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
const BASH_DETAIL_CHARS: usize = 1000;
const MCP_DETAIL_CHARS: usize = 300;
const LINE_BREAK: &str = " ⏎ ";
const LABEL_SEPARATOR: &str = " + ";

const PRODUCTION_BRANCHES: &[&str] = &["main", "master"];
const SHELL_KEYWORDS: &[&str] = &[
    "if", "then", "else", "elif", "do", "while", "until", "!", "{", "(",
];

struct Wrapper {
    name: &'static str,
    value_options: &'static [&'static str],
    relocating_options: &'static [&'static str],
    positional_arguments: usize,
    appends_arguments: bool,
}

const fn wrapper(name: &'static str, value_options: &'static [&'static str]) -> Wrapper {
    Wrapper {
        name,
        value_options,
        relocating_options: &[],
        positional_arguments: 0,
        appends_arguments: false,
    }
}

const WRAPPERS: &[Wrapper] = &[
    Wrapper {
        relocating_options: &["-D", "--chdir"],
        ..wrapper(
            "sudo",
            &[
                "-u",
                "-g",
                "-U",
                "-C",
                "-p",
                "-r",
                "-t",
                "-D",
                "-T",
                "-h",
                "--user",
                "--group",
                "--other-user",
                "--close-from",
                "--prompt",
                "--role",
                "--type",
                "--chdir",
                "--command-timeout",
                "--host",
            ],
        )
    },
    Wrapper {
        relocating_options: &["-C", "--chdir"],
        ..wrapper("env", &["-u", "--unset", "-C", "--chdir"])
    },
    Wrapper {
        positional_arguments: 1,
        ..wrapper("timeout", &["-s", "--signal", "-k", "--kill-after"])
    },
    wrapper("nice", &["-n", "--adjustment"]),
    wrapper("nohup", &[]),
    wrapper("command", &[]),
    wrapper("builtin", &[]),
    wrapper("exec", &["-a"]),
    wrapper(
        "stdbuf",
        &["-i", "-o", "-e", "--input", "--output", "--error"],
    ),
    wrapper("time", &["-f", "-o", "--format", "--output"]),
    Wrapper {
        appends_arguments: true,
        ..wrapper(
            "xargs",
            &[
                "-a",
                "-d",
                "-E",
                "-I",
                "-L",
                "-n",
                "-P",
                "-s",
                "--arg-file",
                "--delimiter",
                "--eof",
                "--replace",
                "--max-lines",
                "--max-args",
                "--max-procs",
                "--max-chars",
            ],
        )
    },
];

#[derive(Default)]
struct CommandPrefix {
    start: usize,
    relocated: bool,
    appends_arguments: bool,
}
const SHELL_WORDS: &[&str] = &["bash", "sh", "zsh", "dash"];
const GIT_GLOBAL_OPTIONS_WITH_VALUE: &[&str] =
    &["-C", "-c", "--git-dir", "--work-tree", "--namespace"];
const RELOCATING_GIT_OPTIONS: &[&str] = &["-C", "--git-dir", "--work-tree"];
const DIRECTORY_WORDS: &[&str] = &["cd", "pushd", "popd", "source", "."];
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

fn detail_excerpt(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let kept: String = text.chars().take(limit - 1).collect();
    format!("{kept}…")
}

fn bash_detail(command: &str) -> String {
    let lines: Vec<String> = command
        .split(['\n', '\r'])
        .map(collapse_whitespace)
        .filter(|line| !line.is_empty())
        .collect();
    detail_excerpt(&lines.join(LINE_BREAK), BASH_DETAIL_CHARS)
}

fn push_distinct(labels: &mut Vec<String>, found: Vec<String>) {
    for label in found {
        if !labels.contains(&label) {
            labels.push(label);
        }
    }
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

fn command_prefix(tokens: &[&str]) -> CommandPrefix {
    let mut prefix = CommandPrefix::default();
    let mut index = 0;
    while let Some(&token) = tokens.get(index) {
        if SHELL_KEYWORDS.contains(&token) || is_env_assignment(token) {
            index += 1;
            continue;
        }
        let Some(wrapper) = WRAPPERS.iter().find(|wrapper| wrapper.name == token) else {
            break;
        };
        index += 1;
        prefix.appends_arguments |= wrapper.appends_arguments;
        while let Some(&option) = tokens.get(index).filter(|option| option.starts_with('-')) {
            index += 1;
            if option == "--" {
                break;
            }
            let name = option.split_once('=').map_or(option, |(name, _)| name);
            prefix.relocated |= wrapper.relocating_options.contains(&name);
            if !option.contains('=') && wrapper.value_options.contains(&option) {
                index += 1;
            }
        }
        index += wrapper.positional_arguments;
    }
    prefix.start = index.min(tokens.len());
    prefix
}

fn relocates(segment: &str) -> bool {
    let tokens: Vec<&str> = segment.split_whitespace().map(clean_token).collect();
    let sets_repository = tokens.iter().any(|token| {
        REPOSITORY_VARIABLES
            .iter()
            .any(|variable| token.starts_with(variable))
    });
    if sets_repository {
        return true;
    }
    let prefix = command_prefix(&tokens);
    if prefix.relocated {
        return true;
    }
    match tokens.get(prefix.start).copied() {
        Some("eval") => relocates(&tokens[prefix.start + 1..].join(" ")),
        Some(first) => DIRECTORY_WORDS.contains(&first),
        None => false,
    }
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
    target.is_empty() || target.contains(['$', '`', '*', '{', '}'])
}

fn production_label(branch: &str) -> String {
    format!("git push → {branch}")
}

fn classify_git_push(
    args: &[&str],
    current_branch: Option<&str>,
    appends_arguments: bool,
) -> Option<String> {
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
        if arg == "--all" || arg == "--mirror" || arg == "--branches" {
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
    let mut targets: Vec<Option<String>> = if refspecs.is_empty() {
        vec![current().filter(|branch| !is_unresolvable(branch))]
    } else {
        refspecs
            .iter()
            .map(|refspec| {
                let refspec = refspec.trim_start_matches('+');
                let target = match refspec.split_once(':') {
                    Some((_, destination)) => Some(strip_branch(destination).to_string()),
                    None if refspec == "HEAD" || refspec == "@" => current(),
                    None => Some(strip_branch(refspec).to_string()),
                };
                target.filter(|branch| !is_unresolvable(branch))
            })
            .collect()
    };
    if appends_arguments {
        targets.push(None);
    }
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
            let labels = self.command_labels(command, current_branch);
            if labels.is_empty() {
                return None;
            }
            return Some(ProductionAction {
                label: labels.join(LABEL_SEPARATOR),
                detail: bash_detail(command),
                fingerprint: format!(
                    "{tool_name}\0{}\0{}",
                    cwd.unwrap_or_default(),
                    collapse_whitespace(command)
                ),
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
            detail: detail_excerpt(&canonical_json(&redacted), MCP_DETAIL_CHARS),
            fingerprint: format!("{tool_name}\0{}", canonical_json(tool_input)),
        })
    }

    fn command_labels(&self, command: &str, current_branch: Option<&str>) -> Vec<String> {
        let mut labels = Vec::new();
        let mut branch = current_branch;
        for segment in split_segments(command) {
            if relocates(segment) {
                branch = None;
            }
            let mut found = self.classify_segment(segment, branch);
            if found.is_empty() {
                for piece in segment
                    .split('`')
                    .map(str::trim)
                    .filter(|piece| !piece.is_empty() && *piece != segment)
                {
                    push_distinct(&mut found, self.classify_segment(piece, branch));
                }
            }
            push_distinct(&mut labels, found);
        }
        labels
    }

    fn classify_segment(&self, segment: &str, current_branch: Option<&str>) -> Vec<String> {
        if self.extra_bash.iter().any(|regex| regex.is_match(segment)) {
            return vec![segment.to_string()];
        }
        let tokens: Vec<&str> = segment.split_whitespace().map(clean_token).collect();
        let prefix = command_prefix(&tokens);
        let start = prefix.start;
        let tokens = &tokens[start..];
        let current_branch = if prefix.relocated {
            None
        } else {
            current_branch
        };
        let Some(first) = tokens.first().copied() else {
            return Vec::new();
        };
        let stripped = tokens.join(" ");
        if start > 0 && self.extra_bash.iter().any(|regex| regex.is_match(&stripped)) {
            return vec![stripped];
        }
        if first == "eval" {
            return self.command_labels(&tokens[1..].join(" "), current_branch);
        }
        if SHELL_WORDS.contains(&first) {
            return match tokens.iter().position(|t| is_shell_command_flag(t)) {
                Some(position) => {
                    self.command_labels(&tokens[position + 1..].join(" "), current_branch)
                }
                None => Vec::new(),
            };
        }
        if self.task_release.is_match(&stripped) {
            return vec!["task release".to_string()];
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
                return classify_git_push(&tokens[index + 1..], branch, prefix.appends_arguments)
                    .into_iter()
                    .collect();
            }
        }
        Vec::new()
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
            ("Bash", Some("if git push origin main; then echo ok; fi"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("true; then git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("{ git push origin main; }"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("! git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("while true; do git push origin main; done"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("until false; do git push origin main; done"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("if true; then echo; else git push origin main; fi"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("if false; then :; elif git push origin main; then :; fi"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("time git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("time -p git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("timeout 60 git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("timeout -s KILL 60 git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("timeout --kill-after=5 60s git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("sudo -u root git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("sudo -g staff -u root git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("sudo --user=root git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("nice -n 10 git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("nice -10 git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("env -u X git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("env -u X FOO=1 git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("nohup git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("command git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("exec git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("exec -a pusher git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("stdbuf -oL git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("stdbuf -o L git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("stdbuf -i0 -e L git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("sudo -u root timeout 60 nice -n 5 git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("xargs -n 1 git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("git push origin @:main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("{ cd ../other; git push; }"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("builtin cd ../other && git push"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("eval cd ../other; git push"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("source env.sh && git push"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some(". ./env.sh; git push"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("env -C ../other git push"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("sudo -D ../other git push"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("git push origin :"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("git push origin +:"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("git push origin 'refs/heads/*:refs/heads/*'"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("git push origin +refs/heads/*:refs/heads/*"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("git push origin 'refs/heads/*'"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("git push --branches"), Some("feature/x"), some("git push → --branches")),
            ("Bash", Some("git push origin @"), Some("main"), some("git push → main")),
            ("Bash", Some("git push origin @"), Some("feature/x"), None),
            ("Bash", Some("timeout 60 git push origin feature"), Some("main"), None),
            ("Bash", Some("sudo -u root git push"), Some("main"), some("git push → main")),
            ("Bash", Some("xargs git push origin feature"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("echo main | xargs git push origin"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("xargs -I {} git push origin {}"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("env - git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("sudo -- git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("command -v git"), Some("main"), None),
            ("Bash", Some("time npm test"), Some("main"), None),
            ("Bash", Some("if [ -f x ]; then echo done; fi"), Some("main"), None),
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
        let failures: Vec<String> = cases
            .into_iter()
            .filter_map(|(tool, command, branch, expected)| {
                let actual = label(tool, command, branch, &rules);
                (actual != expected).then(|| {
                    format!("{tool} {command:?} on {branch:?}: got {actual:?}, want {expected:?}")
                })
            })
            .collect();
        assert!(failures.is_empty(), "\n{}", failures.join("\n"));
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
        let long = format!("git push origin main # {}", "ż".repeat(1200));
        let action = rules
            .classify("Bash", &json!({ "command": long }), None, Some("main"))
            .expect("production");
        assert_eq!(action.detail.chars().count(), 1000);
        assert!(action.detail.ends_with('…'));
        assert!(action.detail.starts_with("git push origin main # ż"));
        let arguments = json!({"project": "x".repeat(600), "confirm": "c1"});
        let deploy = rules
            .classify("mcp__bandzior__deployment_deploy", &arguments, None, None)
            .expect("production");
        assert_eq!(deploy.detail.chars().count(), 300);
        assert!(deploy.detail.ends_with('…'));
    }

    #[test]
    fn label_names_every_production_segment_and_detail_shows_line_breaks() {
        let rules = ProductionRules::new(&[]);
        let classify = |command: &str| {
            rules
                .classify("Bash", &json!({ "command": command }), Some("/repo"), Some("feature/x"))
                .expect("production")
        };
        let hidden = classify("task release # bump\ngit push --force origin main");
        assert_eq!(hidden.label, "task release + git push → main");
        assert_eq!(
            hidden.detail,
            "task release # bump ⏎ git push --force origin main"
        );
        let padded = classify(&format!(
            "task release # {}\r\n\n  git push --force origin main",
            "x".repeat(400)
        ));
        assert_eq!(padded.label, "task release + git push → main");
        assert!(padded
            .detail
            .ends_with(" ⏎ git push --force origin main"));
        assert_eq!(
            classify("git push origin main && git push origin main; task release").label,
            "git push → main + task release"
        );
        assert_eq!(
            classify("git push origin master; git push origin main").label,
            "git push → master + git push → main"
        );
        assert_eq!(
            classify("bash -c 'task release && git push origin main'").label,
            "task release + git push → main"
        );
    }
}
