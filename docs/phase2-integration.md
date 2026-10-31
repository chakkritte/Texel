# Phase 2 — Real-time collaboration integration

This document contains the exact steps to wire the new collaboration service
into the running Phase 1 stack. Nothing here requires changing
`backend/app/main.py`, `backend/app/models.py`, `backend/app/deps.py`, or
`docker-compose.yml` before the snippets below are applied.

## 1. What was added

| Path | Purpose |
|---|---|
| `backend/app/collab/main.py` | Standalone ASGI app: `app.collab.main:app` |
| `backend/app/collab/auth.py` | Bearer JWT auth + project-role check (queries DB directly, reuses `SessionLocal`/models) |
| `backend/app/collab/manager.py` | Per-doc pycrdt `Doc`, seq/dedupe, 5 s debounced persistence, idle unload, pub/sub fan-out |
| `backend/app/collab/store.py` | Redis Stream (capped 5000), atomic `INCR`+`XADD` Lua, dedupe keys, awareness cache |
| `backend/app/collab/protocol.py` | Base64 / state-vector / init-from-plain-text helpers (pure) |
| `backend/app/collab/schemas.py` | Pydantic request/response models |
| `backend/app/collab/keys.py` | Redis key naming |
| `backend/tests/test_collab_*.py` | Unit tests + opt-in DB/Redis integration test |
| `frontend/src/collab/httpProvider.ts` | `HttpYjsProvider` (sync, push, long-poll, awareness, backoff) |
| `frontend/src/collab/useCollabDoc.ts` | React hook returning Y.Doc / Awareness / status |
| `frontend/src/collab/base64.ts` | Browser base64 helpers |
| `frontend/src/collab/index.ts` | Public exports |
| `frontend/package.json` | Adds `yjs`, `y-protocols`, `y-indexeddb`, `y-codemirror.next` |

## 2. Compose: add the `collab` service

Add this service to `docker-compose.yml` (kept out of the file by the Phase 2
task to avoid conflicting with parallel edits):

```yaml
  collab:
    build: ./backend
    restart: unless-stopped
    command: uvicorn app.collab.main:app --host 0.0.0.0 --port 8000 --workers 1
    env_file: .env
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_started
    ports:
      - "127.0.0.1:9001:8000"
    volumes:
      - ./data:/data
    mem_limit: 1536m
    cpus: 1.5
```

Notes:

* `--workers 1` is recommended. Multiple workers/instances are supported (the
  Stream + pub/sub design handles it), but each process keeps its own pycrdt
  document in memory; one worker is the lowest-memory configuration.
* The service reuses the `backend` image, so no new Dockerfile is needed.
* It talks to Postgres/Redis over the compose network using the existing
  `DATABASE_URL` / `REDIS_URL` from `.env`.

## 3. Edge proxy: map `/studio/collab/`

Add to `/home/sgtech/proj/edge-proxy/apps/studio.conf` (inside the `/studio`
server block):

```nginx
# Long-polling: client holds 25 s, proxy read timeout must comfortably exceed
# that (plan uses 75 s).
location /studio/collab/ {
    proxy_pass http://127.0.0.1:9001/collab/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $forwarded_proto;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

    # Opportunistic WebSocket support; the HTTP provider never requires it.
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;

    proxy_read_timeout 75s;
    proxy_send_timeout 75s;
    proxy_buffering off;
    proxy_request_buffering off;
}
```

The trailing `/collab/` in `proxy_pass` replaces the matched `/studio/collab/`
prefix, so the service sees `/collab/v1/...` — exactly the routes it exposes.
No URL rewriting is done in the app.

## 4. `backend/app/main.py` — no change needed

The collaboration service is a **separate ASGI application**
(`app.collab.main:app`) with its own lifespan, Redis client and document
registry. It imports `app.db.SessionLocal`, `app.models` and
`app.security.decode_access_token`; it does not mount into or modify the main
API app. Keep the existing `uvicorn app.main:app` command for the `api`
service untouched.

## 5. Frontend usage

Install the new dependencies and build in Docker as usual:

```bash
cd frontend && npm install   # updates package-lock.json with the 4 Yjs deps
```

### 5.1 `HttpYjsProvider`

```ts
import { HttpYjsProvider } from '../collab'

const provider = new HttpYjsProvider({
  docId: file.id,              // file id (documents.id is also accepted)
  doc: ydoc,
  awareness,                   // reused by y-codemirror.next
  user: { name: user.email, color: '#2dd4bf' },
})
provider.connect()
// ... later
await provider.flush()         // push pending edits + persist before compile
provider.destroy()
```

Default API base is `${import.meta.env.BASE_URL}collab/v1` (i.e.
`/studio/collab/v1`). For the Vite dev server, which does not proxy that path,
set `VITE_COLLAB_URL=http://127.0.0.1:9001/collab/v1` (the collab service
allows `http://localhost:5173` via CORS), or pass `baseUrl` explicitly.

### 5.2 `useCollabDoc` with `y-codemirror.next`

`Editor.tsx` / `CodeMirrorEditor.tsx` are owned by the Phase 1 workstream, so
apply this change there when merging. Replace the `value`/`onChange` plumbing
with the CRDT binding; do **not** keep the effect that overwrites the whole
document from `value`, because Y.Text is now the source of truth.

```tsx
import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { StreamLanguage } from '@codemirror/language'
import { stex } from '@codemirror/legacy-modes/mode/stex'
import { yCollab } from 'y-codemirror.next'
import { useCollabDoc } from '../collab'

function CollabCodeMirror({
  fileId,
  initialContent,
  canEdit,
  userName,
}: {
  fileId: string
  initialContent: string
  canEdit: boolean
  userName: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const { ydoc, awareness, status, synced } = useCollabDoc(fileId, initialContent, {
    user: { name: userName },
  })

  useEffect(() => {
    if (!host.current) return
    const ytext = ydoc.getText('content')
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: ytext.toString(), // usually empty until the first sync lands
        extensions: [
          lineNumbers(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          StreamLanguage.define(stex),
          yCollab(ytext, awareness),          // CRDT <-> CodeMirror binding
          EditorView.editable.of(canEdit),
        ],
      }),
    })
    return () => view.destroy()
  }, [ydoc, awareness, canEdit])

  return (
    <div className="relative h-full">
      <div ref={host} className="h-full overflow-auto text-sm" />
      <span className="absolute right-2 top-1 text-xs text-zinc-500">
        {synced ? 'live' : status}
      </span>
    </div>
  )
}
```

Compile flow (in `Editor.tsx`): before requesting a compile, flush collab to
Postgres because the worker reads `documents.content`:

```ts
const { provider } = useCollabDoc(active.id, content)
// ...
async function compile() {
  await provider?.flush()       // POST /collab/v1/doc/:id/flush
  await api(`/projects/${id}/compile`, { method: 'POST' })
}
```

`initialContent` is only a fallback for an empty server document (or when
`{ enabled: false }`). The server initialises the CRDT from
`documents.content` on first open, so pre-inserting the Phase 1 text would
duplicate it.

## 6. HTTP contract

All routes are under `/collab/v1` (edge `/studio/collab/v1`). `doc_id` may be
either `files.id` or `documents.id`; `files.id` is what the editor already has.

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/doc/{doc_id}/sync` | `sv=<base64 state vector>` | `{seq, update, awareness[]}` |
| POST | `/doc/{doc_id}/update` | `{client_id, client_seq, update}` | `{seq}` |
| GET | `/doc/{doc_id}/poll` | `after=<seq>&timeout=25` | `{seq, updates:[{seq, update}], awareness[]}` or `204` |
| POST | `/doc/{doc_id}/awareness` | `{client_id, update}` | `204` |
| POST | `/doc/{doc_id}/flush` | — | `{seq}` (extra convenience route) |
| WS | `/collab/v1/ws?doc_id=&token=&sv=` | JSON frames | optional, same payloads |
| GET | `/collab/v1/healthz` | — | `{status, redis}` |

* Auth is `Authorization: Bearer <access JWT>` using
  `settings.jwt_secret` / `settings.jwt_algorithm`. WebSocket uses `?token=`
  because browsers cannot set WS headers.
* Any project owner/member may `sync` / `poll` / publish awareness.
  `update` and `flush` require role `editor` (or `owner`); viewers are
  read-only.
* `update` and `awareness` payloads are base64-encoded Yjs binary updates
  (proxy- and JSON-safe). `seq` is monotonic per document.
* Retries of `POST /update` with the same `(client_id, client_seq)` return the
  original seq (Redis dedupe, TTL 600 s); `Y.applyUpdate` is idempotent anyway.
  Two truly simultaneous duplicates landing on different instances may both be
  appended (an extra seq is consumed) but the document still converges.
* `poll` blocks up to `timeout` (server cap 60 s, client default 25 s) on an
  `asyncio.Condition`, woken by local updates and Redis pub/sub for
  cross-instance updates; the stream is re-read every ≤5 s as a safety net.

## 7. Persistence and limits

* Source of truth: `documents.ydoc_state` once a document has been opened by
  the collab service; `documents.content` is kept in sync for the compile
  worker and Phase 1 readers.
* Flush cadence: every 5 s while dirty, when the last tracked client
  disappears (client ids expire after 75 s), on idle unload (10 min) and on
  graceful shutdown. `POST .../flush` forces it.
* Redis Stream per document, `MAXLEN ~ 5000`; seq allocation + `XADD` happen
  atomically in Lua so `poll?after=N` cannot skip entries across instances.
* First open without `ydoc_state` (Phase 1 text only): the resulting CRDT
  bootstrap is published to `collab:init:<doc>` (24 h TTL) and adopted by every
  other instance, so instances share item history and can merge edits before
  the first Postgres flush. After that, the DB snapshot is authoritative.
* Document cap: 5 MiB of UTF-8 text. Oversized updates return `413` and the
  in-memory document is rolled back to the last persisted snapshot.
* Open-doc cap 256 per process; least-recently-used idle documents are
  unloaded. Awareness entries expire after 30 s (clients heartbeat every 15 s).

## 8. Tests

Unit tests (no Postgres/Redis, run in the backend image; the tests are
`unittest.TestCase` based so both `unittest` and `pytest` collect them):

```bash
docker run --rm -v "$PWD/backend:/app" -w /app --entrypoint python \
  latex-studio-worker -m unittest discover -s tests -p 'test_collab_*.py' -v

# or, where pytest is available:
#   cd backend && python -m pytest tests/test_collab_*.py
```

Opt-in integration test (needs the running stack's Postgres/Redis). The test
mounts the backend because `tests/` is not copied into the image:

```bash
docker run --rm --network latex-studio_studio --env-file .env \
  -e STUDIO_COLLAB_INTEGRATION=1 \
  -v "$PWD/backend:/app" -w /app --entrypoint python \
  latex-studio-worker -m unittest discover -s tests -p 'test_collab_integration.py' -v
```

The integration test creates its own user/project/file/document rows, runs
sync → update → dedupe → poll → awareness → flush, verifies persistence, and
deletes the fixture. It never touches the running containers' state besides
those rows.

## 9. Caveats / merge checklist

1. **Do not mix Phase 1 saves with collab writes.** `PUT
   /api/v1/files/{id}/content` replaces `documents.content` and bumps
   `documents.seq` without touching `ydoc_state`, which would diverge from the
   CRDT. Once the editor uses `useCollabDoc`, remove/disable that save path
   for collaborative files (the provider pushes every edit automatically).
2. **Compile freshness:** the worker reads `documents.content`; call
   `provider.flush()` (or `POST .../flush`) before compiling or a compile may
   miss up to ~5 s of edits.
3. **Idle unload / restart:** `ydoc_state` is flushed before unload, so a
   restart reconstructs the document from Postgres and then replays the Redis
   Stream tail. Redis is not a durable store for old history beyond the capped
   stream; Postgres is.
4. **Dev server:** `/studio/collab/` is edge-only. Use `VITE_COLLAB_URL` or a
   Vite proxy when running `npm run dev`.
5. **WebSocket:** implemented at `/collab/v1/ws` for opportunistic use but the
   frontend provider intentionally uses HTTP long-polling only (gw-22 does not
   forward upgrades).
6. **Offline storage:** `y-indexeddb` is installed for a future offline cache
   but is not wired into `useCollabDoc` yet; reconnect still drains queued
   edits from memory and re-syncs after transport failures.
7. **Awareness expiry:** entries have a 30 s TTL. Clients send a heartbeat
   every 15 s; a client that disappears without a removal update vanishes from
   presence within ~30 s.
8. **Roles:** viewers can read and publish presence but their `update` calls
   are rejected with `403`.
