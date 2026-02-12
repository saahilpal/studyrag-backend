# Chat-First PDF Analyzer Backend

## New API (v1)
- `GET /api/v1/health`
- `GET /api/v1/ping`
- `GET /api/v1/sessions`
- `POST /api/v1/sessions`
- `GET /api/v1/sessions/:sessionId`
- `DELETE /api/v1/sessions/:sessionId`
- `POST /api/v1/sessions/:sessionId/pdfs` (multipart upload)
- `GET /api/v1/sessions/:sessionId/pdfs`
- `GET /api/v1/pdfs/:pdfId`
- `DELETE /api/v1/pdfs/:pdfId?removeFile=false`
- `POST /api/v1/sessions/:sessionId/chat`
- `GET /api/v1/sessions/:sessionId/history`
- `DELETE /api/v1/sessions/:sessionId/history`
- `GET /api/v1/jobs/:jobId`
- `GET /api/v1/admin/queue` (dev only)

All success responses use:
```json
{ "ok": true, "data": {} }
```

## Migration
1. Dry run:
```bash
node migrate.js --dry-run
```
2. Execute migrations automatically on startup or manually:
```bash
node migrate.js
```
3. Optional legacy cleanup (after transition window):
```bash
node migrate_cleanup.js
# or
node scripts/migrate_cleanup.js
```

## Backward Compatibility
Legacy endpoints remain for one transitional release with deprecation headers:
- `/subjects`
- `/documents`
- `/rag/query`
- `/rag/quiz`

## Sample Data Loader
```bash
./scripts/load_sample_session.sh
```
