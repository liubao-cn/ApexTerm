<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { NDropdown, type DropdownOption } from "naive-ui";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

/**
 * 全局右键处理：
 * - 输入框 / 文本域 → 中文的 剪切/复制/粘贴/全选 菜单
 * - 终端和侧栏主机项各自有菜单（它们会 preventDefault）
 * - 其它地方 → 不弹系统英文菜单
 */
type Field = HTMLInputElement | HTMLTextAreaElement;

const ctx = ref({ show: false, x: 0, y: 0 });
let field: Field | null = null;

function isField(el: EventTarget | null): el is Field {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

const options: DropdownOption[] = [
  { key: "cut", label: "剪切" },
  { key: "copy", label: "复制" },
  { key: "paste", label: "粘贴" },
  { type: "divider", key: "d" },
  { key: "all", label: "全选" },
];

function onContextMenu(e: MouseEvent) {
  if (e.defaultPrevented) return;
  e.preventDefault();
  if (isField(e.target) && !e.target.readOnly && !e.target.disabled) {
    field = e.target;
    ctx.value = { show: true, x: e.clientX, y: e.clientY };
  }
}

function fireInput(el: Field) {
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function onSelect(key: string) {
  ctx.value.show = false;
  const el = field;
  if (!el) return;
  el.focus();
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? 0;
  const selected = el.value.slice(start, end);
  switch (key) {
    case "copy":
      if (selected) await writeText(selected).catch(() => {});
      break;
    case "cut":
      if (selected) {
        await writeText(selected).catch(() => {});
        el.setRangeText("", start, end, "end");
        fireInput(el);
      }
      break;
    case "paste": {
      const text = await readText().catch(() => "");
      if (text) {
        el.setRangeText(text, start, end, "end");
        fireInput(el);
      }
      break;
    }
    case "all":
      el.select();
      break;
  }
}

onMounted(() => document.addEventListener("contextmenu", onContextMenu));
onBeforeUnmount(() => document.removeEventListener("contextmenu", onContextMenu));
</script>

<template>
  <n-dropdown
    trigger="manual"
    placement="bottom-start"
    :show="ctx.show"
    :x="ctx.x"
    :y="ctx.y"
    :options="options"
    @clickoutside="ctx.show = false"
    @select="onSelect"
  />
</template>
