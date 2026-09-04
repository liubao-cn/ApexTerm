<script setup lang="ts">
import { PanelLeftClose } from "lucide-vue-next";
import { useSettingsStore } from "../stores/settings";
import { useShortcutsStore } from "../stores/shortcuts";

defineProps<{ title: string }>();
const settings = useSettingsStore();
const shortcuts = useShortcutsStore();
</script>

<template>
  <div class="panel-head">
    <span class="panel-title">{{ title }}</span>
    <span class="spacer"></span>
    <slot />
    <button v-tip="`收起侧栏  ${shortcuts.label('toggle-sidebar')}`" class="pbtn" @click="settings.toggleSidebar()">
      <PanelLeftClose :size="14" />
    </button>
  </div>
</template>

<style scoped>
.panel-head {
  flex: none;
  height: 36px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 6px 0 14px;
}

.panel-title {
  font-weight: 600;
  font-size: 12.5px;
  color: var(--text-2);
  letter-spacing: 0.2px;
  white-space: nowrap;
}

.spacer {
  flex: 1;
}

.pbtn {
  display: inline-grid;
  place-items: center;
  width: 26px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-3);
  cursor: default;
}

.pbtn:hover {
  background: var(--hover-3);
  color: var(--text-1);
}
</style>
