use std::path::PathBuf;

use serde::Serialize;
use tauri::State;

use tauri::ipc::Channel;

use crate::cloud::{self, secrets::SecretStore, CloudInstance, PowerAction, ScanResult};
use crate::error::{AppError, Result};
use crate::keys::{self, KeyInfo};
use crate::known_hosts::{self, Candidate, ProbeResult};
use crate::meta::{CloudAccount, CloudBinding, HostMeta, Meta, MetaStore, Snippet};
use crate::remote::{self, RunResult};
use crate::ssh_config::{display_path, expand_tilde, ConfigStore, HostEntry, HostInput};
use crate::terminal::{TermMessage, TerminalState, TerminalTarget};

pub struct AppState {
    pub ssh_dir: PathBuf,
    pub meta: MetaStore,
    pub secrets: SecretStore,
    pub data_dir: PathBuf,
}

/// 设置页「关于」用：版本、数据目录、快捷键定义
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub data_dir: String,
    pub meta_path: String,
    pub ssh_dir: String,
    pub shortcuts: Vec<crate::menu::ShortcutDef>,
    pub platform: &'static str,
}

#[tauri::command]
pub fn app_info(app: tauri::AppHandle, state: State<AppState>) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        data_dir: state.data_dir.to_string_lossy().to_string(),
        meta_path: state.data_dir.join("meta.json").to_string_lossy().to_string(),
        ssh_dir: state.ssh_dir.to_string_lossy().to_string(),
        shortcuts: crate::menu::defaults(),
        platform: std::env::consts::OS,
    }
}

// ---- 本机控制台 ----

#[tauri::command]
pub async fn run_local(command: String, cwd: Option<String>, timeout_secs: Option<u64>) -> Result<RunResult> {
    let timeout = std::time::Duration::from_secs(timeout_secs.unwrap_or(60).clamp(1, 600));
    tauri::async_runtime::spawn_blocking(move || crate::local::run(&command, cwd.as_deref(), timeout))
        .await
        .map_err(|e| AppError::msg(format!("执行任务异常: {e}")))?
}

#[tauri::command]
pub fn local_recent_commands(limit: Option<usize>) -> Vec<String> {
    crate::local::recent_commands(limit.unwrap_or(30).min(200))
}

#[tauri::command]
pub async fn local_summary() -> Result<crate::local::Summary> {
    tauri::async_runtime::spawn_blocking(crate::local::summary)
        .await
        .map_err(|e| AppError::msg(format!("读取系统信息失败: {e}")))
}

#[tauri::command]
pub fn save_local_snippets(state: State<AppState>, snippets: Vec<Snippet>, hidden: Vec<String>) -> Result<Meta> {
    state.meta.save_local_snippets(snippets, hidden)
}

#[tauri::command]
pub fn save_local_dirs(state: State<AppState>, dirs: Vec<crate::meta::LocalDir>) -> Result<Meta> {
    state.meta.save_local_dirs(dirs)
}

/// 读剪贴板给终端粘贴：文件 / 图片返回本机路径（图片先存成 PNG），否则返回文本
#[tauri::command]
pub async fn clipboard_paste_payload(state: State<'_, AppState>) -> Result<crate::clipboard::PastePayload> {
    let dir = state.data_dir.join("pasted-images");
    tauri::async_runtime::spawn_blocking(move || crate::clipboard::read(&dir))
        .await
        .map_err(|e| AppError::msg(format!("读取剪贴板任务异常: {e}")))?
}

/// 前端未捕获错误转发到后端日志（开发时能在 tauri dev 输出里看到，正式版进系统日志）
#[tauri::command]
pub fn log_frontend_error(message: String, stack: Option<String>, info: Option<String>) {
    eprintln!(
        "[frontend error] {message}\n  info: {}\n  {}",
        info.unwrap_or_default(),
        stack.unwrap_or_default()
    );
}

/// 保存快捷键覆盖并立即重建菜单
#[tauri::command]
pub fn save_shortcuts(
    app: tauri::AppHandle,
    state: State<AppState>,
    shortcuts: std::collections::HashMap<String, String>,
) -> Result<Meta> {
    let meta = state.meta.set_shortcuts(shortcuts.clone())?;
    crate::menu::rebuild(&app, &shortcuts).map_err(|e| AppError::msg(format!("重建菜单失败: {e}")))?;
    Ok(meta)
}

impl AppState {
    fn config(&self) -> Result<ConfigStore> {
        ConfigStore::load(self.ssh_dir.clone())
    }

    fn cloud_account(&self, id: &str) -> Result<(CloudAccount, String)> {
        let meta = self.meta.load()?;
        let account = meta
            .cloud_accounts
            .into_iter()
            .find(|a| a.id == id)
            .ok_or_else(|| AppError::msg("云账号不存在"))?;
        let secret = self.secrets.get(&account.id)?;
        Ok((account, secret))
    }

    fn cloud_binding(&self, host_id: &str) -> Result<(CloudBinding, Box<dyn cloud::Provider>)> {
        let meta = self.meta.load()?;
        let binding = meta
            .hosts
            .get(host_id)
            .and_then(|h| h.cloud.clone())
            .ok_or_else(|| AppError::msg("这台主机还没有绑定云实例"))?;
        let (account, secret) = self.cloud_account(&binding.account_id)?;
        Ok((binding, cloud::client(&account, &secret)?))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostsPayload {
    pub hosts: Vec<HostEntry>,
    pub files: Vec<String>,
    pub config_path: String,
    pub meta_path: String,
}

#[tauri::command]
pub fn load_hosts(state: State<AppState>) -> Result<HostsPayload> {
    let store = state.config()?;
    Ok(HostsPayload {
        hosts: store.hosts(),
        files: store.files(),
        config_path: display_path(&state.ssh_dir.join("config")),
        meta_path: display_path(state.meta.path()),
    })
}

#[tauri::command]
pub fn read_config_raw(state: State<AppState>) -> Result<String> {
    Ok(state.config()?.main_doc().render())
}

#[tauri::command]
pub fn upsert_host(state: State<AppState>, input: HostInput) -> Result<String> {
    let mut store = state.config()?;
    let new_id = store.upsert_host(&input)?;
    if let Some(old) = &input.original_id {
        state.meta.rename_host(old, &new_id)?;
    }
    Ok(new_id)
}

#[tauri::command]
pub fn delete_host(state: State<AppState>, id: String) -> Result<()> {
    state.config()?.delete_host(&id)?;
    state.meta.remove_host(&id)?;
    Ok(())
}

#[tauri::command]
pub fn replace_host_raw(state: State<AppState>, id: String, raw: String) -> Result<String> {
    let new_id = state.config()?.replace_host_raw(&id, &raw)?;
    state.meta.rename_host(&id, &new_id)?;
    Ok(new_id)
}

#[tauri::command]
pub fn load_meta(state: State<AppState>) -> Result<Meta> {
    state.meta.load()
}

#[tauri::command]
pub fn save_host_meta(state: State<AppState>, id: String, meta: HostMeta) -> Result<Meta> {
    state.meta.update_host(&id, meta)
}

#[tauri::command]
pub fn save_groups(state: State<AppState>, groups: Vec<String>) -> Result<Meta> {
    state.meta.set_groups(groups)
}

#[tauri::command]
pub fn touch_host_connected(state: State<AppState>, id: String) -> Result<Meta> {
    state.meta.touch_connected(&id)
}

#[tauri::command]
pub fn save_order(state: State<AppState>, order: Vec<String>) -> Result<Meta> {
    state.meta.set_order(order)
}

/// 按 config 别名探测在线与免密状态，失败带原因
#[tauri::command]
pub async fn probe_host(alias: String) -> Result<remote::AliveResult> {
    tauri::async_runtime::spawn_blocking(move || remote::probe_alias(&alias))
        .await
        .map_err(|e| AppError::msg(format!("探测任务异常: {e}")))?
}

#[tauri::command]
pub fn save_snippets(
    state: State<AppState>,
    snippets: Vec<Snippet>,
    hidden: Vec<String>,
) -> Result<Meta> {
    state.meta.save_snippets(snippets, hidden)
}

// ---- 云账号 / 带外电源 ----

/// 新增云账号：先用凭据列一次地域做校验，通过后 Secret 进钥匙串，账号信息进 meta
#[tauri::command]
pub async fn cloud_add_account(
    state: State<'_, AppState>,
    provider: String,
    name: String,
    key_id: String,
    secret: String,
    regions: Vec<String>,
) -> Result<Meta> {
    let key_id = key_id.trim().to_string();
    let secret = secret.trim().to_string();
    if key_id.is_empty() || secret.is_empty() {
        return Err(AppError::msg("密钥不能为空"));
    }
    let account = CloudAccount {
        id: format!("{provider}-{}", &sha_short(&key_id)),
        provider,
        name: if name.trim().is_empty() {
            key_id.chars().take(8).collect::<String>() + "…"
        } else {
            name.trim().to_string()
        },
        key_id,
        regions,
    };
    let probe = account.clone();
    let probe_secret = secret.clone();
    let regions = tauri::async_runtime::spawn_blocking(move || {
        cloud::client(&probe, &probe_secret)?.regions()
    })
    .await
    .map_err(|e| AppError::msg(format!("校验任务异常: {e}")))??;
    if regions.is_empty() {
        return Err(AppError::msg("凭据校验失败：没有可用地域"));
    }
    state.secrets.set(&account.id, &secret)?;
    state.meta.add_cloud_account(account)
}

fn sha_short(s: &str) -> String {
    cloud::http::sha256_hex(s.as_bytes()).chars().take(10).collect()
}

#[tauri::command]
pub fn cloud_remove_account(state: State<AppState>, id: String) -> Result<Meta> {
    state.secrets.delete(&id)?;
    state.meta.remove_cloud_account(&id)
}

/// 扫描账号下全部地域的实例，并按公网 IP 与 config 主机匹配
#[tauri::command]
pub async fn cloud_scan(state: State<'_, AppState>, account_id: String) -> Result<ScanResult> {
    let (account, secret) = state.cloud_account(&account_id)?;
    let hosts = state.config()?.hosts();
    tauri::async_runtime::spawn_blocking(move || cloud::scan(&account, &secret, &hosts))
        .await
        .map_err(|e| AppError::msg(format!("扫描任务异常: {e}")))?
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindInput {
    pub host_id: String,
    pub binding: Option<CloudBinding>,
}

#[tauri::command]
pub fn cloud_bind(state: State<AppState>, bindings: Vec<BindInput>) -> Result<Meta> {
    state
        .meta
        .bind_cloud(bindings.into_iter().map(|b| (b.host_id, b.binding)).collect())
}

#[tauri::command]
pub async fn cloud_state(state: State<'_, AppState>, host_id: String) -> Result<CloudInstance> {
    let (binding, client) = state.cloud_binding(&host_id)?;
    tauri::async_runtime::spawn_blocking(move || client.describe(&binding))
        .await
        .map_err(|e| AppError::msg(format!("查询任务异常: {e}")))?
}

#[tauri::command]
pub async fn cloud_power(
    state: State<'_, AppState>,
    host_id: String,
    action: PowerAction,
) -> Result<()> {
    let (binding, client) = state.cloud_binding(&host_id)?;
    tauri::async_runtime::spawn_blocking(move || client.power(&binding, action))
        .await
        .map_err(|e| AppError::msg(format!("操作任务异常: {e}")))?
}

#[tauri::command]
pub async fn cloud_vnc_url(state: State<'_, AppState>, host_id: String) -> Result<String> {
    let (binding, client) = state.cloud_binding(&host_id)?;
    tauri::async_runtime::spawn_blocking(move || client.vnc_url(&binding))
        .await
        .map_err(|e| AppError::msg(format!("查询任务异常: {e}")))?
}

// ---- 远程执行 ----

/// 静默执行（BatchMode），在线程池里跑，允许多台并发
#[tauri::command]
pub async fn run_remote_command(
    alias: String,
    command: String,
    timeout_secs: Option<u64>,
) -> Result<RunResult> {
    let timeout = std::time::Duration::from_secs(timeout_secs.unwrap_or(60).clamp(1, 3600));
    tauri::async_runtime::spawn_blocking(move || remote::run(&alias, &command, timeout))
        .await
        .map_err(|e| AppError::msg(format!("执行任务异常: {e}")))?
}

#[tauri::command]
pub async fn check_host_alive(alias: String) -> Result<bool> {
    tauri::async_runtime::spawn_blocking(move || remote::is_alive(&alias))
        .await
        .map_err(|e| AppError::msg(format!("探测任务异常: {e}")))?
}

// ---- 内嵌终端 ----

#[tauri::command]
pub fn open_terminal(
    term: State<TerminalState>,
    target: TerminalTarget,
    cols: u16,
    rows: u16,
    term_type: Option<String>,
    term_program: Option<String>,
    on_event: Channel<TermMessage>,
) -> Result<String> {
    term.open(
        &target,
        cols,
        rows,
        term_type.as_deref().unwrap_or("xterm-256color"),
        term_program.as_deref().unwrap_or("apexterm"),
        on_event,
    )
}

#[tauri::command]
pub fn write_terminal(term: State<TerminalState>, id: String, data: String) -> Result<()> {
    term.write(&id, data.as_bytes())
}

#[tauri::command]
pub fn resize_terminal(term: State<TerminalState>, id: String, cols: u16, rows: u16) -> Result<()> {
    term.resize(&id, cols, rows)
}

#[tauri::command]
pub fn close_terminal(term: State<TerminalState>, id: String) -> Result<()> {
    term.close(&id)
}

#[tauri::command]
pub fn terminal_count(term: State<TerminalState>) -> usize {
    term.count()
}

#[tauri::command]
pub fn list_keys(state: State<AppState>) -> Result<Vec<KeyInfo>> {
    let store = state.config()?;
    Ok(keys::list_keys(&state.ssh_dir, &store.hosts()))
}

#[tauri::command]
pub fn load_candidates(state: State<AppState>) -> Result<Vec<Candidate>> {
    let store = state.config()?;
    let meta = state.meta.load()?;
    Ok(known_hosts::candidates(
        &state.ssh_dir,
        &store.hosts(),
        &meta.ignored_candidates,
    ))
}

#[tauri::command]
pub fn set_candidates_ignored(
    state: State<AppState>,
    keys: Vec<String>,
    ignored: bool,
) -> Result<Meta> {
    state.meta.set_candidates_ignored(&keys, ignored)
}

/// 批量新增/更新，config 只备份、写回一次；任一条校验失败则全部不写
#[tauri::command]
pub fn upsert_hosts(state: State<AppState>, inputs: Vec<HostInput>) -> Result<Vec<String>> {
    let mut store = state.config()?;
    let ids = store.upsert_many(&inputs)?;
    for (input, new_id) in inputs.iter().zip(&ids) {
        if let Some(old) = &input.original_id {
            state.meta.rename_host(old, new_id)?;
        }
    }
    Ok(ids)
}

/// 在线程池里跑 ssh，避免阻塞主线程；多台可并发探测
#[tauri::command]
pub async fn probe_candidate(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    user: String,
) -> Result<ProbeResult> {
    let store = state.config()?;
    let key_paths: Vec<PathBuf> = keys::list_keys(&state.ssh_dir, &store.hosts())
        .into_iter()
        .filter(|k| k.has_private)
        .map(|k| expand_tilde(&k.path))
        .collect();
    let user = if user.trim().is_empty() {
        "root".to_string()
    } else {
        user.trim().to_string()
    };
    tauri::async_runtime::spawn_blocking(move || known_hosts::probe(&host, port, &user, &key_paths))
        .await
        .map_err(|e| crate::error::AppError::msg(format!("探测任务异常: {e}")))
}
