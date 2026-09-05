# ApexTerm

面向运维与开发者的 SSH 桌面终端（macOS / Windows），以 `~/.ssh/config` 为唯一数据源：
不另建一套主机数据库，打开就是你已有的免密服务器；程序只追加标签、备注、快捷命令等附加信息。

技术栈：Tauri 2 + Rust 后端，Vue 3 + Naive UI + xterm.js 前端。

## 功能

- **终端**：分屏（拖面板头可换位置 / 插到任一侧、拖分割线调比例）、标签拖拽排序、`⌘⌥方向键` 切换面板、双击重命名、查找、自动重连、可自定义快捷键。
- **配色**：自带 ApexTerm Dark / Light，加 iTerm2-Color-Schemes 全部 600+ 套；可读性增强（自动把对比度不足的 ANSI 色拉到 ≥ 4.5:1）；界面深浅色跟随系统。
- **剪贴板**：粘贴 / 拖放图片与文件到本地终端直接得到路径；复制 TUI（Claude Code、Devin CLI 等）输出时自动接回被截断的长行，右键可选保留换行。
- **连接中心**：搜索、标签、分组、在线探测、隐私模式（截图打码）、`ssh -G` 解析实际连接参数、known_hosts 管理。
- **快捷命令**：本机 / 服务器两套，分组可拖拽排序、可收起；一键在终端执行或后台执行；多台服务器批量执行。
- **文件**：SFTP 文件管理、本地文件夹联动、双击传输。
- **云账号**：腾讯云 / 火山引擎带外开关机（SecretKey 存系统钥匙串，不落盘）。
- **本机控制台**：系统概况、常用目录、最近命令。
- **`⌘P` 命令面板**：一个输入框搜遍主机、文件、快捷命令、目录与程序动作。

## 安装（macOS）

1. 从 [Releases](https://github.com/liubao-cn/ApexTerm/releases) 下载 `.dmg`（Apple Silicon 选 `aarch64`，Intel 选 `x64`），打开后把 ApexTerm 拖到「应用程序」。
2. 首次打开若提示"无法验证开发者"（未做 Apple 签名），任选其一：
   - 应用程序里 **右键 → 打开**，再点「打开」；或
   - 终端执行 `xattr -dr com.apple.quarantine /Applications/ApexTerm.app`
3. 依赖系统自带的 OpenSSH。

数据位置：

- `~/.ssh/config`：唯一的主机数据源，写入前自动备份到 `~/.ssh/config.bak-时间戳`。
- `~/Library/Application Support/com.mac.apexterm/meta.json`：标签、备注、快捷命令、常用目录、快捷键等附加信息。
- 系统钥匙串：云账号 SecretKey。

## 默认快捷键（macOS；Windows 为 `Ctrl+Shift+字母`，标签切换 `Alt+1–9`）

| 操作 | 快捷键 |
|---|---|
| 新建本地终端 / 关闭当前面板 | `⌘T` / `⌘W` |
| 向右 / 向下分屏 | `⌘D` / `⌘⇧D` |
| 切换聚焦面板 | `⌘⌥←↑→↓` |
| 上一个 / 下一个标签，跳到第 N 个标签 | `⌘⇧[` / `⌘⇧]`，`⌘1–9` |
| 命令面板 / 侧栏收起 | `⌘P` / `⌘B` |
| 终端查找 / 清屏 | `⌘F` / `⌘K` |
| 字号放大 / 缩小 / 恢复 | `⌘=` / `⌘-` / `⌘0` |
| 设置 | `⌘,` |

全部可在「设置 → 快捷键」修改。

## 从源码构建

需要 Node ≥ 20、pnpm、Rust 稳定版（rustup）。

```bash
pnpm install
pnpm tauri dev      # 开发
pnpm tauri build    # 打包当前架构，产物在 src-tauri/target/release/bundle/
pnpm typecheck      # vue-tsc
pnpm test           # 前端单元测试（Node 内置 test runner）
cargo test --manifest-path src-tauri/Cargo.toml
```

通用包（Apple Silicon + Intel）：`rustup target add x86_64-apple-darwin` 后 `pnpm tauri build --target universal-apple-darwin`。

本地打包会同时生成更新器用的 `.app.tar.gz` 并要求签名：设置 `TAURI_SIGNING_PRIVATE_KEY`（私钥内容）与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 后再 `pnpm tauri build`；只想得到 `.app` 试跑可忽略最后的签名报错。正式发布走 GitHub Actions，见下。

### Windows

1. 安装 [Rust](https://rustup.rs)、Node、pnpm 与 Visual Studio C++ 生成工具（Tauri 前置要求）。
2. 确认有 OpenSSH 客户端（`设置 → 应用 → 可选功能 → OpenSSH 客户端`，Win10 1809+ 默认已装），或安装 Git for Windows。
3. `pnpm install && pnpm tauri build` → `src-tauri/target/release/bundle/msi/` 或 `nsis/`。

Windows 上的差异：本地终端用 PowerShell 7（若已安装）或 Windows PowerShell；云账号 SecretKey 在没有钥匙串时存到程序数据目录下仅当前用户可读的文件；`~/.ssh/config` 与 `known_hosts` 读 `%USERPROFILE%\.ssh`。Windows 分支未经实机测试，欢迎反馈。

## 发布与自动更新

- 发布：`pnpm release 1.0.1` 同步 `package.json` / `tauri.conf.json` / `Cargo.toml` 的版本号并打 `v1.0.1` 标签，`git push --follow-tags` 后 GitHub Actions（`.github/workflows/release.yml`）在 macOS（Apple Silicon、Intel）与 Windows 上构建并直接发布 Release。
- 更新：程序启动后静默检查 [Releases](https://github.com/liubao-cn/ApexTerm/releases) 的 `latest.json`，有新版本弹窗提示，下载后校验签名并重启换新；也可在「ApexTerm → 检查更新…」手动检查，「设置 → 关于」可关闭启动检查。
- 自建发布需要在仓库 Secrets 里配置 `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（`pnpm tauri signer generate` 生成），并把公钥写到 `tauri.conf.json` 的 `plugins.updater.pubkey`。

## 目录

- `src/` 前端（Vue 3 + Naive UI + xterm.js）
- `src-tauri/` 后端（Rust：ssh config 解析 / 写回、pty、SFTP、云 API、剪贴板、文件监视）
- `tests/` 前端单元测试
- `scripts/make_icon.py` 生成应用图标（再用 `pnpm tauri icon app-icon.png` 派生全部尺寸）

## 许可

[MIT](LICENSE)。内置配色来自 [iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes)（MIT），其它第三方许可见 `THIRD_PARTY_LICENSES.md`。
