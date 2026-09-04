<script setup lang="ts">
import { computed, ref } from "vue";
import { NButton, NInput, NScrollbar, NTag, NTooltip, useMessage } from "naive-ui";
import {
  CheckCircle2,
  EyeOff,
  GitBranch,
  Loader2,
  Network,
  Radar,
  RotateCcw,
  UserPlus,
  Users,
  XCircle,
} from "lucide-vue-next";
import { useHostsStore } from "../stores/hosts";
import { errorText, type Candidate, type HostInput } from "../api";
import { suggestAlias } from "../utils";
import BatchAdoptModal from "./BatchAdoptModal.vue";

const emit = defineEmits<{ adopt: [prefill: Partial<HostInput>] }>();
const store = useHostsStore();
const message = useMessage();
const showIgnored = ref(false);
const batchOpen = ref(false);

const list = computed(() =>
  showIgnored.value ? store.candidates : store.activeCandidates,
);

const probingAny = computed(() =>
  store.activeCandidates.some((c) => store.probeOf(c).status === "running"),
);

async function ignoreAllFailed() {
  const failed = store.probedFail;
  try {
    await store.setCandidatesIgnored(failed, true);
    message.success(`已忽略 ${failed.length} 台，可在「显示已忽略」里恢复`);
  } catch (e) {
    message.error(errorText(e));
  }
}

async function toggleIgnored(c: Candidate) {
  try {
    await store.setCandidatesIgnored([c], !c.ignored);
  } catch (e) {
    message.error(errorText(e));
  }
}

function adopt(c: Candidate) {
  const p = store.probeOf(c);
  const user = p.user || "root";
  emit("adopt", {
    alias: suggestAlias(c.host, user),
    hostName: c.host,
    user,
    port: c.port === 22 ? null : c.port,
    identityFiles: p.result?.key ? [p.result.key] : [],
    identitiesOnly: !!p.result?.key,
  });
}
</script>

<template>
  <div class="panel">
    <header class="panel-header">
      <div class="title">
        <div class="badge"><Radar :size="20" /></div>
        <div>
          <h1>候选主机</h1>
          <div class="muted sub">
            连过（known_hosts 里留有指纹）但没写进 ~/.ssh/config 的机器
          </div>
        </div>
      </div>
      <div class="actions">
        <n-button
          v-if="store.probedOk.length"
          size="small"
          type="primary"
          @click="batchOpen = true"
        >
          <template #icon><Users :size="14" /></template>
          收编全部成功的 ({{ store.probedOk.length }})
        </n-button>
        <n-tooltip v-if="store.probedFail.length">
          <template #trigger>
            <n-button size="small" secondary @click="ignoreAllFailed">
              <template #icon><EyeOff :size="14" /></template>
              忽略全部失败的 ({{ store.probedFail.length }})
            </n-button>
          </template>
          只是本程序打个标记，不会改动 known_hosts；随时可恢复
        </n-tooltip>
        <n-button
          size="small"
          secondary
          :loading="probingAny"
          :disabled="store.activeCandidates.length === 0"
          @click="store.probeAll()"
        >
          <template #icon><Radar :size="14" /></template>
          探测全部
        </n-button>
        <n-button
          v-if="store.ignoredCandidates.length"
          size="small"
          quaternary
          @click="showIgnored = !showIgnored"
        >
          <template #icon><EyeOff :size="14" /></template>
          {{ showIgnored ? "隐藏" : "显示" }}已忽略 ({{ store.ignoredCandidates.length }})
        </n-button>
      </div>
    </header>

    <n-scrollbar class="body-scroll">
      <div class="body">
        <p class="explain muted">
          「探测」会用 <span class="mono">ssh -o BatchMode=yes</span> 依次尝试你本地的
          {{ store.keys.filter((k) => k.hasPrivate).length }} 把密钥，只执行 <span class="mono">exit</span>，
          不会改动服务器。成功后点「收编」即可把它写进 config，以后就能按别名连。
        </p>

        <div v-if="list.length === 0" class="empty muted">
          没有候选主机 —— known_hosts 里的机器都已经在 config 里了。
        </div>

        <div v-for="c in list" :key="c.key" class="row" :class="{ ignored: c.ignored }">
          <div class="row-main">
            <div class="host-line">
              <component :is="c.isGit ? GitBranch : Network" :size="15" class="muted" />
              <span class="host mono selectable">{{ store.mask(c.host) }}</span>
              <span v-if="c.port !== 22" class="mono muted">:{{ c.port }}</span>
              <n-tag v-if="c.isGit" size="tiny" round :bordered="false">Git 平台</n-tag>
              <n-tag v-if="c.isPrivate" size="tiny" round :bordered="false">内网</n-tag>
              <n-tag v-if="c.ignored" size="tiny" round :bordered="false">已忽略</n-tag>
            </div>
            <div class="meta-line muted">
              <span>known_hosts 第 {{ c.lines.join(", ") }} 行</span>
              <span>·</span>
              <span class="mono">{{ c.keyTypes.join(" / ") }}</span>
              <template v-if="c.suggestedUser">
                <span>·</span>
                <span>历史里用过 <span class="mono">{{ c.suggestedUser }}@</span></span>
              </template>
            </div>
            <div class="status-line" :class="store.probeOf(c).status">
              <template v-if="store.probeOf(c).status === 'running'">
                <Loader2 :size="14" class="spin" /> 探测中…
              </template>
              <template v-else-if="store.probeOf(c).status === 'ok'">
                <CheckCircle2 :size="14" />
                {{ store.probeOf(c).result?.message }}
                <span class="muted">（{{ store.probeOf(c).result?.durationMs }} ms）</span>
              </template>
              <template v-else-if="store.probeOf(c).status === 'fail'">
                <XCircle :size="14" />
                {{ store.probeOf(c).result?.message }}
              </template>
            </div>
          </div>

          <div class="row-actions">
            <n-input
              :value="store.probeOf(c).user"
              size="small"
              placeholder="用户名"
              class="user-input mono"
              :disabled="store.probeOf(c).status === 'running'"
              @update:value="(v) => store.setProbeUser(c, v)"
            />
            <n-button
              size="small"
              secondary
              :loading="store.probeOf(c).status === 'running'"
              @click="store.probe(c)"
            >
              <template #icon>
                <RotateCcw v-if="store.probeOf(c).status !== 'idle'" :size="13" />
                <Radar v-else :size="13" />
              </template>
              {{ store.probeOf(c).status === "idle" ? "探测" : "重试" }}
            </n-button>
            <n-tooltip :disabled="store.probeOf(c).status === 'ok'">
              <template #trigger>
                <n-button
                  size="small"
                  type="primary"
                  :secondary="store.probeOf(c).status !== 'ok'"
                  @click="adopt(c)"
                >
                  <template #icon><UserPlus :size="13" /></template>
                  收编
                </n-button>
              </template>
              未探测也能收编，但建议先探测确认哪把密钥可用
            </n-tooltip>
            <n-button size="small" quaternary @click="toggleIgnored(c)">
              {{ c.ignored ? "恢复" : "忽略" }}
            </n-button>
          </div>
        </div>
      </div>
    </n-scrollbar>

    <BatchAdoptModal v-model:show="batchOpen" :candidates="store.probedOk" />
  </div>
</template>

<style scoped>
.panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px 16px;
  padding: 0 24px 16px;
  border-bottom: 1px solid var(--border);
}

.title {
  display: flex;
  gap: 14px;
}

.badge {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  display: grid;
  place-items: center;
  background: rgba(61, 190, 122, 0.14);
  color: var(--green);
  flex: none;
}

.title h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}

.sub {
  margin-top: 2px;
  font-size: 12.5px;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 6px;
  flex: none;
}

.body-scroll {
  flex: 1;
  min-height: 0;
}

.body {
  padding: 18px 24px 28px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 980px;
}

.explain {
  margin: 0 0 6px;
  line-height: 1.7;
  font-size: 12.5px;
}

.empty {
  padding: 40px;
  text-align: center;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px 16px;
  padding: 12px 16px;
  background: var(--panel-bg);
  border: 1px solid var(--border);
  border-radius: 12px;
}

.row.ignored {
  opacity: 0.55;
}

.row-main {
  min-width: 0;
  flex: 1 1 280px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.host-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.host {
  overflow-wrap: anywhere;
}

.host {
  font-size: 14px;
  font-weight: 500;
}

.meta-line {
  display: flex;
  gap: 6px;
  font-size: 11.5px;
  flex-wrap: wrap;
}

.status-line {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  min-height: 18px;
}

.status-line.ok {
  color: var(--green);
}

.status-line.fail {
  color: var(--red);
}

.status-line.running {
  color: var(--text-3);
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.row-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}

.user-input {
  width: 110px;
}
</style>
