#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Tauri's GTK3 layer crashes with a Wayland protocol error on recent
    // KWin (Error 71 at startup), and WebKitGTK's dmabuf renderer fails GBM
    // buffer allocation under XWayland here — force the working combination
    // before GTK initializes. A user's own setting still wins. (Same
    // workaround as ved.)
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("GDK_BACKEND").is_none() {
            std::env::set_var("GDK_BACKEND", "x11");
        }
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    shelf_lib::run()
}
