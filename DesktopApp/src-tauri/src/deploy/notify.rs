use crate::deploy::machine::NotifyKind;
use crate::domain::deploy::{DeployFlow, Tracking};
use crate::notifications::desktop::show_link_notification;
use crate::supervisor::discord::render::v2_payload;
use serde_json::{json, Value};
use std::path::Path;
use tauri::AppHandle;

const SHORT_COMMIT_CHARS: usize = 7;
const TEXT_LIMIT: usize = 1500;
const LINK_LABEL: &str = "Otwórz pipeline";
const MAX_ROW_BUTTONS: usize = 5;
const FAILURE_FALLBACK: &str = "Wdrożenie zakończyło się błędem.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscordButton {
    pub label: String,
    pub custom_id: String,
    pub primary: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscordNotice {
    pub title: String,
    pub body: String,
    pub link: Option<(String, String)>,
    pub buttons: Vec<DiscordButton>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoticeText {
    pub title: String,
    pub body: String,
    pub url: Option<String>,
    pub to_discord: bool,
}

fn short_commit(commit: &str) -> String {
    commit.chars().take(SHORT_COMMIT_CHARS).collect()
}

fn web_url(url: Option<&String>) -> Option<String> {
    url.filter(|url| url.starts_with("https://") || url.starts_with("http://"))
        .cloned()
}

fn stalled_stage(tracking: &Tracking) -> &'static str {
    if tracking.run_id.is_none() {
        "wypchnięciu"
    } else {
        "budowaniu"
    }
}

pub fn notice_text(kind: NotifyKind, tracking: &Tracking, label: &str) -> NoticeText {
    let commit = short_commit(&tracking.commit);
    let run_url = web_url(tracking.run_url.as_ref());
    match kind {
        NotifyKind::Paused => NoticeText {
            title: format!("Pipeline czeka na Ciebie: {label}"),
            body: format!("Wdrożenie {commit} jest wstrzymane do Twojej akceptacji."),
            url: run_url,
            to_discord: true,
        },
        NotifyKind::Failed => NoticeText {
            title: format!("Wdrożenie nie powiodło się: {label}"),
            body: tracking
                .failure
                .as_ref()
                .map(|failure| failure.reason.clone())
                .filter(|reason| !reason.trim().is_empty())
                .unwrap_or_else(|| FAILURE_FALLBACK.to_string()),
            url: run_url,
            to_discord: true,
        },
        NotifyKind::Stalled => NoticeText {
            title: format!("Wdrożenie utknęło: {label}"),
            body: format!("Nie widać dalszego ciągu po {}.", stalled_stage(tracking)),
            url: run_url,
            to_discord: true,
        },
        NotifyKind::Succeeded => NoticeText {
            title: format!("Wdrożono: {label}"),
            body: commit,
            url: None,
            to_discord: false,
        },
    }
}

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let mut cut: String = text.chars().take(limit.saturating_sub(1)).collect();
    cut.push('…');
    cut
}

pub fn discord_payload(notice: &DiscordNotice) -> Value {
    let content = truncate(&format!("**{}**\n{}", notice.title, notice.body), TEXT_LIMIT);
    let mut components = vec![json!({ "type": 10, "content": content })];
    let mut buttons: Vec<Value> = Vec::new();
    if let Some((label, url)) = &notice.link {
        buttons.push(json!({ "type": 2, "style": 5, "label": label, "url": url }));
    }
    for button in &notice.buttons {
        buttons.push(json!({
            "type": 2,
            "style": if button.primary { 3 } else { 2 },
            "label": button.label,
            "custom_id": button.custom_id,
        }));
    }
    buttons.truncate(MAX_ROW_BUTTONS);
    if !buttons.is_empty() {
        components.push(json!({ "type": 1, "components": buttons }));
    }
    v2_payload(Value::Array(components))
}

fn repo_label(flow: &DeployFlow) -> String {
    Path::new(&flow.repo_path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| flow.repo_path.clone())
}

fn delivery_line(kind: NotifyKind, label: &str, discord: Option<&Result<(), String>>) -> String {
    let discord = match discord {
        Some(Ok(())) => "sent to the desktop and to Discord".to_string(),
        Some(Err(reason)) => format!("sent to the desktop, not to Discord ({reason})"),
        None => "sent to the desktop, Discord is not used for this kind".to_string(),
    };
    format!("deploy: {kind:?} notice for {label}: {discord}")
}

pub fn announce(app: &AppHandle, kind: NotifyKind, tracking: &Tracking, flow: &DeployFlow) {
    let label = repo_label(flow);
    let text = notice_text(kind, tracking, &label);
    show_link_notification(app, text.title.clone(), text.body.clone(), text.url.clone());
    if !text.to_discord {
        eprintln!("{}", delivery_line(kind, &label, None));
        return;
    }
    let notice = DiscordNotice {
        title: text.title,
        body: text.body,
        link: text.url.map(|url| (LINK_LABEL.to_string(), url)),
        buttons: Vec::new(),
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let sent = crate::supervisor::runtime::post_discord_notice(&app, notice).await;
        eprintln!("{}", delivery_line(kind, &label, Some(&sent)));
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::deploy::{TrackingFailure, TrackingStage};
    use crate::deploy::test_support::flow;

    const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";
    const RUN_URL: &str = "https://bitbucket.org/cybercode/app/pipelines/results/7";

    fn tracking() -> Tracking {
        let mut tracking = Tracking::new(&flow(), COMMIT, 1);
        tracking.run_id = Some("{run-7}".to_string());
        tracking.run_url = Some(RUN_URL.to_string());
        tracking
    }

    #[test]
    fn a_paused_pipeline_asks_for_the_user_and_goes_to_discord() {
        let text = notice_text(NotifyKind::Paused, &tracking(), "hs-training");
        assert_eq!(
            text,
            NoticeText {
                title: "Pipeline czeka na Ciebie: hs-training".to_string(),
                body: "Wdrożenie 0123456 jest wstrzymane do Twojej akceptacji.".to_string(),
                url: Some(RUN_URL.to_string()),
                to_discord: true,
            }
        );
    }

    #[test]
    fn a_failure_carries_its_reason_and_never_the_log_excerpt() {
        let mut failed = tracking();
        failed.failure = Some(TrackingFailure {
            stage: TrackingStage::Build,
            reason: "krok „Build” zakończył się błędem".to_string(),
            log_excerpt: Some("SECRET LOG LINE".to_string()),
        });
        let text = notice_text(NotifyKind::Failed, &failed, "isp-panel");
        assert_eq!(text.title, "Wdrożenie nie powiodło się: isp-panel");
        assert_eq!(text.body, "krok „Build” zakończył się błędem");
        assert!(!text.body.contains("SECRET"));
        assert_eq!(text.url.as_deref(), Some(RUN_URL));
        assert!(text.to_discord);

        failed.failure = None;
        assert_eq!(notice_text(NotifyKind::Failed, &failed, "x").body, FAILURE_FALLBACK);
    }

    #[test]
    fn a_stall_names_the_stage_it_never_got_past() {
        let mut before_run = tracking();
        before_run.run_id = None;
        before_run.run_url = None;
        let text = notice_text(NotifyKind::Stalled, &before_run, "app");
        assert_eq!(text.title, "Wdrożenie utknęło: app");
        assert_eq!(text.body, "Nie widać dalszego ciągu po wypchnięciu.");
        assert_eq!(text.url, None);
        assert!(text.to_discord);

        let after_run = notice_text(NotifyKind::Stalled, &tracking(), "app");
        assert_eq!(after_run.body, "Nie widać dalszego ciągu po budowaniu.");
        assert_eq!(after_run.url.as_deref(), Some(RUN_URL));
    }

    #[test]
    fn success_is_quiet_and_has_no_link() {
        let text = notice_text(NotifyKind::Succeeded, &tracking(), "app");
        assert_eq!(
            text,
            NoticeText {
                title: "Wdrożono: app".to_string(),
                body: "0123456".to_string(),
                url: None,
                to_discord: false,
            }
        );
    }

    #[test]
    fn only_web_addresses_become_links() {
        let mut odd = tracking();
        odd.run_url = Some("file:///etc/passwd".to_string());
        assert_eq!(notice_text(NotifyKind::Paused, &odd, "app").url, None);
        odd.run_url = Some("http://ci.example.test/7".to_string());
        assert_eq!(
            notice_text(NotifyKind::Paused, &odd, "app").url.as_deref(),
            Some("http://ci.example.test/7")
        );
    }

    fn notice() -> DiscordNotice {
        DiscordNotice {
            title: "Tytuł".to_string(),
            body: "Treść".to_string(),
            link: None,
            buttons: Vec::new(),
        }
    }

    #[test]
    fn the_payload_is_a_components_v2_message_with_a_text_display() {
        let payload = discord_payload(&notice());
        assert_eq!(payload["flags"], 32768);
        assert_eq!(payload["allowed_mentions"], json!({ "parse": [] }));
        assert_eq!(
            payload["components"],
            json!([{ "type": 10, "content": "**Tytuł**\nTreść" }])
        );
    }

    #[test]
    fn the_link_is_a_link_button_followed_by_the_custom_buttons() {
        let mut with_link = notice();
        with_link.link = Some((LINK_LABEL.to_string(), RUN_URL.to_string()));
        with_link.buttons = vec![
            DiscordButton {
                label: "Zatwierdź".to_string(),
                custom_id: "abeon:flow:ok".to_string(),
                primary: true,
            },
            DiscordButton {
                label: "Odrzuć".to_string(),
                custom_id: "abeon:flow:no".to_string(),
                primary: false,
            },
        ];
        let payload = discord_payload(&with_link);
        let components = payload["components"].as_array().unwrap();
        assert_eq!(components.len(), 2);
        let row = &components[1];
        assert_eq!(row["type"], 1);
        let buttons = row["components"].as_array().unwrap();
        assert_eq!(
            buttons[0],
            json!({ "type": 2, "style": 5, "label": LINK_LABEL, "url": RUN_URL })
        );
        assert_eq!(buttons[1]["style"], 3);
        assert_eq!(buttons[1]["custom_id"], "abeon:flow:ok");
        assert_eq!(buttons[2]["style"], 2);
        assert_eq!(buttons[2]["custom_id"], "abeon:flow:no");
        assert!(buttons[1].get("url").is_none());
    }

    #[test]
    fn buttons_without_a_link_still_form_a_row_and_nothing_means_no_row() {
        let mut only_buttons = notice();
        only_buttons.buttons = vec![DiscordButton {
            label: "Tak".to_string(),
            custom_id: "abeon:flow:yes".to_string(),
            primary: true,
        }];
        let payload = discord_payload(&only_buttons);
        let components = payload["components"].as_array().unwrap();
        assert_eq!(components.len(), 2);
        assert_eq!(components[1]["components"][0]["style"], 3);

        let bare = discord_payload(&notice());
        assert_eq!(bare["components"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn a_long_body_is_cut_to_the_text_limit_with_an_ellipsis() {
        let mut long = notice();
        long.body = "ż".repeat(3000);
        let payload = discord_payload(&long);
        let content = payload["components"][0]["content"].as_str().unwrap();
        assert_eq!(content.chars().count(), TEXT_LIMIT);
        assert!(content.ends_with('…'));
        assert!(content.starts_with("**Tytuł**\n"));
    }

    #[test]
    fn a_row_never_holds_more_than_five_buttons() {
        let mut crowded = notice();
        crowded.link = Some((LINK_LABEL.to_string(), RUN_URL.to_string()));
        crowded.buttons = (0..8)
            .map(|index| DiscordButton {
                label: format!("b{index}"),
                custom_id: format!("abeon:flow:{index}"),
                primary: false,
            })
            .collect();
        let payload = discord_payload(&crowded);
        assert_eq!(payload["components"][1]["components"].as_array().unwrap().len(), 5);
    }

    #[test]
    fn the_delivery_line_says_where_each_kind_went_or_why_not() {
        assert_eq!(
            delivery_line(NotifyKind::Paused, "hs-training", Some(&Ok(()))),
            "deploy: Paused notice for hs-training: sent to the desktop and to Discord"
        );
        assert_eq!(
            delivery_line(
                NotifyKind::Failed,
                "app",
                Some(&Err("the supervisor is not running".to_string()))
            ),
            "deploy: Failed notice for app: sent to the desktop, not to Discord (the supervisor is not running)"
        );
        assert_eq!(
            delivery_line(NotifyKind::Succeeded, "app", None),
            "deploy: Succeeded notice for app: sent to the desktop, Discord is not used for this kind"
        );
    }

    #[test]
    fn the_label_is_the_repository_directory_name() {
        let mut named = flow();
        named.repo_path = "/home/u/projects/hs-training".to_string();
        assert_eq!(repo_label(&named), "hs-training");
    }
}
