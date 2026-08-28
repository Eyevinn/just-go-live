/*
 * Just Go Live - Simple web app for quick live broadcasting
 *
 * Copyright (c) 2025 Eyevinn Technology AB
 * Licensed under the MIT License (see LICENSE file)
 */

import { randomBytes } from 'node:crypto';

// Names for a new stream: the encoder instance name, and the RTMP stream key.
//
// The stream key is the only thing that decides who may push video into the
// encoder's RTMP ingest. It used to be derived from the stream id:
//
//   streamKey = 'key' + streamId.replace(/-/g, '').substring(0, 12)
//
// The stream id is not a secret. It is the last path segment of the viewer link,
// which a broadcaster is meant to hand out as widely as possible, so anyone
// holding a viewer link could compute the ingest key for that stream and push
// their own video to the broadcaster's audience. That is a different path from
// issue #2, and closing #2 did not close it: the key never had to be read out of
// a response, it could be calculated.
//
// So the key is now independent random bytes with no relationship to the stream
// id, and it is generated once, at creation, and stored server side.
//
// The instance name stays derived. It is a name, not a credential: the encoder's
// own API requires a service access token, and the instance URL is already
// public because the viewer plays hlsUrl from it. Making it random would change
// behaviour for no security gain.
export function newStreamIdentity(streamId) {
  return {
    instanceName: `live${streamId.replace(/-/g, '').substring(0, 8)}`,
    streamKey: `key${randomBytes(16).toString('hex')}`
  };
}

// True if this stream's key was produced by the derivation above, which means it
// is computable from the viewer link and must not be handed out again.
//
// Streams persisted before that change are restored from streams.json on boot
// with their old key intact, so without this the fix would not take effect on
// any deployment that already has streams: findAvailableInstance would hand the
// next broadcaster a reused stream carrying a legacy key.
//
// The key cannot be rotated on an existing instance, because it is baked into
// the encoder config at creation. So the record is kept, and only excluded from
// reuse: dropping it would lose the only reference to an instance that is still
// running on the account.
export function hasDerivedStreamKey(stream) {
  if (!stream || typeof stream.streamKey !== 'string' || typeof stream.streamId !== 'string') {
    return false;
  }
  return stream.streamKey === `key${stream.streamId.replace(/-/g, '').substring(0, 12)}`;
}
