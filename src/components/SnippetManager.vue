<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import {
  NButton,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NRadioButton,
  NRadioGroup,
  NScrollbar,
  NSelect,
  NSpace,
  NSwitch,
  NTag,
  useMessage,
} from "naive-ui";
import { Eye, EyeOff, Pencil, Plus, Terminal, Trash2, Zap } from "lucide-vue-next";
import { BUILTIN_SNIPPETS, SNIPPET_GROUPS, newCustomSnippet, type Snippet } from "../snippets";
import { useCommandsStore } from "../stores/commands";
import { useHostsStore } from "../stores/hosts";
import { errorText } from "../api";

const commands = useCommandsStore();
const hosts = useHostsStore();
const message = useMessage();

const custom = ref<Snippet[]>([]);
const hidden = ref<string[]>([]);
const editing = ref<Snippet | null>(null);
const saving = ref(false);
const dirty = ref(false);

const form = reactive<Snippet>(newCustomSnippet());

function load() {
  custom.value = commands.customSnippets.map((s) => ({ ...s, hostIds: [...s.hostIds] }));
  hidden.value = [...commands.hiddenIds];
  editing.value = null;
  dirty.value = false;
}

watch(() => commands.managerOpen, (v) => v && load());

const groupOptions = computed(() =>
  [...new Set([...SNIPPET_GROUPS, ...custom.value.map((s) => s.group)])].map((g) => ({ label: g, value: g })),
);
const hostOptions = computed(() => hosts.servers.map((h) => ({ label: h.alias, value: h.id })));

function startEdit(s: Snippet | null) {
  const base = s ?? newCustomSnippet();
  Object.assign(form, { ...base, hostIds: [...base.hostIds] });
  editing.value = base;
}

function cancelEdit() {
  editing.value = null;
}

function commitEdit() {
  if (!form.name.trim()) return message.warning("名称必填");
  if (!form.command.trim()) return message.warning("命令必填");
  const next: Snippet = { ...form, name: form.name.trim(), command: form.command.trim(), builtin: false };
  const idx = custom.value.findIndex((s) => s.id === next.id);
  if (idx >= 0) custom.value.splice(idx, 1, next);
  else custom.value.push(next);
  editing.value = null;
  dirty.value = true;
}

function remove(s: Snippet) {
  custom.value = custom.value.filter((x) => x.id !== s.id);
  dirty.value = true;
}

function toggleHidden(id: string) {
  hidden.value = hidden.value.includes(id) ? hidden.value.filter((x) => x !== id) : [...hidden.value, id];
  dirty.value = true;
}

async function save() {
  saving.value = true;
  try {
    await commands.saveSnippets(custom.value, hidden.value);
    dirty.value = false;
    message.success("已保存");
    commands.managerOpen = false;
  } catch (e) {
    message.error(errorText(e));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <n-modal
    v-model:show="commands.managerOpen"
    preset="card"
    title="管理快捷命令"
    style="width: 820px; max-width: calc(100vw - 40px)"
    :mask-closable="!dirty"
  >
    <n-scrollbar style="max-height: 70vh">
      <section class="section">
        <h3>
          自定义命令
          <n-button size="tiny" secondary class="h3-action" @click="startEdit(null)">
            <template #icon><Plus :size="12" /></template>
            新增
          </n-button>
        </h3>
        <p class="muted hint">
          命令里可以写 <span class="mono">{sudo}</span>：目标主机用户是 root 时展开为空，否则展开为
          <span class="mono">sudo&nbsp;</span>。后台模式无法输入 sudo 密码，需要密码的命令请选终端模式。
        </p>

        <div v-if="editing" class="editor">
          <n-form label-placement="left" label-width="90" size="small">
            <n-form-item label="名称">
              <n-input v-model:value="form.name" placeholder="例如：重启 nginx" />
            </n-form-item>
            <n-form-item label="命令">
              <n-input
                v-model:value="form.command"
                type="textarea"
                class="mono"
                :autosize="{ minRows: 2, maxRows: 6 }"
                placeholder="{sudo}systemctl restart nginx"
                spellcheck="false"
              />
            </n-form-item>
            <n-form-item label="分组">
              <n-select v-model:value="form.group" filterable tag :options="groupOptions" />
            </n-form-item>
            <n-form-item label="模式">
              <n-radio-group v-model:value="form.mode" size="small">
                <n-radio-button value="silent">后台执行并显示输出</n-radio-button>
                <n-radio-button value="terminal">在终端里执行</n-radio-button>
              </n-radio-group>
            </n-form-item>
            <n-form-item label="选项">
              <n-space :size="18" align="center">
                <label class="opt"><n-switch v-model:value="form.confirm" size="small" /> 执行前确认</label>
                <label class="opt"><n-switch v-model:value="form.danger" size="small" /> 标为危险</label>
                <label class="opt"><n-switch v-model:value="form.watchReboot" size="small" /> 执行后监视重启</label>
              </n-space>
            </n-form-item>
            <n-form-item label="适用主机">
              <n-select
                v-model:value="form.hostIds"
                multiple
                filterable
                clearable
                :options="hostOptions"
                placeholder="留空 = 所有主机"
              />
            </n-form-item>
          </n-form>
          <n-space justify="end">
            <n-button size="small" @click="cancelEdit">取消</n-button>
            <n-button size="small" type="primary" @click="commitEdit">确定</n-button>
          </n-space>
        </div>

        <div v-if="custom.length === 0 && !editing" class="muted empty">还没有自定义命令</div>
        <div v-for="s in custom" :key="s.id" class="row">
          <component :is="s.mode === 'terminal' ? Terminal : Zap" :size="13" class="muted" />
          <div class="row-main">
            <div class="row-name">
              {{ s.name }}
              <n-tag size="tiny" round :bordered="false">{{ s.group }}</n-tag>
              <n-tag v-if="s.danger" size="tiny" round :bordered="false" type="error">危险</n-tag>
              <n-tag v-if="s.hostIds.length" size="tiny" round :bordered="false">{{ s.hostIds.length }} 台主机</n-tag>
            </div>
            <div class="row-cmd mono muted">{{ s.command }}</div>
          </div>
          <n-button size="tiny" quaternary @click="startEdit(s)">
            <template #icon><Pencil :size="12" /></template>
          </n-button>
          <n-button size="tiny" quaternary type="error" @click="remove(s)">
            <template #icon><Trash2 :size="12" /></template>
          </n-button>
        </div>
      </section>

      <section class="section">
        <h3>内置命令 <span class="muted hint-inline">不需要的可以隐藏</span></h3>
        <div v-for="s in BUILTIN_SNIPPETS" :key="s.id" class="row" :class="{ off: hidden.includes(s.id) }">
          <component :is="s.mode === 'terminal' ? Terminal : Zap" :size="13" class="muted" />
          <div class="row-main">
            <div class="row-name">
              {{ s.name }}
              <n-tag size="tiny" round :bordered="false">{{ s.group }}</n-tag>
              <n-tag v-if="s.danger" size="tiny" round :bordered="false" type="error">危险</n-tag>
            </div>
            <div class="row-cmd mono muted">{{ s.command }}</div>
          </div>
          <n-button size="tiny" quaternary @click="toggleHidden(s.id)">
            <template #icon>
              <Eye v-if="hidden.includes(s.id)" :size="12" />
              <EyeOff v-else :size="12" />
            </template>
            {{ hidden.includes(s.id) ? "显示" : "隐藏" }}
          </n-button>
        </div>
      </section>
    </n-scrollbar>

    <template #footer>
      <n-space justify="end">
        <n-button @click="commands.managerOpen = false">取消</n-button>
        <n-button type="primary" :loading="saving" :disabled="!dirty" @click="save">保存</n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<style scoped>
.section {
  margin-bottom: 22px;
  padding-right: 6px;
}

.section h3 {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--text-3);
  display: flex;
  align-items: center;
  gap: 10px;
}

.h3-action {
  margin-left: auto;
}

.hint {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.6;
}

.hint-inline {
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  font-size: 11.5px;
}

.editor {
  padding: 14px 16px 12px;
  margin-bottom: 12px;
  border: 1px solid rgba(91, 141, 239, 0.35);
  border-radius: 10px;
  background: rgba(91, 141, 239, 0.06);
}

.opt {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
}

.empty {
  padding: 16px;
  text-align: center;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
}

.row:hover {
  background: var(--hover-1);
}

.row.off {
  opacity: 0.45;
}

.row-main {
  flex: 1;
  min-width: 0;
}

.row-name {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 13px;
}

.row-cmd {
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
