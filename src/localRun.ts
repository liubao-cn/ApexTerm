import { h } from "vue";
import { useDialog, useMessage } from "naive-ui";
import { errorText } from "./api";
import type { Snippet } from "./snippets";
import { useCommandsStore } from "./stores/commands";
import { useConsoleStore } from "./stores/console";
import type { TermSession } from "./stores/terminals";

/** 本机快捷命令的"执行（含确认）/ 删除或隐藏"逻辑，本机控制台与快捷命令面板共用；必须在组件 setup 里调用 */
export function useLocalRun() {
  const commands = useCommandsStore();
  const console_ = useConsoleStore();
  const dialog = useDialog();
  const message = useMessage();

  /** session：终端模式要输入到的会话；不传则由 commands 选当前聚焦的本地会话 */
  function run(sn: Snippet, cwd: string | null, session?: TermSession | null) {
    const go = () => {
      commands.executeLocal(sn, cwd, session);
      if (sn.mode === "silent") message.info(`已在本机执行：${sn.name}`);
    };
    if (!(sn.confirm || sn.danger)) return go();
    dialog[sn.danger ? "error" : "warning"]({
      title: `${sn.name} · 本机`,
      content: () =>
        h("div", { class: "qc-confirm" }, [
          h("div", { class: "qc-confirm-cmd mono" }, sn.command),
          h("div", { class: "qc-confirm-note" }, sn.mode === "silent" ? "后台执行，完成后显示输出" : "在本地终端里执行"),
          sn.description ? h("div", { class: "qc-confirm-note" }, sn.description) : null,
        ]),
      positiveText: sn.danger ? "确认执行" : "执行",
      negativeText: "取消",
      onPositiveClick: go,
    });
  }

  function remove(sn: Snippet) {
    dialog.warning({
      title: sn.builtin ? `隐藏「${sn.name}」？` : `删除「${sn.name}」？`,
      content: sn.builtin ? "内置命令只是隐藏，可在本机控制台「恢复全部内置命令」找回。" : "自定义命令会被删除。",
      positiveText: sn.builtin ? "隐藏" : "删除",
      negativeText: "取消",
      onPositiveClick: () => console_.removeSnippet(sn).catch((e) => message.error(errorText(e))),
    });
  }

  return { run, remove };
}
