<script setup lang="ts">
import { ref, watch } from "vue";
import { NButton, NInput, NModal, NRadioButton, NRadioGroup, NSelect, NSwitch, useMessage } from "naive-ui";
import { errorText } from "../api";
import { LOCAL_GROUPS } from "../localSnippets";
import type { Snippet } from "../snippets";
import { useConsoleStore } from "../stores/console";

const props = defineProps<{ show: boolean; draft: Snippet | null }>();
const emit = defineEmits<{ "update:show": [v: boolean] }>();
const console_ = useConsoleStore();
const message = useMessage();
const groupOptions = LOCAL_GROUPS.map((g) => ({ label: g, value: g }));

// 弹窗内编辑副本，取消时不影响调用方
const local = ref<Snippet | null>(null);
watch(
  () => props.show,
  (v) => v && (local.value = props.draft ? { ...props.draft } : null),
  { immediate: true },
);

async function save() {
  const d = local.value;
  if (!d || !d.name.trim() || !d.command.trim()) return message.warning("名称和命令都要填");
  try {
    await console_.saveSnippet({ ...d, name: d.name.trim(), command: d.command.trim() });
    emit("update:show", false);
    message.success("已保存");
  } catch (e) {
    message.error(errorText(e));
  }
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    :title="draft?.name ? `编辑：${draft.name}` : '新建本机快捷命令'"
    style="width: 560px"
    @update:show="emit('update:show', $event)"
  >
    <div v-if="local" class="form">
      <label>名称</label>
      <n-input v-model:value="local.name" placeholder="例如：重启 nginx（本机）" />
      <label>命令</label>
      <n-input
        v-model:value="local.command"
        type="textarea"
        :autosize="{ minRows: 2, maxRows: 6 }"
        class="mono"
        placeholder="在本机登录 shell 里执行，可用 && 串多条"
      />
      <label>分组</label>
      <n-select v-model:value="local.group" :options="groupOptions" filterable tag />
      <label>方式</label>
      <n-radio-group v-model:value="local.mode" size="small">
        <n-radio-button value="silent">后台执行，显示输出</n-radio-button>
        <n-radio-button value="terminal">在终端里执行</n-radio-button>
      </n-radio-group>
      <label>确认</label>
      <div class="inline">
        <label class="opt"><n-switch v-model:value="local.confirm" size="small" /> 执行前确认</label>
        <label class="opt"><n-switch v-model:value="local.danger" size="small" /> 标红（危险操作）</label>
      </div>
    </div>
    <template #footer>
      <div class="inline end">
        <n-button @click="emit('update:show', false)">取消</n-button>
        <n-button type="primary" @click="save">保存</n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.form {
  display: grid;
  grid-template-columns: 60px minmax(0, 1fr);
  gap: 12px;
  align-items: center;
}

.form label {
  font-size: 12.5px;
  color: var(--text-3);
}

.inline {
  display: flex;
  align-items: center;
  gap: 16px;
}

.inline.end {
  justify-content: flex-end;
  gap: 8px;
}

.opt {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--text-2) !important;
}
</style>
