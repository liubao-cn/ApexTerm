<script setup lang="ts">
import { nextTick, ref } from "vue";
import { NDropdown, NInput, NTooltip, type DropdownOption } from "naive-ui";
import { ArrowUpCircle, Columns2, FolderOpen, LayoutGrid, Palette, Plus, RotateCw, Rows2, Server, TerminalSquare, X } from "lucide-vue-next";
import { useTerminalsStore, type Tab, type TermStatus } from "../stores/terminals";
import { useSettingsStore } from "../stores/settings";
import { useUpdaterStore } from "../stores/updater";
import { appShortcut, isMac, tabIndexLabel } from "../platform";

const terminals = useTerminalsStore();
const settings = useSettingsStore();
const updater = useUpdaterStore();

/** 标签整体状态：有面板在连接 → 连接中；全部结束 → 已结束；否则运行中 */
function tabStatus(t: Tab): TermStatus | "files" {
  if (t.kind === "files") return "files";
  const ss = terminals.sessionsOf(t.id);
  if (ss.some((s) => s.status === "connecting")) return "connecting";
  if (ss.some((s) => s.status === "running")) return "running";
  if (ss.some((s) => s.status === "error")) return "error";
  return "exited";
}

function statusTitle(t: Tab): string {
  const ss = terminals.sessionsOf(t.id);
  if (t.kind === "files") return "文件管理";
  const st = tabStatus(t);
  const base =
    st === "connecting" ? "连接中" : st === "running" ? "已连接" : st === "error" ? "连接失败" : "已结束";
  return ss.length > 1 ? `${base} · ${ss.length} 个分屏` : base;
}

function tabIcon(t: Tab) {
  if (t.kind === "files") return FolderOpen;
  const first = terminals.sessionsOf(t.id)[0];
  return first?.target.kind === "local" ? TerminalSquare : Server;
}

function paneCount(t: Tab): number {
  return terminals.sessionsOf(t.id).length;
}

const newOptions: DropdownOption[] = [
  { key: "local", label: `新建本地终端  ${appShortcut("t")}` },
  { type: "divider", key: "d" },
  { key: "split-row", label: `当前标签向右分屏  ${appShortcut("d")}` },
  { key: "split-col", label: `当前标签向下分屏  ${appShortcut("shift+d")}` },
];

function onNew(key: string) {
  if (key === "local") terminals.openLocal();
  else if (key === "split-row") terminals.split("row");
  else if (key === "split-col") terminals.split("col");
}

const canSplit = () => terminals.activeTab?.kind === "terminal";

// ---- 双击标签重命名 ----
const renamingId = ref<string | null>(null);
const renameText = ref("");
// v-for 里的模板 ref 是数组；同一时刻只会渲染一个输入框
const renameInput = ref<InstanceType<typeof NInput>[]>([]);
function startRename(t: Tab) {
  renamingId.value = t.id;
  renameText.value = t.title;
  nextTick(() => {
    renameInput.value[0]?.focus();
    renameInput.value[0]?.select();
  });
}
function commitRename() {
  const id = renamingId.value;
  if (!id) return;
  renamingId.value = null;
  terminals.renameTab(id, renameText.value);
}
function cancelRename() {
  renamingId.value = null;
}

// ---- 标签拖拽排序（指针事件实现，与主机 / 分组同一套做法） ----
const tabDrag = ref<{ id: string; title: string; x: number; y: number } | null>(null);
const tabDrop = ref<{ id: string; place: "before" | "after" } | null>(null);
let tabPending: { id: string; x: number; y: number } | null = null;
let suppressTabClick = false;

function onTabPointerDown(e: PointerEvent, t: Tab) {
  if (e.button !== 0 || renamingId.value === t.id) return;
  if ((e.target as HTMLElement).closest("button, input")) return;
  tabPending = { id: t.id, x: e.clientX, y: e.clientY };
  window.addEventListener("pointermove", onTabPointerMove);
  window.addEventListener("pointerup", onTabPointerUp, { once: true });
  window.addEventListener("pointercancel", onTabPointerUp, { once: true });
}

function onTabPointerMove(e: PointerEvent) {
  if (!tabPending) return;
  if (!tabDrag.value) {
    if (Math.hypot(e.clientX - tabPending.x, e.clientY - tabPending.y) < 5) return;
    const t = terminals.tabs.find((x) => x.id === tabPending!.id);
    if (!t) return;
    tabDrag.value = { id: t.id, title: t.title, x: e.clientX, y: e.clientY };
    document.body.style.cursor = "grabbing";
  } else {
    tabDrag.value = { ...tabDrag.value, x: e.clientX, y: e.clientY };
  }
  const el = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>(
    ".tab[data-tab-id]",
  );
  if (el?.dataset.tabId && el.dataset.tabId !== tabDrag.value.id) {
    const r = el.getBoundingClientRect();
    tabDrop.value = { id: el.dataset.tabId, place: e.clientX < r.left + r.width / 2 ? "before" : "after" };
  } else {
    tabDrop.value = null;
  }
}

function onTabPointerUp() {
  window.removeEventListener("pointermove", onTabPointerMove);
  const d = tabDrag.value;
  const t = tabDrop.value;
  tabPending = null;
  tabDrag.value = null;
  tabDrop.value = null;
  document.body.style.cursor = "";
  if (!d) return;
  // 拖完的那次 click 不切换标签
  suppressTabClick = true;
  setTimeout(() => (suppressTabClick = false), 0);
  if (t) terminals.reorderTab(d.id, t.id, t.place);
}

function onTabClick(t: Tab) {
  if (!suppressTabClick) terminals.activate(t.id);
}

function tabDropClass(t: Tab) {
  const d = tabDrop.value;
  if (!d || d.id !== t.id) return {};
  return { "drop-before": d.place === "before", "drop-after": d.place === "after" };
}
</script>

<template>
  <div class="tabs" :class="{ mac: isMac }" data-tauri-drag-region>
    <button
      class="tab home"
      :class="{ active: terminals.activeId === null }"
      v-tip="'主页：主机详情 / 本机控制台（ESC 也可返回）'"
      @click="terminals.showDetails()"
    >
      <LayoutGrid :size="14" />
      <span>主页</span>
    </button>

    <div class="tab-list">
      <div
        v-for="(t, i) in terminals.tabs"
        :key="t.id"
        class="tab"
        :class="[{ active: terminals.activeId === t.id, dragging: tabDrag?.id === t.id }, tabDropClass(t)]"
        :data-tab-id="t.id"
        v-tip="`${t.title}\n${statusTitle(t)}  ${tabIndexLabel(i + 1)}  ·  双击重命名 · 按住拖动排序`"
        @pointerdown="onTabPointerDown($event, t)"
        @click="onTabClick(t)"
        @dblclick="startRename(t)"
        @auxclick.middle.prevent="terminals.closeTab(t.id)"
      >
        <span class="dot" :class="tabStatus(t)"></span>
        <component :is="tabIcon(t)" :size="13" class="tab-icon" />
        <n-input
          v-if="renamingId === t.id"
          ref="renameInput"
          v-model:value="renameText"
          size="tiny"
          class="tab-rename"
          placeholder="标签名称"
          @keydown.enter.prevent="commitRename"
          @keydown.esc.prevent="cancelRename"
          @blur="commitRename"
          @click.stop
          @dblclick.stop
        />
        <span v-else class="label">{{ t.title }}</span>
        <span v-if="paneCount(t) > 1" v-tip="'分屏数'" class="panes">{{ paneCount(t) }}</span>
        <button v-tip="`关闭标签  ${appShortcut('w')}`" class="close" @click.stop="terminals.closeTab(t.id)">
          <X :size="12" />
        </button>
      </div>
    </div>

    <template v-if="canSplit()">
      <n-tooltip placement="bottom">
        <template #trigger>
          <button class="tab-add" @click="terminals.split('row')"><Columns2 :size="14" /></button>
        </template>
        向右分屏 {{ appShortcut("d") }}
      </n-tooltip>
      <n-tooltip placement="bottom">
        <template #trigger>
          <button class="tab-add" @click="terminals.split('col')"><Rows2 :size="14" /></button>
        </template>
        向下分屏 {{ appShortcut("shift+d") }}
      </n-tooltip>
    </template>

    <n-dropdown trigger="click" placement="bottom-start" :options="newOptions" @select="onNew">
      <button v-tip="'新建终端 / 分屏'" class="tab-add">
        <Plus :size="15" />
      </button>
    </n-dropdown>

    <div class="spacer" data-tauri-drag-region></div>

    <!-- 后台发现新版 / 已装好待重启：只亮一个徽标，不弹窗不抢焦点 -->
    <button
      v-if="updater.phase === 'installed'"
      v-tip="'新版本已安装，重启后生效'"
      class="update-badge installed"
      @click="updater.open()"
    >
      <RotateCw :size="13" />重启完成更新
    </button>
    <button
      v-else-if="updater.phase === 'available' && updater.update"
      v-tip="`发现新版本 ${updater.update.version}，点击查看更新说明`"
      class="update-badge"
      @click="updater.open()"
    >
      <ArrowUpCircle :size="13" />{{ updater.update.version }} 可用
    </button>

    <button v-tip="`终端外观 / 主题 / 字体  ${appShortcut(',')}`" class="tab-add" @click="settings.show('themes')">
      <Palette :size="15" />
    </button>

    <Teleport to="body">
      <div v-if="tabDrag" class="drag-ghost" :style="{ left: `${tabDrag.x + 14}px`, top: `${tabDrag.y + 10}px` }">
        {{ tabDrag.title }}
        <span class="drag-hint">{{ tabDrop ? "松手放到这里" : "拖到目标位置" }}</span>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.tabs {
  height: var(--titlebar-h);
  flex: none;
  display: flex;
  align-items: flex-end;
  gap: 2px;
  padding: 0 8px 0 10px;
  border-bottom: 1px solid var(--border);
  background: var(--sidebar-bg);
}

/* macOS 隐藏标题栏后红黄绿按钮悬浮在左上角，给它们留位置 */
.tabs.mac {
  padding-left: 82px;
}

.tab,
.tab-add {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  margin-bottom: 4px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--text-3);
  font: inherit;
  font-size: 12.5px;
  cursor: default;
  white-space: nowrap;
  transition: background 0.12s, color 0.12s;
}

.tab:hover,
.tab-add:hover {
  background: var(--hover-2);
  color: var(--text-2);
}

.tab.active {
  background: var(--bg);
  border-color: var(--border);
  color: var(--text-1);
}

.tab.dragging {
  opacity: 0.35;
}

.tab.drop-before {
  box-shadow: inset 2px 0 0 var(--accent);
}

.tab.drop-after {
  box-shadow: inset -2px 0 0 var(--accent);
}

.tab.home {
  padding-right: 12px;
}

.tab-list {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.tab-list::-webkit-scrollbar {
  display: none;
}

.tab .label {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tab-rename {
  width: 140px;
}

.tab-icon {
  flex: none;
  opacity: 0.8;
}

.panes {
  font-size: 10px;
  line-height: 14px;
  padding: 0 5px;
  border-radius: 999px;
  background: rgba(91, 141, 239, 0.2);
  color: var(--accent-text);
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
  background: var(--text-3);
}

.dot.connecting {
  background: var(--orange);
  animation: pulse 1s ease-in-out infinite;
}

.dot.running {
  background: var(--green);
}

.dot.exited {
  background: var(--text-3);
}

.dot.error {
  background: var(--red);
}

.dot.files {
  background: var(--accent-text);
}

@keyframes pulse {
  50% {
    opacity: 0.3;
  }
}

.close {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  margin-right: -4px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  opacity: 0;
  cursor: default;
}

.tab:hover .close,
.tab.active .close {
  opacity: 0.7;
}

.close:hover {
  opacity: 1 !important;
  background: var(--hover-3);
}

.tab-add {
  padding: 0 7px;
}

/* 更新徽标：强调色胶囊，和标签同高对齐 */
.update-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  margin: 0 4px 7px 0;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-text);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: default;
  white-space: nowrap;
}

.update-badge:hover {
  border-color: var(--accent);
}

.update-badge.installed {
  background: color-mix(in srgb, var(--green) 16%, transparent);
  color: var(--green-text);
}

.update-badge.installed:hover {
  border-color: var(--green);
}

.spacer {
  flex: 1;
  height: 100%;
}
</style>
