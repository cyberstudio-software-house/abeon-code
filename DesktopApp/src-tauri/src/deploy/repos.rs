use crate::domain::Project;
use crate::git;
use git2::Repository;
use std::path::{Path, PathBuf};

fn normalize(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.components().collect())
}

pub fn project_repos(project: &Project) -> Vec<PathBuf> {
    git::repo_roots(Path::new(&project.path))
}

pub fn repo_for_dir(dir: &Path) -> Option<PathBuf> {
    let repo = Repository::discover(dir).ok()?;
    let workdir = repo.workdir()?;
    Some(workdir.canonicalize().unwrap_or_else(|_| workdir.components().collect()))
}

pub fn projects_of_repo(projects: &[Project], repo: &Path) -> Vec<i64> {
    let repo = normalize(repo);
    let parent = repo.parent().map(Path::to_path_buf);
    projects
        .iter()
        .filter(|project| {
            let path = normalize(Path::new(&project.path));
            path == repo || parent.as_deref() == Some(path.as_path())
        })
        .map(|project| project.id)
        .collect()
}

pub fn is_known_repo(projects: &[Project], repo: &Path) -> bool {
    !projects_of_repo(projects, repo).is_empty()
}

pub fn repo_label(repo: &Path) -> String {
    repo.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| repo.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deploy::test_support::{init_repo, project};
    use tempfile::tempdir;

    #[test]
    fn a_repository_inside_a_parent_project_belongs_to_both_projects() {
        let projects = vec![project(1, "/p/hafen"), project(2, "/p/hafen/workshop_asp")];
        assert_eq!(projects_of_repo(&projects, Path::new("/p/hafen/workshop_asp")), vec![1, 2]);
        assert!(!is_known_repo(&projects, Path::new("/elsewhere/repo")));
        assert!(is_known_repo(&projects, Path::new("/p/hafen/workshop_asp")));
    }

    #[test]
    fn a_grandparent_project_does_not_own_a_nested_repository() {
        let projects = vec![project(1, "/p"), project(2, "/p/hafen/workshop_asp")];
        assert_eq!(projects_of_repo(&projects, Path::new("/p/hafen/workshop_asp")), vec![2]);
    }

    #[test]
    fn project_repos_lists_the_repositories_of_the_project_path() {
        let dir = tempdir().unwrap();
        init_repo(&dir.path().join("api"));
        init_repo(&dir.path().join("web"));
        let found = project_repos(&project(1, dir.path().to_str().unwrap()));
        let root = dir.path().canonicalize().unwrap();
        assert_eq!(found, vec![root.join("api"), root.join("web")]);
    }

    #[test]
    fn repo_for_dir_returns_the_work_tree_root_from_a_nested_directory() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        let nested = dir.path().join("src/deep");
        std::fs::create_dir_all(&nested).unwrap();
        assert_eq!(repo_for_dir(&nested), Some(dir.path().canonicalize().unwrap()));
        assert_eq!(repo_for_dir(dir.path()), Some(dir.path().canonicalize().unwrap()));
    }

    #[test]
    fn the_label_of_a_repository_is_its_directory_name() {
        assert_eq!(repo_label(Path::new("/p/yachtic/api")), "api");
        assert_eq!(repo_label(Path::new("/")), "/");
    }

    #[test]
    fn repo_for_dir_is_none_outside_a_repository() {
        let dir = tempdir().unwrap();
        assert_eq!(repo_for_dir(dir.path()), None);
    }
}
