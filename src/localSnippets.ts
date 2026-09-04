import type { Snippet, SnippetMode } from "./snippets";
import { isMac, isWindows } from "./platform";

/** 本机控制台的内置命令库：按平台给不同的一套 */
export const LOCAL_GROUPS = ["系统", "网络", "开发", "Homebrew", "Docker", "Git", "清理", "自定义"] as const;

const b = (
  id: string,
  name: string,
  command: string,
  group: string,
  mode: SnippetMode,
  extra: Partial<Snippet> = {},
): Snippet => ({
  id: `l.${id}`,
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

const MAC: Snippet[] = [
  // 系统
  b("top", "CPU / 内存占用", "top -l 1 -n 15 -o cpu | head -n 30", "系统", "silent"),
  b("df", "磁盘使用", "df -h / ~ 2>/dev/null", "系统", "silent"),
  b("battery", "电池状态", "pmset -g batt", "系统", "silent"),
  b("uptime", "运行时间与负载", "uptime", "系统", "silent"),
  b("bigfiles", "家目录里最大的文件夹", "du -sh ~/* 2>/dev/null | sort -rh | head -n 15", "系统", "silent", {
    description: "扫一遍家目录，几秒到几十秒",
  }),
  b("show-hidden", "Finder 显示隐藏文件", "defaults write com.apple.finder AppleShowAllFiles -bool true && killall Finder", "系统", "silent"),
  b("hide-hidden", "Finder 隐藏隐藏文件", "defaults write com.apple.finder AppleShowAllFiles -bool false && killall Finder", "系统", "silent"),
  b("sleep", "立即睡眠", "pmset sleepnow", "系统", "silent", { confirm: true }),
  b("lock", "锁定屏幕", "pmset displaysleepnow", "系统", "silent"),
  // 网络
  b("myip", "公网 IP", "curl -s --max-time 5 https://ifconfig.me; echo", "网络", "silent"),
  b("localip", "本机 IP", "ipconfig getifaddr en0 2>/dev/null; ipconfig getifaddr en1 2>/dev/null; echo", "网络", "silent"),
  b("ports", "监听端口与进程", "lsof -nP -iTCP -sTCP:LISTEN", "网络", "silent"),
  b("flushdns", "清除 DNS 缓存", "sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder", "网络", "terminal", {
    description: "需要输入本机密码",
  }),
  b("ping", "Ping 8.8.8.8", "ping -c 5 8.8.8.8", "网络", "silent"),
  b("wifi", "当前 Wi‑Fi", "networksetup -getairportnetwork en0 2>/dev/null || echo 未连接", "网络", "silent"),
  b("speed", "测速（需 speedtest-cli）", "speedtest-cli --simple 2>/dev/null || echo '未安装：brew install speedtest-cli'", "网络", "silent"),
  // 开发
  b("node-v", "Node / npm / pnpm 版本", "node -v; npm -v; pnpm -v 2>/dev/null; echo; nvm ls 2>/dev/null | head -n 8", "开发", "silent"),
  b("python-v", "Python 版本", "python3 --version; which python3", "开发", "silent"),
  b("rust-v", "Rust 版本", "rustc --version; cargo --version", "开发", "silent"),
  b("serve", "当前目录起 HTTP 服务 :8000", "python3 -m http.server 8000", "开发", "terminal"),
  b("kill-port", "杀掉占用 3000 端口的进程", "lsof -ti tcp:3000 | xargs kill -9", "开发", "silent", { confirm: true }),
  b("ssh-keys", "本机 SSH 公钥", "for f in ~/.ssh/*.pub; do echo \"== $f\"; cat \"$f\"; done", "开发", "silent"),
  b("ssh-agent", "ssh-agent 里的密钥", "ssh-add -l", "开发", "silent"),
  // Homebrew
  b("brew-outdated", "可升级的软件", "brew outdated", "Homebrew", "silent"),
  b("brew-update", "更新 Homebrew 索引", "brew update", "Homebrew", "terminal"),
  b("brew-upgrade", "升级全部软件", "brew upgrade", "Homebrew", "terminal", { confirm: true }),
  b("brew-cleanup", "清理旧版本缓存", "brew cleanup -s", "Homebrew", "silent"),
  b("brew-services", "Homebrew 服务状态", "brew services list", "Homebrew", "silent"),
  b("brew-doctor", "brew doctor", "brew doctor", "Homebrew", "silent"),
  // Docker
  b("docker-ps", "运行中的容器", "docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}'", "Docker", "silent"),
  b("docker-all", "所有容器", "docker ps -a --format 'table {{.Names}}\\t{{.Status}}\\t{{.Image}}'", "Docker", "silent"),
  b("docker-stats", "容器资源占用", "docker stats --no-stream", "Docker", "silent"),
  b("docker-images", "镜像列表", "docker images", "Docker", "silent"),
  b("docker-prune", "清理无用镜像/容器/网络", "docker system prune -f", "Docker", "silent", { confirm: true, danger: true }),
  b("compose-up", "docker compose up -d（当前目录）", "docker compose up -d", "Docker", "terminal"),
  b("compose-logs", "docker compose logs（当前目录）", "docker compose logs -f --tail=100", "Docker", "terminal"),
  // Git
  b("git-status", "git status", "git status -sb", "Git", "silent"),
  b("git-log", "最近 15 次提交", "git log --oneline -n 15", "Git", "silent"),
  b("git-pull", "git pull", "git pull --rebase --autostash", "Git", "terminal"),
  b("git-branches", "分支列表", "git branch -vv", "Git", "silent"),
  b("git-stash", "stash 列表", "git stash list", "Git", "silent"),
  // 清理
  b("trash", "清空废纸篓", "rm -rf ~/.Trash/* 2>/dev/null; echo 已清空", "清理", "silent", { confirm: true, danger: true }),
  b("npm-cache", "清理 npm / pnpm 缓存", "npm cache clean --force; pnpm store prune 2>/dev/null", "清理", "silent"),
  b("xcode-derived", "清理 Xcode DerivedData", "rm -rf ~/Library/Developer/Xcode/DerivedData/*; echo 已清理", "清理", "silent", { confirm: true }),
  b("ds-store", "删除当前目录下所有 .DS_Store", "find . -name .DS_Store -delete; echo 完成", "清理", "silent"),
  b("caches-size", "缓存目录占用", "du -sh ~/Library/Caches 2>/dev/null", "清理", "silent"),
];

const WINDOWS: Snippet[] = [
  b("sysinfo", "系统信息", "systeminfo | Select-Object -First 20", "系统", "silent"),
  b("top", "CPU 占用前 15", "Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 Name,CPU,WS | Format-Table", "系统", "silent"),
  b("df", "磁盘使用", "Get-PSDrive -PSProvider FileSystem | Format-Table Name,Used,Free", "系统", "silent"),
  b("uptime", "开机时长", "(Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime", "系统", "silent"),
  b("myip", "公网 IP", "(Invoke-WebRequest -UseBasicParsing https://ifconfig.me).Content", "网络", "silent"),
  b("localip", "本机 IP", "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' } | Select-Object InterfaceAlias,IPAddress | Format-Table", "网络", "silent"),
  b("ports", "监听端口", "Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess | Format-Table", "网络", "silent"),
  b("flushdns", "清除 DNS 缓存", "ipconfig /flushdns", "网络", "silent"),
  b("ping", "Ping 8.8.8.8", "ping -n 5 8.8.8.8", "网络", "silent"),
  b("node-v", "Node / npm 版本", "node -v; npm -v", "开发", "silent"),
  b("python-v", "Python 版本", "python --version", "开发", "silent"),
  b("ssh-keys", "本机 SSH 公钥", "Get-Content ~\\.ssh\\*.pub", "开发", "silent"),
  b("winget-upgrade", "可升级的软件（winget）", "winget upgrade", "系统", "silent"),
  b("docker-ps", "运行中的容器", "docker ps", "Docker", "silent"),
  b("docker-stats", "容器资源占用", "docker stats --no-stream", "Docker", "silent"),
  b("git-status", "git status", "git status -sb", "Git", "silent"),
  b("git-log", "最近 15 次提交", "git log --oneline -n 15", "Git", "silent"),
  b("git-pull", "git pull", "git pull --rebase --autostash", "Git", "terminal"),
  b("temp", "清理临时文件", "Remove-Item $env:TEMP\\* -Recurse -Force -ErrorAction SilentlyContinue; '完成'", "清理", "silent", { confirm: true }),
];

const LINUX: Snippet[] = [
  b("top", "CPU / 内存占用", "top -bn1 | head -n 20", "系统", "silent"),
  b("df", "磁盘使用", "df -h", "系统", "silent"),
  b("free", "内存使用", "free -m", "系统", "silent"),
  b("uptime", "运行时间与负载", "uptime", "系统", "silent"),
  b("myip", "公网 IP", "curl -s --max-time 5 https://ifconfig.me; echo", "网络", "silent"),
  b("localip", "本机 IP", "ip -brief addr", "网络", "silent"),
  b("ports", "监听端口", "ss -lntup", "网络", "silent"),
  b("ping", "Ping 8.8.8.8", "ping -c 5 8.8.8.8", "网络", "silent"),
  b("node-v", "Node / npm 版本", "node -v; npm -v", "开发", "silent"),
  b("ssh-keys", "本机 SSH 公钥", "cat ~/.ssh/*.pub", "开发", "silent"),
  b("docker-ps", "运行中的容器", "docker ps", "Docker", "silent"),
  b("git-status", "git status", "git status -sb", "Git", "silent"),
  b("git-pull", "git pull", "git pull --rebase --autostash", "Git", "terminal"),
  b("apt-upgradable", "可升级的包（apt）", "apt list --upgradable 2>/dev/null", "系统", "silent"),
];

export const BUILTIN_LOCAL_SNIPPETS: Snippet[] = isMac ? MAC : isWindows ? WINDOWS : LINUX;

export function newLocalSnippetDraft(): Snippet {
  return {
    id: `lc.${Date.now().toString(36)}`,
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

/** 内置命令"复制为自定义"，自定义命令原地编辑 */
export function localSnippetForEdit(sn: Snippet): Snippet {
  return { ...sn, id: sn.builtin ? `lc.${Date.now().toString(36)}` : sn.id, builtin: false };
}
