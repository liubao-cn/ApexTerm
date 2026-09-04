<script setup lang="ts">
import { computed, h } from "vue";
import { NDropdown, type DropdownOption } from "naive-ui";
import { Server, TerminalSquare } from "lucide-vue-next";
import { UNGROUPED, useHostsStore } from "../stores/hosts";
import { useTerminalsStore } from "../stores/terminals";

/** 分屏目标选择：同一台 / 其它服务器 / 本地终端 */
const props = defineProps<{ dir: "row" | "col" }>();
const hosts = useHostsStore();
const terminals = useTerminalsStore();

const options = computed<DropdownOption[]>(() => {
  const cur = terminals.activeSession;
  const out: DropdownOption[] = [];
  if (cur) {
    out.push({ key: "__same", label: `同一台：${cur.title}` });
    out.push({ type: "divider", key: "d0" });
  }
  const groups = new Map<string, DropdownOption[]>();
  for (const h of hosts.servers) {
    const g = hosts.metaOf(h.id).group ?? UNGROUPED;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push({ key: `host:${h.id}`, label: h.alias });
  }
  if (groups.size === 1) {
    out.push(...groups.values().next().value!);
  } else {
    for (const [g, children] of groups) out.push({ type: "group", key: `g:${g}`, label: g, children });
  }
  out.push({ type: "divider", key: "d1" });
  out.push({ key: "__local", label: "本地终端" });
  return out;
});

function renderLabel(o: DropdownOption) {
  const key = String(o.key);
  const icon = key === "__local" ? TerminalSquare : Server;
  return h("span", { class: "qc-item" }, [h(icon, { size: 13, class: "qc-mode" }), o.label as string]);
}

function onSelect(key: string) {
  if (key === "__same") terminals.split(props.dir);
  else if (key === "__local") terminals.split(props.dir, { kind: "local" }, "本地终端", null);
  else if (key.startsWith("host:")) {
    const h = hosts.hosts.find((x) => x.id === key.slice(5));
    if (h) terminals.split(props.dir, { kind: "ssh", alias: h.alias }, h.alias, h.id);
  }
}
</script>

<template>
  <n-dropdown
    trigger="click"
    placement="bottom-end"
    :options="options"
    :render-label="renderLabel"
    scrollable
    style="max-height: 480px; min-width: 200px"
    @select="onSelect"
  >
    <slot />
  </n-dropdown>
</template>
