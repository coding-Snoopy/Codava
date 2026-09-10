import { randomUUID } from 'crypto'
import * as path from 'path'
import * as fs from 'fs/promises'

export type RefactorScope = 'function' | 'file'

export type RefactorCodeSnapshot = {
  code: string
  lineCount: number
  fileComplexity: number
  targetComplexity?: number
}

export type RefactorTarget = {
  functionName: string
  functionOccurrence: number
  startLineBefore: number
  endLineBefore: number
  startLineAfter?: number
  endLineAfter?: number
}

export type AppendRefactorHistoryInput = {
  sessionId: string
  sourceFilePath: string
  language: string
  scope: RefactorScope
  modelName: string
  instruction: string
  target?: RefactorTarget
  before: RefactorCodeSnapshot
  after: RefactorCodeSnapshot
}

export type RefactorHistoryRecord = {
  id: string
  sessionId: string
  createdAt: string
  scope: RefactorScope
  status: 'generated' | 'applied'
  target?: RefactorTarget
  model: {
    name: string
  }
  instruction: string
  before: RefactorCodeSnapshot
  after: RefactorCodeSnapshot
  delta: {
    lineCount: number
    fileComplexity: number
    targetComplexity?: number
  }
  writeBack: {
    applied: boolean
    appliedAt: string | null
  }
}

export type RefactorHistoryDocument = {
  schemaVersion: 1
  sourceFile: {
    relativePath: string
    language: string
  }
  records: RefactorHistoryRecord[]
}

type ResolvedHistoryPath = {
  historyPath: string
  relativePath: string
}

const SCHEMA_VERSION = 1 as const
const HISTORY_DIRECTORY = '.aosp-refactor'
const writeQueues = new Map<string, Promise<unknown>>()

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join('/')
}

function resolveHistoryPath(projectRoot: string, sourceFilePath: string): ResolvedHistoryPath {
  const resolvedRoot = path.resolve(projectRoot)
  const resolvedSource = path.resolve(sourceFilePath)
  const relativePath = path.relative(resolvedRoot, resolvedSource)

  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`)
  ) {
    throw new Error('历史记录保存失败：源文件不在当前项目目录内')
  }

  const firstSegment = relativePath.split(path.sep)[0]
  if (firstSegment === HISTORY_DIRECTORY) {
    throw new Error('历史记录保存失败：不能记录历史目录中的文件')
  }

  return {
    relativePath: normalizeRelativePath(relativePath),
    historyPath: path.join(resolvedRoot, HISTORY_DIRECTORY, 'history', `${relativePath}.json`)
  }
}

function isHistoryDocument(value: unknown): value is RefactorHistoryDocument {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<RefactorHistoryDocument>
  return (
    candidate.schemaVersion === SCHEMA_VERSION &&
    !!candidate.sourceFile &&
    typeof candidate.sourceFile.relativePath === 'string' &&
    typeof candidate.sourceFile.language === 'string' &&
    Array.isArray(candidate.records)
  )
}

async function readHistoryDocument(
  historyPath: string,
  relativePath: string,
  language: string
): Promise<RefactorHistoryDocument> {
  try {
    const content = await fs.readFile(historyPath, 'utf8')
    const parsed: unknown = JSON.parse(content)
    if (!isHistoryDocument(parsed)) {
      throw new Error('文件结构或版本不受支持')
    }
    if (parsed.sourceFile.relativePath !== relativePath) {
      throw new Error('记录的源文件路径与当前文件不一致')
    }
    return parsed
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return {
        schemaVersion: SCHEMA_VERSION,
        sourceFile: { relativePath, language },
        records: []
      }
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`无法读取历史记录 ${historyPath}：${message}`)
  }
}

async function writeJsonAtomically(
  historyPath: string,
  document: RefactorHistoryDocument
): Promise<void> {
  const directory = path.dirname(historyPath)
  await fs.mkdir(directory, { recursive: true })

  const temporaryPath = path.join(directory, `.${path.basename(historyPath)}.${randomUUID()}.tmp`)
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    await fs.rename(temporaryPath, historyPath)
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

async function withWriteQueue<T>(historyPath: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(historyPath) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(task)
  writeQueues.set(historyPath, current)

  try {
    return await current
  } finally {
    if (writeQueues.get(historyPath) === current) {
      writeQueues.delete(historyPath)
    }
  }
}

function buildRecord(input: AppendRefactorHistoryInput): RefactorHistoryRecord {
  const beforeTargetComplexity = input.before.targetComplexity
  const afterTargetComplexity = input.after.targetComplexity
  const targetComplexityDelta =
    beforeTargetComplexity === undefined || afterTargetComplexity === undefined
      ? undefined
      : afterTargetComplexity - beforeTargetComplexity

  return {
    id: randomUUID(),
    sessionId: input.sessionId,
    createdAt: new Date().toISOString(),
    scope: input.scope,
    status: 'generated',
    target: input.target,
    model: { name: input.modelName },
    instruction: input.instruction,
    before: input.before,
    after: input.after,
    delta: {
      lineCount: input.after.lineCount - input.before.lineCount,
      fileComplexity: input.after.fileComplexity - input.before.fileComplexity,
      ...(targetComplexityDelta === undefined ? {} : { targetComplexity: targetComplexityDelta })
    },
    writeBack: {
      applied: false,
      appliedAt: null
    }
  }
}

export async function appendRefactorHistory(
  projectRoot: string,
  input: AppendRefactorHistoryInput
): Promise<{ recordId: string; historyPath: string }> {
  const resolved = resolveHistoryPath(projectRoot, input.sourceFilePath)

  return await withWriteQueue(resolved.historyPath, async () => {
    const document = await readHistoryDocument(
      resolved.historyPath,
      resolved.relativePath,
      input.language
    )
    const record = buildRecord(input)
    document.sourceFile.language = input.language
    document.records.push(record)
    await writeJsonAtomically(resolved.historyPath, document)
    return { recordId: record.id, historyPath: resolved.historyPath }
  })
}

export async function markRefactorHistoryApplied(
  projectRoot: string,
  sourceFilePath: string,
  sessionId: string
): Promise<{ updatedCount: number; historyPath: string }> {
  const resolved = resolveHistoryPath(projectRoot, sourceFilePath)

  return await withWriteQueue(resolved.historyPath, async () => {
    const document = await readHistoryDocument(resolved.historyPath, resolved.relativePath, '')
    const appliedAt = new Date().toISOString()
    let updatedCount = 0

    for (const record of document.records) {
      if (record.sessionId !== sessionId || record.writeBack.applied) continue
      record.status = 'applied'
      record.writeBack = { applied: true, appliedAt }
      updatedCount++
    }

    if (updatedCount > 0) {
      await writeJsonAtomically(resolved.historyPath, document)
    }
    return { updatedCount, historyPath: resolved.historyPath }
  })
}
