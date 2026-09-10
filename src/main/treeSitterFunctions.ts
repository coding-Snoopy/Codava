import * as path from 'path'
import type { App } from 'electron'

export type ParsedFunction = {
  id: string
  name: string
  startByte: number
  endByte: number
  startLine: number
  endLine: number
}

type TSNode = {
  type: string
  startIndex: number
  endIndex: number
  startPosition: { row: number; column: number }
  endPosition: { row: number; column: number }
  childForFieldName(name: string): TSNode | null
  namedChildren: TSNode[]
  children: TSNode[]
}

type TSParser = {
  setLanguage(lang: unknown): void
  // web-tree-sitter 0.25.x 的 parse 接受字符串（UTF-16），返回的 startIndex/endIndex 为 UTF-16 字符偏移
  parse(input: string): { rootNode: TSNode }
}

type WebTreeSitterLanguage = {
  load(path: string): Promise<unknown>
}

type WebTreeSitterParserStatic = {
  init(options: { locateFile: (name: string) => string }): Promise<void>
}

type WebTreeSitterParser = WebTreeSitterParserStatic & (new () => TSParser)

let tsInitPromise: Promise<void> | null = null
let tsParser: TSParser | null = null
let langCache: Map<string, unknown> | null = null

async function importWebTreeSitter(): Promise<{
  Parser: WebTreeSitterParser
  Language: WebTreeSitterLanguage
}> {
  const mod = (await import('web-tree-sitter')) as unknown as {
    default?: { Parser?: unknown; Language?: unknown } & unknown
    Parser?: unknown
    Language?: unknown
  }
  const modDefault = mod.default as { Parser?: unknown; Language?: unknown } | undefined
  // 兼容多种导出形态：
  // - 0.25.x（本项目使用）：具名导出 Parser（有 init/可 new）与独立的 Language（有 load）
  // - 旧版 CJS：module.exports = Parser，且 Parser.Language 提供 load
  // 若错误地取到模块命名空间本身，Parser.init/new Parser() 会抛错，导致 tree-sitter
  // 静默失效、所有调用退化为正则兜底（大文件下是严重性能问题）
  const Parser = (mod.Parser ?? modDefault?.Parser ?? modDefault ?? mod) as WebTreeSitterParser
  const Language = (mod.Language ??
    modDefault?.Language ??
    (Parser as unknown as { Language?: unknown }).Language) as WebTreeSitterLanguage
  return { Parser, Language }
}

// 解析 node_modules 下的资源绝对路径，并兼容生产环境的 asar 打包。
// - 开发模式：app.getAppPath() 指向项目根目录，直接拼接即可
// - 生产模式：app.getAppPath() 形如 .../resources/app.asar，但经 asarUnpack 的 wasm
//   实际位于 .../resources/app.asar.unpacked 下，需把 app.asar 替换为 app.asar.unpacked
function resolveNodeModulePath(app: App, ...segments: string[]): string {
  const appPath = app.getAppPath()
  const base = appPath.endsWith('app.asar') ? `${appPath}.unpacked` : appPath
  return path.join(base, 'node_modules', ...segments)
}

function wasmDir(app: App): string {
  // 各语言语法 wasm 目录（@vscode/tree-sitter-wasm）。生产环境需在 electron-builder.yml
  // 对该包做 asarUnpack，否则 Language.load 无法从 asar 内读取 wasm。
  return resolveNodeModulePath(app, '@vscode', 'tree-sitter-wasm', 'wasm')
}

async function ensureTreeSitter(app: App): Promise<void> {
  if (tsInitPromise) return tsInitPromise

  tsInitPromise = (async () => {
    const { Parser } = await importWebTreeSitter()

    // 核心运行时 wasm 必须使用 web-tree-sitter 自带的 web-tree-sitter.wasm，
    // 与其 JS 胶水同 ABI；@vscode/tree-sitter-wasm 的核心 wasm 由不同 emscripten 构建，
    // 用它会触发 `_emscripten_memcpy_js` LinkError（@vscode 的 wasm 仅用于各语言语法）
    const coreWasm = resolveNodeModulePath(app, 'web-tree-sitter', 'web-tree-sitter.wasm')
    await Parser.init({ locateFile: () => coreWasm })

    tsParser = new Parser()
    langCache = new Map()
  })()

  return tsInitPromise
}

function languageKeyFromFile(filePath: string): 'c' | 'cpp' | 'java' | null {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.java') return 'java'
  if (ext === '.c' || ext === '.h') return 'c'
  if (ext === '.cc' || ext === '.cpp' || ext === '.cxx' || ext === '.hpp') return 'cpp'
  return null
}

async function loadLanguage(app: App, key: 'c' | 'cpp' | 'java'): Promise<unknown> {
  await ensureTreeSitter(app)
  if (!langCache) throw new Error('Tree-sitter not initialized')

  const cached = langCache.get(key)
  if (cached) return cached

  const { Language } = await importWebTreeSitter()

  let langWasmPath: string
  if (key === 'c') {
    langWasmPath = resolveNodeModulePath(
      app,
      '@xsrg2008',
      'web-tree-sitter-c',
      'tree-sitter-c.wasm'
    )
  } else if (key === 'cpp') {
    langWasmPath = path.join(wasmDir(app), 'tree-sitter-cpp.wasm')
  } else {
    langWasmPath = path.join(wasmDir(app), 'tree-sitter-java.wasm')
  }
  const lang = await Language.load(langWasmPath)
  langCache.set(key, lang)
  return lang
}

// ============================================================
// UTF-16 字符偏移 ↔ UTF-8 字节偏移 转换
// ------------------------------------------------------------
// web-tree-sitter 0.25.x 解析字符串，节点 startIndex/endIndex 是 UTF-16 字符偏移；
// 而本项目下游（refactor 切片、复杂度区间、函数 id）均以 UTF-8 字节偏移为契约（Buffer.subarray）。
// 这里统一在模块内部完成转换，对外仍返回字节偏移，确保下游代码零改动。

// 构建字符索引(UTF-16 单元) -> UTF-8 字节偏移的前缀映射（长度为 str.length + 1，单调递增）
function buildByteOffsets(str: string): Uint32Array {
  const n = str.length
  const arr = new Uint32Array(n + 1)
  let byte = 0
  for (let i = 0; i < n; i++) {
    arr[i] = byte
    const c = str.charCodeAt(i)
    if (c < 0x80) {
      byte += 1
    } else if (c < 0x800) {
      byte += 2
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < n) {
      const c2 = str.charCodeAt(i + 1)
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        // 代理对：一个码点 = 4 字节，占 2 个 UTF-16 单元
        byte += 4
        arr[i + 1] = byte // 低代理位映射到该 4 字节序列之后
        i++
        continue
      }
      byte += 3 // 落单的高代理，按 3 字节兜底
    } else {
      byte += 3
    }
  }
  arr[n] = byte
  return arr
}

function inferNameFromDeclaratorText(text: string): string {
  // 尽力而为：取第一个 '(' 之前的最后一个标识符作为函数名
  const beforeParen = text.split('(')[0] || ''
  const m = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(beforeParen.trim())
  return m?.[1] || '<anonymous>'
}

// 注意：node 的 startIndex/endIndex 是 UTF-16 字符偏移，因此直接从源字符串按字符切片
function extractName(node: TSNode, source: string, language: 'c' | 'cpp' | 'java'): string {
  if (language === 'java') {
    const nameNode = node.childForFieldName('name')
    if (nameNode) return source.slice(nameNode.startIndex, nameNode.endIndex)
  }

  const decl = node.childForFieldName('declarator')
  if (decl) {
    const declText = source.slice(decl.startIndex, decl.endIndex)
    return inferNameFromDeclaratorText(declText)
  }

  // 兜底：遍历命名子节点，找 identifier/xxx_identifier 之类的节点
  const stack: TSNode[] = [node]
  while (stack.length) {
    const cur = stack.pop()!
    if (cur.type.endsWith('identifier') || cur.type === 'identifier') {
      return source.slice(cur.startIndex, cur.endIndex)
    }
    for (let i = cur.namedChildren.length - 1; i >= 0; i--) stack.push(cur.namedChildren[i])
  }

  return '<anonymous>'
}

function collectFunctionNodes(root: TSNode, language: 'c' | 'cpp' | 'java'): TSNode[] {
  const wanted = new Set<string>()

  if (language === 'java') {
    wanted.add('method_declaration')
    wanted.add('constructor_declaration')
    wanted.add('interface_method_declaration')
  } else {
    // C/C++
    wanted.add('function_definition')
  }

  const out: TSNode[] = []
  const stack: TSNode[] = [root]

  while (stack.length) {
    const node = stack.pop()!
    if (wanted.has(node.type)) out.push(node)

    // 只遍历 namedChildren，避免把标点符号也当成节点走一遍
    for (let i = node.namedChildren.length - 1; i >= 0; i--) {
      stack.push(node.namedChildren[i])
    }
  }

  return out
}

export type FileAnalysis = {
  functions: ParsedFunction[]
  functionComplexities: Record<string, number>
}

/**
 * 整文件仅做一次 tree-sitter 解析，同时产出函数边界列表与每个函数的圈复杂度。
 * 打开文件的关键路径用它替代“parseFunctions + 复杂度计算”的重复解析（大文件性能优化）。
 */
export async function analyzeFileWithTreeSitter(params: {
  app: App
  filePath: string
  contentBytes: Uint8Array
}): Promise<FileAnalysis> {
  const key = languageKeyFromFile(params.filePath)
  if (!key) return { functions: [], functionComplexities: {} }

  await ensureTreeSitter(params.app)
  if (!tsParser) throw new Error('Tree-sitter parser not initialized')

  const lang = await loadLanguage(params.app, key)
  tsParser.setLanguage(lang)

  const source = Buffer.from(params.contentBytes).toString('utf8')
  const tree = tsParser.parse(source)
  const byteOffsets = buildByteOffsets(source)
  const nodes = collectFunctionNodes(tree.rootNode, key)

  const functions: ParsedFunction[] = []
  const functionComplexities: Record<string, number> = {}
  const seen = new Set<string>()

  for (const n of nodes) {
    // 节点偏移为 UTF-16 字符偏移，转换为对外契约的 UTF-8 字节偏移
    const startByte = byteOffsets[n.startIndex]
    const endByte = byteOffsets[n.endIndex]
    if (endByte <= startByte) continue

    // 按范围去重（避免同一函数节点被重复采集）
    const rangeKey = `${startByte}-${endByte}`
    if (seen.has(rangeKey)) continue
    seen.add(rangeKey)

    const name = extractName(n, source, key)
    const id = `${params.filePath}:${startByte}-${endByte}`
    functions.push({
      id,
      name,
      startByte,
      endByte,
      startLine: n.startPosition.row + 1,
      endLine: n.endPosition.row + 1
    })
    functionComplexities[id] = 1 + countComplexityInSubtree(n, key)
  }

  functions.sort((a, b) => a.startByte - b.startByte)
  return { functions, functionComplexities }
}

export async function parseFunctionsTreeSitter(params: {
  app: App
  filePath: string
  contentBytes: Uint8Array
}): Promise<ParsedFunction[]> {
  // 通过 Tree-sitter 解析函数边界，返回字节偏移与行号区间。
  // 注意：0.25.x 解析字符串，节点偏移为 UTF-16 字符偏移，需转换为 UTF-8 字节偏移后对外使用。
  const key = languageKeyFromFile(params.filePath)
  if (!key) return []

  await ensureTreeSitter(params.app)
  if (!tsParser) throw new Error('Tree-sitter parser not initialized')

  const lang = await loadLanguage(params.app, key)
  tsParser.setLanguage(lang)

  const source = Buffer.from(params.contentBytes).toString('utf8')
  const tree = tsParser.parse(source)
  const byteOffsets = buildByteOffsets(source)
  const nodes = collectFunctionNodes(tree.rootNode, key)

  const functions: ParsedFunction[] = nodes
    .map((n) => {
      const name = extractName(n, source, key)
      const startByte = byteOffsets[n.startIndex]
      const endByte = byteOffsets[n.endIndex]
      const startLine = n.startPosition.row + 1
      const endLine = n.endPosition.row + 1
      const id = `${params.filePath}:${startByte}-${endByte}`
      return { id, name, startByte, endByte, startLine, endLine }
    })
    .filter((f) => f.endByte > f.startByte)
    .sort((a, b) => a.startByte - b.startByte)

  // 按范围去重（避免同一函数节点被重复采集）
  const seen = new Set<string>()
  return functions.filter((f) => {
    const k = `${f.startByte}-${f.endByte}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

// ============================================================
// 基于 AST 的圈复杂度计算
// ============================================================

// 各语言中“判定节点”对应的 AST 节点类型。
// 每命中一个节点计 1 点复杂度；&& / || 逻辑运算符单独按 token 计数。
const DECISION_NODE_TYPES: Record<'c' | 'cpp' | 'java', Set<string>> = {
  c: new Set([
    'conditional_statement', // if / else if
    'for_statement',
    'while_statement',
    'do_statement',
    'case_statement', // switch 中的 case / default 标签
    'catch_clause',
    'conditional_expression' // 三元 a ? b : c
  ]),
  cpp: new Set([
    'conditional_statement',
    'for_statement',
    'while_statement',
    'do_statement',
    'case_statement',
    'catch_clause',
    'conditional_expression'
  ]),
  java: new Set([
    'if_statement',
    'for_statement',
    'enhanced_for_statement', // for-each
    'while_statement',
    'do_statement',
    'switch_label', // switch 中的 case / default 标签
    'catch_clause',
    'ternary_expression'
  ])
}

function countComplexityInSubtree(node: TSNode, key: 'c' | 'cpp' | 'java'): number {
  const decisionTypes = DECISION_NODE_TYPES[key]
  let count = 0
  const stack: TSNode[] = [node]

  while (stack.length) {
    const cur = stack.pop()!

    if (decisionTypes.has(cur.type)) {
      count += 1
    } else if (cur.type === 'binary_expression') {
      // 逻辑运算符 && / || 是匿名子节点：仅对二元表达式节点访问 children（含匿名 token），
      // 避免遍历过程为每个节点都做一次 WASM→JS 的 children 数组分配
      for (const child of cur.children) {
        if (child.type === '&&' || child.type === '||') count += 1
      }
    }

    // 只遍历 namedChildren：节点数约为 children 的一半（不含标点等匿名 token），
    // 大文件下显著减少跨 WASM/JS 边界的属性访问与数组分配次数
    for (let i = cur.namedChildren.length - 1; i >= 0; i--) {
      stack.push(cur.namedChildren[i])
    }
  }

  return count
}

/**
 * 基于 AST 计算整段代码的圈复杂度（基础值 1 + 判定节点数）。
 * 由调用方负责完成解析并传入根节点，本函数不持有 parser 状态。
 */
export function complexityFromRoot(root: TSNode, key: 'c' | 'cpp' | 'java'): number {
  return 1 + countComplexityInSubtree(root, key)
}

/**
 * 确保 tree-sitter 已完成初始化（供圈复杂度模块复用）。
 */
export async function ensureTreeSitterForComplexity(app: App): Promise<void> {
  await ensureTreeSitter(app)
}

/**
 * 解析一段代码并返回语法树根节点（供圈复杂度模块复用）。
 * 通过 filePath 的扩展名选择 C / C++ / Java 语法。
 */
export async function parseToRootForComplexity(
  app: App,
  code: string,
  filePath: string
): Promise<TSNode | null> {
  const key = languageKeyFromFile(filePath)
  if (!key) return null

  await ensureTreeSitter(app)
  if (!tsParser) throw new Error('Tree-sitter parser not initialized')

  const lang = await loadLanguage(app, key)
  tsParser.setLanguage(lang)

  return tsParser.parse(code).rootNode
}
