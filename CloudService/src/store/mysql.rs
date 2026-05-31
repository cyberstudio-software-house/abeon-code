use super::{Device, DeviceStore, PairingCode, PairingStore, PhoneToken, PhoneTokenStore};
use async_trait::async_trait;
use sqlx::{MySql, Pool, Row};

/// sqlx-backed store. One struct implements all three traits over a shared pool.
#[derive(Clone)]
pub struct MysqlStore {
    pool: Pool<MySql>,
}

impl MysqlStore {
    pub fn new(pool: Pool<MySql>) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl DeviceStore for MysqlStore {
    async fn create(&self, d: &Device) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO devices (id, device_secret_hash, label, created_at, last_seen_at) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&d.id)
        .bind(&d.device_secret_hash)
        .bind(&d.label)
        .bind(d.created_at)
        .bind(d.last_seen_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn find_by_secret_hash(&self, hash: &str) -> anyhow::Result<Option<Device>> {
        let row = sqlx::query(
            "SELECT id, device_secret_hash, label, created_at, last_seen_at \
             FROM devices WHERE device_secret_hash = ?",
        )
        .bind(hash)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| Device {
            id: r.get("id"),
            device_secret_hash: r.get("device_secret_hash"),
            label: r.get("label"),
            created_at: r.get("created_at"),
            last_seen_at: r.get("last_seen_at"),
        }))
    }

    async fn touch_last_seen(&self, id: &str, now: i64) -> anyhow::Result<()> {
        sqlx::query("UPDATE devices SET last_seen_at = ? WHERE id = ?")
            .bind(now)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn ping(&self) -> anyhow::Result<()> {
        sqlx::query("SELECT 1").execute(&self.pool).await?;
        Ok(())
    }
}

#[async_trait]
impl PhoneTokenStore for MysqlStore {
    async fn create(&self, t: &PhoneToken) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO phone_tokens (id, device_id, token_hash, created_at, last_used_at, expo_push_token) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&t.id)
        .bind(&t.device_id)
        .bind(&t.token_hash)
        .bind(t.created_at)
        .bind(t.last_used_at)
        .bind(&t.expo_push_token)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn find_by_hash(&self, hash: &str) -> anyhow::Result<Option<PhoneToken>> {
        let row = sqlx::query(
            "SELECT id, device_id, token_hash, created_at, last_used_at, expo_push_token \
             FROM phone_tokens WHERE token_hash = ?",
        )
        .bind(hash)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| PhoneToken {
            id: r.get("id"),
            device_id: r.get("device_id"),
            token_hash: r.get("token_hash"),
            created_at: r.get("created_at"),
            last_used_at: r.get("last_used_at"),
            expo_push_token: r.get("expo_push_token"),
        }))
    }

    async fn set_expo_push_token(&self, phone_id: &str, expo_token: &str) -> anyhow::Result<()> {
        sqlx::query("UPDATE phone_tokens SET expo_push_token = ? WHERE id = ?")
            .bind(expo_token)
            .bind(phone_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn expo_push_token_for_device(&self, device_id: &str) -> anyhow::Result<Option<String>> {
        let row = sqlx::query(
            "SELECT expo_push_token FROM phone_tokens \
             WHERE device_id = ? AND expo_push_token IS NOT NULL \
             ORDER BY created_at DESC LIMIT 1",
        )
        .bind(device_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| r.get("expo_push_token")))
    }
}

#[async_trait]
impl PairingStore for MysqlStore {
    async fn create(&self, c: &PairingCode) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO pairing_codes (code_hash, device_id, expires_at, created_at) \
             VALUES (?, ?, ?, ?)",
        )
        .bind(&c.code_hash)
        .bind(&c.device_id)
        .bind(c.expires_at)
        .bind(c.created_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn take(&self, code_hash: &str, now: i64) -> anyhow::Result<Option<PairingCode>> {
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query(
            "SELECT code_hash, device_id, expires_at, created_at \
             FROM pairing_codes WHERE code_hash = ? FOR UPDATE",
        )
        .bind(code_hash)
        .fetch_optional(&mut *tx)
        .await?;

        let result = match row {
            Some(r) => {
                let code = PairingCode {
                    code_hash: r.get("code_hash"),
                    device_id: r.get("device_id"),
                    expires_at: r.get("expires_at"),
                    created_at: r.get("created_at"),
                };
                // Always delete (single-use); return only if still valid.
                sqlx::query("DELETE FROM pairing_codes WHERE code_hash = ?")
                    .bind(code_hash)
                    .execute(&mut *tx)
                    .await?;
                if code.expires_at > now { Some(code) } else { None }
            }
            None => None,
        };
        tx.commit().await?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{Device, PairingCode};

    /// Needs a live MariaDB. Run with:
    ///   TEST_DATABASE_URL=mysql://user:pass@127.0.0.1/cloudservice_test \
    ///   cargo test --manifest-path CloudService/Cargo.toml mysql -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn device_and_pairing_round_trip_against_mariadb() {
        let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL");
        let pool = sqlx::mysql::MySqlPool::connect(&url).await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let store = MysqlStore::new(pool);

        let d = Device {
            id: format!("dev-{}", crate::crypto::generate_secret()),
            device_secret_hash: crate::crypto::sha256_hex("secret-x"),
            label: Some("test".into()),
            created_at: 1000,
            last_seen_at: None,
        };
        DeviceStore::create(&store, &d).await.unwrap();
        let found = store.find_by_secret_hash(&d.device_secret_hash).await.unwrap();
        assert_eq!(found.as_ref().map(|x| &x.id), Some(&d.id));

        let code = PairingCode {
            code_hash: crate::crypto::sha256_hex(&crate::crypto::generate_pairing_code()),
            device_id: d.id.clone(),
            expires_at: 9_999_999_999,
            created_at: 1000,
        };
        PairingStore::create(&store, &code).await.unwrap();
        assert!(store.take(&code.code_hash, 1001).await.unwrap().is_some());
        assert!(store.take(&code.code_hash, 1001).await.unwrap().is_none()); // single-use
    }
}
