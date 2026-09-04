<script setup lang="ts">
import { computed, h, ref } from "vue";
import { NButton, NDropdown, NInput, NScrollbar, NTag, NTooltip, useDialog, useMessage, type DropdownOption } from "naive-ui";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useQuickCommands } from "../quickCommands";
import {
  Asterisk,
  Cloud,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  GitBranch,
  MoreHorizontal,
  Palette,
  Plus,
  Settings,
  Radar,
  RefreshCw,
  Search,
  Server,
  Settings2,
  Star,
  Users,
} from "lucide-vue-next";
import { UNGROUPED, useHostsStore, type Filter } from "../stores/hosts";
import { useTerminalsStore } from "../stores/terminals";
import { useCommandsStore } from "../stores/commands";
import { useCloudStore } from "../stores/cloud";
import { useSettingsStore } from "../stores/settings";
import { PROVIDER_LABEL, errorText, type HostEntry } from "../api";
import { appShortcut } from "../platform";
import PanelHeader from "./PanelHeader.vue";

const emit = defineEmits<{ create: []; edit: [host: HostEntry] }>();
const store = useHostsStore();
const terminals = useTerminalsStore();
const commands = useCommandsStore();
const cloud = useCloudStore();
const settings = useSettingsStore();
const message = useMessage();
const dialog = useDialog();

// ---- 主机右键菜单 ----
const ctxHost = ref<HostEntry | null>(null);
const ctx = ref({ show: false, x: 0, y: 0 });
const quick = useQuickCommands(ctxHost, ref(null));

const ctxOptions = computed<DropdownOption[]>(() => {
  const h = ctxHost.value;
  if (!h) return [];
  const m = store.metaOf(h.id);
  const out: DropdownOption[] = [];
  if (h.kind !== "pattern") {
    out.push({ key: "connect", label: "连接（新标签）" });
    if (terminals.activeTab?.kind === "terminal") {
      out.push({ key: "split-row", label: "在当前标签向右分屏打开" });
      out.push({ key: "split-col", label: "在当前标签向下分屏打开" });
    }
    if (h.kind === "server") out.push({ key: "files", label: "文件管理" });
    out.push({ key: "probe", label: "探测在线 / 免密" });
    if (quick.groupOptions.value.length) out.push({ key: "qc", label: "快捷命令", children: quick.groupOptions.value });
    out.push({ type: "divider", key: "d1" });
  }
  out.push({ key: "copy", label: `复制命令  ssh ${h.alias}` });
  out.push({ key: "favorite", label: m.favorite ? "取消收藏" : "收藏" });
  out.push({ key: "edit", label: "编辑…" });
  out.push({ type: "divider", key: "d2" });
  out.push({ key: "delete", label: "删除…" });
  return out;
});

function onHostContext(e: MouseEvent, h: HostEntry) {
  e.preventDefault();
  ctxHost.value = h;
  ctx.value = { show: true, x: e.clientX, y: e.clientY };
}

async function onCtxSelect(key: string) {
  ctx.value.show = false;
  const h = ctxHost.value;
  if (!h) return;
  switch (key) {
    case "connect":
      return connect(h);
    case "split-row":
      return terminals.split("row", { kind: "ssh", alias: h.alias }, h.alias, h.id);
    case "split-col":
      return terminals.split("col", { kind: "ssh", alias: h.alias }, h.alias, h.id);
    case "files":
      return terminals.openFiles(h);
    case "probe":
      return store.probeHost(h);
    case "copy":
      try {
        await writeText(`ssh ${h.alias}`);
        message.success(`已复制：ssh ${h.alias}`);
      } catch (e) {
        message.error(errorText(e));
      }
      return;
    case "favorite":
      return store.toggleFavorite(h.id);
    case "edit":
      return emit("edit", h);
    case "delete":
      dialog.warning({
        title: `删除 ${h.alias}？`,
        content: `将从 ${h.sourceFile} 中移除这个 Host 段（删除前会自动备份）。`,
        positiveText: "删除",
        negativeText: "取消",
        onPositiveClick: async () => {
          try {
            await store.remove(h.id);
            message.success("已删除");
          } catch (e) {
            message.error(errorText(e));
          }
        },
      });
      return;
  }
  quick.onSelect(key);
}

// ---- 「⋯」菜单 ----
const icon = (c: typeof Cloud) => () => h(c, { size: 14 });
const menuOptions = computed<DropdownOption[]>(() => [
  {
    key: "privacy",
    label: store.privacy ? "隐私模式：开（地址已打码）" : "隐私模式：关",
    icon: icon(store.privacy ? EyeOff : Eye),
  },
  { type: "divider", key: "d0" },
  { key: "cloud", label: "云账号 / 带外开关机", icon: icon(Cloud) },
  { key: "batch", label: "在多台服务器上执行", icon: icon(Users), disabled: store.servers.length === 0 },
  { key: "snippets", label: "管理快捷命令", icon: icon(Settings2) },
  { key: "appearance", label: "终端配色主题…", icon: icon(Palette) },
  { key: "settings", label: `设置…  ${appShortcut(",")}`, icon: icon(Settings) },
  { type: "divider", key: "d1" },
  { key: "reload", label: `重新读取 ~/.ssh/config  ${appShortcut("r")}`, icon: icon(RefreshCw) },
]);

function onMenu(key: string) {
  switch (key) {
    case "privacy":
      store.togglePrivacy();
      break;
    case "cloud":
      cloud.modalOpen = true;
      break;
    case "batch":
      commands.openBatch();
      break;
    case "snippets":
      commands.managerOpen = true;
      break;
    case "appearance":
      settings.show("themes");
      break;
    case "settings":
      settings.show();
      break;
    case "reload":
      store.load();
      break;
  }
}

// ---- 拖拽排序（指针事件实现；WebView 自带的文件拖放会吞掉 HTML5 drop 事件，不能用 draggable） ----
interface DragState {
  id: string;
  alias: string;
  x: number;
  y: number;
}
const drag = ref<DragState | null>(null);
const dropTarget = ref<{ id: string; place: "before" | "after" } | null>(null);
let pending: { host: HostEntry; startX: number; startY: number } | null = null;
let suppressClick = false;

function onPointerDown(e: PointerEvent, host: HostEntry) {
  if (e.button !== 0) return;
  pending = { host, startX: e.clientX, startY: e.clientY };
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp, { once: true });
  // 指针在窗口外松开时收不到 pointerup，靠这两个兜底收尾
  window.addEventListener("pointercancel", onPointerUp, { once: true });
  window.addEventListener("blur", onPointerUp, { once: true });
}

function onPointerMove(e: PointerEvent) {
  if (!pending) return;
  if (!drag.value) {
    if (Math.hypot(e.clientX - pending.startX, e.clientY - pending.startY) < 5) return;
    drag.value = { id: pending.host.id, alias: pending.host.alias, x: e.clientX, y: e.clientY };
    document.body.style.cursor = "grabbing";
  } else {
    drag.value = { ...drag.value, x: e.clientX, y: e.clientY };
  }
  const el = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>(
    ".host-item[data-id]",
  );
  if (el && el.dataset.id && el.dataset.id !== drag.value.id) {
    const rect = el.getBoundingClientRect();
    dropTarget.value = {
      id: el.dataset.id,
      place: e.clientY < rect.top + rect.height / 2 ? "before" : "after",
    };
  } else {
    dropTarget.value = null;
  }
  // 靠近列表上下边缘时自动滚动
  const scroller = document.querySelector<HTMLElement>(".hosts-panel .list-scroll .n-scrollbar-container");
  if (scroller) {
    const r = scroller.getBoundingClientRect();
    if (e.clientY < r.top + 28) scroller.scrollTop -= 10;
    else if (e.clientY > r.bottom - 28) scroller.scrollTop += 10;
  }
}

async function onPointerUp() {
  window.removeEventListener("pointermove", onPointerMove);
  const d = drag.value;
  const t = dropTarget.value;
  pending = null;
  drag.value = null;
  dropTarget.value = null;
  document.body.style.cursor = "";
  if (!d) return;
  suppressClick = true;
  setTimeout(() => (suppressClick = false), 0);
  if (t) await store.reorder(d.id, t.id, t.place);
}

function dropClass(host: HostEntry) {
  const t = dropTarget.value;
  if (!t || t.id !== host.id) return {};
  return { "drop-before": t.place === "before", "drop-after": t.place === "after" };
}

// ---- 在线状态 ----
function aliveTitle(h: HostEntry): string {
  const a = store.aliveOf(h.id);
  if (a.status === "idle") return "未探测（点顶部 📡 探测全部）";
  if (a.status === "checking") return "探测中…";
  const when = new Date(a.checkedAt).toLocaleTimeString("zh-CN", { hour12: false });
  return `${a.message}\n${when}`;
}

function rebooting(h: HostEntry): boolean {
  const w = commands.watchOf(h.id);
  return !!w && (w.phase === "waitingDown" || w.phase === "down");
}

/** 再次单击已选中的服务器 → 稍等一下再取消选中，给双击留出判定时间 */
let deselectTimer: number | null = null;

function connect(h: HostEntry, e?: MouseEvent) {
  if (deselectTimer) {
    clearTimeout(deselectTimer);
    deselectTimer = null;
  }
  if (h.kind === "pattern") return;
  store.selectHost(h.id);
  // ⌥ + 双击：在当前终端标签里分屏打开，而不是新开标签
  if (e?.altKey && terminals.activeTab?.kind === "terminal") {
    terminals.split("row", { kind: "ssh", alias: h.alias }, h.alias, h.id);
    return;
  }
  terminals.openSsh(h);
}

function liveSessions(h: HostEntry): number {
  return terminals.sessions.filter(
    (s) => s.hostId === h.id && (s.status === "running" || s.status === "connecting"),
  ).length;
}

interface Pill {
  filter: Filter;
  label: string;
  count: number;
  icon: typeof Server;
}

const pills = computed<Pill[]>(() => {
  const list: Pill[] = [
    { filter: { type: "all" }, label: "全部", count: store.servers.length, icon: Server },
  ];
  if (store.favorites.length) {
    list.push({ filter: { type: "favorites" }, label: "收藏", count: store.favorites.length, icon: Star });
  }
  for (const g of store.groups) {
    list.push({
      filter: { type: "group", name: g },
      label: g,
      count: store.groupCounts.get(g) ?? 0,
      icon: Folder,
    });
  }
  if (store.groups.length && (store.groupCounts.get(UNGROUPED) ?? 0) > 0) {
    list.push({
      filter: { type: "ungrouped" },
      label: UNGROUPED,
      count: store.groupCounts.get(UNGROUPED) ?? 0,
      icon: FolderOpen,
    });
  }
  if (store.gitHosts.length) {
    list.push({ filter: { type: "git" }, label: "Git 平台", count: store.gitHosts.length, icon: GitBranch });
  }
  if (store.patternHosts.length) {
    list.push({ filter: { type: "pattern" }, label: "规则", count: store.patternHosts.length, icon: Asterisk });
  }
  return list;
});

function sameFilter(a: Filter, b: Filter): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "group" && b.type === "group") return a.name === b.name;
  return true;
}

function isActive(f: Filter): boolean {
  return store.view === "hosts" && sameFilter(store.filter, f);
}

function setFilter(f: Filter) {
  store.filter = f;
  store.view = "hosts";
}

function select(h: HostEntry) {
  if (suppressClick) return;
  const alreadyShown =
    store.view === "hosts" && store.selectedId === h.id && terminals.activeId === null;
  if (alreadyShown) {
    if (deselectTimer) clearTimeout(deselectTimer);
    deselectTimer = window.setTimeout(() => {
      deselectTimer = null;
      store.selectedId = null;
    }, 260);
    return;
  }
  store.selectHost(h.id);
  terminals.showDetails();
}

function kindIcon(h: HostEntry) {
  return h.kind === "gitPlatform" ? GitBranch : h.kind === "pattern" ? Asterisk : Server;
}
</script>

<template>
  <div class="hosts-panel">
    <PanelHeader title="连接中心">
      <n-tooltip placement="bottom">
        <template #trigger>
          <n-button
            quaternary
            circle
            size="small"
            :loading="store.probingAll"
            :disabled="store.servers.length === 0"
            @click="store.probeAllServers()"
          >
            <template #icon><Radar :size="15" /></template>
          </n-button>
        </template>
        探测全部服务器是否在线、免密是否有效
      </n-tooltip>
      <n-tooltip placement="bottom">
        <template #trigger>
          <n-button quaternary circle size="small" @click="emit('create')">
            <template #icon><Plus :size="17" /></template>
          </n-button>
        </template>
        添加服务器
      </n-tooltip>
      <n-dropdown trigger="click" placement="bottom-end" :options="menuOptions" @select="onMenu">
        <n-button quaternary circle size="small">
          <template #icon><MoreHorizontal :size="16" /></template>
        </n-button>
      </n-dropdown>
    </PanelHeader>

    <div v-if="store.privacy" class="privacy-bar" @click="store.togglePrivacy()">
      <EyeOff :size="12" />
      隐私模式：地址已打码，点此关闭
    </div>
    <div
      v-else-if="store.aliveSummary.online + store.aliveSummary.offline > 0"
      class="alive-bar muted"
    >
      <span class="dot-online"></span>{{ store.aliveSummary.online }} 在线
      <span class="dot-offline"></span>{{ store.aliveSummary.offline }} 离线
      <span v-if="store.probingAll" class="muted">· 探测中…</span>
    </div>

    <div class="search">
      <n-input
        v-model:value="store.query"
        placeholder="搜索别名 / 地址 / 标签 / 备注"
        clearable
        size="small"
        round
      >
        <template #prefix><Search :size="14" class="muted" /></template>
      </n-input>
    </div>

    <div class="pills">
      <button
        v-for="p in pills"
        :key="p.label + p.filter.type"
        class="pill"
        :class="{ active: isActive(p.filter) }"
        @click="setFilter(p.filter)"
      >
        <component :is="p.icon" :size="12" />
        <span>{{ p.label }}</span>
        <span class="pill-count">{{ p.count }}</span>
      </button>
      <button
        v-if="store.candidates.length"
        class="pill candidates"
        :class="{ active: store.view === 'candidates' }"
        v-tip="'known_hosts 里连过、但没写进 config 的主机'"
        @click="store.view = 'candidates'"
      >
        <Radar :size="12" />
        <span>候选</span>
        <span class="pill-count">{{ store.activeCandidates.length }}</span>
      </button>
    </div>

    <n-scrollbar class="list-scroll">
      <div class="list">
        <template v-for="sec in store.sections" :key="sec.name ?? '__flat'">
          <div v-if="sec.name" class="section-title">{{ sec.name }}</div>
          <div
            v-for="h in sec.hosts"
            :key="h.id"
            class="host-item"
            :class="[
              { selected: store.view === 'hosts' && store.selectedId === h.id, dragging: drag?.id === h.id },
              dropClass(h),
            ]"
            :data-id="h.id"
            v-tip="h.kind === 'pattern' ? '' : '双击连接 · ⌥双击分屏 · 右键更多 · 按住拖动排序'"
            @pointerdown="onPointerDown($event, h)"
            @click="select(h)"
            @dblclick="connect(h, $event)"
            @contextmenu="onHostContext($event, h)"
          >
            <span v-tip="aliveTitle(h)" class="host-icon-wrap" :class="store.aliveOf(h.id).status">
              <component :is="kindIcon(h)" :size="15" class="host-icon" />
            </span>
            <div class="host-main">
              <div class="host-alias">
                <span class="alias-text">{{ h.alias }}</span>
                <span v-if="rebooting(h)" v-tip="'重启中，等待恢复'" class="live rebooting"></span>
                <span v-else-if="liveSessions(h)" v-tip="`${liveSessions(h)} 个会话`" class="live"></span>
                <Star
                  v-if="store.metaOf(h.id).favorite"
                  :size="11"
                  class="fav"
                  fill="currentColor"
                />
              </div>
              <div class="host-target mono">
                <span
                  v-if="store.metaOf(h.id).cloud"
                  class="prov"
                  :class="store.metaOf(h.id).cloud!.provider"
                  v-tip="`已绑定${PROVIDER_LABEL[store.metaOf(h.id).cloud!.provider]}实例，可带外开关机`"
                >
                  {{ PROVIDER_LABEL[store.metaOf(h.id).cloud!.provider] }}
                </span>
                {{ store.displayTarget(h) }}
              </div>
            </div>
            <div v-if="store.metaOf(h.id).tags.length" class="host-tags">
              <n-tag
                v-for="t in store.metaOf(h.id).tags.slice(0, 2)"
                :key="t"
                size="tiny"
                :bordered="false"
                round
              >
                {{ t }}
              </n-tag>
            </div>
          </div>
        </template>
        <div v-if="!store.loading && store.filtered.length === 0" class="list-empty muted">
          {{ store.hosts.length === 0 ? "还没有任何主机，点右上角 + 添加" : "没有匹配的主机" }}
        </div>
      </div>
    </n-scrollbar>

    <n-dropdown
      trigger="manual"
      placement="bottom-start"
      :show="ctx.show"
      :x="ctx.x"
      :y="ctx.y"
      :options="ctxOptions"
      :render-label="quick.renderLabel"
      @clickoutside="ctx.show = false"
      @select="onCtxSelect"
    />

    <Teleport to="body">
      <div v-if="drag" class="drag-ghost" :style="{ left: `${drag.x + 14}px`, top: `${drag.y + 10}px` }">
        <Server :size="13" />
        {{ drag.alias }}
        <span class="drag-hint">{{ dropTarget ? "松手放到这里" : "拖到目标位置" }}</span>
      </div>
    </Teleport>

    <div v-tip="store.files.join('\n')" class="sidebar-footer muted mono">
      {{ store.configPath || "~/.ssh/config" }}
      <span v-if="store.files.length > 1">+{{ store.files.length - 1 }}</span>
    </div>
  </div>
</template>

<style scoped>
.hosts-panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.search {
  margin-top: 2px;
  padding: 0 12px 10px;
}

.pills {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 12px 10px;
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 9px;
  border-radius: 999px;
  border: 1px solid transparent;
  background: var(--hover-2);
  color: var(--text-2);
  font: inherit;
  font-size: 12px;
  cursor: default;
  transition: background 0.12s;
}

.pill:hover {
  background: var(--hover-3);
}

.pill.active {
  background: var(--accent-soft);
  border-color: rgba(91, 141, 239, 0.4);
  color: var(--accent-text);
}

.pill.candidates {
  color: var(--green);
  background: rgba(61, 190, 122, 0.1);
}

.pill.candidates.active {
  background: rgba(61, 190, 122, 0.18);
  border-color: rgba(61, 190, 122, 0.45);
  color: #b9f0d2;
}

.pill > span:first-of-type {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pill-count {
  font-size: 11px;
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
}

.list-scroll {
  flex: 1;
  min-height: 0;
}

.list {
  padding: 0 8px 8px;
}

.section-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--text-3);
  padding: 12px 8px 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.host-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  border-radius: 8px;
  cursor: default;
}

.host-item:hover {
  background: var(--hover-2);
}

.host-item.selected {
  background: var(--accent-soft);
}

.host-item.dragging {
  opacity: 0.35;
}

.host-item.drop-before {
  box-shadow: inset 0 2px 0 var(--accent);
}

.host-item.drop-after {
  box-shadow: inset 0 -2px 0 var(--accent);
}
</style>

<style>
/* 拖动时跟随指针的影子，Teleport 到 body，不能用 scoped */
.drag-ghost {
  position: fixed;
  z-index: 9999;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: 8px;
  background: #26262d;
  border: 1px solid rgba(91, 141, 239, 0.5);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  color: #ededf1;
  font-size: 13px;
  font-weight: 500;
  pointer-events: none;
}

.drag-hint {
  font-size: 11px;
  font-weight: 400;
  color: #8c8c96;
}
</style>

<style scoped>

.host-icon-wrap {
  position: relative;
  display: inline-flex;
  flex: none;
}

.host-icon {
  color: var(--text-3);
}

.host-item.selected .host-icon {
  color: var(--accent);
}

/* 在线状态：图标右下角小圆点 */
.host-icon-wrap::after {
  content: "";
  position: absolute;
  right: -3px;
  bottom: -2px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  border: 2px solid var(--sidebar-bg);
  background: transparent;
}

.host-item.selected .host-icon-wrap::after {
  border-color: var(--accent-soft);
}

.host-icon-wrap.online::after {
  background: var(--green);
}

.host-icon-wrap.offline::after {
  background: var(--red);
}

.host-icon-wrap.checking::after {
  background: var(--orange);
  animation: pulse 1s ease-in-out infinite;
}

.privacy-bar,
.alive-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 12px 8px;
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 11.5px;
}

.privacy-bar {
  background: rgba(227, 162, 58, 0.14);
  color: var(--orange-text);
  cursor: default;
}

.privacy-bar:hover {
  background: rgba(227, 162, 58, 0.22);
}

.alive-bar {
  padding-left: 2px;
}

.dot-online,
.dot-offline {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  display: inline-block;
}

.dot-online {
  background: var(--green);
}

.dot-offline {
  background: var(--red);
  margin-left: 6px;
}

.host-main {
  flex: 1;
  min-width: 0;
}

.host-alias {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 500;
  font-size: 13px;
  line-height: 18px;
}

.alias-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fav {
  color: var(--orange);
  flex: none;
}

.live {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--green);
  box-shadow: 0 0 0 2px rgba(61, 190, 122, 0.25);
  flex: none;
}

.live.rebooting {
  background: var(--orange);
  box-shadow: 0 0 0 2px rgba(227, 162, 58, 0.25);
  animation: pulse 1s ease-in-out infinite;
}

@keyframes pulse {
  50% {
    opacity: 0.25;
  }
}

.host-target {
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 16px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.prov {
  display: inline-block;
  margin-right: 5px;
  padding: 0 5px;
  border-radius: 4px;
  font-family:
    -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Segoe UI", sans-serif;
  font-size: 10px;
  line-height: 15px;
  vertical-align: 1px;
}

.prov.tencent {
  background: rgba(0, 82, 217, 0.25);
  color: var(--accent-text);
}

.prov.volcengine {
  background: rgba(22, 100, 255, 0.2);
  color: var(--accent-text);
}

.host-tags {
  display: flex;
  gap: 4px;
  flex: none;
  max-width: 45%;
  overflow: hidden;
}

.host-tags :deep(.n-tag__content) {
  max-width: 72px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.list-empty {
  padding: 32px 12px;
  text-align: center;
}

.sidebar-footer {
  flex: none;
  padding: 8px 14px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
