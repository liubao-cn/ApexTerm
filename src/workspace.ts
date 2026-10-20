/**
 * 工作区存档：标签、分屏布局、面板配色、标题、本地终端所在目录，重新打开程序时原样恢复。
 * 只存"能重新建出来"的东西：进程、屏幕内容、要自动执行的命令（SSH 附带命令、自动输入）一律不存，
 * 恢复时不会重放任何命令。这里全是纯函数；读写存储、什么时候存由调用方负责。
 */
import type { TerminalTarget } from "./api";
import type { Layout, Tab, TermSession } from "./stores/terminals";

export const WORKSPACE_KEY = "apexterm.workspace";

export type SavedTarget = { kind: "ssh"; alias: string } | { kind: "local"; cwd: string | null };

export interface SavedSession {
  target: SavedTarget;
  title: string;
  hostId: string | null;
  /** 「此面板配色」 */
  themeId?: string;
  /** 程序最后设置的窗口标题（如 Devin CLI 的 `devin: 对话标题`），恢复后提示"上次这里是什么" */
  lastTitle?: string;
}

/** 分屏树；叶子用面板在 SavedTab.sessions 里的下标 */
export type SavedLayout =
  | { type: "leaf"; session: number }
  | { type: "split"; dir: "row" | "col"; ratio: number; a: SavedLayout; b: SavedLayout };

export interface SavedTab {
  kind: "terminal" | "files";
  title: string;
  hostId: string | null;
  /** 聚焦面板在 sessions 里的下标 */
  active: number;
  sessions: SavedSession[];
  layout: SavedLayout | null;
}

export interface WorkspaceSnapshot {
  v: 1;
  tabs: SavedTab[];
  /** 当前标签在 tabs 里的下标；停在首页时为 null */
  active: number | null;
}

const TITLE_MAX = 120;
const RATIO_MIN = 0.15;
const RATIO_MAX = 0.85;
const LAYOUT_MAX_DEPTH = 32;

/** 程序设置的标题：去掉控制字符（不让它把转义序列带进终端或界面），按字符截断 */
export function cleanTitle(t: string): string {
  return Array.from(t.replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim())
    .slice(0, TITLE_MAX)
    .join("");
}

function leafIds(l: Layout): string[] {
  return l.type === "leaf" ? [l.sessionId] : [...leafIds(l.a), ...leafIds(l.b)];
}

function saveLayout(l: Layout, index: Map<string, number>): SavedLayout | null {
  if (l.type === "leaf") {
    const i = index.get(l.sessionId);
    return i === undefined ? null : { type: "leaf", session: i };
  }
  const a = saveLayout(l.a, index);
  const b = saveLayout(l.b, index);
  if (!a || !b) return a ?? b;
  return { type: "split", dir: l.dir, ratio: l.ratio, a, b };
}

function saveSession(s: TermSession): SavedSession {
  const target: SavedTarget =
    s.target.kind === "ssh" ? { kind: "ssh", alias: s.target.alias } : { kind: "local", cwd: s.cwd ?? s.target.cwd ?? null };
  const out: SavedSession = { target, title: s.title, hostId: s.hostId };
  if (s.themeId) out.themeId = s.themeId;
  const lastTitle = cleanTitle(s.subtitle || s.lastTitle || "");
  if (lastTitle) out.lastTitle = lastTitle;
  return out;
}

/** 当前工作区 → 存档 */
export function snapshotWorkspace(tabs: Tab[], sessions: TermSession[], activeId: string | null): WorkspaceSnapshot {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const out: SavedTab[] = [];
  let active: number | null = null;
  for (const t of tabs) {
    let saved: SavedTab | null = null;
    if (t.kind === "files") {
      if (t.hostId) saved = { kind: "files", title: t.title, hostId: t.hostId, active: 0, sessions: [], layout: null };
    } else if (t.layout) {
      const ids = leafIds(t.layout).filter((id) => byId.has(id));
      const layout = saveLayout(t.layout, new Map(ids.map((id, i) => [id, i])));
      if (ids.length && layout) {
        saved = {
          kind: "terminal",
          title: t.title,
          hostId: t.hostId,
          active: Math.max(0, ids.indexOf(t.activeSessionId ?? "")),
          sessions: ids.map((id) => saveSession(byId.get(id)!)),
          layout,
        };
      }
    }
    if (!saved) continue;
    if (t.id === activeId) active = out.length;
    out.push(saved);
  }
  return { v: 1, tabs: out, active };
}

// ---- 读存档：逐项校验，坏的标签丢掉、其余照常恢复 ----

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === "string";
const isHostId = (x: unknown): x is string | null => x === null || isStr(x);

function parseSession(x: unknown): SavedSession | null {
  if (!isObj(x) || !isStr(x.title) || !isHostId(x.hostId) || !isObj(x.target)) return null;
  const t = x.target;
  let target: SavedTarget;
  if (t.kind === "ssh" && isStr(t.alias) && t.alias.trim()) target = { kind: "ssh", alias: t.alias.trim() };
  else if (t.kind === "local" && (t.cwd == null || isStr(t.cwd))) target = { kind: "local", cwd: t.cwd || null };
  else return null;
  const out: SavedSession = { target, title: x.title, hostId: x.hostId };
  if (isStr(x.themeId) && x.themeId) out.themeId = x.themeId;
  const lastTitle = isStr(x.lastTitle) ? cleanTitle(x.lastTitle) : "";
  if (lastTitle) out.lastTitle = lastTitle;
  return out;
}

/** 每个面板下标必须恰好出现一次 */
function parseLayout(x: unknown, n: number, used: Set<number>, depth: number): SavedLayout | null {
  if (!isObj(x) || depth > LAYOUT_MAX_DEPTH) return null;
  if (x.type === "leaf") {
    const i = x.session;
    if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= n || used.has(i)) return null;
    used.add(i);
    return { type: "leaf", session: i };
  }
  if (x.type !== "split" || (x.dir !== "row" && x.dir !== "col")) return null;
  if (typeof x.ratio !== "number" || !Number.isFinite(x.ratio)) return null;
  const a = parseLayout(x.a, n, used, depth + 1);
  const b = a && parseLayout(x.b, n, used, depth + 1);
  if (!a || !b) return null;
  return { type: "split", dir: x.dir, ratio: Math.min(RATIO_MAX, Math.max(RATIO_MIN, x.ratio)), a, b };
}

function parseTab(x: unknown): SavedTab | null {
  if (!isObj(x) || !isStr(x.title) || !isHostId(x.hostId)) return null;
  if (x.kind === "files") {
    return x.hostId ? { kind: "files", title: x.title, hostId: x.hostId, active: 0, sessions: [], layout: null } : null;
  }
  if (x.kind !== "terminal" || !Array.isArray(x.sessions) || x.sessions.length === 0) return null;
  const sessions: SavedSession[] = [];
  for (const raw of x.sessions) {
    const s = parseSession(raw);
    if (!s) return null;
    sessions.push(s);
  }
  const used = new Set<number>();
  const layout = parseLayout(x.layout, sessions.length, used, 0);
  if (!layout || used.size !== sessions.length) return null;
  const a = x.active;
  const active = typeof a === "number" && Number.isInteger(a) && a >= 0 && a < sessions.length ? a : 0;
  return { kind: "terminal", title: x.title, hostId: x.hostId, active, sessions, layout };
}

/** 存档文本 → 快照；没有 / 损坏 / 版本不认识时返回 null */
export function parseSnapshot(raw: string | null): WorkspaceSnapshot | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(data) || data.v !== 1 || !Array.isArray(data.tabs)) return null;
  const savedActive = data.active;
  const tabs: SavedTab[] = [];
  let active: number | null = null;
  data.tabs.forEach((raw: unknown, i: number) => {
    const t = parseTab(raw);
    if (!t) return;
    if (savedActive === i) active = tabs.length;
    tabs.push(t);
  });
  return { v: 1, tabs, active };
}

// ---- 恢复 ----

export interface BuildDeps {
  newId: (prefix: "t" | "p") => string;
  /** 建一个新面板（和新开终端走同一个工厂，保证字段齐全） */
  makeSession: (tabId: string, target: TerminalTarget, title: string, hostId: string | null) => TermSession;
  /** 存档里的主机 id / 别名 → 现在 config 里对应的主机 id；主机已不存在返回 null */
  resolveHostId: (hostId: string | null, alias: string | null) => string | null;
  /** 是否直接激活上次停留的标签（已有标签开着时为 false，恢复的标签全部延迟） */
  wakeActive: boolean;
}

function buildLayout(l: SavedLayout, ids: string[], newId: BuildDeps["newId"]): Layout {
  if (l.type === "leaf") return { type: "leaf", sessionId: ids[l.session] };
  return { type: "split", id: newId("p"), dir: l.dir, ratio: l.ratio, a: buildLayout(l.a, ids, newId), b: buildLayout(l.b, ids, newId) };
}

/**
 * 快照 → 新的标签与面板（id 全部新生成）。上次停留的标签直接连接，其余标签标记为延迟：
 * 第一次切过去时才挂载、连接，避免一启动同时发起一串 SSH 登录，也避免后台标签按错误尺寸起 shell。
 * 主机已删掉的 SSH 面板照常恢复（连接时会报错，可关）；主机已删掉的文件标签直接丢弃。
 */
export function buildWorkspace(snap: WorkspaceSnapshot, deps: BuildDeps): { tabs: Tab[]; sessions: TermSession[]; activeId: string | null } {
  const tabs: Tab[] = [];
  const sessions: TermSession[] = [];
  let activeId: string | null = null;
  snap.tabs.forEach((st, i) => {
    const wake = deps.wakeActive && i === snap.active;
    const tabId = deps.newId("t");
    if (st.kind === "files") {
      const hostId = deps.resolveHostId(st.hostId, null);
      if (!hostId) return;
      tabs.push({ id: tabId, kind: "files", title: st.title, hostId, layout: null, activeSessionId: null, deferred: !wake });
    } else {
      if (!st.layout || !st.sessions.length) return;
      const ids: string[] = [];
      for (const ss of st.sessions) {
        const alias = ss.target.kind === "ssh" ? ss.target.alias : null;
        const target: TerminalTarget =
          ss.target.kind === "ssh" ? { kind: "ssh", alias: ss.target.alias } : { kind: "local", cwd: ss.target.cwd };
        const s = deps.makeSession(tabId, target, ss.title, alias ? deps.resolveHostId(ss.hostId, alias) : null);
        sessions.push({
          ...s,
          status: wake ? "connecting" : "idle",
          themeId: ss.themeId ?? null,
          ...(ss.target.kind === "local" && ss.target.cwd ? { cwd: ss.target.cwd } : {}),
          ...(ss.lastTitle ? { lastTitle: ss.lastTitle } : {}),
          restored: true,
        });
        ids.push(s.id);
      }
      const firstSsh = st.sessions.find((s) => s.target.kind === "ssh")?.target;
      const firstAlias = firstSsh?.kind === "ssh" ? firstSsh.alias : null;
      tabs.push({
        id: tabId,
        kind: "terminal",
        title: st.title,
        hostId: st.hostId ? deps.resolveHostId(st.hostId, firstAlias) : null,
        layout: buildLayout(st.layout, ids, deps.newId),
        activeSessionId: ids[st.active] ?? ids[0],
        deferred: !wake,
      });
    }
    if (wake) activeId = tabId;
  });
  return { tabs, sessions, activeId };
}
