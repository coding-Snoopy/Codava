<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as monaco from 'monaco-editor'

// Monaco Worker（Vite 环境）
// 说明：Monaco 在浏览器端需要通过 Web Worker 提供语法服务；这里用 ?worker 让 Vite 生成 worker 入口。
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

// 注册基础语言（用于高亮/分词等）
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution'
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution'

type MonacoEnvironment = {
  getWorker(moduleId: string, label: string): Worker
}

// 定义 Worker 解析规则：不同 label 使用不同的 worker
const selfWithMonaco = self as unknown as { MonacoEnvironment: MonacoEnvironment }
selfWithMonaco.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    if (label === 'typescript' || label === 'javascript') {
      return new TsWorker()
    }
    return new EditorWorker()
  }
}

const props = defineProps<{
  original: string
  modified: string
  language: string
  /** 右侧（modified）是否只读 */
  modifiedReadOnly?: boolean
  /** 1-based 行号（与编辑器展示一致） */
  revealLine?: number | null
  /** 自增该值可强制重新定位（即使 revealLine 没变） */
  revealNonce?: number
}>()

const emit = defineEmits<{ (e: 'update:modified', v: string): void }>()

const rootEl = ref<HTMLElement | null>(null)
let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null
let originalModel: monaco.editor.ITextModel | null = null
let modifiedModel: monaco.editor.ITextModel | null = null

let suppressModifiedEmit = false
let modifiedChangeDisposable: monaco.IDisposable | null = null

function applyReadOnlyOptions(): void {
  if (!diffEditor) return
  // 左侧永远只读；右侧由 props.modifiedReadOnly 控制
  diffEditor.getOriginalEditor().updateOptions({ readOnly: true })
  diffEditor.getModifiedEditor().updateOptions({ readOnly: props.modifiedReadOnly ?? true })
}

function bindModifiedChange(): void {
  modifiedChangeDisposable?.dispose()
  modifiedChangeDisposable = null
  if (!modifiedModel) return

  modifiedChangeDisposable = modifiedModel.onDidChangeContent(() => {
    if (suppressModifiedEmit) return
    emit('update:modified', modifiedModel?.getValue() ?? '')
  })
}

function ensureModels(): void {
  const lang = props.language || 'plaintext'
  let needsSetModel = false

  if (!originalModel) {
    originalModel = monaco.editor.createModel(props.original ?? '', lang)
    needsSetModel = true
  } else {
    monaco.editor.setModelLanguage(originalModel, lang)
    if (originalModel.getValue() !== (props.original ?? ''))
      originalModel.setValue(props.original ?? '')
  }

  if (!modifiedModel) {
    modifiedModel = monaco.editor.createModel(props.modified ?? '', lang)
    needsSetModel = true
  } else {
    monaco.editor.setModelLanguage(modifiedModel, lang)
    if (modifiedModel.getValue() !== (props.modified ?? '')) {
      suppressModifiedEmit = true
      modifiedModel.setValue(props.modified ?? '')
      suppressModifiedEmit = false
    }
  }

  // 只在模型首次创建时调用 setModel；后续内容更新通过 setValue 触发，
  // diff editor 会自动监听 model 的 onDidChangeContent 重新计算差异
  if (needsSetModel) {
    diffEditor?.setModel({ original: originalModel, modified: modifiedModel })
  }
  bindModifiedChange()
  applyReadOnlyOptions()
}

function revealLineInEditor(line: number): void {
  if (!diffEditor) return
  if (!Number.isFinite(line) || line <= 0) return

  const editor = diffEditor.getOriginalEditor()
  editor.revealLineInCenter(line)
  editor.setPosition({ lineNumber: line, column: 1 })
  editor.focus()
}

onMounted(() => {
  if (!rootEl.value) return
  monaco.editor.setTheme('vs')
  diffEditor = monaco.editor.createDiffEditor(rootEl.value, {
    automaticLayout: true,
    // 只读由我们对左右 editor 分别控制
    renderSideBySide: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    wordWrap: 'off',
    diffWordWrap: 'off',
    scrollbar: {
      vertical: 'auto',
      horizontal: 'auto',
      horizontalScrollbarSize: 10,
      verticalScrollbarSize: 10
    }
  })

  ensureModels()

  applyReadOnlyOptions()

  if (typeof props.revealLine === 'number') revealLineInEditor(props.revealLine)
})

watch(
  () => [props.original, props.modified, props.language] as const,
  () => {
    ensureModels()
  }
)

watch(
  () => props.modifiedReadOnly,
  () => {
    applyReadOnlyOptions()
  }
)

watch(
  () => props.revealLine,
  (line) => {
    if (typeof line === 'number') revealLineInEditor(line)
  }
)

watch(
  () => props.revealNonce,
  () => {
    if (typeof props.revealLine === 'number') revealLineInEditor(props.revealLine)
  }
)

onBeforeUnmount(() => {
  modifiedChangeDisposable?.dispose()
  modifiedChangeDisposable = null
  diffEditor?.dispose()
  diffEditor = null
  originalModel?.dispose()
  originalModel = null
  modifiedModel?.dispose()
  modifiedModel = null
})
</script>

<template>
  <div ref="rootEl" class="monaco-diff-root" />
</template>

<style scoped>
.monaco-diff-root {
  width: 100%;
  height: 100%;
}
</style>
