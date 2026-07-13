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

/// Overwrite a tag's `TagName` property in place — used to disambiguate two
/// installed tags that happen to share a name (see `ImportItem::rename`).
fn set_tag_name(sv: &mut StructValue, new_name: &str) {
    if let StructValue::Struct(props) = sv {
        props
            .0
            .insert(PropertyKey::from("TagName"), Property::Str(new_name.to_string()));
    }
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
    // serialize_maps_as_objects: emit plain objects (not JS Maps) so the tree
    //   matches the serde_json-shaped baseline the page diffs against.
    // serialize_large_number_types_as_bigints: i64 fields (e.g. LastUsed =
    //   FDateTime ticks) overflow a JS number; as BigInt they sit untouched in
    //   the tree (the digest extractor only reads enums/bools/f32s).
    let ser = serde_wasm_bindgen::Serializer::new()
        .serialize_maps_as_objects(true)
        .serialize_large_number_types_as_bigints(true);
    save.root.serialize(&ser).map_err(|e| JsError::new(&e.to_string()))
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
    /// Optional replacement for this tag's in-save name. Lets the caller
    /// disambiguate two tags being installed together that happen to share a
    /// name (e.g. rename each to its linked start.gg handle) so both land in
    /// the save instead of one silently overwriting the other.
    #[serde(default)]
    rename: Option<String>,
}

#[derive(Serialize)]
struct ImportReport {
    #[serde(with = "serde_bytes")]
    sav: Vec<u8>,
    imported: Vec<String>,
    skipped: Vec<String>,
    incompatible: Vec<String>,
}

/// Merge tags from `.r2tag` byte buffers into `sav`, honoring per-item overwrite
/// and optional rename, and return the new save bytes plus what happened to
/// each tag. Cross-version tags are rejected as incompatible (same rule as the
/// desktop tool).
///
/// Result order: the save's first tag (typically the setup's own) always
/// stays in slot 0 — a same-named import still overwrites its content (subject
/// to `overwrite`, like any other existing tag), it just never gets displaced
/// from the front. Installed tags land directly after it; every other tag
/// already in the save follows, in its original relative order.
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

        // Pull the first tag out on its own: it always ends up back in slot 0
        // at the end, whether or not it gets overwritten along the way.
        let mut first: Option<StructValue> = if dest_structs.is_empty() {
            None
        } else {
            Some(dest_structs.remove(0))
        };
        let protected_name = first.as_ref().and_then(tag_name_of).map(str::to_string);
        let mut tail: Vec<StructValue> = std::mem::take(dest_structs);
        let mut installed: Vec<StructValue> = Vec::new();

        for item in items {
            let src = read_save(&item.bytes)?;
            for (path, tag) in src.schemas.schemas() {
                merged_schemas.push((path.clone(), tag.clone()));
            }
            let src_version = save_version_of(&src);
            let src_structs = tags_array(&src)?;
            let (tag_sv, orig_name) = match src_structs
                .iter()
                .find_map(|sv| tag_name_of(sv).map(|n| (sv, n.to_string())))
            {
                Some(x) => x,
                None => return Err(JsError::new("a downloaded tag file has no tag")),
            };

            // Reject cross-version tags — writing them would corrupt the save.
            if src_version.is_none() || src_version != dest_version {
                incompatible.push(orig_name);
                continue;
            }

            // A caller-supplied rename (e.g. to disambiguate two tags being
            // installed together under the same name) is baked into the
            // clone's TagName up front, so every lookup below sees the final
            // name this tag will be stored under.
            let mut tag_sv = tag_sv.clone();
            let name = match &item.rename {
                Some(new_name) if new_name != &orig_name => {
                    set_tag_name(&mut tag_sv, new_name);
                    new_name.clone()
                }
                _ => orig_name,
            };

            // The first tag can still be overwritten by a same-named import,
            // but it never leaves slot 0 — the replacement takes its place
            // there instead of moving into the installed block.
            if protected_name.as_deref() == Some(name.as_str()) {
                if item.overwrite {
                    first = Some(tag_sv);
                    imported.push(name);
                } else {
                    skipped.push(name);
                }
                continue;
            }

            // A name can collide with something already placed in this batch
            // (two installed tags sharing a name — the save can only hold one
            // per name) or with a tag further back in the save. Either way,
            // "overwrite" governs whether the newer one wins; when it does,
            // the surviving copy ends up in the installed block, not the tail.
            let in_batch = installed
                .iter()
                .position(|sv| tag_name_of(sv) == Some(name.as_str()));
            let in_tail = tail
                .iter()
                .position(|sv| tag_name_of(sv) == Some(name.as_str()));

            if in_batch.is_some() || in_tail.is_some() {
                if !item.overwrite {
                    skipped.push(name);
                    continue;
                }
                match in_batch {
                    Some(pos) => installed[pos] = tag_sv,
                    None => {
                        tail.remove(in_tail.unwrap());
                        installed.push(tag_sv);
                    }
                }
            } else {
                installed.push(tag_sv);
            }
            imported.push(name);
        }

        if let Some(f) = first.take() {
            dest_structs.push(f);
        }
        dest_structs.append(&mut installed);
        dest_structs.append(&mut tail);
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
