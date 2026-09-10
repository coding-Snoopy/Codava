<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { AppSettingsView, ModelConfigInput, PromptScheme } from '../../../preload/index.d'

// ============================================================
// Props & Emits
// ============================================================

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{
  (e: 'update:visible', val: boolean): void
  (e: 'saved'): void
}>()

const dialogVisible = computed({
  get: () => props.visible,
  set: (val: boolean) => emit('update:visible', val)
})

// ============================================================
// 设置数据
// ============================================================

const settings = ref<AppSettingsView | null>(null)
const activeTab = ref('models')
const loading = ref(false)

async function loadSettings(): Promise<void> {
  loading.value = true
  try {
    settings.value = await window.api.settingsLoad()
    // 同步激活方案到编辑区
    const activeScheme = settings.value.promptSchemes.find(
      (p) => p.id === settings.value!.activeSchemeId
    )
    if (activeScheme) {
      Object.assign(editingTemplates, activeScheme.templates)
      currentSchemeId.value = activeScheme.id
      currentSchemeName.value = activeScheme.name
    }
  } catch (e) {
    ElMessage.error('加载设置失败：' + (e instanceof Error ? e.message : String(e)))
  } finally {
    loading.value = false
  }
}

watch(
  () => props.visible,
  (val) => {
    if (val) {
      loadSettings()
      activeTab.value = 'models'
      resetModelForm()
    }
  }
)

// ============================================================
// 模型管理
// ============================================================

const editingModel = reactive<ModelConfigInput>({
  id: undefined,
  name: '',
  baseUrl: '',
  apiKey: '',
  timeoutMs: 120000
})
const isEditingModel = ref(false)
const testingModel = ref(false)

function resetModelForm(): void {
  editingModel.id = undefined
  editingModel.name = ''
  editingModel.baseUrl = ''
  editingModel.apiKey = ''
  editingModel.timeoutMs = 120000
  isEditingModel.value = false
}

function startAddModel(): void {
  resetModelForm()
  isEditingModel.value = true
}

function startEditModel(model: AppSettingsView['models'][number]): void {
  editingModel.id = model.id
  editingModel.name = model.name
  editingModel.baseUrl = model.baseUrl
  editingModel.apiKey = model.apiKey // 掩码值
  editingModel.timeoutMs = model.timeoutMs
  isEditingModel.value = true
}

async function saveModel(): Promise<void> {
  if (!editingModel.name?.trim()) {
    ElMessage.warning('请输入模型名称')
    return
  }
  if (!editingModel.baseUrl?.trim()) {
    ElMessage.warning('请输入 API 地址')
    return
  }
  try {
    const res = await window.api.settingsSaveModel({ ...editingModel })
    if (!res.ok) {
      ElMessage.error(res.error || '保存失败')
      return
    }
    ElMessage.success(editingModel.id ? '模型已更新' : '模型已添加')
    resetModelForm()
    await loadSettings()
  } catch (e) {
    ElMessage.error('保存失败：' + (e instanceof Error ? e.message : String(e)))
  }
}

async function deleteModel(id: string): Promise<void> {
  try {
    const res = await window.api.settingsDeleteModel(id)
    if (!res.ok) {
      ElMessage.error(res.error || '删除失败')
      return
    }
    ElMessage.success('模型已删除')
    if (editingModel.id === id) resetModelForm()
    await loadSettings()
  } catch (e) {
    ElMessage.error('删除失败：' + (e instanceof Error ? e.message : String(e)))
  }
}

async function setActiveModel(id: string): Promise<void> {
  try {
    await window.api.settingsSetActiveModel(id)
    await loadSettings()
    ElMessage.success('已切换激活模型')
  } catch (e) {
    ElMessage.error('切换失败：' + (e instanceof Error ? e.message : String(e)))
  }
}

async function testModelConnection(): Promise<void> {
  if (!editingModel.baseUrl?.trim()) {
    ElMessage.warning('请先填写 API 地址')
    return
  }
  testingModel.value = true
  try {
    const res = await window.api.settingsTestModel({ ...editingModel })
    if (res.ok) {
      ElMessage.success(res.message)
    } else {
      ElMessage.error(res.message)
    }
  } catch (e) {
    ElMessage.error('测试失败：' + (e instanceof Error ? e.message : String(e)))
  } finally {
    testingModel.value = false
  }
}

// ============================================================
// Prompt 模板管理
// ============================================================

const currentSchemeId = ref('')
const currentSchemeName = ref('')
const editingTemplates = reactive({
  functionSystem: '',
  functionUser: '',
  fileSystem: '',
  fileUser: ''
})

// 默认模板（用于"恢复默认"）
const DEFAULT_TEMPLATES = {
  functionSystem:
    'You are a senior refactoring assistant. Return ONLY the full refactored function code. Do not add explanations. Do not duplicate the function declaration/signature.',
  functionUser: [
    'Language: {{language}}',
    'File: {{filePath}}',
    '',
    'Refactor ONLY this function.',
    '',
    'Theme: preserve original logic, reduce cyclomatic complexity, improve performance.',
    '',
    'Goals (in priority order):',
    '1) Preserve behavior and externally observable side effects exactly.',
    '2) Reduce cyclomatic complexity (flatten deep nesting, use early returns/guard clauses, simplify boolean logic).',
    '3) Improve performance safely (remove redundant work, reduce repeated computations/allocations, avoid unnecessary copies).',
    '',
    'Constraints:',
    '- Keep the same function signature (name/params/return type) and semantics.',
    '- Do not change other functions, call sites, or surrounding code.',
    '- Keep error handling and edge-case behavior consistent.',
    '- Do not add new dependencies.',
    '',
    'Output:',
    '- Return ONLY the full refactored function code. No markdown fences, no explanations.',
    '',
    'Function:',
    '```',
    '{{functionCode}}',
    '```',
    '{{ragContext}}'
  ].join('\n'),
  fileSystem:
    'You are a senior refactoring assistant. You will refactor code while preserving behavior. Return ONLY the full refactored file content. Do not add explanations.',
  fileUser: [
    'Language: {{language}}',
    'File: {{filePath}}',
    '',
    'Refactor the ENTIRE FILE.',
    '',
    'Theme: preserve original logic, reduce cyclomatic complexity, improve performance.',
    '',
    'Goals (in priority order):',
    '1) Preserve behavior, public API, and externally observable side effects.',
    '2) Reduce cyclomatic complexity across the file (split large functions, extract helpers, simplify branching/conditionals, remove duplication).',
    '3) Improve performance safely (avoid repeated parsing/scanning, reduce allocations, improve algorithmic hot paths when obvious and safe).',
    '',
    'Constraints:',
    '- Keep the file complete and compilable.',
    '- Do not remove functionality.',
    '- Do not add new dependencies.',
    '- Prefer localized, low-risk refactors.',
    '',
    'Output:',
    '- Return ONLY the full updated file content. No markdown fences, no explanations.',
    '',
    'Original file:',
    '```',
    '{{fileContent}}',
    '```'
  ].join('\n')
}

const FUNCTION_VARS = [
  { name: 'language', desc: '编程语言（java/cpp）' },
  { name: 'filePath', desc: '文件路径' },
  { name: 'functionName', desc: '函数名' },
  { name: 'functionCode', desc: '函数源代码' },
  { name: 'instruction', desc: '额外重构指令' },
  { name: 'ragContext', desc: 'RAG 参考示例' }
]

const FILE_VARS = [
  { name: 'language', desc: '编程语言（java/cpp）' },
  { name: 'filePath', desc: '文件路径' },
  { name: 'fileContent', desc: '完整文件内容' },
  { name: 'instruction', desc: '额外重构指令' }
]

// 当前聚焦的模板字段（用于变量插入）
const focusedField = ref<keyof typeof editingTemplates | null>(null)

function onTemplateFocus(field: keyof typeof editingTemplates): void {
  focusedField.value = field
}

function insertVariable(varName: string): void {
  const field = focusedField.value
  if (!field) {
    ElMessage.info('请先点击一个模板输入框，再插入变量')
    return
  }
  const insertion = `{{${varName}}}`
  editingTemplates[field] += insertion
}

// 生成变量标签的显示文本（避免在模板插值中直接写 {{ }} 字面量）
function varLabel(varName: string): string {
  return `{{${varName}}}`
}

// 语法检查
type TemplateWarning = { field: string; message: string }

const templateWarnings = computed<TemplateWarning[]>(() => {
  const warnings: TemplateWarning[] = []
  const funcAllowed = FUNCTION_VARS.map((v) => v.name)
  const fileAllowed = FILE_VARS.map((v) => v.name)

  function check(template: string, allowed: string[], fieldName: string): void {
    for (const m of template.matchAll(/\{\{(\w+)\}\}/g)) {
      if (!allowed.includes(m[1])) {
        warnings.push({ field: fieldName, message: `未知变量 {{${m[1]}}}` })
      }
    }
    const stripped = template.replace(/\{\{\w+\}\}/g, '')
    if (stripped.includes('{{')) {
      warnings.push({ field: fieldName, message: '存在未闭合的 {{ 标记' })
    }
  }

  check(editingTemplates.functionSystem, [], '函数-System')
  check(editingTemplates.functionUser, funcAllowed, '函数-User')
  check(editingTemplates.fileSystem, [], '文件-System')
  check(editingTemplates.fileUser, fileAllowed, '文件-User')

  return warnings
})

// 预览渲染
const SAMPLE_VARS: Record<string, string> = {
  language: 'cpp',
  filePath: '/aosp/frameworks/base/services/Foo.cpp',
  functionName: 'handleRequest',
  functionCode: 'void handleRequest(int req) {\n  if (req > 0) {\n    process(req);\n  }\n}',
  fileContent: '#include <iostream>\n\nvoid foo() {\n  std::cout << "hello";\n}',
  instruction: '(可选的额外指令)',
  ragContext:
    '[Reference Example]\n[Before Code]\nvoid old() { ... }\n[After Code]\nvoid improved() { ... }'
}

function renderPreview(template: string): string {
  const lines = template.split('\n')
  const rendered: string[] = []
  for (const line of lines) {
    const varMatches = [...line.matchAll(/\{\{(\w+)\}\}/g)]
    const replaced = line.replace(/\{\{(\w+)\}\}/g, (_, key: string) => SAMPLE_VARS[key] ?? '')
    if (varMatches.length > 0) {
      const allEmpty = varMatches.every((m) => !SAMPLE_VARS[m[1]])
      if (allEmpty) {
        const withoutVars = line.replace(/\{\{\w+\}\}/g, '').trim()
        if (!withoutVars || /^[\w\s]*:?\s*$/.test(withoutVars)) continue
      }
    }
    rendered.push(replaced)
  }
  return rendered
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const showPreview = ref(false)
const previewFunctionUser = computed(() => renderPreview(editingTemplates.functionUser))
const previewFileUser = computed(() => renderPreview(editingTemplates.fileUser))

// 方案操作
function onSchemeChange(schemeId: string): void {
  if (!settings.value) return
  const scheme = settings.value.promptSchemes.find((p) => p.id === schemeId)
  if (scheme) {
    currentSchemeId.value = scheme.id
    currentSchemeName.value = scheme.name
    Object.assign(editingTemplates, scheme.templates)
  }
}

async function saveScheme(): Promise<void> {
  if (!currentSchemeName.value?.trim()) {
    ElMessage.warning('方案名称不能为空')
    return
  }
  const scheme: PromptScheme = {
    id: currentSchemeId.value,
    name: currentSchemeName.value.trim(),
    templates: { ...editingTemplates }
  }
  try {
    const res = await window.api.settingsSaveScheme(scheme)
    if (!res.ok) {
      ElMessage.error(res.error || '保存失败')
      return
    }
    ElMessage.success('Prompt 方案已保存')
    await loadSettings()
  } catch (e) {
    ElMessage.error('保存失败：' + (e instanceof Error ? e.message : String(e)))
  }
}

async function saveAsNewScheme(): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt('请输入新方案名称', '另存为新方案', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      inputValue: '新方案'
    })
    if (!value?.trim()) return
    const scheme: PromptScheme = {
      id: '', // 空 ID 表示新增
      name: value.trim(),
      templates: { ...editingTemplates }
    }
    const res = await window.api.settingsSaveScheme(scheme)
    if (!res.ok) {
      ElMessage.error(res.error || '保存失败')
      return
    }
    ElMessage.success('新方案已保存')
    await loadSettings()
  } catch {
    // 用户取消
  }
}

async function deleteCurrentScheme(): Promise<void> {
  if (!currentSchemeId.value) return
  try {
    const res = await window.api.settingsDeleteScheme(currentSchemeId.value)
    if (!res.ok) {
      ElMessage.error(res.error || '删除失败')
      return
    }
    ElMessage.success('方案已删除')
    await loadSettings()
  } catch (e) {
    ElMessage.error('删除失败：' + (e instanceof Error ? e.message : String(e)))
  }
}

function resetToDefaults(): void {
  Object.assign(editingTemplates, DEFAULT_TEMPLATES)
  ElMessage.info('已恢复为默认模板（需点击"保存方案"生效）')
}

function resetField(field: keyof typeof DEFAULT_TEMPLATES): void {
  editingTemplates[field] = DEFAULT_TEMPLATES[field]
}

async function setActiveScheme(schemeId: string): Promise<void> {
  try {
    await window.api.settingsSetActiveScheme(schemeId)
    await loadSettings()
    ElMessage.success('已切换激活方案')
  } catch (e) {
    ElMessage.error('切换失败：' + (e instanceof Error ? e.message : String(e)))
  }
}

// ============================================================
// 导入 / 导出
// ============================================================

async function exportSettings(): Promise<void> {
  try {
    const res = await window.api.settingsExport()
    if (res.canceled) return
    if (res.ok) {
      ElMessage.success('配置已导出')
    } else {
      ElMessage.error(res.error || '导出失败')
    }
  } catch (e) {
    ElMessage.error('导出失败：' + (e instanceof Error ? e.message : String(e)))
  }
}

async function importSettings(): Promise<void> {
  try {
    const res = await window.api.settingsImport()
    if (res.canceled) return
    if (res.ok) {
      ElMessage.success('配置已导入')
      await loadSettings()
    } else {
      ElMessage.error(res.error || '导入失败')
    }
  } catch (e) {
    ElMessage.error('导入失败：' + (e instanceof Error ? e.message : String(e)))
  }
}

// ============================================================
// 对话框操作
// ============================================================

async function onSaveAndClose(): Promise<void> {
  // 保存当前 Prompt 方案
  if (currentSchemeId.value && currentSchemeName.value?.trim()) {
    const scheme: PromptScheme = {
      id: currentSchemeId.value,
      name: currentSchemeName.value.trim(),
      templates: { ...editingTemplates }
    }
    await window.api.settingsSaveScheme(scheme)
  }
  dialogVisible.value = false
  emit('saved')
}

function onCancel(): void {
  dialogVisible.value = false
}
</script>

<template>
  <el-dialog
    v-model="dialogVisible"
    title="设置"
    width="780px"
    :close-on-click-modal="false"
    destroy-on-close
    class="settings-dialog"
  >
    <el-tabs v-model="activeTab" class="settings-tabs">
      <!-- ==================== 模型管理 ==================== -->
      <el-tab-pane label="模型管理" name="models">
        <div class="models-layout">
          <!-- 模型列表 -->
          <div class="model-list">
            <div class="model-list-header">
              <span class="list-title">已配置模型</span>
              <el-button size="small" type="primary" plain @click="startAddModel">
                + 新增
              </el-button>
            </div>
            <div v-if="settings?.models.length" class="model-items">
              <div
                v-for="model in settings.models"
                :key="model.id"
                class="model-item"
                :class="{ 'is-active': model.id === settings.activeModelId }"
              >
                <div class="model-info" @click="startEditModel(model)">
                  <div class="model-name">
                    {{ model.name }}
                    <span v-if="model.id === settings.activeModelId" class="active-badge">
                      当前
                    </span>
                  </div>
                  <div class="model-url">{{ model.baseUrl }}</div>
                </div>
                <div class="model-actions">
                  <el-button
                    v-if="model.id !== settings.activeModelId"
                    size="small"
                    text
                    @click.stop="setActiveModel(model.id)"
                  >
                    启用
                  </el-button>
                  <el-popconfirm
                    title="确定删除该模型？"
                    confirm-button-text="删除"
                    cancel-button-text="取消"
                    @confirm="deleteModel(model.id)"
                  >
                    <template #reference>
                      <el-button size="small" text type="danger" @click.stop>删除</el-button>
                    </template>
                  </el-popconfirm>
                </div>
              </div>
            </div>
            <div v-else class="model-empty">
              暂无模型配置，点击"新增"添加第一个模型
            </div>
          </div>

          <!-- 编辑表单 -->
          <div v-if="isEditingModel" class="model-form">
            <div class="form-title">{{ editingModel.id ? '编辑模型' : '新增模型' }}</div>
            <el-form label-position="top" size="small">
              <el-form-item label="模型名称" required>
                <el-input v-model="editingModel.name" placeholder="如 gpt-4.1-mini" />
              </el-form-item>
              <el-form-item label="API 地址" required>
                <el-input v-model="editingModel.baseUrl" placeholder="https://api.openai.com" />
              </el-form-item>
              <el-form-item label="API 密钥">
                <el-input
                  v-model="editingModel.apiKey"
                  type="password"
                  show-password
                  placeholder="sk-..."
                />
              </el-form-item>
              <el-form-item label="超时时间（毫秒）">
                <el-input-number
                  v-model="editingModel.timeoutMs"
                  :min="0"
                  :step="10000"
                  :controls="true"
                  style="width: 100%"
                />
                <div class="form-hint">0 或负数表示不启用超时，默认 120000</div>
              </el-form-item>
              <div class="form-buttons">
                <el-button size="small" @click="resetModelForm">取消</el-button>
                <el-button size="small" :loading="testingModel" @click="testModelConnection">
                  测试连接
                </el-button>
                <el-button size="small" type="primary" @click="saveModel">保存模型</el-button>
              </div>
            </el-form>
          </div>
        </div>
      </el-tab-pane>

      <!-- ==================== Prompt 模板 ==================== -->
      <el-tab-pane label="Prompt 模板" name="prompts">
        <div class="prompt-layout">
          <!-- 方案选择栏 -->
          <div class="scheme-bar">
            <el-select
              :model-value="currentSchemeId"
              placeholder="选择方案"
              size="small"
              style="width: 180px"
              @change="onSchemeChange"
            >
              <el-option
                v-for="scheme in settings?.promptSchemes || []"
                :key="scheme.id"
                :label="scheme.name + (scheme.id === settings?.activeSchemeId ? ' (激活)' : '')"
                :value="scheme.id"
              />
            </el-select>
            <el-input
              v-model="currentSchemeName"
              size="small"
              placeholder="方案名称"
              style="width: 140px"
            />
            <el-button size="small" @click="saveScheme">保存方案</el-button>
            <el-button size="small" @click="saveAsNewScheme">另存为</el-button>
            <el-button
              v-if="currentSchemeId !== settings?.activeSchemeId"
              size="small"
              @click="setActiveScheme(currentSchemeId)"
            >
              设为激活
            </el-button>
            <el-popconfirm
              title="确定删除该方案？"
              confirm-button-text="删除"
              cancel-button-text="取消"
              @confirm="deleteCurrentScheme"
            >
              <template #reference>
                <el-button size="small" type="danger" plain>删除</el-button>
              </template>
            </el-popconfirm>
            <el-button size="small" @click="resetToDefaults">恢复默认</el-button>
          </div>

          <!-- 语法警告 -->
          <div v-if="templateWarnings.length" class="syntax-warnings">
            <div v-for="(w, i) in templateWarnings" :key="i" class="warning-item">
              [{{ w.field }}] {{ w.message }}
            </div>
          </div>

          <!-- 函数重构 Prompt -->
          <div class="prompt-section">
            <div class="prompt-section-title">
              函数重构 Prompt
              <el-button size="small" text @click="resetField('functionSystem')">
                重置 System
              </el-button>
              <el-button size="small" text @click="resetField('functionUser')">
                重置 User
              </el-button>
            </div>
            <div class="prompt-field">
              <label>System Prompt</label>
              <el-input
                v-model="editingTemplates.functionSystem"
                type="textarea"
                :rows="3"
                @focus="onTemplateFocus('functionSystem')"
              />
            </div>
            <div class="prompt-field">
              <label>User 模板</label>
              <el-input
                v-model="editingTemplates.functionUser"
                type="textarea"
                :rows="8"
                @focus="onTemplateFocus('functionUser')"
              />
            </div>
            <div class="var-tags">
              <span class="var-label">可用变量：</span>
              <el-tag
                v-for="v in FUNCTION_VARS"
                :key="v.name"
                size="small"
                class="var-tag"
                :title="v.desc"
                @click="insertVariable(v.name)"
              >
                {{ varLabel(v.name) }}
              </el-tag>
            </div>
          </div>

          <!-- 文件重构 Prompt -->
          <div class="prompt-section">
            <div class="prompt-section-title">
              文件重构 Prompt
              <el-button size="small" text @click="resetField('fileSystem')">
                重置 System
              </el-button>
              <el-button size="small" text @click="resetField('fileUser')">
                重置 User
              </el-button>
            </div>
            <div class="prompt-field">
              <label>System Prompt</label>
              <el-input
                v-model="editingTemplates.fileSystem"
                type="textarea"
                :rows="3"
                @focus="onTemplateFocus('fileSystem')"
              />
            </div>
            <div class="prompt-field">
              <label>User 模板</label>
              <el-input
                v-model="editingTemplates.fileUser"
                type="textarea"
                :rows="8"
                @focus="onTemplateFocus('fileUser')"
              />
            </div>
            <div class="var-tags">
              <span class="var-label">可用变量：</span>
              <el-tag
                v-for="v in FILE_VARS"
                :key="v.name"
                size="small"
                class="var-tag"
                :title="v.desc"
                @click="insertVariable(v.name)"
              >
                {{ varLabel(v.name) }}
              </el-tag>
            </div>
          </div>

          <!-- 预览 -->
          <div class="preview-section">
            <div class="preview-header">
              <span>模板预览（使用示例数据渲染）</span>
              <el-button size="small" text @click="showPreview = !showPreview">
                {{ showPreview ? '收起' : '展开' }}
              </el-button>
            </div>
            <div v-if="showPreview" class="preview-body">
              <div class="preview-block">
                <div class="preview-label">函数重构 User 渲染结果：</div>
                <pre class="preview-code">{{ previewFunctionUser }}</pre>
              </div>
              <div class="preview-block">
                <div class="preview-label">文件重构 User 渲染结果：</div>
                <pre class="preview-code">{{ previewFileUser }}</pre>
              </div>
            </div>
          </div>
        </div>
      </el-tab-pane>
    </el-tabs>

    <template #footer>
      <div class="dialog-footer">
        <div class="footer-left">
          <el-button size="small" @click="importSettings">导入配置</el-button>
          <el-button size="small" @click="exportSettings">导出配置</el-button>
        </div>
        <div class="footer-right">
          <el-button size="small" @click="onCancel">取消</el-button>
          <el-button size="small" type="primary" @click="onSaveAndClose">保存</el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.settings-dialog :deep(.el-dialog) {
  background: var(--color-background-soft);
  border: 1px solid var(--ev-c-gray-3);
  box-shadow: 0 18px 48px rgba(30, 36, 48, 0.16);
}

.settings-dialog :deep(.el-dialog__header) {
  border-bottom: 1px solid var(--ev-c-gray-3);
  padding: 12px 16px;
  margin-right: 0;
}

.settings-dialog :deep(.el-dialog__title) {
  font-size: 14px;
  font-weight: 600;
  color: var(--ev-c-text-1);
}

.settings-dialog :deep(.el-dialog__body) {
  padding: 12px 16px;
  max-height: 65vh;
  overflow-y: auto;
}

.settings-dialog :deep(.el-dialog__footer) {
  border-top: 1px solid var(--ev-c-gray-3);
  padding: 10px 16px;
}

.settings-tabs :deep(.el-tabs__item) {
  font-size: 13px;
  color: var(--ev-c-text-2);
}

.settings-tabs :deep(.el-tabs__item.is-active) {
  color: var(--ev-c-accent);
}

/* 模型管理布局 */
.models-layout {
  display: flex;
  gap: 16px;
  min-height: 300px;
}

.model-list {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--ev-c-gray-3);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  background: var(--color-background-soft);
  overflow: hidden;
}

.model-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid var(--ev-c-gray-3);
  background: var(--el-fill-color-light);
}

.list-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--ev-c-text-1);
}

.model-items {
  flex: 1;
  overflow-y: auto;
}

.model-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid var(--ev-c-gray-3);
  cursor: pointer;
  transition: background 0.15s;
}

.model-item:last-child {
  border-bottom: none;
}

.model-item:hover {
  background: var(--ev-c-accent-bg);
}

.model-item.is-active {
  background: var(--ev-c-accent-bg);
}

.model-item.is-active .model-name {
  color: var(--ev-c-accent);
}

.model-info {
  flex: 1;
  min-width: 0;
}

.model-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--ev-c-text-1);
  display: flex;
  align-items: center;
  gap: 6px;
}

.active-badge {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(63, 143, 63, 0.12);
  color: var(--ev-c-good);
  font-weight: 500;
}

.model-url {
  font-size: 11px;
  color: var(--ev-c-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 2px;
}

.model-actions {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}

.model-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ev-c-text-2);
  font-size: 12px;
  padding: 20px;
  text-align: center;
}

.model-form {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--ev-c-gray-3);
  border-radius: 6px;
  padding: 12px;
  background: var(--color-background-soft);
}

.form-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--ev-c-text-1);
  margin-bottom: 10px;
}

.form-hint {
  font-size: 11px;
  color: var(--ev-c-text-2);
  margin-top: 4px;
}

.form-buttons {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}

.model-form :deep(.el-form-item__label) {
  font-size: 12px;
  color: var(--ev-c-text-2);
}

/* Prompt 模板布局 */
.prompt-layout {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.scheme-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.syntax-warnings {
  background: rgba(192, 122, 16, 0.08);
  border: 1px solid rgba(192, 122, 16, 0.28);
  border-radius: 4px;
  padding: 8px 10px;
}

.warning-item {
  font-size: 11px;
  color: var(--ev-c-warn);
  line-height: 1.6;
}

.prompt-section {
  border: 1px solid var(--ev-c-gray-3);
  border-radius: 6px;
  padding: 10px;
  background: var(--color-background-soft);
}

.prompt-section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--ev-c-text-1);
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.prompt-field {
  margin-bottom: 8px;
}

.prompt-field label {
  display: block;
  font-size: 11px;
  color: var(--ev-c-text-2);
  margin-bottom: 4px;
}

.prompt-field :deep(.el-textarea__inner) {
  font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
  font-size: 12px;
  line-height: 1.5;
  background: var(--color-background-soft);
  color: var(--ev-c-text-1);
  box-shadow: 0 0 0 1px var(--ev-c-gray-3) inset;
}

.var-tags {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 4px;
}

.var-label {
  font-size: 11px;
  color: var(--ev-c-text-2);
}

.var-tag {
  cursor: pointer;
  font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
}

.var-tag:hover {
  opacity: 0.8;
}

/* 预览 */
.preview-section {
  border: 1px solid var(--ev-c-gray-3);
  border-radius: 6px;
  overflow: hidden;
  background: var(--color-background-soft);
}

.preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  font-size: 12px;
  font-weight: 500;
  color: var(--ev-c-text-1);
  border-bottom: 1px solid var(--ev-c-gray-3);
  background: var(--el-fill-color-light);
}

.preview-body {
  padding: 10px;
  max-height: 300px;
  overflow-y: auto;
}

.preview-block {
  margin-bottom: 12px;
}

.preview-block:last-child {
  margin-bottom: 0;
}

.preview-label {
  font-size: 11px;
  color: var(--ev-c-text-2);
  margin-bottom: 4px;
}

.preview-code {
  font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
  font-size: 11px;
  line-height: 1.5;
  color: var(--ev-c-text-1);
  background: var(--ev-c-white-soft);
  border: 1px solid var(--ev-c-gray-3);
  border-radius: 4px;
  padding: 8px;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
}

/* 对话框底部 */
.dialog-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.footer-left,
.footer-right {
  display: flex;
  gap: 8px;
}
</style>
