<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { NButton, NCheckbox, NInput, NModal, NSpace, useMessage } from "naive-ui";
import { KeyRound } from "lucide-vue-next";
import { useHostsStore } from "../stores/hosts";
import { errorText, type Candidate, type HostInput } from "../api";
import { suggestAlias } from "../utils";

const props = defineProps<{ candidates: Candidate[] }>();
const show = defineModel<boolean>("show", { required: true });

const store = useHostsStore();
const message = useMessage();
const saving = ref(false);

interface Row {
  key: string;
  host: string;
  port: number;
  user: string;
  identityFile: string | null;
  alias: string;
  selected: boolean;
}

const rows = ref<Row[]>([]);

function uniqueAlias(base: string, taken: Set<string>): string {
  let alias = base;
  let n = 2;
  while (taken.has(alias)) alias = `${base}-${n++}`;
  taken.add(alias);
  return alias;
}

function build() {
  const taken = new Set(store.hosts.map((h) => h.alias));
  rows.value = props.candidates.map((c) => {
    const p = store.probeOf(c);
    const user = p.user || "root";
    return {
      key: c.key,
      host: c.host,
      port: c.port,
      user,
      identityFile: p.result?.key ?? null,
      alias: uniqueAlias(suggestAlias(c.host, user), taken),
      selected: true,
    };
  });
}

watch(show, (v) => v && build());

function aliasError(row: Row): string | null {
  const a = row.alias.trim();
  if (!a) return "别名必填";
  if (/[\s*?!#"]/.test(a)) return "不能含空格和 * ? ! # \"";
  if (store.hosts.some((h) => h.alias === a)) return "已存在";
  if (rows.value.some((r) => r !== row && r.selected && r.alias.trim() === a)) return "本批次内重复";
  return null;
}

const selectedRows = computed(() => rows.value.filter((r) => r.selected));
const hasError = computed(() => selectedRows.value.some((r) => aliasError(r) !== null));

async function submit() {
  const inputs: HostInput[] = selectedRows.value.map((r) => ({
    originalId: null,
    alias: r.alias.trim(),
    hostName: r.host,
    user: r.user.trim() || null,
    port: r.port === 22 ? null : r.port,
    identityFiles: r.identityFile ? [r.identityFile] : [],
    identitiesOnly: !!r.identityFile,
    proxyJump: null,
    description: "",
  }));
  if (inputs.length === 0) return;
  saving.value = true;
  try {
    const ids = await store.upsertMany(inputs);
    message.success(`已收编 ${ids.length} 台并写回 config：${ids.join("、")}`);
    show.value = false;
  } catch (e) {
    message.error(errorText(e));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <n-modal
    v-model:show="show"
    preset="card"
    title="批量收编"
    style="width: 760px"
    :mask-closable="false"
  >
    <p class="muted intro">
      下面是探测成功的机器，别名可以改成顺手的（之后终端里 <span class="mono">ssh 别名</span>）。
      一次性写入 config，只备份一次。
    </p>

    <div class="table">
      <div class="thead">
        <span></span>
        <span>地址</span>
        <span>用户</span>
        <span>密钥</span>
        <span>别名</span>
      </div>
      <div v-for="r in rows" :key="r.key" class="tr" :class="{ off: !r.selected }">
        <n-checkbox v-model:checked="r.selected" />
        <span class="mono cell-host">
          {{ store.mask(r.host) }}<span v-if="r.port !== 22" class="muted">:{{ r.port }}</span>
        </span>
        <n-input v-model:value="r.user" size="small" class="mono" :disabled="!r.selected" />
        <span v-tip="r.identityFile ?? ''" class="mono cell-key">
          <KeyRound :size="12" class="muted" />
          {{ r.identityFile ? r.identityFile.replace("~/.ssh/", "") : "默认" }}
        </span>
        <div class="cell-alias">
          <n-input
            v-model:value="r.alias"
            size="small"
            class="mono"
            :disabled="!r.selected"
            :status="r.selected && aliasError(r) ? 'error' : undefined"
          />
          <span v-if="r.selected && aliasError(r)" class="err">{{ aliasError(r) }}</span>
        </div>
      </div>
    </div>

    <template #footer>
      <n-space justify="space-between" align="center">
        <span class="muted">已选 {{ selectedRows.length }} / {{ rows.length }} 台</span>
        <n-space>
          <n-button @click="show = false">取消</n-button>
          <n-button
            type="primary"
            :loading="saving"
            :disabled="selectedRows.length === 0 || hasError"
            @click="submit"
          >
            写入 config（{{ selectedRows.length }} 台）
          </n-button>
        </n-space>
      </n-space>
    </template>
  </n-modal>
</template>

<style scoped>
.intro {
  margin: 0 0 14px;
  font-size: 12.5px;
  line-height: 1.6;
}

.table {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.thead,
.tr {
  display: grid;
  grid-template-columns: 24px 1.3fr 0.8fr 1fr 1.2fr;
  gap: 10px;
  align-items: center;
}

.thead {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-3);
  padding: 0 4px;
}

.tr {
  padding: 8px 4px;
  border-radius: 8px;
  background: var(--hover-1);
}

.tr.off {
  opacity: 0.5;
}

.cell-host {
  font-size: 13px;
  min-width: 0;
  overflow-wrap: anywhere;
}

.cell-key {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cell-alias {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.err {
  font-size: 11px;
  color: var(--red);
}
</style>
