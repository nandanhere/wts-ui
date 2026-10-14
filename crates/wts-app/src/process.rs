use std::{
    io,
    process::{Child, Command},
};

#[cfg(unix)]
pub(crate) fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    command.process_group(0);
}

#[cfg(not(unix))]
pub(crate) fn configure_process_group(_command: &mut Command) {}

#[cfg(unix)]
pub(crate) fn terminate_process_group(child: &mut Child, already_reaped: bool) -> io::Result<()> {
    let process_group = i32::try_from(child.id())
        .map_err(|_| io::Error::other("child process identifier is invalid"))?;
    // SAFETY: configure_process_group assigns the spawned child a group whose
    // ID equals its PID. A negative PID targets only that owned process group.
    let result = unsafe { libc::kill(-process_group, libc::SIGKILL) };
    if result == -1 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            return Err(error);
        }
    }
    if !already_reaped {
        child.wait()?;
    }
    Ok(())
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
    use tempfile::tempdir;

    #[test]
    fn termination_reaps_the_owned_descendant_group() {
        let directory = tempdir().expect("temporary directory");
        let descendant_file = directory.path().join("descendant.pid");
        let mut command = Command::new("sh");
        command
            .args([
                "-c",
                "sleep 30 & child=$!; printf '%s' \"$child\" > \"$1\"; wait",
                "wts-process-test",
            ])
            .arg(&descendant_file)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_process_group(&mut command);
        let mut child = command.spawn().expect("spawn process group");
        let descendant = wait_for_pid(&descendant_file);

        terminate_process_group(&mut child, false).expect("terminate group");

        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            // SAFETY: signal 0 performs an existence check only.
            let result = unsafe { libc::kill(descendant, 0) };
            if result == -1 && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "descendant process survived group termination"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn wait_for_pid(path: &std::path::Path) -> i32 {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Ok(value) = fs::read_to_string(path)
                && let Ok(process_id) = value.parse::<i32>()
            {
                return process_id;
            }
            assert!(
                Instant::now() < deadline,
                "descendant process did not publish a numeric PID"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }
}

#[cfg(not(unix))]
pub(crate) fn terminate_process_group(child: &mut Child, already_reaped: bool) -> io::Result<()> {
    if !already_reaped {
        match child.kill() {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::InvalidInput => {}
            Err(error) => return Err(error),
        }
        child.wait()?;
    }
    Ok(())
}
