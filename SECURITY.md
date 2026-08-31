# Security

## Reporting a vulnerability

Please email **security@eyevinn.se**. Do not open a public issue for a
vulnerability.

If a security issue has already been opened publicly, that is fine, say so in the
mail rather than adding reproduction details to the issue.

Useful to include, as much of it as you have:

- what the app does that it should not
- how to reproduce it
- what an attacker gets out of it

## What this app hands out, and to whom

Just Go Live deals in three things that are not equally public, which is worth
having in mind when judging whether something is a vulnerability:

| | Public | Notes |
|---|---|---|
| Viewer link and stream id | Published | Meant to be shared, but see the warning below |
| HLS playback URL | Yes | The viewer page plays it |
| RTMP stream key and ingest URL | **No** | Whoever has it can push video to the broadcaster's audience |
| OSC access token, service access tokens | **No** | They control the deploying account |

**The stream id is published, but it is not harmless.** Several routes take it as
their only credential, so anyone holding a viewer link can act on the stream:
`POST /api/start-encoder/:streamId` and `POST /api/stop-encoder/:streamId` are
unauthenticated, so a viewer can stop someone's live broadcast. Treat that as a
known weakness of this app, not as a design you can rely on.

Two rules follow from the table:

1. **`GET /api/stream/:streamId` is unauthenticated by design**, because the
   viewer page calls it. Its response is built from a fixed allowlist in
   `lib/public-stream-view.js`. Do not return the stored stream object from it.
   Broken once, in issue #2, and now guarded by
   `test/public-stream-view.test.js`.
2. **The stream key must not be derivable from anything public.** Deriving it
   from the stream id publishes it to everyone the viewer link is shared with.
   **This is currently broken on `main`**: `server.js` builds the key out of the
   stream id. Do not read this rule as a description of the code.

## The app has no authentication of its own

Any request that reaches `POST /api/go-live` creates a Live Encoding instance on
the deploying account and starts costing money. The app does not authenticate
that request. If you expose it, put a gate in front of it.

## About Eyevinn Technology

Eyevinn Technology is an independent consultant firm specialized in video and
streaming.
