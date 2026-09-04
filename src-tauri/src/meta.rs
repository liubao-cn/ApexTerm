//! 程序自有的附加数据（分组/标签/备注/最近连接），与 ssh config 通过主机 id 关联。
//! 存放在 Application Support 下的 meta.json，不含任何凭据。

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::Result;

/// 主机与云实例的绑定关系（用于带外开关机）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CloudBinding {
    pub account_id: String,
    /// tencent | volcengine
    pub provider: String,
    /// cvm | lighthouse | ecs
    pub product: String,
    pub region: String,
    pub instance_id: String,
    pub instance_name: String,
}

/// 云账号；SecretKey 不在这里，存钥匙串
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CloudAccount {
    pub id: String,
    pub provider: String,
    pub name: String,
    pub key_id: String,
    /// 为空表示扫描全部地域
    pub regions: Vec<String>,
}

/// 本机控制台里的常用目录
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LocalDir {
    pub id: String,
    pub name: String,
    pub path: String,
}

/// 本地目录 ↔ 远端目录 的联动组
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FolderPair {
    pub id: String,
    pub name: String,
    pub local: String,
    pub remote: String,
    /// 监视本地改动自动上传
    pub auto_upload: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HostMeta {
    pub group: Option<String>,
    pub tags: Vec<String>,
    pub note: String,
    pub color: Option<String>,
    pub favorite: bool,
    pub hidden: bool,
    pub last_connected: Option<i64>,
    pub connect_count: u32,
    pub cloud: Option<CloudBinding>,
    /// 小厂商没有 API 时，一键打开的控制台链接
    pub console_url: Option<String>,
    pub folder_pairs: Vec<FolderPair>,
    /// 文件传输是否启用 ssh 压缩
    pub sftp_compression: bool,
}

/// 用户自定义的快捷命令（内置命令在前端定义，这里只存自定义项和被隐藏的内置项 id）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Snippet {
    pub id: String,
    pub name: String,
    /// 命令模板，`{sudo}` 会按目标主机用户是否为 root 展开
    pub command: String,
    pub group: String,
    /// terminal | silent
    pub mode: String,
    pub confirm: bool,
    pub danger: bool,
    pub watch_reboot: bool,
    /// 为空表示对所有主机可用
    pub host_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Meta {
    pub version: u32,
    pub groups: Vec<String>,
    pub hosts: BTreeMap<String, HostMeta>,
    /// 候选区里被忽略的 host:port
    pub ignored_candidates: Vec<String>,
    pub snippets: Vec<Snippet>,
    pub hidden_snippets: Vec<String>,
    /// 本机控制台：自定义本地快捷命令 / 被隐藏的内置本地命令 / 常用目录
    pub local_snippets: Vec<Snippet>,
    pub hidden_local_snippets: Vec<String>,
    pub local_dirs: Vec<LocalDir>,
    pub cloud_accounts: Vec<CloudAccount>,
    /// 侧栏手动排序（主机 id 列表）；不在列表里的按 config 顺序排在后面
    pub order: Vec<String>,
    /// 快捷键覆盖：动作 id → 加速键字符串（空串 = 不绑定）
    pub shortcuts: HashMap<String, String>,
}

pub struct MetaStore {
    path: PathBuf,
}

impl MetaStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> Result<Meta> {
        match fs::read_to_string(&self.path) {
            Ok(s) if s.trim().is_empty() => Ok(Meta::default()),
            Ok(s) => Ok(serde_json::from_str(&s)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Meta::default()),
            Err(e) => Err(e.into()),
        }
    }

    pub fn save(&self, meta: &Meta) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut meta = meta.clone();
        meta.version = 1;
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_string_pretty(&meta)?)?;
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }

    pub fn update_host(&self, id: &str, host: HostMeta) -> Result<Meta> {
        let mut meta = self.load()?;
        if let Some(g) = host.group.as_deref().filter(|g| !g.is_empty()) {
            if !meta.groups.iter().any(|x| x == g) {
                meta.groups.push(g.to_string());
            }
        }
        meta.hosts.insert(id.to_string(), host);
        self.save(&meta)?;
        Ok(meta)
    }

    /// 别名改名后迁移附加数据（含排序位置）
    pub fn rename_host(&self, from: &str, to: &str) -> Result<Meta> {
        let mut meta = self.load()?;
        if from != to {
            if let Some(h) = meta.hosts.remove(from) {
                meta.hosts.insert(to.to_string(), h);
            }
            for id in meta.order.iter_mut() {
                if id == from {
                    *id = to.to_string();
                }
            }
        }
        self.save(&meta)?;
        Ok(meta)
    }

    pub fn remove_host(&self, id: &str) -> Result<Meta> {
        let mut meta = self.load()?;
        meta.hosts.remove(id);
        meta.order.retain(|x| x != id);
        self.save(&meta)?;
        Ok(meta)
    }

    /// 记录一次连接：更新时间戳、累加次数
    pub fn touch_connected(&self, id: &str) -> Result<Meta> {
        let mut meta = self.load()?;
        let h = meta.hosts.entry(id.to_string()).or_default();
        h.last_connected = Some(chrono::Utc::now().timestamp_millis());
        h.connect_count += 1;
        self.save(&meta)?;
        Ok(meta)
    }

    pub fn set_candidates_ignored(&self, keys: &[String], ignored: bool) -> Result<Meta> {
        let mut meta = self.load()?;
        meta.ignored_candidates.retain(|k| !keys.contains(k));
        if ignored {
            meta.ignored_candidates.extend(keys.iter().cloned());
        }
        self.save(&meta)?;
        Ok(meta)
    }

    pub fn save_local_snippets(&self, snippets: Vec<Snippet>, hidden: Vec<String>) -> Result<Meta> {
        let mut meta = self.load()?;
        meta.local_snippets = snippets;
        meta.hidden_local_snippets = hidden;
        self.save(&meta)?;
        Ok(meta)
    }

    pub fn save_local_dirs(&self, dirs: Vec<LocalDir>) -> Result<Meta> {
        let mut meta = self.load()?;
        meta.local_dirs = dirs.into_iter().filter(|d| !d.path.trim().is_empty()).collect();
        self.save(&meta)?;
        Ok(meta)
    }

    pub fn set_shortcuts(&self, shortcuts: HashMap<String, String>) -> Result<Meta> {
        let mut meta = self.load()?;
        meta.shortcuts = shortcuts;
        self.save(&meta)?;
        Ok(meta)
    }

    pub fn set_sftp_compression(&self, host_id: &str, on: bool) -> Result<Meta> {
        let mut meta = self.load()?;
        meta.hosts.entry(host_id.to_string()).or_default().sftp_compression = on;
        self.save(&meta)?;
        Ok(meta)
    }

    pub fn save_folder_pairs(&self, host_id: &str, pairs: Vec<FolderPair>) -> Result<Meta> {
        let mut meta = self.load()?;
        meta.hosts.entry(host_id.to_string()).or_default().folder_pairs = pairs
            .into_iter()
            .filter(|p| !p.local.trim().is_empty() && !p.remote.trim().is_empty())
            .collect();
        self.save(&meta)?;
        Ok(meta)
    }

    pub fn set_order(&self, order: Vec<String>) -> Result<Meta> {
        let mut meta = self.load()?;
        let mut seen = std::collections::HashSet::new();
        meta.order = order.into_iter().filter(|id| seen.insert(id.clone())).collect();
        self.save(&meta)?;
        Ok(meta)
    }

    pub fn add_cloud_account(&self, account: CloudAccount) -> Result<Meta> {
        let mut meta = self.load()?;
        meta.cloud_accounts.retain(|a| a.id != account.id);
        meta.cloud_accounts.push(account);
        self.save(&meta)?;
        Ok(meta)
    }

    /// 删除账号，同时解绑用到它的主机
    pub fn remove_cloud_account(&self, id: &str) -> Result<Meta> {
        let mut meta = self.load()?;
        meta.cloud_accounts.retain(|a| a.id != id);
        for h in meta.hosts.values_mut() {
            if h.cloud.as_ref().map(|c| c.account_id == id).unwrap_or(false) {
                h.cloud = None;
            }
        }
        self.save(&meta)?;
        Ok(meta)
    }

    pub fn bind_cloud(&self, bindings: Vec<(String, Option<CloudBinding>)>) -> Result<Meta> {
        let mut meta = self.load()?;
        for (host_id, binding) in bindings {
            meta.hosts.entry(host_id).or_default().cloud = binding;
        }
        self.save(&meta)?;
        Ok(meta)
    }

    pub fn save_snippets(&self, snippets: Vec<Snippet>, hidden: Vec<String>) -> Result<Meta> {
        let mut meta = self.load()?;
        meta.snippets = snippets
            .into_iter()
            .filter(|s| !s.id.trim().is_empty() && !s.command.trim().is_empty())
            .collect();
        meta.hidden_snippets = hidden;
        meta.hidden_snippets.sort();
        meta.hidden_snippets.dedup();
        self.save(&meta)?;
        Ok(meta)
    }

    pub fn set_groups(&self, groups: Vec<String>) -> Result<Meta> {
        let mut meta = self.load()?;
        let groups: Vec<String> = groups
            .into_iter()
            .map(|g| g.trim().to_string())
            .filter(|g| !g.is_empty())
            .collect();
        for h in meta.hosts.values_mut() {
            if let Some(g) = &h.group {
                if !groups.contains(g) {
                    h.group = None;
                }
            }
        }
        meta.groups = groups;
        self.save(&meta)?;
        Ok(meta)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crud_roundtrip() {
        let dir = std::env::temp_dir().join(format!("apexterm-meta-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let store = MetaStore::new(dir.join("meta.json"));
        assert!(store.load().unwrap().hosts.is_empty());
        let m = store
            .update_host(
                "web",
                HostMeta {
                    group: Some("生产".into()),
                    tags: vec!["nginx".into()],
                    note: "主站".into(),
                    favorite: true,
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(m.groups, vec!["生产"]);
        let m = store.set_order(vec!["b".into(), "web".into(), "a".into(), "web".into()]).unwrap();
        assert_eq!(m.order, vec!["b", "web", "a"], "重复 id 应去重");
        let m = store.rename_host("web", "web2").unwrap();
        assert!(m.hosts.contains_key("web2") && !m.hosts.contains_key("web"));
        assert_eq!(m.order, vec!["b", "web2", "a"], "改名要同步排序表");
        let m = store.set_groups(vec!["测试".into()]).unwrap();
        assert_eq!(m.hosts["web2"].group, None);
        let m = store
            .set_candidates_ignored(&["1.1.1.1:22".into(), "2.2.2.2:22".into()], true)
            .unwrap();
        assert_eq!(m.ignored_candidates.len(), 2);
        let m = store.set_candidates_ignored(&["1.1.1.1:22".into()], true).unwrap();
        assert_eq!(m.ignored_candidates.len(), 2, "重复忽略不应产生重复项");
        let m = store.set_candidates_ignored(&["1.1.1.1:22".into()], false).unwrap();
        assert_eq!(m.ignored_candidates, vec!["2.2.2.2:22"]);

        let m = store
            .add_cloud_account(CloudAccount {
                id: "acc1".into(),
                provider: "tencent".into(),
                name: "主账号".into(),
                key_id: "AKID".into(),
                regions: vec![],
            })
            .unwrap();
        assert_eq!(m.cloud_accounts.len(), 1);
        let binding = CloudBinding {
            account_id: "acc1".into(),
            provider: "tencent".into(),
            product: "cvm".into(),
            region: "ap-guangzhou".into(),
            instance_id: "ins-1".into(),
            instance_name: "web".into(),
        };
        let m = store.bind_cloud(vec![("web".into(), Some(binding))]).unwrap();
        assert_eq!(m.hosts["web"].cloud.as_ref().unwrap().instance_id, "ins-1");
        let m = store.remove_cloud_account("acc1").unwrap();
        assert!(m.cloud_accounts.is_empty());
        assert!(m.hosts["web"].cloud.is_none(), "删账号应同时解绑");
        store.remove_host("web2").unwrap();
        let m = store.remove_host("web").unwrap();
        assert!(m.hosts.is_empty());
        fs::remove_dir_all(dir).unwrap();
    }
}
