import { computed, ref } from "vue";
import { acceptHMRUpdate, defineStore } from "pinia";
import { api, type HostEntry, type TerminalTarget } from "../api";
import { disposeRuntime, getRuntime } from "../terminalRegistry";

export type TermStatus = "connecting" | "running" | "exited" | "error";

export interface TermSession {
  id: string;
  tabId: string;
  target: TerminalTarget;
  /** 面板标题（别名 / 本地终端） */
  title: string;
  /** 远端 shell 通过 OSC 设置的窗口标题 */
  subtitle: string;
  status: TermStatus;
  exitCode: number | null;
  error: string | null;
  /** 后端 pty 会话 id，连接建立后才有 */
  backendId: string | null;
  /** 关联的 config 主机 id（本地终端为 null） */
  hostId: string | null;
  /** 递增，用于触发同一面板内的重连 */
  generation: number;
  /** 连上（收到第一个字节）后原样写入终端的内容，用一次即清空；要执行请自带 \r */
  initialInput?: string | null;
}

/** 分屏布局树：叶子是一个终端面板，split 节点按 ratio 分给左/上 (a) 和右/下 (b) */
export type Layout =
  | { type: "leaf"; sessionId: string }
  | { type: "split"; id: string; dir: "row" | "col"; ratio: number; a: Layout; b: Layout };

export interface Tab {
  id: string;
  kind: "terminal" | "files";
  title: string;
  hostId: string | null;
  /** terminal 标签的分屏树 */
  layout: Layout | null;
  /** 当前聚焦的面板 */
  activeSessionId: string | null;
}

let seq = 0;
const nextId = (p: string) => `${p}${++seq}`;

function leaves(l: Layout | null): string[] {
  if (!l) return [];
  return l.type === "leaf" ? [l.sessionId] : [...leaves(l.a), ...leaves(l.b)];
}

function replaceLeaf(l: Layout, sessionId: string, by: Layout): Layout {
  if (l.type === "leaf") return l.sessionId === sessionId ? by : l;
  return { ...l, a: replaceLeaf(l.a, sessionId, by), b: replaceLeaf(l.b, sessionId, by) };
}

/** 删掉一个叶子，把它的兄弟提升上来；根就是该叶子时返回 null */
function removeLeaf(l: Layout, sessionId: string): Layout | null {
  if (l.type === "leaf") return l.sessionId === sessionId ? null : l;
  if (l.a.type === "leaf" && l.a.sessionId === sessionId) return l.b;
  if (l.b.type === "leaf" && l.b.sessionId === sessionId) return l.a;
  const a = removeLeaf(l.a, sessionId);
  const b = removeLeaf(l.b, sessionId);
  if (!a) return b;
  if (!b) return a;
  return { ...l, a, b };
}

function setRatioIn(l: Layout, splitId: string, ratio: number): Layout {
  if (l.type === "leaf") return l;
  if (l.id === splitId) return { ...l, ratio };
  return { ...l, a: setRatioIn(l.a, splitId, ratio), b: setRatioIn(l.b, splitId, ratio) };
}

/** 两个叶子互换位置 */
function swapLeaves(l: Layout, a: string, b: string): Layout {
  if (l.type === "leaf") {
    if (l.sessionId === a) return { type: "leaf", sessionId: b };
    if (l.sessionId === b) return { type: "leaf", sessionId: a };
    return l;
  }
  return { ...l, a: swapLeaves(l.a, a, b), b: swapLeaves(l.b, a, b) };
}

/** 面板拖放的落点：中心 = 交换位置，四边 = 插到目标那一侧 */
export type DropSide = "left" | "right" | "top" | "bottom";
export type DropZone = "center" | DropSide;

export const useTerminalsStore = defineStore("terminals", () => {
  const tabs = ref<Tab[]>([]);
  const sessions = ref<TermSession[]>([]);
  const activeId = ref<string | null>(null);
  /** 正在被文件拖动经过的面板（AppShell 设置，TerminalView 画高亮） */
  const dropHoverSessionId = ref<string | null>(null);
  /** 正在被拖动的面板（按住面板头拖动）与当前落点，TerminalView 据此画浮标和落点提示 */
  const paneDrag = ref<{ sessionId: string; title: string; x: number; y: number } | null>(null);
  const paneDrop = ref<{ sessionId: string; zone: DropZone } | null>(null);

  const activeTab = computed(() => tabs.value.find((t) => t.id === activeId.value) ?? null);
  const activeSession = computed(() => {
    const t = activeTab.value;
    if (!t?.activeSessionId) return null;
    return sessions.value.find((s) => s.id === t.activeSessionId) ?? null;
  });
  const runningCount = computed(
    () => sessions.value.filter((s) => s.status === "running" || s.status === "connecting").length,
  );

  function sessionsOf(tabId: string): TermSession[] {
    return sessions.value.filter((s) => s.tabId === tabId);
  }

  function makeSession(tabId: string, target: TerminalTarget, title: string, hostId: string | null): TermSession {
    return {
      id: nextId("s"),
      tabId,
      target,
      title,
      subtitle: "",
      status: "connecting",
      exitCode: null,
      error: null,
      backendId: null,
      hostId,
      generation: 0,
    };
  }

  function updateTab(id: string, patch: Partial<Tab>) {
    tabs.value = tabs.value.map((t) => (t.id === id ? { ...t, ...patch } : t));
  }

  // ---- 打开 ----
  function open(target: TerminalTarget, title: string, hostId: string | null): TermSession {
    const tabId = nextId("t");
    const s = makeSession(tabId, target, title, hostId);
    sessions.value = [...sessions.value, s];
    tabs.value = [
      ...tabs.value,
      { id: tabId, kind: "terminal", title, hostId, layout: { type: "leaf", sessionId: s.id }, activeSessionId: s.id },
    ];
    activeId.value = tabId;
    return s;
  }

  function openSsh(host: HostEntry): TermSession {
    const s = open({ kind: "ssh", alias: host.alias }, host.alias, host.id);
    api.touchHostConnected(host.id).catch(() => {});
    return s;
  }

  function openLocal(cwd?: string | null): TermSession {
    const title = cwd ? cwd.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || "本地终端" : "本地终端";
    return open({ kind: "local", cwd: cwd ?? null }, title, null);
  }

  /** 文件管理标签：同一主机只开一个，已有则切过去 */
  function openFiles(host: HostEntry): Tab {
    const existing = tabs.value.find((t) => t.kind === "files" && t.hostId === host.id);
    if (existing) {
      activeId.value = existing.id;
      return existing;
    }
    const tab: Tab = { id: nextId("t"), kind: "files", title: `${host.alias} · 文件`, hostId: host.id, layout: null, activeSessionId: null };
    tabs.value = [...tabs.value, tab];
    activeId.value = tab.id;
    return tab;
  }

  /** 在当前聚焦面板旁边分屏；不传 target 就复制当前面板的连接 */
  function split(dir: "row" | "col", target?: TerminalTarget, title?: string, hostId?: string | null): TermSession | null {
    const tab = activeTab.value;
    if (!tab || tab.kind !== "terminal" || !tab.layout) return null;
    const cur = activeSession.value ?? sessionsOf(tab.id)[0];
    if (!cur) return null;
    const s = makeSession(tab.id, target ?? cur.target, title ?? cur.title, hostId === undefined ? cur.hostId : hostId);
    sessions.value = [...sessions.value, s];
    const node: Layout = {
      type: "split",
      id: nextId("p"),
      dir,
      ratio: 0.5,
      a: { type: "leaf", sessionId: cur.id },
      b: { type: "leaf", sessionId: s.id },
    };
    updateTab(tab.id, { layout: replaceLeaf(tab.layout, cur.id, node), activeSessionId: s.id });
    if (s.hostId && s.target.kind === "ssh") api.touchHostConnected(s.hostId).catch(() => {});
    return s;
  }

  function setRatio(tabId: string, splitId: string, ratio: number) {
    const tab = tabs.value.find((t) => t.id === tabId);
    if (!tab?.layout) return;
    updateTab(tabId, { layout: setRatioIn(tab.layout, splitId, Math.min(0.85, Math.max(0.15, ratio))) });
  }

  /** 同一标签内两个面板互换位置（拖到目标中心） */
  function swapSessions(a: string, b: string) {
    const sa = sessions.value.find((x) => x.id === a);
    const sb = sessions.value.find((x) => x.id === b);
    if (!sa || !sb || a === b || sa.tabId !== sb.tabId) return;
    const tab = tabs.value.find((t) => t.id === sa.tabId);
    if (!tab?.layout) return;
    updateTab(tab.id, { layout: swapLeaves(tab.layout, a, b), activeSessionId: a });
  }

  /** 把面板挪到目标面板的某一侧（形成新的分屏），仅限同一标签 */
  function moveSession(sessionId: string, targetId: string, side: DropSide) {
    const s = sessions.value.find((x) => x.id === sessionId);
    const t = sessions.value.find((x) => x.id === targetId);
    if (!s || !t || sessionId === targetId || s.tabId !== t.tabId) return;
    const tab = tabs.value.find((x) => x.id === s.tabId);
    if (!tab?.layout) return;
    const without = removeLeaf(tab.layout, sessionId);
    if (!without) return;
    const moved: Layout = { type: "leaf", sessionId };
    const target: Layout = { type: "leaf", sessionId: targetId };
    const first = side === "left" || side === "top";
    const node: Layout = {
      type: "split",
      id: nextId("p"),
      dir: side === "left" || side === "right" ? "row" : "col",
      ratio: 0.5,
      a: first ? moved : target,
      b: first ? target : moved,
    };
    updateTab(tab.id, { layout: replaceLeaf(without, targetId, node), activeSessionId: sessionId });
  }

  /** 标签拖拽排序 */
  function reorderTab(id: string, targetId: string, place: "before" | "after") {
    if (id === targetId) return;
    const moving = tabs.value.find((t) => t.id === id);
    const rest = tabs.value.filter((t) => t.id !== id);
    const idx = rest.findIndex((t) => t.id === targetId);
    if (!moving || idx < 0) return;
    rest.splice(idx + (place === "after" ? 1 : 0), 0, moving);
    tabs.value = rest;
  }

  function focusSession(sessionId: string) {
    const s = sessions.value.find((x) => x.id === sessionId);
    if (!s) return;
    updateTab(s.tabId, { activeSessionId: sessionId });
    activeId.value = s.tabId;
  }

  function update(id: string, patch: Partial<TermSession>) {
    sessions.value = sessions.value.map((s) => (s.id === id ? { ...s, ...patch } : s));
  }

  /** 重命名面板；标签里只有这一个面板时标签名一起改 */
  function renameSession(id: string, title: string) {
    const t = title.trim();
    const s = sessions.value.find((x) => x.id === id);
    if (!t || !s) return;
    update(id, { title: t });
    if (sessionsOf(s.tabId).length === 1) updateTab(s.tabId, { title: t });
  }

  function renameTab(id: string, title: string) {
    const t = title.trim();
    if (t) updateTab(id, { title: t });
  }

  function activate(id: string | null) {
    activeId.value = id;
  }

  function showDetails() {
    activeId.value = null;
  }

  /** 把面板拆出去变成独立标签（终端与 SSH 连接原样保留） */
  function detachSession(sessionId: string) {
    const s = sessions.value.find((x) => x.id === sessionId);
    if (!s) return;
    const tab = tabs.value.find((t) => t.id === s.tabId);
    if (!tab?.layout) return;
    const remaining = removeLeaf(tab.layout, sessionId);
    if (!remaining) return; // 已经是独立标签
    const newTabId = nextId("t");
    sessions.value = sessions.value.map((x) => (x.id === sessionId ? { ...x, tabId: newTabId } : x));
    updateTab(tab.id, {
      layout: remaining,
      activeSessionId: tab.activeSessionId === sessionId ? leaves(remaining)[0] : tab.activeSessionId,
    });
    tabs.value = [
      ...tabs.value,
      { id: newTabId, kind: "terminal", title: s.title, hostId: s.hostId, layout: { type: "leaf", sessionId }, activeSessionId: sessionId },
    ];
    activeId.value = newTabId;
  }

  // ---- 关闭 ----
  function killSession(s: TermSession) {
    if (getRuntime(s.id)) {
      disposeRuntime(s.id);
    } else if (s.backendId && (s.status === "running" || s.status === "connecting")) {
      api.closeTerminal(s.backendId).catch(() => {});
    }
  }

  function closeTab(tabId: string) {
    const idx = tabs.value.findIndex((t) => t.id === tabId);
    if (idx < 0) return;
    for (const s of sessionsOf(tabId)) killSession(s);
    sessions.value = sessions.value.filter((s) => s.tabId !== tabId);
    const rest = tabs.value.filter((t) => t.id !== tabId);
    tabs.value = rest;
    if (activeId.value === tabId) {
      const neighbour = rest[Math.min(idx, rest.length - 1)];
      activeId.value = neighbour ? neighbour.id : null;
    }
  }

  /** 关闭一个面板；标签里最后一个面板关闭时整个标签关闭 */
  function closeSession(sessionId: string) {
    const s = sessions.value.find((x) => x.id === sessionId);
    if (!s) return;
    const tab = tabs.value.find((t) => t.id === s.tabId);
    if (!tab || !tab.layout) return;
    const remaining = removeLeaf(tab.layout, sessionId);
    if (!remaining) {
      closeTab(tab.id);
      return;
    }
    killSession(s);
    sessions.value = sessions.value.filter((x) => x.id !== sessionId);
    const nextActive = tab.activeSessionId === sessionId ? leaves(remaining)[0] : tab.activeSessionId;
    updateTab(tab.id, { layout: remaining, activeSessionId: nextActive });
  }

  /** ⌘W：关闭当前聚焦面板（终端标签）或整个标签（文件标签） */
  function closeActive() {
    const tab = activeTab.value;
    if (!tab) return;
    if (tab.kind === "terminal" && tab.activeSessionId) closeSession(tab.activeSessionId);
    else closeTab(tab.id);
  }

  /** 兼容旧调用：按标签关闭 */
  function close(tabId: string) {
    closeTab(tabId);
  }

  function reconnect(id: string) {
    const s = sessions.value.find((x) => x.id === id);
    if (!s) return;
    update(id, { status: "connecting", exitCode: null, error: null, backendId: null, generation: s.generation + 1 });
  }

  function cycle(delta: number) {
    const list = tabs.value;
    if (list.length === 0) return;
    const cur = list.findIndex((t) => t.id === activeId.value);
    const positions = list.length + 1;
    const next = (((cur + 1 + delta) % positions) + positions) % positions;
    activeId.value = next === 0 ? null : list[next - 1].id;
  }

  function activateIndex(n: number) {
    const t = tabs.value[n];
    if (t) activeId.value = t.id;
  }

  return {
    tabs,
    sessions,
    activeId,
    dropHoverSessionId,
    paneDrag,
    paneDrop,
    activeTab,
    activeSession,
    runningCount,
    sessionsOf,
    open,
    openSsh,
    openLocal,
    openFiles,
    split,
    detachSession,
    setRatio,
    swapSessions,
    moveSession,
    reorderTab,
    focusSession,
    update,
    renameSession,
    renameTab,
    activate,
    showDetails,
    close,
    closeTab,
    closeSession,
    closeActive,
    reconnect,
    cycle,
    activateIndex,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useTerminalsStore, import.meta.hot));
}
