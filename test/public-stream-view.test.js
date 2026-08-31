/*
 * Just Go Live - Simple web app for quick live broadcasting
 *
 * Copyright (c) 2025 Eyevinn Technology AB
 * Licensed under the MIT License (see LICENSE file)
 */

// Regression guard for issue #2.
//
// GET /api/stream/:streamId is unauthenticated, because the viewer page calls it.
// It used to return the stored stream object whole, which put the deploying
// tenant's OSC personal access token, the RTMP stream key and a service access
// token into the browser of every viewer of every stream.
//
// Two independent checks, on purpose. The key allowlist catches a field added
// deliberately; the canary sweep catches a secret that arrives inside a field
// someone did not think of, including a nested one.
//
// Plain assertions and no test runner, so this runs on any Node the app itself
// supports and adds no dependency.

import assert from 'node:assert/strict';
import { publicStreamView } from '../lib/public-stream-view.js';

const CANARY = {
  pat: 'CANARY_personal_access_token',
  sat: 'CANARY_service_access_token',
  streamKey: 'CANARY_stream_key',
  manageToken: 'CANARY_manage_token'
};

// Shaped like the object server.js actually stores, including the fields that
// leaked. `ctx` is no longer stored on a stream, but it is included here so this
// test still fails if someone puts it back and widens the response.
function storedStream() {
  return {
    streamId: 'a1b2c3',
    instanceName: 'live12345678',
    streamKey: CANARY.streamKey,
    rtmpUrl: `rtmp://10.0.0.1:1935/live/${CANARY.streamKey}`,
    hlsUrl: 'https://example.osaas.io/origin/hls/index.m3u8',
    viewerUrl: 'https://example.osaas.io/watch/a1b2c3',
    serviceUrl: 'https://example.osaas.io',
    status: 'encoding',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    manageToken: CANARY.manageToken,
    serviceAccessToken: CANARY.sat,
    serviceAccessTokenCreated: new Date('2026-01-01T00:00:00.000Z'),
    ctx: { personalAccessToken: CANARY.pat, environment: 'prod' }
  };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('returns exactly the three playback fields', () => {
  const view = publicStreamView(storedStream());
  assert.deepEqual(Object.keys(view).sort(), ['hlsUrl', 'status', 'streamId']);
});

test('no credential or stream key survives into the response', () => {
  const serialized = JSON.stringify(publicStreamView(storedStream()));
  for (const [label, secret] of Object.entries(CANARY)) {
    assert.ok(!serialized.includes(secret), `${label} leaked into the response`);
  }
  // The whole point: the object went out verbatim, so check the shape too.
  assert.ok(!serialized.includes('personalAccessToken'), 'ctx leaked into the response');
});

test('a secret added to the stored stream later still cannot leak', () => {
  const stream = storedStream();
  stream.someFutureToken = 'CANARY_a_field_nobody_has_added_yet';
  stream.nested = { deeper: { token: 'CANARY_nested' } };
  const serialized = JSON.stringify(publicStreamView(stream));
  assert.ok(!serialized.includes('CANARY_a_field_nobody_has_added_yet'));
  assert.ok(!serialized.includes('CANARY_nested'));
});

test('passes through what the viewer page needs', () => {
  const stream = storedStream();
  const view = publicStreamView(stream);
  // watch.html reads exactly these two. Losing either breaks the player.
  assert.equal(view.hlsUrl, stream.hlsUrl);
  assert.equal(view.status, stream.status);
  assert.equal(view.streamId, stream.streamId);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`ok    ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL  ${name}`);
    console.error(`      ${error.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
