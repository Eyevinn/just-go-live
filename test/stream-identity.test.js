/*
 * Just Go Live - Simple web app for quick live broadcasting
 *
 * Copyright (c) 2025 Eyevinn Technology AB
 * Licensed under the MIT License (see LICENSE file)
 */

// Regression guard for the RTMP stream key.
//
// The key gates who may push video into the encoder. The stream id does not: it
// is the last segment of the viewer link, which is meant to be shared. Deriving
// the key from the id therefore published the key to every viewer.
//
// The load bearing check is "same id, different key". A key that merely looks
// random can still be a function of the id, and only calling twice with the same
// id catches that.
//
// Plain assertions and no test runner, matching test/public-stream-view.test.js.

import assert from 'node:assert/strict';
import { newStreamIdentity } from '../lib/stream-identity.js';

// A fixed id so the derivation this replaces is reproducible in the assertions.
const STREAM_ID = '5f629f6a-7161-47fb-96c9-a8e2b1d40c37';
const ID_HEX = STREAM_ID.replace(/-/g, '');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('the stream key is not a function of the stream id', () => {
  const a = newStreamIdentity(STREAM_ID);
  const b = newStreamIdentity(STREAM_ID);
  assert.notEqual(
    a.streamKey,
    b.streamKey,
    'same stream id produced the same key, so the key is still derived from it'
  );
});

test('the old derivation is gone', () => {
  const { streamKey } = newStreamIdentity(STREAM_ID);
  assert.notEqual(streamKey, `key${ID_HEX.substring(0, 12)}`);
});

test('no slice of the stream id survives in the key', () => {
  // Any run of 8 or more hex characters shared with the id would be enough to
  // make the key guessable from the viewer link.
  const { streamKey } = newStreamIdentity(STREAM_ID);
  for (let i = 0; i + 8 <= ID_HEX.length; i++) {
    const slice = ID_HEX.substring(i, i + 8);
    assert.ok(!streamKey.includes(slice), `key contains stream id slice ${slice}`);
  }
});

test('the key has enough entropy to be unguessable', () => {
  const { streamKey } = newStreamIdentity(STREAM_ID);
  assert.match(streamKey, /^key[0-9a-f]{32}$/);
});

test('the instance name is still derived from the stream id', () => {
  // Deliberate: a name, not a credential. Asserted so a later change to it is a
  // decision someone makes, not a side effect.
  const { instanceName } = newStreamIdentity(STREAM_ID);
  assert.equal(instanceName, `live${ID_HEX.substring(0, 8)}`);
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

if (failed > 0) {
  console.error(`\n${failed} of ${tests.length} tests failed`);
  process.exit(1);
}
console.log(`\n${tests.length} tests passed`);
