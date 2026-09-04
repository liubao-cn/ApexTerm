<script setup lang="ts">
import { Server, Settings, Zap } from "lucide-vue-next";
import { useSettingsStore, type SidebarPanel } from "../stores/settings";
import { useShortcutsStore } from "../stores/shortcuts";

const settings = useSettingsStore();
const shortcuts = useShortcutsStore();

const items: { id: SidebarPanel; label: string; icon: typeof Server }[] = [
  { id: "hosts", label: "连接中心", icon: Server },
  { id: "commands", label: "快捷命令", icon: Zap },
];

const isActive = (id: SidebarPanel) => settings.prefs.sidebarPanel === id && !settings.prefs.sidebarCollapsed;
</script>

<template>
  <nav class="rail">
    <button
      v-for="it in items"
      :key="it.id"
      class="rail-btn"
      :class="{ active: isActive(it.id) }"
      v-tip="`${it.label}${isActive(it.id) ? '（再点收起）' : ''}  ${shortcuts.label('toggle-sidebar')}`"
      @click="settings.showPanel(it.id)"
    >
      <component :is="it.icon" :size="18" :stroke-width="1.75" />
    </button>
    <span class="spacer"></span>
    <button v-tip="`设置  ${shortcuts.label('settings')}`" class="rail-btn" @click="settings.show()">
      <Settings :size="18" :stroke-width="1.75" />
    </button>
  </nav>
</template>

<style scoped>
.rail {
  width: 44px;
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 0;
  background: var(--sidebar-bg);
  border-right: 1px solid var(--border);
}

.rail-btn {
  position: relative;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-3);
  cursor: default;
  transition: background 0.12s, color 0.12s;
}

.rail-btn:hover {
  background: var(--hover-2);
  color: var(--text-1);
}

.rail-btn.active {
  background: var(--hover-2);
  color: var(--accent);
}

.rail-btn.active::before {
  content: "";
  position: absolute;
  left: -4px;
  top: 9px;
  bottom: 9px;
  width: 2px;
  border-radius: 2px;
  background: var(--accent);
}

.spacer {
  flex: 1;
}
</style>
