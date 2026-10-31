# Full-document WYSIWYG: architecture and delivery plan

This document scopes the "Visual / WYSIWYG mode" for whole LaTeX documents. It
is deliberately separate from the equation builder: the CodeCogs editor (and
CodeCogs fxEditor) edit **one equation at a time** and cannot render or
round-trip a complete `.tex` document.

## Goal

Provide an editable visual view of the current `.tex` file that stays in sync
with the LaTeX source:

- Edit paragraphs, sections, lists, emphasis, math and simple tables visually.
- Insert/edit equations with a WYSIWYG math editor.
- Keep labels, citations, references and package-specific commands intact.
- Fall back to the source editor for constructs the visual model does not
  support, without losing content.

## Non-goals (initial phases)

- Arbitrary user-defined macros and `\newcommand` expansion.
- Every package-specific environment (`algorithm2e`, `tikz`, `thebibliography`
  layouts, custom thesis classes, etc.).
- Pixel-perfect rendering of the compiled PDF.
- Replacing the PDF + SyncTeX preview, which remains the source of truth for
  final layout.

## Why this is a separate project

A true visual LaTeX editor needs three pieces that do not exist in CodeCogs:

1. a LaTeX parser with source positions,
2. a rich-text document model with a reversible serializer,
3. a mapping between model positions and source positions (for diffs, undo,
   collaboration and preserving untouched markup).

Overleaf's Visual Editor is built on this pattern (ProseMirror + a LaTeX parser +
source mapping). Without the mapping, any visual edit can silently rewrite or
destroy unsupported LaTeX.

## Proposed architecture

### 1. Parser

- Use `@unified-latex/unified-latex` or `latex-utensils` to parse `.tex` into an
  AST with byte/line positions for every node.
- Preserve comments and raw source slices for unknown/unsupported nodes.
- Parse the document in isolation; do not expand includes in the visual layer.

### 2. Document model

- ProseMirror (or TipTap on top of ProseMirror) with a schema for:
  - document/section/subsection, paragraph, text with bold/italic/underline,
  - lists, blockquotes, verbatim/code,
  - inline math and display math nodes (store original LaTeX as an attribute),
  - citations/references as atomic nodes storing their LaTeX,
  - figures/tables as atomic blocks initially (not fully editable),
  - an `unsupported` node that renders a read-only source slice with an
    "Edit in source" action.
- Keep a `sourceRange` attribute on every node for mapping back to the `.tex`.

### 3. Serializer

- Serialize the ProseMirror document back to LaTeX by walking nodes in order.
- For unchanged nodes, copy the original source slice verbatim (preserve
  whitespace, comments and macro spelling).
- For edited nodes, emit canonical LaTeX for that node.
- Reject the save if the round-trip check fails (parse → serialize → parse) or if
  an edit would touch an unsupported construct.

### 4. Math

- Use MathLive for inline/display math editing, or reuse the existing equation
  dialog. Store the math node's LaTeX; never store only the rendered image.
- Validate math delimiters (`$...$`, `\[...\]`, environments) when serializing.

### 5. Collaboration

- Current collab is Y.Text via Yjs. A ProseMirror editor needs a Y.XmlFragment
  (or a ProseMirror-specific Yjs binding).
- Options:
  - **Recommended:** keep source mode as the collaborative source of truth;
    make visual mode a per-user, lock-aware editing session that commits
    changes back to Y.Text via the serializer.
  - Long term: migrate the document model to Y.XmlFragment and bind
    ProseMirror/Yjs directly.
- Start visual mode with a "Take editing lock" model if concurrent source
  editing is possible.

### 6. UI

- Toggle `Source | Visual` in the editor header.
- Visual mode hides the source pane and shows the visual document + a
  "Compile / PDF" split.
- Unsupported nodes show a source block with an "Edit in source" button that
  switches back to source mode at the corresponding line.
- Errors from the round-trip parser appear in a problems panel.

## Delivery phases

### Phase 3.1 — Read-only visual AST (1–2 weeks)

- Parse the current file and render a visual, non-editable view.
- Unknown constructs render as source blocks.
- No mutations; useful to validate the parser and rendering.

### Phase 3.2 — Editable text + math (3–4 weeks)

- ProseMirror editing for paragraphs, headings, emphasis, lists and math.
- Serializer with verbatim preservation of unchanged source slices.
- Round-trip tests on a corpus of real thesis/article files.
- "Edit in source" fallback for unsupported nodes.

### Phase 3.3 — Structure and collaboration (3–4 weeks)

- Sections, citations/references, figures, simple tables.
- Yjs/ProseMirror collaboration model and locking.
- Source ↔ visual cursor mapping.

### Phase 3.4 — Hardening (2 weeks)

- Fuzz/round-trip corpus, performance on large documents, accessibility,
  undo/redo, conflict handling and user documentation.

## Test strategy

- Golden round-trip corpus: parse → serialize must be byte-identical for files
  with no visual edits.
- Per-node round-trip tests for edited nodes.
- Compile-equality tests: compile source and round-tripped source; compare
  extracted text, page count and log warnings.
- Visual regression screenshots for common constructs.
- Load/soak tests for collaboration and large documents.

## Decision points

1. Which document classes/templates must be supported in the first release?
2. Is visual mode collaborative from day one, or single-editor with a lock?
3. Should unsupported constructs be read-only (recommended) or automatically
   rewritten?
4. Which parser/schema libraries are acceptable dependencies?

Until these are agreed, the safe scope is the current equation builder plus the
read-only Visual preview; shipping partial full-document editing would risk
silently corrupting LaTeX projects.
