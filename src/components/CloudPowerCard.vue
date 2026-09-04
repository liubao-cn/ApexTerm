<script setup lang="ts">
import { computed, h, onMounted, watch } from "vue";
import { NButton, NTag, NTooltip, useDialog, useMessage } from "naive-ui";
import {
  Cloud,
  ExternalLink,
  Loader2,
  MonitorSmartphone,
  Power,
  PowerOff,
  RefreshCw,
  RotateCcw,
  Unlink,
  Zap,
} from "lucide-vue-next";
import {
  PRODUCT_LABEL,
  PROVIDER_LABEL,
  STATE_LABEL,
  errorText,
  type HostEntry,
  type PowerAction,
} from "../api";
import { useCloudStore } from "../stores/cloud";
import { useCommandsStore } from "../stores/commands";

const props = defineProps<{ host: HostEntry }>();
const cloud = useCloudStore();
const commands = useCommandsStore();
const message = useMessage();
const dialog = useDialog();

const binding = computed(() => cloud.bindingOf(props.host.id));
const state = computed(() => cloud.stateOf(props.host.id));
const inst = computed(() => state.value.instance);
const stateType = computed(() => {
  switch (inst.value?.state) {
    case "running":
      return "success" as const;
    case "stopped":
      return "error" as const;
    case "unknown":
    case undefined:
      return "default" as const;
    default:
      return "warning" as const;
  }
});
const busy = computed(() => {
  const s = inst.value?.state;
  return s === "starting" || s === "stopping" || s === "rebooting" || s === "pending";
});

onMounted(() => {
  if (binding.value && !inst.value) cloud.refresh(props.host.id);
});
watch(
  () => props.host.id,
  () => {
    if (binding.value && !cloud.stateOf(props.host.id).instance) cloud.refresh(props.host.id);
  },
);

interface Act {
  action: PowerAction;
  label: string;
  danger: boolean;
  desc: string;
  icon: typeof Power;
  show: boolean;
}

const actions = computed<Act[]>(() => {
  const s = inst.value?.state;
  const stopped = s === "stopped";
  return [
    { action: "start", label: "开机", danger: false, icon: Power, show: stopped || s === undefined || s === "unknown", desc: "调用云 API 启动实例，开机后自动等待 SSH 恢复" },
    { action: "forceReboot", label: "强制重启", danger: true, icon: Zap, show: !stopped, desc: "相当于按下电源复位键。服务器卡死、SSH 进不去时用这个" },
    { action: "reboot", label: "重启", danger: true, icon: RotateCcw, show: !stopped, desc: "云平台先尝试正常关机再启动，失败才强制" },
    { action: "stop", label: "关机", danger: true, icon: PowerOff, show: !stopped, desc: "正常关机；之后可用这里的「开机」再启动" },
    { action: "forceStop", label: "强制关机", danger: true, icon: PowerOff, show: !stopped, desc: "直接断电，未写盘的数据会丢" },
  ];
});

function run(a: Act) {
  const title = `${a.label} · ${props.host.alias}`;
  dialog[a.danger ? "error" : "info"]({
    title,
    content: () =>
      h("div", { class: "qc-confirm" }, [
        h("div", { class: "qc-confirm-cmd mono" }, `${PROVIDER_LABEL[binding.value!.provider]} · ${binding.value!.instanceName || binding.value!.instanceId}`),
        h("div", { class: "qc-confirm-note" }, a.desc),
      ]),
    positiveText: a.danger ? "确认执行" : "执行",
    negativeText: "取消",
    onPositiveClick: async () => {
      try {
        await cloud.power(props.host, a.action);
        message.success(`已向${PROVIDER_LABEL[binding.value!.provider]}发出「${a.label}」请求`);
      } catch (e) {
        message.error(errorText(e));
      }
    },
  });
}

async function vnc() {
  try {
    await cloud.openVnc(props.host.id);
  } catch (e) {
    message.error(errorText(e));
  }
}

function unbind() {
  dialog.warning({
    title: "解除绑定？",
    content: "只是断开本程序里主机与云实例的关联，不影响服务器本身。",
    positiveText: "解除",
    negativeText: "取消",
    onPositiveClick: async () => {
      try {
        await cloud.bind([{ hostId: props.host.id, binding: null }]);
      } catch (e) {
        message.error(errorText(e));
      }
    },
  });
}
</script>

<template>
  <section class="card">
    <h3>
      云实例 · 带外电源
      <span class="hint">不走 SSH，服务器卡死也能操作</span>
      <template v-if="binding">
        <n-button size="tiny" quaternary class="h3-action" :loading="state.loading" @click="cloud.refresh(host.id)">
          <template #icon><RefreshCw :size="12" /></template>
          刷新
        </n-button>
      </template>
    </h3>

    <template v-if="!binding">
      <div class="unbound">
        <Cloud :size="18" class="muted" />
        <div class="unbound-text">
          <div>还没绑定云实例。绑定后可以在 SSH 失联时开机 / 强制重启。</div>
          <div class="muted small">
            支持腾讯云（CVM / 轻量）和火山引擎。在「云账号」里添加密钥，程序会按公网 IP 自动匹配。
          </div>
        </div>
        <n-button size="small" secondary @click="cloud.modalOpen = true">
          <template #icon><Cloud :size="14" /></template>
          去绑定
        </n-button>
      </div>
    </template>

    <template v-else>
      <div class="inst-row">
        <n-tag size="small" round :bordered="false" :class="['prov', binding.provider]">
          {{ PROVIDER_LABEL[binding.provider] }}
        </n-tag>
        <span class="inst-name">{{ binding.instanceName || binding.instanceId }}</span>
        <span class="mono muted small">{{ binding.instanceId }}</span>
        <n-tag size="small" round :bordered="false" :type="stateType">
          <template #icon><Loader2 v-if="state.loading || busy" :size="11" class="spin" /></template>
          {{ inst ? STATE_LABEL[inst.state] : state.loading ? "查询中…" : "未知" }}
        </n-tag>
      </div>
      <div class="muted small inst-meta">
        {{ PRODUCT_LABEL[binding.product] }} · {{ inst?.zone || binding.region }}
        <template v-if="inst"> · {{ inst.cpu }} 核 {{ inst.memoryGb }} GB · {{ inst.os }}</template>
        <template v-if="state.updatedAt"> · {{ new Date(state.updatedAt).toLocaleTimeString("zh-CN", { hour12: false }) }} 更新</template>
      </div>
      <div v-if="state.error" class="err small">{{ state.error }}</div>

      <div class="power-actions">
        <n-tooltip v-for="a in actions.filter((x) => x.show)" :key="a.action">
          <template #trigger>
            <n-button
              size="small"
              :secondary="!a.danger"
              :tertiary="a.danger"
              :type="a.action === 'start' ? 'success' : a.danger ? 'error' : 'default'"
              :disabled="busy"
              @click="run(a)"
            >
              <template #icon><component :is="a.icon" :size="13" /></template>
              {{ a.label }}
            </n-button>
          </template>
          {{ a.desc }}
        </n-tooltip>
        <n-button v-if="binding.provider === 'tencent'" size="small" secondary @click="vnc">
          <template #icon><MonitorSmartphone :size="13" /></template>
          VNC 控制台
          <ExternalLink :size="11" style="margin-left: 4px; opacity: 0.6" />
        </n-button>
        <n-button size="small" quaternary class="unbind" @click="unbind">
          <template #icon><Unlink :size="13" /></template>
          解除绑定
        </n-button>
      </div>

      <div v-if="commands.watchOf(host.id)" class="muted small">
        重启 / 开机后程序会持续探测 SSH，恢复时提醒；进度见上方标题栏。
      </div>
    </template>
  </section>
</template>

<style scoped>
.card {
  background: var(--panel-bg);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 14px 18px 16px;
}

.card h3 {
  margin: 0 0 12px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--text-3);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 10px;
}

.hint {
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  font-size: 11.5px;
  opacity: 0.8;
}

.h3-action {
  margin-left: auto;
}

.unbound {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.unbound-text {
  flex: 1 1 260px;
  min-width: 0;
  line-height: 1.6;
}

.small {
  font-size: 11.5px;
}

.inst-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.inst-name {
  font-weight: 600;
  font-size: 14px;
}

.inst-meta {
  margin: 6px 0 12px;
}

.err {
  color: var(--red);
  margin-bottom: 8px;
}

.power-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}

.unbind {
  margin-left: auto;
}

.prov.tencent {
  background: rgba(0, 82, 217, 0.25);
  color: var(--accent-text);
}

.prov.volcengine {
  background: rgba(22, 100, 255, 0.2);
  color: var(--accent-text);
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
