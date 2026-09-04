<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { NButton, NCheckbox, NModal, NScrollbar, NSpace, NTag } from "naive-ui";
import { ArrowDownToLine, ArrowUpFromLine } from "lucide-vue-next";
import { formatBytes, type FolderPair, type HostEntry, type SyncPlan } from "../api";
import { useFilesStore } from "../stores/files";

const props = defineProps<{ host: HostEntry; pair: FolderPair | null; plan: SyncPlan | null }>();
const show = defineModel<boolean>("show", { required: true });
const files = useFilesStore();

const selected = ref<Set<string>>(new Set());
const deleteOrphans = ref<Set<string>>(new Set());
const applying = ref(false);

watch(
  () => props.plan,
  (p) => {
    selected.value = new Set(p?.items.map((i) => i.rel) ?? []);
    deleteOrphans.value = new Set();
  },
  { immediate: true },
);

const isPush = computed(() => props.plan?.direction === "push");
const selectedBytes = computed(
  () => props.plan?.items.filter((i) => selected.value.has(i.rel)).reduce((a, b) => a + b.size, 0) ?? 0,
);

function toggle(set: Set<string>, key: string) {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

async function apply() {
  if (!props.plan || !props.pair) return;
  applying.value = true;
  try {
    await files.applySync(props.host, props.pair, props.plan.direction, [...selected.value], [...deleteOrphans.value]);
    show.value = false;
  } finally {
    applying.value = false;
  }
}
</script>

<template>
  <n-modal v-model:show="show" preset="card" :title="isPush ? '推送到服务器' : '拉取到本地'" style="width: 760px; max-width: calc(100vw - 40px)">
    <template v-if="plan && pair">
      <div class="head">
        <component :is="isPush ? ArrowUpFromLine : ArrowDownToLine" :size="16" class="muted" />
        <span class="mono path">{{ isPush ? plan.local : plan.remote }}</span>
        <span class="muted">→</span>
        <span class="mono path">{{ isPush ? plan.remote : plan.local }}</span>
      </div>
      <div class="summary muted">
        {{ plan.items.length }} 个文件需要传输（{{ formatBytes(plan.bytes) }}）· {{ plan.unchanged }} 个相同已跳过
        <template v-if="plan.orphans.length"> · 目标端多出 {{ plan.orphans.length }} 个文件</template>
      </div>

      <n-scrollbar style="max-height: 50vh">
        <div v-if="plan.items.length === 0" class="empty muted">两边已经一致，没有需要传输的文件。</div>
        <div v-for="i in plan.items" :key="i.rel" class="row" @click="selected = toggle(selected, i.rel)">
          <n-checkbox :checked="selected.has(i.rel)" @click.stop @update:checked="selected = toggle(selected, i.rel)" />
          <n-tag size="tiny" round :bordered="false" :type="i.action === 'create' ? 'success' : 'warning'">
            {{ i.action === "create" ? "新增" : "更新" }}
          </n-tag>
          <span class="mono rel">{{ i.rel }}</span>
          <span class="muted small">{{ formatBytes(i.size) }} · {{ i.reason }}</span>
        </div>

        <template v-if="plan.orphans.length">
          <div class="orphan-title muted">
            目标端多出的文件（默认保留；勾选则删除）
          </div>
          <div v-for="o in plan.orphans" :key="o" class="row orphan" @click="deleteOrphans = toggle(deleteOrphans, o)">
            <n-checkbox :checked="deleteOrphans.has(o)" @click.stop @update:checked="deleteOrphans = toggle(deleteOrphans, o)" />
            <n-tag size="tiny" round :bordered="false" type="error">删除</n-tag>
            <span class="mono rel">{{ o }}</span>
          </div>
        </template>
      </n-scrollbar>
    </template>

    <template #footer>
      <n-space justify="space-between" align="center">
        <span class="muted small">
          已选 {{ selected.size }} 个文件 · {{ formatBytes(selectedBytes) }}
          <template v-if="deleteOrphans.size"> · 删除 {{ deleteOrphans.size }} 个</template>
        </span>
        <n-space>
          <n-button @click="show = false">取消</n-button>
          <n-button
            type="primary"
            :loading="applying"
            :disabled="selected.size === 0 && deleteOrphans.size === 0"
            @click="apply"
          >
            {{ isPush ? "开始推送" : "开始拉取" }}
          </n-button>
        </n-space>
      </n-space>
    </template>
  </n-modal>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}

.path {
  font-size: 12.5px;
  overflow-wrap: anywhere;
}

.summary {
  font-size: 12px;
  margin-bottom: 10px;
}

.empty {
  padding: 30px;
  text-align: center;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 6px;
  border-radius: 6px;
}

.row:hover {
  background: var(--hover-1);
}

.rel {
  font-size: 12.5px;
  min-width: 0;
  overflow-wrap: anywhere;
}

.small {
  font-size: 11.5px;
  margin-left: auto;
  white-space: nowrap;
}

.orphan-title {
  font-size: 11.5px;
  padding: 12px 6px 4px;
}

.row.orphan {
  opacity: 0.85;
}
</style>
