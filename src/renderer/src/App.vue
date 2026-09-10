<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Splitpanes, Pane } from 'splitpanes'
import 'splitpanes/dist/splitpanes.css'
import MonacoDiff from './components/MonacoDiff.vue'
import RefactorHistoryViewer from './components/RefactorHistoryViewer.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import type { ModelConfigView, BatchProgressEvent, PromptScheme } from '../../preload/index.d'

import appIconUrl from '../../../resources/icon.png?url'

type FileTreeNode = {
  id: string
  label: string
  path: string
  kind: 'dir' | 'file'
  children?: FileTreeNode[]
}

type ParsedFunction = {
  id: string
  name: string
  startByte: number
  endByte: number
  startLine: number
  endLine: number
}

type FunctionWithComplexity = ParsedFunction & {
  originalComplexity?: number
  refactoredComplexity?: number
}

type AuditScope = 'original' | 'refactored'

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
  scope: AuditScope
  language: string
  model: string
  scanCoverage: string
  summary: string
  generatedAt: string
  functionResults: FunctionAuditEntry[]
}

const rootDir = ref<string | null>(null)
const tree = ref<FileTreeNode | null>(null)

const rootDirName = computed(() => {
  if (!rootDir.value) return ''
  const parts = rootDir.value.split(/[/\\]+/).filter(Boolean)
  return parts[parts.length - 1] || rootDir.value
})

const selectedFilePath = ref<string | null>(null)
const originalContent = ref<string>('')
const modifiedContent = ref<string>('')
const historySessionId = ref<string>('')

function isRefactorHistoryFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase()
  return normalized.includes('/.aosp-refactor/history/') && normalized.endsWith('.json')
}

const isViewingHistoryFile = computed(() =>
  selectedFilePath.value ? isRefactorHistoryFile(selectedFilePath.value) : false
)
const isSelectedSourceFile = computed(() =>
  selectedFilePath.value ? isSupportedSourceFile(selectedFilePath.value) : false
)

const functionsList = ref<FunctionWithComplexity[]>([])
const selectedFunctionId = ref<string | null>(null)
const refactorPreviewContent = ref<string>('')
const revealLine = ref<number | null>(null)
const revealNonce = ref<number>(0)

// 圈复杂度相关状态
const originalFileComplexity = ref<number | null>(null)
const refactoredFileComplexity = ref<number | null>(null)
const functionComplexityMap = ref<Record<string, { original?: number; refactored?: number }>>({})

// 模型选择相关状态（动态从设置中心加载）
const selectedModelId = ref<string>('')
const availableModels = ref<ModelConfigView[]>([])
const activePromptScheme = ref<PromptScheme | null>(null)
const settingsDialogVisible = ref(false)

const selectedModelUrl = computed(() => {
  const m = availableModels.value.find((m) => m.id === selectedModelId.value)
  return m?.baseUrl ?? ''
})
const selectedModelName = computed(
  () =>
    availableModels.value.find((model) => model.id === selectedModelId.value)?.name ?? '未配置模型'
)

// 从设置中心加载模型列表
async function loadModelSettings(): Promise<void> {
  try {
    const s = await window.api.settingsLoad()
    availableModels.value = s.models
    selectedModelId.value = s.activeModelId
    activePromptScheme.value =
      s.promptSchemes.find((scheme) => scheme.id === s.activeSchemeId) ?? null
  } catch (e) {
    ElMessage.error('加载模型配置失败：' + (e instanceof Error ? e.message : String(e)))
  }
}

// 初始化：加载设置中心的模型配置
onMounted(async () => {
  await loadModelSettings()
})

// 监听模型选择变化，同步到主进程
watch(selectedModelId, async (newId) => {
  if (!newId) return
  try {
    await window.api.settingsSetActiveModel(newId)
  } catch (e) {
    ElMessage.error('切换模型失败：' + (e instanceof Error ? e.message : String(e)))
  }
})

function openSettings(): void {
  settingsDialogVisible.value = true
}

function onSettingsSaved(): void {
  void loadModelSettings()
}

type BusyKind = 'functionRefactor' | 'fileRefactor' | 'fileAudit' | 'write' | null
const busyKind = ref<BusyKind>(null)
const busyText = ref<string>('')
const isBusy = computed(() => busyKind.value !== null)

const isMaximized = ref(false)

type MenuKey = 'file' | 'edit' | 'view' | 'help'
const openMenuKey = ref<MenuKey | null>(null)
const activeEditorTab = ref<'diff' | 'audit'>('diff')
const menuAnchorRect = ref<{ left: number; top: number; bottom: number } | null>(null)
const menubarEl = ref<HTMLElement | null>(null)
const menuPanelEl = ref<HTMLElement | null>(null)

// 工作台布局的纯 UI 显隐状态：只控制面板可见性与折叠态，不参与任何业务判断
const sidebarVisible = ref(true)
const inspectorVisible = ref(true)
type InspectorSectionKey = 'complexity' | 'risk' | 'model'
const inspectorCollapsed = ref<Record<InspectorSectionKey, boolean>>({
  complexity: false,
  risk: false,
  // 模型属于低频配置，默认折叠把常显空间让给风险统计
  model: true
})

function toggleInspectorSection(key: InspectorSectionKey): void {
  inspectorCollapsed.value[key] = !inspectorCollapsed.value[key]
}

const diffRightReadOnly = ref(true)

const activeRefactorRequestId = ref<string | null>(null)
const cancelRequested = ref(false)

// ---- 双一致性质检相关状态 ----
type QGSigCheck = { pass: boolean; differences: Array<{ functionName: string; originalSignature: string; refactoredSignature: string }> }
type QGSemCheck = { equivalent: boolean; confidence: string; issues: string[]; suggestion: string }
type QGResult = { sigCheck: QGSigCheck | null; semCheck: QGSemCheck | null; attempt: number; passed: boolean; reportPath?: string | null }
type PerFnResult = { functionId: string; functionName: string; passed: boolean; sigCheck: QGSigCheck | null; semCheck: QGSemCheck | null; attempt: number }
type FileQGResult = { functionResults: PerFnResult[]; failureCount: number; passedCount: number; attempt: number; reportPath?: string | null }

const lastQGResult = ref<QGResult | null>(null)
const lastFileQGResult = ref<FileQGResult | null>(null)
const qgProgressMsg = ref<string>('')

// ============================================================
// 批量重构状态
// ============================================================
type BatchLogLevel = 'info' | 'success' | 'failed' | 'skipped'
type BatchLogItem = { id: number; text: string; level: BatchLogLevel }

// 重构模式：函数重构 / 文件重构 / 批量重构
type RefactorMode = 'function' | 'file' | 'batch' | 'audit' | null
const refactorMode = ref<RefactorMode>(null)

const batchVisible = ref(false) // 进度浮层是否显示
const batchRunning = ref(false) // 重构任务是否进行中
const batchId = ref<string>('')
// 单文件扫描（重构前后双版本并行）的 requestId 集合：用于进度归属与统一取消
const activeAuditRequestIds = ref<string[]>([])
// requestId → 扫描范围 / 剩余时间，仅用于日志前缀与双版本 ETA 取较长者
const auditScopeByRequestId = new Map<string, AuditScope>()
const auditEtaByRequestId = new Map<string, number>()
// 双版本并行取消时会收到两条 batch-cancelled，只记一次日志
let auditCancelledLogged = false
const batchOverallPercent = ref(0)
const batchCurrentFile = ref('')
const batchFileIndex = ref(0)
const batchTotalFiles = ref(0)
const batchCurrentFunction = ref('')
const batchDoneFunctions = ref(0)
const batchTotalFunctions = ref(0)
const batchEtaMs = ref(0)
const batchLogs = ref<BatchLogItem[]>([])
const batchLogEl = ref<HTMLElement | null>(null)
let batchLogSeq = 0
let unsubscribeBatchProgress: (() => void) | null = null
let unsubscribeAuditBatchProgress: (() => void) | null = null

// 圈复杂度变化信息（浮窗中展示）
const panelComplexity = ref<{
  original: number | null
  refactored: number | null
  label: string
}>({ original: null, refactored: null, label: '' })

// 函数重构计时
let refactorStartMs = 0

// 进度浮层是否可取消（统一取消逻辑）
const canCancelPanel = computed(() => {
  if (!batchRunning.value) return false
  if (cancelRequested.value) return false
  return true
})

// 是否有任何重构任务在进行（用于禁用按钮）
const isRefactorBusy = computed(() => batchRunning.value || busyKind.value === 'write')

// 批量扫描进行中（与单文件扫描共用 refactorMode='audit'，靠 requestId 集合区分按钮 loading 归属）
const batchAuditRunning = computed(
  () =>
    batchRunning.value &&
    refactorMode.value === 'audit' &&
    activeAuditRequestIds.value.length === 0
)

// 底部状态栏：“Show All…”展开详细日志面板的开关
const batchDetailExpanded = ref(false)

// 状态栏左侧文本：“正在重构的文件名/函数名”
const batchStatusText = computed(() => {
  const file = shortenPath(batchCurrentFile.value)
  const fn = batchCurrentFunction.value
  if (refactorMode.value === 'audit') {
    const counter =
      batchTotalFunctions.value > 0
        ? ` ${batchDoneFunctions.value}/${batchTotalFunctions.value}`
        : ''
    if (file && fn) return `${file} · ${fn}${counter}`
    if (file) return `${file}${counter}`
    if (fn) return `${fn}${counter}`
    return batchRunning.value ? '正在准备扫描…' : '扫描完成'
  }
  if (file && fn) return `${file}/${fn}`
  if (file) return file
  if (fn) return fn
  return batchRunning.value ? '正在准备…' : '重构完成'
})

const batchEtaText = computed(() => {
  if (!batchRunning.value || batchEtaMs.value <= 0) return '—'
  const totalSec = Math.round(batchEtaMs.value / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`
})

function shortenPath(p?: string): string {
  if (!p) return ''
  const parts = p.split(/[/\\]+/).filter(Boolean)
  return parts.slice(-2).join('/')
}

async function refreshIsMaximized(): Promise<void> {
  try {
    isMaximized.value = await window.api.windowIsMaximized()
  } catch {
    // 忽略：某些平台/异常情况下主进程 IPC 可能暂时不可用，不影响主流程
  }
}

async function onClickMinimize(): Promise<void> {
  await window.api.windowMinimize()
}

async function onClickToggleMaximize(): Promise<void> {
  await window.api.windowToggleMaximize()
  await refreshIsMaximized()
}

async function onClickClose(): Promise<void> {
  await window.api.windowClose()
}

function closeMenu(): void {
  openMenuKey.value = null
  menuAnchorRect.value = null
}

function openMenu(key: MenuKey, targetEl: HTMLElement): void {
  const rect = targetEl.getBoundingClientRect()
  openMenuKey.value = key
  menuAnchorRect.value = { left: rect.left, top: rect.top, bottom: rect.bottom }
}

function toggleMenu(key: MenuKey, evt: MouseEvent): void {
  const el = evt.currentTarget as HTMLElement | null
  if (!el) return
  if (openMenuKey.value === key) {
    closeMenu()
    return
  }
  openMenu(key, el)
}

async function onMenuOpenDirectory(): Promise<void> {
  closeMenu()
  if (isBusy.value) {
    ElMessage.info('正在处理中，请稍候…')
    return
  }
  await openDirectory()
}

async function onMenuExit(): Promise<void> {
  closeMenu()
  await window.api.appQuit()
}

function onMenuToggleReadOnly(): void {
  if (isViewingHistoryFile.value) {
    ElMessage.info('重构历史记录始终以只读方式打开')
    closeMenu()
    return
  }
  diffRightReadOnly.value = !diffRightReadOnly.value
  closeMenu()
}

async function onMenuAbout(): Promise<void> {
  closeMenu()
  const info = await window.api.getAppInfo()
  await ElMessageBox.alert(
    `应用：${info.name}\n版本：${info.version}\n平台：${info.platform}\nElectron：${info.electron}\nChromium：${info.chrome}\nNode：${info.node}`,
    '关于',
    { confirmButtonText: '确定' }
  )
}

function installMenuGlobalListeners(): () => void {
  function onMouseDown(ev: MouseEvent): void {
    if (!openMenuKey.value) return
    const t = ev.target as Node | null
    if (!t) return
    if (menubarEl.value?.contains(t)) return
    if (menuPanelEl.value?.contains(t)) return
    closeMenu()
  }

  function onKeyDown(ev: KeyboardEvent): void {
    if (ev.key === 'Escape' && openMenuKey.value) {
      ev.preventDefault()
      closeMenu()
    }
  }

  window.addEventListener('mousedown', onMouseDown, true)
  window.addEventListener('keydown', onKeyDown)
  return () => {
    window.removeEventListener('mousedown', onMouseDown, true)
    window.removeEventListener('keydown', onKeyDown)
  }
}

let uninstallMenuListeners: null | (() => void) = null

async function runBusy<T>(
  kind: Exclude<BusyKind, null>,
  text: string,
  task: () => Promise<T>
): Promise<T | null> {
  // 统一的“忙碌态”包装：
  // - 防止重复点击触发并发操作
  // - 让右下区域展示 loading 文案
  if (isBusy.value) {
    ElMessage.info('正在处理中，请稍候…')
    return null
  }

  busyKind.value = kind
  busyText.value = text
  try {
    return await task()
  } finally {
    busyKind.value = null
    busyText.value = ''
  }
}

function createRequestId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function countLines(code: string): number {
  if (code.length === 0) return 0
  return code.split(/\r\n|\r|\n/).length
}

function getHistoryInstruction(scope: 'function' | 'file'): string {
  const scheme = activePromptScheme.value
  if (!scheme) return '未配置 Prompt 方案'
  return scope === 'function' ? scheme.templates.functionUser : scheme.templates.fileUser
}

async function saveRefactorHistory(
  input: Parameters<typeof window.api.appendRefactorHistory>[0]
): Promise<boolean> {
  try {
    await window.api.appendRefactorHistory(input)
    if (rootDir.value) {
      try {
        tree.value = await window.api.buildFileTree(rootDir.value)
      } catch (error) {
        console.warn('重构历史已保存，但刷新项目树失败:', error)
      }
    }
    return true
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    ElMessage.warning(`重构完成，但历史记录保存失败：${message}`)
    return false
  }
}

const language = computed(() => {
  const p = selectedFilePath.value || ''
  const lower = p.toLowerCase()
  if (lower.endsWith('.json')) return 'json'
  if (lower.endsWith('.java')) return 'java'
  if (lower.endsWith('.c')) return 'cpp'
  if (
    lower.endsWith('.cc') ||
    lower.endsWith('.cpp') ||
    lower.endsWith('.cxx') ||
    lower.endsWith('.h') ||
    lower.endsWith('.hpp')
  )
    return 'cpp'
  return 'plaintext'
})

const selectedFunction = computed(
  () => functionsList.value.find((f) => f.id === selectedFunctionId.value) || null
)

const hasRefactoredFileComplexity = computed(() => refactoredFileComplexity.value != null)

const hasRefactoredContent = computed(() => originalContent.value !== modifiedContent.value)

const originalAuditReport = ref<CodeAuditReport | null>(null)
const refactoredAuditReport = ref<CodeAuditReport | null>(null)

const hasOriginalAuditReport = computed(() => originalAuditReport.value != null)
const hasRefactoredAuditReport = computed(() => refactoredAuditReport.value != null)

const auditColumns = computed(() => {
  const cols: Array<{ scope: AuditScope; label: string; report: CodeAuditReport }> = []
  if (hasOriginalAuditReport.value) {
    cols.push({
      scope: 'original',
      label: hasRefactoredAuditReport.value ? '重构前扫描结果' : '扫描结果',
      report: originalAuditReport.value!
    })
  }
  if (hasRefactoredAuditReport.value) {
    cols.push({
      scope: 'refactored',
      label: hasOriginalAuditReport.value ? '重构后扫描结果' : '扫描结果',
      report: refactoredAuditReport.value!
    })
  }
  return cols
})

function deriveOverallRisk(report: CodeAuditReport): CodeAuditSeverity {
  const rank: Record<CodeAuditSeverity, number> = { low: 1, medium: 2, high: 3, critical: 4 }
  let highest: CodeAuditSeverity = 'low'
  for (const entry of report.functionResults) {
    if (rank[entry.overallRisk] > rank[highest]) {
      highest = entry.overallRisk
    }
  }
  return highest
}

function deriveHasVulnerabilities(report: CodeAuditReport): boolean {
  return report.functionResults.some((entry) => entry.hasVulnerabilities)
}

type VulStats = {
  critical: number
  high: number
  medium: number
  low: number
  safe: number
  total: number
}

function computeVulStats(report: CodeAuditReport | null): VulStats {
  const stats: VulStats = { critical: 0, high: 0, medium: 0, low: 0, safe: 0, total: 0 }
  if (!report) return stats
  for (const entry of report.functionResults) {
    if (entry.hasVulnerabilities && entry.vulnerabilities?.length) {
      // 按每个漏洞单独统计
      for (const vul of entry.vulnerabilities) {
        const sev = vul.severity
        if (sev === 'critical') stats.critical++
        else if (sev === 'high') stats.high++
        else if (sev === 'medium') stats.medium++
        else stats.low++
        stats.total++
      }
    } else {
      // 无漏洞函数计为"安全"
      stats.safe++
      stats.total++
    }
  }
  return stats
}

function buildPieGradient(stats: VulStats): string {
  if (stats.total === 0) return '#c0c4cc'
  const colors: Record<string, string> = {
    critical: '#F56C6C',
    high: '#E6A23C',
    medium: '#E6CD5B',
    low: '#67C23A',
    safe: '#409EFF'
  }
  const order = ['critical', 'high', 'medium', 'low', 'safe'] as const
  let cumulative = 0
  const segments: string[] = []
  for (const key of order) {
    const count = stats[key]
    if (count > 0) {
      const pct = (count / stats.total) * 100
      segments.push(`${colors[key]} ${cumulative}% ${cumulative + pct}%`)
      cumulative += pct
    }
  }
  return segments.length > 0 ? `conic-gradient(${segments.join(', ')})` : '#c0c4cc'
}

function getVulCount(stats: VulStats, key: keyof Omit<VulStats, 'total'>): number {
  return stats[key]
}

const originalVulStats = computed(() => computeVulStats(originalAuditReport.value))
const refactoredVulStats = computed(() => computeVulStats(refactoredAuditReport.value))

function getNameOccurrenceKey(name: string, occurrence: number): string {
  return `${name}#${occurrence}`
}

function getFunctionOccurrenceIndexById(
  functions: Array<Pick<ParsedFunction, 'id' | 'name'>>,
  targetId: string
): number | null {
  const nameCounters = new Map<string, number>()
  for (const fn of functions) {
    const occurrence = (nameCounters.get(fn.name) ?? 0) + 1
    nameCounters.set(fn.name, occurrence)
    if (fn.id === targetId) return occurrence
  }
  return null
}

function buildComplexityMapByNameOccurrence(
  functions: FunctionWithComplexity[]
): Map<string, { original?: number; refactored?: number }> {
  const nameCounters = new Map<string, number>()
  const map = new Map<string, { original?: number; refactored?: number }>()

  for (const fn of functions) {
    const occurrence = (nameCounters.get(fn.name) ?? 0) + 1
    nameCounters.set(fn.name, occurrence)
    map.set(getNameOccurrenceKey(fn.name, occurrence), {
      original: fn.originalComplexity,
      refactored: fn.refactoredComplexity
    })
  }

  return map
}

function mapFunctionsWithComplexityByNameOccurrence(
  parsedFunctions: ParsedFunction[],
  complexityMap: Map<string, { original?: number; refactored?: number }>
): FunctionWithComplexity[] {
  const nameCounters = new Map<string, number>()

  return parsedFunctions.map((f) => {
    const occurrence = (nameCounters.get(f.name) ?? 0) + 1
    nameCounters.set(f.name, occurrence)
    const key = getNameOccurrenceKey(f.name, occurrence)
    const c = complexityMap.get(key)
    return {
      ...f,
      originalComplexity: c?.original,
      refactoredComplexity: c?.refactored
    }
  })
}

function findFunctionIdByNameAndOccurrence(
  functions: ParsedFunction[],
  name: string,
  occurrence: number | null
): string | null {
  if (!occurrence) return null

  let currentOccurrence = 0
  for (const fn of functions) {
    if (fn.name !== name) continue
    currentOccurrence += 1
    if (currentOccurrence === occurrence) {
      return fn.id
    }
  }

  return null
}

function requestReveal(line: number): void {
  revealLine.value = line
  revealNonce.value++
}

async function calculateAndStoreComplexity(
  content: string,
  isRefactored: boolean = false,
  refactoredFunctionId?: string,
  precomputed?: { fileComplexity: number; functionComplexities: Record<string, number> }
): Promise<void> {
  if (!selectedFilePath.value) return

  try {
    // 优先复用调用方已获取的单次解析结果（避免重复解析）；
    // 否则用 analyzeFile 单次解析同时得到文件与各函数复杂度（替代旧的 parse+复杂度两次解析）
    const result =
      precomputed ?? (await window.api.analyzeFile(selectedFilePath.value, language.value, content))

    if (isRefactored) {
      refactoredFileComplexity.value = result.fileComplexity
      for (const fn of functionsList.value) {
        const existing = functionComplexityMap.value[fn.id] || {}
        const shouldSetRefactored = !refactoredFunctionId || fn.id === refactoredFunctionId
        functionComplexityMap.value[fn.id] = {
          ...existing,
          refactored: shouldSetRefactored ? result.functionComplexities[fn.id] : existing.refactored
        }
        if (shouldSetRefactored) {
          fn.refactoredComplexity = result.functionComplexities[fn.id]
        }
      }
    } else {
      originalFileComplexity.value = result.fileComplexity
      functionComplexityMap.value = {}
      for (const fn of functionsList.value) {
        const existing = functionComplexityMap.value[fn.id] || {}
        functionComplexityMap.value[fn.id] = {
          ...existing,
          original: result.functionComplexities[fn.id]
        }
        fn.originalComplexity = result.functionComplexities[fn.id]
      }
    }
  } catch (e) {
    ElMessage.error('计算圈复杂度失败：' + (e instanceof Error ? e.message : String(e)))
  }
}

// 审计结果 DOM 引用，用于点击函数列表后跳转到对应的扫描结果
const auditEntryRefMap = new Map<string, HTMLElement>()

function handleAuditEntryRef(el: unknown, scope: string, functionName: string, startLine: number): void {
  const key = `${scope}:${functionName}:${startLine}`
  if (el) {
    auditEntryRefMap.set(key, el as HTMLElement)
  } else {
    auditEntryRefMap.delete(key)
  }
}

function onFunctionRowClick(row: ParsedFunction): void {
  selectedFunctionId.value = row.id
  requestReveal(row.startLine)

  // 如果在扫描结果标签页，跳转到对应函数的审计结果
  if (activeEditorTab.value === 'audit') {
    const scopes: AuditScope[] = ['original', 'refactored']
    for (const scope of scopes) {
      const key = `${scope}:${row.name}:${row.startLine}`
      const el = auditEntryRefMap.get(key)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        // 高亮闪烁提示
        const prevBg = (el as HTMLElement).style.background
        ;(el as HTMLElement).style.transition = 'background 0.3s'
        ;(el as HTMLElement).style.background = 'rgba(64, 158, 255, 0.15)'
        setTimeout(() => {
          ;(el as HTMLElement).style.background = prevBg
        }, 1500)
        break
      }
    }
  }
}

function functionRowClassName(params: { row: ParsedFunction }): string {
  return params.row.id === selectedFunctionId.value ? 'is-selected' : ''
}

function getComplexityClass(complexity: number | undefined): string {
  if (complexity === undefined || complexity === null) return ''
  if (complexity <= 5) return 'complexity-low'
  if (complexity <= 10) return 'complexity-medium'
  return 'complexity-high'
}

function getDeltaClass(delta: number): string {
  if (delta > 0) return 'delta-positive'
  if (delta < 0) return 'delta-negative'
  return 'delta-zero'
}

function resetAuditReports(): void {
  originalAuditReport.value = null
  refactoredAuditReport.value = null
}

function getAuditReportByScope(scope: AuditScope): CodeAuditReport | null {
  return scope === 'original' ? originalAuditReport.value : refactoredAuditReport.value
}

function getAuditScopeLabel(scope: AuditScope): string {
  return scope === 'original' ? '重构前' : '重构后'
}

function getAuditExportFileName(scope: AuditScope): string {
  const fileStem = selectedFilePath.value
    ? selectedFilePath.value.split(/[/\\]+/).pop()?.replace(/\.[^.]+$/, '') || 'audit-report'
    : 'audit-report'
  return `${fileStem}.${scope}.audit.json`
}

// 单文件扫描复用批量任务的进度通道与底部日志面板，保持与重构流程一致的体验
function beginAuditProgress(): void {
  if (!selectedFilePath.value) return
  refactorMode.value = 'audit'
  batchId.value = ''
  activeAuditRequestIds.value = []
  auditScopeByRequestId.clear()
  auditEtaByRequestId.clear()
  auditCancelledLogged = false
  batchVisible.value = true
  batchRunning.value = true
  cancelRequested.value = false
  batchDetailExpanded.value = true
  batchLogs.value = []
  batchOverallPercent.value = 0
  batchDoneFunctions.value = 0
  batchTotalFunctions.value = 0
  batchEtaMs.value = 0
  batchTotalFiles.value = 1
  batchFileIndex.value = 1
  batchCurrentFile.value = shortenPath(selectedFilePath.value)
  batchCurrentFunction.value = ''
  panelComplexity.value = { original: null, refactored: null, label: '' }
  pushBatchLog(`开始扫描：${shortenPath(selectedFilePath.value)}`, 'info')
}

// 结束后保留 batchVisible 与日志供回看
function endAuditProgress(): void {
  batchRunning.value = false
  batchCurrentFunction.value = ''
  activeAuditRequestIds.value = []
  auditScopeByRequestId.clear()
  auditEtaByRequestId.clear()
}

// 进度事件是否属于当前扫描任务（单文件扫描双版本并行时 batchId 只能存一个，故并集判定）
function isCurrentAuditBatch(id?: string): boolean {
  if (!id) return false
  if (id === batchId.value) return true
  return activeAuditRequestIds.value.includes(id)
}

async function runSingleFileAudit(
  scope: AuditScope,
  fileContent: string,
  requestId: string
): Promise<void> {
  if (!selectedFilePath.value) return

  // 先登记再发 IPC，保证进度事件回传时能归属到本次扫描
  batchId.value = requestId
  auditScopeByRequestId.set(requestId, scope)
  if (!activeAuditRequestIds.value.includes(requestId)) {
    activeAuditRequestIds.value.push(requestId)
  }

  const { report } = await window.api.auditFile({
    requestId,
    filePath: selectedFilePath.value,
    language: language.value,
    fileContent,
    scope
  })

  if (scope === 'original') {
    originalAuditReport.value = report
  } else {
    refactoredAuditReport.value = report
  }
}

async function runFileAudit(): Promise<void> {
  if (!selectedFilePath.value) {
    ElMessage.warning('请先选择文件')
    return
  }
  if (isBusy.value || batchRunning.value) {
    ElMessage.info('任务正在进行中…')
    return
  }

  // 未进行重构：弹出确认对话框，选择是否仅扫描重构前代码
  if (!hasRefactoredContent.value) {
    const choice = await ElMessageBox.confirm(
      '该文件还未进行重构，是否直接进行扫描任务？',
      '提示',
      { confirmButtonText: '是', cancelButtonText: '否', type: 'info' }
    ).catch(() => false)
    if (!choice) return

    beginAuditProgress()
    await runBusy('fileAudit', '正在生成扫描报告…', async () => {
      try {
        await runSingleFileAudit('original', originalContent.value, createRequestId())
        refactoredAuditReport.value = null
        ElMessage.success('扫描报告已更新')
        activeEditorTab.value = 'audit'
      } catch (e: unknown) {
        // 取消的反馈由进度事件的「扫描已取消」日志承担，不弹红色报错（与函数/文件重构约定一致）
        if (!cancelRequested.value) {
          const msg = e instanceof Error ? e.message : String(e)
          pushBatchLog(`扫描失败：${msg}`, 'failed')
          ElMessage.error(msg)
        }
      } finally {
        endAuditProgress()
      }
    })
    return
  }

  // 已重构：同时扫描两个版本
  beginAuditProgress()
  await runBusy('fileAudit', '正在生成扫描报告…', async () => {
    try {
      const jobs: Array<Promise<void>> = [
        runSingleFileAudit('original', originalContent.value, createRequestId()),
        runSingleFileAudit('refactored', modifiedContent.value, createRequestId())
      ]
      const results = await Promise.allSettled(jobs)
      const failed = results.filter((item) => item.status === 'rejected')
      if (failed.length) {
        const reason =
          failed[0].status === 'rejected'
            ? failed[0].reason instanceof Error
              ? failed[0].reason.message
              : String(failed[0].reason)
            : '扫描失败'
        throw new Error(reason)
      }
      ElMessage.success('扫描报告已更新')
      activeEditorTab.value = 'audit'
    } catch (e: unknown) {
      // 同上：取消不弹错，交给「扫描已取消」日志
      if (!cancelRequested.value) {
        const msg = e instanceof Error ? e.message : String(e)
        pushBatchLog(`扫描失败：${msg}`, 'failed')
        ElMessage.error(msg)
      }
    } finally {
      endAuditProgress()
    }
  })
}

async function exportAuditReport(scope: AuditScope): Promise<void> {
  const report = getAuditReportByScope(scope)
  if (!report) {
    ElMessage.warning(`请先生成${getAuditScopeLabel(scope)}扫描报告`)
    return
  }

  const result = await window.api.saveJsonFile({
    defaultFileName: getAuditExportFileName(scope),
    jsonText: JSON.stringify(report, null, 2),
    title: `${getAuditScopeLabel(scope)}扫描报告导出`
  })

  if (result.ok) {
    ElMessage.success('扫描报告已导出')
  }
}

function getRiskTagType(risk: CodeAuditSeverity): 'success' | 'warning' | 'danger' | 'info' {
  if (risk === 'low') return 'success'
  if (risk === 'medium') return 'warning'
  if (risk === 'high' || risk === 'critical') return 'danger'
  return 'info'
}

function getRiskLabel(risk: CodeAuditSeverity): string {
  if (risk === 'low') return '低'
  if (risk === 'medium') return '中'
  if (risk === 'high') return '高'
  if (risk === 'critical') return '严重'
  return risk
}

async function loadDirectory(dir: string): Promise<void> {
  rootDir.value = dir
  tree.value = await window.api.buildFileTree(dir)
  selectedFilePath.value = null
  functionsList.value = []
  selectedFunctionId.value = null
  originalContent.value = ''
  modifiedContent.value = ''
  refactorPreviewContent.value = ''
  resetAuditReports()
  historySessionId.value = ''
}

async function openDirectory(): Promise<void> {
  // 通过主进程打开“选择目录”对话框，然后构建左侧目录树
  const dir = await window.api.selectDirectory()
  if (!dir) return
  await loadDirectory(dir)
}

function isSupportedSourceFile(filePath: string): boolean {
  // 仅允许对 C/C++/Java 进行后续“函数解析/重构/写回”流程。
  // 目录树仍然会展示全部文件，便于浏览项目结构。
  const lower = (filePath || '').toLowerCase()
  return (
    lower.endsWith('.c') ||
    lower.endsWith('.cc') ||
    lower.endsWith('.cpp') ||
    lower.endsWith('.cxx') ||
    lower.endsWith('.h') ||
    lower.endsWith('.hpp') ||
    lower.endsWith('.java')
  )
}

async function onTreeNodeClick(node: unknown): Promise<void> {
  const n = node as { kind?: unknown; path?: unknown } | null
  if (!n || n.kind !== 'file') return
  const filePath = typeof n.path === 'string' ? n.path : ''
  if (!filePath) return

  if (isRefactorHistoryFile(filePath)) {
    await openHistoryFile(filePath)
    return
  }

  if (!isSupportedSourceFile(filePath)) {
    ElMessage.info('仅支持打开 C/C++/Java 文件进行重构')
    return
  }

  await openFile(filePath)
}

// 打开文件的序号令牌：每次 openFile 自增，用于丢弃过期的异步结果
// （防止大文件解析期间快速切换文件时，旧结果覆盖新结果、多次解析排队放大卡顿）
let openFileSeq = 0
const fileParsing = ref(false)

async function openHistoryFile(filePath: string): Promise<void> {
  const seq = ++openFileSeq
  selectedFilePath.value = filePath
  activeEditorTab.value = 'diff'
  historySessionId.value = ''
  fileParsing.value = true
  functionsList.value = []
  selectedFunctionId.value = null
  originalFileComplexity.value = null
  refactoredFileComplexity.value = null
  functionComplexityMap.value = {}
  refactorPreviewContent.value = ''
  revealLine.value = null

  try {
    const { content } = await window.api.readFile(filePath)
    if (seq !== openFileSeq) return
    originalContent.value = content
    modifiedContent.value = content
  } finally {
    if (seq === openFileSeq) fileParsing.value = false
  }
}

async function openFile(filePath: string): Promise<void> {
  if (!isSupportedSourceFile(filePath)) {
    ElMessage.info('仅支持打开 C/C++/Java 文件进行重构')
    return
  }

  const seq = ++openFileSeq
  const isStale = (): boolean => seq !== openFileSeq

  selectedFilePath.value = filePath
  historySessionId.value = createRequestId()
  fileParsing.value = true
  functionsList.value = []
  selectedFunctionId.value = null
  const { content } = await window.api.readFile(filePath)
  originalContent.value = content
  modifiedContent.value = content

  const parsed = await window.api.parseFunctions(filePath)
  functionsList.value = parsed.functions.map((f) => ({
    ...f,
    originalComplexity: undefined,
    refactoredComplexity: undefined
  }))
  selectedFunctionId.value = parsed.functions[0]?.id ?? null
  if (parsed.functions[0]) requestReveal(parsed.functions[0].startLine)
  refactorPreviewContent.value = ''
  resetAuditReports()
  
  // 重置圈复杂度状态
  originalFileComplexity.value = null
  refactoredFileComplexity.value = null
  functionComplexityMap.value = {}
  refactorPreviewContent.value = ''

  try {
    const { content } = await window.api.readFile(filePath)
    if (isStale()) return
    originalContent.value = content
    modifiedContent.value = content

    // 一次解析同时得到函数列表与圈复杂度（主进程整文件仅做一次 tree-sitter 解析）
    const analysis = await window.api.analyzeFile(filePath, language.value, content)
    if (isStale()) return

    functionsList.value = analysis.functions.map((f) => ({
      ...f,
      originalComplexity: analysis.functionComplexities[f.id],
      refactoredComplexity: undefined
    }))
    selectedFunctionId.value = analysis.functions[0]?.id ?? null
    if (analysis.functions[0]) requestReveal(analysis.functions[0].startLine)

    originalFileComplexity.value = analysis.fileComplexity
    functionComplexityMap.value = {}
    for (const fn of functionsList.value) {
      functionComplexityMap.value[fn.id] = { original: fn.originalComplexity }
    }
  } finally {
    // 只有最新一次 openFile 才能复位 loading；过期调用的结果已被丢弃
    if (!isStale()) fileParsing.value = false
  }
}

async function runFunctionRefactor(): Promise<void> {
  if (!isSelectedSourceFile.value || !selectedFilePath.value || !selectedFunction.value) {
    ElMessage.warning('请先选择文件和函数')
    return
  }
  if (batchRunning.value) {
    ElMessage.info('正在处理中，请稍候…')
    return
  }

  const fn = selectedFunction.value
  const targetFunctionOccurrence = getFunctionOccurrenceIndexById(functionsList.value, fn.id)

  // 初始化浮窗状态
  refactorMode.value = 'function'
  batchId.value = ''
  batchVisible.value = true
  batchRunning.value = true
  cancelRequested.value = false
  batchOverallPercent.value = 0
  batchCurrentFile.value = selectedFilePath.value
  batchCurrentFunction.value = fn.name
  batchFileIndex.value = 0
  batchTotalFiles.value = 0
  batchDoneFunctions.value = 0
  batchTotalFunctions.value = 1
  batchEtaMs.value = 0
  batchLogs.value = []
  panelComplexity.value = { original: null, refactored: null, label: '' }
  refactorStartMs = Date.now()

  const requestId = createRequestId()
  activeRefactorRequestId.value = requestId

  // 监听双一致性审查进度
  const unsubQG = window.api.onQGProgress((msg) => {
    const stageLabel = msg.stage === 'refactoring' ? '重构中' : '质检中'
    const attemptLabel = msg.isRetry ? `重试 ${msg.attempt - 1}/${msg.maxAttempts - 1}` : '初次'
    qgProgressMsg.value = `${stageLabel} · ${attemptLabel}`
    batchCurrentFunction.value =
      msg.stage === 'checking' ? `${msg.functionName} · 检查中` : msg.functionName
    if (msg.isRetry && msg.stage === 'refactoring') {
      pushBatchLog(`  · 未通过，重试 ${msg.attempt - 1}/${msg.maxAttempts - 1}…`, 'info')
    } else if (msg.stage === 'checking') {
      pushBatchLog(`  · 语义检查中…`, 'info')
    }
  })

  pushBatchLog(`开始函数重构：${fn.name}`, 'info')
  pushBatchLog(`文件：${shortenPath(selectedFilePath.value)}`, 'info')
  if (fn.originalComplexity != null) {
    pushBatchLog(`重构前圈复杂度：${fn.originalComplexity}`, 'info')
  }

  try {
    const sourceFilePath = selectedFilePath.value!
    const beforeCode = modifiedContent.value
    const beforeAnalysis = await window.api.analyzeFile(sourceFilePath, language.value, beforeCode)
    const res = await window.api.refactorFunction({
      requestId,
      filePath: sourceFilePath,
      language: language.value,
      functionId: fn.id,
      startByte: fn.startByte,
      endByte: fn.endByte,
      functionName: fn.name,
      currentFileContent: beforeCode
    })

    refactorPreviewContent.value = res.refactoredFunctionCode
    modifiedContent.value = res.updatedFileContent

    // 双一致性审查结果
    const qg = (res as Record<string, unknown>).qualityGate as QGResult | undefined
    lastQGResult.value = qg ?? null
    lastFileQGResult.value = null

    // 保存重构前的圈复杂度数据（按”函数名 + 同名出现序号”映射）
    const complexityMap = buildComplexityMapByNameOccurrence(functionsList.value)

    // 单次解析同时得到新函数列表与复杂度，供下方列表刷新与复杂度展示复用（避免重复解析）
    const analysis = await window.api.analyzeFile(
      sourceFilePath,
      language.value,
      modifiedContent.value
    )
    functionsList.value = mapFunctionsWithComplexityByNameOccurrence(
      analysis.functions,
      complexityMap
    )
    const matchedFunctionId = findFunctionIdByNameAndOccurrence(
      analysis.functions,
      fn.name,
      targetFunctionOccurrence
    )
    selectedFunctionId.value = matchedFunctionId ?? analysis.functions[0]?.id ?? null
    const cur = analysis.functions.find((f) => f.id === selectedFunctionId.value)
    if (cur) requestReveal(cur.startLine)

    // 计算重构后的圈复杂度（仅展示当前重构函数），复用上面的单次解析结果
    await calculateAndStoreComplexity(
      modifiedContent.value,
      true,
      matchedFunctionId ?? '__UNMATCHED_FUNCTION__',
      analysis
    )

    // 以主进程基于“重构后代码”直接计算的复杂度为权威值
    if (matchedFunctionId) {
      const matchedFn = functionsList.value.find((f) => f.id === matchedFunctionId)
      if (matchedFn) {
        if (typeof res.refactoredComplexity === 'number') {
          matchedFn.refactoredComplexity = res.refactoredComplexity
        }
        if (fn.originalComplexity != null) {
          matchedFn.originalComplexity = fn.originalComplexity
        }
        const prev = functionComplexityMap.value[matchedFunctionId] || {}
        functionComplexityMap.value[matchedFunctionId] = {
          ...prev,
          original: fn.originalComplexity ?? prev.original,
          refactored:
            typeof res.refactoredComplexity === 'number'
              ? res.refactoredComplexity
              : prev.refactored
        }
      }
    }

    const historySaved = await saveRefactorHistory({
      sessionId: historySessionId.value,
      sourceFilePath,
      language: language.value,
      scope: 'function',
      modelName: selectedModelName.value,
      instruction: getHistoryInstruction('function'),
      target: {
        functionName: fn.name,
        functionOccurrence: targetFunctionOccurrence ?? 1,
        startLineBefore: fn.startLine,
        endLineBefore: fn.endLine,
        startLineAfter: cur?.startLine,
        endLineAfter: cur?.endLine
      },
      before: {
        code: beforeCode,
        lineCount: countLines(beforeCode),
        fileComplexity: beforeAnalysis.fileComplexity,
        targetComplexity: beforeAnalysis.functionComplexities[fn.id]
      },
      after: {
        code: modifiedContent.value,
        lineCount: countLines(modifiedContent.value),
        fileComplexity: analysis.fileComplexity,
        targetComplexity:
          typeof res.refactoredComplexity === 'number'
            ? res.refactoredComplexity
            : matchedFunctionId
              ? analysis.functionComplexities[matchedFunctionId]
              : undefined
      }
    })

    // 浮窗显示复杂度变化
    const elapsed = ((Date.now() - refactorStartMs) / 1000).toFixed(1)
    batchOverallPercent.value = 100
    if (fn.originalComplexity != null && typeof res.refactoredComplexity === 'number') {
      panelComplexity.value = {
        original: fn.originalComplexity,
        refactored: res.refactoredComplexity,
        label: `函数 ${fn.name} 圈复杂度`
      }
      const delta = res.refactoredComplexity - fn.originalComplexity
      const sign = delta > 0 ? '+' : ''
      pushBatchLog(
        `圈复杂度：${fn.originalComplexity} → ${res.refactoredComplexity}（${sign}${delta}）`,
        delta <= 0 ? 'success' : 'info'
      )
    }
    if (qg?.passed) {
      pushBatchLog(`${fn.name} → 已重构`, 'success')
    }
    pushBatchLog(`函数重构完成，耗时 ${elapsed}s`, 'success')
    if (qg) {
      if (qg.passed) {
        ElMessage.success(historySaved ? '函数重构完成，历史记录已更新 ✓' : '函数重构完成 ✓')
      } else {
        ElMessage.warning(
          historySaved ? '未通过质检，已保留原始代码；历史记录已更新' : '未通过质检，已保留原始代码'
        )
      }
    } else {
      ElMessage.success(
        historySaved
          ? '函数重构完成（临时预览与历史记录已更新）'
          : '函数重构完成（已写入临时预览）'
      )
    }
  } catch (e: unknown) {
    // 取消时只在悬浮框内提示，不弹出报错弹窗
    if (cancelRequested.value) {
      pushBatchLog('函数重构已取消', 'failed')
    } else {
      const msg = e instanceof Error ? e.message : String(e)
      pushBatchLog(`函数重构失败：${msg}`, 'failed')
      ElMessage.error(msg)
    }
  } finally {
    unsubQG()
    qgProgressMsg.value = ''
    batchRunning.value = false
    batchCurrentFunction.value = ''
    activeRefactorRequestId.value = null
    cancelRequested.value = false
  }
}

async function runFileRefactor(): Promise<void> {
  if (!isSelectedSourceFile.value || !selectedFilePath.value) {
    ElMessage.warning('请先选择文件')
    return
  }
  if (batchRunning.value) {
    ElMessage.info('正在处理中，请稍候…')
    return
  }

  const previousFunctionName = selectedFunction.value?.name ?? null
  const previousFunctionOccurrence = selectedFunctionId.value
    ? getFunctionOccurrenceIndexById(functionsList.value, selectedFunctionId.value)
    : null

  // 初始化浮窗状态
  refactorMode.value = 'file'
  batchVisible.value = true
  batchRunning.value = true
  cancelRequested.value = false
  batchOverallPercent.value = 0
  batchCurrentFile.value = selectedFilePath.value
  batchCurrentFunction.value = ''
  batchFileIndex.value = 1
  batchTotalFiles.value = 1
  batchDoneFunctions.value = 0
  batchTotalFunctions.value = 0
  batchEtaMs.value = 0
  batchLogs.value = []
  panelComplexity.value = { original: null, refactored: null, label: '' }

  const requestId = createRequestId()
  activeRefactorRequestId.value = requestId
  batchId.value = requestId // 让 handleBatchProgress 能匹配到事件

  // 监听双一致性审查进度
  const unsubQGFile = window.api.onQGProgress((msg) => {
    let stageLabel: string
    if (msg.stage === 'analyzing') {
      stageLabel = '分析中'
    } else if (msg.stage === 'file-refactoring') {
      stageLabel = '重构中'
    } else if (msg.stage === 'checking') {
      stageLabel = '质检中'
    } else {
      stageLabel = '重构中'
    }
    const attemptLabel = msg.isRetry ? `重试 ${msg.attempt - 1}/${msg.maxAttempts - 1}` : '初次'
    qgProgressMsg.value = `[${msg.functionName}] ${stageLabel} · ${attemptLabel}`
    batchCurrentFunction.value = msg.functionName
    if (msg.stage === 'analysis-done') {
      pushBatchLog(`  · 选中 ${msg.selectedCount ?? 0} 个函数需要重构`, 'info')
    } else if (msg.isRetry && msg.stage === 'refactoring') {
      pushBatchLog(`  · ${msg.functionName} 重试 ${msg.attempt - 1}/${msg.maxAttempts - 1}…`, 'info')
    } else if (msg.stage === 'checking') {
      pushBatchLog(`  · ${msg.functionName} 检查中…`, 'info')
    }
  })

  pushBatchLog(`开始文件重构：${shortenPath(selectedFilePath.value)}`, 'info')

  try {
    const sourceFilePath = selectedFilePath.value!
    const beforeCode = modifiedContent.value
    const beforeAnalysis = await window.api.analyzeFile(sourceFilePath, language.value, beforeCode)
    const res = await window.api.refactorFile({
      requestId,
      filePath: sourceFilePath,
      language: language.value,
      currentFileContent: beforeCode
    })

    // 检查是否已取消：取消后不显示“完成”和复杂度
    if (cancelRequested.value) {
      pushBatchLog('文件重构已取消', 'failed')
      return
    }

    refactorPreviewContent.value =
      res.summary || '/* 文件重构已完成：请在“代码对比”中查看整文件变更 */'
    modifiedContent.value = res.updatedFileContent

    // 双一致性审查结果
    const fqg = (res as Record<string, unknown>).qualityGate as FileQGResult | undefined
    lastFileQGResult.value = fqg ?? null
    lastQGResult.value = null

    // 保存重构前的圈复杂度数据（按”函数名 + 同名出现序号”映射）
    const complexityMap = buildComplexityMapByNameOccurrence(functionsList.value)

    // 单次解析同时得到新函数列表与复杂度，供列表刷新与复杂度展示复用（避免重复解析）
    const analysis = await window.api.analyzeFile(
      sourceFilePath,
      language.value,
      modifiedContent.value
    )
    functionsList.value = mapFunctionsWithComplexityByNameOccurrence(
      analysis.functions,
      complexityMap
    ).map((f) => ({
      ...f,
      refactoredComplexity: undefined
    }))

    if (previousFunctionName) {
      selectedFunctionId.value =
        findFunctionIdByNameAndOccurrence(
          analysis.functions,
          previousFunctionName,
          previousFunctionOccurrence
        ) ??
        analysis.functions[0]?.id ??
        null
    } else {
      selectedFunctionId.value = analysis.functions[0]?.id ?? null
    }

    const cur = analysis.functions.find((f) => f.id === selectedFunctionId.value)
    if (cur) requestReveal(cur.startLine)

    // 计算重构后的圈复杂度，复用上面的单次解析结果
    await calculateAndStoreComplexity(modifiedContent.value, true, undefined, analysis)

    const historySaved = await saveRefactorHistory({
      sessionId: historySessionId.value,
      sourceFilePath,
      language: language.value,
      scope: 'file',
      modelName: selectedModelName.value,
      instruction: getHistoryInstruction('file'),
      before: {
        code: beforeCode,
        lineCount: countLines(beforeCode),
        fileComplexity: beforeAnalysis.fileComplexity
      },
      after: {
        code: modifiedContent.value,
        lineCount: countLines(modifiedContent.value),
        fileComplexity: analysis.fileComplexity
      }
    })

    // 逐函数重构结果（先输出，保证日志顺序）
    if (fqg) {
      for (const fr of fqg.functionResults) {
        if (fr.passed && fr.attempt > 0) {
          pushBatchLog(`${fr.functionName} → 已重构`, 'success')
        }
      }
    }

    // 浮窗显示文件复杂度变化
    batchOverallPercent.value = 100
    if (res.originalComplexity != null && res.refactoredComplexity != null) {
      panelComplexity.value = {
        original: res.originalComplexity,
        refactored: res.refactoredComplexity,
        label: '文件圈复杂度'
      }
      const delta = res.refactoredComplexity - res.originalComplexity
      const sign = delta > 0 ? '+' : ''
      pushBatchLog(
        `文件圈复杂度：${res.originalComplexity} → ${res.refactoredComplexity}（${sign}${delta}）`,
        delta <= 0 ? 'success' : 'info'
      )
    }
    pushBatchLog('文件重构完成', 'success')
    if (fqg) {
      if (fqg.failureCount > 0) {
        ElMessage.warning(
          `文件重构完成：${fqg.passedCount} 已优化，${fqg.failureCount} 保留原代码${
            historySaved ? '；历史记录已更新' : ''
          }`
        )
      } else {
        ElMessage.success(historySaved ? '该文件已重构，历史记录已更新 ✓' : '该文件已重构 ✓')
      }
    } else {
      ElMessage.success(
        historySaved
          ? '文件重构完成：临时预览与历史记录已更新'
          : '文件重构完成：已更新整文件（临时预览）'
      )
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    pushBatchLog(`文件重构失败：${msg}`, 'failed')
    ElMessage.error(msg)
  } finally {
    unsubQGFile()
    qgProgressMsg.value = ''
    batchRunning.value = false
    batchCurrentFunction.value = ''
    activeRefactorRequestId.value = null
    batchId.value = ''
    cancelRequested.value = false
  }
}

async function writeBackToFile(): Promise<void> {
  if (!isSelectedSourceFile.value || !selectedFilePath.value) {
    ElMessage.warning('请先选择文件')
    return
  }

  const ok = await ElMessageBox.confirm('确认将右侧结果写回文件？', '写回确认', {
    confirmButtonText: '写回',
    cancelButtonText: '取消',
    type: 'warning'
  }).catch(() => false)
  if (!ok) return

  await runBusy('write', '正在写回文件…', async () => {
    try {
      const sourceFilePath = selectedFilePath.value!
      const appliedSessionId = historySessionId.value
      await window.api.writeFile(sourceFilePath, modifiedContent.value)

      let historyUpdateError: string | null = null
      let historyUpdatedCount = 0
      if (appliedSessionId) {
        try {
          const result = await window.api.markRefactorHistoryApplied(
            sourceFilePath,
            appliedSessionId
          )
          historyUpdatedCount = result.updatedCount
        } catch (error: unknown) {
          historyUpdateError = error instanceof Error ? error.message : String(error)
        }
      }

      originalContent.value = modifiedContent.value

      // 保存重构后的圈复杂度数据（写回后作为新的原始值）
      const complexityMap = buildComplexityMapByNameOccurrence(functionsList.value)

      const parsed = await window.api.parseFunctions(sourceFilePath, modifiedContent.value)
      functionsList.value = mapFunctionsWithComplexityByNameOccurrence(
        parsed.functions,
        complexityMap
      ).map((f) => ({
        ...f,
        originalComplexity: f.refactoredComplexity ?? f.originalComplexity,
        refactoredComplexity: undefined
      }))
      selectedFunctionId.value = parsed.functions[0]?.id ?? null

      // 写回后，将重构后的复杂度作为新的原始复杂度
      originalFileComplexity.value = refactoredFileComplexity.value ?? originalFileComplexity.value
      refactoredFileComplexity.value = null
      historySessionId.value = createRequestId()

      if (historyUpdateError) {
        ElMessage.warning(`文件已写回，但历史记录状态更新失败：${historyUpdateError}`)
      } else if (historyUpdatedCount > 0) {
        ElMessage.success(`已写回到文件，${historyUpdatedCount} 条历史记录已标记为 applied`)
      } else {
        ElMessage.success('已写回到文件')
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      ElMessage.error(msg)
    }
  })
}

watch(selectedFilePath, () => {
  // 预留：如果未来需要在切换文件时做额外副作用（统计/埋点/缓存等），可以放这里
})

watch(
  () => selectedFunction.value,
  (fn) => {
    if (fn) requestReveal(fn.startLine)
  }
)

function pushBatchLog(text: string, level: BatchLogLevel = 'info'): void {
  batchLogs.value.push({ id: batchLogSeq++, text, level })
  // 限制日志条数，避免长任务导致内存无限增长
  if (batchLogs.value.length > 500) {
    batchLogs.value.splice(0, batchLogs.value.length - 500)
  }
}

// 判断路径是否位于批量重构备份目录（任意一级目录名以 Backup 结尾）内
function isInBackupDir(filePath: string): boolean {
  const segments = filePath.split(/[\\/]/)
  // 最后一段是文件名，只检查目录段
  return segments.slice(0, -1).some((segment) => segment.endsWith('Backup'))
}

// 递归展平目录树，收集所有受支持的源文件路径（排除备份目录内的文件）
function collectSupportedFiles(node: FileTreeNode | null): string[] {
  if (!node) return []
  const out: string[] = []
  const walk = (n: FileTreeNode): void => {
    if (n.kind === 'file') {
      if (isSupportedSourceFile(n.path) && !isInBackupDir(n.path)) out.push(n.path)
    } else if (n.children) {
      for (const c of n.children) walk(c)
    }
  }
  walk(node)
  return out
}

// 批量重构时实时切换代码预览和函数列表到当前处理的文件
async function batchSwitchToFile(filePath: string): Promise<void> {
  try {
    // 作废旧打开请求：批量切换文件后，之前未完成的 openFile 结果不得再覆盖界面
    openFileSeq++
    selectedFilePath.value = filePath
    historySessionId.value = createRequestId()
    const { content } = await window.api.readFile(filePath)
    originalContent.value = content
    modifiedContent.value = content

    // 一次解析同时得到函数列表与圈复杂度（替代 parseFunctions + calculateComplexity 的重复解析）
    const lang = filePath.toLowerCase().endsWith('.java') ? 'java' : 'cpp'
    const analysis = await window.api.analyzeFile(filePath, lang, content)
    functionsList.value = analysis.functions.map((f) => ({
      ...f,
      originalComplexity: analysis.functionComplexities[f.id],
      refactoredComplexity: undefined
    }))
    selectedFunctionId.value = analysis.functions[0]?.id ?? null
    if (analysis.functions[0]) requestReveal(analysis.functions[0].startLine)
    refactorPreviewContent.value = ''
    originalFileComplexity.value = analysis.fileComplexity
    refactoredFileComplexity.value = null
    functionComplexityMap.value = {}
    for (const fn of functionsList.value) {
      functionComplexityMap.value[fn.id] = { original: fn.originalComplexity }
    }
  } catch {
    // 忽略：批量过程中切换文件失败不影响主流程
  }
}

// 批量重构时高亮当前正在重构的函数
function batchHighlightFunction(functionName: string): void {
  const fn = functionsList.value.find((f) => f.name === functionName)
  if (fn) {
    selectedFunctionId.value = fn.id
    requestReveal(fn.startLine)
  }
}

// 处理主进程推送的重构进度事件（批量/文件重构共用）
function handleBatchProgress(data: BatchProgressEvent): void {
  if (!data) return
  // 匹配当前活动的 batchId 或 activeRefactorRequestId
  if (data.batchId !== batchId.value && data.batchId !== activeRefactorRequestId.value) return
  switch (data.phase) {
    case 'backup-done':
      pushBatchLog(`已备份目录到：${data.backupDir ?? ''}`, 'success')
      break
    case 'batch-start':
      batchTotalFiles.value = data.totalFiles ?? batchTotalFiles.value
      batchTotalFunctions.value = data.totalFunctions ?? 0
      pushBatchLog(
        `扫描完成：${data.totalFiles ?? 0} 个文件，共 ${data.totalFunctions ?? 0} 个函数`,
        'info'
      )
      break
    case 'file-start':
      batchCurrentFile.value = data.file ?? ''
      batchFileIndex.value = (data.fileIndex ?? 0) + 1
      pushBatchLog(
        `[${batchFileIndex.value}/${data.totalFiles ?? batchTotalFiles.value}] 开始处理：${shortenPath(data.file)}（${data.functionCount ?? 0} 个函数）`,
        'info'
      )
      // 实时切换代码预览和函数列表到当前文件
      if (data.file) void batchSwitchToFile(data.file)
      break
    case 'analysis-start':
      batchCurrentFunction.value = '分析中…'
      break
    case 'analysis-done': {
      const selected = (data as Record<string, unknown>).selectedCount as number ?? 0
      pushBatchLog(`  · 选中 ${selected} 个函数需要重构`, 'info')
      break
    }
    case 'function-start':
      batchCurrentFunction.value = data.functionName ?? ''
      if (data.functionName) batchHighlightFunction(data.functionName)
      break
    case 'function-checking':
      batchCurrentFunction.value = `${data.functionName} · 检查中`
      pushBatchLog(`  · ${data.functionName} 检查中…`, 'info')
      break
    case 'function-retry':
      batchCurrentFunction.value = data.functionName ?? ''
      pushBatchLog(`  · ${data.functionName} 重试 ${(data.attempt ?? 2) - 1}/${(data.maxAttempts ?? 4) - 1}…`, 'info')
      break
    case 'function-done': {
      batchDoneFunctions.value = data.doneFunctions ?? batchDoneFunctions.value
      batchTotalFunctions.value = data.totalFunctions ?? batchTotalFunctions.value
      // 进度条：优先用主进程给的 overallPercent（批量重构）；
      // 文件重构未发送该字段时，用已完成/总函数数换算
      if (data.overallPercent != null) {
        batchOverallPercent.value = data.overallPercent
      } else if (data.doneFunctions != null && data.totalFunctions && data.totalFunctions > 0) {
        batchOverallPercent.value = Math.round((data.doneFunctions / data.totalFunctions) * 100)
      }
      if (data.etaMs != null) batchEtaMs.value = data.etaMs
      if (data.status === 'success') {
        pushBatchLog(`  · ${data.functionName ?? ''} → 已重构`, 'success')
      }
      // 重构成功时：更新代码预览显示diff，更新函数列表中该函数的重构后复杂度
      if (data.status === 'success' && data.updatedFileContent) {
        modifiedContent.value = data.updatedFileContent
      }
      if (data.status === 'success' && data.functionName && data.refactoredComplexity != null) {
        const fn = functionsList.value.find((f) => f.name === data.functionName)
        if (fn) {
          fn.refactoredComplexity = data.refactoredComplexity
        }
      }
      break
    }
    case 'file-done':
      pushBatchLog(`完成文件：${shortenPath(data.file)}`, 'info')
      break
    case 'file-refactor-done': {
      if (cancelRequested.value) break
      const orig = data.originalComplexity ?? null
      const refac = data.refactoredComplexity ?? null
      panelComplexity.value = { original: orig, refactored: refac, label: '文件圈复杂度' }
      break
    }
    case 'batch-cancelled':
      pushBatchLog('批量重构已取消', 'failed')
      break
    case 'batch-done':
      batchOverallPercent.value = 100
      pushBatchLog('全部处理完成', 'success')
      break
  }
}

async function runBatchRefactor(): Promise<void> {
  if (!rootDir.value || !tree.value) {
    ElMessage.warning('请先打开一个项目目录')
    return
  }
  if (batchRunning.value) {
    ElMessage.info('批量重构正在进行中…')
    return
  }
  const files = collectSupportedFiles(tree.value)
  if (files.length === 0) {
    ElMessage.warning('目录中未找到受支持的源文件（.c/.cc/.cpp/.cxx/.h/.hpp/.java）')
    return
  }
  try {
    await ElMessageBox.confirm(
      `将对目录内 ${files.length} 个源文件逐个进行“逐函数重构”，并在重构前自动备份整个目录。该操作耗时较长，确认开始？`,
      '批量重构确认',
      { confirmButtonText: '开始', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return // 用户取消
  }

  // 初始化进度状态
  refactorMode.value = 'batch'
  batchId.value = createRequestId()
  batchVisible.value = true
  batchRunning.value = true
  cancelRequested.value = false
  batchOverallPercent.value = 0
  batchCurrentFile.value = ''
  batchFileIndex.value = 0
  batchTotalFiles.value = files.length
  batchCurrentFunction.value = ''
  batchDoneFunctions.value = 0
  batchTotalFunctions.value = 0
  batchEtaMs.value = 0
  batchLogs.value = []
  panelComplexity.value = { original: null, refactored: null, label: '' }
  pushBatchLog(`开始批量重构，共 ${files.length} 个文件`, 'info')

  try {
    const res = await window.api.refactorBatch({
      batchId: batchId.value,
      rootDir: rootDir.value,
      files
    })
    if (res.ok) {
      const totalSuccess = res.report.reduce((s, r) => s + r.success, 0)
      const totalFailed = res.report.reduce((s, r) => s + r.failed, 0)
      ElMessage.success(`批量重构完成：${totalSuccess} 个函数成功，${totalFailed} 个失败`)
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    pushBatchLog(`批量重构出错：${msg}`, 'failed')
    ElMessage.error(msg)
  } finally {
    batchRunning.value = false
    batchCurrentFunction.value = ''
    if (rootDir.value) {
      try {
        tree.value = await window.api.buildFileTree(rootDir.value)
      } catch {
        // 忽略：项目目录可能已被移动/删除
      }
    }
    // 重构结果已写回磁盘：若当前打开了文件，重新载入以展示最新内容
    if (selectedFilePath.value) {
      try {
        await openFile(selectedFilePath.value)
      } catch {
        // 忽略：文件可能已被移动/删除
      }
    }
  }
}

// 批量扫描：对 .c/.c++/.java 文件逐文件审计，结果导出为同目录 .audit.json
async function runBatchAudit(): Promise<void> {
  if (!rootDir.value || !tree.value) {
    ElMessage.warning('请先打开一个项目目录')
    return
  }
  if (batchRunning.value || isBusy.value) {
    ElMessage.info('批量操作正在进行中…')
    return
  }
  const files = collectSupportedFiles(tree.value)
  if (files.length === 0) {
    ElMessage.warning('目录中未找到受支持的源文件（.c/.cc/.cpp/.cxx/.h/.hpp/.java）')
    return
  }
  try {
    await ElMessageBox.confirm(
      `将对目录内 ${files.length} 个源文件逐个进行代码安全扫描，扫描报告将导出为各文件同目录下的 .audit.json 文件。该操作耗时较长，确认开始？`,
      '批量扫描确认',
      { confirmButtonText: '开始', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }

  // 初始化进度状态
  refactorMode.value = 'audit'
  batchId.value = createRequestId()
  batchVisible.value = true
  batchRunning.value = true
  batchDetailExpanded.value = true
  auditCancelledLogged = false
  cancelRequested.value = false
  batchOverallPercent.value = 0
  batchCurrentFile.value = ''
  batchFileIndex.value = 0
  batchTotalFiles.value = files.length
  batchCurrentFunction.value = ''
  batchDoneFunctions.value = 0
  batchTotalFunctions.value = 0
  batchEtaMs.value = 0
  batchLogs.value = []
  panelComplexity.value = { original: null, refactored: null, label: '' }
  pushBatchLog(`开始批量扫描，共 ${files.length} 个文件`, 'info')

  try {
    const res = await window.api.auditBatch({
      batchId: batchId.value,
      rootDir: rootDir.value,
      files
    })
    if (res.ok) {
      const okCount = res.report.filter((r) => r.status === 'ok').length
      const failCount = res.report.filter((r) => r.status === 'failed').length
      ElMessage.success(
        `批量扫描完成：${okCount} 个文件扫描成功${failCount > 0 ? `，${failCount} 个失败` : ''}`
      )
      // 刷新目录树以显示新生成的 .audit.json 文件
      if (rootDir.value) {
        try {
          tree.value = await window.api.buildFileTree(rootDir.value)
        } catch {
          // 忽略
        }
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    pushBatchLog(`批量扫描出错：${msg}`, 'failed')
    ElMessage.error(msg)
  } finally {
    batchRunning.value = false
    batchCurrentFunction.value = ''
  }
}

// 逐函数日志前缀：单文件扫描区分重构前后版本，批量扫描用文件序号
function auditFunctionLogPrefix(data: BatchProgressEvent): string {
  const scope = data.batchId ? auditScopeByRequestId.get(data.batchId) : undefined
  if (scope) return scope === 'original' ? '[前]' : '[后]'
  return `[${batchFileIndex.value}]`
}

// 扫描百分比只前进不回退：函数级与文件级两套口径并存，取较大值
function raiseAuditPercent(value: number): void {
  const next = Math.max(0, Math.min(100, Math.round(value)))
  if (next > batchOverallPercent.value) batchOverallPercent.value = next
}

// 处理扫描进度事件（单文件扫描与批量扫描共用）
function handleAuditBatchProgress(data: BatchProgressEvent): void {
  if (!data) return
  if (!isCurrentAuditBatch(data.batchId)) return
  switch (data.phase) {
    case 'batch-start':
      batchTotalFiles.value = data.totalFiles ?? batchTotalFiles.value
      // 累加：单文件双版本并行时每个版本各报一次
      batchTotalFunctions.value += data.totalFunctions ?? 0
      if ((data.totalFiles ?? 0) > 1) {
        pushBatchLog(`准备扫描 ${data.totalFiles ?? 0} 个文件`, 'info')
      }
      break
    case 'file-start':
      batchCurrentFile.value = data.file ?? ''
      batchFileIndex.value = (data.fileIndex ?? 0) + 1
      pushBatchLog(
        `[${batchFileIndex.value}/${data.totalFiles ?? batchTotalFiles.value}] 正在扫描：${shortenPath(data.file)}`,
        'info'
      )
      break
    case 'function-start':
      batchCurrentFunction.value = data.functionName ?? ''
      break
    case 'function-done': {
      batchDoneFunctions.value += 1
      if (data.functionName) batchCurrentFunction.value = data.functionName
      // 百分比由渲染侧算：主进程的 overallPercent 是单版本口径
      const total = batchTotalFunctions.value
      if (total > 0) {
        raiseAuditPercent((batchDoneFunctions.value / total) * 100)
      }
      if (activeAuditRequestIds.value.length > 0) {
        // 双版本并行：每个版本维护自己的 ETA，取较长者作为剩余时间
        auditEtaByRequestId.set(data.batchId, data.etaMs ?? 0)
        let maxEta = 0
        auditEtaByRequestId.forEach((v) => {
          if (v > maxEta) maxEta = v
        })
        batchEtaMs.value = maxEta
      } else {
        batchEtaMs.value = data.etaMs ?? 0
      }
      pushBatchLog(
        `  ${auditFunctionLogPrefix(data)} ${data.functionName ?? ''} ${data.status === 'success' ? '✓' : '✗'}`,
        data.status === 'success' ? 'success' : 'failed'
      )
      break
    }
    case 'file-done':
      pushBatchLog(
        `  ✓ 扫描完成 → ${shortenPath(data.jsonPath ?? data.file)}`,
        'success'
      )
      raiseAuditPercent(
        (batchFileIndex.value / (data.totalFiles ?? batchTotalFiles.value)) * 100
      )
      break
    case 'file-error':
      pushBatchLog(
        `  ✗ 扫描失败：${shortenPath(data.file)}（${data.error ?? '未知错误'}）`,
        'failed'
      )
      raiseAuditPercent(
        (batchFileIndex.value / (data.totalFiles ?? batchTotalFiles.value)) * 100
      )
      break
    case 'batch-done':
      batchOverallPercent.value = 100
      if (batchTotalFiles.value > 1) {
        pushBatchLog(`全部扫描完成：${data.okCount ?? 0} 个成功`, 'success')
      }
      break
    case 'batch-cancelled':
      if (!auditCancelledLogged) {
        auditCancelledLogged = true
        pushBatchLog(
          activeAuditRequestIds.value.length > 0 ? '扫描已取消' : '批量扫描已取消',
          'failed'
        )
      }
      break
  }
}

// 统一取消逻辑（函数/文件/批量重构、单文件/批量扫描通用）
async function cancelCurrentRefactor(): Promise<void> {
  if (!batchRunning.value || cancelRequested.value) return
  cancelRequested.value = true
  pushBatchLog('已请求取消，正在停止…', 'info')
  try {
    if (refactorMode.value === 'batch' || refactorMode.value === 'audit') {
      if (batchId.value) await window.api.cancelBatch(batchId.value)
    } else if (activeRefactorRequestId.value) {
      await window.api.cancelRefactor(activeRefactorRequestId.value)
    }
    // 单文件扫描的每个版本都是独立 requestId，逐个作废（cancelBatch 对未注册 id 无害）
    for (const id of activeAuditRequestIds.value) {
      await window.api.cancelRefactor(id)
    }
  } catch {
    // 忽略取消请求异常
  }
}

function closeBatchPanel(): void {
  if (batchRunning.value) {
    ElMessage.info('重构进行中，请先取消或等待完成')
    return
  }
  batchVisible.value = false
}

function showProgressPanel(): void {
  batchVisible.value = true
}

function toggleBatchDetail(): void {
  batchDetailExpanded.value = !batchDetailExpanded.value
}

// 日志追加时自动滚动到底部
watch(
  () => batchLogs.value.length,
  async () => {
    await nextTick()
    if (batchLogEl.value) batchLogEl.value.scrollTop = batchLogEl.value.scrollHeight
  }
)

onMounted(() => {
  void refreshIsMaximized()
  uninstallMenuListeners = installMenuGlobalListeners()
  unsubscribeBatchProgress = window.api.onBatchProgress(handleBatchProgress)
  unsubscribeAuditBatchProgress = window.api.onAuditBatchProgress(handleAuditBatchProgress)
})

// Vue 组件卸载时移除监听（理论上主窗口生命周期很长，但保持整洁）
onBeforeUnmount(() => {
  uninstallMenuListeners?.()
  uninstallMenuListeners = null
  unsubscribeBatchProgress?.()
  unsubscribeBatchProgress = null
  unsubscribeAuditBatchProgress?.()
  unsubscribeAuditBatchProgress = null
})
</script>

<template>
  <div class="workbench">
    <div class="titlebar" @dblclick="onClickToggleMaximize">
      <div class="titlebar-left">
        <img class="app-logo" :src="appIconUrl" alt="" aria-hidden="true" />
        <div class="app-title">Codava</div>
        <div ref="menubarEl" class="menubar">
          <button
            class="menu-btn"
            type="button"
            :class="{ 'is-open': openMenuKey === 'file' }"
            @click.stop="toggleMenu('file', $event)"
          >
            文件
          </button>
          <button
            class="menu-btn"
            type="button"
            :class="{ 'is-open': openMenuKey === 'edit' }"
            @click.stop="toggleMenu('edit', $event)"
          >
            编辑
          </button>
          <button
            class="menu-btn"
            type="button"
            :class="{ 'is-open': openMenuKey === 'view' }"
            @click.stop="toggleMenu('view', $event)"
          >
            视图
          </button>
          <button
            class="menu-btn"
            type="button"
            :class="{ 'is-open': openMenuKey === 'help' }"
            @click.stop="toggleMenu('help', $event)"
          >
            帮助
          </button>
          <button class="menu-btn" type="button" @click.stop="openSettings">设置</button>
          <button
            class="menu-btn menu-btn-scan"
            type="button"
            :disabled="isBusy || batchRunning || !selectedFilePath"
            @click.stop="runFileAudit"
          >
            <span v-if="busyKind === 'fileAudit'" class="scan-btn-spinner" aria-hidden="true" />
            {{ busyKind === 'fileAudit' ? '扫描中…' : '开始扫描' }}
          </button>
        </div>
        <div class="app-subtitle" :title="rootDir || ''">{{ rootDirName || '未选择目录' }}</div>
      </div>
      <div class="titlebar-spacer" />
      <div class="titlebar-controls">
        <button
          class="tb-btn"
          type="button"
          aria-label="最小化"
          title="最小化"
          @click.stop="onClickMinimize"
        >
          <svg class="tb-icon" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2 9.5H10" fill="none" stroke="currentColor" stroke-width="1.6" />
          </svg>
        </button>
        <button
          class="tb-btn"
          type="button"
          :aria-label="isMaximized ? '还原' : '最大化'"
          :title="isMaximized ? '还原' : '最大化'"
          @click.stop="onClickToggleMaximize"
        >
          <svg v-if="!isMaximized" class="tb-icon" viewBox="0 0 12 12" aria-hidden="true">
            <rect
              x="2.2"
              y="2.2"
              width="7.6"
              height="7.6"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
            />
          </svg>
          <svg v-else class="tb-icon" viewBox="0 0 12 12" aria-hidden="true">
            <path
              d="M4 3H10V9"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="square"
            />
            <rect
              x="2.2"
              y="4.2"
              width="6.6"
              height="6.6"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
            />
          </svg>
        </button>
        <button
          class="tb-btn tb-close"
          type="button"
          aria-label="关闭"
          title="关闭"
          @click.stop="onClickClose"
        >
          <svg class="tb-icon tb-icon-close" viewBox="0 0 12 12" aria-hidden="true">
            <path
              d="M3 3L9 9M9 3L3 9"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>
    </div>

    <div
      v-if="openMenuKey && menuAnchorRect"
      ref="menuPanelEl"
      class="menu-panel"
      :style="{ left: menuAnchorRect.left + 'px', top: menuAnchorRect.bottom + 'px' }"
      role="menu"
    >
      <template v-if="openMenuKey === 'file'">
        <button class="menu-item" type="button" role="menuitem" @click="onMenuOpenDirectory">
          打开…
        </button>
        <div class="menu-sep" />
        <button class="menu-item" type="button" role="menuitem" @click="onMenuExit">退出</button>
      </template>

      <template v-else-if="openMenuKey === 'edit'">
        <button
          class="menu-item"
          type="button"
          role="menuitemcheckbox"
          @click="onMenuToggleReadOnly"
        >
          <span class="menu-check">{{ diffRightReadOnly || isViewingHistoryFile ? '✓' : '' }}</span>
          只读模式
        </button>
      </template>

      <template v-else-if="openMenuKey === 'view'">
        <button class="menu-item is-disabled" type="button" role="menuitem" disabled>目录树</button>
        <button class="menu-item is-disabled" type="button" role="menuitem" disabled>重构</button>
      </template>

      <template v-else>
        <button class="menu-item" type="button" role="menuitem" @click="onMenuAbout">关于</button>
      </template>
    </div>

    <div class="workbench-body">
      <!-- 写回遮罩：覆盖整个工作区（包含侧栏与检查器） -->
      <div v-if="busyKind === 'write'" class="busy-overlay" role="status" aria-live="polite">
        <div class="busy-card">
          <div class="busy-spinner" aria-hidden="true" />
          <div class="busy-text">{{ busyText }}</div>
        </div>
      </div>

      <!-- 活动栏：固定 44px，不参与拖拽，只切换面板显隐与调用现有动作 -->
      <nav class="activity-bar">
        <button
          class="activity-btn"
          type="button"
          title="资源管理器"
          aria-label="资源管理器"
          :class="{ 'is-active': sidebarVisible }"
          :aria-pressed="sidebarVisible"
          @click="sidebarVisible = !sidebarVisible"
        >
          <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor">
            <path
              stroke-width="1.3"
              stroke-linejoin="round"
              d="M1.8 3.6h4l1.2 1.6h6.2a.8.8 0 0 1 .8.8v6a.8.8 0 0 1-.8.8H1.8a.8.8 0 0 1-.8-.8V4.4a.8.8 0 0 1 .8-.8Z"
            />
          </svg>
        </button>
        <button
          class="activity-btn"
          type="button"
          title="扫描结果"
          aria-label="扫描结果"
          :class="{ 'is-active': activeEditorTab === 'audit' }"
          :disabled="!hasOriginalAuditReport && !hasRefactoredAuditReport"
          @click="activeEditorTab = 'audit'"
        >
          <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor">
            <path
              stroke-width="1.3"
              stroke-linejoin="round"
              d="M8 1.6 13.4 3.4v4.2c0 3-2.2 5.4-5.4 6.4-3.2-1-5.4-3.4-5.4-6.4V3.4L8 1.6Z"
            />
            <path stroke-width="1.3" stroke-linecap="round" d="M5.8 8 7.4 9.6l3-3.2" />
          </svg>
        </button>
        <button
          class="activity-btn"
          type="button"
          title="检查器"
          aria-label="检查器"
          :class="{ 'is-active': inspectorVisible }"
          :aria-pressed="inspectorVisible"
          @click="inspectorVisible = !inspectorVisible"
        >
          <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor">
            <rect x="1.6" y="2.6" width="12.8" height="10.8" rx="1.4" stroke-width="1.3" />
            <path stroke-width="1.3" d="M9.6 2.6v10.8" />
          </svg>
        </button>
        <div class="activity-sep" />
        <button class="activity-btn" type="button" title="设置" aria-label="设置" @click="openSettings">
          <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor">
            <path stroke-width="1.3" stroke-linecap="round" d="M2.4 5h6M11.6 5h2M2.4 11h2M5.6 11h8" />
            <circle cx="10" cy="5" r="1.7" stroke-width="1.3" />
            <circle cx="4" cy="11" r="1.7" stroke-width="1.3" />
          </svg>
        </button>
        <button
          class="activity-btn activity-btn-scan"
          type="button"
          :title="busyKind === 'fileAudit' ? '扫描中…' : '开始扫描'"
          aria-label="开始扫描"
          :disabled="isBusy || batchRunning || !selectedFilePath"
          @click="runFileAudit"
        >
          <span v-if="busyKind === 'fileAudit'" class="scan-btn-spinner" aria-hidden="true" />
          <svg v-else viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor">
            <circle cx="7" cy="7" r="4.4" stroke-width="1.3" />
            <path stroke-width="1.4" stroke-linecap="round" d="M10.4 10.4 14 14" />
          </svg>
        </button>
      </nav>

      <Splitpanes class="workbench-split" :push-other-panes="false">
        <!-- 左侧栏：目录树 + 函数列表上下分段 -->
        <Pane v-if="sidebarVisible" :size="22" :min-size="14">
          <Splitpanes class="workbench-split" horizontal :push-other-panes="false">
            <Pane :size="55" :min-size="20">
              <div
                class="pane"
                :class="{ 'open-dir-clickable': !tree }"
                @click="!tree && openDirectory()"
              >
                <div class="pane-body">
                  <div class="section-title">
                    <div class="section-label">资源管理器</div>
                    <div class="section-value" :title="rootDir || ''">
                      {{ rootDirName || '未选择目录' }}
                    </div>
                  </div>
                  <div v-if="tree" class="explorer-toolbar actions">
                    <el-button
                      class="tool-btn"
                      size="small"
                      :loading="batchRunning && refactorMode === 'batch'"
                      :disabled="batchRunning"
                      @click.stop="runBatchRefactor"
                    >
                      批量重构
                    </el-button>
                    <el-button
                      class="tool-btn"
                      size="small"
                      :loading="batchAuditRunning"
                      :disabled="batchRunning || isBusy"
                      @click.stop="runBatchAudit"
                    >
                      批量扫描
                    </el-button>
                    <el-button
                      class="tool-btn"
                      size="small"
                      :disabled="!batchVisible && batchLogs.length === 0"
                      @click.stop="showProgressPanel"
                    >
                      显示进度
                    </el-button>
                  </div>
                  <div v-if="tree" class="scroll">
                    <el-tree
                      :data="tree.children || []"
                      node-key="id"
                      :props="{ label: 'label', children: 'children' }"
                      highlight-current
                      @node-click="onTreeNodeClick"
                    />
                  </div>
                  <div v-else class="open-dir-empty">
                    <div class="open-dir-title">打开目录</div>
                    <div class="open-dir-sub">点击左侧任意位置选择文件夹</div>
                  </div>
                </div>
              </div>
            </Pane>

            <Pane :size="45" :min-size="20">
              <div class="pane">
                <div class="pane-header">
                  <div class="title">函数列表</div>
                  <div class="spacer" />
                  <div class="actions actions-compact">
                    <el-button
                      class="tool-btn"
                      size="small"
                      :disabled="isRefactorBusy || !isSelectedSourceFile || !selectedFunction"
                      :loading="batchRunning && refactorMode === 'function'"
                      @click="runFunctionRefactor"
                    >
                      函数重构
                    </el-button>
                    <el-button
                      class="tool-btn"
                      size="small"
                      :disabled="isRefactorBusy || !isSelectedSourceFile"
                      :loading="batchRunning && refactorMode === 'file'"
                      @click="runFileRefactor"
                    >
                      文件重构
                    </el-button>
                  </div>
                </div>
                <div class="pane-body">
                  <div v-if="fileParsing" class="empty">正在解析文件…</div>
                  <div v-else-if="functionsList.length" class="scroll">
                    <el-table
                      :data="functionsList"
                      size="small"
                      height="100%"
                      :row-class-name="functionRowClassName"
                      @row-click="onFunctionRowClick"
                    >
                      <el-table-column prop="name" label="函数" min-width="88" show-overflow-tooltip />
                      <el-table-column label="行" width="72">
                        <template #default="{ row }">
                          <span class="lines-cell">{{ row.startLine }}-{{ row.endLine }}</span>
                        </template>
                      </el-table-column>
                      <el-table-column label="前" width="40" align="right">
                        <template #default="{ row }">
                          <span :class="getComplexityClass(row.originalComplexity)">
                            {{ row.originalComplexity ?? '-' }}
                          </span>
                        </template>
                      </el-table-column>
                      <el-table-column label="后" width="40" align="right">
                        <template #default="{ row }">
                          <span :class="getComplexityClass(row.refactoredComplexity)">
                            {{ row.refactoredComplexity ?? '-' }}
                          </span>
                        </template>
                      </el-table-column>
                    </el-table>
                  </div>
                  <div v-else class="empty">
                    {{
                      isViewingHistoryFile
                        ? '当前正在查看重构历史记录'
                        : '该文件未解析到函数（或尚未选择文件）'
                    }}
                  </div>
                </div>
              </div>
            </Pane>
          </Splitpanes>
        </Pane>

        <!-- 主区：中间列（编辑器 + 输出面板）+ 右侧检查器 -->
        <Pane :size="78" :min-size="46">
          <Splitpanes class="workbench-split" :push-other-panes="false">
            <Pane :size="74" :min-size="40">
              <div class="center-column">
                <div class="pane center-editor">
                  <div class="pane-header">
                    <div v-if="isViewingHistoryFile" class="title">重构历史记录</div>
                    <div v-else class="tabs-row">
                      <button
                        class="tab-btn"
                        :class="{ active: activeEditorTab === 'diff' }"
                        type="button"
                        @click="activeEditorTab = 'diff'"
                      >
                        代码对比
                      </button>
                      <button
                        class="tab-btn"
                        :class="{ active: activeEditorTab === 'audit' }"
                        type="button"
                        :disabled="!hasOriginalAuditReport && !hasRefactoredAuditReport"
                        @click="activeEditorTab = 'audit'"
                      >
                        扫描结果
                        <span
                          v-if="hasOriginalAuditReport || hasRefactoredAuditReport"
                          class="tab-badge"
                        >
                          {{ (hasOriginalAuditReport ? 1 : 0) + (hasRefactoredAuditReport ? 1 : 0) }}
                        </span>
                      </button>
                    </div>
                    <div class="path" :title="selectedFilePath || ''">
                      {{ selectedFilePath || '未选择文件' }}
                    </div>
                    <div class="actions">
                      <el-button
                        v-if="activeEditorTab === 'diff'"
                        class="tool-btn"
                        size="small"
                        :disabled="isRefactorBusy || !isSelectedSourceFile"
                        :loading="busyKind === 'write'"
                        @click="writeBackToFile"
                      >
                        写回到文件
                      </el-button>
                      <template v-if="activeEditorTab === 'audit'">
                        <el-button
                          v-for="col in auditColumns"
                          :key="col.scope"
                          class="tool-btn"
                          size="small"
                          @click="exportAuditReport(col.scope)"
                        >
                          {{
                            auditColumns.length === 1
                              ? '导出报告'
                              : col.scope === 'original'
                                ? '导出前'
                                : '导出后'
                          }}
                        </el-button>
                      </template>
                    </div>
                  </div>
                  <div class="pane-body">
                    <!-- 代码对比标签页 -->
                    <RefactorHistoryViewer v-if="isViewingHistoryFile" :content="modifiedContent" />
                    <template v-else-if="activeEditorTab === 'diff'">
                      <MonacoDiff
                        v-if="selectedFilePath"
                        v-model:modified="modifiedContent"
                        :original="originalContent"
                        :language="language"
                        :modified-read-only="diffRightReadOnly"
                        :reveal-line="revealLine"
                        :reveal-nonce="revealNonce"
                      />
                      <div v-else class="empty">在左侧选择一个文件</div>
                    </template>

                    <!-- 扫描结果标签页 -->
                    <div v-else class="audit-dual-col">
                      <div v-for="col in auditColumns" :key="col.scope" class="audit-col">
                        <div class="audit-col-header">
                          <span class="audit-col-title">{{ col.label }}</span>
                          <el-tag size="small" :type="getRiskTagType(deriveOverallRisk(col.report))">
                            {{ getRiskLabel(deriveOverallRisk(col.report)) }}
                          </el-tag>
                          <el-tag v-if="deriveHasVulnerabilities(col.report)" size="small" type="danger">
                            有漏洞
                          </el-tag>
                          <el-tag v-else size="small" type="success">安全</el-tag>
                        </div>
                        <div class="audit-col-body scroll">
                          <div class="audit-summary">{{ col.report.summary }}</div>
                          <div v-if="col.report.functionResults.length" class="audit-section">
                            <div class="audit-section-title">
                              函数扫描（{{ col.report.functionResults.length }}个）
                            </div>
                            <div
                              v-for="(funcEntry, funcIdx) in col.report.functionResults"
                              :key="col.scope + 'f' + funcIdx"
                              :ref="(el) => handleAuditEntryRef(el, col.scope, funcEntry.functionName, funcEntry.startLine)"
                              class="audit-finding func-entry"
                            >
                              <div class="audit-finding-head">
                                <span class="audit-finding-title">{{ funcEntry.functionName }}</span>
                                <span class="audit-finding-lines">📍{{ funcEntry.startLine }}-{{ funcEntry.endLine }}</span>
                                <el-tag size="small" :type="getRiskTagType(funcEntry.overallRisk)">
                                  {{ getRiskLabel(funcEntry.overallRisk) }}
                                </el-tag>
                                <el-tag v-if="funcEntry.hasVulnerabilities" size="small" type="danger">漏洞</el-tag>
                                <el-tag v-else size="small" type="success">安全</el-tag>
                              </div>
                              <div v-if="funcEntry.hasVulnerabilities && funcEntry.vulnerabilities?.length">
                                <div
                                  v-for="(vul, vulIdx) in funcEntry.vulnerabilities"
                                  :key="col.scope + 'vul' + vulIdx"
                                  class="func-finding"
                                >
                                  <div class="func-finding-head">
                                    <span class="func-finding-type">{{ vul.vulnerabilityType }}</span>
                                    <el-tag size="small" :type="getRiskTagType(vul.severity)">
                                      {{ getRiskLabel(vul.severity) }}
                                    </el-tag>
                                    <span class="audit-finding-lines">📍{{ vul.vulLineRange }}</span>
                                  </div>
                                  <div class="audit-finding-field"><span class="field-label">成因：</span><span>{{ vul.cause }}</span></div>
                                  <div class="audit-finding-field"><span class="field-label">危害：</span><span>{{ vul.potentialHarm }}</span></div>
                                  <div class="audit-finding-field"><span class="field-label">修复：</span><span>{{ vul.fixSuggestion }}</span></div>
                                </div>
                              </div>
                              <div v-if="!funcEntry.hasVulnerabilities && funcEntry.safeCodeAnalysis">
                                <div class="audit-finding-field"><span class="field-label">功能：</span><span>{{ funcEntry.safeCodeAnalysis.codeFunction }}</span></div>
                                <div class="audit-finding-field"><span class="field-label">评估：</span><span>{{ funcEntry.safeCodeAnalysis.securityAssessment }}</span></div>
                                <div class="audit-finding-field"><span class="field-label">风险：</span><span>{{ funcEntry.safeCodeAnalysis.potentialRisks }}</span></div>
                                <div class="audit-finding-field"><span class="field-label">建议：</span><span>{{ funcEntry.safeCodeAnalysis.improvementSuggestions }}</span></div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                      <div v-if="auditColumns.length === 0" class="empty audit-col-empty">尚未扫描</div>
                    </div>
                  </div>
                </div>

                <!-- 输出 / 进度面板：默认收起，由状态栏 Show All… 展开 -->
                <div v-if="batchDetailExpanded" class="pane bottom-panel">
                  <div class="pane-header">
                    <div class="title">
                      {{
                        refactorMode === 'function'
                          ? '函数重构详情'
                          : refactorMode === 'file'
                            ? '文件重构详情'
                            : refactorMode === 'audit'
                              ? '扫描详情'
                              : '批量重构详情'
                      }}
                    </div>
                    <div class="spacer" />
                    <button class="batch-mini-btn" type="button" @click="toggleBatchDetail">
                      收起
                    </button>
                  </div>
                  <div class="pane-body status-detail-body">
                    <div
                      v-if="refactorMode === 'batch' || refactorMode === 'audit'"
                      class="batch-stat-line"
                    >
                      文件：{{ batchFileIndex }}/{{ batchTotalFiles }}
                      <span class="batch-dot">·</span>
                      函数：{{ batchDoneFunctions }}/{{ batchTotalFunctions }}
                      <span class="batch-dot">·</span>
                      剩余：{{ batchEtaText }}
                    </div>
                    <div
                      v-if="refactorMode !== 'function'"
                      class="batch-stat-line batch-current"
                      :title="batchCurrentFile"
                    >
                      当前文件：{{ shortenPath(batchCurrentFile) || '—' }}
                    </div>
                    <div class="batch-stat-line batch-current">
                      当前函数：{{ batchCurrentFunction || '—' }}
                    </div>
                    <!-- 圈复杂度变化展示 -->
                    <div v-if="panelComplexity.original != null" class="batch-complexity-box">
                      <div class="batch-complexity-label">
                        {{ panelComplexity.label || '圈复杂度' }}
                      </div>
                      <div class="batch-complexity-values">
                        <span>{{ panelComplexity.original }}</span>
                        <span class="batch-complexity-arrow">→</span>
                        <span
                          :class="
                            panelComplexity.refactored != null &&
                            panelComplexity.refactored <= (panelComplexity.original ?? 0)
                              ? 'batch-complexity-good'
                              : 'batch-complexity-warn'
                          "
                        >
                          {{ panelComplexity.refactored ?? '—' }}
                        </span>
                        <span
                          v-if="
                            panelComplexity.refactored != null && panelComplexity.original != null
                          "
                          class="batch-complexity-delta"
                        >
                          ({{ panelComplexity.refactored - panelComplexity.original > 0 ? '+' : ''
                          }}{{ panelComplexity.refactored - panelComplexity.original }})
                        </span>
                      </div>
                    </div>
                    <div ref="batchLogEl" class="batch-log">
                      <div
                        v-for="log in batchLogs"
                        :key="log.id"
                        class="batch-log-item"
                        :class="'batch-log-' + log.level"
                      >
                        {{ log.text }}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </Pane>

            <!-- 右侧检查器：复杂度 / 风险 / 模型 合并为一张可折叠卡片 -->
            <Pane v-if="inspectorVisible" :size="26" :min-size="16">
              <div class="pane inspector">
                <div class="pane-header">
                  <div class="title">检查器</div>
                  <div class="spacer" />
                </div>
                <div class="pane-body inspector-body">
                  <section class="inspector-section">
                    <button
                      class="inspector-section-header"
                      type="button"
                      :aria-expanded="!inspectorCollapsed.complexity"
                      @click="toggleInspectorSection('complexity')"
                    >
                      <svg
                        class="inspector-chevron"
                        :class="{ 'is-collapsed': inspectorCollapsed.complexity }"
                        viewBox="0 0 12 12"
                        width="10"
                        height="10"
                        aria-hidden="true"
                      >
                        <path
                          d="M2.5 4.5 6 8l3.5-3.5"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.4"
                          stroke-linecap="round"
                        />
                      </svg>
                      <span class="inspector-section-title">文件圈复杂度</span>
                      <span
                        v-if="originalFileComplexity != null"
                        class="inspector-summary-chip"
                      >
                        {{ originalFileComplexity }}→{{ refactoredFileComplexity ?? '—' }}
                      </span>
                    </button>
                    <div
                      v-show="!inspectorCollapsed.complexity"
                      class="inspector-section-body"
                    >
                      <div v-if="selectedFilePath && !isViewingHistoryFile" class="complexity-info">
                        <div class="complexity-item">
                          <span class="complexity-label">重构前：</span>
                          <span :class="getComplexityClass(originalFileComplexity || undefined)">
                            {{ originalFileComplexity ?? '-' }}
                          </span>
                        </div>
                        <div v-if="hasRefactoredFileComplexity" class="complexity-item">
                          <span class="complexity-label">重构后：</span>
                          <span :class="getComplexityClass(refactoredFileComplexity || undefined)">
                            {{ refactoredFileComplexity }}
                          </span>
                        </div>
                        <div
                          v-if="
                            hasRefactoredFileComplexity &&
                            originalFileComplexity != null &&
                            refactoredFileComplexity != null
                          "
                          class="complexity-delta"
                        >
                          <span class="delta-label">变化：</span>
                          <span
                            :class="
                              getDeltaClass(refactoredFileComplexity - originalFileComplexity)
                            "
                          >
                            {{ refactoredFileComplexity - originalFileComplexity > 0 ? '+' : ''
                            }}{{ refactoredFileComplexity - originalFileComplexity }}
                          </span>
                        </div>
                      </div>
                      <div v-else class="empty">
                        {{ isViewingHistoryFile ? '指标已保存在记录中' : '未选择文件' }}
                      </div>
                    </div>
                  </section>

                  <section
                    class="inspector-section inspector-section--risk"
                    :class="{ 'is-collapsed': inspectorCollapsed.risk }"
                  >
                    <button
                      class="inspector-section-header"
                      type="button"
                      :aria-expanded="!inspectorCollapsed.risk"
                      @click="toggleInspectorSection('risk')"
                    >
                      <svg
                        class="inspector-chevron"
                        :class="{ 'is-collapsed': inspectorCollapsed.risk }"
                        viewBox="0 0 12 12"
                        width="10"
                        height="10"
                        aria-hidden="true"
                      >
                        <path
                          d="M2.5 4.5 6 8l3.5-3.5"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.4"
                          stroke-linecap="round"
                        />
                      </svg>
                      <span class="inspector-section-title">风险统计</span>
                    </button>
                    <div v-show="!inspectorCollapsed.risk" class="inspector-section-body">
                      <div v-if="auditColumns.length > 0" class="vul-stats-wrap">
                        <div
                          v-for="col in auditColumns"
                          :key="'vsc-' + col.scope"
                          class="vul-chart-group"
                        >
                          <div class="vul-chart-label">
                            {{ col.scope === 'original' ? '重构前' : '重构后' }}
                          </div>
                          <div
                            class="pie-chart"
                            :style="{
                              background: buildPieGradient(
                                col.scope === 'original' ? originalVulStats : refactoredVulStats
                              )
                            }"
                          />
                          <div class="vul-legend">
                            <div class="vul-legend-item vul-critical">
                              <span class="vul-dot" style="background:#F56C6C" />
                              <span class="vul-label">严重</span>
                              <span class="vul-num">{{
                                getVulCount(col.scope === 'original' ? originalVulStats : refactoredVulStats, 'critical')
                              }}</span>
                            </div>
                            <div class="vul-legend-item vul-high">
                              <span class="vul-dot" style="background:#E6A23C" />
                              <span class="vul-label">高</span>
                              <span class="vul-num">{{
                                getVulCount(col.scope === 'original' ? originalVulStats : refactoredVulStats, 'high')
                              }}</span>
                            </div>
                            <div class="vul-legend-item vul-medium">
                              <span class="vul-dot" style="background:#E6CD5B" />
                              <span class="vul-label">中</span>
                              <span class="vul-num">{{
                                getVulCount(col.scope === 'original' ? originalVulStats : refactoredVulStats, 'medium')
                              }}</span>
                            </div>
                            <div class="vul-legend-item vul-low">
                              <span class="vul-dot" style="background:#67C23A" />
                              <span class="vul-label">低</span>
                              <span class="vul-num">{{
                                getVulCount(col.scope === 'original' ? originalVulStats : refactoredVulStats, 'low')
                              }}</span>
                            </div>
                            <div class="vul-legend-item vul-safe">
                              <span class="vul-dot" style="background:#409EFF" />
                              <span class="vul-label">安全</span>
                              <span class="vul-num">{{
                                getVulCount(col.scope === 'original' ? originalVulStats : refactoredVulStats, 'safe')
                              }}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                      <div v-else class="empty">暂无扫描数据</div>
                    </div>
                  </section>

                  <section class="inspector-section">
                    <div class="inspector-section-header">
                      <button
                        class="inspector-section-toggle"
                        type="button"
                        :aria-expanded="!inspectorCollapsed.model"
                        @click="toggleInspectorSection('model')"
                      >
                        <svg
                          class="inspector-chevron"
                          :class="{ 'is-collapsed': inspectorCollapsed.model }"
                          viewBox="0 0 12 12"
                          width="10"
                          height="10"
                          aria-hidden="true"
                        >
                          <path
                            d="M2.5 4.5 6 8l3.5-3.5"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.4"
                            stroke-linecap="round"
                          />
                        </svg>
                        <span class="inspector-section-title">模型选择</span>
                        <span class="inspector-summary-chip" :title="selectedModelName">
                          {{ selectedModelName }}
                        </span>
                      </button>
                      <button
                        class="gear-btn"
                        type="button"
                        title="打开设置"
                        aria-label="打开设置"
                        @click="openSettings"
                      >
                        <svg
                          viewBox="0 0 16 16"
                          width="14"
                          height="14"
                          fill="none"
                          stroke="currentColor"
                        >
                          <path
                            stroke-width="1.3"
                            stroke-linecap="round"
                            d="M2.4 5h6M11.6 5h2M2.4 11h2M5.6 11h8"
                          />
                          <circle cx="10" cy="5" r="1.7" stroke-width="1.3" />
                          <circle cx="4" cy="11" r="1.7" stroke-width="1.3" />
                        </svg>
                      </button>
                    </div>
                    <div v-show="!inspectorCollapsed.model" class="inspector-section-body">
                      <div class="model-selector">
                        <el-select
                          v-if="availableModels.length"
                          v-model="selectedModelId"
                          placeholder="选择 AI 模型"
                          size="small"
                          style="width: 100%"
                        >
                          <el-option
                            v-for="model in availableModels"
                            :key="model.id"
                            :label="model.name"
                            :value="model.id"
                          />
                        </el-select>
                        <div v-else class="model-empty-hint">暂无模型，请先在设置中添加</div>
                        <div
                          v-if="selectedModelUrl"
                          class="model-url-hint"
                          :title="selectedModelUrl"
                        >
                          {{ selectedModelUrl }}
                        </div>
                      </div>
                    </div>
                  </section>
                </div>
              </div>
            </Pane>
          </Splitpanes>
        </Pane>
      </Splitpanes>
    </div>

    <!-- 常驻状态栏：左侧上下文摘要，右侧仅在有批量任务时出现进度段 -->
    <div class="status-bar">
      <div class="status-bar-inner">
        <span class="status-bar-item" :title="rootDir || ''">
          {{ rootDirName || '未选择目录' }}
        </span>
        <span class="status-bar-sep" />
        <span class="status-bar-item" :title="selectedModelName">{{ selectedModelName }}</span>
        <template v-if="originalFileComplexity != null">
          <span class="status-bar-sep" />
          <span class="status-bar-item">
            复杂度 {{ originalFileComplexity }}→{{ refactoredFileComplexity ?? '—' }}
          </span>
        </template>
        <div class="spacer" />
        <template v-if="batchVisible">
          <span
            class="status-bar-text"
            :title="batchCurrentFile ? batchCurrentFile + ' / ' + batchCurrentFunction : ''"
          >
            <span v-if="batchRunning" class="status-bar-spinner" aria-hidden="true" />
            {{ batchStatusText }}
          </span>
          <div class="status-bar-progress">
            <el-progress :percentage="batchOverallPercent" :stroke-width="6" :show-text="false" />
          </div>
          <span class="status-bar-percent">{{ batchOverallPercent }}%</span>
          <button
            v-if="batchRunning"
            class="status-bar-btn"
            type="button"
            :disabled="!canCancelPanel"
            @click="cancelCurrentRefactor"
          >
            {{ cancelRequested ? '取消中…' : '取消' }}
          </button>
          <button class="status-bar-btn" type="button" @click="toggleBatchDetail">
            {{ batchDetailExpanded ? 'Hide...' : 'Show All...' }}
          </button>
          <button
            v-if="!batchRunning"
            class="status-bar-btn status-bar-close"
            type="button"
            title="关闭"
            @click="closeBatchPanel"
          >
            ✕
          </button>
        </template>
      </div>
    </div>

    <SettingsDialog v-model:visible="settingsDialogVisible" @saved="onSettingsSaved" />
  </div>
</template>

<style scoped>
.workbench {
  width: 100vw;
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--color-background);
}

.titlebar {
  height: 44px;
  display: flex;
  align-items: center;
  background: var(--color-background-soft);
  border-bottom: 1px solid var(--ev-c-gray-3);
  user-select: none;
  -webkit-app-region: drag;
}

.titlebar-left {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 10px;
  overflow: hidden;
}

.app-logo {
  width: 28px;
  height: 28px;
  display: block;
  flex: 0 0 auto;
  margin-right: 2px;
}

.menubar {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 44px;
  -webkit-app-region: no-drag;
}

.menu-btn {
  height: 28px;
  padding: 0 10px;
  border: none;
  background: transparent;
  color: var(--ev-c-text-1);
  font-size: 12px;
  border-radius: 6px;
  cursor: pointer;
}

.menu-btn:hover {
  background: var(--ev-c-accent-bg);
}

.menu-btn.is-open {
  background: var(--ev-c-gray-2);
}

.menu-btn-scan {
  color: var(--el-color-primary);
  font-weight: 600;
}

.menu-btn-scan:hover:not(:disabled) {
  background: var(--el-color-primary-light-9);
}

.menu-btn-scan:disabled {
  color: var(--ev-c-text-3);
  cursor: not-allowed;
}

.scan-btn-spinner {
  display: inline-block;
  width: 10px;
  height: 10px;
  border: 1.5px solid var(--el-color-primary);
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  margin-right: 4px;
  vertical-align: middle;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* 编辑器标签页 */
.tabs-row {
  display: flex;
  align-items: center;
  gap: 2px;
}

.tab-btn {
  height: 26px;
  padding: 0 14px;
  border: none;
  background: transparent;
  color: var(--ev-c-text-2);
  font-size: 12px;
  border-radius: 4px 4px 0 0;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: color 0.15s, border-color 0.15s;
}

.tab-btn:hover:not(:disabled) {
  color: var(--ev-c-text-1);
}

.tab-btn.active {
  color: var(--el-color-primary);
  border-bottom-color: var(--el-color-primary);
  font-weight: 600;
}

.tab-btn:disabled {
  color: var(--ev-c-text-3);
  cursor: not-allowed;
}

.tab-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  margin-left: 4px;
  font-size: 10px;
  font-weight: 700;
  color: #fff;
  background: var(--el-color-primary);
  border-radius: 8px;
}

/* 审计双栏布局 */
.audit-dual-col {
  display: flex;
  height: 100%;
  gap: 1px;
  background: var(--ev-c-gray-3);
}

.audit-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--color-background-soft);
  min-width: 0;
}

.audit-col-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--ev-c-gray-2);
  flex-shrink: 0;
}

.audit-col-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--ev-c-text-1);
}

.audit-col-body {
  flex: 1;
  overflow-y: auto;
  padding: 6px 8px;
}

.audit-col-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--ev-c-text-3);
  width: 100%;
}

.menu-panel {
  position: fixed;
  min-width: 180px;
  background: var(--color-background-soft);
  border: 1px solid var(--ev-c-gray-3);
  box-shadow: var(--ev-shadow-pop);
  border-radius: var(--ev-radius-card);
  padding: 6px;
  z-index: 1000;
  -webkit-app-region: no-drag;
}

.menu-item {
  width: 100%;
  height: 28px;
  padding: 0 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--ev-c-text-1);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.menu-item:hover {
  background: var(--ev-c-accent-bg);
  color: var(--ev-c-accent);
}

.menu-item.is-disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.menu-sep {
  height: 1px;
  margin: 6px 4px;
  background: var(--ev-c-gray-3);
}

.menu-check {
  width: 16px;
  display: inline-flex;
  justify-content: center;
  color: var(--ev-c-text-1);
}

.app-title {
  font-size: 15px;
  font-weight: 700;
  background: linear-gradient(90deg, #4f46e5, #7c3aed);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  white-space: nowrap;
}

.app-subtitle {
  font-size: 12px;
  color: var(--ev-c-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 40vw;
}

.titlebar-spacer {
  flex: 1;
}

.titlebar-controls {
  display: flex;
  height: 44px;
  -webkit-app-region: no-drag;
}

.tb-btn {
  width: 46px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--ev-c-text-1);
  cursor: pointer;
}

.tb-btn:hover {
  background: var(--ev-c-gray-2);
}

.tb-btn:active {
  background: var(--ev-c-gray-1);
}

.tb-close:hover {
  background: #c42b1c;
  color: #fff;
}

.tb-icon {
  width: 12px;
  height: 12px;
  display: block;
}

.tb-icon-close {
  width: 12px;
  height: 12px;
}

.workbench-split {
  width: 100%;
  flex: 1;
  min-width: 0;
  min-height: 0;
}

/* 工作区主体：活动栏 + 分栏区，并作为写回遮罩的定位容器 */
.workbench-body {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: stretch;
  gap: var(--ev-space-2);
  padding: var(--ev-space-2);
  position: relative;
}

/* 活动栏：固定宽度，不参与拖拽 */
.activity-bar {
  flex: 0 0 var(--ev-activity-w);
  width: var(--ev-activity-w);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--ev-space-1);
  padding: var(--ev-space-2) 0;
  background: var(--color-background-soft);
  border: 1px solid var(--ev-c-gray-3);
  border-radius: var(--ev-radius-card);
  box-shadow: var(--ev-shadow-card);
}

.activity-btn {
  position: relative;
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--ev-space-1);
  border: none;
  border-radius: var(--ev-radius-ctrl);
  background: transparent;
  color: var(--ev-c-text-2);
  cursor: pointer;
}

.activity-btn:hover:not(:disabled) {
  background: var(--ev-c-accent-bg);
  color: var(--ev-c-accent);
}

.activity-btn:disabled {
  color: var(--ev-c-text-4);
  cursor: not-allowed;
}

/* 当前项：靛蓝图标 + 浅底 + 左侧 2px 指示条 */
.activity-btn.is-active {
  background: var(--ev-c-accent-bg);
  color: var(--ev-c-accent);
}

.activity-btn.is-active::before {
  content: '';
  position: absolute;
  left: -5px;
  top: 6px;
  bottom: 6px;
  width: 2px;
  border-radius: 2px;
  background: var(--ev-c-accent);
}

.activity-sep {
  width: 22px;
  height: 1px;
  margin: var(--ev-space-1) 0;
  background: var(--ev-c-gray-2);
}

/* 中间列：编辑区 + 输出面板上下堆叠 */
.center-column {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--ev-space-2);
}

.center-editor {
  flex: 1 1 auto;
  min-height: 0;
}

.busy-overlay {
  position: absolute;
  inset: 0;
  background: rgba(30, 36, 48, 0.22);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
}

.busy-card {
  background: var(--color-background-soft);
  border: 1px solid var(--ev-c-gray-3);
  border-radius: 8px;
  padding: 14px 16px;
  min-width: 240px;
  max-width: 70%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.busy-text {
  font-size: 12px;
  color: var(--ev-c-text-1);
  text-align: center;
  line-height: 1.4;
}

.busy-actions {
  display: flex;
  justify-content: center;
  gap: 8px;
}

.busy-spinner {
  width: 18px;
  height: 18px;
  border-radius: 999px;
  border: 2px solid rgba(79, 70, 229, 0.2);
  border-top-color: var(--ev-c-accent);
  animation: busy-spin 0.9s linear infinite;
}

@keyframes busy-spin {
  to {
    transform: rotate(360deg);
  }
}

.open-dir-clickable {
  cursor: pointer;
}

.open-dir-clickable * {
  cursor: pointer;
}

.open-dir-empty {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--ev-c-text-2);
}

.open-dir-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--ev-c-text-1);
}

.open-dir-sub {
  font-size: 12px;
  color: var(--ev-c-text-2);
}

.pane {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--color-background-soft);
  border: 1px solid var(--ev-c-gray-3);
  border-radius: var(--ev-radius-card);
  box-shadow: var(--ev-shadow-card);
  overflow: hidden;
}

.pane-header {
  /* 窄栏下允许换行兜底，保证按钮永不被卡片边界裁切 */
  min-height: var(--ev-header-h);
  flex: 0 0 auto;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  align-content: center;
  gap: var(--ev-space-2);
  padding: 5px var(--ev-space-3);
  border-bottom: 1px solid var(--ev-c-gray-3);
}

.pane-header .title {
  flex: 0 0 auto;
  white-space: nowrap;
  font-size: var(--ev-font-sm);
  font-weight: 600;
  color: var(--ev-c-text-1);
}

.pane-header .tabs-row {
  flex: 0 0 auto;
}

.pane-header .actions {
  flex: 0 0 auto;
  gap: var(--ev-space-1);
}

/* 侧栏宽度有限，函数/文件重构按钮用紧凑尺寸以尽量与标题同排 */
.pane-header .actions-compact :deep(.el-button.tool-btn) {
  padding: 0 7px;
  font-size: var(--ev-font-xs);
}

.spacer {
  flex: 1;
}

.pane-header .path {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ev-c-text-2);
  font-size: 12px;
}

.pane-header .actions {
  display: flex;
  gap: 8px;
}

.actions :deep(.el-button.tool-btn) {
  height: 24px;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid var(--ev-c-gray-3);
  background: var(--ev-button-alt-bg);
  color: var(--ev-button-alt-text);
}

.actions :deep(.el-button.tool-btn:hover) {
  background: var(--ev-button-alt-hover-bg);
  color: var(--ev-button-alt-hover-text);
}

.actions :deep(.el-button.tool-btn.is-disabled) {
  opacity: 0.55;
}

.pane-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.section-title {
  height: var(--ev-header-h);
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--ev-space-3);
  border-bottom: 1px solid var(--ev-c-gray-3);
  background: var(--color-background-soft);
}

.section-label {
  font-size: var(--ev-font-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--ev-c-text-2);
}

.section-value {
  font-size: var(--ev-font-xs);
  color: var(--ev-c-text-1);
  max-width: 70%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.explorer-toolbar {
  flex: 0 0 auto;
  display: flex;
  /* 侧栏拖窄时按钮换行而不是被裁掉 */
  flex-wrap: wrap;
  gap: var(--ev-space-2);
  padding: var(--ev-space-2) var(--ev-space-3);
  border-bottom: 1px solid var(--ev-c-gray-3);
}

/* 常驻状态栏：作为 workbench 的最后一项，不再 fixed */
.status-bar {
  flex: 0 0 auto;
  width: 100%;
  z-index: 2000;
}

.status-bar-inner {
  height: var(--ev-status-h);
  display: flex;
  align-items: center;
  gap: var(--ev-space-2);
  padding: 0 var(--ev-space-2);
  background: var(--color-background-soft);
  border-top: 1px solid var(--ev-c-gray-3);
}

/* 状态栏上下文摘要：目录 / 模型 / 复杂度 */
.status-bar-item {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--ev-font-xs);
  color: var(--ev-c-text-2);
}

.status-bar-sep {
  flex: 0 0 auto;
  width: 1px;
  height: 12px;
  background: var(--ev-c-gray-3);
}

.status-bar-text {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--ev-c-text-1);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.status-bar-spinner {
  flex: 0 0 auto;
  width: 12px;
  height: 12px;
  border-radius: 999px;
  border: 2px solid rgba(79, 70, 229, 0.2);
  border-top-color: var(--ev-c-accent);
  animation: busy-spin 0.9s linear infinite;
}

.status-bar-progress {
  flex: 1 1 auto;
  min-width: 60px;
}

.status-bar-percent {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--ev-c-text-2);
  min-width: 34px;
  text-align: right;
}

.status-bar-btn {
  flex: 0 0 auto;
  height: 20px;
  padding: 0 8px;
  border: 1px solid var(--ev-c-gray-3);
  border-radius: 4px;
  background: transparent;
  color: var(--ev-c-text-1);
  font-size: 11px;
  cursor: pointer;
}

.status-bar-btn:hover:not(:disabled) {
  background: var(--ev-c-gray-2);
}

.status-bar-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.status-bar-close {
  padding: 0 6px;
}

/* Show All… 展开的详细面板（在状态栏上方） */
/* 输出 / 进度面板：内嵌在中间列底部，不再使用悬浮遮罩 */
.bottom-panel {
  flex: 0 0 200px;
  height: 200px;
}

.status-detail-body {
  padding: var(--ev-space-2) var(--ev-space-3);
  display: flex;
  flex-direction: column;
  gap: var(--ev-space-2);
  overflow: auto;
}

.batch-mini-btn {
  height: 22px;
  padding: 0 10px;
  border: 1px solid var(--ev-c-gray-3);
  border-radius: 4px;
  background: transparent;
  color: var(--ev-c-text-1);
  font-size: 12px;
  cursor: pointer;
}

.batch-mini-btn:hover {
  background: var(--ev-c-gray-3);
}

.batch-stat-line {
  font-size: 12px;
  color: var(--ev-c-text-2);
}

.batch-current {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ev-c-text-1);
}

.batch-dot {
  margin: 0 4px;
  color: var(--ev-c-text-2);
}

.batch-log {
  flex: 1 1 auto;
  min-height: 60px;
  overflow: auto;
  padding: var(--ev-space-1) var(--ev-space-2);
  border: 1px solid var(--ev-c-gray-3);
  border-radius: var(--ev-radius-ctrl);
  background: var(--color-background);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: var(--ev-font-xs);
  line-height: 1.5;
}

.batch-log-item {
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--ev-c-text-2);
}

.batch-log-success {
  color: var(--ev-c-good);
}

.batch-log-failed {
  color: var(--ev-c-bad);
}

.batch-log-skipped {
  color: var(--ev-c-warn);
}

.batch-complexity-box {
  padding: 6px 8px;
  border: 1px solid var(--ev-c-gray-3);
  border-radius: 6px;
  background: var(--color-background-mute);
}

.batch-complexity-label {
  font-size: 11px;
  color: var(--ev-c-text-2);
  margin-bottom: 2px;
}

.batch-complexity-values {
  font-size: 13px;
  font-weight: 600;
  color: var(--ev-c-text-1);
  display: flex;
  align-items: center;
  gap: 6px;
}

.batch-complexity-arrow {
  color: var(--ev-c-text-2);
  font-weight: 400;
}

.batch-complexity-good {
  color: var(--ev-c-good);
}

.batch-complexity-warn {
  color: var(--ev-c-warn);
}

.batch-complexity-delta {
  font-size: 11px;
  font-weight: 400;
  color: var(--ev-c-text-2);
}

.scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.empty {
  padding: 12px;
  color: var(--ev-c-text-2);
}

/* 函数列表表格：浅色卡片内保持透底，文本/悬停/选中态统一用主题变量 */
:deep(.el-table .is-selected) {
  background-color: var(--ev-c-accent-bg);
}

:deep(.el-table .is-selected td.el-table__cell) {
  background-color: var(--ev-c-accent-bg);
  color: var(--ev-c-accent);
}

:deep(.el-table__body tr:hover > td.el-table__cell) {
  background-color: var(--ev-c-accent-bg);
}

:deep(.el-table),
:deep(.el-table__inner-wrapper),
:deep(.el-table__header-wrapper),
:deep(.el-table__body-wrapper),
:deep(.el-table__expanded-cell),
:deep(.el-table tr),
:deep(.el-table td.el-table__cell),
:deep(.el-table th.el-table__cell) {
  background-color: transparent;
  color: var(--ev-c-text-1);
}

:deep(.el-table th.el-table__cell) {
  color: var(--ev-c-text-2);
  font-weight: 600;
}

:deep(.el-table td.el-table__cell),
:deep(.el-table th.el-table__cell.is-leaf) {
  border-bottom-color: var(--ev-c-gray-3);
}

:deep(.el-table__empty-block),
:deep(.el-table__empty-text) {
  color: var(--ev-c-text-3);
}

/* 分割条：浅色主题下改为透明间隙，让两侧卡片自然分隔 */
:deep(.splitpanes__splitter) {
  background: var(--ev-c-gray-3);
  position: relative;
}

:deep(.splitpanes--vertical > .splitpanes__splitter) {
  width: var(--ev-gutter);
  background: transparent;
}

:deep(.splitpanes--horizontal > .splitpanes__splitter) {
  height: var(--ev-gutter);
  background: transparent;
}

/* 通过伪元素扩大命中区域，避免视觉上变粗 */
:deep(.splitpanes__splitter::before) {
  content: '';
  position: absolute;
  inset: -4px;
}

:deep(.splitpanes__splitter:hover) {
  background: var(--ev-c-accent-bg);
}

/* 目录树：浅色卡片下提高节点文字对比度 */
:deep(.el-tree),
:deep(.el-tree-node) {
  background: transparent;
  color: var(--ev-c-text-1);
}

:deep(.el-tree-node__content) {
  white-space: nowrap;
  border-radius: 6px;
  color: var(--ev-c-text-1);
}

:deep(.el-tree-node__label),
:deep(.el-tree-node__expand-icon) {
  color: var(--ev-c-text-1);
}

:deep(.el-tree-node__expand-icon.is-leaf) {
  color: var(--ev-c-text-4);
}

:deep(.el-tree-node__content:hover) {
  background: var(--ev-c-accent-bg);
}

:deep(.el-tree--highlight-current .el-tree-node.is-current > .el-tree-node__content) {
  background: var(--ev-c-accent-bg);
}

:deep(.el-tree--highlight-current .el-tree-node.is-current > .el-tree-node__content .el-tree-node__label) {
  color: var(--ev-c-accent);
  font-weight: 600;
}

/* 圈复杂度样式（浅色背景下用加深的语义色） */
.complexity-low {
  color: var(--ev-c-good);
  font-weight: 500;
}

.complexity-medium {
  color: var(--ev-c-warn);
  font-weight: 500;
}

.complexity-high {
  color: var(--ev-c-bad);
  font-weight: 500;
}

.delta-positive {
  color: var(--ev-c-bad);
  font-weight: 500;
}

.delta-negative {
  color: var(--ev-c-good);
  font-weight: 500;
}

.delta-zero {
  color: var(--ev-c-text-2);
}

.complexity-info {
  padding: var(--ev-space-3);
  display: flex;
  flex-direction: column;
  gap: var(--ev-space-2);
}

.complexity-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.complexity-label {
  color: var(--ev-c-text-2);
  font-size: 12px;
}

.complexity-delta {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--ev-c-gray-3);
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.delta-label {
  color: var(--ev-c-text-2);
  font-size: 12px;
}

.model-selector {
  padding: var(--ev-space-3);
}

.model-selector :deep(.el-select) {
  width: 100%;
}

/* 模型选择框：白底 + 浅边框 + 深色文本（弹层样式由 base.css 全局接管） */
.model-selector :deep(.el-select__wrapper) {
  background-color: var(--color-background-soft);
  box-shadow: 0 0 0 1px var(--ev-c-gray-3) inset;
}

.model-selector :deep(.el-select__wrapper:hover) {
  box-shadow: 0 0 0 1px var(--ev-c-accent-soft) inset;
}

.model-selector :deep(.el-select__wrapper.is-focused) {
  box-shadow: 0 0 0 1px var(--ev-c-accent) inset;
}

.model-selector :deep(.el-select__selected-item),
.model-selector :deep(.el-select__placeholder) {
  color: var(--ev-c-text-1);
}

.model-selector :deep(.el-select__placeholder.is-transparent) {
  color: var(--ev-c-text-3);
}

.model-selector :deep(.el-select__caret) {
  color: var(--ev-c-text-2);
}

/* ===== 检查器：单张卡片内多个可折叠 section ===== */
.inspector-body {
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  overflow-x: hidden;
}

/* 默认按内容高度排；风险段例外，让它吃掉检查器剩余空白 */
.inspector-section {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.inspector-section--risk {
  /* 只长不缩：内容变高时交给 .inspector-body 的 overflow-y 滚动，避免饼图被压扁 */
  flex: 1 0 auto;
}

/* 折叠时退回内容高度，否则 flex-grow 会在标题下方留空洞 */
.inspector-section--risk.is-collapsed {
  flex: 0 0 auto;
}

.inspector-section--risk .inspector-section-body {
  flex: 1 0 auto;
  display: flex;
  flex-direction: column;
}

.inspector-section--risk .empty {
  margin: auto;
}

.inspector-section + .inspector-section {
  border-top: 1px solid var(--ev-c-gray-3);
}

.inspector-section-header {
  width: 100%;
  height: var(--ev-header-h);
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--ev-space-2);
  padding: 0 var(--ev-space-3);
  border: none;
  background: var(--el-fill-color-light);
  color: var(--ev-c-text-1);
}

button.inspector-section-header {
  cursor: pointer;
  text-align: left;
}

.inspector-section-header:hover {
  background: var(--ev-c-accent-bg);
}

.inspector-section-toggle {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--ev-space-2);
  height: var(--ev-header-h);
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: left;
}

.inspector-chevron {
  flex: 0 0 auto;
  color: var(--ev-c-text-2);
  transition: transform 0.15s ease;
}

.inspector-chevron.is-collapsed {
  transform: rotate(-90deg);
}

.inspector-section-title {
  flex: 0 0 auto;
  white-space: nowrap;
  font-size: var(--ev-font-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--ev-c-text-2);
}

/* section 标题右侧摘要：走主题变量，不写死颜色 */
.inspector-summary-chip {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-left: auto;
  padding: 1px var(--ev-space-2);
  border-radius: 999px;
  background: var(--ev-c-accent-bg);
  color: var(--ev-c-accent);
  font-size: var(--ev-font-xs);
  font-weight: 600;
}

.inspector-section-body {
  padding: var(--ev-space-1) 0;
}

.gear-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--ev-c-text-2);
  cursor: pointer;
  border-radius: 4px;
  padding: 0;
}

.gear-btn:hover {
  background: var(--ev-c-accent-bg);
  color: var(--ev-c-accent);
}

.model-empty-hint {
  padding: 8px 0;
  font-size: 12px;
  color: var(--ev-c-text-2);
}

.model-url-hint {
  margin-top: 6px;
  font-size: 11px;
  color: var(--ev-c-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 风险统计 */
.vul-stats-wrap {
  display: flex;
  flex: 1 0 auto;
  gap: var(--ev-space-3);
  padding: var(--ev-space-2) var(--ev-space-3);
  overflow-x: auto;
}

.vul-chart-group {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

.vul-chart-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--ev-c-text-2);
  flex-shrink: 0;
}

.pie-chart {
  /* 随栏宽自适应放大，不再写死 58px；上限防止检查器拉宽时失衡 */
  width: 100%;
  max-width: 120px;
  min-width: 56px;
  height: auto;
  aspect-ratio: 1 / 1;
  border-radius: 50%;
  flex-shrink: 0;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
}

.vul-legend {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* 函数表「行」列：空间不足时宁可截断也不折行 */
.lines-cell {
  font-size: var(--ev-font-xs);
  white-space: nowrap;
}

.vul-legend-item {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  color: var(--ev-c-text-2);
}

.vul-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.vul-label {
  flex-shrink: 0;
}

.vul-num {
  font-weight: 600;
  color: var(--ev-c-text-1);
  flex-shrink: 0;
  margin-left: 2px;
}

.audit-scroll {
  padding: 10px 12px;
  gap: 12px;
}

.audit-report {
  padding: 10px 12px;
  border: 1px solid var(--ev-c-gray-3);
  border-radius: 8px;
  background: var(--ev-c-white-soft);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.audit-report + .audit-report {
  margin-top: 12px;
}

.audit-report-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.audit-report-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--ev-c-text-1);
}

.audit-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  font-size: 11px;
  color: var(--ev-c-text-2);
}

.audit-summary {
  font-size: 12px;
  color: var(--ev-c-text-1);
  line-height: 1.5;
}

.audit-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.audit-section-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--ev-c-text-2);
  letter-spacing: 0.4px;
}

.audit-list {
  margin: 0;
  padding-left: 16px;
  color: var(--ev-c-text-1);
  font-size: 12px;
  line-height: 1.45;
}

.audit-finding {
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid var(--ev-c-gray-3);
  background: var(--ev-c-white-soft);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.audit-finding-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.audit-finding-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--ev-c-text-1);
}

.audit-finding-lines {
  font-size: 12px;
  color: var(--ev-c-text-2);
  margin-left: 8px;
  font-family: monospace;
}

.audit-finding-desc,
.audit-finding-evidence,
.audit-finding-reco {
  font-size: 12px;
  line-height: 1.45;
  color: var(--ev-c-text-2);
  white-space: pre-wrap;
}

.audit-finding-field {
  font-size: 12px;
  line-height: 1.45;
  color: var(--ev-c-text-2);
}

.audit-finding-field .field-label {
  font-weight: 600;
  color: var(--ev-c-text-1);
}

/* 逐函数扫描结果 */
.func-entry {
  border-left: 3px solid var(--ev-c-gray-1);
}

.func-finding {
  margin-left: 12px;
  margin-top: 8px;
  padding: 8px;
  border: 1px solid var(--ev-c-gray-3);
  border-radius: 6px;
  background: var(--color-background-soft);
}

.func-finding-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.func-finding-type {
  font-size: 12px;
  font-weight: 600;
  color: var(--el-color-danger);
}
.qg-info {
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.qg-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.qg-label {
  color: var(--ev-c-text-2);
  min-width: 72px;
}

.qg-pass {
  color: var(--ev-c-good);
  font-weight: 500;
}

.qg-fail {
  color: var(--ev-c-bad);
  font-weight: 500;
}

.qg-summary-bar {
  display: flex;
  gap: 12px;
  padding: 4px 0;
  font-size: 12px;
  font-weight: 500;
}

.qg-summary-pass { color: var(--ev-c-good); }
.qg-summary-kept { color: var(--ev-c-text-2); }
.qg-summary-attempt { color: var(--ev-c-text-2); font-size: 11px; margin-left: auto; }

.qg-fn-list {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.qg-fn-row {
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.15s;
}

.qg-fn-row:hover {
  background: var(--color-background-mute);
}

.qg-fn-row.is-expanded {
  background: var(--color-background-mute);
}

.qg-fn-row-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  font-size: 12px;
}

.qg-fn-status {
  font-size: 11px;
  width: 14px;
}

.qg-fn-name {
  color: var(--ev-c-text-1);
  font-family: monospace;
  flex: 1;
}

.qg-fn-result {
  font-size: 11px;
}

.qg-fn-arrow {
  color: var(--ev-c-text-2);
  font-size: 10px;
  width: 12px;
}

.qg-fn-detail {
  padding: 6px 8px 8px 28px;
  font-size: 11px;
  border-top: 1px solid var(--ev-c-gray-3);
}

.qg-detail-block {
  margin-bottom: 6px;
}

.qg-detail-title {
  font-weight: 500;
  color: var(--ev-c-bad);
  margin-bottom: 3px;
}

.qg-detail-line {
  margin: 2px 0;
}

.qg-detail-line code {
  background: var(--ev-c-white-mute);
  padding: 1px 4px;
  border-radius: 4px;
  font-size: 11px;
  word-break: break-all;
}

.qg-detail-issues {
  margin: 2px 0;
  padding-left: 16px;
}

.qg-detail-issues li {
  margin: 2px 0;
  color: var(--ev-c-text-1);
}

.qg-detail-suggestion {
  color: var(--ev-c-warn);
  margin-top: 4px;
}

.qg-detail-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 3px 0;
}

.qg-detail-label {
  color: var(--ev-c-text-2);
  min-width: 64px;
}

.qg-detail-sub {
  margin: 3px 0 6px 10px;
  padding-left: 8px;
  border-left: 2px solid var(--ev-c-gray-3);
}

</style>
