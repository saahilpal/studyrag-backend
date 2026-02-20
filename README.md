# Document Analyzer RAG Backend

Production-oriented backend for session-based PDF ingestion, vector retrieval, and Gemini-powered chat generation over indexed documents.

## Overview
This service provides a local-first Retrieval Augmented Generation (RAG) backend designed for document analysis workflows.

It supports:
- Session lifecycle management
- PDF upload and asynchronous indexing
- Local embedding generation and SQLite vector persistence
- Similarity retrieval across indexed chunks
- Synchronous and streaming chat responses
- Persistent job tracking with polling

## Architecture
The backend is organized as a layered Node.js service:

- API layer: Express routes under `/api/v1`
- Domain services: upload, indexing, retrieval, chat, queue, metrics, cleanup
- Persistence: SQLite (`better-sqlite3`) for sessions, documents, vectors, jobs, and chat history
- AI integrations:
  - Local embeddings via `@xenova/transformers`
  - Generation via Gemini (`@google/genai`)

Data flow:

1. `POST /sessions/:id/pdfs` receives upload and creates an indexing job.
2. Worker parses PDF, chunks text, embeds vectors, stores chunks.
3. `POST /sessions/:id/chat` retrieves top candidates, builds prompt, and generates answer.
4. Responses are returned as JSON or SSE stream (when requested).

## Features
- Versioned API base: `/api/v1`
- Response envelope contract:
  - Success: `{ ok: true, data: ... }`
  - Error: `{ ok: false, error: { code, message, retryable } }`
- Upload size guardrails (default 50MB)
- Request payload limits (JSON/urlencoded 2MB)
- Job queue with progress/stage/queue position
- SSE token streaming for chat
- Session chat history persistence
- Periodic cleanup worker for stale jobs/temp artifacts
- Route-level rate limiting and schema validation

## API Overview
Endpoint groups:

- Health
  - `GET /api/v1/health`
  - `GET /api/v1/ping`
- Sessions
  - `GET /api/v1/sessions`
  - `POST /api/v1/sessions`
  - `GET /api/v1/sessions/:sessionId`
  - `DELETE /api/v1/sessions/:sessionId`
- PDFs
  - `GET /api/v1/sessions/:sessionId/pdfs`
  - `POST /api/v1/sessions/:sessionId/pdfs`
  - `GET /api/v1/pdfs/:pdfId`
  - `DELETE /api/v1/pdfs/:pdfId`
- Chat
  - `POST /api/v1/sessions/:sessionId/chat`
- Jobs
  - `GET /api/v1/jobs/:jobId`
- History
  - `GET /api/v1/sessions/:sessionId/history`
  - `DELETE /api/v1/sessions/:sessionId/history`
- Admin (disabled in production)
  - `GET /api/v1/admin/queue`
  - `POST /api/v1/admin/reset`

Full schema reference: `openapi.yaml`

## Tech Stack
- Runtime: Node.js (CommonJS)
- Web framework: Express
- Database: SQLite (`better-sqlite3`)
- File processing: `multer`, `pdf-parse`
- Embeddings: `@xenova/transformers`
- LLM generation: `@google/genai` (Gemini)
- Validation: `zod`
- Security middleware: `helmet`, `cors`, rate limiter
- Testing: Node test runner, `supertest`, `pdfkit`

## Setup
1. Install dependencies:

```bash
npm install
```

2. Create local environment file:

```bash
cp .env.example .env
```

3. Configure required variables (at minimum `GEMINI_API_KEY`).

4. Run database migrations:

```bash
npm run migrate
```

5. Start the service:

```bash
npm run dev
```

## Environment Variables
| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `4000` | HTTP port |
| `HOST` | No | `0.0.0.0` | Bind address |
| `NODE_ENV` | No | `development` | Runtime mode |
| `TRUST_PROXY` | No | `false` | Express proxy trust |
| `GEMINI_API_KEY` | Yes | - | Gemini API key |
| `GEMINI_MODEL` | No | `gemini-2.5-flash` | Comma-separated model candidates |
| `CORS_ALLOWED_ORIGINS` | No | `http://localhost:3000,http://127.0.0.1:3000` | Allowed origins |
| `MAX_UPLOAD_FILE_SIZE_BYTES` | No | `52428800` | Upload size cap |
| `RAG_TOP_K` | No | `5` | Retrieval top-k |
| `RAG_CANDIDATE_PAGE_SIZE` | No | `400` | Candidate scan page size |
| `RAG_HISTORY_LIMIT` | No | `12` | Prompt history cap |
| `RAG_TOKEN_TO_CHAR_RATIO` | No | `4` | Chunking ratio |
| `RAG_CHUNK_TOKENS` | No | `1000` | Chunk token target |
| `RAG_CHUNK_OVERLAP_TOKENS` | No | `200` | Chunk overlap |
| `LOCAL_EMBEDDING_BATCH_SIZE` | No | `24` | Embedding batch size |
| `LOCAL_EMBEDDING_BATCH_SIZE_MIN` | No | `8` | Min adaptive batch |
| `LOCAL_EMBEDDING_BATCH_SIZE_MAX` | No | `64` | Max adaptive batch |
| `CLEANUP_INTERVAL_MS` | No | `900000` | Cleanup scheduler interval |
| `CLEANUP_COMPLETED_JOB_TTL_HOURS` | No | `24` | Completed job retention |
| `CLEANUP_FAILED_JOB_TTL_HOURS` | No | `72` | Failed job retention |
| `CLEANUP_TEMP_FILE_TTL_HOURS` | No | `6` | Temp file retention |

## Project Structure
```text
.
├── docs/
├── scripts/
├── src/
│   ├── app.js
│   ├── server.js
│   ├── config/
│   ├── db/
│   ├── middleware/
│   ├── routes/
│   ├── services/
│   └── utils/
├── tests/
├── .env.example
├── openapi.yaml
├── package.json
└── README.md
```

## Development
Run locally:

```bash
npm run dev
```

Run tests:

```bash
npm test
```

Run integration-only tests:

```bash
npm run test:integration
```

Run migration dry-run:

```bash
npm run migrate:dry-run
```

## Production Deployment
1. Set `NODE_ENV=production`.
2. Provide secure values for required environment variables.
3. Run migrations before serving traffic.
4. Start with:

```bash
npm start
```

5. Place the process behind a reverse proxy and enable `TRUST_PROXY=true` when required.
6. Restrict access to admin endpoints (`/api/v1/admin/*`) in production environments.

## Performance Notes
- `better-sqlite3` is synchronous; high concurrency can block the event loop.
- Retrieval performs paged full-corpus similarity scanning per session.
- Embedding batches are adaptive to reduce memory spikes.
- Uploads are disk-backed (temp-to-storage) to avoid large in-memory buffers.
- SSE streaming keeps chat responsive for long completions.

## Security Notes
- No built-in authentication/authorization is currently enforced.
- CORS is allowlisted via environment configuration.
- Requests and payloads are size-limited and schema-validated.
- Upload validation includes MIME, extension, and PDF signature checks.
- Keep `.env` local; it is ignored by git.

## Roadmap
- Add authentication and tenant isolation
- Replace in-memory limiter with distributed rate limiting
- Add worker-thread or external worker offload for vector scoring
- Introduce horizontal queue/worker scaling
- Improve observability (metrics, traces, alerts)

## License
ISC
