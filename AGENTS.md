# ApexTerm 项目规则

## 构建与验证（严禁占满本机磁盘）

- **禁止在本机运行 `tauri build`、`cargo build`、`cargo test` 等 Rust 编译命令**：`src-tauri/target` 单次编译会产生约 9–12 GB 缓存，挤占本机磁盘空间。若误触发，必须立即执行 `cargo clean --manifest-path src-tauri/Cargo.toml` 清理。
- **本地验证仅运行轻量前端检查**：
  - 单测：`pnpm test`
  - 类型检查：`pnpm typecheck`
- **多平台编译、签名与安装包构建统一交由 GitHub Actions 完成**：
  - 常规校验见 `.github/workflows/ci.yml`
  - 发版流程：先提交代码与 `CHANGELOG.md` 的「未发布」说明，再执行 `pnpm release <主.次.补丁>` 生成版本提交与 `v*` 标签，最后 `git push --follow-tags` 触发 `.github/workflows/release.yml` 自动打包发布（应用内更新器会自动拉取新版本）。
