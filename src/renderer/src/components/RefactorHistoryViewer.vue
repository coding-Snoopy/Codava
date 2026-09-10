<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import MonacoDiff from './MonacoDiff.vue'
import MonacoEditor from './MonacoEditor.vue'

type CodeSnapshot = {
  code: string
  lineCount: number
  fileComplexity: number
  targetComplexity?: number
}

type HistoryRecord = {
  id: string
  sessionId: string
  createdAt: string
  scope: 'function' | 'file'
  status: 'generated' | 'applied'
  target?: {
    functionName: string
    functionOccurrence: number
    startLineBefore: number
    endLineBefore: number
    startLineAfter?: number
    endLineAfter?: number
  }
  model: { name: string }
  instruction: string
  before: CodeSnapshot
  after: CodeSnapshot
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

type HistoryDocument = {
  schemaVersion: number
  sourceFile: {
    relativePath: string
    language: string
  }
  records: HistoryRecord[]
}

const props = defineProps<{
  content: string
}>()

const selectedRecordId = ref('')
const showRawJson = ref(false)

const document = computed<HistoryDocument | null>(() => {
  try {
    const value = JSON.parse(props.content) as Partial<HistoryDocument>
    if (!value.sourceFile || !Array.isArray(value.records)) return null
    return value as HistoryDocument
  } catch {
    return null
  }
})

watch(
  () => props.content,
  () => {
    const records = document.value?.records ?? []
    selectedRecordId.value = records.at(-1)?.id ?? ''
    showRawJson.value = false
  },
  { immediate: true }
)

const selectedRecord = computed(() => {
  const records = document.value?.records ?? []
  return records.find((record) => record.id === selectedRecordId.value) ?? records.at(-1) ?? null
})

const sourceLanguage = computed(() => document.value?.sourceFile.language || 'plaintext')

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function formatDelta(value: number | undefined): string {
  if (value === undefined) return '-'
  return value > 0 ? `+${value}` : String(value)
}

function scopeLabel(scope: HistoryRecord['scope']): string {
  return scope === 'function' ? '函数重构' : '文件重构'
}
</script>

<template>
  <div class="history-viewer">
    <template v-if="document && document.records.length">
      <div class="history-toolbar">
        <div class="history-source">
          <span class="source-label">源文件</span>
          <span class="source-path" :title="document.sourceFile.relativePath">
            {{ document.sourceFile.relativePath }}
          </span>
          <span class="record-count">{{ document.records.length }} 条记录</span>
        </div>

        <select v-model="selectedRecordId" class="record-select" aria-label="选择重构记录">
          <option v-for="(record, index) in document.records" :key="record.id" :value="record.id">
            #{{ index + 1 }} {{ scopeLabel(record.scope) }} · {{ formatTime(record.createdAt) }}
          </option>
        </select>

        <button class="view-toggle" type="button" @click="showRawJson = !showRawJson">
          {{ showRawJson ? '查看代码对比' : '查看原始 JSON' }}
        </button>
      </div>

      <MonacoEditor
        v-if="showRawJson"
        :model-value="content"
        language="json"
        read-only
        class="history-editor"
      />

      <template v-else-if="selectedRecord">
        <div class="record-summary">
          <span class="summary-chip scope-chip">{{ scopeLabel(selectedRecord.scope) }}</span>
          <span
            class="summary-chip"
            :class="selectedRecord.status === 'applied' ? 'status-applied' : 'status-generated'"
          >
            {{ selectedRecord.status === 'applied' ? '已写回' : '仅预览' }}
          </span>
          <span class="summary-item">模型：{{ selectedRecord.model.name }}</span>
          <span v-if="selectedRecord.target" class="summary-item">
            函数：{{ selectedRecord.target.functionName }}
          </span>
          <span class="summary-item">
            行数：{{ selectedRecord.before.lineCount }} → {{ selectedRecord.after.lineCount }} （{{
              formatDelta(selectedRecord.delta.lineCount)
            }}）
          </span>
          <span class="summary-item">
            圈复杂度：{{ selectedRecord.before.fileComplexity }} →
            {{ selectedRecord.after.fileComplexity }}（{{
              formatDelta(selectedRecord.delta.fileComplexity)
            }}）
          </span>
          <span v-if="selectedRecord.target" class="summary-item">
            函数复杂度：{{ selectedRecord.before.targetComplexity ?? '-' }} →
            {{ selectedRecord.after.targetComplexity ?? '-' }}（{{
              formatDelta(selectedRecord.delta.targetComplexity)
            }}）
          </span>
        </div>

        <div class="code-labels" aria-hidden="true">
          <span>重构前</span>
          <span>重构后</span>
        </div>
        <MonacoDiff
          :original="selectedRecord.before.code"
          :modified="selectedRecord.after.code"
          :language="sourceLanguage"
          modified-read-only
          class="history-diff"
        />
      </template>
    </template>

    <div v-else class="invalid-history">
      <div class="invalid-title">无法解析结构化重构记录</div>
      <div class="invalid-subtitle">该文件可能为空、损坏或来自不支持的版本。</div>
      <MonacoEditor :model-value="content" language="json" read-only class="history-editor" />
    </div>
  </div>
</template>

<style scoped>
.history-viewer {
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--color-background-soft);
  color: var(--ev-c-text-1);
}

.history-toolbar {
  flex: 0 0 auto;
  min-height: 42px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--ev-c-gray-3);
  background: var(--el-fill-color-light);
}

.history-source {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 1;
}

.source-label,
.record-count {
  flex: 0 0 auto;
  color: var(--ev-c-text-2);
  font-size: 12px;
}

.source-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.record-select,
.view-toggle {
  height: 28px;
  border: 1px solid var(--ev-c-gray-3);
  border-radius: 6px;
  background: var(--color-background-soft);
  color: var(--ev-c-text-1);
  font-size: 12px;
}

.record-select {
  width: min(360px, 34vw);
  padding: 0 8px;
}

.view-toggle {
  flex: 0 0 auto;
  padding: 0 11px;
  cursor: pointer;
}

.view-toggle:hover {
  border-color: var(--ev-c-accent-soft);
  background: var(--ev-c-accent-bg);
}

.record-summary {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px 12px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--ev-c-gray-3);
  background: var(--ev-c-white-soft);
  font-size: 12px;
}

.summary-chip {
  border-radius: 10px;
  padding: 2px 8px;
}

.scope-chip {
  color: var(--ev-c-accent);
  background: var(--ev-c-accent-bg);
}

.status-applied {
  color: var(--ev-c-good);
  background: rgba(63, 143, 63, 0.12);
}

.status-generated {
  color: var(--ev-c-warn);
  background: rgba(192, 122, 16, 0.1);
}

.summary-item {
  color: var(--ev-c-text-2);
}

.code-labels {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: 1fr 1fr;
  border-bottom: 1px solid var(--ev-c-gray-3);
  background: var(--el-fill-color-light);
  color: var(--ev-c-text-2);
  font-size: 12px;
}

.code-labels span {
  padding: 4px 12px;
}

.code-labels span + span {
  border-left: 1px solid var(--ev-c-gray-3);
}

.history-diff,
.history-editor {
  flex: 1 1 auto;
  min-height: 0;
}

.invalid-history {
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
}

.invalid-title {
  padding: 10px 12px 2px;
  color: var(--ev-c-bad);
  font-size: 13px;
}

.invalid-subtitle {
  padding: 0 12px 10px;
  color: var(--ev-c-text-2);
  font-size: 12px;
}
</style>
