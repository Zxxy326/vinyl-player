pub mod scan;
pub mod tags;
pub mod transcode;

use std::path::Path;

use base64_lite::encode as b64;

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
        .invoke_handler(tauri::generate_handler![
            pick_and_scan,
            scan_library,
            prepare_playback,
            read_cover,
            read_lyrics,
            log_line
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
