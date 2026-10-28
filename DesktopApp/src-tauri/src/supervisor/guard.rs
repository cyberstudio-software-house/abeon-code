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

const CONFIRM_GATED_TOOLS: &[&str] = &[
    "mcp__bandzior__config_update",
    "mcp__bandzior__resource_update",
    "mcp__bandzior__env_vars_set",
    "mcp__bandzior__deployment_deploy",
    "mcp__bandzior__deployment_version_update",
    "mcp__bandzior__deployment_containers_update",
    "mcp__bandzior__deployment_update",
];
const FULLY_REDACTED_TOOLS: &[&str] = &[
    "mcp__bandzior__env_vars_set",
    "mcp__bandzior__secret_create",
];
const SENSITIVE_KEY_PARTS: &[&str] = &[
    "secret",
    "password",
    "passwd",
    "token",
    "key",
    "value",
    "data",
    "env",
    "credential",
];
const IDENTIFIER_KEYS: &[&str] = &["id", "name", "project", "namespace", "deployment"];
const REDACTED: &str = "***";
const BASH_TOOL: &str = "Bash";
const DETAIL_CHARS: usize = 300;

const PRODUCTION_BRANCHES: &[&str] = &["main", "master"];
const WRAPPER_WORDS: &[&str] = &[
    "sudo", "env", "time", "nohup", "exec", "command", "nice", "xargs",
];
const SHELL_WORDS: &[&str] = &["bash", "sh", "zsh", "dash"];
const GIT_GLOBAL_OPTIONS_WITH_VALUE: &[&str] =
    &["-C", "-c", "--git-dir", "--work-tree", "--namespace"];
const RELOCATING_GIT_OPTIONS: &[&str] = &["-C", "--git-dir", "--work-tree"];
const DIRECTORY_WORDS: &[&str] = &["cd", "pushd", "popd"];
const REPOSITORY_VARIABLES: &[&str] = &["GIT_DIR=", "GIT_WORK_TREE="];
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
    pub detail: String,
    pub fingerprint: String,
}

pub struct ProductionRules {
    task_release: Regex,
    mcp_patterns: Vec<Regex>,
    extra_bash: Vec<Regex>,
}

fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn detail_excerpt(text: &str) -> String {
    if text.chars().count() <= DETAIL_CHARS {
        return text.to_string();
    }
    let kept: String = text.chars().take(DETAIL_CHARS - 1).collect();
    format!("{kept}…")
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by(|left, right| left.0.cmp(right.0));
            let body = entries
                .into_iter()
                .map(|(key, item)| {
                    format!("{}:{}", Value::String(key.clone()), canonical_json(item))
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{body}}}")
        }
        Value::Array(items) => {
            let body = items
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",");
            format!("[{body}]")
        }
        other => other.to_string(),
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let key = key.to_lowercase();
    SENSITIVE_KEY_PARTS.iter().any(|part| key.contains(part))
}

fn is_identifier_key(key: &str) -> bool {
    let key = key.to_lowercase();
    IDENTIFIER_KEYS.contains(&key.as_str()) || key.ends_with("_id")
}

fn redact(value: &Value, key: Option<&str>, every_string: bool) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(name, item)| {
                    let item = if is_sensitive_key(name) {
                        Value::String(REDACTED.to_string())
                    } else {
                        redact(item, Some(name), every_string)
                    };
                    (name.clone(), item)
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| redact(item, key, every_string))
                .collect(),
        ),
        Value::String(_) if every_string && !key.is_some_and(is_identifier_key) => {
            Value::String(REDACTED.to_string())
        }
        other => other.clone(),
    }
}

fn is_confirmed(confirm: Option<&Value>) -> bool {
    match confirm {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(text)) => {
            let text = text.trim();
            !(text.is_empty() || text == "0" || text.eq_ignore_ascii_case("false"))
        }
        Some(Value::Number(number)) => number.as_f64() != Some(0.0),
        Some(_) => true,
    }
}

fn is_preview(tool_name: &str, tool_input: &Value) -> bool {
    CONFIRM_GATED_TOOLS.contains(&tool_name) && !is_confirmed(tool_input.get("confirm"))
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
    token
        .trim_matches(|c| c == '"' || c == '\'')
        .trim_end_matches('`')
}

fn split_segments(command: &str) -> Vec<&str> {
    command
        .split(|c| matches!(c, ';' | '|' | '&' | '\n' | '\r' | '(' | ')'))
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

fn command_start(tokens: &[&str]) -> usize {
    let mut start = 0;
    while start < tokens.len() {
        let token = tokens[start];
        if is_env_assignment(token)
            || WRAPPER_WORDS.contains(&token)
            || (token.starts_with('-') && start > 0)
        {
            start += 1;
        } else {
            break;
        }
    }
    start
}

fn relocates(segment: &str) -> bool {
    let tokens: Vec<&str> = segment.split_whitespace().map(clean_token).collect();
    let sets_repository = tokens.iter().any(|token| {
        REPOSITORY_VARIABLES
            .iter()
            .any(|variable| token.starts_with(variable))
    });
    sets_repository
        || tokens
            .get(command_start(&tokens))
            .is_some_and(|first| DIRECTORY_WORDS.contains(first))
}

fn is_relocating_git_option(option: &str) -> bool {
    RELOCATING_GIT_OPTIONS.iter().any(|relocating| {
        option == *relocating
            || option
                .strip_prefix(relocating)
                .is_some_and(|rest| rest.starts_with('='))
    })
}

fn is_shell_command_flag(token: &str) -> bool {
    token.starts_with('-') && !token.starts_with("--") && token.ends_with('c')
}

fn strip_branch(target: &str) -> &str {
    let target = target.trim_start_matches('+');
    target.strip_prefix("refs/heads/").unwrap_or(target)
}

fn is_redirection_operator(token: &str) -> bool {
    let rest = token.trim_start_matches(|c: char| c.is_ascii_digit());
    matches!(rest, ">" | ">>" | "<" | ">&" | "&>")
}

fn is_redirection(token: &str) -> bool {
    let rest = token.trim_start_matches(|c: char| c.is_ascii_digit());
    rest.starts_with('>') || rest.starts_with('<') || rest.starts_with("&>") || token.ends_with('>')
}

fn is_unresolvable(target: &str) -> bool {
    target.is_empty() || target.contains('$') || target.contains('`')
}

fn production_label(branch: &str) -> String {
    format!("git push → {branch}")
}

fn classify_git_push(args: &[&str], current_branch: Option<&str>) -> Option<String> {
    let mut positionals: Vec<&str> = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = args[index];
        if arg.starts_with('#') {
            break;
        }
        if is_redirection(arg) {
            index += if is_redirection_operator(arg) { 2 } else { 1 };
            continue;
        }
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
        vec![current().filter(|branch| !is_unresolvable(branch))]
    } else {
        refspecs
            .iter()
            .map(|refspec| {
                let refspec = refspec.trim_start_matches('+');
                let target = match refspec.split_once(':') {
                    Some((_, destination)) => Some(strip_branch(destination).to_string()),
                    None if refspec == "HEAD" => current(),
                    None => Some(strip_branch(refspec).to_string()),
                };
                target.filter(|branch| !is_unresolvable(branch))
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
        cwd: Option<&str>,
        current_branch: Option<&str>,
    ) -> Option<ProductionAction> {
        if tool_name == BASH_TOOL {
            let command = tool_input.get("command").and_then(Value::as_str)?;
            let label = self.classify_command(command, current_branch)?;
            let command = collapse_whitespace(command);
            return Some(ProductionAction {
                label,
                detail: detail_excerpt(&command),
                fingerprint: format!("{tool_name}\0{}\0{command}", cwd.unwrap_or_default()),
            });
        }
        let production = self
            .mcp_patterns
            .iter()
            .any(|regex| regex.is_match(tool_name))
            && !is_preview(tool_name, tool_input);
        if !production {
            return None;
        }
        let redacted = redact(tool_input, None, FULLY_REDACTED_TOOLS.contains(&tool_name));
        Some(ProductionAction {
            label: tool_name.to_string(),
            detail: detail_excerpt(&canonical_json(&redacted)),
            fingerprint: format!("{tool_name}\0{}", canonical_json(tool_input)),
        })
    }

    fn classify_command(&self, command: &str, current_branch: Option<&str>) -> Option<String> {
        let mut branch = current_branch;
        for segment in split_segments(command) {
            if relocates(segment) {
                branch = None;
            }
            let found = self.classify_segment(segment, branch).or_else(|| {
                segment
                    .split('`')
                    .map(str::trim)
                    .filter(|piece| !piece.is_empty() && *piece != segment)
                    .find_map(|piece| self.classify_segment(piece, branch))
            });
            if found.is_some() {
                return found;
            }
        }
        None
    }

    fn classify_segment(&self, segment: &str, current_branch: Option<&str>) -> Option<String> {
        if self.extra_bash.iter().any(|regex| regex.is_match(segment)) {
            return Some(segment.to_string());
        }
        let tokens: Vec<&str> = segment.split_whitespace().map(clean_token).collect();
        let start = command_start(&tokens);
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
            let mut relocated = false;
            while index < tokens.len() && tokens[index].starts_with('-') {
                relocated |= is_relocating_git_option(tokens[index]);
                let takes_value = GIT_GLOBAL_OPTIONS_WITH_VALUE.contains(&tokens[index]);
                index += if takes_value { 2 } else { 1 };
            }
            if tokens.get(index) == Some(&"push") {
                let branch = if relocated { None } else { current_branch };
                return classify_git_push(&tokens[index + 1..], branch);
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
        rules
            .classify(tool, &input, None, branch)
            .map(|action| action.label)
    }

    fn classify_mcp(rules: &ProductionRules, tool: &str, input: Value) -> Option<String> {
        rules
            .classify(tool, &input, None, None)
            .map(|action| action.label)
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
            ("Bash", Some("git push origin 2>&1 | tail -5"), Some("main"), some("git push → main")),
            ("Bash", Some("git push origin 2>/dev/null"), Some("main"), some("git push → main")),
            ("Bash", Some("git push > /tmp/log 2>&1"), Some("main"), some("git push → main")),
            ("Bash", Some("git push origin # comment"), Some("main"), some("git push → main")),
            ("Bash", Some("git push origin feature 2>&1"), Some("main"), None),
            ("Bash", Some("git push origin feature > /tmp/log"), Some("main"), None),
            ("Bash", Some("git push origin feature # main"), Some("main"), None),
            ("Bash", Some("git push -u origin \"$(git branch --show-current)\""), Some("main"), some("git push → ?")),
            ("Bash", Some("git push -u origin \"$(git branch --show-current)\""), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("git push origin $BRANCH"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("git push origin ${BRANCH}"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("git push origin HEAD:$BRANCH"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("git push origin `git branch --show-current`"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("OUT=$(git push origin main)"), None, some("git push → main")),
            ("Bash", Some("`git push origin main`"), None, some("git push → main")),
            ("Bash", Some("echo `git push origin main`"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("OUT=`git push origin main`"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("echo `task release:patch`"), Some("feature/x"), some("task release")),
            ("Bash", Some("` git push origin main`"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("git push origin `git branch --show-current`"), Some("main"), some("git push → ?")),
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
            ("Bash", Some("cd ../other && git push"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("git -C ../other push"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("git -C x push origin feature"), Some("main"), None),
            ("Bash", Some("pushd ../other; git push; popd"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("cd ../other && git push origin HEAD"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("cd ../other && git push origin feature"), Some("main"), None),
            ("Bash", Some("git push && cd ../other"), Some("feature/x"), None),
            ("Bash", Some("git --work-tree=../other push"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("git --git-dir ../other/.git push"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("GIT_DIR=../other/.git git push"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("export GIT_WORK_TREE=../other && git push"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("cd ../other && bash -c 'git push'"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("task build"), None, None),
            ("Bash", Some("git log --oneline"), Some("main"), None),
            ("mcp__bandzior__deployment_deploy", None, None, None),
            ("mcp__bandzior__config_update", None, None, None),
            ("mcp__bandzior__env_vars_set", None, None, None),
            ("mcp__bandzior__deployment_create", None, None, some("mcp__bandzior__deployment_create")),
            ("mcp__bandzior__resource_create", None, None, some("mcp__bandzior__resource_create")),
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
        assert_eq!(rules.classify("Bash", &json!({}), None, Some("main")), None);
    }

    #[test]
    fn bandzior_previews_are_not_production() {
        let rules = ProductionRules::new(&[]);
        let gated = [
            "mcp__bandzior__config_update",
            "mcp__bandzior__resource_update",
            "mcp__bandzior__env_vars_set",
            "mcp__bandzior__deployment_deploy",
            "mcp__bandzior__deployment_version_update",
            "mcp__bandzior__deployment_containers_update",
            "mcp__bandzior__deployment_update",
        ];
        let always = [
            "mcp__bandzior__deployment_create",
            "mcp__bandzior__deployment_rollback",
            "mcp__bandzior__resource_create",
            "mcp__bandzior__resource_delete",
            "mcp__bandzior__secret_create",
        ];
        let previews = [
            json!({}),
            json!({"confirm": false}),
            json!({"confirm": "false"}),
            json!({"confirm": null}),
            json!({"confirm": ""}),
            json!({"confirm": 0}),
        ];
        let confirmed = [
            json!({"confirm": true, "change_id": "c1"}),
            json!({"confirm": "true"}),
            json!({"confirm": "TRUE"}),
            json!({"confirm": 1}),
            json!({"confirm": "yes"}),
        ];
        for tool in gated {
            for input in &previews {
                assert_eq!(
                    classify_mcp(&rules, tool, input.clone()),
                    None,
                    "{tool} {input}"
                );
            }
            for input in &confirmed {
                assert_eq!(
                    classify_mcp(&rules, tool, input.clone()),
                    Some(tool.to_string()),
                    "{tool} {input}"
                );
            }
        }
        for tool in always {
            for input in previews.iter().chain(confirmed.iter()) {
                assert_eq!(
                    classify_mcp(&rules, tool, input.clone()),
                    Some(tool.to_string()),
                    "{tool} {input}"
                );
            }
        }
        assert_eq!(
            classify_mcp(
                &rules,
                "mcp__bandzior__project_find",
                json!({"confirm": true})
            ),
            None
        );
    }

    #[test]
    fn actions_carry_exact_fingerprint_and_detail() {
        let rules = ProductionRules::new(&[]);
        let bash = |command: &str, cwd: Option<&str>| {
            rules
                .classify("Bash", &json!({ "command": command }), cwd, Some("main"))
                .expect("production")
        };
        let push = bash("git push origin main", Some("/repo"));
        assert_eq!(push.label, "git push → main");
        assert_eq!(push.detail, "git push origin main");
        assert_eq!(
            bash("  git   push\torigin main ", Some("/repo")).fingerprint,
            push.fingerprint
        );
        assert_ne!(
            bash("git push origin main", Some("/other")).fingerprint,
            push.fingerprint
        );
        assert_ne!(
            bash("git push origin main", None).fingerprint,
            push.fingerprint
        );
        assert_ne!(
            bash("git push --force origin main", Some("/repo")).fingerprint,
            push.fingerprint
        );
        assert_ne!(
            bash("git push", Some("/repo")).fingerprint,
            push.fingerprint
        );

        let deploy = |input: Value| {
            rules
                .classify(
                    "mcp__bandzior__deployment_deploy",
                    &input,
                    Some("/repo"),
                    None,
                )
                .expect("production")
        };
        let first = deploy(json!({"confirm": true, "change_id": "c1", "spec": {"b": 2, "a": 1}}));
        let reordered =
            deploy(json!({"spec": {"a": 1, "b": 2}, "change_id": "c1", "confirm": true}));
        assert_eq!(first.fingerprint, reordered.fingerprint);
        assert_eq!(
            first.detail,
            r#"{"change_id":"c1","confirm":true,"spec":{"a":1,"b":2}}"#
        );
        assert_eq!(first.label, "mcp__bandzior__deployment_deploy");
        assert_ne!(
            deploy(json!({"confirm": true, "change_id": "c2", "spec": {"a": 1, "b": 2}}))
                .fingerprint,
            first.fingerprint
        );
        assert_ne!(
            rules
                .classify(
                    "mcp__bandzior__deployment_update",
                    &json!({"confirm": true, "change_id": "c1", "spec": {"a": 1, "b": 2}}),
                    Some("/repo"),
                    None
                )
                .unwrap()
                .fingerprint,
            first.fingerprint
        );
        assert_eq!(
            deploy(json!({"confirm": true, "change_id": "c1"})).fingerprint,
            rules
                .classify(
                    "mcp__bandzior__deployment_deploy",
                    &json!({"change_id": "c1", "confirm": true}),
                    Some("/elsewhere"),
                    None
                )
                .unwrap()
                .fingerprint
        );
    }

    #[test]
    fn mcp_detail_redacts_secrets_but_fingerprint_keeps_them() {
        let rules = ProductionRules::new(&[]);
        let action = |tool: &str, input: Value| {
            rules
                .classify(tool, &input, None, None)
                .expect("production")
        };
        let env = action(
            "mcp__bandzior__env_vars_set",
            json!({"deployment_id": 5, "vars": {"API_KEY": "abc"}, "confirm": true}),
        );
        assert!(!env.detail.contains("abc"), "{}", env.detail);
        assert!(
            env.detail.contains(r#""deployment_id":5"#),
            "{}",
            env.detail
        );
        assert!(env.detail.contains(r#""API_KEY":"***""#), "{}", env.detail);
        assert_ne!(
            action(
                "mcp__bandzior__env_vars_set",
                json!({"deployment_id": 5, "vars": {"API_KEY": "abd"}, "confirm": true}),
            )
            .fingerprint,
            env.fingerprint
        );
        let plain = action(
            "mcp__bandzior__env_vars_set",
            json!({"name": "web", "vars": {"LOG_LEVEL": "debug"}, "confirm": "true"}),
        );
        assert_eq!(
            plain.detail,
            r#"{"confirm":"***","name":"web","vars":{"LOG_LEVEL":"***"}}"#
        );
        let secret = action(
            "mcp__bandzior__secret_create",
            json!({
                "namespace": "cs-app-x",
                "name": "db",
                "project_id": "p-1",
                "note": "plain",
                "items": [{"password": "p4ss"}, "loose"]
            }),
        );
        assert_eq!(
            secret.detail,
            r#"{"items":[{"password":"***"},"***"],"name":"db","namespace":"cs-app-x","note":"***","project_id":"p-1"}"#
        );
        let create = action(
            "mcp__bandzior__deployment_create",
            json!({
                "project": "shop",
                "image": "nginx:1.27",
                "Environment": {"A": "1"},
                "auth_token": "t0k",
                "nested": [{"secret_value": "s3"}, {"Data": [1, 2]}],
                "replicas": 2
            }),
        );
        assert_eq!(
            create.detail,
            r#"{"Environment":"***","auth_token":"***","image":"nginx:1.27","nested":[{"secret_value":"***"},{"Data":"***"}],"project":"shop","replicas":2}"#
        );
        let bash = rules
            .classify(
                "Bash",
                &json!({"command": "API_KEY=abc task release"}),
                None,
                None,
            )
            .expect("production");
        assert_eq!(bash.detail, "API_KEY=abc task release");
    }

    #[test]
    fn detail_is_capped_on_a_char_boundary() {
        let rules = ProductionRules::new(&[]);
        let long = format!("git push origin main # {}", "ż".repeat(400));
        let action = rules
            .classify("Bash", &json!({ "command": long }), None, Some("main"))
            .expect("production");
        assert_eq!(action.detail.chars().count(), 300);
        assert!(action.detail.ends_with('…'));
        assert!(action.detail.starts_with("git push origin main # ż"));
    }
}
