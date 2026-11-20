# Voice Notes (demo)

Small end-to-end slice of the pipeline a field-crew messaging app needs: record in the
browser, upload, enforce the two-minute limit on the server, transcribe with an audio/LLM
API, play back, and push updates to every client over Socket.IO.

## Run

```bash
npm install
npm start            # http://localhost:3000
```

Transcription uses OpenAI's audio endpoint when `OPENAI_API_KEY` is set; without it the
server returns a mock transcript so the rest of the flow stays testable.

```bash
OPENAI_API_KEY=sk-... TRANSCRIBE_MODEL=whisper-1 npm start
```

## Tests

```bash
npm test
```

Covers the 120s boundary (including codec padding tolerance), duration formatting, ffprobe
output parsing, and an API-level check that a 130s upload returns 422 while the file is deleted
rather than stored. The API test generates its own audio with `ffmpeg` and is skipped if
`ffmpeg` is missing.

## What is enforced where

| Rule | Place |
| --- | --- |
| Max 120s per voice note | server, via `ffprobe` on the stored file (client timer is UX only) |
| Audio-only uploads, 30MB cap | `multer` file filter + limits |
| "Listened" state | `POST /api/notes/:id/listened`, broadcast to other clients |
| Live delivery of new notes | Socket.IO `note:new` / `note:listened` |

## API

- `GET /api/notes` — list notes (newest first)
- `POST /api/notes` — multipart upload, field name `audio`
- `POST /api/notes/:id/listened` — mark played by `by`
- Socket.IO events: `notes:sync` (on connect), `note:new`, `note:listened`

## Deliberate limits (upgrade path)

- Notes live in `notes.json` and files on local disk: swap for PostgreSQL + S3 when
  storage or concurrency matters.
- Transcription is synchronous inside the request: move to a queue/worker once uploads
  overlap.
- No auth or workspace membership: the permission model belongs in the service layer, so
  it is left out rather than faked.
- Single-page React without a build step: migrate to Vite + JSX when the UI grows.
