<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Check } from "lucide-vue-next";
import { presetById } from "../themes";
import { CURATED_GROUPS, extraThemeIds } from "../themeCatalog";
import { placePopup } from "../popupPlace";
import { useSettingsStore } from "../stores/settings";

/**
 * 「此面板配色」快选：在鼠标位置弹出的色卡面板，点一下立即生效、面板不关，可以连着试几套。
 * 原来是右键菜单的二级菜单：三十来项、一千多像素高，Naive UI 的二级菜单又不会挪位置也不会滚动，
 * 在哪儿右键都有一截被窗口边缘截掉。这里自己定位（placePopup 保证整块落在窗口内，放不下就内部滚动）。
 */
const props = defineProps<{
  show: boolean;
  x: number;
  y: number;
  /** 这个面板自己指定的预设；null = 没指定 */
  current: string | null;
  /** 没指定时实际跟随谁 */
  inherit: "host" | "global";
}>();
const emit = defineEmits<{ "update:show": [boolean]; select: [string | null]; more: [] }>();

const settings = useSettingsStore();
const el = ref<HTMLDivElement | null>(null);
const pos = ref<{ left: number; top: number; maxHeight: number } | null>(null);

const extras = computed(() => extraThemeIds(settings.prefs.favoriteThemes, [props.current]).map((id) => presetById(id)));

function close() {
  emit("update:show", false);
}

function onDocPointerDown(e: PointerEvent) {
  if (!el.value?.contains(e.target as Node)) close();
}

function onKeydown(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  close();
}

function listen(on: boolean) {
  const fn = on ? "addEventListener" : "removeEventListener";
  document[fn]("pointerdown", onDocPointerDown as EventListener, true);
  document[fn]("keydown", onKeydown as EventListener, true);
  window[fn]("resize", close);
  window[fn]("blur", close);
}

watch(
  () => props.show,
  async (show) => {
    listen(show);
    pos.value = null;
    if (!show) return;
    // 先不限高渲染一帧量出自然尺寸，再摆进窗口
    await nextTick();
    const node = el.value;
    if (!node) return;
    pos.value = placePopup({
      x: props.x,
      y: props.y,
      w: node.offsetWidth,
      h: node.offsetHeight,
      vw: window.innerWidth,
      vh: window.innerHeight,
    });
    node.focus({ preventScroll: true });
  },
);
onBeforeUnmount(() => listen(false));

const style = computed(() =>
  pos.value
    ? { left: `${pos.value.left}px`, top: `${pos.value.top}px`, maxHeight: `${pos.value.maxHeight}px` }
    : { left: "0px", top: "0px", visibility: "hidden" as const },
);
</script>

<template>
  <Teleport to="body">
    <div v-if="show" ref="el" class="ptp" :style="style" role="dialog" aria-label="此面板配色" tabindex="-1" @contextmenu.prevent.stop>
      <div class="ptp-head">
        <span class="ptp-title">此面板配色</span>
        <button class="ptp-link" @click="emit('more')">全部配色…</button>
      </div>
      <button class="ptp-follow" :class="{ on: current === null }" @click="emit('select', null)">
        <Check :size="13" class="ptp-check" />
        {{ inherit === "host" ? "跟随主机设置" : "跟随全局设置" }}
      </button>
      <template v-for="g in CURATED_GROUPS" :key="g.key">
        <div class="ptp-group">{{ g.name }}</div>
        <div v-for="f in g.families" :key="f.name" class="ptp-row">
          <span class="ptp-name">{{ f.name }}</span>
          <button
            v-for="v in [{ id: f.dark, label: '深' }, { id: f.light, label: '浅' }]"
            :key="v.id"
            class="ptp-chip"
            :class="{ on: current === v.id }"
            :style="{ background: presetById(v.id).theme.background, color: presetById(v.id).theme.foreground }"
            :aria-label="`${f.name} ${v.label}色`"
            :aria-pressed="current === v.id"
            @click="emit('select', v.id)"
          >
            <span>{{ v.label }}</span>
            <span class="ptp-dots" aria-hidden="true">
              <i v-for="k in ['red', 'yellow', 'green', 'blue'] as const" :key="k" :style="{ background: presetById(v.id).theme[k] }"></i>
            </span>
          </button>
        </div>
      </template>
      <template v-if="extras.length">
        <div class="ptp-group">收藏 / 正在使用</div>
        <div v-for="t in extras" :key="t.id" class="ptp-row">
          <button
            class="ptp-chip wide"
            :class="{ on: current === t.id }"
            :style="{ background: t.theme.background, color: t.theme.foreground }"
            :aria-pressed="current === t.id"
            @click="emit('select', t.id)"
          >
            <span class="ptp-chip-name">{{ t.name }}</span>
            <span class="ptp-dots" aria-hidden="true">
              <i v-for="k in ['red', 'yellow', 'green', 'blue'] as const" :key="k" :style="{ background: t.theme[k] }"></i>
            </span>
          </button>
        </div>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.ptp {
  position: fixed;
  z-index: 5000;
  width: 284px;
  padding: 8px;
  overflow-y: auto;
  border-radius: 10px;
  border: 1px solid var(--hover-3);
  background: var(--panel-bg-2);
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.35);
  color: var(--text-1);
  font-size: 12px;
  outline: none;
}

.ptp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 4px 6px;
}

.ptp-title {
  font-weight: 600;
}

.ptp-link {
  padding: 2px 6px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--accent-text);
  font: inherit;
  cursor: default;
}

.ptp-link:hover {
  background: var(--hover-2);
}

.ptp-follow {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 28px;
  padding: 0 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-2);
  font: inherit;
  text-align: left;
  cursor: default;
}

.ptp-follow:hover {
  background: var(--hover-2);
}

.ptp-check {
  visibility: hidden;
  color: var(--accent);
}

.ptp-follow.on {
  color: var(--text-1);
}

.ptp-follow.on .ptp-check {
  visibility: visible;
}

.ptp-group {
  margin: 8px 6px 4px;
  color: var(--text-3);
  font-size: 11px;
}

.ptp-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 76px 76px;
  align-items: center;
  gap: 6px;
  padding: 2px 6px;
}

.ptp-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
}

.ptp-chip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  height: 24px;
  padding: 0 8px;
  border: none;
  border-radius: 6px;
  box-shadow: 0 0 0 1px var(--hover-3);
  font: inherit;
  font-size: 11px;
  cursor: default;
}

.ptp-chip.wide {
  grid-column: 1 / -1;
}

.ptp-chip:hover {
  box-shadow: 0 0 0 1px var(--hover-5);
}

.ptp-chip.on {
  box-shadow: 0 0 0 2px var(--accent);
}

.ptp-chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ptp-dots {
  display: inline-flex;
  flex: none;
  gap: 3px;
}

.ptp-dots i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
</style>
