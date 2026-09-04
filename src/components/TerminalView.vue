<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRef, watch } from "vue";
import { NButton, NDropdown, NInput, NTooltip, useDialog, useMessage, type DropdownOption } from "naive-ui";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  ChevronDown,
  ChevronUp,
  Columns2,
  ExternalLink,
  RotateCcw,
  Rows2,
  Server,
  TerminalSquare,
  X,
  Zap,
} from "lucide-vue-next";
import { api, base64ToBytes, errorText, type PastePayload } from "../api";
import { pathsForShell } from "../shellPath";
import { reflowSelection } from "../copyReflow";
import { useTerminalsStore, type DropSide, type DropZone, type TermSession } from "../stores/terminals";
import { useHostsStore } from "../stores/hosts";
import { useSettingsStore } from "../stores/settings";
import { attach, beep, createRuntime, detach, getRuntime, type TermRuntime } from "../terminalRegistry";
import { appShortcut, isTabModifier } from "../platform";
import { useQuickCommands } from "../quickCommands";
import { useShortcutsStore } from "../stores/shortcuts";
import SplitMenu from "./SplitMenu.vue";

const props = defineProps<{ session: TermSession; active: boolean }>();
const store = useTerminalsStore();
const hosts = useHostsStore();
const settings = useSettingsStore();
const shortcuts = useShortcutsStore();
const message = useMessage();
const dialog = useDialog();

const host = computed(() =>
  props.session.hostId ? hosts.hosts.find((h) => h.id === props.session.hostId) : undefined,
);
const sessionRef = toRef(props, "session");
const quick = useQuickCommands(host, sessionRef);

const container = ref<HTMLDivElement | null>(null);
const searchOpen = ref(false);
const searchText = ref("");
const searchInput = ref<InstanceType<typeof NInput> | null>(null);

let rt: TermRuntime;
let resizeObserver: ResizeObserver | null = null;
let fitFrame = 0;
let unmounted = false;

const GRAY = "\x1b[90m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

// ---- 连接中计时 ----
const connectElapsed = ref(0);
let elapsedTimer: number | null = null;
function startConnectClock() {
  const started = Date.now();
  connectElapsed.value = 0;
  stopConnectClock();
  elapsedTimer = window.setInterval(() => (connectElapsed.value = Math.round((Date.now() - started) / 1000)), 500);
}
function stopConnectClock() {
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = null;
}

function scheduleFit() {
  cancelAnimationFrame(fitFrame);
  fitFrame = requestAnimationFrame(() => {
    if (!props.active || unmounted) return;
    try {
      rt.fit.fit();
    } catch {
      /* 容器尚未布局完成时 fit 会抛错，忽略 */
    }
  });
}

async function connect() {
  const token = {};
  rt.connectionToken = token;
  rt.backendId = null;
  rt.gotOutput = false;
  const sessionId = props.session.id;
  startConnectClock();
  try {
    rt.fit.fit();
  } catch {
    /* ignore */
  }
  try {
    const id = await api.openTerminal(props.session.target, rt.term.cols, rt.term.rows, (m) => {
      if (rt.connectionToken !== token) return;
      if (m.type === "data") {
        if (!rt.gotOutput) {
          rt.gotOutput = true;
          stopConnectClock();
          store.update(sessionId, { status: "running" });
          // 控制台 / 命令面板开出来的会话：提示符出来后把内容原样写进去（要执行的话调用方自带 \r）
          const pending = store.sessions.find((s) => s.id === sessionId)?.initialInput;
          if (pending) {
            store.update(sessionId, { initialInput: null });
            setTimeout(() => {
              if (rt.backendId) api.writeTerminal(rt.backendId, pending).catch(() => {});
            }, 250);
          }
        }
        rt.term.write(base64ToBytes(m.data));
      } else {
        rt.backendId = null;
        stopConnectClock();
        store.update(sessionId, { status: "exited", exitCode: m.code, backendId: null });
        const code = m.code != null ? `，退出码 ${m.code}` : "";
        rt.term.write(`\r\n${GRAY}— 会话已结束${code}。按回车重新连接，${appShortcut("w")} 关闭 —${RESET}\r\n`);
        if (m.code === 0) rt.reconnectAttempts = 0;
        scheduleAutoReconnect(m.code);
      }
    }, settings.prefs.termType, settings.prefs.termProgram);
    if (rt.connectionToken !== token) {
      api.closeTerminal(id).catch(() => {});
      return;
    }
    rt.backendId = id;
    store.update(sessionId, { backendId: id, ...(rt.gotOutput ? { status: "running" as const } : {}) });
    api.resizeTerminal(id, rt.term.cols, rt.term.rows).catch(() => {});
  } catch (e) {
    if (rt.connectionToken !== token) return;
    stopConnectClock();
    store.update(sessionId, { status: "error", error: errorText(e) });
    rt.term.write(`\r\n${RED}连接失败：${errorText(e)}${RESET}\r\n${GRAY}按回车重试，${appShortcut("w")} 关闭${RESET}\r\n`);
  }
}

function reconnect() {
  store.reconnect(props.session.id);
}

// ---- 查找 ----
function toggleSearch() {
  searchOpen.value = !searchOpen.value;
  if (searchOpen.value) nextTick(() => searchInput.value?.focus());
  else {
    rt.search.clearDecorations();
    rt.term.focus();
  }
}
const findNext = () => searchText.value && rt.search.findNext(searchText.value, { incremental: false });
const findPrev = () => searchText.value && rt.search.findPrevious(searchText.value);

// ---- 剪贴板 ----
/** 当前选区文本；默认把 TUI 按宽度截断的长行接回一行，raw=true 原样 */
function selectionText(raw = false): string {
  const text = rt.term.getSelection();
  return !raw && settings.prefs.copyReflow ? reflowSelection(text, rt.term.cols) : text;
}

async function copySelection(raw = false) {
  const text = selectionText(raw);
  if (!text) return message.info("没有选中文本");
  try {
    await writeText(text);
    rt.term.clearSelection();
  } catch (e) {
    message.error(errorText(e));
  }
}

/** 捕获阶段接管 ⌘C / 菜单拷贝：xterm 自己的 copy 处理只会原样拷贝 */
function onDomCopy(e: ClipboardEvent) {
  if (!rt.term.hasSelection() || !e.clipboardData) return;
  e.preventDefault();
  e.stopPropagation();
  e.clipboardData.setData("text/plain", selectionText());
}

/** 统一粘贴入口：文本走 xterm 粘贴；图片 / 文件走路径 */
async function pasteClipboard() {
  let payload: PastePayload;
  try {
    payload = await api.clipboardPaste();
  } catch (e) {
    return message.error(`读取剪贴板失败：${errorText(e)}`);
  }
  if (payload.kind === "empty") return;
  if (payload.kind === "text") return rt.term.paste(payload.text);
  pastePaths(payload.paths);
}

/** 图片 / 文件路径：本地终端直接粘，SSH 会话提示（远端看不到本机文件） */
function pastePaths(paths: string[]) {
  if (!paths.length) return;
  if (props.session.target.kind !== "local") {
    dialog.info({
      title: "剪贴板里是本机图片 / 文件",
      content: `远端 ${props.session.title} 看不到本机文件。可以先用「文件管理」上传，再粘贴远端路径。`,
      positiveText: host.value ? "打开文件管理" : undefined,
      negativeText: "关闭",
      onPositiveClick: () => {
        if (host.value) store.openFiles(host.value);
      },
    });
    return;
  }
  rt.term.paste(pathsForShell(paths));
  rt.term.focus();
}

/** 捕获阶段拦住 xterm 自己的粘贴：⌘V / 菜单粘贴 / 右键粘贴全部走同一条路，图片和文件也能粘出路径 */
function onDomPaste(e: ClipboardEvent) {
  e.preventDefault();
  e.stopPropagation();
  pasteClipboard();
}

// ---- 右键菜单 ----
const ctx = ref({ show: false, x: 0, y: 0 });
const ctxOptions = computed<DropdownOption[]>(() => {
  const hasSel = rt?.term.hasSelection() ?? false;
  const out: DropdownOption[] = [
    { key: "copy", label: hasSel ? "复制" : "复制（未选中）", disabled: !hasSel },
    ...(hasSel && settings.prefs.copyReflow ? [{ key: "copy-raw", label: "复制（保留换行）" }] : []),
    { key: "paste", label: "粘贴" },
    { key: "select-all", label: "全选" },
    { type: "divider", key: "d1" },
    { key: "clear", label: `清屏  ${appShortcut("k")}` },
    { key: "find", label: `查找  ${appShortcut("f")}` },
    { type: "divider", key: "d2" },
    { key: "split-row", label: `向右分屏  ${appShortcut("d")}` },
    { key: "split-col", label: `向下分屏  ${appShortcut("shift+d")}` },
  ];
  if (multiPane.value) out.push({ key: "detach", label: "移到新标签" });
  out.push({ key: "rename", label: "重命名面板…" });
  if (host.value && quick.groupOptions.value.length) {
    out.push({ type: "divider", key: "d3" });
    out.push({ key: "qc", label: "快捷命令", children: quick.groupOptions.value });
  }
  out.push({ type: "divider", key: "d4" });
  out.push({ key: "appearance", label: `终端外观 / 主题…  ${appShortcut(",")}` });
  out.push({ key: "reconnect", label: "重新连接", disabled: props.session.status === "connecting" });
  out.push({ key: "close", label: `关闭面板  ${appShortcut("w")}` });
  return out;
});

function onContextMenu(e: MouseEvent) {
  e.preventDefault();
  // 「右键粘贴」模式：右键 = 有选中就复制、否则粘贴；⇧+右键 才弹菜单
  if (settings.prefs.rightClickPaste && !e.shiftKey) {
    if (rt.term.hasSelection()) copySelection();
    else pasteClipboard();
    return;
  }
  ctx.value = { show: true, x: e.clientX, y: e.clientY };
}

function onCtxSelect(key: string) {
  ctx.value.show = false;
  switch (key) {
    case "copy":
      return copySelection();
    case "copy-raw":
      return copySelection(true);
    case "paste":
      return pasteClipboard();
    case "select-all":
      return rt.term.selectAll();
    case "clear":
      return rt.term.clear();
    case "find":
      return toggleSearch();
    case "split-row":
      return store.split("row");
    case "split-col":
      return store.split("col");
    case "detach":
      return store.detachSession(props.session.id);
    case "rename":
      return startRename();
    case "appearance":
      settings.show("themes");
      return;
    case "reconnect":
      return reconnect();
    case "close":
      return store.closeSession(props.session.id);
  }
  quick.onSelect(key);
}

const multiPane = computed(() => store.sessionsOf(props.session.tabId).length > 1);
/** 分屏时当前聚焦的那个面板：面板头加亮，方便分清 */
const paneFocused = computed(() => multiPane.value && store.activeTab?.activeSessionId === props.session.id);

// ---- 重命名面板 ----
const renaming = ref(false);
const renameText = ref("");
const renameInput = ref<InstanceType<typeof NInput> | null>(null);
function startRename() {
  renameText.value = props.session.title;
  renaming.value = true;
  nextTick(() => {
    renameInput.value?.focus();
    renameInput.value?.select();
  });
}
function commitRename() {
  if (!renaming.value) return;
  renaming.value = false;
  store.renameSession(props.session.id, renameText.value);
  rt.term.focus();
}
function cancelRename() {
  renaming.value = false;
  rt.term.focus();
}

// ---- 面板拖拽：按住面板头拖到别的面板上，中心 = 交换位置，四边 = 插到那一侧 ----
const dropZone = computed<DropZone | null>(() =>
  store.paneDrop?.sessionId === props.session.id ? store.paneDrop.zone : null,
);
const isDragSource = computed(() => store.paneDrag?.sessionId === props.session.id);
const DROP_LABEL: Record<DropZone, string> = {
  center: "交换位置",
  left: "放到左侧",
  right: "放到右侧",
  top: "放到上方",
  bottom: "放到下方",
};
let dragPending: { x: number; y: number } | null = null;

function onHeadPointerDown(e: PointerEvent) {
  // 只在面板头的空白 / 标题上起手；按钮、输入框、只有一个面板时不拖
  if (e.button !== 0 || !multiPane.value) return;
  if ((e.target as HTMLElement).closest("button, input, .pane-rename")) return;
  dragPending = { x: e.clientX, y: e.clientY };
  window.addEventListener("pointermove", onHeadPointerMove);
  window.addEventListener("pointerup", onHeadPointerUp, { once: true });
  window.addEventListener("pointercancel", onHeadPointerUp, { once: true });
}

function onHeadPointerMove(e: PointerEvent) {
  if (!dragPending) return;
  if (!store.paneDrag) {
    if (Math.hypot(e.clientX - dragPending.x, e.clientY - dragPending.y) < 6) return;
    store.paneDrag = { sessionId: props.session.id, title: props.session.title, x: e.clientX, y: e.clientY };
    document.body.style.cursor = "grabbing";
  } else {
    store.paneDrag = { ...store.paneDrag, x: e.clientX, y: e.clientY };
  }
  const el = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>(
    ".term-wrap[data-session-id]",
  );
  const id = el?.dataset.sessionId;
  if (!el || !id || id === props.session.id) {
    store.paneDrop = null;
    return;
  }
  const r = el.getBoundingClientRect();
  const rx = (e.clientX - r.left) / r.width;
  const ry = (e.clientY - r.top) / r.height;
  let zone: DropZone = "center";
  if (rx < 0.3 || rx > 0.7 || ry < 0.3 || ry > 0.7) {
    const dist: Record<DropSide, number> = { left: rx, right: 1 - rx, top: ry, bottom: 1 - ry };
    zone = (Object.keys(dist) as DropSide[]).reduce((a, b) => (dist[a] <= dist[b] ? a : b));
  }
  store.paneDrop = { sessionId: id, zone };
}

function onHeadPointerUp() {
  window.removeEventListener("pointermove", onHeadPointerMove);
  const drag = store.paneDrag;
  const drop = store.paneDrop;
  dragPending = null;
  store.paneDrag = null;
  store.paneDrop = null;
  document.body.style.cursor = "";
  if (!drag || !drop) return;
  if (drop.zone === "center") store.swapSessions(drag.sessionId, drop.sessionId);
  else store.moveSession(drag.sessionId, drop.sessionId, drop.zone);
  nextTick(() => getRuntime(drag.sessionId)?.term.focus());
}

const statusText = computed(() => {
  switch (props.session.status) {
    case "connecting":
      return "连接中";
    case "running":
      return props.session.subtitle || "已连接";
    case "exited":
      return "已结束";
    case "error":
      return "连接失败";
  }
});

// ---- 断线自动重连 ----
function cancelAutoReconnect() {
  if (rt.reconnectTimer) {
    clearTimeout(rt.reconnectTimer);
    rt.reconnectTimer = null;
    rt.term.write(`\r\n${GRAY}— 已取消自动重连 —${RESET}\r\n`);
  }
}

function scheduleAutoReconnect(code: number | null) {
  // 正常 exit（0）或用户主动结束不重连；连接被掐断（255 等）才重连
  if (!settings.prefs.autoReconnect || code === 0 || code === null) return;
  if (!rt.gotOutput) return; // 从未连上过，多半是配置问题，不要反复重试
  if (rt.reconnectAttempts >= 5) {
    rt.term.write(`\r\n${GRAY}— 已重试 5 次仍失败，停止自动重连 —${RESET}\r\n`);
    return;
  }
  rt.reconnectAttempts += 1;
  const delay = Math.min(3000 * rt.reconnectAttempts, 15000);
  rt.term.write(
    `\r\n${GRAY}— ${Math.round(delay / 1000)} 秒后自动重连（第 ${rt.reconnectAttempts}/5 次），按任意键取消 —${RESET}\r\n`,
  );
  rt.reconnectTimer = window.setTimeout(() => {
    rt.reconnectTimer = null;
    reconnect();
  }, delay);
}

// ---- 生命周期 ----
onMounted(() => {
  const existing = getRuntime(props.session.id);
  const fresh = !existing;
  rt =
    existing ??
    createRuntime(props.session.id, { ...settings.prefs, theme: settings.xtermTheme });
  attach(rt, container.value!);
  rt.ui.toggleSearch = toggleSearch;
  rt.ui.pastePaths = pastePaths;
  rt.ui.rename = startRename;
  container.value!.addEventListener("paste", onDomPaste, true);
  container.value!.addEventListener("copy", onDomCopy, true);

  if (fresh) {
    rt.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      // 用户可自定义的应用快捷键：放行给原生菜单
      if (shortcuts.matches(e)) return false;
      if (isTabModifier(e) && /^[0-9]$/.test(e.key)) return false;
      if (e.key === "Escape" && searchOpen.value) {
        toggleSearch();
        return false;
      }
      return true;
    });
    rt.term.onData((d) => {
      if (rt.reconnectTimer) {
        cancelAutoReconnect();
        return;
      }
      if (rt.backendId) api.writeTerminal(rt.backendId, d).catch(() => {});
      else if (d === "\r") {
        const s = store.sessions.find((x) => x.id === props.session.id);
        if (s && (s.status === "exited" || s.status === "error")) reconnect();
      }
    });
    rt.term.onResize(({ cols, rows }) => {
      if (rt.backendId) api.resizeTerminal(rt.backendId, cols, rows).catch(() => {});
    });
    rt.term.onTitleChange((t) => store.update(props.session.id, { subtitle: t }));
    rt.term.onSelectionChange(() => {
      if (settings.prefs.copyOnSelect && rt.term.hasSelection()) {
        writeText(selectionText()).catch(() => {});
      }
    });
    rt.term.onBell(() => {
      if (settings.prefs.bellSound) beep();
    });
  }

  resizeObserver = new ResizeObserver(() => scheduleFit());
  resizeObserver.observe(container.value!);

  nextTick(() => {
    if (fresh) connect();
    else scheduleFit();
    rt.term.focus();
  });
});

watch(
  () => props.active,
  (v) => v && nextTick(() => {
    scheduleFit();
    rt.term.focus();
  }),
);

watch(
  () => [settings.prefs, settings.xtermTheme] as const,
  ([ap, th]) => {
    if (!rt) return;
    rt.term.options.fontFamily = ap.fontFamily;
    rt.term.options.fontSize = ap.fontSize;
    rt.term.options.lineHeight = ap.lineHeight;
    rt.term.options.cursorBlink = ap.cursorBlink;
    rt.term.options.cursorStyle = ap.cursorStyle;
    rt.term.options.scrollback = ap.scrollback;
    rt.term.options.macOptionIsMeta = ap.optionAsMeta;
    rt.term.options.drawBoldTextInBrightColors = ap.brightBold;
    rt.term.options.theme = th;
    if (props.active) scheduleFit();
  },
  { deep: true },
);

watch(
  () => props.session.generation,
  (gen, old) => {
    if (gen > (old ?? 0)) {
      rt.term.write(`\r\n${GRAY}— 正在重新连接… —${RESET}\r\n`);
      connect();
      rt.term.focus();
    }
  },
);

onBeforeUnmount(() => {
  unmounted = true;
  stopConnectClock();
  cancelAnimationFrame(fitFrame);
  resizeObserver?.disconnect();
  container.value?.removeEventListener("paste", onDomPaste, true);
  container.value?.removeEventListener("copy", onDomCopy, true);
  // 会话仍在 store 里 → 只是面板被移动/重建，保留终端与连接；不在了 → store 已经 dispose 过
  if (getRuntime(props.session.id)) detach(rt);
});
</script>

<template>
  <div
    class="term-wrap"
    :class="{ 'drop-hover': store.dropHoverSessionId === session.id, 'drag-source': isDragSource }"
    :data-session-id="session.id"
    :style="{ background: settings.theme.background }"
    @contextmenu="onContextMenu"
  >
    <!-- 面板头：主机、状态、快捷命令、分屏、关闭；分屏时按住可拖动换位置 -->
    <div class="pane-head" :class="{ 'pane-focused': paneFocused, draggable: multiPane }" @pointerdown="onHeadPointerDown">
      <component :is="session.target.kind === 'local' ? TerminalSquare : Server" :size="13" class="muted" />
      <n-input
        v-if="renaming"
        ref="renameInput"
        v-model:value="renameText"
        size="tiny"
        class="pane-rename"
        placeholder="面板名称"
        @keydown.enter.prevent="commitRename"
        @keydown.esc.prevent="cancelRename"
        @blur="commitRename"
      />
      <span
        v-else
        class="pane-title"
        v-tip="multiPane ? '双击重命名 · 按住拖动可换位置 / 插到另一面板某一侧' : '双击重命名'"
        @dblclick="startRename"
      >{{ session.title }}</span>
      <span class="pane-status" :class="session.status">
        <span class="dot"></span>{{ statusText }}
      </span>
      <span class="spacer"></span>
      <n-dropdown
        v-if="host"
        trigger="click"
        placement="bottom-end"
        :options="quick.options.value"
        :render-label="quick.renderLabel"
        scrollable
        style="max-height: 480px; min-width: 300px"
        @select="quick.onSelect"
      >
        <button v-tip="'快捷命令'" class="pbtn"><Zap :size="13" /></button>
      </n-dropdown>
      <SplitMenu dir="row">
        <button v-tip="`向右分屏  ${appShortcut('d')}`" class="pbtn"><Columns2 :size="13" /></button>
      </SplitMenu>
      <SplitMenu dir="col">
        <button v-tip="`向下分屏  ${appShortcut('shift+d')}`" class="pbtn"><Rows2 :size="13" /></button>
      </SplitMenu>
      <n-tooltip v-if="multiPane">
        <template #trigger>
          <button class="pbtn" @click="store.detachSession(session.id)"><ExternalLink :size="13" /></button>
        </template>
        移到新标签
      </n-tooltip>
      <button v-tip="`关闭面板  ${appShortcut('w')}`" class="pbtn close" @click="store.closeSession(session.id)">
        <X :size="13" />
      </button>
    </div>

    <div ref="container" class="term-host"></div>

    <!-- 面板拖放落点提示 -->
    <div v-if="dropZone" class="drop-zone" :class="dropZone">
      <span class="drop-label">{{ DROP_LABEL[dropZone] }}</span>
    </div>
    <Teleport to="body">
      <div
        v-if="isDragSource && store.paneDrag"
        class="drag-ghost"
        :style="{ left: `${store.paneDrag.x + 14}px`, top: `${store.paneDrag.y + 10}px` }"
      >
        <component :is="session.target.kind === 'local' ? TerminalSquare : Server" :size="13" />
        {{ session.title }}
        <span class="drag-hint">{{ store.paneDrop ? DROP_LABEL[store.paneDrop.zone] : "拖到另一个面板上" }}</span>
      </div>
    </Teleport>

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

    <div v-if="searchOpen" class="search-bar">
      <n-input
        ref="searchInput"
        v-model:value="searchText"
        size="small"
        placeholder="在终端里查找…"
        clearable
        @keydown.enter.exact="findNext"
        @keydown.shift.enter="findPrev"
        @keydown.esc="toggleSearch"
        @update:value="(v: string) => v && rt.search.findNext(v, { incremental: true })"
      />
      <n-button size="small" quaternary circle @click="findPrev"><template #icon><ChevronUp :size="14" /></template></n-button>
      <n-button size="small" quaternary circle @click="findNext"><template #icon><ChevronDown :size="14" /></template></n-button>
      <n-button size="small" quaternary circle @click="toggleSearch"><template #icon><X :size="14" /></template></n-button>
    </div>

    <transition name="fade">
      <div v-if="session.status === 'connecting'" class="connecting">
        <div class="ring"><span></span><span></span><span></span></div>
        <div class="connecting-title">正在连接 {{ session.title }}…</div>
        <div class="muted connecting-sub">
          {{ session.target.kind === "ssh" ? "ssh " + session.target.alias : "本地终端" }}
          <template v-if="connectElapsed > 0"> · {{ connectElapsed }}s</template>
        </div>
        <div v-if="connectElapsed >= 8" class="muted connecting-sub">
          还没有响应：可能网络较慢、服务器不在线，或正在等待你输入密钥口令
        </div>
      </div>
    </transition>

    <div v-if="session.status === 'exited' || session.status === 'error'" class="exit-bar">
      <span>
        {{ session.status === "error" ? "连接失败" : "会话已结束" }}
        <template v-if="session.exitCode != null">（退出码 {{ session.exitCode }}）</template>
      </span>
      <n-button size="tiny" secondary type="primary" @click="reconnect">
        <template #icon><RotateCcw :size="12" /></template>
        重新连接
      </n-button>
      <n-button size="tiny" quaternary @click="store.closeSession(session.id)">关闭</n-button>
    </div>
  </div>
</template>

<style scoped>
.term-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

/* 文件拖到面板上：虚线强调框 */
.term-wrap.drop-hover::after {
  content: "";
  position: absolute;
  inset: 30px 2px 2px 2px;
  border: 2px dashed var(--accent);
  border-radius: 8px;
  pointer-events: none;
  z-index: 3;
}

.pane-head {
  flex: none;
  height: 28px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 6px 0 12px;
  background: var(--hover-1);
  border-bottom: 1px solid var(--hover-2);
  font-size: 12px;
  color: var(--text-2);
}

.pane-head.draggable {
  cursor: grab;
}

.term-wrap.drag-source {
  opacity: 0.55;
}

/* 拖放落点：中心 = 整块，四边 = 半块 */
.drop-zone {
  position: absolute;
  inset: 28px 0 0 0;
  z-index: 4;
  display: grid;
  place-items: center;
  background: rgba(91, 141, 239, 0.16);
  border: 2px solid var(--accent);
  pointer-events: none;
}

.drop-zone.left {
  right: 50%;
}

.drop-zone.right {
  left: 50%;
}

.drop-zone.top {
  bottom: 50%;
}

.drop-zone.bottom {
  top: 50%;
}

.drop-label {
  padding: 4px 10px;
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
}

/* 分屏时聚焦面板的头部加亮 */
.pane-head.pane-focused {
  background: var(--hover-2);
  color: var(--text-1);
}

.pane-head.pane-focused .pane-title {
  color: var(--accent-text);
}

.pane-title {
  font-weight: 600;
  white-space: nowrap;
  cursor: inherit;
}

.pane-rename {
  width: 160px;
}

.pane-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.pane-status .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-3);
  flex: none;
}

.pane-status.running .dot {
  background: var(--green);
}

.pane-status.connecting .dot {
  background: var(--orange);
  animation: pulse 1s ease-in-out infinite;
}

.pane-status.error .dot {
  background: var(--red);
}

.spacer {
  flex: 1;
}

.pbtn {
  display: inline-grid;
  place-items: center;
  width: 24px;
  height: 22px;
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

.pbtn.close:hover {
  background: rgba(229, 97, 91, 0.2);
  color: var(--red-text);
}

.term-host {
  flex: 1;
  min-height: 0;
  position: relative;
  /* 不成为滚动容器：跟随光标的隐藏输入框 / 输入法组合视图越界时，不会让 WebKit 为显示插入点滚动整个界面 */
  overflow: clip;
}

/* padding 放在 .xterm 上，FitAddon 会把它从可用尺寸里扣掉 */
.term-host :deep(.xterm) {
  height: 100%;
  padding: 6px 2px 6px 10px;
}

.term-host :deep(.xterm-viewport) {
  background-color: transparent !important;
}

.search-bar {
  position: absolute;
  top: 34px;
  right: 16px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  width: 340px;
  background: var(--panel-bg-2);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  z-index: 2;
}

.connecting {
  position: absolute;
  inset: 28px 0 0 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  pointer-events: none;
  background: radial-gradient(ellipse at center, rgba(91, 141, 239, 0.06), transparent 60%);
}

.ring {
  position: relative;
  width: 56px;
  height: 56px;
  margin-bottom: 10px;
}

.ring span {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 2px solid var(--accent);
  opacity: 0;
  animation: ripple 1.8s ease-out infinite;
}

.ring span:nth-child(2) {
  animation-delay: 0.6s;
}

.ring span:nth-child(3) {
  animation-delay: 1.2s;
}

@keyframes ripple {
  0% {
    transform: scale(0.35);
    opacity: 0.9;
  }
  100% {
    transform: scale(1.15);
    opacity: 0;
  }
}

@keyframes pulse {
  50% {
    opacity: 0.3;
  }
}

.connecting-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-1);
}

.connecting-sub {
  font-size: 12px;
  max-width: 420px;
  text-align: center;
  line-height: 1.6;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.25s;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.exit-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  font-size: 12px;
  color: var(--text-2);
  background: rgba(28, 28, 33, 0.92);
  border-top: 1px solid var(--border);
  backdrop-filter: blur(8px);
}
</style>
