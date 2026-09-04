<script setup lang="ts">
import { toRef } from "vue";
import { NButton, NDropdown } from "naive-ui";
import { ChevronDown, Zap } from "lucide-vue-next";
import type { HostEntry } from "../api";
import type { TermSession } from "../stores/terminals";
import { useQuickCommands } from "../quickCommands";

const props = withDefaults(
  defineProps<{
    host: HostEntry;
    /** 传入时，终端模式的命令直接输入到这个会话，而不是新开标签 */
    session?: TermSession | null;
    size?: "tiny" | "small" | "medium";
    quaternary?: boolean;
    iconOnly?: boolean;
  }>(),
  { session: null, size: "small", quaternary: false, iconOnly: false },
);

const { options, renderLabel, onSelect } = useQuickCommands(toRef(props, "host"), toRef(props, "session"));
</script>

<template>
  <n-dropdown
    trigger="click"
    placement="bottom-end"
    :options="options"
    :render-label="renderLabel"
    scrollable
    style="max-height: 520px; min-width: 300px"
    @select="onSelect"
  >
    <n-button :size="size" :secondary="!quaternary" :quaternary="quaternary" :circle="iconOnly">
      <template #icon><Zap :size="size === 'tiny' ? 12 : 14" /></template>
      <template v-if="!iconOnly">
        快捷命令
        <ChevronDown :size="12" style="margin-left: 4px; opacity: 0.7" />
      </template>
    </n-button>
  </n-dropdown>
</template>

<style>
/* 下拉渲染在 body 下，不能用 scoped */
.qc-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 420px;
}

.qc-item.danger {
  color: #f07a74;
}

.qc-mode {
  opacity: 0.6;
  flex: none;
}

.qc-name {
  flex: none;
}

.qc-cmd {
  font-size: 11px;
  opacity: 0.55;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.qc-confirm-cmd {
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--hover-2);
  font-size: 12.5px;
  overflow-wrap: anywhere;
  margin-bottom: 8px;
}

.qc-confirm-note {
  font-size: 12px;
  opacity: 0.65;
  line-height: 1.6;
}
</style>
