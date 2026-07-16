mod db;
mod lookup;
mod publish;
mod server;

use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use tauri::Manager;

struct Db(Arc<Mutex<Connection>>);

// Every command is async + spawn_blocking: sync Tauri commands run on the
// main thread, and the DB mutex is shared with the scan-server threads —
// a batch of phone scans mid-write would otherwise stall the UI while it
// waits for the lock (and publish would freeze it for a whole git push).

/// Run `f` against the shared connection on a blocking-work thread.
async fn with_db<T, F>(state: tauri::State<'_, Db>, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&Connection) -> Result<T, String> + Send + 'static,
{
    let db = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || f(&db.lock().unwrap()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_movies(state: tauri::State<'_, Db>) -> Result<Vec<db::Movie>, String> {
    with_db(state, |conn| db::list(conn).map_err(|e| e.to_string())).await
}

#[tauri::command]
async fn add_movie(state: tauri::State<'_, Db>, movie: db::Movie) -> Result<db::Movie, String> {
    with_db(state, move |conn| db::add(conn, movie).map_err(|e| e.to_string())).await
}

#[tauri::command]
async fn update_movie(state: tauri::State<'_, Db>, movie: db::Movie) -> Result<(), String> {
    with_db(state, move |conn| db::update(conn, &movie).map_err(|e| e.to_string())).await
}

#[tauri::command]
async fn delete_movie(state: tauri::State<'_, Db>, id: i64) -> Result<(), String> {
    with_db(state, move |conn| db::delete(conn, id).map_err(|e| e.to_string())).await
}

#[tauri::command]
async fn get_setting(state: tauri::State<'_, Db>, key: String) -> Result<Option<String>, String> {
    with_db(state, move |conn| db::get_setting(conn, &key).map_err(|e| e.to_string())).await
}

#[tauri::command]
async fn set_setting(state: tauri::State<'_, Db>, key: String, value: String) -> Result<(), String> {
    with_db(state, move |conn| {
        db::set_setting(conn, &key, &value).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn lookup_barcode(code: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || lookup::lookup_upc(&code))
        .await
        .map_err(|e| e.to_string())?
}

/// Everything the "phone scanning" setup panel needs to show the user.
#[tauri::command]
async fn scan_server_info(state: tauri::State<'_, Db>) -> Result<serde_json::Value, String> {
    with_db(state, |conn| {
        let token = server::ensure_token(conn).map_err(|e| e.to_string())?;
        Ok(serde_json::json!({
            "ip": server::lan_ip(),
            "port": server::PORT,
            "token": token,
        }))
    })
    .await
}

#[tauri::command]
async fn publish_to_repo(state: tauri::State<'_, Db>) -> Result<String, String> {
    let db = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // hold the lock only long enough to snapshot — the git push that
        // follows can take seconds and must not block phone scans
        let (movies, repo_path) = {
            let conn = db.lock().unwrap();
            let repo_path = db::get_setting(&conn, "repo_path")
                .map_err(|e| e.to_string())?
                .ok_or("no repo folder set — use \"set repo folder\" first")?;
            let movies = db::list(&conn).map_err(|e| e.to_string())?;
            (movies, repo_path)
        };
        publish::publish(&movies, &repo_path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn write_file(path: String, contents: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::write(&path, contents).map_err(|e| format!("couldn't write {path}: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn read_file(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::read_to_string(&path).map_err(|e| format!("couldn't read {path}: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let conn = Connection::open(dir.join("shelf.db"))?;
            db::init(&conn)?;
            let token = server::ensure_token(&conn)?;
            let conn = Arc::new(Mutex::new(conn));
            server::spawn(app.handle().clone(), conn.clone(), token);
            app.manage(Db(conn));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_movies,
            add_movie,
            update_movie,
            delete_movie,
            get_setting,
            set_setting,
            lookup_barcode,
            scan_server_info,
            publish_to_repo,
            write_file,
            read_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running shelf");
}
