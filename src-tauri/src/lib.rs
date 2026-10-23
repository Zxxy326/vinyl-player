pub mod scan;
pub mod tags;
pub mod transcode;

use std::path::Path;
use std::sync::Mutex;

use base64_lite::encode as b64;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, State};

/// 关窗口时的行为。前端启动时把用户的选择同步过来（存在 localStorage 里），
/// 这里只做内存缓存：None = 还没选过，弹一次确认框。
#[derive(Default)]
struct CloseState(Mutex<Option<String>>);

#[tauri::command]
fn set_close_action(state: State<'_, CloseState>, action: String) {
    let mut g = state.0.lock().unwrap();
    // "ask" 就当成"还没决定"，下次照样弹
    *g = if action == "ask" { None } else { Some(action) };
}

/// 用户在确认框里点了某个选项
#[tauri::command]
fn resolve_close(
    window: tauri::Window,
    state: State<'_, CloseState>,
    action: String,
    remember: bool,
) {
    if remember {
        let mut g = state.0.lock().unwrap();
        *g = if action == "ask" { None } else { Some(action.clone()) };
    }
    match action.as_str() {
        "tray" => {
            let _ = window.hide();
        }
        _ => {
            window.app_handle().exit(0);
        }
    }
}

#[tauri::command]
async fn pick_and_scan() -> Result<scan::ScanResult, String> {
    let picked = tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("选择音乐文件夹")
            .pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;

    match picked {
        Some(dir) => {
            let d = dir.clone();
            tauri::async_runtime::spawn_blocking(move || scan::scan(&d))
                .await
                .map_err(|e| e.to_string())
        }
        None => Ok(scan::ScanResult {
            dir: String::new(),
            tracks: Vec::new(),
        }),
    }
}

#[tauri::command]
async fn scan_library(dir: String) -> Result<scan::ScanResult, String> {
    let p = std::path::PathBuf::from(&dir);
    if !p.is_dir() {
        return Err("目录不存在".into());
    }
    tauri::async_runtime::spawn_blocking(move || scan::scan(&p))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn prepare_playback(path: String) -> Result<transcode::Prep, String> {
    tauri::async_runtime::spawn_blocking(move || transcode::prepare(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn read_cover(path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        tags::cover(Path::new(&path)).map(|bytes| b64(&bytes))
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_lyrics(path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&path);
        // 先找同名 .lrc
        let mut side = p.to_path_buf();
        side.set_extension("lrc");
        if side.is_file() {
            if let Ok(bytes) = std::fs::read(&side) {
                if bytes.len() <= 256 * 1024 {
                    let s = String::from_utf8_lossy(&bytes)
                        .trim_start_matches('\u{feff}')
                        .to_string();
                    if !s.trim().is_empty() {
                        return Some(s);
                    }
                }
            }
        }
        tags::embedded_lyrics(p)
    })
    .await
    .map_err(|e| e.to_string())
}

/// 前端启动/异常写一行日志，便于排查「窗口空白」这类问题
#[tauri::command]
fn log_line(msg: String) {
    use std::io::Write;
    let dir = scan::cache_dir();
    let dir = dir.parent().map(|p| p.to_path_buf()).unwrap_or(dir);
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("boot.log"))
    {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "[{secs}] {msg}");
    }
}

/// 不引第三方依赖的最小 base64（封面用）
mod base64_lite {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    pub fn encode(input: &[u8]) -> String {
        let mut out = String::with_capacity(input.len() / 3 * 4 + 4);
        for chunk in input.chunks(3) {
            let b = [
                chunk[0],
                *chunk.get(1).unwrap_or(&0),
                *chunk.get(2).unwrap_or(&0),
            ];
            let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
            out.push(T[(n >> 18) as usize & 63] as char);
            out.push(T[(n >> 12) as usize & 63] as char);
            out.push(if chunk.len() > 1 {
                T[(n >> 6) as usize & 63] as char
            } else {
                '='
            });
            out.push(if chunk.len() > 2 {
                T[n as usize & 63] as char
            } else {
                '='
            });
        }
        out
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(CloseState::default())
        .invoke_handler(tauri::generate_handler![
            pick_and_scan,
            scan_library,
            prepare_playback,
            read_cover,
            read_lyrics,
            log_line,
            set_close_action,
            resolve_close
        ])
        .setup(|app| {
            build_tray(app)?;
            Ok(())
        })
        // 关窗口：按用户记住的选择处理；没选过就拦下来问前端
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let action = window
                    .state::<CloseState>()
                    .0
                    .lock()
                    .unwrap()
                    .clone();
                match action.as_deref() {
                    Some("quit") => { /* 放行，窗口关掉进程就退了 */ }
                    Some("tray") => {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    _ => {
                        api.prevent_close();
                        let _ = window.emit("vp://ask-close", ());
                        let _ = window.set_focus();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 托盘：收进后台时还能叫回来 / 退出
fn build_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Vinyl Player")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => reveal(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                reveal(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn reveal(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}
