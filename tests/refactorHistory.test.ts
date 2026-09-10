import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  appendRefactorHistory,
  markRefactorHistoryApplied,
  type AppendRefactorHistoryInput,
  type RefactorHistoryDocument
} from '../src/main/refactorHistory.ts'

function createInput(
  sourceFilePath: string,
  sessionId: string,
  afterCode: string
): AppendRefactorHistoryInput {
  return {
    sessionId,
    sourceFilePath,
    language: 'cpp',
    scope: 'file',
    modelName: 'test-model',
    instruction: 'test instruction',
    before: {
      code: 'int main() { return 0; }\n',
      lineCount: 2,
      fileComplexity: 2
    },
    after: {
      code: afterCode,
      lineCount: 2,
      fileComplexity: 1
    }
  }
}

test('按源文件追加记录并将同一会话标记为 applied', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'aosp-refactor-history-'))
  try {
    const projectRoot = join(temporaryRoot, 'project')
    const sourceFilePath = join(projectRoot, 'src', 'main.cpp')
    await mkdir(join(projectRoot, 'src'), { recursive: true })
    await writeFile(sourceFilePath, 'int main() { return 0; }\n', 'utf8')

    const [first, second] = await Promise.all([
      appendRefactorHistory(
        projectRoot,
        createInput(sourceFilePath, 'session-1', 'int main() { return 1; }\n')
      ),
      appendRefactorHistory(
        projectRoot,
        createInput(sourceFilePath, 'session-1', 'int main() { return 2; }\n')
      )
    ])

    assert.equal(first.historyPath, second.historyPath)
    const beforeApply = JSON.parse(
      await readFile(first.historyPath, 'utf8')
    ) as RefactorHistoryDocument
    assert.equal(beforeApply.schemaVersion, 1)
    assert.equal(beforeApply.sourceFile.relativePath, 'src/main.cpp')
    assert.equal(beforeApply.records.length, 2)
    assert.ok(beforeApply.records.every((record) => record.status === 'generated'))
    assert.ok(beforeApply.records.every((record) => record.delta.lineCount === 0))
    assert.ok(beforeApply.records.every((record) => record.delta.fileComplexity === -1))

    const applied = await markRefactorHistoryApplied(projectRoot, sourceFilePath, 'session-1')
    assert.equal(applied.updatedCount, 2)

    const afterApply = JSON.parse(
      await readFile(first.historyPath, 'utf8')
    ) as RefactorHistoryDocument
    assert.ok(afterApply.records.every((record) => record.status === 'applied'))
    assert.ok(afterApply.records.every((record) => record.writeBack.appliedAt !== null))
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('拒绝为项目目录外的源文件创建历史记录', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'aosp-refactor-history-boundary-'))
  try {
    const projectRoot = join(temporaryRoot, 'project')
    const outsideFile = join(temporaryRoot, 'outside.cpp')
    await mkdir(projectRoot, { recursive: true })
    await writeFile(outsideFile, 'void outside() {}\n', 'utf8')

    await assert.rejects(
      appendRefactorHistory(
        projectRoot,
        createInput(outsideFile, 'session-outside', 'void outside() {}\n')
      ),
      /源文件不在当前项目目录内/
    )
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})
