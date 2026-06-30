use serde::Deserialize;
use crate::domain::clickup::{
    ClickUpAttachment, ClickUpComment, ClickUpList, ClickUpSpace, ClickUpTaskDetail, ClickUpTaskRef,
    ClickUpWorkspace,
};

const DEFAULT_BASE: &str = "https://api.clickup.com/api/v2";

#[derive(Debug, thiserror::Error)]
pub enum ClickUpError {
    #[error("clickup token invalid or expired")]
    InvalidToken,
    #[error("clickup rate limit exceeded")]
    RateLimited,
    #[error("clickup unreachable: {0}")]
    Offline(String),
    #[error("clickup api error {status}: {message}")]
    Api { status: u16, message: String },
}

pub struct ClickUpClient {
    http: reqwest::Client,
    token: String,
    base: String,
}

#[derive(Deserialize)]
struct TeamsResponse { teams: Vec<Team> }
#[derive(Deserialize)]
struct Team { id: String, name: String }

impl ClickUpClient {
    pub fn new(token: impl Into<String>) -> Self {
        Self::with_base(token, DEFAULT_BASE)
    }

    pub fn with_base(token: impl Into<String>, base: impl Into<String>) -> Self {
        Self { http: reqwest::Client::new(), token: token.into(), base: base.into() }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base.trim_end_matches('/'), path)
    }

    async fn get_json<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T, ClickUpError> {
        let resp = self.http
            .get(self.url(path))
            .header("Authorization", &self.token)
            .send().await
            .map_err(|e| ClickUpError::Offline(e.to_string()))?;
        Self::ok(resp).await?.json().await
            .map_err(|e| ClickUpError::Offline(e.to_string()))
    }

    async fn ok(resp: reqwest::Response) -> Result<reqwest::Response, ClickUpError> {
        match resp.status().as_u16() {
            200..=299 => Ok(resp),
            401 | 403 => Err(ClickUpError::InvalidToken),
            429 => Err(ClickUpError::RateLimited),
            status => {
                let message = resp.text().await.unwrap_or_default();
                Err(ClickUpError::Api { status, message })
            }
        }
    }

    pub async fn get_user(&self) -> Result<(), ClickUpError> {
        let resp = self.http
            .get(self.url("/user"))
            .header("Authorization", &self.token)
            .send().await
            .map_err(|e| ClickUpError::Offline(e.to_string()))?;
        Self::ok(resp).await.map(|_| ())
    }

    pub async fn list_workspaces(&self) -> Result<Vec<ClickUpWorkspace>, ClickUpError> {
        let r: TeamsResponse = self.get_json("/team").await?;
        Ok(r.teams.into_iter().map(|t| ClickUpWorkspace { id: t.id, name: t.name }).collect())
    }

    pub async fn post_comment(&self, task_id: &str, text: &str) -> Result<(), ClickUpError> {
        let resp = self.http
            .post(self.url(&format!("/task/{task_id}/comment")))
            .header("Authorization", &self.token)
            .json(&serde_json::json!({ "comment_text": text }))
            .send().await
            .map_err(|e| ClickUpError::Offline(e.to_string()))?;
        Self::ok(resp).await.map(|_| ())
    }
}

pub struct TaskInputRef { pub id: String, pub custom: bool }

fn looks_custom(s: &str) -> bool {
    s.contains('-') && s.chars().next().map_or(false, |c| c.is_ascii_alphabetic())
}

pub fn parse_task_input(input: &str) -> TaskInputRef {
    let t = input.trim();
    if let Some(idx) = t.find("/t/") {
        let rest = &t[idx + 3..];
        let seg: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
        if seg.len() >= 2 {
            return TaskInputRef { id: seg[1].to_string(), custom: true };
        }
        if let Some(one) = seg.first() {
            return TaskInputRef { id: (*one).to_string(), custom: looks_custom(one) };
        }
    }
    TaskInputRef { id: t.to_string(), custom: looks_custom(t) }
}

#[derive(Deserialize)] struct NamedDto { id: String, name: String }
#[derive(Deserialize)] struct SpacesResponse { spaces: Vec<NamedDto> }
#[derive(Deserialize)] struct ListsResponse { lists: Vec<NamedDto> }
#[derive(Deserialize)] struct FoldersResponse { folders: Vec<FolderDto> }
#[derive(Deserialize)] struct FolderDto { lists: Vec<NamedDto> }

#[derive(Deserialize)] struct StatusDto { status: String }
#[derive(Deserialize)] struct AttachmentDto { id: String, #[serde(default)] title: Option<String>, #[serde(default)] url: Option<String> }
#[derive(Deserialize)]
struct TaskDto {
    id: String,
    #[serde(default)] custom_id: Option<String>,
    name: String,
    #[serde(default)] description: Option<String>,
    #[serde(default)] markdown_description: Option<String>,
    #[serde(default)] text_content: Option<String>,
    #[serde(default)] status: Option<StatusDto>,
    #[serde(default)] url: Option<String>,
    #[serde(default)] attachments: Vec<AttachmentDto>,
}
#[derive(Deserialize)] struct CommentsResponse { comments: Vec<CommentDto> }
#[derive(Deserialize)] struct CommentDto {
    id: String,
    #[serde(default)] comment_text: String,
    #[serde(default)] user: Option<UserDto>,
    #[serde(default)] date: Option<String>,
}
#[derive(Deserialize)] struct UserDto { #[serde(default)] username: Option<String> }

impl ClickUpClient {
    pub async fn list_spaces(&self, workspace_id: &str) -> Result<Vec<ClickUpSpace>, ClickUpError> {
        let r: SpacesResponse = self.get_json(&format!("/team/{workspace_id}/space")).await?;
        Ok(r.spaces.into_iter().map(|s| ClickUpSpace { id: s.id, name: s.name }).collect())
    }

    pub async fn list_lists(&self, space_id: &str) -> Result<Vec<ClickUpList>, ClickUpError> {
        let mut out: Vec<ClickUpList> = Vec::new();
        let folderless: ListsResponse = self.get_json(&format!("/space/{space_id}/list")).await?;
        out.extend(folderless.lists.into_iter().map(|l| ClickUpList { id: l.id, name: l.name }));
        let folders: FoldersResponse = self.get_json(&format!("/space/{space_id}/folder")).await?;
        for f in folders.folders {
            out.extend(f.lists.into_iter().map(|l| ClickUpList { id: l.id, name: l.name }));
        }
        Ok(out)
    }

    pub async fn get_task_detail(&self, id: &str, custom: bool, team_id: Option<&str>)
        -> Result<ClickUpTaskDetail, ClickUpError>
    {
        let q = if custom {
            format!("?custom_task_ids=true&team_id={}", team_id.unwrap_or(""))
        } else { String::new() };
        let t: TaskDto = self.get_json(&format!("/task/{id}{q}")).await?;
        let comments: CommentsResponse = self.get_json(&format!("/task/{id}/comment{q}")).await?;
        let description = t.markdown_description
            .filter(|s| !s.is_empty())
            .or(t.description)
            .or(t.text_content)
            .unwrap_or_default();
        Ok(ClickUpTaskDetail {
            id: t.id,
            custom_id: t.custom_id,
            name: t.name,
            description,
            status: t.status.map(|s| s.status),
            url: t.url.unwrap_or_default(),
            attachments: t.attachments.into_iter().map(|a| ClickUpAttachment {
                id: a.id,
                title: a.title.unwrap_or_else(|| "(załącznik)".into()),
                url: a.url.unwrap_or_default(),
            }).collect(),
            comments: comments.comments.into_iter().map(|c| ClickUpComment {
                id: c.id,
                user: c.user.and_then(|u| u.username).unwrap_or_else(|| "?".into()),
                text: c.comment_text,
                date: c.date.and_then(|d| d.parse().ok()).unwrap_or(0),
            }).collect(),
        })
    }
}

pub enum QueryKind { Id, Name }

pub fn classify_query(q: &str) -> QueryKind {
    let t = q.trim();
    let no_space = !t.chars().any(char::is_whitespace);
    let alnum_id = t.chars().all(|c| c.is_ascii_alphanumeric()) && t.chars().any(|c| c.is_ascii_digit());
    if no_space && (t.starts_with("http") || looks_custom(t) || alnum_id) {
        QueryKind::Id
    } else {
        QueryKind::Name
    }
}

#[derive(Deserialize)] struct TasksResponse { tasks: Vec<TaskDto> }

impl ClickUpClient {
    fn task_ref(t: TaskDto) -> ClickUpTaskRef {
        ClickUpTaskRef {
            id: t.id,
            custom_id: t.custom_id,
            name: t.name,
            status: t.status.map(|s| s.status),
            url: t.url.unwrap_or_default(),
            list_name: None,
        }
    }

    pub async fn list_tasks_in_list(&self, list_id: &str) -> Result<Vec<ClickUpTaskRef>, ClickUpError> {
        let r: TasksResponse = self.get_json(&format!("/list/{list_id}/task")).await?;
        Ok(r.tasks.into_iter().map(Self::task_ref).collect())
    }

    pub async fn list_tasks_in_space(&self, team_id: &str, space_id: &str)
        -> Result<Vec<ClickUpTaskRef>, ClickUpError>
    {
        let r: TasksResponse = self
            .get_json(&format!("/team/{team_id}/task?space_ids[]={space_id}"))
            .await?;
        Ok(r.tasks.into_iter().map(Self::task_ref).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn get_user_ok_sends_authorization_header() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/user"))
            .and(header("authorization", "pk_test"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "user": { "id": 1, "username": "u" }
            })))
            .mount(&server).await;
        let client = ClickUpClient::with_base("pk_test", server.uri());
        client.get_user().await.unwrap();
    }

    #[tokio::test]
    async fn get_user_401_maps_invalid_token() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/user"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server).await;
        let client = ClickUpClient::with_base("bad", server.uri());
        assert!(matches!(client.get_user().await.unwrap_err(), ClickUpError::InvalidToken));
    }

    #[tokio::test]
    async fn list_workspaces_parses_teams() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/team"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "teams": [ { "id": "111", "name": "Acme" }, { "id": "222", "name": "Beta" } ]
            })))
            .mount(&server).await;
        let client = ClickUpClient::with_base("pk_test", server.uri());
        let ws = client.list_workspaces().await.unwrap();
        assert_eq!(ws.len(), 2);
        assert_eq!(ws[0].id, "111");
        assert_eq!(ws[0].name, "Acme");
    }

    #[tokio::test]
    async fn rate_limit_maps_429() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/team"))
            .respond_with(ResponseTemplate::new(429))
            .mount(&server).await;
        let client = ClickUpClient::with_base("pk_test", server.uri());
        assert!(matches!(client.list_workspaces().await.unwrap_err(), ClickUpError::RateLimited));
    }

    #[test]
    fn parse_plain_id() {
        let r = parse_task_input("868abc12");
        assert_eq!(r.id, "868abc12");
        assert!(!r.custom);
    }
    #[test]
    fn parse_custom_id() {
        let r = parse_task_input("CU-123");
        assert_eq!(r.id, "CU-123");
        assert!(r.custom);
    }
    #[test]
    fn parse_url_with_team_and_custom() {
        let r = parse_task_input("https://app.clickup.com/t/9008/CU-123");
        assert_eq!(r.id, "CU-123");
        assert!(r.custom);
    }
    #[test]
    fn parse_url_plain() {
        let r = parse_task_input("https://app.clickup.com/t/868abc12");
        assert_eq!(r.id, "868abc12");
        assert!(!r.custom);
    }

    #[tokio::test]
    async fn list_spaces_parses() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/team/111/space"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "spaces": [ { "id": "s1", "name": "Space 1" } ]
            }))).mount(&server).await;
        let c = ClickUpClient::with_base("pk", server.uri());
        let s = c.list_spaces("111").await.unwrap();
        assert_eq!(s[0].name, "Space 1");
    }

    #[tokio::test]
    async fn get_task_detail_maps_description_status_attachments_and_comments() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/task/868abc12"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "868abc12", "custom_id": "CU-9", "name": "Fix bug",
                "markdown_description": "## do it",
                "status": { "status": "in progress" },
                "url": "https://app.clickup.com/t/868abc12",
                "attachments": [ { "id": "a1", "title": "log.txt", "url": "https://files/a1" } ]
            }))).mount(&server).await;
        Mock::given(method("GET")).and(path("/task/868abc12/comment"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "comments": [ { "id": "c1", "comment_text": "hi", "user": { "username": "ann" }, "date": "1700000000000" } ]
            }))).mount(&server).await;
        let c = ClickUpClient::with_base("pk", server.uri());
        let d = c.get_task_detail("868abc12", false, None).await.unwrap();
        assert_eq!(d.name, "Fix bug");
        assert_eq!(d.description, "## do it");
        assert_eq!(d.status.as_deref(), Some("in progress"));
        assert_eq!(d.attachments[0].title, "log.txt");
        assert_eq!(d.comments[0].user, "ann");
        assert_eq!(d.comments[0].date, 1_700_000_000_000);
    }

    #[test]
    fn classify_query_distinguishes_id_and_name() {
        assert!(matches!(classify_query("CU-123"), QueryKind::Id));
        assert!(matches!(classify_query("868abc12"), QueryKind::Id));
        assert!(matches!(classify_query("https://app.clickup.com/t/868abc12"), QueryKind::Id));
        assert!(matches!(classify_query("fix login bug"), QueryKind::Name));
        assert!(matches!(classify_query("logowanie"), QueryKind::Name));
    }

    #[tokio::test]
    async fn list_tasks_in_list_maps_refs() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/list/li9/task"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "tasks": [ { "id": "t1", "name": "Alpha", "status": { "status": "open" },
                             "url": "https://app.clickup.com/t/t1" } ]
            }))).mount(&server).await;
        let c = ClickUpClient::with_base("pk", server.uri());
        let r = c.list_tasks_in_list("li9").await.unwrap();
        assert_eq!(r[0].id, "t1");
        assert_eq!(r[0].name, "Alpha");
        assert_eq!(r[0].status.as_deref(), Some("open"));
    }

    #[tokio::test]
    async fn post_comment_sends_body() {
        let server = MockServer::start().await;
        Mock::given(method("POST")).and(path("/task/t1/comment"))
            .and(wiremock::matchers::body_json(serde_json::json!({ "comment_text": "done" })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "id": "c1" })))
            .mount(&server).await;
        let c = ClickUpClient::with_base("pk", server.uri());
        c.post_comment("t1", "done").await.unwrap();
    }
}
