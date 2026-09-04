<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  NButton,
  NDynamicTags,
  NInput,
  NModal,
  NScrollbar,
  NSelect,
  NSpace,
  NTag,
  NTooltip,
  useDialog,
  useMessage,
} from "naive-ui";
import {
  AlertTriangle,
  Asterisk,
  Copy,
  FileCode2,
  FolderOpen,
  GitBranch,
  KeyRound,
  Pencil,
  Radar,
  Server,
  Star,
  Terminal,
  Trash2,
} from "lucide-vue-next";
import { useHostsStore } from "../stores/hosts";
import { useTerminalsStore } from "../stores/terminals";
import { useCommandsStore } from "../stores/commands";
import { KIND_LABEL, errorText, sshCommand, type HostEntry } from "../api";
import { debounce } from "../utils";
import QuickCommandsMenu from "./QuickCommandsMenu.vue";
import CloudPowerCard from "./CloudPowerCard.vue";

const props = defineProps<{ host: HostEntry }>();
const emit = defineEmits<{ edit: [host: HostEntry] }>();

const store = useHostsStore();
const terminals = useTerminalsStore();
const commands = useCommandsStore();
const message = useMessage();
const dialog = useDialog();

const alive = computed(() => store.aliveOf(props.host.id));
const aliveText = computed(() => {
  const a = alive.value;
  switch (a.status) {
    case "idle":
      return "未探测";
    case "checking":
      return "探测中…";
    default:
      return `${a.message} · ${new Date(a.checkedAt).toLocaleTimeString("zh-CN", { hour12: false })}`;
  }
});

const rebootWatch = computed(() => commands.watchOf(props.host.id));
const rebootText = computed(() => {
  const w = rebootWatch.value;
  if (!w) return "";
  switch (w.phase) {
    case "waitingDown":
      return `重启中，等待掉线… ${commands.fmtElapsed(w.startedAt)}`;
    case "down":
      return `已掉线，等待恢复… ${commands.fmtElapsed(w.startedAt)}`;
    case "up":
      return `已恢复上线，耗时 ${commands.fmtElapsed(w.startedAt, w.upAt ?? w.startedAt)}`;
    case "timeout":
      return "15 分钟仍未恢复，请到云控制台查看";
  }
});

const openSessions = computed(() =>
  terminals.sessions.filter(
    (s) => s.hostId === props.host.id && (s.status === "running" || s.status === "connecting"),
  ),
);

function connect() {
  terminals.openSsh(props.host);
}

function lastConnectedText(ts: number | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

const meta = computed(() => store.metaOf(props.host.id));
const kindIcon = computed(() =>
  props.host.kind === "gitPlatform" ? GitBranch : props.host.kind === "pattern" ? Asterisk : Server,
);

// ---- 分组 / 标签 / 备注（自动保存） ----
const group = ref<string | null>(null);
const tags = ref<string[]>([]);
const note = ref("");
const saveState = ref<"idle" | "dirty" | "saving" | "saved" | "error">("idle");
let hydrating = false;

function hydrate() {
  hydrating = true;
  const m = store.metaOf(props.host.id);
  group.value = m.group;
  tags.value = [...m.tags];
  note.value = m.note;
  saveState.value = "idle";
  queueMicrotask(() => (hydrating = false));
}

watch(() => props.host.id, hydrate, { immediate: true });

const persist = debounce(async () => {
  saveState.value = "saving";
  try {
    await store.saveMeta(props.host.id, {
      group: group.value?.trim() || null,
      tags: tags.value.map((t) => t.trim()).filter(Boolean),
      note: note.value,
    });
    saveState.value = "saved";
  } catch (e) {
    saveState.value = "error";
    message.error(`保存失败：${errorText(e)}`);
  }
}, 500);

watch([group, tags, note], () => {
  if (hydrating) return;
  saveState.value = "dirty";
  persist();
});

const groupOptions = computed(() =>
  store.groups.map((g) => ({ label: g, value: g })),
);

const saveStateText = computed(
  () =>
    ({
      idle: "",
      dirty: "修改中…",
      saving: "保存中…",
      saved: "已保存",
      error: "保存失败",
    })[saveState.value],
);

// ---- 操作 ----
async function copyCommand() {
  try {
    await navigator.clipboard.writeText(sshCommand(props.host));
    message.success(`已复制：${sshCommand(props.host)}`);
  } catch {
    message.error("复制失败");
  }
}

function confirmDelete() {
  dialog.warning({
    title: `删除 ${props.host.alias}？`,
    content: `将从 ${props.host.sourceFile} 中移除这个 Host 段（删除前会自动备份），程序里的分组备注也会一并清除。`,
    positiveText: "删除",
    negativeText: "取消",
    onPositiveClick: async () => {
      try {
        await store.remove(props.host.id);
        message.success("已删除");
      } catch (e) {
        message.error(errorText(e));
      }
    },
  });
}

// ---- 原文编辑 ----
const rawOpen = ref(false);
const rawText = ref("");
const rawSaving = ref(false);

function openRaw() {
  rawText.value = props.host.raw;
  rawOpen.value = true;
}

async function saveRaw() {
  rawSaving.value = true;
  try {
    await store.replaceRaw(props.host.id, rawText.value);
    rawOpen.value = false;
    message.success("已写回 config");
  } catch (e) {
    message.error(errorText(e));
  } finally {
    rawSaving.value = false;
  }
}

function keyInfo(path: string) {
  return store.keyFor(path);
}
</script>

<template>
  <div class="detail">
    <header class="detail-header">
      <div class="title">
        <div class="kind-badge" :class="host.kind">
          <component :is="kindIcon" :size="20" />
        </div>
        <div class="title-text">
          <div class="alias-row">
            <h1 class="selectable">{{ host.alias }}</h1>
            <n-tag size="small" round :bordered="false" class="kind-tag">{{ KIND_LABEL[host.kind] }}</n-tag>
            <n-button quaternary circle size="small" @click="store.toggleFavorite(host.id)">
              <template #icon>
                <Star :size="16" :fill="meta.favorite ? 'currentColor' : 'none'" :class="{ fav: meta.favorite }" />
              </template>
            </n-button>
          </div>
          <div class="target mono selectable">{{ store.displayTarget(host) }}</div>
          <div class="last muted">
            <span v-if="host.kind !== 'pattern'" class="alive" :class="alive.status">
              <span class="alive-dot"></span>{{ aliveText }}
              <n-button size="tiny" quaternary :loading="alive.status === 'checking'" @click="store.probeHost(host)">
                <template #icon><Radar :size="11" /></template>
                {{ alive.status === "idle" ? "探测" : "重新探测" }}
              </n-button>
            </span>
            <span v-if="meta.lastConnected">
              上次连接 {{ lastConnectedText(meta.lastConnected) }} · 共 {{ meta.connectCount }} 次
            </span>
          </div>
          <div v-if="rebootWatch" class="reboot" :class="rebootWatch.phase">
            <span class="reboot-dot"></span>
            {{ rebootText }}
            <n-button
              v-if="rebootWatch.phase === 'up' || rebootWatch.phase === 'timeout'"
              size="tiny"
              quaternary
              @click="commands.dismissWatch(host.id)"
            >
              知道了
            </n-button>
          </div>
        </div>
      </div>
      <div class="actions">
        <QuickCommandsMenu v-if="host.kind !== 'pattern'" :host="host" />
        <n-button v-if="host.kind === 'server'" secondary size="small" @click="terminals.openFiles(host)">
          <template #icon><FolderOpen :size="14" /></template>
          文件
        </n-button>
        <n-button secondary size="small" @click="copyCommand">
          <template #icon><Copy :size="14" /></template>
          复制命令
        </n-button>
        <n-button secondary size="small" @click="emit('edit', host)">
          <template #icon><Pencil :size="14" /></template>
          编辑
        </n-button>
        <n-button secondary size="small" type="error" @click="confirmDelete">
          <template #icon><Trash2 :size="14" /></template>
          删除
        </n-button>
        <n-tooltip :disabled="host.kind !== 'pattern'">
          <template #trigger>
            <n-button type="primary" size="small" :disabled="host.kind === 'pattern'" @click="connect">
              <template #icon><Terminal :size="14" /></template>
              {{ openSessions.length ? `再开一个（已开 ${openSessions.length}）` : "连接" }}
            </n-button>
          </template>
          通配规则不是具体主机，无法连接
        </n-tooltip>
      </div>
    </header>

    <n-scrollbar class="body-scroll">
      <div class="body">
        <p v-if="host.description" class="description selectable">{{ host.description }}</p>

        <CloudPowerCard v-if="host.kind === 'server'" :host="host" />

        <section class="card">
          <h3>连接参数</h3>
          <dl class="grid">
            <dt>地址</dt>
            <dd class="mono selectable">{{ host.hostName ? store.mask(host.hostName) : "—" }}</dd>
            <dt>用户</dt>
            <dd class="selectable">{{ host.user ?? "（未指定，使用当前用户名）" }}</dd>
            <dt>端口</dt>
            <dd class="mono">{{ host.port ?? 22 }}</dd>
            <dt>密钥</dt>
            <dd>
              <template v-if="host.identityFiles.length">
                <div v-for="f in host.identityFiles" :key="f" class="key-row">
                  <KeyRound :size="13" class="muted" />
                  <span class="mono selectable">{{ store.maskKeyPath(f) }}</span>
                  <template v-if="keyInfo(f)">
                    <span v-if="keyInfo(f)!.hasPrivate" class="muted mono fp">
                      {{ keyInfo(f)!.algorithm }} {{ store.maskFp(keyInfo(f)!.fingerprint) }}
                    </span>
                    <n-tag v-else size="tiny" type="warning" round :bordered="false">
                      <template #icon><AlertTriangle :size="11" /></template>
                      文件不存在
                    </n-tag>
                  </template>
                </div>
              </template>
              <span v-else class="muted">未指定（使用默认密钥 / ssh-agent）</span>
            </dd>
            <template v-if="host.identitiesOnly">
              <dt>IdentitiesOnly</dt>
              <dd>yes <span class="muted">— 只尝试上面指定的密钥</span></dd>
            </template>
            <template v-if="host.proxyJump">
              <dt>跳板机</dt>
              <dd class="mono selectable">{{ store.maskBlock(host.proxyJump) }}</dd>
            </template>
            <template v-for="kv in host.extra" :key="kv.key + kv.value">
              <dt>{{ kv.key }}</dt>
              <dd class="mono selectable">{{ store.maskBlock(kv.value) }}</dd>
            </template>
            <dt>来源</dt>
            <dd class="mono muted selectable">{{ host.sourceFile }}:{{ host.line }}</dd>
          </dl>
        </section>

        <section class="card">
          <h3>
            分组与备注
            <span class="hint">仅保存在本程序，不写入 config</span>
            <span class="save-state" :class="saveState">{{ saveStateText }}</span>
          </h3>
          <div class="meta-grid">
            <label>分组</label>
            <n-select
              v-model:value="group"
              filterable
              tag
              clearable
              size="small"
              :options="groupOptions"
              placeholder="选择或输入新分组名，回车创建"
            />
            <label>标签</label>
            <n-dynamic-tags v-model:value="tags" size="small" />
            <label>备注</label>
            <n-input
              v-model:value="note"
              type="textarea"
              size="small"
              placeholder="用途、注意事项、负责人…"
              :autosize="{ minRows: 2, maxRows: 8 }"
            />
          </div>
        </section>

        <section class="card">
          <h3>
            config 原文
            <n-button size="tiny" quaternary class="h3-action" @click="openRaw">
              <template #icon><FileCode2 :size="13" /></template>
              编辑原文
            </n-button>
          </h3>
          <pre class="raw mono selectable">{{ store.maskBlock(host.raw, host) }}</pre>
        </section>
      </div>
    </n-scrollbar>

    <n-modal
      v-model:show="rawOpen"
      preset="card"
      title="编辑 config 原文"
      style="width: 680px"
      :mask-closable="false"
    >
      <n-input
        v-model:value="rawText"
        type="textarea"
        class="mono raw-editor"
        :autosize="{ minRows: 8, maxRows: 24 }"
        spellcheck="false"
      />
      <p class="muted hint-line">
        必须且只能包含一个 Host 段，可以带上方的注释行。保存前会自动备份 {{ host.sourceFile }}。
      </p>
      <template #footer>
        <n-space justify="end">
          <n-button @click="rawOpen = false">取消</n-button>
          <n-button type="primary" :loading="rawSaving" @click="saveRaw">保存</n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.detail {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.detail-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px 16px;
  padding: 0 24px 16px;
  border-bottom: 1px solid var(--border);
}

.title {
  display: flex;
  gap: 14px;
  min-width: 0;
  flex: 1 1 320px;
}

.kind-badge {
  width: 44px;
  height: 44px;
  flex: none;
  border-radius: 12px;
  display: grid;
  place-items: center;
  background: var(--accent-soft);
  color: var(--accent);
}

.kind-badge.gitPlatform {
  background: rgba(227, 162, 58, 0.16);
  color: var(--orange);
}

.kind-badge.pattern {
  background: var(--border);
  color: var(--text-2);
}

.title-text {
  min-width: 0;
}

.alias-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.alias-row h1 {
  margin: 0;
  min-width: 0;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: 0.2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kind-tag {
  background: var(--border);
}

.fav {
  color: var(--orange);
}

.target {
  margin-top: 2px;
  font-size: 12.5px;
  color: var(--text-3);
  overflow-wrap: anywhere;
}

.last {
  margin-top: 3px;
  font-size: 12px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 14px;
}

.alive {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.alive-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-3);
}

.alive.online .alive-dot {
  background: var(--green);
}

.alive.offline .alive-dot {
  background: var(--red);
}

.alive.checking .alive-dot {
  background: var(--orange);
  animation: pulse 1s ease-in-out infinite;
}

.alive.online {
  color: var(--green-text);
}

.alive.offline {
  color: var(--red-text);
}

.reboot {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 3px 10px 3px 8px;
  border-radius: 999px;
  font-size: 12px;
  background: rgba(227, 162, 58, 0.14);
  color: var(--orange-text);
}

.reboot.up {
  background: rgba(61, 190, 122, 0.14);
  color: var(--green-text);
}

.reboot.timeout {
  background: rgba(229, 97, 91, 0.14);
  color: var(--red-text);
}

.reboot-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}

.reboot.waitingDown .reboot-dot,
.reboot.down .reboot-dot {
  animation: pulse 1s ease-in-out infinite;
}

@keyframes pulse {
  50% {
    opacity: 0.25;
  }
}

.actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  flex: none;
  padding-top: 6px;
}

.body-scroll {
  flex: 1;
  min-height: 0;
}

.body {
  padding: 18px 24px 28px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 900px;
}

.description {
  margin: 0;
  padding: 10px 14px;
  border-left: 3px solid var(--accent);
  background: rgba(91, 141, 239, 0.08);
  border-radius: 0 8px 8px 0;
  color: var(--text-2);
  white-space: pre-wrap;
  line-height: 1.6;
}

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

.save-state {
  margin-left: auto;
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  font-size: 11.5px;
}

.save-state.saved {
  color: var(--green);
}

.save-state.error {
  color: var(--red);
}

.h3-action {
  margin-left: auto;
}

.grid {
  display: grid;
  /* 标签列随最长字段名伸展（如 PreferredAuthentications），超过上限才折行 */
  grid-template-columns: minmax(110px, max-content) minmax(0, 1fr);
  gap: 8px 16px;
  margin: 0;
  align-items: baseline;
}

.grid dt {
  color: var(--text-3);
  max-width: 220px;
  overflow-wrap: anywhere;
}

.grid dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}

.key-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  line-height: 22px;
}

.fp {
  font-size: 11.5px;
}

.meta-grid {
  display: grid;
  grid-template-columns: minmax(110px, max-content) minmax(0, 1fr);
  gap: 10px 16px;
  align-items: start;
}

.meta-grid label {
  color: var(--text-3);
  line-height: 28px;
}

.raw {
  margin: 0;
  padding: 12px 14px;
  background: #121215;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.65;
  color: var(--text-2);
  overflow-x: auto;
}

.raw-editor :deep(textarea) {
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.6;
}

.hint-line {
  margin: 10px 0 0;
  font-size: 12px;
}
</style>
