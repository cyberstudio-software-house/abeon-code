use std::future::Future;

use crate::db::DbPool;
use crate::remote::cloud_client::{CloudClient, CloudError};

const KEY_DEVICE_ID: &str = "remoteDeviceId";
const KEY_DEVICE_SECRET: &str = "remoteDeviceSecret";

/// Read the persisted device secret, if present and non-empty.
pub fn load_secret(db: &DbPool) -> Option<String> {
    let conn = db.get().ok()?;
    crate::db::settings_repo::get(&conn, KEY_DEVICE_SECRET)
        .ok()
        .flatten()
        .filter(|s| !s.is_empty())
}

/// Register a fresh device with CloudService and persist its id + secret,
/// overwriting any previous values. Returns `(deviceId, deviceSecret)`.
pub async fn register_and_persist(
    db: &DbPool,
    client: &CloudClient,
) -> anyhow::Result<(String, String)> {
    let (id, secret) = client.register().await?;
    let conn = db.get()?;
    crate::db::settings_repo::set(&conn, KEY_DEVICE_ID, &id)?;
    crate::db::settings_repo::set(&conn, KEY_DEVICE_SECRET, &secret)?;
    Ok((id, secret))
}

/// Return the persisted device secret, registering on first use.
pub async fn get_or_register_secret(db: &DbPool, client: &CloudClient) -> anyhow::Result<String> {
    if let Some(secret) = load_secret(db) {
        return Ok(secret);
    }
    Ok(register_and_persist(db, client).await?.1)
}

/// Run an authenticated CloudService call with the persisted device secret.
/// If the server rejects the secret as unknown (`401`), re-register once and
/// retry. A second `401` propagates as an error.
pub async fn with_reregister_on_unauthorized<T, F, Fut>(
    db: &DbPool,
    client: &CloudClient,
    op: F,
) -> anyhow::Result<T>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = Result<T, CloudError>>,
{
    let secret = get_or_register_secret(db, client).await?;
    match op(secret).await {
        Ok(value) => Ok(value),
        Err(CloudError::Unauthorized) => {
            let (_, fresh) = register_and_persist(db, client).await?;
            op(fresh).await.map_err(anyhow::Error::from)
        }
        Err(other) => Err(other.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn test_db() -> (NamedTempFile, DbPool) {
        let f = NamedTempFile::new().unwrap();
        let pool = crate::db::init_pool(&f.path().to_path_buf()).unwrap();
        (f, pool)
    }

    fn set_secret(db: &DbPool, value: &str) {
        let conn = db.get().unwrap();
        crate::db::settings_repo::set(&conn, KEY_DEVICE_SECRET, value).unwrap();
    }

    fn get_persisted(db: &DbPool, key: &str) -> Option<String> {
        let conn = db.get().unwrap();
        crate::db::settings_repo::get(&conn, key).unwrap()
    }

    #[tokio::test]
    async fn uses_existing_secret_without_registering() {
        let (_f, db) = test_db();
        set_secret(&db, "good");
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/pair/start"))
            .and(header("authorization", "Bearer good"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "code": "OK12", "expiresInSecs": 300
            })))
            .mount(&server)
            .await;
        let client = CloudClient::new(server.uri());

        let code = with_reregister_on_unauthorized(&db, &client, |s| {
            let client = &client;
            async move { client.pair_start(&s).await.map(|pc| pc.code) }
        })
        .await
        .unwrap();

        assert_eq!(code, "OK12");
        assert_eq!(get_persisted(&db, KEY_DEVICE_SECRET).as_deref(), Some("good"));
    }

    #[tokio::test]
    async fn reregisters_and_retries_on_401() {
        let (_f, db) = test_db();
        set_secret(&db, "stale");
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/pair/start"))
            .and(header("authorization", "Bearer stale"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/devices"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "deviceId": "dev-new", "deviceSecret": "fresh"
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/pair/start"))
            .and(header("authorization", "Bearer fresh"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "code": "NEW9", "expiresInSecs": 300
            })))
            .mount(&server)
            .await;
        let client = CloudClient::new(server.uri());

        let code = with_reregister_on_unauthorized(&db, &client, |s| {
            let client = &client;
            async move { client.pair_start(&s).await.map(|pc| pc.code) }
        })
        .await
        .unwrap();

        assert_eq!(code, "NEW9");
        assert_eq!(get_persisted(&db, KEY_DEVICE_SECRET).as_deref(), Some("fresh"));
        assert_eq!(get_persisted(&db, KEY_DEVICE_ID).as_deref(), Some("dev-new"));
    }

    #[tokio::test]
    async fn second_401_propagates_as_error() {
        let (_f, db) = test_db();
        set_secret(&db, "stale");
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/pair/start"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/devices"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "deviceId": "dev-new", "deviceSecret": "fresh"
            })))
            .mount(&server)
            .await;
        let client = CloudClient::new(server.uri());

        let result = with_reregister_on_unauthorized(&db, &client, |s| {
            let client = &client;
            async move { client.pair_start(&s).await.map(|pc| pc.code) }
        })
        .await;

        assert!(result.is_err());
    }
}
