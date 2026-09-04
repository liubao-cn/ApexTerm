import { computed, h, type Ref } from "vue";
import { useDialog, useMessage, type DropdownOption } from "naive-ui";
import { Cloud, Settings2, Terminal, Users, Zap } from "lucide-vue-next";
import { PROVIDER_LABEL, errorText, type HostEntry, type PowerAction } from "./api";
import { SNIPPET_GROUPS, resolveCommand, type Snippet } from "./snippets";
import { useCommandsStore } from "./stores/commands";
import { useCloudStore } from "./stores/cloud";
import type { TermSession } from "./stores/terminals";

const CLOUD_ACTIONS: { key: string; action: PowerAction; label: string; desc: string }[] = [
  { key: "__cloud:forceReboot", action: "forceReboot", label: "云 API · 强制重启", desc: "相当于按电源复位键，服务器卡死、SSH 进不去时用" },
  { key: "__cloud:start", action: "start", label: "云 API · 开机", desc: "启动已关机的实例，开机后自动等待 SSH 恢复" },
  { key: "__cloud:stop", action: "stop", label: "云 API · 关机", desc: "云平台执行正常关机，之后可用「开机」再启动" },
];

/**
 * 快捷命令菜单的选项/渲染/执行逻辑，供快捷命令按钮、终端右键菜单、侧栏右键菜单共用。
 * 必须在组件 setup 里调用（用到 useDialog / useMessage）。
 */
export function useQuickCommands(host: Ref<HostEntry | undefined | null>, session: Ref<TermSession | null | undefined>) {
  const commands = useCommandsStore();
  const cloud = useCloudStore();
  const dialog = useDialog();
  const message = useMessage();

  const snippets = computed(() => (host.value ? commands.forHost(host.value) : []));
  const byId = computed(() => new Map(snippets.value.map((s) => [s.id, s])));
  const binding = computed(() => (host.value ? cloud.bindingOf(host.value.id) : null));

  /** 仅命令分组（不含"批量/管理"尾项），可嵌进别的菜单当子菜单 */
  const groupOptions = computed<DropdownOption[]>(() => {
    const list = snippets.value;
    const groups = [...new Set([...SNIPPET_GROUPS, ...list.map((s) => s.group)])];
    const out: DropdownOption[] = [];
    for (const g of groups) {
      const items = list.filter((s) => s.group === g);
      if (!items.length) continue;
      out.push({ type: "group", key: `g:${g}`, label: g, children: items.map((s) => ({ key: s.id, label: s.name })) });
    }
    if (binding.value) {
      out.push({
        type: "group",
        key: "g:cloud",
        label: `${PROVIDER_LABEL[binding.value.provider]} 带外控制`,
        children: CLOUD_ACTIONS.map((a) => ({ key: a.key, label: a.label })),
      });
    }
    return out;
  });

  const options = computed<DropdownOption[]>(() => {
    const out = [...groupOptions.value];
    if (out.length) out.push({ type: "divider", key: "d1" });
    out.push({ key: "__batch", label: "在多台服务器上执行…" });
    out.push({ key: "__manage", label: "管理快捷命令…" });
    return out;
  });

  function renderLabel(option: DropdownOption) {
    const key = String(option.key);
    if (key.startsWith("__cloud:")) {
      const a = CLOUD_ACTIONS.find((x) => x.key === key)!;
      return h("span", { class: ["qc-item", { danger: a.action !== "start" }] }, [
        h(Cloud, { size: 13, class: "qc-mode" }),
        h("span", { class: "qc-name" }, a.label),
        h("span", { class: "qc-cmd" }, binding.value?.instanceName || binding.value?.instanceId || ""),
      ]);
    }
    if (key === "__batch") return h("span", { class: "qc-item" }, [h(Users, { size: 13 }), option.label as string]);
    if (key === "__manage") return h("span", { class: "qc-item" }, [h(Settings2, { size: 13 }), option.label as string]);
    const s = byId.value.get(key);
    if (!s || !host.value) return option.label as string;
    return h("span", { class: ["qc-item", { danger: s.danger }] }, [
      h(s.mode === "terminal" ? Terminal : Zap, { size: 13, class: "qc-mode" }),
      h("span", { class: "qc-name" }, s.name),
      h("span", { class: "qc-cmd mono" }, resolveCommand(s.command, host.value)),
    ]);
  }

  function run(s: Snippet) {
    if (!host.value) return;
    commands.execute(s, host.value, session.value);
    if (s.mode === "silent") message.info(`已在 ${host.value.alias} 后台执行：${s.name}`);
    if (s.watchReboot) message.warning(`开始监视 ${host.value.alias}，恢复上线后会提醒`);
  }

  function confirmAndRun(s: Snippet) {
    const hst = host.value!;
    const cmd = resolveCommand(s.command, hst);
    const where = s.mode === "silent" ? "后台执行，完成后显示输出" : session.value ? "输入到当前终端会话" : "新开一个终端标签执行";
    dialog[s.danger ? "error" : "warning"]({
      title: `${s.name} · ${hst.alias}`,
      content: () =>
        h("div", { class: "qc-confirm" }, [
          h("div", { class: "qc-confirm-cmd mono" }, cmd),
          h("div", { class: "qc-confirm-note" }, where),
          s.description ? h("div", { class: "qc-confirm-note" }, s.description) : null,
        ]),
      positiveText: s.danger ? "确认执行" : "执行",
      negativeText: "取消",
      onPositiveClick: () => run(s),
    });
  }

  function runCloud(a: (typeof CLOUD_ACTIONS)[number]) {
    const b = binding.value;
    const hst = host.value;
    if (!b || !hst) return;
    dialog[a.action === "start" ? "info" : "error"]({
      title: `${a.label} · ${hst.alias}`,
      content: () =>
        h("div", { class: "qc-confirm" }, [
          h("div", { class: "qc-confirm-cmd mono" }, `${PROVIDER_LABEL[b.provider]} · ${b.instanceName || b.instanceId}`),
          h("div", { class: "qc-confirm-note" }, a.desc),
        ]),
      positiveText: a.action === "start" ? "执行" : "确认执行",
      negativeText: "取消",
      onPositiveClick: async () => {
        try {
          await cloud.power(hst, a.action);
          message.success(`已向${PROVIDER_LABEL[b.provider]}发出「${a.label}」请求`);
        } catch (e) {
          message.error(errorText(e));
        }
      },
    });
  }

  /** 返回 true 表示这个 key 属于快捷命令菜单并已处理 */
  function onSelect(key: string): boolean {
    if (key.startsWith("__cloud:")) {
      const a = CLOUD_ACTIONS.find((x) => x.key === key);
      if (a) runCloud(a);
      return true;
    }
    if (key === "__batch") {
      commands.openBatch(host.value ? [host.value.id] : []);
      return true;
    }
    if (key === "__manage") {
      commands.managerOpen = true;
      return true;
    }
    const s = byId.value.get(key);
    if (!s) return false;
    if (s.confirm || s.danger) confirmAndRun(s);
    else run(s);
    return true;
  }

  return { options, groupOptions, renderLabel, onSelect };
}
