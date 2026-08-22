//! 安卓 SAF 插件的 Rust 侧实现（tauri 2.11 新版移动插件 API）。
//! 通过 Builder.setup → PluginApi::register_android_plugin 注册 Kotlin 插件类，
//! 插件实例由 tauri 自动创建（Kotlin 构造器为 Plugin(activity)），无需 MainActivity 注册。

use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::search::SearchHit;
use crate::session::RootRef;
use crate::tree::{TreeNode, Tree};

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> Result<SafPlugin<R>, Box<dyn std::error::Error>> {
    // 包名 + Kotlin 类名（与 gen/android 里的 SafPlugin.kt 对应）
    let handle = api.register_android_plugin("com.chensdong.mdreader", "SafPlugin")?;
    Ok(SafPlugin(handle))
}

/// 访问 SAF 插件 API
pub struct SafPlugin<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> SafPlugin<R> {
    fn call<T: DeserializeOwned>(
        &self,
        method: &str,
        payload: impl serde::Serialize,
    ) -> Result<T, String> {
        self.0
            .run_mobile_plugin(method, payload)
            .map_err(|e| e.to_string())
    }

    /// 弹出系统目录授权选择器，返回 {uri, name}，取消则 Err
    pub fn pick_folder(&self) -> Result<RootRef, String> {
        let v: serde_json::Value = self.call("pickFolder", ())?;
        Ok(RootRef {
            kind: "saf".into(),
            loc: v["uri"].as_str().unwrap_or("").to_string(),
        })
    }

    /// 递归列出 SAF 目录树
    pub fn list_tree(&self, uri: &str) -> Result<Tree, String> {
        let v: serde_json::Value = self.call("listTree", serde_json::json!({ "uri": uri }))?;
        if v.get("children").is_none() {
            return Err("SAF 树解析失败".into());
        }
        Ok(Tree {
            name: v["name"].as_str().unwrap_or("文档库").to_string(),
            path: uri.to_string(),
            md_count: v["mdCount"].as_u64().unwrap_or(0),
            children: parse_children(&v["children"]),
        })
    }

    /// 按文档 Uri 读取文本
    pub fn read_text(&self, uri: &str) -> Result<String, String> {
        self.call("readText", serde_json::json!({ "uri": uri }))
    }

    /// 按文档 Uri 读取二进制（base64 中转），返回 (bytes, mime)
    pub fn read_bytes_b64(&self, uri: &str) -> Result<(Vec<u8>, String), String> {
        let v: serde_json::Value = self.call("readBytesBase64", serde_json::json!({ "uri": uri }))?;
        let b64 = v["base64"].as_str().unwrap_or("");
        let mime = v["mime"]
            .as_str()
            .unwrap_or("application/octet-stream")
            .to_string();
        use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
        let bytes = B64.decode(b64).map_err(|e| format!("base64 解码失败: {e}"))?;
        Ok((bytes, mime))
    }

    /// 解析相对路径（相对 md 文档所在目录）→ 文档 Uri
    pub fn resolve_relative(&self, ctx: &str, rel: &str) -> Result<String, String> {
        self.call("resolveRelative", serde_json::json!({ "ctx": ctx, "rel": rel }))
    }

    /// 解析相对路径并读取二进制（mdimg 相对图片）
    pub fn resolve_bytes_b64(&self, ctx: &str, rel: &str) -> Result<(Vec<u8>, String), String> {
        let v: serde_json::Value =
            self.call("resolveBytesBase64", serde_json::json!({ "ctx": ctx, "rel": rel }))?;
        let b64 = v["base64"].as_str().unwrap_or("");
        let mime = v["mime"]
            .as_str()
            .unwrap_or("application/octet-stream")
            .to_string();
        use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
        let bytes = B64.decode(b64).map_err(|e| format!("base64 解码失败: {e}"))?;
        Ok((bytes, mime))
    }

    /// 全文搜索（文件名 + md 内容；Kotlin 侧在后台线程实现）
    pub fn search_tree(&self, root: &str, query: &str) -> Result<Vec<SearchHit>, String> {
        let v: serde_json::Value =
            self.call("searchTree", serde_json::json!({ "uri": root, "query": query }))?;
        // Kotlin 侧返回 { hits: [...] }（JSObject 包装，走 org.json 原生序列化）
        let arr = v.get("hits").cloned().unwrap_or_default();
        Ok(parse_hits(&arr))
    }
}

fn parse_hits(arr: &serde_json::Value) -> Vec<SearchHit> {
    let Some(list) = arr.as_array() else {
        return vec![];
    };
    list.iter()
        .map(|h| SearchHit {
            path: h["path"].as_str().unwrap_or("").to_string(),
            name: h["name"].as_str().unwrap_or("").to_string(),
            matched_by: h["matchedBy"].as_str().unwrap_or("name").to_string(),
            snippets: h["snippets"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|s| s.as_str().map(|x| x.to_string()))
                        .collect()
                })
                .unwrap_or_default(),
        })
        .collect()
}

fn parse_children(arr: &serde_json::Value) -> Vec<TreeNode> {
    let Some(list) = arr.as_array() else {
        return vec![];
    };
    list.iter()
        .filter_map(|n| {
            let kind = n["kind"].as_str().unwrap_or("file").to_string();
            let is_dir = kind == "dir";
            Some(TreeNode {
                name: n["name"].as_str().unwrap_or("").to_string(),
                path: n["path"].as_str().unwrap_or("").to_string(),
                kind,
                size: n["size"].as_u64().unwrap_or(0),
                mtime: n["mtime"].as_u64().unwrap_or(0),
                children: if is_dir {
                    Some(parse_children(&n["children"]))
                } else {
                    None
                },
            })
        })
        .collect()
}
