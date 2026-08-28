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
| Viewer link and stream id | Yes | Meant to be shared as widely as possible |
| HLS playback URL | Yes | The viewer page plays it |
| RTMP stream key and ingest URL | **No** | Whoever has it can push video to the broadcaster's audience |
| OSC access token, service access tokens | **No** | They control the deploying account |

Two rules follow from that table, and both have already been broken once:

1. **`GET /api/stream/:streamId` is unauthenticated by design**, because the
   viewer page calls it. Its response is built from a fixed allowlist in
   `lib/public-stream-view.js`. Do not return the stored stream object from it.
2. **The stream key must not be derivable from anything public.** Deriving it
   from the stream id, which is the last segment of the viewer link, published it
   to everyone the link was shared with.

Rule 1 has a regression test in `test/public-stream-view.test.js`.

## The app has no authentication of its own

Any request that reaches `POST /api/go-live` creates a Live Encoding instance on
the deploying account and starts costing money. The app does not authenticate
that request. If you expose it, put a gate in front of it.

## About Eyevinn Technology

Eyevinn Technology is an independent consultant firm specialized in video and
streaming.
