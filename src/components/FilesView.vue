<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { NButton, NInput, NProgress, NScrollbar, NSwitch, NTag, NTooltip, useDialog, useMessage } from "naive-ui";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  ArrowDownToLine,
  ArrowUp,
  ArrowUpFromLine,
  ChevronRight,
  File,
  Folder,
  FolderPlus,
  Home,
  Link2,
  ListChecks,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-vue-next";
import { api, errorText, formatBytes, formatMtime, type FolderPair, type FsEntry, type SyncPlan } from "../api";
import { useHostsStore } from "../stores/hosts";
import { useFilesStore, type Side } from "../stores/files";
import { useSettingsStore } from "../stores/settings";
import type { Tab } from "../stores/terminals";
import { fileManagerName } from "../platform";
import SyncPlanModal from "./SyncPlanModal.vue";

const props = defineProps<{ tab: Tab; active: boolean }>();
const hosts = useHostsStore();
const files = useFilesStore();
const settings = useSettingsStore();
const dialog = useDialog();
const message = useMessage();

const host = computed(() => hosts.hosts.find((h) => h.id === props.tab.hostId));
const st = computed(() => files.state(props.tab.hostId!));
const pairs = computed(() => files.pairsOf(props.tab.hostId!));
const currentPair = ref<FolderPair | null>(null);

const localInput = ref("");
const remoteInput = ref("");
watch(() => st.value.local.path, (p) => (localInput.value = p), { immediate: true });
watch(() => st.value.remote.path, (p) => (remoteInput.value = p), { immediate: true });

onMounted(() => {
  if (host.value) files.init(host.value);
});

// ---- 导航 ----
function go(side: Side, path: string) {
  if (!host.value || !path.trim()) return;
  files.load(host.value, side, path.trim());
}

async function goHome(side: Side) {
  if (!host.value) return;
  try {
    const home = side === "local" ? await api.localHome() : await api.sftpHome(host.value.alias);
    go(side, home);
  } catch (e) {
    message.error(errorText(e));
  }
}

function visible(side: Side): FsEntry[] {
  const list = st.value[side].entries;
  return settings.prefs.showHidden ? list : list.filter((e) => !e.name.startsWith("."));
}

function enter(side: Side, e: FsEntry) {
  if (!host.value) return;
  if (e.isDir) {
    go(side, e.path);
  } else if (!settings.prefs.doubleClickTransfer) {
    return;
  } else if (side === "local") {
    files.upload(host.value, [e.path], st.value.remote.path);
    message.info(`上传 ${e.name} → ${st.value.remote.path}`);
  } else {
    files.download(host.value, [e.path], st.value.local.path);
    message.info(`下载 ${e.name} → ${st.value.local.path}`);
  }
}

function onRowClick(side: Side, e: FsEntry, ev: MouseEvent) {
  files.select(props.tab.hostId!, side, e.path, ev.metaKey || ev.ctrlKey ? "toggle" : ev.shiftKey ? "range" : "single");
}

function selectedEntries(side: Side): FsEntry[] {
  const pane = st.value[side];
  return pane.entries.filter((e) => pane.selected.includes(e.path));
}

// ---- 操作 ----
function askText(title: string, initial: string, onOk: (v: string) => void) {
  const value = ref(initial);
  dialog.create({
    title,
    content: () =>
      h(NInput, {
        value: value.value,
        autofocus: true,
        "onUpdate:value": (v: string) => (value.value = v),
        onKeydown: (e: KeyboardEvent) => {
          if (e.key === "Enter" && value.value.trim()) {
            (e.target as HTMLElement).closest(".n-dialog")?.querySelector<HTMLButtonElement>(".n-button--primary-type")?.click();
          }
        },
      }),
    positiveText: "确定",
    negativeText: "取消",
    onPositiveClick: () => {
      if (!value.value.trim()) return false;
      onOk(value.value.trim());
    },
  });
}

function newFolder(side: Side) {
  askText(side === "local" ? "新建本地文件夹" : "新建远端文件夹", "", async (name) => {
    try {
      await files.mkdir(host.value!, side, name);
    } catch (e) {
      message.error(errorText(e));
    }
  });
}

function renameSelected(side: Side) {
  const sel = selectedEntries(side);
  if (sel.length !== 1) return message.warning("请只选中一个再重命名");
  askText("重命名", sel[0].name, async (name) => {
    try {
      await files.rename(host.value!, side, sel[0].path, name);
    } catch (e) {
      message.error(errorText(e));
    }
  });
}

function removeSelected(side: Side) {
  const sel = selectedEntries(side);
  if (!sel.length) return;
  dialog.error({
    title: `删除 ${sel.length} 项？`,
    content: `${side === "local" ? "本地" : "服务器上"}的这些文件/文件夹会被永久删除，不进回收站：\n${sel.map((e) => e.name).join("、")}`,
    style: "white-space: pre-wrap",
    positiveText: "删除",
    negativeText: "取消",
    onPositiveClick: async () => {
      try {
        await files.remove(host.value!, side, sel.map((e) => e.path));
      } catch (e) {
        message.error(errorText(e));
      }
    },
  });
}

function uploadSelected() {
  const sel = selectedEntries("local");
  if (!sel.length || !host.value) return;
  files.upload(host.value, sel.map((e) => e.path), st.value.remote.path);
}

function downloadSelected() {
  const sel = selectedEntries("remote");
  if (!sel.length || !host.value) return;
  files.download(host.value, sel.map((e) => e.path), st.value.local.path);
}

async function pickLocalFolder() {
  const picked = await openDialog({ directory: true, multiple: false, defaultPath: st.value.local.path });
  if (typeof picked === "string") go("local", picked);
}

async function pickAndUpload() {
  const picked = await openDialog({ multiple: true, directory: false, defaultPath: st.value.local.path });
  const list = Array.isArray(picked) ? picked : picked ? [picked] : [];
  if (list.length && host.value) files.upload(host.value, list, st.value.remote.path);
}

function reveal() {
  const sel = selectedEntries("local");
  revealItemInDir(sel[0]?.path ?? st.value.local.path).catch((e) => message.error(errorText(e)));
}

// ---- 从 Finder 拖文件到远端面板 → 上传 ----
const remotePane = ref<HTMLElement | null>(null);
const dropHover = ref(false);
let unlistenDrop: UnlistenFn | null = null;

function overRemote(x: number, y: number): boolean {
  const el = remotePane.value;
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const px = x / scale;
  const py = y / scale;
  return px >= r.left && px <= r.right && py >= r.top && py <= r.bottom;
}

onMounted(async () => {
  unlistenDrop = await getCurrentWebview().onDragDropEvent((ev) => {
    if (!props.active) return;
    const p = ev.payload;
    if (p.type === "over" || p.type === "enter") {
      dropHover.value = overRemote(p.position.x, p.position.y);
    } else if (p.type === "leave") {
      dropHover.value = false;
    } else if (p.type === "drop") {
      const hit = overRemote(p.position.x, p.position.y);
      dropHover.value = false;
      if (hit && host.value && p.paths.length) {
        files.upload(host.value, p.paths, st.value.remote.path);
        message.info(`开始上传 ${p.paths.length} 项到 ${st.value.remote.path}`);
      }
    }
  });
});

onBeforeUnmount(() => unlistenDrop?.());

// ---- 联动组 ----
const planOpen = ref(false);
const plan = ref<SyncPlan | null>(null);
const planning = ref(false);

function usePair(p: FolderPair) {
  currentPair.value = p;
  go("local", p.local);
  go("remote", p.remote);
}

function addPair() {
  const name = ref("");
  dialog.create({
    title: "添加联动文件夹组",
    content: () =>
      h("div", { class: "pair-form" }, [
        h("div", { class: "muted small" }, "以当前两侧打开的目录为一组："),
        h("div", { class: "mono small" }, `本地：${st.value.local.path}`),
        h("div", { class: "mono small" }, `远端：${st.value.remote.path}`),
        h(NInput, {
          value: name.value,
          placeholder: "组名，例如：前端项目 / 配置文件",
          autofocus: true,
          style: "margin-top: 10px",
          "onUpdate:value": (v: string) => (name.value = v),
        }),
      ]),
    positiveText: "添加",
    negativeText: "取消",
    onPositiveClick: async () => {
      const pair: FolderPair = {
        id: `fp${Date.now().toString(36)}`,
        name: name.value.trim() || `${st.value.local.path.split("/").pop()} ↔ ${st.value.remote.path.split("/").pop()}`,
        local: st.value.local.path,
        remote: st.value.remote.path,
        autoUpload: false,
      };
      try {
        await files.savePairs(host.value!, [...pairs.value, pair]);
        currentPair.value = pair;
        message.success("已添加联动组");
      } catch (e) {
        message.error(errorText(e));
      }
    },
  });
}

function removePair(p: FolderPair) {
  dialog.warning({
    title: `删除联动组「${p.name}」？`,
    content: "只删除这组关联关系，不会动任何文件。",
    positiveText: "删除",
    negativeText: "取消",
    onPositiveClick: async () => {
      if (files.activeWatchers.has(p.id)) await files.setAutoUpload(host.value!, p, false).catch(() => {});
      await files.savePairs(host.value!, pairs.value.filter((x) => x.id !== p.id));
      if (currentPair.value?.id === p.id) currentPair.value = null;
    },
  });
}

async function sync(direction: "push" | "pull") {
  const p = currentPair.value;
  if (!p || !host.value) return;
  planning.value = true;
  try {
    plan.value = await files.planSync(host.value, p, direction);
    planOpen.value = true;
  } catch (e) {
    message.error(errorText(e));
  } finally {
    planning.value = false;
  }
}

async function toggleCompression(on: boolean) {
  try {
    await files.setCompression(host.value!, on);
    message.success(on ? "已开启压缩传输，下次传输起生效" : "已关闭压缩传输");
  } catch (e) {
    message.error(errorText(e));
  }
}

async function toggleAuto(p: FolderPair, on: boolean) {
  try {
    await files.setAutoUpload(host.value!, p, on);
    message.success(on ? `已开启自动上传：${p.name}` : `已关闭自动上传：${p.name}`);
  } catch (e) {
    message.error(errorText(e));
  }
}

const pairLog = computed(() =>
  currentPair.value ? files.syncLog.filter((e) => e.pairId === currentPair.value!.id).slice(0, 30) : [],
);

// ---- 传输面板 ----
const myTransfers = computed(() => files.transfers.filter((t) => t.hostId === props.tab.hostId));
const showTransfers = ref(true);

function pct(t: (typeof myTransfers.value)[number]): number {
  const p = t.progress;
  if (!p || !p.bytesTotal) return t.finished ? 100 : 0;
  return Math.min(100, Math.round((p.bytesDone / p.bytesTotal) * 100));
}
</script>

<template>
  <div v-if="host" class="files">
    <!-- 联动组栏 -->
    <div class="pairs-bar">
      <Link2 :size="14" class="muted" />
      <span class="muted label">联动文件夹组</span>
      <button
        v-for="p in pairs"
        :key="p.id"
        class="pair"
        :class="{ active: currentPair?.id === p.id }"
        v-tip="`${p.local}\n↔ ${p.remote}`"
        @click="usePair(p)"
      >
        {{ p.name }}
        <span v-if="files.activeWatchers.has(p.id)" v-tip="'自动上传中'" class="auto-dot"></span>
        <X :size="11" class="pair-x" @click.stop="removePair(p)" />
      </button>
      <n-button size="tiny" quaternary @click="addPair">
        <template #icon><Plus :size="12" /></template>
        用当前目录添加
      </n-button>

      <n-tooltip>
        <template #trigger>
          <label class="auto compress">
            <n-switch
              size="small"
              :value="hosts.metaOf(tab.hostId!).sftpCompression"
              @update:value="(v: boolean) => toggleCompression(v)"
            />
            压缩传输
          </label>
        </template>
        <div style="max-width: 320px; line-height: 1.6">
          ssh 层 zlib 压缩。传代码、日志、配置这类文本，且带宽较小（跨境/家宽）时开启能快 2–5 倍；
          传图片、视频、压缩包这类本身已压缩的文件或在内网时反而会更慢，建议关闭。
        </div>
      </n-tooltip>

      <template v-if="currentPair">
        <span class="spacer"></span>
        <n-button size="tiny" secondary type="primary" :loading="planning" @click="sync('push')">
          <template #icon><ArrowUpFromLine :size="12" /></template>
          推送到服务器
        </n-button>
        <n-button size="tiny" secondary :loading="planning" @click="sync('pull')">
          <template #icon><ArrowDownToLine :size="12" /></template>
          拉取到本地
        </n-button>
        <n-tooltip>
          <template #trigger>
            <label class="auto">
              <n-switch
                size="small"
                :value="files.activeWatchers.has(currentPair.id)"
                @update:value="(v: boolean) => toggleAuto(currentPair!, v)"
              />
              自动上传
            </label>
          </template>
          监视本地目录，文件新建/修改后自动上传到远端对应位置（不镜像删除）
        </n-tooltip>
      </template>
    </div>

    <!-- 双面板 -->
    <div class="panes">
      <template v-for="side in (['local', 'remote'] as Side[])" :key="side">
        <div
          :ref="side === 'remote' ? (el) => (remotePane = el as HTMLElement) : undefined"
          class="pane"
          :class="{ 'drop-hover': side === 'remote' && dropHover }"
        >
          <div class="pane-head">
            <span class="pane-title">{{ side === "local" ? "本地" : host.alias }}</span>
            <n-tooltip><template #trigger><n-button size="tiny" quaternary @click="files.up(host!, side)"><template #icon><ArrowUp :size="13" /></template></n-button></template>上一级</n-tooltip>
            <n-tooltip><template #trigger><n-button size="tiny" quaternary @click="goHome(side)"><template #icon><Home :size="13" /></template></n-button></template>家目录</n-tooltip>
            <n-input
              :value="side === 'local' ? localInput : remoteInput"
              size="tiny"
              class="mono path-input"
              @update:value="(v: string) => (side === 'local' ? (localInput = v) : (remoteInput = v))"
              @keydown.enter="go(side, side === 'local' ? localInput : remoteInput)"
            />
            <n-tooltip><template #trigger><n-button size="tiny" quaternary :loading="st[side].loading" @click="files.refresh(host!, side)"><template #icon><RefreshCw :size="13" /></template></n-button></template>刷新</n-tooltip>
            <n-tooltip><template #trigger><n-button size="tiny" quaternary @click="newFolder(side)"><template #icon><FolderPlus :size="13" /></template></n-button></template>新建文件夹</n-tooltip>
            <n-tooltip v-if="side === 'local'"><template #trigger><n-button size="tiny" quaternary @click="pickLocalFolder"><template #icon><Folder :size="13" /></template></n-button></template>选择本地文件夹</n-tooltip>
          </div>

          <div class="pane-actions">
            <template v-if="side === 'local'">
              <n-button size="tiny" secondary type="primary" :disabled="!st.local.selected.length" @click="uploadSelected">
                <template #icon><ArrowUpFromLine :size="12" /></template>
                上传选中 ({{ st.local.selected.length }})
              </n-button>
              <n-button size="tiny" quaternary @click="pickAndUpload">选择文件上传…</n-button>
              <n-button size="tiny" quaternary @click="reveal">在 {{ fileManagerName }} 显示</n-button>
            </template>
            <template v-else>
              <n-button size="tiny" secondary type="primary" :disabled="!st.remote.selected.length" @click="downloadSelected">
                <template #icon><ArrowDownToLine :size="12" /></template>
                下载选中 ({{ st.remote.selected.length }})
              </n-button>
              <span class="muted small">可把文件从 {{ fileManagerName }} 拖到这里上传</span>
            </template>
            <span class="spacer"></span>
            <n-button size="tiny" quaternary :disabled="st[side].selected.length !== 1" @click="renameSelected(side)"><template #icon><Pencil :size="12" /></template></n-button>
            <n-button size="tiny" quaternary type="error" :disabled="!st[side].selected.length" @click="removeSelected(side)"><template #icon><Trash2 :size="12" /></template></n-button>
          </div>

          <div v-if="st[side].error" class="pane-error">{{ st[side].error }}</div>

          <n-scrollbar class="list-scroll">
            <table class="list">
              <tbody>
                <tr
                  v-for="e in visible(side)"
                  :key="e.path"
                  :class="{ selected: st[side].selected.includes(e.path) }"
                  @click="onRowClick(side, e, $event)"
                  @dblclick="enter(side, e)"
                >
                  <td class="c-icon">
                    <Folder v-if="e.isDir" :size="14" class="icon-dir" />
                    <File v-else :size="14" class="muted" />
                  </td>
                  <td v-tip="e.path" class="c-name">
                    {{ e.name }}<span v-if="e.isSymlink" class="muted"> →</span>
                  </td>
                  <td class="c-size muted mono">{{ e.isDir ? "" : formatBytes(e.size) }}</td>
                  <td class="c-time muted">{{ formatMtime(e.mtime) }}</td>
                  <td class="c-go"><ChevronRight v-if="e.isDir" :size="12" class="muted" /></td>
                </tr>
              </tbody>
            </table>
            <div v-if="!st[side].loading && !st[side].error && st[side].entries.length === 0" class="empty muted">空目录</div>
          </n-scrollbar>
        </div>
      </template>
    </div>

    <!-- 传输 / 同步日志 -->
    <div class="transfers" :class="{ collapsed: !showTransfers }">
      <div class="transfers-head" @click="showTransfers = !showTransfers">
        <ListChecks :size="13" />
        <span>传输任务</span>
        <n-tag v-if="files.activeTransfers" size="tiny" round :bordered="false" type="info">{{ files.activeTransfers }} 进行中</n-tag>
        <span v-if="currentPair && pairLog.length" class="muted small">· 自动上传日志 {{ pairLog.length }} 条</span>
        <span class="spacer"></span>
        <n-button size="tiny" quaternary @click.stop="files.clearFinished()">清除已完成</n-button>
      </div>
      <n-scrollbar v-if="showTransfers" style="max-height: 150px">
        <div v-for="t in myTransfers" :key="t.id" class="transfer">
          <div class="t-line">
            <span class="t-label">{{ t.label }}</span>
            <span class="muted small t-status">
              <template v-if="t.error">{{ t.error }}</template>
              <template v-else-if="t.progress?.phase === 'cancelled'">已取消</template>
              <template v-else-if="t.finished">完成</template>
              <template v-else-if="t.progress?.phase === 'scanning'">扫描中…</template>
              <template v-else-if="t.progress">
                {{ t.progress.filesDone }}/{{ t.progress.filesTotal }} · {{ formatBytes(t.progress.bytesDone) }} / {{ formatBytes(t.progress.bytesTotal) }}
              </template>
              <template v-else>准备中…</template>
            </span>
            <n-button v-if="!t.finished" size="tiny" quaternary @click="files.cancel(t.id)"><template #icon><X :size="11" /></template></n-button>
          </div>
          <n-progress
            type="line"
            :percentage="pct(t)"
            :height="4"
            :show-indicator="false"
            :status="t.error ? 'error' : t.finished ? 'success' : 'default'"
          />
        </div>
        <div v-for="e in pairLog" :key="e.at + e.rel" class="log" :class="{ err: !e.ok }">
          <span class="muted small">{{ new Date(e.at).toLocaleTimeString("zh-CN", { hour12: false }) }}</span>
          <span class="mono small">{{ e.rel || currentPair?.name }}</span>
          <span class="small">{{ e.message }}</span>
        </div>
        <div v-if="myTransfers.length === 0 && pairLog.length === 0" class="muted small empty-t">
          还没有传输任务。双击文件即可传到另一侧；也可以选中后点上传 / 下载。
        </div>
      </n-scrollbar>
    </div>

    <SyncPlanModal v-model:show="planOpen" :host="host" :pair="currentPair" :plan="plan" />
  </div>
  <div v-else class="muted missing">主机已不存在</div>
</template>

<style scoped>
.files {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.pairs-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--sidebar-bg);
}

.label {
  font-size: 12px;
  margin-right: 4px;
}

.pair {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 8px 0 10px;
  border-radius: 999px;
  border: 1px solid transparent;
  background: var(--hover-2);
  color: var(--text-2);
  font: inherit;
  font-size: 12px;
  cursor: default;
}

.pair.active {
  background: var(--accent-soft);
  border-color: rgba(91, 141, 239, 0.4);
  color: var(--accent-text);
}

.pair-x {
  opacity: 0.5;
}

.pair-x:hover {
  opacity: 1;
}

.auto-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--green);
  box-shadow: 0 0 0 2px rgba(61, 190, 122, 0.25);
}

.auto {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-2);
}

.auto.compress {
  margin-left: 6px;
  padding-left: 10px;
  border-left: 1px solid var(--border);
}

.spacer {
  flex: 1;
}

.panes {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1px;
  background: var(--border);
}

.pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--bg);
  transition: box-shadow 0.15s;
}

.pane.drop-hover {
  box-shadow: inset 0 0 0 2px var(--accent);
}

.pane-head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 10px 4px;
}

.pane-title {
  font-weight: 600;
  font-size: 12.5px;
  margin-right: 4px;
  white-space: nowrap;
}

.path-input {
  flex: 1;
  min-width: 0;
}

.pane-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px 6px;
  border-bottom: 1px solid var(--border);
}

.pane-error {
  margin: 8px 10px;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(229, 97, 91, 0.12);
  color: var(--red-text);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.list-scroll {
  flex: 1;
  min-height: 0;
}

.list {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}

.list tr {
  cursor: default;
}

.list tr:hover {
  background: var(--hover-1);
}

.list tr.selected {
  background: var(--accent-soft);
}

.list td {
  padding: 4px 6px;
  white-space: nowrap;
}

.c-icon {
  width: 24px;
  padding-left: 12px !important;
}

.icon-dir {
  color: #e3b25c;
}

.c-name {
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 0;
  width: 100%;
}

.c-size {
  text-align: right;
  font-size: 11.5px;
}

.c-time {
  font-size: 11.5px;
}

.c-go {
  width: 20px;
}

.empty {
  padding: 30px;
  text-align: center;
}

.transfers {
  flex: none;
  border-top: 1px solid var(--border);
  background: var(--sidebar-bg);
}

.transfers-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  font-size: 12px;
  color: var(--text-2);
  cursor: default;
}

.transfer {
  padding: 4px 14px 6px;
}

.t-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  margin-bottom: 3px;
}

.t-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1;
}

.t-status {
  white-space: nowrap;
}

.log {
  display: flex;
  gap: 10px;
  padding: 2px 14px;
  color: var(--green-text);
}

.log.err {
  color: var(--red-text);
}

.small {
  font-size: 11.5px;
}

.empty-t {
  padding: 8px 14px 10px;
}

.missing {
  padding: 40px;
  text-align: center;
}
</style>

<style>
.pair-form .small {
  font-size: 12px;
  line-height: 1.7;
}
</style>
