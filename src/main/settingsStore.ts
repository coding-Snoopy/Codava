import { app, safeStorage } from 'electron'
import * as path from 'path'
import * as fs from 'fs/promises'

// ============================================================
// 类型定义
// ============================================================

export type ModelConfig = {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  timeoutMs: number
}

export type PromptTemplates = {
  functionSystem: string
  functionUser: string
  fileSystem: string
  fileUser: string
}

export type PromptScheme = {
  id: string
  name: string
  templates: PromptTemplates
}

export type AppSettings = {
  version: 1
  models: ModelConfig[]
  activeModelId: string
  promptSchemes: PromptScheme[]
  activeSchemeId: string
}

// 渲染进程看到的模型视图（API Key 已掩码）
export type ModelConfigView = Omit<ModelConfig, 'apiKey'> & { apiKey: string }

export type AppSettingsView = Omit<AppSettings, 'models'> & {
  models: ModelConfigView[]
}

// 渲染进程提交的模型输入（apiKey 可能是掩码值，表示未修改）
export type ModelConfigInput = {
  id?: string
  name: string
  baseUrl: string
  apiKey: string
  timeoutMs: number
}

// ============================================================
// ============================================================
// 默认 Prompt 模板
//
// 函数模板：用于逐函数重构。签名 & 语义一致性由质量门自动检查，
// 重试时系统会自动注入具体反馈，模板无需重复强调签名/语义约束。
//
// 文件模板：当前方案 C 中文件分析走内置固定 prompt，
// 此模板保留供用户自定义场景使用。
// ============================================================

export const DEFAULT_FUNCTION_SYSTEM =
  'You are a senior refactoring assistant. Return ONLY the full refactored function code. No markdown fences, no explanations.'

export const DEFAULT_FUNCTION_USER = [
  'Language: {{language}}',
  'File: {{filePath}}',
  '',
  'Refactor ONLY this function. Focus on improving code quality:',
  '1) Reduce cyclomatic complexity — flatten deep nesting, use early returns / guard clauses, simplify boolean logic.',
  '2) Improve performance — remove redundant work, reduce repeated computations / allocations, avoid unnecessary copies.',
  '3) Modernize — use language idioms, improve readability, eliminate dead code.',
  '',
  'If a retry feedback is given below, fix ONLY the listed issues; do not undo other improvements.',
  '',
  '{{instruction}}',
  '',
  'Function:',
  '```',
  '{{functionCode}}',
  '```',
  '{{ragContext}}'
].join('\n')

export const DEFAULT_FILE_SYSTEM =
  'You are a senior code analyst. Identify which functions in the given file would benefit most from refactoring. Return ONLY a JSON object, no markdown fences.'

export const DEFAULT_FILE_USER = [
  'Language: {{language}}',
  'File: {{filePath}}',
  '',
  '{{instruction}}',
  '',
  'Functions found in this file:',
  '{{functionList}}',
  '',
  'Analyze each function and return a JSON list of function names that should be refactored.',
  '',
  'Prioritize functions with:',
  '1) High cyclomatic complexity (deep nesting, many branches).',
  '2) Long functions that are hard to maintain.',
  '3) Code duplication, anti-patterns, or poor readability.',
  '4) Performance bottlenecks.',
  '',
  'Respond with ONLY a JSON object:',
  '{ "functions": ["func1", "func2"], "reasoning": "brief explanation in Chinese" }',
  '',
  'File content:',
  '```',
  '{{fileContent}}',
  '```'
].join('\n')

export function getDefaultTemplates(): PromptTemplates {
  return {
    functionSystem: DEFAULT_FUNCTION_SYSTEM,
    functionUser: DEFAULT_FUNCTION_USER,
    fileSystem: DEFAULT_FILE_SYSTEM,
    fileUser: DEFAULT_FILE_USER
  }
}

// ============================================================
// 模板变量定义
// ============================================================

export const FUNCTION_TEMPLATE_VARS = [
  'language',
  'filePath',
  'functionName',
  'functionCode',
  'instruction',
  'ragContext'
] as const

export const FILE_TEMPLATE_VARS = ['language', 'filePath', 'fileContent', 'instruction', 'functionList'] as const

// ============================================================
// 工具函数
// ============================================================

export function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 渲染模板：将 {{var}} 替换为实际值。
 * - 若某行中所有变量均为空，且去掉变量后只剩标签（如 "Instruction:"），则移除该行。
 * - 若某行仅由一个变量构成且该变量为空，也移除该行。
 * - 折叠连续空行为最多两个换行。
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  const lines = template.split('\n')
  const rendered: string[] = []

  for (const line of lines) {
    const varMatches = [...line.matchAll(/\{\{(\w+)\}\}/g)]
    const replaced = line.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? '')

    if (varMatches.length > 0) {
      const varNames = varMatches.map((m) => m[1])
      const allEmpty = varNames.every((name) => !vars[name])
      if (allEmpty) {
        const withoutVars = line.replace(/\{\{\w+\}\}/g, '').trim()
        // 去掉变量后只剩标签/空白 → 跳过该行
        if (!withoutVars || /^[\w\s]*:?\s*$/.test(withoutVars)) continue
      }
    }

    rendered.push(replaced)
  }

  return rendered
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 校验模板中的 {{var}} 占位符是否合法。
 * 返回非法变量名列表和未闭合标记列表。
 */
export function validateTemplate(
  template: string,
  allowedVars: readonly string[]
): { unknownVars: string[]; unclosed: boolean } {
  const unknownVars: string[] = []
  const seen = new Set<string>()

  for (const m of template.matchAll(/\{\{(\w+)\}\}/g)) {
    const name = m[1]
    if (!allowedVars.includes(name) && !seen.has(name)) {
      unknownVars.push(name)
      seen.add(name)
    }
  }

  // 检测未闭合的 {{
  const stripped = template.replace(/\{\{\w+\}\}/g, '')
  const unclosed = stripped.includes('{{')

  return { unknownVars, unclosed }
}

// ============================================================
// API Key 加密 / 解密 / 掩码
// ============================================================

const ENC_PREFIX = 'enc:'

export function encryptApiKey(plainKey: string): string {
  if (!plainKey) return ''
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const buf = safeStorage.encryptString(plainKey)
      return ENC_PREFIX + buf.toString('base64')
    }
  } catch {
    // 加密不可用时回退明文
  }
  return plainKey
}

export function decryptApiKey(storedKey: string): string {
  if (!storedKey) return ''
  if (storedKey.startsWith(ENC_PREFIX)) {
    try {
      const buf = Buffer.from(storedKey.slice(ENC_PREFIX.length), 'base64')
      return safeStorage.decryptString(buf)
    } catch {
      return ''
    }
  }
  return storedKey
}

export function maskApiKey(plainKey: string): string {
  if (!plainKey) return ''
  if (plainKey.length <= 8) return '****'
  return plainKey.slice(0, 3) + '****' + plainKey.slice(-4)
}

const MASKED_PATTERN = /^.{0,6}\*{3,}.{0,4}$/

export function isMaskedKey(key: string): boolean {
  return MASKED_PATTERN.test(key)
}

// ============================================================
// 持久化读写
// ============================================================

let cachedSettings: AppSettings | null = null

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

function createDefaultSettings(): AppSettings {
  const templates = getDefaultTemplates()
  const defaultScheme: PromptScheme = {
    id: 'default',
    name: '默认方案',
    templates
  }
  return {
    version: 1,
    models: [],
    activeModelId: '',
    promptSchemes: [defaultScheme],
    activeSchemeId: 'default'
  }
}

export async function initSettings(): Promise<AppSettings> {
  const filePath = getSettingsPath()
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as AppSettings
    // 基础校验
    if (parsed && Array.isArray(parsed.models) && Array.isArray(parsed.promptSchemes)) {
      cachedSettings = parsed
      return parsed
    }
  } catch {
    // 文件不存在或解析失败 → 初始化为空默认配置
  }

  const created = createDefaultSettings()
  cachedSettings = created
  await persistSettings(created)
  return created
}

export function getSettings(): AppSettings {
  if (!cachedSettings) {
    // 兜底：返回空默认配置（正常流程中 initSettings 已先调用）
    cachedSettings = createDefaultSettings()
  }
  return cachedSettings
}

async function persistSettings(s: AppSettings): Promise<void> {
  const filePath = getSettingsPath()
  const tmpPath = filePath + '.tmp'
  await fs.writeFile(tmpPath, JSON.stringify(s, null, 2), 'utf8')
  await fs.rename(tmpPath, filePath)
}

export async function saveSettingsToDisk(s: AppSettings): Promise<void> {
  cachedSettings = s
  await persistSettings(s)
}

// ============================================================
// 激活模型 / 方案读取器（供 LLM 调用函数使用）
// ============================================================

export function getActiveModel(): ModelConfig | null {
  const s = getSettings()
  if (!s.activeModelId) return null
  return s.models.find((m) => m.id === s.activeModelId) ?? null
}

export function getActiveScheme(): PromptScheme {
  const s = getSettings()
  const scheme = s.promptSchemes.find((p) => p.id === s.activeSchemeId)
  if (scheme) return scheme
  // 兜底：返回默认方案
  const templates = getDefaultTemplates()
  return { id: 'default', name: '默认方案', templates }
}

// ============================================================
// 导入 / 导出
// ============================================================

export function createExportData(s: AppSettings): object {
  return {
    version: s.version,
    models: s.models.map((m) => ({
      ...m,
      apiKey: maskApiKey(decryptApiKey(m.apiKey))
    })),
    activeModelId: s.activeModelId,
    promptSchemes: s.promptSchemes,
    activeSchemeId: s.activeSchemeId
  }
}

export function validateImportedSettings(json: unknown): AppSettings | null {
  if (!json || typeof json !== 'object') return null
  const obj = json as Record<string, unknown>

  if (!Array.isArray(obj.models) || !Array.isArray(obj.promptSchemes)) return null

  const models: ModelConfig[] = []
  for (const m of obj.models) {
    if (!m || typeof m !== 'object') return null
    const model = m as Record<string, unknown>
    if (typeof model.name !== 'string' || typeof model.baseUrl !== 'string') return null
    models.push({
      id: typeof model.id === 'string' ? model.id : generateId(),
      name: model.name,
      baseUrl: model.baseUrl,
      apiKey: typeof model.apiKey === 'string' ? model.apiKey : '',
      timeoutMs: typeof model.timeoutMs === 'number' ? model.timeoutMs : 120000
    })
  }

  const promptSchemes: PromptScheme[] = []
  for (const p of obj.promptSchemes) {
    if (!p || typeof p !== 'object') return null
    const scheme = p as Record<string, unknown>
    if (typeof scheme.name !== 'string') return null
    const t = scheme.templates as Record<string, unknown> | undefined
    if (!t || typeof t !== 'object') return null
    promptSchemes.push({
      id: typeof scheme.id === 'string' ? scheme.id : generateId(),
      name: scheme.name,
      templates: {
        functionSystem: typeof t.functionSystem === 'string' ? t.functionSystem : '',
        functionUser: typeof t.functionUser === 'string' ? t.functionUser : '',
        fileSystem: typeof t.fileSystem === 'string' ? t.fileSystem : '',
        fileUser: typeof t.fileUser === 'string' ? t.fileUser : ''
      }
    })
  }

  if (promptSchemes.length === 0) {
    promptSchemes.push({
      id: 'default',
      name: '默认方案',
      templates: getDefaultTemplates()
    })
  }

  return {
    version: 1,
    models,
    activeModelId:
      typeof obj.activeModelId === 'string' && models.some((m) => m.id === obj.activeModelId)
        ? obj.activeModelId
        : (models[0]?.id ?? ''),
    promptSchemes,
    activeSchemeId:
      typeof obj.activeSchemeId === 'string' &&
      promptSchemes.some((p) => p.id === obj.activeSchemeId)
        ? obj.activeSchemeId
        : promptSchemes[0].id
  }
}

/**
 * 合并导入的配置：导入的模型追加到现有列表（按名称去重），
 * 导入的 Prompt 方案替换现有方案。
 * 若导入的 apiKey 为掩码值，则保留本地已有的同名模型密钥。
 */
export function mergeImportedSettings(
  current: AppSettings,
  imported: AppSettings
): AppSettings {
  const models = [...current.models]

  for (const im of imported.models) {
    const existing = models.find((m) => m.name === im.name)
    if (existing) {
      // 同名模型：更新配置，但若导入的密钥是掩码则保留原密钥
      existing.baseUrl = im.baseUrl
      existing.timeoutMs = im.timeoutMs
      if (!isMaskedKey(im.apiKey)) {
        existing.apiKey = encryptApiKey(im.apiKey)
      }
    } else {
      models.push({
        ...im,
        id: generateId(),
        apiKey: isMaskedKey(im.apiKey) ? '' : encryptApiKey(im.apiKey)
      })
    }
  }

  return {
    version: 1,
    models,
    activeModelId: current.activeModelId || (models[0]?.id ?? ''),
    promptSchemes: imported.promptSchemes,
    activeSchemeId: imported.activeSchemeId
  }
}

// ============================================================
// 视图转换（API Key 掩码）
// ============================================================

export function toSettingsView(s: AppSettings): AppSettingsView {
  return {
    version: s.version,
    models: s.models.map((m) => ({
      ...m,
      apiKey: maskApiKey(decryptApiKey(m.apiKey))
    })),
    activeModelId: s.activeModelId,
    promptSchemes: s.promptSchemes,
    activeSchemeId: s.activeSchemeId
  }
}
