use serde::Serialize;
use ts_rs::TS;
use super::open_input::parse_open_input;

const PROMPT_FLAG: &str = "--prompt";
const BACKGROUND_FLAG: &str = "--background";
const DEEP_LINK_SCHEME: &str = "abeon-code://";

#[derive(Serialize, Clone, Debug, PartialEq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    pub path: String,
    pub initial_prompt: Option<String>,
    pub background: bool,
}

impl OpenRequest {
    pub fn path_only(path: String) -> Self {
        Self { path, initial_prompt: None, background: false }
    }
}

pub fn parse_cli_args(args: &[String], cwd: Option<&str>) -> Vec<OpenRequest> {
    let mut paths: Vec<(String, bool)> = Vec::new();
    let mut prompt: Option<String> = None;
    let mut background = false;
    let mut iter = args.iter().skip(1);
    while let Some(raw) = iter.next() {
        if raw == PROMPT_FLAG {
            if let Some(value) = iter.next() {
                prompt = Some(value.clone());
            }
            continue;
        }
        if raw == BACKGROUND_FLAG {
            background = true;
            continue;
        }
        if let Some(path) = parse_open_input(raw, cwd) {
            paths.push((path, raw.starts_with(DEEP_LINK_SCHEME)));
        }
    }
    paths
        .into_iter()
        .map(|(path, from_deep_link)| {
            if from_deep_link {
                OpenRequest::path_only(path)
            } else {
                OpenRequest { path, initial_prompt: prompt.clone(), background }
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(rest: &[&str]) -> Vec<String> {
        std::iter::once("abeoncode").chain(rest.iter().copied()).map(String::from).collect()
    }

    #[test]
    fn bare_path() {
        assert_eq!(
            parse_cli_args(&argv(&["/home/u/proj"]), None),
            vec![OpenRequest::path_only("/home/u/proj".into())]
        );
    }

    #[test]
    fn path_with_prompt_and_background() {
        assert_eq!(
            parse_cli_args(&argv(&["/p", "--prompt", "line1\nline2", "--background"]), None),
            vec![OpenRequest {
                path: "/p".into(),
                initial_prompt: Some("line1\nline2".into()),
                background: true,
            }]
        );
    }

    #[test]
    fn options_before_path_apply_to_it() {
        assert_eq!(
            parse_cli_args(&argv(&["--background", "--prompt", "x", "/p"]), None),
            vec![OpenRequest { path: "/p".into(), initial_prompt: Some("x".into()), background: true }]
        );
    }

    #[test]
    fn prompt_value_that_looks_like_path_is_not_a_path() {
        assert_eq!(
            parse_cli_args(&argv(&["/p", "--prompt", "/other/dir"]), None),
            vec![OpenRequest { path: "/p".into(), initial_prompt: Some("/other/dir".into()), background: false }]
        );
    }

    #[test]
    fn prompt_value_that_looks_like_flag_is_consumed() {
        assert_eq!(
            parse_cli_args(&argv(&["/p", "--prompt", "--background"]), None),
            vec![OpenRequest { path: "/p".into(), initial_prompt: Some("--background".into()), background: false }]
        );
    }

    #[test]
    fn dangling_prompt_flag_is_ignored() {
        assert_eq!(
            parse_cli_args(&argv(&["/p", "--prompt"]), None),
            vec![OpenRequest::path_only("/p".into())]
        );
    }

    #[test]
    fn options_without_path_produce_nothing() {
        assert!(parse_cli_args(&argv(&["--prompt", "x", "--background"]), None).is_empty());
    }

    #[test]
    fn legacy_inputs_keep_working() {
        assert_eq!(parse_cli_args(&argv(&["-psn_0_123"]), None), vec![]);
        assert_eq!(
            parse_cli_args(&argv(&["proj"]), Some("/work")),
            vec![OpenRequest::path_only("/work/proj".into())]
        );
        assert_eq!(
            parse_cli_args(&argv(&["abeon-code://open?path=%2Fx%2Fy"]), None),
            vec![OpenRequest::path_only("/x/y".into())]
        );
    }

    #[test]
    fn deep_link_never_carries_prompt() {
        let reqs = parse_cli_args(
            &argv(&["abeon-code://open?path=%2Fx&prompt=rm%20-rf&background=true"]),
            None,
        );
        assert_eq!(reqs, vec![OpenRequest::path_only("/x".into())]);
    }

    #[test]
    fn serializes_camel_case() {
        let json = serde_json::to_value(OpenRequest {
            path: "/p".into(),
            initial_prompt: Some("x".into()),
            background: true,
        }).unwrap();
        assert_eq!(json, serde_json::json!({ "path": "/p", "initialPrompt": "x", "background": true }));
    }
}
