use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, PartialEq)]
struct ConnectClaims {
    sub: String,
    exp: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    channel: Option<String>,
}

/// Mint a Centrifugo connection JWT (HS256) for device `sub`, valid `ttl_secs`.
/// `now_unix` is injected so the function stays pure/testable.
pub fn mint_connection_token(
    secret: &str,
    sub: &str,
    now_unix: usize,
    ttl_secs: usize,
) -> anyhow::Result<String> {
    use jsonwebtoken::{encode, EncodingKey, Header};
    let claims = ConnectClaims { sub: sub.to_string(), exp: now_unix + ttl_secs, channel: None };
    Ok(encode(&Header::default(), &claims, &EncodingKey::from_secret(secret.as_bytes()))?)
}

/// Mint a channel subscription JWT (HS256) — used only if the deployment gates channels.
pub fn mint_subscription_token(
    secret: &str,
    sub: &str,
    channel: &str,
    now_unix: usize,
    ttl_secs: usize,
) -> anyhow::Result<String> {
    use jsonwebtoken::{encode, EncodingKey, Header};
    let claims = ConnectClaims {
        sub: sub.to_string(),
        exp: now_unix + ttl_secs,
        channel: Some(channel.to_string()),
    };
    Ok(encode(&Header::default(), &claims, &EncodingKey::from_secret(secret.as_bytes()))?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};

    /// Validation that ignores expiry, so claim round-trips don't depend on wall clock.
    fn lax_validation() -> Validation {
        let mut v = Validation::new(Algorithm::HS256);
        v.validate_exp = false;
        v.required_spec_claims.clear();
        v
    }

    #[test]
    fn connection_token_round_trips() {
        let secret = "test-secret";
        let token = mint_connection_token(secret, "device-1", 1_000, 3600).unwrap();
        let data = decode::<ConnectClaims>(
            &token,
            &DecodingKey::from_secret(secret.as_bytes()),
            &lax_validation(),
        )
        .unwrap();
        assert_eq!(data.claims.sub, "device-1");
        assert_eq!(data.claims.exp, 4_600);
        assert_eq!(data.claims.channel, None);
    }

    #[test]
    fn subscription_token_carries_channel() {
        let secret = "test-secret";
        let token = mint_subscription_token(secret, "device-1", "cmd:device-1", 0, 60).unwrap();
        let data = decode::<ConnectClaims>(
            &token,
            &DecodingKey::from_secret(secret.as_bytes()),
            &lax_validation(),
        )
        .unwrap();
        assert_eq!(data.claims.channel.as_deref(), Some("cmd:device-1"));
    }

    #[test]
    fn wrong_secret_is_rejected() {
        let token = mint_connection_token("right", "d", 0, 60).unwrap();
        let res = decode::<ConnectClaims>(
            &token,
            &DecodingKey::from_secret(b"wrong"),
            &lax_validation(),
        );
        assert!(res.is_err());
    }
}
