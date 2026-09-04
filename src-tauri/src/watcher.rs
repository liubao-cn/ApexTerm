//! 联动文件夹的自动上传：监视本地目录，文件新建/修改后（防抖 600ms）自动上传到远端对应路径。
//! 只镜像新增与修改，不镜像删除（本地误删不会连带删服务器）。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, Result};
use crate::sftp::{ensure_remote_dirs, join_remote, upload_file, Reporter, SftpState};

const SKIP_DIRS: &[&str] = &[".git", "node_modules", ".idea", ".vscode", "__pycache__", "target", ".DS_Store"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncEvent {
    pub pair_id: String,
    pub rel: String,
    pub ok: bool,
    pub message: String,
    pub at: i64,
}

#[derive(Default)]
pub struct WatchState {
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
}

fn should_skip(local_root: &Path, path: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(local_root) else { return true };
    rel.components().any(|c| {
        let s = c.as_os_str().to_string_lossy();
        SKIP_DIRS.contains(&s.as_ref()) || s.ends_with(".swp") || s.ends_with('~') || s.starts_with(".#")
    })
}

fn emit(app: &AppHandle, pair_id: &str, rel: &str, ok: bool, message: impl Into<String>) {
    let _ = app.emit(
        "sync-event",
        SyncEvent {
            pair_id: pair_id.to_string(),
            rel: rel.to_string(),
            ok,
            message: message.into(),
            at: chrono::Utc::now().timestamp_millis(),
        },
    );
}

impl WatchState {
    pub fn start(
        &self,
        app: AppHandle,
        sftp: Arc<SftpState>,
        pair_id: String,
        alias: String,
        local: PathBuf,
        remote: String,
    ) -> Result<()> {
        if !local.is_dir() {
            return Err(AppError::msg("本地目录不存在"));
        }
        self.stop(&pair_id);
        let (tx, mut rx) = tokio::sync::mpsc::channel::<PathBuf>(1024);
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res {
                if matches!(ev.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                    for p in ev.paths {
                        let _ = tx.blocking_send(p);
                    }
                }
            }
        })
        .map_err(|e| AppError::msg(format!("创建文件监视失败: {e}")))?;
        watcher
            .watch(&local, RecursiveMode::Recursive)
            .map_err(|e| AppError::msg(format!("监视目录失败: {e}")))?;
        self.watchers.lock().unwrap().insert(pair_id.clone(), watcher);

        tauri::async_runtime::spawn(async move {
            let cancel = AtomicBool::new(false);
            loop {
                // 收到第一个事件后再等 600ms，把同一批改动攒齐再上传
                let Some(first) = rx.recv().await else { break };
                let mut pending: HashSet<PathBuf> = HashSet::from([first]);
                let deadline = tokio::time::Instant::now() + Duration::from_millis(600);
                loop {
                    match tokio::time::timeout_at(deadline, rx.recv()).await {
                        Ok(Some(p)) => {
                            pending.insert(p);
                        }
                        Ok(None) => return,
                        Err(_) => break,
                    }
                }
                let (session, lane) = match (sftp.session(&alias).await, sftp.lane(&alias).await) {
                    (Ok(s), Ok(l)) => (s, l),
                    (Err(e), _) | (_, Err(e)) => {
                        emit(&app, &pair_id, "", false, format!("连接失败：{e}"));
                        continue;
                    }
                };
                let mut made: HashSet<String> = HashSet::new();
                let mut files: Vec<PathBuf> = pending
                    .into_iter()
                    .filter(|p| !should_skip(&local, p) && p.is_file())
                    .collect();
                files.sort();
                for path in files {
                    let Ok(rel_path) = path.strip_prefix(&local) else { continue };
                    let rel = rel_path.to_string_lossy().replace('\\', "/");
                    let target = join_remote(&remote, &rel);
                    if let Some(idx) = target.rfind('/') {
                        let dir = target[..idx].to_string();
                        if !made.contains(&dir) {
                            if let Err(e) = ensure_remote_dirs(&session, &remote, &dir).await {
                                emit(&app, &pair_id, &rel, false, e.to_string());
                                continue;
                            }
                            made.insert(dir);
                        }
                    }
                    let mut rep = Reporter::silent();
                    match upload_file(&lane, &path, &target, &mut rep, &cancel).await {
                        Ok(()) => emit(&app, &pair_id, &rel, true, "已上传"),
                        Err(e) => emit(&app, &pair_id, &rel, false, e.to_string()),
                    }
                }
            }
        });
        Ok(())
    }

    pub fn stop(&self, pair_id: &str) {
        // drop watcher 即停止监视；接收端随后收到 None 退出
        self.watchers.lock().unwrap().remove(pair_id);
    }

    pub fn active(&self) -> Vec<String> {
        self.watchers.lock().unwrap().keys().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skip_rules() {
        let root = Path::new("/p");
        assert!(should_skip(root, Path::new("/p/node_modules/a.js")));
        assert!(should_skip(root, Path::new("/p/.git/HEAD")));
        assert!(should_skip(root, Path::new("/p/src/a.swp")));
        assert!(should_skip(root, Path::new("/other/a.txt")));
        assert!(!should_skip(root, Path::new("/p/src/app.py")));
    }
}
