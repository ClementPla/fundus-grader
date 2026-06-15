use crate::error::{Error, Result};
use rusqlite::{params, Connection, OpenFlags};
use serde::Serialize;
use std::path::Path;

pub fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('meta','cases','images','classes','masks')",
        [],
        |r| r.get(0),
    )?;
    if n < 5 {
        return Err(Error::Invalid(format!(
            "project file at {} is missing required tables (found {}/5)",
            path.display(),
            n
        )));
    }
    Ok(conn)
}

#[derive(Debug, Clone, Serialize)]
pub struct CaseRef {
    pub id: i64,
    pub has_od: bool,
    pub is_calibration: bool,
    pub ref_icdr: i64,
    pub ref_dme: i64,
    pub ai_icdr: Option<i64>,
    pub ai_dme: Option<i64>,
}

pub fn list_cases(conn: &Connection) -> Result<Vec<CaseRef>> {
    let mut stmt = conn.prepare(
        "SELECT id, has_od, is_calibration, ref_icdr, ref_dme, ai_icdr, ai_dme FROM cases ORDER BY id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(CaseRef {
            id: r.get(0)?,
            has_od: r.get::<_, i64>(1)? != 0,
            is_calibration: r.get::<_, i64>(2)? != 0,
            ref_icdr: r.get(3)?,
            ref_dme: r.get(4)?,
            ai_icdr: r.get(5)?,
            ai_dme: r.get(6)?,
        })
    })?;
    let mut v = Vec::new();
    for row in rows {
        v.push(row?);
    }
    Ok(v)
}

pub fn get_case(conn: &Connection, case_id: i64) -> Result<CaseRef> {
    let mut stmt = conn.prepare(
        "SELECT id, has_od, is_calibration, ref_icdr, ref_dme, ai_icdr, ai_dme FROM cases WHERE id = ?1",
    )?;
    let case = stmt
        .query_row(params![case_id], |r| {
            Ok(CaseRef {
                id: r.get(0)?,
                has_od: r.get::<_, i64>(1)? != 0,
                is_calibration: r.get::<_, i64>(2)? != 0,
                ref_icdr: r.get(3)?,
                ref_dme: r.get(4)?,
                ai_icdr: r.get(5)?,
                ai_dme: r.get(6)?,
            })
        })
        .map_err(|_| Error::NotFound(format!("case {}", case_id)))?;
    Ok(case)
}

pub fn get_image(conn: &Connection, case_id: i64, view: &str) -> Result<Vec<u8>> {
    let bytes: Vec<u8> = conn
        .query_row(
            "SELECT png FROM images WHERE case_id = ?1 AND view = ?2",
            params![case_id, view],
            |r| r.get(0),
        )
        .map_err(|_| Error::NotFound(format!("image case={} view={}", case_id, view)))?;
    Ok(bytes)
}

#[derive(Debug, Clone, Serialize)]
pub struct ImageDims {
    pub width: i64,
    pub height: i64,
}

pub fn get_image_dims(conn: &Connection, case_id: i64, view: &str) -> Result<ImageDims> {
    let (w, h): (i64, i64) = conn
        .query_row(
            "SELECT width, height FROM images WHERE case_id = ?1 AND view = ?2",
            params![case_id, view],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| Error::NotFound(format!("image dims case={} view={}", case_id, view)))?;
    Ok(ImageDims { width: w, height: h })
}

#[derive(Debug, Clone, Serialize)]
pub struct MaskContour {
    pub class_id: i64,
    pub contours_json: String,
}

pub fn list_mask_contours(conn: &Connection, case_id: i64, view: &str) -> Result<Vec<MaskContour>> {
    let mut stmt = conn.prepare(
        "SELECT class_id, contours_json FROM masks WHERE case_id = ?1 AND view = ?2 ORDER BY class_id",
    )?;
    let rows = stmt.query_map(params![case_id, view], |r| {
        Ok(MaskContour {
            class_id: r.get(0)?,
            contours_json: r.get(1)?,
        })
    })?;
    let mut v = Vec::new();
    for row in rows {
        v.push(row?);
    }
    Ok(v)
}

#[derive(Debug, Clone, Serialize)]
pub struct ClassInfo {
    pub class_id: i64,
    pub name: String,
    pub default_style: serde_json::Value,
}

pub fn list_classes(conn: &Connection) -> Result<Vec<ClassInfo>> {
    let mut stmt = conn.prepare("SELECT class_id, name, default_style_json FROM classes ORDER BY class_id")?;
    let rows = stmt.query_map([], |r| {
        let class_id: i64 = r.get(0)?;
        let name: String = r.get(1)?;
        let style_str: String = r.get(2)?;
        Ok((class_id, name, style_str))
    })?;
    let mut v = Vec::new();
    for row in rows {
        let (class_id, name, style_str) = row?;
        let default_style: serde_json::Value = serde_json::from_str(&style_str)?;
        v.push(ClassInfo {
            class_id,
            name,
            default_style,
        });
    }
    Ok(v)
}

pub fn meta_get(conn: &Connection, key: &str) -> Result<Option<String>> {
    let mut stmt = conn.prepare("SELECT value FROM meta WHERE key = ?1")?;
    let mut rows = stmt.query(params![key])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}
