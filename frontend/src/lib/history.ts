import { api, BASE } from './api'

export type ProjectLite = {
  id: string
  name: string
  main_file: string
  engine: string
  ai_enabled?: boolean
  role?: string
  created_at?: string
  updated_at?: string
}

export type Version = {
  id: string
  project_id: string
  label: string | null
  kind: string
  created_by: string
  created_at: string
  file_count: number
}

export type VersionFile = {
  file_id: string
  name: string
  folder_id: string | null
  kind: string
  mime: string
  size: number
  archive_path: string
}

export type VersionDetail = Version & { files: VersionFile[] }

export type CommentAnchor = {
  line?: number
  column?: number
  snippet?: string
  [key: string]: unknown
}

export type CommentT = {
  id: string
  project_id: string
  file_id: string
  author_id: string
  author_name: string | null
  body: string
  anchor: CommentAnchor | null
  resolved_at: string | null
  created_at: string
}

export type ShareRole = 'viewer' | 'editor'

export type ShareLink = {
  id: string
  project_id: string
  role: ShareRole
  expires_at: string | null
  revoked_at: string | null
  created_at: string
}

export type ShareLinkCreated = ShareLink & { token: string; url: string }

export type Template = {
  id: string
  name: string
  description: string
  engine: string
  main_file?: string
}

export type SharedProject = {
  id: string
  name: string
  main_file: string
  engine: string
  role: ShareRole
  created_at: string
  updated_at: string
}

export type SharedTree = {
  folders: { id: string; name: string; parent_id: string | null }[]
  files: {
    id: string
    name: string
    kind: string
    mime: string
    size: number
    folder_id: string | null
  }[]
}

export type DocContent = { content: string; seq: number }

function jsonBody(body: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(body) }
}

function withQuery(path: string, params: Record<string, string | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, value)
  }
  const qs = search.toString()
  return qs ? `${path}?${qs}` : path
}

// --- Versions -------------------------------------------------------------

export function listVersions(projectId: string): Promise<Version[]> {
  return api<Version[]>(`/projects/${projectId}/versions`)
}

export function createVersion(projectId: string, label?: string): Promise<Version> {
  return api<Version>(`/projects/${projectId}/versions`, jsonBody(label ? { label } : {}))
}

export function getVersion(versionId: string): Promise<VersionDetail> {
  return api<VersionDetail>(`/versions/${versionId}`)
}

export function restoreVersion(
  versionId: string,
): Promise<{ restored: boolean; version_id: string; project_id: string; restored_files: number }> {
  return api(`/versions/${versionId}/restore`, { method: 'POST' })
}

// --- Comments -------------------------------------------------------------

export function listComments(
  projectId: string,
  fileId?: string | null,
  includeResolved = true,
): Promise<CommentT[]> {
  return api<CommentT[]>(
    withQuery(`/projects/${projectId}/comments`, {
      file_id: fileId || undefined,
      include_resolved: includeResolved ? undefined : 'false',
    }),
  )
}

export function createComment(
  projectId: string,
  input: { file_id: string; body: string; anchor?: CommentAnchor | null },
): Promise<CommentT> {
  return api<CommentT>(`/projects/${projectId}/comments`, jsonBody(input))
}

export function resolveComment(commentId: string): Promise<CommentT> {
  return api<CommentT>(`/comments/${commentId}/resolve`, { method: 'POST' })
}

export function deleteComment(commentId: string): Promise<void> {
  return api<void>(`/comments/${commentId}`, { method: 'DELETE' })
}

// --- Share links ----------------------------------------------------------

export function listShareLinks(projectId: string): Promise<ShareLink[]> {
  return api<ShareLink[]>(`/projects/${projectId}/share-links`)
}

export function createShareLink(
  projectId: string,
  role: ShareRole,
  expiresInDays?: number | null,
): Promise<ShareLinkCreated> {
  return api<ShareLinkCreated>(
    `/projects/${projectId}/share-links`,
    jsonBody({
      role,
      expires_in_days: expiresInDays ?? undefined,
    }),
  )
}

export function deleteShareLink(linkId: string): Promise<void> {
  return api<void>(`/share-links/${linkId}`, { method: 'DELETE' })
}

/** Absolute UI URL for a share token (the backend returns `/studio/share/<token>`). */
export function absoluteShareUrl(url: string): string {
  try {
    return new URL(url, window.location.origin).toString()
  } catch {
    return url
  }
}

// --- Templates ------------------------------------------------------------

export function listTemplates(): Promise<Template[]> {
  return api<Template[]>('/templates')
}

export function cloneTemplate(templateId: string, name: string): Promise<ProjectLite> {
  return api<ProjectLite>(`/templates/${templateId}/clone`, jsonBody({ name }))
}

// --- Public share viewer (no auth) ---------------------------------------

export function getSharedProject(token: string): Promise<SharedProject> {
  return api<SharedProject>(`/share/${token}`)
}

export function getSharedTree(token: string): Promise<SharedTree> {
  return api<SharedTree>(`/share/${token}/tree`)
}

export function getSharedFileContent(token: string, fileId: string): Promise<DocContent> {
  return api<DocContent>(`/share/${token}/files/${fileId}/content`)
}

export function sharedPdfUrl(token: string, jobId: string): string {
  return `${BASE}api/v1/share/${token}/compile/${jobId}/pdf`
}
