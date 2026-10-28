use std::time::{Duration, Instant};
use uuid::Uuid;

const APPROVAL_TTL: Duration = Duration::from_secs(24 * 3600);
const TOKEN_TTL: Duration = Duration::from_secs(30 * 60);
const CODE_ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH: usize = 4;

#[derive(Debug, Clone)]
pub struct Approval {
    pub id: String,
    pub session_id: String,
    pub action: String,
    pub code: String,
    pub created_at_ms: i64,
    pub expires_at: Instant,
}

struct Token {
    session_id: String,
    action: String,
    expires_at: Instant,
}

#[derive(Default)]
pub struct ApprovalBook {
    pending: Vec<Approval>,
    tokens: Vec<Token>,
}

fn random_code() -> String {
    let bytes = Uuid::new_v4().into_bytes();
    bytes
        .iter()
        .take(CODE_LENGTH)
        .map(|byte| CODE_ALPHABET[(*byte & 31) as usize] as char)
        .collect()
}

impl ApprovalBook {
    fn prune(&mut self, now: Instant) {
        self.pending.retain(|approval| approval.expires_at > now);
        self.tokens.retain(|token| token.expires_at > now);
    }

    pub fn create(
        &mut self,
        session_id: &str,
        action: &str,
        now: Instant,
        now_ms: i64,
    ) -> (Approval, bool) {
        self.prune(now);
        if let Some(existing) = self
            .pending
            .iter()
            .find(|approval| approval.session_id == session_id && approval.action == action)
        {
            return (existing.clone(), false);
        }
        let mut code = random_code();
        while self.pending.iter().any(|approval| approval.code == code) {
            code = random_code();
        }
        let approval = Approval {
            id: Uuid::new_v4().to_string(),
            session_id: session_id.to_string(),
            action: action.to_string(),
            code,
            created_at_ms: now_ms,
            expires_at: now + APPROVAL_TTL,
        };
        self.pending.push(approval.clone());
        (approval, true)
    }

    pub fn resolve(&mut self, id: &str, approve: bool, now: Instant) -> Option<Approval> {
        self.prune(now);
        let index = self.pending.iter().position(|approval| approval.id == id)?;
        let approval = self.pending.remove(index);
        if approve {
            self.tokens.push(Token {
                session_id: approval.session_id.clone(),
                action: approval.action.clone(),
                expires_at: now + TOKEN_TTL,
            });
        }
        Some(approval)
    }

    pub fn consume_token(&mut self, session_id: &str, action: &str, now: Instant) -> bool {
        self.prune(now);
        match self
            .tokens
            .iter()
            .position(|token| token.session_id == session_id && token.action == action)
        {
            Some(index) => {
                self.tokens.remove(index);
                true
            }
            None => false,
        }
    }

    pub fn pending(&self, now: Instant) -> Vec<Approval> {
        self.pending
            .iter()
            .filter(|approval| approval.expires_at > now)
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: Duration = Duration::from_secs(3600);
    const ALPHABET: &str = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    #[test]
    fn create_dedupes_pending() {
        let now = Instant::now();
        let mut book = ApprovalBook::default();
        let (first, created_first) = book.create("s1", "git push origin main", now, 1000);
        let (second, created_second) = book.create("s1", "git push origin main", now + HOUR, 2000);
        assert!(created_first);
        assert!(!created_second);
        assert_eq!(first.id, second.id);
        assert_eq!(first.code, second.code);
        assert_eq!(book.pending(now + HOUR).len(), 1);
        let (other, created_other) = book.create("s1", "kubectl delete pod x", now, 1000);
        assert!(created_other);
        assert_ne!(other.id, first.id);
    }

    #[test]
    fn code_alphabet_and_length() {
        let now = Instant::now();
        let mut book = ApprovalBook::default();
        for index in 0..200 {
            let (approval, _) = book.create("s1", &format!("action {index}"), now, 0);
            assert_eq!(approval.code.len(), 4);
            assert!(approval.code.chars().all(|c| ALPHABET.contains(c)));
            assert!(uuid::Uuid::parse_str(&approval.id).is_ok());
        }
        let codes: std::collections::HashSet<_> =
            book.pending(now).into_iter().map(|a| a.code).collect();
        assert_eq!(codes.len(), 200);
    }

    #[test]
    fn approve_grants_one_shot_token() {
        let now = Instant::now();
        let mut book = ApprovalBook::default();
        let (approval, _) = book.create("s1", "deploy", now, 0);
        assert!(!book.consume_token("s1", "deploy", now));
        let resolved = book.resolve(&approval.id, true, now).unwrap();
        assert_eq!(resolved.id, approval.id);
        assert!(book.pending(now).is_empty());
        assert!(!book.consume_token("s2", "deploy", now));
        assert!(!book.consume_token("s1", "other", now));
        assert!(book.consume_token("s1", "deploy", now));
        assert!(!book.consume_token("s1", "deploy", now));
        assert!(book.resolve(&approval.id, true, now).is_none());
    }

    #[test]
    fn token_expires_after_thirty_minutes() {
        let now = Instant::now();
        let mut book = ApprovalBook::default();
        let (approval, _) = book.create("s1", "deploy", now, 0);
        book.resolve(&approval.id, true, now).unwrap();
        assert!(!book.consume_token("s1", "deploy", now + Duration::from_secs(31 * 60)));
    }

    #[test]
    fn reject_grants_no_token() {
        let now = Instant::now();
        let mut book = ApprovalBook::default();
        let (approval, _) = book.create("s1", "deploy", now, 0);
        assert!(book.resolve(&approval.id, false, now).is_some());
        assert!(book.pending(now).is_empty());
        assert!(!book.consume_token("s1", "deploy", now));
    }

    #[test]
    fn expired_approvals_drop_after_24h() {
        let now = Instant::now();
        let mut book = ApprovalBook::default();
        let (approval, _) = book.create("s1", "deploy", now, 0);
        assert_eq!(book.pending(now + 23 * HOUR).len(), 1);
        assert!(book.pending(now + 25 * HOUR).is_empty());
        assert!(book.resolve(&approval.id, true, now + 25 * HOUR).is_none());
        assert!(!book.consume_token("s1", "deploy", now + 25 * HOUR));
        let (recreated, created) = book.create("s1", "deploy", now + 25 * HOUR, 5);
        assert!(created);
        assert_ne!(recreated.id, approval.id);
    }

    #[test]
    fn resolve_unknown_id_is_none() {
        let mut book = ApprovalBook::default();
        assert!(book.resolve("missing", true, Instant::now()).is_none());
    }
}
