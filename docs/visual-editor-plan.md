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

## Current status (Phase 3.1 + 3.2a/b/c + 3.3 + 3.4a/b delivered)

Visual mode now has two tabs: **Document** (the visual editor) and **PDF**.

Implemented with:

- `@unified-latex/unified-latex-to-hast` for AST → HTML conversion.
- KaTeX for inline and display math.
- Small macro replacements for common IEEE macros (`\uppercase`,
  `\authorrefmark`, `\IEEEmembership`, `\textsuperscript`).
- AST source offsets for mapping plain paragraphs and section headings back to
  the `.tex` source.
- Inline editing for plain paragraphs and headings; edits are escaped and
  written back through CodeMirror (so collaboration, undo and autosave work).
- No-op blurs are ignored to avoid spurious source changes.
- Inline and display math nodes are mapped back to their source ranges; clicking
  a rendered equation opens the equation builder and preserves its delimiters
  or environment (`$...$`, `\(...\)`, `\[...\]`, `equation`, `align`, ...).
- Inline formatting (`\textbf`, `\textit`, `\emph`, `\underline`, `\texttt`,
  `\textsc`) is editable through a B/I/U toolbar; the DOM is serialized back to
  LaTeX on blur.
- Simple `itemize` and `enumerate` lists are editable item by item (including
  inline formatting). Editing an item rewrites the whole list environment with
  its original environment name.
- Citation/reference/label keys are rendered as chips; clicking one opens a key
  editor that replaces only the key source range.
- `.bib` files in the project are parsed; citation chips show the matching
  entry metadata and a searchable picker lets authors select keys.
- `\includegraphics` images are resolved from project files through the
  authenticated download endpoint and displayed as blob URLs. Missing assets
  render a placeholder.
- Simple `tabular`/`tabularx`/`longtable` tables are editable cell by cell,
  including tables inside `table` floats. Captions, labels and column specs are
  preserved; unsupported tables remain read-only.
- Visual edits carry an expected source slice. If a remote collaborator changed
  that range first, the edit is rejected and a conflict notice is shown instead
  of clobbering the other change.
- Focused editable blocks publish an awareness `editingBlock` range. Other
  clients show a "Locked by …" overlay and cannot edit the same block.
- Complex blocks (mixed math paragraphs for text, labeled/nested lists, complex
  table cells, unknown macros) are rendered read-only with an "Edit in source"
  jump.

Known limitations of this phase:

- Text inside a mixed block (a paragraph containing math or macros) is still
  read-only; only its equations are click-to-edit.
- `\item[label]`, nested lists, and list items containing math or unsupported
  macros remain read-only.
- Formatting is limited to the supported emphasis commands; colors, font sizes,
  links and arbitrary macros are source-only.
- Tables using `\hline`, `\multicolumn`, `\multirow`, math or citations are
  read-only; table captions/labels are not editable from the visual view.
- `.bib` resolution powers the picker and chip metadata; reference numbering is
  not resolved.
- Only the active file is rendered; `\input`/`\include` are not expanded.
- Collaboration uses source ranges plus awareness locks, not a full
  ProseMirror/Yjs visual document model.
- Unknown macros degrade to text or empty spans.

## Delivery phases

### Phase 3.1 — Read-only visual AST (1–2 weeks) — delivered

- Parse the current file and render a visual, non-editable view.
- Unknown constructs render as text/source fallbacks.
- No mutations; useful to validate the parser and rendering.

### Phase 3.2 — Editable text + math + formatting/lists (3–4 weeks) — delivered (supported subset)

- Plain paragraph/heading editing with AST source ranges and safe escaping
  (delivered).
- Read-only rendering and "Edit in source" fallback for complex blocks
  (delivered).
- Click-to-edit inline and display equations with delimiter/environment
  preservation (delivered).
- Inline formatting through a B/I/U toolbar with LaTeX serialization
  (delivered).
- Simple itemize/enumerate list editing with inline formatting (delivered).
- Serializer with verbatim preservation of unchanged source slices (partially
  delivered: unchanged blocks are never rewritten).
- Round-trip tests on a corpus of real thesis/article files (pending).

### Phase 3.3 — Structure and collaboration (3–4 weeks) — delivered (supported subset)

- Citation/reference/label key editing (delivered).
- `\includegraphics` figures resolved from project files (delivered).
- Simple tabular tables rendered read-only (delivered).
- Source-range conflict guard for visual edits (delivered).
- Editable table cells, `.bib` citation resolution, nested structure (pending).
- Full Yjs/ProseMirror collaboration model and source ↔ visual cursor mapping
  (pending; current visual edits go through CodeMirror/Yjs source ranges).

### Phase 3.4 — Editable tables, `.bib` resolution and collaboration (delivered subset)

- Editable simple `tabular`/`tabularx`/`longtable` cells, including tables
  inside `table` floats; captions, labels and column specs preserved
  (delivered).
- `.bib` parser, citation-chip metadata and searchable citation picker
  (delivered).
- Awareness-based `editingBlock` locks plus the expected-source conflict guard
  (delivered).
- Full ProseMirror + Y.XmlFragment visual CRDT and source ↔ visual cursor
  mapping (pending; this is a separate architectural project).
- Hardening: fuzz/round-trip corpus, performance on large documents,
  accessibility and undo/redo (pending).

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
