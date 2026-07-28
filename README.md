# Stage 2: Backend JSON Store

netlify functions + netlify blobs storage works independently of any UI
goal is to prove the storage layer persists data correctly before
building anything on top of it

## Existing infrastructure

- `netlify.toml` routes `/api/*` to Netlify Functions
- `netlify/functions/_store.js` shared helpers: `getLessonStore`,
  `readLessons`/`writeLessons`, `readExceptions`/`writeExceptions`,
  `jsonResponse`, `nextId`, `timesOverlap` (the last one isn't used yet will be wired into validation in Stage 3)
- `netlify/functions/lessons.js` minimal `GET` (list) + `POST` (add) only.
  No validation, no conflict checking, no update/delete yet.

there is **no `public/` UI in this stage** — it's backend-only tested directly via HTTP

## Tests

```bash
# Add a lesson
curl -X POST http://localhost:8888/api/lessons \
  -H "Content-Type: application/json" \
  -d '{"student":"Sam","subject":"Algebra","day_of_week":1,"start_time":"16:00","end_time":"17:00"}'

# List lessons and confirm it persisted
curl http://localhost:8888/api/lessons
```

## Missing

- No validation or conflict checking (Stage 3)
- No update/delete (Stage 3)
- No frontend calendar (Stage 3 reconnects Stage 1's UI to this backend)
- No AI assistant (Stage 4)
- No rate limiting (Stage 5)
