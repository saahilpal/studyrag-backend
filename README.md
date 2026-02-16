# Document-analyzer-rag Backend

## Overview
Document-analyzer-rag Backend is a Node.js service for session-based document ingestion, semantic indexing, and retrieval-augmented responses. It exposes versioned REST endpoints, processes PDF indexing asynchronously, and stores metadata/chunks in SQLite.

## Features
- Session and PDF lifecycle APIs
- Async indexing queue with retry support
- RAG chat generation flow
- Structured JSON response envelope
- Local vector search over stored chunk embeddings
- Input validation and upload safety controls
- Legacy endpoint compatibility layer for migration

## Architecture
- `src/routes`: HTTP transport layer and request validation
- `src/services`: core business logic (sessions, queue, indexing, RAG, vectors)
- `src/db`: database bootstrap and migration routines
- `src/middleware`: cross-cutting request middleware
- `src/utils`: shared utilities (logger, async handler, error normalization)
- `src/config`: provider configuration and runtime adapters

## Tech Stack
- Node.js (CommonJS)
- Express 5
- SQLite (`better-sqlite3`)
- Multer (multipart file uploads)
- `@xenova/transformers` (local embeddings)
- `@google/genai` (generation backend)

## Folder Structure
```text
.
├── src/
│   ├── config/
│   ├── db/
│   ├── middleware/
│   ├── routes/
│   ├── services/
│   └── utils/
├── scripts/
├── test/
├── migrate.js
├── migrate_cleanup.js
├── openapi.yaml
└── README.md
```

## Setup
1. Install dependencies:
```bash
npm install
```
2. Create environment file:
```bash
cp .env.example .env
```
3. Provide required values in `.env`:
- `GEMINI_API_KEY`
- `PORT`
- `HOST`
- `NODE_ENV`
- optional tuning variables (`RAG_*`, `LOCAL_EMBEDDING_*`, `MAX_UPLOAD_FILE_SIZE_BYTES`)

## Run Instructions
- Development:
```bash
npm run dev
```
- Standard run:
```bash
npm start
```
- Database migration:
```bash
node migrate.js --dry-run
node migrate.js
```
- Optional legacy cleanup:
```bash
node migrate_cleanup.js
```

## API Documentation
Primary spec: `openapi.yaml`

Core endpoints:
- `GET /api/v1/health`
- `GET /api/v1/sessions`
- `POST /api/v1/sessions`
- `POST /api/v1/sessions/:sessionId/pdfs`
- `POST /api/v1/sessions/:sessionId/chat`
- `GET /api/v1/jobs/:jobId`

Legacy compatibility endpoints:
- `/subjects`
- `/documents`
- `/rag/query`

## Error Format
Success responses:
```json
{ "ok": true, "data": {} }
```

Error responses:
```json
{ "ok": false, "error": "MESSAGE" }
```

## Security Notes
- Uploads are validated by MIME type, file extension, and PDF signature.
- File size limits are enforced at upload middleware and service level.
- Upload path operations are restricted to approved storage roots.
- Internal stack traces and sensitive runtime details are not returned to clients.
- Secrets are environment-driven; `.env` is ignored and must not be committed.

## Future Roadmap
- Authentication system
- Role system
- Cloud deployment
- Rate limiting
- Analytics
- Multiple document types
- Distributed processing
- Cloudflare tunnel support

## License
ISC
