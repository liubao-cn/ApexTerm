import { computed, ref, watch } from "vue";
import { acceptHMRUpdate, defineStore } from "pinia";
import { api, errorText, type HostEntry, type RunResult, type StoredSnippet } from "../api";
import {
  BUILTIN_SNIPPETS,
  resolveCommand,
  snippetAppliesTo,
  type Snippet,
} from "../snippets";
import { useHostsStore } from "./hosts";
import { useTerminalsStore, type TermSession } from "./terminals";

export interface RunRecord {
  id: string;
  hostId: string;
  alias: string;
  title: string;
  command: string;
  startedAt: number;
  status: "running" | "done" | "error";
  result: RunResult | null;
  error: string | null;
}

export type RebootPhase = "waitingDown" | "down" | "up" | "timeout";

export interface RebootWatch {
  hostId: string;
  alias: string;
  startedAt: number;
  phase: RebootPhase;
  downAt: number | null;
  upAt: number | null;
  checks: number;
}

/** 90 秒内都没掉线：要么重启极快，要么命令根本没执行成功，都停止等待 */
const WAIT_DOWN_LIMIT = 90_000;
/** 掉线后最多等 15 分钟 */
const WAIT_UP_LIMIT = 15 * 60_000;
const CHECK_INTERVAL = 5_000;

function toStored(s: Snippet): StoredSnippet {
  return {
    id: s.id,
    name: s.name,
    command: s.command,
    group: s.group,
    mode: s.mode,
    confirm: s.confirm,
    danger: s.danger,
    watchReboot: s.watchReboot,
    hostIds: s.hostIds,
  };
}

export const useCommandsStore = defineStore("commands", () => {
  const hosts = useHostsStore();
  const terminals = useTerminalsStore();

  // ---- 命令库 ----
  const customSnippets = computed<Snippet[]>(() =>
    hosts.meta.snippets.map((s) => ({
      ...s,
      mode: s.mode === "terminal" ? "terminal" : "silent",
      builtin: false,
    })),
  );
  const hiddenIds = computed(() => new Set(hosts.meta.hiddenSnippets));
  const visibleBuiltins = computed(() => BUILTIN_SNIPPETS.filter((s) => !hiddenIds.value.has(s.id)));
  const allSnippets = computed(() => [...visibleBuiltins.value, ...customSnippets.value]);

  function forHost(host: HostEntry): Snippet[] {
    return allSnippets.value.filter((s) => snippetAppliesTo(s, host));
  }

  async function saveSnippets(custom: Snippet[], hidden: string[]) {
    hosts.meta = await api.saveSnippets(custom.map(toStored), hidden);
  }

  // ---- 执行 ----
  const records = ref<RunRecord[]>([]);
  const resultsOpen = ref(false);
  const managerOpen = ref(false);
  const batchOpen = ref(false);
  const batchPreselect = ref<string[]>([]);
  let seq = 0;

  const runningCount = computed(() => records.value.filter((r) => r.status === "running").length);

  function updateRecord(id: string, patch: Partial<RunRecord>) {
    records.value = records.value.map((r) => (r.id === id ? { ...r, ...patch } : r));
  }

  async function runSilent(
    host: HostEntry,
    title: string,
    command: string,
    timeoutSecs = 60,
  ): Promise<RunRecord> {
    const rec: RunRecord = {
      id: `r${++seq}`,
      hostId: host.id,
      alias: host.alias,
      title,
      command,
      startedAt: Date.now(),
      status: "running",
      result: null,
      error: null,
    };
    records.value = [rec, ...records.value].slice(0, 200);
    try {
      const result = await api.runRemote(host.alias, command, timeoutSecs);
      updateRecord(rec.id, { status: "done", result });
    } catch (e) {
      updateRecord(rec.id, { status: "error", error: errorText(e) });
    }
    return records.value.find((r) => r.id === rec.id) ?? rec;
  }

  function runInTerminal(host: HostEntry, command: string, session?: TermSession | null) {
    if (session && session.backendId && session.status === "running") {
      api.writeTerminal(session.backendId, `${command}\r`).catch(() => {});
      terminals.focusSession(session.id);
    } else {
      terminals.open({ kind: "ssh", alias: host.alias, command }, host.alias, host.id);
      api.touchHostConnected(host.id).catch(() => {});
    }
  }

  // ---- 本机 ----
  const LOCAL_ID = "__local";

  async function runLocalSilent(title: string, command: string, cwd?: string | null, timeoutSecs = 60): Promise<RunRecord> {
    const rec: RunRecord = {
      id: `r${++seq}`,
      hostId: LOCAL_ID,
      alias: "本机",
      title,
      command,
      startedAt: Date.now(),
      status: "running",
      result: null,
      error: null,
    };
    records.value = [rec, ...records.value].slice(0, 200);
    try {
      const result = await api.runLocal(command, cwd, timeoutSecs);
      updateRecord(rec.id, { status: "done", result });
    } catch (e) {
      updateRecord(rec.id, { status: "error", error: errorText(e) });
    }
    return records.value.find((r) => r.id === rec.id) ?? rec;
  }

  /** 当前聚焦的面板如果是运行中的本地会话，就用它；否则找任意一个活着的本地会话 */
  function pickLocalSession(): TermSession | undefined {
    const isLive = (s: TermSession) => s.target.kind === "local" && s.status === "running";
    const active = terminals.activeSession;
    if (active && isLive(active)) return active;
    return terminals.sessions.find(isLive);
  }

  /** 在本地终端里执行：优先当前聚焦的本地会话，其次任意活着的本地会话，否则新开一个（可指定目录） */
  function runLocalInTerminal(command: string, cwd?: string | null, session?: TermSession | null) {
    const target = session ?? pickLocalSession();
    if (target?.backendId && target.status === "running" && (!cwd || target.target.kind === "local")) {
      const prefix = cwd ? `cd ${shellQuote(cwd)} && ` : "";
      api.writeTerminal(target.backendId, `${prefix}${command}\r`).catch(() => {});
      terminals.focusSession(target.id);
      return;
    }
    const title = cwd ? cwd.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || "本地终端" : "本地终端";
    const s = terminals.open({ kind: "local", cwd: cwd ?? null }, title, null);
    terminals.update(s.id, { initialInput: `${command}\r` });
  }

  function shellQuote(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`;
  }

  /** 执行本机快捷命令（确认对话框由调用方负责）；session 指定要输入到哪个终端 */
  function executeLocal(snippet: Snippet, cwd?: string | null, session?: TermSession | null) {
    if (snippet.mode === "terminal") {
      runLocalInTerminal(snippet.command, cwd, session);
    } else {
      resultsOpen.value = true;
      runLocalSilent(snippet.name, snippet.command, cwd);
    }
  }

  /** 执行一条快捷命令（确认对话框由调用方负责） */
  function execute(snippet: Snippet, host: HostEntry, session?: TermSession | null) {
    const command = resolveCommand(snippet.command, host);
    if (snippet.mode === "terminal") {
      runInTerminal(host, command, session);
    } else {
      resultsOpen.value = true;
      runSilent(host, snippet.name, command);
    }
    if (snippet.watchReboot) startRebootWatch(host);
  }

  function clearRecords() {
    records.value = records.value.filter((r) => r.status === "running");
  }

  function openBatch(hostIds: string[] = []) {
    batchPreselect.value = hostIds;
    batchOpen.value = true;
  }

  // ---- 重启恢复监视 ----
  const watches = ref<Record<string, RebootWatch>>({});
  const timers = new Map<string, number>();
  const now = ref(Date.now());
  let clock: number | null = null;

  const activeWatchCount = computed(
    () => Object.values(watches.value).filter((w) => w.phase === "waitingDown" || w.phase === "down").length,
  );

  watch(activeWatchCount, (n) => {
    if (n > 0 && clock === null) {
      clock = window.setInterval(() => (now.value = Date.now()), 1000);
    } else if (n === 0 && clock !== null) {
      clearInterval(clock);
      clock = null;
    }
  });

  function setWatch(hostId: string, patch: Partial<RebootWatch>) {
    const cur = watches.value[hostId];
    if (!cur) return;
    watches.value = { ...watches.value, [hostId]: { ...cur, ...patch } };
  }

  /**
   * 开始监视主机恢复上线。
   * alreadyDown=true 用于"云 API 开机 / 强制重启"这类已知机器此刻不在线的场景，直接进入等待恢复阶段。
   */
  function startRebootWatch(host: HostEntry, opts: { alreadyDown?: boolean } = {}) {
    stopTimer(host.id);
    const t0 = Date.now();
    watches.value = {
      ...watches.value,
      [host.id]: {
        hostId: host.id,
        alias: host.alias,
        startedAt: t0,
        phase: opts.alreadyDown ? "down" : "waitingDown",
        downAt: opts.alreadyDown ? t0 : null,
        upAt: null,
        checks: 0,
      },
    };
    const tick = async () => {
      const w = watches.value[host.id];
      if (!w || (w.phase !== "waitingDown" && w.phase !== "down")) return;
      const alive = await api.checkHostAlive(host.alias).catch(() => false);
      const cur = watches.value[host.id];
      if (!cur) return;
      const t = Date.now();
      let patch: Partial<RebootWatch> = { checks: cur.checks + 1 };
      if (cur.phase === "waitingDown") {
        if (!alive) patch = { ...patch, phase: "down", downAt: t };
        else if (t - cur.startedAt > WAIT_DOWN_LIMIT) patch = { ...patch, phase: "up", upAt: t };
      } else if (cur.phase === "down") {
        if (alive) patch = { ...patch, phase: "up", upAt: t };
        else if (t - cur.startedAt > WAIT_UP_LIMIT) patch = { ...patch, phase: "timeout" };
      }
      setWatch(host.id, patch);
      const next = watches.value[host.id];
      if (next && (next.phase === "waitingDown" || next.phase === "down")) {
        timers.set(host.id, window.setTimeout(tick, CHECK_INTERVAL));
      }
    };
    timers.set(host.id, window.setTimeout(tick, 3_000));
  }

  function stopTimer(hostId: string) {
    const t = timers.get(hostId);
    if (t) clearTimeout(t);
    timers.delete(hostId);
  }

  function dismissWatch(hostId: string) {
    stopTimer(hostId);
    const rest = { ...watches.value };
    delete rest[hostId];
    watches.value = rest;
  }

  function watchOf(hostId: string): RebootWatch | undefined {
    return watches.value[hostId];
  }

  /** 人类可读的耗时，如 47s / 1m32s */
  function fmtElapsed(from: number, to: number = now.value): string {
    const s = Math.max(0, Math.round((to - from) / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  }

  return {
    customSnippets,
    visibleBuiltins,
    allSnippets,
    hiddenIds,
    forHost,
    saveSnippets,
    records,
    runningCount,
    resultsOpen,
    LOCAL_ID,
    runLocalSilent,
    runLocalInTerminal,
    executeLocal,
    managerOpen,
    batchOpen,
    batchPreselect,
    runSilent,
    runInTerminal,
    execute,
    clearRecords,
    openBatch,
    watches,
    now,
    activeWatchCount,
    startRebootWatch,
    dismissWatch,
    watchOf,
    fmtElapsed,
  };
});

// 让 Vite 热更新时替换掉旧的 store 实例，避免组件拿到缺少新方法的旧对象而渲染报错
if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useCommandsStore, import.meta.hot));
}
