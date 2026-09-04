import type { HostEntry } from "./api";

export type SnippetMode = "terminal" | "silent";

export interface Snippet {
  id: string;
  name: string;
  /** 命令模板；`{sudo}` 在 root 用户下展开为空，否则为 `sudo ` */
  command: string;
  group: string;
  /** terminal：在终端标签里执行（可交互、能输 sudo 密码）；silent：后台执行并收集输出 */
  mode: SnippetMode;
  confirm: boolean;
  danger: boolean;
  /** 执行后轮询主机，直到重新上线 */
  watchReboot: boolean;
  /** 为空 = 所有主机可用 */
  hostIds: string[];
  builtin?: boolean;
  description?: string;
}

export const SNIPPET_GROUPS = ["状态", "服务", "容器", "磁盘", "更新", "工具", "电源", "自定义"] as const;

const b = (
  id: string,
  name: string,
  command: string,
  group: string,
  mode: SnippetMode,
  extra: Partial<Snippet> = {},
): Snippet => ({
  id: `b.${id}`,
  name,
  command,
  group,
  mode,
  confirm: false,
  danger: false,
  watchReboot: false,
  hostIds: [],
  builtin: true,
  ...extra,
});

/**
 * 内置命令库。原则：只用 coreutils / procps / iproute2 / systemd 等几乎所有 Linux 都有的命令，
 * 发行版相关的（apt / dnf）在名字里标明；需要 systemd 的在描述里标明。
 */
export const BUILTIN_SNIPPETS: Snippet[] = [
  // 状态
  b("uptime", "运行时间与负载", "uptime", "状态", "silent"),
  b("os", "系统版本与内核", "cat /etc/os-release 2>/dev/null | head -n 2; uname -srm", "状态", "silent"),
  b("df", "磁盘使用", "df -h", "状态", "silent"),
  b("free", "内存使用", "free -m", "状态", "silent"),
  b("top", "CPU / 内存占用快照", "top -bn1 | head -n 20", "状态", "silent"),
  b("ip", "IP 地址", "hostname -I 2>/dev/null || ip -brief addr 2>/dev/null || ifconfig", "状态", "silent"),
  b("ports", "监听端口", "ss -lntup 2>/dev/null || netstat -lntup", "状态", "silent", {
    description: "非 root 看不到进程名，属正常现象",
  }),
  b("who", "当前登录用户", "who", "状态", "silent"),

  // 服务（systemd）
  b("failed", "失败的服务", "systemctl --failed --no-pager", "服务", "silent", {
    description: "需要 systemd",
  }),
  b("journal", "最近 50 条错误日志", "journalctl -p err -n 50 --no-pager", "服务", "silent", {
    description: "需要 systemd",
  }),
  b("dmesg", "内核日志（最近 30 行）", "{sudo}dmesg | tail -n 30", "服务", "silent"),
  b("journal.follow", "实时跟踪系统日志", "journalctl -f", "服务", "terminal", {
    description: "需要 systemd，Ctrl+C 退出",
  }),

  // 容器
  b(
    "docker.ps",
    "Docker 容器列表",
    'docker ps -a --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"',
    "容器",
    "silent",
  ),
  b("docker.stats", "Docker 资源占用", "docker stats --no-stream", "容器", "silent"),
  b("docker.df", "Docker 磁盘占用", "docker system df", "容器", "silent"),
  b("docker.prune", "清理无用镜像 / 容器 / 网络", "docker system prune -f", "容器", "silent", {
    confirm: true,
    description: "不会删除正在使用的镜像和数据卷",
  }),

  // 磁盘
  b(
    "du",
    "大目录排查",
    "{sudo}du -xsh /var/log /var/lib/docker /home /root /opt /tmp 2>/dev/null | sort -h",
    "磁盘",
    "silent",
  ),
  b("journal.size", "系统日志占用", "journalctl --disk-usage", "磁盘", "silent", {
    description: "需要 systemd",
  }),
  b("journal.vacuum", "系统日志瘦身到 200M", "{sudo}journalctl --vacuum-size=200M", "磁盘", "silent", {
    confirm: true,
    description: "需要 systemd",
  }),

  // 更新
  b("apt", "apt 更新升级（Debian / Ubuntu）", "{sudo}apt-get update && {sudo}apt-get upgrade -y", "更新", "terminal", {
    confirm: true,
  }),
  b("dnf", "dnf / yum 更新（RHEL 系）", "{sudo}sh -c 'command -v dnf >/dev/null && dnf -y upgrade || yum -y update'", "更新", "terminal", {
    confirm: true,
  }),

  // 工具（交互）
  b("htop", "htop（没有则 top）", "htop 2>/dev/null || top", "工具", "terminal"),
  b("nginx.reload", "Nginx 测试配置并重载", "{sudo}nginx -t && {sudo}systemctl reload nginx", "工具", "silent", {
    confirm: true,
  }),

  // 电源（走 SSH 的"软"操作；服务器卡死、SSH 不通时无效，那种情况需要云厂商 API 的强制重启）
  b("reboot", "软重启（SSH）", "{sudo}reboot", "电源", "terminal", {
    confirm: true,
    danger: true,
    watchReboot: true,
    description: "适用于计划内重启（如升级内核后）。执行后自动监视，恢复上线时提醒。服务器卡死、SSH 进不去时请用云厂商 API 强制重启。",
  }),
  b("shutdown", "关机（SSH）", "{sudo}shutdown -h now", "电源", "terminal", {
    confirm: true,
    danger: true,
    description: "关机后 SSH 无法再开机，只能通过云厂商控制台 / API 或物理机 IPMI 开机。",
  }),
];

/** 按目标主机展开模板变量 */
export function resolveCommand(template: string, host: HostEntry): string {
  const isRoot = (host.user ?? "").toLowerCase() === "root";
  return template.split("{sudo}").join(isRoot ? "" : "sudo ");
}

export function snippetAppliesTo(s: Snippet, host: HostEntry): boolean {
  return s.hostIds.length === 0 || s.hostIds.includes(host.id);
}

export function newCustomSnippet(): Snippet {
  return {
    id: `c.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: "",
    command: "",
    group: "自定义",
    mode: "silent",
    confirm: false,
    danger: false,
    watchReboot: false,
    hostIds: [],
  };
}
