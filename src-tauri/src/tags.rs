use std::path::Path;

use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::{Accessor, ItemKey};

#[derive(Default, Clone)]
pub struct Meta {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration: f64,
    /// kbps
    pub bitrate: u32,
    /// Hz
    pub sample_rate: u32,
    /// bit，有损格式通常是 0
    pub bit_depth: u32,
}

fn open(path: &Path) -> Option<lofty::file::TaggedFile> {
    Probe::open(path).ok()?.read().ok()
}

pub fn read(path: &Path) -> Meta {
    let mut m = Meta::default();
    let Some(tagged) = open(path) else { return m };

    let props = tagged.properties();
    m.duration = props.duration().as_secs_f64();
    m.bitrate = props.audio_bitrate().unwrap_or(0);
    m.sample_rate = props.sample_rate().unwrap_or(0);
    m.bit_depth = props.bit_depth().map(|b| b as u32).unwrap_or(0);

    if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
        m.title = tag.title().map(|s| s.trim().to_string()).unwrap_or_default();
        m.artist = tag.artist().map(|s| s.trim().to_string()).unwrap_or_default();
        m.album = tag.album().map(|s| s.trim().to_string()).unwrap_or_default();
    }
    m
}

/// 内嵌封面（取第一张图）
pub fn cover(path: &Path) -> Option<Vec<u8>> {
    let tagged = open(path)?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
    let pic = tag.pictures().first()?;
    let data = pic.data();
    if data.is_empty() || data.len() > 12 * 1024 * 1024 {
        return None;
    }
    Some(data.to_vec())
}

/// 内嵌歌词（ID3 USLT / Vorbis LYRICS）
pub fn embedded_lyrics(path: &Path) -> Option<String> {
    let tagged = open(path)?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
    tag.get_string(&ItemKey::Lyrics).map(|s| s.to_string())
}
