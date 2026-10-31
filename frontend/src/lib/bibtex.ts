export type BibEntry = {
  key: string
  type: string
  title?: string
  author?: string
  year?: string
  venue?: string
}

function clean(value: string): string {
  return value.replace(/[{}]/g, ' ').replace(/\s+/g, ' ').trim()
}

function parseFields(text: string): Record<string, string> {
  const fields: Record<string, string> = {}
  let index = 0
  while (index < text.length) {
    const match = /^\s*,?\s*([a-zA-Z][\w-]*)\s*=\s*/.exec(text.slice(index))
    if (!match) break
    const name = match[1].toLowerCase()
    index += match[0].length
    let value = ''
    if (text[index] === '{') {
      let depth = 0
      const start = index + 1
      for (; index < text.length; index += 1) {
        const char = text[index]
        if (char === '{') depth += 1
        else if (char === '}') {
          depth -= 1
          if (depth === 0) {
            index += 1
            break
          }
          }
        }
      value = text.slice(start, index - 1)
    } else if (text[index] === '"') {
      const start = index + 1
      index += 1
      for (; index < text.length; index += 1) {
        const char = text[index]
        if (char === '\\') {
          index += 1
          continue
        }
        if (char === '"') {
          index += 1
          break
        }
      }
      value = text.slice(start, index - 1)
    } else {
      const start = index
      while (index < text.length && text[index] !== ',') index += 1
      value = text.slice(start, index)
    }
    fields[name] = clean(value)
    while (index < text.length && text[index] !== ',') index += 1
    if (text[index] === ',') index += 1
  }
  return fields
}

export function parseBibtex(source: string): BibEntry[] {
  const entries: BibEntry[] = []
  let index = 0
  while (index < source.length) {
    const at = source.indexOf('@', index)
    if (at === -1) break
    const header = /^@([a-zA-Z]+)\s*([{(])/.exec(source.slice(at))
    if (!header) {
      index = at + 1
      continue
    }
    const type = header[1].toLowerCase()
    if (type === 'comment' || type === 'preamble' || type === 'string') {
      index = at + 1
      continue
    }
    const open = header[2]
    const close = open === '{' ? '}' : ')'
    let cursor = at + header[0].length
    let depth = 1
    let inQuote = false
    for (; cursor < source.length && depth > 0; cursor += 1) {
      const char = source[cursor]
      if (inQuote) {
        if (char === '\\') cursor += 1
        else if (char === '"') inQuote = false
        continue
      }
      if (char === '"') inQuote = true
      else if (char === open) depth += 1
      else if (char === close) depth -= 1
    }
    if (depth !== 0) break
    const body = source.slice(at + header[0].length, cursor - 1)
    const comma = body.indexOf(',')
    const key = (comma === -1 ? body : body.slice(0, comma)).trim()
    if (!key) {
      index = cursor
      continue
    }
    const fields = parseFields(comma === -1 ? '' : body.slice(comma + 1))
    entries.push({
      key,
      type,
      title: fields.title,
      author: fields.author,
      year: fields.year,
      venue: fields.journal ?? fields.booktitle ?? fields.publisher,
    })
    index = cursor
  }
  return entries
}

export function formatBibEntry(entry: BibEntry): string {
  const firstAuthor = entry.author?.split(/\s+and\s+/i)[0]?.trim()
  const people = firstAuthor ? `${firstAuthor}${entry.author?.match(/\s+and\s+/i) ? ' et al.' : ''}` : ''
  const title = entry.title ? ` — ${entry.title}` : ''
  const year = entry.year ? ` (${entry.year})` : ''
  return `${people}${year}${title}`.trim() || entry.key
}
