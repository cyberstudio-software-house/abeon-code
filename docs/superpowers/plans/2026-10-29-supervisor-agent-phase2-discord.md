# Supervisor Agent Phase 2 (Discord) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the supervisor agent to the user's Discord DM. Escalations and production approvals
reach the user there when they are away, the user can talk to the supervisor over DM, and a coded DM
reply approves a guarded action, verified by the app itself.

**Architecture:**
- **Spawn.** The supervisor session is spawned with the official Discord plugin as a channel, and the
  plugin is enabled only in the supervisor workdir.
- **Pure Rust units (`src-tauri/src/supervisor/discord/`):** plugin state files, the REST client, the
  reply matcher and the launch preflight.
- **Core.** `SupervisorCore` decides the channel of every escalation from presence, the mute setting
  and whether the channel is live. It forwards open app escalations when the user leaves, and
  accepts approvals coming from a DM poll.
- **UI.** A Discord section in Settings runs the setup. The supervisor panel marks what went to
  Discord.

**Tech Stack:** Rust (Tauri 2, tokio, reqwest 0.12, serde_json, wiremock for tests), React 19 +
Zustand 5 + Vitest, ts-rs.

**Spec:** `docs/superpowers/specs/2026-10-28-supervisor-agent-design.md`. Read §4 (Approval), §5
(Spawn, Permissions, `CLAUDE.md`), §8 (Presence, routing and Discord), §9 (UI), "Failure behaviour"
and **"Spike 3 results (2026-10-29)"**. Phase 1 is complete on local `main`; module map in
`DesktopApp/CLAUDE.md` → "## Supervisor agent".

## Global Constraints

- **Code and copy:** no comments in code; identifiers in English; user-facing copy in Polish.
- **Commits:** Conventional Commits with scope `desktop`, e.g. `feat(desktop): …`. No co-author
  trailer, no `Claude-Session:` line. Commit on local `main`; never push.
- **Commands:**
  - Rust tests from `DesktopApp/src-tauri`: `cargo test <filter>`.
  - Frontend tests from `DesktopApp`: `npx vitest run --maxWorkers=3 <file>`.
  - Lint from `DesktopApp`: `npm run lint`.
  - Before each commit run the full `cargo test` and the full `npx vitest run --maxWorkers=3`, and
    report every failure.
- **ts-rs:** `cargo test` regenerates `src/types/*.ts`. The barrel `src/types/index.ts` is maintained
  by hand, so add every new exported type there.
- **Tauri commands:** any command that touches disk or network is `#[tauri::command(async)]`. The
  GTK main thread must not block (Wayland/COSMIC disconnects the client).
- **Supervisor independence:** the supervisor must not import from `remote/`.
- **Plugin identifiers:**
  - plugin id `discord@claude-plugins-official`;
  - channel argument `--channels plugin:discord@claude-plugins-official`;
  - plugin MCP tool prefix `mcp__plugin_discord_discord__`;
  - failure-cache key `plugin:discord:discord` in `<claude_home>/mcp-needs-auth-cache.json`;
  - plugin state dir `<claude_home>/channels/discord/`, holding `.env` (`DISCORD_BOT_TOKEN=`),
    `access.json` and `approved/<senderId>`.
- **The plugin is used unmodified.**
- **Discord REST:**
  - base `https://discord.com/api/v10`;
  - headers `Authorization: Bot <token>` and `User-Agent: DiscordBot (abeoncode, <CARGO_PKG_VERSION>)`;
  - request timeout 15 s.
- **Token handling:**
  - never logged, never returned to the frontend, never placed in `CLAUDE.md`, an event or an error
    message;
  - `.env` is written with mode `600` in a directory with mode `700`.
- **No `ask` rules:** the supervisor's `settings.json` never contains `ask` rules. Everything is
  allowed or denied.
- **Approval codes:** 4 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (existing
  `supervisor/approvals.rs`). DM reply verbs are `zatwierdzam` and `odrzucam`.
- **DM approval poll:** every 10 s, only while an approval is pending and Discord is enabled, linked
  and has a token.
- **Routing (spec §8):**
  - present and mute on → `app`;
  - otherwise → `discord` when the channel is live (enabled, launched with the channel, chat linked);
  - otherwise → `app`.
- **Settings keys:**
  - `supervisorDiscordEnabled` (default `false`);
  - `supervisorDiscordMuteWhenPresent` (default `true`);
  - `supervisorDiscordChatId` (Rust-only, not a frontend persisted key).

## Review Focus

1. **Discord enabled but Bun or the token missing.**
   - The supervisor still starts, without `--channels`.
   - Escalations stay in the app, and the Settings status names the blocker.
   - Pinned by Task 4 `launch_blocked_without_bun_or_token`, Task 6
     `escalation_stays_in_app_when_discord_inactive` and Task 9
     `status_reports_each_setup_step`.
2. **Coded reply variants and impostors.**
   - Accepted: lower case, extra spaces, a trailing period.
   - Ignored: the bot's own message carrying the code, a non-allowlisted author, a reply older than
     the request, a second reply for the same code.
   - Pinned by the Task 3 matcher tests and Task 7 `poll_ignores_the_bots_own_message`.
3. **Presence flapping** (leave → return → leave). Open app escalations are forwarded once, and no
   empty `forwarded` event is ever queued. Pinned by Task 6
   `leaving_forwards_open_app_escalations_once`.
4. **Broken files under `~/.claude`** (missing or corrupt `access.json`, `.env`,
   `mcp-needs-auth-cache.json`, `settings.json`). No panic, no file created where none existed, and
   other keys untouched. Pinned by the Task 1 tests.
5. **The token never leaves the machine's files.** It is absent from the status JSON, error
   messages and `CLAUDE.md`. Pinned by Task 2 `unauthorized_maps_to_its_own_error`, Task 5
   `discord_section_only_when_enabled` and Task 9 `status_never_contains_the_token`.

---

### Task 1: Discord plugin state files

**Files:**
- Create: `DesktopApp/src-tauri/src/supervisor/discord/mod.rs`, `DesktopApp/src-tauri/src/supervisor/discord/files.rs`
- Modify: `DesktopApp/src-tauri/src/supervisor/mod.rs` (add `pub mod discord;`)

**Interfaces:**
- Produces (in `discord/mod.rs`): `pub const PLUGIN_ID: &str = "discord@claude-plugins-official";`,
  `pub const CHANNEL_ARG: &str = "plugin:discord@claude-plugins-official";`,
  `pub const PLUGIN_TOOLS: &str = "mcp__plugin_discord_discord__*";`
- Produces (in `discord/files.rs`):
  - `pub struct DiscordFiles` with `pub fn new(dir: PathBuf) -> Self`,
    `pub fn for_claude_home(claude_home: &Path) -> Self` (`<claude_home>/channels/discord`),
    `pub fn token(&self) -> Option<String>`, `pub fn save_token(&self, token: &str) -> std::io::Result<()>`,
    `pub fn access(&self) -> Access`, `pub fn pair(&self, code: &str, now_ms: i64) -> Result<PairedUser, PairError>`
  - `pub struct Access { pub dm_policy: String, pub allow_from: Vec<String>, pub pending_count: usize }`
  - `pub struct PairedUser { pub sender_id: String, pub chat_id: String }`
  - `pub enum PairError { UnknownCode, Expired, Io(String) }` with `Display`: „Nieznany kod parowania”,
    „Kod parowania wygasł — napisz do bota ponownie”, „Nie udało się zapisać dostępu: <io>”
  - `pub fn validate_token(token: &str) -> Result<String, &'static str>` (trimmed; rejects empty and
    any whitespace inside; error „Token ma nieprawidłowy format”)
  - `pub fn global_plugin_enabled(claude_home: &Path) -> bool`
  - `pub fn disable_global_plugin(claude_home: &Path) -> std::io::Result<bool>` (true when it changed the file)
  - `pub fn clear_failure_cache(claude_home: &Path) -> std::io::Result<bool>` (true when it removed the key)

Rules:
- `pair` operates on a `serde_json::Value`, so the keys the plugin owns (`groups`,
  `mentionPatterns`, `ackReaction`, …) survive.
- `pair` follows the plugin's `skills/access/SKILL.md` `pair` steps: add the sender to `allowFrom`
  without duplicates, delete the pending entry, set `dmPolicy` to `"allowlist"`, write
  `approved/<senderId>` containing the `chatId`.
- The code is matched after `trim().to_lowercase()`.
- Writes are atomic (temp file + rename): `access.json` and `.env` get mode `600`, a created state dir
  gets `700`.
- `disable_global_plugin` and `clear_failure_cache` rewrite the file only when they change it. On a
  missing or unparsable file they return `Ok(false)` and leave it alone.
- Key order may be normalised by `serde_json`. `notifications/hook_installer.rs` already rewrites the
  same `settings.json` this way.

- [ ] **Step 1: Write the failing tests** in `files.rs` (`tempfile::tempdir()` fixtures):
  - `token_reads_the_bot_token_line`: `.env` = `"FOO=1\nDISCORD_BOT_TOKEN=abc.def\n"` → `Some("abc.def")`.
  - `token_missing_file_or_line_is_none`: no file → `None`; `"FOO=1\n"` → `None`.
  - `save_token_replaces_only_the_token_line_and_sets_mode_600`:
    - before: `"DISCORD_STATE_DIR=/x\nDISCORD_BOT_TOKEN=old\n"`;
    - after `save_token("new")`: the file contains `DISCORD_STATE_DIR=/x` and `DISCORD_BOT_TOKEN=new`,
      no `old`, and has mode `0o600`;
    - saving into a missing dir creates it with mode `0o700`.
  - `validate_token_rejects_whitespace_and_empty`:
    - `""`, `"  "`, `"a b"`, `"ab\ncd"` → `Err`;
    - `" MTU2.Gx_y-z "` → `Ok("MTU2.Gx_y-z")`.
  - `access_defaults_when_missing_or_corrupt`: missing and `"{"` both → `dm_policy == "pairing"`,
    empty `allow_from`, `pending_count == 0`.
  - `pair_moves_sender_to_allowlist_and_switches_policy`:
    - fixture `access.json`:
      `{"dmPolicy":"pairing","allowFrom":[],"groups":{"g1":{"requireMention":true,"allowFrom":[]}},"mentionPatterns":["@bot"],"pending":{"4f7541":{"senderId":"844465727611863040","chatId":"1565442299968757861","createdAt":1000,"expiresAt":<now_ms+3600000>,"replies":1}}}`;
    - `pair("4F7541 ", now_ms)` → `PairedUser { sender_id: "844465727611863040", chat_id: "1565442299968757861" }`;
    - the file then has `allowFrom == ["844465727611863040"]`, empty `pending`, `dmPolicy == "allowlist"`,
      and `groups` and `mentionPatterns` unchanged;
    - `approved/844465727611863040` reads `"1565442299968757861"`, and `access.json` has mode `0o600`.
  - `pair_dedupes_an_already_allowed_sender`: `allowFrom` already holds the sender → it is still
    present exactly once.
  - `pair_rejects_unknown_and_expired_codes`:
    - `pair("zzzzzz")` → `UnknownCode`;
    - an entry with `expiresAt < now_ms` → `Expired`;
    - the `access.json` bytes are unchanged in both cases.
  - `clear_failure_cache_removes_only_the_discord_key`:
    `{"plugin:discord:discord":{"timestamp":1},"plugin:linear:linear":{"timestamp":2}}` → `Ok(true)`,
    leaving only the key `plugin:linear:linear` with its value.
  - `clear_failure_cache_leaves_missing_or_corrupt_files_alone`:
    - missing → `Ok(false)` and no file created;
    - `"not json"` → `Ok(false)` and the bytes are unchanged;
    - the key absent → `Ok(false)` and the file mtime is unchanged.
  - `global_plugin_flag_reads_and_disables_only_the_discord_entry`:
    - fixture: `settings.json` with
      `{"enabledPlugins":{"discord@claude-plugins-official":true,"x@y":true},"hooks":{"Stop":[]}}`;
    - `global_plugin_enabled` → `true`;
    - `disable_global_plugin` → `Ok(true)`. Re-read: discord `false`, `x@y` `true`, `hooks` present;
    - a second `disable_global_plugin` → `Ok(false)`.

- [ ] **Step 2: Run** `cargo test supervisor::discord::files` — expect compile failure / FAIL.
- [ ] **Step 3: Implement** the interfaces above in `discord/files.rs` and the constants in `discord/mod.rs`.
- [ ] **Step 4: Run** `cargo test supervisor::discord::files` — expect PASS; then full `cargo test`.
- [ ] **Step 5: Commit** — `feat(desktop): read and write the Discord plugin state for the supervisor`

---

### Task 2: Discord REST client

**Files:**
- Create: `DesktopApp/src-tauri/src/supervisor/discord/client.rs` (register in `discord/mod.rs`)

**Interfaces:**
- Produces:
  - `pub const API_BASE: &str = "https://discord.com/api/v10";`
  - `pub struct DiscordClient` with `pub fn new(token: impl Into<String>) -> Self` and
    `pub fn with_base(token: impl Into<String>, base: impl Into<String>) -> Self`. Mirror
    `clickup/mod.rs` `ClickUpClient`.
  - `pub async fn bot(&self) -> Result<BotInfo, DiscordError>`: `GET /applications/@me`.
  - `pub async fn open_dm(&self, user_id: &str) -> Result<String, DiscordError>`:
    `POST /users/@me/channels` with body `{"recipient_id": user_id}`, returns `id`.
  - `pub async fn messages_after(&self, channel_id: &str, after: &str) -> Result<Vec<DiscordMessage>, DiscordError>`:
    `GET /channels/{channel_id}/messages?after={after}&limit=100`, returned sorted oldest-first by
    numeric id.
  - `pub async fn react(&self, channel_id: &str, message_id: &str, emoji: &str) -> Result<(), DiscordError>`:
    `PUT /channels/{c}/messages/{m}/reactions/{percent-encoded emoji}/@me`.
  - `pub struct BotInfo { pub name: String, pub message_content_intent: bool, pub guild_count: Option<u64> }`.
    `message_content_intent` is `flags & ((1 << 18) | (1 << 19)) != 0`, and `guild_count` comes from
    `approximate_guild_count`.
  - `pub struct DiscordMessage { pub id: String, pub author_id: String, pub author_is_bot: bool, pub content: String }`.
    A missing `author.bot` means `false`.
  - `pub enum DiscordError { Unauthorized, Http(u16), Network(String), Decode(String) }` with a Polish
    `Display`. `Unauthorized` reads „Discord odrzucił token bota”. No variant ever contains the token.

- [ ] **Step 1: Write the failing tests** (`wiremock::MockServer`, `#[tokio::test]`):
  - `bot_reads_name_intent_and_guild_count`:
    - response `{"name":"AbeonCode","flags":524288,"approximate_guild_count":1}` →
      `name == "AbeonCode"`, `message_content_intent`, `guild_count == Some(1)`;
    - the mock matches header `Authorization: Bot tok`, and a `User-Agent` starting with
      `DiscordBot (abeoncode, `.
  - `bot_without_intent_flag`: `flags: 0` → `message_content_intent == false`.
  - `unauthorized_maps_to_its_own_error`: 401 → `DiscordError::Unauthorized`, and its `to_string()`
    does not contain `"tok"`.
  - `open_dm_posts_recipient_and_returns_channel_id`: `body_json({"recipient_id":"u1"})` → `"d1"`.
  - `messages_after_sends_cursor_and_returns_oldest_first`:
    - query `after=100` and `limit=100`;
    - response `[{"id":"300","author":{"id":"a","bot":true},"content":"x"},{"id":"200","author":{"id":"b"},"content":"y"}]`;
    - result ids `["200","300"]`; `author_is_bot` is `true` for `"300"` and `false` for `"200"`.
  - `react_encodes_the_emoji`: path `/channels/c1/messages/m1/reactions/%E2%9C%85/@me`, method `PUT`,
    status 204 → `Ok(())`.
- [ ] **Step 2: Run** `cargo test supervisor::discord::client` — expect FAIL.
- [ ] **Step 3: Implement** `client.rs` (reqwest with a 15 s timeout; encode the emoji with `reqwest::Url` path segments or byte-wise `%XX`).
- [ ] **Step 4: Run** `cargo test supervisor::discord::client` — PASS; full `cargo test`.
- [ ] **Step 5: Commit** — `feat(desktop): add a Discord REST client for the supervisor`

---

### Task 3: Coded approval replies

**Files:**
- Create: `DesktopApp/src-tauri/src/supervisor/discord/replies.rs` (register in `discord/mod.rs`)

**Interfaces:**
- Consumes: `DiscordMessage` (Task 2).
- Produces:
  - `pub const DISCORD_EPOCH_MS: i64 = 1_420_070_400_000;`
  - `pub fn snowflake_ms(id: &str) -> Option<i64>`, computing `(id >> 22) + DISCORD_EPOCH_MS`.
  - `pub fn snowflake_at(ms: i64) -> String`, computing `(ms - DISCORD_EPOCH_MS) << 22`.
  - `pub fn parse_reply(content: &str) -> Option<(bool, String)>`, returning `(approve, CODE_UPPERCASE)`.
  - `pub struct PendingCode { pub approval_id: String, pub code: String, pub created_at_ms: i64 }`.
  - `pub struct MatchedReply { pub approval_id: String, pub approve: bool, pub message_id: String }`.
  - `pub fn match_replies(messages: &[DiscordMessage], allow_from: &[String], pending: &[PendingCode]) -> Vec<MatchedReply>`.

`parse_reply` grammar, after `trim()`:
- an optional single trailing `.` or `!`;
- then the verb `zatwierdzam` (approve) or `odrzucam` (reject), case-insensitive;
- then whitespace;
- then exactly 4 ASCII alphanumerics;
- nothing else.

`match_replies` processes messages in snowflake order. It skips:
- bot authors;
- authors not in `allow_from`;
- ids that do not parse;
- replies whose `snowflake_ms(id) <= created_at_ms`;
- codes that are not pending.

The first match per approval wins.

- [ ] **Step 1: Write the failing tests:**
  - `snowflake_round_trips_milliseconds`:
    - `snowflake_ms("1565442306201620621") == Some(1793300930310)`;
    - `snowflake_ms(&snowflake_at(1793300930310)) == Some(1793300930310)`;
    - `snowflake_ms("x") == None`.
  - `parse_reply_accepts_both_verbs_any_case`:
    - `"zatwierdzam K7QX"` → `(true,"K7QX")`;
    - `"  Odrzucam k7qx "` → `(false,"K7QX")`;
    - `"ZATWIERDZAM K7QX."` → `(true,"K7QX")`.
  - `parse_reply_rejects_chatter`: each of `"zatwierdzam"`, `"zatwierdzam K7QX teraz"`,
    `"tak K7QX"`, `"zatwierdzam K7Q"`, `"zatwierdzam K7QXX"`, `"ok zatwierdzam K7QX"` → `None`.
  - `match_requires_allowlisted_human_author`:
    - pending `K7QX` created at ms `T`;
    - three messages with ids `snowflake_at(T+1000)` and increasing, all with content `"zatwierdzam K7QX"`:
      1. author `"bot"` with `author_is_bot: true`;
      2. author `"999"`, which is not allowed;
      3. author `"844465727611863040"`, which is allowed.
    - Exactly one match, on the third message's id.
  - `match_ignores_messages_older_than_the_request`: message at `snowflake_at(T)` with
    `created_at_ms == T` → empty.
  - `match_takes_the_first_reply_per_approval`: `"odrzucam K7QX"` then `"zatwierdzam K7QX"` → one
    match with `approve == false`.
  - `match_routes_each_code_to_its_approval`: pending `K7QX` (id `a1`) and `MN2P` (id `a2`), one reply
    each → two matches with the right `approval_id`s.
  - `match_ignores_codes_that_are_not_pending`: reply `"zatwierdzam ZZZZ"` → empty.
- [ ] **Step 2: Run** `cargo test supervisor::discord::replies` — FAIL.
- [ ] **Step 3: Implement** `replies.rs`.
- [ ] **Step 4: Run** `cargo test supervisor::discord::replies` — PASS; full `cargo test`.
- [ ] **Step 5: Commit** — `feat(desktop): recognise coded approval replies from the Discord DM`

---

### Task 4: Discord settings, launch preflight, spawn flags and workdir permissions

**Files:**
- Create: `DesktopApp/src-tauri/src/supervisor/discord/preflight.rs` (register in `discord/mod.rs`)
- Modify: `DesktopApp/src-tauri/src/supervisor/settings.rs`, `DesktopApp/src-tauri/src/supervisor/process.rs` (`build_supervisor_command` + its tests), `DesktopApp/src-tauri/src/supervisor/workdir.rs`, `DesktopApp/src-tauri/src/supervisor/claude_md.rs` (type only)

**Interfaces:**
- Consumes: `DiscordFiles` and the constants from Task 1.
- Produces:
  - `SupervisorSettings` new fields:
    - `pub discord_enabled: bool`, from key `supervisorDiscordEnabled`: `"true"` → true, default false;
    - `pub discord_mute_when_present: bool`, from key `supervisorDiscordMuteWhenPresent`: only
      `"false"` → false, default true;
    - `pub discord_chat_id: Option<String>`, from key `supervisorDiscordChatId`, trimmed and
      non-empty.
  - `pub const DISCORD_CHAT_ID_KEY: &str = "supervisorDiscordChatId";` in `settings.rs`.
  - `preflight.rs`:
    - `pub fn resolve_bun(env: &HashMap<String, String>, home: &Path) -> Option<PathBuf>`;
    - `pub enum DiscordBlocker { BunMissing, TokenMissing }` with `Display` „Nie znaleziono Bun
      (~/.bun/bin/bun)” and „Brak tokenu bota Discord”;
    - `pub struct DiscordLaunch { pub path_prefix: Option<PathBuf> }`;
    - `pub fn discord_launch(env: &HashMap<String, String>, home: &Path, files: &DiscordFiles) -> Result<DiscordLaunch, DiscordBlocker>`
      (Bun first, then token);
    - `pub fn with_path_prefix(env: HashMap<String, String>, prefix: Option<&Path>) -> HashMap<String, String>`.
  - `build_supervisor_command(session: SupervisorSessionArg, model: Option<&str>, mcp_json: &Path, discord_channel: bool) -> String`.
  - `pub struct DiscordContext { pub chat_id: Option<String> }` in `claude_md.rs`. The struct is
    declared here; Task 5 renders it.
  - `write_supervisor_workdir(dir, exe, level, read_roots, claude_home, discord: Option<&DiscordContext>)`.
    `Some` means the channel is used.

Rules:
- **`resolve_bun` order:**
  1. each `PATH` dir of `env`, as `<dir>/bun`;
  2. `<BUN_INSTALL>/bin/bun` from `env`;
  3. `<home>/.bun/bin/bun`.
  - A candidate counts only if it is a regular file with an execute bit.
- **`path_prefix`** is `Some(parent)` only when Bun was found outside `PATH`.
- **`with_path_prefix`** prepends `<prefix>:` to `PATH`, or sets `PATH` to the prefix when it is
  absent. `None` leaves `PATH` unchanged.
- **Command with `discord_channel = true`:** the same as today, minus ` --strict-mcp-config`, plus a
  trailing ` --channels plugin:discord@claude-plugins-official`.
- **Workdir `settings.json`:**
  - `enabledPlugins[PLUGIN_ID]` is always written: `true` with `discord` Some, `false` otherwise.
  - `PLUGIN_TOOLS` is added to `allow` only with `discord` Some.
  - `"mcp__bandzior"` joins `DENIED_TOOLS` always (19 entries).

- [ ] **Step 1: Write the failing tests:**
  - `settings.rs`:
    - extend `defaults_when_keys_missing` with `!discord_enabled`, `discord_mute_when_present` and
      `discord_chat_id == None`;
    - new `discord_keys_parse`: `"true"`, `"false"`, `" 156 "` → `true`, `false`, `Some("156")`;
      `""` chat → `None`.
  - `preflight.rs` (tempdir, executable files via `std::os::unix::fs::PermissionsExt`):
    - `bun_on_path_needs_no_prefix`;
    - `bun_from_bun_install_or_home_gets_a_prefix`: two cases, the second with no `BUN_INSTALL`;
    - `non_executable_bun_is_ignored`;
    - `launch_blocked_without_bun_or_token`: no Bun → `BunMissing`; Bun without `.env` →
      `TokenMissing`; both → `Ok`;
    - `path_prefix_is_prepended_once`: `PATH=/usr/bin` + `/h/.bun/bin` → `"/h/.bun/bin:/usr/bin"`;
      no `PATH` → `"/h/.bun/bin"`; `None` → unchanged.
  - `process.rs`:
    - update both existing command tests to pass `false`;
    - new `discord_command_drops_strict_mcp_and_adds_the_channel`, which asserts the full string
      `"claude --session-id {ID} --model 'claude-opus-5-5' --permission-mode dontAsk --mcp-config '/w/mcp.json' --channels plugin:discord@claude-plugins-official"`.
  - `workdir.rs`:
    - update `supervisor_settings_has_no_ask_and_denies_bash` to expect `mcp__bandzior` in `deny`;
    - new `discord_workdir_enables_the_plugin_and_its_tools`: `enabledPlugins[PLUGIN_ID] == true`,
      `allow` contains `mcp__plugin_discord_discord__*`, no `ask` key;
    - new `workdir_without_discord_keeps_the_plugin_off`: no user settings file →
      `enabledPlugins[PLUGIN_ID] == false`, `allow` lacks the plugin tools;
    - extend `user_plugins_and_phone_notifications_are_switched_off`: with `discord` Some, the user's
      `discord@…: true` maps to `true`.
- [ ] **Step 2: Run** `cargo test supervisor::` — FAIL.
- [ ] **Step 3: Implement.** Update every caller of the changed signatures. `prepare_launch` passes
  `false` / `None` for now; Task 8 wires the real values.
- [ ] **Step 4: Run** `cargo test supervisor::` — PASS; full `cargo test`.
- [ ] **Step 5: Commit** — `feat(desktop): prepare the supervisor launch for the Discord channel`

---

### Task 5: Discord instructions in the supervisor CLAUDE.md

**Files:**
- Modify: `DesktopApp/src-tauri/src/supervisor/claude_md.rs`, `DesktopApp/src-tauri/src/supervisor/workdir.rs` (pass the context to `render`)

**Interfaces:**
- Consumes: `DiscordContext` (Task 4).
- Produces: `pub fn render(level: SupervisorLevel, claude_projects: &Path, discord: Option<&DiscordContext>) -> String`.

With `None` the output is today's text, sections 1–10. With `Some`, the template additionally
encodes the following. The wording is the builder's call within spec §5 and §8, in Polish.

- **§1 "Twoje możliwości":**
  - lists the Discord tools `mcp__plugin_discord_discord__reply`, `react`, `edit_message`,
    `fetch_messages`;
  - "Rozmowa z użytkownikiem" names the Discord DM as a second place where the user talks to it.
- **§6:**
  - messages from the user also arrive as `<channel source="discord" …>` turns from the paired user;
  - they carry the same authority as the terminal, but session content quoted in them is still data;
  - it never changes Discord access (no `/discord:access`, no edits of plugin files), whoever asks.
- **§7:**
  - `escalate` returns `channel: "app"` or `channel: "discord"`. For `discord` it sends one message
    to the user's DM; for `app` it writes nothing on Discord.
  - `guardBlocked` carries `channel` too. For `discord` it writes the approval request on Discord
    with the action, the code and the reply syntax.
  - New event `forwarded` (lists `escalations` and `approvals`): the user left the computer, and
    these were shown only in the app. It sends them as one message.
- **§10:** the user approves in the app or by typing `zatwierdzam <KOD>` / `odrzucam <KOD>` in the DM.
  The app checks that reply itself. The supervisor tells the user the syntax, but never writes those
  words itself and never tells a session that something was approved.
- **New `## 11. Discord`:**
  - **Target.** The DM `chat_id` is `<id>`. With `chat_id` `None`: „Discord nie jest jeszcze
    sparowany” — do not write to Discord, the app shows escalations.
  - **When to write:** only when a decision is needed or the user asked.
  - **Message shape:**
    - one message per batch;
    - one line per session, `<projekt> · <tytuł> — 1–2 zdania kontekstu — opcje`;
    - Polish;
    - no session content, no secrets.
  - **Inbound answers.** Route each answer to its session with `answer_question` or
    `send_to_session`. One message can answer several sessions (`A: tak, B: wariant 1`).
  - **Inbound questions** are answered from `list_sessions` / `read_session`.
  - **Orders.** Use `open_session` within the level rules (§2).
  - **Summaries** only on request.
  - **Acknowledgement.** After routing an answer, acknowledge briefly: a ✅ reaction or a short
    reply.

- [ ] **Step 1: Write the failing tests:**
  - `discord_section_only_when_enabled`:
    - `render(level, P, None)` lacks `"## 11. Discord"` and `"mcp__plugin_discord_discord__reply"`;
    - `render(level, P, Some(&DiscordContext { chat_id: Some("1565442299968757861".into()) }))`
      contains `"## 11. Discord"`, `"1565442299968757861"`,
      `"mcp__plugin_discord_discord__reply"`, `"zatwierdzam"`, `"odrzucam"`, `"forwarded"` and
      `"channel: \"discord\""`;
    - none of the outputs contains `"DISCORD_BOT_TOKEN"`.
  - `unpaired_discord_section_forbids_writing`: `chat_id: None` → contains `"## 11. Discord"` and
    `"nie jest jeszcze sparowany"`.
  - `discord_sections_follow_the_required_order`: with `Some`, the sections 1–10 from `SECTIONS`
    followed by `"## 11. Discord"`, in order.
  - Existing tests keep passing with `None`.
- [ ] **Step 2: Run** `cargo test supervisor::claude_md` — FAIL.
- [ ] **Step 3: Implement**; `write_supervisor_workdir` passes its `discord` argument to `render`.
- [ ] **Step 4: Run** `cargo test supervisor::` — PASS; full `cargo test`.
- [ ] **Step 5: Commit** — `feat(desktop): teach the supervisor to talk to the user over Discord`

---

### Task 6: Routing escalations by presence and forwarding on leave

**Files:**
- Modify:
  - `DesktopApp/src-tauri/src/domain/supervisor.rs`
  - `DesktopApp/src-tauri/src/supervisor/presence.rs`
  - `DesktopApp/src-tauri/src/supervisor/events.rs`
  - `DesktopApp/src-tauri/src/supervisor/core.rs`
  - `DesktopApp/src-tauri/src/supervisor/core/operations.rs`
  - `DesktopApp/src-tauri/src/supervisor/core/production.rs`
  - `DesktopApp/src-tauri/src/supervisor/tools.rs`
  - `DesktopApp/src/types/index.ts` (barrel)

**Interfaces:**
- Consumes: `SupervisorSettings.discord_mute_when_present` (Task 4).
- Produces:
  - Domain:
    - `pub enum EscalationChannel { App, Discord }` in `domain/supervisor.rs`: serde
      `rename_all = "camelCase"` (`"app"` | `"discord"`), `TS` exported;
    - `channel: EscalationChannel` on `EscalationView` and `ApprovalView`;
    - `discord_active: bool` on `SupervisorSnapshot`.
  - Presence: `pub fn route(discord_active: bool, present: bool, mute_when_present: bool) -> EscalationChannel`
    in `presence.rs`.
  - Core:
    - `pub fn set_discord_active(&self, active: bool)` on `SupervisorCore` (publishes);
    - `pub struct EscalateOutcome { pub skipped: Vec<String>, pub channel: EscalationChannel }`;
      `SupervisorCore::escalate` now returns `Result<EscalateOutcome, String>`.
  - Events:
    - `SupervisorEvent::GuardBlocked` gains `channel: EscalationChannel`;
    - new `SupervisorEvent::Forwarded { escalations: Vec<ForwardedEscalation>, approvals: Vec<ForwardedApproval> }`
      with `ForwardedEscalation { session_id, label, summary }` and
      `ForwardedApproval { approval_id, label, action, code }`;
    - `wakes_supervisor()` is true for `Forwarded`.
  - Tools: the `escalate` tool result is `{"channel": "app" | "discord", "skipped"?: [...]}`, and its
    description names both values.

Rules:
- **Channel.** It is `route(state.discord_active, present, settings.discord_mute_when_present)` at
  the moment of escalation or guard block.
- **Escalation.** With `App`, today's behaviour: desktop notification + attention + list. With
  `Discord`: attention + list, no desktop notification.
- **Guard block.** The same rule for its desktop notification. `ApprovalRecord` stores the channel,
  and `ApprovalView.channel` reads it.
- **Forwarding on leave.**
  - `CoreState` tracks `last_present`.
  - In `tick`, `report_activity` and `set_away`, a transition from present to not present while
    `discord_active` moves every escalation and every pending approval with `App` to `Discord`.
  - It then pushes one `Forwarded` event, and only if at least one item moved.
- **Inactive channel.** With `discord_active` false nothing is forwarded.

- [ ] **Step 1: Write the failing tests:**
  - `presence.rs`, `route_follows_presence_and_mute`:
    - `(false, *, *)` → `App`;
    - `(true, true, true)` → `App`;
    - `(true, true, false)` → `Discord`;
    - `(true, false, true)` → `Discord`.
  - `events.rs`:
    - `forwarded_event_json_shape`: `{"type":"forwarded","escalations":[{"session_id":…,"label":…,"summary":…}],"approvals":[{"approval_id":…,"label":…,"action":…,"code":…}]}`;
    - `guard_blocked_carries_its_channel`: `"channel":"discord"`;
    - `forwarded_wakes_the_supervisor`.
  - `core.rs` tests (existing `FakeEffects` + helpers; a question handed to the supervisor, then
    `core.escalate`):
    - `escalation_goes_to_discord_when_away_and_active`:
      - `set_discord_active(true)` + `set_away(true)`;
      - the outcome channel is `Discord`;
      - `notifications()` is empty and `attentions()` has 1;
      - snapshot escalation `channel == Discord` and `discord_active`.
    - `escalation_stays_in_app_when_present_and_muted`: `report_activity(None)`, mute default `true`,
      active → `App`, and 1 desktop notification.
    - `escalation_goes_to_discord_when_present_but_not_muted`: mute `false` → `Discord`.
    - `escalation_stays_in_app_when_discord_inactive`: away and inactive → `App` + notification.
    - `guard_block_routes_like_escalations`:
      - away + active: the `GuardBlocked` event has `channel == Discord` and there is no desktop
        notification;
      - present + muted: `App` + notification.
    - `leaving_forwards_open_app_escalations_once`:
      - present + active, escalate → `App`;
      - `set_away(true)` → `take_events()` holds exactly one `Forwarded` with that escalation, and
        the snapshot escalation is now `Discord`;
      - `set_away(false)`, then `set_away(true)` → no further `Forwarded`.
    - `leaving_without_discord_forwards_nothing`.
    - `presence_timeout_forwards_on_tick`: activity, then advance past the presence threshold the
      same way the existing grace tests advance time, then `tick()` → one `Forwarded`.
  - `tools.rs`: update `escalate_releases_menu_and_returns_app_channel`; new
    `escalate_reports_the_discord_channel` (away + active → `"discord"`).
- [ ] **Step 2: Run** `cargo test supervisor::` — FAIL.
- [ ] **Step 3: Implement**, then run `cargo test` to regenerate the TS types and add
  `EscalationChannel` to `src/types/index.ts`.
- [ ] **Step 4: Run** full `cargo test`, full `npx vitest run --maxWorkers=3`, `npm run lint`.
  Fix frontend fixtures that build `EscalationView` / `ApprovalView` / `SupervisorSnapshot`, so the
  new fields are present.
- [ ] **Step 5: Commit** — `feat(desktop): route supervisor escalations to Discord when the user is away`

---

### Task 7: Approving guarded actions by a coded DM reply

**Files:**
- Create: `DesktopApp/src-tauri/src/supervisor/discord/poll.rs` (register in `discord/mod.rs`)
- Modify: `DesktopApp/src-tauri/src/supervisor/core/production.rs`, `DesktopApp/src-tauri/src/commands/supervisor.rs` (caller), `DesktopApp/src-tauri/src/supervisor/runtime.rs` (spawn the loop)

**Interfaces:**
- Consumes: `DiscordClient` (Task 2), `PendingCode` / `match_replies` / `snowflake_at` (Task 3), `DiscordFiles` (Task 1), `SupervisorSettings.discord_*` (Task 4).
- Produces:
  - In `production.rs`:
    - `pub enum ApprovalSource { App, Discord }`;
    - `SupervisorCore::resolve_approval(&self, approval_id: &str, approve: bool, source: ApprovalSource) -> Result<(), String>`.
      The decision rationale is „Decyzja użytkownika” for `App` and „Decyzja użytkownika na
      Discordzie” for `Discord`; the rest is unchanged.
    - `SupervisorCore::pending_approval_codes(&self) -> Vec<PendingCode>`.
  - In `poll.rs`:
    - `pub const POLL_INTERVAL: Duration = Duration::from_secs(10);`
    - `pub async fn poll_approvals(client: &DiscordClient, chat_id: &str, allow_from: &[String], core: &SupervisorCore) -> Result<usize, DiscordError>`.
      It returns the number resolved. The cursor is `snowflake_at(min(created_at_ms) - 1)`. Each
      `MatchedReply` resolves with `ApprovalSource::Discord`, then the client reacts best-effort
      with `✅` (approve) or `❌` (reject).
  - In `runtime.rs`: `spawn_discord_approvals(app, core)`, started next to `spawn_ticks`. Every
    `POLL_INTERVAL` it runs `poll_approvals` only when all of these hold:
    - `pending_approval_codes()` is not empty;
    - `settings.discord_enabled`;
    - `settings.discord_chat_id` is `Some`;
    - a token exists;
    - `access().allow_from` is not empty.
  - Errors go to `eprintln!("supervisor: discord poll failed: {error}")`, and never with the token.

- [ ] **Step 1: Write the failing tests:**
  - `production.rs`:
    - `discord_resolution_logs_its_source`: resolve with `Discord` → the last decision has rationale
      „Decyzja użytkownika na Discordzie”, an `ApprovalResolved` event, and the approval text typed
      into the session (as in the existing approve test);
    - `pending_codes_list_only_open_approvals`: two blocks, resolve one → one `PendingCode` with the
      other's code and `created_at_ms`.
  - `poll.rs` (`wiremock` + `FakeEffects` core with one blocked approval):
    - `poll_resolves_a_coded_reply_and_reacts`:
      - `GET /channels/d1/messages` returns
        `[{"id": snowflake_at(created+1000), "author":{"id":"u1"}, "content":"zatwierdzam <code>"}]`;
      - a mock expects `PUT /channels/d1/messages/<id>/reactions/%E2%9C%85/@me` once;
      - the result is `Ok(1)`, and `core.approval_status(id).status == Approved`.
    - `poll_ignores_the_bots_own_message`: the same content with `"bot": true` → `Ok(0)`, the
      status stays `Pending`, no reaction request.
- [ ] **Step 2: Run** `cargo test supervisor::` — FAIL.
- [ ] **Step 3: Implement**; `supervisor_resolve_approval` passes `ApprovalSource::App`.
- [ ] **Step 4: Run** full `cargo test` — PASS.
- [ ] **Step 5: Commit** — `feat(desktop): accept coded Discord replies as production approvals`

---

### Task 8: Launching the supervisor with the Discord channel

**Files:**
- Modify: `DesktopApp/src-tauri/src/supervisor/process.rs`, `DesktopApp/src-tauri/src/supervisor/runtime.rs`, `DesktopApp/CLAUDE.md` ("## Supervisor agent")

**Interfaces:**
- Consumes: Tasks 1, 2, 4, 5, 6.
- Produces:
  - `pub struct DiscordLink { pub channel_active: bool, pub blocker: Option<String> }` in
    `discord/mod.rs`, plus `SupervisorProcess::discord_link(&self) -> DiscordLink`, which records the
    last launch.
  - In `runtime.rs`:
    - `#[derive(Clone, Copy, PartialEq, Eq, Debug)] struct AppliedSettings { level: SupervisorLevel, discord_enabled: bool }`;
    - `enum Transition { Unchanged, Start, Stop, Restart, Refresh }`;
    - `fn transition(previous: AppliedSettings, next: AppliedSettings) -> Transition`;
    - `pub fn link_discord_chat(app: &AppHandle)`, an async task spawned at runtime start and by
      Task 9 after a token save. It acts when all of these hold:
      - `discord_enabled`;
      - `discord_chat_id` is `None`;
      - `access().allow_from` is not empty;
      - a token exists.

      It then calls `DiscordClient::open_dm(allow_from[0])`, persists the id under
      `DISCORD_CHAT_ID_KEY` and calls `restart_supervisor`. On a REST error it logs and keeps `None`.

**Launch rules (`prepare_launch`, which stays synchronous and never calls `block_on`):**
1. **Preflight.** With `settings.discord_enabled`, run `discord_launch(&shell_env, &home, &DiscordFiles::for_claude_home(&claude_home))`.
2. **On `Ok`:**
   1. `clear_failure_cache(&claude_home)`. Log an error, do not fail the launch.
   2. Build the env with `with_path_prefix`.
   3. `chat_id = settings.discord_chat_id`. It may be `None`; `link_discord_chat` fills it later.
   4. Write the workdir with `Some(&DiscordContext { chat_id })`.
   5. Build the command with `discord_channel = true`.
3. **On `Err(blocker)`:** launch exactly as Phase 1 (`None`, `false`) and record
   `blocker.to_string()`.
4. **After the PTY spawns:** `core.set_discord_active(channel && chat_id.is_some())`.
5. **On exit or stop:** `set_discord_active(false)`.
6. **`refresh_instructions`** rewrites the workdir with the context of the last launch.

**Transition rules:**
- `Off → on` is `Start`, and `on → Off` is `Stop`.
- With both levels on: `discord_enabled` changed → `Restart`; only the level changed → `Refresh`.
- Otherwise `Unchanged`.
- `apply_settings` keeps calling `core.level_changed()` exactly where it does today, and on `Restart`
  calls `process.restart(app)`.

- [ ] **Step 1: Write the failing tests** in `runtime.rs`:
  - `transition_starts_and_stops_with_the_level`;
  - `transition_restarts_when_discord_toggles`: `Assistant`, `false → true` → `Restart`;
  - `transition_refreshes_on_level_change_only`: `Assistant → Relay` with the same Discord flag →
    `Refresh`;
  - `transition_ignores_unrelated_changes`: identical → `Unchanged`.
- [ ] **Step 2: Run** `cargo test supervisor::runtime` — FAIL.
- [ ] **Step 3: Implement** the launch and transition rules.
- [ ] **Step 4: Update `DesktopApp/CLAUDE.md` → "## Supervisor agent"** with these facts, each as one
  bullet:
  - the Discord channel spawn rule (no `--strict-mcp-config` with `--channels`);
  - Bun resolution and the `PATH` prefix (the app's login shell skips `~/.zshrc`);
  - clearing the `plugin:discord:discord` failure-cache key before each Discord launch;
  - the plugin is enabled only in the workdir, and `mcp__bandzior` is denied;
  - the DM approval poll (10 s, allowlisted human authors, after the request, exact code);
  - routing and forward-on-leave.
- [ ] **Step 5: Run** full `cargo test` — PASS; `cargo build` from `src-tauri` compiles.
- [ ] **Step 6: Commit** — `feat(desktop): start the supervisor with the Discord channel when it is set up`

---

### Task 9: Discord setup commands

**Files:**
- Create: `DesktopApp/src-tauri/src/supervisor/discord/status.rs` (register in `discord/mod.rs`)
- Modify:
  - `DesktopApp/src-tauri/src/domain/supervisor.rs`
  - `DesktopApp/src-tauri/src/commands/supervisor.rs`
  - `DesktopApp/src-tauri/src/lib.rs` (register commands)
  - `DesktopApp/src/lib/tauri.ts`
  - `DesktopApp/src/types/index.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 4, 8 (`discord_link()`), `runtime::restart_supervisor`.
- Produces:
  - Domain types (serde camelCase, `TS` exported):
    - `pub struct DiscordBotView { pub name: String, pub message_content_intent: bool, pub guild_count: Option<u64> }`
      (`guild_count`: `#[ts(type = "number | null")]`);
    - `pub struct DiscordSetupStatus { pub bun_path: Option<String>, pub token_stored: bool, pub bot: Option<DiscordBotView>, pub bot_error: Option<String>, pub paired_users: usize, pub pending_pairings: usize, pub policy: String, pub chat_linked: bool, pub global_plugin_enabled: bool, pub channel_active: bool, pub blocker: Option<String> }`.
  - `pub fn setup_status(files: &DiscordFiles, claude_home: &Path, bun: Option<PathBuf>, bot: Option<Result<BotInfo, DiscordError>>, chat_linked: bool, link: &DiscordLink) -> DiscordSetupStatus`
    in `discord/status.rs`.
  - Commands, all `#[tauri::command(async)]`:
    - `supervisor_discord_status(app) -> AppResult<DiscordSetupStatus>`. It calls
      `DiscordClient::bot()` only when a token exists.
    - `supervisor_discord_save_token(app, token: String) -> AppResult<()>`: `validate_token` →
      `save_token` → `link_discord_chat(&app)`. Then, when `discord_enabled` and the level is not
      `Off`, `restart_supervisor(&app)`.
    - `supervisor_discord_pair(app, code: String) -> AppResult<()>`: `pair(code, now_ms())` → set
      `DISCORD_CHAT_ID_KEY` to `chat_id` → restart under the same condition. Errors use the
      `PairError` `Display`.
    - `supervisor_discord_disable_global_plugin(app) -> AppResult<()>`.
  - `tauri.ts`:
    - `supervisorDiscordStatus(): Promise<DiscordSetupStatus>`;
    - `supervisorDiscordSaveToken(token: string): Promise<void>`;
    - `supervisorDiscordPair(code: string): Promise<void>`;
    - `supervisorDiscordDisableGlobalPlugin(): Promise<void>`.

- [ ] **Step 1: Write the failing tests** in `discord/status.rs` (tempdir):
  - `status_reports_each_setup_step`:
    - fixture: `.env` with a token, `access.json` with one `allowFrom` and one pending, `dmPolicy`
      `"allowlist"`, global `settings.json` with the plugin `true`, `bun = Some("/h/.bun/bin/bun")`,
      `bot = Some(Ok(BotInfo { name: "AbeonCode", message_content_intent: true, guild_count: Some(1) }))`,
      `chat_linked = true`, `link = DiscordLink { channel_active: false, blocker: Some("Brak tokenu bota Discord") }`;
    - expected: `token_stored`, `paired_users == 1`, `pending_pairings == 1`,
      `policy == "allowlist"`, `global_plugin_enabled`, `bot.name == "AbeonCode"`,
      `blocker == Some(...)`, `bun_path == Some("/h/.bun/bin/bun")`.
  - `status_reports_a_rejected_token`: `bot = Some(Err(DiscordError::Unauthorized))` → `bot == None`,
    `bot_error == Some("Discord odrzucił token bota")`.
  - `status_never_contains_the_token`: the token `"MTU2.secret-token"` does not appear in
    `serde_json::to_string(&status)`.
- [ ] **Step 2: Run** `cargo test supervisor::discord::status` — FAIL.
- [ ] **Step 3: Implement** the status builder, the commands, the registration, the bindings and the
  barrel exports (`DiscordSetupStatus`, `DiscordBotView`).
- [ ] **Step 4: Run** full `cargo test`, full `npx vitest run --maxWorkers=3`, `npm run lint` — PASS.
- [ ] **Step 5: Commit** — `feat(desktop): add Discord setup commands for the supervisor`

---

### Task 10: Discord section in Settings and Discord markers in the panel

**Files:**
- Create: `DesktopApp/src/components/dialogs/SupervisorDiscordSection.tsx`, `DesktopApp/src/components/dialogs/SupervisorDiscordSection.test.tsx`
- Modify:
  - `DesktopApp/src/store/settingsSlice.ts`
  - `DesktopApp/src/store/index.ts`
  - `DesktopApp/src/store/supervisorSettings.test.ts`
  - `DesktopApp/src/components/dialogs/SupervisorSettingsTab.tsx`
  - `DesktopApp/src/components/supervisor/SupervisorPanel.tsx`
  - `DesktopApp/src/components/supervisor/SupervisorPanel.test.tsx`

**Interfaces:**
- Consumes: Task 9 bindings and types; `EscalationChannel`, `discordActive` (Task 6).
- Produces:
  - store fields `supervisorDiscordEnabled: boolean` (default `false`) and
    `supervisorDiscordMuteWhenPresent: boolean` (default `true`);
  - setters `setSupervisorDiscordEnabled` and `setSupervisorDiscordMuteWhenPresent`;
  - both are persisted keys serialized as `'true'` / `'false'` (`index.ts` `PERSISTED_KEYS`,
    `pickPersistedFields`, `serializeValue`, `deserializeValue`).

**UI (Polish copy):**
- **Section „Discord”** in `SupervisorSettingsTab`, after „Operacje produkcyjne”. It holds the
  `SupervisorDiscordSection`.
- **Toggles:**
  - „Rozmowa przez Discord” (`supervisorDiscordEnabled`);
  - „Wyciszaj Discord, gdy jestem przy komputerze” (`supervisorDiscordMuteWhenPresent`). This one is
    shown only when the first toggle is on.
- **Setup block**, shown when enabled.
  - It loads `supervisorDiscordStatus()` on mount, after every action and on „Odśwież”.
  - Checklist rows with ✓ or ✗:
    1. „Bun zainstalowany” (with `bunPath`);
    2. „Token bota zapisany”;
    3. „Bot: <name>”, or `botError`;
    4. „Message Content Intent włączony”;
    5. „Bot dodany do serwera” (`guildCount > 0`);
    6. „Sparowany użytkownik” (`pairedUsers > 0`);
    7. „Tylko lista dozwolonych” (`policy === 'allowlist'`);
    8. „Agent połączony z Discordem” (`channelActive`, or `blocker` text).
- **Bot creation steps.** A short ordered list: New Application → Bot → Message Content Intent →
  Reset Token → OAuth2 URL Generator scope `bot` with View Channels, Send Messages, Read Message
  History, Add Reactions → add to a server. „Otwórz Discord Developer Portal” calls
  `openUrl('https://discord.com/developers/applications')` from `@tauri-apps/plugin-opener`.
- **Token.** A password input with „Zapisz token”. It calls `supervisorDiscordSaveToken(value)` and
  clears the input on success. The stored token is never shown.
- **Pairing.**
  - Text: „Napisz do bota na Discordzie dowolną wiadomość — odpowie kodem parowania”.
  - A code input with „Sparuj”, calling `supervisorDiscordPair(value.trim())`.
  - Shown when `tokenStored`.
- **Global plugin warning.** When `globalPluginEnabled`: „Wtyczka Discord jest włączona globalnie —
  każda sesja Claude łączy się z botem”.
  - The button „Wyłącz globalnie” first reveals a confirmation with the change text
    „~/.claude/settings.json: enabledPlugins → discord@claude-plugins-official: true → false” and the
    buttons „Potwierdź” / „Anuluj”.
  - „Potwierdź” calls `supervisorDiscordDisableGlobalPlugin()`.
  - Errors from every action go to `toast.error` with `formatTauriError`, as in `SupervisorPanel`.
- **`SupervisorPanel`:**
  - `ApprovalRow` and `EscalationRow` show a small badge „Discord” when `channel === 'discord'`;
  - when `supervisorDiscordEnabled`, the header shows „Discord połączony” or „Discord nieaktywny”
    from `snapshot.discordActive`.

- [ ] **Step 1: Write the failing tests:**
  - `supervisorSettings.test.ts`: `persists the Discord toggles`. Both booleans serialize as
    `'true'` / `'false'` and deserialize back; the defaults are `false` / `true`.
  - `SupervisorDiscordSection.test.tsx` (mock `../../lib/tauri` like `SupervisorSettingsTab.test.tsx`):
    - `hides the setup when Discord is off`: no „Token bota zapisany” text.
    - `shows the checklist from the status`: the mocked status (bot `AbeonCode`, `pairedUsers: 1`,
      `channelActive: true`) renders „Bot: AbeonCode” and ✓ for „Sparowany użytkownik”.
    - `saves the token and clears the field`: type `tok`, click „Zapisz token” →
      `supervisorDiscordSaveToken('tok')`, and the input value is `''`.
    - `pairs with the typed code`: type ` 4f7541 ` → `supervisorDiscordPair('4f7541')`.
    - `asks before disabling the global plugin`:
      - `globalPluginEnabled: true`; the first click shows the text containing `enabledPlugins` and
        does not call the command;
      - „Potwierdź” calls `supervisorDiscordDisableGlobalPlugin`.
  - `SupervisorPanel.test.tsx`: `marks escalations sent to Discord`. An escalation with
    `channel: 'discord'` shows the „Discord” badge, and one with `'app'` does not.
- [ ] **Step 2: Run** `npx vitest run --maxWorkers=3 src/components/dialogs/SupervisorDiscordSection.test.tsx src/components/supervisor/SupervisorPanel.test.tsx src/store/supervisorSettings.test.ts` — FAIL.
- [ ] **Step 3: Implement** the store fields, the persistence, the section and the panel markers.
- [ ] **Step 4: Run** full `npx vitest run --maxWorkers=3`, `npm run lint`, full `cargo test` — PASS.
- [ ] **Step 5: Commit** — `feat(desktop): set up Discord for the supervisor in Settings`

---

## Manual QA after the plan (user, live app)

The machine is already set up: bot `AbeonCode`, token stored, user paired, `allowlist`, global plugin
`false`.
1. Run `npm run tauri dev` with the production app stopped. In Settings → Agent sterujący → Discord,
   turn on „Rozmowa przez Discord”. Every checklist row shows ✓, and the panel header shows „Discord
   połączony”.
2. Switch „Nie ma mnie” on. A question the supervisor escalates arrives as a DM, in the
   one-line-per-session format.
3. A guarded `git push` to main from a supervisor-origin prompt is blocked. Replying
   `zatwierdzam <KOD>` in the DM gets a ✅ reaction within ~10 s, and the session receives the
   approval.
4. With an app escalation open and „Nie ma mnie” off, switching it on sends one DM with the forwarded
   items.
5. DM „co robi sesja X?” gets a short answer; DM „otwórz sesję w projekcie Y i …” opens a session at
   level *Samodzielny* / *Asystent* per §7.

**Known limit (accepted, not a task):** `discord_active` means "launched with the channel and the chat
linked". If the plugin dies at runtime (token revoked, network loss), routing still says `discord`
until the next relaunch. The Settings status (`botError`) shows a revoked token.
