import { computed, ref, watch } from "vue";
import { acceptHMRUpdate, defineStore } from "pinia";
import { DEFAULT_THEME_ID, FONT_OPTIONS, presetById, toXtermTheme, type TermTheme } from "../themes";
import { setTooltipDelay } from "../tooltip";

export type AppTheme = "dark" | "light" | "system";
export type SettingsSection = "terminal" | "themes" | "shortcuts" | "files" | "ui" | "about";
export type SidebarPanel = "hosts" | "commands";
export const SIDEBAR_MIN = 240;
export const SIDEBAR_MAX = 480;
export const SIDEBAR_DEFAULT = 300;

export interface Prefs {
  // ---- 终端外观 ----
  /** 预设 id；custom 表示在预设基础上手改过配色 */
  themeId: string;
  customTheme: TermTheme | null;
  favoriteThemes: string[];
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: "bar" | "block" | "underline";
  cursorBlink: boolean;
  /** 光标颜色跟随文字颜色，而不用主题自带的光标色 */
  cursorFollowsForeground: boolean;
  /** 可读性增强：自动把对比度过低的 ANSI 颜色推到可读范围（注释灰 ≥ 4:1，彩色 ≥ 3:1） */
  boostReadability: boolean;
  // ---- 终端行为 ----
  scrollback: number;
  copyOnSelect: boolean;
  /** 复制时把 TUI 按终端宽度截断的长行接回一行（见 copyReflow.ts） */
  copyReflow: boolean;
  rightClickPaste: boolean;
  bellSound: boolean;
  optionAsMeta: boolean;
  brightBold: boolean;
  autoReconnect: boolean;
  termType: string;
  // ---- 界面 ----
  appTheme: AppTheme;
  tooltipDelay: number;
  probeOnStart: boolean;
  /** 启动后静默检查一次新版本（GitHub Releases） */
  autoCheckUpdate: boolean;
  // ---- 文件 ----
  showHidden: boolean;
  defaultLocalDir: string;
  doubleClickTransfer: boolean;
  // ---- 侧栏 ----
  sidebarCollapsed: boolean;
  sidebarPanel: SidebarPanel;
  sidebarWidth: number;
  /** 快捷命令面板里展开的分组（默认全部收起），键为 `模式:分组名` */
  commandGroupsExpanded: string[];
  /** 快捷命令面板里分组的自定义顺序，按模式分开；不在列表里的分组按默认顺序排在后面 */
  commandGroupOrder: { local: string[]; host: string[] };
}

const KEY = "apexterm.prefs";
export const FONT_MIN = 9;
export const FONT_MAX = 28;

export const DEFAULTS: Prefs = {
  themeId: DEFAULT_THEME_ID,
  customTheme: null,
  favoriteThemes: [],
  fontFamily: FONT_OPTIONS[0],
  fontSize: 13,
  lineHeight: 1.2,
  cursorStyle: "bar",
  cursorBlink: true,
  cursorFollowsForeground: false,
  boostReadability: true,
  scrollback: 10000,
  copyOnSelect: false,
  copyReflow: true,
  rightClickPaste: false,
  bellSound: false,
  optionAsMeta: true,
  brightBold: false,
  autoReconnect: true,
  termType: "xterm-256color",
  appTheme: "dark",
  tooltipDelay: 150,
  probeOnStart: false,
  autoCheckUpdate: true,
  showHidden: true,
  defaultLocalDir: "",
  doubleClickTransfer: true,
  sidebarCollapsed: false,
  sidebarPanel: "hosts",
  sidebarWidth: SIDEBAR_DEFAULT,
  commandGroupsExpanded: [],
  commandGroupOrder: { local: [], host: [] },
};

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const p = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) };
    p.favoriteThemes = [...new Set(p.favoriteThemes)];
    return p;
  } catch {
    return { ...DEFAULTS };
  }
}

function systemDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
}

export const useSettingsStore = defineStore("settings", () => {
  const prefs = ref<Prefs>(load());
  const open = ref(false);
  const section = ref<SettingsSection>("terminal");
  const systemIsDark = ref(systemDark());

  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    systemIsDark.value = e.matches;
  });

  watch(prefs, (v) => localStorage.setItem(KEY, JSON.stringify(v)), { deep: true });
  watch(() => prefs.value.tooltipDelay, (ms) => setTooltipDelay(ms), { immediate: true });

  /** 应用（非终端）是否深色 */
  const appDark = computed(() =>
    prefs.value.appTheme === "system" ? systemIsDark.value : prefs.value.appTheme === "dark",
  );
  watch(appDark, (dark) => document.documentElement.classList.toggle("light", !dark), { immediate: true });

  /** 当前实际生效的终端配色 */
  const theme = computed<TermTheme>(() =>
    prefs.value.themeId === "custom" && prefs.value.customTheme
      ? prefs.value.customTheme
      : presetById(prefs.value.themeId).theme,
  );

  /** 交给 xterm 的最终配色（含选区透明度、光标跟随等处理） */
  const xtermTheme = computed(() =>
    toXtermTheme(theme.value, {
      cursorFollowsForeground: prefs.value.cursorFollowsForeground,
      boostReadability: prefs.value.boostReadability,
    }),
  );

  /** 当前基于哪个预设（custom 时记住来源，用于显示） */
  const baseThemeId = ref(prefs.value.themeId === "custom" ? DEFAULT_THEME_ID : prefs.value.themeId);

  function setPreset(id: string) {
    baseThemeId.value = id;
    prefs.value = { ...prefs.value, themeId: id, customTheme: null };
  }

  /** 改某个颜色：自动切到 custom，基于当前配色复制一份再改 */
  function setColor(key: keyof TermTheme, value: string) {
    prefs.value = { ...prefs.value, themeId: "custom", customTheme: { ...theme.value, [key]: value } };
  }

  function toggleFavoriteTheme(id: string) {
    const list = prefs.value.favoriteThemes;
    prefs.value = {
      ...prefs.value,
      favoriteThemes: list.includes(id) ? list.filter((x) => x !== id) : [...list, id],
    };
  }

  function patch(p: Partial<Prefs>) {
    prefs.value = { ...prefs.value, ...p };
  }

  function zoom(delta: number) {
    const size = Math.min(FONT_MAX, Math.max(FONT_MIN, prefs.value.fontSize + delta));
    prefs.value = { ...prefs.value, fontSize: size };
  }

  function resetZoom() {
    prefs.value = { ...prefs.value, fontSize: DEFAULTS.fontSize };
  }

  function resetAll() {
    prefs.value = { ...DEFAULTS };
  }

  function show(sec?: SettingsSection) {
    if (sec) section.value = sec;
    open.value = true;
  }

  // ---- 侧栏 ----
  function toggleSidebar() {
    prefs.value = { ...prefs.value, sidebarCollapsed: !prefs.value.sidebarCollapsed };
  }

  /** 图标栏点击：点当前面板 = 收起，点其它 = 展开并切换 */
  function showPanel(p: SidebarPanel) {
    const same = prefs.value.sidebarPanel === p && !prefs.value.sidebarCollapsed;
    prefs.value = { ...prefs.value, sidebarPanel: p, sidebarCollapsed: same };
  }

  /** 展开并切到指定面板（命令面板 / 快捷键用，不做收起切换） */
  function openPanel(p: SidebarPanel) {
    prefs.value = { ...prefs.value, sidebarPanel: p, sidebarCollapsed: false };
  }

  function setSidebarWidth(w: number) {
    prefs.value = { ...prefs.value, sidebarWidth: Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w))) };
  }

  function toggleCommandGroup(key: string) {
    const list = prefs.value.commandGroupsExpanded;
    prefs.value = {
      ...prefs.value,
      commandGroupsExpanded: list.includes(key) ? list.filter((x) => x !== key) : [...list, key],
    };
  }

  /** 全部展开 / 全部收起：只影响传入的这一组键（当前模式下的分组） */
  function setCommandGroupsExpanded(keys: string[], expanded: boolean) {
    const rest = prefs.value.commandGroupsExpanded.filter((x) => !keys.includes(x));
    prefs.value = { ...prefs.value, commandGroupsExpanded: expanded ? [...rest, ...keys] : rest };
  }

  function setCommandGroupOrder(mode: "local" | "host", order: string[]) {
    prefs.value = { ...prefs.value, commandGroupOrder: { ...prefs.value.commandGroupOrder, [mode]: order } };
  }

  return {
    prefs,
    open,
    section,
    appDark,
    theme,
    xtermTheme,
    baseThemeId,
    setPreset,
    setColor,
    toggleFavoriteTheme,
    patch,
    zoom,
    resetZoom,
    resetAll,
    show,
    toggleSidebar,
    showPanel,
    openPanel,
    setSidebarWidth,
    toggleCommandGroup,
    setCommandGroupsExpanded,
    setCommandGroupOrder,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSettingsStore, import.meta.hot));
}
