# Phase 4 — History, comments, share links, templates

This document describes how to wire the Phase 4 backend and frontend code into the
existing Phase 1 application. Phase 4 code is deliberately additive: no existing
file was modified while it was written.

## What was added

Backend:

| File | Purpose |
| --- | --- |
| `backend/app/models_history.py` | SQLAlchemy models: `versions`, `version_files`, `comments`, `share_links`, `templates` |
| `backend/app/routers/history.py` | Snapshot create/list/get/restore (`.tar.gz` via stdlib `tarfile`) |
| `backend/app/routers/comments.py` | File comments, resolve, delete |
| `backend/app/routers/share.py` | Share-link management + public read-only `/share/{token}/...` endpoints |
| `backend/app/routers/templates.py` | Three built-in templates + clone endpoint |
| `backend/tests/test_history_*.py` | Unit tests for token hashing, snapshot manifest round-trip, template cloning logic |

Frontend:

| File | Purpose |
| --- | --- |
| `frontend/src/lib/history.ts` | Typed API helpers built on `api()` from `lib/api.ts` |
| `frontend/src/components/history/HistoryPanel.tsx` | Props: `{ projectId, onRestored? }` |
| `frontend/src/components/history/CommentsPanel.tsx` | Props: `{ projectId, fileId }` |
| `frontend/src/components/history/ShareDialog.tsx` | Props: `{ projectId }` (renders its own "Share" trigger) |
| `frontend/src/components/history/TemplatePicker.tsx` | Props: `{ onCreated }` |

## 1. Backend integration (`backend/app/main.py`)

`Base.metadata.create_all` only creates tables for models that have been imported
before the lifespan runs, so import `models_history` **and** include the four
routers. The router modules import `models_history` themselves, but the explicit
import documents the dependency and is order-independent.

```python
# backend/app/main.py
import app.models_history  # noqa: F401  # register Phase 4 tables before create_all
from app.routers import auth, comments, compile, history, projects, share, templates
```

```python
app.include_router(auth.router, prefix="/api/v1")
app.include_router(projects.router, prefix="/api/v1")
app.include_router(compile.router, prefix="/api/v1")
# Phase 4
app.include_router(history.router, prefix="/api/v1")
app.include_router(comments.router, prefix="/api/v1")
app.include_router(share.router, prefix="/api/v1")
app.include_router(templates.router, prefix="/api/v1")
```

No changes to `core/config.py` are required. The existing lifespan already creates
`{data_dir}/versions`, and snapshots are written to
`{data_dir}/versions/{project_id}/{version_id}.tar.gz`.

No Alembic migration is required for this phase: the app uses
`Base.metadata.create_all`, which creates the five missing tables on startup. If
the project later adopts Alembic, autogenerate a migration for the same tables.

Apply the code by rebuilding/restarting the API (and worker, which shares the
image) when convenient:

```bash
cd /home/sgtech/proj/latex-studio
docker compose build api worker
docker compose up -d api worker
```

## 2. Routes

All authenticated routes are mounted under `/api/v1` (public URL prefix
`/studio/api/v1`).

| Method | Path | Min role |
| --- | --- | --- |
| POST | `/projects/{project_id}/versions` | editor |
| GET | `/projects/{project_id}/versions` | viewer |
| GET | `/versions/{version_id}` | viewer |
| POST | `/versions/{version_id}/restore` | editor |
| GET | `/projects/{project_id}/comments?file_id=&include_resolved=` | viewer |
| POST | `/projects/{project_id}/comments` | commenter |
| POST | `/comments/{comment_id}/resolve` | commenter (author) or editor |
| DELETE | `/comments/{comment_id}` | commenter (author) or editor |
| POST | `/projects/{project_id}/share-links` | editor |
| GET | `/projects/{project_id}/share-links` | editor |
| DELETE | `/share-links/{link_id}` | editor |
| GET | `/share/{token}` | token |
| GET | `/share/{token}/tree` | token |
| GET | `/share/{token}/files/{file_id}/content` | token |
| GET | `/share/{token}/compile/{job_id}/pdf` | token |
| GET | `/templates` | authenticated |
| POST | `/templates/{template_id}/clone` | authenticated |

### Snapshot format

```
manifest.json          # project name/main_file/engine + file metadata
docs/{file_id}.tex     # documents.content
files/{file_id}        # binary bytes from files.disk_path
```

Restore writes text back into `documents.content`, clears `documents.ydoc_state`,
bumps `documents.seq`, re-creates deleted files (same UUIDs), restores binaries to
`{data_dir}/projects/{project_id}/files/{file_id}`, and drops references to
folders that no longer exist. The newest 20 versions per project are kept; older
archives and rows are removed after each new snapshot.

### Share links

* Raw token: `secrets.token_urlsafe(32)`; only its SHA-256 hex digest is stored.
* The raw token (and `url`) is returned **once** from the create endpoint.
* `url` is the frontend URL `/studio/share/{token}`; the API endpoints are under
  `/studio/api/v1/share/{token}/...`.
* Expired/revoked/unknown tokens return `404`. The public endpoints are read-only
  and do not require a bearer token.

### Templates

Built-ins are Python constants (no seed migration): `blank-article`,
`article-sections`, `ieee-two-column` (IEEEtran conference class). The
`templates` table exists for future persisted/custom templates; rows found there
are merged into `GET /templates` and can be cloned by id.

## 3. Frontend integration — `Editor.tsx`

The page files were intentionally not modified. Add the imports, a sidebar tab
state, the restore refresh helper, and the components as follows.

```tsx
import HistoryPanel from '../components/history/HistoryPanel'
import CommentsPanel from '../components/history/CommentsPanel'
import ShareDialog from '../components/history/ShareDialog'

// inside Editor():
const [sidePanel, setSidePanel] = useState<'files' | 'history' | 'comments'>('files')

async function refreshAfterRestore() {
  if (!id) return
  const t = await api<TreeT>(`/projects/${id}/tree`)
  setTree(t)
  if (active) {
    const current = t.files.find((f) => f.id === active.id)
    if (current) await loadContent(current)
  }
  setDirty(false)
  setJob(await api<Job | null>(`/projects/${id}/compiles/latest`).catch(() => null))
}
```

In the header, next to the Compile button:

```tsx
{id && <ShareDialog projectId={id} />}
```

Replace the contents of the left `<aside>` with tabbed panels (keep the existing
`newFile` button and `FileTree` under the "Files" tab):

```tsx
<aside className="flex w-72 shrink-0 flex-col overflow-hidden border-r bg-white">
  <div className="flex border-b">
    {(['files', 'history', 'comments'] as const).map((tab) => (
      <button
        key={tab}
        onClick={() => setSidePanel(tab)}
        className={`flex-1 px-2 py-2 text-xs capitalize ${
          sidePanel === tab ? 'border-b-2 border-emerald-600 font-medium' : 'text-zinc-500'
        }`}
      >
        {tab}
      </button>
    ))}
  </div>

  {sidePanel === 'files' && (
    <>
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-xs font-semibold uppercase text-zinc-500">Files</span>
        <button onClick={newFile} className="text-xs text-emerald-700 hover:underline">
          + New
        </button>
      </div>
      <FileTree tree={tree} activeId={active?.id ?? null} onSelect={loadContent} />
    </>
  )}

  <div className="min-h-0 flex-1 overflow-auto">
    {sidePanel === 'history' && id && (
      <HistoryPanel projectId={id} onRestored={refreshAfterRestore} />
    )}
    {sidePanel === 'comments' && id && (
      <CommentsPanel projectId={id} fileId={active?.id ?? null} />
    )}
  </div>
</aside>
```

`CommentsPanel` accepts `fileId: string | null`; it shows a hint until a file is
selected. Comments posted from the panel include only an optional anchor; wire a
selection anchor later by passing
`createComment(projectId, { file_id, body, anchor: { line, column, snippet } })`.

## 4. Frontend integration — `Projects.tsx`

Add `useNavigate` and `TemplatePicker`, then render the picker above (or instead
of) the existing name-only form:

```tsx
import { Link, useNavigate } from 'react-router-dom'
import TemplatePicker from '../components/history/TemplatePicker'

// inside Projects():
const navigate = useNavigate()

<TemplatePicker
  onCreated={(project) => {
    void queryClient.invalidateQueries({ queryKey: ['projects'] })
    navigate(`/projects/${project.id}`)
  }}
/>
```

The existing plain "New project name" form can stay as a quick blank-project
creator. `onCreated` receives the created `ProjectOut` payload (including `id`).

## 5. Public share viewer (follow-up page)

The backend public API is complete, but a public viewer page is outside this
change set (page/router files are owned by other work). To add it, register a
route **outside** the `Protected` wrapper in `App.tsx`:

```tsx
<Route path="/share/:token" element={<ShareView />} />
```

`ShareView` can be implemented entirely with `frontend/src/lib/history.ts`:

```tsx
import {
  getSharedProject,
  getSharedTree,
  getSharedFileContent,
  sharedPdfUrl,
} from '../lib/history'

// const project = await getSharedProject(token)
// const tree    = await getSharedTree(token)
// const doc     = await getSharedFileContent(token, fileId)
// <iframe src={sharedPdfUrl(token, jobId)} />
```

`sharedPdfUrl` returns a `/studio/api/v1/share/{token}/compile/{jobId}/pdf` URL
that works without a bearer token. The viewer is read-only by design; editor
share links have the same read-only public endpoints in this phase.

## 6. Tests

Phase 4 unit tests do not need Postgres, Redis, or Docker-in-Docker:

```bash
docker run --rm -v /home/sgtech/proj/latex-studio/backend:/app -w /app \
  --entrypoint sh latex-studio-worker -c \
  "pip install -q pytest && python -m pytest -q tests/test_history_*.py"
```

If pytest is already available in the environment, simply run
`pytest tests/test_history_*.py`. The tests cover:

* share token generation, SHA-256 hashing and expiry/revocation checks;
* snapshot manifest/archive round-trip in `tmp_path`, including binary and Unicode
  content, plus the 20-version retention rule;
* built-in template contents, clone payload construction and path-traversal
  rejection.

Syntax-only check without pytest:

```bash
docker run --rm -v /home/sgtech/proj/latex-studio/backend:/app -w /app \
  --entrypoint python latex-studio-worker -m compileall app
```

## 7. Caveats

* **Rebuild required.** The running `api` container has the Phase 1 image; the new
  tables/routers only exist after `docker compose build api worker` and restart.
* **Delete-project cleanup.** `projects.py` (not modified this phase) removes
  `projects/` and `compiles/` directories but not `versions/{project_id}`.
  `versions`/`version_files` rows are removed by the DB cascade, but snapshot
  archives remain on disk. Add `shutil.rmtree(Path(settings.data_dir) / "versions" / str(project_id))`
  to project deletion when convenient.
* **Token visibility.** Share tokens are hashed at rest, so `GET .../share-links`
  cannot re-display a URL; the create response is the only chance to copy it.
  Revoke and re-create if the link is lost.
* **Restore is source-only.** Snapshots contain sources, not compile artifacts.
  Restoring the same sources and recompiling reproduces the same PDF; there is no
  stored PDF in the snapshot. Yjs state is intentionally cleared so the next CRDT
  load starts from the restored `documents.content`.
* **Restore replaces live content.** There is no automatic pre-restore snapshot;
  take a manual version before restoring if the current state matters.
* **Concurrency.** Version restore writes plain rows; in a live collaborative
  session, clients should reconnect/reload after restore so their Yjs docs start
  from the restored content.
* **Share editor role.** Public share endpoints are read-only in this phase; an
  `editor` link currently grants no write access. Role is stored for future
  redeem-to-session flows.
* **Templates require a name.** `POST /templates/{id}/clone` validates
  `name` (1–200 chars). `TemplatePicker` defaults the field to the template name.
