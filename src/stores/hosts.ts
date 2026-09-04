import { computed, ref } from "vue";
import { acceptHMRUpdate, defineStore } from "pinia";
import {
  api,
  emptyHostMeta,
  emptyMeta,
  errorText,
  hostTarget,
  maskFingerprint,
  maskHost,
  maskPath,
  maskText,
  type Candidate,
  type HostEntry,
  type HostInput,
  type HostMeta,
  type KeyInfo,
  type Meta,
  type ProbeResult,
} from "../api";

export interface Alive {
  status: "idle" | "checking" | "online" | "offline";
  message: string;
  checkedAt: number;
  durationMs: number;
}

const PRIVACY_KEY = "apexterm.privacy";

export type View = "hosts" | "candidates" | "console";

export interface ProbeState {
  status: "idle" | "running" | "ok" | "fail";
  result: ProbeResult | null;
  user: string;
}

export type Filter =
  | { type: "all" }
  | { type: "favorites" }
  | { type: "git" }
  | { type: "pattern" }
  | { type: "ungrouped" }
  | { type: "group"; name: string };

export const UNGROUPED = "未分组";

export const useHostsStore = defineStore("hosts", () => {
  const hosts = ref<HostEntry[]>([]);
  const files = ref<string[]>([]);
  const configPath = ref("");
  const metaPath = ref("");
  const meta = ref<Meta>(emptyMeta());
  const keys = ref<KeyInfo[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const selectedId = ref<string | null>(null);
  const query = ref("");
  const filter = ref<Filter>({ type: "all" });
  const view = ref<View>("hosts");
  const candidates = ref<Candidate[]>([]);
  const probes = ref<Record<string, ProbeState>>({});

  const byId = computed(() => new Map(hosts.value.map((h) => [h.id, h])));
  const selected = computed(() =>
    selectedId.value ? byId.value.get(selectedId.value) ?? null : null,
  );

  // ---- 隐私模式（截图时把地址打码，只影响显示） ----
  const privacy = ref(localStorage.getItem(PRIVACY_KEY) === "1");
  function togglePrivacy() {
    privacy.value = !privacy.value;
    localStorage.setItem(PRIVACY_KEY, privacy.value ? "1" : "0");
  }
  /** 单个地址 / IP */
  function mask(s: string | null | undefined): string {
    if (!s) return "";
    return privacy.value ? maskHost(s) : s;
  }
  /** user@host:port */
  function displayTarget(h: HostEntry): string {
    return hostTarget(h, privacy.value);
  }
  /** config 原文等多行文本 */
  function maskBlock(text: string, h?: HostEntry): string {
    return privacy.value ? maskText(text, h?.hostName ? [h.hostName] : []) : text;
  }
  /** 密钥文件路径 */
  function maskKeyPath(p: string): string {
    return privacy.value ? maskPath(p) : p;
  }
  /** 密钥指纹 */
  function maskFp(fp: string): string {
    return privacy.value ? maskFingerprint(fp) : fp;
  }

  // ---- 手动排序 ----
  const orderIndex = computed(() => new Map(meta.value.order.map((id, i) => [id, i])));
  const configIndex = computed(() => new Map(hosts.value.map((h, i) => [h.id, i])));
  function sortByOrder(list: HostEntry[]): HostEntry[] {
    return [...list].sort((a, b) => {
      const ia = orderIndex.value.get(a.id) ?? Number.POSITIVE_INFINITY;
      const ib = orderIndex.value.get(b.id) ?? Number.POSITIVE_INFINITY;
      if (ia !== ib) return ia - ib;
      return (configIndex.value.get(a.id) ?? 0) - (configIndex.value.get(b.id) ?? 0);
    });
  }

  /** 把 fromId 放到 toId 的前/后；「全部」视图下跨分组拖动会同时改分组 */
  async function reorder(fromId: string, toId: string, place: "before" | "after") {
    if (fromId === toId) return;
    const seq = sortByOrder(hosts.value).map((h) => h.id).filter((id) => id !== fromId);
    const idx = seq.indexOf(toId);
    if (idx < 0) return;
    seq.splice(place === "before" ? idx : idx + 1, 0, fromId);
    meta.value = { ...meta.value, order: seq };
    meta.value = await api.saveOrder(seq);
    if (filter.value.type === "all") {
      const targetGroup = metaOf(toId).group;
      if (metaOf(fromId).group !== targetGroup) await saveMeta(fromId, { group: targetGroup });
    }
  }

  // ---- 在线 / 免密探测 ----
  const alive = ref<Record<string, Alive>>({});
  const probingAll = ref(false);
  function aliveOf(id: string): Alive {
    return alive.value[id] ?? { status: "idle", message: "", checkedAt: 0, durationMs: 0 };
  }
  function setAlive(id: string, patch: Partial<Alive>) {
    alive.value = { ...alive.value, [id]: { ...aliveOf(id), ...patch } };
  }
  async function probeHost(h: HostEntry) {
    setAlive(h.id, { status: "checking" });
    try {
      const r = await api.probeHost(h.alias);
      setAlive(h.id, {
        status: r.ok ? "online" : "offline",
        message: r.message,
        checkedAt: Date.now(),
        durationMs: r.durationMs,
      });
    } catch (e) {
      setAlive(h.id, { status: "offline", message: errorText(e), checkedAt: Date.now(), durationMs: 0 });
    }
  }
  /** 并发 6 路探测全部服务器 */
  async function probeAllServers() {
    if (probingAll.value) return;
    probingAll.value = true;
    const list = [...servers.value];
    let i = 0;
    const worker = async () => {
      while (i < list.length) await probeHost(list[i++]);
    };
    try {
      await Promise.all(Array.from({ length: Math.min(6, list.length) }, worker));
    } finally {
      probingAll.value = false;
    }
  }
  const aliveSummary = computed(() => {
    let online = 0;
    let offline = 0;
    for (const h of servers.value) {
      const s = aliveOf(h.id).status;
      if (s === "online") online++;
      else if (s === "offline") offline++;
    }
    return { online, offline };
  });

  const activeCandidates = computed(() => candidates.value.filter((c) => !c.ignored));
  const ignoredCandidates = computed(() => candidates.value.filter((c) => c.ignored));

  function probeOf(c: Candidate): ProbeState {
    return (
      probes.value[c.key] ?? {
        status: "idle",
        result: null,
        user: c.suggestedUser ?? "root",
      }
    );
  }

  function setProbeUser(c: Candidate, user: string) {
    probes.value = { ...probes.value, [c.key]: { ...probeOf(c), user } };
  }

  async function probe(c: Candidate) {
    const current = probeOf(c);
    probes.value = { ...probes.value, [c.key]: { ...current, status: "running" } };
    try {
      const result = await api.probeCandidate(c.host, c.port, current.user);
      probes.value = {
        ...probes.value,
        [c.key]: { ...current, status: result.ok ? "ok" : "fail", result },
      };
    } catch (e) {
      probes.value = {
        ...probes.value,
        [c.key]: {
          ...current,
          status: "fail",
          result: { ok: false, key: null, keyType: null, message: errorText(e), durationMs: 0 },
        },
      };
    }
  }

  async function probeAll() {
    await Promise.all(activeCandidates.value.map((c) => probe(c)));
  }

  /** 探测成功 / 失败的未忽略候选 */
  const probedOk = computed(() =>
    activeCandidates.value.filter((c) => probeOf(c).status === "ok"),
  );
  const probedFail = computed(() =>
    activeCandidates.value.filter((c) => probeOf(c).status === "fail"),
  );

  async function setCandidatesIgnored(list: Candidate[], ignored: boolean) {
    if (list.length === 0) return;
    const keys = new Set(list.map((c) => c.key));
    meta.value = await api.setCandidatesIgnored([...keys], ignored);
    candidates.value = candidates.value.map((x) => (keys.has(x.key) ? { ...x, ignored } : x));
  }

  async function upsertMany(inputs: HostInput[]): Promise<string[]> {
    const ids = await api.upsertHosts(inputs);
    await load();
    return ids;
  }

  function selectHost(id: string) {
    selectedId.value = id;
    view.value = "hosts";
  }

  function metaOf(id: string): HostMeta {
    return meta.value.hosts[id] ?? emptyHostMeta();
  }

  const servers = computed(() => hosts.value.filter((h) => h.kind === "server"));
  const gitHosts = computed(() => hosts.value.filter((h) => h.kind === "gitPlatform"));
  const patternHosts = computed(() => hosts.value.filter((h) => h.kind === "pattern"));
  const favorites = computed(() => hosts.value.filter((h) => metaOf(h.id).favorite));

  const groups = computed(() => {
    const names = new Set(meta.value.groups);
    for (const h of hosts.value) {
      const g = metaOf(h.id).group;
      if (g) names.add(g);
    }
    return [...names];
  });

  const groupCounts = computed(() => {
    const counts = new Map<string, number>();
    for (const h of servers.value) {
      const g = metaOf(h.id).group ?? UNGROUPED;
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    return counts;
  });

  function matchesQuery(h: HostEntry, q: string): boolean {
    if (!q) return true;
    const m = metaOf(h.id);
    const hay = [
      h.alias,
      h.hostName,
      h.user,
      h.description,
      m.group,
      m.note,
      ...m.tags,
      ...h.patterns,
    ]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    return q
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .every((w) => hay.includes(w));
  }

  const filtered = computed(() => {
    const f = filter.value;
    let list: HostEntry[];
    switch (f.type) {
      case "all":
        list = servers.value;
        break;
      case "favorites":
        list = favorites.value;
        break;
      case "git":
        list = gitHosts.value;
        break;
      case "pattern":
        list = patternHosts.value;
        break;
      case "ungrouped":
        list = servers.value.filter((h) => !metaOf(h.id).group);
        break;
      case "group":
        list = servers.value.filter((h) => metaOf(h.id).group === f.name);
        break;
    }
    const q = query.value.trim();
    return sortByOrder(list.filter((h) => matchesQuery(h, q)));
  });

  /** 「全部」视图下按分组分节展示 */
  const sections = computed(() => {
    if (filter.value.type !== "all") {
      return [{ name: null as string | null, hosts: filtered.value }];
    }
    const map = new Map<string, HostEntry[]>();
    for (const g of groups.value) map.set(g, []);
    map.set(UNGROUPED, []);
    for (const h of filtered.value) {
      const g = metaOf(h.id).group ?? UNGROUPED;
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(h);
    }
    const out = [...map.entries()]
      .filter(([, hs]) => hs.length > 0)
      .map(([name, hs]) => ({ name: name as string | null, hosts: hs }));
    if (out.length === 1 && out[0].name === UNGROUPED) out[0].name = null;
    return out;
  });

  async function load() {
    loading.value = true;
    error.value = null;
    try {
      const [payload, m, k, c] = await Promise.all([
        api.loadHosts(),
        api.loadMeta(),
        api.listKeys(),
        api.loadCandidates(),
      ]);
      hosts.value = payload.hosts;
      files.value = payload.files;
      configPath.value = payload.configPath;
      metaPath.value = payload.metaPath;
      meta.value = m;
      keys.value = k;
      candidates.value = c;
      if (selectedId.value && !byId.value.has(selectedId.value)) {
        selectedId.value = null;
      }
    } catch (e) {
      error.value = errorText(e);
    } finally {
      loading.value = false;
    }
  }

  async function saveMeta(id: string, patch: Partial<HostMeta>) {
    const next = { ...metaOf(id), ...patch };
    meta.value = { ...meta.value, hosts: { ...meta.value.hosts, [id]: next } };
    meta.value = await api.saveHostMeta(id, next);
  }

  async function toggleFavorite(id: string) {
    await saveMeta(id, { favorite: !metaOf(id).favorite });
  }

  async function upsert(input: HostInput): Promise<string> {
    const id = await api.upsertHost(input);
    await load();
    selectedId.value = id;
    return id;
  }

  async function remove(id: string) {
    await api.deleteHost(id);
    if (selectedId.value === id) selectedId.value = null;
    await load();
  }

  async function replaceRaw(id: string, raw: string): Promise<string> {
    const newId = await api.replaceHostRaw(id, raw);
    await load();
    selectedId.value = newId;
    return newId;
  }

  function keyFor(path: string): KeyInfo | undefined {
    return keys.value.find((k) => k.path === path);
  }

  return {
    hosts,
    files,
    configPath,
    metaPath,
    meta,
    keys,
    loading,
    error,
    selectedId,
    selected,
    query,
    filter,
    privacy,
    togglePrivacy,
    mask,
    displayTarget,
    maskBlock,
    maskKeyPath,
    maskFp,
    reorder,
    alive,
    aliveOf,
    probingAll,
    probeHost,
    probeAllServers,
    aliveSummary,
    view,
    candidates,
    activeCandidates,
    ignoredCandidates,
    probes,
    probeOf,
    setProbeUser,
    probe,
    probeAll,
    probedOk,
    probedFail,
    setCandidatesIgnored,
    upsertMany,
    selectHost,
    servers,
    gitHosts,
    patternHosts,
    favorites,
    groups,
    groupCounts,
    filtered,
    sections,
    metaOf,
    keyFor,
    load,
    saveMeta,
    toggleFavorite,
    upsert,
    remove,
    replaceRaw,
  };
});

// 让 Vite 热更新时替换掉旧的 store 实例，避免组件拿到缺少新方法的旧对象而渲染报错
if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useHostsStore, import.meta.hot));
}
