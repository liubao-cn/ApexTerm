<script setup lang="ts">
import { computed, ref } from "vue";
import { useTerminalsStore, type Layout, type Tab } from "../stores/terminals";
import TerminalView from "./TerminalView.vue";

const props = defineProps<{ tab: Tab; node: Layout; visible: boolean }>();
const terminals = useTerminalsStore();

const root = ref<HTMLDivElement | null>(null);
const dragging = ref(false);

const countLeaves = (l: Layout): number => (l.type === "leaf" ? 1 : countLeaves(l.a) + countLeaves(l.b));
/** 只有一个面板时不画聚焦框 */
const multiPane = computed(() => !!props.tab.layout && countLeaves(props.tab.layout) > 1);

function sessionOf(id: string) {
  return terminals.sessions.find((s) => s.id === id);
}

const keyOf = (l: Layout) => (l.type === "leaf" ? `leaf:${l.sessionId}` : `split:${l.id}`);

function onDividerDown(e: PointerEvent) {
  if (props.node.type !== "split" || !root.value) return;
  e.preventDefault();
  const node = props.node;
  const rect = root.value.getBoundingClientRect();
  dragging.value = true;
  document.body.style.cursor = node.dir === "row" ? "col-resize" : "row-resize";
  const move = (ev: PointerEvent) => {
    const ratio =
      node.dir === "row"
        ? (ev.clientX - rect.left) / rect.width
        : (ev.clientY - rect.top) / rect.height;
    terminals.setRatio(props.tab.id, node.id, ratio);
  };
  const up = () => {
    dragging.value = false;
    document.body.style.cursor = "";
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}
</script>

<template>
  <!-- 叶子：一个终端面板 -->
  <div
    v-if="node.type === 'leaf'"
    class="pane"
    :class="{ focused: multiPane && tab.activeSessionId === node.sessionId }"
    @pointerdown="terminals.focusSession(node.sessionId)"
  >
    <!-- 按会话 id 作 key：面板互换 / 挪动位置时必须重建组件，否则 Vue 复用实例会让终端 DOM 张冠李戴 -->
    <TerminalView
      v-if="sessionOf(node.sessionId)"
      :key="node.sessionId"
      :session="sessionOf(node.sessionId)!"
      :active="visible"
    />
  </div>

  <!-- 分割：a | b，中间一条可拖的分割线 -->
  <div v-else ref="root" class="split" :class="[node.dir, { dragging }]">
    <div class="cell" :style="{ flexBasis: `${node.ratio * 100}%` }">
      <PaneLayout :key="keyOf(node.a)" :tab="tab" :node="node.a" :visible="visible" />
    </div>
    <div class="divider" @pointerdown="onDividerDown"></div>
    <div class="cell" :style="{ flexBasis: `${(1 - node.ratio) * 100}%` }">
      <PaneLayout :key="keyOf(node.b)" :tab="tab" :node="node.b" :visible="visible" />
    </div>
  </div>
</template>

<style scoped>
.pane {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  outline: 1px solid transparent;
  outline-offset: -1px;
}

.pane.focused {
  outline-color: rgba(91, 141, 239, 0.45);
}

.split {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.split.row {
  flex-direction: row;
}

.split.col {
  flex-direction: column;
}

.cell {
  flex: 0 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
}

/* 分割条本身透明，中间画一条实线：在终端深底和面板头的浅灰底上都看得见，左右 / 上下分屏一致 */
.divider {
  flex: none;
  position: relative;
  z-index: 1;
  background: var(--bg);
}

/* 只作用于本层的分割条（用 >）：嵌套分屏里内层分割条的方向不能被外层规则覆盖 */
.split.row > .divider {
  width: 6px;
  cursor: col-resize;
}

.split.col > .divider {
  height: 6px;
  cursor: row-resize;
}

.divider::after {
  content: "";
  position: absolute;
  background: var(--hover-4);
  transition: background 0.12s;
}

.split.row > .divider::after {
  top: 0;
  bottom: 0;
  left: 2px;
  width: 2px;
}

.split.col > .divider::after {
  left: 0;
  right: 0;
  top: 2px;
  height: 2px;
}

.divider:hover::after,
.split.dragging > .divider::after {
  background: var(--accent);
}

/* 分割线扩大一点点命中范围 */
.divider::before {
  content: "";
  position: absolute;
  inset: -3px;
}
</style>
