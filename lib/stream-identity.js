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
