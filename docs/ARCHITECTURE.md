# Architecture Notes

This document provides a concise operational view of the backend runtime components.

## Runtime Topology

```text
Client
  -> Express API (/api/v1)
      -> Route layer
      -> Service layer
      -> SQLite
      -> Filesystem storage (uploads/temp)
      -> Gemini API
      -> Local embedding model
```

## Core Services
- `uploadService`: file validation and storage movement
- `indexingService`: parse/chunk/embed/store pipeline
- `vectorService`: retrieval and vector scoring
- `ragService`: prompt assembly and generation
- `jobQueue`: async orchestration with persistence
- `cleanupService`: periodic stale data cleanup

## Persistence
- SQLite tables for sessions, PDFs, chunks, chat messages, and queue jobs
- Upload files stored under `data/uploads`

## Contracts
- API base: `/api/v1`
- Success wrapper: `{ ok: true, data }`
- Error wrapper: `{ ok: false, error: { code, message, retryable } }`
