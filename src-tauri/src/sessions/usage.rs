use std::collections::{HashMap, HashSet};
use serde_json::Value;
use crate::domain::{ModelUsage, TokenTotals, UsageSummary};
use crate::sessions::pricing::{price_for, ModelPrice};

/// Raw per-model tally with the 5m/1h cache split kept for accurate pricing.
#[derive(Debug, Clone, Copy, Default)]
struct RawTokens {
    input: u64,
    output: u64,
    cache_write_5m: u64,
    cache_write_1h: u64,
    cache_read: u64,
}

impl RawTokens {
    fn add(&mut self, o: &RawTokens) {
        self.input = self.input.saturating_add(o.input);
        self.output = self.output.saturating_add(o.output);
        self.cache_write_5m = self.cache_write_5m.saturating_add(o.cache_write_5m);
        self.cache_write_1h = self.cache_write_1h.saturating_add(o.cache_write_1h);
        self.cache_read = self.cache_read.saturating_add(o.cache_read);
    }

    fn display(&self) -> TokenTotals {
        TokenTotals {
            input: self.input,
            output: self.output,
            cache_write: self.cache_write_5m.saturating_add(self.cache_write_1h),
            cache_read: self.cache_read,
        }
    }
}

fn u64_at(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(|x| x.as_u64()).unwrap_or(0)
}

/// Reads `message.model` + `message.usage` from one parsed JSONL line.
/// Returns `(model, dedup_key, tokens)` or `None` for non-usage lines.
/// `dedup_key` prefers `message.id`, falls back to top-level `requestId`, then `uuid`.
fn extract_usage(line: &Value) -> Option<(String, String, RawTokens)> {
    let msg = line.get("message")?;
    let usage = msg.get("usage")?;
    let model = msg.get("model").and_then(|m| m.as_str()).unwrap_or("unknown").to_string();
    let dedup_key = msg.get("id").and_then(|x| x.as_str())
        .or_else(|| line.get("requestId").and_then(|x| x.as_str()))
        .or_else(|| line.get("uuid").and_then(|x| x.as_str()))
        .unwrap_or("")
        .to_string();

    let cache = usage.get("cache_creation");
    let (cw5m, cw1h) = match cache {
        Some(c) => (u64_at(c, "ephemeral_5m_input_tokens"), u64_at(c, "ephemeral_1h_input_tokens")),
        None => (u64_at(usage, "cache_creation_input_tokens"), 0),
    };

    let tokens = RawTokens {
        input: u64_at(usage, "input_tokens"),
        output: u64_at(usage, "output_tokens"),
        cache_write_5m: cw5m,
        cache_write_1h: cw1h,
        cache_read: u64_at(usage, "cache_read_input_tokens"),
    };
    Some((model, dedup_key, tokens))
}

/// Accumulates usage across many lines, de-duplicating repeated API responses.
#[derive(Default)]
pub struct UsageAccumulator {
    seen: HashSet<String>,
    by_model: HashMap<String, RawTokens>,
}

impl UsageAccumulator {
    pub fn add_line(&mut self, line: &Value) {
        if let Some((model, key, tokens)) = extract_usage(line) {
            if !key.is_empty() && !self.seen.insert(key) {
                return;
            }
            self.by_model.entry(model).or_default().add(&tokens);
        }
    }

    pub fn finalize(&self) -> UsageSummary {
        let mut total = RawTokens::default();
        let mut by_model = Vec::new();
        let mut unknown_models = Vec::new();
        let mut cost_total = 0.0;

        for (model, raw) in &self.by_model {
            total.add(raw);
            let cost = match price_for(model) {
                Some(price) => cost_of(raw, &price),
                None => {
                    unknown_models.push(model.clone());
                    0.0
                }
            };
            cost_total += cost;
            by_model.push(ModelUsage { model: model.clone(), tokens: raw.display(), cost_usd: cost });
        }

        by_model.sort_by(|a, b| b.cost_usd.partial_cmp(&a.cost_usd).unwrap_or(std::cmp::Ordering::Equal));
        unknown_models.sort();

        UsageSummary {
            tokens: total.display(),
            cost_usd: cost_total,
            by_model,
            unknown_models,
        }
    }
}

/// Cost in USD for one model's raw token tally given its price.
/// Each bucket priced separately; prices are USD per 1,000,000 tokens.
fn cost_of(t: &RawTokens, p: &ModelPrice) -> f64 {
    let per = 1_000_000.0;
    (t.input as f64 * p.input
        + t.output as f64 * p.output
        + t.cache_write_5m as f64 * p.cache_write_5m
        + t.cache_write_1h as f64 * p.cache_write_1h
        + t.cache_read as f64 * p.cache_read) / per
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn assistant(id: &str, model: &str, input: u64, output: u64, cw1h: u64, read: u64) -> Value {
        json!({
            "type": "assistant",
            "uuid": format!("uuid-{id}"),
            "requestId": format!("req-{id}"),
            "message": {
                "id": id,
                "model": model,
                "usage": {
                    "input_tokens": input,
                    "output_tokens": output,
                    "cache_read_input_tokens": read,
                    "cache_creation_input_tokens": cw1h,
                    "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": cw1h }
                }
            }
        })
    }

    #[test]
    fn extracts_buckets_and_splits_cache_write() {
        let (model, key, t) = extract_usage(&assistant("msg_1", "claude-opus-4-7", 100, 50, 200, 300)).unwrap();
        assert_eq!(model, "claude-opus-4-7");
        assert_eq!(key, "msg_1");
        assert_eq!(t.input, 100);
        assert_eq!(t.output, 50);
        assert_eq!(t.cache_write_1h, 200);
        assert_eq!(t.cache_write_5m, 0);
        assert_eq!(t.cache_read, 300);
    }

    #[test]
    fn cache_creation_fallback_without_breakdown() {
        let line = json!({
            "type": "assistant",
            "message": {
                "id": "msg_fallback",
                "model": "claude-opus-4-7",
                "usage": { "input_tokens": 10, "output_tokens": 5, "cache_creation_input_tokens": 700, "cache_read_input_tokens": 0 }
            }
        });
        let (_model, _key, t) = extract_usage(&line).unwrap();
        assert_eq!(t.cache_write_5m, 700);
        assert_eq!(t.cache_write_1h, 0);
    }

    #[test]
    fn non_usage_line_returns_none() {
        assert!(extract_usage(&json!({"type":"user","message":{"content":"hi"}})).is_none());
    }

    #[test]
    fn dedupes_by_message_id() {
        let mut acc = UsageAccumulator::default();
        let line = assistant("msg_1", "claude-opus-4-7", 100, 50, 0, 0);
        acc.add_line(&line);
        acc.add_line(&line);
        let s = acc.finalize();
        assert_eq!(s.tokens.input, 100);
        assert_eq!(s.tokens.output, 50);
    }

    #[test]
    fn sums_across_models_and_reports_unknown() {
        let mut acc = UsageAccumulator::default();
        acc.add_line(&assistant("a", "claude-opus-4-7", 100, 10, 0, 0));
        acc.add_line(&assistant("b", "claude-sonnet-4-6", 200, 20, 0, 0));
        acc.add_line(&assistant("c", "mystery-model", 1000, 1000, 0, 0));
        let s = acc.finalize();
        assert_eq!(s.tokens.input, 1300);
        assert_eq!(s.tokens.output, 1030);
        assert_eq!(s.by_model.len(), 3);
        assert_eq!(s.unknown_models, vec!["mystery-model".to_string()]);
    }

    #[test]
    fn computes_cost_per_bucket() {
        let mut acc = UsageAccumulator::default();
        acc.add_line(&assistant("x", "claude-opus-4-7", 1_000_000, 1_000_000, 0, 1_000_000));
        let s = acc.finalize();
        assert!((s.cost_usd - 91.5).abs() < 1e-6, "got {}", s.cost_usd);
    }

    #[test]
    fn cache_write_1h_priced_higher_than_input() {
        let mut acc = UsageAccumulator::default();
        acc.add_line(&assistant("y", "claude-opus-4-7", 0, 0, 1_000_000, 0));
        let s = acc.finalize();
        assert!((s.cost_usd - 30.0).abs() < 1e-6, "got {}", s.cost_usd);
    }
}
