//! In-browser Rivals II tag operations, compiled to WebAssembly.
//!
//! These mirror the desktop tool's save handling (same `uesave` crate) but work
//! on byte buffers instead of files, so the website can read a `.sav`, split out
//! individual `.r2tag` tags, and merge tags back into a save — all client-side.

use serde::{Deserialize, Serialize};
use std::io::Cursor;
use uesave::{Property, PropertyKey, Save, StructValue, ValueVec};
use wasm_bindgen::prelude::*;

const DEFAULT_TAG_NAMES: [&str; 4] = ["Player1", "Player2", "Player3", "Player4"];

fn is_custom_tag(name: &str) -> bool {
    !DEFAULT_TAG_NAMES.contains(&name)
}

fn read_save(bytes: &[u8]) -> Result<Save, JsError> {
    Save::read(&mut Cursor::new(bytes)).map_err(|e| JsError::new(&e.to_string()))
}

fn tag_name_of(sv: &StructValue) -> Option<&str> {
    if let StructValue::Struct(props) = sv {
        if let Some(Property::Str(name)) = props.0.get(&PropertyKey::from("TagName")) {
            return Some(name.as_str());
        }
    }
    None
}

fn save_version_of(save: &Save) -> Option<i32> {
    match save.root.properties.0.get(&PropertyKey::from("SaveVersion")) {
        Some(Property::Int(v)) => Some(*v),
        _ => None,
    }
}

fn tags_array<'a>(save: &'a Save) -> Result<&'a Vec<StructValue>, JsError> {
    match save.root.properties.0.get(&PropertyKey::from("SavedPlayerTags")) {
        Some(Property::Array(ValueVec::Struct(s))) => Ok(s),
        Some(_) => Err(JsError::new("SavedPlayerTags is not a struct array")),
        None => Err(JsError::new("save has no SavedPlayerTags")),
    }
}

fn tags_array_mut<'a>(save: &'a mut Save) -> Result<&'a mut Vec<StructValue>, JsError> {
    match save.root.properties.0.get_mut(&PropertyKey::from("SavedPlayerTags")) {
        Some(Property::Array(ValueVec::Struct(s))) => Ok(s),
        Some(_) => Err(JsError::new("SavedPlayerTags is not a struct array")),
        None => Err(JsError::new("save has no SavedPlayerTags")),
    }
}

fn write_save(save: &Save) -> Result<Vec<u8>, JsError> {
    let mut buf = Vec::new();
    save.write(&mut buf).map_err(|e| JsError::new(&e.to_string()))?;
    Ok(buf)
}

/// List the custom tag names in a `.sav` (the built-in Player1–Player4 are skipped).
#[wasm_bindgen]
pub fn get_tag_names(sav: &[u8]) -> Result<Vec<String>, JsError> {
    let save = read_save(sav)?;
    Ok(tags_array(&save)?
        .iter()
        .filter_map(tag_name_of)
        .filter(|n| is_custom_tag(n))
        .map(|s| s.to_string())
        .collect())
}

/// The save-format version of a `.sav` or `.r2tag`, or `null` if absent.
#[wasm_bindgen]
pub fn save_version(bytes: &[u8]) -> Result<Option<i32>, JsError> {
    Ok(save_version_of(&read_save(bytes)?))
}

/// The tag name stored inside a `.r2tag`.
#[wasm_bindgen]
pub fn tag_name_in(r2tag: &[u8]) -> Result<String, JsError> {
    let save = read_save(r2tag)?;
    tags_array(&save)?
        .iter()
        .find_map(tag_name_of)
        .map(|s| s.to_string())
        .ok_or_else(|| JsError::new("no tag name found in file"))
}

/// The full parsed save tree as a JS object (the `root` properties). The page
/// uses this to read a tag's control settings/bindings and diff them against the
/// default. Reuses the same `serde` serialization as the desktop JSON export.
#[wasm_bindgen]
pub fn tag_json(bytes: &[u8]) -> Result<JsValue, JsError> {
    let save = read_save(bytes)?;
    serde_wasm_bindgen::to_value(&save.root).map_err(|e| JsError::new(&e.to_string()))
}

/// Produce a one-tag `.r2tag` (the full save with only `tag_name` retained).
#[wasm_bindgen]
pub fn export_tag(sav: &[u8], tag_name: &str) -> Result<Vec<u8>, JsError> {
    let mut save = read_save(sav)?;
    tags_array_mut(&mut save)?.retain(|sv| tag_name_of(sv) == Some(tag_name));
    write_save(&save)
}

#[derive(Deserialize)]
struct ImportItem {
    #[serde(with = "serde_bytes")]
    bytes: Vec<u8>,
    overwrite: bool,
}

#[derive(Serialize)]
struct ImportReport {
    #[serde(with = "serde_bytes")]
    sav: Vec<u8>,
    imported: Vec<String>,
    skipped: Vec<String>,
    incompatible: Vec<String>,
}

/// Merge tags from `.r2tag` byte buffers into `sav`, honoring per-item overwrite,
/// and return the new save bytes plus what happened to each tag. Cross-version
/// tags are rejected as incompatible (same rule as the desktop tool).
#[wasm_bindgen]
pub fn import_tags(sav: &[u8], items: JsValue) -> Result<JsValue, JsError> {
    let items: Vec<ImportItem> =
        serde_wasm_bindgen::from_value(items).map_err(|e| JsError::new(&e.to_string()))?;

    let mut dest = read_save(sav)?;
    let dest_version = save_version_of(&dest);

    let mut imported = Vec::new();
    let mut skipped = Vec::new();
    let mut incompatible = Vec::new();

    // Writing the merged save needs a property schema for every path it
    // contains. An imported tag can have paths the destination never populated
    // (so the destination's read didn't record their schemas), e.g. custom
    // gamepad action mappings. Schemas are keyed by property name path (no array
    // indices), so copying each source's schemas into the destination makes the
    // write self-describing.
    let mut merged_schemas: Vec<(String, _)> = Vec::new();

    {
        let dest_structs = tags_array_mut(&mut dest)?;
        for item in items {
            let src = read_save(&item.bytes)?;
            for (path, tag) in src.schemas.schemas() {
                merged_schemas.push((path.clone(), tag.clone()));
            }
            let src_version = save_version_of(&src);
            let src_structs = tags_array(&src)?;
            let (tag_sv, name) = match src_structs
                .iter()
                .find_map(|sv| tag_name_of(sv).map(|n| (sv, n.to_string())))
            {
                Some(x) => x,
                None => return Err(JsError::new("a downloaded tag file has no tag")),
            };

            // Reject cross-version tags — writing them would corrupt the save.
            if src_version.is_none() || src_version != dest_version {
                incompatible.push(name);
                continue;
            }

            let existing = dest_structs
                .iter()
                .position(|sv| tag_name_of(sv) == Some(name.as_str()));
            if existing.is_some() && !item.overwrite {
                skipped.push(name);
                continue;
            }

            let cloned = tag_sv.clone();
            match existing {
                Some(pos) => dest_structs[pos] = cloned,
                None => dest_structs.push(cloned),
            }
            imported.push(name);
        }
    }

    for (path, tag) in merged_schemas {
        dest.schemas.record(path, tag);
    }

    let report = ImportReport {
        sav: write_save(&dest)?,
        imported,
        skipped,
        incompatible,
    };
    serde_wasm_bindgen::to_value(&report).map_err(|e| JsError::new(&e.to_string()))
}
