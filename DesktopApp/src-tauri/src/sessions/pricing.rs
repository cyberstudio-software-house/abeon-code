/// USD per 1,000,000 tokens, per bucket.
#[derive(Debug, Clone, Copy)]
pub struct ModelPrice {
    pub input: f64,
    pub output: f64,
    pub cache_write_5m: f64,
    pub cache_write_1h: f64,
    pub cache_read: f64,
}

/// Matched by substring so date/point suffixes (e.g. `claude-opus-4-7`) still resolve.
pub fn price_for(model: &str) -> Option<ModelPrice> {
    let m = model.to_ascii_lowercase();
    if m.contains("opus") {
        Some(ModelPrice { input: 15.0, output: 75.0, cache_write_5m: 18.75, cache_write_1h: 30.0, cache_read: 1.5 })
    } else if m.contains("sonnet") {
        Some(ModelPrice { input: 3.0, output: 15.0, cache_write_5m: 3.75, cache_write_1h: 6.0, cache_read: 0.3 })
    } else if m.contains("haiku") {
        Some(ModelPrice { input: 1.0, output: 5.0, cache_write_5m: 1.25, cache_write_1h: 2.0, cache_read: 0.1 })
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_opus_with_date_suffix() {
        let p = price_for("claude-opus-4-7").unwrap();
        assert_eq!(p.input, 15.0);
        assert_eq!(p.output, 75.0);
    }

    #[test]
    fn resolves_sonnet_and_haiku() {
        let sonnet = price_for("claude-sonnet-4-6").unwrap();
        assert_eq!(sonnet.input, 3.0);
        assert_eq!(sonnet.output, 15.0);
        let haiku = price_for("claude-haiku-4-5-20251001").unwrap();
        assert_eq!(haiku.input, 1.0);
        assert_eq!(haiku.output, 5.0);
    }

    #[test]
    fn resolves_opus_4_8() {
        let p = price_for("claude-opus-4-8").unwrap();
        assert_eq!(p.input, 15.0);
        assert_eq!(p.output, 75.0);
        let p1m = price_for("claude-opus-4-8[1m]").unwrap();
        assert_eq!(p1m.output, 75.0);
    }

    #[test]
    fn unknown_model_is_none() {
        assert!(price_for("gpt-4o").is_none());
        assert!(price_for("").is_none());
    }
}
