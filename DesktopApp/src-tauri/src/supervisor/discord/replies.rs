use std::collections::HashSet;

use crate::supervisor::discord::client::DiscordMessage;

pub const DISCORD_EPOCH_MS: i64 = 1_420_070_400_000;

pub fn snowflake_ms(id: &str) -> Option<i64> {
    let value = id.parse::<u64>().ok()?;
    Some((value >> 22) as i64 + DISCORD_EPOCH_MS)
}

pub fn snowflake_at(ms: i64) -> String {
    if ms <= DISCORD_EPOCH_MS {
        return "0".to_string();
    }
    (((ms - DISCORD_EPOCH_MS) as u64) << 22).to_string()
}

pub fn parse_reply(content: &str) -> Option<(bool, String)> {
    let trimmed = content.trim();
    let body = trimmed
        .strip_suffix('.')
        .or_else(|| trimmed.strip_suffix('!'))
        .unwrap_or(trimmed);
    let mut tokens = body.split_whitespace();
    let verb = tokens.next()?;
    let code = tokens.next()?;
    if tokens.next().is_some() {
        return None;
    }
    let approve = if verb.eq_ignore_ascii_case("zatwierdzam") {
        true
    } else if verb.eq_ignore_ascii_case("odrzucam") {
        false
    } else {
        return None;
    };
    if code.len() != 4 || !code.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some((approve, code.to_ascii_uppercase()))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingCode {
    pub approval_id: String,
    pub code: String,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MatchedReply {
    pub approval_id: String,
    pub approve: bool,
    pub message_id: String,
}

pub fn match_replies(
    messages: &[DiscordMessage],
    allow_from: &[String],
    pending: &[PendingCode],
) -> Vec<MatchedReply> {
    let mut ordered: Vec<(u64, &DiscordMessage)> = messages
        .iter()
        .filter_map(|message| Some((message.id.parse::<u64>().ok()?, message)))
        .collect();
    ordered.sort_by_key(|(numeric_id, _)| *numeric_id);

    let mut matched_ids: HashSet<&str> = HashSet::new();
    let mut matches = Vec::new();
    for (_, message) in ordered {
        if message.author_is_bot || !allow_from.contains(&message.author_id) {
            continue;
        }
        let Some(posted_ms) = snowflake_ms(&message.id) else {
            continue;
        };
        let Some((approve, code)) = parse_reply(&message.content) else {
            continue;
        };
        let target = pending.iter().find(|candidate| {
            candidate.code.eq_ignore_ascii_case(&code)
                && !matched_ids.contains(candidate.approval_id.as_str())
                && posted_ms > candidate.created_at_ms
        });
        let Some(target) = target else {
            continue;
        };
        matched_ids.insert(target.approval_id.as_str());
        matches.push(MatchedReply {
            approval_id: target.approval_id.clone(),
            approve,
            message_id: message.id.clone(),
        });
    }
    matches
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: i64 = 1_793_300_930_310;
    const OWNER: &str = "844465727611863040";

    fn message(id: String, author_id: &str, is_bot: bool, content: &str) -> DiscordMessage {
        DiscordMessage {
            id,
            author_id: author_id.to_string(),
            author_is_bot: is_bot,
            content: content.to_string(),
        }
    }

    fn pending(approval_id: &str, code: &str) -> PendingCode {
        PendingCode {
            approval_id: approval_id.to_string(),
            code: code.to_string(),
            created_at_ms: T,
        }
    }

    fn allowed() -> Vec<String> {
        vec![OWNER.to_string()]
    }

    #[test]
    fn snowflake_round_trips_milliseconds() {
        assert_eq!(snowflake_ms("1565442306201620621"), Some(1_793_300_930_310));
        assert_eq!(
            snowflake_ms(&snowflake_at(1_793_300_930_310)),
            Some(1_793_300_930_310)
        );
        assert_eq!(snowflake_ms("x"), None);
    }

    #[test]
    fn snowflake_at_clamps_before_the_epoch() {
        assert_eq!(snowflake_at(0), "0");
        assert_eq!(snowflake_at(-5), "0");
        assert_eq!(snowflake_at(DISCORD_EPOCH_MS), "0");
    }

    #[test]
    fn parse_reply_accepts_both_verbs_any_case() {
        assert_eq!(
            parse_reply("zatwierdzam K7QX"),
            Some((true, "K7QX".to_string()))
        );
        assert_eq!(
            parse_reply("  Odrzucam k7qx "),
            Some((false, "K7QX".to_string()))
        );
        assert_eq!(
            parse_reply("ZATWIERDZAM K7QX."),
            Some((true, "K7QX".to_string()))
        );
        assert_eq!(
            parse_reply("odrzucam K7QX!"),
            Some((false, "K7QX".to_string()))
        );
    }

    #[test]
    fn parse_reply_rejects_chatter() {
        for content in [
            "zatwierdzam",
            "zatwierdzam K7QX teraz",
            "tak K7QX",
            "zatwierdzam K7Q",
            "zatwierdzam K7QXX",
            "ok zatwierdzam K7QX",
            "zatwierdzam K7Q!",
            "zatwierdzam K7QX..",
        ] {
            assert_eq!(parse_reply(content), None, "{content}");
        }
    }

    #[test]
    fn match_requires_allowlisted_human_author() {
        let messages = vec![
            message(snowflake_at(T + 1000), "bot", true, "zatwierdzam K7QX"),
            message(snowflake_at(T + 2000), "999", false, "zatwierdzam K7QX"),
            message(snowflake_at(T + 3000), OWNER, false, "zatwierdzam K7QX"),
        ];
        let matches = match_replies(&messages, &allowed(), &[pending("a1", "K7QX")]);
        assert_eq!(
            matches,
            vec![MatchedReply {
                approval_id: "a1".to_string(),
                approve: true,
                message_id: snowflake_at(T + 3000),
            }]
        );
    }

    #[test]
    fn match_ignores_messages_older_than_the_request() {
        let messages = vec![message(snowflake_at(T), OWNER, false, "zatwierdzam K7QX")];
        assert!(match_replies(&messages, &allowed(), &[pending("a1", "K7QX")]).is_empty());
    }

    #[test]
    fn match_takes_the_first_reply_per_approval() {
        let messages = vec![
            message(snowflake_at(T + 2000), OWNER, false, "zatwierdzam K7QX"),
            message(snowflake_at(T + 1000), OWNER, false, "odrzucam K7QX"),
        ];
        let matches = match_replies(&messages, &allowed(), &[pending("a1", "K7QX")]);
        assert_eq!(matches.len(), 1);
        assert!(!matches[0].approve);
        assert_eq!(matches[0].message_id, snowflake_at(T + 1000));
    }

    #[test]
    fn match_routes_each_code_to_its_approval() {
        let messages = vec![
            message(snowflake_at(T + 1000), OWNER, false, "zatwierdzam MN2P"),
            message(snowflake_at(T + 2000), OWNER, false, "odrzucam K7QX"),
        ];
        let matches = match_replies(
            &messages,
            &allowed(),
            &[pending("a1", "K7QX"), pending("a2", "MN2P")],
        );
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].approval_id, "a2");
        assert!(matches[0].approve);
        assert_eq!(matches[1].approval_id, "a1");
        assert!(!matches[1].approve);
    }

    #[test]
    fn match_ignores_codes_that_are_not_pending() {
        let messages = vec![message(
            snowflake_at(T + 1000),
            OWNER,
            false,
            "zatwierdzam ZZZZ",
        )];
        assert!(match_replies(&messages, &allowed(), &[pending("a1", "K7QX")]).is_empty());
    }
}
