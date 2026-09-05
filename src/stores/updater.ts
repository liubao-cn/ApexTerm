import { markRaw, ref, shallowRef } from "vue";
import { defineStore } from "pinia";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { errorText } from "../api";

export type UpdatePhase = "idle" | "checking" | "available" | "downloading" | "ready" | "latest" | "error";

export const HOMEPAGE_URL = "https://github.com/liubao-cn/ApexTerm";
export const RELEASES_URL = `${HOMEPAGE_URL}/releases`;

/**
 * 应用内更新：从 GitHub Releases 的 latest.json 读取新版本（签名由 tauri-plugin-updater 校验），
 * 下载完成后重启换新。启动时静默检查一次；菜单"检查更新…"手动检查会明确反馈结果。
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

  async function checkForUpdates(opts: { manual: boolean }): Promise<UpdatePhase> {
    if (phase.value === "checking" || phase.value === "downloading") {
      if (opts.manual) show.value = true;
      return phase.value;
    }
    manual.value = opts.manual;
    phase.value = "checking";
    error.value = "";
    if (opts.manual) show.value = true;
    try {
      const u = await check({ timeout: 15_000 });
      if (u) {
        update.value = markRaw(u);
        phase.value = "available";
        show.value = true;
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
        else if (ev.event === "Finished") phase.value = "ready";
      });
      phase.value = "ready";
      await relaunch();
    } catch (e) {
      phase.value = "error";
      error.value = errorText(e);
    }
  }

  function dismiss() {
    show.value = false;
    if (phase.value === "latest" || phase.value === "error") phase.value = "idle";
  }

  return { phase, show, update, error, downloaded, total, manual, checkForUpdates, install, dismiss };
});
