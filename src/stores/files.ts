import { computed, ref } from "vue";
import { acceptHMRUpdate, defineStore } from "pinia";
import { listen } from "@tauri-apps/api/event";
import {
  api,
  errorText,
  type FolderPair,
  type FsEntry,
  type HostEntry,
  type SyncEvent,
  type SyncPlan,
  type TransferProgress,
} from "../api";
import { useHostsStore } from "./hosts";
import { useSettingsStore } from "./settings";

export type Side = "local" | "remote";

export interface PaneState {
  path: string;
  entries: FsEntry[];
  loading: boolean;
  error: string | null;
  selected: string[];
}

export interface HostFiles {
  local: PaneState;
  remote: PaneState;
  initialized: boolean;
}

export interface Transfer {
  id: string;
  hostId: string;
  kind: "upload" | "download" | "sync";
  label: string;
  progress: TransferProgress | null;
  startedAt: number;
  finished: boolean;
  error: string | null;
}

let seq = 0;
const emptyPane = (path = ""): PaneState => ({ path, entries: [], loading: false, error: null, selected: [] });

export function parentPath(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, "");
  // Windows 盘根：C:\ 的上一级还是 C:\
  if (/^[A-Za-z]:$/.test(trimmed)) return `${trimmed}\\`;
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (idx <= 0) return trimmed.includes("\\") || /^[A-Za-z]:/.test(trimmed) ? `${trimmed.slice(0, 2)}\\` : "/";
  const parent = trimmed.slice(0, idx);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

export function joinPath(base: string, name: string): string {
  if (base.endsWith("/") || base.endsWith("\\")) return `${base}${name}`;
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return `${base}${sep}${name}`;
}

export const useFilesStore = defineStore("files", () => {
  const hosts = useHostsStore();
  const settings = useSettingsStore();
  const byHost = ref<Record<string, HostFiles>>({});
  const transfers = ref<Transfer[]>([]);
  const syncLog = ref<SyncEvent[]>([]);
  const activeWatchers = ref<Set<string>>(new Set());
  let listening = false;

  function state(hostId: string): HostFiles {
    if (!byHost.value[hostId]) {
      byHost.value = { ...byHost.value, [hostId]: { local: emptyPane(), remote: emptyPane(), initialized: false } };
    }
    return byHost.value[hostId];
  }

  function patchPane(hostId: string, side: Side, patch: Partial<PaneState>) {
    const s = state(hostId);
    byHost.value = { ...byHost.value, [hostId]: { ...s, [side]: { ...s[side], ...patch } } };
  }

  async function ensureListening() {
    if (listening) return;
    listening = true;
    await listen<SyncEvent>("sync-event", (e) => {
      syncLog.value = [e.payload, ...syncLog.value].slice(0, 300);
    });
    try {
      activeWatchers.value = new Set(await api.watchActive());
    } catch {
      /* ignore */
    }
  }

  async function setCompression(host: HostEntry, on: boolean) {
    hosts.meta = await api.sftpSetCompression(host.id, host.alias, on);
  }

  /** 首次打开：本地到家目录，远端到登录用户家目录 */
  async function init(host: HostEntry) {
    ensureListening();
    const s = state(host.id);
    if (s.initialized) return;
    byHost.value = { ...byHost.value, [host.id]: { ...s, initialized: true } };
    // 把持久化的压缩开关同步给后端（后端按此决定 ssh -o Compression）
    if (hosts.metaOf(host.id).sftpCompression) await setCompression(host, true).catch(() => {});
    const home = settings.prefs.defaultLocalDir.trim() || (await api.localHome().catch(() => "/"));
    await load(host, "local", home);
    patchPane(host.id, "remote", { loading: true });
    try {
      const rhome = await api.sftpHome(host.alias);
      await load(host, "remote", rhome);
    } catch (e) {
      patchPane(host.id, "remote", { loading: false, error: errorText(e) });
    }
  }

  async function load(host: HostEntry, side: Side, path: string) {
    patchPane(host.id, side, { loading: true, error: null });
    try {
      const entries = side === "local" ? await api.localList(path) : await api.sftpList(host.alias, path);
      patchPane(host.id, side, { path, entries, loading: false, selected: [] });
    } catch (e) {
      patchPane(host.id, side, { loading: false, error: errorText(e) });
    }
  }

  async function refresh(host: HostEntry, side: Side) {
    await load(host, side, state(host.id)[side].path);
  }

  async function up(host: HostEntry, side: Side) {
    await load(host, side, parentPath(state(host.id)[side].path));
  }

  function select(hostId: string, side: Side, path: string, mode: "single" | "toggle" | "range") {
    const pane = state(hostId)[side];
    let next: string[];
    if (mode === "toggle") {
      next = pane.selected.includes(path) ? pane.selected.filter((p) => p !== path) : [...pane.selected, path];
    } else if (mode === "range" && pane.selected.length) {
      const paths = pane.entries.map((e) => e.path);
      const a = paths.indexOf(pane.selected[pane.selected.length - 1]);
      const b = paths.indexOf(path);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      next = [...new Set([...pane.selected, ...paths.slice(lo, hi + 1)])];
    } else {
      next = [path];
    }
    patchPane(hostId, side, { selected: next });
  }

  // ---- 传输 ----
  function addTransfer(hostId: string, kind: Transfer["kind"], label: string): Transfer {
    const t: Transfer = { id: `x${++seq}-${Date.now().toString(36)}`, hostId, kind, label, progress: null, startedAt: Date.now(), finished: false, error: null };
    transfers.value = [t, ...transfers.value].slice(0, 100);
    return t;
  }

  function patchTransfer(id: string, patch: Partial<Transfer>) {
    transfers.value = transfers.value.map((t) => (t.id === id ? { ...t, ...patch } : t));
  }

  function onProgress(id: string) {
    return (p: TransferProgress) => {
      patchTransfer(id, {
        progress: p,
        finished: p.phase === "done" || p.phase === "error" || p.phase === "cancelled",
        error: p.phase === "error" ? p.message : null,
      });
    };
  }

  async function upload(host: HostEntry, localPaths: string[], remoteDir: string) {
    for (const lp of localPaths) {
      const name = lp.split(/[/\\]/).filter(Boolean).pop() ?? lp;
      const t = addTransfer(host.id, "upload", `↑ ${name} → ${remoteDir}`);
      try {
        await api.sftpUpload(host.alias, lp, remoteDir, t.id, onProgress(t.id));
      } catch (e) {
        patchTransfer(t.id, { finished: true, error: errorText(e) });
      }
    }
    if (state(host.id).remote.path === remoteDir) await refresh(host, "remote");
  }

  async function download(host: HostEntry, remotePaths: string[], localDir: string) {
    for (const rp of remotePaths) {
      const name = rp.split("/").filter(Boolean).pop() ?? rp;
      const t = addTransfer(host.id, "download", `↓ ${name} → ${localDir}`);
      try {
        await api.sftpDownload(host.alias, rp, localDir, t.id, onProgress(t.id));
      } catch (e) {
        patchTransfer(t.id, { finished: true, error: errorText(e) });
      }
    }
    if (state(host.id).local.path === localDir) await refresh(host, "local");
  }

  function cancel(id: string) {
    api.sftpCancel(id).catch(() => {});
  }

  function clearFinished() {
    transfers.value = transfers.value.filter((t) => !t.finished);
  }

  const activeTransfers = computed(() => transfers.value.filter((t) => !t.finished).length);

  // ---- 增删改 ----
  async function mkdir(host: HostEntry, side: Side, name: string) {
    const path = joinPath(state(host.id)[side].path, name);
    if (side === "local") await api.localMkdir(path);
    else await api.sftpMkdir(host.alias, path);
    await refresh(host, side);
  }

  async function remove(host: HostEntry, side: Side, paths: string[]) {
    for (const p of paths) {
      if (side === "local") await api.localRemove(p);
      else await api.sftpRemove(host.alias, p);
    }
    await refresh(host, side);
  }

  async function rename(host: HostEntry, side: Side, from: string, newName: string) {
    const to = joinPath(parentPath(from), newName);
    if (side === "local") await api.localRename(from, to);
    else await api.sftpRename(host.alias, from, to);
    await refresh(host, side);
  }

  // ---- 联动组 ----
  function pairsOf(hostId: string): FolderPair[] {
    return hosts.metaOf(hostId).folderPairs;
  }

  async function savePairs(host: HostEntry, pairs: FolderPair[]) {
    hosts.meta = await api.saveFolderPairs(host.id, pairs);
  }

  async function planSync(host: HostEntry, pair: FolderPair, direction: "push" | "pull"): Promise<SyncPlan> {
    return api.sftpSyncPlan(host.alias, pair.local, pair.remote, direction);
  }

  async function applySync(host: HostEntry, pair: FolderPair, direction: "push" | "pull", rels: string[], orphans: string[]) {
    const t = addTransfer(host.id, "sync", `${direction === "push" ? "推送" : "拉取"} ${pair.name}（${rels.length} 个文件）`);
    try {
      await api.sftpSyncApply(host.alias, pair.local, pair.remote, direction, rels, orphans, t.id, onProgress(t.id));
    } catch (e) {
      patchTransfer(t.id, { finished: true, error: errorText(e) });
    }
    await Promise.all([refresh(host, "local"), refresh(host, "remote")]);
  }

  async function setAutoUpload(host: HostEntry, pair: FolderPair, on: boolean) {
    if (on) await api.watchStart(pair.id, host.alias, pair.local, pair.remote);
    else await api.watchStop(pair.id);
    const next = new Set(activeWatchers.value);
    if (on) next.add(pair.id);
    else next.delete(pair.id);
    activeWatchers.value = next;
    await savePairs(host, pairsOf(host.id).map((p) => (p.id === pair.id ? { ...p, autoUpload: on } : p)));
  }

  /** 程序启动后恢复勾选了自动上传的联动组（并同步压缩开关） */
  async function resumeWatchers() {
    await ensureListening();
    for (const h of hosts.hosts) {
      if (hosts.metaOf(h.id).sftpCompression) await setCompression(h, true).catch(() => {});
      for (const p of hosts.metaOf(h.id).folderPairs) {
        if (p.autoUpload && !activeWatchers.value.has(p.id)) {
          try {
            await api.watchStart(p.id, h.alias, p.local, p.remote);
            activeWatchers.value = new Set([...activeWatchers.value, p.id]);
          } catch {
            /* 目录不存在等，忽略 */
          }
        }
      }
    }
  }

  return {
    byHost,
    transfers,
    syncLog,
    activeWatchers,
    activeTransfers,
    state,
    init,
    load,
    refresh,
    up,
    select,
    upload,
    download,
    cancel,
    clearFinished,
    mkdir,
    remove,
    rename,
    pairsOf,
    savePairs,
    planSync,
    applySync,
    setAutoUpload,
    resumeWatchers,
    setCompression,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useFilesStore, import.meta.hot));
}
