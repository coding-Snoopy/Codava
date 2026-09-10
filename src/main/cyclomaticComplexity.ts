/**
 * 圈复杂度计算模块
 *
 * 圈复杂度（Cyclomatic Complexity）用于衡量程序的逻辑复杂度。
 * 计算方法：基于控制流图中的判定节点数量。
 *
 * 判定语句包括：
 * - if, else if
 * - for, while
 * - case (switch 语句中的每个 case)
 * - catch
 * - &&, || (逻辑运算符)
 * - ?: (三元运算符)
 */

import type { App } from 'electron'
import {
  complexityFromRoot,
  ensureTreeSitterForComplexity,
  parseToRootForComplexity
} from './treeSitterFunctions'

/**
 * 计算给定代码片段的圈复杂度
 * @param code 源代码字符串
 * @param language 编程语言 ('c' | 'cpp' | 'java' | 'plaintext')
 * @returns 圈复杂度数值（最小值为 1）
 */
export function calculateCyclomaticComplexity(
  code: string,
  language: string = 'plaintext'
): number {
  if (!code || code.trim().length === 0) {
    return 1
  }

  // 移除字符串字面量和注释，避免误判
  const cleanedCode = removeStringsAndComments(code, language)

  let complexity = 1 // 基础复杂度

  // 统计判定节点
  // 1) if / for / while / catch
  const ifMatches = cleanedCode.match(/\bif\s*(?:constexpr\s*)?\(/g)
  if (ifMatches) complexity += ifMatches.length

  const forMatches = cleanedCode.match(/\bfor\s*\(/g)
  if (forMatches) complexity += forMatches.length

  const whileMatches = cleanedCode.match(/\bwhile\s*\(/g)
  if (whileMatches) complexity += whileMatches.length

  const catchMatches = cleanedCode.match(/\bcatch\s*\(/g)
  if (catchMatches) complexity += catchMatches.length

  // 2) switch 分支标签（case/default）
  const caseMatches = cleanedCode.match(/\bcase\s+[^:]+:/g)
  if (caseMatches) complexity += caseMatches.length
  const defaultMatches = cleanedCode.match(/\bdefault\s*:/g)
  if (defaultMatches) complexity += defaultMatches.length

  // 3) 条件表达式中的逻辑运算符 && / ||
  // 仅在 if/for/while/catch 的 (...) 中计数，避免全局过度统计
  complexity += countLogicalOperatorsInDecisionExpressions(cleanedCode)

  // 4) 三元运算符 ?:
  const ternaryMatches = cleanedCode.match(/\?[^?:]*:/g)
  if (ternaryMatches) complexity += ternaryMatches.length

  // Java 特有：增强 for 循环（for-each）已在 for 中统计
  // Java 特有：instanceof 不增加圈复杂度

  return complexity
}

function countLogicalOperatorsInDecisionExpressions(cleanedCode: string): number {
  let total = 0
  const startRegex = /\b(?:if\s*(?:constexpr\s*)?|for|while|catch)\s*\(/g

  let match: RegExpExecArray | null
  while ((match = startRegex.exec(cleanedCode)) !== null) {
    const openParenIndex = match.index + match[0].length - 1
    const closeParenIndex = findMatchingParen(cleanedCode, openParenIndex)
    if (closeParenIndex < 0) continue

    const expr = cleanedCode.slice(openParenIndex + 1, closeParenIndex)
    const andCount = expr.match(/&&/g)?.length ?? 0
    const orCount = expr.match(/\|\|/g)?.length ?? 0
    total += andCount + orCount
  }

  return total
}

function findMatchingParen(text: string, openParenIndex: number): number {
  let depth = 0

  for (let i = openParenIndex; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(') {
      depth += 1
      continue
    }
    if (ch !== ')') continue

    depth -= 1
    if (depth === 0) return i
  }

  return -1
}

/**
 * 移除代码中的字符串字面量和注释
 * @param code 源代码
 * @param language 语言类型
 * @returns 清理后的代码
 */
function removeStringsAndComments(code: string, language: string): string {
  let result = ''
  let i = 0
  let inString: '"' | "'" | '`' | null = null
  let inLineComment = false
  let inBlockComment = false

  while (i < code.length) {
    const ch = code[i]
    const next = i + 1 < code.length ? code[i + 1] : ''

    // 处理行注释结束
    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false
        result += ch
      }
      i++
      continue
    }

    // 处理块注释结束
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false
        i += 2
      } else {
        i++
      }
      continue
    }

    // 处理字符串
    if (inString) {
      if (ch === '\\' && i + 1 < code.length) {
        // 跳过转义字符
        i += 2
        continue
      }
      if (ch === inString) {
        inString = null
      }
      i++
      continue
    }

    // 检测新的注释或字符串开始
    if (ch === '/' && next === '/') {
      inLineComment = true
      i += 2
      continue
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true
      i += 2
      continue
    }

    if (ch === '"' || ch === "'" || (language !== 'java' && ch === '`')) {
      inString = ch
      i++
      continue
    }

    // 保留非注释和字符串的字符
    result += ch
    i++
  }

  return result
}

/**
 * 计算文件中每个函数的圈复杂度
 * @param fileContent 文件完整内容
 * @param functions 函数列表（包含起止位置）
 * @param language 语言类型
 * @returns 每个函数的圈复杂度映射（key 为函数 id）
 */
export function calculateFunctionComplexities(
  fileContent: string,
  functions: Array<{
    id: string
    startByte: number
    endByte: number
  }>,
  language: string
): Record<string, number> {
  const result: Record<string, number> = {}
  const fileBytes = Buffer.from(fileContent, 'utf8')

  for (const fn of functions) {
    const funcCode = fileBytes.subarray(fn.startByte, fn.endByte).toString('utf8')
    result[fn.id] = calculateCyclomaticComplexity(funcCode, language)
  }

  return result
}

/**
 * 计算整个文件的圈复杂度
 * @param fileContent 文件内容
 * @param language 语言类型
 * @returns 文件整体圈复杂度
 */
export function calculateFileComplexity(fileContent: string, language: string): number {
  return calculateCyclomaticComplexity(fileContent, language)
}

// ============================================================
// 基于 AST 的圈复杂度计算（tree-sitter，解析失败时回退正则算法）
// ============================================================
/**
 * 将通用语言标识映射到 tree-sitter 语法键。
 * 不支持的语言返回 null，调用方据此回退到正则算法。
 */
function toTreeSitterKey(language: string): 'c' | 'cpp' | 'java' | null {
  const lang = (language || '').toLowerCase()
  if (lang === 'c') return 'c'
  if (lang === 'cpp' || lang === 'c++') return 'cpp'
  if (lang === 'java') return 'java'
  return null
}

/**
 * 使用 tree-sitter AST 计算代码片段的圈复杂度。
 * 解析失败或语言不受支持时，回退到正则算法（calculateCyclomaticComplexity），
 * 因此本函数始终能返回合理结果。
 *
 * @param app Electron App 实例（用于定位 wasm 资源）
 * @param code 源代码字符串
 * @param language 语言标识（'c' | 'cpp' | 'java'）
 * @param filePath 可选文件路径，用于按扩展名更精确地选择 C / C++ 语法
 */
export async function calculateCyclomaticComplexityAST(
  app: App,
  code: string,
  language: string,
  filePath?: string
): Promise<number> {
  if (!code || code.trim().length === 0) return 1

  const key = toTreeSitterKey(language)
  if (!key) return calculateCyclomaticComplexity(code, language)

  try {
    await ensureTreeSitterForComplexity(app)
    const ext = key === 'java' ? 'java' : key === 'c' ? 'c' : 'cpp'
    const root = await parseToRootForComplexity(app, code, filePath ?? `snippet.${ext}`)
    if (!root) return calculateCyclomaticComplexity(code, language)
    return complexityFromRoot(root, key)
  } catch {
    return calculateCyclomaticComplexity(code, language)
  }
}
