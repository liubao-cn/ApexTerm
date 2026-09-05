import { markRaw, ref, shallowRef } from "vue";
import { defineStore } from "pinia";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { errorText } from "../api";

/**
 * idle → checking → available（有新版）→ downloading → installed（已装好，等重启）
 *                 ↘ latest / error
 */
export type UpdatePhase = "idle" | "checking" | "available" | "downloading" | "installed" | "latest" | "error";

export const HOMEPAGE_URL = "https://github.com/liubao-cn/ApexTerm";
export const RELEASES_URL = `${HOMEPAGE_URL}/releases`;

/** 两次真正发出请求的最小间隔：一次请求只拿约 4 KB 的 latest.json，每天最多 4 次 */
const MIN_CHECK_INTERVAL = 6 * 60 * 60 * 1000;
/** 兜底定时器：窗口一直在前台不切换时靠它触发 maybeCheck */
const TICK_INTERVAL = 60 * 60 * 1000;
const STARTUP_DELAY = 5000;

/**
 * 应用内更新：从 GitHub Releases 的 latest.json 读取新版本（签名由 tauri-plugin-updater 校验）。
 * - 后台检查（启动 / 回到前台 / 每小时兜底，6 小时内只请求一次）发现新版只亮顶栏徽标，不弹模态框、不抢终端焦点
 * - 手动"检查更新…"直接开对话框并明确反馈结果
 * - 下载安装与重启分两步：装好后可以稍后再重启，重启会关闭所有终端会话
 */
export const useUpdaterStore = defineStore("updater", () => {
  const phase = ref<UpdatePhase>("idle");
  const show = ref(false);
  /**
   * 插件的 Update 类用了 JS 私有字段（#rid），不能被 Vue 包成响应式 Proxy——否则调用
   * downloadAndInstall 时会抛 "Cannot read private member from an object whose class did not declare it"。
   * 用 shallowRef 持有，并 markRaw 防止被别处的 reactive 再包一层。
   */
  const update = shallowRef<Update | null>(null);
  const error = ref("");
  const downloaded = ref(0);
  const total = ref<number | null>(null);
  /** 本次是否由用户手动触发（决定"已是最新 / 出错"要不要打扰） */
  const manual = ref(false);
  /** 用户点过「稍后」的版本：本次运行不再弹提示（徽标保留，随时可点） */
  const snoozedVersion = ref<string | null>(null);
  /** 后台发现新版本时的一次性通知（AppShell 挂 toast），同一版本只通知一次 */
  const notifiedVersion = ref<string | null>(null);
  let lastCheckAt = 0;

  async function checkForUpdates(opts: { manual: boolean }): Promise<UpdatePhase> {
    if (phase.value === "checking" || phase.value === "downloading" || phase.value === "installed") {
      if (opts.manual) show.value = true;
      return phase.value;
    }
    manual.value = opts.manual;
    phase.value = "checking";
    error.value = "";
    if (opts.manual) show.value = true;
    lastCheckAt = Date.now();
    try {
      const u = await check({ timeout: 15_000 });
      if (u) {
        update.value = markRaw(u);
        phase.value = "available";
        // 后台发现：只亮徽标；点过「稍后」的版本连 toast 都不再发
        if (opts.manual) show.value = true;
        else if (u.version !== snoozedVersion.value && u.version !== notifiedVersion.value) notifiedVersion.value = u.version;
      } else {
        update.value = null;
        phase.value = "latest";
        if (!opts.manual) show.value = false;
      }
    } catch (e) {
      phase.value = "error";
      error.value = errorText(e);
      if (!opts.manual) show.value = false;
    }
    return phase.value;
  }

  /** 后台调度用：6 小时内只真正请求一次；正在下载 / 已装好等重启时不再查 */
  function maybeCheck() {
    if (phase.value === "checking" || phase.value === "downloading" || phase.value === "installed") return;
    if (Date.now() - lastCheckAt < MIN_CHECK_INTERVAL) return;
    checkForUpdates({ manual: false });
  }

  /** 启动 5 秒后、窗口回到前台、每小时兜底各触发一次 maybeCheck；返回停止函数 */
  function startSchedule(): () => void {
    const startup = window.setTimeout(maybeCheck, STARTUP_DELAY);
    const tick = window.setInterval(maybeCheck, TICK_INTERVAL);
    const onVisible = () => {
      if (document.visibilityState === "visible") maybeCheck();
    };
    window.addEventListener("focus", maybeCheck);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(startup);
      window.clearInterval(tick);
      window.removeEventListener("focus", maybeCheck);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }

  /** 下载并安装到位，不重启；之后由用户决定立即还是稍后重启 */
  async function install() {
    const u = update.value;
    if (!u || phase.value === "downloading") return;
    phase.value = "downloading";
    show.value = true;
    downloaded.value = 0;
    total.value = null;
    error.value = "";
    try {
      await u.downloadAndInstall((ev) => {
        if (ev.event === "Started") total.value = ev.data.contentLength ?? null;
        else if (ev.event === "Progress") downloaded.value += ev.data.chunkLength;
      });
      phase.value = "installed";
    } catch (e) {
      phase.value = "error";
      error.value = errorText(e);
    }
  }

  async function restart() {
    await relaunch();
  }

  /** 「稍后」：本次运行不再为这个版本弹提示 */
  function snooze() {
    if (update.value) snoozedVersion.value = update.value.version;
    show.value = false;
  }

  function open() {
    show.value = true;
  }

  function dismiss() {
    show.value = false;
    if (phase.value === "latest" || phase.value === "error") phase.value = "idle";
  }

  return {
    phase,
    show,
    update,
    error,
    downloaded,
    total,
    manual,
    snoozedVersion,
    notifiedVersion,
    checkForUpdates,
    maybeCheck,
    startSchedule,
    install,
    restart,
    snooze,
    open,
    dismiss,
  };
});
