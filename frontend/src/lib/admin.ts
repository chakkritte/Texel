export type AdminUser = {
  id: string
  email: string
  display_name: string
  is_admin: boolean
  is_active: boolean
  created_at: string
  project_count: number
}

export type AdminTemplateFile = {
  name: string
  kind?: 'doc' | 'binary'
}

export type AdminTemplate = {
  id: string
  name: string
  description: string
  engine: 'pdflatex' | 'xelatex' | 'lualatex' | string
  main_file: string
  files: AdminTemplateFile[]
  builtin: boolean
}
