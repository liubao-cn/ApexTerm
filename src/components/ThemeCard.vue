<script setup lang="ts">
import { computed } from "vue";
import { Star } from "lucide-vue-next";
import { minContrast, selectionColors, type TermTheme } from "../themes";

/** 一张配色预览卡：用 AI CLI 里最常见的几种文字（提示符、次要信息、增删行、选中文字）直接演示这套颜色 */
const props = defineProps<{
  name: string;
  theme: TermTheme;
  active?: boolean;
  /** 当前主题在这套预设基础上手改过颜色 */
  tweaked?: boolean;
  favorite?: boolean;
  /** 光标色（「光标跟随文字颜色」打开时由外面传前景色） */
  cursor?: string;
}>();
defineEmits<{ select: []; "toggle-favorite": [] }>();

const selection = computed(() => selectionColors(props.theme).active);
const highContrast = computed(() => minContrast(props.theme) >= 4.5);
</script>

<template>
  <div
    class="theme-card"
    :class="{ active }"
    :style="{ background: theme.background, color: theme.foreground }"
    role="button"
    tabindex="0"
    :aria-pressed="active"
    :aria-label="`使用配色 ${name}`"
    @click="$emit('select')"
    @keydown.enter.prevent="$emit('select')"
    @keydown.space.prevent="$emit('select')"
  >
    <div class="tc-preview mono" aria-hidden="true">
      <div><span :style="{ color: theme.green }">❯</span> <span :style="{ color: theme.blue }">devin</span> 修复登录超时</div>
      <div><span :style="{ color: theme.magenta }">●</span> <span :style="{ color: theme.cyan }">auth.ts</span> <span :style="{ color: theme.brightBlack }"># 次要信息</span></div>
      <div>
        <span :style="{ color: theme.green }">+ok</span> <span :style="{ color: theme.red }">-err</span> <span :style="{ color: theme.yellow }">warn</span>
        <span class="tc-selection" :style="{ background: selection }">选中</span
        ><span class="tc-cursor" :style="{ background: cursor ?? theme.cursor }"></span>
      </div>
    </div>
    <div class="tc-foot">
      <span class="tc-name">{{ name }}</span>
      <span class="tc-tags">
        <span v-if="tweaked" class="tc-tag">已微调</span>
        <span v-if="highContrast" class="tc-tag">高对比</span>
      </span>
      <button
        class="tc-star"
        :class="{ on: favorite }"
        v-tip="favorite ? '取消收藏' : '收藏：会出现在各处的配色快选里'"
        :aria-label="favorite ? '取消收藏' : '收藏'"
        @click.stop="$emit('toggle-favorite')"
        @keydown.enter.stop
        @keydown.space.stop
      >
        <Star :size="12" :fill="favorite ? 'currentColor' : 'none'" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.theme-card {
  border-radius: 10px;
  border: 2px solid transparent;
  padding: 10px 12px 8px;
  cursor: default;
  box-shadow: 0 0 0 1px var(--border) inset;
  transition: transform 0.1s;
  min-width: 0;
}

.theme-card:hover {
  transform: translateY(-1px);
}

.theme-card.active {
  border-color: var(--accent);
}

.tc-preview {
  font-size: 11px;
  line-height: 1.65;
  white-space: nowrap;
  overflow: hidden;
}

.tc-selection {
  margin-left: 2px;
  padding: 1px 3px;
}

.tc-cursor {
  display: inline-block;
  width: 2px;
  height: 12px;
  margin-left: 1px;
  vertical-align: text-bottom;
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
</style>
