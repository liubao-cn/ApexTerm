<script setup lang="ts">
import { ref, watch } from "vue";
import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, useSettingsStore } from "../stores/settings";

const settings = useSettingsStore();
// 拖动期间只改本地宽度，松手才写入偏好
const width = ref(settings.prefs.sidebarWidth);
watch(() => settings.prefs.sidebarWidth, (w) => (width.value = w));
const dragging = ref(false);

function onDown(e: PointerEvent) {
  e.preventDefault();
  const startX = e.clientX;
  const startW = width.value;
  dragging.value = true;
  document.body.style.cursor = "col-resize";
  const move = (ev: PointerEvent) => {
    width.value = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startW + ev.clientX - startX));
  };
  const up = () => {
    dragging.value = false;
    document.body.style.cursor = "";
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    settings.setSidebarWidth(width.value);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}
</script>

<template>
  <aside class="side-panel" :style="{ width: `${width}px` }">
    <slot />
    <div
      class="resizer"
      :class="{ dragging }"
      @pointerdown="onDown"
      @dblclick="settings.setSidebarWidth(SIDEBAR_DEFAULT)"
    ></div>
  </aside>
</template>

<style scoped>
.side-panel {
  position: relative;
  flex: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--sidebar-bg);
  border-right: 1px solid var(--border);
}

.resizer {
  position: absolute;
  top: 0;
  bottom: 0;
  right: -3px;
  width: 6px;
  cursor: col-resize;
  z-index: 2;
}

.resizer:hover,
.resizer.dragging {
  background: var(--accent);
  opacity: 0.6;
}
</style>
