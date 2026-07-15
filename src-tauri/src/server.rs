//! LAN scan server: lets an iPhone feed barcodes to the desktop app.
//!
//! iOS Safari can't do barcode lookups (CORS) and its camera decoding is
//! unreliable, but the built-in Shortcuts app has a native barcode scanner
//! and can GET any LAN URL. So the desktop listens on a port; a one-time
//! Shortcut does scan → GET /scan?code=…&token=… → we look the title up
//! (no CORS on this side), insert into SQLite, tell the UI, and answer in
//! plain text for the Shortcut to show as a notification.

use std::net::UdpSocket;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection};
use tauri::{AppHandle, Emitter};

use crate::{db, lookup};

pub const PORT: u16 = 7788;

/// Random hex token, created once and kept in settings. Guards the endpoint
/// so only devices that saw the setup panel can write to the shelf.
pub fn ensure_token(conn: &Connection) -> rusqlite::Result<String> {
    if let Some(token) = db::get_setting(conn, "scan_token")? {
        return Ok(token);
    }
    let token: String =
        conn.query_row("SELECT lower(hex(randomblob(8)))", [], |row| row.get(0))?;
    db::set_setting(conn, "scan_token", &token)?;
    Ok(token)
}

/// Best-effort LAN IP: a UDP "connect" (no packets sent) makes the OS pick
/// the outbound interface. Falls back to localhost if there's no network.
pub fn lan_ip() -> String {
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            s.connect("192.168.255.255:80")?;
            Ok(s.local_addr()?.ip().to_string())
        })
        .unwrap_or_else(|_| "127.0.0.1".into())
}

pub fn spawn(app: AppHandle, conn: Arc<Mutex<Connection>>, token: String) {
    std::thread::spawn(move || {
        let server = match tiny_http::Server::http(("0.0.0.0", PORT)) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("shelf: scan server failed to bind port {PORT}: {e}");
                return;
            }
        };
        for request in server.incoming_requests() {
            let reply = handle(&app, &conn, &token, request.url());
            let (status, body) = match reply {
                Ok(body) => (200, body),
                Err((status, body)) => (status, body),
            };
            let response = tiny_http::Response::from_string(body)
                .with_status_code(status)
                .with_header(
                    tiny_http::Header::from_bytes("Content-Type", "text/plain; charset=utf-8")
                        .unwrap(),
                );
            let _ = request.respond(response);
        }
    });
}

fn handle(
    app: &AppHandle,
    conn: &Arc<Mutex<Connection>>,
    token: &str,
    url: &str,
) -> Result<String, (u16, String)> {
    let (path, query) = url.split_once('?').unwrap_or((url, ""));
    if path == "/" {
        return Ok("shelf is listening. scan endpoint: /scan?code=BARCODE&token=TOKEN".into());
    }
    if path != "/scan" {
        return Err((404, "not found".into()));
    }

    let mut code = None;
    let mut got_token = None;
    for pair in query.split('&') {
        match pair.split_once('=') {
            Some(("code", v)) => code = Some(v.trim().to_string()),
            Some(("token", v)) => got_token = Some(v.to_string()),
            _ => {}
        }
    }
    if got_token.as_deref() != Some(token) {
        return Err((403, "bad token — re-check the URL in your shortcut".into()));
    }
    let code = code.filter(|c| !c.is_empty()).ok_or((
        400,
        "no barcode — the shortcut should send ?code=<scanned barcode>".into(),
    ))?;
    if !code.chars().all(|c| c.is_ascii_digit()) || code.len() < 8 || code.len() > 14 {
        return Err((400, format!("'{code}' doesn't look like a UPC/EAN barcode")));
    }

    // already on the shelf? (leading zeros stripped, same as the JS side)
    let owned = find_by_barcode(conn, &code).map_err(internal)?;
    if let Some(m) = owned {
        let year = m.year.map(|y| format!(" ({y})")).unwrap_or_default();
        return Ok(format!("you already have: {}{} [{}]", m.title, year, m.format));
    }

    // new disc: look the title up (may fail — still add a placeholder so a
    // batch scanning session never silently drops a disc)
    let looked_up = lookup::lookup_upc(&code).ok().and_then(|v| {
        v["items"][0]["title"].as_str().map(str::to_string)
    });

    let (title, format, note) = match looked_up {
        Some(raw) => {
            let format = guess_format(&raw).unwrap_or("Blu-ray").to_string();
            (clean_title(&raw), format, None)
        }
        None => (
            format!("unknown ({code})"),
            "Blu-ray".to_string(),
            Some(" — couldn't identify, fix the title on the desktop"),
        ),
    };

    let movie = {
        let conn = conn.lock().unwrap();
        let added_at: String = conn
            .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |r| r.get(0))
            .map_err(internal)?;
        db::add(
            &conn,
            db::Movie {
                id: None,
                title,
                year: None,
                format,
                barcode: Some(code),
                poster: None,
                director: None,
                runtime: None,
                genres: None,
                overview: None,
                notes: String::new(),
                watched: false,
                added_at,
            },
        )
        .map_err(internal)?
    };

    let _ = app.emit("phone-scan", &movie);
    Ok(format!(
        "added: {} [{}]{}",
        movie.title,
        movie.format,
        note.unwrap_or("")
    ))
}

fn find_by_barcode(
    conn: &Arc<Mutex<Connection>>,
    code: &str,
) -> rusqlite::Result<Option<db::Movie>> {
    let normalized = code.trim_start_matches('0');
    let conn = conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, title, year, format, barcode, poster, director, runtime,
                genres, overview, notes, watched, added_at
         FROM movies WHERE ltrim(barcode, '0') = ?1 LIMIT 1",
    )?;
    let mut rows = stmt.query_map(params![normalized], db::from_row)?;
    rows.next().transpose()
}

fn internal<E: std::fmt::Display>(e: E) -> (u16, String) {
    (500, format!("shelf error: {e}"))
}

// Rust twins of guessFormat/cleanTitle in ui/js/lookup.js — keep in step.

fn guess_format(text: &str) -> Option<&'static str> {
    let t = text.to_lowercase();
    if t.contains("4k") || t.contains("uhd") || t.contains("ultra hd") {
        Some("4K")
    } else if t.contains("blu-ray") || t.contains("bluray") || t.contains("blu ray") {
        Some("Blu-ray")
    } else if t.contains("dvd") {
        Some("DVD")
    } else {
        None
    }
}

fn clean_title(text: &str) -> String {
    // strip bracketed junk
    let mut out = String::with_capacity(text.len());
    let mut depth = 0usize;
    for ch in text.chars() {
        match ch {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    // strip format/packaging noise words
    const NOISE: &[&str] = &[
        "4k", "uhd", "ultra hd", "blu-ray", "bluray", "blu ray", "dvd", "digital",
        "steelbook", "widescreen", "full screen", "special edition",
        "collector's edition", "collectors edition", "anniversary edition",
        "combo pack", "region free", "new", "sealed",
    ];
    let cleaned = out
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut lower = cleaned.to_lowercase();
    let mut result = cleaned.clone();
    for word in NOISE {
        while let Some(pos) = lower.find(word) {
            // only strip whole words
            let end = pos + word.len();
            let before_ok = pos == 0 || !lower.as_bytes()[pos - 1].is_ascii_alphanumeric();
            let after_ok =
                end == lower.len() || !lower.as_bytes()[end].is_ascii_alphanumeric();
            if before_ok && after_ok {
                result.replace_range(pos..end, &" ".repeat(word.len()));
                lower.replace_range(pos..end, &" ".repeat(word.len()));
            } else {
                break;
            }
        }
    }
    result
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(|c: char| "+/|·-".contains(c) || c.is_whitespace())
        .to_string()
}
