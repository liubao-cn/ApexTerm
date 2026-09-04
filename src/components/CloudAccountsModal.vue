<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import {
  NButton,
  NCheckbox,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NRadioButton,
  NRadioGroup,
  NScrollbar,
  NSpace,
  NTag,
  useDialog,
  useMessage,
} from "naive-ui";
import { Cloud, Link2, Plus, Radar, Trash2 } from "lucide-vue-next";
import {
  PRODUCT_LABEL,
  PROVIDER_LABEL,
  STATE_LABEL,
  errorText,
  type CloudInstance,
  type CloudProvider,
  type ScanResult,
} from "../api";
import { useCloudStore } from "../stores/cloud";
import { useHostsStore } from "../stores/hosts";

const cloud = useCloudStore();
const hosts = useHostsStore();
const message = useMessage();
const dialog = useDialog();

// ---- 添加账号 ----
const adding = ref(false);
const saving = ref(false);
const form = reactive({
  provider: "tencent" as CloudProvider,
  name: "",
  keyId: "",
  secret: "",
  regions: "",
});

const keyHint = computed(() =>
  form.provider === "tencent"
    ? "腾讯云控制台 → 访问管理 → API 密钥管理。建议新建子账号，只授予 QcloudCVMReadOnlyAccess + 开关机、QcloudLighthouse 对应权限"
    : "火山引擎控制台 → 访问控制 → 密钥管理。建议子用户只授予 ECS 查询与开关机权限",
);

async function submitAccount() {
  if (!form.keyId.trim() || !form.secret.trim()) return message.warning("请填写密钥");
  saving.value = true;
  try {
    const regions = form.regions.split(/[,\s，]+/).map((s) => s.trim()).filter(Boolean);
    await cloud.addAccount(form.provider, form.name, form.keyId, form.secret, regions);
    message.success("账号已添加，SecretKey 已存入钥匙串");
    form.secret = "";
    form.keyId = "";
    form.name = "";
    form.regions = "";
    adding.value = false;
  } catch (e) {
    message.error(errorText(e));
  } finally {
    saving.value = false;
  }
}

function confirmRemove(id: string, name: string) {
  dialog.warning({
    title: `删除云账号 ${name}？`,
    content: "会从钥匙串删除 SecretKey，并解除该账号下所有主机的实例绑定。",
    positiveText: "删除",
    negativeText: "取消",
    onPositiveClick: async () => {
      try {
        await cloud.removeAccount(id);
        message.success("已删除");
      } catch (e) {
        message.error(errorText(e));
      }
    },
  });
}

// ---- 扫描与匹配 ----
const scanningId = ref<string | null>(null);
const scanResult = ref<ScanResult | null>(null);
const scanAccountId = ref<string | null>(null);
const selected = ref<Set<string>>(new Set());
const binding = ref(false);

async function scan(accountId: string) {
  scanningId.value = accountId;
  scanResult.value = null;
  try {
    const r = await cloud.scan(accountId);
    scanResult.value = r;
    scanAccountId.value = accountId;
    selected.value = new Set(
      r.matches
        .filter((m) => !alreadyBound(m.hostId, m.instance))
        .map((m) => m.hostId),
    );
    if (r.errors.length) message.warning(`${r.errors.length} 个地域查询失败，其余已列出`);
  } catch (e) {
    message.error(errorText(e));
  } finally {
    scanningId.value = null;
  }
}

function alreadyBound(hostId: string, inst: CloudInstance): boolean {
  const b = cloud.bindingOf(hostId);
  return !!b && b.instanceId === inst.instanceId;
}

function toggle(hostId: string) {
  const next = new Set(selected.value);
  if (next.has(hostId)) next.delete(hostId);
  else next.add(hostId);
  selected.value = next;
}

async function bindSelected() {
  const r = scanResult.value;
  if (!r) return;
  const list = r.matches
    .filter((m) => selected.value.has(m.hostId))
    .map((m) => ({
      hostId: m.hostId,
      binding: {
        accountId: m.instance.accountId,
        provider: m.instance.provider,
        product: m.instance.product,
        region: m.instance.region,
        instanceId: m.instance.instanceId,
        instanceName: m.instance.name,
      },
    }));
  if (list.length === 0) return;
  binding.value = true;
  try {
    await cloud.bind(list);
    message.success(`已绑定 ${list.length} 台，详情页可以直接开关机了`);
    selected.value = new Set();
  } catch (e) {
    message.error(errorText(e));
  } finally {
    binding.value = false;
  }
}

const unmatched = computed(() => {
  const r = scanResult.value;
  if (!r) return [];
  const matchedIds = new Set(r.matches.map((m) => m.instance.instanceId));
  return r.instances.filter((i) => !matchedIds.has(i.instanceId));
});

const boundCount = computed(
  () => hosts.hosts.filter((h) => !!cloud.bindingOf(h.id)).length,
);

watch(
  () => cloud.modalOpen,
  (v) => {
    if (!v) {
      scanResult.value = null;
      adding.value = false;
    }
  },
);
</script>

<template>
  <n-modal
    v-model:show="cloud.modalOpen"
    preset="card"
    title="云账号与带外电源控制"
    style="width: 880px; max-width: calc(100vw - 40px)"
  >
    <n-scrollbar style="max-height: 72vh">
      <p class="muted intro">
        绑定云账号后，程序能绕过 SSH 直接开机 / 强制重启 / 关机——服务器卡死、SSH 进不去时靠的就是这条通道。
        SecretKey 只存在系统钥匙串里，不写入任何配置文件。当前已绑定 <b>{{ boundCount }}</b> 台主机。
      </p>

      <section class="section">
        <h3>
          云账号
          <n-button v-if="!adding" size="tiny" secondary class="h3-action" @click="adding = true">
            <template #icon><Plus :size="12" /></template>
            添加账号
          </n-button>
        </h3>

        <div v-if="adding" class="editor">
          <n-form label-placement="left" label-width="90" size="small">
            <n-form-item label="厂商">
              <n-radio-group v-model:value="form.provider" size="small">
                <n-radio-button value="tencent">腾讯云</n-radio-button>
                <n-radio-button value="volcengine">火山引擎</n-radio-button>
              </n-radio-group>
            </n-form-item>
            <n-form-item label="备注名">
              <n-input v-model:value="form.name" placeholder="例如：公司主账号（可留空）" />
            </n-form-item>
            <n-form-item :label="form.provider === 'tencent' ? 'SecretId' : 'Access Key'">
              <n-input v-model:value="form.keyId" class="mono" spellcheck="false" />
            </n-form-item>
            <n-form-item :label="form.provider === 'tencent' ? 'SecretKey' : 'Secret Key'">
              <n-input
                v-model:value="form.secret"
                type="password"
                show-password-on="click"
                class="mono"
                spellcheck="false"
              />
            </n-form-item>
            <n-form-item label="限定地域">
              <n-input
                v-model:value="form.regions"
                class="mono"
                placeholder="留空 = 自动扫描全部地域；也可填 ap-guangzhou, ap-singapore"
              />
            </n-form-item>
          </n-form>
          <p class="muted hint">{{ keyHint }}</p>
          <n-space justify="end">
            <n-button size="small" @click="adding = false">取消</n-button>
            <n-button size="small" type="primary" :loading="saving" @click="submitAccount">
              校验并保存
            </n-button>
          </n-space>
        </div>

        <div v-if="cloud.accounts.length === 0 && !adding" class="muted empty">还没有云账号</div>
        <div v-for="a in cloud.accounts" :key="a.id" class="row">
          <Cloud :size="15" class="muted" />
          <div class="row-main">
            <div class="row-name">
              {{ a.name }}
              <n-tag size="tiny" round :bordered="false" :class="['prov', a.provider]">{{ PROVIDER_LABEL[a.provider] }}</n-tag>
              <span class="mono muted small">{{ a.keyId.slice(0, 8) }}…</span>
              <span v-if="a.regions.length" class="muted small">仅 {{ a.regions.join(", ") }}</span>
            </div>
          </div>
          <n-button size="tiny" secondary :loading="scanningId === a.id" @click="scan(a.id)">
            <template #icon><Radar :size="12" /></template>
            扫描实例并匹配
          </n-button>
          <n-button size="tiny" quaternary type="error" @click="confirmRemove(a.id, a.name)">
            <template #icon><Trash2 :size="12" /></template>
          </n-button>
        </div>
      </section>

      <section v-if="scanResult" class="section">
        <h3>
          扫描结果
          <span class="hint-inline muted">
            {{ scanResult.regionsScanned }} 个地域 · {{ scanResult.instances.length }} 台实例 · 匹配到 {{ scanResult.matches.length }} 台
          </span>
        </h3>
        <div v-for="err in scanResult.errors" :key="err" class="err small">{{ err }}</div>

        <div v-if="scanResult.matches.length" class="matches">
          <div v-for="m in scanResult.matches" :key="m.hostId" class="row match" @click="toggle(m.hostId)">
            <n-checkbox :checked="selected.has(m.hostId)" @click.stop @update:checked="toggle(m.hostId)" />
            <div class="row-main">
              <div class="row-name">
                <b>{{ m.alias }}</b>
                <Link2 :size="12" class="muted" />
                <span>{{ m.instance.name || m.instance.instanceId }}</span>
                <n-tag size="tiny" round :bordered="false">{{ PRODUCT_LABEL[m.instance.product] }}</n-tag>
                <n-tag size="tiny" round :bordered="false" :type="m.instance.state === 'running' ? 'success' : 'default'">
                  {{ STATE_LABEL[m.instance.state] }}
                </n-tag>
                <n-tag v-if="alreadyBound(m.hostId, m.instance)" size="tiny" round :bordered="false" type="info">已绑定</n-tag>
              </div>
              <div class="muted small mono">
                {{ m.instance.instanceId }} · {{ m.instance.zone || m.instance.region }} ·
                {{ m.instance.publicIps.map((ip) => hosts.mask(ip)).join(", ") }}
                · {{ m.instance.cpu }}C{{ m.instance.memoryGb }}G · {{ m.instance.os }}
              </div>
            </div>
          </div>
          <n-space justify="end" style="margin-top: 8px">
            <n-button size="small" type="primary" :disabled="selected.size === 0" :loading="binding" @click="bindSelected">
              绑定选中的 {{ selected.size }} 台
            </n-button>
          </n-space>
        </div>
        <div v-else class="muted empty">
          没有实例的公网 IP 和 config 里的地址对得上。
        </div>

        <details v-if="unmatched.length" class="unmatched">
          <summary class="muted">未匹配到 config 主机的实例（{{ unmatched.length }}）</summary>
          <div v-for="i in unmatched" :key="i.instanceId" class="row">
            <div class="row-main">
              <div class="row-name">
                {{ i.name || i.instanceId }}
                <n-tag size="tiny" round :bordered="false">{{ PRODUCT_LABEL[i.product] }}</n-tag>
                <n-tag size="tiny" round :bordered="false">{{ STATE_LABEL[i.state] }}</n-tag>
              </div>
              <div class="muted small mono">
                {{ i.instanceId }} · {{ i.zone || i.region }} ·
                {{ i.publicIps.map((ip) => hosts.mask(ip)).join(", ") || "无公网 IP" }}
              </div>
            </div>
          </div>
        </details>
      </section>
    </n-scrollbar>
  </n-modal>
</template>

<style scoped>
.intro {
  margin: 0 0 16px;
  font-size: 12.5px;
  line-height: 1.7;
}

.intro b {
  color: var(--text-1);
}

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
  flex-wrap: wrap;
  gap: 10px;
}

.h3-action {
  margin-left: auto;
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

.hint {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.6;
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

.row.match {
  cursor: default;
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

.small {
  font-size: 11.5px;
}

.err {
  color: var(--red);
  margin-bottom: 4px;
}

.prov.tencent {
  background: rgba(0, 82, 217, 0.25);
  color: var(--accent-text);
}

.prov.volcengine {
  background: rgba(22, 100, 255, 0.2);
  color: var(--accent-text);
}

.unmatched {
  margin-top: 10px;
}

.unmatched summary {
  cursor: default;
  font-size: 12px;
  padding: 4px 0;
}
</style>
