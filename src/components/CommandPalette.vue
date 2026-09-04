<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { NInput, NModal } from "naive-ui";
import {
  Cloud,
  Columns2,
  Eye,
  FolderOpen,
  Laptop,
  PanelLeft,
  Pencil,
  Play,
  Radar,
  Rows2,
  Server,
  Settings,
  TerminalSquare,
  Users,
  Zap,
} from "lucide-vue-next";
import { getTerm } from "../terminalRegistry";
import type { HostEntry } from "../api";
import type { Snippet } from "../snippets";
import { useHostsStore } from "../stores/hosts";
import { useTerminalsStore } from "../stores/terminals";
import { useCommandsStore } from "../stores/commands";
import { useConsoleStore } from "../stores/console";
import { useCloudStore } from "../stores/cloud";
import { useSettingsStore } from "../stores/settings";
import { appShortcut } from "../platform";

/**
 * ⌘P 命令面板：一个输入框搜遍 主机（连接 / 文件）、本机快捷命令、当前主机的快捷命令、常用目录、程序动作。
 */
const show = defineModel<boolean>("show", { required: true });
const hosts = useHostsStore();
const terminals = useTerminalsStore();
const commands = useCommandsStore();
const consoleStore = useConsoleStore();
const cloud = useCloudStore();
const settings = useSettingsStore();

const query = ref("");
const index = ref(0);
const input = ref<InstanceType<typeof NInput> | null>(null);

interface Item {
  key: string;
  icon: typeof Server;
  title: string;
  sub: string;
  group: string;
  keywords: string;
  run: () => void;
}

const currentHost = computed<HostEntry | null>(() => {
  const s = terminals.activeSession;
  if (s?.hostId) return hosts.hosts.find((h) => h.id === s.hostId) ?? null;
  return terminals.activeId === null ? hosts.selected : null;
});

const items = computed<Item[]>(() => {
  const out: Item[] = [];
  for (const h of hosts.servers) {
    out.push({
      key: `h:${h.id}`,
      icon: Server,
      title: h.alias,
      sub: hosts.displayTarget(h),
      group: "连接服务器",
      keywords: `${h.alias} ${h.hostName ?? ""} ${h.user ?? ""} ${hosts.metaOf(h.id).tags.join(" ")} ${hosts.metaOf(h.id).note}`,
      run: () => terminals.openSsh(h),
    });
    out.push({
      key: `f:${h.id}`,
      icon: FolderOpen,
      title: `${h.alias} · 文件`,
      sub: "SFTP 文件管理",
      group: "文件",
      keywords: `${h.alias} 文件 sftp files`,
      run: () => terminals.openFiles(h),
    });
  }
  const cur = currentHost.value;
  if (cur) {
    for (const s of commands.forHost(cur)) {
      out.push({
        key: `hs:${s.id}`,
        icon: s.mode === "terminal" ? Play : Zap,
        title: s.name,
        sub: `${cur.alias} · ${s.command}`,
        group: `${cur.alias} 的快捷命令`,
        keywords: `${s.name} ${s.command} ${s.group}`,
        run: () => commands.execute(s, cur, terminals.activeSession),
      });
    }
  }
  for (const s of consoleStore.snippets as Snippet[]) {
    out.push({
      key: `ls:${s.id}`,
      icon: s.mode === "terminal" ? Play : Zap,
      title: s.name,
      sub: `本机 · ${s.command}`,
      group: "本机快捷命令",
      keywords: `${s.name} ${s.command} ${s.group} 本机 local`,
      run: () => commands.executeLocal(s, consoleStore.cwd),
    });
  }
  for (const d of consoleStore.dirs) {
    out.push({
      key: `d:${d.id}`,
      icon: TerminalSquare,
      title: `在 ${d.name} 打开终端`,
      sub: d.path,
      group: "常用目录",
      keywords: `${d.name} ${d.path} 目录 终端`,
      run: () => terminals.openLocal(d.path),
    });
  }
  const act = (key: string, icon: typeof Server, title: string, sub: string, keywords: string, run: () => void) =>
    out.push({ key: `a:${key}`, icon, title, sub, group: "动作", keywords: `${title} ${keywords}`, run });
  act("console", Laptop, "本机控制台", appShortcut("shift+l"), "本机 local console", () => {
    terminals.showDetails();
    hosts.view = "console";
  });
  act("local-term", TerminalSquare, "新建本地终端", appShortcut("t"), "终端 terminal", () => terminals.openLocal());
  act(
    "sidebar",
    PanelLeft,
    settings.prefs.sidebarCollapsed ? "显示侧栏" : "隐藏侧栏",
    appShortcut("b"),
    "侧栏 sidebar 收起 展开",
    () => settings.toggleSidebar(),
  );
  act("panel-hosts", Server, "打开连接中心", "", "侧栏 主机 连接 hosts", () => settings.openPanel("hosts"));
  act("panel-commands", Zap, "打开快捷命令面板", "", "侧栏 快捷命令 commands", () => settings.openPanel("commands"));
  if (terminals.activeTab?.kind === "terminal") {
    act("split-right", Columns2, "向右分屏", appShortcut("d"), "分屏 split", () => terminals.split("row"));
    act("split-down", Rows2, "向下分屏", appShortcut("shift+d"), "分屏 split", () => terminals.split("col"));
    if (terminals.activeSession) {
      act("rename-pane", Pencil, "重命名当前面板", "", "重命名 rename 标题", () =>
        getTerm(terminals.activeSession?.id)?.ui.rename?.(),
      );
    }
  }
  act("probe", Radar, "探测全部服务器", appShortcut("shift+p"), "在线 探测 probe", () => hosts.probeAllServers());
  act("privacy", Eye, hosts.privacy ? "关闭隐私模式" : "开启隐私模式", appShortcut("shift+h"), "隐私 打码 privacy", () => hosts.togglePrivacy());
  act("batch", Users, "在多台服务器上执行命令", "", "批量 batch", () => commands.openBatch());
  act("cloud", Cloud, "云账号 / 带外开关机", "", "云 腾讯 火山 cloud", () => (cloud.modalOpen = true));
  act("settings", Settings, "设置", appShortcut(","), "设置 主题 快捷键 settings", () => settings.show());
  act("themes", Settings, "终端配色主题", "", "主题 配色 theme", () => settings.show("themes"));
  return out;
});

function score(item: Item, q: string): number {
  const t = item.title.toLowerCase();
  const k = item.keywords.toLowerCase();
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  if (t.includes(q)) return 60;
  if (k.includes(q)) return 40;
  // 子序列匹配（如 "gst" → git status）
  let i = 0;
  for (const ch of t) if (ch === q[i]) i++;
  return i === q.length ? 20 : 0;
}

const results = computed<Item[]>(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) {
    // 空查询：最近连接的主机 + 动作
    const recent = [...hosts.servers]
      .filter((h) => hosts.metaOf(h.id).lastConnected)
      .sort((a, b) => (hosts.metaOf(b.id).lastConnected ?? 0) - (hosts.metaOf(a.id).lastConnected ?? 0))
      .slice(0, 5)
      .map((h) => items.value.find((i) => i.key === `h:${h.id}`)!)
      .filter(Boolean);
    return [...recent, ...items.value.filter((i) => i.group === "动作")];
  }
  return items.value
    .map((i) => ({ i, s: score(i, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 40)
    .map((x) => x.i);
});

watch(show, (v) => {
  if (v) {
    query.value = "";
    index.value = 0;
    nextTick(() => input.value?.focus());
  }
});
watch(query, () => (index.value = 0));

function pick(item: Item) {
  show.value = false;
  item.run();
}

function onKey(e: KeyboardEvent) {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    index.value = Math.min(results.value.length - 1, index.value + 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    index.value = Math.max(0, index.value - 1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const it = results.value[index.value];
    if (it) pick(it);
  } else if (e.key === "Escape") {
    show.value = false;
  }
}

let lastGroup = "";
function groupLabel(item: Item, i: number): string | null {
  if (i === 0) lastGroup = "";
  if (item.group !== lastGroup) {
    lastGroup = item.group;
    return item.group;
  }
  return null;
}
</script>

<template>
  <n-modal v-model:show="show" :mask-closable="true" transform-origin="center" style="width: 640px; max-width: calc(100vw - 40px)">
    <div class="palette" @keydown="onKey">
      <n-input
        ref="input"
        v-model:value="query"
        size="large"
        placeholder="搜主机、命令、目录、动作…  ↑↓ 选择，回车执行"
        :bordered="false"
        clearable
      />
      <div class="results">
        <template v-for="(it, i) in results" :key="it.key">
          <div v-if="groupLabel(it, i)" class="group">{{ it.group }}</div>
          <div class="item" :class="{ active: i === index }" @mouseenter="index = i" @click="pick(it)">
            <component :is="it.icon" :size="15" class="muted" />
            <span class="title">{{ it.title }}</span>
            <span class="sub mono muted">{{ it.sub }}</span>
          </div>
        </template>
        <div v-if="results.length === 0" class="empty muted">没有匹配项</div>
      </div>
      <div class="foot muted">
        {{ appShortcut("p") }} 打开 · 回车执行 · 当前主机：{{ currentHost?.alias ?? "无" }}
      </div>
    </div>
  </n-modal>
</template>

<style scoped>
.palette {
  background: var(--panel-bg-2);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}

.results {
  max-height: 60vh;
  overflow-y: auto;
  padding: 4px 8px 8px;
  border-top: 1px solid var(--border);
}

.group {
  padding: 8px 10px 4px;
  font-size: 11px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--text-3);
}

.item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: default;
}

.item.active {
  background: var(--accent-soft);
}

.title {
  font-size: 13px;
  white-space: nowrap;
}

.sub {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  text-align: right;
}

.empty {
  padding: 24px;
  text-align: center;
}

.foot {
  padding: 6px 14px 8px;
  font-size: 11px;
  border-top: 1px solid var(--border);
}
</style>
