//! 文件管理相关命令：本地目录、远端 SFTP、传输、同步、联动组

use std::path::PathBuf;
use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use crate::commands::AppState;
use crate::error::{AppError, Result};
use crate::meta::{FolderPair, Meta};
use crate::sftp::{self, Entry, Progress, SftpState, SyncPlan};
use crate::watcher::WatchState;

fn expand_local(p: &str) -> PathBuf {
    crate::ssh_config::expand_tilde(p)
}

// ---- 本地 ----

#[tauri::command]
pub fn local_home() -> String {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "/".into())
}

#[tauri::command]
pub fn local_list(path: String) -> Result<Vec<Entry>> {
    sftp::list_local(&expand_local(&path))
}

#[tauri::command]
pub fn local_mkdir(path: String) -> Result<()> {
    std::fs::create_dir_all(expand_local(&path))?;
    Ok(())
}

#[tauri::command]
pub fn local_remove(path: String) -> Result<()> {
    let p = expand_local(&path);
    if p.is_dir() {
        std::fs::remove_dir_all(p)?;
    } else {
        std::fs::remove_file(p)?;
    }
    Ok(())
}

#[tauri::command]
pub fn local_rename(from: String, to: String) -> Result<()> {
    std::fs::rename(expand_local(&from), expand_local(&to))?;
    Ok(())
}

// ---- 远端 ----

#[tauri::command]
pub async fn sftp_home(sftp: State<'_, Arc<SftpState>>, alias: String) -> Result<String> {
    let s = sftp.session(&alias).await?;
    sftp::remote_home(&s).await
}

#[tauri::command]
pub async fn sftp_list(sftp: State<'_, Arc<SftpState>>, alias: String, path: String) -> Result<Vec<Entry>> {
    let s = sftp.session(&alias).await?;
    sftp::list_remote(&s, &path).await
}

#[tauri::command]
pub async fn sftp_mkdir(sftp: State<'_, Arc<SftpState>>, alias: String, path: String) -> Result<()> {
    let s = sftp.session(&alias).await?;
    sftp::remote_mkdir(&s, &path).await
}

#[tauri::command]
pub async fn sftp_remove(sftp: State<'_, Arc<SftpState>>, alias: String, path: String) -> Result<()> {
    if path.trim_end_matches('/').is_empty() {
        return Err(AppError::msg("拒绝删除根目录"));
    }
    let s = sftp.session(&alias).await?;
    sftp::remote_remove(&s, &path).await
}

#[tauri::command]
pub async fn sftp_rename(sftp: State<'_, Arc<SftpState>>, alias: String, from: String, to: String) -> Result<()> {
    let s = sftp.session(&alias).await?;
    sftp::remote_rename(&s, &from, &to).await
}

#[tauri::command]
pub async fn sftp_disconnect(sftp: State<'_, Arc<SftpState>>, alias: String) -> Result<()> {
    sftp.disconnect(&alias).await;
    Ok(())
}

/// 切换某台主机的 ssh 压缩传输（同时写入 meta 持久化）
#[tauri::command]
pub fn sftp_set_compression(
    state: State<AppState>,
    sftp: State<'_, Arc<SftpState>>,
    host_id: String,
    alias: String,
    on: bool,
) -> Result<Meta> {
    sftp.set_compression(&alias, on);
    state.meta.set_sftp_compression(&host_id, on)
}

// ---- 传输 ----

#[tauri::command]
pub async fn sftp_upload(
    sftp: State<'_, Arc<SftpState>>,
    alias: String,
    local: String,
    remote_dir: String,
    task_id: String,
    on_progress: Channel<Progress>,
) -> Result<()> {
    sftp::upload(&sftp, &alias, &expand_local(&local), &remote_dir, &task_id, on_progress).await
}

#[tauri::command]
pub async fn sftp_download(
    sftp: State<'_, Arc<SftpState>>,
    alias: String,
    remote: String,
    local_dir: String,
    task_id: String,
    on_progress: Channel<Progress>,
) -> Result<()> {
    sftp::download(&sftp, &alias, &remote, &expand_local(&local_dir), &task_id, on_progress).await
}

#[tauri::command]
pub fn sftp_cancel(sftp: State<'_, Arc<SftpState>>, task_id: String) {
    sftp.cancel(&task_id);
}

// ---- 同步 ----

#[tauri::command]
pub async fn sftp_sync_plan(
    sftp: State<'_, Arc<SftpState>>,
    alias: String,
    local: String,
    remote: String,
    direction: String,
) -> Result<SyncPlan> {
    sftp::plan(&sftp, &alias, &expand_local(&local), &remote, &direction).await
}

#[tauri::command]
pub async fn sftp_sync_apply(
    sftp: State<'_, Arc<SftpState>>,
    alias: String,
    local: String,
    remote: String,
    direction: String,
    rels: Vec<String>,
    delete_orphans: Vec<String>,
    task_id: String,
    on_progress: Channel<Progress>,
) -> Result<()> {
    sftp::apply(
        &sftp,
        &alias,
        &expand_local(&local),
        &remote,
        &direction,
        rels,
        delete_orphans,
        &task_id,
        on_progress,
    )
    .await
}

// ---- 联动组 ----

#[tauri::command]
pub fn save_folder_pairs(state: State<AppState>, host_id: String, pairs: Vec<FolderPair>) -> Result<Meta> {
    state.meta.save_folder_pairs(&host_id, pairs)
}

#[tauri::command]
pub fn watch_start(
    app: AppHandle,
    sftp: State<'_, Arc<SftpState>>,
    watch: State<'_, WatchState>,
    pair_id: String,
    alias: String,
    local: String,
    remote: String,
) -> Result<()> {
    watch.start(app, sftp.inner().clone(), pair_id, alias, expand_local(&local), remote)
}

#[tauri::command]
pub fn watch_stop(watch: State<'_, WatchState>, pair_id: String) {
    watch.stop(&pair_id);
}

#[tauri::command]
pub fn watch_active(watch: State<'_, WatchState>) -> Vec<String> {
    watch.active()
}
