# Supervisor Discord Buttons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The supervisor's Discord batches become app-rendered Components V2 messages with one-tap buttons for short answers and for production approvals, kept in sync with decisions made anywhere else.

**Architecture:** The supervisor passes structured batches to a new MCP tool; the core validates them and hands them (through `Effects`) to a Discord buttons service that assigns keys, renders, posts and tracks messages in an in-memory registry. The same service runs its own gateway connection (`intents: 0`) for `INTERACTION_CREATE`: approval clicks resolve approvals in the core directly, option clicks become a `discordAnswer` event for the supervisor. The core reports every settle (session moved on, question dismissed, approval resolved or expired) to the service, which PATCHes the affected message.

**Tech Stack:** Rust (Tauri 2 backend, `tokio`, `reqwest` 0.12, `tokio-tungstenite` 0.29, `parking_lot`, `serde_json`, `wiremock` in tests), React 19 + Vitest for one status row.

**Spec:** `docs/superpowers/specs/2026-11-01-supervisor-discord-buttons-design.md`

## Global Constraints

- Work in `DesktopApp/`; Rust commands from `DesktopApp/src-tauri`, npm from `DesktopApp`. Commit directly on local `main`.
- Identifiers in English; user-facing copy in Polish, exactly as given in this plan.
- No code comments. Commits: Conventional Commits, `feat(desktop):` / `fix(desktop):` / `docs(desktop):`, no co-author or session trailer.
- Never log or return the bot token or an interaction token.
- Every Discord message the app sends: `"flags": 32768` (Components V2) and `"allowed_mentions": {"parse": []}`; never a `content` field on V2 messages.
- Limits: ≤ 40 components per message (counted recursively), ≤ 4000 characters across text displays, ≤ 5 buttons per action row; item options 0–5, each 1–25 characters; question 1–300 characters; context ≤ 300 characters.
- `custom_id` formats: `abeon:q:<item_id>:<option_index>` and `abeon:a:<approval_id>:y|n`.
- An interaction callback goes out before any slow work; the registry lock is never held across an `.await`.
- Verification commands: `cargo test --lib` (from `src-tauri`), `npm run lint`, `npx vitest run --maxWorkers=3` (plain `npm test` flakes under load).

## Review Focus

1. **The supervisor retries `discord_post` after a timeout although the first call went out** → the question must not appear twice. Test in Task 3 (`posting_an_open_question_again_is_skipped`).
2. **Supervisor restarting when the user taps an option** → `discord_active` is briefly false, but the click must be accepted and queued, not refused. Test in Task 7 (`accepts_discord_answers_while_the_supervisor_restarts`).
3. **Backticks or Markdown in supervisor-provided text** (question, option, context) → the layout and the code-span hints must not break. Test in Task 2 (`backticks_in_supervisor_text_do_not_break_code_spans`).
4. **Session labels without ` · ` or project names starting with a non-ASCII letter** (`Sesja 0123abcd`, `Łódź`) → a sensible title and key letter. Tests in Task 2 and Task 3.
5. **The bot token changes in Settings while the gateway is connected** → it reconnects with the new token. Test in Task 9 (`reconfigure_with_a_new_token_reconnects`).

---

### Task 1: Escalations keep their question id

**Files:**
- Modify: `src-tauri/src/domain/supervisor.rs` (`EscalationView`)
- Modify: `src-tauri/src/supervisor/events.rs` (`ForwardedEscalation`)
- Modify: `src-tauri/src/supervisor/core.rs` (`escalate_question`, `forwarded_escalation`, tests)
- Regenerated: `src/types/EscalationView.ts` (by `cargo test`); fix any frontend fixture that builds an `EscalationView` literal.

**Interfaces:**
- Produces: `EscalationView.question_id: String` (TS `questionId: string`), `ForwardedEscalation.question_id: String` (JSON `question_id`).

- [ ] **Step 1: Write the failing tests** in `core.rs` tests:

```rust
#[test]
fn escalation_keeps_the_question_id() {
    // open a turn-end question for "s1" as neighbouring escalate tests do, then escalate it
    assert_eq!(core.snapshot().escalations[0].question_id, question_id);
}

#[test]
fn forwarded_escalations_carry_the_question_id() {
    // escalate while present (channel App), activate Discord, leave → Forwarded event
    assert_eq!(forwarded.escalations[0].question_id, question_id);
}
```

- [ ] **Step 2: Run** `cargo test --lib supervisor::core` → FAIL (no field `question_id`).
- [ ] **Step 3: Implement.** Add the field after `session_id` in both structs, set it from `question.id` in `escalate_question`, copy it in `forwarded_escalation`, update the existing JSON-shape tests in `events.rs` and every struct literal.
- [ ] **Step 4: Run** `cargo test --lib` → PASS; `npm run lint` → 0 errors (fix fixtures that now miss `questionId`).
- [ ] **Step 5: Commit** `feat(desktop): keep the question id on supervisor escalations`.

---

### Task 2: Renderer for Components V2 batches

**Files:**
- Create: `src-tauri/src/supervisor/discord/render.rs`
- Modify: `src-tauri/src/supervisor/discord/mod.rs` (`pub mod render;`)

**Interfaces:**
- Produces (all `pub`, in `render.rs`):

```rust
#[derive(Clone, Debug, PartialEq)]
pub enum ItemState { Open, Clicked(String), Answered(String), Settled }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalMark { Pending, Approved, Rejected, Expired }
#[derive(Clone, Debug, PartialEq)]
pub struct ItemView { pub item_id: String, pub key: String, pub question: String, pub context: Option<String>,
                      pub options: Vec<String>, pub text_options: Vec<String>, pub state: ItemState }
#[derive(Clone, Debug, PartialEq)]
pub struct ApprovalRow { pub approval_id: String, pub action: String, pub code: String, pub mark: ApprovalMark }
#[derive(Clone, Debug, PartialEq)]
pub struct BlockView { pub label: String, pub continued: bool, pub items: Vec<ItemView>, pub approvals: Vec<ApprovalRow> }
#[derive(Clone, Debug, PartialEq)]
pub struct MessageView { pub header: Option<String>, pub blocks: Vec<BlockView>, pub footer: Option<String> }

pub const STALE_TEXT: &str = "⌛ Nieaktualne — odpowiedz tekstem";
pub fn project_and_title(label: &str) -> (String, Option<String>);
pub fn accent(project: &str) -> u32;
pub fn header(blocks: &[BlockView]) -> String;
pub fn footer(blocks: &[BlockView]) -> Option<String>;
pub fn render(view: &MessageView) -> serde_json::Value;
pub fn split(blocks: Vec<BlockView>, header: Option<String>, footer: Option<String>) -> Vec<MessageView>;
pub fn replace_row(components: &serde_json::Value, custom_id: &str, text: &str) -> serde_json::Value;
pub fn component_count(components: &serde_json::Value) -> usize;
pub fn text_length(components: &serde_json::Value) -> usize;
```

Exact output (spec §3):
- `render` → `{"flags": 32768, "allowed_mentions": {"parse": []}, "components": [...]}`. Order: header text display (type 10) if `Some`, one container per block (type 17, `accent_color: accent(project)`), footer text display if `Some`.
- `header` → `**🧭 Do decyzji: <projekt> (<parts>) · …**` in first-seen project order, blocks of one project summed; parts joined by ` + `: question count if > 0; approvals `zgoda` (1), `<n> zgody` (2–4), `<n> zgód` (≥ 5). E.g. `**🧭 Do decyzji: zargood (3) · therappio (1 + zgoda)**`.
- `project_and_title` splits at the first ` · `; without it the whole label is the project and the title is `None`.
- Container contents: title `**📁 <projekt>** — <tytuł>` (+ ` (cd.)` when `continued`; without a title just `**📁 <projekt>**`). Per item one text display: `**<key>** <question>`, then `\n-# albo odpisz ` + text options as `` `<key> <option>: …` `` joined by ` · ` (only if any), then `\n-# <context>` (only if `Some`). Then, if the item is `Open` and has options, an action row of secondary buttons (`style: 2`, `label: option`, `custom_id: abeon:q:<item_id>:<index>`); if not `Open`, a text display with the state text: `✅ <key>: <value>` (Clicked; Answered with the value shortened to 40 characters + `…`), `✅ <key>: rozstrzygnięte` (Settled). Per approval: text `` 🔒 **Zgoda:** `<action>` · kod `<code>` `` and, when `Pending`, a row `✅ Zatwierdź` (`style: 3`, `emoji: {"name": "✅"}`, label `Zatwierdź`, `abeon:a:<id>:y`) + `❌ Odrzuć` (`style: 4`, label `Odrzuć`, `abeon:a:<id>:n`); otherwise a text display `✅ Zatwierdzono` / `❌ Odrzucono` / `⌛ Wygasło`.
- `footer` → `-# Możesz też odpisać tekstem, np. ` + `` `<key> <first option>` `` for the first up to three items that have options, joined by `, ` inside one code span (`` `S1 tak, S2 prod` ``); `None` when no item has options.
- Backticks in question, context, option and value text are replaced with `'` before rendering (inside code spans and plain text alike).
- `accent`: palette `[0x5865F2, 0x3BA55C, 0xFAA61A, 0xEB459E, 0x00A8FC, 0xED4245]`, index = 32-bit FNV-1a of the project name modulo 6.
- `split`: greedy by blocks; a message holds header (first only) + blocks + footer (last only) within 40 components and 4000 characters; a block that does not fit in an empty message is cut between items/approvals and continues with `continued: true` in the next message.
- `replace_row`: walks components recursively and replaces the action row (type 1) containing a button with that `custom_id` by `{"type": 10, "content": text}`.

- [ ] **Step 1: Write the failing tests** in `render.rs`:

```rust
#[test] fn header_counts_questions_and_approvals_per_project() {
    // blocks: zargood·A (2 items), zargood·B (1 item), therappio·C (1 item + 1 approval)
    assert_eq!(header(&blocks), "**🧭 Do decyzji: zargood (3) · therappio (1 + zgoda)**");
}
#[test] fn header_uses_polish_plurals_for_approvals() { /* 0 items + 3 approvals → "(3 zgody)", 5 → "(5 zgód)", 1 → "(zgoda)" */ }
#[test] fn render_puts_buttons_under_their_question() {
    let json = render(&view);
    assert_eq!(json["flags"], 32768);
    assert!(json.get("content").is_none());
    // container 1: title, item text "**S1** Akceptujesz?", row with custom_ids ["abeon:q:i1:0","abeon:q:i1:1"]
}
#[test] fn render_shows_text_options_and_context_as_small_text() {
    // item text == "**S1** Akceptujesz?\n-# albo odpisz `S1 uwagi: …`\n-# Sesja przyjęła założenia."
}
#[test] fn render_pending_approval_has_success_and_danger_buttons() { /* styles 3 and 4, ids abeon:a:a1:y / :n, text "🔒 **Zgoda:** `git push → master` · kod `K7QX`" */ }
#[test] fn resolved_states_replace_the_row_with_text() {
    // Clicked("tak") → "✅ S1: tak"; Answered(<60 chars>) → 40 chars + "…"; Settled → "✅ S1: rozstrzygnięte"
    // Approved/Rejected/Expired → "✅ Zatwierdzono" / "❌ Odrzucono" / "⌛ Wygasło"; no type-1 row left for them
}
#[test] fn footer_samples_the_first_three_keys_with_options() { assert_eq!(footer(&blocks).unwrap(), "-# Możesz też odpisać tekstem, np. `S1 tak, S2 prod, B1 tak`"); }
#[test] fn label_without_separator_is_the_whole_project() { assert_eq!(project_and_title("Sesja 0123abcd"), ("Sesja 0123abcd".into(), None)); }
#[test] fn accent_is_stable_and_from_the_palette() { assert_eq!(accent("zargood"), accent("zargood")); assert!(PALETTE.contains(&accent("therappio"))); }
#[test] fn split_keeps_a_small_batch_in_one_message() {}
#[test] fn split_moves_a_block_that_does_not_fit_to_the_next_message() {}
#[test] fn split_continues_an_oversized_block_as_cd() {
    // one block, 6 items × 5 options → 2 messages; messages[1].blocks[0].continued; header only in [0], footer only in [1]
    // every rendered message: component_count(&json["components"]) <= 40 && text_length(&json["components"]) <= 4000
}
#[test] fn replace_row_swaps_only_the_clicked_row() {}
#[test] fn backticks_in_supervisor_text_do_not_break_code_spans() { /* option "a`b" → button label "a'b", footer sample "`S1 a'b`" */ }
```

- [ ] **Step 2: Run** `cargo test --lib supervisor::discord::render` → FAIL (module missing).
- [ ] **Step 3: Implement** `render.rs` per the interface and exact output above.
- [ ] **Step 4: Run** `cargo test --lib supervisor::discord::render` → PASS.
- [ ] **Step 5: Commit** `feat(desktop): render supervisor Discord batches as Components V2 messages`.

---

### Task 3: Registry of posted batches and answer keys

**Files:**
- Create: `src-tauri/src/supervisor/discord/registry.rs`
- Modify: `src-tauri/src/supervisor/discord/mod.rs`

**Interfaces:**
- Consumes: Task 2 `ItemState`, `ApprovalMark`, `ItemView`, `ApprovalRow`, `BlockView`, `MessageView`, `header`, `footer`, `split`, `project_and_title`.
- Produces:

```rust
#[derive(Clone, Debug, PartialEq)]
pub struct PostItem { pub question_id: String, pub question: String, pub options: Vec<String>,
                      pub text_options: Vec<String>, pub context: Option<String> }
#[derive(Clone, Debug, PartialEq)]
pub struct PostApproval { pub approval_id: String, pub action: String, pub code: String }
#[derive(Clone, Debug, PartialEq)]
pub struct PostBlock { pub session_id: String, pub label: String, pub items: Vec<PostItem>, pub approvals: Vec<PostApproval> }
#[derive(Clone, Debug, PartialEq)]
pub struct PostRequest { pub blocks: Vec<PostBlock> }
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct PostedKey { pub question_id: String, pub question: String, pub key: String }
#[derive(serde::Serialize, Clone, Debug, PartialEq, Default)]
pub struct PostResult { pub posted: usize, pub keys: Vec<PostedKey>, pub skipped: Vec<String> }
#[derive(Clone, Debug, PartialEq)]
pub struct KeyAnswer { pub key: String, pub value: String }
#[derive(Clone, Debug, PartialEq)]
pub struct ClickedOption { pub question_id: String, pub session_id: String, pub label: String, pub key: String,
                           pub question: String, pub value: String, pub open_keys: Vec<String> }
#[derive(Clone, Debug, PartialEq)]
pub enum ButtonTarget { Option { message: u64, item_id: String, index: usize },
                        Approval { message: u64, approval_id: String, approve: bool } }
pub struct PlannedPost { pub messages: Vec<u64>, pub result: PostResult }
pub struct AnswerOutcome { pub changed: Vec<u64>, pub skipped: Vec<String> }

#[derive(Default)] pub struct ButtonRegistry { /* private */ }
impl ButtonRegistry {
    pub fn plan_post(&mut self, request: PostRequest) -> PlannedPost;
    pub fn view(&self, message: u64) -> Option<MessageView>;
    pub fn discord_id(&self, message: u64) -> Option<String>;
    pub fn confirm_posted(&mut self, message: u64, discord_id: String);
    pub fn discard(&mut self, message: u64);
    pub fn target(&self, custom_id: &str) -> Option<ButtonTarget>;
    pub fn click_option(&mut self, item_id: &str, index: usize) -> Option<ClickedOption>;
    pub fn mark_approval(&mut self, approval_id: &str, mark: ApprovalMark) -> Option<u64>;
    pub fn answer_keys(&mut self, answers: &[KeyAnswer]) -> AnswerOutcome;
    pub fn settle_session(&mut self, session_id: &str) -> Vec<u64>;
    pub fn settle_question(&mut self, question_id: &str) -> Vec<u64>;
}
```

Rules (spec §1, §2, §4):
- `plan_post` skips a `question_id` that already has an `Open` item and an approval already registered as `Pending` (ids go to `skipped`), assigns keys, creates items with an 8-hex-character random `item_id`, computes `header`/`footer` over all new blocks, lays them out with `split`, stores each message under a new local id (u64, increasing) and returns those ids plus `result.keys` (one `PostedKey` per item, in input order) and `result.posted` = number of messages. A request whose items and approvals were all skipped plans no message.
- Keys: prefix = uppercased first n alphanumeric characters of the project name (from `project_and_title(label).0`; `X` when it has none), n = smallest n ≥ 1 for which the prefix differs from the first n characters of every other project that has `Open` items; number = per-prefix counter that only increases during the app run. Existing keys never change.
- `target` parses both `custom_id` formats and returns `None` for anything unknown (including other prefixes such as `perm:`).
- `click_option` acts only on an `Open` item and a valid index: sets `Clicked(option)`, returns `ClickedOption` whose `open_keys` are the other `Open` items' keys with the same `question_id`, in key order.
- `mark_approval`, `answer_keys`, `settle_*` return the local ids of messages whose rendered state changed (each id once); unchanged calls return nothing. `answer_keys` closes only `Open` keys (`Answered(value)`); others go to `skipped`. `settle_*` turn `Open` items into `Settled` and leave approvals alone.
- `discard` removes the message and its items/approvals so they can be posted again.

- [ ] **Step 1: Write the failing tests:**

```rust
#[test] fn keys_use_the_projects_first_letter_and_count_up() { /* sklep: S1, S2; blog: B1 */ }
#[test] fn keys_lengthen_only_for_new_items_when_letters_collide() {
    // post sklep → "S1"; post serwis while S1 open → "SE1"; post sklep again → "SK1"; S1 still "S1"
}
#[test] fn keys_are_not_reused_after_an_item_closes() { /* S1 answered, next sklep item → "S2" */ }
#[test] fn keys_use_the_uppercase_first_letter_of_unicode_names() { /* "łódź · x" → "Ł1"; label "Sesja 0123abcd" → "S1" */ }
#[test] fn posting_an_open_question_again_is_skipped() {
    let second = registry.plan_post(same_request);
    assert_eq!(second.result.skipped, vec!["q1".to_string()]);
    assert!(second.messages.is_empty());
}
#[test] fn a_pending_approval_is_posted_once() {}
#[test] fn target_parses_both_custom_id_formats_and_rejects_others() { /* "perm:allow:abcde" → None */ }
#[test] fn click_option_returns_the_answer_and_the_still_open_keys() {
    // q1 split into S1, S2 → click S1 index 0 → value "tak", open_keys ["S2"]; second click → None
}
#[test] fn answer_keys_closes_open_keys_and_skips_the_rest() { /* ["S1" open, "S9" unknown] → skipped ["S9"] */ }
#[test] fn settle_session_closes_only_open_items_of_that_session() {}
#[test] fn mark_approval_reports_a_change_once() { /* Approved → Some(id); Approved again → None */ }
#[test] fn discard_lets_the_same_question_be_posted_again() {}
#[test] fn view_reflects_the_current_state() { /* after click: item state Clicked("tak") in view() */ }
```

- [ ] **Step 2: Run** `cargo test --lib supervisor::discord::registry` → FAIL.
- [ ] **Step 3: Implement** `registry.rs` per the interface and rules.
- [ ] **Step 4: Run** the same command → PASS.
- [ ] **Step 5: Commit** `feat(desktop): track posted Discord batches and assign answer keys`.

---

### Task 4: REST client for posting, editing and interaction callbacks

**Files:**
- Modify: `src-tauri/src/supervisor/discord/client.rs`

**Interfaces:**
- Produces on `DiscordClient`:

```rust
pub async fn post_message(&self, channel_id: &str, payload: &serde_json::Value) -> Result<String, DiscordError>; // message id
pub async fn edit_message(&self, channel_id: &str, message_id: &str, payload: &serde_json::Value) -> Result<(), DiscordError>;
pub async fn interaction_callback(&self, interaction_id: &str, interaction_token: &str, payload: &serde_json::Value) -> Result<(), DiscordError>;
```
- New variant `DiscordError::RateLimited(std::time::Duration)` with message `Discord ogranicza liczbę zapytań`, built from a 429 body `{"retry_after": <seconds as float>}`.
- `interaction_callback` sends `POST /interactions/{id}/{token}/callback` **without** the `Authorization` header (as in the spike) and treats 204 as success.

- [ ] **Step 1: Write the failing wiremock tests:** `post_message_returns_the_new_message_id` (POST `/channels/d1/messages`, body passes through, response `{"id":"m1"}` → `"m1"`), `edit_message_patches_the_message` (PATCH `/channels/d1/messages/m1`), `interaction_callback_sends_no_bot_token` (`server.received_requests()` has no `authorization` header; 204 → `Ok`), `rate_limit_maps_to_retry_after` (429 `{"retry_after":1.5}` → `RateLimited(Duration::from_millis(1500))`).
- [ ] **Step 2: Run** `cargo test --lib supervisor::discord::client` → FAIL.
- [ ] **Step 3: Implement** the three methods and the 429 mapping in the shared `send` path.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(desktop): post, edit and answer interactions through the Discord REST client`.

---

### Task 5: Gateway client for button clicks

**Files:**
- Create: `src-tauri/src/supervisor/discord/gateway.rs`
- Modify: `src-tauri/src/supervisor/discord/mod.rs`

**Interfaces:**
- Produces:

```rust
pub const GATEWAY_URL: &str = "wss://gateway.discord.gg/?v=10&encoding=json";
#[derive(Clone, Debug, PartialEq)]
pub struct Interaction { pub id: String, pub token: String, pub user_id: String, pub custom_id: String,
                         pub message_id: String, pub message_components: serde_json::Value }
#[derive(Clone, Debug, PartialEq)]
pub enum GatewayStatus { Off(String), Connecting, Connected, Failed(String) }
pub async fn run_gateway(url: String, token: String,
                         interactions: tokio::sync::mpsc::UnboundedSender<Interaction>,
                         status: tokio::sync::watch::Sender<GatewayStatus>,
                         stop: tokio::sync::watch::Receiver<bool>);
```

Behaviour (spec §5):
- On HELLO (op 10), start heartbeats (first after `interval × jitter`), then IDENTIFY `{"op":2,"d":{"token":…,"intents":0,"properties":{"os":std::env::consts::OS,"browser":"abeoncode","device":"abeoncode"}}}`. READY → `Connected`.
- Dispatch `INTERACTION_CREATE` with `d.type == 3` → `Interaction` (`user_id` from `d.user.id`, else `d.member.user.id`; `custom_id` from `d.data.custom_id`; `message_id`/`message_components` from `d.message`). Other interaction types are ignored.
- op 1 → heartbeat now; op 7 → reconnect; op 9 → reconnect after 1–5 s with a fresh IDENTIFY; a heartbeat due with no op 11 since the last one → close and reconnect.
- Close code 4004 → `Failed("Discord odrzucił token bota")` and return; 4010–4014 → `Failed("Discord odrzucił połączenie bramki (kod <n>)")` and return; anything else → `Connecting`, reconnect with backoff 1 s doubling to 60 s, reset after READY.
- `stop` becoming `true` closes the socket and returns.

- [ ] **Step 1: Write the failing tests** against a local `tokio_tungstenite::accept_async` server on `127.0.0.1:0`, with `heartbeat_interval` 50 ms: `identifies_with_zero_intents_after_hello`, `forwards_component_interactions` (fields equal the payload's), `ignores_non_component_interactions` (type 2 → nothing within 200 ms), `answers_heartbeat_requests_immediately`, `reconnects_after_op_7` (second accept receives an IDENTIFY), `stops_on_auth_failure` (close 4004 → status `Failed("Discord odrzucił token bota")`, function returns), `stops_when_asked`.
- [ ] **Step 2: Run** `cargo test --lib supervisor::discord::gateway` → FAIL.
- [ ] **Step 3: Implement** `run_gateway` on `tokio-tungstenite` (rustls feature already enabled); jitter from `uuid::Uuid::new_v4()` bytes, no new dependency.
- [ ] **Step 4: Run** → PASS (run 3× to make sure it is not timing-flaky).
- [ ] **Step 5: Commit** `feat(desktop): receive Discord button clicks over a gateway connection`.

---

### Task 6: Core reports settles to Discord; Effects gains the Discord calls

**Files:**
- Create: `src-tauri/src/supervisor/discord/jobs.rs`
- Modify: `src-tauri/src/supervisor/effects.rs`, `src-tauri/src/supervisor/approvals.rs`, `src-tauri/src/supervisor/core.rs`, `src-tauri/src/supervisor/core/operations.rs`, `src-tauri/src/supervisor/core/production.rs`, `src-tauri/src/supervisor/test_support.rs`, `src-tauri/src/supervisor/runtime.rs` (`AppEffects`)

**Interfaces:**
- Consumes: Task 3 `PostRequest`, `PostResult`, `KeyAnswer`.
- Produces:

```rust
// effects.rs
#[derive(Clone, Debug, PartialEq)]
pub enum DiscordSync {
    SessionSettled { session_id: String },
    QuestionSettled { question_id: String },
    ApprovalSettled { approval_id: String, state: crate::supervisor::core::ApprovalState },
}
// added to trait Effects:
fn discord_sync(&self, change: DiscordSync);                                   // never blocks
fn discord_post(&self, request: PostRequest) -> Result<PostResult, String>;    // blocking, only from handle_tool
fn discord_answered(&self, answers: Vec<KeyAnswer>) -> Result<Vec<String>, String>;

// discord/jobs.rs
pub const REPLY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
pub const ERROR_BUTTONS_OFFLINE: &str = "Przyciski Discorda nie działają — wyślij wiadomość przez reply";
pub enum ButtonJob {
    Post { request: PostRequest, reply: std::sync::mpsc::Sender<Result<PostResult, String>> },
    Answered { answers: Vec<KeyAnswer>, reply: std::sync::mpsc::Sender<Vec<String>> },
    Sync(DiscordSync),
    Reconfigure,
}
#[derive(Clone)] pub struct ButtonsHandle { /* UnboundedSender<ButtonJob> */ }
impl ButtonsHandle {
    pub fn new(jobs: tokio::sync::mpsc::UnboundedSender<ButtonJob>) -> Self;
    pub fn sync(&self, change: DiscordSync);
    pub fn reconfigure(&self);
    pub fn post(&self, request: PostRequest) -> Result<PostResult, String>;   // post_with_timeout(request, REPLY_TIMEOUT)
    pub fn post_with_timeout(&self, request: PostRequest, timeout: std::time::Duration) -> Result<PostResult, String>;
    pub fn answered(&self, answers: Vec<KeyAnswer>) -> Result<Vec<String>, String>;
}
// approvals.rs
pub fn take_expired(&mut self, now: Instant) -> Vec<Approval>;
// core
pub(crate) fn report_expired_approvals(&self, now: Instant); // called from tick() with now()
```
- `AppEffects` gets `buttons: OnceLock<ButtonsHandle>` and `pub fn set_buttons(&self, handle: ButtonsHandle)`; without a handle `discord_sync` does nothing and the other two return `Err(ERROR_BUTTONS_OFFLINE)`. Timeout or a dropped reply → `Err(ERROR_BUTTONS_OFFLINE)`.
- `FakeEffects` records `discord_syncs: Mutex<Vec<DiscordSync>>`, `discord_posts: Mutex<Vec<PostRequest>>`, `discord_answers: Mutex<Vec<Vec<KeyAnswer>>>`, and returns `discord_post_result: Mutex<Result<PostResult, String>>` (default `Ok(PostResult::default())`) and `discord_answered_skipped: Mutex<Vec<String>>`.
- Emission points (spec §8): `send_to_session` success → `SessionSettled`; Human `UserPromptSubmit` → `SessionSettled`; `forget_session` → `SessionSettled` (through a new `Outbox.discord` vector flushed by `flush`); `dismiss_escalation` → `QuestionSettled` with that escalation's `question_id`; `resolve_approval` (any source) → `ApprovalSettled` `Approved`/`Rejected`; `report_expired_approvals` → `ApprovalSettled` `Expired` for every expired approval whose record has no outcome, once.

- [ ] **Step 1: Write the failing tests** (core tests, `FakeEffects.discord_syncs`): `send_to_session_settles_the_session_on_discord`, `human_prompt_settles_the_session_on_discord`, `agent_prompt_does_not_settle_on_discord`, `dismissing_an_escalation_settles_its_question_on_discord`, `rebind_settles_the_forgotten_session_on_discord`, `resolving_an_approval_reports_it_to_discord` (both `ApprovalSource::App` and `::Discord`), `expired_approvals_are_reported_once` (`core.report_expired_approvals(Instant::now() + Duration::from_secs(25 * 3600))` twice → one `Expired`); in `approvals.rs`: `take_expired_returns_each_expired_approval_once`; in `jobs.rs`: `post_times_out_into_the_offline_error` (receiver kept alive but never read, `post_with_timeout(request, Duration::from_millis(50))` → `Err(ERROR_BUTTONS_OFFLINE)`) and `post_without_a_consumer_fails_at_once` (receiver dropped → `Err(ERROR_BUTTONS_OFFLINE)`).
- [ ] **Step 2: Run** `cargo test --lib supervisor` → FAIL.
- [ ] **Step 3: Implement** per the interfaces; keep `discord_sync` calls outside the state lock (collect into the outbox or call after the lock is dropped).
- [ ] **Step 4: Run** `cargo test --lib` → PASS.
- [ ] **Step 5: Commit** `feat(desktop): report supervisor settles to the Discord buttons service`.

---

### Task 7: `discordAnswer` event and the two supervisor tools

**Files:**
- Modify: `src-tauri/src/supervisor/events.rs`, `src-tauri/src/supervisor/core.rs`, `src-tauri/src/supervisor/core/operations.rs`, `src-tauri/src/supervisor/tools.rs`

**Interfaces:**
- Consumes: Task 3 `PostItem`, `PostBlock`, `PostApproval`, `PostRequest`, `PostResult`, `KeyAnswer`, `ClickedOption`; Task 6 `Effects::discord_post` / `discord_answered`.
- Produces:

```rust
// events.rs, new variant (wakes_supervisor → true)
DiscordAnswer { question_id: String, session_id: String, label: String, key: String,
                question: String, value: String, open_keys: Vec<String> },
// core
pub struct DiscordPostItemInput { pub question_id: String, pub question: String, pub options: Vec<String>,
                                  pub text_options: Vec<String>, pub context: Option<String> }
pub fn accepts_discord_answers(&self) -> bool;   // level != Off && settings.discord_enabled && settings.discord_chat_id.is_some()
pub fn record_discord_answer(&self, answer: ClickedOption);
pub fn discord_post(&self, items: Vec<DiscordPostItemInput>, approval_ids: Vec<String>) -> Result<PostResult, String>;
pub fn discord_answered(&self, answers: Vec<KeyAnswer>) -> Result<Vec<String>, String>;
```
- Tool `discord_post` input (spec §1): `{"blocks":[{"session_id","items":[{question_id, question, options?, text_options?, context?}]}], "approval_ids"?: []}`. The tool flattens blocks into items (the session comes from the escalation, `session_id` is informational); result is `PostResult` as JSON. Tool `discord_answered` input `{"answers":[{"key","value"}]}`, result `{"skipped":[…]}`.
- Validation in `core.discord_post` (Polish errors, exact):
  - `"Discord nie jest aktywny — eskalacje pokazuje aplikacja"` unless `discord_active` and a chat id is stored;
  - `"Nie ma czego wysłać"` for no items and no approvals;
  - `"Pytanie {id} nie jest przekazane na Discorda"` unless an escalation has that `question_id` and `channel == Discord`;
  - `"Pusta treść pytania"`, `"Treść pytania może mieć najwyżej 300 znaków"`, `"Kontekst może mieć najwyżej 300 znaków"`, `"Pytanie może mieć najwyżej 5 opcji z przyciskami"`, `"Opcja przycisku musi mieć od 1 do 25 znaków"`;
  - `"Prośba o zgodę {id} nie czeka na decyzję na Discordzie"` unless pending, record outcome `None` and `channel == Discord`.
- Building `PostRequest`: one block per session in first-seen order, `label` from the escalation (or the approval record), approvals attached to their session's block (block created when absent), `action` = record `action.label`, `code` = record code. `effects.discord_post` is called after the state lock is dropped.
- Tool descriptions (Polish, in `tool_definitions`): `discord_post` — „Wysyła na Discorda partię eskalacji i próśb o zgodę jako jedną wiadomość z przyciskami. Wołasz je po escalate z wynikiem channel: "discord", dla guardBlocked z channel: "discord" i dla forwarded. Zwraca klucze pytań (np. S1) do odpowiedzi tekstem.”; `discord_answered` — „Zgłasza odpowiedzi użytkownika napisane tekstem na Discordzie (np. S1 tak), żeby aplikacja zdjęła przyciski tych kluczy.”

- [ ] **Step 1: Write the failing tests:** events `discord_answer_event_json_shape` (`"type":"discordAnswer"`, `"open_keys":["S2"]`) and `discord_answer_wakes_the_supervisor`; core `discord_post_requires_an_active_discord`, `discord_post_rejects_questions_not_routed_to_discord`, `discord_post_rejects_too_many_or_too_long_options`, `discord_post_builds_blocks_with_labels_and_approval_codes` (recorded `PostRequest`: block label = escalation label, approval `action == "git push → main"` and the approval's code), `discord_post_returns_the_effects_result`, `discord_answered_passes_answers_and_returns_skipped`, `accepts_discord_answers_is_false_when_off`, `accepts_discord_answers_while_the_supervisor_restarts` (level Assistant, Discord enabled + chat id, `set_discord_active(false)`, `set_supervisor_state(false, false, None)` → `true`), `record_discord_answer_queues_the_event`; tools `tool_definitions` lists `discord_post` and `discord_answered`, `handle_tool` routes both.
- [ ] **Step 2: Run** `cargo test --lib supervisor` → FAIL.
- [ ] **Step 3: Implement** per the interfaces.
- [ ] **Step 4: Run** `cargo test --lib` → PASS.
- [ ] **Step 5: Commit** `feat(desktop): let the supervisor post Discord batches and report text answers`.

---

### Task 8: Interaction decisions

**Files:**
- Create: `src-tauri/src/supervisor/discord/interactions.rs`
- Modify: `src-tauri/src/supervisor/discord/mod.rs`

**Interfaces:**
- Consumes: Task 2 `render`, `replace_row`, `STALE_TEXT`; Task 3 `ButtonRegistry`, `ButtonTarget`, `ClickedOption`; Task 5 `Interaction`; Task 7 `accepts_discord_answers`; core `resolve_approval`, `approval_status`, `ApprovalSource::Discord`.
- Produces:

```rust
pub const NOT_ALLOWED: &str = "Brak uprawnień.";
pub const SUPERVISOR_OFF: &str = "Agent sterujący jest wyłączony — odpowiedz w aplikacji.";
#[derive(Clone, Debug, PartialEq)]
pub enum InteractionReply { Update(serde_json::Value), Ephemeral(&'static str) }
pub struct InteractionOutcome { pub reply: InteractionReply, pub answer: Option<ClickedOption> }
pub fn decide(interaction: &Interaction, allow_from: &[String], registry: &mut ButtonRegistry,
              core: &SupervisorCore) -> InteractionOutcome;
pub fn callback_payload(reply: &InteractionReply) -> serde_json::Value;
```
- Order (spec §6): user not in `allow_from` → `Ephemeral(NOT_ALLOWED)`; unknown target → `Update` of `{"flags":32768,"allowed_mentions":{"parse":[]},"components": replace_row(&interaction.message_components, custom_id, STALE_TEXT)}`; approval → `resolve_approval(id, approve, Discord)`, on success `mark_approval(Approved|Rejected)`, on error map `approval_status` (`Approved`/`Rejected`/`Expired`; unknown → `Expired`) and mark that; reply `Update(render(view))`; option → `Ephemeral(SUPERVISOR_OFF)` when `!core.accepts_discord_answers()`, else `click_option` and `Update(render(view))` with `answer` set only when the click changed the item.
- `callback_payload`: `Update(p)` → `{"type":7,"data":p}`; `Ephemeral(t)` → `{"type":4,"data":{"content":t,"flags":64}}`.
- `decide` holds no lock and does no I/O; the caller sends the callback first and calls `core.record_discord_answer(answer)` afterwards.

- [ ] **Step 1: Write the failing tests** (real `SupervisorCore` with `FakeEffects`, registry with one planned+confirmed message): `a_click_from_another_account_is_refused` (approval still pending), `an_unknown_button_gets_the_stale_row`, `approve_click_resolves_the_approval_and_shows_the_outcome` (status Approved, decision rationale `Decyzja użytkownika na Discordzie`, rendered text contains `✅ Zatwierdzono`, no button `abeon:a:<id>:y` left), `reject_click_rejects`, `click_on_an_already_rejected_approval_shows_its_state`, `option_click_returns_the_answer_with_open_keys`, `option_click_is_refused_while_the_supervisor_is_off`, `a_second_click_on_the_same_item_has_no_answer`, `callback_payload_shapes`.
- [ ] **Step 2: Run** `cargo test --lib supervisor::discord::interactions` → FAIL.
- [ ] **Step 3: Implement** `interactions.rs`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(desktop): decide Discord button clicks for approvals and answers`.

---

### Task 9: Buttons service and runtime wiring

**Files:**
- Create: `src-tauri/src/supervisor/discord/buttons.rs`
- Modify: `src-tauri/src/supervisor/discord/mod.rs`, `src-tauri/src/supervisor/runtime.rs` (start, `apply_settings`, a shared `discord_config`), `src-tauri/src/commands/supervisor.rs` (after a token save call `runtime::buttons_reconfigure`)

**Interfaces:**
- Consumes: Tasks 2–8.
- Produces:

```rust
#[derive(Clone, Debug, PartialEq)]
pub struct ButtonsConfig { pub token: String, pub chat_id: String, pub allow_from: Vec<String> }
#[derive(Clone, Debug)]
pub struct Endpoints { pub api_base: String, pub gateway_url: String }   // production: client::API_BASE, gateway::GATEWAY_URL
pub fn start(core: Arc<SupervisorCore>,
             config: Arc<dyn Fn() -> Result<ButtonsConfig, String> + Send + Sync>,
             endpoints: Endpoints) -> (ButtonsHandle, tokio::sync::watch::Receiver<GatewayStatus>);
// runtime.rs
fn discord_config(effects: &AppEffects) -> Result<ButtonsConfig, String>;  // Err = Polish reason
pub fn buttons_reconfigure(app: &AppHandle);
```
- `discord_config` reasons (exact): `"Discord wyłączony"`, `"rozmowa niesparowana"`, `"brak tokenu bota"`, `"brak sparowanego użytkownika"`. `spawn_discord_approvals` uses the same function.
- The service: on start and on `Reconfigure` (and every 60 s as a safety net) reads `config`; `Err(reason)` → stop the gateway, status `Off(reason)`; `Ok` with a different token than the running gateway → restart `run_gateway`. Jobs: `Post` → `plan_post`, render and `post_message` each planned message (confirm ids; on error `discard` the unsent ones and reply `Err(error.to_string())`); `Answered` → `answer_keys`, PATCH changed messages, reply skipped; `Sync` → the matching registry call, PATCH changed messages. Interactions are handled in their own task: lock, `decide`, unlock, `interaction_callback`, then `record_discord_answer`. A 429 on post/edit retries once after `retry_after`. Errors are logged as `supervisor: discord buttons: <error>`.
- `runtime::start` creates the service after `spawn_discord_approvals`, calls `effects.set_buttons(handle)`, and keeps the status receiver in a new `SupervisorRuntime.buttons_status: OnceLock<watch::Receiver<GatewayStatus>>`. `apply_settings` and a saved token call `buttons_reconfigure`.

- [ ] **Step 1: Write the failing tests** (wiremock for REST, local WebSocket for the gateway, `Endpoints` pointing at both): `post_job_posts_rendered_messages_and_returns_keys` (called through `ButtonsHandle::post` inside `spawn_blocking`), `failed_post_discards_items_so_they_can_be_posted_again`, `sync_job_patches_the_changed_message`, `answered_job_patches_and_returns_skipped`, `gateway_click_resolves_an_approval_end_to_end` (gateway sends INTERACTION_CREATE → wiremock receives a type 7 callback → core approval Approved), `config_error_keeps_the_gateway_off` (status `Off("brak tokenu bota")`, no WebSocket accept), `reconfigure_with_a_new_token_reconnects` (second IDENTIFY carries the new token).
- [ ] **Step 2: Run** `cargo test --lib supervisor::discord::buttons` → FAIL.
- [ ] **Step 3: Implement** `buttons.rs` and the runtime/command wiring.
- [ ] **Step 4: Run** `cargo test --lib` → PASS.
- [ ] **Step 5: Commit** `feat(desktop): run the Discord buttons service next to the supervisor`.

---

### Task 10: Buttons status in Settings

**Files:**
- Modify: `src-tauri/src/supervisor/discord/mod.rs` (`DiscordLink`), `src-tauri/src/supervisor/runtime.rs` (`discord_link`), `src-tauri/src/supervisor/discord/status.rs`, `src-tauri/src/domain/supervisor.rs` (`DiscordSetupStatus`)
- Modify: `src/components/dialogs/SupervisorDiscordSection.tsx`, `src/components/dialogs/SupervisorDiscordSection.test.tsx`
- Regenerated: `src/types/DiscordSetupStatus.ts`

**Interfaces:**
- Consumes: Task 9 status receiver.
- Produces: `DiscordLink { …, buttons_connected: bool, buttons_blocker: Option<String> }`; `DiscordSetupStatus.buttons_connected: bool`, `buttons_blocker: Option<String>` (TS `buttonsConnected`, `buttonsBlocker`). Blocker text: `Off(reason)` → reason; `Connecting` → `"łączenie z Discordem"`; `Failed(reason)` → reason; `Connected` → `None`.
- UI: a `CheckRow` with `testId="check-buttons"` right after `check-channel`: ok = `buttonsConnected`; text `Przyciski na Discordzie działają` or `Przyciski na Discordzie nie działają — <blocker>` (without ` — …` when the blocker is null).

- [ ] **Step 1: Write the failing tests:** `status.rs` `status_reports_the_buttons_connection`; Vitest `shows the buttons connection row` (connected → text „Przyciski na Discordzie działają”; disconnected with blocker „brak tokenu bota” → „Przyciski na Discordzie nie działają — brak tokenu bota”).
- [ ] **Step 2: Run** `cargo test --lib supervisor::discord::status` and `npx vitest run src/components/dialogs/SupervisorDiscordSection.test.tsx` → FAIL.
- [ ] **Step 3: Implement**; run `cargo test --lib` once to regenerate the TS type.
- [ ] **Step 4: Run** `cargo test --lib`, `npm run lint`, `npx vitest run --maxWorkers=3` → PASS.
- [ ] **Step 5: Commit** `feat(desktop): show the Discord buttons connection in settings`.

---

### Task 11: Supervisor instructions and docs

**Files:**
- Modify: `src-tauri/src/supervisor/claude_md.rs` (Discord variant texts and tests)
- Modify: `DesktopApp/CLAUDE.md` ("Supervisor agent"), `docs/superpowers/specs/2026-10-28-supervisor-agent-design.md` (§8 "Message style": one line pointing to the buttons spec)

**Interfaces:**
- Consumes: tool names `mcp__abeoncode__discord_post`, `mcp__abeoncode__discord_answered`; event `discordAnswer`; `forwarded` escalations now have `question_id`.

Required content (spec §9), pinned by tests as exact phrases:
- Section 11 „Kształt wiadomości” becomes „Partia”: batches go through `mcp__abeoncode__discord_post`; `mcp__plugin_discord_discord__reply` only for conversation. Guidance for filling items: short question, a multi-part question becomes several items with the same `question_id`, one-word answers in `options` (max 5, ≤ 25 characters), free-text ones in `text_options`, `context` only when needed. Phrase: „Aplikacja sama składa wiadomość: ramki, klucze i przyciski”.
- Fallback: „Gdy `mcp__abeoncode__discord_post` zwróci błąd, wysyłasz jedną wiadomość przez `mcp__plugin_discord_discord__reply`” followed by the v0.1.36 text layout (keep the existing example block and its tests).
- Keys: „Klucze nadaje aplikacja” — from the tool result; the supervisor no longer invents them (drop the current „Klucze.” rules except as part of the fallback).
- Text answers: „wołasz `mcp__abeoncode__discord_answered`” with the keys and values before routing.
- Event `discordAnswer` (Discord-variant event list): the user's answer to that key; route when `open_keys` is empty, together with the other answers of that question.
- `forwarded`: escalations include `question_id`; send them and the approvals through `discord_post`.
- `guardBlocked` with `channel: "discord"` and `escalate` → `channel: "discord"`: post through `discord_post` (approval ids / question ids), no hand-written approval syntax in batches. Keep the conversational rule that a code is always given when talking about a pending approval, and the rule that the syntax only appears inside a sentence.
- „Jedna sprawa, jedna wiadomość”: a question that only repeats an already-posted approval is escalated but not posted; a new decision goes into the next batch; phrase „Nie edytujesz wiadomości wysłanych przez `mcp__abeoncode__discord_post`”.

- [ ] **Step 1: Write the failing tests** in `claude_md.rs`: `discord_batches_go_through_discord_post` (phrases above present in the paired render, `mcp__abeoncode__discord_answered` and `discordAnswer` present, `question_id` in the forwarded description), `discord_tools_stay_out_of_the_plain_render` (no `discord_post` / `discord_answered` / `discordAnswer` without Discord); update existing assertions whose wording changes, keeping every safety assertion (approval syntax only in a sentence, never a standalone approval line, supervisor never approves).
- [ ] **Step 2: Run** `cargo test --lib supervisor::claude_md` → FAIL.
- [ ] **Step 3: Implement** the texts; update `DesktopApp/CLAUDE.md` with one "Discord buttons" bullet (tools, gateway with `intents: 0`, registry in memory, settle signals, the `abeon:` prefix and that the plugin ignores non-`perm:` buttons, status row) and the spec pointer.
- [ ] **Step 4: Run** `cargo test --lib`, `npm run lint`, `npx vitest run --maxWorkers=3` → PASS.
- [ ] **Step 5: Commit** `feat(desktop): teach the supervisor to post Discord batches with buttons`.

---

## Live QA (after Task 11, on a running build)

Not automatable; report each result to the user:
1. Escalate a question with two short options while away → one V2 message, ramka per project, buttons under the question; tap one → `✅ S1: tak`, the session receives the answer.
2. Trigger a guarded push → tap „Zatwierdź” → `✅ Zatwierdzono`, the session gets the approval notice; repeat with „Odrzuć”.
3. Answer a key by text (`S1 uwagi: …`) → its buttons disappear.
4. Approve a pending request in the app → the Discord message shows `✅ Zatwierdzono`.
5. Restart the app, tap an old button → `⌛ Nieaktualne — odpowiedz tekstem`.
6. Disconnect the network → Settings row shows the blocker; reconnect → row recovers.
7. The plugin's own permission buttons (Allow/Deny) still work.
