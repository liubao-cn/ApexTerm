<script setup lang="ts">
import { NButton, NModal, NScrollbar, NTag, useMessage } from "naive-ui";
import { CheckCircle2, Copy, Loader2, RotateCcw, Terminal, Trash2, XCircle } from "lucide-vue-next";
import { useCommandsStore, type RunRecord } from "../stores/commands";
import { useHostsStore } from "../stores/hosts";

const commands = useCommandsStore();
const hosts = useHostsStore();
const message = useMessage();

function statusTag(r: RunRecord): { type: "success" | "error" | "warning" | "default"; text: string } {
  if (r.status === "running") return { type: "default", text: "执行中" };
  if (r.status === "error") return { type: "error", text: "失败" };
  const res = r.result!;
  if (res.timedOut) return { type: "warning", text: "超时" };
  if (res.ok) return { type: "success", text: "退出码 0" };
  return { type: "error", text: `退出码 ${res.code ?? "?"}` };
}

async function copyOutput(r: RunRecord) {
  const text = [r.result?.stdout, r.result?.stderr].filter(Boolean).join("\n");
  try {
    await navigator.clipboard.writeText(text);
    message.success("已复制输出");
  } catch {
    message.error("复制失败");
  }
}

function rerun(r: RunRecord) {
  if (r.hostId === commands.LOCAL_ID) return void commands.runLocalSilent(r.title, r.command);
  const host = hosts.hosts.find((h) => h.id === r.hostId);
  if (!host) return message.error("主机已不存在");
  commands.runSilent(host, r.title, r.command);
}

function openInTerminal(r: RunRecord) {
  if (r.hostId === commands.LOCAL_ID) {
    commands.runLocalInTerminal(r.command);
    commands.resultsOpen = false;
    return;
  }
  const host = hosts.hosts.find((h) => h.id === r.hostId);
  if (!host) return message.error("主机已不存在");
  commands.runInTerminal(host, r.command);
  commands.resultsOpen = false;
}

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}
</script>

<template>
  <n-modal
    v-model:show="commands.resultsOpen"
    preset="card"
    title="执行结果"
    style="width: 820px; max-width: calc(100vw - 40px)"
  >
    <template #header-extra>
      <n-button size="tiny" quaternary :disabled="commands.records.length === 0" @click="commands.clearRecords()">
        <template #icon><Trash2 :size="12" /></template>
        清空
      </n-button>
    </template>

    <n-scrollbar style="max-height: 70vh">
      <div class="list">
        <div v-if="commands.records.length === 0" class="empty muted">还没有执行过后台命令</div>
        <div v-for="r in commands.records" :key="r.id" class="record">
          <div class="head">
            <span class="alias">{{ r.alias }}</span>
            <span class="title muted">{{ r.title }}</span>
            <n-tag size="tiny" round :bordered="false" :type="statusTag(r).type">
              <template #icon>
                <Loader2 v-if="r.status === 'running'" :size="11" class="spin" />
                <CheckCircle2 v-else-if="r.result?.ok" :size="11" />
                <XCircle v-else :size="11" />
              </template>
              {{ statusTag(r).text }}
            </n-tag>
            <span v-if="r.result" class="muted small">{{ r.result.durationMs }} ms</span>
            <span class="muted small time">{{ fmtTime(r.startedAt) }}</span>
            <span class="spacer"></span>
            <n-button v-tip="'复制输出'" size="tiny" quaternary :disabled="!r.result" @click="copyOutput(r)">
              <template #icon><Copy :size="12" /></template>
            </n-button>
            <n-button v-tip="'再次运行'" size="tiny" quaternary :disabled="r.status === 'running'" @click="rerun(r)">
              <template #icon><RotateCcw :size="12" /></template>
            </n-button>
            <n-button v-tip="'在终端里执行'" size="tiny" quaternary @click="openInTerminal(r)">
              <template #icon><Terminal :size="12" /></template>
            </n-button>
          </div>
          <div class="cmd mono selectable">$ {{ r.command }}</div>
          <pre v-if="r.result?.stdout" class="out mono selectable">{{ r.result.stdout }}</pre>
          <pre v-if="r.result?.stderr" class="out err mono selectable">{{ r.result.stderr }}</pre>
          <div v-if="r.error" class="out err mono">{{ r.error }}</div>
          <div v-if="r.result && !r.result.stdout && !r.result.stderr && !r.error" class="muted small">（无输出）</div>
          <div v-if="r.result?.truncated" class="muted small">输出过长，已截断到 1 MiB</div>
          <div v-if="r.result?.timedOut" class="muted small">超过时限被终止；需要长时间运行的命令请用「在终端里执行」</div>
        </div>
      </div>
    </n-scrollbar>
  </n-modal>
</template>

<style scoped>
.list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-right: 6px;
}

.empty {
  padding: 40px;
  text-align: center;
}

.record {
  background: var(--hover-1);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 14px 12px;
}

.head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 6px;
}

.alias {
  font-weight: 600;
}

.small {
  font-size: 11.5px;
}

.spacer {
  flex: 1;
}

.cmd {
  font-size: 12px;
  color: var(--text-2);
  overflow-wrap: anywhere;
  margin-bottom: 6px;
}

.out {
  margin: 0;
  padding: 10px 12px;
  background: #121215;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.55;
  max-height: 360px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.out.err {
  color: #f07a74;
  margin-top: 6px;
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
