//! UPC lookup through Rust so the webview never fights CORS. Uses the
//! upcitemdb trial endpoint (keyless, ~100 requests/day) and hands the raw
//! JSON to the frontend, which shares its parsing with the PWA code path.

use std::time::Duration;

pub fn lookup_upc(code: &str) -> Result<serde_json::Value, String> {
    if !code.chars().all(|c| c.is_ascii_digit()) || code.len() < 8 || code.len() > 14 {
        return Err("that doesn't look like a UPC/EAN barcode".into());
    }
    let url = format!("https://api.upcitemdb.com/prod/trial/lookup?upc={code}");
    let response = ureq::get(&url)
        .timeout(Duration::from_secs(10))
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(429, _) => "barcode service rate limit hit — try again later".into(),
            other => format!("barcode lookup failed: {other}"),
        })?;
    response
        .into_json()
        .map_err(|e| format!("barcode lookup returned bad JSON: {e}"))
}
