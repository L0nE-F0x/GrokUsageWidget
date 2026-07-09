//! Windows helpers so background Node/npm work does not flash a console window.

use std::process::Command as StdCommand;
use tokio::process::Command as TokioCommand;

/// CREATE_NO_WINDOW — hide console for console-subsystem programs (node, cmd, npm).
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
pub fn hide_tokio_console(cmd: &mut TokioCommand) {
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn hide_tokio_console(_cmd: &mut TokioCommand) {}

#[cfg(windows)]
pub fn hide_std_console(cmd: &mut StdCommand) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn hide_std_console(_cmd: &mut StdCommand) {}
