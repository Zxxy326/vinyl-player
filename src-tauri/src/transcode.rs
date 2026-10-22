use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::scan;
use crate::tags;

/// 缓存上限：超过就按最久未用淘汰
const CACHE_LIMIT: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prep {
    pub path: String,
    pub transcoded: bool,
    pub duration: f64,
    pub error: Option<String>,
}

static FFMPEG: OnceLock<Option<PathBuf>> = OnceLock::new();

fn detect_ffmpeg() -> Option<PathBuf> {
    // 1) 和 exe 放在一起
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in ["ffmpeg.exe", "ffmpeg"] {
                let p = dir.join(name);
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }
    // 2) PATH 里
    let probe = Command::new("ffmpeg")
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    match probe {
        Ok(s) if s.success() => Some(PathBuf::from("ffmpeg")),
        _ => None,
    }
}

pub fn ffmpeg_path() -> Option<PathBuf> {
    FFMPEG.get_or_init(detect_ffmpeg).clone()
}

/// FNV-1a 64：路径 + 修改时间 + 大小，保证同一个文件同一份缓存
fn cache_key(path: &Path) -> String {
    let md = std::fs::metadata(path).ok();
    let size = md.as_ref().map(|m| m.len()).unwrap_or(0);
    let mtime = md
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in path.to_string_lossy().as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    for v in [size, mtime] {
        for b in v.to_le_bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x100_0000_01b3);
        }
    }
    format!("{h:016x}")
}

fn native(ext: &str) -> bool {
    scan::NATIVE.contains(&ext)
}

pub fn prepare(path_str: &str) -> Result<Prep, String> {
    let path = PathBuf::from(path_str);
    if !path.is_file() {
        return Err("文件不存在".into());
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();

    if native(&ext) {
        return Ok(Prep {
            path: path_str.to_string(),
            transcoded: false,
            duration: 0.0,
            error: None,
        });
    }

    let key = cache_key(&path);
    let cache = scan::cache_dir();

    // 已有缓存直接复用
    for cand in ["flac", "wav"] {
        let f = cache.join(format!("{key}.{cand}"));
        if f.is_file() {
            return Ok(Prep {
                path: f.to_string_lossy().to_string(),
                transcoded: true,
                duration: 0.0,
                error: None,
            });
        }
    }

    let out = if ffmpeg_path().is_some() {
        cache.join(format!("{key}.flac"))
    } else if scan::DECODABLE.contains(&ext.as_str()) {
        cache.join(format!("{key}.wav"))
    } else {
        return Err(format!(
            "{} 需要 ffmpeg 才能转码（把 ffmpeg.exe 放到程序目录或加入 PATH）",
            ext.to_uppercase()
        ));
    };

    // 临时文件必须保留真实扩展名：ffmpeg 靠扩展名推断 muxer，写成 ".flac.part" 会直接失败
    let ext = out.extension().and_then(|e| e.to_str()).unwrap_or("tmp");
    let stem = out.file_stem().and_then(|s| s.to_str()).unwrap_or("out");
    let tmp = out.with_file_name(format!("{stem}.part.{ext}"));
    let _ = std::fs::remove_file(&tmp);

    if out.extension().and_then(|e| e.to_str()) == Some("flac") {
        let bin = ffmpeg_path().ok_or("找不到 ffmpeg")?;
        ffmpeg_to_flac(&bin, &path, &tmp)?;
    } else {
        decode_to_wav(&path, &tmp)?;
    }

    std::fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
    evict(&cache, CACHE_LIMIT);

    // 转码产物读一遍时长，免得前端曲库列表里这首歌显示成 0:00
    let duration = tags::read(&out).duration;

    Ok(Prep {
        path: out.to_string_lossy().to_string(),
        transcoded: true,
        duration,
        error: None,
    })
}

fn ffmpeg_to_flac(bin: &Path, src: &Path, dst: &Path) -> Result<(), String> {
    let out = Command::new(bin)
        .args(["-v", "error", "-y", "-i"])
        .arg(src)
        .args(["-vn", "-c:a", "flac", "-compression_level", "5"])
        .args(["-f", "flac"])
        .arg(dst)
        .output()
        .map_err(|e| format!("调用 ffmpeg 失败: {e}"))?;

    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if msg.is_empty() {
            "ffmpeg 转码失败".into()
        } else {
            msg
        });
    }
    Ok(())
}

fn decode_to_wav(src: &Path, dst: &Path) -> Result<(), String> {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let file = std::fs::File::open(src).map_err(|e| e.to_string())?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = src.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("无法识别格式: {e}"))?;

    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or("没有可解码的音轨")?
        .clone();

    let track_id = track.id;
    let sample_rate = track.codec_params.sample_rate.unwrap_or(44100);
    let channels = track
        .codec_params
        .channels
        .map(|c| c.count())
        .unwrap_or(2)
        .max(1);

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("没有对应解码器: {e}"))?;

    let spec = hound::WavSpec {
        channels: channels as u16,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(dst, spec).map_err(|e| e.to_string())?;

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(_) => break,
        };
        if packet.track_id() != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(decoded) => {
                let dspec = *decoded.spec();
                let cap = decoded.capacity() as u64;
                let mut sbuf = SampleBuffer::<i16>::new(cap, dspec);
                sbuf.copy_interleaved_ref(decoded);
                for s in sbuf.samples() {
                    writer.write_sample(*s).map_err(|e| e.to_string())?;
                }
            }
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
            Err(_) => break,
        }
    }

    writer.finalize().map_err(|e| e.to_string())?;
    Ok(())
}

/// 缓存超过上限时，删掉最久没被访问的文件
fn evict(dir: &Path, limit: u64) {
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = Vec::new();
    let mut total = 0u64;

    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if let Ok(md) = e.metadata() {
                if md.is_file() {
                    total += md.len();
                    let at = md
                        .accessed()
                        .or_else(|_| md.modified())
                        .unwrap_or(std::time::UNIX_EPOCH);
                    files.push((at, md.len(), p));
                }
            }
        }
    }
    if total <= limit {
        return;
    }
    files.sort_by_key(|f| f.0);
    for (_, size, p) in files {
        if total <= limit {
            break;
        }
        if std::fs::remove_file(&p).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}
