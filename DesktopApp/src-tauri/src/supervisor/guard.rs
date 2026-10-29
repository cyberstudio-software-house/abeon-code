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

const MAX_NESTING: usize = 8;
const UNRESOLVED_TARGET: &str = "?";
const GIT_PUSH_LABEL: &str = "git push";
const TASK_RELEASE_LABEL: &str = "task release";
const MERGE_LABEL: &str = "merge PR";
const RULE_LABEL: &str = "reguła";
const GIT_PROGRAM: &str = "git";
const PUSH_COMMAND: &str = "push";
const EVAL_WORD: &str = "eval";
const TASK_PROGRAM: &str = "task";
const TASK_RELEASE_PREFIX: &str = "release";
const TASK_OPTIONS_WITH_VALUE: &[&str] = &[
    "-d",
    "--dir",
    "-t",
    "--taskfile",
    "-o",
    "--output",
    "-C",
    "--concurrency",
    "-I",
    "--interval",
    "--sort",
    "--output-group-begin",
    "--output-group-end",
];
const MERGE_PROGRAMS: &[&str] = &["gh", "bkt"];
const MERGE_SUBCOMMAND: [&str; 2] = ["pr", "merge"];
const STDIN_SCRIPT_FLAG: &str = "-s";
const HERE_DOCUMENT: &str = "<<";

const PRODUCTION_BRANCHES: &[&str] = &["main", "master"];
const SHELL_KEYWORDS: &[&str] = &[
    "if", "then", "else", "elif", "do", "while", "until", "!", "{", "(",
];

struct Wrapper {
    name: &'static str,
    value_options: &'static [&'static str],
    relocating_options: &'static [&'static str],
    script_options: &'static [&'static str],
    positional_arguments: usize,
    appends_arguments: bool,
}

const fn wrapper(name: &'static str, value_options: &'static [&'static str]) -> Wrapper {
    Wrapper {
        name,
        value_options,
        relocating_options: &[],
        script_options: &[],
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
        script_options: &["-S", "--split-string"],
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
    wrapper("setsid", &[]),
    wrapper("doas", &["-u", "-C", "-a"]),
    wrapper(
        "ionice",
        &[
            "-c",
            "--class",
            "-n",
            "--classdata",
            "-p",
            "--pid",
            "-P",
            "--pgid",
            "-u",
            "--uid",
        ],
    ),
    Wrapper {
        positional_arguments: 1,
        script_options: &["-c", "--command"],
        ..wrapper(
            "flock",
            &["-w", "--wait", "--timeout", "-E", "--conflict-exit-code"],
        )
    },
    Wrapper {
        relocating_options: &["--working-directory"],
        ..wrapper(
            "systemd-run",
            &[
                "-u",
                "--unit",
                "-p",
                "--property",
                "--description",
                "--slice",
                "-E",
                "--setenv",
                "--uid",
                "--gid",
                "--nice",
                "-M",
                "--machine",
                "-H",
                "--host",
                "--service-type",
                "--working-directory",
                "--on-active",
                "--on-boot",
                "--on-startup",
                "--on-unit-active",
                "--on-unit-inactive",
                "--on-calendar",
                "--timer-property",
                "--path-property",
                "--socket-property",
            ],
        )
    },
];

struct Interpreter {
    name: &'static str,
    script_letters: &'static str,
    script_options: &'static [&'static str],
    attached_script: bool,
}

const INTERPRETERS: &[Interpreter] = &[
    Interpreter {
        name: "python",
        script_letters: "c",
        script_options: &[],
        attached_script: true,
    },
    Interpreter {
        name: "node",
        script_letters: "ep",
        script_options: &["--eval", "--print"],
        attached_script: false,
    },
    Interpreter {
        name: "nodejs",
        script_letters: "ep",
        script_options: &["--eval", "--print"],
        attached_script: false,
    },
    Interpreter {
        name: "perl",
        script_letters: "eE",
        script_options: &[],
        attached_script: true,
    },
    Interpreter {
        name: "ruby",
        script_letters: "e",
        script_options: &[],
        attached_script: true,
    },
];

#[derive(Default)]
struct Classified {
    labels: Vec<String>,
    relocates: bool,
}

impl Classified {
    fn labels(labels: Vec<String>) -> Classified {
        Classified {
            labels,
            relocates: false,
        }
    }

    fn label(label: String) -> Classified {
        Classified::labels(vec![label])
    }
}

#[derive(Default)]
struct CommandPrefix {
    start: usize,
    relocated: bool,
    appends_arguments: bool,
    script: Option<String>,
}

impl CommandPrefix {
    fn with_script(mut self, script: Option<&str>, length: usize) -> CommandPrefix {
        self.start = length;
        self.script = script.map(str::to_string);
        self
    }
}

const SHELL_WORDS: &[&str] = &["bash", "sh", "zsh", "dash", "ksh"];
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
    mcp_patterns: Vec<Regex>,
    extra_bash: Vec<Regex>,
}

fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn command_fingerprint(command: &str) -> String {
    command
        .split(['\n', '\r'])
        .map(collapse_whitespace)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
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

fn redact_entries(
    map: &serde_json::Map<String, Value>,
    every_string: bool,
    keeps_identifiers: bool,
) -> Value {
    Value::Object(
        map.iter()
            .map(|(name, item)| {
                let item = if is_sensitive_key(name) {
                    Value::String(REDACTED.to_string())
                } else if keeps_identifiers && item.is_string() && is_identifier_key(name) {
                    item.clone()
                } else {
                    redact(item, every_string)
                };
                (name.clone(), item)
            })
            .collect(),
    )
}

fn redact(value: &Value, every_string: bool) -> Value {
    match value {
        Value::Object(map) => redact_entries(map, every_string, false),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| redact(item, every_string))
                .collect(),
        ),
        Value::String(_) if every_string => Value::String(REDACTED.to_string()),
        other => other.clone(),
    }
}

fn redact_arguments(arguments: &Value, every_string: bool) -> Value {
    match arguments {
        Value::Object(map) => redact_entries(map, every_string, true),
        other => redact(other, every_string),
    }
}

fn is_confirmed(confirm: Option<&Value>) -> bool {
    match confirm {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(text)) => {
            let text = text.trim();
            !(text.is_empty() || text.eq_ignore_ascii_case("false"))
        }
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

fn join_continuations(command: &str) -> String {
    command.replace("\\\r\n", "").replace("\\\n", "")
}

fn shell_words(segment: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut in_word = false;
    let mut chars = segment.chars();
    while let Some(character) = chars.next() {
        match character {
            '\'' => {
                in_word = true;
                for quoted in chars.by_ref() {
                    if quoted == '\'' {
                        break;
                    }
                    word.push(quoted);
                }
            }
            '"' => {
                in_word = true;
                while let Some(quoted) = chars.next() {
                    match quoted {
                        '"' => break,
                        '\\' => match chars.next() {
                            Some(escaped @ ('"' | '\\' | '$' | '`')) => word.push(escaped),
                            Some(other) => {
                                word.push('\\');
                                word.push(other);
                            }
                            None => word.push('\\'),
                        },
                        other => word.push(other),
                    }
                }
            }
            '\\' => {
                in_word = true;
                if let Some(escaped) = chars.next() {
                    word.push(escaped);
                }
            }
            blank if blank.is_whitespace() => {
                if in_word {
                    words.push(std::mem::take(&mut word));
                    in_word = false;
                }
            }
            other => {
                in_word = true;
                word.push(other);
            }
        }
    }
    if in_word {
        words.push(word);
    }
    words
        .into_iter()
        .map(|word| word.trim_end_matches('`').to_string())
        .collect()
}

fn program_name(token: &str) -> &str {
    token.rsplit('/').next().unwrap_or(token)
}

fn is_segment_separator(character: char) -> bool {
    matches!(character, ';' | '|' | '&' | '\n' | '\r' | '(' | ')')
}

fn split_segments(command: &str) -> Vec<&str> {
    command
        .split(is_segment_separator)
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .collect()
}

fn quoted_segments(command: &str) -> Vec<&str> {
    let mut segments = Vec::new();
    let mut start = 0;
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for (index, character) in command.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match (quote, character) {
            (Some('\''), '\'') => quote = None,
            (Some('\''), _) => {}
            (_, '\\') => escaped = true,
            (Some(open), close) if open == close => quote = None,
            (Some(_), _) => {}
            (None, '\'' | '"') => quote = Some(character),
            (None, separator) if is_segment_separator(separator) => {
                segments.push(command[start..index].trim());
                start = index + separator.len_utf8();
            }
            (None, _) => {}
        }
    }
    segments.push(command[start..].trim());
    segments.retain(|segment| !segment.is_empty());
    segments
}

fn attached_value<'a>(option: &'a str, names: &[&str]) -> Option<&'a str> {
    if let Some((name, value)) = option.split_once('=') {
        if name.starts_with("--") && names.contains(&name) {
            return Some(value);
        }
    }
    if option.starts_with("--") || option.len() <= 2 {
        return None;
    }
    option
        .get(..2)
        .filter(|short| names.contains(short))
        .and_then(|_| option.get(2..))
}

fn is_version_of(program: &str, name: &str) -> bool {
    program.strip_prefix(name).is_some_and(|version| {
        version
            .chars()
            .all(|character| character.is_ascii_digit() || character == '.')
    })
}

fn interpreter(program: &str) -> Option<&'static Interpreter> {
    INTERPRETERS
        .iter()
        .find(|interpreter| is_version_of(program, interpreter.name))
}

fn short_script<'a>(argument: &'a str, interpreter: &Interpreter) -> Option<&'a str> {
    let cluster = argument
        .strip_prefix('-')
        .filter(|cluster| !cluster.starts_with('-'))?;
    let position = cluster.find(|letter| interpreter.script_letters.contains(letter))?;
    cluster.get(position + 1..)
}

fn interpreter_scripts(command: &[&str]) -> Option<Vec<String>> {
    let interpreter = interpreter(program_name(command.first()?))?;
    let mut scripts = Vec::new();
    let mut arguments = command[1..].iter().copied();
    while let Some(argument) = arguments.next() {
        if let Some(script) = attached_value(argument, interpreter.script_options) {
            scripts.push(script.to_string());
            continue;
        }
        let attached = if interpreter.script_options.contains(&argument) {
            ""
        } else {
            match short_script(argument, interpreter) {
                Some(attached) => attached,
                None => continue,
            }
        };
        if interpreter.attached_script && !attached.is_empty() {
            scripts.push(attached.to_string());
        } else if let Some(script) = arguments.next() {
            scripts.push(script.to_string());
        }
    }
    Some(scripts)
}

fn neutralize_quotes(script: &str) -> String {
    script
        .chars()
        .map(|character| {
            if matches!(character, '\'' | '"' | '`' | '\\') {
                ' '
            } else {
                character
            }
        })
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

fn option_matches(option: &str, names: &[&str]) -> bool {
    let name = option.split_once('=').map_or(option, |(name, _)| name);
    if names.contains(&name) {
        return true;
    }
    !option.starts_with("--")
        && option.len() > 2
        && option.get(..2).is_some_and(|short| names.contains(&short))
}

fn command_prefix(tokens: &[&str]) -> CommandPrefix {
    let mut prefix = CommandPrefix::default();
    let mut index = 0;
    while let Some(&token) = tokens.get(index) {
        if SHELL_KEYWORDS.contains(&token) || is_env_assignment(token) {
            index += 1;
            continue;
        }
        let name = program_name(token);
        let Some(wrapper) = WRAPPERS.iter().find(|wrapper| wrapper.name == name) else {
            break;
        };
        index += 1;
        prefix.appends_arguments |= wrapper.appends_arguments;
        while let Some(&option) = tokens.get(index).filter(|option| option.starts_with('-')) {
            if wrapper.script_options.contains(&option) {
                return prefix.with_script(tokens.get(index + 1).copied(), tokens.len());
            }
            if let Some(script) = attached_value(option, wrapper.script_options) {
                return prefix.with_script(Some(script), tokens.len());
            }
            index += 1;
            if option == "--" {
                break;
            }
            prefix.relocated |= option_matches(option, wrapper.relocating_options);
            if !option.contains('=') && wrapper.value_options.contains(&option) {
                index += 1;
            }
        }
        index += wrapper.positional_arguments;
        if tokens
            .get(index)
            .is_some_and(|token| wrapper.script_options.contains(token))
        {
            return prefix.with_script(tokens.get(index + 1).copied(), tokens.len());
        }
    }
    prefix.start = index.min(tokens.len());
    prefix
}

fn shell_script(tokens: &[&str]) -> Option<String> {
    let position = tokens
        .iter()
        .position(|token| is_shell_command_flag(token))?;
    Some(tokens[position + 1..].join(" "))
}

fn relocates_directly(tokens: &[&str], prefix: &CommandPrefix) -> bool {
    let sets_repository = tokens.iter().any(|token| {
        REPOSITORY_VARIABLES
            .iter()
            .any(|variable| token.starts_with(variable))
    });
    sets_repository
        || prefix.relocated
        || tokens
            .get(prefix.start)
            .is_some_and(|first| DIRECTORY_WORDS.contains(first))
}

fn reads_script_from_stdin(command: &[&str]) -> bool {
    if !command.first().is_some_and(|first| {
        let program = program_name(first);
        SHELL_WORDS.contains(&program) || interpreter(program).is_some()
    }) {
        return false;
    }
    let mut index = 1;
    while let Some(&token) = command.get(index) {
        if is_shell_command_flag(token) {
            return false;
        }
        if token == STDIN_SCRIPT_FLAG || token.starts_with(HERE_DOCUMENT) {
            return true;
        }
        if is_redirection(token) {
            index += if is_redirection_operator(token) { 2 } else { 1 };
            continue;
        }
        if !token.starts_with('-') {
            return false;
        }
        index += 1;
    }
    true
}

fn mentions_git_push(text: &str) -> bool {
    let words: Vec<&str> = text
        .split(|character: char| {
            !(character.is_alphanumeric() || matches!(character, '-' | '_' | '.' | '/'))
        })
        .filter(|word| !word.is_empty())
        .collect();
    words
        .iter()
        .position(|word| program_name(word) == GIT_PROGRAM)
        .is_some_and(|index| words[index + 1..].contains(&PUSH_COMMAND))
}

fn calls_git_push_indirectly(tokens: &[&str], start: usize) -> bool {
    tokens
        .iter()
        .enumerate()
        .position(|(index, token)| index != start && program_name(token) == GIT_PROGRAM)
        .is_some_and(|index| tokens[index + 1..].contains(&PUSH_COMMAND))
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
    format!("{GIT_PUSH_LABEL} → {branch}")
}

fn runs_task_release(arguments: &[&str]) -> bool {
    let mut index = 0;
    while let Some(&argument) = arguments.get(index) {
        if argument == "--" || argument.starts_with('#') {
            return false;
        }
        if argument.starts_with('-') {
            index += if TASK_OPTIONS_WITH_VALUE.contains(&argument) {
                2
            } else {
                1
            };
            continue;
        }
        if argument.starts_with(TASK_RELEASE_PREFIX) {
            return true;
        }
        index += 1;
    }
    false
}

fn merges_pull_request(arguments: &[&str]) -> bool {
    arguments
        .windows(2)
        .any(|pair| pair == MERGE_SUBCOMMAND.as_slice())
}

fn classify_git(
    arguments: &[&str],
    current_branch: Option<&str>,
    appends_arguments: bool,
) -> Option<String> {
    let mut index = 0;
    let mut relocated = false;
    while index < arguments.len() && arguments[index].starts_with('-') {
        relocated |= is_relocating_git_option(arguments[index]);
        let takes_value = GIT_GLOBAL_OPTIONS_WITH_VALUE.contains(&arguments[index]);
        index += if takes_value { 2 } else { 1 };
    }
    if arguments.get(index) != Some(&PUSH_COMMAND) {
        return None;
    }
    let branch = if relocated { None } else { current_branch };
    classify_git_push(&arguments[index + 1..], branch, appends_arguments)
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
        None => Some(production_label(UNRESOLVED_TARGET)),
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
            let labels = self.command_labels(command, current_branch, 0).labels;
            if labels.is_empty() {
                return None;
            }
            return Some(ProductionAction {
                label: labels.join(LABEL_SEPARATOR),
                detail: bash_detail(command),
                fingerprint: format!(
                    "{tool_name}\0{}\0{}",
                    cwd.unwrap_or_default(),
                    command_fingerprint(command)
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
        let redacted = redact_arguments(tool_input, FULLY_REDACTED_TOOLS.contains(&tool_name));
        Some(ProductionAction {
            label: tool_name.to_string(),
            detail: detail_excerpt(&canonical_json(&redacted), MCP_DETAIL_CHARS),
            fingerprint: format!("{tool_name}\0{}", canonical_json(tool_input)),
        })
    }

    fn command_labels(
        &self,
        command: &str,
        current_branch: Option<&str>,
        depth: usize,
    ) -> Classified {
        if depth > MAX_NESTING {
            let labels = if mentions_git_push(command) {
                vec![production_label(UNRESOLVED_TARGET)]
            } else {
                Vec::new()
            };
            return Classified {
                labels,
                relocates: true,
            };
        }
        let command = join_continuations(command);
        let mut labels = Vec::new();
        let mut branch = current_branch;
        let mut relocated = false;
        let mut feeds_shell = false;
        for segment in split_segments(&command) {
            let words = shell_words(segment);
            let tokens: Vec<&str> = words.iter().map(String::as_str).collect();
            let prefix = command_prefix(&tokens);
            if relocates_directly(&tokens, &prefix) {
                branch = None;
                relocated = true;
            }
            feeds_shell |= reads_script_from_stdin(&tokens[prefix.start..]);
            let classified = self.classify_tokens(segment, &tokens, &prefix, branch, depth);
            let mut found = classified.labels;
            if classified.relocates {
                branch = None;
                relocated = true;
            }
            if found.is_empty() {
                for piece in segment
                    .split('`')
                    .map(str::trim)
                    .filter(|piece| !piece.is_empty() && *piece != segment)
                {
                    push_distinct(
                        &mut found,
                        self.classify_segment(piece, branch, depth + 1).labels,
                    );
                }
            }
            if found.is_empty() && calls_git_push_indirectly(&tokens, prefix.start) {
                found.push(production_label(UNRESOLVED_TARGET));
            }
            push_distinct(&mut labels, found);
        }
        let unsplit_branch = if relocated { None } else { current_branch };
        for segment in quoted_segments(&command)
            .into_iter()
            .filter(|segment| segment.contains(is_segment_separator))
        {
            push_distinct(
                &mut labels,
                self.classify_segment(segment, unsplit_branch, depth).labels,
            );
        }
        let pushes = labels.iter().any(|label| label.starts_with(GIT_PUSH_LABEL));
        if feeds_shell && !pushes && mentions_git_push(&command) {
            labels.push(production_label(UNRESOLVED_TARGET));
        }
        Classified {
            labels,
            relocates: relocated,
        }
    }

    fn extra_rule_label(&self, text: &str) -> Option<String> {
        self.extra_bash
            .iter()
            .find(|regex| regex.is_match(text))
            .map(|regex| format!("{RULE_LABEL}: {}", regex.as_str()))
    }

    fn inline_script_labels(
        &self,
        script: &str,
        current_branch: Option<&str>,
        depth: usize,
    ) -> Vec<String> {
        let mut labels = self
            .command_labels(&neutralize_quotes(script), current_branch, depth + 1)
            .labels;
        let pushes = labels.iter().any(|label| label.starts_with(GIT_PUSH_LABEL));
        if !pushes && mentions_git_push(script) {
            labels.push(production_label(UNRESOLVED_TARGET));
        }
        labels
    }

    fn classify_segment(
        &self,
        segment: &str,
        current_branch: Option<&str>,
        depth: usize,
    ) -> Classified {
        let words = shell_words(segment);
        let tokens: Vec<&str> = words.iter().map(String::as_str).collect();
        let prefix = command_prefix(&tokens);
        let branch = if relocates_directly(&tokens, &prefix) {
            None
        } else {
            current_branch
        };
        self.classify_tokens(segment, &tokens, &prefix, branch, depth)
    }

    fn classify_tokens(
        &self,
        segment: &str,
        tokens: &[&str],
        prefix: &CommandPrefix,
        current_branch: Option<&str>,
        depth: usize,
    ) -> Classified {
        if let Some(label) = self.extra_rule_label(segment) {
            return Classified::label(label);
        }
        let branch = if prefix.relocated {
            None
        } else {
            current_branch
        };
        if let Some(script) = &prefix.script {
            return self.command_labels(script, branch, depth + 1);
        }
        let rest = &tokens[prefix.start..];
        let Some(&first) = rest.first() else {
            return Classified::default();
        };
        if prefix.start > 0 {
            if let Some(label) = self.extra_rule_label(&rest.join(" ")) {
                return Classified::label(label);
            }
        }
        let program = program_name(first);
        let arguments = &rest[1..];
        if program == EVAL_WORD {
            return self.command_labels(&arguments.join(" "), branch, depth + 1);
        }
        if SHELL_WORDS.contains(&program) {
            return match shell_script(rest) {
                Some(script) => self.command_labels(&script, branch, depth + 1),
                None => Classified::default(),
            };
        }
        if let Some(scripts) = interpreter_scripts(rest) {
            let mut labels = Vec::new();
            for script in scripts {
                push_distinct(
                    &mut labels,
                    self.inline_script_labels(&script, branch, depth),
                );
            }
            return Classified::labels(labels);
        }
        if program == TASK_PROGRAM && runs_task_release(arguments) {
            return Classified::label(TASK_RELEASE_LABEL.to_string());
        }
        if MERGE_PROGRAMS.contains(&program) && merges_pull_request(arguments) {
            return Classified::label(MERGE_LABEL.to_string());
        }
        if program == GIT_PROGRAM {
            return Classified::labels(
                classify_git(arguments, branch, prefix.appends_arguments)
                    .into_iter()
                    .collect(),
            );
        }
        Classified::default()
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
            ("Bash", Some("bash -c 'cd ../other && git push'"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("sh -c \"cd x; git push\""), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("bash -c \"cd ../other\"; git push"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("env -C../x git push"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("sudo -D../x git push"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("env --chdir=../x git push"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("/usr/bin/git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("/usr/bin/git push"), Some("main"), some("git push → main")),
            ("Bash", Some("\\git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("/usr/bin/sudo git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("setsid git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("setsid -f git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("flock /tmp/l git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("flock -w 5 /tmp/l git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("flock /tmp/l -c 'git push origin main'"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("flock /tmp/l git push origin feature"), Some("main"), None),
            ("Bash", Some("doas git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("doas -u root git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("ionice -c2 -n7 git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("ionice -c 3 git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("systemd-run --user --scope git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("systemd-run -p Nice=5 git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("systemd-run --working-directory=../x git push"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("echo 'git push origin main' | sh"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("printf 'git push origin main' | bash -s"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("echo 'git push origin main' | sudo zsh"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("bash <<< 'git push origin main'"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("bash <<<'git push origin main'"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("echo \"git push origin main\" | cat"), Some("feature/x"), None),
            ("Bash", Some("echo 'git status' | sh"), Some("main"), None),
            ("Bash", Some("bash deploy.sh"), Some("main"), None),
            ("Bash", Some("GIT_SSH_COMMAND=\"ssh -i key\" git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("GIT_SSH_COMMAND='ssh -i key' git push"), Some("main"), some("git push → main")),
            ("Bash", Some("git -c core.sshCommand=\"ssh -i key\" push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("chrt -r 10 git push origin feature"), Some("main"), some("git push → ?")),
            ("Bash", Some("taskset -c 0 /usr/bin/git push"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("git log --grep push"), Some("main"), None),
            ("Bash", Some("git -C x log --grep push"), Some("main"), None),
            ("Bash", Some("task -d X release:patch"), None, some("task release")),
            ("Bash", Some("task --yes release:patch"), None, some("task release")),
            ("Bash", Some("task -t Taskfile.yml release"), None, some("task release")),
            ("Bash", Some("/usr/local/bin/task release:minor"), None, some("task release")),
            ("Bash", Some("task build release"), None, some("task release")),
            ("Bash", Some("task --list"), None, None),
            ("Bash", Some("task build -- release"), None, None),
            ("Bash", Some("git push \\\n  origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("git \\\npush origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("cd ../other \\\n  && git push"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("eval eval git push origin main"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("eval eval eval eval eval eval eval eval eval eval git push origin feature"), Some("main"), some("git push → ?")),
            ("Bash", Some("eval eval eval eval eval eval eval eval eval eval ls"), Some("main"), None),
            ("Bash", Some("gh pr merge 12 --squash"), Some("feature/x"), some("merge PR")),
            ("Bash", Some("bkt pr merge 5"), None, some("merge PR")),
            ("Bash", Some("cd x && gh pr merge --auto 3"), None, some("merge PR")),
            ("Bash", Some("python3 -c \"import os; os.system('git push origin main')\""), Some("feature/x"), some("git push → main")),
            ("Bash", Some("python -c \"import os; os.system('git push origin main')\""), Some("feature/x"), some("git push → main")),
            ("Bash", Some("node -e \"require('child_process').execSync('git push origin main')\""), Some("feature/x"), some("git push → main")),
            ("Bash", Some("node --eval \"require('child_process').execSync('git push origin main')\""), Some("feature/x"), some("git push → main")),
            ("Bash", Some("node -p \"require('child_process').execSync('git push origin main')\""), Some("feature/x"), some("git push → main")),
            ("Bash", Some("perl -e 'system(\"git push origin main\")'"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("perl -E 'system(\"git push origin main\")'"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("ruby -e 'system(\"git push origin main\")'"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("env -S 'git push origin main'"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("env --split-string='git push origin main'"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("python3 -c \"print(1)\""), Some("main"), None),
            ("Bash", Some("node -e \"console.log(1)\""), Some("main"), None),
            ("Bash", Some("perl -le 'print 1'"), Some("main"), None),
            ("Bash", Some("env -S'git push origin main'"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("env --split-string 'cd x; git push'"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("node --eval='require(\"child_process\").execSync(\"git push origin main\")'"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("node -pe \"require('child_process').execSync('git push origin main')\""), Some("feature/x"), some("git push → main")),
            ("Bash", Some("perl -le 'system(\"git push origin main\")'"), Some("feature/x"), some("git push → main")),
            ("Bash", Some("python3 -Bc \"import os; os.system('git push origin main')\""), Some("feature/x"), some("git push → main")),
            ("Bash", Some("/usr/bin/python3.12 -c \"import os; os.system('git push origin main')\""), Some("feature/x"), some("git push → main")),
            ("Bash", Some("sudo -u deploy python3 -c \"import os; os.system('task release:patch')\""), Some("feature/x"), some("task release")),
            ("Bash", Some("python3 -c 'import subprocess; subprocess.run([\"git\", \"push\"])'"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("python3 -c \"import os; os.system('git push origin feature')\""), Some("main"), some("git push → ?")),
            ("Bash", Some("bash -c \"python3 -c 'import os; os.system(\\\"git push origin main\\\")'\""), Some("feature/x"), some("git push → main")),
            ("Bash", Some("python3 - <<'EOF'\nimport os\nos.system(\"git push origin main\")\nEOF"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("echo 'import os; os.system(\"git push origin main\")' | python3"), Some("feature/x"), some("git push → ?")),
            ("Bash", Some("python3 manage.py test"), Some("main"), None),
            ("Bash", Some("gh pr view 12"), None, None),
            ("Bash", Some("gh pr create --fill"), None, None),
            ("Bash", Some("bkt pr list"), None, None),
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
            Some("reguła: ^make deploy".to_string())
        );
        assert_eq!(
            label("Bash", Some("cd x && make deploy prod"), None, &rules),
            Some("reguła: ^make deploy".to_string())
        );
        assert_eq!(
            label("Bash", Some("sudo make deploy TOKEN=s3cret"), None, &rules),
            Some("reguła: ^make deploy".to_string())
        );
        let action = rules
            .classify(
                "Bash",
                &json!({ "command": "make deploy TOKEN=s3cret" }),
                None,
                None,
            )
            .expect("production");
        assert!(!action.label.contains("s3cret"), "{}", action.label);
        assert_eq!(action.detail, "make deploy TOKEN=s3cret");
        assert_eq!(
            label("mcp__foo__bar", None, None, &rules),
            Some("mcp__foo__bar".to_string())
        );
        assert_eq!(label("mcp__baz__bar", None, None, &rules), None);
        assert_eq!(label("Bash", Some("make build"), None, &rules), None);
        assert_eq!(label("Bash", Some("ls"), None, &rules), None);
    }

    fn nested_shell(depth: usize, innermost: &str) -> String {
        (0..depth).fold(innermost.to_string(), |script, _| {
            format!("bash -c '{}'", script.replace('\'', "'\\''"))
        })
    }

    #[test]
    fn nesting_is_capped_without_overflowing_the_stack() {
        let rules = ProductionRules::new(&[]);
        assert_eq!(
            label("Bash", Some(&nested_shell(3, "git push origin main")), Some("feature/x"), &rules),
            Some("git push → main".to_string())
        );
        assert_eq!(
            label("Bash", Some(&nested_shell(10, "git push origin feature")), Some("main"), &rules),
            Some("git push → ?".to_string())
        );
        assert_eq!(
            label("Bash", Some(&nested_shell(10, "ls -la")), Some("main"), &rules),
            None
        );
        let deep_eval = format!("{}git push origin main", "eval ".repeat(20_000));
        assert_eq!(
            label("Bash", Some(&deep_eval), Some("feature/x"), &rules),
            Some("git push → ?".to_string())
        );
        let deep_harmless = format!("{}ls", "eval ".repeat(20_000));
        assert_eq!(label("Bash", Some(&deep_harmless), Some("main"), &rules), None);
        let deep_shell = format!("{}git push", "bash -c ".repeat(20_000));
        assert_eq!(
            label("Bash", Some(&deep_shell), Some("feature/x"), &rules),
            Some("git push → ?".to_string())
        );
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
            json!({"deployment_id": "7"}),
            json!({}),
            json!({"deployment_id": "7", "confirm": false}),
            json!({"deployment_id": "7", "confirm": "false"}),
            json!({"deployment_id": "7", "confirm": null}),
            json!({"deployment_id": "7", "confirm": ""}),
            json!({"deployment_id": "7", "confirm": "  "}),
        ];
        let confirmed = [
            json!({"deployment_id": "7", "confirm": "chg-42"}),
            json!({"deployment_id": "7", "confirm": "0"}),
            json!({"confirm": 0}),
            json!({"confirm": true}),
            json!({"confirm": "true"}),
            json!({"confirm": 1}),
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
        let one_line = bash("task release # bump git push --force origin main", Some("/repo"));
        let two_lines = bash("task release # bump\ngit push --force origin main", Some("/repo"));
        assert_ne!(one_line.label, two_lines.label);
        assert_ne!(one_line.fingerprint, two_lines.fingerprint);
        assert_eq!(
            bash("task release # bump \n\n  git push   --force origin main\r\n", Some("/repo"))
                .fingerprint,
            two_lines.fingerprint
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
        let first =
            deploy(json!({"confirm": "c1", "deployment_id": "7", "spec": {"b": 2, "a": 1}}));
        let reordered =
            deploy(json!({"spec": {"a": 1, "b": 2}, "deployment_id": "7", "confirm": "c1"}));
        assert_eq!(first.fingerprint, reordered.fingerprint);
        assert_eq!(
            first.detail,
            r#"{"confirm":"c1","deployment_id":"7","spec":{"a":1,"b":2}}"#
        );
        assert_eq!(first.label, "mcp__bandzior__deployment_deploy");
        assert_ne!(
            deploy(json!({"confirm": "c2", "deployment_id": "7", "spec": {"a": 1, "b": 2}}))
                .fingerprint,
            first.fingerprint
        );
        assert_ne!(
            rules
                .classify(
                    "mcp__bandzior__deployment_update",
                    &json!({"confirm": "c1", "deployment_id": "7", "spec": {"a": 1, "b": 2}}),
                    Some("/repo"),
                    None
                )
                .unwrap()
                .fingerprint,
            first.fingerprint
        );
        assert_eq!(
            deploy(json!({"confirm": "c1", "deployment_id": "7"})).fingerprint,
            rules
                .classify(
                    "mcp__bandzior__deployment_deploy",
                    &json!({"deployment_id": "7", "confirm": "c1"}),
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
    fn identifier_exemption_covers_only_top_level_parameters() {
        let rules = ProductionRules::new(&[]);
        let detail = |tool: &str, input: Value| {
            rules
                .classify(tool, &input, None, None)
                .expect("production")
                .detail
        };
        let nested = detail(
            "mcp__bandzior__env_vars_set",
            json!({"deployment_id": "5", "variables": {"CLIENT_ID": "x"}, "confirm": "c-1"}),
        );
        assert!(!nested.contains(r#""x""#), "{nested}");
        assert!(nested.contains(r#""deployment_id":"5""#), "{nested}");
        assert!(nested.contains(r#""CLIENT_ID":"***""#), "{nested}");
        let secret = detail(
            "mcp__bandzior__secret_create",
            json!({"namespace": "cs-app-x", "name": "db", "spec": {"name": "inner", "project": "p"}}),
        );
        assert_eq!(
            secret,
            r#"{"name":"db","namespace":"cs-app-x","spec":{"name":"***","project":"***"}}"#
        );
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
                .classify(
                    "Bash",
                    &json!({ "command": command }),
                    Some("/repo"),
                    Some("feature/x"),
                )
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
        assert!(padded.detail.ends_with(" ⏎ git push --force origin main"));
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
