<script setup lang="ts">
import { computed } from "vue";
import { NButton, NModal, NProgress, NSpin } from "naive-ui";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowUpCircle, CheckCircle2, CircleAlert } from "lucide-vue-next";
import { RELEASES_URL, useUpdaterStore } from "../stores/updater";

const updater = useUpdaterStore();

const percent = computed(() => {
  if (!updater.total) return null;
  return Math.min(100, Math.round((updater.downloaded / updater.total) * 100));
});

const sizeText = computed(() => {
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  return updater.total ? `${mb(updater.downloaded)} / ${mb(updater.total)}` : mb(updater.downloaded);
});

/**
 * 更新说明 = GitHub Release 正文 = CHANGELOG 里本版的变更条目，只说改了什么。
 * 这里把 markdown 轻量排版：### 小标题、- 条目、去掉反引号。
 */
const notes = computed(() => {
  const raw = (updater.update?.body ?? "").trim();
  const blocks: { heading: string; items: string[] }[] = [];
  let cur: { heading: string; items: string[] } | null = null;
  for (const line of raw.split("\n")) {
    const t = line.trim().replace(/`/g, "");
    if (!t) continue;
    const h = t.match(/^#{1,6}\s+(.+)$/);
    if (h) {
      cur = { heading: h[1], items: [] };
      blocks.push(cur);
      continue;
    }
    if (!cur) {
      cur = { heading: "", items: [] };
      blocks.push(cur);
    }
    cur.items.push(t.replace(/^[-*]\s+/, ""));
  }
  return blocks;
});

const title = computed(() => {
  switch (updater.phase) {
    case "checking":
      return "正在检查更新…";
    case "available":
      return `发现新版本 ${updater.update?.version ?? ""}`;
    case "downloading":
      return "正在下载更新…";
    case "ready":
      return "即将重启完成更新";
    case "latest":
      return "已是最新版本";
    case "error":
      return "更新失败";
    default:
      return "检查更新";
  }
});

/** 不可关闭的阶段：下载中 / 准备重启 */
const busy = computed(() => updater.phase === "downloading" || updater.phase === "ready");
</script>

<template>
  <n-modal
    :show="updater.show"
    :mask-closable="!busy"
    :close-on-esc="!busy"
    transform-origin="center"
    @update:show="(v: boolean) => !v && !busy && updater.dismiss()"
  >
    <div class="update-card" role="dialog" aria-modal="true" :aria-label="title">
      <div class="head">
        <span class="icon" :class="updater.phase">
          <n-spin v-if="updater.phase === 'checking'" :size="18" />
          <CheckCircle2 v-else-if="updater.phase === 'latest'" :size="22" />
          <CircleAlert v-else-if="updater.phase === 'error'" :size="22" />
          <ArrowUpCircle v-else :size="22" />
        </span>
        <div class="titles">
          <div class="title">{{ title }}</div>
          <div v-if="updater.update" class="sub">
            当前 {{ updater.update.currentVersion }} → {{ updater.update.version }}
            <template v-if="updater.update.date"> · {{ updater.update.date.slice(0, 10) }}</template>
          </div>
        </div>
      </div>

      <div v-if="updater.phase === 'available' && notes.length" class="notes">
        <div v-for="(b, i) in notes" :key="i" class="notes-block">
          <div v-if="b.heading" class="notes-heading">{{ b.heading }}</div>
          <ul class="notes-list">
            <li v-for="(item, j) in b.items" :key="j">{{ item }}</li>
          </ul>
        </div>
      </div>
      <div v-else-if="updater.phase === 'available'" class="notes muted">这个版本没有附带更新说明。</div>

      <div v-if="updater.phase === 'downloading' || updater.phase === 'ready'" class="progress">
        <n-progress
          type="line"
          :percentage="percent ?? 0"
          :indicator-placement="'inside'"
          :processing="updater.phase === 'downloading'"
          :show-indicator="percent !== null"
        />
        <div class="muted small">{{ updater.phase === 'ready' ? '下载完成，正在安装并重启…' : sizeText }}</div>
      </div>

      <div v-if="updater.phase === 'error'" class="error">
        <div class="mono small selectable">{{ updater.error }}</div>
        <div class="muted small" style="margin-top: 6px">可以稍后重试，或到发布页手动下载安装包。</div>
      </div>

      <div v-if="updater.phase === 'latest'" class="muted small">当前已是最新版本，无需更新。</div>

      <div class="actions">
        <n-button v-if="updater.phase === 'error'" size="small" secondary @click="openUrl(RELEASES_URL)">前往发布页</n-button>
        <span class="spacer"></span>
        <template v-if="updater.phase === 'available'">
          <n-button size="small" quaternary @click="updater.dismiss()">稍后</n-button>
          <n-button size="small" type="primary" @click="updater.install()">下载并重启</n-button>
        </template>
        <template v-else-if="updater.phase === 'error'">
          <n-button size="small" quaternary @click="updater.dismiss()">关闭</n-button>
          <n-button size="small" type="primary" @click="updater.update ? updater.install() : updater.checkForUpdates({ manual: true })">重试</n-button>
        </template>
        <n-button v-else-if="!busy" size="small" type="primary" @click="updater.dismiss()">好</n-button>
      </div>
    </div>
  </n-modal>
</template>

<style scoped>
.update-card {
  width: 440px;
  max-width: calc(100vw - 48px);
  padding: 18px 20px 16px;
  border-radius: 12px;
  background: var(--panel-bg);
  border: 1px solid var(--border);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.35);
  color: var(--text-1);
}

.head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.icon {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background: var(--accent-soft);
  color: var(--accent-text);
  flex: none;
}

.icon.latest {
  background: color-mix(in srgb, var(--green) 16%, transparent);
  color: var(--green-text);
}

.icon.error {
  background: color-mix(in srgb, var(--red) 16%, transparent);
  color: var(--red-text);
}

.title {
  font-size: 15px;
  font-weight: 600;
}

.sub {
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-3);
}

.notes {
  margin-top: 14px;
  max-height: 220px;
  overflow: auto;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--hover-1);
  font-size: 12.5px;
  line-height: 1.55;
  word-break: break-word;
}

.notes-block + .notes-block {
  margin-top: 10px;
}

.notes-heading {
  font-weight: 600;
  color: var(--text-2);
  margin-bottom: 4px;
}

.notes-list {
  margin: 0;
  padding-left: 18px;
}

.notes-list li + li {
  margin-top: 3px;
}

.progress {
  margin-top: 16px;
  display: grid;
  gap: 6px;
}

.error {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--red) 10%, transparent);
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
}

.spacer {
  flex: 1;
}

.small {
  font-size: 12px;
}

.mono {
  font-family: var(--mono);
}
</style>
