<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { NButton, NInput, NScrollbar, NSelect, useMessage } from "naive-ui";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Cpu,
  FolderOpen,
  FolderPlus,
  HardDrive,
  History,
  Laptop,
  MemoryStick,
  Network,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Terminal,
  TerminalSquare,
  Trash2,
  X,
  Zap,
} from "lucide-vue-next";
import { errorText, formatBytes } from "../api";
import { localSnippetForEdit, newLocalSnippetDraft } from "../localSnippets";
import { useLocalRun } from "../localRun";
import type { Snippet } from "../snippets";
import { useConsoleStore } from "../stores/console";
import { useCommandsStore } from "../stores/commands";
import { useTerminalsStore } from "../stores/terminals";
import { useHostsStore } from "../stores/hosts";
import LocalSnippetEditor from "./LocalSnippetEditor.vue";

const console_ = useConsoleStore();
const commands = useCommandsStore();
const terminals = useTerminalsStore();
const hosts = useHostsStore();
const message = useMessage();
const localRun = useLocalRun();

onMounted(() => console_.init());

const s = computed(() => console_.summary);
const uptimeText = computed(() => {
  const secs = s.value?.uptimeSecs ?? 0;
  const d = Math.floor(secs / 86400);
  const hh = Math.floor((secs % 86400) / 3600);
  const mm = Math.floor((secs % 3600) / 60);
  return d ? `${d} 天 ${hh} 小时` : hh ? `${hh} 小时 ${mm} 分` : `${mm} 分`;
});
const memPct = computed(() => (s.value?.memTotal ? Math.round((s.value.memUsed / s.value.memTotal) * 100) : 0));

// ---- 工作目录 ----
const cwdOptions = computed(() => [
  { label: "家目录（默认）", value: "" },
  ...console_.dirs.map((d) => ({ label: `${d.name}  ${hosts.privacy ? "" : d.path}`, value: d.path })),
]);

// ---- 执行 ----
function runRecent(cmd: string, e: MouseEvent) {
  if (e.altKey) {
    commands.runLocalSilent(cmd.length > 40 ? `${cmd.slice(0, 40)}…` : cmd, cmd, console_.cwd);
    commands.resultsOpen = true;
  } else {
    commands.runLocalInTerminal(cmd, console_.cwd);
  }
}

const recentQuery = ref("");
const filteredRecents = computed(() => {
  const q = recentQuery.value.trim().toLowerCase();
  return q ? console_.recents.filter((c) => c.toLowerCase().includes(q)) : console_.recents;
});

// ---- 常用目录 ----
async function addDir() {
  const picked = await openDialog({ directory: true, multiple: false, defaultPath: s.value?.home });
  if (typeof picked === "string") {
    await console_.addDir(picked).catch((e) => message.error(errorText(e)));
  }
}

// ---- 自定义命令编辑 ----
const editorOpen = ref(false);
const draft = ref<Snippet | null>(null);

function newSnippet() {
  draft.value = newLocalSnippetDraft();
  editorOpen.value = true;
}

function editSnippet(sn: Snippet) {
  draft.value = localSnippetForEdit(sn);
  editorOpen.value = true;
}
</script>

<template>
  <n-scrollbar class="console-scroll">
    <div class="console">
      <!-- 头部：系统概况 -->
      <header class="head">
        <div class="head-icon"><Laptop :size="26" /></div>
        <div class="head-main">
          <h1>
            本机控制台
            <span v-if="s" class="muted host">{{ hosts.privacy ? "xxxxx" : s.hostname }}</span>
          </h1>
          <div class="muted sub">
            <template v-if="s">
              {{ s.user }} · {{ s.os }} · {{ s.arch }} · {{ s.shell.split("/").pop() }} · 已运行 {{ uptimeText }}
            </template>
            <template v-else-if="console_.summaryError">{{ console_.summaryError }}</template>
            <template v-else>读取系统信息…</template>
          </div>
        </div>
        <div class="head-actions">
          <n-button size="small" secondary type="primary" @click="terminals.openLocal(console_.cwd)">
            <template #icon><TerminalSquare :size="14" /></template>
            新建本地终端
          </n-button>
          <n-button size="small" quaternary :loading="console_.loadingSummary" @click="console_.refreshSummary(); console_.refreshRecents()">
            <template #icon><RefreshCw :size="14" /></template>
          </n-button>
        </div>
      </header>

      <div v-if="s" class="stats">
        <div class="stat">
          <Cpu :size="14" class="muted" />
          <div><div class="stat-v">{{ s.cpuCount }} 核</div><div class="stat-k">{{ s.cpuBrand || "CPU" }}</div></div>
        </div>
        <div class="stat">
          <MemoryStick :size="14" class="muted" />
          <div>
            <div class="stat-v">{{ formatBytes(s.memUsed) }} <span class="muted">/ {{ formatBytes(s.memTotal) }}</span></div>
            <div class="stat-k">内存 {{ memPct }}%</div>
          </div>
        </div>
        <div v-for="d in s.disks.slice(0, 2)" :key="d.mount" class="stat">
          <HardDrive :size="14" class="muted" />
          <div>
            <div class="stat-v">{{ formatBytes(d.free) }} <span class="muted">可用</span></div>
            <div class="stat-k mono">{{ d.mount === "/System/Volumes/Data" ? "/" : d.mount }} · 共 {{ formatBytes(d.total) }}</div>
          </div>
        </div>
        <div class="stat">
          <Network :size="14" class="muted" />
          <div>
            <div class="stat-v mono">{{ hosts.privacy ? "xxx.xxx.xxx.xxx" : s.ips[0]?.split(" ")[1] ?? "—" }}</div>
            <div class="stat-k">{{ s.ips.length > 1 ? `等 ${s.ips.length} 个地址` : s.ips[0]?.split(" ")[0] ?? "无网络" }}</div>
          </div>
        </div>
      </div>

      <!-- 常用目录 + 工作目录 -->
      <section class="card">
        <h3>
          常用目录
          <span class="hint">点击在该目录打开本地终端；右侧选择快捷命令的工作目录</span>
          <span class="spacer"></span>
          <n-select :value="console_.cwd ?? ''" :options="cwdOptions" size="tiny" style="width: 240px" @update:value="(v: string) => (console_.cwd = v || null)" />
        </h3>
        <div class="dirs">
          <button v-for="d in console_.dirs" :key="d.id" class="dir" v-tip="hosts.privacy ? '' : d.path" @click="terminals.openLocal(d.path)">
            <FolderOpen :size="14" />
            {{ d.name }}
            <X :size="11" class="dir-x" @click.stop="console_.removeDir(d.id)" />
          </button>
          <n-button size="tiny" quaternary @click="addDir">
            <template #icon><FolderPlus :size="12" /></template>
            添加目录
          </n-button>
        </div>
      </section>

      <!-- 快捷命令 -->
      <section class="card">
        <h3>
          本机快捷命令
          <span class="hint">⚡ 后台执行并显示输出 · ▶ 在终端里执行</span>
          <span class="spacer"></span>
          <n-button size="tiny" quaternary @click="newSnippet">
            <template #icon><Plus :size="12" /></template>
            自定义
          </n-button>
        </h3>
        <div v-for="[g, list] in console_.groups" :key="g" class="group">
          <div class="group-name">{{ g }}</div>
          <div class="grid">
            <div v-for="sn in list" :key="sn.id" class="cmd" :class="{ danger: sn.danger }" v-tip="sn.description ? `${sn.command}\n${sn.description}` : sn.command" @click="localRun.run(sn, console_.cwd)">
              <component :is="sn.mode === 'terminal' ? Play : Zap" :size="13" class="cmd-mode" />
              <span class="cmd-name">{{ sn.name }}</span>
              <span class="cmd-actions" @click.stop>
                <button class="mini" v-tip="sn.builtin ? '复制为自定义' : '编辑'" @click="editSnippet(sn)"><Pencil :size="11" /></button>
                <button class="mini" v-tip="sn.builtin ? '隐藏' : '删除'" @click="localRun.remove(sn)"><Trash2 :size="11" /></button>
              </span>
            </div>
          </div>
        </div>
        <div v-if="hosts.meta.hiddenLocalSnippets.length" class="muted small restore">
          已隐藏 {{ hosts.meta.hiddenLocalSnippets.length }} 个内置命令
          <n-button size="tiny" quaternary @click="console_.restoreBuiltins()"><template #icon><RotateCcw :size="11" /></template>恢复全部内置命令</n-button>
        </div>
      </section>

      <!-- 最近命令 -->
      <section class="card">
        <h3>
          <History :size="13" />
          最近用过的命令
          <span class="hint">来自本机 shell 历史 · 点击在终端执行 · ⌥点击后台执行</span>
          <span class="spacer"></span>
          <n-input v-model:value="recentQuery" size="tiny" placeholder="筛选…" clearable style="width: 200px" />
        </h3>
        <div v-if="filteredRecents.length === 0" class="muted small">没有历史记录</div>
        <div class="recents">
          <button v-for="c in filteredRecents.slice(0, 40)" :key="c" class="recent mono" @click="runRecent(c, $event)">
            <Terminal :size="11" class="muted" />
            <span>{{ c }}</span>
          </button>
        </div>
      </section>
    </div>

    <!-- 自定义命令编辑 -->
    <LocalSnippetEditor v-model:show="editorOpen" :draft="draft" />
  </n-scrollbar>
</template>

<style scoped>
.console-scroll {
  flex: 1;
  min-height: 0;
}

.console {
  max-width: 1040px;
  margin: 0 auto;
  padding: 8px 28px 32px;
}

.head {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 14px;
}

.head-icon {
  width: 48px;
  height: 48px;
  border-radius: 14px;
  display: grid;
  place-items: center;
  background: var(--accent-soft);
  color: var(--accent);
  flex: none;
}

.head-main {
  flex: 1;
  min-width: 0;
}

h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.host {
  font-size: 13px;
  font-weight: 500;
}

.sub {
  font-size: 12.5px;
  margin-top: 3px;
}

.head-actions {
  display: flex;
  gap: 6px;
}

.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}

.stat {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--panel-bg);
  border: 1px solid var(--border);
}

.stat-v {
  font-size: 14px;
  font-weight: 600;
}

.stat-k {
  font-size: 11.5px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 220px;
}

.card {
  background: var(--panel-bg);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 14px 18px 16px;
  margin-bottom: 14px;
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
  gap: 8px;
  flex-wrap: wrap;
}

.hint {
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  font-size: 11.5px;
  opacity: 0.8;
}

.spacer {
  flex: 1;
}

.dirs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.dir {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 28px;
  padding: 0 8px 0 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--hover-1);
  color: var(--text-1);
  font: inherit;
  font-size: 12.5px;
  cursor: default;
}

.dir:hover {
  background: var(--hover-3);
}

.dir-x {
  opacity: 0.45;
}

.dir-x:hover {
  opacity: 1;
}

.group {
  margin-bottom: 10px;
}

.group-name {
  font-size: 12px;
  color: var(--text-3);
  margin: 0 0 6px 2px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 6px;
}

.cmd {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--hover-1);
  font-size: 12.5px;
  cursor: default;
}

.cmd:hover {
  background: var(--hover-3);
  border-color: rgba(91, 141, 239, 0.4);
}

.cmd.danger {
  color: var(--red-text);
}

.cmd-mode {
  flex: none;
  opacity: 0.7;
}

.cmd-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 操作按钮常驻占位，只切透明度：悬停时卡片高度不变 */
.cmd-actions {
  display: inline-flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.12s;
}

.cmd:hover .cmd-actions {
  opacity: 1;
}

.mini {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-3);
  cursor: default;
}

.mini:hover {
  background: var(--hover-3);
  color: var(--text-1);
}

.restore {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.small {
  font-size: 12px;
}

.recents {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.recent {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  text-align: left;
  cursor: default;
}

.recent span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recent:hover {
  background: var(--hover-2);
  color: var(--text-1);
}
</style>
