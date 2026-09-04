import { Channel, invoke } from "@tauri-apps/api/core";

export type HostKind = "server" | "gitPlatform" | "pattern";

export interface KeyValue {
  key: string;
  value: string;
}

export interface HostEntry {
  id: string;
  alias: string;
  patterns: string[];
  hostName: string | null;
  user: string | null;
  port: number | null;
  identityFiles: string[];
  identitiesOnly: boolean;
  proxyJump: string | null;
  extra: KeyValue[];
  description: string | null;
  kind: HostKind;
  sourceFile: string;
  line: number;
  raw: string;
}

export interface HostsPayload {
  hosts: HostEntry[];
  files: string[];
  configPath: string;
  metaPath: string;
}

export type CloudProvider = "tencent" | "volcengine";
export type CloudProduct = "cvm" | "lighthouse" | "ecs";
export type PowerAction = "start" | "stop" | "forceStop" | "reboot" | "forceReboot";
export type InstanceState =
  | "running"
  | "stopped"
  | "starting"
  | "stopping"
  | "rebooting"
  | "pending"
  | "unknown";

export interface CloudBinding {
  accountId: string;
  provider: CloudProvider;
  product: CloudProduct;
  region: string;
  instanceId: string;
  instanceName: string;
}

export interface CloudAccount {
  id: string;
  provider: CloudProvider;
  name: string;
  keyId: string;
  regions: string[];
}

export interface CloudInstance {
  accountId: string;
  provider: CloudProvider;
  product: CloudProduct;
  region: string;
  zone: string;
  instanceId: string;
  name: string;
  state: InstanceState;
  rawState: string;
  publicIps: string[];
  privateIps: string[];
  os: string;
  cpu: number;
  memoryGb: number;
}

export interface InstanceMatch {
  hostId: string;
  alias: string;
  instance: CloudInstance;
}

export interface ScanResult {
  instances: CloudInstance[];
  matches: InstanceMatch[];
  regionsScanned: number;
  errors: string[];
}

export const PROVIDER_LABEL: Record<CloudProvider, string> = {
  tencent: "腾讯云",
  volcengine: "火山引擎",
};

export const PRODUCT_LABEL: Record<CloudProduct, string> = {
  cvm: "云服务器 CVM",
  lighthouse: "轻量应用服务器",
  ecs: "云服务器 ECS",
};

export const STATE_LABEL: Record<InstanceState, string> = {
  running: "运行中",
  stopped: "已关机",
  starting: "开机中",
  stopping: "关机中",
  rebooting: "重启中",
  pending: "创建中",
  unknown: "未知",
};

export function bindingToInstance(b: CloudBinding): Pick<CloudInstance, "provider" | "product" | "region" | "instanceId" | "name"> {
  return {
    provider: b.provider,
    product: b.product,
    region: b.region,
    instanceId: b.instanceId,
    name: b.instanceName,
  };
}

export interface FolderPair {
  id: string;
  name: string;
  local: string;
  remote: string;
  autoUpload: boolean;
}

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  mtime: number | null;
  permissions: number | null;
}

export interface TransferProgress {
  taskId: string;
  phase: "scanning" | "transferring" | "done" | "error" | "cancelled";
  current: string;
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  message: string;
}

export interface SyncItem {
  rel: string;
  action: "create" | "update";
  size: number;
  reason: string;
}

export interface SyncPlan {
  direction: "push" | "pull";
  local: string;
  remote: string;
  items: SyncItem[];
  orphans: string[];
  unchanged: number;
  bytes: number;
}

export interface SyncEvent {
  pairId: string;
  rel: string;
  ok: boolean;
  message: string;
  at: number;
}

export interface HostMeta {
  group: string | null;
  tags: string[];
  note: string;
  color: string | null;
  favorite: boolean;
  hidden: boolean;
  lastConnected: number | null;
  connectCount: number;
  cloud: CloudBinding | null;
  consoleUrl: string | null;
  folderPairs: FolderPair[];
  sftpCompression: boolean;
}

export interface StoredSnippet {
  id: string;
  name: string;
  command: string;
  group: string;
  mode: string;
  confirm: boolean;
  danger: boolean;
  watchReboot: boolean;
  hostIds: string[];
}

export interface Meta {
  version: number;
  groups: string[];
  hosts: Record<string, HostMeta>;
  ignoredCandidates: string[];
  snippets: StoredSnippet[];
  hiddenSnippets: string[];
  cloudAccounts: CloudAccount[];
  order: string[];
  shortcuts: Record<string, string>;
  localSnippets: StoredSnippet[];
  hiddenLocalSnippets: string[];
  localDirs: LocalDir[];
}

export interface ShortcutDef {
  id: string;
  label: string;
  group: string;
  default: string;
}

export interface AppInfo {
  version: string;
  dataDir: string;
  metaPath: string;
  sshDir: string;
  shortcuts: ShortcutDef[];
  platform: string;
}

export interface AliveResult {
  ok: boolean;
  message: string;
  durationMs: number;
}

export interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

export interface Candidate {
  key: string;
  host: string;
  port: number;
  keyTypes: string[];
  lines: number[];
  suggestedUser: string | null;
  isGit: boolean;
  isPrivate: boolean;
  ignored: boolean;
}

export interface ProbeResult {
  ok: boolean;
  key: string | null;
  keyType: string | null;
  message: string;
  durationMs: number;
}

export interface KeyInfo {
  path: string;
  publicPath: string | null;
  hasPrivate: boolean;
  algorithm: string;
  bits: number;
  fingerprint: string;
  comment: string;
  usedBy: string[];
}

export type TerminalTarget =
  | { kind: "ssh"; alias: string; command?: string | null }
  | { kind: "local"; cwd?: string | null };

/** 终端粘贴：剪贴板里是文件 / 图片时给本机路径（图片已存成 PNG），否则给文本 */
export type PastePayload =
  | { kind: "files"; paths: string[] }
  | { kind: "image"; paths: string[] }
  | { kind: "text"; text: string }
  | { kind: "empty" };

export interface LocalDir {
  id: string;
  name: string;
  path: string;
}

export interface LocalDisk {
  mount: string;
  total: number;
  free: number;
}

export interface LocalSummary {
  hostname: string;
  user: string;
  os: string;
  kernel: string;
  arch: string;
  shell: string;
  uptimeSecs: number;
  cpuCount: number;
  cpuBrand: string;
  memTotal: number;
  memUsed: number;
  disks: LocalDisk[];
  ips: string[];
  home: string;
}

export type TermMessage =
  | { type: "data"; data: string }
  | { type: "exit"; code: number | null };

export interface HostInput {
  originalId: string | null;
  alias: string;
  hostName: string;
  user: string | null;
  port: number | null;
  identityFiles: string[];
  identitiesOnly: boolean;
  proxyJump: string | null;
  description: string;
}

export const api = {
  loadHosts: () => invoke<HostsPayload>("load_hosts"),
  readConfigRaw: () => invoke<string>("read_config_raw"),
  upsertHost: (input: HostInput) => invoke<string>("upsert_host", { input }),
  deleteHost: (id: string) => invoke<void>("delete_host", { id }),
  replaceHostRaw: (id: string, raw: string) =>
    invoke<string>("replace_host_raw", { id, raw }),
  loadMeta: () => invoke<Meta>("load_meta"),
  saveHostMeta: (id: string, meta: HostMeta) =>
    invoke<Meta>("save_host_meta", { id, meta }),
  saveGroups: (groups: string[]) => invoke<Meta>("save_groups", { groups }),
  listKeys: () => invoke<KeyInfo[]>("list_keys"),
  upsertHosts: (inputs: HostInput[]) => invoke<string[]>("upsert_hosts", { inputs }),
  loadCandidates: () => invoke<Candidate[]>("load_candidates"),
  setCandidatesIgnored: (keys: string[], ignored: boolean) =>
    invoke<Meta>("set_candidates_ignored", { keys, ignored }),
  probeCandidate: (host: string, port: number, user: string) =>
    invoke<ProbeResult>("probe_candidate", { host, port, user }),
  touchHostConnected: (id: string) => invoke<Meta>("touch_host_connected", { id }),
  saveOrder: (order: string[]) => invoke<Meta>("save_order", { order }),
  probeHost: (alias: string) => invoke<AliveResult>("probe_host", { alias }),
  saveSnippets: (snippets: StoredSnippet[], hidden: string[]) =>
    invoke<Meta>("save_snippets", { snippets, hidden }),
  runRemote: (alias: string, command: string, timeoutSecs = 60) =>
    invoke<RunResult>("run_remote_command", { alias, command, timeoutSecs }),
  checkHostAlive: (alias: string) => invoke<boolean>("check_host_alive", { alias }),

  cloudAddAccount: (
    provider: CloudProvider,
    name: string,
    keyId: string,
    secret: string,
    regions: string[] = [],
  ) => invoke<Meta>("cloud_add_account", { provider, name, keyId, secret, regions }),
  cloudRemoveAccount: (id: string) => invoke<Meta>("cloud_remove_account", { id }),
  cloudScan: (accountId: string) => invoke<ScanResult>("cloud_scan", { accountId }),
  cloudBind: (bindings: { hostId: string; binding: CloudBinding | null }[]) =>
    invoke<Meta>("cloud_bind", { bindings }),
  cloudState: (hostId: string) => invoke<CloudInstance>("cloud_state", { hostId }),
  cloudPower: (hostId: string, action: PowerAction) =>
    invoke<void>("cloud_power", { hostId, action }),
  cloudVncUrl: (hostId: string) => invoke<string>("cloud_vnc_url", { hostId }),

  // ---- 文件 ----
  localHome: () => invoke<string>("local_home"),
  localList: (path: string) => invoke<FsEntry[]>("local_list", { path }),
  localMkdir: (path: string) => invoke<void>("local_mkdir", { path }),
  localRemove: (path: string) => invoke<void>("local_remove", { path }),
  localRename: (from: string, to: string) => invoke<void>("local_rename", { from, to }),
  sftpHome: (alias: string) => invoke<string>("sftp_home", { alias }),
  sftpList: (alias: string, path: string) => invoke<FsEntry[]>("sftp_list", { alias, path }),
  sftpMkdir: (alias: string, path: string) => invoke<void>("sftp_mkdir", { alias, path }),
  sftpRemove: (alias: string, path: string) => invoke<void>("sftp_remove", { alias, path }),
  sftpRename: (alias: string, from: string, to: string) =>
    invoke<void>("sftp_rename", { alias, from, to }),
  sftpDisconnect: (alias: string) => invoke<void>("sftp_disconnect", { alias }),
  sftpSetCompression: (hostId: string, alias: string, on: boolean) =>
    invoke<Meta>("sftp_set_compression", { hostId, alias, on }),
  sftpUpload: (
    alias: string,
    local: string,
    remoteDir: string,
    taskId: string,
    onProgress: (p: TransferProgress) => void,
  ) => {
    const ch = new Channel<TransferProgress>();
    ch.onmessage = onProgress;
    return invoke<void>("sftp_upload", { alias, local, remoteDir, taskId, onProgress: ch });
  },
  sftpDownload: (
    alias: string,
    remote: string,
    localDir: string,
    taskId: string,
    onProgress: (p: TransferProgress) => void,
  ) => {
    const ch = new Channel<TransferProgress>();
    ch.onmessage = onProgress;
    return invoke<void>("sftp_download", { alias, remote, localDir, taskId, onProgress: ch });
  },
  sftpCancel: (taskId: string) => invoke<void>("sftp_cancel", { taskId }),
  sftpSyncPlan: (alias: string, local: string, remote: string, direction: "push" | "pull") =>
    invoke<SyncPlan>("sftp_sync_plan", { alias, local, remote, direction }),
  sftpSyncApply: (
    alias: string,
    local: string,
    remote: string,
    direction: "push" | "pull",
    rels: string[],
    deleteOrphans: string[],
    taskId: string,
    onProgress: (p: TransferProgress) => void,
  ) => {
    const ch = new Channel<TransferProgress>();
    ch.onmessage = onProgress;
    return invoke<void>("sftp_sync_apply", {
      alias,
      local,
      remote,
      direction,
      rels,
      deleteOrphans,
      taskId,
      onProgress: ch,
    });
  },
  saveFolderPairs: (hostId: string, pairs: FolderPair[]) =>
    invoke<Meta>("save_folder_pairs", { hostId, pairs }),
  watchStart: (pairId: string, alias: string, local: string, remote: string) =>
    invoke<void>("watch_start", { pairId, alias, local, remote }),
  watchStop: (pairId: string) => invoke<void>("watch_stop", { pairId }),
  watchActive: () => invoke<string[]>("watch_active"),

  openTerminal: (
    target: TerminalTarget,
    cols: number,
    rows: number,
    onMessage: (m: TermMessage) => void,
    termType = "xterm-256color",
  ) => {
    const onEvent = new Channel<TermMessage>();
    onEvent.onmessage = onMessage;
    return invoke<string>("open_terminal", { target, cols, rows, termType, onEvent });
  },
  appInfo: () => invoke<AppInfo>("app_info"),
  clipboardPaste: () => invoke<PastePayload>("clipboard_paste_payload"),
  runLocal: (command: string, cwd?: string | null, timeoutSecs = 60) =>
    invoke<RunResult>("run_local", { command, cwd: cwd ?? null, timeoutSecs }),
  localRecentCommands: (limit = 30) => invoke<string[]>("local_recent_commands", { limit }),
  localSummary: () => invoke<LocalSummary>("local_summary"),
  saveLocalSnippets: (snippets: StoredSnippet[], hidden: string[]) =>
    invoke<Meta>("save_local_snippets", { snippets, hidden }),
  saveLocalDirs: (dirs: LocalDir[]) => invoke<Meta>("save_local_dirs", { dirs }),
  saveShortcuts: (shortcuts: Record<string, string>) => invoke<Meta>("save_shortcuts", { shortcuts }),
  writeTerminal: (id: string, data: string) => invoke<void>("write_terminal", { id, data }),
  resizeTerminal: (id: string, cols: number, rows: number) =>
    invoke<void>("resize_terminal", { id, cols, rows }),
  closeTerminal: (id: string) => invoke<void>("close_terminal", { id }),
};

/** base64 → 字节，交给 xterm 自己做 UTF-8 流式解码（多字节字符跨分片也不会乱码） */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const emptyHostMeta = (): HostMeta => ({
  group: null,
  tags: [],
  note: "",
  color: null,
  favorite: false,
  hidden: false,
  lastConnected: null,
  connectCount: 0,
  cloud: null,
  consoleUrl: null,
  folderPairs: [],
  sftpCompression: false,
});

export const emptyMeta = (): Meta => ({
  version: 0,
  groups: [],
  hosts: {},
  ignoredCandidates: [],
  snippets: [],
  hiddenSnippets: [],
  cloudAccounts: [],
  order: [],
  shortcuts: {},
  localSnippets: [],
  hiddenLocalSnippets: [],
  localDirs: [],
});

const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;

/** 隐私模式下把地址打码：IPv4 → xxx.xxx.xxx.xxx，其它主机名 → xxxxx */
export function maskHost(s: string): string {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return "xxx.xxx.xxx.xxx";
  if (s.includes(":") && /^[0-9a-f:.]+$/i.test(s)) return "xxxx:xxxx::xxxx";
  return "xxxxx";
}

/** 路径只保留目录，文件名打码：~/.ssh/id_rsa → ~/.ssh/xxxxx */
export function maskPath(p: string): string {
  return p.replace(/[^/\\]+$/, "xxxxx");
}

/** 指纹打码：SHA256:abc… → SHA256:xxxxxxxx */
export function maskFingerprint(fp: string): string {
  return fp.replace(/^([A-Za-z0-9]+:).*/, "$1xxxxxxxx");
}

/** 打码一段任意文本里的 IPv4、指定主机名、密钥文件名（用于 config 原文等） */
export function maskText(text: string, hostNames: string[] = []): string {
  let out = text.replace(IPV4, "xxx.xxx.xxx.xxx");
  for (const h of hostNames) {
    if (h && !/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) out = out.split(h).join("xxxxx");
  }
  return out.replace(/^(\s*IdentityFile[\s=]+)(\S+)/gim, (_m, k: string, p: string) => k + maskPath(p));
}

export const KIND_LABEL: Record<HostKind, string> = {
  server: "服务器",
  gitPlatform: "Git 平台",
  pattern: "通配规则",
};

export function sshCommand(h: HostEntry): string {
  return `ssh ${h.alias}`;
}

/** user@host:port 形式的目标描述；privacy=true 时地址打码 */
export function hostTarget(h: HostEntry, privacy = false): string {
  const raw = h.hostName ?? h.alias;
  const host = privacy ? maskHost(raw) : raw;
  const user = h.user ? `${h.user}@` : "";
  const port = h.port && h.port !== 22 ? `:${h.port}` : "";
  return `${user}${host}${port}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatMtime(secs: number | null): string {
  if (!secs) return "";
  const d = new Date(secs * 1000);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleString("zh-CN", {
    year: sameYear ? undefined : "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
