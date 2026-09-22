//! Bounded ACP text-file operations, authorized for one canonical project path at a time.

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use crate::host_access;
use crate::problem::Problem;

pub const MAX_FILE_BYTES: usize = 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadTextFile {
    pub session_id: String,
    pub path: String,
    pub line: Option<usize>,
    pub limit: Option<usize>,
    #[serde(rename = "_meta")]
    pub _meta: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteTextFile {
    pub session_id: String,
    pub path: String,
    pub content: String,
    #[serde(rename = "_meta")]
    pub _meta: Option<Value>,
}

pub fn resolve(
    root: &str,
    requested: &str,
    write: bool,
    copilot_home: &Path,
) -> Result<PathBuf, Problem> {
    if requested.is_empty() || requested.len() > 4096 || requested.contains('\0') {
        return Err(Problem::plain(
            "The requested file path is invalid or too long.",
        ));
    }
    let path = Path::new(requested);
    if private_path(path) {
        return Err(Problem::plain(
            "Copilot client file access does not read or write credential, environment or private runtime files.",
        ));
    }
    let target = host_access::validated_client_file(Path::new(root), path, write, copilot_home)
        .map_err(|error| {
            Problem::with(
                "That file is outside the allowed project boundary. Choose a specific working folder; home, system and credential folders are not grants.",
                error.to_string(),
            )
        })?;
    if private_path(&target) {
        return Err(Problem::plain(
            "The requested path resolves to a private runtime or credential file.",
        ));
    }
    Ok(target)
}

fn private_path(path: &Path) -> bool {
    path.components().any(|component| {
        let name = component.as_os_str().to_string_lossy().to_ascii_lowercase();
        matches!(
            name.as_str(),
            ".git"
                | ".copilot"
                | ".ssh"
                | ".aws"
                | ".azure"
                | ".kube"
                | ".gnupg"
                | ".npmrc"
                | ".netrc"
                | ".git-credentials"
                | "credentials"
                | "credentials.toml"
        ) || name == ".env"
            || name.starts_with(".env.")
    })
}

pub fn read(path: &Path, line: Option<usize>, limit: Option<usize>) -> Result<String, Problem> {
    if line == Some(0) || limit == Some(0) {
        return Err(Problem::plain(
            "File line and limit must be positive integers.",
        ));
    }
    let file = fs::File::open(path).map_err(|error| {
        Problem::with("The approved file could not be opened.", error.to_string())
    })?;
    let mut bytes = Vec::new();
    file.take((MAX_FILE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            Problem::with("The approved file could not be read.", error.to_string())
        })?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(Problem::plain(
            "Client text-file access is limited to 1 MiB per file.",
        ));
    }
    let text = String::from_utf8(bytes).map_err(|error| {
        Problem::with("The approved file is not UTF-8 text.", error.to_string())
    })?;
    Ok(text
        .split_inclusive('\n')
        .skip(line.unwrap_or(1) - 1)
        .take(limit.unwrap_or(usize::MAX))
        .collect())
}

pub fn write(path: &Path, content: &str) -> Result<(), Problem> {
    if content.len() > MAX_FILE_BYTES {
        return Err(Problem::plain(
            "Client text-file writes are limited to 1 MiB.",
        ));
    }
    let permissions = match fs::metadata(path) {
        Ok(metadata) if metadata.permissions().readonly() => {
            return Err(Problem::plain("The approved file is read-only."));
        }
        Ok(metadata) => Some(metadata.permissions()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(Problem::with(
                "The approved file could not be inspected.",
                error.to_string(),
            ));
        }
    };
    let parent = path
        .parent()
        .ok_or_else(|| Problem::plain("The approved file has no parent."))?;
    let temporary = parent.join(format!(".darbot-write-{:032x}", rand::random::<u128>()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        if let Some(permissions) = permissions {
            file.set_permissions(permissions)?;
        }
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)
    })();
    result.map_err(|error: std::io::Error| {
        let cleanup = match fs::remove_file(&temporary) {
            Ok(()) => String::new(),
            Err(cleanup) if cleanup.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(cleanup) => format!(
                " Temporary write cleanup also failed at {}: {cleanup}",
                temporary.display()
            ),
        };
        Problem::with(
            "The approved file could not be replaced.",
            format!("{error}{cleanup}"),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_files_round_trip_and_reads_preserve_requested_line_endings() {
        let root = crate::test_support::temp_root("copilot-client-files");
        fs::create_dir_all(&root).unwrap();
        let file = root.join("message.txt");
        let target = resolve(
            root.to_str().unwrap(),
            file.to_str().unwrap(),
            true,
            &root.join("private-runtime"),
        )
        .unwrap();
        write(&target, "first\r\nsecond\r\nlast").unwrap();
        assert_eq!(read(&target, Some(2), Some(1)).unwrap(), "second\r\n");
        assert_eq!(
            read(&target, None, None).unwrap(),
            "first\r\nsecond\r\nlast"
        );
        write(&target, "replacement").unwrap();
        assert_eq!(read(&target, None, None).unwrap(), "replacement");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        assert!(read(&target, Some(0), None).is_err());
        assert!(read(&target, None, Some(0)).is_err());
        assert!(write(&target, &"x".repeat(MAX_FILE_BYTES + 1)).is_err());
        assert_eq!(read(&target, None, None).unwrap(), "replacement");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn client_paths_reject_escape_private_files_and_missing_parents() {
        let root = crate::test_support::temp_root("copilot-client-boundary");
        fs::create_dir_all(&root).unwrap();
        for relative in [
            ".env",
            ".env.local",
            ".copilot/auth.json",
            ".ssh/key",
            "missing/new.txt",
        ] {
            let path = root.join(relative);
            assert!(resolve(
                root.to_str().unwrap(),
                path.to_str().unwrap(),
                true,
                &root.join("state")
            )
            .is_err());
        }
        assert!(resolve(
            root.to_str().unwrap(),
            "relative.txt",
            true,
            &root.join("state")
        )
        .is_err());
        let outside = root.parent().unwrap().join("outside.txt");
        assert!(resolve(
            root.to_str().unwrap(),
            outside.to_str().unwrap(),
            true,
            &root.join("state")
        )
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn client_paths_reject_links_including_dangling_write_targets() {
        use std::os::unix::fs::symlink;
        let root = crate::test_support::temp_root("copilot-client-links");
        fs::create_dir_all(&root).unwrap();
        let link = root.join("linked.txt");
        symlink(root.parent().unwrap().join("missing-target"), &link).unwrap();
        assert!(resolve(
            root.to_str().unwrap(),
            link.to_str().unwrap(),
            true,
            &root.join("state")
        )
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
