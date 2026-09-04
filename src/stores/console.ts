import { computed, ref } from "vue";
import { acceptHMRUpdate, defineStore } from "pinia";
import { api, errorText, type LocalDir, type LocalSummary, type StoredSnippet } from "../api";
import { BUILTIN_LOCAL_SNIPPETS } from "../localSnippets";
import type { Snippet } from "../snippets";
import { useHostsStore } from "./hosts";

/** 本机控制台：系统概况、常用目录、本地快捷命令、最近命令 */
export const useConsoleStore = defineStore("console", () => {
  const hosts = useHostsStore();

  const summary = ref<LocalSummary | null>(null);
  const summaryError = ref<string | null>(null);
  const loadingSummary = ref(false);
  const recents = ref<string[]>([]);
  /** 快捷命令执行的工作目录（为空 = 家目录） */
  const cwd = ref<string | null>(null);

  async function refreshSummary() {
    loadingSummary.value = true;
    try {
      summary.value = await api.localSummary();
      summaryError.value = null;
    } catch (e) {
      summaryError.value = errorText(e);
    } finally {
      loadingSummary.value = false;
    }
  }

  async function refreshRecents() {
    recents.value = await api.localRecentCommands(40).catch(() => []);
  }

  async function init() {
    await Promise.all([summary.value ? Promise.resolve() : refreshSummary(), refreshRecents()]);
  }

  // ---- 本地快捷命令：内置（按平台）+ 自定义 − 隐藏 ----
  const snippets = computed<Snippet[]>(() => {
    const hidden = new Set(hosts.meta.hiddenLocalSnippets);
    const custom: Snippet[] = hosts.meta.localSnippets.map((s: StoredSnippet) => ({
      ...s,
      mode: s.mode === "terminal" ? "terminal" : "silent",
      builtin: false,
    }));
    return [...BUILTIN_LOCAL_SNIPPETS.filter((s) => !hidden.has(s.id)), ...custom];
  });

  const groups = computed(() => {
    const out = new Map<string, Snippet[]>();
    for (const s of snippets.value) {
      if (!out.has(s.group)) out.set(s.group, []);
      out.get(s.group)!.push(s);
    }
    return [...out.entries()];
  });

  function toStored(s: Snippet): StoredSnippet {
    return {
      id: s.id,
      name: s.name,
      command: s.command,
      group: s.group,
      mode: s.mode,
      confirm: s.confirm,
      danger: s.danger,
      watchReboot: false,
      hostIds: [],
    };
  }

  async function saveSnippet(s: Snippet) {
    const list = hosts.meta.localSnippets.filter((x) => x.id !== s.id);
    hosts.meta = await api.saveLocalSnippets([...list, toStored(s)], hosts.meta.hiddenLocalSnippets);
  }

  async function removeSnippet(s: Snippet) {
    if (s.builtin) {
      hosts.meta = await api.saveLocalSnippets(hosts.meta.localSnippets, [...hosts.meta.hiddenLocalSnippets, s.id]);
    } else {
      hosts.meta = await api.saveLocalSnippets(
        hosts.meta.localSnippets.filter((x) => x.id !== s.id),
        hosts.meta.hiddenLocalSnippets,
      );
    }
  }

  async function restoreBuiltins() {
    hosts.meta = await api.saveLocalSnippets(hosts.meta.localSnippets, []);
  }

  // ---- 常用目录 ----
  const dirs = computed<LocalDir[]>(() => hosts.meta.localDirs);

  async function addDir(path: string, name?: string) {
    const trimmed = path.replace(/[/\\]+$/, "");
    if (dirs.value.some((d) => d.path === trimmed)) return;
    const dir: LocalDir = {
      id: `d${Date.now().toString(36)}`,
      name: name?.trim() || trimmed.split(/[/\\]/).pop() || trimmed,
      path: trimmed,
    };
    hosts.meta = await api.saveLocalDirs([...dirs.value, dir]);
  }

  async function removeDir(id: string) {
    hosts.meta = await api.saveLocalDirs(dirs.value.filter((d) => d.id !== id));
  }

  return {
    summary,
    summaryError,
    loadingSummary,
    recents,
    cwd,
    refreshSummary,
    refreshRecents,
    init,
    snippets,
    groups,
    saveSnippet,
    removeSnippet,
    restoreBuiltins,
    dirs,
    addDir,
    removeDir,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useConsoleStore, import.meta.hot));
}
