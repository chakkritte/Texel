import { type Range, StateEffect, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view'

export type ReviewState = {
  additions: { from: number; to: number }[]
  deletions: { pos: number; text: string }[]
}

export const setReviewEffect = StateEffect.define<ReviewState | null>()

class DeletedTextWidget extends WidgetType {
  constructor(readonly text: string) {
    super()
  }

  eq(other: DeletedTextWidget) {
    return other.text === this.text
  }

  toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-track-del'
    span.textContent = this.text
    return span
  }
}

function buildDecorations(docLength: number, review: ReviewState): DecorationSet {
  const ranges: Range<Decoration>[] = []
  for (const addition of review.additions) {
    const from = Math.max(0, Math.min(addition.from, docLength))
    const to = Math.max(from, Math.min(addition.to, docLength))
    if (to > from) {
      ranges.push(Decoration.mark({ class: 'cm-track-add' }).range(from, to))
    }
  }
  for (const deletion of review.deletions) {
    const pos = Math.max(0, Math.min(deletion.pos, docLength))
    ranges.push(
      Decoration.widget({
        widget: new DeletedTextWidget(deletion.text),
        side: 1,
      }).range(pos)
    )
  }
  ranges.sort((a, b) => a.from - b.from)
  return Decoration.set(ranges, true)
}

export const reviewField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, tr) {
    decorations = decorations.map(tr.changes)
    for (const effect of tr.effects) {
      if (effect.is(setReviewEffect)) {
        return effect.value
          ? buildDecorations(tr.state.doc.length, effect.value)
          : Decoration.none
      }
    }
    return decorations
  },
  provide: (field) => EditorView.decorations.from(field),
})
