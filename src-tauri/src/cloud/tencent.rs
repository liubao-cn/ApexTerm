//! 腾讯云：TC3-HMAC-SHA256 签名，覆盖 CVM（云服务器）与 Lighthouse（轻量应用服务器）。
//! 文档：https://cloud.tencent.com/document/api/213/30654

use serde_json::{json, Value};
use ureq::Agent;

use super::http::{agent, hmac_sha256, net_err, read_json, sha256_hex};
use super::{normalize_state, CloudInstance, PowerAction, Provider};
use crate::error::{AppError, Result};
use crate::meta::CloudBinding;

const CVM_VERSION: &str = "2017-03-12";
const LIGHTHOUSE_VERSION: &str = "2020-03-24";

pub struct Tencent {
    secret_id: String,
    secret_key: String,
    agent: Agent,
}

impl Tencent {
    pub fn new(secret_id: &str, secret_key: &str) -> Self {
        Self {
            secret_id: secret_id.trim().to_string(),
            secret_key: secret_key.trim().to_string(),
            agent: agent(),
        }
    }

    fn call(
        &self,
        service: &str,
        version: &str,
        region: Option<&str>,
        action: &str,
        payload: &Value,
    ) -> Result<Value> {
        let host = format!("{service}.tencentcloudapi.com");
        let body = serde_json::to_string(payload)?;
        let now = chrono::Utc::now();
        let timestamp = now.timestamp();
        let date = now.format("%Y-%m-%d").to_string();
        let content_type = "application/json; charset=utf-8";

        let canonical_headers = format!(
            "content-type:{content_type}\nhost:{host}\nx-tc-action:{}\n",
            action.to_ascii_lowercase()
        );
        let signed_headers = "content-type;host;x-tc-action";
        let canonical_request = format!(
            "POST\n/\n\n{canonical_headers}\n{signed_headers}\n{}",
            sha256_hex(body.as_bytes())
        );
        let scope = format!("{date}/{service}/tc3_request");
        let string_to_sign = format!(
            "TC3-HMAC-SHA256\n{timestamp}\n{scope}\n{}",
            sha256_hex(canonical_request.as_bytes())
        );
        let k_date = hmac_sha256(format!("TC3{}", self.secret_key).as_bytes(), date.as_bytes());
        let k_service = hmac_sha256(&k_date, service.as_bytes());
        let k_signing = hmac_sha256(&k_service, b"tc3_request");
        let signature = hex::encode(hmac_sha256(&k_signing, string_to_sign.as_bytes()));
        let authorization = format!(
            "TC3-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
            self.secret_id
        );

        let mut req = self
            .agent
            .post(format!("https://{host}/"))
            .header("Authorization", authorization)
            .header("Content-Type", content_type)
            .header("X-TC-Action", action)
            .header("X-TC-Timestamp", timestamp.to_string())
            .header("X-TC-Version", version);
        if let Some(r) = region {
            req = req.header("X-TC-Region", r);
        }
        let resp = req.send(body.as_str()).map_err(net_err)?;
        let v = read_json(resp)?;
        if let Some(err) = v.pointer("/Response/Error") {
            let code = err["Code"].as_str().unwrap_or("?");
            let msg = err["Message"].as_str().unwrap_or("");
            return Err(AppError::msg(format!("腾讯云 {action} 失败 [{code}]: {msg}")));
        }
        Ok(v["Response"].clone())
    }

    fn cvm(&self, region: Option<&str>, action: &str, payload: Value) -> Result<Value> {
        self.call("cvm", CVM_VERSION, region, action, &payload)
    }

    fn lighthouse(&self, region: Option<&str>, action: &str, payload: Value) -> Result<Value> {
        self.call("lighthouse", LIGHTHOUSE_VERSION, region, action, &payload)
    }

    fn call_product(&self, binding: &CloudBinding, action: &str, payload: Value) -> Result<Value> {
        match binding.product.as_str() {
            "lighthouse" => self.lighthouse(Some(&binding.region), action, payload),
            _ => self.cvm(Some(&binding.region), action, payload),
        }
    }
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

fn cvm_instance(account_id: &str, region: &str, v: &Value) -> CloudInstance {
    let raw_state = v["InstanceState"].as_str().unwrap_or("").to_string();
    CloudInstance {
        account_id: account_id.into(),
        provider: "tencent".into(),
        product: "cvm".into(),
        region: region.into(),
        zone: v["Placement"]["Zone"].as_str().unwrap_or("").into(),
        instance_id: v["InstanceId"].as_str().unwrap_or("").into(),
        name: v["InstanceName"].as_str().unwrap_or("").into(),
        state: normalize_state(&raw_state),
        raw_state,
        public_ips: strs(&v["PublicIpAddresses"]),
        private_ips: strs(&v["PrivateIpAddresses"]),
        os: v["OsName"].as_str().unwrap_or("").into(),
        cpu: v["CPU"].as_u64().unwrap_or(0) as u32,
        memory_gb: v["Memory"].as_u64().unwrap_or(0) as u32,
    }
}

fn lighthouse_instance(account_id: &str, region: &str, v: &Value) -> CloudInstance {
    let raw_state = v["InstanceState"].as_str().unwrap_or("").to_string();
    CloudInstance {
        account_id: account_id.into(),
        provider: "tencent".into(),
        product: "lighthouse".into(),
        region: region.into(),
        zone: v["Zone"].as_str().unwrap_or("").into(),
        instance_id: v["InstanceId"].as_str().unwrap_or("").into(),
        name: v["InstanceName"].as_str().unwrap_or("").into(),
        state: normalize_state(&raw_state),
        raw_state,
        public_ips: strs(&v["PublicAddresses"]),
        private_ips: strs(&v["PrivateAddresses"]),
        os: v["OsName"].as_str().unwrap_or("").into(),
        cpu: v["CPU"].as_u64().unwrap_or(0) as u32,
        memory_gb: v["Memory"].as_u64().unwrap_or(0) as u32,
    }
}

impl Provider for Tencent {
    fn regions(&self) -> Result<Vec<String>> {
        let resp = self.cvm(None, "DescribeRegions", json!({}))?;
        let mut regions: Vec<String> = resp["RegionSet"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter(|r| r["RegionState"].as_str().unwrap_or("AVAILABLE") == "AVAILABLE")
                    .filter_map(|r| r["Region"].as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        regions.sort();
        regions.dedup();
        if regions.is_empty() {
            return Err(AppError::msg("腾讯云未返回任何地域，请检查密钥权限"));
        }
        Ok(regions)
    }

    fn list_instances(&self, account_id: &str, region: &str) -> Result<Vec<CloudInstance>> {
        let mut out = Vec::new();
        // CVM 分页
        let mut offset = 0u64;
        loop {
            let resp = self.cvm(
                Some(region),
                "DescribeInstances",
                json!({ "Offset": offset, "Limit": 100 }),
            )?;
            let set = resp["InstanceSet"].as_array().cloned().unwrap_or_default();
            let n = set.len() as u64;
            out.extend(set.iter().map(|v| cvm_instance(account_id, region, v)));
            offset += n;
            if n < 100 || offset >= resp["TotalCount"].as_u64().unwrap_or(0) {
                break;
            }
        }
        // 轻量应用服务器：不是每个地域都有该产品，报"地域不支持"时忽略
        match self.lighthouse(
            Some(region),
            "DescribeInstances",
            json!({ "Offset": 0, "Limit": 100 }),
        ) {
            Ok(resp) => {
                let set = resp["InstanceSet"].as_array().cloned().unwrap_or_default();
                out.extend(set.iter().map(|v| lighthouse_instance(account_id, region, v)));
            }
            Err(e) => {
                let s = e.to_string();
                if !(s.contains("UnsupportedRegion") || s.contains("InvalidParameterValue.RegionNotFound") || s.contains("UnauthorizedOperation") || s.contains("InvalidParameter.Region")) {
                    return Err(e);
                }
            }
        }
        Ok(out)
    }

    fn describe(&self, binding: &CloudBinding) -> Result<CloudInstance> {
        let resp = self.call_product(
            binding,
            "DescribeInstances",
            json!({ "InstanceIds": [binding.instance_id] }),
        )?;
        let first = resp["InstanceSet"]
            .as_array()
            .and_then(|a| a.first())
            .ok_or_else(|| AppError::msg(format!("实例 {} 不存在（可能已释放）", binding.instance_id)))?;
        Ok(if binding.product == "lighthouse" {
            lighthouse_instance(&binding.account_id, &binding.region, first)
        } else {
            cvm_instance(&binding.account_id, &binding.region, first)
        })
    }

    fn power(&self, binding: &CloudBinding, action: PowerAction) -> Result<()> {
        let ids = json!([binding.instance_id]);
        let is_lh = binding.product == "lighthouse";
        let (api, payload) = match action {
            PowerAction::Start => ("StartInstances", json!({ "InstanceIds": ids })),
            PowerAction::Stop if is_lh => ("StopInstances", json!({ "InstanceIds": ids })),
            PowerAction::Stop => ("StopInstances", json!({ "InstanceIds": ids, "StopType": "SOFT_FIRST" })),
            PowerAction::ForceStop if is_lh => ("StopInstances", json!({ "InstanceIds": ids })),
            PowerAction::ForceStop => ("StopInstances", json!({ "InstanceIds": ids, "StopType": "HARD" })),
            PowerAction::Reboot if is_lh => ("RebootInstances", json!({ "InstanceIds": ids })),
            PowerAction::Reboot => ("RebootInstances", json!({ "InstanceIds": ids, "StopType": "SOFT_FIRST" })),
            PowerAction::ForceReboot if is_lh => ("RebootInstances", json!({ "InstanceIds": ids })),
            PowerAction::ForceReboot => ("RebootInstances", json!({ "InstanceIds": ids, "StopType": "HARD" })),
        };
        self.call_product(binding, api, payload).map(|_| ())
    }

    fn vnc_url(&self, binding: &CloudBinding) -> Result<String> {
        let resp = self.call_product(
            binding,
            "DescribeInstanceVncUrl",
            json!({ "InstanceId": binding.instance_id }),
        )?;
        let url = resp["InstanceVncUrl"]
            .as_str()
            .ok_or_else(|| AppError::msg("腾讯云未返回 VNC 地址"))?;
        Ok(format!(
            "https://img.qcloud.com/qcloud/app/active_vnc/index.html?InstanceVncUrl={url}"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cvm_and_lighthouse_shapes() {
        let cvm = json!({
            "InstanceId": "ins-1", "InstanceName": "web", "InstanceState": "RUNNING",
            "Placement": { "Zone": "ap-guangzhou-3" },
            "PublicIpAddresses": ["1.2.3.4"], "PrivateIpAddresses": ["10.0.0.1"],
            "OsName": "Ubuntu", "CPU": 2, "Memory": 4
        });
        let i = cvm_instance("acc", "ap-guangzhou", &cvm);
        assert_eq!(i.product, "cvm");
        assert_eq!(i.public_ips, vec!["1.2.3.4"]);
        assert_eq!(i.state, super::super::InstanceState::Running);
        assert_eq!(i.zone, "ap-guangzhou-3");

        let lh = json!({
            "InstanceId": "lhins-1", "InstanceName": "lite", "InstanceState": "STOPPED",
            "Zone": "ap-shanghai-2", "PublicAddresses": ["5.6.7.8"], "PrivateAddresses": ["10.0.0.9"],
            "OsName": "Debian", "CPU": 1, "Memory": 2
        });
        let i = lighthouse_instance("acc", "ap-shanghai", &lh);
        assert_eq!(i.product, "lighthouse");
        assert_eq!(i.state, super::super::InstanceState::Stopped);
        assert_eq!(i.binding().instance_id, "lhins-1");
    }
}
