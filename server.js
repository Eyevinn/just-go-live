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
import {
  createEyevinnLiveEncodingInstance,
  getEyevinnLiveEncodingInstance,
  removeEyevinnLiveEncodingInstance
} from '@osaas/client-services';
import { publicStreamView } from './lib/public-stream-view.js';
import { classifyRemovalError } from './lib/removal-outcome.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';

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

// A secret the broadcaster's page holds and the audience does not.
//
// Every other stream route is keyed on streamId alone, and streamId is the last
// segment of the viewer link, which is handed to the audience on purpose. That is
// survivable for the encoder routes, which are reversible. It is not survivable
// for removal: one DELETE from anyone holding a viewer link would destroy the
// encoder mid-broadcast, and the RTMP endpoint and stream key do not come back.
//
// So DELETE requires this token, which is returned only in the go-live response.
// The pre-existing start-encoder and stop-encoder routes are the same class of
// exposure and are deliberately left alone here, so this stays one change.
function newManageToken() {
  return randomBytes(32).toString('hex');
}

function manageTokenMatches(expected, provided) {
  if (typeof expected !== 'string' || typeof provided !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Check if there's an available instance to reuse
function findAvailableInstance() {
  for (const [streamId, streamInfo] of activeStreams.entries()) {
    // 'remove-failed' is deliberately not reusable: we do not know whether the
    // instance behind it is alive.
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
      
      // Streams created before manage tokens existed do not have one.
      if (!streamInfo.manageToken) {
        streamInfo.manageToken = newManageToken();
      }

      return res.json({
        success: true,
        streamId,
        rtmpUrl: streamInfo.rtmpUrl,
        viewerUrl,
        instanceName: streamInfo.instanceName,
        manageToken: streamInfo.manageToken
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
      manageToken: newManageToken(),
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
      viewerUrl,
      instanceName,
      manageToken: streamInfo.manageToken
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

// Remove the Live Encoding instance this app created for a stream.
//
// Going live creates an instance on the deploying account and it keeps running,
// and costing, until someone removes it. Stopping the encoder stops the encoding
// process and leaves the instance up, so before this endpoint existed the only
// way to stop the cost was to find the instance in Open Source Cloud and delete
// it by hand (issue #3).
//
// Requires the manage token from the go-live response, because streamId alone is
// public and this operation cannot be undone.
app.delete('/api/stream/:streamId', async (req, res) => {
  const { streamId } = req.params;
  const streamInfo = activeStreams.get(streamId);

  if (!streamInfo) {
    // No instanceName to give: the record that held it is what is missing. Say
    // so plainly rather than letting the caller print an empty name, because a
    // missing record can also mean an instance nobody is tracking any more.
    return res.status(404).json({
      success: false,
      error:
        'Stream not found. Either it was already removed, or this server lost the record ' +
        'while the instance was still running. Check the eyevinn-live-encoding service in ' +
        'Open Source Cloud for an instance that should not be there.',
      instanceName: null
    });
  }

  if (!manageTokenMatches(streamInfo.manageToken, req.get('x-manage-token'))) {
    return res.status(403).json({
      success: false,
      error: 'Removing a stream requires the manage token from the go-live response.',
      instanceName: null
    });
  }

  let outcome;
  try {
    const ctx = new Context({ personalAccessToken: OSC_ACCESS_TOKEN });
    await removeEyevinnLiveEncodingInstance(ctx, streamInfo.instanceName);
    outcome = 'removed';
    console.log(`Removed instance ${streamInfo.instanceName}`);
  } catch (error) {
    if (classifyRemovalError(error) === 'already-gone') {
      outcome = 'already-gone';
      console.warn(`Instance ${streamInfo.instanceName} was already gone`);
    } else {
      // The local record is kept on purpose. It is the only thing left that
      // names an instance which may still be running and still being charged
      // for, and dropping it here would hide the exact cost this endpoint
      // exists to end. Error level, not info: an operator greps for this.
      console.error(
        `Failed to remove instance ${streamInfo.instanceName} ` +
        `(httpCode=${error && error.httpCode ? error.httpCode : 'none'}). ` +
        `It may still be running and billing.`,
        error
      );
      streamInfo.status = 'remove-failed';
      await saveStreams();
      return res.status(500).json({
        success: false,
        outcome: 'unknown',
        error: error.message,
        instanceName: streamInfo.instanceName
      });
    }
  }

  activeStreams.delete(streamId);
  await saveStreams();

  // Say which of the two happened. "I issued a delete and it succeeded" and
  // "it was not there" are different facts and the page words them differently.
  res.json({ success: true, outcome, instanceName: streamInfo.instanceName });
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