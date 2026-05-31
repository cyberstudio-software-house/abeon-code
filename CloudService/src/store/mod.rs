pub mod mysql;

use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Device {
    pub id: String,
    pub device_secret_hash: String,
    pub label: Option<String>,
    pub created_at: i64,
    pub last_seen_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhoneToken {
    pub id: String,
    pub device_id: String,
    pub token_hash: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
    pub expo_push_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingCode {
    pub code_hash: String,
    pub device_id: String,
    pub expires_at: i64,
    pub created_at: i64,
}

#[async_trait]
pub trait DeviceStore: Send + Sync {
    async fn create(&self, device: &Device) -> anyhow::Result<()>;
    async fn find_by_secret_hash(&self, hash: &str) -> anyhow::Result<Option<Device>>;
    async fn touch_last_seen(&self, id: &str, now: i64) -> anyhow::Result<()>;
    /// Readiness probe — a trivial round-trip to the backing store.
    async fn ping(&self) -> anyhow::Result<()>;
}

#[async_trait]
pub trait PhoneTokenStore: Send + Sync {
    async fn create(&self, token: &PhoneToken) -> anyhow::Result<()>;
    async fn find_by_hash(&self, hash: &str) -> anyhow::Result<Option<PhoneToken>>;
    async fn set_expo_push_token(&self, phone_id: &str, expo_token: &str) -> anyhow::Result<()>;
    async fn expo_push_token_for_device(&self, device_id: &str) -> anyhow::Result<Option<String>>;
}

#[async_trait]
pub trait PairingStore: Send + Sync {
    async fn create(&self, code: &PairingCode) -> anyhow::Result<()>;
    /// Single-use redeem: if a non-expired code exists, delete and return it.
    async fn take(&self, code_hash: &str, now: i64) -> anyhow::Result<Option<PairingCode>>;
}

// ---- In-memory fakes (used by tests) ----

#[derive(Default)]
pub struct InMemoryDevices(Mutex<Vec<Device>>);
#[derive(Default)]
pub struct InMemoryPhones(Mutex<Vec<PhoneToken>>);
#[derive(Default)]
pub struct InMemoryPairing(Mutex<HashMap<String, PairingCode>>);

#[async_trait]
impl DeviceStore for InMemoryDevices {
    async fn create(&self, device: &Device) -> anyhow::Result<()> {
        self.0.lock().unwrap().push(device.clone());
        Ok(())
    }
    async fn find_by_secret_hash(&self, hash: &str) -> anyhow::Result<Option<Device>> {
        Ok(self.0.lock().unwrap().iter().find(|d| d.device_secret_hash == hash).cloned())
    }
    async fn touch_last_seen(&self, id: &str, now: i64) -> anyhow::Result<()> {
        if let Some(d) = self.0.lock().unwrap().iter_mut().find(|d| d.id == id) {
            d.last_seen_at = Some(now);
        }
        Ok(())
    }
    async fn ping(&self) -> anyhow::Result<()> {
        Ok(())
    }
}

#[async_trait]
impl PhoneTokenStore for InMemoryPhones {
    async fn create(&self, token: &PhoneToken) -> anyhow::Result<()> {
        self.0.lock().unwrap().push(token.clone());
        Ok(())
    }
    async fn find_by_hash(&self, hash: &str) -> anyhow::Result<Option<PhoneToken>> {
        Ok(self.0.lock().unwrap().iter().find(|t| t.token_hash == hash).cloned())
    }
    async fn set_expo_push_token(&self, phone_id: &str, expo_token: &str) -> anyhow::Result<()> {
        let mut tokens = self.0.lock().unwrap();
        if let Some(t) = tokens.iter_mut().find(|t| t.id == phone_id) {
            t.expo_push_token = Some(expo_token.to_string());
        }
        Ok(())
    }
    async fn expo_push_token_for_device(&self, device_id: &str) -> anyhow::Result<Option<String>> {
        let tokens = self.0.lock().unwrap();
        // Most-recent (created_at desc) token for this device_id that has expo_push_token set.
        let result = tokens
            .iter()
            .filter(|t| t.device_id == device_id && t.expo_push_token.is_some())
            .max_by_key(|t| t.created_at)
            .and_then(|t| t.expo_push_token.clone());
        Ok(result)
    }
}

#[async_trait]
impl PairingStore for InMemoryPairing {
    async fn create(&self, code: &PairingCode) -> anyhow::Result<()> {
        self.0.lock().unwrap().insert(code.code_hash.clone(), code.clone());
        Ok(())
    }
    async fn take(&self, code_hash: &str, now: i64) -> anyhow::Result<Option<PairingCode>> {
        let mut map = self.0.lock().unwrap();
        match map.get(code_hash).cloned() {
            Some(code) if code.expires_at > now => {
                map.remove(code_hash);
                Ok(Some(code))
            }
            Some(_) => {
                map.remove(code_hash); // expired — clean up, treat as absent
                Ok(None)
            }
            None => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn device_round_trips_by_secret_hash() {
        let store = InMemoryDevices::default();
        let d = Device {
            id: "dev-1".into(),
            device_secret_hash: "abc".into(),
            label: None,
            created_at: 100,
            last_seen_at: None,
        };
        store.create(&d).await.unwrap();
        assert_eq!(store.find_by_secret_hash("abc").await.unwrap(), Some(d));
        assert_eq!(store.find_by_secret_hash("nope").await.unwrap(), None);
    }

    #[tokio::test]
    async fn pairing_take_is_single_use_and_expiry_aware() {
        let store = InMemoryPairing::default();
        let code = PairingCode { code_hash: "h".into(), device_id: "dev-1".into(), expires_at: 200, created_at: 100 };
        store.create(&code).await.unwrap();
        // expired (now >= expires_at) → None
        assert_eq!(store.take("h", 200).await.unwrap(), None);

        let code2 = PairingCode { code_hash: "h2".into(), device_id: "dev-1".into(), expires_at: 200, created_at: 100 };
        store.create(&code2).await.unwrap();
        assert_eq!(store.take("h2", 150).await.unwrap(), Some(code2)); // valid
        assert_eq!(store.take("h2", 150).await.unwrap(), None);        // single-use
    }

    #[tokio::test]
    async fn expo_push_token_set_and_lookup() {
        let store = InMemoryPhones::default();
        let token = PhoneToken {
            id: "phone-1".into(),
            device_id: "dev-1".into(),
            token_hash: "hash-abc".into(),
            created_at: 1000,
            last_used_at: None,
            expo_push_token: None,
        };
        store.create(&token).await.unwrap();

        store.set_expo_push_token("phone-1", "ExponentPushToken[x]").await.unwrap();

        let result = store.expo_push_token_for_device("dev-1").await.unwrap();
        assert_eq!(result, Some("ExponentPushToken[x]".to_string()));
    }

    #[tokio::test]
    async fn expo_push_token_for_unknown_device_returns_none() {
        let store = InMemoryPhones::default();
        let result = store.expo_push_token_for_device("nonexistent-device").await.unwrap();
        assert_eq!(result, None);
    }
}
