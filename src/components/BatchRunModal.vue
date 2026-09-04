<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  NButton,
  NCheckbox,
  NInput,
  NInputNumber,
  NModal,
  NScrollbar,
  NSelect,
  NSpace,
  NTag,
  useDialog,
  useMessage,
} from "naive-ui";
import { CheckCircle2, Loader2, Play, XCircle } from "lucide-vue-next";
import { UNGROUPED, useHostsStore } from "../stores/hosts";
import { useCommandsStore, type RunRecord } from "../stores/commands";
import { resolveCommand, type Snippet } from "../snippets";
import type { HostEntry } from "../api";

const hosts = useHostsStore();
const commands = useCommandsStore();
const dialog = useDialog();
const message = useMessage();

const selected = ref<Set<string>>(new Set());
const snippetId = ref<string | null>(null);
const customCmd = ref("");
const timeout = ref(60);
const running = ref(false);
const results = ref<Record<string, RunRecord>>({});

watch(
  () => commands.batchOpen,
  (v) => {
    if (!v) return;
    selected.value = new Set(commands.batchPreselect);
    results.value = {};
    running.value = false;
  },
);

const grouped = computed(() => {
  const map = new Map<string, HostEntry[]>();
  for (const h of hosts.servers) {
    const g = hosts.metaOf(h.id).group ?? UNGROUPED;
    if (!map.has(g)) map.set(g, []);
    map.get(g)!.push(h);
  }
  return [...map.entries()];
});

const snippetOptions = computed(() =>
  commands.allSnippets
    .filter((s) => s.hostIds.length === 0)
    .map((s) => ({ label: `${s.name}  ·  ${s.command}`, value: s.id })),
);

const snippet = computed<Snippet | null>(
  () => commands.allSnippets.find((s) => s.id === snippetId.value) ?? null,
);

const commandTemplate = computed(() => (snippet.value ? snippet.value.command : customCmd.value.trim()));
const targets = computed(() => hosts.servers.filter((h) => selected.value.has(h.id)));
const canRun = computed(() => targets.value.length > 0 && commandTemplate.value.length > 0 && !running.value);

function toggle(id: string) {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
}

function toggleGroup(list: HostEntry[]) {
  const next = new Set(selected.value);
  const all = list.every((h) => next.has(h.id));
  for (const h of list) {
    if (all) next.delete(h.id);
    else next.add(h.id);
  }
  selected.value = next;
}

function selectAll(on: boolean) {
  selected.value = on ? new Set(hosts.servers.map((h) => h.id)) : new Set();
}

async function runAll() {
  const list = targets.value;
  const s = snippet.value;
  running.value = true;
  results.value = {};
  const title = s?.name ?? "批量命令";
  await Promise.all(
    list.map(async (h) => {
      const cmd = resolveCommand(commandTemplate.value, h);
      const rec = await commands.runSilent(h, title, cmd, timeout.value);
      results.value = { ...results.value, [h.id]: rec };
      if (s?.watchReboot && rec.status === "done") commands.startRebootWatch(h);
    }),
  );
  running.value = false;
  const ok = Object.values(results.value).filter((r) => r.result?.ok).length;
  message.info(`完成：${ok} / ${list.length} 台成功`);
}

function confirmRun() {
  const s = snippet.value;
  const dangerous = s?.danger || /\b(reboot|shutdown|poweroff|halt|rm\s+-rf|mkfs|dd\s)/.test(commandTemplate.value);
  if (!dangerous && !s?.confirm) return runAll();
  dialog[dangerous ? "error" : "warning"]({
    title: `在 ${targets.value.length} 台服务器上执行`,
    content: `${commandTemplate.value}\n\n目标：${targets.value.map((h) => h.alias).join("、")}`,
    positiveText: dangerous ? "确认执行" : "执行",
    negativeText: "取消",
    style: "white-space: pre-wrap",
    onPositiveClick: runAll,
  });
}

function status(h: HostEntry): { kind: "idle" | "running" | "ok" | "fail"; text: string } {
  const r = results.value[h.id];
  if (!r) return running.value ? { kind: "running", text: "执行中…" } : { kind: "idle", text: "" };
  if (r.status === "running") return { kind: "running", text: "执行中…" };
  if (r.status === "error") return { kind: "fail", text: r.error ?? "失败" };
  const res = r.result!;
  if (res.timedOut) return { kind: "fail", text: "超时" };
  const first = (res.stdout || res.stderr).split("\n").find((l) => l.trim()) ?? "";
  if (res.ok) return { kind: "ok", text: first || "完成（无输出）" };
  return { kind: "fail", text: `退出码 ${res.code ?? "?"}${first ? "：" + first : ""}` };
}
</script>

<template>
  <n-modal
    v-model:show="commands.batchOpen"
    preset="card"
    title="在多台服务器上执行"
    style="width: 860px; max-width: calc(100vw - 40px)"
    :mask-closable="!running"
  >
    <div class="layout">
      <div class="hosts">
        <div class="hosts-head">
          <span class="muted">选择服务器（{{ selected.size }} / {{ hosts.servers.length }}）</span>
          <span class="spacer"></span>
          <n-button size="tiny" quaternary @click="selectAll(true)">全选</n-button>
          <n-button size="tiny" quaternary @click="selectAll(false)">清空</n-button>
        </div>
        <n-scrollbar style="max-height: 420px">
          <div v-for="[g, list] in grouped" :key="g" class="group">
            <div class="group-title" @click="toggleGroup(list)">{{ g }}</div>
            <div v-for="h in list" :key="h.id" class="host-row" @click="toggle(h.id)">
              <n-checkbox :checked="selected.has(h.id)" @click.stop @update:checked="toggle(h.id)" />
              <span class="alias">{{ h.alias }}</span>
              <span class="mono muted target">{{ hosts.displayTarget(h) }}</span>
              <span class="status" :class="status(h).kind">
                <Loader2 v-if="status(h).kind === 'running'" :size="12" class="spin" />
                <CheckCircle2 v-else-if="status(h).kind === 'ok'" :size="12" />
                <XCircle v-else-if="status(h).kind === 'fail'" :size="12" />
                <span class="status-text">{{ status(h).text }}</span>
              </span>
            </div>
          </div>
        </n-scrollbar>
      </div>

      <div class="cmd">
        <div class="field">
          <label>快捷命令</label>
          <n-select
            v-model:value="snippetId"
            :options="snippetOptions"
            filterable
            clearable
            size="small"
            placeholder="选一条，或在下面直接写命令"
          />
        </div>
        <div class="field">
          <label>自定义命令</label>
          <n-input
            v-model:value="customCmd"
            type="textarea"
            size="small"
            class="mono"
            :disabled="!!snippetId"
            :autosize="{ minRows: 3, maxRows: 8 }"
            placeholder="例如：{sudo}systemctl restart nginx"
            spellcheck="false"
          />
        </div>
        <div class="field inline">
          <label>超时（秒）</label>
          <n-input-number v-model:value="timeout" :min="5" :max="3600" size="small" style="width: 120px" />
        </div>
        <p class="muted note">
          全部以后台模式（BatchMode）并发执行，每台的完整输出在「执行结果」里查看。
          非 root 用户需要输 sudo 密码的命令在这里会失败，请单台在终端里执行。
        </p>
        <n-tag v-if="snippet?.danger" type="error" size="small" round :bordered="false">危险命令，会二次确认</n-tag>
      </div>
    </div>

    <template #footer>
      <n-space justify="space-between" align="center">
        <n-button size="small" quaternary :disabled="commands.records.length === 0" @click="commands.resultsOpen = true">
          查看执行结果
        </n-button>
        <n-space>
          <n-button @click="commands.batchOpen = false">关闭</n-button>
          <n-button type="primary" :disabled="!canRun" :loading="running" @click="confirmRun">
            <template #icon><Play :size="14" /></template>
            在 {{ targets.length }} 台上执行
          </n-button>
        </n-space>
      </n-space>
    </template>
  </n-modal>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
  gap: 20px;
}

.hosts-head {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 6px;
  font-size: 12px;
}

.spacer {
  flex: 1;
}

.group-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-3);
  padding: 10px 6px 4px;
  cursor: default;
}

.group-title:hover {
  color: var(--text-2);
}

.host-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 6px;
  border-radius: 6px;
  cursor: default;
}

.host-row:hover {
  background: var(--hover-1);
}

.alias {
  font-weight: 500;
  flex: none;
}

.target {
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.status {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  max-width: 45%;
  color: var(--text-3);
}

.status.ok {
  color: var(--green);
}

.status.fail {
  color: var(--red);
}

.status-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.field {
  margin-bottom: 12px;
}

.field label {
  display: block;
  font-size: 12px;
  color: var(--text-3);
  margin-bottom: 4px;
}

.field.inline {
  display: flex;
  align-items: center;
  gap: 10px;
}

.field.inline label {
  margin: 0;
}

.note {
  margin: 0 0 8px;
  font-size: 12px;
  line-height: 1.6;
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
