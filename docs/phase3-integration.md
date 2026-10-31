# Phase 3 — AI side panel: integration guide

This phase adds the AI panel backend (`/api/v1/ai/*`) and frontend
(`AiPanel`) without editing any Phase 1/2/4 file. The two files that must be
wired by their owners are `backend/app/main.py` and
`frontend/src/pages/Editor.tsx`.

## What was added

Backend:

- `backend/app/models_ai.py` — `ai_conversations`, `ai_messages`, `ai_usage`
  (SQLAlchemy models on the shared `Base`).
- `backend/app/ai/providers.py` — Anthropic Messages API (official
  `anthropic` async SDK, streaming) + Ollama `/api/chat` (httpx NDJSON
  stream), model catalog, pricing/cost calculation.
- `backend/app/ai/context.py` — context builder: current file or selection
  ±40 lines, file tree, resolved `\input`/`\include` (max 5 files), latest
  compile error + log tail, open comments (when the Phase 4 table exists),
  ~60k-token cap.
- `backend/app/ai/tools.py` — strict tool schemas `propose_edit` and
  `jump_to_error`, plus the fenced-JSON fallback for providers without native
  tools (Ollama).
- `backend/app/ai/service.py` — SSE orchestration, history, persistence,
  daily quota, usage aggregation.
- `backend/app/ai/schemas.py` — request/response models.
- `backend/app/routers/ai.py` — the HTTP routes.
- `backend/tests/test_ai_*.py` — unit tests (36 tests, including a mocked
  end-to-end SSE route test).
- `backend/requirements.txt` — adds `anthropic>=0.40` and `pytest>=8`.

Frontend:

- `frontend/src/lib/ai.ts` — typed API client and fetch + ReadableStream SSE
  parser (Bearer token, refresh-on-401, abort support).
- `frontend/src/components/ai/AiPanel.tsx` — left dock panel with Chat /
  Fix errors / Explain actions, model + conversation selectors, streaming
  chat, context hints, usage footer.
- `frontend/src/components/ai/ChatMessage.tsx` — message bubbles and tool
  cards.
- `frontend/src/components/ai/EditProposal.tsx` — proposed-edit diff with
  Apply / Reject and jump-to-error.
- `frontend/src/components/ai/ModelSelector.tsx`,
  `ContextHints.tsx`, `types.ts`, `index.ts`.

## 1. Backend integration (`backend/app/main.py`)

`ai_conversations` / `ai_messages` / `ai_usage` must be registered on
`Base.metadata` **before** `Base.metadata.create_all` runs in the lifespan.
Add the import near the existing model/router imports (top of the file):

```python
# Register Phase 3 tables before create_all() in lifespan().
from app.models_ai import AiConversation, AiMessage, AiUsage  # noqa: F401
from app.routers import ai
```

Then mount the router with the other routers:

```python
app.include_router(auth.router, prefix="/api/v1")
app.include_router(projects.router, prefix="/api/v1")
app.include_router(compile.router, prefix="/api/v1")
app.include_router(ai.router, prefix="/api/v1")   # <-- add this
```

The app's `root_path=/studio` means the public routes are
`/studio/api/v1/ai/...`; the router itself uses `/ai/...`.

No `core/config.py` change is required — `anthropic_api_key`,
`anthropic_model`, `ollama_base_url`, `ollama_api_key` and `ollama_model`
already exist. `AI_DAILY_TOKEN_QUOTA` is read from the process environment
(default `2000000` tokens/day) and is optional.

### Rebuild

`backend/requirements.txt` changed, so the `api` and `worker` images need a
rebuild when you deploy (the AI routes only run in `api`; `worker` shares the
image):

```bash
docker compose build api worker
docker compose up -d api worker
```

For a quick local check inside an already-running API container instead:

```bash
docker compose exec api pip install 'anthropic>=0.40'
docker compose restart api
```

## 2. Environment

| Variable | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | for Anthropic | Server-side key; never sent to the browser |
| `ANTHROPIC_MODEL` | no | Default Anthropic model (`claude-sonnet-5-5`) |
| `OLLAMA_BASE_URL` | no | Ollama endpoint (default `http://127.0.0.1:11434`; can be a cloud URL) |
| `OLLAMA_API_KEY` | no | Sent as `Authorization: Bearer ...` to Ollama when set |
| `OLLAMA_MODEL` | no | Default Ollama model (`qwen3:8b`) |
| `AI_DAILY_TOKEN_QUOTA` | no | Per-user daily token quota; default `2000000` |

Keys are read only from server settings. There is no BYOK path.

## 3. API reference

All routes require the normal `Authorization: Bearer <access token>` header.

| Method | Path (behind `/studio`) | Notes |
|---|---|---|
| GET | `/api/v1/ai/models` | `{providers:[{id, models, default}]}`; Ollama tags are fetched from `GET {OLLAMA_BASE_URL}/api/tags` and degrade to an empty list |
| GET | `/api/v1/ai/projects/{project_id}/conversations` | Current user's conversations in the project |
| POST | `/api/v1/ai/projects/{project_id}/conversations` | Body `{title?, provider?, model?}`; requires editor role |
| GET | `/api/v1/ai/conversations/{id}/messages` | Persisted user/assistant messages |
| POST | `/api/v1/ai/projects/{project_id}/messages` | SSE stream; requires editor role and `project.ai_enabled` |
| GET | `/api/v1/ai/usage?days=30` | Tokens/cost aggregated for the current user |

`POST /ai/projects/{id}/messages` body:

```json
{
  "conversation_id": "optional-uuid",
  "provider": "anthropic",
  "model": "claude-sonnet-5-5",
  "content": "Why does the build fail?",
  "context": {
    "file_id": "optional-file-uuid",
    "selection": { "from": 40, "to": 52, "text": "optional selected text" },
    "compile_job_id": "optional-compile-job-uuid"
  }
}
```

`selection.from` / `selection.to` are **0-based line numbers** (`to`
exclusive). The builder shows ±40 lines around that range and includes the
absolute character offsets so `propose_edit.range` can refer to the complete
file.

SSE frames (one event per blank-line-delimited frame, `X-Accel-Buffering:
no`):

```
event: token
data: {"text":"The error is "}

event: tool
data: {"name":"propose_edit","input":{"file_id":"...","range":{"from":10,"to":20},"replacement":"...","rationale":"..."}}

event: done
data: {"conversation_id":"...","message_id":"...","provider":"anthropic","model":"claude-sonnet-5-5","usage":{"tokens_in":1234,"tokens_out":200,"total_tokens":1434,"cost_usd":0.004468},"latency_ms":2100}

event: error
data: {"message":"Anthropic rate limit reached; please retry shortly."}
```

Quick curl check (create the token through the normal login flow):

```bash
curl -N -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"provider":"anthropic","model":"claude-sonnet-5-5","content":"Explain main.tex","context":{}}' \
  http://127.0.0.1:9000/api/v1/ai/projects/$PROJECT/messages
```

### Tool / edit approval contract

- `propose_edit{file_id, range:{from,to}, replacement, rationale}` — the
  server never applies it. The browser shows a diff; on **Apply** it fetches
  the file and calls the existing
  `PUT /api/v1/files/{file_id}/content`.
- `jump_to_error{file, line, message, job_id?}` — the browser calls the
  `onJumpToError` prop.
- Anthropic receives native tool definitions (`strict: true`). Ollama gets a
  system-prompt convention: emit a fenced ```json block with
  `{"tool":"propose_edit","input":{...}}`; the server parses it and emits the
  same `tool` SSE event.

`range.from` / `range.to` are **0-based character offsets** into the complete
file content (`to` exclusive).

### Quota / permissions

- `project.ai_enabled = false` → HTTP 403.
- Messages and conversation creation require the `editor` project role;
  listing conversations/messages requires `viewer`.
- A per-user daily quota (`AI_DAILY_TOKEN_QUOTA`) is checked before the
  stream starts; exceeding it returns HTTP 429.
- Usage is persisted in `ai_usage` after each completed turn (tokens, cost,
  latency); `ai_messages` stores role/content/model/token counts/tool calls.

## 4. Frontend integration (`frontend/src/pages/Editor.tsx`)

Import the panel:

```tsx
import { AiPanel } from '../components/ai'
import type { Selection } from '../lib/ai'
```

Add state for the selection (the Editor already has `project`, `active`,
`job`, `loadContent`, and `jumpToError`):

```tsx
const [aiSelection, setAiSelection] = useState<Selection | null>(null)

const compileError = job?.error
  ? { jobId: job.id, message: job.error }
  : null
```

Render the panel as the first left dock, as a sibling **before** the existing
file-tree `<aside>` inside `<div className="flex min-h-0 flex-1">`:

```tsx
{project?.ai_enabled && (
  <AiPanel
    projectId={project.id}
    fileId={active?.id ?? null}
    selection={aiSelection}
    compileError={compileError}
    onJumpToError={(target) => {
      // The Editor's existing helper resolves the file and moves the cursor.
      void jumpToError(target)
    }}
    onApplied={async (fileId) => {
      // Reload the editor if the applied file is currently open.
      if (active?.id === fileId && active) await loadContent(active)
    }}
  />
)}
```

`AiPanel` takes `projectId, fileId, selection, compileError, onJumpToError,
onApplied` exactly. `compileError` accepts either the structured
`CompileErrorInfo` object shown above or a plain compiler-message string
(e.g. `job?.error ?? null`). `onApplied(fileId)` is optional; it fires after
the browser successfully PUTs the approved content. `loadContent` already
refreshes the editor buffer and clears the dirty flag.

> Save unsaved editor changes before accepting an AI edit: `EditProposal`
> computes the replacement against the last saved server content.

### Selection (optional)

The panel works with `selection={null}` (whole current file is sent). To send
a selection, have `CodeMirrorEditor` report the 0-based line range:

```ts
// Suggested addition to CodeMirrorEditor: an optional onSelectionChange prop.
// import { EditorView } from '@codemirror/view'
const updateListener = EditorView.updateListener.of((update) => {
  if (!update.selectionSet && !update.docChanged) return
  const state = update.state
  const main = state.selection.main
  const from = state.doc.lineAt(main.from).number - 1
  const to = state.doc.lineAt(main.to).number // exclusive
  onSelectionChange?.({ from, to: main.empty ? from + 1 : to })
})
```

If you do not want to change `CodeMirrorEditor` yet, pass `selection={null}`.

### Jump-to-error

No editor changes are needed: `CodeMirrorEditor` already accepts a `jump`
prop and the Editor already has `jumpToError(err)`, which resolves the file
by basename, switches to it, and scrolls to the line. The panel calls
`onJumpToError` with `{file, line, message}`; wire it as shown above:

```tsx
onJumpToError={(target) => {
  void jumpToError(target)
}}
```

If you later change the Editor, keep the same contract: the panel emits a
project-relative `file`, a 1-based `line`, and the compiler `message`.

## 5. Tests

```bash
cd backend
pytest tests/test_ai_context.py tests/test_ai_tools.py \
       tests/test_ai_providers.py tests/test_ai_sse.py
```

The tests are pure/unit-level: context slicing/truncation/include resolution,
tool validation + JSON-block parsing, pricing, provider selection, SSE
framing and mocked provider streams. They do not need a database, Redis,
network, or API keys. (`available_providers` may wait up to ~4 s for a
non-existent Ollama tags endpoint; it returns an empty list on failure.)

Compile check used during development:

```bash
docker run --rm -v /home/sgtech/proj/latex-studio/backend:/app -w /app \
  --entrypoint python latex-studio-worker -m compileall app tests
```

## 6. Caveats

- **Edits are never applied server-side.** `EditProposal` fetches the current
  server content and PUTs the replacement after the user approves. Save
  unsaved editor changes first — otherwise the diff is computed against the
  last saved content. When Phase 2's Yjs path is ready, replace the PUT with a
  CRDT update (origin `ai`) as the plan specifies.
- **Ollama has no native tools here.** The model is asked to emit fenced JSON;
  parsing is best effort. Anthropic uses native `tool_use` blocks.
- **Prompt caching** is applied to the stable system + project block on
  Anthropic (`cache_control: {"type": "ephemeral"}`). Very small projects may
  fall under the provider's minimum cacheable prefix, so caching simply does
  not engage. The stable block deliberately omits timestamps/file sizes so
  moving the cursor or saving a file does not invalidate it unnecessarily.
- **History replay** uses the last 20 `ai_messages` and a ~20k-token budget,
  always starting on a user turn. Tool calls are persisted on the assistant
  message for the UI but are replayed to the model as text only.
- **Model catalog** is static (`settings.anthropic_model` plus the current
  Sonnet/Opus/Haiku IDs) and Ollama's `/api/tags`. It does not call the
  Anthropic Models API.
- **Costs** use the published per-1M-token rates in
  `app/ai/providers.py`; unknown/local models report `$0`.
- **Comments** are included when a `comments` table/`Comment` model exists
  (Phase 4 `app.models_history.Comment` is detected automatically; open
  comments have `resolved_at IS NULL`). If the table is absent the builder
  silently skips them.
- **Quota** is a simple daily sum of persisted tokens. Concurrent requests can
  overshoot slightly; there is no distributed lock.
- **SSE has no resume.** A reconnect reloads persisted messages; an in-flight
  turn that was cancelled is stored with partial text and zero usage.
- **Roles:** the panel is editor-only at the message endpoint; the Editor
  should hide it for viewers (`project.ai_enabled` check plus role).
- The Docker stack was **not** started/stopped/rebuilt while implementing this
  phase; the `anthropic` dependency takes effect on the next image build.
