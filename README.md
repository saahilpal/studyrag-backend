# Document Analyzer RAG Backend

## 1. Project Overview
Document Analyzer RAG Backend is a production-focused Node.js service for session-based PDF ingestion, semantic indexing, and retrieval-augmented chat.

Core stack:
- Node.js + Express
- SQLite (`better-sqlite3`)
- Local embeddings (`@xenova/transformers`)
- Gemini generation (`@google/genai`)
- Background job queue with persistence

API base:
- `/api/v1`

Response envelope:
- Success: `{ "ok": true, "data": ... }`
- Error: `{ "ok": false, "error": { code, message, retryable } }`

---

## 2. Architecture Diagram
```text
Client
  |
  | HTTP / SSE
  v
Express App (src/app.js)
  |- security middleware (helmet, cors, json limits)
  |- route-level rate limits + schema validation
  v
API Router (src/routes/apiV1.js)
  |- sessions / pdfs / chat / jobs / admin
  |- streaming chat (SSE)
  v
Services Layer (src/services/*)
  |- uploadService      (temp-file pipeline, file validation)
  |- indexingService    (parse -> chunk -> embed -> store)
  |- vectorService      (full-corpus paged similarity search)
  |- ragService         (retrieve + Gemini generate/stream)
  |- jobQueue           (persistent queue, retries, progress)
  |- cleanupService     (stale jobs/temp/orphan cleanup)
  v
SQLite (data/studyrag.sqlite)
  |- sessions, pdfs, chunks, chat_messages, job_queue

Filesystem (data/uploads)
  |- per-session PDFs
  |- temp upload directory
```

---

## 3. API Documentation

### Health & Utility
- `GET /api/v1/health`
  - Returns status, uptime, queue size, memory usage, and CPU load
- `GET /api/v1/ping`

### Sessions
- `GET /api/v1/sessions`
- `POST /api/v1/sessions`
  - Body: `{ "title": "..." }`
- `GET /api/v1/sessions/:sessionId`
- `DELETE /api/v1/sessions/:sessionId`

### PDFs
- `GET /api/v1/sessions/:sessionId/pdfs`
- `POST /api/v1/sessions/:sessionId/pdfs` (multipart)
  - Fields:
    - `file` (PDF)
    - `title` (optional)
  - Returns job metadata including progress and queue position
- `GET /api/v1/pdfs/:pdfId`
- `DELETE /api/v1/pdfs/:pdfId?removeFile=true|false`

### Chat
- `POST /api/v1/sessions/:sessionId/chat`
  - JSON mode (default): returns full response
  - Streaming mode (SSE): `?stream=true` or `Accept: text/event-stream`

### Jobs
- `GET /api/v1/jobs/:jobId`
  - Includes `progress`, `stage`, `queuePosition`, retries, and result/error

### History
- `GET /api/v1/sessions/:sessionId/history?limit=...&offset=...`
- `DELETE /api/v1/sessions/:sessionId/history`

### Admin (non-production only)
- `GET /api/v1/admin/queue`
- `POST /api/v1/admin/reset`

---

## 4. Setup Instructions

### Prerequisites
- Node.js 20+
- npm

### Install
```bash
npm install
```

### Configure
```bash
cp .env.example .env
```
Set required values (especially `GEMINI_API_KEY`).

### Run
```bash
npm run dev
# or
npm start
```

### Run migrations manually
```bash
node migrate.js --dry-run
node migrate.js
```

### Run tests
```bash
npm test
```

---

## 5. Environment Variables

### Core
- `PORT` (default `4000`)
- `HOST` (default `0.0.0.0`)
- `NODE_ENV` (`development` or `production`)
- `GEMINI_API_KEY` (required for Gemini responses)
- `GEMINI_MODEL` (comma-separated model candidates)

### Security & HTTP
- `CORS_ALLOWED_ORIGINS` (comma-separated exact origins)
- `TRUST_PROXY` (`true|false`)
- `MAX_UPLOAD_FILE_SIZE_BYTES` (default `52428800`)

### RAG / Retrieval
- `RAG_TOP_K` (default `5`)
- `RAG_CANDIDATE_PAGE_SIZE` (default `400`)
- `RAG_HISTORY_LIMIT` (default `12`)
- `RAG_TOKEN_TO_CHAR_RATIO` (default `4`)
- `RAG_CHUNK_TOKENS` (default `1000`)
- `RAG_CHUNK_OVERLAP_TOKENS` (default `200`)

### Local Embeddings
- `LOCAL_EMBEDDING_BATCH_SIZE` (default `24`)
- `LOCAL_EMBEDDING_BATCH_SIZE_MIN` (default `8`)
- `LOCAL_EMBEDDING_BATCH_SIZE_MAX` (default `64`)

### Cleanup Worker
- `CLEANUP_INTERVAL_MS` (default `900000`)
- `CLEANUP_COMPLETED_JOB_TTL_HOURS` (default `24`)
- `CLEANUP_FAILED_JOB_TTL_HOURS` (default `72`)
- `CLEANUP_TEMP_FILE_TTL_HOURS` (default `6`)

---

## 6. Job System Explanation
The queue is single-worker and persisted to SQLite (`job_queue`) for recovery after restart.

Supported job types:
- `indexPdf`
- `chatQuery`

Job lifecycle:
- `queued -> processing -> completed|failed`

Queue features:
- Retry with exponential backoff
- Live progress fields:
  - `progress` (0–100)
  - `stage` (`uploading|parsing|chunking|embedding|retrieving|generating`)
- Queue visibility:
  - `queuePosition` from `/api/v1/jobs/:jobId`

---

## 7. RAG Pipeline Explanation
Pipeline:
1. Upload PDF to temp disk path
2. Validate MIME, extension, and PDF signature
3. Move to permanent session storage
4. Parse text (`pdf-parse`)
5. Chunk text with overlap
6. Generate local embeddings (MiniLM)
7. Store chunks and vectors in SQLite
8. Retrieve relevant chunks using full-corpus paged similarity search
9. Generate answer with Gemini
10. Persist conversation history

Idempotency:
- Re-index replaces previous chunks for the same PDF (`replacePdfChunks`) and uses deterministic chunk keys.

---

## 8. Streaming Usage (SSE)
Enable streaming on chat:
- Add query param `stream=true`
- Or set header `Accept: text/event-stream`

Example:
```bash
curl -N -X POST "http://127.0.0.1:4000/api/v1/sessions/1/chat?stream=true" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"message":"Summarize the document."}'
```

SSE events:
- `ready`
- `progress`
- `token`
- `done`
- `error`

The final assistant message is stored only after successful stream completion.

---

## 9. Error Format Specification
All non-2xx responses use:
```json
{
  "ok": false,
  "error": {
    "code": "PDF_NOT_READY",
    "message": "Documents still processing or failed indexing.",
    "retryable": true
  }
}
```

Notes:
- `code`: stable machine-readable identifier
- `message`: human-readable explanation
- `retryable`: client can retry later

---

## 10. Performance Notes
Implemented optimizations:
- Uploads are disk-streamed (no large in-memory file buffering)
- Full-corpus retrieval is paged and yields to the event loop between pages
- Similarity search filters by embedding vector length
- Embedding generation uses adaptive batching
- Queue state is persisted and recoverable on restart

Operational guidance:
- SQLite is synchronous and can block under high concurrency
- For high throughput, consider external queue + vector DB + worker scaling

---

## 11. Known Limitations
- SQLite and `better-sqlite3` are not ideal for very high write/query concurrency
- No authentication/authorization yet
- Single-process queue worker (no distributed coordination)
- In-process rate limiting (not shared across instances)
- SSE streaming is one-way; no client-driven cancellation API yet

---

## 12. Future Roadmap
- Add authN/authZ and tenant isolation
- Introduce distributed queue (Redis/BullMQ or equivalent)
- Move vector search to ANN/vector database backend
- Add worker-thread or external worker offload for similarity scoring
- Add observability stack (traces, metrics, alerting)
- Add document-type expansion beyond PDF
- Add WebSocket bidirectional streaming option
