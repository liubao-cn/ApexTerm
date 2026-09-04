import { computed, ref } from "vue";
import { acceptHMRUpdate, defineStore } from "pinia";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  api,
  errorText,
  type CloudBinding,
  type CloudInstance,
  type CloudProvider,
  type HostEntry,
  type PowerAction,
  type ScanResult,
} from "../api";
import { useHostsStore } from "./hosts";
import { useCommandsStore } from "./commands";

export interface CloudState {
  instance: CloudInstance | null;
  loading: boolean;
  error: string | null;
  updatedAt: number;
}

const STABLE = new Set(["running", "stopped", "unknown"]);

export const useCloudStore = defineStore("cloud", () => {
  const hosts = useHostsStore();
  const commands = useCommandsStore();

  const accounts = computed(() => hosts.meta.cloudAccounts);
  const modalOpen = ref(false);
  const states = ref<Record<string, CloudState>>({});
  const pollers = new Map<string, number>();

  function bindingOf(hostId: string): CloudBinding | null {
    return hosts.metaOf(hostId).cloud;
  }

  function stateOf(hostId: string): CloudState {
    return states.value[hostId] ?? { instance: null, loading: false, error: null, updatedAt: 0 };
  }

  function setState(hostId: string, patch: Partial<CloudState>) {
    states.value = { ...states.value, [hostId]: { ...stateOf(hostId), ...patch } };
  }

  async function refresh(hostId: string): Promise<CloudInstance | null> {
    if (!bindingOf(hostId)) return null;
    setState(hostId, { loading: true });
    try {
      const inst = await api.cloudState(hostId);
      setState(hostId, { instance: inst, error: null, loading: false, updatedAt: Date.now() });
      return inst;
    } catch (e) {
      setState(hostId, { error: errorText(e), loading: false, updatedAt: Date.now() });
      return null;
    }
  }

  /** 操作后每 4 秒刷一次状态，直到进入稳定态或超过 3 分钟 */
  function pollUntilStable(hostId: string) {
    stopPoll(hostId);
    const started = Date.now();
    const tick = async () => {
      const inst = await refresh(hostId);
      const elapsed = Date.now() - started;
      if (inst && STABLE.has(inst.state) && elapsed > 3000) return;
      if (elapsed > 3 * 60_000) return;
      pollers.set(hostId, window.setTimeout(tick, 4000));
    };
    pollers.set(hostId, window.setTimeout(tick, 1500));
  }

  function stopPoll(hostId: string) {
    const t = pollers.get(hostId);
    if (t) clearTimeout(t);
    pollers.delete(hostId);
  }

  async function power(host: HostEntry, action: PowerAction) {
    await api.cloudPower(host.id, action);
    if (action === "reboot" || action === "forceReboot") {
      commands.startRebootWatch(host);
    } else if (action === "start") {
      commands.startRebootWatch(host, { alreadyDown: true });
    } else {
      commands.dismissWatch(host.id);
    }
    pollUntilStable(host.id);
  }

  async function openVnc(hostId: string) {
    const url = await api.cloudVncUrl(hostId);
    await openUrl(url);
  }

  async function addAccount(
    provider: CloudProvider,
    name: string,
    keyId: string,
    secret: string,
    regions: string[],
  ) {
    hosts.meta = await api.cloudAddAccount(provider, name, keyId, secret, regions);
  }

  async function removeAccount(id: string) {
    hosts.meta = await api.cloudRemoveAccount(id);
  }

  async function scan(accountId: string): Promise<ScanResult> {
    return api.cloudScan(accountId);
  }

  async function bind(list: { hostId: string; binding: CloudBinding | null }[]) {
    hosts.meta = await api.cloudBind(list);
    for (const b of list) {
      if (b.binding) refresh(b.hostId);
      else setState(b.hostId, { instance: null, error: null });
    }
  }

  return {
    accounts,
    modalOpen,
    states,
    bindingOf,
    stateOf,
    refresh,
    pollUntilStable,
    power,
    openVnc,
    addAccount,
    removeAccount,
    scan,
    bind,
  };
});

// 让 Vite 热更新时替换掉旧的 store 实例，避免组件拿到缺少新方法的旧对象而渲染报错
if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useCloudStore, import.meta.hot));
}
