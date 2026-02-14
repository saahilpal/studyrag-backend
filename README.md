# StudyRAG Backend

Production-ready backend for session-based PDF ingestion, semantic indexing, and retrieval-augmented chat/quiz workflows.

## Description
StudyRAG Backend provides REST APIs to:
- create and manage study sessions
- upload and index PDFs asynchronously
- query indexed content with RAG chat
- generate quizzes from session context
- track queue state and runtime metrics

## Features
- Express API with consistent JSON envelopes
- SQLite persistence with startup migrations
- Background job queue for indexing/chat workloads
- Local embedding generation and vector similarity search
- PDF upload validation (size, MIME, extension, signature)
- Legacy endpoint compatibility with deprecation headers
- Structured operational logging

## Architecture
- `routes/`: HTTP handlers and transport-level validation
- `services/`: business/domain logic (sessions, uploads, queue, RAG, vectors)
- `db/`: SQLite connection and migration logic
- `middleware/`: cross-cutting concerns (rate limiting)
- `utils/`: shared helpers (async handler, logger, error normalization)

## Tech Stack
- Node.js (CommonJS)
- Express 5
- SQLite (`better-sqlite3`)
- Google Gemini API (`@google/genai`)
- Local embeddings (`@xenova/transformers`)
- Multer (multipart upload handling)

## API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/` | Service status |
| GET | `/health` | Service health |
| GET | `/api/v1/health` | API health check |
| GET | `/api/v1/ping` | Ping endpoint |
| GET | `/api/v1/sessions` | List sessions |
| POST | `/api/v1/sessions` | Create session |
| GET | `/api/v1/sessions/:sessionId` | Session details + PDFs |
| DELETE | `/api/v1/sessions/:sessionId` | Delete session |
| POST | `/api/v1/sessions/:sessionId/pdfs` | Upload PDF (multipart) |
| GET | `/api/v1/sessions/:sessionId/pdfs` | List PDFs in session |
| GET | `/api/v1/pdfs/:pdfId` | Get PDF metadata/status |
| DELETE | `/api/v1/pdfs/:pdfId` | Delete PDF record (+optional file) |
| POST | `/api/v1/sessions/:sessionId/chat` | Chat against indexed PDFs |
| GET | `/api/v1/sessions/:sessionId/history` | Get chat history |
| DELETE | `/api/v1/sessions/:sessionId/history` | Clear chat history |
| POST | `/api/v1/sessions/:sessionId/quiz` | Generate quiz JSON |
| GET | `/api/v1/jobs/:jobId` | Poll async job status |
| GET | `/api/v1/admin/queue` | Queue + metrics (non-prod) |
| POST | `/api/v1/admin/reset` | Reset uploads folder (non-prod) |

Legacy transitional endpoints remain:
- `/subjects`
- `/documents`
- `/rag/query`
- `/rag/quiz`

## Response Format

Success:
```json
{ "ok": true, "data": {} }
```

Error:
```json
{ "ok": false, "error": "MESSAGE" }
```

## Installation
```bash
npm install
```

## Environment Setup
1. Copy `.env.example` to `.env`.
2. Set required values, especially `GEMINI_API_KEY`.

Key environment variables:
- `PORT`
- `HOST`
- `NODE_ENV`
- `GEMINI_API_KEY`
- `GEMINI_MODEL`
- `MAX_UPLOAD_FILE_SIZE_BYTES`
- `RAG_*` and `LOCAL_EMBEDDING_*` tuning variables

## Run Instructions
Development:
```bash
npm run dev
```

Production-like local run:
```bash
npm start
```

Migrations:
```bash
node migrate.js --dry-run
node migrate.js
```

Optional legacy cleanup:
```bash
node migrate_cleanup.js
```

## Folder Structure
```text
.
├── app.js
├── server.js
├── config/
├── db/
├── middleware/
├── routes/
├── services/
├── utils/
├── scripts/
├── test/
└── data/
```

## Security Notes
- Uploads are restricted to PDF MIME + `.pdf` extension + `%PDF-` signature.
- Upload file size limits are enforced.
- Upload path operations are constrained to `data/uploads`.
- Internal stack traces are not exposed in API responses.
- Secrets must come from environment variables; do not commit `.env`.

## Deployment Guide
1. Provision Node.js runtime and persistent storage volume for `data/`.
2. Set environment variables from secret manager.
3. Install dependencies: `npm ci`.
4. Run migrations: `node migrate.js`.
5. Start service: `npm start`.
6. Put behind reverse proxy/load balancer with TLS.
7. Monitor logs and health endpoints.

## License
ISC
