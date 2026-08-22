//! `mdimg://` 自定义协议：预览中图片的本地读取（相对路径图片统一改写到这里）。
//! 桌面：`mdimg://local/<percent-encoded 绝对路径>` → 直接读文件。
//! 安卓：`mdimg://mobile/<ctx>/<rel>` → SAF 插件解析相对路径后读取。

use tauri::{http::Response, UriSchemeContext, Wry};
#[cfg_attr(not(mobile), allow(unused_imports))]
use tauri::Manager;

use percent_encoding::percent_decode_str;

fn mime_for(path: &str) -> &'static str {
    let lower = path.to_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".svg") {
        "image/svg+xml"
    } else if lower.ends_with(".bmp") {
        "image/bmp"
    } else if lower.ends_with(".ico") {
        "image/x-icon"
    } else if lower.ends_with(".avif") {
        "image/avif"
    } else {
        "application/octet-stream"
    }
}

/// 在 Builder 上注册 mdimg 协议（应用为 Wry 运行时）
pub fn register(builder: tauri::Builder<Wry>) -> tauri::Builder<Wry> {
    builder.register_uri_scheme_protocol("mdimg", |_ctx: UriSchemeContext<Wry>, request| {
        let uri = request.uri().to_string();
        #[cfg(mobile)]
        let app = _ctx.app_handle().clone();

        #[cfg(mobile)]
        {
            if let Some(idx) = uri.find("mobile/") {
                let rest = &uri[idx + 7..];
                let (ctx_s, rel) = match rest.split_once('/') {
                    Some((c, r)) => (c.to_string(), r.to_string()),
                    None => (String::new(), String::new()),
                };
                let ctx_s = percent_decode_str(&ctx_s).decode_utf8_lossy().into_owned();
                let rel = percent_decode_str(&rel).decode_utf8_lossy().into_owned();
                if ctx_s.is_empty() || rel.is_empty() {
                    return Response::builder()
                        .status(404)
                        .body(std::borrow::Cow::Owned(Vec::new()))
                        .unwrap();
                }
                let state = app.state::<crate::saf::SafPlugin<Wry>>();
                return match state.resolve_bytes_b64(&ctx_s, &rel) {
                    Ok((bytes, mime)) => Response::builder()
                        .header("content-type", mime.as_str())
                        .header("cache-control", "no-cache")
                        .body(bytes.into())
                        .unwrap(),
                    Err(_) => Response::builder()
                        .status(404)
                        .body(std::borrow::Cow::Owned(Vec::new()))
                        .unwrap(),
                };
            }
            return Response::builder()
                .status(404)
                .body(std::borrow::Cow::Owned(Vec::new()))
                .unwrap();
        }

        #[cfg(not(mobile))]
        {
            let Some(idx) = uri.find("local/") else {
                return Response::builder()
                    .status(404)
                    .body(std::borrow::Cow::Owned(Vec::new()))
                    .unwrap();
            };
            let encoded = &uri[idx + 6..];
            let decoded = percent_decode_str(encoded)
                .decode_utf8_lossy()
                .into_owned();
            if decoded.is_empty() {
                return Response::builder()
                    .status(404)
                    .body(std::borrow::Cow::Owned(Vec::new()))
                    .unwrap();
            }
            let mime = mime_for(&decoded);
            return match crate::saf::read_bytes(&decoded) {
                Ok(bytes) => Response::builder()
                    .header("content-type", mime)
                    .header("cache-control", "no-cache")
                    .body(bytes.into())
                    .unwrap(),
                Err(_) => Response::builder()
                    .status(404)
                    .body(Vec::new().into())
                    .unwrap(),
            };
        }
    })
}