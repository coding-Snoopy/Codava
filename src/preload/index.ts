import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { PreloadApi, BatchProgressEvent } from './index.d'

// 渲染进程可用的“受控 API”。
// 说明：不要把 Node/Electron 的全部能力直接暴露给 renderer；只暴露我们需要的最小集合。
const api: PreloadApi = {
  appQuit: (): Promise<void> => ipcRenderer.invoke('app:quit'),
  getAppInfo: (): Promise<{
    name: string
    version: string
    platform: string
    electron: string
    chrome: string
    node: string
  }> => ipcRenderer.invoke('app:getInfo'),
  selectDirectory: (): Promise<string | null> => ipcRenderer.invoke('fs:selectDirectory'),
  buildFileTree: (rootDir: string) => ipcRenderer.invoke('fs:buildFileTree', rootDir),
  readFile: (filePath: string): Promise<{ content: string }> =>
    ipcRenderer.invoke('fs:readFile', filePath),
  writeFile: (filePath: string, content: string): Promise<{ ok: true }> =>
    ipcRenderer.invoke('fs:writeFile', filePath, content),
  saveJsonFile: (params: { defaultFileName: string; jsonText: string; title?: string }) =>
    ipcRenderer.invoke('fs:saveJson', params),
  appendRefactorHistory: (input) => ipcRenderer.invoke('history:append', input),
  markRefactorHistoryApplied: (sourceFilePath: string, sessionId: string) =>
    ipcRenderer.invoke('history:markApplied', { sourceFilePath, sessionId }),
  parseFunctions: (filePath: string, content?: string) =>
    ipcRenderer.invoke('parse:functions', filePath, content),
  analyzeFile: (filePath: string, language: string, content?: string) =>
    ipcRenderer.invoke('analyze:file', filePath, language, content),
  calculateComplexity: (filePath: string, content: string, language: string) =>
    ipcRenderer.invoke('complexity:calculate', filePath, content, language),
  auditFile: (params: {
    filePath: string
    language: string
    fileContent: string
    scope: 'original' | 'refactored'
    requestId?: string
  }) => ipcRenderer.invoke('audit:file', params),
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
  }): Promise<{
    refactoredFunctionCode: string
    updatedFileContent: string
    refactoredComplexity: number
  }> => ipcRenderer.invoke('refactor:function', params),
  refactorFile: (params: {
    requestId?: string
    filePath: string
    language: string
    currentFileContent: string
    instruction?: string
  }) => ipcRenderer.invoke('refactor:file', params),

  refactorBatch: (params: {
    batchId: string
    rootDir: string
    files: string[]
    instruction?: string
  }) => ipcRenderer.invoke('refactor:batch', params),

  auditBatch: (params: {
    batchId: string
    rootDir: string
    files: string[]
  }) => ipcRenderer.invoke('audit:batch', params),

  cancelBatch: (batchId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('refactor:batch:cancel', batchId),

  onBatchProgress: (cb: (data: BatchProgressEvent) => void) => {
    const listener = (_e: unknown, data: BatchProgressEvent): void => cb(data)
    ipcRenderer.on('refactor:batch:progress', listener)
    return () => {
      ipcRenderer.removeListener('refactor:batch:progress', listener)
    }
  },

  onAuditBatchProgress: (cb: (data: BatchProgressEvent) => void) => {
    const listener = (_e: unknown, data: BatchProgressEvent): void => cb(data)
    ipcRenderer.on('audit:batch:progress', listener)
    return () => {
      ipcRenderer.removeListener('audit:batch:progress', listener)
    }
  },

  cancelRefactor: (requestId: string): Promise<{ ok: boolean; found: boolean }> =>
    ipcRenderer.invoke('refactor:cancel', requestId),

  onQGProgress: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, msg: { functionName: string; attempt: number; maxAttempts: number; isRetry: boolean; stage: 'refactoring' | 'checking' | 'analyzing' | 'file-refactoring' }): void => {
      callback(msg)
    }
    ipcRenderer.on('qg:progress', handler)
    return () => {
      ipcRenderer.removeListener('qg:progress', handler)
    }
  },

  windowMinimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  windowToggleMaximize: (): Promise<void> => ipcRenderer.invoke('window:toggleMaximize'),
  windowIsMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:isMaximized'),
  windowClose: (): Promise<void> => ipcRenderer.invoke('window:close'),

  // 设置中心 API
  settingsLoad: () => ipcRenderer.invoke('settings:load'),
  settingsSaveModel: (m) => ipcRenderer.invoke('settings:saveModel', m),
  settingsDeleteModel: (id: string) => ipcRenderer.invoke('settings:deleteModel', id),
  settingsSetActiveModel: (id: string) => ipcRenderer.invoke('settings:setActiveModel', id),
  settingsSaveScheme: (s) => ipcRenderer.invoke('settings:saveScheme', s),
  settingsDeleteScheme: (id: string) => ipcRenderer.invoke('settings:deleteScheme', id),
  settingsSetActiveScheme: (id: string) => ipcRenderer.invoke('settings:setActiveScheme', id),
  settingsExport: () => ipcRenderer.invoke('settings:export'),
  settingsImport: () => ipcRenderer.invoke('settings:import'),
  settingsTestModel: (m) => ipcRenderer.invoke('settings:testModel', m)
}

// 使用 contextBridge 将 API 安全地暴露到 window 上。
// 只有在开启 contextIsolation 时才推荐这么做；否则只能退化为直接挂到全局对象。
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore（类型声明在 d.ts 中）
  window.electron = electronAPI
  // @ts-ignore（类型声明在 d.ts 中）
  window.api = api
}
