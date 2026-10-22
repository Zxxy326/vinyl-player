use std::path::{Path, PathBuf};

use serde::Serialize;
use walkdir::WalkDir;

use crate::{tags, transcode};

/// WebView2 原生就能解的格式，直接播
pub const NATIVE: &[&str] = &["mp3", "m4a", "aac", "flac", "wav", "ogg", "oga", "opus"];
/// symphonia 能解、但 WebView2 不能播的格式
pub const DECODABLE: &[&str] = &["aiff", "aif", "caf", "mp1", "mp2"];
/// 其余格式只有 ffmpeg 能救
const OTHERS: &[&str] = &[
    "ape", "wma", "dsf", "dff", "wv", "mpc", "tak", "tta", "mka", "ac3", "dts",
];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration: f64,
    pub format: String,
    pub playable: bool,
    pub needs_transcode: bool,
    pub lrc: String,
    pub size: u64,
    /// kbps
    pub bitrate: u32,
    /// Hz
    pub sample_rate: u32,
    /// bit
    pub bit_depth: u32,
}

#[derive(Serialize)]
pub struct ScanResult {
    pub dir: String,
    pub tracks: Vec<Track>,
}

pub fn is_audio(ext: &str) -> bool {
    NATIVE.contains(&ext) || DECODABLE.contains(&ext) || OTHERS.contains(&ext)
}

fn sidecar_lrc(path: &Path) -> String {
    let mut p = path.to_path_buf();
    p.set_extension("lrc");
    if !p.exists() {
        // 大小写不敏感地再试一次
        if let (Some(parent), Some(stem)) = (path.parent(), path.file_stem()) {
            if let Ok(rd) = std::fs::read_dir(parent) {
                for e in rd.flatten() {
                    let name = e.file_name().to_string_lossy().to_lowercase();
                    if name == format!("{}.lrc", stem.to_string_lossy().to_lowercase()) {
                        return read_text(&e.path());
                    }
                }
            }
        }
        return String::new();
    }
    read_text(&p)
}

fn read_text(p: &Path) -> String {
    match std::fs::read(p) {
        Ok(bytes) if bytes.len() <= 256 * 1024 => {
            let s = String::from_utf8_lossy(&bytes).to_string();
            s.trim_start_matches('\u{feff}').to_string()
        }
        _ => String::new(),
    }
}

pub fn scan(dir: &Path) -> ScanResult {
    let has_ffmpeg = transcode::ffmpeg_path().is_some();
    let mut tracks = Vec::new();

    for entry in WalkDir::new(dir)
        .max_depth(12)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !(e.depth() > 0 && name.starts_with('.'))
        })
        .flatten()
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase())
            .unwrap_or_default();
        if !is_audio(&ext) {
            continue;
        }

        let meta = tags::read(path);
        let stem = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "未知曲目".into());

        let title = if meta.title.is_empty() {
            clean_name(&stem)
        } else {
            meta.title
        };
        let artist = if meta.artist.is_empty() {
            guess_artist(&stem).unwrap_or_else(|| "未知艺人".into())
        } else {
            meta.artist
        };

        let native = NATIVE.contains(&ext.as_str());
        let playable = native || has_ffmpeg || DECODABLE.contains(&ext.as_str());

        tracks.push(Track {
            path: path.to_string_lossy().to_string(),
            title,
            artist,
            album: meta.album,
            duration: meta.duration,
            format: ext.to_uppercase(),
            playable,
            needs_transcode: !native,
            lrc: sidecar_lrc(path),
            size: entry.metadata().map(|m| m.len()).unwrap_or(0),
            bitrate: meta.bitrate,
            sample_rate: meta.sample_rate,
            bit_depth: meta.bit_depth,
        });
    }

    tracks.sort_by(|a, b| natural_cmp(&a.path, &b.path));

    ScanResult {
        dir: dir.to_string_lossy().to_string(),
        tracks,
    }
}

/// "01 - Artist - Title" → "Title"；纯文件名则原样返回
fn clean_name(stem: &str) -> String {
    let s = stem.trim_start_matches(|c: char| c.is_ascii_digit())
        .trim_start_matches(['.', '-', '_', ' ', ')', ']']);
    let s = if s.is_empty() { stem } else { s };
    match s.split_once(" - ") {
        Some((_artist, title)) if !title.trim().is_empty() => title.trim().to_string(),
        _ => s.trim().to_string(),
    }
}

fn guess_artist(stem: &str) -> Option<String> {
    let s = stem.trim_start_matches(|c: char| c.is_ascii_digit())
        .trim_start_matches(['.', '-', '_', ' ', ')', ']']);
    s.split_once(" - ")
        .map(|(a, _)| a.trim().to_string())
        .filter(|a| !a.is_empty())
}

/// 路径里的数字按数值比较，避免 10 排在 2 前面
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let mut ai = a.chars().peekable();
    let mut bi = b.chars().peekable();
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some(ca), Some(cb)) => {
                if ca.is_ascii_digit() && cb.is_ascii_digit() {
                    let mut na = String::new();
                    while let Some(c) = ai.peek().copied().filter(|c| c.is_ascii_digit()) {
                        na.push(c);
                        ai.next();
                    }
                    let mut nb = String::new();
                    while let Some(c) = bi.peek().copied().filter(|c| c.is_ascii_digit()) {
                        nb.push(c);
                        bi.next();
                    }
                    let va: u64 = na.parse().unwrap_or(0);
                    let vb: u64 = nb.parse().unwrap_or(0);
                    if va != vb {
                        return va.cmp(&vb);
                    }
                } else {
                    if ca != cb {
                        return ca.to_ascii_lowercase().cmp(&cb.to_ascii_lowercase());
                    }
                    ai.next();
                    bi.next();
                }
            }
        }
    }
}

pub fn cache_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|_| std::env::var("XDG_CACHE_HOME").map(PathBuf::from))
        .unwrap_or_else(|_| std::env::temp_dir());
    let d = base.join("vinyl-player").join("cache");
    let _ = std::fs::create_dir_all(&d);
    d
}
