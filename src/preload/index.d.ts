import { ElectronAPI } from '@electron-toolkit/preload'

export type FileTreeNode = {
  id: string
  label: string
  path: string
  kind: 'dir' | 'file'
  children?: FileTreeNode[]
}

export type ParsedFunction = {
  id: string
  name: string
  startByte: number
  endByte: number
  startLine: number
  endLine: number
}

export type RefactorCodeSnapshot = {
  code: string
  lineCount: number
  fileComplexity: number
  targetComplexity?: number
}

export type AppendRefactorHistoryInput = {
  sessionId: string
  sourceFilePath: string
  language: string
  scope: 'function' | 'file'
  modelName: string
  instruction: string
  target?: {
    functionName: string
    functionOccurrence: number
    startLineBefore: number
    endLineBefore: number
    startLineAfter?: number
    endLineAfter?: number
  }
  before: RefactorCodeSnapshot
  after: RefactorCodeSnapshot
}

// ============================================================
// 设置中心相关类型
// ============================================================

export type ModelConfigView = {
  id: string
  name: string
  baseUrl: string
  apiKey: string // 掩码后的密钥，如 "sk-****xxxx"
  timeoutMs: number
}

export type ModelConfigInput = {
  id?: string // 不传表示新增
  name: string
  baseUrl: string
  apiKey: string // 实际密钥或掩码值（掩码表示未修改）
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

export type AppSettingsView = {
  version: 1
  models: ModelConfigView[]
  activeModelId: string
  promptSchemes: PromptScheme[]
  activeSchemeId: string
}

// ============================================================
// 批量重构相关类型
// ============================================================

export type FunctionRefactorStatus = {
  name: string
  status: 'success' | 'failed' | 'skipped'
  error?: string
}

export type BatchFileReport = {
  file: string
  success: number
  failed: number
  skipped: number
}

// 批量重构进度事件。不同 phase 携带不同字段，故大部分字段可选。
export type BatchProgressEvent = {
  batchId: string
  phase:
    | 'backup-done'
    | 'batch-start'
    | 'file-start'
    | 'function-start'
    | 'function-done'
    | 'file-done'
    | 'file-error'
    | 'batch-cancelled'
    | 'batch-done'
    | 'file-refactor-done'
    | 'analysis-start'
    | 'analysis-done'
    | 'function-checking'
    | 'function-retry'
  backupDir?: string
  totalFiles?: number
  totalFunctions?: number
  file?: string
  fileIndex?: number
  functionCount?: number
  functionName?: string
  status?: 'success' | 'failed' | 'skipped'
  error?: string
  jsonPath?: string
  okCount?: number
  report?: unknown
  doneFunctions?: number
  overallPercent?: number
  etaMs?: number
  report?: BatchFileReport[]
  originalComplexity?: number
  refactoredComplexity?: number
  updatedFileContent?: string
  attempt?: number
  maxAttempts?: number
  selectedCount?: number
  totalCount?: number
}

// 打开文件的统一分析结果：一次解析同时产出函数列表与圈复杂度
export type FileAnalysisResult = {
  functions: ParsedFunction[]
  functionComplexities: Record<string, number>
  fileComplexity: number
}

// ============================================================
// 代码扫描审计相关类型
// ============================================================

export type CodeAuditSeverity = 'low' | 'medium' | 'high' | 'critical'

// ============================================================
// 质量门相关类型
// ============================================================

export type SignatureDiff = {
  functionName: string
  originalSignature: string
  refactoredSignature: string
}

export type SignatureCheckResult = {
  pass: boolean
  differences: SignatureDiff[]
}

export type SemanticCheckResult = {
  equivalent: boolean
  confidence: string
  issues: string[]
  suggestion: string
}

export type QualityGateResult = {
  sigCheck: SignatureCheckResult | null
  semCheck: SemanticCheckResult | null
  attempt: number
  passed: boolean
  reportPath?: string | null
}

export type PerFunctionResult = {
  functionId: string
  functionName: string
  passed: boolean
  sigCheck: SignatureCheckResult | null
  semCheck: SemanticCheckResult | null
  attempt: number
}

export type VulnerabilityFinding = {
  vulnerabilityType: string
  cause: string
  potentialHarm: string
  fixSuggestion: string
  severity: CodeAuditSeverity
  vulLineStart: number
  vulLineEnd: number
  vulLineRange: string
}

export type SafeCodeAnalysis = {
  codeFunction: string
  securityAssessment: string
  potentialRisks: string
  improvementSuggestions: string
}

export type FunctionAuditEntry = {
  functionName: string
  startLine: number
  endLine: number
  overallRisk: CodeAuditSeverity
  hasVulnerabilities: boolean
  vulnerabilities?: VulnerabilityFinding[]
  safeCodeAnalysis?: SafeCodeAnalysis
}

export type CodeAuditReport = {
  filePath: string
  scope: 'original' | 'refactored'
  language: string
  model: string
  scanCoverage: string
  summary: string
  generatedAt: string
  functionResults: FunctionAuditEntry[]
}

export type PreloadApi = {
  appQuit: () => Promise<void>
  getAppInfo: () => Promise<{
    name: string
    version: string
    platform: string
    electron: string
    chrome: string
    node: string
  }>
  selectDirectory: () => Promise<string | null>
  buildFileTree: (rootDir: string) => Promise<FileTreeNode>
  readFile: (filePath: string) => Promise<{ content: string }>
  writeFile: (filePath: string, content: string) => Promise<{ ok: true }>
  saveJsonFile: (params: { defaultFileName: string; jsonText: string; title?: string }) => Promise<{
    ok: boolean
    canceled: boolean
    filePath?: string
  }>
  appendRefactorHistory: (
    input: AppendRefactorHistoryInput
  ) => Promise<{ recordId: string; historyPath: string }>
  markRefactorHistoryApplied: (
    sourceFilePath: string,
    sessionId: string
  ) => Promise<{ updatedCount: number; historyPath: string }>
  parseFunctions: (filePath: string, content?: string) => Promise<{ functions: ParsedFunction[] }>
  analyzeFile: (filePath: string, language: string, content?: string) => Promise<FileAnalysisResult>
  calculateComplexity: (filePath: string, content: string, language: string) => Promise<{
    fileComplexity: number
    functionComplexities: Record<string, number>
  }>
  auditFile: (params: {
    filePath: string
    language: string
    fileContent: string
    scope: 'original' | 'refactored'
    requestId?: string
  }) => Promise<{ report: CodeAuditReport }>
  refactorFunction: (params: {
    requestId?: string
    filePath: string
    language: string
    functionId: string
    startByte: number
    endByte: number
    functionName: string
    currentFileContent: string
    instruction?: string
  }) => Promise<{
    refactoredFunctionCode: string
    updatedFileContent: string
    refactoredComplexity: number
    qualityGate?: QualityGateResult
  }>
  refactorFile: (params: {
    requestId?: string
    filePath: string
    language: string
    currentFileContent: string
    instruction?: string
  }) => Promise<{
    updatedFileContent: string
    summary?: string
    perFunctionStatus?: FunctionRefactorStatus[]
    originalComplexity?: number
    refactoredComplexity?: number
    qualityGate?: {
      functionResults: PerFunctionResult[]
      failureCount: number
      passedCount: number
      attempt: number
      reportPath?: string | null
    }
  }>
  refactorBatch: (params: {
    batchId: string
    rootDir: string
    files: string[]
    instruction?: string
  }) => Promise<{ ok: boolean; report: BatchFileReport[] }>
  auditBatch: (params: {
    batchId: string
    rootDir: string
    files: string[]
  }) => Promise<{ ok: boolean; report: Array<{ file: string; status: 'ok' | 'failed'; jsonPath?: string; error?: string }> }>
  cancelBatch: (batchId: string) => Promise<{ ok: boolean }>
  onBatchProgress: (cb: (data: BatchProgressEvent) => void) => () => void
  onAuditBatchProgress: (cb: (data: BatchProgressEvent) => void) => () => void
  cancelRefactor: (requestId: string) => Promise<{ ok: boolean; found: boolean }>
  onQGProgress: (
    cb: (msg: { functionName: string; attempt: number; maxAttempts: number; isRetry: boolean; stage: 'refactoring' | 'checking' | 'analyzing' | 'file-refactoring' | 'analysis-done'; selectedCount?: number; totalCount?: number }) => void
  ) => () => void
  windowMinimize: () => Promise<void>
  windowToggleMaximize: () => Promise<void>
  windowIsMaximized: () => Promise<boolean>
  windowClose: () => Promise<void>

  // 设置中心 API
  settingsLoad: () => Promise<AppSettingsView>
  settingsSaveModel: (m: ModelConfigInput) => Promise<{ ok: boolean; error?: string }>
  settingsDeleteModel: (id: string) => Promise<{ ok: boolean; error?: string }>
  settingsSetActiveModel: (id: string) => Promise<{ ok: boolean }>
  settingsSaveScheme: (s: PromptScheme) => Promise<{ ok: boolean; error?: string }>
  settingsDeleteScheme: (id: string) => Promise<{ ok: boolean; error?: string }>
  settingsSetActiveScheme: (id: string) => Promise<{ ok: boolean }>
  settingsExport: () => Promise<{ ok: boolean; canceled?: boolean; error?: string }>
  settingsImport: () => Promise<{ ok: boolean; canceled?: boolean; error?: string }>
  settingsTestModel: (m: ModelConfigInput) => Promise<{ ok: boolean; message: string }>
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: PreloadApi
  }
}
