import type { FileT } from '../components/FileTree'

export const TEXT_EXT_RE =
  /\.(tex|ltx|bib|sty|cls|txt|md|csv|json|ya?ml|cfg|def|bst|clo|fd|dtx|ins|log)$/i
export const IMAGE_EXT_RE = /\.(png|jpe?g|gif|svg|webp|ico|bmp|avif)$/i

export function isTextFile(file: FileT): boolean {
  return file.kind === 'doc' || TEXT_EXT_RE.test(file.name)
}

export function isTexFile(file: FileT): boolean {
  return /\.(tex|ltx)$/i.test(file.name)
}

export function isImageFile(file: FileT): boolean {
  return IMAGE_EXT_RE.test(file.name) || (file.mime ?? '').startsWith('image/')
}

export function isPdfFile(file: FileT): boolean {
  return /\.pdf$/i.test(file.name) || file.mime === 'application/pdf'
}

export function fileIconName(file: FileT): string {
  if (isImageFile(file)) return 'image'
  if (isPdfFile(file)) return 'picture_as_pdf'
  if (/\.(bib|bst)$/i.test(file.name)) return 'menu_book'
  if (/\.(cls|sty|cfg|def)$/i.test(file.name)) return 'code'
  if (isTextFile(file)) return 'description'
  return 'attach_file'
}
