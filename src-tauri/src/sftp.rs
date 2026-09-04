//! SFTP 文件管理。传输通道是系统 ssh 的 sftp 子系统（`ssh -s <alias> sftp`），
//! 因此免密/跳板机/所有 config 选项与终端完全一致；协议层用 russh-sftp。
//! 提供：目录浏览、上传/下载（递归、带进度、可取消）、增删改名、目录同步计划与执行。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use russh_sftp::client::rawsession::RawSftpSession;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, FileType, OpenFlags, StatusCode};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::task::JoinSet;

use crate::error::{AppError, Result};
use crate::remote::{classify_ssh_failure, validate_alias};
use crate::tools;

const IGNORED_NAMES: &[&str] = &[".DS_Store", "Thumbs.db"];

// ---------- 数据结构 ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    /// Unix 秒
    pub mtime: Option<u64>,
    pub permissions: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub task_id: String,
    /// scanning | transferring | done | error | cancelled
    pub phase: String,
    pub current: String,
    pub files_done: u64,
    pub files_total: u64,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncItem {
    /// 相对路径（/ 分隔）
    pub rel: String,
    /// create | update
    pub action: String,
    pub size: u64,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPlan {
    pub direction: String,
    pub local: String,
    pub remote: String,
    pub items: Vec<SyncItem>,
    /// 只存在于目标端的文件（可选删除）
    pub orphans: Vec<String>,
    pub unchanged: u64,
    pub bytes: u64,
}

// ---------- 连接管理 ----------

/// 浏览通道：高层 API，用于列目录 / 增删改名 / 同步比对
struct Conn {
    sftp: Arc<SftpSession>,
    child: Child,
    compression: bool,
}

/// 传输通道：裸协议，允许多个读写请求同时在途（流水线），大文件跨洋传输快数倍
struct Lane {
    raw: Arc<RawSftpSession>,
    child: Child,
    compression: bool,
}

/// 单个 SFTP 请求的数据块大小；OpenSSH sftp-server 单包上限 256 KiB，64 KiB 是各实现都稳的取值
const PIPE_CHUNK: usize = 64 * 1024;
/// 同时在途的请求数：64 KiB × 32 = 2 MiB 窗口，足以填满高延迟链路
const WINDOW: usize = 32;

#[derive(Default)]
pub struct SftpState {
    conns: tokio::sync::Mutex<HashMap<String, Conn>>,
    lanes: tokio::sync::Mutex<HashMap<String, Lane>>,
    /// 每台主机是否启用 ssh 压缩（-o Compression=yes）
    compression: Mutex<HashMap<String, bool>>,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

fn sftp_err(context: &str, e: impl std::fmt::Display) -> AppError {
    AppError::msg(format!("{context}: {e}"))
}

type SshStream = tokio::io::Join<tokio::process::ChildStdout, tokio::process::ChildStdin>;

/// 启动 `ssh -s <alias> sftp` 子系统，返回子进程、双向流、以及收集 stderr 的任务
async fn spawn_subsystem(
    alias: &str,
    compression: bool,
) -> Result<(Child, SshStream, tokio::task::JoinHandle<String>)> {
    validate_alias(alias)?;
    let mut cmd = Command::from(tools::command(tools::ssh()));
    cmd.args(["-o", "BatchMode=yes"])
        .args(["-o", "ConnectTimeout=15"])
        .args(["-o", "ServerAliveInterval=30"])
        .args(["-o", "LogLevel=ERROR"])
        .args(["-o", if compression { "Compression=yes" } else { "Compression=no" }])
        .arg("-s")
        .arg("--")
        .arg(alias)
        .arg("sftp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::msg(format!("无法启动 ssh: {e}")))?;
    let stdin = child.stdin.take().expect("stdin piped");
    let stdout = child.stdout.take().expect("stdout piped");
    let mut stderr = child.stderr.take().expect("stderr piped");
    let err_buf = tokio::spawn(async move {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s).await;
        s
    });
    Ok((child, tokio::io::join(stdout, stdin), err_buf))
}

async fn connect_failure(alias: &str, mut child: Child, err_buf: tokio::task::JoinHandle<String>, e: impl std::fmt::Display) -> AppError {
    let _ = child.kill().await;
    let stderr = tokio::time::timeout(Duration::from_secs(2), err_buf)
        .await
        .ok()
        .and_then(|r| r.ok())
        .unwrap_or_default();
    let reason = if stderr.trim().is_empty() {
        format!("SFTP 初始化失败: {e}")
    } else {
        classify_ssh_failure(&stderr)
    };
    AppError::msg(format!("连接 {alias} 失败：{reason}"))
}

async fn connect(alias: &str, compression: bool) -> Result<Conn> {
    let (child, stream, err_buf) = spawn_subsystem(alias, compression).await?;
    match tokio::time::timeout(Duration::from_secs(25), SftpSession::new(stream)).await {
        Ok(Ok(sftp)) => {
            sftp.set_timeout(60);
            Ok(Conn { sftp: Arc::new(sftp), child, compression })
        }
        Ok(Err(e)) => Err(connect_failure(alias, child, err_buf, e).await),
        Err(_) => {
            let mut child = child;
            let _ = child.kill().await;
            Err(AppError::msg(format!("连接 {alias} 超时")))
        }
    }
}

async fn connect_lane(alias: &str, compression: bool) -> Result<Lane> {
    let (child, stream, err_buf) = spawn_subsystem(alias, compression).await?;
    let raw = RawSftpSession::new(stream);
    raw.set_timeout(120);
    match tokio::time::timeout(Duration::from_secs(25), raw.init()).await {
        Ok(Ok(_)) => Ok(Lane { raw: Arc::new(raw), child, compression }),
        Ok(Err(e)) => Err(connect_failure(alias, child, err_buf, e).await),
        Err(_) => {
            let mut child = child;
            let _ = child.kill().await;
            Err(AppError::msg(format!("连接 {alias} 超时")))
        }
    }
}

impl SftpState {
    fn compression_for(&self, alias: &str) -> bool {
        self.compression.lock().unwrap().get(alias).copied().unwrap_or(false)
    }

    /// 切换某台主机的压缩；下次取通道时若与现有连接不一致会自动重连
    pub fn set_compression(&self, alias: &str, on: bool) {
        self.compression.lock().unwrap().insert(alias.to_string(), on);
    }

    /// 取（或建立）浏览通道；进程已退出或压缩设置变了则重连
    pub async fn session(&self, alias: &str) -> Result<Arc<SftpSession>> {
        let want = self.compression_for(alias);
        let mut conns = self.conns.lock().await;
        if let Some(c) = conns.get_mut(alias) {
            match c.child.try_wait() {
                Ok(None) if c.compression == want => return Ok(c.sftp.clone()),
                _ => {
                    if let Some(mut old) = conns.remove(alias) {
                        let _ = old.child.kill().await;
                    }
                }
            }
        }
        let conn = connect(alias, want).await?;
        let sftp = conn.sftp.clone();
        conns.insert(alias.to_string(), conn);
        Ok(sftp)
    }

    /// 取（或建立）传输通道
    pub async fn lane(&self, alias: &str) -> Result<Arc<RawSftpSession>> {
        let want = self.compression_for(alias);
        let mut lanes = self.lanes.lock().await;
        if let Some(l) = lanes.get_mut(alias) {
            match l.child.try_wait() {
                Ok(None) if l.compression == want => return Ok(l.raw.clone()),
                _ => {
                    if let Some(mut old) = lanes.remove(alias) {
                        let _ = old.child.kill().await;
                    }
                }
            }
        }
        let lane = connect_lane(alias, want).await?;
        let raw = lane.raw.clone();
        lanes.insert(alias.to_string(), lane);
        Ok(raw)
    }

    pub async fn disconnect(&self, alias: &str) {
        if let Some(mut c) = self.conns.lock().await.remove(alias) {
            let _ = c.sftp.close().await;
            let _ = c.child.kill().await;
        }
        if let Some(mut l) = self.lanes.lock().await.remove(alias) {
            let _ = l.raw.close_session();
            let _ = l.child.kill().await;
        }
    }

    pub fn cancel_token(&self, task_id: &str) -> Arc<AtomicBool> {
        let mut m = self.cancels.lock().unwrap();
        let t = Arc::new(AtomicBool::new(false));
        m.insert(task_id.to_string(), t.clone());
        t
    }

    pub fn cancel(&self, task_id: &str) {
        if let Some(t) = self.cancels.lock().unwrap().get(task_id) {
            t.store(true, Ordering::SeqCst);
        }
    }

    pub fn finish_task(&self, task_id: &str) {
        self.cancels.lock().unwrap().remove(task_id);
    }
}

// ---------- 路径工具 ----------

pub fn join_remote(base: &str, name: &str) -> String {
    if base.ends_with('/') {
        format!("{base}{name}")
    } else {
        format!("{base}/{name}")
    }
}

fn file_name_of(path: &str) -> String {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(path)
        .to_string()
}

fn to_secs(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn ignored(name: &str) -> bool {
    IGNORED_NAMES.contains(&name)
}

// ---------- 远端目录 ----------

pub async fn list_remote(sftp: &SftpSession, path: &str) -> Result<Vec<Entry>> {
    let dir = sftp
        .read_dir(path)
        .await
        .map_err(|e| sftp_err(&format!("读取远端目录 {path}"), e))?;
    let mut out = Vec::new();
    for e in dir {
        let name = e.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let attrs = e.metadata();
        let full = join_remote(path, &name);
        let ty = e.file_type();
        let mut is_dir = ty == FileType::Dir;
        let is_symlink = ty == FileType::Symlink;
        if is_symlink {
            // 软链接指向目录时当目录处理，方便双击进入
            if let Ok(target) = sftp.metadata(full.clone()).await {
                is_dir = target.is_dir();
            }
        }
        out.push(Entry {
            name,
            path: full,
            is_dir,
            is_symlink,
            size: attrs.size.unwrap_or(0),
            mtime: attrs.mtime.map(u64::from),
            permissions: attrs.permissions,
        });
    }
    sort_entries(&mut out);
    Ok(out)
}

fn sort_entries(list: &mut [Entry]) {
    list.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

pub async fn remote_home(sftp: &SftpSession) -> Result<String> {
    sftp.canonicalize(".")
        .await
        .map_err(|e| sftp_err("获取远端家目录", e))
}

pub async fn remote_mkdir(sftp: &SftpSession, path: &str) -> Result<()> {
    match sftp.create_dir(path).await {
        Ok(()) => Ok(()),
        Err(e) => {
            // 已存在则忽略
            if sftp.metadata(path).await.map(|m| m.is_dir()).unwrap_or(false) {
                Ok(())
            } else {
                Err(sftp_err(&format!("创建远端目录 {path}"), e))
            }
        }
    }
}

/// 递归删除远端文件/目录
pub fn remote_remove<'a>(
    sftp: &'a SftpSession,
    path: &'a str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
    Box::pin(async move {
        let meta = sftp
            .symlink_metadata(path)
            .await
            .map_err(|e| sftp_err(&format!("读取 {path}"), e))?;
        if meta.is_dir() {
            let entries = list_remote(sftp, path).await?;
            for e in entries {
                remote_remove(sftp, &e.path).await?;
            }
            sftp.remove_dir(path)
                .await
                .map_err(|e| sftp_err(&format!("删除远端目录 {path}"), e))
        } else {
            sftp.remove_file(path)
                .await
                .map_err(|e| sftp_err(&format!("删除远端文件 {path}"), e))
        }
    })
}

pub async fn remote_rename(sftp: &SftpSession, from: &str, to: &str) -> Result<()> {
    sftp.rename(from, to)
        .await
        .map_err(|e| sftp_err(&format!("重命名 {from}"), e))
}

/// 递归收集远端文件（相对路径 → (size, mtime)），最多 8 个目录同时列举
async fn walk_remote(sftp: &Arc<SftpSession>, root: &str) -> Result<HashMap<String, (u64, Option<u64>)>> {
    let mut out = HashMap::new();
    let mut queue: Vec<(String, String)> = vec![(root.to_string(), String::new())];
    let mut set: JoinSet<(String, Result<Vec<Entry>>)> = JoinSet::new();
    loop {
        while set.len() < 8 {
            let Some((dir, rel)) = queue.pop() else { break };
            let s = sftp.clone();
            set.spawn(async move { (rel, list_remote(&s, &dir).await) });
        }
        let Some(joined) = set.join_next().await else { break };
        let (rel, listing) = joined.map_err(|e| AppError::msg(format!("列目录任务异常: {e}")))?;
        let entries = match listing {
            Ok(e) => e,
            Err(e) if rel.is_empty() => return Err(e),
            Err(_) => continue,
        };
        for e in entries {
            if ignored(&e.name) {
                continue;
            }
            let r = if rel.is_empty() { e.name.clone() } else { format!("{rel}/{}", e.name) };
            if e.is_dir {
                queue.push((e.path, r));
            } else if !e.is_symlink {
                out.insert(r, (e.size, e.mtime));
            }
        }
    }
    Ok(out)
}

// ---------- 本地目录 ----------

pub fn list_local(path: &Path) -> Result<Vec<Entry>> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(path)? {
        let e = e?;
        let name = e.file_name().to_string_lossy().to_string();
        let full = e.path();
        let meta = match std::fs::metadata(&full) {
            Ok(m) => m,
            Err(_) => match std::fs::symlink_metadata(&full) {
                Ok(m) => m,
                Err(_) => continue,
            },
        };
        let is_symlink = std::fs::symlink_metadata(&full).map(|m| m.file_type().is_symlink()).unwrap_or(false);
        out.push(Entry {
            name,
            path: full.to_string_lossy().to_string(),
            is_dir: meta.is_dir(),
            is_symlink,
            size: if meta.is_dir() { 0 } else { meta.len() },
            mtime: meta.modified().ok().map(to_secs),
            permissions: {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    Some(meta.permissions().mode())
                }
                #[cfg(not(unix))]
                {
                    None
                }
            },
        });
    }
    sort_entries(&mut out);
    Ok(out)
}

fn walk_local(root: &Path) -> Result<HashMap<String, (u64, Option<u64>)>> {
    let mut out = HashMap::new();
    let mut stack = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, rel)) = stack.pop() {
        let rd = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(e) if rel.is_empty() => return Err(e.into()),
            Err(_) => continue,
        };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if ignored(&name) {
                continue;
            }
            let r = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            let Ok(meta) = e.metadata() else { continue };
            if meta.is_dir() {
                stack.push((e.path(), r));
            } else if meta.is_file() {
                out.insert(r, (meta.len(), meta.modified().ok().map(to_secs)));
            }
        }
    }
    Ok(out)
}

// ---------- 传输 ----------

pub struct Reporter<'a> {
    channel: Option<&'a Channel<Progress>>,
    task_id: String,
    files_done: u64,
    files_total: u64,
    bytes_done: u64,
    bytes_total: u64,
    last_sent: std::time::Instant,
}

impl<'a> Reporter<'a> {
    fn new(channel: &'a Channel<Progress>, task_id: &str) -> Self {
        Self {
            channel: Some(channel),
            task_id: task_id.to_string(),
            files_done: 0,
            files_total: 0,
            bytes_done: 0,
            bytes_total: 0,
            last_sent: std::time::Instant::now(),
        }
    }

    /// 不汇报进度（自动上传后台任务用）
    pub fn silent() -> Self {
        Self {
            channel: None,
            task_id: String::new(),
            files_done: 0,
            files_total: 0,
            bytes_done: 0,
            bytes_total: 0,
            last_sent: std::time::Instant::now(),
        }
    }

    fn send(&mut self, phase: &str, current: &str, message: &str, force: bool) {
        let Some(channel) = self.channel else { return };
        if !force && self.last_sent.elapsed() < Duration::from_millis(120) {
            return;
        }
        self.last_sent = std::time::Instant::now();
        let _ = channel.send(Progress {
            task_id: self.task_id.clone(),
            phase: phase.into(),
            current: current.into(),
            files_done: self.files_done,
            files_total: self.files_total,
            bytes_done: self.bytes_done,
            bytes_total: self.bytes_total,
            message: message.into(),
        });
    }
}

fn check_cancel(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::SeqCst) {
        Err(AppError::msg("已取消"))
    } else {
        Ok(())
    }
}

fn status_ok(context: &str, s: russh_sftp::protocol::Status) -> Result<()> {
    if s.status_code == StatusCode::Ok {
        Ok(())
    } else {
        Err(AppError::msg(format!("{context}: {} ({:?})", s.error_message, s.status_code)))
    }
}

/// 流水线上传：本地顺序读块，最多 WINDOW 个写请求同时在途
pub async fn upload_file(
    raw: &Arc<RawSftpSession>,
    local: &Path,
    remote: &str,
    rep: &mut Reporter<'_>,
    cancel: &AtomicBool,
) -> Result<()> {
    let mut src = tokio::fs::File::open(local).await?;
    let meta = src.metadata().await?;
    let handle = raw
        .open(remote, OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE, FileAttributes::default())
        .await
        .map_err(|e| sftp_err(&format!("创建远端文件 {remote}"), e))?
        .handle;

    let mut inflight: JoinSet<Result<usize>> = JoinSet::new();
    let mut offset = 0u64;
    let mut eof = false;
    let mut buf = vec![0u8; PIPE_CHUNK];
    let result: Result<()> = async {
        loop {
            while !eof && inflight.len() < WINDOW {
                check_cancel(cancel)?;
                let n = src.read(&mut buf).await?;
                if n == 0 {
                    eof = true;
                    break;
                }
                let r = raw.clone();
                let h = handle.clone();
                let data = buf[..n].to_vec();
                let off = offset;
                offset += n as u64;
                let ctx = remote.to_string();
                inflight.spawn(async move {
                    let st = r.write(h, off, data).await.map_err(|e| sftp_err(&format!("写入 {ctx}"), e))?;
                    status_ok(&format!("写入 {ctx}"), st)?;
                    Ok(n)
                });
            }
            if eof && inflight.is_empty() {
                break;
            }
            match inflight.join_next().await {
                Some(Ok(Ok(n))) => {
                    rep.bytes_done += n as u64;
                    rep.send("transferring", remote, "", false);
                }
                Some(Ok(Err(e))) => return Err(e),
                Some(Err(e)) => return Err(AppError::msg(format!("写入任务异常: {e}"))),
                None => break,
            }
        }
        Ok(())
    }
    .await;
    inflight.abort_all();
    let closed = raw.close(handle).await;
    result?;
    closed.map_err(|e| sftp_err("关闭远端文件", e))?;
    // 让远端 mtime 跟本地一致，便于之后的同步比较
    if let Ok(m) = meta.modified() {
        let secs = to_secs(m) as u32;
        let _ = raw
            .setstat(remote, FileAttributes { atime: Some(secs), mtime: Some(secs), ..Default::default() })
            .await;
    }
    Ok(())
}

/// 流水线下载：按偏移并发发出读请求，收到后按顺序落盘
async fn download_file(
    raw: &Arc<RawSftpSession>,
    remote: &str,
    local: &Path,
    rep: &mut Reporter<'_>,
    cancel: &AtomicBool,
) -> Result<()> {
    if let Some(parent) = local.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let attrs = raw
        .stat(remote)
        .await
        .map_err(|e| sftp_err(&format!("读取 {remote}"), e))?
        .attrs;
    let size = attrs.size.unwrap_or(0);
    let handle = raw
        .open(remote, OpenFlags::READ, FileAttributes::default())
        .await
        .map_err(|e| sftp_err(&format!("打开远端文件 {remote}"), e))?
        .handle;
    let mut dst = tokio::fs::File::create(local).await?;

    type Piece = (u64, u32, Vec<u8>);
    let mut inflight: JoinSet<Result<Piece>> = JoinSet::new();
    let mut pending: std::collections::BTreeMap<u64, Vec<u8>> = std::collections::BTreeMap::new();
    let mut next_issue = 0u64;
    let mut next_write = 0u64;
    let issue = |set: &mut JoinSet<Result<Piece>>, off: u64, len: u32| {
        let r = raw.clone();
        let h = handle.clone();
        let ctx = remote.to_string();
        set.spawn(async move {
            let d = r.read(h, off, len).await.map_err(|e| sftp_err(&format!("读取 {ctx}"), e))?;
            Ok((off, len, d.data))
        });
    };
    let result: Result<()> = async {
        loop {
            while inflight.len() < WINDOW && next_issue < size {
                check_cancel(cancel)?;
                let len = (size - next_issue).min(PIPE_CHUNK as u64) as u32;
                issue(&mut inflight, next_issue, len);
                next_issue += u64::from(len);
            }
            if inflight.is_empty() && next_write >= size {
                break;
            }
            match inflight.join_next().await {
                Some(Ok(Ok((off, len, data)))) => {
                    // 服务器可能少给（短读）：把缺的那段再要一次
                    let got = data.len() as u32;
                    let end = off + u64::from(got);
                    if got < len && end < size {
                        issue(&mut inflight, end, len - got);
                    }
                    pending.insert(off, data);
                    while let Some(chunk) = pending.remove(&next_write) {
                        dst.write_all(&chunk).await?;
                        next_write += chunk.len() as u64;
                        rep.bytes_done += chunk.len() as u64;
                        rep.send("transferring", remote, "", false);
                    }
                }
                Some(Ok(Err(e))) => return Err(e),
                Some(Err(e)) => return Err(AppError::msg(format!("读取任务异常: {e}"))),
                None => break,
            }
        }
        Ok(())
    }
    .await;
    inflight.abort_all();
    let _ = raw.close(handle).await;
    result?;
    dst.flush().await?;
    drop(dst);
    if let Some(m) = attrs.mtime {
        let t = UNIX_EPOCH + Duration::from_secs(u64::from(m));
        if let Ok(f) = std::fs::File::options().write(true).open(local) {
            let _ = f.set_modified(t);
        }
    }
    Ok(())
}

/// 收集本地路径下的所有文件（含目录递归），返回 (本地路径, 相对路径)
fn collect_local_files(root: &Path) -> Result<Vec<(PathBuf, String)>> {
    let meta = std::fs::metadata(root)?;
    if meta.is_file() {
        return Ok(vec![(root.to_path_buf(), String::new())]);
    }
    let mut out = Vec::new();
    for (rel, _) in walk_local(root)? {
        out.push((root.join(&rel), rel));
    }
    out.sort_by(|a, b| a.1.cmp(&b.1));
    Ok(out)
}

/// 上传一个本地文件或目录到远端目录下（保留名字）
pub async fn upload(
    state: &SftpState,
    alias: &str,
    local: &Path,
    remote_dir: &str,
    task_id: &str,
    channel: Channel<Progress>,
) -> Result<()> {
    let sftp = state.session(alias).await?;
    let lane = state.lane(alias).await?;
    let cancel = state.cancel_token(task_id);
    let mut rep = Reporter::new(&channel, task_id);
    let result = async {
        rep.send("scanning", &local.display().to_string(), "", true);
        let files = collect_local_files(local)?;
        let name = local
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .ok_or_else(|| AppError::msg("无效的本地路径"))?;
        let is_dir = std::fs::metadata(local)?.is_dir();
        rep.files_total = files.len() as u64;
        rep.bytes_total = files.iter().map(|(p, _)| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)).sum();
        let base = join_remote(remote_dir, &name);
        if is_dir {
            remote_mkdir(&sftp, &base).await?;
        }
        let mut made: std::collections::HashSet<String> = std::collections::HashSet::new();
        for (path, rel) in files {
            check_cancel(&cancel)?;
            let target = if rel.is_empty() { base.clone() } else { join_remote(&base, &rel) };
            if let Some(idx) = target.rfind('/') {
                let dir = &target[..idx];
                if !dir.is_empty() && dir != remote_dir.trim_end_matches('/') && !made.contains(dir) {
                    remote_mkdir(&sftp, dir).await?;
                    made.insert(dir.to_string());
                }
            }
            upload_file(&lane, &path, &target, &mut rep, &cancel).await?;
            rep.files_done += 1;
            rep.send("transferring", &target, "", true);
        }
        Ok::<(), AppError>(())
    }
    .await;
    state.finish_task(task_id);
    match result {
        Ok(()) => {
            rep.send("done", "", "上传完成", true);
            Ok(())
        }
        Err(e) if e.to_string() == "已取消" => {
            rep.send("cancelled", "", "已取消", true);
            Ok(())
        }
        Err(e) => {
            rep.send("error", "", &e.to_string(), true);
            Err(e)
        }
    }
}

/// 下载一个远端文件或目录到本地目录下（保留名字）
pub async fn download(
    state: &SftpState,
    alias: &str,
    remote: &str,
    local_dir: &Path,
    task_id: &str,
    channel: Channel<Progress>,
) -> Result<()> {
    let sftp = state.session(alias).await?;
    let lane = state.lane(alias).await?;
    let cancel = state.cancel_token(task_id);
    let mut rep = Reporter::new(&channel, task_id);
    let result = async {
        rep.send("scanning", remote, "", true);
        let meta = sftp
            .metadata(remote)
            .await
            .map_err(|e| sftp_err(&format!("读取 {remote}"), e))?;
        let name = file_name_of(remote);
        let base = local_dir.join(&name);
        let files: Vec<(String, PathBuf, u64)> = if meta.is_dir() {
            walk_remote(&sftp, remote)
                .await?
                .into_iter()
                .map(|(rel, (size, _))| (join_remote(remote, &rel), base.join(&rel), size))
                .collect()
        } else {
            vec![(remote.to_string(), base.clone(), meta.size.unwrap_or(0))]
        };
        rep.files_total = files.len() as u64;
        rep.bytes_total = files.iter().map(|f| f.2).sum();
        if meta.is_dir() {
            tokio::fs::create_dir_all(&base).await?;
        }
        for (r, l, _) in files {
            check_cancel(&cancel)?;
            download_file(&lane, &r, &l, &mut rep, &cancel).await?;
            rep.files_done += 1;
            rep.send("transferring", &r, "", true);
        }
        Ok::<(), AppError>(())
    }
    .await;
    state.finish_task(task_id);
    match result {
        Ok(()) => {
            rep.send("done", "", "下载完成", true);
            Ok(())
        }
        Err(e) if e.to_string() == "已取消" => {
            rep.send("cancelled", "", "已取消", true);
            Ok(())
        }
        Err(e) => {
            rep.send("error", "", &e.to_string(), true);
            Err(e)
        }
    }
}

// ---------- 同步 ----------

/// 比较本地与远端目录，生成同步计划（不做任何改动）
pub async fn plan(
    state: &SftpState,
    alias: &str,
    local: &Path,
    remote: &str,
    direction: &str,
) -> Result<SyncPlan> {
    let sftp = state.session(alias).await?;
    let local_files = walk_local(local)?;
    let remote_files = walk_remote(&sftp, remote).await?;
    let (src, dst) = if direction == "pull" {
        (&remote_files, &local_files)
    } else {
        (&local_files, &remote_files)
    };
    let mut items = Vec::new();
    let mut unchanged = 0u64;
    let mut bytes = 0u64;
    for (rel, (size, mtime)) in src {
        match dst.get(rel) {
            None => {
                bytes += size;
                items.push(SyncItem { rel: rel.clone(), action: "create".into(), size: *size, reason: "目标端不存在".into() });
            }
            Some((dsize, dmtime)) => {
                let newer = match (mtime, dmtime) {
                    (Some(a), Some(b)) => *a > b + 2,
                    _ => false,
                };
                if size != dsize {
                    bytes += size;
                    items.push(SyncItem { rel: rel.clone(), action: "update".into(), size: *size, reason: format!("大小不同 {dsize} → {size}") });
                } else if newer {
                    bytes += size;
                    items.push(SyncItem { rel: rel.clone(), action: "update".into(), size: *size, reason: "源端更新".into() });
                } else {
                    unchanged += 1;
                }
            }
        }
    }
    let mut orphans: Vec<String> = dst.keys().filter(|k| !src.contains_key(*k)).cloned().collect();
    items.sort_by(|a, b| a.rel.cmp(&b.rel));
    orphans.sort();
    Ok(SyncPlan {
        direction: direction.into(),
        local: local.to_string_lossy().to_string(),
        remote: remote.to_string(),
        items,
        orphans,
        unchanged,
        bytes,
    })
}

/// 执行同步计划里选中的条目
pub async fn apply(
    state: &SftpState,
    alias: &str,
    local: &Path,
    remote: &str,
    direction: &str,
    rels: Vec<String>,
    delete_orphans: Vec<String>,
    task_id: &str,
    channel: Channel<Progress>,
) -> Result<()> {
    let sftp = state.session(alias).await?;
    let lane = state.lane(alias).await?;
    let cancel = state.cancel_token(task_id);
    let mut rep = Reporter::new(&channel, task_id);
    let result = async {
        rep.files_total = (rels.len() + delete_orphans.len()) as u64;
        if direction == "pull" {
            for rel in &rels {
                if let Ok(m) = sftp.metadata(join_remote(remote, rel)).await {
                    rep.bytes_total += m.size.unwrap_or(0);
                }
            }
        } else {
            for rel in &rels {
                rep.bytes_total += std::fs::metadata(local.join(rel)).map(|m| m.len()).unwrap_or(0);
            }
        }
        let mut made: std::collections::HashSet<String> = std::collections::HashSet::new();
        for rel in &rels {
            check_cancel(&cancel)?;
            let l = local.join(rel);
            let r = join_remote(remote, rel);
            if direction == "pull" {
                download_file(&lane, &r, &l, &mut rep, &cancel).await?;
            } else {
                if let Some(idx) = r.rfind('/') {
                    let dir = &r[..idx];
                    if !made.contains(dir) {
                        ensure_remote_dirs(&sftp, remote, dir).await?;
                        made.insert(dir.to_string());
                    }
                }
                upload_file(&lane, &l, &r, &mut rep, &cancel).await?;
            }
            rep.files_done += 1;
            rep.send("transferring", &r, "", true);
        }
        for rel in &delete_orphans {
            check_cancel(&cancel)?;
            if direction == "pull" {
                let _ = std::fs::remove_file(local.join(rel));
            } else {
                let _ = sftp.remove_file(join_remote(remote, rel)).await;
            }
            rep.files_done += 1;
            rep.send("transferring", rel, "删除", true);
        }
        Ok::<(), AppError>(())
    }
    .await;
    state.finish_task(task_id);
    match result {
        Ok(()) => {
            rep.send("done", "", "同步完成", true);
            Ok(())
        }
        Err(e) if e.to_string() == "已取消" => {
            rep.send("cancelled", "", "已取消", true);
            Ok(())
        }
        Err(e) => {
            rep.send("error", "", &e.to_string(), true);
            Err(e)
        }
    }
}

/// 逐级创建 root 之下到 dir 的远端目录
pub async fn ensure_remote_dirs(sftp: &SftpSession, root: &str, dir: &str) -> Result<()> {
    let root_t = root.trim_end_matches('/');
    let Some(rest) = dir.strip_prefix(root_t) else {
        return remote_mkdir(sftp, dir).await;
    };
    let mut cur = root_t.to_string();
    for part in rest.split('/').filter(|p| !p.is_empty()) {
        cur = format!("{cur}/{part}");
        remote_mkdir(sftp, &cur).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_helpers() {
        assert_eq!(join_remote("/root", "a"), "/root/a");
        assert_eq!(join_remote("/root/", "a"), "/root/a");
        assert_eq!(file_name_of("/var/log/nginx"), "nginx");
        assert_eq!(file_name_of("/var/log/nginx/"), "nginx");
        assert!(ignored(".DS_Store"));
    }

    #[test]
    fn local_listing_and_walk() {
        let dir = std::env::temp_dir().join(format!("apexterm-sftp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub/deep")).unwrap();
        std::fs::write(dir.join("a.txt"), "hello").unwrap();
        std::fs::write(dir.join("sub/deep/b.txt"), "world!").unwrap();
        std::fs::write(dir.join(".DS_Store"), "x").unwrap();
        let list = list_local(&dir).unwrap();
        assert_eq!(list[0].name, "sub", "目录排在前面");
        assert!(list.iter().any(|e| e.name == "a.txt" && e.size == 5));
        let walked = walk_local(&dir).unwrap();
        assert_eq!(walked.len(), 2);
        assert_eq!(walked["sub/deep/b.txt"].0, 6);
        let files = collect_local_files(&dir).unwrap();
        assert_eq!(files.iter().map(|f| f.1.as_str()).collect::<Vec<_>>(), vec!["a.txt", "sub/deep/b.txt"]);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
