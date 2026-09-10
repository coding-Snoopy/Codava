/**
 * 重构质量门编排模块
 *
 * 负责：
 * 1. 调用 LLM 进行语义一致性检查（checkSemanticConsistency）
 * 2. 函数重构 + 质量门编排（runFunctionRefactorWithQG）：最多 3 次重试
 * 3. 文件重构 + 质量门编排（runFileRefactorWithQG）：方案 B — 靶向修正（旧方案，保留兼容）
 * 4. 文件重构 + 分析优先（runFileRefactorWithAnalysis）：方案 C — 分析优先
 *    - 阶段 1：先发整体给 LLM 分析哪些函数值得重构
 *    - 阶段 2：针对这些函数逐个进行函数级重构（复用 runFunctionRefactorWithQG）
 *    - 通过的 → 保留重构版本；失败的 → 保留原始代码
 */

import type { App } from 'electron'
import { checkSingleFunctionSignature, parseFunctionsFallbackLocal } from './signatureChecker'
import type { SignatureCheckResult } from './signatureChecker'
import { FailureReportManager } from './failureReport'
import type { SemanticCheckResult } from './failureReport'

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/** 函数级 LLM 调用器签名（由 index.ts 提供实现） */
export type FunctionRefactorLLMCaller = (params: {
  filePath: string
  language: string
  functionName: string
  functionCode: string
  instruction?: string
  abortController?: AbortController
}) => Promise<{ refactoredFunctionCode: string; raw?: unknown }>

/** 文件级 LLM 调用器签名（由 index.ts 提供实现） */
export type FileRefactorLLMCaller = (params: {
  filePath: string
  language: string
  fileContent: string
  instruction?: string
  abortController?: AbortController
}) => Promise<{ updatedFileContent: string; raw?: unknown }>

/** 单个函数的质量门结果 */
export type PerFunctionQGResult = {
  functionId: string
  functionName: string
  passed: boolean
  sigCheck: SignatureCheckResult | null
  semCheck: SemanticCheckResult | null
  attempt: number
}

/** 函数重构质量门返回值 */
export type FunctionRefactorQGResult = {
  passed: boolean
  refactoredFunctionCode: string
  updatedFileContent: string
  sigCheck: SignatureCheckResult | null
  semCheck: SemanticCheckResult | null
  attempt: number
}

/** 文件重构质量门返回值 */
export type FileRefactorQGResult = {
  updatedFileContent: string
  functionResults: PerFunctionQGResult[]
  failureCount: number
  passedCount: number
  /** 文件级重试次数（1 = 初次通过，>1 = 第 N 次全文件重试通过） */
  attempt: number
}

/** 语义检查 LLM 调用器签名（外部注入，用于解耦模型配置来源）。 */
export type SemanticCheckLLMCaller = (params: {
  system: string
  user: string
  abortController?: AbortController
}) => Promise<string>

/** 函数分析 LLM 调用器签名 — 发送整个文件，返回值得重构的函数名列表 */
export type FunctionAnalysisLLMCaller = (params: {
  filePath: string
  language: string
  fileContent: string
  functions: Array<{ name: string; startLine: number; endLine: number }>
  instruction?: string
  abortController?: AbortController
}) => Promise<{ functions: string[]; raw?: unknown }>

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * 将函数代码缝合回文件指定字节位置
 */
function stitchFunctionIntoFile(
  fileContent: string,
  startByte: number,
  endByte: number,
  newFunctionCode: string
): string {
  const before = fileContent.slice(0, startByte)
  const after = fileContent.slice(endByte)
  return before + newFunctionCode + after
}

/**
 * 构建累积的重试反馈文本
 */
function buildRetryFeedback(
  sigCheck: SignatureCheckResult | null,
  semCheck: SemanticCheckResult | null
): string {
  const parts: string[] = []

  if (sigCheck && !sigCheck.pass) {
    parts.push('## 签名不匹配')
    for (const diff of sigCheck.differences) {
      parts.push(`- 原始签名: \`${diff.originalSignature}\``)
      parts.push(`- 重构签名: \`${diff.refactoredSignature}\``)
      parts.push(`  → 请保持函数签名与原始完全一致，不要修改函数名、返回类型、参数类型/名称/顺序。`)
    }
  }

  if (semCheck && !semCheck.equivalent) {
    parts.push('## 语义不一致')
    for (const issue of semCheck.issues) {
      parts.push(`- ${issue}`)
    }
    if (semCheck.suggestion) {
      parts.push(`\n修正建议: ${semCheck.suggestion}`)
    }
  }

  if (parts.length === 0) {
    parts.push('上一轮重构未能通过双一致性审查，请重新生成。')
  }

  return '\n\n[双一致性审查反馈 - 请修正以下问题]\n' + parts.join('\n')
}

// ---------------------------------------------------------------------------
// 语义一致性检查（LLM）
// ---------------------------------------------------------------------------

/** LLM 通用调用参数 */
type LLMCallParams = {
  system: string
  user: string
  abortController?: AbortController
}

/**
 * 通用 LLM 调用（OpenAI 兼容 API）
 */
async function callLLM(params: LLMCallParams): Promise<string> {
  const baseUrl = (process.env.LLM_BASE_URL || 'https://api.openai.com').replace(/\/$/, '')
  const apiKey = (process.env.LLM_API_KEY || '').trim()
  let model = process.env.LLM_MODEL || 'gpt-4.1-mini'
  model = model.toLowerCase().replace(/[^a-z0-9-.]/g, '-')

  if (!apiKey) {
    // Mock 模式：返回空内容，由调用方处理
    console.log('[QG SemCheck] Mock 模式（无 LLM_API_KEY），跳过 LLM 调用')
    return ''
  }

  console.log('\n' + '='.repeat(80))
  console.log('[QG SemCheck] === 语义检查 LLM 请求 ===')
  console.log(`[QG SemCheck] Model: ${model}, BaseURL: ${baseUrl}`)
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
    const raw = (process.env.LLM_TIMEOUT_MS || '').trim()
    if (!raw) return 120_000
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) && n > 0 ? n : 120_000
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

/**
 * 调用 LLM 判断两个代码片段是否语义等价
 */
async function checkSemanticConsistency(params: {
  originalCode: string
  refactoredCode: string
  language: string
  scope: 'function' | 'file'
  abortController?: AbortController
  /** 外部注入的 LLM 调用器（优先于内置 process.env 版本） */
  callLLM?: SemanticCheckLLMCaller
}): Promise<SemanticCheckResult> {
  const system = `You are a code reviewer specializing in semantics verification.
Your task: determine whether two code snippets are SEMANTICALLY EQUIVALENT.

Definition of semantic equivalence:
- Same return values for ALL possible inputs
- Same externally observable side effects (parameter modifications, global state, I/O)
- Same error/exception behavior
- Same control flow outcomes

You MUST respond with ONLY a valid JSON object (no markdown fences, no other text):
{
  "equivalent": true or false,
  "confidence": "high" or "medium" or "low",
  "issues": ["specific difference 1", "specific difference 2"],
  "suggestion": "how to fix, or empty string if equivalent"
}`

  const scopeContext =
    params.scope === 'function'
      ? 'Compare the following two FUNCTION implementations for semantic equivalence:'
      : 'Compare the following two FILE contents for semantic equivalence across all functions:'

  const user = [
    scopeContext,
    '',
    `Language: ${params.language}`,
    '',
    '[Original Code]',
    '```',
    params.originalCode,
    '```',
    '',
    '[Refactored Code]',
    '```',
    params.refactoredCode,
    '```'
  ].join('\n')

  try {
    const llmCaller = params.callLLM ?? callLLM
    const content = await llmCaller({
      system,
      user,
      abortController: params.abortController
    })

    if (!content) {
      // Mock 模式（无 API key）
      return { equivalent: true, confidence: 'high', issues: [], suggestion: '' }
    }

    // 尝试解析 JSON：先尝试直接解析，再尝试从 markdown fence 中提取
    let parsed: Record<string, unknown> | null = null
    try {
      parsed = JSON.parse(content.trim()) as Record<string, unknown>
    } catch {
      const jsonMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?```/.exec(content)
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[1].trim()) as Record<string, unknown>
        } catch {
          // 解析失败，保守返回不等价
        }
      }
    }

    if (parsed && typeof parsed.equivalent === 'boolean') {
      const result = {
        equivalent: parsed.equivalent,
        confidence: typeof parsed.confidence === 'string' ? parsed.confidence : 'low',
        issues: Array.isArray(parsed.issues)
          ? parsed.issues.map(String)
          : [],
        suggestion: typeof parsed.suggestion === 'string' ? parsed.suggestion : ''
      }
      console.log(`[QG SemCheck] 结果: ${result.equivalent ? '✓ 等价' : '✗ 不等价'} (confidence: ${result.confidence})`)
      if (!result.equivalent) {
        console.log('[QG SemCheck] 问题:', result.issues)
        console.log('[QG SemCheck] 建议:', result.suggestion)
      }
      return result
    }

    // 无法解析 LLM 返回，保守处理：视为不等价
    return {
      equivalent: false,
      confidence: 'low',
      issues: ['LLM response could not be parsed as JSON'],
      suggestion: '请确保重构后代码与原始代码语义完全一致'
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    // Mock 模式回退
    if (msg.includes('LLM_API_KEY') || msg.includes('fetch')) {
      return { equivalent: true, confidence: 'low', issues: [], suggestion: '' }
    }
    throw e
  }
}

// ---------------------------------------------------------------------------
// 函数重构 + 质量门编排
// ---------------------------------------------------------------------------

/**
 * 带质量门的函数重构
 *
 * 流程：
 * for attempt = 1..4 (1 次初次 + 最多 3 次重试):
 *   LLM 重构 → 签名检查 → 语义检查
 *   通过 → 返回结果
 *   失败 → 累积反馈，下次重试
 * 4 次全败 → 回退原始代码，记录失败清单
 */
export async function runFunctionRefactorWithQG(params: {
  filePath: string
  language: string
  functionId: string
  functionName: string
  startByte: number
  endByte: number
  currentFileContent: string
  instruction?: string
  abortController?: AbortController
  callFunctionRefactorLLM: FunctionRefactorLLMCaller
  /** 外部注入的语义检查 LLM 调用器（优先于内置 process.env 版本） */
  callLLMForSemCheck?: SemanticCheckLLMCaller
  onProgress?: (msg: { functionName: string; attempt: number; maxAttempts: number; isRetry: boolean; stage: 'refactoring' | 'checking' }) => void
}): Promise<FunctionRefactorQGResult> {
  const {
    filePath,
    language,
    functionName,
    startByte,
    endByte,
    currentFileContent,
    instruction,
    abortController,
    callFunctionRefactorLLM,
    onProgress
  } = params

  const fileBytes = Buffer.from(currentFileContent, 'utf8')
  const originalFunctionCode = fileBytes.subarray(startByte, endByte).toString('utf8')

  let feedback = ''
  let lastResult: { refactoredFunctionCode: string; raw?: unknown } | null = null
  let lastSemCheck: SemanticCheckResult | null = null

  const MAX_ATTEMPTS = 4 // 1 次初次 + 3 次重试

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const isRetry = attempt > 1
    onProgress?.({ functionName, attempt, maxAttempts: MAX_ATTEMPTS, isRetry, stage: 'refactoring' })
    let fullInstruction = instruction
      ? instruction + feedback
      : feedback
        ? `Refactor this function.${feedback}`
        : undefined

    // 重试时附加上次重构结果 + 反馈，让 LLM 对照原始代码和上次失败结果来修正
    if (isRetry && lastResult) {
      const prevCode = `\n\n[上次重构结果 - 请基于原始代码修复其中问题]\n\`\`\`\n${lastResult.refactoredFunctionCode}\n\`\`\``
      fullInstruction = (fullInstruction || 'Refactor this function.')
      // 插入到反馈前面：上次结果 → 反馈 → 原始指令
      const fbIdx = fullInstruction.indexOf('[双一致性审查反馈')
      if (fbIdx >= 0) {
        fullInstruction = fullInstruction.slice(0, fbIdx) + prevCode + '\n' + fullInstruction.slice(fbIdx)
      } else {
        fullInstruction += prevCode
      }
    }

    try {
      lastResult = await callFunctionRefactorLLM({
        filePath,
        language,
        functionName,
        functionCode: originalFunctionCode,
        instruction: fullInstruction,
        abortController
      })
    } catch (e: unknown) {
      // 仅用户取消 / 超时时立即终止，网络错误等继续重试
      if (isAbortOrTimeout(e, abortController)) {
        return {
          passed: false,
          refactoredFunctionCode: originalFunctionCode,
          updatedFileContent: currentFileContent,
          sigCheck: null,
          semCheck: null,
          attempt
        }
      }
      const errMsg = e instanceof Error ? e.message : String(e)
      console.log(`[QG] 函数 ${functionName} LLM 调用失败（${errMsg}），将在下一轮重试`)
      feedback = `\n\n[上一轮 LLM 调用失败: ${errMsg}，请重新生成]`
      continue
    }

    // 签名检查
    const sigCheck = checkSingleFunctionSignature(
      originalFunctionCode,
      lastResult.refactoredFunctionCode,
      language,
      functionName
    )

    if (!sigCheck.pass) {
      feedback = buildRetryFeedback(sigCheck, null)
      const label = isRetry ? `第 ${attempt - 1} 次重试` : '初次'
      console.log(`[QG] 函数 ${functionName} ${label}签名检查失败:`, sigCheck.differences)
      continue
    }

    // 语义检查
    onProgress?.({ functionName, attempt, maxAttempts: MAX_ATTEMPTS, isRetry, stage: 'checking' })
    let semCheck: SemanticCheckResult
    try {
      semCheck = await checkSemanticConsistency({
        originalCode: originalFunctionCode,
        refactoredCode: lastResult.refactoredFunctionCode,
        language,
        scope: 'function',
        abortController,
        callLLM: params.callLLMForSemCheck
      })
    } catch {
      semCheck = {
        equivalent: false,
        confidence: 'low',
        issues: ['语义检查 LLM 调用失败'],
        suggestion: ''
      }
    }
    lastSemCheck = semCheck

    if (sigCheck.pass && semCheck.equivalent) {
      // 通过！缝合回文件
      const updatedFileContent = stitchFunctionIntoFile(
        currentFileContent,
        startByte,
        endByte,
        lastResult.refactoredFunctionCode
      )

      return {
        passed: true,
        refactoredFunctionCode: lastResult.refactoredFunctionCode,
        updatedFileContent,
        sigCheck,
        semCheck,
        attempt
      }
    }

    feedback = buildRetryFeedback(sigCheck, semCheck)
    const label = isRetry ? `第 ${attempt - 1} 次重试` : '初次'
    console.log(`[QG] 函数 ${functionName} ${label}语义检查失败:`, semCheck.issues)
    console.log(`[QG] 反馈内容:\n${feedback}`)
  }

  // 全部尝试失败：回退原始代码，记录失败清单
  const finalSigCheck = checkSingleFunctionSignature(
    originalFunctionCode,
    lastResult?.refactoredFunctionCode ?? originalFunctionCode,
    language,
    functionName
  )

  // 记录到失败清单
  FailureReportManager.addFailure({
    filePath,
    functionName,
    language,
    mode: 'function',
    timestamp: new Date().toISOString(),
    sigCheck: finalSigCheck,
    semCheck: finalSigCheck.pass ? lastSemCheck : null,
    attempts: MAX_ATTEMPTS
  })

  console.log(`[QG] 函数 ${functionName} ${MAX_ATTEMPTS} 次尝试（1 初次 + ${MAX_ATTEMPTS - 1} 重试）均失败，已回退为原始代码`)

  return {
    passed: false,
    refactoredFunctionCode: originalFunctionCode,
    updatedFileContent: currentFileContent, // 保持原样，不修改
    sigCheck: finalSigCheck,
    semCheck: finalSigCheck.pass ? lastSemCheck : null,
    attempt: MAX_ATTEMPTS
  }
}

// ---------------------------------------------------------------------------
// 文件重构 + 质量门编排（方案 B — 靶向修正）
// ---------------------------------------------------------------------------

/**
 * 带质量门的文件重构（方案 B：靶向修正）
 *
 * 流程：
 * 1. 全文件 LLM 重构（只调 1 次）
 * 2. 解析新旧函数列表，逐函数签名 + 语义检查
 * 3. 通过的 → 保留重构版本
 * 4. 失败的 → 函数级 LLM 修正（最多 3 次）
 * 5. 仍失败 → 回退为原始代码，记录失败清单
 * 6. 缝合所有函数回文件
 */
export async function runFileRefactorWithQG(params: {
  filePath: string
  language: string
  currentFileContent: string
  instruction?: string
  abortController?: AbortController
  callFileRefactorLLM: FileRefactorLLMCaller
  app: App
  originalFunctions?: Array<{ id: string; name: string; startByte: number; endByte: number; startLine: number; endLine: number }>
  callLLMForSemCheck?: SemanticCheckLLMCaller
  onProgress?: (msg: { functionName: string; attempt: number; maxAttempts: number; isRetry: boolean; stage: 'refactoring' | 'checking' | 'file-refactoring' }) => void
}): Promise<FileRefactorQGResult> {
  const {
    filePath,
    language,
    currentFileContent,
    instruction,
    abortController,
    callFileRefactorLLM,
    app,
    onProgress
  } = params

  const origBytes = Buffer.from(currentFileContent, 'utf8')

  // ---- 预先解析原始文件函数列表（全程复用） ----
  let origFunctions: ParsedFn[] = []
  try {
    const { parseFunctionsTreeSitter } = await import('./treeSitterFunctions')
    origFunctions = await parseFunctionsTreeSitter({ app, filePath, contentBytes: origBytes })
  } catch {
    console.log('[QG File] Tree-sitter 解析原始文件失败，使用启发式回退')
    origFunctions = parseFunctionsFallbackLocal(filePath, origBytes)
  }

  const origMap = buildFunctionOccurrenceMap(origFunctions)
  console.log(`[QG File] 原始文件解析到 ${origFunctions.length} 个函数:`, origFunctions.map(f => f.name))

  // 函数名清单注入 prompt
  const fnListHint =
    origFunctions.length > 0
      ? `\n\n⛔ The original file contains exactly these ${origFunctions.length} functions. Your output MUST contain ALL of them and NO others:\n${origFunctions.map((n, i) => `  ${i + 1}. ${n}()`).join('\n')}`
      : ''

  const MAX_ATTEMPTS = 4 // 1 次初次 + 3 次重试
  let lastRefactoredContent = ''
  let feedback = ''

  // ---- 主循环：全文件重构 + 全函数质检，任一失败即整文件重来 ----
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const isRetry = attempt > 1
    onProgress?.({ functionName: '全文件', attempt, maxAttempts: MAX_ATTEMPTS, isRetry, stage: 'file-refactoring' })

    // 组装全文件重构指令（含累积反馈）
    let fullInstruction = (instruction ?? '') + fnListHint
    if (feedback) {
      fullInstruction += '\n\n' + feedback
    }

    let refactoredContent: string
    try {
      const result = await callFileRefactorLLM({
        filePath,
        language,
        fileContent: currentFileContent,
        instruction: fullInstruction,
        abortController
      })
      refactoredContent = result.updatedFileContent
    } catch (e: unknown) {
      // 仅用户取消 / 超时时立即终止
      if (isAbortOrTimeout(e, abortController)) {
        return {
          updatedFileContent: currentFileContent,
          functionResults: [],
          failureCount: 0,
          passedCount: 0,
          attempt
        }
      }
      const errMsg = e instanceof Error ? e.message : String(e)
      console.log(`[QG File] 全文件 LLM 调用失败（${errMsg}），将在下一轮重试`)
      feedback = `\n\n[上一轮 LLM 调用失败: ${errMsg}，请重新生成]`
      continue
    }
    lastRefactoredContent = refactoredContent

    // 解析重构后文件
    const refactoredBytes = Buffer.from(refactoredContent, 'utf8')
    let refactoredFunctions: ParsedFn[] = []
    try {
      const { parseFunctionsTreeSitter } = await import('./treeSitterFunctions')
      refactoredFunctions = await parseFunctionsTreeSitter({ app, filePath, contentBytes: refactoredBytes })
    } catch {
      console.log('[QG File] Tree-sitter 解析重构文件失败，使用启发式回退')
      refactoredFunctions = parseFunctionsFallbackLocal(filePath, refactoredBytes)
    }
    const refactoredMap = buildFunctionOccurrenceMap(refactoredFunctions)
    console.log(`[QG File] 重构文件解析到 ${refactoredFunctions.length} 个函数:`, refactoredFunctions.map(f => f.name))

    // ---- 逐函数签名 + 语义检查 ----
    let allPassed = true
    const failedDetails: string[] = []
    const currentResults: PerFunctionQGResult[] = []

    for (const [key, origFn] of origMap) {
      onProgress?.({ functionName: origFn.name, attempt, maxAttempts: MAX_ATTEMPTS, isRetry, stage: 'checking' })

      const refactoredFn = refactoredMap.get(key)
      if (!refactoredFn) {
        allPassed = false
        failedDetails.push(
          `⛔ ${origFn.name}(): FUNCTION MISSING — the function was not found in the refactored output. You MUST include it.`
        )
        currentResults.push({
          functionId: origFn.id,
          functionName: origFn.name,
          passed: false,
          sigCheck: { pass: false, differences: [] },
          semCheck: null,
          attempt
        })
        continue
      }

      const origCode = origBytes.subarray(origFn.startByte, origFn.endByte).toString('utf8')
      const refactoredCode = refactoredBytes
        .subarray(refactoredFn.startByte, refactoredFn.endByte)
        .toString('utf8')

      // 签名检查
      const sigCheck = checkSingleFunctionSignature(origCode, refactoredCode, language, origFn.name)
      if (!sigCheck.pass) {
        allPassed = false
        const origSig = sigCheck.differences[0]?.originalSignature ?? origFn.name + '()'
        const refSig = sigCheck.differences[0]?.refactoredSignature ?? '(unknown)'
        failedDetails.push(
          `⛔ ${origFn.name}(): SIGNATURE MISMATCH — original: \`${origSig}\` → refactored: \`${refSig}\`. Keep the EXACT original signature.`
        )
        currentResults.push({
          functionId: origFn.id,
          functionName: origFn.name,
          passed: false,
          sigCheck,
          semCheck: null,
          attempt
        })
        continue
      }

      // 语义检查
      let semCheck: SemanticCheckResult
      try {
        semCheck = await checkSemanticConsistency({
          originalCode: origCode,
          refactoredCode,
          language,
          scope: 'function',
          abortController,
          callLLM: params.callLLMForSemCheck
        })
      } catch {
        semCheck = { equivalent: false, confidence: 'low', issues: ['语义检查调用失败'], suggestion: '' }
      }

      if (!semCheck.equivalent) {
        allPassed = false
        const issueList = semCheck.issues.map((s) => `    - ${s}`).join('\n')
        failedDetails.push(
          `⛔ ${origFn.name}(): SEMANTIC INEQUIVALENCE — confidence: ${semCheck.confidence}\n${issueList}${semCheck.suggestion ? `\n    Suggestion: ${semCheck.suggestion}` : ''}`
        )
      }

      currentResults.push({
        functionId: origFn.id,
        functionName: origFn.name,
        passed: semCheck.equivalent,
        sigCheck,
        semCheck,
        attempt
      })
    }

    // 检查重构后是否新增了函数
    for (const [key, refactoredFn] of refactoredMap) {
      if (!origMap.has(key)) {
        allPassed = false
        failedDetails.push(
          `⛔ ${refactoredFn.name}(): UNEXPECTED NEW FUNCTION — this function does not exist in the original file. Remove it.`
        )
      }
    }

    // 全部通过 → 直接返回
    if (allPassed) {
      console.log(`[QG File] 第 ${attempt} 次尝试全部通过（${origFunctions.length} 个函数）`)
      return {
        updatedFileContent: refactoredContent,
        functionResults: currentResults,
        failureCount: 0,
        passedCount: currentResults.filter(r => r.passed).length,
        attempt
      }
    }

    // 有失败 → 构建反馈，下轮重试
    feedback = buildFileLevelRetryFeedback(failedDetails, attempt, MAX_ATTEMPTS)
    console.log(`[QG File] 第 ${attempt} 次尝试有 ${failedDetails.length} 类问题，反馈:\n${feedback}`)
  }

  // ---- 全部尝试失败：整个文件回退原始代码 ----
  console.log(`[QG File] ${MAX_ATTEMPTS} 次全文件重构均未通过，整个文件回退为原始代码`)

  // 收集失败信息用于展示和记录
  const finalBytes = Buffer.from(lastRefactoredContent, 'utf8')
  let finalRefactoredFunctions: ParsedFn[] = []
  try {
    const { parseFunctionsTreeSitter } = await import('./treeSitterFunctions')
    finalRefactoredFunctions = await parseFunctionsTreeSitter({ app, filePath, contentBytes: finalBytes })
  } catch {
    finalRefactoredFunctions = parseFunctionsFallbackLocal(filePath, finalBytes)
  }
  const finalRefactoredMap = buildFunctionOccurrenceMap(finalRefactoredFunctions)

  const functionResults: PerFunctionQGResult[] = []

  for (const [key, origFn] of origMap) {
    const refactoredFn = finalRefactoredMap.get(key)
    const origCode = origBytes.subarray(origFn.startByte, origFn.endByte).toString('utf8')

    if (!refactoredFn) {
      functionResults.push({
        functionId: origFn.id, functionName: origFn.name, passed: false,
        sigCheck: { pass: false, differences: [] }, semCheck: null, attempt: MAX_ATTEMPTS
      })
      FailureReportManager.addFailure({
        filePath, functionName: origFn.name,
        language,
        mode: 'file',
        timestamp: new Date().toISOString(),
        sigCheck: { pass: false, differences: [{ functionName: origFn.name, originalSignature: origFn.name + '()', refactoredSignature: '(函数缺失)' }] },
        semCheck: null, attempts: MAX_ATTEMPTS
      })
      continue
    }

    const refactoredCode = finalBytes.subarray(refactoredFn.startByte, refactoredFn.endByte).toString('utf8')
    const sigCheck = checkSingleFunctionSignature(origCode, refactoredCode, language, origFn.name)

    if (sigCheck.pass) {
      let semCheck: SemanticCheckResult = { equivalent: true, confidence: 'low', issues: [], suggestion: '' }
      try {
        semCheck = await checkSemanticConsistency({
          originalCode: origCode, refactoredCode, language, scope: 'function', abortController,
          callLLM: params.callLLMForSemCheck
        })
      } catch { /* keep default */ }

      if (semCheck.equivalent) {
        // 虽然通过了质检，但整个文件回退
        functionResults.push({
          functionId: origFn.id, functionName: origFn.name, passed: true, sigCheck, semCheck, attempt: MAX_ATTEMPTS
        })
        continue
      }
    }

    functionResults.push({
      functionId: origFn.id, functionName: origFn.name, passed: false,
      sigCheck, semCheck: null, attempt: MAX_ATTEMPTS
    })
    FailureReportManager.addFailure({
      filePath, functionName: origFn.name,
      language,
      mode: 'file',
      timestamp: new Date().toISOString(),
      sigCheck: sigCheck.pass ? null : sigCheck,
      semCheck: sigCheck.pass ? { equivalent: false, confidence: 'low', issues: ['语义检查未通过'], suggestion: '' } : null,
      attempts: MAX_ATTEMPTS
    })
  }

  const failureCount = functionResults.filter((r) => !r.passed).length
  const passedCount = functionResults.filter((r) => r.passed).length

  // 返回原始文件内容，不做任何部分修补
  return { updatedFileContent: currentFileContent, functionResults, failureCount, passedCount, attempt: MAX_ATTEMPTS }
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

type ParsedFn = {
  id: string
  name: string
  startByte: number
  endByte: number
  startLine: number
  endLine: number
}

function buildFunctionOccurrenceMap(functions: ParsedFn[]): Map<string, ParsedFn> {
  const nameCounters = new Map<string, number>()
  const map = new Map<string, ParsedFn>()

  for (const fn of functions) {
    const occurrence = (nameCounters.get(fn.name) ?? 0) + 1
    nameCounters.set(fn.name, occurrence)
    map.set(`${fn.name}#${occurrence}`, fn)
  }

  return map
}

/**
 * 构建文件级重试反馈（汇总所有失败函数的审查信息）
 */
function buildFileLevelRetryFeedback(
  failedDetails: string[],
  attempt: number,
  maxAttempts: number
): string {
  const header = `\n\n[双一致性审查反馈 — 第 ${attempt}/${maxAttempts} 次尝试 — 以下函数未通过质检，请重新重构整个文件]\n`
  return header + failedDetails.join('\n\n')
}

/**
 * 判断异常是否由用户取消或超时引起。
 * 这类错误不应重试，应直接终止。
 */
function isAbortOrTimeout(e: unknown, abortController?: AbortController): boolean {
  if (abortController?.signal?.aborted) return true
  if (e instanceof Error) {
    const msg = e.message.toLowerCase()
    if (msg.includes('cancel') || msg.includes('abort') || msg.includes('timeout')) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// 文件重构 + 分析优先（方案 C — 智能分析后逐函数重构）
// ---------------------------------------------------------------------------

/**
 * 带质量门的文件重构（方案 C：先分析、再逐函数重构）
 *
 * 流程：
 * 1. 解析原始文件的函数列表
 * 2. 阶段 1 — 分析：发送整个文件给 LLM，判断哪些函数值得重构
 * 3. 阶段 2 — 逐函数重构：对分析出的每个函数调用 runFunctionRefactorWithQG
 * 4. 通过的 → 保留重构版本；失败的 → 保留原始代码
 * 5. 缝合所有结果返回
 */
export async function runFileRefactorWithAnalysis(params: {
  filePath: string
  language: string
  currentFileContent: string
  instruction?: string
  abortController?: AbortController
  callFunctionRefactorLLM: FunctionRefactorLLMCaller
  callFunctionAnalysisLLM: FunctionAnalysisLLMCaller
  app: App
  callLLMForSemCheck?: SemanticCheckLLMCaller
  onProgress?: (msg: { functionName: string; attempt: number; maxAttempts: number; isRetry: boolean; stage: 'refactoring' | 'checking' | 'analyzing' | 'file-refactoring' | 'analysis-done'; selectedCount?: number; totalCount?: number }) => void
}): Promise<FileRefactorQGResult> {
  const {
    filePath,
    language,
    currentFileContent,
    instruction,
    abortController,
    callFunctionRefactorLLM,
    callFunctionAnalysisLLM,
    app,
    onProgress
  } = params

  const origBytes = Buffer.from(currentFileContent, 'utf8')

  // ---- 解析原始文件函数列表 ----
  let origFunctions: ParsedFn[] = []
  try {
    const { parseFunctionsTreeSitter } = await import('./treeSitterFunctions')
    origFunctions = await parseFunctionsTreeSitter({ app, filePath, contentBytes: origBytes })
  } catch {
    console.log('[QG Analysis] Tree-sitter 解析原始文件失败，使用启发式回退')
    origFunctions = parseFunctionsFallbackLocal(filePath, origBytes)
  }

  if (origFunctions.length === 0) {
    console.log('[QG Analysis] 文件未解析到任何函数，跳过重构')
    return {
      updatedFileContent: currentFileContent,
      functionResults: [],
      failureCount: 0,
      passedCount: 0,
      attempt: 1
    }
  }

  console.log(`[QG Analysis] 原始文件解析到 ${origFunctions.length} 个函数:`, origFunctions.map(f => f.name))

  // ---- 阶段 1：分析哪些函数值得重构 ----
  onProgress?.({ functionName: '分析中', attempt: 1, maxAttempts: 1, isRetry: false, stage: 'analyzing' })

  let targetFunctionNames: Set<string>

  try {
    const analysisResult = await callFunctionAnalysisLLM({
      filePath,
      language,
      fileContent: currentFileContent,
      functions: origFunctions.map(f => ({ name: f.name, startLine: f.startLine, endLine: f.endLine })),
      instruction,
      abortController
    })

    if (analysisResult.functions.length === 0) {
      console.log('[QG Analysis] LLM 分析认为没有函数需要重构')
      onProgress?.({ functionName: '分析完成', attempt: 1, maxAttempts: 1, isRetry: false, stage: 'analysis-done', selectedCount: 0, totalCount: origFunctions.length })
      return {
        updatedFileContent: currentFileContent,
        functionResults: origFunctions.map(f => ({
          functionId: f.id,
          functionName: f.name,
          passed: true,
          sigCheck: null,
          semCheck: null,
          attempt: 0
        })),
        failureCount: 0,
        passedCount: origFunctions.length,
        attempt: 1
      }
    }

    targetFunctionNames = new Set(analysisResult.functions)
    console.log(`[QG Analysis] LLM 分析选中 ${targetFunctionNames.size} 个函数需要重构:`, [...targetFunctionNames])
    onProgress?.({ functionName: '分析完成', attempt: 1, maxAttempts: 1, isRetry: false, stage: 'analysis-done', selectedCount: targetFunctionNames.size, totalCount: origFunctions.length })
  } catch (e: unknown) {
    if (isAbortOrTimeout(e, abortController)) {
      return {
        updatedFileContent: currentFileContent,
        functionResults: [],
        failureCount: 0,
        passedCount: 0,
        attempt: 1
      }
    }
    // 分析失败 → 降级为重构所有函数
    console.log('[QG Analysis] LLM 分析失败，降级为重构所有函数:', e)
    targetFunctionNames = new Set(origFunctions.map(f => f.name))
    onProgress?.({ functionName: '分析完成', attempt: 1, maxAttempts: 1, isRetry: false, stage: 'analysis-done', selectedCount: targetFunctionNames.size, totalCount: origFunctions.length })
  }

  // ---- 阶段 2：逐函数重构 ----
  // 按文件中的顺序处理函数（保持字节偏移追踪的一致性）
  let currentContent = currentFileContent
  const functionResults: PerFunctionQGResult[] = []
  const nameOccurrenceMap = new Map<string, number>()

  for (const origFn of origFunctions) {
    const occurrence = (nameOccurrenceMap.get(origFn.name) ?? 0) + 1
    nameOccurrenceMap.set(origFn.name, occurrence)

    if (!targetFunctionNames.has(origFn.name)) {
      // 不在重构目标中，保留原始代码
      functionResults.push({
        functionId: origFn.id,
        functionName: origFn.name,
        passed: true,
        sigCheck: null,
        semCheck: null,
        attempt: 0
      })
      continue
    }

    // 在当前文件内容中定位该函数的最新位置
    const currentBytes = Buffer.from(currentContent, 'utf8')
    let currentFunctions: ParsedFn[]
    try {
      const { parseFunctionsTreeSitter } = await import('./treeSitterFunctions')
      currentFunctions = await parseFunctionsTreeSitter({ app, filePath, contentBytes: currentBytes })
    } catch {
      currentFunctions = parseFunctionsFallbackLocal(filePath, currentBytes)
    }

    const currentFn = findFunctionByOccurrence(currentFunctions, origFn.name, occurrence)
    if (!currentFn) {
      console.log(`[QG Analysis] 无法在当前位置找到函数 ${origFn.name}#${occurrence}，跳过`)
      functionResults.push({
        functionId: origFn.id,
        functionName: origFn.name,
        passed: false,
        sigCheck: { pass: false, differences: [{ functionName: origFn.name, originalSignature: origFn.name + '()', refactoredSignature: '(定位失败)' }] },
        semCheck: null,
        attempt: 0
      })
      FailureReportManager.addFailure({
        filePath,
        functionName: origFn.name,
        language,
        mode: 'file',
        timestamp: new Date().toISOString(),
        sigCheck: { pass: false, differences: [{ functionName: origFn.name, originalSignature: origFn.name + '()', refactoredSignature: '(定位失败)' }] },
        semCheck: null,
        attempts: 0
      })
      continue
    }

    // 对单个函数进行重构（复用已有的函数级重构+质量门）
    const result = await runFunctionRefactorWithQG({
      filePath,
      language,
      functionId: origFn.id,
      functionName: origFn.name,
      startByte: currentFn.startByte,
      endByte: currentFn.endByte,
      currentFileContent: currentContent,
      instruction,
      abortController,
      callFunctionRefactorLLM,
      callLLMForSemCheck: params.callLLMForSemCheck,
      onProgress: (msg) => {
        onProgress?.({
          ...msg,
          stage: msg.stage
        })
      }
    })

    if (result.passed) {
      // 通过：更新当前文件内容（后续函数将基于新内容定位）
      currentContent = result.updatedFileContent
    }

    functionResults.push({
      functionId: origFn.id,
      functionName: origFn.name,
      passed: result.passed,
      sigCheck: result.sigCheck,
      semCheck: result.semCheck,
      attempt: result.attempt
    })
  }

  const failureCount = functionResults.filter(r => !r.passed).length
  const passedCount = functionResults.filter(r => r.passed).length

  console.log(`[QG Analysis] 文件重构完成：${passedCount} 个通过，${failureCount} 个失败`)

  return {
    updatedFileContent: currentContent,
    functionResults,
    failureCount,
    passedCount,
    attempt: 1
  }
}

/**
 * 在函数列表中按名称 + 出现序号查找函数
 */
function findFunctionByOccurrence(
  functions: ParsedFn[],
  targetName: string,
  targetOccurrence: number
): ParsedFn | null {
  let currentOccurrence = 0
  for (const fn of functions) {
    if (fn.name !== targetName) continue
    currentOccurrence++
    if (currentOccurrence === targetOccurrence) {
      return fn
    }
  }
  return null
}
