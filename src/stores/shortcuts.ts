import { computed, ref } from "vue";
import { acceptHMRUpdate, defineStore } from "pinia";
import { api, type AppInfo, type ShortcutDef } from "../api";
import { accelLabel, matchesAccel } from "../platform";
import { useHostsStore } from "./hosts";

/**
 * 快捷键：默认表来自后端（与菜单一致），用户覆盖存在 meta.shortcuts。
 * 终端里按键时用 matches() 判断是否该放行给菜单。
 */
export const useShortcutsStore = defineStore("shortcuts", () => {
  const hosts = useHostsStore();
  const info = ref<AppInfo | null>(null);

  async function load() {
    if (!info.value) info.value = await api.appInfo();
    return info.value;
  }

  const defs = computed<ShortcutDef[]>(() => info.value?.shortcuts ?? []);
  const overrides = computed(() => hosts.meta.shortcuts ?? {});

  /** 动作 id → 当前生效的加速键（空串 = 未绑定） */
  const resolved = computed<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const d of defs.value) out[d.id] = overrides.value[d.id] ?? d.default;
    return out;
  });

  function label(id: string): string {
    return accelLabel(resolved.value[id]);
  }

  /** 返回命中的动作 id */
  function matches(e: KeyboardEvent): string | null {
    for (const [id, accel] of Object.entries(resolved.value)) {
      if (accel && matchesAccel(e, accel)) return id;
    }
    return null;
  }

  async function set(id: string, accel: string | null) {
    const def = defs.value.find((d) => d.id === id);
    if (!def) return;
    const next = { ...overrides.value };
    // 与默认相同就不必存覆盖；null 表示恢复默认
    if (accel === null || accel === def.default) delete next[id];
    else next[id] = accel;
    hosts.meta = await api.saveShortcuts(next);
  }

  async function resetAll() {
    hosts.meta = await api.saveShortcuts({});
  }

  /** 找出用同一加速键的其它动作（冲突提示） */
  function conflicts(id: string, accel: string): ShortcutDef[] {
    if (!accel) return [];
    return defs.value.filter((d) => d.id !== id && resolved.value[d.id]?.toLowerCase() === accel.toLowerCase());
  }

  return { info, load, defs, resolved, label, matches, set, resetAll, conflicts };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useShortcutsStore, import.meta.hot));
}
