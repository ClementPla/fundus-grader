use crate::error::Error;
use crate::state::AppState;
use tauri::http::{Request, Response};
use tauri::{Manager, UriSchemeContext, Wry};

fn parse(host: &str, path: &str) -> Option<(i64, String, String)> {
    println!("parsing image uri: host={}, path={}", host, path);
    let combined = format!("{}/{}", host, path);
    let segments: Vec<&str> = combined.split('/').filter(|s| !s.is_empty()).collect();
    let anchor = segments.iter().position(|&s| s == "image")?;
    if segments.len() < anchor + 4 {
        return None;
    }
    let case_id: i64 = segments[anchor + 1].parse().ok()?;
    let view = segments[anchor + 2].to_string();
    let variant = segments[anchor + 3].to_string();
    Some((case_id, view, variant))
}

fn err(status: u16, msg: impl Into<String>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("content-type", "text/plain")
        .body(msg.into().into_bytes())
        .unwrap_or_default()
}

pub fn handle(ctx: UriSchemeContext<'_, Wry>, req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let url = req.uri();
    let host = url.host().unwrap_or("");
    let path = url.path();
    let Some((case_id, view, variant)) = parse(host, path) else {
        return err(400, "bad uri");
    };

    let app = ctx.app_handle();
    let state = app.state::<AppState>();
    let bytes_result: crate::error::Result<Vec<u8>> = state.with(|s| {
        let Some(project) = s.project_db.as_ref() else {
            return Err(Error::NoProject);
        };
        match variant.as_str() {
            "raw" => crate::project_db::get_image(project, case_id, &view),
            "preprocessed" => {
                let raw = crate::project_db::get_image(project, case_id, &view)?;
                crate::preprocessing::illumination_correct(&raw)
            }
            _ => Err(Error::Invalid(format!("variant {}", variant))),
        }
    });

    match bytes_result {
        Ok(bytes) => Response::builder()
            .status(200)
            .header("content-type", "image/png")
            .header("cache-control", "no-store")
            .body(bytes)
            .unwrap_or_default(),
        Err(e) => err(404, e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::parse;

    #[test]
    fn parses_webkit_form() {
        // macOS/Linux: scheme handler receives host="image", path="/12/macula/raw"
        let p = parse("image", "/12/macula/raw").unwrap();
        assert_eq!(p, (12, "macula".into(), "raw".into()));
    }

    #[test]
    fn parses_webview2_form() {
        // Windows: host="fundus.localhost", path="/image/12/macula/preprocessed"
        let p = parse("fundus.localhost", "/image/12/macula/preprocessed").unwrap();
        assert_eq!(p, (12, "macula".into(), "preprocessed".into()));
    }

    #[test]
    fn parses_od_view() {
        let p = parse("image", "/3/od/raw").unwrap();
        assert_eq!(p, (3, "od".into(), "raw".into()));
    }

    #[test]
    fn rejects_missing_fields() {
        assert!(parse("image", "/12/macula").is_none());
        assert!(parse("fundus.localhost", "/image/12").is_none());
    }

    #[test]
    fn rejects_bad_case_id() {
        assert!(parse("image", "/abc/macula/raw").is_none());
    }

    #[test]
    fn rejects_no_anchor() {
        assert!(parse("foo.localhost", "/bar/12/macula/raw").is_none());
    }
}