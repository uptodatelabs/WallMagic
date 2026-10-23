//! WallMagic GUI 진입점.
//! 릴리스 빌드에서는 콘솔 창을 띄우지 않기 위해 windows_subsystem을 지정한다.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    wallmagic_app::run();
}
