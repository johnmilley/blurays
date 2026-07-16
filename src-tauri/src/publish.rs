//! Publishes the collection to the shelf git repo as `ui/movies.json` and
//! pushes it, so the read-only mobile web view (GitHub Pages) picks up
//! whatever's on the desktop without any manual export/import step.

use std::path::Path;
use std::process::Command;

use crate::db;

/// Takes a snapshot of the movies rather than the connection so the DB
/// lock never spans the (slow, networked) git operations below.
pub fn publish(movies: &[db::Movie], repo_path: &str) -> Result<String, String> {
    let repo = Path::new(repo_path);
    if !repo.is_dir() {
        return Err(format!("'{repo_path}' isn't a folder — set it again in the menu"));
    }
    let ui_dir = repo.join("ui");
    if !ui_dir.is_dir() {
        return Err(format!(
            "no ui/ folder inside '{repo_path}' — pick the repo root (the one with CLAUDE.md, ui/, src-tauri/ in it)"
        ));
    }

    let json = serde_json::to_string_pretty(movies).map_err(|e| e.to_string())?;
    std::fs::write(ui_dir.join("movies.json"), json)
        .map_err(|e| format!("couldn't write movies.json: {e}"))?;

    let run = |args: &[&str]| -> Result<(bool, String), String> {
        let out = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .map_err(|e| format!("couldn't run git: {e}"))?;
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        Ok((out.status.success(), text))
    };

    run(&["add", "ui/movies.json"])?;

    let (committed, commit_out) = run(&[
        "commit",
        "-m",
        &format!("Publish collection ({} titles)", movies.len()),
    ])?;
    if !committed && !commit_out.to_lowercase().contains("nothing to commit") {
        return Err(format!("git commit failed: {}", commit_out.trim()));
    }

    let (pushed, push_out) = run(&["push"])?;
    if !pushed {
        return Err(format!("git push failed: {}", push_out.trim()));
    }

    Ok(if committed {
        format!("published {} titles", movies.len())
    } else {
        format!("published {} titles (already up to date, pushed anyway)", movies.len())
    })
}
