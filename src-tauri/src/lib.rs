mod db;
mod lookup;
mod server;

use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use tauri::Manager;

struct Db(Arc<Mutex<Connection>>);

#[tauri::command]
fn list_movies(state: tauri::State<Db>) -> Result<Vec<db::Movie>, String> {
    db::list(&state.0.lock().unwrap()).map_err(|e| e.to_string())
}

#[tauri::command]
fn add_movie(state: tauri::State<Db>, movie: db::Movie) -> Result<db::Movie, String> {
    db::add(&state.0.lock().unwrap(), movie).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_movie(state: tauri::State<Db>, movie: db::Movie) -> Result<(), String> {
    db::update(&state.0.lock().unwrap(), &movie).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_movie(state: tauri::State<Db>, id: i64) -> Result<(), String> {
    db::delete(&state.0.lock().unwrap(), id).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_setting(state: tauri::State<Db>, key: String) -> Result<Option<String>, String> {
    db::get_setting(&state.0.lock().unwrap(), &key).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_setting(state: tauri::State<Db>, key: String, value: String) -> Result<(), String> {
    db::set_setting(&state.0.lock().unwrap(), &key, &value).map_err(|e| e.to_string())
}

#[tauri::command]
async fn lookup_barcode(code: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || lookup::lookup_upc(&code))
        .await
        .map_err(|e| e.to_string())?
}

/// Everything the "phone scanning" setup panel needs to show the user.
#[tauri::command]
fn scan_server_info(state: tauri::State<Db>) -> Result<serde_json::Value, String> {
    let token = server::ensure_token(&state.0.lock().unwrap()).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "ip": server::lan_ip(),
        "port": server::PORT,
        "token": token,
    }))
}

#[tauri::command]
fn write_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("couldn't write {path}: {e}"))
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("couldn't read {path}: {e}"))
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
            write_file,
            read_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running shelf");
}
