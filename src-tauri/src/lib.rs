//! markdown阅读器 · 主入口与 Tauri 命令层

mod img;
mod saf;

use mdreader_core::{md, search, session, tree};

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub struct AppState {
    pub root: Mutex<Option<session::RootRef>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedRoot {
    pub root: session::RootRef,
    pub tree: tree::Tree,
}

/// 扫描目录树（fs 或 SAF）
fn scan_tree_internal(_app: &AppHandle, root: &session::RootRef) -> Result<tree::Tree, String> {
    if root.kind == "saf" {
        #[cfg(mobile)]
        {
            let app = _app;
            let state = app.state::<saf::SafPlugin<tauri::Wry>>();
            return state.list_tree(&root.loc);
        }
        #[cfg(not(mobile))]
        {
            return Err("此平台不支持 SAF 目录".into());
        }
    }
    #[cfg(not(mobile))]
    {
        saf::list_tree(&root.loc)
    }
    #[cfg(mobile)]
    {
        Err("此平台不支持本地目录".into())
    }
}

/// 设置当前打开的根目录：扫描 + 存状态 + 启动监听（仅桌面 fs）
fn open_root_internal(app: &AppHandle, root: session::RootRef) -> Result<OpenedRoot, String> {
    let tree = scan_tree_internal(app, &root)?;
    *app.state::<AppState>().root.lock().unwrap() = Some(root.clone());
    if root.kind == "fs" {
        spawn_watcher(app.clone(), &root.loc);
    }
    Ok(OpenedRoot { root, tree })
}

// ============================ Tauri 命令 ============================

/// 弹出「打开文件夹」选择器（桌面：系统对话框；安卓：SAF 目录授权）
#[tauri::command]
fn open_folder_picker(app: AppHandle) -> Result<Option<OpenedRoot>, String> {
    #[cfg(mobile)]
    {
        let state = app.state::<saf::SafPlugin<tauri::Wry>>();
        let root = state.pick_folder()?;
        let opened = open_root_internal(&app, root)?;
        return Ok(Some(opened));
    }
    #[cfg(not(mobile))]
    {
        use tauri_plugin_dialog::DialogExt;
        let picked = app
            .dialog()
            .file()
            .blocking_pick_folder()
            .and_then(|p| p.into_path().ok());
        let Some(path) = picked else {
            return Ok(None);
        };
        let loc = path.to_string_lossy().replace('\\', "/");
        let opened = open_root_internal(&app, session::RootRef {
            kind: "fs".into(),
            loc,
        })?;
        Ok(Some(opened))
    }
}

/// 直接打开一个已知根目录（启动恢复 / 最近打开列表）
#[tauri::command]
fn open_root(app: AppHandle, root: session::RootRef) -> Result<OpenedRoot, String> {
    open_root_internal(&app, root)
}

/// 重新扫描当前根目录
#[tauri::command]
fn scan_tree(app: AppHandle, root: session::RootRef) -> Result<tree::Tree, String> {
    scan_tree_internal(&app, &root)
}

/// 渲染一篇 md：读取 + 转 HTML（含代码高亮/图片路径改写）
#[tauri::command]
fn render_md(_app: AppHandle, path: String, dark: bool) -> Result<md::RenderedMd, String> {
    if path.starts_with("content://") {
        #[cfg(mobile)]
        {
            let app = _app;
            let state = app.state::<saf::SafPlugin<tauri::Wry>>();
            let text = state.read_text(&path)?;
            return Ok(md::render(&text, "", dark, Some(&path)));
        }
        #[cfg(not(mobile))]
        {
            return Err("非法路径".into());
        }
    }
    let base = std::path::Path::new(&path)
        .parent()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    #[cfg(not(mobile))]
    {
        let text = saf::read_text(&path)?;
        return Ok(md::render(&text, &base, dark, None));
    }
    #[cfg(mobile)]
    {
        let _ = (base, dark);
        Err("非法路径".into())
    }
}

/// 全文搜索（桌面：文件系统遍历，后台线程执行）
#[tauri::command]
async fn search_files(root: String, query: String) -> Vec<search::SearchHit> {
    tauri::async_runtime::spawn_blocking(move || search::search(&root, &query))
        .await
        .unwrap_or_default()
}

/// 全文搜索（安卓 SAF：必须同步命令——tauri 移动端插件 JNI 在 async 上下文无法回传响应）
#[tauri::command]
fn search_files_saf(app: AppHandle, root: String, query: String) -> Vec<search::SearchHit> {
    #[cfg(mobile)]
    {
        let state = app.state::<saf::SafPlugin<tauri::Wry>>();
        return state.search_tree(&root, &query).unwrap_or_default();
    }
    #[cfg(not(mobile))]
    {
        Vec::new()
    }
}

/// 保存会话（最近打开/上次位置/滚动比例/主题）
#[tauri::command]
fn save_session(app: AppHandle, session: session::Session) -> Result<(), String> {
    let cfg = app.path().app_config_dir().map_err(|e| e.to_string())?;
    session::save(&cfg, &session)
}

/// 读取会话
#[tauri::command]
fn load_session(app: AppHandle) -> session::Session {
    let cfg = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())
        .unwrap_or_else(|_| std::env::temp_dir());
    session::load(&cfg)
}

/// 用系统默认程序打开外部链接
#[tauri::command]
fn open_external(app: AppHandle, url: String) {
    use tauri_plugin_opener::OpenerExt;
    if let Err(e) = app.opener().open_url(url, None::<String>) {
        eprintln!("open_external failed: {e}");
    }
}

/// 安卓 SAF：解析相对路径（md 链接跳转用）
#[tauri::command]
fn resolve_rel(_app: AppHandle, ctx: String, rel: String) -> Result<String, String> {
    #[cfg(mobile)]
    {
        let app = _app;
        let state = app.state::<saf::SafPlugin<tauri::Wry>>();
        state.resolve_relative(&ctx, &rel)
    }
    #[cfg(not(mobile))]
    {
        let _ = (ctx, rel);
        Err("桌面端无需解析".into())
    }
}

// ============================ 文件监听 ============================

/// 监听根目录变化：防抖 300ms 后重扫树并广播
fn spawn_watcher(app: AppHandle, root_loc: &str) {
    use notify_debouncer_mini::{new_debouncer, DebounceEventResult, DebounceEventHandler};

    struct EventBridge(std::sync::mpsc::Sender<DebounceEventResult>);
    impl DebounceEventHandler for EventBridge {
        fn handle_event(&mut self, event: DebounceEventResult) {
            let _ = self.0.send(event);
        }
    }

    let root = root_loc.to_string();
    let (tx, rx) = std::sync::mpsc::channel();
    let Ok(mut debouncer) = new_debouncer(Duration::from_millis(300), EventBridge(tx)) else {
        return;
    };
    if debouncer
        .watcher()
        .watch(
            std::path::Path::new(&root),
            notify_debouncer_mini::notify::RecursiveMode::Recursive,
        )
        .is_err()
    {
        return;
    }
    std::thread::spawn(move || {
        while let Ok(result) = rx.recv() {
            match result {
                Ok(events) => {
                    let changed_md: Vec<String> = events
                        .iter()
                        .filter(|e| {
                            e.path
                                .extension()
                                .map(|x| {
                                    let x = x.to_string_lossy().to_lowercase();
                                    x == "md" || x == "markdown"
                                })
                                .unwrap_or(false)
                        })
                        .map(|e| e.path.to_string_lossy().replace('\\', "/"))
                        .collect();

                    let tree = tree::scan(&root);
                    let payload = OpenedRoot {
                        root: session::RootRef {
                            kind: "fs".into(),
                            loc: root.clone(),
                        },
                        tree,
                    };
                    let _ = app.emit("tree-changed", &payload);

                    if !changed_md.is_empty() {
                        let _ = app.emit("file-changed", &changed_md);
                    }
                }
                Err(_) => {}
            }
        }
    });
}

// ============================ 入口 ============================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = img::register(
        tauri::Builder::default()
            .plugin(saf::init())
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_opener::init())
            .manage(AppState {
                root: Mutex::new(None),
            }),
    );
    builder
        .setup(|app| {
            // 调试用：环境变量指定初始文件夹（开发冒烟测试）
            if let Ok(dir) = std::env::var("MDREADER_DEV_FOLDER") {
                if !dir.is_empty() {
                    let root = session::RootRef {
                        kind: "fs".into(),
                        loc: dir,
                    };
                    match open_root_internal(app.handle(), root) {
                        Ok(opened) => {
                            // 广播一次，让前端（无会话时）也能接管该目录
                            let _ = app.emit("tree-changed", &opened);
                        }
                        Err(e) => eprintln!("MDREADER_DEV_FOLDER open failed: {e}"),
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_folder_picker,
            open_root,
            scan_tree,
            render_md,
            search_files,
            search_files_saf,
            save_session,
            load_session,
            open_external,
            resolve_rel
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}