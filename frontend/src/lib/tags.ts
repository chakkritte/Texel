export type ProjectTag = {
  id: string
  name: string
  color: string
}

/** Palette offered when creating a tag (all dark enough for white text). */
export const TAG_COLORS = [
  '#dc2626',
  '#ea580c',
  '#d97706',
  '#16a34a',
  '#0d9488',
  '#2563eb',
  '#7c3aed',
  '#db2777',
  '#475569',
]

/** Pick black or white text for a hex background. */
export function tagInk(color: string): string {
  const hex = color.replace('#', '')
  if (hex.length !== 6) return '#ffffff'
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b
  return luminance > 160 ? '#111827' : '#ffffff'
}
