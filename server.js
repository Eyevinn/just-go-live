/*
 * Just Go Live - Simple web app for quick live broadcasting
 * 
 * Copyright (c) 2025 Eyevinn Technology AB
 * Licensed under the MIT License (see LICENSE file)
 */

import express from 'express';
import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { Context, getPortsForInstance } from '@osaas/client-core';
import { createEyevinnLiveEncodingInstance, getEyevinnLiveEncodingInstance } from '@osaas/client-services';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const OSC_ACCESS_TOKEN = process.env.OSC_ACCESS_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL;
const DATA_DIR = process.env.DATA_DIR || (process.env.NODE_ENV === 'production' ? '/userdata' : __dirname);

if (!OSC_ACCESS_TOKEN) {
  console.error('OSC_ACCESS_TOKEN environment variable is required');
  process.exit(1);
}

app.use(express.json());
app.use(express.static('public'));

const activeStreams = new Map();
const STREAMS_FILE = path.join(DATA_DIR, 'streams.json');

// Save streams to disk
async function saveStreams() {
  try {
    const streamsData = Array.from(activeStreams.entries()).map(([key, value]) => {
      // Keep the service access token out of the file on disk. `ctx` is no
      // longer stored on a stream at all, but it stays in this destructure so
      // that reintroducing it cannot silently write a personal access token
      // into streams.json, and so that streams loaded from an older file that
      // does contain one get it dropped on the next save.
      const { ctx, serviceAccessToken, ...serializable } = value;
      return [key, { 
        ...serializable, 
        hasServiceAccessToken: !!serviceAccessToken,
        lastSaved: new Date().toISOString()
      }];
    });
    await fs.writeFile(STREAMS_FILE, JSON.stringify(streamsData, null, 2));
    console.log('Streams saved to disk');
  } catch (error) {
    console.error('Error saving streams:', error);
  }
}

// Load streams from disk
async function loadStreams() {
  try {
    const data = await fs.readFile(STREAMS_FILE, 'utf8');
    const streamsData = JSON.parse(data);
    
    console.log(`Loading ${streamsData.length} streams from disk...`);
    
    for (const [key, value] of streamsData) {
      activeStreams.set(key, value);
    }
    
    console.log('Streams loaded from disk');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Error loading streams:', error);
    }
  }
}

// Check if instance exists and is available
async function checkInstanceAvailability(instanceName) {
  try {
    const ctx = new Context({ personalAccessToken: OSC_ACCESS_TOKEN });
    const instance = await getEyevinnLiveEncodingInstance(ctx, instanceName);
    
    // Check if instance exists (SDK might return null/undefined instead of throwing)
    if (!instance) {
      console.log(`Instance ${instanceName} not found (returned null/undefined)`);
      return { available: false };
    }
    
    return { available: true, instance };
  } catch (error) {
    console.log(`Instance ${instanceName} not available:`, error.message);
    return { available: false };
  }
}

// Check if service access token needs refresh (1 hour expiration)
function needsTokenRefresh(tokenCreated) {
  if (!tokenCreated) return true;
  const tokenAge = Date.now() - new Date(tokenCreated).getTime();
  const oneHour = 60 * 60 * 1000;
  return tokenAge > oneHour;
}

// Generate viewer URL using PUBLIC_URL if set, otherwise use request headers
function generateViewerUrl(req, streamId) {
  if (PUBLIC_URL) {
    return `${PUBLIC_URL}/watch/${streamId}`;
  }
  return `${req.protocol}://${req.get('host')}/watch/${streamId}`;
}

// Recreate missing instances
async function validateAndRecreateInstances() {
  console.log('Validating existing instances...');
  
  for (const [streamId, streamInfo] of activeStreams.entries()) {
    const { available } = await checkInstanceAvailability(streamInfo.instanceName);
    
    if (!available) {
      console.log(`Instance ${streamInfo.instanceName} not found, removing from active streams`);
      activeStreams.delete(streamId);
    } else {
      console.log(`Instance ${streamInfo.instanceName} is available`);
      
      // Recreate context and refresh service access token if needed
      const ctx = new Context({ personalAccessToken: OSC_ACCESS_TOKEN });
      
      if (needsTokenRefresh(streamInfo.serviceAccessTokenCreated)) {
        try {
          const sat = await ctx.getServiceAccessToken('eyevinn-live-encoding');
          streamInfo.serviceAccessToken = sat;
          streamInfo.serviceAccessTokenCreated = new Date();
          console.log(`Refreshed service access token for ${streamInfo.instanceName}`);
        } catch (error) {
          console.error(`Failed to refresh service access token for ${streamInfo.instanceName}:`, error);
        }
      } else {
        console.log(`Service access token for ${streamInfo.instanceName} is still valid`);
      }
    }
  }
  
  // Save updated state
  await saveStreams();
}

// Check if there's an available instance to reuse
function findAvailableInstance() {
  for (const [streamId, streamInfo] of activeStreams.entries()) {
    if (streamInfo.status === 'created' || streamInfo.status === 'stopped') {
      return { streamId, streamInfo };
    }
  }
  return null;
}

// Start encoder for a stream (extracted from endpoint logic)
async function startEncoderForStream(streamInfo) {
  // Refresh service access token if needed or if missing
  if (!streamInfo.serviceAccessToken || needsTokenRefresh(streamInfo.serviceAccessTokenCreated)) {
    const ctx = new Context({ personalAccessToken: OSC_ACCESS_TOKEN });
    const sat = await ctx.getServiceAccessToken('eyevinn-live-encoding');
    streamInfo.serviceAccessToken = sat;
    streamInfo.serviceAccessTokenCreated = new Date();
    console.log(`Refreshed service access token for ${streamInfo.instanceName} before starting encoder`);
  }

  // Poll the encoder endpoint until it's available (up to 60 seconds)
  const maxAttempts = 30;
  const pollInterval = 2000; // 2 seconds
  let attempts = 0;
  let encoderReady = false;

  console.log('Waiting for encoder to be ready...');
  
  while (attempts < maxAttempts && !encoderReady) {
    try {
      // Check if encoder endpoint is available
      const checkResponse = await fetch(`${streamInfo.serviceUrl}/api/encoder`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${streamInfo.serviceAccessToken}`
        }
      });

      if (checkResponse.ok || checkResponse.status === 404) {
        // Endpoint is available (404 is expected when encoder is not running)
        encoderReady = true;
        console.log(`Encoder endpoint ready after ${attempts * 2} seconds`);
      } else {
        attempts++;
        if (attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, pollInterval));
        }
      }
    } catch (error) {
      attempts++;
      if (attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }
    }
  }

  if (!encoderReady) {
    throw new Error('Encoder endpoint not available after 60 seconds');
  }

  // Now start the encoder
  const response = await fetch(`${streamInfo.serviceUrl}/api/encoder`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${streamInfo.serviceAccessToken}`
    },
    body: JSON.stringify({ timeout: 0 })
  });

  if (response.ok) {
    streamInfo.status = 'encoding';
    console.log(`Encoder started for ${streamInfo.instanceName}`);
  } else {
    const errorData = await response.json().catch(() => ({}));
    console.log('Start encoder error:', errorData);
    throw new Error(`Failed to start encoder: ${response.statusText}`);
  }
}

app.post('/api/go-live', async (req, res) => {
  try {
    // Check if we can reuse an existing available instance
    const existingStream = findAvailableInstance();
    
    if (existingStream) {
      const { streamId, streamInfo } = existingStream;
      console.log(`Reusing existing instance: ${streamInfo.instanceName}`);
      
      // Refresh service access token if needed or missing
      if (!streamInfo.serviceAccessToken || needsTokenRefresh(streamInfo.serviceAccessTokenCreated)) {
        const ctx = new Context({ personalAccessToken: OSC_ACCESS_TOKEN });
        const sat = await ctx.getServiceAccessToken('eyevinn-live-encoding');
        streamInfo.serviceAccessToken = sat;
        streamInfo.serviceAccessTokenCreated = new Date();
        console.log(`Refreshed service access token for reused instance ${streamInfo.instanceName}`);
      }
      
      // Generate new viewer URL for this session
      const viewerUrl = generateViewerUrl(req, streamId);
      streamInfo.viewerUrl = viewerUrl;
      
      // Start the encoder automatically
      await startEncoderForStream(streamInfo);
      
      await saveStreams();
      
      return res.json({
        success: true,
        streamId,
        rtmpUrl: streamInfo.rtmpUrl,
        viewerUrl
      });
    }

    // No available instance, create a new one
    const streamId = uuidv4();
    const instanceName = `live${streamId.replace(/-/g, '').substring(0, 8)}`;
    const streamKey = `key${streamId.replace(/-/g, '').substring(0, 12)}`;

    // Initialize the OSC context
    const ctx = new Context({ personalAccessToken: OSC_ACCESS_TOKEN });

    // Create the live encoding instance
    console.log(`Creating new instance: ${instanceName} with stream key: ${streamKey}`);
    const instanceConfig = {
      name: instanceName,
      HlsOnly: true,
      StreamKey: streamKey
    };

    const instance = await createEyevinnLiveEncodingInstance(ctx, instanceConfig);
    console.log('Instance created:', instance);

    const serviceUrl = instance.url;
    
    // Get service access token for the live encoding service
    const sat = await ctx.getServiceAccessToken('eyevinn-live-encoding');
    console.log('Got service access token');
    
    // Get port mappings using the proper SDK function with service access token
    const ports = await getPortsForInstance(ctx, 'eyevinn-live-encoding', instanceName, sat);
    console.log('Port mappings:', ports);
    
    // Find the RTMP port (1935)
    const rtmpPort = ports.find(port => port.internalPort === 1935);
    if (!rtmpPort) {
      throw new Error('Could not find RTMP port mapping');
    }

    const rtmpUrl = `rtmp://${rtmpPort.externalIp}:${rtmpPort.externalPort}/live/${streamKey}`;
    const hlsUrl = `${serviceUrl}/origin/hls/index.m3u8`;
    const viewerUrl = generateViewerUrl(req, streamId);

    const streamInfo = {
      streamId,
      instanceName,
      streamKey,
      rtmpUrl,
      hlsUrl,
      viewerUrl,
      serviceUrl,
      status: 'created',
      createdAt: new Date(),
      serviceAccessToken: sat,
      serviceAccessTokenCreated: new Date()
    };

    activeStreams.set(streamId, streamInfo);
    
    // Start the encoder automatically
    await startEncoderForStream(streamInfo);
    
    await saveStreams(); // Save to disk

    res.json({
      success: true,
      streamId,
      rtmpUrl,
      viewerUrl
    });

  } catch (error) {
    console.error('Error creating live stream:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/start-encoder/:streamId', async (req, res) => {
  try {
    const { streamId } = req.params;
    const streamInfo = activeStreams.get(streamId);

    if (!streamInfo) {
      return res.status(404).json({ success: false, error: 'Stream not found' });
    }

    // Refresh service access token if needed or missing
    if (!streamInfo.serviceAccessToken || needsTokenRefresh(streamInfo.serviceAccessTokenCreated)) {
      const ctx = new Context({ personalAccessToken: OSC_ACCESS_TOKEN });
      const sat = await ctx.getServiceAccessToken('eyevinn-live-encoding');
      streamInfo.serviceAccessToken = sat;
      streamInfo.serviceAccessTokenCreated = new Date();
      console.log(`Refreshed service access token for ${streamInfo.instanceName} before starting encoder`);
    }

    // Poll the encoder endpoint until it's available (up to 60 seconds)
    const maxAttempts = 30;
    const pollInterval = 2000; // 2 seconds
    let attempts = 0;
    let encoderReady = false;

    console.log('Waiting for encoder to be ready...');
    
    while (attempts < maxAttempts && !encoderReady) {
      try {
        // Check if encoder endpoint is available
        const checkResponse = await fetch(`${streamInfo.serviceUrl}/api/encoder`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${streamInfo.serviceAccessToken}`
          }
        });

        if (checkResponse.ok || checkResponse.status === 404) {
          // Endpoint is available (404 is expected when encoder is not running)
          encoderReady = true;
          console.log(`Encoder endpoint ready after ${attempts * 2} seconds`);
        } else {
          attempts++;
          if (attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, pollInterval));
          }
        }
      } catch (error) {
        attempts++;
        if (attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, pollInterval));
        }
      }
    }

    if (!encoderReady) {
      throw new Error('Encoder endpoint not available after 60 seconds');
    }

    // Now start the encoder
    const response = await fetch(`${streamInfo.serviceUrl}/api/encoder`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${streamInfo.serviceAccessToken}`
      },
      body: JSON.stringify({ timeout: 0 })
    });

    if (response.ok) {
      streamInfo.status = 'encoding';
      activeStreams.set(streamId, streamInfo);
      await saveStreams(); // Save updated status
      res.json({ success: true });
    } else {
      const errorData = await response.json();
      console.log('Start encoder error:', errorData);
      throw new Error(`Failed to start encoder: ${response.statusText}`);
    }

  } catch (error) {
    console.error('Error starting encoder:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/stop-encoder/:streamId', async (req, res) => {
  try {
    const { streamId } = req.params;
    const streamInfo = activeStreams.get(streamId);

    if (!streamInfo) {
      return res.status(404).json({ success: false, error: 'Stream not found' });
    }

    // Refresh service access token if needed or missing
    if (!streamInfo.serviceAccessToken || needsTokenRefresh(streamInfo.serviceAccessTokenCreated)) {
      const ctx = new Context({ personalAccessToken: OSC_ACCESS_TOKEN });
      const sat = await ctx.getServiceAccessToken('eyevinn-live-encoding');
      streamInfo.serviceAccessToken = sat;
      streamInfo.serviceAccessTokenCreated = new Date();
      console.log(`Refreshed service access token for ${streamInfo.instanceName} before stopping encoder`);
    }

    // Use direct API call to stop the encoder with service access token
    const response = await fetch(`${streamInfo.serviceUrl}/api/encoder`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${streamInfo.serviceAccessToken}`
      }
    });

    if (response.ok) {
      streamInfo.status = 'stopped';
      activeStreams.set(streamId, streamInfo);
      await saveStreams(); // Save updated status
      res.json({ success: true });
    } else {
      throw new Error(`Failed to stop encoder: ${response.statusText}`);
    }

  } catch (error) {
    console.error('Error stopping encoder:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// The only fields a viewer needs to play the stream.
//
// This endpoint is reachable without authentication, by design: the viewer link
// is what a broadcaster hands to their audience, and watch.html fetches it on
// load and again on every status poll. So build the response from an explicit
// allowlist and never from the stored object, which also holds the service
// access token, the RTMP stream key, and the ingest URL with that key in it.
//
// watch.html reads exactly hlsUrl and status. streamId is already in the URL the
// caller used, so echoing it back tells them nothing they did not have.
function publicStreamView(streamInfo) {
  return {
    streamId: streamInfo.streamId,
    hlsUrl: streamInfo.hlsUrl,
    status: streamInfo.status
  };
}

app.get('/api/stream/:streamId', (req, res) => {
  const { streamId } = req.params;
  const streamInfo = activeStreams.get(streamId);

  if (!streamInfo) {
    return res.status(404).json({ success: false, error: 'Stream not found' });
  }

  res.json({
    success: true,
    stream: publicStreamView(streamInfo)
  });
});

app.get('/watch/:streamId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'watch.html'));
});

// Initialize server with persistence
async function initializeServer() {
  await loadStreams();
  if (activeStreams.size > 0) {
    await validateAndRecreateInstances();
  }
}

app.listen(PORT, async () => {
  console.log(`Just Go Live server running on port ${PORT}`);
  console.log(`Make sure OSC_ACCESS_TOKEN is set in your environment`);
  
  // Initialize persistence
  await initializeServer();
});