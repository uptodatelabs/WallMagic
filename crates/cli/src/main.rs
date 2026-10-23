use std::path::PathBuf;
use std::process::ExitCode;
use wallmagic_core::{
    generate_sample_wallpaper, get_current_wallpaper, restore_wallpaper, set_wallpaper,
    WallpaperPosition, VERSION,
};

fn print_help() {
    println!(
        "WallMagic CLI v{VERSION} — Windows Wallpaper Engine Prototype

USAGE:
    wallmagic-cli <SUBCOMMAND> [OPTIONS]

SUBCOMMANDS:
    get                         Query current desktop wallpaper path
    set <PATH> [--pos <STYLE>]  Validate, stage, and set wallpaper from image path
    generate <PROMPT> [--apply] Generate 1920x1080 wallpaper from prompt (and optionally apply)
    restore                     Restore previously snapshotted wallpaper
    -h, --help                  Print this help message
    -V, --version               Print version"
    );
}

fn parse_position(s: &str) -> Result<WallpaperPosition, String> {
    match s.to_ascii_lowercase().as_str() {
        "center" => Ok(WallpaperPosition::Center),
        "tile" => Ok(WallpaperPosition::Tile),
        "stretch" => Ok(WallpaperPosition::Stretch),
        "fit" => Ok(WallpaperPosition::Fit),
        "fill" => Ok(WallpaperPosition::Fill),
        "span" => Ok(WallpaperPosition::Span),
        other => Err(format!(
            "unknown position style '{other}' (expected: center|tile|stretch|fit|fill|span)"
        )),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();

    if args.is_empty() {
        print_help();
        return ExitCode::SUCCESS;
    }

    match args[0].as_str() {
        "-h" | "--help" | "help" => {
            print_help();
            ExitCode::SUCCESS
        }
        "-V" | "--version" | "version" => {
            println!("wallmagic-cli {VERSION}");
            ExitCode::SUCCESS
        }
        "get" => {
            if args.len() > 1 {
                eprintln!("error: unexpected argument '{}' for 'get'", args[1]);
                return ExitCode::FAILURE;
            }
            match get_current_wallpaper(None) {
                Ok(path) => {
                    println!("{path}");
                    ExitCode::SUCCESS
                }
                Err(err) => {
                    eprintln!("error: failed to get current wallpaper: {err}");
                    ExitCode::FAILURE
                }
            }
        }
        "set" => {
            if args.len() < 2 {
                eprintln!("error: 'set' requires an image <PATH> argument");
                print_help();
                return ExitCode::FAILURE;
            }
            let image_path = PathBuf::from(&args[1]);
            let mut position = WallpaperPosition::Fill;
            let mut i = 2;
            while i < args.len() {
                match args[i].as_str() {
                    "--pos" | "--position" => {
                        if i + 1 >= args.len() {
                            eprintln!("error: '{}' requires a value", args[i]);
                            return ExitCode::FAILURE;
                        }
                        match parse_position(&args[i + 1]) {
                            Ok(pos) => position = pos,
                            Err(msg) => {
                                eprintln!("error: {msg}");
                                return ExitCode::FAILURE;
                            }
                        }
                        i += 2;
                    }
                    unknown => {
                        eprintln!("error: unknown option '{unknown}' for 'set'");
                        return ExitCode::FAILURE;
                    }
                }
            }

            match set_wallpaper(&image_path, None, position) {
                Ok(state) => {
                    println!(
                        "OK: applied wallpaper '{}' via {}",
                        state.current_wallpaper.unwrap_or_default(),
                        state.backend_used.unwrap_or_default()
                    );
                    ExitCode::SUCCESS
                }
                Err(err) => {
                    eprintln!("error: failed to set wallpaper: {err}");
                    ExitCode::FAILURE
                }
            }
        }
        "generate" => {
            if args.len() < 2 {
                eprintln!("error: 'generate' requires a <PROMPT> argument");
                print_help();
                return ExitCode::FAILURE;
            }
            let prompt = &args[1];
            let mut apply = false;
            let mut out_path = wallmagic_core::app_data_dir().join("generated_prompt.bmp");

            let mut i = 2;
            while i < args.len() {
                match args[i].as_str() {
                    "--apply" => {
                        apply = true;
                        i += 1;
                    }
                    "--out" | "-o" => {
                        if i + 1 >= args.len() {
                            eprintln!("error: '{}' requires a path", args[i]);
                            return ExitCode::FAILURE;
                        }
                        out_path = PathBuf::from(&args[i + 1]);
                        i += 2;
                    }
                    unknown => {
                        eprintln!("error: unknown option '{unknown}' for 'generate'");
                        return ExitCode::FAILURE;
                    }
                }
            }

            match generate_sample_wallpaper(prompt, &out_path) {
                Ok(generated) => {
                    println!("OK: generated '{}'", generated.display());
                    if apply {
                        match set_wallpaper(&generated, None, WallpaperPosition::Fill) {
                            Ok(state) => {
                                println!(
                                    "OK: applied wallpaper '{}' via {}",
                                    state.current_wallpaper.unwrap_or_default(),
                                    state.backend_used.unwrap_or_default()
                                );
                                ExitCode::SUCCESS
                            }
                            Err(err) => {
                                eprintln!("error: failed to apply generated wallpaper: {err}");
                                ExitCode::FAILURE
                            }
                        }
                    } else {
                        ExitCode::SUCCESS
                    }
                }
                Err(err) => {
                    eprintln!("error: failed to generate wallpaper: {err}");
                    ExitCode::FAILURE
                }
            }
        }
        "restore" => {
            if args.len() > 1 {
                eprintln!("error: unexpected argument '{}' for 'restore'", args[1]);
                return ExitCode::FAILURE;
            }
            match restore_wallpaper(None) {
                Ok(state) => {
                    println!(
                        "OK: restored wallpaper '{}' via {}",
                        state.current_wallpaper.unwrap_or_default(),
                        state.backend_used.unwrap_or_default()
                    );
                    ExitCode::SUCCESS
                }
                Err(err) => {
                    eprintln!("error: failed to restore wallpaper: {err}");
                    ExitCode::FAILURE
                }
            }
        }
        unknown => {
            eprintln!("error: unknown subcommand or option '{unknown}'");
            print_help();
            ExitCode::FAILURE
        }
    }
}
