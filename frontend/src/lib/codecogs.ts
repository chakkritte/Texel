/**
 * Loader for the legacy CodeCogs equation editor API.
 *
 * The reference page (chakkritte.github.io/cv/math.html) uses this free
 * no-key build. It is an equation editor only: a toolbar, a LaTeX input and
 * a rendered preview. It does not provide whole-document WYSIWYG editing.
 */

const SCRIPT_URL = 'https://editor.codecogs.com/eqneditor.api.min.js'
const STYLE_URL = 'https://editor.codecogs.com/eqneditor.css'
const SCRIPT_ID = 'codecogs-eqneditor-api'
const STYLE_ID = 'codecogs-eqneditor-css'

let loader: Promise<void> | null = null

declare global {
  interface Window {
    EqEditor?: any
  }
}

export function loadCodeCogsEditor(): Promise<void> {
  if (window.EqEditor) return Promise.resolve()
  if (loader) return loader

  loader = new Promise<void>((resolve, reject) => {
    if (!document.getElementById(STYLE_ID)) {
      const link = document.createElement('link')
      link.id = STYLE_ID
      link.rel = 'stylesheet'
      link.href = STYLE_URL
      document.head.appendChild(link)
    }

    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null
    if (existing) {
      if (window.EqEditor) {
        resolve()
        return
      }
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener(
        'error',
        () => reject(new Error('Could not load the equation editor')),
        { once: true },
      )
      return
    }

    const script = document.createElement('script')
    script.id = SCRIPT_ID
    script.src = SCRIPT_URL
    script.async = true
    script.addEventListener('load', () => resolve(), { once: true })
    script.addEventListener(
      'error',
      () => reject(new Error('Could not load the equation editor')),
      { once: true },
    )
    document.head.appendChild(script)
  }).catch((error) => {
    // Allow a later retry after a network failure.
    loader = null
    throw error
  })

  return loader
}
