<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as monaco from 'monaco-editor'

// Monaco Worker（Vite 环境）
// 说明：与 MonacoDiff 一致，必须提供 worker 解析器，否则会出现语法服务不可用/报错。
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'

import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution'
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution'
import 'monaco-editor/esm/vs/language/json/monaco.contribution'

type MonacoEnvironment = {
  getWorker(moduleId: string, label: string): Worker
}

const selfWithMonaco = self as unknown as { MonacoEnvironment: MonacoEnvironment }
selfWithMonaco.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    if (label === 'json') {
      return new JsonWorker()
    }
    if (label === 'typescript' || label === 'javascript') {
      return new TsWorker()
    }
    return new EditorWorker()
  }
}

const props = defineProps<{
  modelValue: string
  language: string
  readOnly?: boolean
}>()

const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()

const rootEl = ref<HTMLElement | null>(null)
let editor: monaco.editor.IStandaloneCodeEditor | null = null
let model: monaco.editor.ITextModel | null = null

onMounted(() => {
  if (!rootEl.value) return
  monaco.editor.setTheme('vs')
  model = monaco.editor.createModel(props.modelValue ?? '', props.language || 'plaintext')
  editor = monaco.editor.create(rootEl.value, {
    model,
    automaticLayout: true,
    readOnly: props.readOnly ?? false,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    wordWrap: 'off',
    scrollbar: {
      vertical: 'auto',
      horizontal: 'auto',
      horizontalScrollbarSize: 10,
      verticalScrollbarSize: 10
    }
  })

  editor.onDidChangeModelContent(() => {
    if (!model) return
    emit('update:modelValue', model.getValue())
  })
})

watch(
  () => props.modelValue,
  (v) => {
    if (!model) return
    if (model.getValue() !== (v ?? '')) model.setValue(v ?? '')
  }
)

watch(
  () => props.language,
  (lang) => {
    if (!model) return
    monaco.editor.setModelLanguage(model, lang || 'plaintext')
  }
)

watch(
  () => props.readOnly,
  (ro) => {
    editor?.updateOptions({ readOnly: ro ?? false })
  }
)

onBeforeUnmount(() => {
  editor?.dispose()
  editor = null
  model?.dispose()
  model = null
})
</script>

<template>
  <div ref="rootEl" class="monaco-root" />
</template>

<style scoped>
.monaco-root {
  width: 100%;
  height: 100%;
}
</style>
