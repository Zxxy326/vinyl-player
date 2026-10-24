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

/// 沉浸播放时别让系统休眠。
/// SetThreadExecutionState 是**线程级**的状态：调用它的线程一退出就失效，
/// 所以起一个常驻线程持有这个状态，命令只负责给它发消息。
static AWAKE_TX: std::sync::OnceLock<std::sync::mpsc::Sender<bool>> = std::sync::OnceLock::new();

#[cfg(windows)]
extern "system" {
    fn SetThreadExecutionState(flags: u32) -> u32;
}

fn awake_tx() -> &'static std::sync::mpsc::Sender<bool> {
    AWAKE_TX.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        std::thread::spawn(move || {
            let mut cur = false;
            for want in rx {
                if want == cur {
                    continue;
                }
                cur = want;
                #[cfg(windows)]
                unsafe {
                    const ES_CONTINUOUS: u32 = 0x8000_0000;
                    const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
                    const ES_DISPLAY_REQUIRED: u32 = 0x0000_0002;
                    let flags = if cur {
                        ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED
                    } else {
                        ES_CONTINUOUS
                    };
                    SetThreadExecutionState(flags);
                }
            }
        });
        tx
    })
}

#[tauri::command]
fn keep_awake(on: bool) {
    let _ = awake_tx().send(on);
}

/// 前端把首帧排好了：这时候才真的把窗口放出来。
/// 窗口 show() 之后启动幕会立刻开始化开，所以用户看到的第一帧就是启动幕。
#[tauri::command]
fn frontend_ready(window: tauri::Window) {
    let _ = window.show();
    let _ = window.set_focus();
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

/// 窗口几何动画：让原生窗口自己连续长大/缩小。
///
/// 为什么必须放到 Rust 里做：Windows 的窗口尺寸是「一帧换掉」的，
/// setFullscreen / setSize 都只有终态。前端拿 CSS 怎么补，都会留下
/// 「窗口已经变大、内容还没长满」的空档 —— 真机录屏逐帧看，那半秒
/// 画面是空的，比硬切还难看。这里用 ~60fps 逐帧推 set_bounds，
/// 窗口和内容一起连续变，中间不会出现内容比窗口小的一帧。
#[tauri::command]
async fn animate_window(app: tauri::AppHandle, w: f64, h: f64, x: f64, y: f64, ms: u64) -> Result<(), String> {
    /* 必须丢到阻塞线程池：同步命令是在主线程上跑的，这里每帧 sleep 12ms，
       放在主线程会把窗口消息循环堵死半秒 —— 那窗口反而会假死。
       挪出来以后主线程只负责真正执行 set_size，动画期间照常响应。 */
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let win = app.get_webview_window("main").ok_or("no main window")?;
        let sf = win.scale_factor().map_err(|e| e.to_string())?;
        let cur = win.outer_size().map_err(|e| e.to_string())?;
        let w0 = cur.width as f64 / sf;
        let h0 = cur.height as f64 / sf;

        let dur = (ms as f64 / 1000.0).max(0.001);
        let t0 = std::time::Instant::now();
        loop {
            let t = (t0.elapsed().as_secs_f64() / dur).min(1.0);
            // ease-out cubic，和前端那套缓动对齐
            let e = 1.0 - (1.0 - t).powi(3);
            let cw = w0 + (w - w0) * e;
            let ch = h0 + (h - h0) * e;
            // 动画过程中始终居中于目标矩形，放大/缩小都是对称展开
            let cx = x + (w - cw) / 2.0;
            let cy = y + (h - ch) / 2.0;
            let _ = win.set_size(tauri::LogicalSize::new(cw, ch));
            let _ = win.set_position(tauri::LogicalPosition::new(cx, cy));
            if t >= 1.0 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(12));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 当前窗口的 (宽, 高, x, y)，逻辑像素。进沉浸前存一份，退出时缩回去。
#[tauri::command]
fn window_geometry(app: tauri::AppHandle) -> Result<(f64, f64, f64, f64), String> {
    let win = app.get_webview_window("main").ok_or("no main window")?;
    let sf = win.scale_factor().map_err(|e| e.to_string())?;
    let sz = win.outer_size().map_err(|e| e.to_string())?;
    let pos = win.outer_position().map_err(|e| e.to_string())?;
    Ok((
        sz.width as f64 / sf,
        sz.height as f64 / sf,
        pos.x as f64 / sf,
        pos.y as f64 / sf,
    ))
}

/// 当前显示器的 (宽, 高)，逻辑像素 —— 沉浸模式要铺满它
#[tauri::command]
fn screen_geometry(app: tauri::AppHandle) -> Result<(f64, f64), String> {
    let win = app.get_webview_window("main").ok_or("no main window")?;
    let sf = win.scale_factor().map_err(|e| e.to_string())?;
    let mon = win
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("no monitor")?;
    let s = mon.size();
    Ok((s.width as f64 / sf, s.height as f64 / sf))
}

/// 置顶：铺满屏幕后要靠它压住任务栏，退出时还原
#[tauri::command]
fn set_topmost(app: tauri::AppHandle, on: bool) -> Result<(), String> {
    let win = app.get_webview_window("main").ok_or("no main window")?;
    win.set_always_on_top(on).map_err(|e| e.to_string())
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
    /* ---- 单实例 ----
       双击图标时如果已经有一个实例在跑，第二个不建窗口，只把消息递过去然后退出。
       用 127.0.0.1 上一个固定端口当"已运行"的锁：抢不到就说明前一个还活着。
       不引插件、不加依赖，Windows 上重复绑定同一端口本来就会失败。 */
    const IPC_PORT: u16 = 47321;
    let listener = match std::net::TcpListener::bind(("127.0.0.1", IPC_PORT)) {
        Ok(l) => l,
        Err(_) => {
            use std::io::Write;
            if let Ok(mut s) = std::net::TcpStream::connect(("127.0.0.1", IPC_PORT)) {
                let _ = s.write_all(b"focus\n");
            }
            return;
        }
    };

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
            resolve_close,
            keep_awake,
            frontend_ready,
            animate_window,
            window_geometry,
            screen_geometry,
            set_topmost
        ])
        .setup(move |app| {
            // 已经运行的实例收到第二个实例的消息后，把窗口叫回前台
            let ipc_handle = app.handle().clone();
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { continue };
                    let mut buf = [0u8; 8];
                    use std::io::Read;
                    let _ = stream.read(&mut buf);
                    reveal(&ipc_handle);
                }
            });
            build_tray(app)?;
            // 窗口是 visible:false 建出来的（见 tauri.conf.json），要等前端说"画好了"再放出来，
            // 否则用户会先看到一片空底色、再看到界面，也就是那个"闪一下"。
            // 兜底：前端要是启动阶段就挂了，2.8 秒后无论如何也把窗口放出来。
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(2800));
                if let Some(w) = handle.get_webview_window("main") {
                    if !w.is_visible().unwrap_or(true) {
                        let _ = w.show();
                    }
                }
            });
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
