import { useState } from 'react'
import Icon from './shell/Icon'

export type FolderT = { id: string; name: string; parent_id: string | null }
export type FileT = {
  id: string
  name: string
  kind: string
  mime: string
  size: number
  folder_id: string | null
}
export type TreeT = { folders: FolderT[]; files: FileT[] }

const DRAG_MIME = 'application/x-studio-item'

type Props = {
  tree: TreeT
  activeId: string | null
  onSelect: (file: FileT) => void
  onMoveFile?: (fileId: string, folderId: string | null) => void
  onMoveFolder?: (folderId: string, parentId: string | null) => void
  /** When provided, each file row shows a rename action. */
  onRename?: (file: FileT) => void
  /** When provided, each file row shows a delete action. */
  onDelete?: (file: FileT) => void
}

function fileIconName(file: FileT): string {
  if (/\.(png|jpe?g|gif|svg|webp|ico|pdf)$/i.test(file.name)) return 'image'
  if (/\.(cls|sty|bst|bib|cfg|def)$/i.test(file.name)) return 'code'
  if (/\.(tex|ltx)$/i.test(file.name)) return 'description'
  return 'attach_file'
}

function FileRow({
  file,
  active,
  depth,
  onSelect,
  onRename,
  onDelete,
}: {
  file: FileT
  active: boolean
  depth: number
  onSelect: (file: FileT) => void
  onRename?: (file: FileT) => void
  onDelete?: (file: FileT) => void
}) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_MIME, `file:${file.id}`)
        e.dataTransfer.effectAllowed = 'move'
      }}
      style={{ paddingLeft: `${8 + depth * 14}px` }}
      className={`group mx-1 flex w-[calc(100%-0.5rem)] items-center gap-1 rounded-lg pr-1 transition-colors ${
        active
          ? 'bg-[var(--accent-soft)] font-medium text-[var(--color-on-secondary-container)]'
          : 'text-[var(--ink-2)] hover:bg-[var(--panel-3)]'
      }`}
    >
      <button
        type="button"
        onClick={() => onSelect(file)}
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-[13px]"
      >
        <Icon name={fileIconName(file)} size={16} className={active ? '' : 'text-[var(--muted)]'} />
        <span className="truncate">{file.name}</span>
      </button>
      {onRename && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onRename(file)
          }}
          title={`Rename ${file.name}`}
          aria-label={`Rename ${file.name}`}
          className="shrink-0 rounded-md p-1 text-[var(--muted)] opacity-0 transition-opacity hover:bg-[var(--accent-soft)] hover:text-[var(--accent)] focus-visible:opacity-100 group-hover:opacity-100 max-md:opacity-100"
        >
          <Icon name="edit" size={15} />
        </button>
      )}
      {onDelete && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onDelete(file)
          }}
          title={`Delete ${file.name}`}
          aria-label={`Delete ${file.name}`}
          className="shrink-0 rounded-md p-1 text-[var(--muted)] opacity-0 transition-opacity hover:bg-[var(--danger-soft)] hover:text-[var(--danger)] focus-visible:opacity-100 group-hover:opacity-100 max-md:opacity-100"
        >
          <Icon name="delete" size={15} />
        </button>
      )}
    </div>
  )
}

function FolderNode({
  folder,
  tree,
  activeId,
  onSelect,
  onMoveFile,
  onMoveFolder,
  onRename,
  onDelete,
  depth,
}: {
  folder: FolderT
  tree: TreeT
  activeId: string | null
  onSelect: (file: FileT) => void
  onMoveFile?: (fileId: string, folderId: string | null) => void
  onMoveFolder?: (folderId: string, parentId: string | null) => void
  onRename?: (file: FileT) => void
  onDelete?: (file: FileT) => void
  depth: number
}) {
  const [open, setOpen] = useState(true)
  const [dragOver, setDragOver] = useState(false)
  const folders = tree.folders.filter((f) => f.parent_id === folder.id)
  const files = tree.files.filter((f) => f.folder_id === folder.id)

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const payload = e.dataTransfer.getData(DRAG_MIME)
    if (!payload) return
    const [kind, id] = payload.split(':')
    if (kind === 'file') onMoveFile?.(id, folder.id)
    else if (kind === 'folder') onMoveFolder?.(id, folder.id)
  }

  return (
    <div>
      <button
        onClick={() => setOpen((value) => !value)}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_MIME, `folder:${folder.id}`)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onDragOver={(e) => {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        style={{ paddingLeft: `${6 + depth * 14}px` }}
        className={`mx-1 flex w-[calc(100%-0.5rem)] items-center gap-1 rounded-lg py-1.5 pr-2 text-left text-[13px] font-medium transition-colors ${
          dragOver
            ? 'bg-[var(--accent-soft)] text-[var(--color-on-secondary-container)]'
            : 'text-[var(--ink-2)] hover:bg-[var(--panel-3)]'
        }`}
        title="Drag to move, click to collapse"
      >
        <Icon name={open ? 'expand_more' : 'chevron_right'} size={16} />
        <Icon name={open ? 'folder_open' : 'folder'} size={16} />
        <span className="truncate">{folder.name}</span>
      </button>
      {open && (
        <>
          {folders.map((child) => (
            <FolderNode
              key={child.id}
              folder={child}
              tree={tree}
              activeId={activeId}
              onSelect={onSelect}
              onMoveFile={onMoveFile}
              onMoveFolder={onMoveFolder}
              onRename={onRename}
              onDelete={onDelete}
              depth={depth + 1}
            />
          ))}
          {files.map((file) => (
            <FileRow
              key={file.id}
              file={file}
              active={activeId === file.id}
              depth={depth + 1}
              onSelect={onSelect}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))}
        </>
      )}
    </div>
  )
}

export default function FileTree({
  tree,
  activeId,
  onSelect,
  onMoveFile,
  onMoveFolder,
  onRename,
  onDelete,
}: Props) {
  const roots = tree.folders.filter((f) => !f.parent_id)
  const rootFiles = tree.files.filter((f) => !f.folder_id)

  function dropToRoot(e: React.DragEvent) {
    e.preventDefault()
    const payload = e.dataTransfer.getData(DRAG_MIME)
    if (!payload) return
    const [kind, id] = payload.split(':')
    if (kind === 'file') onMoveFile?.(id, null)
    else if (kind === 'folder') onMoveFolder?.(id, null)
  }

  return (
    <div
      className="min-h-full py-1.5"
      onDragOver={(e) => e.preventDefault()}
      onDrop={dropToRoot}
    >
      {roots.map((folder) => (
        <FolderNode
          key={folder.id}
          folder={folder}
          tree={tree}
          activeId={activeId}
          onSelect={onSelect}
          onMoveFile={onMoveFile}
          onMoveFolder={onMoveFolder}
          onRename={onRename}
          onDelete={onDelete}
          depth={0}
        />
      ))}
      {rootFiles.map((file) => (
        <FileRow
          key={file.id}
          file={file}
          active={activeId === file.id}
          depth={0}
          onSelect={onSelect}
          onRename={onRename}
          onDelete={onDelete}
        />
      ))}
      {roots.length === 0 && rootFiles.length === 0 && (
        <div className="px-3 py-4 text-xs text-[var(--muted)]">No files</div>
      )}
      <div className="px-3 py-3 text-[10px] text-[var(--muted-2)]">
        Drag files or folders here to move them to the project root.
      </div>
    </div>
  )
}
