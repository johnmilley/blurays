use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
pub struct Movie {
    #[serde(default)]
    pub id: Option<i64>,
    pub title: String,
    #[serde(default)]
    pub year: Option<i32>,
    #[serde(default = "default_format")]
    pub format: String,
    #[serde(default)]
    pub barcode: Option<String>,
    #[serde(default)]
    pub poster: Option<String>,
    #[serde(default)]
    pub director: Option<String>,
    #[serde(default)]
    pub runtime: Option<i32>,
    #[serde(default)]
    pub genres: Option<String>,
    #[serde(default)]
    pub overview: Option<String>,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub watched: bool,
    #[serde(default)]
    pub added_at: String,
}

fn default_format() -> String {
    "Blu-ray".into()
}

pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS movies (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            title    TEXT NOT NULL,
            year     INTEGER,
            format   TEXT NOT NULL DEFAULT 'Blu-ray',
            barcode  TEXT,
            poster   TEXT,
            director TEXT,
            runtime  INTEGER,
            notes    TEXT NOT NULL DEFAULT '',
            watched  INTEGER NOT NULL DEFAULT 0,
            added_at TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_movies_barcode ON movies(barcode);
        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );",
    )?;
    migrate(conn)
}

/// Add columns introduced after the first release to existing databases.
fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let existing: Vec<String> = conn
        .prepare("SELECT name FROM pragma_table_info('movies')")?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for (name, ddl) in [
        ("genres", "ALTER TABLE movies ADD COLUMN genres TEXT"),
        ("overview", "ALTER TABLE movies ADD COLUMN overview TEXT"),
    ] {
        if !existing.iter().any(|c| c == name) {
            conn.execute(ddl, [])?;
        }
    }
    Ok(())
}

pub(crate) fn from_row(row: &Row) -> rusqlite::Result<Movie> {
    Ok(Movie {
        id: row.get(0)?,
        title: row.get(1)?,
        year: row.get(2)?,
        format: row.get(3)?,
        barcode: row.get(4)?,
        poster: row.get(5)?,
        director: row.get(6)?,
        runtime: row.get(7)?,
        genres: row.get(8)?,
        overview: row.get(9)?,
        notes: row.get(10)?,
        watched: row.get::<_, i64>(11)? != 0,
        added_at: row.get(12)?,
    })
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Movie>> {
    conn.prepare(
        "SELECT id, title, year, format, barcode, poster, director, runtime,
                genres, overview, notes, watched, added_at
         FROM movies ORDER BY title COLLATE NOCASE",
    )?
    .query_map([], from_row)?
    .collect()
}

pub fn add(conn: &Connection, mut movie: Movie) -> rusqlite::Result<Movie> {
    conn.execute(
        "INSERT INTO movies (title, year, format, barcode, poster, director,
                             runtime, genres, overview, notes, watched, added_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            movie.title,
            movie.year,
            movie.format,
            movie.barcode,
            movie.poster,
            movie.director,
            movie.runtime,
            movie.genres,
            movie.overview,
            movie.notes,
            movie.watched as i64,
            movie.added_at,
        ],
    )?;
    movie.id = Some(conn.last_insert_rowid());
    Ok(movie)
}

pub fn update(conn: &Connection, movie: &Movie) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE movies SET title = ?1, year = ?2, format = ?3, barcode = ?4,
                           poster = ?5, director = ?6, runtime = ?7,
                           genres = ?8, overview = ?9, notes = ?10, watched = ?11
         WHERE id = ?12",
        params![
            movie.title,
            movie.year,
            movie.format,
            movie.barcode,
            movie.poster,
            movie.director,
            movie.runtime,
            movie.genres,
            movie.overview,
            movie.notes,
            movie.watched as i64,
            movie.id,
        ],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM movies WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn get_setting(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}
