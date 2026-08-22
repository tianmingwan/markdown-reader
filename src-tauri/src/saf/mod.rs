//! 安卓 SAF（Storage Access Framework）桥接。
//!
//! 桌面端：空插件，文件夹选择走系统对话框。
//! 安卓端：通过 Tauri 移动插件机制（tauri 2.11 新版）调用 Kotlin 侧实现
//! （ACTION_OPEN_DOCUMENT_TREE 授权目录 → 递归列出 .md 文件树 → 读取文本/图片）。
//! Kotlin 源码在 `src-tauri/android-extras/`，构建安卓版时拷入生成工程。
//! 插件由 `register_android_plugin` 自动实例化，无需修改 MainActivity。

#[cfg(mobile)]
mod mobile;
#[cfg(mobile)]
pub use mobile::*;

use tauri::{plugin::TauriPlugin, Manager, Runtime};

/// 注册 SAF 插件；桌面端为 no-op，安卓端在 setup 里注册 Kotlin 插件
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("saf")
        .setup(|app, api| {
            #[cfg(mobile)]
            {
                let saf = mobile::init(app, api)?;
                app.manage(saf);
            }
            Ok(())
        })
        .build()
}

/// 读取 md 文本：桌面直接读文件；安卓走 SAF
#[cfg(not(mobile))]
pub fn read_text(path: &str) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

/// 读取图片等二进制：桌面直接读文件；安卓走 SAF（插件内部 base64 中转）
#[cfg(not(mobile))]
pub fn read_bytes(path: &str) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| e.to_string())
}

/// 列出目录树：桌面直接扫描；安卓走 SAF 递归查询
#[cfg(not(mobile))]
pub fn list_tree(loc: &str) -> Result<crate::tree::Tree, String> {
    Ok(crate::tree::scan(loc))
}
