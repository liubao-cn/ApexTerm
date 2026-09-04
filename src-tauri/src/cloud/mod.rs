//! 云厂商带外电源控制：开机 / 关机 / 强制重启 / 状态 / VNC。
//! SSH 不通（服务器卡死、已关机）时唯一有效的通道。
//! 目前支持腾讯云（CVM + 轻量应用服务器）和火山引擎（ECS）。

pub mod http;
pub mod secrets;
pub mod tencent;
pub mod volcengine;

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::meta::{CloudAccount, CloudBinding};
use crate::ssh_config::HostEntry;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PowerAction {
    Start,
    Stop,
    ForceStop,
    Reboot,
    ForceReboot,
}

/// 各家状态归一化后的取值
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InstanceState {
    Running,
    Stopped,
    Starting,
    Stopping,
    Rebooting,
    Pending,
    Unknown,
}

pub fn normalize_state(raw: &str) -> InstanceState {
    match raw.to_ascii_uppercase().as_str() {
        "RUNNING" => InstanceState::Running,
        "STOPPED" | "SHUTDOWN" => InstanceState::Stopped,
        "STARTING" => InstanceState::Starting,
        "STOPPING" => InstanceState::Stopping,
        "REBOOTING" => InstanceState::Rebooting,
        "PENDING" | "CREATING" | "LAUNCH_FAILED" => InstanceState::Pending,
        _ => InstanceState::Unknown,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudInstance {
    pub account_id: String,
    /// tencent | volcengine
    pub provider: String,
    /// cvm | lighthouse | ecs
    pub product: String,
    pub region: String,
    pub zone: String,
    pub instance_id: String,
    pub name: String,
    pub state: InstanceState,
    pub raw_state: String,
    pub public_ips: Vec<String>,
    pub private_ips: Vec<String>,
    pub os: String,
    pub cpu: u32,
    pub memory_gb: u32,
}

impl CloudInstance {
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn binding(&self) -> CloudBinding {
        CloudBinding {
            account_id: self.account_id.clone(),
            provider: self.provider.clone(),
            product: self.product.clone(),
            region: self.region.clone(),
            instance_id: self.instance_id.clone(),
            instance_name: self.name.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceMatch {
    pub host_id: String,
    pub alias: String,
    pub instance: CloudInstance,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub instances: Vec<CloudInstance>,
    pub matches: Vec<InstanceMatch>,
    pub regions_scanned: usize,
    pub errors: Vec<String>,
}

/// 统一的厂商客户端接口
pub trait Provider: Send + Sync {
    /// 校验凭据（列出可用地域）
    fn regions(&self) -> Result<Vec<String>>;
    /// 列出某个地域下（所有产品线）的实例
    fn list_instances(&self, account_id: &str, region: &str) -> Result<Vec<CloudInstance>>;
    /// 查询单个实例
    fn describe(&self, binding: &CloudBinding) -> Result<CloudInstance>;
    fn power(&self, binding: &CloudBinding, action: PowerAction) -> Result<()>;
    fn vnc_url(&self, binding: &CloudBinding) -> Result<String>;
}

pub fn client(account: &CloudAccount, secret: &str) -> Result<Box<dyn Provider>> {
    match account.provider.as_str() {
        "tencent" => Ok(Box::new(tencent::Tencent::new(&account.key_id, secret))),
        "volcengine" => Ok(Box::new(volcengine::Volcengine::new(&account.key_id, secret))),
        other => Err(AppError::msg(format!("不支持的云厂商: {other}"))),
    }
}

/// 并发扫描全部地域，把实例的公网 IP 和 config 里的 HostName / 别名对上
pub fn scan(account: &CloudAccount, secret: &str, hosts: &[HostEntry]) -> Result<ScanResult> {
    let client = client(account, secret)?;
    let regions = if account.regions.is_empty() {
        client.regions()?
    } else {
        account.regions.clone()
    };

    let mut instances = Vec::new();
    let mut errors = Vec::new();
    std::thread::scope(|s| {
        let handles: Vec<_> = regions
            .iter()
            .map(|region| {
                let client = &client;
                let account_id = account.id.as_str();
                s.spawn(move || (region.clone(), client.list_instances(account_id, region)))
            })
            .collect();
        for h in handles {
            match h.join() {
                Ok((_, Ok(list))) => instances.extend(list),
                Ok((region, Err(e))) => errors.push(format!("{region}: {e}")),
                Err(_) => errors.push("扫描线程异常".into()),
            }
        }
    });
    instances.sort_by(|a, b| (&a.region, &a.name).cmp(&(&b.region, &b.name)));

    let mut by_ip: HashMap<&str, &CloudInstance> = HashMap::new();
    for inst in &instances {
        for ip in inst.public_ips.iter().chain(inst.private_ips.iter()) {
            by_ip.entry(ip.as_str()).or_insert(inst);
        }
    }
    let matches = hosts
        .iter()
        .filter_map(|h| {
            let key = h.host_name.as_deref().unwrap_or(&h.alias);
            by_ip.get(key).map(|inst| InstanceMatch {
                host_id: h.id.clone(),
                alias: h.alias.clone(),
                instance: (*inst).clone(),
            })
        })
        .collect();

    Ok(ScanResult {
        instances,
        matches,
        regions_scanned: regions.len(),
        errors,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_normalization() {
        assert_eq!(normalize_state("RUNNING"), InstanceState::Running);
        assert_eq!(normalize_state("stopped"), InstanceState::Stopped);
        assert_eq!(normalize_state("SHUTDOWN"), InstanceState::Stopped);
        assert_eq!(normalize_state("REBOOTING"), InstanceState::Rebooting);
        assert_eq!(normalize_state("weird"), InstanceState::Unknown);
    }
}
