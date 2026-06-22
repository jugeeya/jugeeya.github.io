//! Dump a Rivals II GVAS save (`.sav` or `.r2tag`) to JSON on stdout.
//!
//! Build-time helper only — it has no place in the shipped site. The tags page
//! reads precomputed *digests* (see `scripts/build_tag_settings.py`), which are
//! produced by feeding this tool's output through that script. Uses the same
//! `uesave` crate as the in-browser WASM, so the parse matches exactly.
//!
//! Usage: tagdump <path-to.r2tag>

use std::io::Cursor;
use uesave::Save;

fn main() {
    let path = match std::env::args().nth(1) {
        Some(p) => p,
        None => {
            eprintln!("usage: tagdump <path-to .sav/.r2tag>");
            std::process::exit(2);
        }
    };
    let bytes = std::fs::read(&path).unwrap_or_else(|e| {
        eprintln!("read {path}: {e}");
        std::process::exit(1);
    });
    let save = Save::read(&mut Cursor::new(bytes)).unwrap_or_else(|e| {
        eprintln!("parse {path}: {e}");
        std::process::exit(1);
    });
    println!("{}", serde_json::to_string(&save.root).expect("serialize"));
}
