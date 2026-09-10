/**
 * 函数签名一致性检查模块
 *
 * 通过 Tree-sitter 解析函数，提取"函数头"（从函数起始到 { 之前的部分），
 * 标准化空白符后进行字符串比对，判断重构前后函数签名是否一致。
 *
 * 同时支持回退：若 Tree-sitter 解析失败，使用启发式方法提取函数头。
 */

import { extname } from 'path'
import type { App } from 'electron'
import { parseFunctionsTreeSitter } from './treeSitterFunctions'

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export type SignatureDiff = {
  functionName: string
  originalSignature: string
  refactoredSignature: string
}

export type SignatureCheckResult = {
  pass: boolean
  differences: SignatureDiff[]
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * 标准化代码文本：折叠连续空白、移除 // 和 /* 注释
 */
function normalizeWhitespace(text: string): string {
  let result = ''
  let i = 0

  while (i < text.length) {
    const ch = text[i]
    const next = i + 1 < text.length ? text[i + 1] : ''

    // 行注释 //
    if (ch === '/' && next === '/') {
      i += 2
      while (i < text.length && text[i] !== '\n') i++
      continue
    }

    // 块注释 /* */
    if (ch === '/' && next === '*') {
      i += 2
      while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2
      continue
    }

    // 折叠空白
    if (/\s/.test(ch)) {
      i++
      // 跳过后续空白
      while (i < text.length && /\s/.test(text[i])) i++
      result += ' '
      continue
    }

    result += ch
    i++
  }

  return result.trim()
}

/**
 * 提取函数签名头部分（函数起始到第一个 body { 之前）
 *
 * 策略（按优先级回退）：
 *   A. 使用 findTopLevelBrace 定位函数体 '{'（已处理字符串/注释/括号嵌套）
 *   B. 通过参数列表 ')' 定位 + 惰性匹配到 '{'（兼容初始化列表等）
 */
function extractFunctionHead(code: string): string {
  // 方案 A：直接找第一个顶层 '{'（findTopLevelBrace 已处理字符串、注释、括号嵌套）
  const braceIdx = findTopLevelBrace(code)
  if (braceIdx >= 0) return code.slice(0, braceIdx)

  // 方案 B：通过参数列表 ')' 回退定位
  let depth = 0
  let parenEnd = -1

  for (let i = 0; i < code.length; i++) {
    const ch = code[i]
    if (ch === '(') {
      depth++
    } else if (ch === ')') {
      depth--
      if (depth === 0 && parenEnd < 0) {
        parenEnd = i
        break
      }
    }
  }

  if (parenEnd < 0) return code

  // 从 parenEnd 之后找第一个 '{'（跳过可能的 const/override/throws/初始化列表等）
  const afterParams = code.slice(parenEnd + 1)
  const braceMatch = /^[^{]*\{/.exec(afterParams)
  if (braceMatch) {
    const beforeBrace = braceMatch[0].slice(0, -1)
    return code.slice(0, parenEnd + 1 + beforeBrace.length)
  }

  return code.slice(0, parenEnd + 1).trimEnd()
}

/**
 * C++ 签名标准化：消除语法形式不同但语义等价的差异
 *
 * 处理：
 *   - [[attributes]]（nodiscard, maybe_unused, gnu::xxx 等）
 *   - template 中 typename ↔ class
 *   - __attribute__((...)) / __declspec(...) 等编译器扩展
 */
function normalizeCppSignature(sig: string): string {
  let result = sig

  // 1. 移除 C++11 属性 [[...]]（支持嵌套，如 [[gnu::always_inline, nodiscard]]）
  let prev = ''
  while (prev !== result) {
    prev = result
    result = result.replace(
      // eslint-disable-next-line no-useless-escape
      /\[\[(?:[^\[\]]|\[(?:[^\[\]]|\[(?:[^\[\]])*?\])*?\])*?\]\]/g,
      ''
    )
  }

  // 2. template<...> 中 typename ↔ class 完全等价
  result = result.replace(/\btypename\b/g, 'class')

  // 3. 移除 GCC/Clang __attribute__((...)) 和 MSVC __declspec(...)
  result = result.replace(/__attribute__\s*\(\([\s\S]*?\)\)/g, '')
  result = result.replace(/__declspec\s*\([\s\S]*?\)/g, '')

  return result.trim()
}

function findTopLevelBrace(code: string): number {
  let depth = 0
  let inStr: '"' | "'" | '`' | null = null
  let inLineComment = false
  let inBlockComment = false

  for (let i = 0; i < code.length; i++) {
    const ch = code[i]
    const next = i + 1 < code.length ? code[i + 1] : ''

    if (inLineComment) {
      if (ch === '\n') inLineComment = false
      continue
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i++ }
      continue
    }
    if (inStr) {
      if (ch === '\\') { i++; continue }
      if (ch === inStr) inStr = null
      continue
    }

    if (ch === '/' && next === '/') { inLineComment = true; i++; continue }
    if (ch === '/' && next === '*') { inBlockComment = true; i++; continue }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue }
    if (ch === '{' && depth === 0) return i
    if (ch === '(') depth++
    if (ch === ')') depth--
  }
  return -1
}

// ---------------------------------------------------------------------------
// Tree-sitter 路径提取函数头
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 检查单个函数的签名一致性
 *
 * @param originalCode  原始函数的完整代码
 * @param refactoredCode 重构后函数的完整代码
 * @param _language      语言（保留用于未来 Tree-sitter 增强）
 * @param functionName   函数名（用于差异报告中标识）
 */
export function checkSingleFunctionSignature(
  originalCode: string,
  refactoredCode: string,
  language: string,
  functionName: string = '<unknown>'
): SignatureCheckResult {
  const originalHead = extractFunctionHead(originalCode)
  const refactoredHead = extractFunctionHead(refactoredCode)

  let originalNorm = normalizeWhitespace(originalHead)
  let refactoredNorm = normalizeWhitespace(refactoredHead)

  // C/C++ 专属标准化：消除属性、typename/class、编译器扩展等非语义差异
  if (language === 'c' || language === 'cpp') {
    originalNorm = normalizeCppSignature(originalNorm)
    refactoredNorm = normalizeCppSignature(refactoredNorm)
  }

  const pass = originalNorm === refactoredNorm

  const differences: SignatureDiff[] = []
  if (!pass) {
    differences.push({
      functionName,
      originalSignature: originalHead.trim(),
      refactoredSignature: refactoredHead.trim()
    })
  }

  return { pass, differences }
}

/**
 * 检查文件中所有函数的签名一致性（用于文件级重构）
 *
 * @param originalFileContent  原始文件内容
 * @param refactoredFileContent 重构后文件内容
 * @param language              语言
 * @param filePath              文件路径
 * @param app                   Electron App 实例
 */
export async function checkAllFunctionSignatures(
  originalFileContent: string,
  refactoredFileContent: string,
  language: string,
  filePath: string,
  app: App
): Promise<SignatureCheckResult> {
  const originalBytes = Buffer.from(originalFileContent, 'utf8')
  const refactoredBytes = Buffer.from(refactoredFileContent, 'utf8')

  let origFunctions: RawParsedFunction[]
  let refactoredFunctions: RawParsedFunction[]

  try {
    origFunctions = await parseFunctionsTreeSitter({ app, filePath, contentBytes: originalBytes })
  } catch {
    origFunctions = parseFunctionsFallbackLocal(filePath, originalBytes)
  }

  try {
    refactoredFunctions = await parseFunctionsTreeSitter({
      app,
      filePath,
      contentBytes: refactoredBytes
    })
  } catch {
    refactoredFunctions = parseFunctionsFallbackLocal(filePath, refactoredBytes)
  }

  // 按函数名 + 出现序号构建索引
  const origMap = buildFunctionMap(origFunctions)
  const refactoredMap = buildFunctionMap(refactoredFunctions)

  const differences: SignatureDiff[] = []

  for (const [key, origFn] of origMap) {
    const refactoredFn = refactoredMap.get(key)
    if (!refactoredFn) {
      differences.push({
        functionName: origFn.name,
        originalSignature: 'present',
        refactoredSignature: '(missing)'
      })
      continue
    }

    const origCode = originalBytes.subarray(origFn.startByte, origFn.endByte).toString('utf8')
    const refactoredCode = refactoredBytes
      .subarray(refactoredFn.startByte, refactoredFn.endByte)
      .toString('utf8')

    let origHead = normalizeWhitespace(extractFunctionHead(origCode))
    let refactoredHead = normalizeWhitespace(extractFunctionHead(refactoredCode))

    if (language === 'c' || language === 'cpp') {
      origHead = normalizeCppSignature(origHead)
      refactoredHead = normalizeCppSignature(refactoredHead)
    }

    if (origHead !== refactoredHead) {
      differences.push({
        functionName: origFn.name,
        originalSignature: extractFunctionHead(origCode).trim(),
        refactoredSignature: extractFunctionHead(refactoredCode).trim()
      })
    }
  }

  return { pass: differences.length === 0, differences }
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

type RawParsedFunction = {
  id: string
  name: string
  startByte: number
  endByte: number
  startLine: number
  endLine: number
}

function buildFunctionMap(
  functions: RawParsedFunction[]
): Map<string, RawParsedFunction> {
  const nameCounters = new Map<string, number>()
  const result = new Map<string, RawParsedFunction>()

  for (const fn of functions) {
    const occ = (nameCounters.get(fn.name) ?? 0) + 1
    nameCounters.set(fn.name, occ)
    result.set(getNameOccurrenceKey(fn.name, occ), fn)
  }

  return result
}

function getNameOccurrenceKey(name: string, occurrence: number): string {
  return `${name}#${occurrence}`
}

/**
 * 本地启发式函数解析（与 index.ts 中的 parseFunctionsFallback 逻辑一致）
 */
export function parseFunctionsFallbackLocal(
  filePath: string,
  fileBytes: Uint8Array
): RawParsedFunction[] {
  const text = fileBytes.toString()
  const isJava = extname(filePath).toLowerCase() === '.java'

  const controlKeywords = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'foreach', 'do', 'synchronized'
  ])

  const results: RawParsedFunction[] = []
  const candidateRegex = /\)\s*\{/g

  function findFallbackFunctionStart(openParenIndex: number): number {
    let start = openParenIndex
    while (start > 0) {
      const prev = text[start - 1]
      if (prev === ';' || prev === '{' || prev === '}') break
      start--
    }
    while (start < openParenIndex && /\s/.test(text[start])) start++
    return start
  }

  function getLineNumberAt(index: number): number {
    let line = 1
    for (let i = 0; i < index && i < text.length; i++) {
      if (text.charCodeAt(i) === 10) line++
    }
    return line
  }

  function findMatchingBrace(openBraceIndex: number): number {
    let depth = 0
    let inStr: '"' | "'" | '`' | null = null
    let inLineComment = false
    let inBlockComment = false

    for (let i = openBraceIndex; i < text.length; i++) {
      const ch = text[i]
      const next = i + 1 < text.length ? text[i + 1] : ''

      if (inLineComment) { if (ch === '\n') inLineComment = false; continue }
      if (inBlockComment) { if (ch === '*' && next === '/') { inBlockComment = false; i++ } continue }
      if (inStr) { if (ch === '\\') { i++; continue } if (ch === inStr) inStr = null; continue }

      if (ch === '/' && next === '/') { inLineComment = true; i++; continue }
      if (ch === '/' && next === '*') { inBlockComment = true; i++; continue }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue }

      if (ch === '{') depth++
      if (ch === '}') { depth--; if (depth === 0) return i + 1 }
    }
    return -1
  }

  let match: RegExpExecArray | null
  while ((match = candidateRegex.exec(text)) !== null) {
    const openBrace = match.index + match[0].length - 1
    const closeParen = match.index
    let parenDepth = 0
    let openParen = -1
    for (let i = closeParen; i >= 0; i--) {
      if (text[i] === ')') parenDepth++
      else if (text[i] === '(') { parenDepth--; if (parenDepth === 0) { openParen = i; break } }
    }
    if (openParen < 0) continue

    const before = text.slice(0, openParen)
    const nameMatch = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(before)
    if (!nameMatch) continue
    const name = nameMatch[1]
    if (controlKeywords.has(name)) continue
    if (isJava && name === 'new') continue

    const endByte = findMatchingBrace(openBrace)
    if (endByte < 0) continue

    const startByte = findFallbackFunctionStart(openParen)
    const startLine = getLineNumberAt(startByte)
    const endLine = getLineNumberAt(endByte)
    const id = `${filePath}:${startByte}-${endByte}`

    results.push({ id, name, startByte, endByte, startLine, endLine })
  }

  const seen = new Set<number>()
  return results
    .filter((f) => { if (seen.has(f.startByte)) return false; seen.add(f.startByte); return true })
    .sort((a, b) => a.startByte - b.startByte)
}
