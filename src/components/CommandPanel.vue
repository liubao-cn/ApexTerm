<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { NDropdown, NInput, NScrollbar, NSelect, NTab, NTabs, useMessage, type DropdownOption } from "naive-ui";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  ChevronUp,
  Laptop,
  Pencil,
  Play,
  Plus,
  Server,
  Settings2,
  Terminal,
  TerminalSquare,
  Zap,
} from "lucide-vue-next";
import { errorText, type HostEntry } from "../api";
import { localSnippetForEdit, newLocalSnippetDraft } from "../localSnippets";
import { useLocalRun } from "../localRun";
import { useQuickCommands } from "../quickCommands";
import { SNIPPET_GROUPS, resolveCommand, type Snippet } from "../snippets";
import { getRuntime } from "../terminalRegistry";
import { useCommandsStore } from "../stores/commands";
import { useConsoleStore } from "../stores/console";
import { useHostsStore } from "../stores/hosts";
import { useSettingsStore } from "../stores/settings";
import { useTerminalsStore, type TermSession } from "../stores/terminals";
import PanelHeader from "./PanelHeader.vue";
import LocalSnippetEditor from "./LocalSnippetEditor.vue";

type Mode = "local" | "host";

const terminals = useTerminalsStore();
const hosts = useHostsStore();
const commands = useCommandsStore();
const console_ = useConsoleStore();
const settings = useSettingsStore();
const message = useMessage();
const localRun = useLocalRun();

// ---- 目标终端 ----
const active = computed(() => terminals.activeSession);
const mode = ref<Mode>(active.value?.target.kind === "ssh" ? "host" : "local");
const hostId = ref<string | null>(active.value?.hostId ?? hosts.selectedId);

// 会话变化时自动跟随；手动切换的模式在下一次会话变化前保持
watch(
  () => active.value?.id,
  () => {
    const a = active.value;
    if (!a) return;
    mode.value = a.target.kind === "ssh" ? "host" : "local";
    if (a.hostId) hostId.value = a.hostId;
  },
);
watch(
  () => hosts.selectedId,
  (id) => {
    if (id && !active.value?.hostId) hostId.value = id;
  },
);

const host = computed<HostEntry | undefined>(
  () => hosts.servers.find((h) => h.id === hostId.value) ?? hosts.servers[0],
);
const hostOptions = computed(() => hosts.servers.map((h) => ({ label: h.alias, value: h.id })));
const quickSession = computed(() => (host.value ? targetSession("ssh", host.value.id) : null));
const quick = useQuickCommands(host, quickSession);

function targetSession(kind: "local" | "ssh", hid: string | null): TermSession | null {
  const ok = (s: TermSession) =>
    s.status === "running" && s.target.kind === kind && (kind === "local" || s.hostId === hid);
  const a = active.value;
  if (a && ok(a)) return a;
  return terminals.sessions.find(ok) ?? null;
}

const targetLabel = computed(() => {
  if (mode.value === "host") {
    if (!host.value) return "没有可用主机";
    return targetSession("ssh", host.value.id) ? `${host.value.alias} · SSH` : `${host.value.alias} · 将新开 SSH 标签`;
  }
  const s = targetSession("local", null);
  if (!s) return "将新开本地终端";
  // 用户改过名就显示自定义名，否则显示 shell 报的标题
  const name = s.title !== "本地终端" ? s.title : s.subtitle;
  return name ? `本地终端 · ${name}` : "本地终端";
});

// ---- 列表 ----
const query = ref("");
interface Group {
  name: string;
  items: Snippet[];
}
/** 当前模式下全部分组（未过滤、已按自定义顺序排好） */
const allGroups = computed<Group[]>(() => {
  let src: Group[];
  if (mode.value === "local") {
    src = console_.groups.map(([name, items]) => ({ name, items }));
  } else {
    const list = host.value ? commands.forHost(host.value) : [];
    const names = [...new Set([...SNIPPET_GROUPS, ...list.map((s) => s.group)])];
    src = names.map((name) => ({ name, items: list.filter((s) => s.group === name) })).filter((g) => g.items.length);
  }
  // 用户排过序的排前面（按其顺序），其余按默认顺序跟在后面
  const order = settings.prefs.commandGroupOrder[mode.value];
  const rank = (g: Group) => {
    const i = order.indexOf(g.name);
    return i < 0 ? order.length + src.indexOf(g) : i;
  };
  return [...src].sort((a, b) => rank(a) - rank(b));
});

const groups = computed<Group[]>(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return allGroups.value;
  const hit = (s: Snippet) => s.name.toLowerCase().includes(q) || s.command.toLowerCase().includes(q);
  return allGroups.value.map((g) => ({ ...g, items: g.items.filter(hit) })).filter((g) => g.items.length);
});

// 展开状态按 `模式:分组名` 记忆，默认全部收起；搜索时全部展开
const groupKey = (name: string) => `${mode.value}:${name}`;
const expanded = (name: string) => !!query.value || settings.prefs.commandGroupsExpanded.includes(groupKey(name));
const allExpanded = computed(() => allGroups.value.length > 0 && allGroups.value.every((g) => expanded(g.name)));
function toggleAll() {
  settings.setCommandGroupsExpanded(allGroups.value.map((g) => groupKey(g.name)), !allExpanded.value);
}

/** 分组上移 / 下移：以当前显示顺序为基准写回自定义顺序 */
function moveGroup(name: string, delta: -1 | 1) {
  const names = allGroups.value.map((g) => g.name);
  const i = names.indexOf(name);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= names.length) return;
  [names[i], names[j]] = [names[j], names[i]];
  settings.setCommandGroupOrder(mode.value, names);
}

// ---- 分组拖拽排序（指针事件实现，与连接中心的主机排序同一套做法） ----
const drag = ref<{ name: string; x: number; y: number } | null>(null);
const dropTarget = ref<{ name: string; place: "before" | "after" } | null>(null);
let pendingDrag: { name: string; startX: number; startY: number } | null = null;
let suppressClick = false;

function onGroupPointerDown(e: PointerEvent, name: string) {
  if (e.button !== 0 || query.value) return;
  pendingDrag = { name, startX: e.clientX, startY: e.clientY };
  window.addEventListener("pointermove", onGroupPointerMove);
  window.addEventListener("pointerup", onGroupPointerUp, { once: true });
  window.addEventListener("pointercancel", onGroupPointerUp, { once: true });
  window.addEventListener("blur", onGroupPointerUp, { once: true });
}

function onGroupPointerMove(e: PointerEvent) {
  if (!pendingDrag) return;
  if (!drag.value) {
    if (Math.hypot(e.clientX - pendingDrag.startX, e.clientY - pendingDrag.startY) < 5) return;
    drag.value = { name: pendingDrag.name, x: e.clientX, y: e.clientY };
    document.body.style.cursor = "grabbing";
  } else {
    drag.value = { ...drag.value, x: e.clientX, y: e.clientY };
  }
  const el = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>(
    ".group-head[data-group]",
  );
  if (el?.dataset.group && el.dataset.group !== drag.value.name) {
    const r = el.getBoundingClientRect();
    dropTarget.value = { name: el.dataset.group, place: e.clientY < r.top + r.height / 2 ? "before" : "after" };
  } else {
    dropTarget.value = null;
  }
}

function onGroupPointerUp() {
  window.removeEventListener("pointermove", onGroupPointerMove);
  const d = drag.value;
  const t = dropTarget.value;
  pendingDrag = null;
  drag.value = null;
  dropTarget.value = null;
  document.body.style.cursor = "";
  if (!d) return;
  // 拖完的那次 click 不当作折叠 / 展开
  suppressClick = true;
  setTimeout(() => (suppressClick = false), 0);
  if (!t) return;
  const names = allGroups.value.map((g) => g.name).filter((n) => n !== d.name);
  const idx = names.indexOf(t.name) + (t.place === "after" ? 1 : 0);
  names.splice(idx, 0, d.name);
  settings.setCommandGroupOrder(mode.value, names);
}

function onGroupClick(name: string) {
  if (suppressClick) return;
  settings.toggleCommandGroup(groupKey(name));
}

function dropClass(name: string) {
  const t = dropTarget.value;
  if (!t || t.name !== name) return {};
  return { "drop-before": t.place === "before", "drop-after": t.place === "after" };
}

const preview = (s: Snippet) => (mode.value === "host" && host.value ? resolveCommand(s.command, host.value) : s.command);

// ---- 动作 ----
/** 单击：粘贴到目标终端、不回车 */
function paste(s: Snippet) {
  const text = preview(s);
  if (mode.value === "local") {
    const t = targetSession("local", null);
    if (t) return pasteInto(t, text);
    const ns = terminals.openLocal(console_.cwd);
    terminals.update(ns.id, { initialInput: text });
    return;
  }
  if (!host.value) return message.warning("没有可用主机");
  const t = targetSession("ssh", host.value.id);
  if (t) return pasteInto(t, text);
  const ns = terminals.openSsh(host.value);
  terminals.update(ns.id, { initialInput: text });
}

function pasteInto(s: TermSession, text: string) {
  const rt = getRuntime(s.id);
  terminals.focusSession(s.id);
  rt?.term.paste(text);
  rt?.term.focus();
}

/** ⌥单击 / ▶ / 右键：沿用现有执行语义（含确认对话框），目标是当前聚焦的终端 */
function run(s: Snippet) {
  if (mode.value === "local") localRun.run(s, console_.cwd, targetSession("local", null));
  else quick.onSelect(s.id);
}

function onClick(s: Snippet, e: MouseEvent) {
  if (e.altKey) run(s);
  else paste(s);
}

async function copy(s: Snippet) {
  try {
    await writeText(preview(s));
    message.success("已复制命令");
  } catch (e) {
    message.error(errorText(e));
  }
}

// ---- 编辑 ----
const editorOpen = ref(false);
const draft = ref<Snippet | null>(null);
function add() {
  if (mode.value === "host") {
    commands.managerOpen = true;
    return;
  }
  draft.value = newLocalSnippetDraft();
  editorOpen.value = true;
}
function edit(s: Snippet) {
  if (mode.value === "host") {
    commands.managerOpen = true;
    return;
  }
  draft.value = localSnippetForEdit(s);
  editorOpen.value = true;
}
function remove(s: Snippet) {
  if (mode.value === "host") {
    commands.managerOpen = true;
    return;
  }
  localRun.remove(s);
}

// ---- 右键菜单 ----
const ctx = ref<{ show: boolean; x: number; y: number; s: Snippet | null }>({ show: false, x: 0, y: 0, s: null });
const ctxOptions = computed<DropdownOption[]>(() => {
  const s = ctx.value.s;
  const out: DropdownOption[] = [
    { key: "paste", label: "粘贴到终端" },
    { key: "run", label: "立即执行  ⌥单击" },
    { key: "copy", label: "复制命令" },
    { type: "divider", key: "d" },
    { key: "edit", label: mode.value === "host" ? "管理主机快捷命令…" : s?.builtin ? "复制为自定义…" : "编辑…" },
  ];
  if (mode.value === "local") out.push({ key: "remove", label: s?.builtin ? "隐藏" : "删除…" });
  return out;
});
function onContext(e: MouseEvent, s: Snippet) {
  e.preventDefault();
  ctx.value = { show: true, x: e.clientX, y: e.clientY, s };
}
const ctxActions: Record<string, (s: Snippet) => unknown> = { paste, run, copy, edit, remove };
function onCtxSelect(key: string) {
  const s = ctx.value.s;
  ctx.value.show = false;
  if (s) ctxActions[key]?.(s);
}

function openConsole() {
  hosts.view = "console";
  terminals.showDetails();
  console_.init();
}
</script>

<template>
  <div class="cmd-panel">
    <PanelHeader title="快捷命令">
      <button v-tip="allExpanded ? '全部收起' : '全部展开'" class="pbtn" :disabled="allGroups.length === 0" @click="toggleAll">
        <component :is="allExpanded ? ChevronsDownUp : ChevronsUpDown" :size="14" />
      </button>
      <button v-tip="mode === 'host' ? '管理主机快捷命令' : '新建本机快捷命令'" class="pbtn" @click="add">
        <Plus :size="15" />
      </button>
      <button
        v-tip="mode === 'host' ? '管理主机快捷命令…' : '本机控制台（管理本机命令）'"
        class="pbtn"
        @click="mode === 'host' ? (commands.managerOpen = true) : openConsole()"
      >
        <Settings2 :size="14" />
      </button>
    </PanelHeader>

    <div class="target muted">
      <component :is="mode === 'host' ? Server : TerminalSquare" :size="12" />
      <span class="target-text">目标：{{ targetLabel }}</span>
    </div>

    <div class="mode">
      <n-tabs :value="mode" type="segment" size="small" animated @update:value="(v: Mode) => (mode = v)">
        <n-tab name="local">本地</n-tab>
        <n-tab name="host">主机</n-tab>
      </n-tabs>
      <n-select
        v-if="mode === 'host'"
        :value="hostId"
        :options="hostOptions"
        size="small"
        placeholder="选择主机"
        @update:value="(v: string) => (hostId = v)"
      />
    </div>

    <div class="search">
      <n-input v-model:value="query" size="small" round clearable placeholder="搜索名称 / 命令" />
    </div>

    <n-scrollbar class="list-scroll">
      <div class="list">
        <div v-if="groups.length === 0" class="muted empty">
          {{ query ? "没有匹配的命令" : "还没有命令，点右上角 ＋ 添加" }}
        </div>
        <template v-for="(g, gi) in groups" :key="g.name">
          <div
            class="group-head"
            :class="[{ dragging: drag?.name === g.name }, dropClass(g.name)]"
            :data-group="g.name"
            v-tip="query ? '' : '点击折叠 / 展开 · 按住拖动排序'"
            @pointerdown="onGroupPointerDown($event, g.name)"
            @click="onGroupClick(g.name)"
          >
            <component :is="expanded(g.name) ? ChevronDown : ChevronRight" :size="12" />
            <span class="group-name">{{ g.name }}</span>
            <span class="count">{{ g.items.length }}</span>
            <span class="group-actions" :class="{ hidden: !!query }" @click.stop>
              <button v-tip="'上移'" class="mini" :disabled="gi === 0" @click="moveGroup(g.name, -1)"><ChevronUp :size="11" /></button>
              <button v-tip="'下移'" class="mini" :disabled="gi === groups.length - 1" @click="moveGroup(g.name, 1)"><ChevronDown :size="11" /></button>
            </span>
          </div>
          <template v-if="expanded(g.name)">
            <div
              v-for="s in g.items"
              :key="s.id"
              class="item"
              :class="{ danger: s.danger }"
              v-tip="s.description ? `${preview(s)}\n${s.description}` : preview(s)"
              @click="onClick(s, $event)"
              @contextmenu="onContext($event, s)"
            >
              <component :is="s.mode === 'terminal' ? Terminal : Zap" :size="12" class="item-mode" />
              <span class="item-name">{{ s.name }}</span>
              <span class="item-cmd mono">{{ preview(s) }}</span>
              <span class="item-actions" @click.stop>
                <button v-tip="'立即执行'" class="mini" @click="run(s)"><Play :size="11" /></button>
                <button v-tip="s.builtin && mode === 'local' ? '复制为自定义' : '编辑'" class="mini" @click="edit(s)">
                  <Pencil :size="11" />
                </button>
              </span>
            </div>
          </template>
        </template>
      </div>
    </n-scrollbar>

    <div class="foot">
      <button class="link" @click="openConsole"><Laptop :size="12" /> 打开本机控制台</button>
    </div>

    <n-dropdown
      trigger="manual"
      placement="bottom-start"
      :show="ctx.show"
      :x="ctx.x"
      :y="ctx.y"
      :options="ctxOptions"
      @clickoutside="ctx.show = false"
      @select="onCtxSelect"
    />
    <Teleport to="body">
      <div v-if="drag" class="drag-ghost" :style="{ left: `${drag.x + 14}px`, top: `${drag.y + 10}px` }">
        {{ drag.name }}
        <span class="drag-hint">{{ dropTarget ? "松手放到这里" : "拖到目标位置" }}</span>
      </div>
    </Teleport>
    <LocalSnippetEditor v-model:show="editorOpen" :draft="draft" />
  </div>
</template>

<style scoped>
.cmd-panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.pbtn {
  display: inline-grid;
  place-items: center;
  width: 26px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-3);
  cursor: default;
}

.pbtn:hover {
  background: var(--hover-3);
  color: var(--text-1);
}

.target {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 12px 8px;
  padding: 4px 10px;
  border-radius: 6px;
  background: var(--hover-1);
  font-size: 11.5px;
}

.target-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mode {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 12px 8px;
}

.search {
  padding: 0 12px 8px;
}

.list-scroll {
  flex: 1;
  min-height: 0;
}

.list {
  padding: 0 8px 8px;
}

.empty {
  padding: 32px 12px;
  text-align: center;
  font-size: 12px;
}

.group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 2px 0 6px;
  margin-top: 2px;
  border-radius: 6px;
  color: var(--text-3);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  cursor: default;
}

.group-head:hover {
  color: var(--text-1);
  background: var(--hover-1);
}

.group-head.dragging {
  opacity: 0.35;
}

.group-head.drop-before {
  box-shadow: inset 0 2px 0 var(--accent);
}

.group-head.drop-after {
  box-shadow: inset 0 -2px 0 var(--accent);
}

.group-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.count {
  font-weight: 400;
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
}

/* ▲▼ 常驻占位，只切透明度：悬停时行高不变 */
.group-actions {
  display: inline-flex;
  gap: 0;
  opacity: 0;
  transition: opacity 0.12s;
}

.group-head:hover .group-actions {
  opacity: 1;
}

.group-actions.hidden {
  visibility: hidden;
}

.mini:disabled {
  opacity: 0.3;
  pointer-events: none;
}

.item {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr) auto;
  grid-template-rows: auto auto;
  column-gap: 8px;
  align-items: center;
  padding: 5px 8px;
  border-radius: 8px;
  cursor: default;
}

.item:hover {
  background: var(--hover-2);
}

.item.danger .item-name {
  color: var(--red-text);
}

.item-mode {
  grid-row: 1 / span 2;
  opacity: 0.6;
}

.item-name {
  font-size: 12.5px;
  font-weight: 500;
  line-height: 18px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-cmd {
  grid-column: 2;
  font-size: 11px;
  color: var(--text-3);
  line-height: 15px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 操作按钮常驻占位，只切透明度：悬停时高度和文字截断都不变 */
.item-actions {
  grid-row: 1 / span 2;
  display: inline-flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.12s;
}

.item:hover .item-actions {
  opacity: 1;
}

.mini {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
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

.foot {
  flex: none;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
}

.link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--accent-text);
  font: inherit;
  font-size: 12px;
  cursor: default;
}

.link:hover {
  text-decoration: underline;
}
</style>
