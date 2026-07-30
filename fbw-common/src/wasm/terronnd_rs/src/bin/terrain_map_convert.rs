//! Build-time CLI converting the SimBridge `terrain.map` (v1) into the
//! gauge-native `terrain2.map` (flat directory + grid-sorted payloads; a
//! pure repack, every payload is copied verbatim).
//!
//! Usage:
//!   terrain_map_convert <terrain.map> <terrain2.map>   convert (temp+rename)
//!   terrain_map_convert --check <terrain2.map>         validate, exit 0/1

#[cfg(not(target_arch = "wasm32"))]
fn main() -> std::process::ExitCode {
    use std::io::{BufWriter, Write};
    use std::process::ExitCode;

    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("--check") if args.len() == 3 => {
            if terronnd::convert::check_v2(&args[2]) {
                ExitCode::SUCCESS
            } else {
                eprintln!("{}: not a valid terrain2.map", args[2]);
                ExitCode::FAILURE
            }
        }
        Some(v1_path) if args.len() == 3 && !v1_path.starts_with('-') => {
            let v2_path = &args[2];
            let started = std::time::Instant::now();

            let v1 = match terronnd::fileformat::TerrainMap::open(v1_path) {
                Ok(v1) => v1,
                Err(e) => {
                    eprintln!("failed to open {v1_path}: {e}");
                    return ExitCode::FAILURE;
                }
            };
            println!(
                "converting {v1_path} ({} tiles) -> {v2_path}",
                v1.tiles.len()
            );

            let part_path = format!("{v2_path}.part");
            let result = (|| -> std::io::Result<()> {
                let file = std::fs::File::create(&part_path)?;
                let mut out = BufWriter::with_capacity(1 << 20, file);
                let mut last_percent = 0;
                terronnd::convert::convert_v1_to_v2(&v1, &mut out, |done, total| {
                    let percent = done * 100 / total;
                    if percent >= last_percent + 10 {
                        last_percent = percent;
                        println!("  {percent}% ({done}/{total} tiles)");
                        let _ = std::io::stdout().flush();
                    }
                })?;
                out.into_inner().map_err(|e| e.into_error())?.sync_all()?;
                Ok(())
            })();

            if let Err(e) = result {
                eprintln!("conversion failed: {e}");
                let _ = std::fs::remove_file(&part_path);
                return ExitCode::FAILURE;
            }
            if std::fs::exists(v2_path).unwrap_or(false) {
                if let Err(e) = std::fs::remove_file(v2_path) {
                    eprintln!("failed to replace {v2_path}: {e}");
                    return ExitCode::FAILURE;
                }
            }
            if let Err(e) = std::fs::rename(&part_path, v2_path) {
                eprintln!("failed to move {part_path} into place: {e}");
                return ExitCode::FAILURE;
            }

            let size = std::fs::metadata(v2_path).map(|m| m.len()).unwrap_or(0);
            println!(
                "wrote {v2_path}: {:.1} MB in {:.0} s",
                size as f64 / 1e6,
                started.elapsed().as_secs_f64()
            );
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("usage: terrain_map_convert <terrain.map> <terrain2.map>");
            eprintln!("       terrain_map_convert --check <terrain2.map>");
            ExitCode::from(2)
        }
    }
}

/// The converter is host tooling; a wasm build of the bin target is a no-op.
#[cfg(target_arch = "wasm32")]
fn main() {}
