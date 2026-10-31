# SGtech LaTeX Studio (Texel)

A self-hosted, collaborative LaTeX workspace for writing papers, theses and
reports in the browser. It combines a CodeMirror editor, real-time
collaboration, PDF preview with SyncTeX, project management and an AI writing
assistant.

## Features

- Real-time collaboration (Yjs/CRDT) with comments and share links
- CodeMirror 6 editor for `.tex`, `.bib`, `.sty`, `.cls` and other text files
- PDF preview with forward/inverse SyncTeX
- Equation builder popup with a visual toolbar and live preview (CodeCogs)
- Visual editor with inline editing for plain text, click-to-edit equations, and a PDF/SyncTeX view (Phase 3.2b)
- Compilation with a configurable engine:
  - `pdflatex`, `xelatex`, `lualatex` via TeX Live + `latexmk`
  - Tectonic as a fallback
- Project management: templates, `.zip` import/export, tags, archive, Trash and restore
- File tree with upload (single/multiple), rename and delete
- Version snapshots with restore
- AI assistant with model selection, selection-aware actions and diff-based edit proposals
- Admin panel for user management and custom templates (`.zip` upload)

## Stack

- Frontend: React 18, TypeScript, Vite, Tailwind CSS 4, CodeMirror 6
- Backend: FastAPI, SQLAlchemy (async), PostgreSQL, Redis, arq
- Collaboration: Yjs over an HTTP provider
- Compilation: Tectonic and full TeX Live Docker images
- Deployment: Docker Compose + nginx

## Quick start

1. Copy the environment template and fill in the secrets:

   ```bash
   cp .env.example .env
   ```

   Set `JWT_SECRET`, `HOST_DATA_DIR` (absolute path to this repo's `data/`
   directory on the host) and, if AI features are used, `ANTHROPIC_API_KEY`.

2. Make sure these Docker images are available on the host:

   - `overleaf-latex-full:6.3.2`
   - `tectonic-prod:0.17.0` (fallback compiler)

3. Build and start the services:

   ```bash
   docker compose up -d --build
   ```

4. Open `http://localhost:9002/` (or the path configured by your reverse proxy).

The first account that registers becomes an administrator. Administrators can
create/manage users and custom templates from `/admin`.

## Repository layout

```
backend/           FastAPI app, routers, collaboration, compile runner
frontend/          React app
compile/           TeX Live compile image (based on overleaf-latex-full)
compile-tectonic/  Tectonic compile image
docs/              Integration notes
docker-compose.yml Local deployment
```

## Notes

- `.env` and `data/` are intentionally git-ignored. Never commit user projects,
  snapshots or API keys.
- `HOST_DATA_DIR` must be an absolute host path because the worker bind-mounts
  project files into short-lived compile containers.
- The equation builder uses the free CodeCogs equation-editor API. CodeCogs
  displays a retirement notice for this API; moving to fxEditor requires a
  domain-bound licence. The editor is an equation tool only.
- The Visual mode Document tab edits plain paragraphs and headings inline and
  lets you click an inline/display equation to edit it with the equation
  builder (Phase 3.2b). Math delimiters and environments are preserved, edits
  are source-mapped, and LaTeX-special characters are escaped automatically.
  Blocks containing other complex constructs (lists, formatting, unknown
  macros) are rendered read-only with an "Edit in source" action. Only the
  active file is shown; `\input`/`\include` are not expanded. See
  [`docs/visual-editor-plan.md`](docs/visual-editor-plan.md) for the
  architecture, safety constraints and remaining phases.
