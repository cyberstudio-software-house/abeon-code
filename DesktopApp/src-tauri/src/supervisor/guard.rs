use regex::Regex;
use serde_json::Value;

const BUILTIN_MCP_GLOBS: &[&str] = &[
    "mcp__bandzior__config_update",
    "mcp__bandzior__deployment_*",
    "mcp__bandzior__env_vars_set",
    "mcp__bandzior__resource_create",
    "mcp__bandzior__resource_update",
    "mcp__bandzior__resource_delete",
    "mcp__bandzior__secret_create",
];

const PRODUCTION_BRANCHES: &[&str] = &["main", "master"];
const WRAPPER_WORDS: &[&str] = &[
    "sudo", "env", "time", "nohup", "exec", "command", "nice", "xargs",
];
const SHELL_WORDS: &[&str] = &["bash", "sh", "zsh", "dash"];
const GIT_GLOBAL_OPTIONS_WITH_VALUE: &[&str] =
    &["-C", "-c", "--git-dir", "--work-tree", "--namespace"];
const PUSH_OPTIONS_WITH_VALUE: &[&str] = &[
    "-o",
    "--push-option",
    "--receive-pack",
    "--exec",
    "--repo",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProductionAction {
    pub label: String,
}

pub struct ProductionRules {
    task_release: Regex,
    mcp_patterns: Vec<Regex>,
    extra_bash: Vec<Regex>,
}

fn glob_to_regex(glob: &str) -> Option<Regex> {
    let body = glob
        .split('*')
        .map(regex::escape)
        .collect::<Vec<_>>()
        .join(".*");
    Regex::new(&format!("^{body}$")).ok()
}

fn clean_token(token: &str) -> &str {
    token.trim_matches(|c| c == '"' || c == '\'' || c == '`')
}

fn split_segments(command: &str) -> Vec<&str> {
    command
        .split(|c| matches!(c, ';' | '|' | '&' | '\n' | '\r' | '(' | ')' | '`'))
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .collect()
}

fn is_env_assignment(token: &str) -> bool {
    match token.split_once('=') {
        Some((name, _)) => {
            !name.is_empty()
                && !name.starts_with(|c: char| c.is_ascii_digit())
                && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        }
        None => false,
    }
}

fn is_shell_command_flag(token: &str) -> bool {
    token.starts_with('-') && !token.starts_with("--") && token.ends_with('c')
}

fn strip_branch(target: &str) -> &str {
    let target = target.trim_start_matches('+');
    target.strip_prefix("refs/heads/").unwrap_or(target)
}

fn production_label(branch: &str) -> String {
    format!("git push → {branch}")
}

fn classify_git_push(args: &[&str], current_branch: Option<&str>) -> Option<String> {
    let mut positionals: Vec<&str> = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = args[index];
        if arg == "--all" || arg == "--mirror" {
            return Some(production_label(arg));
        }
        if arg.starts_with('-') {
            let takes_value = PUSH_OPTIONS_WITH_VALUE.contains(&arg);
            index += if takes_value { 2 } else { 1 };
            continue;
        }
        positionals.push(arg);
        index += 1;
    }
    let refspecs: Vec<&str> = positionals.into_iter().skip(1).collect();
    let current = || current_branch.map(str::to_string);
    let targets: Vec<Option<String>> = if refspecs.is_empty() {
        vec![current()]
    } else {
        refspecs
            .iter()
            .map(|refspec| {
                let refspec = refspec.trim_start_matches('+');
                match refspec.split_once(':') {
                    Some((_, destination)) => Some(strip_branch(destination).to_string()),
                    None if refspec == "HEAD" => current(),
                    None => Some(strip_branch(refspec).to_string()),
                }
            })
            .collect()
    };
    targets.into_iter().find_map(|target| match target {
        None => Some(production_label("?")),
        Some(branch) if PRODUCTION_BRANCHES.contains(&branch.as_str()) => {
            Some(production_label(&branch))
        }
        Some(_) => None,
    })
}

impl ProductionRules {
    pub fn new(extra: &[String]) -> ProductionRules {
        let mut mcp_patterns: Vec<Regex> = BUILTIN_MCP_GLOBS
            .iter()
            .filter_map(|glob| glob_to_regex(glob))
            .collect();
        let mut extra_bash = Vec::new();
        for line in extra {
            let line = line.trim();
            if let Some(pattern) = line.strip_prefix("bash:") {
                let pattern = pattern.trim();
                if pattern.is_empty() {
                    continue;
                }
                if let Ok(regex) = Regex::new(pattern) {
                    extra_bash.push(regex);
                }
            } else if let Some(glob) = line.strip_prefix("mcp:") {
                let glob = glob.trim();
                if glob.is_empty() {
                    continue;
                }
                if let Some(regex) = glob_to_regex(glob) {
                    mcp_patterns.push(regex);
                }
            }
        }
        ProductionRules {
            task_release: Regex::new(r"^task\s+release").expect("valid task release regex"),
            mcp_patterns,
            extra_bash,
        }
    }

    pub fn classify(
        &self,
        tool_name: &str,
        tool_input: &Value,
        current_branch: Option<&str>,
    ) -> Option<ProductionAction> {
        let label = if tool_name == "Bash" {
            let command = tool_input.get("command").and_then(Value::as_str)?;
            self.classify_command(command, current_branch)
        } else if self.mcp_patterns.iter().any(|regex| regex.is_match(tool_name)) {
            Some(tool_name.to_string())
        } else {
            None
        };
        label.map(|label| ProductionAction { label })
    }

    fn classify_command(&self, command: &str, current_branch: Option<&str>) -> Option<String> {
        split_segments(command)
            .into_iter()
            .find_map(|segment| self.classify_segment(segment, current_branch))
    }

    fn classify_segment(&self, segment: &str, current_branch: Option<&str>) -> Option<String> {
        if self.extra_bash.iter().any(|regex| regex.is_match(segment)) {
            return Some(segment.to_string());
        }
        let tokens: Vec<&str> = segment.split_whitespace().map(clean_token).collect();
        let mut start = 0;
        while start < tokens.len() {
            let token = tokens[start];
            if is_env_assignment(token) || WRAPPER_WORDS.contains(&token) {
                start += 1;
            } else if token.starts_with('-') && start > 0 {
                start += 1;
            } else {
                break;
            }
        }
        let tokens = &tokens[start..];
        let first = *tokens.first()?;
        let stripped = tokens.join(" ");
        if start > 0 && self.extra_bash.iter().any(|regex| regex.is_match(&stripped)) {
            return Some(stripped);
        }
        if first == "eval" {
            return self.classify_command(&tokens[1..].join(" "), current_branch);
        }
        if SHELL_WORDS.contains(&first) {
            if let Some(position) = tokens.iter().position(|t| is_shell_command_flag(t)) {
                return self.classify_command(&tokens[position + 1..].join(" "), current_branch);
            }
            return None;
        }
        if self.task_release.is_match(&stripped) {
            return Some("task release".to_string());
        }
        if first == "git" {
            let mut index = 1;
            while index < tokens.len() && tokens[index].starts_with('-') {
                let takes_value = GIT_GLOBAL_OPTIONS_WITH_VALUE.contains(&tokens[index]);
                index += if takes_value { 2 } else { 1 };
            }
            if tokens.get(index) == Some(&"push") {
                return classify_git_push(&tokens[index + 1..], current_branch);
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn label(
        tool: &str,
        command: Option<&str>,
        branch: Option<&str>,
        rules: &ProductionRules,
    ) -> Option<String> {
        let input = match command {
            Some(command) => json!({ "command": command }),
            None => json!({}),
        };
        rules.classify(tool, &input, branch).map(|action| action.label)
    }

    #[test]
    fn classify_cases() {
        let rules = ProductionRules::new(&[]);
        let some = |text: &str| Some(text.to_string());
        let cases: Vec<(&str, Option<&str>, Option<&str>, Option<String>)> = vec![
            ("Bash", Some("git push"), Some("main"), some("git push → main")),
            ("Bash", Some("git push"), Some("feature/x"), None),
            ("Bash", Some("git push origin feature"), Some("main"), None),
            ("Bash", Some("git push origin HEAD:main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("git -C repo push --force origin master"), None, some("git push → master")),
            ("Bash", Some("cd app && git push -u origin main"), None, some("git push → main")),
            ("Bash", Some("git push --all"), None, some("git push → --all")),
            ("Bash", Some("git push --mirror origin"), None, some("git push → --mirror")),
            ("Bash", Some("git push origin +refs/heads/main"), None, some("git push → main")),
            ("Bash", Some("task release:patch --yes"), None, some("task release")),
            ("Bash", Some("echo \"git push origin main\""), None, None),
            ("Bash", Some("git status"), Some("main"), None),
            ("Bash", Some("git push"), None, some("git push → ?")),
            ("Bash", Some("git push origin HEAD"), Some("main"), some("git push → main")),
            ("Bash", Some("git push origin HEAD"), Some("feature/x"), None),
            ("Bash", Some("git push origin feature/x:refs/heads/main"), None, some("git push → main")),
            ("Bash", Some("git push origin :main"), None, some("git push → main")),
            ("Bash", Some("git push origin feature main"), None, some("git push → main")),
            ("Bash", Some("git push origin \"main\""), None, some("git push → main")),
            ("Bash", Some("git -c user.name=x push origin main"), None, some("git push → main")),
            ("Bash", Some("git --git-dir=.git push origin main"), None, some("git push → main")),
            ("Bash", Some("git push --force-with-lease origin main"), None, some("git push → main")),
            ("Bash", Some("git push origin main-fix"), None, None),
            ("Bash", Some("git commit -m x\ngit push origin master"), None, some("git push → master")),
            ("Bash", Some("true || git push origin main"), None, some("git push → main")),
            ("Bash", Some("npm test; git push origin main | cat"), None, some("git push → main")),
            ("Bash", Some("FOO=1 git push origin main"), None, some("git push → main")),
            ("Bash", Some("sudo git push origin main"), None, some("git push → main")),
            ("Bash", Some("bash -c \"git push origin main\""), None, some("git push → main")),
            ("Bash", Some("sh -c 'cd x && git push origin main'"), None, some("git push → main")),
            ("Bash", Some("git push -o ci.skip origin feature"), Some("main"), None),
            ("Bash", Some("cd x && task release"), None, some("task release")),
            ("Bash", Some("task build"), None, None),
            ("Bash", Some("git log --oneline"), Some("main"), None),
            ("mcp__bandzior__deployment_deploy", None, None, some("mcp__bandzior__deployment_deploy")),
            ("mcp__bandzior__config_update", None, None, some("mcp__bandzior__config_update")),
            ("mcp__bandzior__env_vars_set", None, None, some("mcp__bandzior__env_vars_set")),
            ("mcp__bandzior__resource_delete", None, None, some("mcp__bandzior__resource_delete")),
            ("mcp__bandzior__secret_create", None, None, some("mcp__bandzior__secret_create")),
            ("mcp__bandzior__project_find", None, None, None),
            ("mcp__bandzior__resource_show", None, None, None),
            ("Read", None, None, None),
        ];
        for (tool, command, branch, expected) in cases {
            assert_eq!(
                label(tool, command, branch, &rules),
                expected,
                "tool={tool} command={command:?} branch={branch:?}"
            );
        }
    }

    #[test]
    fn extra_rules_apply() {
        let rules = ProductionRules::new(&[
            "bash:^make deploy".to_string(),
            "mcp:mcp__foo__*".to_string(),
            "garbage".to_string(),
            "bash:(".to_string(),
            "bash:".to_string(),
        ]);
        assert_eq!(
            label("Bash", Some("make deploy prod"), None, &rules),
            Some("make deploy prod".to_string())
        );
        assert_eq!(
            label("Bash", Some("cd x && make deploy prod"), None, &rules),
            Some("make deploy prod".to_string())
        );
        assert_eq!(
            label("mcp__foo__bar", None, None, &rules),
            Some("mcp__foo__bar".to_string())
        );
        assert_eq!(label("mcp__baz__bar", None, None, &rules), None);
        assert_eq!(label("Bash", Some("make build"), None, &rules), None);
        assert_eq!(label("Bash", Some("ls"), None, &rules), None);
    }

    #[test]
    fn missing_command_is_not_production() {
        let rules = ProductionRules::new(&[]);
        assert_eq!(rules.classify("Bash", &json!({}), Some("main")), None);
    }
}
