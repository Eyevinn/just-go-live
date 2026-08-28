/*
 * Just Go Live - Simple web app for quick live broadcasting
 *
 * Copyright (c) 2025 Eyevinn Technology AB
 * Licensed under the MIT License (see LICENSE file)
 */

// The only fields a viewer needs to play the stream.
//
// GET /api/stream/:streamId is reachable without authentication, by design: the
// viewer link is what a broadcaster hands to their audience, and watch.html
// fetches that endpoint on load and again on every status poll.
//
// So the response is built from this allowlist and never from the stored stream,
// which also holds the RTMP stream key, the ingest URL with that key in it, and
// a service access token. Returning the stored object whole put all of that in
// every viewer's browser (issue #2).
//
// watch.html reads exactly hlsUrl and status. streamId is echoed back because the
// caller already had it in the URL it called.
//
// This lives in its own module so it can be tested without importing server.js,
// which starts listening on import. See test/public-stream-view.test.js: adding a
// field here without adding it to that test's allowlist fails the test.
export function publicStreamView(streamInfo) {
  return {
    streamId: streamInfo.streamId,
    hlsUrl: streamInfo.hlsUrl,
    status: streamInfo.status
  };
}
