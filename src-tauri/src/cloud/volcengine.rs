//! 火山引擎：HMAC-SHA256（SigV4 风格）签名，覆盖 ECS 云服务器。
//! 文档：https://www.volcengine.com/docs/6369/67269

use serde_json::Value;
use ureq::Agent;

use super::http::{agent, hmac_sha256, net_err, percent_encode, read_json, sha256_hex};
use super::{normalize_state, CloudInstance, PowerAction, Provider};
use crate::error::{AppError, Result};
use crate::meta::CloudBinding;

const SERVICE: &str = "ecs";
const HOST: &str = "ecs.volcengineapi.com";
const VERSION: &str = "2020-04-01";
/// DescribeRegions 本身不分地域，签名时随便给一个合法地域即可
const DEFAULT_REGION: &str = "cn-beijing";

pub struct Volcengine {
    access_key: String,
    secret_key: String,
    agent: Agent,
}

impl Volcengine {
    pub fn new(access_key: &str, secret_key: &str) -> Self {
        Self {
            access_key: access_key.trim().to_string(),
            secret_key: secret_key.trim().to_string(),
            agent: agent(),
        }
    }

    /// 火山 ECS 接口全部走 GET + 查询参数（数组参数形如 `InstanceIds.1`）
    fn call(&self, region: &str, action: &str, params: &[(&str, String)]) -> Result<Value> {
        let mut query: Vec<(String, String)> = params
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        query.push(("Action".into(), action.into()));
        query.push(("Version".into(), VERSION.into()));
        query.sort();
        let canonical_query = query
            .iter()
            .map(|(k, v)| format!("{}={}", percent_encode(k), percent_encode(v)))
            .collect::<Vec<_>>()
            .join("&");

        let now = chrono::Utc::now();
        let x_date = now.format("%Y%m%dT%H%M%SZ").to_string();
        let date = now.format("%Y%m%d").to_string();
        let payload_hash = sha256_hex(b"");
        let canonical_headers = format!("host:{HOST}\nx-content-sha256:{payload_hash}\nx-date:{x_date}\n");
        let signed_headers = "host;x-content-sha256;x-date";
        let canonical_request = format!(
            "GET\n/\n{canonical_query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
        );
        let scope = format!("{date}/{region}/{SERVICE}/request");
        let string_to_sign = format!(
            "HMAC-SHA256\n{x_date}\n{scope}\n{}",
            sha256_hex(canonical_request.as_bytes())
        );
        let k_date = hmac_sha256(self.secret_key.as_bytes(), date.as_bytes());
        let k_region = hmac_sha256(&k_date, region.as_bytes());
        let k_service = hmac_sha256(&k_region, SERVICE.as_bytes());
        let k_signing = hmac_sha256(&k_service, b"request");
        let signature = hex::encode(hmac_sha256(&k_signing, string_to_sign.as_bytes()));
        let authorization = format!(
            "HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
            self.access_key
        );

        let resp = self
            .agent
            .get(format!("https://{HOST}/?{canonical_query}"))
            .header("X-Date", x_date)
            .header("X-Content-Sha256", payload_hash)
            .header("Authorization", authorization)
            .call()
            .map_err(net_err)?;
        let v = read_json(resp)?;
        if let Some(err) = v.pointer("/ResponseMetadata/Error") {
            let code = err["Code"].as_str().unwrap_or("?");
            let msg = err["Message"].as_str().unwrap_or("");
            return Err(AppError::msg(format!("火山引擎 {action} 失败 [{code}]: {msg}")));
        }
        Ok(v["Result"].clone())
    }
}

fn instance(account_id: &str, region: &str, v: &Value) -> CloudInstance {
    let raw_state = v["Status"].as_str().unwrap_or("").to_string();
    let public_ips: Vec<String> = v["EipAddress"]["IpAddress"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|s| vec![s.to_string()])
        .unwrap_or_default();
    let private_ips: Vec<String> = v["NetworkInterfaces"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|n| n["PrimaryIpAddress"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    CloudInstance {
        account_id: account_id.into(),
        provider: "volcengine".into(),
        product: "ecs".into(),
        region: region.into(),
        zone: v["ZoneId"].as_str().unwrap_or("").into(),
        instance_id: v["InstanceId"].as_str().unwrap_or("").into(),
        name: v["InstanceName"].as_str().unwrap_or("").into(),
        state: normalize_state(&raw_state),
        raw_state,
        public_ips,
        private_ips,
        os: v["OsName"].as_str().unwrap_or("").into(),
        cpu: v["Cpus"].as_u64().unwrap_or(0) as u32,
        memory_gb: (v["MemorySize"].as_u64().unwrap_or(0) / 1024) as u32,
    }
}

impl Provider for Volcengine {
    fn regions(&self) -> Result<Vec<String>> {
        let result = self.call(DEFAULT_REGION, "DescribeRegions", &[])?;
        let mut regions: Vec<String> = result["Regions"]
            .as_array()
            .map(|a| a.iter().filter_map(|r| r["RegionId"].as_str().map(String::from)).collect())
            .unwrap_or_default();
        regions.sort();
        regions.dedup();
        if regions.is_empty() {
            return Err(AppError::msg("火山引擎未返回任何地域，请检查密钥权限"));
        }
        Ok(regions)
    }

    fn list_instances(&self, account_id: &str, region: &str) -> Result<Vec<CloudInstance>> {
        let mut out = Vec::new();
        let mut next: Option<String> = None;
        loop {
            let mut params = vec![("MaxResults", "100".to_string())];
            if let Some(t) = &next {
                params.push(("NextToken", t.clone()));
            }
            let result = self.call(region, "DescribeInstances", &params)?;
            let list = result["Instances"].as_array().cloned().unwrap_or_default();
            out.extend(list.iter().map(|v| instance(account_id, region, v)));
            next = result["NextToken"].as_str().filter(|s| !s.is_empty()).map(String::from);
            if next.is_none() || list.is_empty() {
                break;
            }
        }
        Ok(out)
    }

    fn describe(&self, binding: &CloudBinding) -> Result<CloudInstance> {
        let result = self.call(
            &binding.region,
            "DescribeInstances",
            &[("InstanceIds.1", binding.instance_id.clone())],
        )?;
        let first = result["Instances"]
            .as_array()
            .and_then(|a| a.first())
            .ok_or_else(|| AppError::msg(format!("实例 {} 不存在（可能已释放）", binding.instance_id)))?;
        Ok(instance(&binding.account_id, &binding.region, first))
    }

    fn power(&self, binding: &CloudBinding, action: PowerAction) -> Result<()> {
        let id = ("InstanceId", binding.instance_id.clone());
        let (api, params): (&str, Vec<(&str, String)>) = match action {
            PowerAction::Start => ("StartInstance", vec![id]),
            PowerAction::Stop => ("StopInstance", vec![id, ("ForceStop", "false".into())]),
            PowerAction::ForceStop => ("StopInstance", vec![id, ("ForceStop", "true".into())]),
            PowerAction::Reboot => ("RebootInstance", vec![id, ("ForceStop", "false".into())]),
            PowerAction::ForceReboot => ("RebootInstance", vec![id, ("ForceStop", "true".into())]),
        };
        self.call(&binding.region, api, &params).map(|_| ())
    }

    fn vnc_url(&self, _binding: &CloudBinding) -> Result<String> {
        Err(AppError::msg("火山引擎暂不支持在程序内打开 VNC，请到控制台使用远程连接"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_instance_shape() {
        let v = json!({
            "InstanceId": "i-abc", "InstanceName": "vk", "Status": "RUNNING", "ZoneId": "cn-beijing-a",
            "EipAddress": { "IpAddress": "115.190.208.190" },
            "NetworkInterfaces": [{ "PrimaryIpAddress": "192.168.0.2" }],
            "OsName": "Debian 12", "Cpus": 2, "MemorySize": 4096
        });
        let i = instance("acc", "cn-beijing", &v);
        assert_eq!(i.public_ips, vec!["115.190.208.190"]);
        assert_eq!(i.private_ips, vec!["192.168.0.2"]);
        assert_eq!(i.memory_gb, 4);
        assert_eq!(i.state, super::super::InstanceState::Running);
    }
}
