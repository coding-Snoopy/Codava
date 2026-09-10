import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join, extname } from 'path'
import * as path from 'path'
import * as fs from 'fs/promises'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { parseFunctionsTreeSitter, analyzeFileWithTreeSitter } from './treeSitterFunctions'
import {
  calculateCyclomaticComplexityAST,
  calculateFileComplexity,
  calculateFunctionComplexities
} from './cyclomaticComplexity'
import { parseFunctionsFallbackLocal } from './signatureChecker'
import {
  initSettings,
  getSettings,
  saveSettingsToDisk,
  getActiveModel,
  getActiveScheme,
  renderTemplate,
  toSettingsView,
  generateId,
  encryptApiKey,
  decryptApiKey,
  isMaskedKey,
  createExportData,
  validateImportedSettings,
  mergeImportedSettings,
  type ModelConfigInput,
  type PromptScheme
} from './settingsStore'
import { runFunctionRefactorWithQG, runFileRefactorWithAnalysis } from './refactorQualityGate'
import { FailureReportManager } from './failureReport'
import {
  appendRefactorHistory,
  markRefactorHistoryApplied,
  type AppendRefactorHistoryInput
} from './refactorHistory'

// 记录正在进行的“LLM 重构请求”，用于实现取消。
// key: requestId（由渲染进程生成并透传）
// value: AbortController（用于 abort fetch）
const inflightRefactorControllers = new Map<string, AbortController>()

// 记录正在进行的“批量重构任务”的取消标记。
// key: batchId；value: 可变对象，置 cancelled=true 后文件循环会在下一个文件前停止
const batchCancelFlags = new Map<string, { cancelled: boolean }>()

// 加载特定模型的 .env 文件
async function loadModelDotEnv(model: string): Promise<void> {
  // 使用与 API 调用相同的模型名称规范化逻辑
  const normalizedModel = model.toLowerCase().replace(/[^a-z0-9-.]/g, '-')
  const modelEnvPath = path.join(process.cwd(), `.env.${normalizedModel}`)
  // 强制加载模型特定的配置文件，覆盖现有的环境变量
  await tryLoadDotEnvFile(modelEnvPath, true)
  console.log(`已尝试加载模型配置文件: ${modelEnvPath}`)
}
type ParsedFunction = {
  id: string
  name: string
  startByte: number
  endByte: number
  startLine: number
  endLine: number
}

// 历史记录只能写入用户通过目录选择器打开的项目中。
let activeProjectRoot: string | null = null

type FileTreeNode = {
  id: string
  label: string
  path: string
  kind: 'dir' | 'file'
  children?: FileTreeNode[]
}

/**
 * 轻量级 .env 加载器（不引入 dotenv 依赖）。
 * - 对于模型特定的配置文件，强制覆盖环境变量。
 * - 对于通用 .env 文件，仅在对应 key 尚未存在时才写入。
 * - 支持 `export KEY=VALUE` 形式。
 * - 支持单/双引号包裹，并做常见转义（\n/\r/\t/\\ 等）。
 */
async function tryLoadDotEnvFile(dotEnvPath: string, force: boolean = false): Promise<boolean> {
  try {
    const raw = await fs.readFile(dotEnvPath, 'utf8')
    const loadedKeys: string[] = []

    for (const lineRaw of raw.split(/\r?\n/)) {
      const line = lineRaw.trim()
      if (!line || line.startsWith('#')) continue

      const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line
      const eq = normalized.indexOf('=')
      if (eq <= 0) continue

      const key = normalized.slice(0, eq).trim()
      let value = normalized.slice(eq + 1).trim()
      if (!key) continue

      const quoted =
        (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
      if (quoted) {
        value = value.slice(1, -1)
        value = value
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\\\/g, '\\')
          .replace(/\\"/g, '"')
          .replace(/\\'/g, "'")
      }

      if (force || process.env[key] === undefined) {
        process.env[key] = value
        loadedKeys.push(key)
      }
    }

    if (loadedKeys.length) {
      console.log(`[env] loaded ${loadedKeys.length} keys from ${dotEnvPath}`)
    }
    return true
  } catch {
    return false
  }
}
function countSourceLines(code: string): number {
  if (code.length === 0) return 0
  return code.split(/\r\n|\r|\n/).length
}

async function buildFileTree(rootDir: string): Promise<FileTreeNode> {
  const rootLabel = path.basename(rootDir) || rootDir

  async function walk(dirPath: string): Promise<FileTreeNode[]> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    const nodes: FileTreeNode[] = []

    for (const entry of entries) {
      // 跳过常见“噪声目录”，避免无意义的扫描与渲染成本
      if (
        entry.name === '.git' ||
        entry.name === 'node_modules' ||
        entry.name === 'out' ||
        entry.name === 'dist'
      ) {
        continue
      }

      // 跳过批量重构生成的备份目录（原文件夹名 + Backup），防止备份内容被二次扫描/重构
      if (entry.isDirectory() && entry.name.endsWith('Backup')) {
        continue
      }

      const fullPath = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        const children = await walk(fullPath)
        nodes.push({
          id: fullPath,
          label: entry.name === '.aosp-refactor' ? '重构记录' : entry.name,
          path: fullPath,
          kind: 'dir',
          children
        })
      } else if (entry.isFile()) {
        nodes.push({
          id: fullPath,
          label: entry.name,
          path: fullPath,
          kind: 'file'
        })
      }
    }

    // 排序：目录在前、文件在后；同类按名称排序
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
      return a.label.localeCompare(b.label)
    })

    return nodes
  }

  return {
    id: rootDir,
    label: rootLabel,
    path: rootDir,
    kind: 'dir',
    children: await walk(rootDir)
  }
}

function parseFunctionsFallback(filePath: string, fileBytes: Buffer): ParsedFunction[] {
  // 兜底函数解析（启发式）：查找形如 "name(...) { ... }" 的块，并排除 if/for/while 等控制结构。
  // 说明：此解析方式不保证 100% 准确，仅在 Tree-sitter 解析失败时兜底保证 UI 流程可用。
  const text = fileBytes.toString('utf8')
  const isJava = extname(filePath).toLowerCase() === '.java'

  const controlKeywords = new Set([
    'if',
    'for',
    'while',
    'switch',
    'catch',
    'foreach',
    'do',
    'synchronized'
  ])

  const results: ParsedFunction[] = []
  const candidateRegex = /\)\s*\{/g

  // 预计算所有换行符位置（O(n) 一次），后续行号查询用二分查找（O(log n)），
  // 避免“每个函数从头扫描到 offset”造成的 O(函数数 × 文件大小) 开销（大文件关键优化）
  const newlineOffsets: number[] = []
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) newlineOffsets.push(i)
  }

  function findFallbackFunctionStart(openParenIndex: number): number {
    // 回溯到“当前函数声明片段”的起点：
    // - 以最近的 ; / { / } 作为边界
    // - 这样可以尽量包含返回类型、作用域限定符、修饰符等
    let start = openParenIndex
    while (start > 0) {
      const prev = text[start - 1]
      if (prev === ';' || prev === '{' || prev === '}') break
      start--
    }

    // 跳过边界后的空白符，避免把空行/缩进纳入函数范围
    while (start < openParenIndex && /\s/.test(text[start])) {
      start++
    }

    return start
  }

  function getLineNumberAt(index: number): number {
    // 行号从 1 开始（与编辑器 UI 展示一致）：行号 = 1 + index 之前的换行符数量
    let lo = 0
    let hi = newlineOffsets.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (newlineOffsets[mid] < index) lo = mid + 1
      else hi = mid
    }
    return lo + 1
  }

  // 从 '(' 前反向提取最后一个标识符作为函数名。
  // 避免 text.slice(0, openParen) 为每个候选位置做一次 O(n) 字符串拷贝（大文件关键优化）。
  function extractNameBeforeParen(openParenIndex: number): string | null {
    let end = openParenIndex - 1
    while (end >= 0 && /\s/.test(text[end])) end--
    let start = end
    while (start >= 0 && /[A-Za-z0-9_]/.test(text[start])) start--
    if (start === end) return null
    const name = text.slice(start + 1, end + 1)
    return /^[A-Za-z_]/.test(name) ? name : null
  }

  function findMatchingBrace(openBraceIndex: number): number {
    let depth = 0
    let inStr: '"' | "'" | '`' | null = null
    let inLineComment = false
    let inBlockComment = false

    for (let i = openBraceIndex; i < text.length; i++) {
      const ch = text[i]
      const next = i + 1 < text.length ? text[i + 1] : ''

      if (inLineComment) {
        if (ch === '\n') inLineComment = false
        continue
      }
      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false
          i++
        }
        continue
      }
      if (inStr) {
        if (ch === '\\') {
          i++
          continue
        }
        if (ch === inStr) inStr = null
        continue
      }

      if (ch === '/' && next === '/') {
        inLineComment = true
        i++
        continue
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true
        i++
        continue
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        inStr = ch
        continue
      }

      if (ch === '{') depth++
      if (ch === '}') {
        depth--
        if (depth === 0) return i + 1
      }
    }
    return -1
  }

  let match: RegExpExecArray | null
  while ((match = candidateRegex.exec(text)) !== null) {
    const openBrace = match.index + match[0].length - 1

    // 从右向左回溯：找到与当前 ')' 配对的 '('
    // 并据此提取 '(' 前最后一个标识符作为“函数名”
    const closeParen = match.index
    let parenDepth = 0
    let openParen = -1
    for (let i = closeParen; i >= 0; i--) {
      const ch = text[i]
      if (ch === ')') parenDepth++
      else if (ch === '(') {
        parenDepth--
        if (parenDepth === 0) {
          openParen = i
          break
        }
      }
    }
    if (openParen < 0) continue

    const name = extractNameBeforeParen(openParen)
    if (!name) continue
    if (controlKeywords.has(name)) continue

    // Java：启发式跳过匿名内部类/lambda 等容易误判为“函数”的结构
    if (isJava && name === 'new') continue

    const endByte = findMatchingBrace(openBrace)
    if (endByte < 0) continue

    const startByte = findFallbackFunctionStart(openParen)
    const startLine = getLineNumberAt(startByte)
    const endLine = getLineNumberAt(endByte)

    const id = `${filePath}:${startByte}-${endByte}`
    results.push({ id, name, startByte, endByte, startLine, endLine })
  }

  // 按 startByte 去重（避免同一位置被多次命中）
  const seen = new Set<number>()
  return results
    .filter((f) => {
      if (seen.has(f.startByte)) return false
      seen.add(f.startByte)
      return true
    })
    .sort((a, b) => a.startByte - b.startByte)
}

async function callFunctionRefactorLLM(params: {
  filePath: string
  language: string
  functionName: string
  functionCode: string
  instruction?: string
  abortController?: AbortController
}): Promise<{ refactoredFunctionCode: string; raw?: unknown }> {
  function readTimeoutMs(): number {
    // 超时时间来自激活模型配置，未配置时使用默认值
    const activeModel = getActiveModel()
    if (activeModel && activeModel.timeoutMs > 0) return activeModel.timeoutMs
    return 120_000
  }
  function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  function normalizeRefactoredFunctionOutput(code: string, functionName: string): string {
    const trimmed = code.trim()
    const name = (functionName || '').trim()
    if (!name) return trimmed

    // 处理模型偶发的“函数签名前缀重复”问题，例如：
    // `bool A::fbool A::f(...) { ... }`
    const duplicatedPrefixPattern = new RegExp(
      `^([\\s\\S]*?\\b${escapeRegExp(name)}\\b)\\s*\\1(?=\\s*\\()`
    )

    return trimmed.replace(duplicatedPrefixPattern, '$1')
  }

  // 从设置中心读取激活模型配置
  const activeModel = getActiveModel()
  const baseUrl = (activeModel?.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')
  const apiKey = (activeModel ? decryptApiKey(activeModel.apiKey) : '').trim()
  let model = activeModel?.name || 'gpt-4.1-mini'
  const originalModel = model
  model = model.toLowerCase().replace(/[^a-z0-9-.]/g, '-')
  console.log(
    `[DEBUG] Model: original=${originalModel}, normalized=${model}, baseUrl=${baseUrl}, apiKeyExists=${!!apiKey}, source=${activeModel ? 'settings' : 'default'}`
  )

  if (!apiKey) {
    const banner = `/* MOCK: set LLM_API_KEY/LLM_BASE_URL/LLM_MODEL to enable real refactor */\n`
    return { refactoredFunctionCode: banner + params.functionCode }
  }

  let ragContext = ''
  try {
    const ragBaseUrl = process.env.RAG_API_BASE_URL || 'http://localhost:8000'
    const searchUrl = `${ragBaseUrl}/api/search_similar`

    const searchResponse = await fetch(searchUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        target_code: params.functionCode
      })
    })

    if (searchResponse.ok) {
      const searchResult = await searchResponse.json()
      if (searchResult.found && searchResult.before_code && searchResult.after_code) {
        ragContext = `\n\n[Reference Example] (Please refer to the following historical refactoring style for this refactoring)\n[Before Code]\n${searchResult.before_code}\n[After Code]\n${searchResult.after_code}\n`
        console.log(`[RAG] Found similar record, similarity: ${searchResult.similarity}`)
      } else {
        console.log(`[RAG] No sufficiently similar record found: ${searchResult.message}`)
      }
    } else {
      console.log(`[RAG] Search service unavailable: ${searchResponse.status}`)
    }
  } catch (error) {
    console.log('[RAG] Search failed, continuing with refactoring:', error)
  }

  // 从激活 Prompt 方案读取模板，渲染变量
  const scheme = getActiveScheme()
  const system = scheme.templates.functionSystem

  const user = renderTemplate(scheme.templates.functionUser, {
    language: params.language,
    filePath: params.filePath,
    functionName: params.functionName,
    functionCode: params.functionCode,
    instruction: params.instruction || '',
    ragContext
  })

  // 调试日志：显示完整的提示词（包括 RAG 增强的上下文）
  console.log('\n' + '='.repeat(80))
  console.log('[DEBUG] === COMPLETE PROMPT SENT TO LLM (with RAG context) ===')
  console.log('='.repeat(80))
  console.log('\n[SYSTEM PROMPT]:')
  console.log(system)
  console.log('\n[USER PROMPT]:')
  console.log(user)
  console.log('\n' + '='.repeat(80))
  console.log('[DEBUG] === END OF PROMPT ===')
  console.log('='.repeat(80) + '\n')

  // 根据模型类型确定 API 端点和请求格式
  // 所有模型都使用 OpenAI 兼容接口格式
  const url = `${baseUrl}/v1/chat/completions`
  const requestBody = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0.2,
    max_tokens: 4096
    // timeout: 60000
  }

  const abortController = params.abortController
  const timeoutMs = readTimeoutMs()
  const shouldTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0

  let timer: NodeJS.Timeout | null = null
  if (abortController && shouldTimeout) {
    timer = setTimeout(() => {
      // 标记为超时取消；渲染端会显示该错误信息
      abortController.abort('timeout')
    }, timeoutMs)
  }

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      signal: abortController?.signal,
      body: JSON.stringify(requestBody)
    })

    if (!resp.ok) {
      const text = await resp.text()
      throw new Error(`LLM request failed: ${resp.status} ${resp.statusText}: ${text}`)
    }

    const json = await resp.json()
    // 所有模型都使用 OpenAI 兼容响应格式
    const content = json?.choices?.[0]?.message?.content

    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('LLM returned empty content')
    }

    // 如果模型输出被 ``` 代码围栏包裹（可能前后还带有说明文字），优先提取第一个围栏内的代码；
    // 取不到时再回退到“去除首尾围栏”的原逻辑，保证写回时只包含函数体本身
    let cleaned = content.trim()
    const fenceMatch = cleaned.match(/```[a-zA-Z0-9_-]*\r?\n?([\s\S]*?)\r?\n?```/)
    if (fenceMatch && fenceMatch[1].trim().length > 0) {
      cleaned = fenceMatch[1].trim()
    } else {
      cleaned = cleaned
        .replace(/^```[a-zA-Z0-9_-]*\r?\n?/, '')
        .replace(/\r?\n?```\s*$/, '')
        .trim()
    }
    const normalized = normalizeRefactoredFunctionOutput(cleaned, params.functionName)
    // 控制台打印全部的模型输出
    console.log('LLM raw response:', JSON.stringify(json, null, 2))

    return { refactoredFunctionCode: normalized, raw: json }
  } catch (e: unknown) {
    // fetch 被 AbortController 取消时，这里统一转换成更友好的错误信息
    if (abortController?.signal?.aborted) {
      const reason = (abortController.signal as AbortSignal & { reason?: unknown }).reason
      if (reason === 'timeout') {
        throw new Error(`LLM 请求超时（${timeoutMs}ms），可在 .env 设置 LLM_TIMEOUT_MS 调整`)
      }
      throw new Error('已取消本次重构请求')
    }
    throw e
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// 语义检查 LLM 调用器：使用 settingsStore 的模型配置（而非 process.env）
async function callLLMForSemCheck(params: {
  system: string
  user: string
  abortController?: AbortController
}): Promise<string> {
  const activeModel = getActiveModel()
  const baseUrl = (activeModel?.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')
  const apiKey = (activeModel ? decryptApiKey(activeModel.apiKey) : '').trim()
  let model = activeModel?.name || 'gpt-4.1-mini'
  const originalModel = model
  model = model.toLowerCase().replace(/[^a-z0-9-.]/g, '-')

  if (!apiKey) {
    console.log('[QG SemCheck] Mock 模式（无 API Key），跳过 LLM 调用')
    return ''
  }

  console.log('\n' + '='.repeat(80))
  console.log('[QG SemCheck] === 语义检查 LLM 请求 ===')
  console.log(`[QG SemCheck] Model: ${model} (original: ${originalModel}), BaseURL: ${baseUrl}`)
  console.log('[QG SemCheck] [SYSTEM PROMPT]:')
  console.log(params.system)
  console.log('[QG SemCheck] [USER PROMPT]:')
  console.log(params.user)
  console.log('='.repeat(80) + '\n')

  const url = `${baseUrl}/v1/chat/completions`
  const requestBody = {
    model,
    messages: [
      { role: 'system' as const, content: params.system },
      { role: 'user' as const, content: params.user }
    ],
    temperature: 0.1,
    max_tokens: 2048
  }

  const timeoutMs = (() => {
    if (activeModel && activeModel.timeoutMs > 0) return activeModel.timeoutMs
    return 120_000
  })()

  const abortController = params.abortController
  let timer: NodeJS.Timeout | null = null

  if (abortController) {
    timer = setTimeout(() => abortController.abort('timeout'), timeoutMs)
  }

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      signal: abortController?.signal,
      body: JSON.stringify(requestBody)
    })

    if (!resp.ok) {
      const text = await resp.text()
      throw new Error(`LLM request failed: ${resp.status} ${resp.statusText}: ${text}`)
    }

    const json = await resp.json() as Record<string, unknown>
    const content = (json as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content

    console.log('[QG SemCheck] LLM raw response:', JSON.stringify(json, null, 2))

    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('LLM returned empty content')
    }

    console.log('[QG SemCheck] 解析结果:', content.trim())
    return content
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// 函数分析 LLM 调用器（Plan C 分析优先模式）：发送整个文件，返回值得重构的函数名列表
async function callFunctionAnalysisLLM(params: {
  filePath: string
  language: string
  fileContent: string
  functions: Array<{ name: string; startLine: number; endLine: number }>
  instruction?: string
  abortController?: AbortController
}): Promise<{ functions: string[]; raw?: unknown }> {
  const activeModel = getActiveModel()
  const baseUrl = (activeModel?.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')
  const apiKey = (activeModel ? decryptApiKey(activeModel.apiKey) : '').trim()
  let model = activeModel?.name || 'gpt-4.1-mini'
  model = model.toLowerCase().replace(/[^a-z0-9-.]/g, '-')

  if (!apiKey) {
    console.log('[QG Analysis] Mock 模式（无 API Key），返回所有函数')
    return { functions: params.functions.map((f) => f.name) }
  }

  const fnList = params.functions
    .map((f, i) => `${i + 1}. ${f.name}() (行 ${f.startLine}-${f.endLine})`)
    .join('\n')

  // 从设置中心读取文件分析 Prompt 模板
  const scheme = getActiveScheme()
  const system = renderTemplate(scheme.templates.fileSystem, {
    language: params.language,
    filePath: params.filePath,
    fileContent: params.fileContent,
    instruction: params.instruction || '',
    functionList: fnList
  })
  const user = renderTemplate(scheme.templates.fileUser, {
    language: params.language,
    filePath: params.filePath,
    fileContent: params.fileContent,
    instruction: params.instruction || '',
    functionList: fnList
  })

  const url = `${baseUrl}/v1/chat/completions`
  const requestBody = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0.3,
    max_tokens: 2048
  }

  const timeoutMs = activeModel?.timeoutMs || 120_000
  const abortController = params.abortController
  let timer: NodeJS.Timeout | null = null
  if (abortController) {
    timer = setTimeout(() => abortController.abort('timeout'), timeoutMs)
  }

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      signal: abortController?.signal,
      body: JSON.stringify(requestBody)
    })

    if (!resp.ok) {
      const text = await resp.text()
      throw new Error(`LLM request failed: ${resp.status} ${resp.statusText}: ${text}`)
    }

    const json = await resp.json() as Record<string, unknown>
    const content = (json as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content

    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('LLM returned empty content')
    }

    let parsed: Record<string, unknown> | null = null
    try {
      parsed = JSON.parse(content.trim()) as Record<string, unknown>
    } catch {
      const jsonMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?```/.exec(content)
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[1].trim()) as Record<string, unknown>
        } catch { /* fall through */ }
      }
    }

    if (parsed && Array.isArray(parsed.functions)) {
      const selectedNames = parsed.functions.map(String).filter((n) =>
        params.functions.some((f) => f.name === n)
      )
      console.log(`[QG Analysis] LLM 分析选中 ${selectedNames.length} 个函数:`, selectedNames)
      return { functions: selectedNames, raw: json }
    }

    // 解析失败，返回所有函数
    return { functions: params.functions.map((f) => f.name) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// 判断路径是否位于批量重构备份目录（任意一级目录名以 Backup 结尾）内
function isInBackupDir(filePath: string): boolean {
  const segments = filePath.split(/[\\/]/)
  // 最后一段是文件名，只检查目录段
  return segments.slice(0, -1).some((segment) => segment.endsWith('Backup'))
}

// 批量重构前备份：仅备份将被修改的文件，按相对根目录的路径存放
// 备份位置固定为根目录同级的“原文件夹名 + Backup”文件夹，每次运行前清空重建（固定名称覆盖）
async function backupDirectory(rootDir: string, files: string[]): Promise<string> {
  const parentDir = path.dirname(rootDir)
  const folderName = path.basename(rootDir)
  const backupDir = path.join(parentDir, `${folderName}Backup`)
  // 清空旧备份，避免残留历史文件
  await fs.rm(backupDir, { recursive: true, force: true })
  for (const file of files) {
    const relativePath = path.relative(rootDir, file)
    // 防御：跳过不在根目录内的文件（含跨盘符时 path.relative 返回绝对路径的情况）
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) continue
    const destPath = path.join(backupDir, relativePath)
    await fs.mkdir(path.dirname(destPath), { recursive: true })
    await fs.copyFile(file, destPath)
  }
  return backupDir
}

type CodeAuditSeverity = 'low' | 'medium' | 'high' | 'critical'

type VulnerabilityFinding = {
  vulnerabilityType: string
  cause: string
  potentialHarm: string
  fixSuggestion: string
  severity: CodeAuditSeverity
  vulLineStart: number
  vulLineEnd: number
  vulLineRange: string
}

type SafeCodeAnalysis = {
  codeFunction: string
  securityAssessment: string
  potentialRisks: string
  improvementSuggestions: string
}

type FunctionAuditEntry = {
  functionName: string
  startLine: number
  endLine: number
  overallRisk: CodeAuditSeverity
  hasVulnerabilities: boolean
  vulnerabilities?: VulnerabilityFinding[]
  safeCodeAnalysis?: SafeCodeAnalysis
}

type CodeAuditReport = {
  filePath: string
  scope: 'original' | 'refactored'
  language: string
  model: string
  scanCoverage: string
  summary: string
  generatedAt: string
  functionResults: FunctionAuditEntry[]
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return trimmed

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim()
  }

  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1)
  }

  return trimmed
}

async function callFileAuditLLM(params: {
  filePath: string
  language: string
  fileContent: string
  scope: 'original' | 'refactored'
  abortController?: AbortController
}): Promise<{ report: CodeAuditReport; raw?: unknown }> {
  function readTimeoutMs(): number {
    // 超时时间来自激活模型配置，未配置时使用默认值
    const activeModel = getActiveModel()
    if (activeModel && activeModel.timeoutMs > 0) return activeModel.timeoutMs
    return 120_000
  }
  function readEnvTimeoutMs(): number {
    const raw = (process.env.LLM_TIMEOUT_MS || '').trim()
    if (!raw) return readTimeoutMs()
    const n = Number.parseInt(raw, 10)
    if (!Number.isFinite(n)) return readTimeoutMs()
    return n
  }

  // 从设置中心读取激活模型配置
  const activeModel = getActiveModel()
  const baseUrl = (activeModel?.baseUrl || process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
  const apiKey = (activeModel ? decryptApiKey(activeModel.apiKey) : (process.env.LLM_API_KEY || '')).trim()
  let model = activeModel?.name || process.env.LLM_MODEL || 'gpt-4.1-mini'
  const originalModel = model
  model = model.toLowerCase().replace(/[^a-z0-9-.]/g, '-')
  console.log(
    `[DEBUG] Audit model: original=${originalModel}, normalized=${model}, baseUrl=${baseUrl}, apiKeyExists=${!!apiKey}, source=${activeModel ? 'settings' : 'env'}`
  )

  const scopeLabel = params.scope === 'original' ? '重构前' : '重构后'

  if (!apiKey) {
    return {
      report: {
        filePath: params.filePath,
        scope: params.scope,
        language: params.language,
        model,
        scanCoverage: 'N/A',
        summary: `MOCK 扫描报告：当前未配置 API Key，无法执行真实审计（${scopeLabel}）。请在设置中心配置模型及 API Key。`,
        generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
        functionResults: []
      }
    }
  }

  const system = '你是一名代码安全审查员。你的审查风格是保守、务实、克制——只报告确凿、高危、直接影响程序安全性的漏洞。不深挖、不衍生、不推测。默认假设代码是安全的，除非有明确的相反证据。请用中文撰写所有文本。只返回合法 JSON，不要 markdown 包裹。'

  const user = [
    `任务：对以下${scopeLabel}版本代码文件做快速安全审查。`,
    `语言：${params.language}`,
    `文件：${params.filePath}`,
    '',
    '【审查准则 —— 请严格遵守】',
    '1. 仅报告同时满足以下三个条件的确凿漏洞：',
    '   a) 漏洞100%确定存在',
    '   b) 可导致程序崩溃、任意代码执行或数据泄露',
    '   c) 在当前代码上下文中可直接触发',
    '',
    '2. ⚠️ 漏洞类型强制规范（极其重要 —— 违反即为错误 ⚠️',
    '   你必须且只能从下表中选择 vulnerabilityType，不得自创、近义替换或追加修饰词。',
    '   ┌──────────────────────┬──────────────────────────────────────────────┐',
    '   │ 规范类型（仅这些）    │ 判定标准                                     │',
    '   ├──────────────────────┼──────────────────────────────────────────────┤',
    '   │ 缓冲区溢出           │ 固定缓冲区 + 无边界检查写入 → 栈/堆溢出        │',
    '   │ 空指针解引用         │ 对可能为 NULL 的指针无条件解引用                │',
    '   │ 数组越界访问         │ 数组索引超出合法范围（与缓冲区溢出区分）         │',
    '   │ 整数溢出             │ 算术运算溢出且结果用于内存/索引操作             │',
    '   │ SQL注入              │ 用户输入直接拼接 SQL 字符串                    │',
    '   │ 命令注入             │ 用户输入直接拼接 shell/系统命令                 │',
    '   │ 资源泄漏             │ 打开句柄/分配内存后所有路径均未释放             │',
    '   │ 格式化字符串漏洞     │ 用户输入直接作为 printf/format 等格式化参数     │',
    '   │ 竞态条件             │ 多线程共享变量无锁或 TOCTOU 时间窗              │',
    '   │ 释放后使用           │ 指针/引用释放后继续解引用                       │',
    '   │ 双重释放             │ 同一指针/资源被释放 ≥2 次                      │',
    '   │ 未初始化变量         │ 栈/堆变量在使用前未赋值                          │',
    '   │ 除零错误             │ 除数/模数可能为 0 且未检查                       │',
    '   │ 路径遍历             │ 用户输入路径未过滤，可访问非预期文件              │',
    '   │ 敏感信息泄露         │ 明文输出密钥/密码/内存地址/令牌等敏感数据        │',
    '   │ 输入验证不足         │ 外部输入直接用于关键操作且无校验（仅报高危场景）  │',
    '   └──────────────────────┴──────────────────────────────────────────────┘',
    '   ❌ 禁止使用：数组越界读取、未初始化内存、任意名称+修饰词等自由描述',
    '',
    '3. 以下情况不应报告为漏洞：',
    '   - 推测性风险、理论性弱点、最佳实践缺失',
    '   - 需要多层复杂条件才能触发的场景',
    '   - 参数校验不严格但调用者可信的场景',
    '   - 仅"代码不够健壮"但不构成直接安全威胁',
    '4. 分析要求：每个漏洞描述2-3句话；不溯源、不展开、不衍生；同一根因合并。',
    '5. 自我审查：输出前逐条确认"100%确定？高危？直接危害？"——任一为否则不报。',
    '',
    '根据判断结果选择以下一种格式返回 JSON：',
    '',
    '=== 如果检测到确凿高危漏洞（hasVulnerabilities = true）===',
    '{',
    '  "hasVulnerabilities": true,',
    '  "scanCoverage": "已扫描整份文件",',
    '  "overallRisk": "high 或 critical（仅高危/致命才报 true）",',
    '  "summary": "一句话概括（中文）",',
    '  "vulnerabilities": [{',
    '    "vulnerabilityType": "漏洞类型",',
    '    "severity": "high 或 critical",',
    '    "cause": "简要原因（2-3句，中文）",',
    '    "potentialHarm": "简要危害（1-2句，中文）",',
    '    "fixSuggestion": "简要修复方向（1-2句，中文）",',
    '    "vulLineStart": 起始行号,',
    '    "vulLineEnd": 结束行号,',
    '    "vulLineRange": "起始-终止"',
    '  }]',
    '}',
    '',
    '=== 如果未发现确凿漏洞或仅存在非关键问题（hasVulnerabilities = false）===',
    '{',
    '  "hasVulnerabilities": false,',
    '  "scanCoverage": "已扫描整份文件",',
    '  "overallRisk": "low",',
    '  "summary": "未发现确凿高危漏洞（中文）",',
    '  "safeCodeAnalysis": {',
    '    "codeFunction": "代码功能简述（1-2句，中文）",',
    '    "securityAssessment": "安全评估（1-2句，中文）",',
    '    "potentialRisks": "无",',
    '    "improvementSuggestions": "无"',
    '  }',
    '}',
    '',
    '重要：返回合法 JSON 对象，不要 markdown 包裹，所有字段用中文。无漏洞时 potentialRisks/improvementSuggestions 直接填"无"。',
    '',
    '待审查代码：',
    '```',
    params.fileContent,
    '```'
  ].join('\n')

  const url = `${baseUrl}/v1/chat/completions`
  const requestBody = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0.1,
    max_tokens: 8192
  }

  const abortController = params.abortController
  const timeoutMs = readEnvTimeoutMs()
  const shouldTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0

  let timer: NodeJS.Timeout | null = null
  if (abortController && shouldTimeout) {
    timer = setTimeout(() => {
      abortController.abort('timeout')
    }, timeoutMs)
  }

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      signal: abortController?.signal,
      body: JSON.stringify(requestBody)
    })

    if (!resp.ok) {
      const text = await resp.text()
      throw new Error(`LLM request failed: ${resp.status} ${resp.statusText}: ${text}`)
    }

    const json = await resp.json()
    const content = json?.choices?.[0]?.message?.content

    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('LLM returned empty content')
    }

    const normalizedJsonText = extractJsonObject(content)
    const parsed = JSON.parse(normalizedJsonText) as {
      hasVulnerabilities?: boolean
      scanCoverage?: string
      overallRisk?: string
      summary?: string
      vulnerabilities?: unknown
      safeCodeAnalysis?: unknown
    }

    const hasVulnerabilities = parsed.hasVulnerabilities === true

    const vulnerabilities: VulnerabilityFinding[] = hasVulnerabilities
      ? (Array.isArray(parsed.vulnerabilities)
          ? parsed.vulnerabilities
              .map((item) => item as Record<string, unknown>)
              .filter(
                (item) =>
                  typeof item?.vulnerabilityType === 'string' &&
                  typeof item?.cause === 'string'
              )
              .map(
                (item): VulnerabilityFinding => ({
                  vulnerabilityType: item.vulnerabilityType as string,
                  cause: item.cause as string,
                  potentialHarm:
                    typeof item.potentialHarm === 'string' ? item.potentialHarm : '暂无详细危害分析',
                  fixSuggestion:
                    typeof item.fixSuggestion === 'string'
                      ? item.fixSuggestion
                      : '暂无具体修复建议',
                  severity:
                    item.severity === 'low' ||
                    item.severity === 'medium' ||
                    item.severity === 'high' ||
                    item.severity === 'critical'
                      ? (item.severity as CodeAuditSeverity)
                      : 'medium',
                  vulLineStart:
                    typeof item.vulLineStart === 'number'
                      ? item.vulLineStart
                      : (typeof item.vulLineRange === 'string'
                          ? Number.parseInt(item.vulLineRange.split('-')[0], 10) || 1
                          : 1),
                  vulLineEnd:
                    typeof item.vulLineEnd === 'number'
                      ? item.vulLineEnd
                      : (typeof item.vulLineRange === 'string'
                          ? Number.parseInt(item.vulLineRange.split('-')[1] || item.vulLineRange.split('-')[0], 10) || 1
                          : 1),
                  vulLineRange:
                    typeof item.vulLineRange === 'string'
                      ? item.vulLineRange
                      : `${item.vulLineStart || 1}-${item.vulLineEnd || 1}`
                })
              )
          : [])
      : []

    const safeCodeAnalysis: SafeCodeAnalysis | undefined =
      !hasVulnerabilities && typeof parsed.safeCodeAnalysis === 'object' && parsed.safeCodeAnalysis !== null
        ? (() => {
            const s = parsed.safeCodeAnalysis as Record<string, unknown>
            return {
              codeFunction:
                typeof s.codeFunction === 'string' ? s.codeFunction : '暂无代码功能说明',
              securityAssessment:
                typeof s.securityAssessment === 'string' ? s.securityAssessment : '暂无安全评估',
              potentialRisks:
                typeof s.potentialRisks === 'string' ? s.potentialRisks : '暂无潜在风险分析',
              improvementSuggestions:
                typeof s.improvementSuggestions === 'string'
                  ? s.improvementSuggestions
                  : '暂无安全改进建议'
            }
          })()
        : undefined

    // 整文件兜底审计当前只返回文件级摘要；保留已解析字段以兼容后续报告模型扩展。
    void vulnerabilities
    void safeCodeAnalysis

    const report: CodeAuditReport = {
      filePath: params.filePath,
      scope: params.scope,
      language: params.language,
      model,
      scanCoverage:
        typeof parsed.scanCoverage === 'string' && parsed.scanCoverage.trim().length > 0
          ? parsed.scanCoverage.trim()
          : '已扫描整份文件',
      summary:
        typeof parsed.summary === 'string' && parsed.summary.trim().length > 0
          ? parsed.summary.trim()
          : `${scopeLabel}文件审计完成。`,
      generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      functionResults: []
    }

    console.log('LLM audit raw response:', JSON.stringify(json, null, 2))

    return { report, raw: json }
  } catch (e: unknown) {
    if (abortController?.signal?.aborted) {
      const reason = (abortController.signal as AbortSignal & { reason?: unknown }).reason
      if (reason === 'timeout') {
        throw new Error(`LLM 请求超时（${timeoutMs}ms），可在 .env 设置 LLM_TIMEOUT_MS 调整`)
      }
      throw new Error('已取消本次扫描')
    }
    if (e instanceof SyntaxError) {
      throw new Error(`LLM 返回的扫描结果不是有效 JSON：${e.message}`)
    }
    throw e
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function callFunctionAuditLLM(params: {
  filePath: string
  language: string
  functionName: string
  functionCode: string
  startLine: number
  endLine: number
  scope: 'original' | 'refactored'
  abortController?: AbortController
}): Promise<{ report: { overallRisk: CodeAuditSeverity; hasVulnerabilities: boolean; vulnerabilities: VulnerabilityFinding[]; safeCodeAnalysis?: SafeCodeAnalysis; scanCoverage: string; summary: string }; raw?: unknown }> {
  function readTimeoutMs(): number {
    // 超时时间来自激活模型配置，未配置时使用默认值
    const activeModel = getActiveModel()
    if (activeModel && activeModel.timeoutMs > 0) return activeModel.timeoutMs
    return 120_000
  }
  function readEnvTimeoutMs(): number {
    const raw = (process.env.LLM_TIMEOUT_MS || '').trim()
    if (!raw) return readTimeoutMs()
    const n = Number.parseInt(raw, 10)
    if (!Number.isFinite(n)) return readTimeoutMs()
    return n
  }

  // 从设置中心读取激活模型配置
  const activeModel = getActiveModel()
  const baseUrl = (activeModel?.baseUrl || process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
  const apiKey = (activeModel ? decryptApiKey(activeModel.apiKey) : (process.env.LLM_API_KEY || '')).trim()
  let model = activeModel?.name || process.env.LLM_MODEL || 'gpt-4.1-mini'
  const originalModel = model
  model = model.toLowerCase().replace(/[^a-z0-9-.]/g, '-')
  console.log(
    `[DEBUG] Function audit model: original=${originalModel}, normalized=${model}, baseUrl=${baseUrl}, apiKeyExists=${!!apiKey}, source=${activeModel ? 'settings' : 'env'}`
  )

  const scopeLabel = params.scope === 'original' ? '重构前' : '重构后'

  if (!apiKey) {
    return {
      report: {
        overallRisk: 'medium' as CodeAuditSeverity,
        hasVulnerabilities: false,
        vulnerabilities: [],
        safeCodeAnalysis: {
          codeFunction: '当前未配置 API Key，无法执行真实扫描。',
          securityAssessment: `MOCK 报告（${scopeLabel}）：请在设置中心配置模型及 API Key。`,
          potentialRisks: '无',
          improvementSuggestions: '无'
        },
        scanCoverage: `函数 ${params.functionName}（第${params.startLine}-${params.endLine}行）`,
        summary: `MOCK 扫描报告：当前未配置 API Key，无法执行真实审计（${scopeLabel}，函数 ${params.functionName}）。请在设置中心配置模型及 API Key。`
      }
    }
  }

  const system = '你是一名代码安全审查员。审查风格：极端保守、极度克制。默认判定"安全"，仅当代码中存在明确、直接、可导致程序崩溃或安全漏洞的确凿证据时才报告。不推测、不深挖、不衍生。请用中文撰写所有文本。只返回合法 JSON，不要 markdown 包裹。'

  const user = [
    `任务：对以下${scopeLabel}版本的单个函数做快速安全审查。`,
    `语言：${params.language}`,
    `文件：${params.filePath}`,
    `函数名：${params.functionName}`,
    `函数位置：第 ${params.startLine}-${params.endLine} 行`,
    '',
    '【审查准则 —— 请逐条严格执行】',
    '1. 你的默认判定必须是 "hasVulnerabilities: false"。',
    '   仅当发现同时满足以下三个条件的漏洞时才报 true：',
    '   a) 漏洞100%确定存在（不是"可能"或"推测"）',
    '   b) 漏洞可导致程序崩溃、任意代码执行或数据泄露',
    '   c) 漏洞在当前代码上下文中可直接触发，无需复杂前置条件',
    '2. ⚠️ 漏洞类型强制规范（极其重要 —— 违反即为错误 ⚠️',
    '   你必须且只能从下表中选择 vulnerabilityType，不得自创、近义替换或追加修饰词。',
    '   ┌──────────────────────┬──────────────────────────────────────────────┐',
    '   │ 规范类型（仅这些）    │ 判定标准                                     │',
    '   ├──────────────────────┼──────────────────────────────────────────────┤',
    '   │ 缓冲区溢出           │ 固定缓冲区 + 无边界检查写入 → 栈/堆溢出        │',
    '   │ 空指针解引用         │ 对可能为 NULL 的指针无条件解引用                │',
    '   │ 数组越界访问         │ 数组索引超出合法范围（与缓冲区溢出区分）         │',
    '   │ 整数溢出             │ 算术运算溢出且结果用于内存/索引操作             │',
    '   │ SQL注入              │ 用户输入直接拼接 SQL 字符串                    │',
    '   │ 命令注入             │ 用户输入直接拼接 shell/系统命令                 │',
    '   │ 资源泄漏             │ 打开句柄/分配内存后所有路径均未释放             │',
    '   │ 格式化字符串漏洞     │ 用户输入直接作为 printf/format 等格式化参数     │',
    '   │ 竞态条件             │ 多线程共享变量无锁或 TOCTOU 时间窗              │',
    '   │ 释放后使用           │ 指针/引用释放后继续解引用                       │',
    '   │ 双重释放             │ 同一指针/资源被释放 ≥2 次                      │',
    '   │ 未初始化变量         │ 栈/堆变量在使用前未赋值                          │',
    '   │ 除零错误             │ 除数/模数可能为 0 且未检查                       │',
    '   │ 路径遍历             │ 用户输入路径未过滤，可访问非预期文件              │',
    '   │ 敏感信息泄露         │ 明文输出密钥/密码/内存地址/令牌等敏感数据        │',
    '   │ 输入验证不足         │ 外部输入直接用于关键操作且无校验（仅报高危场景）  │',
    '   └──────────────────────┴──────────────────────────────────────────────┘',
    '   示例：若发现无边界检查的数组写入 → "缓冲区溢出"（非"数组越界读取"、"未初始化变量导致的数组越界"）',
    '   示例：若发现未初始化的局部变量被读取 → "未初始化变量"（非"未初始化变量导致的数组越界读取"）',
    '   示例：若发现 malloc 返回后未判空直接使用 → "空指针解引用"',
    '   ❌ 禁止使用：数组越界读取、数组越界写入、未初始化内存、任意名称前面加修饰词等自由描述',
    '3. 以下情况一律不要报为漏洞：',
    '   - 理论性弱点、潜在风险、最佳实践缺失',
    '   - "如果调用者传入恶意参数则可能……"（上游责任，不在本函数范围）',
    '   - 参数校验不严格但调用者可信的场景',
    '   - 需要多级间接调用或极端时序条件才能触发',
    '   - 仅"代码不够健壮"但不构成直接安全威胁',
    '4. 输出要求：',
    '   - 每个漏洞描述精简到2-3句话',
    '   - 不追溯调用链、不展开攻击面分析',
    '   - 同一根因的多个表现合并为一个漏洞',
    '   - potentialRisks 和 improvementSuggestions 默认填 "无"',
    '5. 输出前逐条自我审查：',
    '   "这个漏洞真的100%确定吗？真的高危吗？真的有直接危害吗？"',
    '   只要有一条答案为"否"或"不确定" —— 不报。',
    `目标：1000个函数中只报3-5个确凿高危漏洞。你的使命是过滤噪音，只留真正危险的信号。`,
    '',
    '根据判断结果选择以下格式返回 JSON：',
    '',
    '=== 确凿高危漏洞（hasVulnerabilities = true）===',
    '{',
    '  "hasVulnerabilities": true,',
    '  "scanCoverage": "已扫描",',
    '  "overallRisk": "high 或 critical",',
    '  "summary": "一句话（中文）",',
    '  "vulnerabilities": [{',
    '    "vulnerabilityType": "类型",',
    '    "severity": "high 或 critical",',
    '    "cause": "2-3句简要原因（中文）",',
    '    "potentialHarm": "1-2句简要危害（中文）",',
    '    "fixSuggestion": "1-2句简要修复（中文）",',
    '    "vulLineStart": 行号,',
    '    "vulLineEnd": 行号,',
    '    "vulLineRange": "起-止"',
    '  }]',
    '}',
    '',
    '=== 未发现确凿漏洞或仅有非关键问题（hasVulnerabilities = false）===',
    '{',
    '  "hasVulnerabilities": false,',
    '  "scanCoverage": "已扫描",',
    '  "overallRisk": "low",',
    '  "summary": "未发现确凿高危漏洞（中文）",',
    '  "safeCodeAnalysis": {',
    '    "codeFunction": "功能简述（1-2句，中文）",',
    '    "securityAssessment": "安全评估（1-2句，中文）",',
    '    "potentialRisks": "无",',
    '    "improvementSuggestions": "无"',
    '  }',
    '}',
    '',
    '重要：只返回合法 JSON，不要 markdown 包裹。无漏洞时所有 safeCodeAnalysis 字段必须简短，potentialRisks/improvementSuggestions 直接填"无"。',
    '',
    '待审查函数代码：',
    '```',
    params.functionCode,
    '```'
  ].join('\n')

  const url = `${baseUrl}/v1/chat/completions`
  const requestBody = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0.1,
    max_tokens: 8192
  }

  const abortController = params.abortController
  const timeoutMs = readEnvTimeoutMs()
  const shouldTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0

  let timer: NodeJS.Timeout | null = null
  if (abortController && shouldTimeout) {
    timer = setTimeout(() => {
      abortController.abort('timeout')
    }, timeoutMs)
  }

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      signal: abortController?.signal,
      body: JSON.stringify(requestBody)
    })

    if (!resp.ok) {
      const text = await resp.text()
      throw new Error(`LLM request failed: ${resp.status} ${resp.statusText}: ${text}`)
    }

    const json = await resp.json()
    const content = json?.choices?.[0]?.message?.content

    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('LLM returned empty content')
    }

    const normalizedJsonText = extractJsonObject(content)
    const parsed = JSON.parse(normalizedJsonText) as {
      hasVulnerabilities?: boolean
      scanCoverage?: string
      overallRisk?: string
      summary?: string
      vulnerabilities?: unknown
      safeCodeAnalysis?: unknown
    }

    const hasVulnerabilities = parsed.hasVulnerabilities === true

    const vulnerabilities: VulnerabilityFinding[] = hasVulnerabilities
      ? (Array.isArray(parsed.vulnerabilities)
          ? parsed.vulnerabilities
              .map((item) => item as Record<string, unknown>)
              .filter(
                (item) =>
                  typeof item?.vulnerabilityType === 'string' &&
                  typeof item?.cause === 'string'
              )
              .map(
                (item): VulnerabilityFinding => ({
                  vulnerabilityType: item.vulnerabilityType as string,
                  cause: item.cause as string,
                  potentialHarm:
                    typeof item.potentialHarm === 'string' ? item.potentialHarm : '暂无详细危害分析',
                  fixSuggestion:
                    typeof item.fixSuggestion === 'string'
                      ? item.fixSuggestion
                      : '暂无具体修复建议',
                  severity:
                    item.severity === 'low' ||
                    item.severity === 'medium' ||
                    item.severity === 'high' ||
                    item.severity === 'critical'
                      ? (item.severity as CodeAuditSeverity)
                      : 'medium',
                  vulLineStart:
                    typeof item.vulLineStart === 'number'
                      ? item.vulLineStart
                      : (typeof item.vulLineRange === 'string'
                          ? Number.parseInt(item.vulLineRange.split('-')[0], 10) || 1
                          : 1),
                  vulLineEnd:
                    typeof item.vulLineEnd === 'number'
                      ? item.vulLineEnd
                      : (typeof item.vulLineRange === 'string'
                          ? Number.parseInt(item.vulLineRange.split('-')[1] || item.vulLineRange.split('-')[0], 10) || 1
                          : 1),
                  vulLineRange:
                    typeof item.vulLineRange === 'string'
                      ? item.vulLineRange
                      : `${item.vulLineStart || params.startLine}-${item.vulLineEnd || params.endLine}`
                })
              )
          : [])
      : []

    const safeCodeAnalysis: SafeCodeAnalysis | undefined =
      !hasVulnerabilities && typeof parsed.safeCodeAnalysis === 'object' && parsed.safeCodeAnalysis !== null
        ? (() => {
            const s = parsed.safeCodeAnalysis as Record<string, unknown>
            return {
              codeFunction:
                typeof s.codeFunction === 'string' ? s.codeFunction : '暂无代码功能说明',
              securityAssessment:
                typeof s.securityAssessment === 'string' ? s.securityAssessment : '暂无安全评估',
              potentialRisks:
                typeof s.potentialRisks === 'string' ? s.potentialRisks : '无',
              improvementSuggestions:
                typeof s.improvementSuggestions === 'string'
                  ? s.improvementSuggestions
                  : '无'
            }
          })()
        : undefined

    const overallRisk: CodeAuditSeverity =
      parsed.overallRisk === 'low' ||
      parsed.overallRisk === 'medium' ||
      parsed.overallRisk === 'high' ||
      parsed.overallRisk === 'critical'
        ? (parsed.overallRisk as CodeAuditSeverity)
        : 'medium'

    const report = {
      filePath: params.filePath,
      scope: params.scope,
      language: params.language,
      model,
      scanCoverage:
        typeof parsed.scanCoverage === 'string' && parsed.scanCoverage.trim().length > 0
          ? parsed.scanCoverage.trim()
          : `函数 ${params.functionName}（第${params.startLine}-${params.endLine}行）`,
      overallRisk,
      hasVulnerabilities,
      vulnerabilities,
      safeCodeAnalysis,
      summary:
        typeof parsed.summary === 'string' && parsed.summary.trim().length > 0
          ? parsed.summary.trim()
          : `函数 ${params.functionName}（${scopeLabel}）审计完成。`,
      generatedAt: new Date().toLocaleString('zh-CN', { hour12: false })
    }

    console.log(`[DEBUG] Function audit result for ${params.functionName}:`, JSON.stringify(report, null, 2))

    return { report, raw: json }
  } catch (e: unknown) {
    if (abortController?.signal?.aborted) {
      const reason = (abortController.signal as AbortSignal & { reason?: unknown }).reason
      if (reason === 'timeout') {
        throw new Error(`LLM 请求超时（${timeoutMs}ms），可在 .env 设置 LLM_TIMEOUT_MS 调整`)
      }
      throw new Error('已取消本次扫描')
    }
    if (e instanceof SyntaxError) {
      throw new Error(`LLM 返回的扫描结果不是有效 JSON：${e.message}`)
    }
    throw e
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// JSON 重构报告结构
// ---------------------------------------------------------------------------

type RefactorReportResult = {
  functionName: string
  originalCode: string
  refactoredCode: string
  complexity: { original: number | null; refactored: number | null }
}

type RefactorReport = {
  generatedAt: string
  filePath: string
  language: string
  mode: 'function' | 'file'
  analysis: {
    totalFunctions: number
    selectedForRefactor: number
    selectedNames: string[]
  } | null
  results: RefactorReportResult[]
  summary: {
    total: number
    refactored: number
    unrefactored: number
    complexityChange: { original: number | null; refactored: number | null }
  }
}

/** 顶层汇总文件结构：一个文件对应一条 RefactorReport */
type RefactorResults = {
  generatedAt: string
  files: RefactorReport[]
}

const REPORT_FILE_NAME = 'refactor-results.json'

function calculateCodeComplexity(code: string, language: string): number | null {
  try {
    return calculateFileComplexity(code, language)
  } catch {
    return null
  }
}

function extractOriginalCode(
  fileContent: string,
  startByte: number,
  endByte: number
): string {
  const bytes = Buffer.from(fileContent, 'utf8')
  return bytes.subarray(startByte, endByte).toString('utf8')
}

function getReportPath(): string {
  return path.join(process.cwd(), REPORT_FILE_NAME)
}

async function saveRefactorReport(report: RefactorReport): Promise<string> {
  const reportPath = getReportPath()

  // 读取现有的汇总文件
  let existing: RefactorResults = { generatedAt: '', files: [] }
  try {
    const raw = await fs.readFile(reportPath, 'utf8')
    const parsed = JSON.parse(raw) as RefactorResults
    if (parsed.files) {
      existing = parsed
    }
  } catch {
    // 文件不存在或解析失败，从空开始
  }

  const fileIdx = existing.files.findIndex(f => f.filePath === report.filePath)

  if (fileIdx >= 0) {
    const cur = existing.files[fileIdx]
    if (report.mode === 'function') {
      // 函数重构：合并更新该函数条目
      const fnIdx = cur.results.findIndex(
        r => r.functionName === report.results[0].functionName
      )
      if (fnIdx >= 0) {
        cur.results[fnIdx] = report.results[0]
      } else {
        cur.results.push(report.results[0])
      }
      // 重新计算该文件的 summary
      const refactored = cur.results.filter(r => r.refactoredCode !== '未重构').length
      cur.summary = {
        total: cur.results.length,
        refactored,
        unrefactored: cur.results.length - refactored,
        complexityChange: {
          original: cur.results.reduce((s, r) => s + (r.complexity.original ?? 0), 0),
          refactored: cur.results.reduce((s, r) => s + (r.complexity.refactored ?? 0), 0)
        }
      }
      cur.generatedAt = new Date().toLocaleString('zh-CN', { hour12: false })
    } else {
      // 文件重构：整体替换该文件的条目
      existing.files[fileIdx] = report
    }
  } else {
    // 新文件，追加
    existing.files.push(report)
  }

  existing.generatedAt = new Date().toLocaleString('zh-CN', { hour12: false })
  await fs.writeFile(reportPath, JSON.stringify(existing, null, 2), 'utf8')
  console.log(`[Report] 重构报告已保存至: ${reportPath} (共 ${existing.files.length} 个文件)`)
  return reportPath
}

function buildOccurrenceMapForReport(
  functions: ParsedFunction[]
): Map<string, ParsedFunction> {
  const nameCounters = new Map<string, number>()
  const map = new Map<string, ParsedFunction>()
  for (const fn of functions) {
    const occ = (nameCounters.get(fn.name) ?? 0) + 1
    nameCounters.set(fn.name, occ)
    map.set(`${fn.name}#${occ}`, fn)
  }
  return map
}

async function buildFileRefactorReport(params: {
  filePath: string
  language: string
  originalContent: string
  refactoredContent: string
  functionResults: Array<{ functionName: string; passed: boolean; attempt: number }>
  analysisInfo: { totalFunctions: number; selectedForRefactor: number; selectedNames: string[] } | null
}): Promise<RefactorReport> {
  const origBytes = Buffer.from(params.originalContent, 'utf8')
  const refactoredBytes = Buffer.from(params.refactoredContent, 'utf8')

  const origFunctions = parseFunctionsFallbackLocal(params.filePath, origBytes)
  const refactoredFunctions = parseFunctionsFallbackLocal(params.filePath, refactoredBytes)

  const origMap = buildOccurrenceMapForReport(origFunctions)
  const refactoredMap = buildOccurrenceMapForReport(refactoredFunctions)

  const results: RefactorReportResult[] = []
  let refactoredCount = 0
  let unrefactoredCount = 0
  let totalOrigComplexity = 0
  let totalRefactoredComplexity = 0

  for (const [key, origFn] of origMap) {
    const origCode = origBytes.subarray(origFn.startByte, origFn.endByte).toString('utf8')
    const origComplexity = calculateCodeComplexity(origCode, params.language)
    totalOrigComplexity += origComplexity ?? 0

    // 查找该函数在 functionResults 中的状态
    // attempt=0 表示未被分析选中，attempt>0 表示被选中（通过或失败）
    const fnResult = params.functionResults.find(r => r.functionName === origFn.name)
    const wasSelected = fnResult != null && fnResult.attempt > 0
    const wasPassed = wasSelected && fnResult!.passed

    let refactoredCode: string
    let refactoredComplexity: number | null

    if (wasPassed) {
      const refactoredFn = refactoredMap.get(key)
      if (refactoredFn) {
        refactoredCode = refactoredBytes.subarray(refactoredFn.startByte, refactoredFn.endByte).toString('utf8')
        refactoredComplexity = calculateCodeComplexity(refactoredCode, params.language)
        totalRefactoredComplexity += refactoredComplexity ?? 0
        refactoredCount++
      } else {
        refactoredCode = '未重构'
        refactoredComplexity = null
        unrefactoredCount++
      }
    } else {
      refactoredCode = '未重构'
      refactoredComplexity = null
      unrefactoredCount++
    }

    results.push({
      functionName: origFn.name,
      originalCode: origCode,
      refactoredCode,
      complexity: { original: origComplexity, refactored: refactoredComplexity }
    })
  }

  return {
    generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    filePath: params.filePath,
    language: params.language,
    mode: 'file',
    analysis: params.analysisInfo,
    results,
    summary: {
      total: origFunctions.length,
      refactored: refactoredCount,
      unrefactored: unrefactoredCount,
      complexityChange: {
        original: totalOrigComplexity,
        refactored: totalRefactoredComplexity
      }
    }
  }
}

let mainWindow: BrowserWindow | null = null

const APP_BG = '#1b1b1f'

function createWindow(): BrowserWindow {
  // 创建主窗口：Windows/Linux 使用无边框窗口，以便渲染进程自绘标题栏与按钮
  mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: false,
    backgroundColor: APP_BG,
    ...(process.platform === 'win32' ? { darkTheme: true, frame: false, icon } : {}),
    ...(process.platform === 'linux' ? { frame: false, icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.setBackgroundColor(APP_BG)

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 开发模式：通过 electron-vite 注入的 ELECTRON_RENDERER_URL 加载渲染端（支持热更新）
  // 生产模式：加载打包后的本地 HTML 文件
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

// Electron 完成初始化后会触发 whenReady。
// 许多 API（例如创建窗口、注册全局快捷键等）都应在此之后调用。
app.whenReady().then(async () => {
  await initSettings()

  // Windows：设置 appUserModelId（影响通知、任务栏分组等行为）
  electronApp.setAppUserModelId('com.electron.app')

  // 开发/生产的快捷键行为由 electron-toolkit 统一处理：
  // - 开发：F12 打开/关闭 DevTools
  // - 生产：禁用 CommandOrControl + R 防止误刷新
  // 参考：https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC 测试
  ipcMain.on('ping', () => console.log('pong'))

  ipcMain.handle('app:quit', () => {
    app.quit()
  })

  ipcMain.handle('app:getInfo', () => {
    return {
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    }
  })

  ipcMain.handle('refactor:cancel', async (_evt, requestId: string) => {
    const ctrl = inflightRefactorControllers.get(requestId)
    if (!ctrl) return { ok: false, found: false }
    ctrl.abort('cancel')
    return { ok: true, found: true }
  })

  ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize()
  })

  ipcMain.handle('window:toggleMaximize', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })

  ipcMain.handle('window:isMaximized', () => {
    return mainWindow?.isMaximized() ?? false
  })

  ipcMain.handle('window:close', () => {
    mainWindow?.close()
  })

  // ============================================================
  // 设置中心 IPC handlers
  // ============================================================

  ipcMain.handle('settings:load', () => {
    return toSettingsView(getSettings())
  })

  ipcMain.handle('settings:saveModel', async (_evt, input: ModelConfigInput) => {
    const s = getSettings()
    if (!input.name?.trim()) return { ok: false, error: '模型名称不能为空' }
    if (!input.baseUrl?.trim()) return { ok: false, error: 'API 地址不能为空' }

    if (input.id) {
      // 更新已有模型
      const existing = s.models.find((m) => m.id === input.id)
      if (!existing) return { ok: false, error: '模型不存在' }
      existing.name = input.name.trim()
      existing.baseUrl = input.baseUrl.trim()
      existing.timeoutMs = input.timeoutMs ?? 120000
      // 若密钥为掩码值（未修改），保留原密钥
      if (!isMaskedKey(input.apiKey)) {
        existing.apiKey = encryptApiKey(input.apiKey)
      }
    } else {
      // 新增模型
      const newModel = {
        id: generateId(),
        name: input.name.trim(),
        baseUrl: input.baseUrl.trim(),
        apiKey: encryptApiKey(input.apiKey || ''),
        timeoutMs: input.timeoutMs ?? 120000
      }
      s.models.push(newModel)
      // 若是第一个模型，自动激活
      if (s.models.length === 1) {
        s.activeModelId = newModel.id
      }
    }

    await saveSettingsToDisk(s)
    return { ok: true }
  })

  ipcMain.handle('settings:deleteModel', async (_evt, id: string) => {
    const s = getSettings()
    if (s.models.length <= 1) return { ok: false, error: '至少保留一个模型配置' }
    const idx = s.models.findIndex((m) => m.id === id)
    if (idx < 0) return { ok: false, error: '模型不存在' }
    s.models.splice(idx, 1)
    // 若删除的是当前激活模型，自动切换到第一个
    if (s.activeModelId === id) {
      s.activeModelId = s.models[0]?.id ?? ''
    }
    await saveSettingsToDisk(s)
    return { ok: true }
  })

  ipcMain.handle('settings:setActiveModel', async (_evt, id: string) => {
    const s = getSettings()
    const model = s.models.find((m) => m.id === id)
    if (!model) return { ok: false }
    s.activeModelId = id
    await saveSettingsToDisk(s)
    return { ok: true }
  })

  ipcMain.handle('settings:saveScheme', async (_evt, scheme: PromptScheme) => {
    const s = getSettings()
    if (!scheme.name?.trim()) return { ok: false, error: '方案名称不能为空' }

    const existing = s.promptSchemes.find((p) => p.id === scheme.id)
    if (existing) {
      existing.name = scheme.name.trim()
      existing.templates = { ...scheme.templates }
    } else {
      const newScheme: PromptScheme = {
        id: scheme.id || generateId(),
        name: scheme.name.trim(),
        templates: { ...scheme.templates }
      }
      s.promptSchemes.push(newScheme)
      if (s.promptSchemes.length === 1) {
        s.activeSchemeId = newScheme.id
      }
    }

    await saveSettingsToDisk(s)
    return { ok: true }
  })

  ipcMain.handle('settings:deleteScheme', async (_evt, id: string) => {
    const s = getSettings()
    if (s.promptSchemes.length <= 1) return { ok: false, error: '至少保留一个 Prompt 方案' }
    const idx = s.promptSchemes.findIndex((p) => p.id === id)
    if (idx < 0) return { ok: false, error: '方案不存在' }
    s.promptSchemes.splice(idx, 1)
    if (s.activeSchemeId === id) {
      s.activeSchemeId = s.promptSchemes[0]?.id ?? ''
    }
    await saveSettingsToDisk(s)
    return { ok: true }
  })

  ipcMain.handle('settings:setActiveScheme', async (_evt, id: string) => {
    const s = getSettings()
    const scheme = s.promptSchemes.find((p) => p.id === id)
    if (!scheme) return { ok: false }
    s.activeSchemeId = id
    await saveSettingsToDisk(s)
    return { ok: true }
  })

  // 设置渲染进程选择的模型配置
  ipcMain.handle('config:setModel', async (_evt, config: { model: string; baseUrl?: string; apiKey?: string }) => {
    // 加载模型特定的 .env 文件
    await loadModelDotEnv(config.model)
    console.log(`已加载模型 ${config.model} 的配置`) 
    return { ok: true }
  })

  ipcMain.handle('settings:export', async () => {
    const s = getSettings()
    const exportData = createExportData(s)
    const res = await dialog.showSaveDialog({
      title: '导出配置',
      defaultPath: 'aospilot-settings.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePath) return { ok: false, canceled: true }
    try {
      await fs.writeFile(res.filePath, JSON.stringify(exportData, null, 2), 'utf8')
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('settings:import', async () => {
    const res = await dialog.showOpenDialog({
      title: '导入配置',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    })
    if (res.canceled || res.filePaths.length === 0) return { ok: false, canceled: true }
    try {
      const raw = await fs.readFile(res.filePaths[0], 'utf8')
      const json = JSON.parse(raw)
      const imported = validateImportedSettings(json)
      if (!imported) return { ok: false, error: '配置文件格式无效' }
      const current = getSettings()
      const merged = mergeImportedSettings(current, imported)
      await saveSettingsToDisk(merged)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('settings:testModel', async (_evt, input: ModelConfigInput) => {
    const baseUrl = (input.baseUrl || '').replace(/\/$/, '')
    const apiKey = isMaskedKey(input.apiKey) ? '' : input.apiKey || ''
    const model = input.name || ''

    if (!baseUrl) return { ok: false, message: 'API 地址不能为空' }
    if (!apiKey) return { ok: false, message: '请输入 API 密钥后再测试（掩码密钥无法用于测试）' }

    try {
      const url = `${baseUrl}/v1/chat/completions`
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: model.toLowerCase().replace(/[^a-z0-9-.]/g, '-'),
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 5
        }),
        signal: AbortSignal.timeout(15000)
      })
      if (resp.ok) {
        return { ok: true, message: `连接成功（${resp.status}）` }
      }
      const text = await resp.text()
      return { ok: false, message: `连接失败（${resp.status}）：${text.slice(0, 200)}` }
    } catch (e) {
      return { ok: false, message: `连接失败：${e instanceof Error ? e.message : String(e)}` }
    }
  })

  ipcMain.handle('fs:selectDirectory', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory']
    })
    if (res.canceled || res.filePaths.length === 0) return null
    activeProjectRoot = path.resolve(res.filePaths[0])
    return activeProjectRoot
  })

  ipcMain.handle('history:append', async (_evt, input: AppendRefactorHistoryInput) => {
    if (!activeProjectRoot) {
      throw new Error('保存重构历史失败：请先选择项目目录')
    }
    return await appendRefactorHistory(activeProjectRoot, input)
  })

  ipcMain.handle(
    'history:markApplied',
    async (_evt, params: { sourceFilePath: string; sessionId: string }) => {
      if (!activeProjectRoot) {
        throw new Error('更新重构历史失败：请先选择项目目录')
      }
      return await markRefactorHistoryApplied(
        activeProjectRoot,
        params.sourceFilePath,
        params.sessionId
      )
    }
  )

  ipcMain.handle('fs:buildFileTree', async (_evt, rootDir: string) => {
    return await buildFileTree(rootDir)
  })

  ipcMain.handle('fs:readFile', async (_evt, filePath: string) => {
    const bytes = await fs.readFile(filePath)
    return { content: bytes.toString('utf8') }
  })

  ipcMain.handle('fs:writeFile', async (_evt, filePath: string, content: string) => {
    await fs.writeFile(filePath, content, 'utf8')
    return { ok: true }
  })

  ipcMain.handle(
    'fs:saveJson',
    async (_evt, params: { defaultFileName: string; jsonText: string; title?: string }) => {
      const result = await dialog.showSaveDialog({
        title: params.title || '保存 JSON 文件',
        defaultPath: params.defaultFileName,
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })

      if (result.canceled || !result.filePath) {
        return { ok: false, canceled: true as const }
      }

      await fs.writeFile(result.filePath, params.jsonText, 'utf8')
      return { ok: true, canceled: false as const, filePath: result.filePath }
    }
  )

  ipcMain.handle('parse:functions', async (_evt, filePath: string, content?: string) => {
    const bytes =
      typeof content === 'string' ? Buffer.from(content, 'utf8') : await fs.readFile(filePath)
    try {
      const functions = await parseFunctionsTreeSitter({ app, filePath, contentBytes: bytes })
      return { functions }
    } catch {
      const functions = parseFunctionsFallback(filePath, bytes)
      return { functions }
    }
  })

  // 打开文件的统一分析入口：整文件仅做一次 tree-sitter 解析，
  // 同时返回函数列表、每函数圈复杂度与文件级圈复杂度（大文件性能关键路径）
  ipcMain.handle(
    'analyze:file',
    async (_evt, filePath: string, language: string, content?: string) => {
      const bytes =
        typeof content === 'string' ? Buffer.from(content, 'utf8') : await fs.readFile(filePath)

      const summarize = (
        functions: ParsedFunction[],
        functionComplexities: Record<string, number>
      ): {
        functions: ParsedFunction[]
        functionComplexities: Record<string, number>
        fileComplexity: number
      } => {
        const values = Object.values(functionComplexities)
        // 没有函数时回退到整文件正则计算，避免显示为 0
        const fileComplexity = values.length
          ? values.reduce((sum, value) => sum + value, 0)
          : calculateFileComplexity(bytes.toString('utf8'), language)
        return { functions, functionComplexities, fileComplexity }
      }

      try {
        const { functions, functionComplexities } = await analyzeFileWithTreeSitter({
          app,
          filePath,
          contentBytes: bytes
        })
        return summarize(functions, functionComplexities)
      } catch {
        // tree-sitter 失败时整体回退：正则提取函数 + 正则圈复杂度
        const functions = parseFunctionsFallback(filePath, bytes)
        const functionComplexities = calculateFunctionComplexities(
          bytes.toString('utf8'),
          functions,
          language
        )
        return summarize(functions, functionComplexities)
      }
    }
  )

  ipcMain.handle(
    'refactor:function',
    async (
      _evt,
      params: {
        requestId?: string
        filePath: string
        language: string
        functionId: string
        startByte: number
        endByte: number
        functionName: string
        currentFileContent: string
        instruction?: string
      }
    ) => {
      const requestId = (params.requestId || '').trim() || `${Date.now()}-${Math.random()}`
      const abortController = new AbortController()
      inflightRefactorControllers.set(requestId, abortController)

      try {
        // 带质量门的函数重构
        const result = await runFunctionRefactorWithQG({
          filePath: params.filePath,
          language: params.language,
          functionId: params.functionId,
          functionName: params.functionName,
          startByte: params.startByte,
          endByte: params.endByte,
          currentFileContent: params.currentFileContent,
          instruction: params.instruction,
          abortController,
          callFunctionRefactorLLM,
          callLLMForSemCheck,
          onProgress: (msg) => {
            mainWindow?.webContents.send('qg:progress', msg)
          }
        })

        // 重构后圈复杂度
        let refactoredComplexity: number | undefined
        if (result.passed) {
          try {
            refactoredComplexity = await calculateCyclomaticComplexityAST(
              app, result.refactoredFunctionCode, params.language, params.filePath
            )
          } catch { /* ignore */ }
        }

        // 保存 JSON 重构报告
        const originalFunctionCode = extractOriginalCode(
          params.currentFileContent, params.startByte, params.endByte
        )
        const originalComplexity = calculateCodeComplexity(originalFunctionCode, params.language)
        const refactoredCodeForReport = result.passed ? result.refactoredFunctionCode : '未重构'

        const fnReport: RefactorReport = {
          generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
          filePath: params.filePath,
          language: params.language,
          mode: 'function',
          analysis: null,
          results: [
            {
              functionName: params.functionName,
              originalCode: originalFunctionCode,
              refactoredCode: refactoredCodeForReport,
              complexity: { original: originalComplexity, refactored: refactoredComplexity ?? null }
            }
          ],
          summary: {
            total: 1,
            refactored: result.passed ? 1 : 0,
            unrefactored: result.passed ? 0 : 1,
            complexityChange: {
              original: originalComplexity,
              refactored: refactoredComplexity ?? null
            }
          }
        }
        try {
          await saveRefactorReport(fnReport)
        } catch {
          // 忽略报告写入失败
        }

        return {
          refactoredFunctionCode: result.refactoredFunctionCode,
          updatedFileContent: result.updatedFileContent,
          refactoredComplexity,
          qualityGate: {
            sigCheck: result.sigCheck,
            semCheck: result.semCheck,
            attempt: result.attempt,
            passed: result.passed
          }
        }
      } finally {
        inflightRefactorControllers.delete(requestId)
      }
    }
  )

  ipcMain.handle(
    'refactor:file',
    async (
      evt,
      params: {
        requestId?: string
        filePath: string
        language: string
        currentFileContent: string
        instruction?: string
      }
    ) => {
      const requestId = (params.requestId || '').trim() || `${Date.now()}-${Math.random()}`
      const abortController = new AbortController()
      inflightRefactorControllers.set(requestId, abortController)

      const emit = (payload: Record<string, unknown>): void => {
        evt.sender.send('refactor:batch:progress', { batchId: requestId, ...payload })
      }

      try {
        // 计算重构前文件复杂度
        const originalComplexity = calculateFileComplexity(
          params.currentFileContent,
          params.language
        )

        // 带质量门的文件重构（方案 C：分析优先 + 逐函数重构）
        const result = await runFileRefactorWithAnalysis({
          filePath: params.filePath,
          language: params.language,
          currentFileContent: params.currentFileContent,
          instruction: params.instruction,
          abortController,
          callFunctionRefactorLLM,
          callFunctionAnalysisLLM,
          app,
          callLLMForSemCheck,
          onProgress: (msg) => {
            mainWindow?.webContents.send('qg:progress', msg)
          }
        })

        // 计算重构后文件复杂度
        const refactoredComplexity = calculateFileComplexity(
          result.updatedFileContent,
          params.language
        )

        emit({
          phase: 'file-refactor-done',
          file: params.filePath,
          originalComplexity,
          refactoredComplexity
        })

        // 生成失败报告
        let reportPath: string | null = null
        try {
          if (result.failureCount > 0) {
            const reportDir = path.join(app.getPath('userData'), 'reports')
            await fs.mkdir(reportDir, { recursive: true })
            const reportFile = path.join(
              reportDir,
              `failure-report-${Date.now()}.md`
            )
            await FailureReportManager.appendToReportFile(reportFile)
            reportPath = reportFile
          }
        } catch {
          // 忽略报告写入失败
        }

        // 保存 JSON 重构报告
        const analysisInfo = (() => {
          const selected = result.functionResults
            .filter(r => r.attempt > 0)
            .map(r => r.functionName)
          return {
            totalFunctions: result.functionResults.length,
            selectedForRefactor: selected.length,
            selectedNames: selected
          }
        })()
        try {
          const fileReport = await buildFileRefactorReport({
            filePath: params.filePath,
            language: params.language,
            originalContent: params.currentFileContent,
            refactoredContent: result.updatedFileContent,
            functionResults: result.functionResults,
            analysisInfo
          })
          const jsonReportPath = await saveRefactorReport(fileReport)
          if (!reportPath) {
            reportPath = jsonReportPath
          }
        } catch {
          // 忽略报告写入失败
        }

        return {
          updatedFileContent: result.updatedFileContent,
          summary:
            result.failureCount > 0
              ? `文件重构完成：${result.passedCount} 个已优化，${result.failureCount} 个保留原代码`
              : '该文件已重构',
          perFunctionStatus: result.functionResults.map((r) => ({
            name: r.functionName,
            status: r.attempt === 0
              ? ('skipped' as const)
              : r.passed
                ? ('success' as const)
                : ('failed' as const),
            error: r.attempt === 0
              ? 'LLM 分析未选中'
              : r.passed
                ? undefined
                : r.sigCheck && !r.sigCheck.pass
                  ? '签名不一致'
                  : r.semCheck && !r.semCheck.equivalent
                    ? '语义不等价'
                    : '质检未通过'
          })),
          originalComplexity,
          refactoredComplexity,
          qualityGate: {
            functionResults: result.functionResults,
            failureCount: result.failureCount,
            passedCount: result.passedCount,
            attempt: result.attempt,
            reportPath
          }
        }
      } finally {
        inflightRefactorControllers.delete(requestId)
      }
    }
  )

  ipcMain.handle(
    'refactor:batch',
    async (
      evt,
      params: {
        batchId: string
        rootDir: string
        files: string[]
        instruction?: string
      }
    ) => {
      const flag = { cancelled: false }
      batchCancelFlags.set(params.batchId, flag)
      const abortController = new AbortController()
      inflightRefactorControllers.set(params.batchId, abortController)

      const emit = (payload: Record<string, unknown>): void => {
        evt.sender.send('refactor:batch:progress', { batchId: params.batchId, ...payload })
      }

      try {
        // 0) 兜底过滤：排除位于备份目录内的文件
        const targetFiles = params.files.filter((file) => !isInBackupDir(file))

        // 1) 先备份
        const backupDir = await backupDirectory(params.rootDir, targetFiles)
        emit({ phase: 'backup-done', backupDir })

        // 2) 预扫描：统计每个文件的函数数
        const filePlans: Array<{ file: string; functionCount: number }> = []
        for (const file of targetFiles) {
          try {
            const bytes = await fs.readFile(file)
            let fns: ParsedFunction[]
            try {
              fns = await parseFunctionsTreeSitter({ app, filePath: file, contentBytes: bytes })
            } catch {
              fns = parseFunctionsFallback(file, bytes)
            }
            filePlans.push({ file, functionCount: fns.length })
          } catch {
            filePlans.push({ file, functionCount: 0 })
          }
        }

        const totalFiles = filePlans.length
        const totalFunctions = filePlans.reduce((s, p) => s + p.functionCount, 0)
        let doneFunctions = 0
        const startedAt = Date.now()

        emit({ phase: 'batch-start', totalFiles, totalFunctions })

        const report: Array<{ file: string; success: number; failed: number; skipped: number }> = []

        // 3) 逐文件 — 方案 C（分析优先 + 质量门）
        for (let i = 0; i < filePlans.length; i++) {
          if (flag.cancelled) {
            emit({ phase: 'batch-cancelled' })
            break
          }

          const { file, functionCount } = filePlans[i]
          emit({ phase: 'file-start', file, fileIndex: i, totalFiles, functionCount })

          if (functionCount === 0) {
            report.push({ file, success: 0, failed: 0, skipped: 0 })
            emit({ phase: 'file-done', file, fileIndex: i, totalFiles })
            continue
          }

          try {
            const bytes = await fs.readFile(file)
            const fileContent = bytes.toString('utf8')
            const lang = extname(file).toLowerCase() === '.java' ? 'java' : 'cpp'

            // 方案 C：分析优先 + 逐函数质量门
            const qgResult = await runFileRefactorWithAnalysis({
              filePath: file,
              language: lang,
              currentFileContent: fileContent,
              instruction: params.instruction,
              abortController,
              callFunctionRefactorLLM,
              callFunctionAnalysisLLM,
              app,
              callLLMForSemCheck,
              onProgress: (msg) => {
                // QG 进度
                mainWindow?.webContents.send('qg:progress', msg)
                // 批量进度：分析 / 重构 / 检查 / 重试阶段都通知 UI
                if (msg.stage === 'analyzing') {
                  emit({ phase: 'analysis-start', file, functionCount })
                } else if (msg.stage === 'analysis-done') {
                  emit({ phase: 'analysis-done', file, selectedCount: msg.selectedCount ?? 0, totalCount: msg.totalCount ?? functionCount })
                } else if (msg.stage === 'refactoring') {
                  if (msg.isRetry) {
                    emit({ phase: 'function-retry', file, functionName: msg.functionName, attempt: msg.attempt, maxAttempts: msg.maxAttempts })
                  } else {
                    emit({ phase: 'function-start', file, functionName: msg.functionName })
                  }
                } else if (msg.stage === 'checking') {
                  emit({ phase: 'function-checking', file, functionName: msg.functionName })
                }
              }
            })

            // 发送逐函数结果
            for (const fr of qgResult.functionResults) {
              doneFunctions++
              const elapsed = Date.now() - startedAt
              const avg = doneFunctions > 0 ? elapsed / doneFunctions : 0
              const etaMs = Math.max(0, Math.round((totalFunctions - doneFunctions) * avg))
              const status: 'success' | 'failed' | 'skipped' =
                fr.attempt === 0 ? 'skipped' : fr.passed ? 'success' : 'failed'
              emit({
                phase: 'function-done',
                file,
                functionName: fr.functionName,
                status,
                doneFunctions,
                totalFunctions,
                overallPercent:
                  totalFunctions > 0 ? Math.round((doneFunctions / totalFunctions) * 100) : 100,
                etaMs
              })
            }

            // 保存 JSON 重构报告
            const analysisInfo = {
              totalFunctions: qgResult.functionResults.length,
              selectedForRefactor: qgResult.functionResults.filter(r => r.attempt > 0).length,
              selectedNames: qgResult.functionResults.filter(r => r.attempt > 0).map(r => r.functionName)
            }
            try {
              const fileReport = await buildFileRefactorReport({
                filePath: file,
                language: lang,
                originalContent: fileContent,
                refactoredContent: qgResult.updatedFileContent,
                functionResults: qgResult.functionResults,
                analysisInfo
              })
              await saveRefactorReport(fileReport)
            } catch { /* 忽略报告写入失败 */ }

            const success = qgResult.functionResults.filter(r => r.attempt > 0 && r.passed).length
            const failed = qgResult.functionResults.filter(r => r.attempt > 0 && !r.passed).length
            const skipped = qgResult.functionResults.filter(r => r.attempt === 0).length

            // 批量重构会直接写回，因此先持久化 generated 记录，再在写回成功后标记 applied。
            let historyCreated = false
            if (success > 0) {
              try {
                const activeModel = getActiveModel()
                const activeScheme = getActiveScheme()
                await appendRefactorHistory(params.rootDir, {
                  sessionId: params.batchId,
                  sourceFilePath: file,
                  language: lang,
                  scope: 'file',
                  modelName: activeModel?.name || '未配置模型',
                  instruction:
                    params.instruction || activeScheme?.templates.fileUser || '批量逐函数重构',
                  before: {
                    code: fileContent,
                    lineCount: countSourceLines(fileContent),
                    fileComplexity: calculateFileComplexity(fileContent, lang)
                  },
                  after: {
                    code: qgResult.updatedFileContent,
                    lineCount: countSourceLines(qgResult.updatedFileContent),
                    fileComplexity: calculateFileComplexity(qgResult.updatedFileContent, lang)
                  }
                })
                historyCreated = true
              } catch (error) {
                console.warn(`[history] 批量重构记录保存失败：${file}`, error)
              }
            }

            // 写回原文件
            await fs.writeFile(file, qgResult.updatedFileContent, 'utf8')
            if (historyCreated) {
              try {
                await markRefactorHistoryApplied(params.rootDir, file, params.batchId)
              } catch (error) {
                console.warn(`[history] 批量重构记录状态更新失败：${file}`, error)
              }
            }

            report.push({ file, success, failed, skipped })
          } catch {
            if (flag.cancelled || abortController.signal.aborted) {
              emit({ phase: 'batch-cancelled' })
              break
            }
            report.push({ file, success: 0, failed: 1, skipped: 0 })
          }

          emit({ phase: 'file-done', file, fileIndex: i, totalFiles })
        }

        emit({ phase: 'batch-done', report })
        return { ok: true, report }
      } finally {
        batchCancelFlags.delete(params.batchId)
        inflightRefactorControllers.delete(params.batchId)
      }
    }
  )

  ipcMain.handle('audit:file',
    async (
      evt,
      params: {
        filePath: string
        language: string
        fileContent: string
        scope: 'original' | 'refactored'
        requestId?: string
      }
    ) => {
      const requestId = (params.requestId || '').trim() || `${Date.now()}-${Math.random()}`
      const abortController = new AbortController()
      inflightRefactorControllers.set(requestId, abortController)

      // 复用批量扫描的进度通道：单文件扫描把 requestId 当作 batchId，UI 侧统一消费
      const emit = (payload: Record<string, unknown>): void => {
        evt.sender.send('audit:batch:progress', { batchId: requestId, ...payload })
      }

      try {
        // 1. 将文件内容解析为函数列表
        const contentBytes = Buffer.from(params.fileContent, 'utf8')
        let functions: ParsedFunction[]
        try {
          functions = await parseFunctionsTreeSitter({
            app,
            filePath: params.filePath,
            contentBytes
          })
        } catch {
          functions = parseFunctionsFallback(params.filePath, contentBytes)
        }

        const totalFunctions = functions.length
        emit({ phase: 'batch-start', totalFiles: 1, totalFunctions })

        // 2. 如果没有解析到函数，回退到文件级扫描
        if (functions.length === 0) {
          const { report } = await callFileAuditLLM({
            filePath: params.filePath,
            language: params.language,
            fileContent: params.fileContent,
            scope: params.scope,
            abortController
          })
          emit({ phase: 'batch-done', totalFiles: 1, okCount: 1 })
          return { report }
        }

        // 3. 逐函数审计
        type FuncAuditReport = Awaited<ReturnType<typeof callFunctionAuditLLM>>['report']
        const funcAuditResults: Array<{ func: ParsedFunction; report: FuncAuditReport }> = []
        const funcAuditErrors: string[] = []
        let doneFunctions = 0
        const startedAt = Date.now()
        // 仅用户主动取消算取消；LLM 超时同样会 abort，但不应被当成取消
        const isUserCancelled = (): boolean =>
          abortController.signal.aborted && abortController.signal.reason === 'cancel'
        // 失败函数同样计入进度，否则百分比永远到不了 100
        const emitFunctionDone = (functionName: string, status: 'success' | 'failed'): void => {
          doneFunctions++
          const elapsed = Date.now() - startedAt
          const avg = doneFunctions > 0 ? elapsed / doneFunctions : 0
          emit({
            phase: 'function-done',
            file: params.filePath,
            functionName,
            status,
            doneFunctions,
            totalFunctions,
            overallPercent:
              totalFunctions > 0 ? Math.round((doneFunctions / totalFunctions) * 100) : 100,
            etaMs: Math.max(0, Math.round((totalFunctions - doneFunctions) * avg))
          })
        }
        for (const func of functions) {
          // 检查是否已被取消
          if (abortController.signal.aborted) {
            throw new Error('已取消本次扫描')
          }
          emit({
            phase: 'function-start',
            file: params.filePath,
            functionName: func.name
          })
          const funcCode = contentBytes.subarray(func.startByte, func.endByte).toString('utf8')
          try {
            const { report } = await callFunctionAuditLLM({
              filePath: params.filePath,
              language: params.language,
              functionName: func.name,
              functionCode: funcCode,
              startLine: func.startLine,
              endLine: func.endLine,
              scope: params.scope,
              abortController
            })
            funcAuditResults.push({ func, report })
            emitFunctionDone(func.name, 'success')
          } catch (e) {
            if (isUserCancelled()) {
              // 取消导致的中断不计入完成数，避免取消后进度显示为 100%
              break
            }
            const errMsg = e instanceof Error ? e.message : String(e)
            console.error(`[audit:file] 函数 ${func.name} 审计失败：`, errMsg)
            funcAuditErrors.push(`${func.name}：${errMsg}`)
            emitFunctionDone(func.name, 'failed')
          }
        }

        // 取消可能落在最后一个函数上，此时循环会正常结束，同样要收敛为取消
        if (isUserCancelled()) {
          throw new Error('已取消本次扫描')
        }

        // 如果所有函数审计均失败，抛出错误而非返回空报告
        if (funcAuditResults.length === 0 && functions.length > 0) {
          const detail = funcAuditErrors.slice(0, 3).join('；')
          const extra = funcAuditErrors.length > 3 ? `（共 ${funcAuditErrors.length} 个函数审计失败）` : ''
          throw new Error(`所有函数审计均失败，请检查 API Key 或 Token 额度是否有效：${detail}${extra}`)
        }

        // 4. 构建 functionResults 并生成汇总摘要
        const functionResults: FunctionAuditEntry[] = []
        let vulnCount = 0
        const severityRank: Record<CodeAuditSeverity, number> = {
          low: 1,
          medium: 2,
          high: 3,
          critical: 4
        }
        let highestRisk: CodeAuditSeverity = 'low'

        for (const { func, report } of funcAuditResults) {
          const entry: FunctionAuditEntry = {
            functionName: func.name,
            startLine: func.startLine,
            endLine: func.endLine,
            overallRisk: report.overallRisk,
            hasVulnerabilities: report.hasVulnerabilities,
            vulnerabilities: report.hasVulnerabilities ? report.vulnerabilities : undefined,
            safeCodeAnalysis: !report.hasVulnerabilities ? report.safeCodeAnalysis : undefined
          }
          functionResults.push(entry)

          if (report.hasVulnerabilities) {
            vulnCount += report.vulnerabilities.length
          }
          if (severityRank[report.overallRisk] > severityRank[highestRisk]) {
            highestRisk = report.overallRisk
          }
        }

        // 5. 构造汇总报告
        const scopeLabel = params.scope === 'original' ? '重构前' : '重构后'
        const aggregatedSummary = vulnCount > 0
          ? `逐函数扫描完成（${scopeLabel}）：共 ${functions.length} 个函数，发现 ${vulnCount} 个漏洞`
          : `逐函数扫描完成（${scopeLabel}）：共 ${functions.length} 个函数，未发现安全漏洞`

        const aggregatedReport: CodeAuditReport = {
          filePath: params.filePath,
          scope: params.scope,
          language: params.language,
          model: process.env.LLM_MODEL || 'gpt-4.1-mini',
          scanCoverage: `逐函数扫描，共 ${functions.length} 个函数`,
          summary: aggregatedSummary,
          generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
          functionResults
        }

        console.log(
          `[audit:file] 汇总完成：${functionResults.length}/${functions.length} 个函数审计成功`
        )

        emit({ phase: 'batch-done', totalFiles: 1, okCount: funcAuditResults.length })

        return { report: aggregatedReport }
      } catch (e) {
        // 仅用户主动取消才报 cancelled；其它异常（含超时）由渲染侧按失败处理
        if (abortController.signal.aborted && abortController.signal.reason === 'cancel') {
          emit({ phase: 'batch-cancelled' })
        }
        throw e
      } finally {
        inflightRefactorControllers.delete(requestId)
      }
    }
  )

  // 批量扫描：对文件列表中的 .c/.c++/.java 文件逐文件审计，结果存为同目录 .audit.json
  ipcMain.handle(
    'audit:batch',
    async (
      evt,
      params: {
        batchId: string
        rootDir: string
        files: string[]
      }
    ) => {
      const flag = { cancelled: false }
      batchCancelFlags.set(params.batchId, flag)
      const abortController = new AbortController()
      inflightRefactorControllers.set(params.batchId, abortController)

      const emit = (payload: Record<string, unknown>): void => {
        evt.sender.send('audit:batch:progress', { batchId: params.batchId, ...payload })
      }

      try {
        // 过滤支持的源文件（与 isSupportedSourceFile 保持一致），排除备份目录
        const targetFiles = params.files.filter((file) => {
          const lower = file.toLowerCase()
          return (
            (lower.endsWith('.c') ||
              lower.endsWith('.cc') ||
              lower.endsWith('.cpp') ||
              lower.endsWith('.cxx') ||
              lower.endsWith('.c++') ||
              lower.endsWith('.h') ||
              lower.endsWith('.hpp') ||
              lower.endsWith('.java')) &&
            !isInBackupDir(file)
          )
        })

        // 预扫描：统计每个文件的函数数，作为进度分母（与批量重构一致）
        const filePlans: Array<{ file: string; functionCount: number }> = []
        for (const file of targetFiles) {
          try {
            const bytes = await fs.readFile(file)
            let fns: ParsedFunction[]
            try {
              fns = await parseFunctionsTreeSitter({ app, filePath: file, contentBytes: bytes })
            } catch {
              fns = parseFunctionsFallback(file, bytes)
            }
            filePlans.push({ file, functionCount: fns.length })
          } catch {
            filePlans.push({ file, functionCount: 0 })
          }
        }

        const totalFiles = filePlans.length
        const totalFunctions = filePlans.reduce((s, p) => s + p.functionCount, 0)
        let doneFunctions = 0
        const startedAt = Date.now()
        emit({ phase: 'batch-start', totalFiles, totalFunctions })

        const batchReport: Array<{
          file: string
          status: 'ok' | 'failed'
          jsonPath?: string
          error?: string
        }> = []

        for (let i = 0; i < filePlans.length; i++) {
          if (flag.cancelled) {
            emit({ phase: 'batch-cancelled' })
            break
          }

          const { file, functionCount } = filePlans[i]
          emit({ phase: 'file-start', file, fileIndex: i, totalFiles, functionCount })

          // 本文件已上报的函数数，用于整文件失败时补齐差额而不重复计数
          let fileDoneFunctions = 0
          const isUserCancelled = (): boolean =>
            flag.cancelled ||
            (abortController.signal.aborted && abortController.signal.reason === 'cancel')
          const emitFunctionDone = (
            functionName: string,
            status: 'success' | 'failed'
          ): void => {
            doneFunctions++
            fileDoneFunctions++
            const elapsed = Date.now() - startedAt
            const avg = doneFunctions > 0 ? elapsed / doneFunctions : 0
            emit({
              phase: 'function-done',
              file,
              functionName,
              status,
              doneFunctions,
              totalFunctions,
              overallPercent:
                totalFunctions > 0 ? Math.round((doneFunctions / totalFunctions) * 100) : 100,
              etaMs: Math.max(0, Math.round((totalFunctions - doneFunctions) * avg))
            })
          }

          try {
            const bytes = await fs.readFile(file)
            const fileContent = bytes.toString('utf8')
            const lang = file.toLowerCase().endsWith('.java') ? 'java' : 'cpp'

            // 1. 解析函数列表
            let functions: ParsedFunction[]
            try {
              functions = await parseFunctionsTreeSitter({
                app,
                filePath: file,
                contentBytes: bytes
              })
            } catch {
              functions = parseFunctionsFallback(file, bytes)
            }

            let auditReport: CodeAuditReport

            if (functions.length === 0) {
              // 没有函数则回退到文件级审计
              const { report: fileReport } = await callFileAuditLLM({
                filePath: file,
                language: lang,
                fileContent,
                scope: 'original',
                abortController
              })
              auditReport = fileReport
            } else {
              // 2. 逐函数审计
              type FuncAuditReport = Awaited<
                ReturnType<typeof callFunctionAuditLLM>
              >['report']
              const funcAuditResults: Array<{
                func: ParsedFunction
                report: FuncAuditReport
              }> = []

              for (const func of functions) {
                if (abortController.signal.aborted) break
                emit({ phase: 'function-start', file, functionName: func.name })
                const funcCode = bytes
                  .subarray(func.startByte, func.endByte)
                  .toString('utf8')
                try {
                  const { report: funcReport } = await callFunctionAuditLLM({
                    filePath: file,
                    language: lang,
                    functionName: func.name,
                    functionCode: funcCode,
                    startLine: func.startLine,
                    endLine: func.endLine,
                    scope: 'original',
                    abortController
                  })
                  funcAuditResults.push({ func, report: funcReport })
                  emitFunctionDone(func.name, 'success')
                } catch (e) {
                  if (isUserCancelled()) {
                    // 取消导致的中断不计入完成数，避免取消后进度显示为 100%
                    break
                  }
                  const errMsg = e instanceof Error ? e.message : String(e)
                  console.error(
                    `[audit:batch] 函数 ${func.name} 审计失败 (${file})：${errMsg}`
                  )
                  emitFunctionDone(func.name, 'failed')
                }
              }

              // 3. 构建汇总报告
              const functionResults: FunctionAuditEntry[] = []
              let vulnCount = 0
              const severityRank: Record<CodeAuditSeverity, number> = {
                low: 1,
                medium: 2,
                high: 3,
                critical: 4
              }
              let highestRisk: CodeAuditSeverity = 'low'

              for (const { func, report } of funcAuditResults) {
                const entry: FunctionAuditEntry = {
                  functionName: func.name,
                  startLine: func.startLine,
                  endLine: func.endLine,
                  overallRisk: report.overallRisk,
                  hasVulnerabilities: report.hasVulnerabilities,
                  vulnerabilities: report.hasVulnerabilities
                    ? report.vulnerabilities
                    : undefined,
                  safeCodeAnalysis: !report.hasVulnerabilities
                    ? report.safeCodeAnalysis
                    : undefined
                }
                functionResults.push(entry)

                if (report.hasVulnerabilities) {
                  vulnCount += report.vulnerabilities.length
                }
                if (
                  severityRank[report.overallRisk] >
                  severityRank[highestRisk]
                ) {
                  highestRisk = report.overallRisk
                }
              }

              const summary =
                vulnCount > 0
                  ? `逐函数扫描完成：共 ${functions.length} 个函数，发现 ${vulnCount} 个漏洞`
                  : `逐函数扫描完成：共 ${functions.length} 个函数，未发现安全漏洞`

              auditReport = {
                filePath: file,
                scope: 'original',
                language: lang,
                model: process.env.LLM_MODEL || 'gpt-4.1-mini',
                scanCoverage: `逐函数扫描，共 ${functions.length} 个函数`,
                summary,
                generatedAt: new Date().toLocaleString('zh-CN', {
                  hour12: false
                }),
                functionResults
              }
            }

            // 4. 导出 JSON 到文件同目录
            const jsonPath =
              file.replace(/\.[^.]+$/, '') + '.audit.json'
            await fs.writeFile(
              jsonPath,
              JSON.stringify(auditReport, null, 2),
              'utf8'
            )

            batchReport.push({ file, status: 'ok', jsonPath })
            emit({
              phase: 'file-done',
              file,
              fileIndex: i,
              totalFiles,
              jsonPath
            })
          } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e)
            console.error(`[audit:batch] 文件审计失败 (${file})：${errMsg}`)
            // 整文件失败时把剩余函数计入进度，避免进度卡住；取消则保留缺口
            if (!isUserCancelled()) {
              doneFunctions += Math.max(0, functionCount - fileDoneFunctions)
            }
            batchReport.push({ file, status: 'failed', error: errMsg })
            emit({
              phase: 'file-error',
              file,
              fileIndex: i,
              totalFiles,
              error: errMsg
            })
          }
        }

        const okCount = batchReport.filter((r) => r.status === 'ok').length
        emit({ phase: 'batch-done', totalFiles, okCount, report: batchReport })
        return { ok: true, report: batchReport }
      } finally {
        batchCancelFlags.delete(params.batchId)
        inflightRefactorControllers.delete(params.batchId)
      }
    }
  )

  ipcMain.handle('refactor:batch:cancel', (_evt, batchId: string) => {
    const flag = batchCancelFlags.get(batchId)
    if (flag) flag.cancelled = true
    inflightRefactorControllers.get(batchId)?.abort('cancel')
    return { ok: !!flag }
  })

  createWindow()

  app.on('activate', function () {
    // macOS：常见行为是在点击 Dock 图标且没有窗口时重新创建窗口
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 关闭所有窗口时退出应用（macOS 例外：通常应用会保持运行，直到用户显式 Cmd + Q 退出）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 说明：主进程其它业务代码也可以拆分到单独文件中，再在这里引入。
