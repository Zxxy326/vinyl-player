// Windows 下不弹控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::Path;

/// 命令行自检（release 版没有控制台，结果写文件）：
///   vinyl-player.exe --scan <目录> --out scan.json
///   vinyl-player.exe --prepare <文件> --out prep.json
fn cli() -> bool {
    let args: Vec<String> = std::env::args().collect();
    let out = args
        .iter()
        .position(|a| a == "--out")
        .and_then(|i| args.get(i + 1))
        .cloned();

    if let Some(i) = args.iter().position(|a| a == "--scan") {
        let Some(dir) = args.get(i + 1) else { return false };
        let res = vinyl_player_lib::scan::scan(Path::new(dir));
        let json = serde_json::to_string_pretty(&res).unwrap_or_default();
        match out {
            Some(p) => {
                let _ = std::fs::write(p, json);
            }
            None => println!("{json}"),
        }
        return true;
    }

    if let Some(i) = args.iter().position(|a| a == "--prepare") {
        let Some(file) = args.get(i + 1) else { return false };
        let json = match vinyl_player_lib::transcode::prepare(file) {
            Ok(p) => serde_json::to_string_pretty(&p).unwrap_or_default(),
            Err(e) => format!("{{\"error\":{}}}", serde_json::to_string(&e).unwrap_or_default()),
        };
        match out {
            Some(p) => {
                let _ = std::fs::write(p, json);
            }
            None => println!("{json}"),
        }
        return true;
    }

    false
}

fn main() {
    if cli() {
        return;
    }
    // release 版没有控制台，panic 信息会直接丢掉。写一份到临时目录，出问题好查。
    std::panic::set_hook(Box::new(|info| {
        use std::io::Write;
        let path = std::env::temp_dir().join("vinyl-player-panic.log");
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(f, "{info}");
        }
    }));
    vinyl_player_lib::run()
}
