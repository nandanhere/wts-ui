//! Owned process-group handling for spawned helper processes.
//!
//! Helpers such as `glab`, `docker`, and MCP servers can spawn
//! descendants. Killing only the direct child leaks those descendants,
//! so children are spawned in their own process group and termination
//! signals the whole group.

use std::process::{Child, Command};

#[cfg(unix)]
pub(crate) fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    command.process_group(0);
}

#[cfg(not(unix))]
pub(crate) fn configure_process_group(_command: &mut Command) {}

#[cfg(unix)]
pub(crate) fn terminate_process_group(child: &mut Child) {
    let process_group = i32::try_from(child.id()).unwrap_or(-1);
    if process_group > 0 {
        // SAFETY: configure_process_group assigns the spawned child a
        // group whose ID equals its PID. A negative PID targets only
        // that owned process group.
        let result = unsafe { libc::kill(-process_group, libc::SIGKILL) };
        if result == -1 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                let _ = child.kill();
            }
        }
    } else {
        let _ = child.kill();
    }
    let _ = child.wait();
}

#[cfg(not(unix))]
pub(crate) fn terminate_process_group(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{
        fs,
        process::Stdio,
        thread,
        time::{Duration, Instant},
    };

    #[test]
    fn termination_reaps_the_owned_descendant_group() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let descendant_file = directory.path().join("descendant.pid");
        let mut command = Command::new("sh");
        command
            .args([
                "-c",
                "sleep 30 & child=$!; printf '%s' \"$child\" > \"$1\"; wait",
                "wts-integrations-test",
            ])
            .arg(&descendant_file)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_process_group(&mut command);
        let mut child = command.spawn().expect("spawn shell");

        let deadline = Instant::now() + Duration::from_secs(5);
        let descendant_pid: i32 = loop {
            if let Ok(raw) = fs::read_to_string(&descendant_file)
                && let Ok(pid) = raw.trim().parse::<i32>()
            {
                break pid;
            }
            assert!(Instant::now() < deadline, "descendant did not start");
            thread::sleep(Duration::from_millis(10));
        };

        terminate_process_group(&mut child);

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            // SAFETY: signal 0 only probes whether the descendant exists.
            let alive = unsafe { libc::kill(descendant_pid, 0) } == 0;
            if !alive {
                break;
            }
            assert!(Instant::now() < deadline, "descendant survived group kill");
            thread::sleep(Duration::from_millis(10));
        }
    }
}
