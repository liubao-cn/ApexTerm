<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import {
  NButton,
  NColorPicker,
  NInput,
  NInputNumber,
  NModal,
  NRadioButton,
  NRadioGroup,
  NScrollbar,
  NSelect,
  NSlider,
  NSwitch,
  NTag,
  useMessage,
} from "naive-ui";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  FolderOpen,
  Info,
  Keyboard,
  Monitor,
  Palette,
  RotateCcw,
  Search,
  Star,
  Terminal,
} from "lucide-vue-next";
import {
  ANSI_KEYS,
  FONT_OPTIONS,
  TERM_TYPES,
  THEME_PRESETS,
  isDark,
  minContrast,
  presetById,
  type TermTheme,
  type TermThemePreset,
} from "../themes";
import { CURATED_IDS, THEME_FAMILIES } from "../themeCatalog";
import { FONT_MAX, FONT_MIN, useSettingsStore, type SettingsSection, type TermProgram } from "../stores/settings";
import { useShortcutsStore } from "../stores/shortcuts";
import { useHostsStore } from "../stores/hosts";
import { useUpdaterStore } from "../stores/updater";
import { accelFromEvent, accelLabel, appShortcut, fileManagerName, isMac } from "../platform";
import { errorText } from "../api";

const settings = useSettingsStore();
const shortcuts = useShortcutsStore();
const hosts = useHostsStore();
const updater = useUpdaterStore();
const message = useMessage();

const p = computed(() => settings.prefs);
const theme = computed(() => settings.theme);

const sections: { id: SettingsSection; label: string; icon: typeof Terminal }[] = [
  { id: "terminal", label: "终端", icon: Terminal },
  { id: "themes", label: "配色主题", icon: Palette },
  { id: "shortcuts", label: "快捷键", icon: Keyboard },
  { id: "files", label: "文件传输", icon: FolderOpen },
  { id: "ui", label: "界面", icon: Monitor },
  { id: "about", label: "关于", icon: Info },
];

onMounted(() => shortcuts.load().catch(() => {}));

// ---- 字体 ----
const fontOptions = computed(() => {
  const list = FONT_OPTIONS.map((f) => ({ label: f.split(",")[0].replace(/"/g, ""), value: f }));
  if (!FONT_OPTIONS.includes(p.value.fontFamily)) {
    list.unshift({ label: p.value.fontFamily.split(",")[0].replace(/"/g, ""), value: p.value.fontFamily });
  }
  return list;
});
const termTypeOptions = TERM_TYPES.map((t) => ({ label: t, value: t }));
const termProgramOptions: { label: string; value: TermProgram }[] = [
  { label: "ApexTerm（如实）", value: "apexterm" },
  { label: "iTerm2 兼容", value: "iterm" },
  { label: "VS Code 兼容", value: "vscode" },
];

// ---- 主题库：精选按家族分组展示；600+ 完整库收在「全部」里搜索 ----
type Filter = "featured" | "dark" | "light" | "favorites" | "all";
const filter = ref<Filter>("featured");
const query = ref("");
const filters: { key: Filter; label: string }[] = [
  { key: "featured", label: "精选" },
  { key: "dark", label: "深色" },
  { key: "light", label: "浅色" },
  { key: "favorites", label: "收藏" },
  { key: "all", label: `全部 ${THEME_PRESETS.length}` },
];

interface Card extends TermThemePreset {
  dark: boolean;
  /** 正文与基础彩色的最低对比度 ≥ 4.5 → 打「高对比」标签 */
  highContrast: boolean;
  label?: string;
}
const toCard = (t: TermThemePreset, label?: string): Card => ({
  ...t,
  dark: isDark(t.theme),
  highContrast: minContrast(t.theme) >= 4.5,
  label,
});

/** 家族视图（精选 / 深色 / 浅色） */
const familyView = computed(() => {
  if (filter.value === "favorites" || filter.value === "all") return null;
  return THEME_FAMILIES.map((f) => ({
    name: f.name,
    desc: f.desc,
    cards: f.variants
      .map((v) => toCard(presetById(v.id), v.label))
      .filter((c) => filter.value === "featured" || (filter.value === "dark" ? c.dark : !c.dark)),
  })).filter((f) => f.cards.length);
});

/** 平铺视图（收藏 / 全部 / 搜索） */
const flatCards = computed<Card[]>(() => {
  const q = query.value.trim().toLowerCase();
  const fav = new Set(p.value.favoriteThemes);
  return THEME_PRESETS.filter((t) => {
    if (q && !t.name.toLowerCase().includes(q) && !t.id.includes(q)) return false;
    return filter.value === "favorites" ? fav.has(t.id) : true;
  }).map((t) => toCard(t));
});

const curatedCount = CURATED_IDS.size;
const activePresetId = computed(() => (p.value.themeId === "custom" ? settings.baseThemeId : p.value.themeId));
/** 当前主题不在精选里时给个提示，方便找到它 */
const activeOutsideCurated = computed(
  () => !CURATED_IDS.has(activePresetId.value) && filter.value === "featured",
);

watch(query, (q) => {
  if (q && filter.value !== "favorites") filter.value = "all";
});

const showColorEditor = ref(false);
const baseColors: { key: keyof TermTheme; label: string }[] = [
  { key: "background", label: "背景" },
  { key: "foreground", label: "文字" },
  { key: "cursor", label: "光标" },
  { key: "selectionBackground", label: "选区" },
];

// ---- 快捷键录制 ----
const recording = ref<string | null>(null);
function startRecord(id: string) {
  recording.value = id;
  window.addEventListener("keydown", onRecordKey, { capture: true });
}
function stopRecord() {
  recording.value = null;
  window.removeEventListener("keydown", onRecordKey, { capture: true });
}
async function onRecordKey(e: KeyboardEvent) {
  e.preventDefault();
  e.stopPropagation();
  const id = recording.value;
  if (!id) return;
  if (e.key === "Escape") return stopRecord();
  if (e.key === "Backspace" || e.key === "Delete") {
    stopRecord();
    await shortcuts.set(id, "");
    return;
  }
  const accel = accelFromEvent(e);
  if (!accel) return; // 只按了修饰键，继续等
  stopRecord();
  const clash = shortcuts.conflicts(id, accel);
  if (clash.length) message.warning(`与「${clash.map((c) => c.label).join("、")}」冲突，已同时保存，请调整其一`);
  try {
    await shortcuts.set(id, accel);
  } catch (err) {
    message.error(errorText(err));
  }
}
const shortcutGroups = computed(() => {
  const groups = new Map<string, typeof shortcuts.defs>();
  for (const d of shortcuts.defs) {
    if (!groups.has(d.group)) groups.set(d.group, []);
    groups.get(d.group)!.push(d);
  }
  return [...groups.entries()];
});
const fixedShortcuts = [
  { label: "切换到第 N 个标签", keys: isMac ? "⌘1 … ⌘9" : "Alt+1 … Alt+9" },
  { label: "回到主机列表 / 取消选中", keys: "ESC" },
  { label: "复制 / 粘贴（终端内）", keys: isMac ? "⌘C / ⌘V" : "Ctrl+Shift+C / Ctrl+Shift+V" },
  { label: "侧栏主机：连接", keys: "双击" },
  { label: "侧栏主机：在当前标签分屏打开", keys: "⌥ + 双击" },
];

// ---- 文件 ----
async function pickDefaultDir() {
  const picked = await openDialog({ directory: true, multiple: false, defaultPath: p.value.defaultLocalDir || undefined });
  if (typeof picked === "string") settings.patch({ defaultLocalDir: picked });
}

// ---- 关于 ----
function revealData() {
  const path = shortcuts.info?.metaPath;
  if (path) revealItemInDir(path).catch((e) => message.error(errorText(e)));
}
</script>

<template>
  <n-modal v-model:show="settings.open" preset="card" title="设置" class="settings-modal" style="width: 960px; max-width: calc(100vw - 32px)">
    <div class="layout">
      <nav class="nav">
        <button
          v-for="s in sections"
          :key="s.id"
          class="nav-item"
          :class="{ active: settings.section === s.id }"
          @click="settings.section = s.id"
        >
          <component :is="s.icon" :size="15" />
          {{ s.label }}
        </button>
        <div class="nav-spacer"></div>
        <button class="nav-item reset" @click="settings.resetAll()">
          <RotateCcw :size="13" />
          全部恢复默认
        </button>
      </nav>

      <n-scrollbar class="content-scroll">
        <div class="content">
          <!-- ================= 终端 ================= -->
          <template v-if="settings.section === 'terminal'">
            <h2>终端</h2>
            <section class="card">
              <div class="row">
                <div class="row-label">字体</div>
                <n-select :value="p.fontFamily" :options="fontOptions" filterable tag size="small" style="max-width: 320px" @update:value="(v: string) => settings.patch({ fontFamily: v })" />
              </div>
              <div class="row">
                <div class="row-label">字号 <span class="muted">{{ p.fontSize }}px</span></div>
                <div class="stepper">
                  <n-button size="small" secondary @click="settings.zoom(-1)">−</n-button>
                  <n-input-number :value="p.fontSize" :min="FONT_MIN" :max="FONT_MAX" size="small" :show-button="false" style="width: 64px" @update:value="(v: number | null) => v && settings.patch({ fontSize: v })" />
                  <n-button size="small" secondary @click="settings.zoom(1)">+</n-button>
                  <span class="muted small">{{ appShortcut("=") }} / {{ appShortcut("-") }} / {{ appShortcut("0") }}</span>
                </div>
              </div>
              <div class="row">
                <div class="row-label">行高 <span class="muted">{{ p.lineHeight.toFixed(2) }}</span></div>
                <n-slider :value="p.lineHeight" :min="1" :max="1.6" :step="0.05" style="max-width: 320px" @update:value="(v: number) => settings.patch({ lineHeight: v })" />
              </div>
              <div class="row">
                <div class="row-label">光标</div>
                <div class="inline">
                  <n-radio-group :value="p.cursorStyle" size="small" @update:value="(v: 'bar' | 'block' | 'underline') => settings.patch({ cursorStyle: v })">
                    <n-radio-button value="bar">竖线</n-radio-button>
                    <n-radio-button value="block">方块</n-radio-button>
                    <n-radio-button value="underline">下划线</n-radio-button>
                  </n-radio-group>
                  <label class="opt"><n-switch size="small" :value="p.cursorBlink" @update:value="(v: boolean) => settings.patch({ cursorBlink: v })" /> 闪烁</label>
                </div>
              </div>
              <div class="row">
                <div class="row-label">光标颜色</div>
                <div class="inline">
                  <n-radio-group :value="p.cursorFollowsForeground ? 'fg' : 'theme'" size="small" @update:value="(v: string) => settings.patch({ cursorFollowsForeground: v === 'fg' })">
                    <n-radio-button value="theme">用主题自带的光标色</n-radio-button>
                    <n-radio-button value="fg">跟随文字颜色</n-radio-button>
                  </n-radio-group>
                  <span class="cursor-swatch" :style="{ background: p.cursorFollowsForeground ? theme.foreground : theme.cursor }"></span>
                  <span class="muted small">不少主题的光标色很跳（如 Cyberpunk 是薄荷绿），不喜欢就选跟随文字</span>
                </div>
              </div>
              <div class="row">
                <div class="row-label">回滚行数 <span class="muted">{{ p.scrollback.toLocaleString() }}</span></div>
                <n-slider :value="p.scrollback" :min="1000" :max="100000" :step="1000" style="max-width: 320px" @update:value="(v: number) => settings.patch({ scrollback: v })" />
              </div>
              <div class="row">
                <div class="row-label">终端类型 <span class="muted">TERM</span></div>
                <n-select :value="p.termType" :options="termTypeOptions" size="small" style="max-width: 220px" @update:value="(v: string) => settings.patch({ termType: v })" />
              </div>
              <div class="row">
                <div class="row-label">
                  自报终端身份 <span class="muted">TERM_PROGRAM</span>
                  <div class="muted small" style="font-weight: 400; margin-top: 2px">
                    Devin CLI 等工具只给名单里的终端发纯超链接，否则会把百分号编码的 URL 打印在链接后面。选「iTerm2 兼容」可去掉；只影响新开的终端。
                  </div>
                </div>
                <n-select :value="p.termProgram" :options="termProgramOptions" size="small" style="max-width: 220px" @update:value="(v: TermProgram) => settings.patch({ termProgram: v })" />
              </div>
            </section>

            <section class="card">
              <div class="toggle">
                <div><b>断线自动重连</b><div class="muted small">连接意外断开（非正常 exit）时自动重连，最多 5 次，按任意键取消</div></div>
                <n-switch :value="p.autoReconnect" @update:value="(v: boolean) => settings.patch({ autoReconnect: v })" />
              </div>
              <div class="toggle">
                <div><b>选中即复制</b><div class="muted small">鼠标选中文本后自动复制到剪贴板</div></div>
                <n-switch :value="p.copyOnSelect" @update:value="(v: boolean) => settings.patch({ copyOnSelect: v })" />
              </div>
              <div class="toggle">
                <div><b>复制时接回被截断的长行</b><div class="muted small">Claude Code / Devin CLI 这类工具按终端宽度自己换行，复制出来会带一堆多余换行；开启后按"上一行写满 / 下一行首词放不下"判断并接回一行。需要原样复制时用右键菜单「复制（保留换行）」</div></div>
                <n-switch :value="p.copyReflow" @update:value="(v: boolean) => settings.patch({ copyReflow: v })" />
              </div>
              <div class="toggle">
                <div><b>右键粘贴</b><div class="muted small">开启后右键直接粘贴（有选中文本则复制）；右键菜单改为 ⇧ + 右键</div></div>
                <n-switch :value="p.rightClickPaste" @update:value="(v: boolean) => settings.patch({ rightClickPaste: v })" />
              </div>
              <div class="toggle">
                <div><b>响铃提示音</b><div class="muted small">远端输出 BEL 字符（如 tab 补全失败）时播放短促提示音</div></div>
                <n-switch :value="p.bellSound" @update:value="(v: boolean) => settings.patch({ bellSound: v })" />
              </div>
              <div v-if="isMac" class="toggle">
                <div><b>Option 作为 Meta 键</b><div class="muted small">⌥+字母 发送 Alt 组合（如 ⌥B/⌥F 按单词移动）；关闭则输入特殊字符</div></div>
                <n-switch :value="p.optionAsMeta" @update:value="(v: boolean) => settings.patch({ optionAsMeta: v })" />
              </div>
              <div class="toggle">
                <div><b>粗体使用亮色</b><div class="muted small">加粗文字用 ANSI 亮色渲染（传统终端行为）</div></div>
                <n-switch :value="p.brightBold" @update:value="(v: boolean) => settings.patch({ brightBold: v })" />
              </div>
            </section>
          </template>

          <!-- ================= 配色主题 ================= -->
          <template v-else-if="settings.section === 'themes'">
            <h2>配色主题 <span class="muted count">精选 {{ curatedCount }} 套 · 库 {{ THEME_PRESETS.length }} 套</span></h2>
            <div class="theme-tools">
              <div class="chips">
                <button v-for="f in filters" :key="f.key" class="chip" :class="{ active: filter === f.key }" @click="filter = f.key">{{ f.label }}</button>
              </div>
              <n-input v-model:value="query" size="small" placeholder="搜索全部主题…" clearable style="max-width: 220px">
                <template #prefix><Search :size="13" class="muted" /></template>
              </n-input>
            </div>
            <p v-if="activeOutsideCurated" class="muted small hint-row">
              当前使用的「{{ presetById(activePresetId).name }}」不在精选里，可在「全部」中搜索到它。
            </p>

            <!-- 家族视图 -->
            <template v-if="familyView">
              <section v-for="f in familyView" :key="f.name" class="family">
                <div class="family-head">
                  <span class="family-name">{{ f.name }}</span>
                  <span class="muted small">{{ f.desc }}</span>
                </div>
                <div class="theme-grid compact">
                  <div
                    v-for="c in f.cards"
                    :key="c.id"
                    class="theme-card"
                    :class="{ active: activePresetId === c.id }"
                    :style="{ background: c.theme.background, color: c.theme.foreground }"
                    @click="settings.setPreset(c.id)"
                  >
                    <div class="tc-preview mono">
                      <div><span :style="{ color: c.theme.green }">❯</span> <span :style="{ color: c.theme.blue }">claude</span> <span :style="{ color: c.theme.brightBlack }"># 注释</span></div>
                      <div>
                        <span :style="{ color: c.theme.yellow }">warn</span> <span :style="{ color: c.theme.red }">error</span> <span :style="{ color: c.theme.cyan }">info</span> <span :style="{ color: c.theme.magenta }">*</span>
                        <span class="tc-cursor" :style="{ background: p.cursorFollowsForeground ? c.theme.foreground : c.theme.cursor }"></span>
                      </div>
                    </div>
                    <div class="tc-foot">
                      <span class="tc-name">{{ c.label ?? c.name }}</span>
                      <span class="tc-tags">
                        <span v-if="activePresetId === c.id && p.themeId === 'custom'" class="tc-tag">已微调</span>
                        <span v-if="c.highContrast" class="tc-tag">高对比</span>
                        <span class="tc-tag">{{ c.dark ? "深" : "浅" }}</span>
                      </span>
                      <button class="tc-star" :class="{ on: p.favoriteThemes.includes(c.id) }" v-tip="'收藏'" @click.stop="settings.toggleFavoriteTheme(c.id)">
                        <Star :size="12" :fill="p.favoriteThemes.includes(c.id) ? 'currentColor' : 'none'" />
                      </button>
                    </div>
                  </div>
                </div>
              </section>
              <div v-if="familyView.length === 0" class="muted empty">没有匹配的主题</div>
            </template>

            <!-- 平铺视图：收藏 / 全部 -->
            <div v-else class="theme-grid">
              <div
                v-for="c in flatCards"
                :key="c.id"
                class="theme-card"
                :class="{ active: activePresetId === c.id }"
                :style="{ background: c.theme.background, color: c.theme.foreground }"
                @click="settings.setPreset(c.id)"
              >
                <div class="tc-preview mono">
                  <div><span :style="{ color: c.theme.green }">❯</span> <span :style="{ color: c.theme.blue }">claude</span> <span :style="{ color: c.theme.brightBlack }"># 注释</span></div>
                  <div>
                    <span :style="{ color: c.theme.yellow }">warn</span> <span :style="{ color: c.theme.red }">error</span> <span :style="{ color: c.theme.cyan }">info</span> <span :style="{ color: c.theme.magenta }">*</span>
                    <span class="tc-cursor" :style="{ background: p.cursorFollowsForeground ? c.theme.foreground : c.theme.cursor }"></span>
                  </div>
                </div>
                <div class="tc-foot">
                  <span class="tc-name">{{ c.name }}</span>
                  <span class="tc-tags">
                    <span v-if="activePresetId === c.id && p.themeId === 'custom'" class="tc-tag">已微调</span>
                    <span v-if="c.highContrast" class="tc-tag">高对比</span>
                    <span class="tc-tag">{{ c.dark ? "深" : "浅" }}</span>
                  </span>
                  <button class="tc-star" :class="{ on: p.favoriteThemes.includes(c.id) }" v-tip="'收藏'" @click.stop="settings.toggleFavoriteTheme(c.id)">
                    <Star :size="12" :fill="p.favoriteThemes.includes(c.id) ? 'currentColor' : 'none'" />
                  </button>
                </div>
              </div>
              <div v-if="flatCards.length === 0" class="muted empty">{{ filter === "favorites" ? "还没有收藏，点卡片右下角的 ★" : "没有匹配的主题" }}</div>
            </div>

            <section class="card">
              <div class="toggle">
                <div><b>可读性增强</b><div class="muted small">自动把对比度过低的颜色推到可读范围：注释灰 ≥ 4:1、彩色 ≥ 3:1。Claude Code / Devin CLI 里的提示字不再看不清；关掉即恢复主题原味。</div></div>
                <n-switch :value="p.boostReadability" size="small" @update:value="(v: boolean) => settings.patch({ boostReadability: v })" />
              </div>
            </section>

            <section class="card">
              <div class="toggle" style="cursor: default" @click="showColorEditor = !showColorEditor">
                <div><b>微调当前主题的颜色</b><div class="muted small">改任意一格即变为"自定义"，点任意预设可恢复</div></div>
                <n-button size="tiny" quaternary>{{ showColorEditor ? "收起" : "展开" }}</n-button>
              </div>
              <template v-if="showColorEditor">
                <div class="colors">
                  <div v-for="c in baseColors" :key="c.key" class="color">
                    <n-color-picker :value="theme[c.key]" :show-alpha="c.key === 'selectionBackground'" size="small" :modes="['hex']" @update:value="(v: string) => settings.setColor(c.key, v)" />
                    <span>{{ c.label }}</span>
                  </div>
                </div>
                <div class="colors ansi">
                  <div v-for="c in ANSI_KEYS" :key="c.key" class="color">
                    <n-color-picker :value="theme[c.key]" :show-alpha="false" size="small" :modes="['hex']" @update:value="(v: string) => settings.setColor(c.key, v)" />
                    <span>{{ c.label }}</span>
                  </div>
                </div>
              </template>
            </section>
            <p class="muted small credit">主题库来自 iTerm2-Color-Schemes（MIT 许可）。所有打开的终端会实时应用。</p>
          </template>

          <!-- ================= 快捷键 ================= -->
          <template v-else-if="settings.section === 'shortcuts'">
            <h2>快捷键 <n-button size="tiny" quaternary style="margin-left: auto" @click="shortcuts.resetAll()">全部恢复默认</n-button></h2>
            <p class="muted small">点击右侧按键区，然后直接按下新的组合键；按 ⌫ 取消绑定，按 ESC 放弃修改。菜单栏会立即更新。</p>
            <section v-for="[group, defs] in shortcutGroups" :key="group" class="card">
              <h3>{{ group }}</h3>
              <div v-for="d in defs" :key="d.id" class="sc-row">
                <span class="sc-label">{{ d.label }}</span>
                <span v-if="shortcuts.resolved[d.id] !== d.default" class="muted small">默认 {{ accelLabel(d.default) }}</span>
                <button class="kbd" :class="{ recording: recording === d.id, empty: !shortcuts.resolved[d.id] }" @click="recording === d.id ? stopRecord() : startRecord(d.id)">
                  <template v-if="recording === d.id">请按下组合键…</template>
                  <template v-else>{{ shortcuts.label(d.id) || "未绑定" }}</template>
                </button>
                <n-button v-if="shortcuts.resolved[d.id] !== d.default" size="tiny" quaternary v-tip="'恢复默认'" @click="shortcuts.set(d.id, null)">
                  <template #icon><RotateCcw :size="12" /></template>
                </n-button>
              </div>
            </section>
            <section class="card">
              <h3>固定快捷键</h3>
              <div v-for="f in fixedShortcuts" :key="f.label" class="sc-row">
                <span class="sc-label">{{ f.label }}</span>
                <span class="kbd static">{{ f.keys }}</span>
              </div>
            </section>
          </template>

          <!-- ================= 文件传输 ================= -->
          <template v-else-if="settings.section === 'files'">
            <h2>文件传输</h2>
            <section class="card">
              <div class="row">
                <div class="row-label">默认本地目录</div>
                <div class="inline">
                  <n-input :value="p.defaultLocalDir" size="small" placeholder="留空 = 用户主目录" class="mono" style="max-width: 360px" @update:value="(v: string) => settings.patch({ defaultLocalDir: v })" />
                  <n-button size="small" secondary @click="pickDefaultDir">选择…</n-button>
                </div>
              </div>
              <div class="toggle">
                <div><b>显示隐藏文件</b><div class="muted small">以 . 开头的文件和文件夹</div></div>
                <n-switch :value="p.showHidden" @update:value="(v: boolean) => settings.patch({ showHidden: v })" />
              </div>
              <div class="toggle">
                <div><b>双击文件即传输</b><div class="muted small">双击左侧文件上传、右侧文件下载；关闭后双击仅选中</div></div>
                <n-switch :value="p.doubleClickTransfer" @update:value="(v: boolean) => settings.patch({ doubleClickTransfer: v })" />
              </div>
            </section>
            <section class="card">
              <h3>传输机制</h3>
              <ul class="muted small notes">
                <li>每台主机两条 SFTP 通道：浏览通道 + 传输通道；传输通道 32 个 64 KiB 请求并发在途，高延迟链路上比逐块传输快数倍。</li>
                <li>「压缩传输」按主机单独开关（在文件页顶部），文本类文件 + 窄带宽时开启，已压缩文件或内网时关闭。</li>
                <li>联动文件夹组的"自动上传"只镜像新增与修改，不镜像删除；忽略 .git、node_modules、临时文件。</li>
              </ul>
            </section>
          </template>

          <!-- ================= 界面 ================= -->
          <template v-else-if="settings.section === 'ui'">
            <h2>界面</h2>
            <section class="card">
              <div class="row">
                <div class="row-label">应用主题</div>
                <n-radio-group :value="p.appTheme" size="small" @update:value="(v: 'dark' | 'light' | 'system') => settings.patch({ appTheme: v })">
                  <n-radio-button value="dark">深色</n-radio-button>
                  <n-radio-button value="light">浅色</n-radio-button>
                  <n-radio-button value="system">跟随系统</n-radio-button>
                </n-radio-group>
              </div>
              <div class="row">
                <div class="row-label">提示出现延迟 <span class="muted">{{ p.tooltipDelay }}ms</span></div>
                <n-slider :value="p.tooltipDelay" :min="0" :max="800" :step="50" :marks="{ 0: '立即', 150: '默认', 800: '慢' }" style="max-width: 320px" @update:value="(v: number) => settings.patch({ tooltipDelay: v })" />
              </div>
            </section>
            <section class="card">
              <div class="toggle">
                <div><b>隐私模式</b><div class="muted small">把所有地址、IP、密钥名打码，方便截图</div></div>
                <n-switch :value="hosts.privacy" @update:value="() => hosts.togglePrivacy()" />
              </div>
              <div class="toggle">
                <div><b>启动时自动探测所有服务器</b><div class="muted small">打开程序就并发探测在线 / 免密状态（19 台约 5–10 秒）</div></div>
                <n-switch :value="p.probeOnStart" @update:value="(v: boolean) => settings.patch({ probeOnStart: v })" />
              </div>
            </section>
          </template>

          <!-- ================= 关于 ================= -->
          <template v-else>
            <h2>关于</h2>
            <section class="card about">
              <div class="about-head">
                <div class="logo"><Terminal :size="22" /></div>
                <div>
                  <div class="about-name">ApexTerm</div>
                  <div class="muted small">版本 {{ shortcuts.info?.version ?? "…" }} · {{ shortcuts.info?.platform ?? "" }}</div>
                </div>
              </div>
              <dl class="kv">
                <dt>SSH 配置</dt><dd class="mono selectable">{{ hosts.files.join(", ") || "~/.ssh/config" }}</dd>
                <dt>程序数据</dt><dd class="mono selectable">{{ shortcuts.info?.metaPath ?? "" }}</dd>
                <dt>密钥目录</dt><dd class="mono selectable">{{ shortcuts.info?.sshDir ?? "" }}</dd>
              </dl>
              <div class="inline">
                <n-button size="small" secondary @click="revealData">在 {{ fileManagerName }} 中显示数据文件</n-button>
                <n-button size="small" secondary @click="hosts.load()">重新读取 SSH 配置</n-button>
                <n-button size="small" secondary :loading="updater.phase === 'checking'" @click="updater.checkForUpdates({ manual: true })">检查更新</n-button>
              </div>
              <div class="toggle" style="margin-top: 14px">
                <div><b>启动时检查更新</b><div class="muted small">从 GitHub Releases 读取版本信息，有新版本才提示；下载的安装包会校验签名</div></div>
                <n-switch :value="p.autoCheckUpdate" @update:value="(v: boolean) => settings.patch({ autoCheckUpdate: v })" />
              </div>
              <p class="muted small" style="margin: 14px 0 0">
                所有主机信息以 <span class="mono">~/.ssh/config</span> 为唯一数据源；分组、备注、排序、联动组、快捷键等附加信息存在程序数据文件里；云账号密钥存在系统钥匙串。
              </p>
              <n-tag v-if="p.themeId === 'custom'" size="small" :bordered="false" style="margin-top: 10px">当前终端配色：自定义（基于 {{ settings.baseThemeId }}）</n-tag>
            </section>
          </template>
        </div>
      </n-scrollbar>
    </div>
  </n-modal>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: 168px minmax(0, 1fr);
  height: 72vh;
  min-height: 460px;
  margin: -8px -4px -12px;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 10px 6px 0;
  border-right: 1px solid var(--border);
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 12px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-2);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: default;
}

.nav-item:hover {
  background: var(--hover-2);
}

.nav-item.active {
  background: var(--accent-soft);
  color: var(--text-1);
  font-weight: 600;
}

.nav-spacer {
  flex: 1;
}

.nav-item.reset {
  font-size: 12px;
  color: var(--text-3);
}

.content-scroll {
  height: 100%;
}

.content {
  padding: 4px 6px 12px 20px;
}

h2 {
  margin: 4px 0 14px;
  font-size: 16px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 10px;
}

.count {
  font-size: 12px;
  font-weight: 400;
}

h3 {
  margin: 0 0 10px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--text-3);
}

.card {
  background: var(--panel-bg);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 14px 16px;
  margin-bottom: 14px;
}

.row {
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  padding: 8px 0;
}

.row + .row {
  border-top: 1px solid var(--border);
}

.row-label {
  font-size: 13px;
}

.inline {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.stepper {
  display: flex;
  align-items: center;
  gap: 6px;
}

.opt {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
}

.toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 0;
}

.toggle + .toggle {
  border-top: 1px solid var(--border);
}

.toggle b {
  font-weight: 600;
  font-size: 13px;
}

.small {
  font-size: 12px;
  line-height: 1.6;
}

/* 主题库 */
.theme-tools {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
}

.hint-row {
  margin: -4px 0 10px;
}

.family {
  margin-bottom: 16px;
}

.family-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 8px;
}

.family-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}

.theme-grid.compact {
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  margin-bottom: 0;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-2);
  font: inherit;
  font-size: 12px;
  cursor: default;
}

.chip:hover {
  background: var(--hover-2);
}

.chip.active {
  background: var(--accent-soft);
  border-color: rgba(91, 141, 239, 0.5);
  color: var(--text-1);
}

.theme-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}

.theme-card {
  border-radius: 10px;
  border: 2px solid transparent;
  padding: 10px 12px 8px;
  cursor: default;
  box-shadow: 0 0 0 1px var(--border) inset;
  transition: transform 0.1s;
}

.theme-card:hover {
  transform: translateY(-1px);
}

.theme-card.active {
  border-color: var(--accent);
}

.tc-preview {
  font-size: 11px;
  line-height: 1.6;
  white-space: nowrap;
  overflow: hidden;
  opacity: 0.95;
}

.tc-cursor {
  display: inline-block;
  width: 7px;
  height: 12px;
  margin-left: 6px;
  vertical-align: text-bottom;
  border-radius: 1px;
}

.cursor-swatch {
  display: inline-block;
  width: 14px;
  height: 14px;
  border-radius: 4px;
  border: 1px solid var(--border);
}

.tc-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  font-size: 12px;
}

.tc-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

.tc-tags {
  display: inline-flex;
  gap: 4px;
}

.tc-tag {
  font-size: 10px;
  padding: 0 5px;
  border-radius: 4px;
  background: rgba(127, 127, 127, 0.25);
}

.tc-star {
  display: inline-grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  opacity: 0.45;
  cursor: default;
}

.tc-star:hover,
.tc-star.on {
  opacity: 1;
}

.tc-star.on {
  color: #f2c14e;
}

.empty {
  grid-column: 1 / -1;
  padding: 30px;
  text-align: center;
}

.colors {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin: 10px 0;
}

.colors.ansi {
  grid-template-columns: repeat(8, minmax(0, 1fr));
}

.color {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  color: var(--text-3);
  text-align: center;
}

.credit {
  margin: 0;
}

/* 快捷键 */
.sc-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
}

.sc-row + .sc-row {
  border-top: 1px solid var(--border);
}

.sc-label {
  flex: 1;
  font-size: 13px;
}

.kbd {
  min-width: 120px;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--hover-1);
  color: var(--text-1);
  font: inherit;
  font-size: 12.5px;
  text-align: center;
  cursor: default;
}

.kbd:hover {
  background: var(--hover-2);
}

.kbd.recording {
  border-color: var(--accent);
  color: var(--accent);
  animation: pulse 1s ease-in-out infinite;
}

.kbd.empty {
  color: var(--text-3);
  font-style: italic;
}

.kbd.static {
  cursor: default;
  color: var(--text-2);
}

@keyframes pulse {
  50% {
    opacity: 0.5;
  }
}

.notes {
  margin: 0;
  padding-left: 18px;
}

.notes li {
  margin-bottom: 4px;
}

/* 关于 */
.about-head {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 14px;
}

.logo {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  display: grid;
  place-items: center;
  background: var(--accent-soft);
  color: var(--accent);
}

.about-name {
  font-size: 16px;
  font-weight: 600;
}

.kv {
  display: grid;
  grid-template-columns: 90px minmax(0, 1fr);
  gap: 6px 12px;
  margin: 0 0 14px;
  font-size: 12.5px;
}

.kv dt {
  color: var(--text-3);
}

.kv dd {
  margin: 0;
  overflow-wrap: anywhere;
}
</style>
