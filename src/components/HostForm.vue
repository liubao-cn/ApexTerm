<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import {
  NButton,
  NForm,
  NFormItem,
  NFormItemGi,
  NGrid,
  NInput,
  NInputNumber,
  NModal,
  NSelect,
  NSpace,
  NSwitch,
  useMessage,
  type FormInst,
  type FormRules,
} from "naive-ui";
import { ClipboardPaste } from "lucide-vue-next";
import { useHostsStore } from "../stores/hosts";
import { errorText, type HostEntry, type HostInput } from "../api";
import { parseSshCommand, suggestAlias } from "../utils";

const props = defineProps<{
  host: HostEntry | null;
  /** 从候选区「收编」时的预填值 */
  prefill?: Partial<HostInput> | null;
}>();
const show = defineModel<boolean>("show", { required: true });

const store = useHostsStore();
const message = useMessage();
const formRef = ref<FormInst | null>(null);
const saving = ref(false);

const model = reactive({
  alias: "",
  hostName: "",
  user: "",
  port: null as number | null,
  identityFiles: [] as string[],
  identitiesOnly: false,
  proxyJump: "",
  description: "",
});

const pasteCmd = ref("");

function reset() {
  const h = props.host;
  const p = props.prefill;
  model.alias = h?.alias ?? p?.alias ?? "";
  model.hostName = h?.hostName ?? p?.hostName ?? "";
  model.user = h?.user ?? p?.user ?? "root";
  model.port = h?.port ?? p?.port ?? null;
  model.identityFiles = h
    ? [...h.identityFiles]
    : p?.identityFiles
      ? [...p.identityFiles]
      : ["~/.ssh/id_ed25519"];
  model.identitiesOnly = h ? h.identitiesOnly : (p?.identitiesOnly ?? true);
  model.proxyJump = h?.proxyJump ?? p?.proxyJump ?? "";
  model.description = h?.description ?? p?.description ?? "";
  pasteCmd.value = "";
}

watch(show, (v) => v && reset());

const isEdit = computed(() => props.host !== null);
const isAdopt = computed(() => !isEdit.value && !!props.prefill);

function aliasTaken(alias: string): boolean {
  return store.hosts.some((h) => h.alias === alias && h.id !== props.host?.id);
}

const keyOptions = computed(() =>
  store.keys
    .filter((k) => k.hasPrivate)
    .map((k) => ({
      label: k.fingerprint ? `${k.path}  ·  ${k.algorithm} ${k.comment || ""}`.trim() : k.path,
      value: k.path,
    })),
);

const rules: FormRules = {
  alias: [
    { required: true, message: "别名必填", trigger: ["input", "blur"] },
    {
      validator: (_r, v: string) => !/[\s*?!#"]/.test(v),
      message: "别名不能包含空格和 * ? ! # \" 字符",
      trigger: ["input", "blur"],
    },
    {
      validator: (_r, v: string) => !aliasTaken(v.trim()),
      message: "这个别名已经存在",
      trigger: ["input", "blur"],
    },
  ],
  hostName: [{ required: true, message: "地址必填", trigger: ["input", "blur"] }],
};

function applyPaste() {
  const parsed = parseSshCommand(pasteCmd.value);
  if (!parsed) {
    message.warning("没识别出主机地址，格式示例：ssh -p 2222 root@1.2.3.4");
    return;
  }
  model.hostName = parsed.hostName;
  if (parsed.user) model.user = parsed.user;
  if (parsed.port) model.port = parsed.port;
  if (parsed.identityFiles.length) model.identityFiles = parsed.identityFiles;
  if (parsed.proxyJump) model.proxyJump = parsed.proxyJump;
  if (!model.alias) model.alias = suggestAlias(parsed.hostName, parsed.user);
  message.success("已填充，请检查后保存");
}

async function submit() {
  try {
    await formRef.value?.validate();
  } catch {
    return;
  }
  const input: HostInput = {
    originalId: props.host?.id ?? null,
    alias: model.alias.trim(),
    hostName: model.hostName.trim(),
    user: model.user.trim() || null,
    port: model.port && model.port !== 22 ? model.port : null,
    identityFiles: model.identityFiles,
    identitiesOnly: model.identitiesOnly && model.identityFiles.length > 0,
    proxyJump: model.proxyJump.trim() || null,
    description: model.description.trim(),
  };
  saving.value = true;
  try {
    await store.upsert(input);
    message.success(isEdit.value ? "已保存并写回 config" : `已添加，终端里可直接 ssh ${input.alias}`);
    show.value = false;
  } catch (e) {
    message.error(errorText(e));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <n-modal
    v-model:show="show"
    preset="card"
    :title="isEdit ? `编辑 ${host?.alias}` : isAdopt ? `收编 ${prefill?.hostName}` : '添加服务器'"
    style="width: 600px"
    :mask-closable="false"
  >
    <div v-if="!isEdit && !isAdopt" class="paste-row">
      <n-input
        v-model:value="pasteCmd"
        size="small"
        placeholder="粘贴一条 ssh 命令快速填充，如 ssh -p 2222 -i ~/.ssh/k root@1.2.3.4"
        class="mono"
        @keyup.enter="applyPaste"
      />
      <n-button size="small" secondary @click="applyPaste">
        <template #icon><ClipboardPaste :size="14" /></template>
        解析
      </n-button>
    </div>

    <n-form
      ref="formRef"
      :model="model"
      :rules="rules"
      label-placement="left"
      label-width="90"
      size="small"
      require-mark-placement="left"
    >
      <n-form-item label="别名" path="alias">
        <n-input v-model:value="model.alias" placeholder="例如 prod-web，之后终端里 ssh prod-web" class="mono" />
      </n-form-item>
      <n-form-item label="地址" path="hostName">
        <n-input v-model:value="model.hostName" placeholder="IP 或域名" class="mono" />
      </n-form-item>
      <n-grid :cols="2" :x-gap="12">
        <n-form-item-gi label="用户" path="user">
          <n-input v-model:value="model.user" placeholder="root" class="mono" />
        </n-form-item-gi>
        <n-form-item-gi label="端口" path="port" label-width="60">
          <n-input-number
            v-model:value="model.port"
            :min="1"
            :max="65535"
            placeholder="22"
            clearable
            :show-button="false"
            style="width: 100%"
          />
        </n-form-item-gi>
      </n-grid>
      <n-form-item label="密钥" path="identityFiles">
        <n-select
          v-model:value="model.identityFiles"
          multiple
          filterable
          tag
          :options="keyOptions"
          placeholder="选择 ~/.ssh 下的密钥，或输入路径后回车"
        />
      </n-form-item>
      <n-form-item label="仅用该密钥" path="identitiesOnly">
        <n-switch v-model:value="model.identitiesOnly" :disabled="model.identityFiles.length === 0" />
        <span class="muted switch-hint">IdentitiesOnly yes，密钥多时避免被服务器拒绝</span>
      </n-form-item>
      <n-form-item label="跳板机" path="proxyJump">
        <n-input v-model:value="model.proxyJump" placeholder="ProxyJump，如 user@bastion:22，可留空" class="mono" />
      </n-form-item>
      <n-form-item label="描述" path="description">
        <n-input v-model:value="model.description" placeholder="写入 config 的注释行，可留空" />
      </n-form-item>
    </n-form>

    <p class="muted foot-hint">
      保存前会自动备份 ~/.ssh/config；{{ isEdit ? "只改动这个 Host 段涉及的行，其它内容原样保留。" : "新主机追加到主 config 末尾。" }}
    </p>

    <template #footer>
      <n-space justify="end">
        <n-button @click="show = false">取消</n-button>
        <n-button type="primary" :loading="saving" @click="submit">
          {{ isEdit ? "保存" : "添加" }}
        </n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<style scoped>
.paste-row {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}

.switch-hint {
  margin-left: 10px;
  font-size: 12px;
}

.foot-hint {
  margin: 4px 0 0;
  font-size: 12px;
}
</style>
