<script setup lang="ts">
import { onBeforeUnmount, onErrorCaptured, onMounted, ref, watch } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { NAlert, NButton, useMessage } from "naive-ui";
import { Laptop, Plus, Server, TerminalSquare } from "lucide-vue-next";
import { useHostsStore } from "../stores/hosts";
import { useTerminalsStore } from "../stores/terminals";
import { useCommandsStore } from "../stores/commands";
import { useCloudStore } from "../stores/cloud";
import { HOMEPAGE_URL, useUpdaterStore } from "../stores/updater";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getTerm } from "../terminalRegistry";
import { neighborPane, type NavDir } from "../paneNav";
import { appShortcut, isTabModifier } from "../platform";
import type { HostEntry, HostInput } from "../api";
import SideRail from "./SideRail.vue";
import SidePanel from "./SidePanel.vue";
import HostsPanel from "./HostsPanel.vue";
import CommandPanel from "./CommandPanel.vue";
import HostDetail from "./HostDetail.vue";
import HostForm from "./HostForm.vue";
import CandidatesPanel from "./CandidatesPanel.vue";
import LocalConsole from "./LocalConsole.vue";
import CommandPalette from "./CommandPalette.vue";
import UpdateDialog from "./UpdateDialog.vue";
import TerminalTabs from "./TerminalTabs.vue";
import PaneLayout from "./PaneLayout.vue";
import FilesView from "./FilesView.vue";
import RunResultsModal from "./RunResultsModal.vue";
import SnippetManager from "./SnippetManager.vue";
import BatchRunModal from "./BatchRunModal.vue";
import CloudAccountsModal from "./CloudAccountsModal.vue";
import SettingsModal from "./SettingsModal.vue";
import EditContextMenu from "./EditContextMenu.vue";
import { useSettingsStore } from "../stores/settings";
import { useFilesStore } from "../stores/files";
import { useShortcutsStore } from "../stores/shortcuts";

const store = useHostsStore();
const terminals = useTerminalsStore();
const commands = useCommandsStore();
const cloud = useCloudStore();
const updater = useUpdaterStore();
const settings = useSettingsStore();
const files = useFilesStore();
const shortcuts = useShortcutsStore();
const message = useMessage();

// 重启监视：状态翻转时弹提示
watch(
  () => Object.values(commands.watches).map((w) => `${w.hostId}:${w.phase}`).join("|"),
  (_, old) => {
    const before = new Set((old ?? "").split("|"));
    for (const w of Object.values(commands.watches)) {
      if (before.has(`${w.hostId}:${w.phase}`)) continue;
      if (w.phase === "up") {
        message.success(`${w.alias} 已恢复上线，耗时 ${commands.fmtElapsed(w.startedAt, w.upAt ?? Date.now())}`, {
          duration: 8000,
        });
      } else if (w.phase === "timeout") {
        message.error(`${w.alias} 15 分钟仍未恢复，请到云控制台查看`, { duration: 0, closable: true });
      } else if (w.phase === "down") {
        message.info(`${w.alias} 已掉线，正在等待恢复…`);
      }
    }
  },
);
// 窗口标题跟随当前会话：Mission Control / ⌘Tab 里能分清正在连哪台机
watch(
  () => terminals.activeSession?.title ?? terminals.activeTab?.title ?? null,
  (t) => getCurrentWindow().setTitle(t ? `${t} — ApexTerm` : "ApexTerm").catch(() => {}),
  { immediate: true },
);

const formOpen = ref(false);
const formHost = ref<HostEntry | null>(null);
const formPrefill = ref<Partial<HostInput> | null>(null);

function openCreate() {
  formHost.value = null;
  formPrefill.value = null;
  formOpen.value = true;
}

function openEdit(h: HostEntry) {
  formHost.value = h;
  formPrefill.value = null;
  formOpen.value = true;
}

function openAdopt(prefill: Partial<HostInput>) {
  formHost.value = null;
  formPrefill.value = prefill;
  formOpen.value = true;
}

/** 键盘按方向切换聚焦面板（拖拽换位置的键盘替代） */
function focusNeighbor(dir: NavDir) {
  const cur = terminals.activeSession?.id;
  if (!cur) return;
  const next = neighborPane(cur, dir);
  if (!next) return;
  terminals.focusSession(next);
  getTerm(next)?.term.focus();
}

/** 原生菜单项（含 ⌘W/⌘T/⌘K 等加速键）统一从这里分发 */
function handleMenu(id: string) {
  switch (id) {
    case "new-local-terminal":
      terminals.openLocal();
      break;
    case "close-tab":
      terminals.closeActive();
      break;
    case "clear-terminal":
      getTerm(terminals.activeSession?.id)?.term.clear();
      break;
    case "split-right":
      terminals.split("row");
      break;
    case "split-down":
      terminals.split("col");
      break;
    case "focus-pane-left":
    case "focus-pane-right":
    case "focus-pane-up":
    case "focus-pane-down":
      focusNeighbor(id.slice("focus-pane-".length) as NavDir);
      break;
    case "zoom-in":
      settings.zoom(1);
      break;
    case "zoom-out":
      settings.zoom(-1);
      break;
    case "zoom-reset":
      settings.resetZoom();
      break;
    case "settings":
      settings.show();
      break;
    case "check-update":
      updater.checkForUpdates({ manual: true });
      break;
    case "open-homepage":
      openUrl(HOMEPAGE_URL).catch(() => {});
      break;
    case "open-issues":
      openUrl(`${HOMEPAGE_URL}/issues`).catch(() => {});
      break;
    case "toggle-sidebar":
      settings.toggleSidebar();
      break;
    case "new-host":
      openCreate();
      break;
    case "probe-all":
      store.probeAllServers();
      break;
    case "privacy":
      store.togglePrivacy();
      break;
    case "palette":
      paletteOpen.value = true;
      break;
    case "local-console":
      terminals.showDetails();
      store.view = "console";
      break;
    case "next-tab":
      terminals.cycle(1);
      break;
    case "prev-tab":
      terminals.cycle(-1);
      break;
    case "find":
      getTerm(terminals.activeSession?.id)?.ui.toggleSearch?.();
      break;
    case "reload-config":
      store.load();
      break;
  }
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}

const anyModalOpen = () =>
  formOpen.value ||
  commands.resultsOpen ||
  commands.managerOpen ||
  commands.batchOpen ||
  cloud.modalOpen;

/** mac ⌘1–9 / 其它平台 Alt+1–9 切换到对应标签；ESC 退出详情回到首页 */
function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    if (isTyping(e) || anyModalOpen() || terminals.activeId !== null) return;
    if (store.view === "candidates" || store.view === "console") store.view = "hosts";
    else if (store.selectedId) store.selectedId = null;
    return;
  }
  if (!isTabModifier(e)) return;
  if (/^[1-9]$/.test(e.key)) {
    terminals.activateIndex(Number(e.key) - 1);
    e.preventDefault();
  }
}

let unlistenMenu: UnlistenFn | null = null;
let unlistenDrop: UnlistenFn | null = null;

/** 拖放坐标（物理像素）命中的终端面板 */
function paneAt(x: number, y: number): string | null {
  const scale = window.devicePixelRatio || 1;
  const el = document.elementFromPoint(x / scale, y / scale)?.closest<HTMLElement>(".term-wrap[data-session-id]");
  return el?.dataset.sessionId ?? null;
}

/** 子组件渲染出错时不让整块界面悄悄消失：显示横幅 + 一键重载 */
const uiError = ref<string | null>(null);
const paletteOpen = ref(false);
const reloadUi = () => window.location.reload();
onErrorCaptured((err) => {
  uiError.value = err instanceof Error ? err.message : String(err);
  return true;
});

onMounted(async () => {
  shortcuts.load().catch(() => {});
  await store.load();
  // 恢复上次勾选了"自动上传"的联动组
  files.resumeWatchers().catch(() => {});
  if (settings.prefs.probeOnStart) store.probeAllServers();
  // 启动 5 秒后静默检查一次新版本；dev 构建没有可比对的发布版本，跳过
  if (settings.prefs.autoCheckUpdate && !import.meta.env.DEV) {
    setTimeout(() => updater.checkForUpdates({ manual: false }), 5000);
  }
  window.addEventListener("keydown", handleKeydown);
  unlistenMenu = await listen<string>("menu", (e) => handleMenu(e.payload));
  // 文件拖到终端面板上 → 粘路径；文件管理标签有自己的上传处理（按 active 守卫），这里只管终端标签
  unlistenDrop = await getCurrentWebview().onDragDropEvent((ev) => {
    if (terminals.activeTab?.kind !== "terminal") {
      terminals.dropHoverSessionId = null;
      return;
    }
    const p = ev.payload;
    if (p.type === "enter" || p.type === "over") {
      terminals.dropHoverSessionId = paneAt(p.position.x, p.position.y);
    } else if (p.type === "leave") {
      terminals.dropHoverSessionId = null;
    } else if (p.type === "drop") {
      const id = paneAt(p.position.x, p.position.y);
      terminals.dropHoverSessionId = null;
      if (id && p.paths.length) getTerm(id)?.ui.pastePaths?.(p.paths);
    }
  });
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleKeydown);
  unlistenMenu?.();
  unlistenDrop?.();
});
</script>

<template>
  <div class="shell">
    <div v-if="uiError" class="ui-error">
      <span class="mono">界面出错：{{ uiError }}</span>
      <n-button size="tiny" type="primary" @click="reloadUi">重新加载界面</n-button>
      <n-button size="tiny" quaternary @click="uiError = null">忽略</n-button>
    </div>
    <TerminalTabs />
    <div class="body">
      <SideRail />
      <SidePanel v-show="!settings.prefs.sidebarCollapsed">
        <HostsPanel v-if="settings.prefs.sidebarPanel === 'hosts'" @create="openCreate" @edit="openEdit" />
        <CommandPanel v-else />
      </SidePanel>
      <main class="main">
        <div class="content">
          <div v-show="terminals.activeId === null" class="details">
            <n-alert
              v-if="store.error"
              type="error"
              title="读取 SSH 配置失败"
              closable
              class="main-alert"
              @close="store.error = null"
            >
              {{ store.error }}
            </n-alert>
            <CandidatesPanel v-if="store.view === 'candidates'" @adopt="openAdopt" />
            <LocalConsole v-else-if="store.view === 'console'" />
            <HostDetail v-else-if="store.selected" :host="store.selected" @edit="openEdit" />
            <div v-else class="welcome">
              <div class="welcome-icon"><Server :size="40" :stroke-width="1.5" /></div>
              <h2>ApexTerm</h2>
              <p class="muted">
                已从 <span class="mono">{{ store.configPath || "~/.ssh/config" }}</span> 读取
                <b>{{ store.servers.length }}</b> 台服务器、
                <b>{{ store.gitHosts.length }}</b> 个 Git 平台、
                <b>{{ store.patternHosts.length }}</b> 条通配规则
                <template v-if="store.files.length > 1">（含 {{ store.files.length - 1 }} 个 Include 文件）</template>
              </p>
              <p v-if="store.activeCandidates.length" class="muted">
                另外发现 <b>{{ store.activeCandidates.length }}</b> 台连过但没进 config 的机器，
                <a class="link" @click="store.view = 'candidates'">去候选区看看</a>
              </p>
              <p class="muted">左侧单击看详情，双击直接连接；也可以：</p>
              <div class="welcome-actions">
                <n-button type="primary" secondary @click="openCreate">
                  <template #icon><Plus :size="16" /></template>
                  添加服务器
                </n-button>
                <n-button secondary @click="terminals.openLocal()">
                  <template #icon><TerminalSquare :size="16" /></template>
                  打开本地终端
                  <span class="kbd">{{ appShortcut("t") }}</span>
                </n-button>
                <n-button secondary @click="store.view = 'console'">
                  <template #icon><Laptop :size="16" /></template>
                  本机控制台
                  <span class="kbd">{{ appShortcut("shift+l") }}</span>
                </n-button>
              </div>
            </div>
          </div>

          <template v-for="t in terminals.tabs" :key="t.id">
            <div v-show="terminals.activeId === t.id" class="tab-body">
              <PaneLayout
                v-if="t.kind === 'terminal' && t.layout"
                :tab="t"
                :node="t.layout"
                :visible="terminals.activeId === t.id"
              />
              <FilesView v-else-if="t.kind === 'files' && t.hostId" :tab="t" :active="terminals.activeId === t.id" />
            </div>
          </template>
        </div>
      </main>
    </div>
    <HostForm v-model:show="formOpen" :host="formHost" :prefill="formPrefill" />
    <RunResultsModal />
    <SnippetManager />
    <BatchRunModal />
    <CloudAccountsModal />
    <SettingsModal />
    <EditContextMenu />
    <CommandPalette v-model:show="paletteOpen" />
    <UpdateDialog />
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
}

.body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  position: relative;
  background: var(--bg);
}

.content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}

.details {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding-top: 16px;
}

.tab-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.ui-error {
  position: fixed;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 20000;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: min(90vw, 720px);
  padding: 8px 14px;
  border-radius: 10px;
  background: rgba(229, 97, 91, 0.16);
  border: 1px solid rgba(229, 97, 91, 0.4);
  color: var(--red-text);
  font-size: 12px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
}

.ui-error .mono {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.main-alert {
  margin: 0 20px 12px;
}

.welcome {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 40px;
  text-align: center;
}

.welcome-icon {
  width: 84px;
  height: 84px;
  border-radius: 24px;
  display: grid;
  place-items: center;
  background: var(--accent-soft);
  color: var(--accent);
  margin-bottom: 8px;
}

.welcome h2 {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  letter-spacing: 0.2px;
}

.welcome p {
  margin: 0;
  max-width: 520px;
  line-height: 1.7;
}

.welcome b {
  color: var(--text-1);
  font-weight: 600;
}

.welcome-actions {
  display: flex;
  gap: 10px;
  margin-top: 6px;
}

.kbd {
  margin-left: 6px;
  font-size: 11px;
  opacity: 0.6;
}

.link {
  color: var(--accent);
  cursor: pointer;
}

.link:hover {
  text-decoration: underline;
}
</style>
