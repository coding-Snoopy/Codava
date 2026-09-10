/**
 * 自动重构失败清单模块
 *
 * 管理重构质量门检查失败记录，支持：
 * - 新增失败记录
 * - 生成 Markdown 格式失败清单报告
 * - 保存报告到文件
 * - 清空记录
 */

import * as fs from 'fs/promises'
import type { SignatureCheckResult } from './signatureChecker'

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export type SemanticCheckResult = {
  equivalent: boolean
  confidence: string
  issues: string[]
  suggestion: string
}

export type RefactorMode = 'function' | 'file'

export type FailureRecord = {
  filePath: string
  functionName: string
  timestamp: string
  sigCheck: SignatureCheckResult | null
  semCheck: SemanticCheckResult | null
  attempts: number
  /** 重构模式：函数级重构 or 文件级重构 */
  mode: RefactorMode
  /** 源文件语言（用于报告中展示） */
  language: string
}

// ---------------------------------------------------------------------------
// FailureReportManager
// ---------------------------------------------------------------------------

class FailureReportManagerImpl {
  private failures: FailureRecord[] = []

  addFailure(record: FailureRecord): void {
    this.failures.push(record)
  }

  getFailures(): FailureRecord[] {
    return [...this.failures]
  }

  get failureCount(): number {
    return this.failures.length
  }

  clear(): void {
    this.failures = []
  }

  /**
   * 生成 Markdown 格式的失败清单报告。
   * 按函数重构 / 文件重构分组，各自一张表格。
   */
  generateReport(): string {
    if (this.failures.length === 0) {
      return '# 自动重构失败清单\n\n> 无失败记录，所有重构均通过双一致性审查。\n'
    }

    const now = new Date().toLocaleString('zh-CN', { hour12: false })
    const funcFailures = this.failures.filter((f) => f.mode === 'function')
    const fileFailures = this.failures.filter((f) => f.mode === 'file')

    // 文件重构按文件去重计数（一个文件里多个函数失败仍算 1 个文件失败）
    const fileCount = new Set(fileFailures.map((f) => f.filePath)).size
    const total = funcFailures.length + fileCount

    const lines: string[] = [
      '# 自动重构失败清单',
      '',
      `> 生成时间：${now} | 共 **${total}** 个失败（函数重构 ${funcFailures.length} + 文件重构 ${fileCount}）`,
      ''
    ]

    if (funcFailures.length > 0) {
      lines.push(...buildFailureTable('函数重构失败', funcFailures, 'function'))
    }

    if (fileFailures.length > 0) {
      lines.push(...buildFailureTable('文件重构失败', fileFailures, 'file'))
    }

    return lines.join('\n')
  }

  /**
   * 将失败记录写入报告文件（全量重写，保证格式一致）。
   */
  async appendToReportFile(outputPath: string): Promise<void> {
    if (this.failures.length === 0) return

    try {
      const fullReport = this.generateReport()
      await fs.writeFile(outputPath, fullReport, 'utf8')
    } catch {
      console.error(`[FailureReport] 无法写入报告文件: ${outputPath}`)
    }
  }
}

/** 全局单例 */
export const FailureReportManager = new FailureReportManagerImpl()

// ---------------------------------------------------------------------------
// 报告格式化辅助
// ---------------------------------------------------------------------------

const FUNC_TABLE_HEADER = '| 文件 | 函数 | 签名检查 | 语义检查 | 失败原因 |'
const FUNC_TABLE_SEP    = '|------|------|----------|----------|----------|'
const FILE_TABLE_HEADER = '| 文件 | 失败函数 | 失败原因 |'
const FILE_TABLE_SEP    = '|------|----------|----------|'

/**
 * 构建失败表格。函数模式按函数逐行；文件模式按文件逐行（合并同文件函数）。
 */
function buildFailureTable(title: string, failures: FailureRecord[], mode: RefactorMode): string[] {
  if (mode === 'file') {
    return buildFileModeTable(title, failures)
  }
  return buildFunctionModeTable(title, failures)
}

function buildFunctionModeTable(title: string, failures: FailureRecord[]): string[] {
  const lines: string[] = [
    `## ${title}（${failures.length} 个）`,
    '',
    FUNC_TABLE_HEADER,
    FUNC_TABLE_SEP
  ]
  for (const f of failures) {
    const fileName = f.filePath.replace(/\\/g, '/').split('/').pop() || f.filePath
    lines.push(buildFuncRow(fileName, f))
  }
  lines.push('')
  return lines
}

function buildFileModeTable(title: string, failures: FailureRecord[]): string[] {
  // 按文件分组
  const groups = groupByFile(failures)
  const lines: string[] = [
    `## ${title}（${groups.size} 个）`,
    '',
    FILE_TABLE_HEADER,
    FILE_TABLE_SEP
  ]
  for (const [filePath, records] of groups) {
    const fileName = filePath.replace(/\\/g, '/').split('/').pop() || filePath
    const fnNames = records.map((r) => `\`${r.functionName}\``).join('、')
    const reason = buildFileModeReason(records)
    lines.push(`| \`${fileName}\` | ${fnNames} | ${reason} |`)
  }
  lines.push('')
  return lines
}

function buildFuncRow(fileName: string, f: FailureRecord): string {
  const sig = f.sigCheck ? (f.sigCheck.pass ? '✓' : '✗') : '—'
  const sem = f.semCheck ? (f.semCheck.equivalent ? '✓' : '✗') : '—'
  return `| \`${fileName}\` | \`${f.functionName}\` | ${sig} | ${sem} | ${buildReasonText(f)} |`
}

/** 文件模式：汇总该文件所有失败原因 */
function buildFileModeReason(records: FailureRecord[]): string {
  const hasMissing = records.some((r) => {
    const diffs = r.sigCheck?.differences ?? []
    return diffs.length > 0 && diffs[0]?.refactoredSignature === '(missing)'
  })
  const hasSigMismatch = records.some((r) => r.sigCheck && !r.sigCheck.pass && !isMissing(r))
  const hasSemFail = records.some((r) => r.semCheck && !r.semCheck.equivalent)

  const parts: string[] = []
  if (hasMissing) parts.push('函数缺失')
  if (hasSigMismatch) parts.push('签名不匹配')
  if (hasSemFail) parts.push('语义不等价')
  const text = parts.length > 0 ? parts.join('、') : '未知'
  return text.replace(/\|/g, '\\|')
}

function isMissing(r: FailureRecord): boolean {
  const diffs = r.sigCheck?.differences ?? []
  return diffs.length > 0 && diffs[0]?.refactoredSignature === '(missing)'
}

function groupByFile(failures: FailureRecord[]): Map<string, FailureRecord[]> {
  const groups = new Map<string, FailureRecord[]>()
  for (const f of failures) {
    const list = groups.get(f.filePath)
    if (list) list.push(f)
    else groups.set(f.filePath, [f])
  }
  return groups
}

function buildReasonText(f: FailureRecord): string {
  const parts: string[] = []
  if (f.sigCheck && !f.sigCheck.pass) {
    const diffs = f.sigCheck.differences
    if (diffs.length > 0) {
      const d = diffs[0]
      if (d.originalSignature === 'present' && d.refactoredSignature === '(missing)') {
        parts.push('函数缺失')
      } else if (d.refactoredSignature === '(函数缺失)') {
        parts.push('函数缺失')
      } else {
        parts.push('签名不匹配')
      }
    } else {
      parts.push('签名不匹配')
    }
  }
  if (f.semCheck && !f.semCheck.equivalent) {
    const brief = f.semCheck.issues.slice(0, 2).join('; ')
    parts.push(`语义不等价: ${brief}`)
  }
  const text = parts.length > 0 ? parts.join(' | ') : '未知'
  // 转义表格特殊字符
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}
