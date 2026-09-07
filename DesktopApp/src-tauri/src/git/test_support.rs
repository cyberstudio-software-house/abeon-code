use std::fs;
use std::path::Path;
use std::process::Command;

pub fn run_git(dir: &Path, args: &[&str]) {
    let out = Command::new("git").current_dir(dir).args(args).output().expect("git");
    if !out.status.success() {
        panic!("git {:?} failed: {}", args, String::from_utf8_lossy(&out.stderr));
    }
}

pub fn git_stdout(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").current_dir(dir).args(args).output().expect("git");
    if !out.status.success() {
        panic!("git {:?} failed: {}", args, String::from_utf8_lossy(&out.stderr));
    }
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

pub fn init_repo_with_commit(dir: &Path) {
    run_git(dir, &["init", "-q", "-b", "main"]);
    run_git(dir, &["config", "user.email", "t@t"]);
    run_git(dir, &["config", "user.name", "t"]);
    fs::write(dir.join("seed.txt"), "x\n").unwrap();
    run_git(dir, &["add", "."]);
    run_git(dir, &["commit", "-q", "-m", "seed"]);
}

pub fn commit_all(dir: &Path, message: &str) -> String {
    run_git(dir, &["add", "-A"]);
    run_git(dir, &["commit", "-q", "-m", message]);
    git_stdout(dir, &["rev-parse", "HEAD"])
}
