# Supervisor Discord buttons — design

Date: 2026-11-01 · App: `DesktopApp/` · Scope: the supervisor's Discord DM batches get clickable
buttons for short answers and for production approvals. The app (not the supervisor) renders and
posts those batches, receives the clicks over its own Discord gateway connection, and keeps the
messages in sync with what happens elsewhere.

Builds on `2026-10-28-supervisor-agent-design.md` (§8 Discord) and the batch layout shipped in
v0.1.36 (header, one block per session, one keyed bullet per question, `S1 tak` text answers).

## Why

The user answers the supervisor from Discord, often on the phone. Two things are tedious there:

- typing `zatwierdzam 9PCJ` (the exact 4-character code) to approve a blocked production action;
- typing `S1 tak, S2 prod` for questions whose answer is one short word.

One tap should do both. The batch must stay as readable as the v0.1.36 text layout, which was chosen
because a single line per session read as one dense block once several projects asked at once.

## Decisions agreed with the user

1. **Approvals: one tap.** „Zatwierdź” resolves the approval immediately. There is no second
   „Na pewno?” step, even for a push to `main`/`master`.
2. **Approval buttons** „✅ Zatwierdź” / „❌ Odrzuć” under every approval request. A click resolves the
   approval in the app directly, without the supervisor (the supervisor must never be able to
   approve). The buttons are then replaced by the outcome. Typing `zatwierdzam <KOD>` keeps working.
3. **Question buttons** for every short option, not only yes/no (e.g. `prod` · `kopia`), at most 5
   per question. Options that need free text (`opisz`, `uwagi`) stay text-only. A click counts exactly
   like the user typing `S1 tak` on Discord: it goes to the supervisor, which routes the answer to the
   session.
4. **Resolved elsewhere** (answered in the app, by text, by the supervisor, approval expired): the
   buttons disappear and the message shows the state.
5. **The app composes the message** from structured data the supervisor passes, so the layout is
   always identical and no longer depends on the supervisor following formatting rules.
6. **Only the user's account can click.** Anyone else gets an ephemeral „Brak uprawnień.” (visible
   only to them) and nothing happens.
7. **Layout: mock-up 2** (sent to the DM on 2026-11-01): Discord Components V2. One container
   (embed-like box with a coloured accent bar) per session block, buttons directly under the question
   they answer, approval buttons directly under the approval line.

## Goals

- One-tap answers for short options and approvals from the Discord DM.
- Deterministic batch layout rendered by the app (mock-up 2).
- Text answers (`S1 tak`, `zatwierdzam <KOD>`) keep working unchanged.
- A Discord message never offers a live button for something already decided.

## Non-goals

- Free-text input from Discord forms (modals) or select menus.
- Threads, a private server, or a channel per project.
- Replacing or patching the Discord channel plugin. The plugin keeps carrying the conversation
  (inbound DMs, the supervisor's conversational replies, reactions).
- Buttons on the supervisor's conversational replies (answers to the user's questions, confirmations).
- Keeping posted-message state across an app restart (see Failure handling).
- Posting approvals to Discord without the supervisor (possible later; today the supervisor batches
  them with the session's question, see §"One matter, one message").

## Anti-goals (a failure even if everything else works)

- Any path where the supervisor can cause an approval: approval clicks never pass through it, and
  nothing a click produces for the supervisor can approve anything.
- A click from an account outside `allowFrom` having any effect.
- Breaking the plugin's own permission buttons (`perm:allow|deny|more:<id>`).
- The bot token in any log line, event, tool result or Discord message.
- A gateway connection while Discord is off, unlinked, or has no token.
- A message that keeps a live button after its question or approval was decided.

## Verified facts and constraints

From the spike on 2026-11-01 (bun script in the session scratchpad, not kept):

- A second gateway session with the same bot token and `intents: 0` receives `INTERACTION_CREATE`
  while the plugin's discord.js client is connected. Interactions are delivered regardless of
  intents, so this connection receives no message content.
- The plugin's `interactionCreate` handler returns early for any button whose `custom_id` does not
  match `^perm:(allow|deny|more):[a-km-z]{5}$` (plugin `server.ts:747`). It never acknowledges our
  buttons, so our callback wins.
- The click carried `user.id` = `allowFrom[0]`. A type 7 callback (`UPDATE_MESSAGE`) returned 204 in
  0.3 s and replaced the message.
- A Components V2 message (`flags: 1 << 15`) with containers, text displays and action rows posts to
  the DM with status 200.

Discord limits to design around:

- An interaction must be acknowledged within 3 s.
- V2 messages cannot use `content`; all text goes into text display components. Per message: at most
  40 components counted recursively, and 4000 characters across all text displays.
- Action row ≤ 5 buttons; button label ≤ 80 characters; `custom_id` ≤ 100 characters.
- REST rate limits return 429 with `retry_after`.

Codebase constraints:

- `tools::handle_tool` is synchronous, while posting needs async REST (`reqwest`, already used by
  `discord/client.rs`). `tokio-tungstenite` (with rustls) is already a dependency.
- The plugin's `edit_message` sets `content`, which a V2 message rejects, so the supervisor must not
  edit app-posted messages.
- The existing DM approval poll (`discord/poll.rs`, every 10 s) and its conditions (Discord enabled,
  chat linked, token present, non-empty `allowFrom` read from the plugin's `access.json`) stay as
  they are; the gateway uses the same conditions.
- Approvals are resolved through `SupervisorCore::resolve_approval(id, approve,
  ApprovalSource::Discord)`, which already queues the approval notice into the session and emits
  `approvalResolved` to the supervisor.
- `escalate_question` takes the question out of `questions` and creates an `EscalationView` with its
  own id and no link back to the `question_id`; `ForwardedEscalation` carries no id at all. Both
  need the `question_id` (or an escalation id the tool accepts) for this design.
- `ApprovalBook::prune` drops expired approvals silently, without an event; the sync in §8 needs a
  signal for expiry.
- `level_changed` to Off clears the supervisor's event queue.

## Design

### Overview

```
supervisor ──discord_post(blocks, approval_ids)──▶ app: validate, assign keys, render V2, POST
                                                     │ registry: message ↔ items
user taps a button ──INTERACTION_CREATE──▶ app gateway task
     approval  → resolve_approval(…, Discord) → UPDATE_MESSAGE with the outcome
     option    → record value → UPDATE_MESSAGE → event discordAnswer → supervisor routes it
resolved elsewhere (app card, text code, supervisor answer, expiry) → app PATCHes the message
```

### 1. New MCP tool `mcp__abeoncode__discord_post`

The supervisor calls it instead of `mcp__plugin_discord_discord__reply` for every batch of
escalations and approval requests that `escalate` / `guardBlocked` / `forwarded` route to Discord.
`reply` stays for conversation only.

Input:

```json
{
  "blocks": [
    {
      "session_id": "…",
      "items": [
        {
          "question_id": "…",
          "question": "Specyfikacja etapu 2: akceptujesz?",
          "options": ["tak", "nie"],
          "text_options": ["uwagi"],
          "context": "Sesja przyjęła, że nowe elementy makiet zostają."
        }
      ]
    }
  ],
  "approval_ids": ["…"]
}
```

- `items` of one block may share a `question_id` (a session that asked two things at the end of a
  turn gets two items, two keys).
- `options`: 0–5 entries, each ≤ 25 characters, rendered as buttons. `text_options`: listed in the
  text, answered by typing. An item with no options at all is text-only.
- `question` ≤ 300 characters, `context` ≤ 300 characters (optional).
- `approval_ids`: pending approvals routed to Discord. The app renders them from its own approval
  record (action and code come from the app, never from supervisor text) inside the block of the
  approval's session; if no block for that session is passed, the app creates one from the session
  label.

Validation (errors are Polish strings like the other tools):

- Discord must be active (`discord_active` and a linked chat); otherwise an error tells the
  supervisor to leave it to the app.
- Every `question_id` must be an open escalation routed to `discord` (the supervisor still calls
  `escalate` first; that is where the app records the escalation and decides the channel). The
  escalation therefore keeps its `question_id`, and `forwarded` escalations carry it too, so the
  supervisor has an id to pass for forwarded items.
- Every approval must be pending and routed to `discord`.
- Already-posted questions and approvals with an open message are skipped, not posted twice
  (returned in `skipped`). This enforces "one matter, one message" in code instead of prompt rules.

**One matter, one message** *(call made in review)*: a new batch is always a new message (it also
pings the user); the app never appends items to an older message. A session question that only asks
for an approval already posted is escalated as today but not posted (the existing prompt rule); a
question that brings a genuinely new decision is posted in the next batch.

### 1b. New MCP tool `mcp__abeoncode__discord_answered` *(call made in review)*

The app never sees text answers (`S1 tak`); they reach the supervisor through the plugin. So the
supervisor reports them: after reading a DM that answers keys by text, it calls

```json
{ "answers": [{ "key": "S1", "value": "tak" }, { "key": "B1", "value": "własny opis …" }] }
```

The app marks those items answered (their buttons become `✅ S1: tak`, long values shortened to
about 40 characters), so `open_keys` stays accurate and the user cannot answer the same key twice.
Unknown or already-closed keys come back in `skipped`. It records nothing else and touches no
session; routing to the session stays `answer_question` / `send_to_session`.

Result: the call returns only after the post succeeded or failed (the supervisor must know, so it can
fall back to a plain `reply` if posting fails):

```json
{ "posted": 1, "keys": [{ "question_id": "…", "question": "…", "key": "S1" }], "skipped": [] }
```

How the synchronous `handle_tool` waits for the async post is the builder's call (an async tool
path, or handing the post to the Discord task and blocking on a oneshot with a timeout).

### 2. Keys are assigned by the app

The app assigns keys with the v0.1.36 rule, now enforced in code: the project's first letter
uppercased plus a running number per project (`S1`, `S2`, `B1`); when two projects with open items
share the first letter, both use as many leading letters as needed to differ (`SK1`, `SE1`); a key
is never reused while its item is open. The project name comes from the session label
(`<projekt> · <tytuł>`). Keys come back in the tool result; the supervisor remembers them for text
answers.

### 3. Rendering (mock-up 2)

One V2 message per batch (`flags: 1 << 15`, `allowed_mentions: { parse: [] }`):

1. Text display: `**🧭 Do decyzji: <projekt> (n) · <projekt> (n + zgoda)**`.
2. One container per session block, accent colour from a small fixed palette chosen by a stable hash
   of the project name:
   - text display `**📁 <projekt>** — <tytuł>`;
   - per item: text display `**<key>** <question>`, plus `-# albo odpisz \`<key> <text option>: …\``
     when there are text options, plus `-# <context>` when given; then an action row with one
     secondary button per option;
   - per approval: text display `🔒 **Zgoda:** \`<action>\` · kod \`<code>\``, then an action row
     „✅ Zatwierdź” (success) and „❌ Odrzuć” (danger).
3. Text display footer: `-# Możesz też odpisać tekstem, np. \`<sample>\``, the sample built from the
   first option of up to three keys.

Splitting: when a batch exceeds 40 components or 4000 text characters, it is split into several
messages on container boundaries, header only in the first, footer only in the last. The input
limits do not keep a block within one message (an item with 5 options costs 7 components, so six
such items overflow), so a block that does not fit continues in the next message in a new container
titled `**📁 <projekt>** — <tytuł> (cd.)` *(call made in review)*. Keys never change once posted.

Resolved states replace an item's (or approval's) action row with a text display:

| State | Text |
|-------|------|
| Answered by a click | `✅ <key>: <option>` |
| Answered another way (text, app, supervisor) | `✅ <key>: rozstrzygnięte` |
| Approval approved / rejected | `✅ Zatwierdzono` / `❌ Odrzucono` |
| Approval expired | `⌛ Wygasło` |
| Unknown or stale button | `⌛ Nieaktualne — odpowiedz tekstem` |

The renderer is a pure function from the registry state to component JSON, so both the first post
and every later update re-render the whole message from the same source.

### 4. Registry of posted messages

In memory, inside the Discord runtime state: message id ↔ items (question id, session id, key,
options, state) and approvals (approval id, state). `custom_id`s:

- `abeon:q:<item_id>:<option_index>`;
- `abeon:a:<approval_id>:y` / `abeon:a:<approval_id>:n`.

`item_id` is a short random id. The option value is taken from the registry, never from the
`custom_id`. The `abeon:` prefix never matches the plugin's `perm:` pattern.

### 5. Gateway task

A minimal Discord gateway client on `tokio-tungstenite`:

- connect to `wss://gateway.discord.gg/?v=10&encoding=json`; on HELLO start heartbeats (first one
  after `interval × jitter`), send IDENTIFY with `intents: 0`;
- handle op 1 (heartbeat now), op 7 (reconnect), op 9 (invalid session), op 11 (ack; a missed ack
  closes and reconnects);
- forward `INTERACTION_CREATE` dispatches to the interaction handler;
- reconnect with backoff (1 s doubling up to 60 s). Resume vs. re-identify is the builder's call;
  re-identify is acceptable at this volume.

It runs only while the same conditions as the DM poll hold, and is stopped or restarted when they
change (Discord toggled, token saved, chat linked, `allowFrom` emptied). It never logs the token or
interaction tokens.

### 6. Interaction handler

Must answer within 3 s, so it decides from in-memory state, sends the callback, and does anything
slow afterwards:

1. Read `allowFrom` (as the poll does). A user outside it gets a type 4 callback with flags 64,
   content „Brak uprawnień.”; nothing else happens.
2. Unknown `custom_id` (stale message, app restarted): type 7 callback that replaces that row with
   the stale text.
3. Approval: `resolve_approval(id, approve, ApprovalSource::Discord)`. On success, type 7 with the
   outcome row. If it was already resolved or expired, type 7 showing the current state. The decision
   log rationale may say it was a button (builder's call on wording).
4. Option: mark the item answered with that option, type 7 with `✅ <key>: <option>`, then push
   `SupervisorEvent::DiscordAnswer` (below) and wake the supervisor.
5. Option while the supervisor cannot take it *(call made in review)*:
   - supervisor restarting or not ready yet, level not Off: accept as in step 4; the event waits in
     the queue, which already survives until readiness;
   - level Off, or the Discord channel not active: type 4 ephemeral „Agent sterujący jest wyłączony —
     odpowiedz w aplikacji.”, buttons stay, nothing is recorded.

   A click that reaches the supervisor late is safe: if the session moved on, §8 has already closed
   the item, so the click gets the stale row instead of an event.

### 7. Event for the supervisor

```json
{
  "type": "discordAnswer",
  "question_id": "…",
  "session_id": "…",
  "label": "projekt · tytuł",
  "key": "S1",
  "question": "Specyfikacja etapu 2: akceptujesz?",
  "value": "tak",
  "open_keys": ["S2"]
}
```

- It wakes the supervisor (`wakes_supervisor`).
- `value` is always one of the options the supervisor itself supplied, so no free text from Discord
  enters through this path.
- `open_keys` lists the other still-open keys of the same `question_id`. The supervisor forwards the
  answers of one question to its session together, once no key of that question is open, exactly as
  it does for text answers. A key the user answers by text is closed through `discord_answered`
  (§1b), so `open_keys` never lists it.

### 8. Keeping messages in sync

The app PATCHes its own message (`PATCH /channels/{chat}/messages/{id}` with re-rendered components)
when:

- an approval it posted is resolved by any path (app card, `zatwierdzam <KOD>` via the poll, a
  button) or expires (expiry needs a signal: prune must report what it dropped, or the Discord task
  checks posted approvals against the pending list; builder's call);
- items are closed by `discord_answered` (§1b);
- all open items of a session close (`✅ <key>: rozstrzygnięte`, unless already answered) when the
  escalated question is settled. For an escalated question the real signals are: the supervisor's
  `send_to_session` to that session, a Human prompt typed in that session, „Odrzuć” on the
  escalation in the app, and the core forgetting the session (rebind after `/clear` or `/resume`).
  `answer_question` and `questionResolved` do not fire for escalated questions, because escalation
  takes the question out of `questions`.

Updates are sent from the Discord task, coalesced per message, and honour 429 `retry_after`.

### 9. Supervisor instructions (`claude_md.rs`, Discord variant)

- Batches go through `mcp__abeoncode__discord_post`; `reply` is for conversation only. If
  `discord_post` fails, fall back to one plain `reply` in the v0.1.36 text layout.
- The supervisor writes short questions, splits multi-part questions into items, marks one-word
  options as `options` and free-text ones as `text_options`, and adds context only when needed.
- Keys come from the tool result; the supervisor no longer invents them.
- It no longer writes the `zatwierdzam <KOD>` syntax for batched approvals (the app renders them);
  in conversation it still gives the code when the user asks about a pending approval.
- It never edits app-posted messages with `edit_message`.
- New event `discordAnswer`: treat it as the user's answer to that key; route when the question has
  no open keys.
- After a DM that answers keys by text, call `discord_answered` with those keys and values before
  routing, so the buttons go and `open_keys` stays true.
- "One matter, one message" (punkt 10) now means: do not post a question that only repeats an
  approval already posted; a genuinely new decision goes into the next batch (a new message), never
  by editing an app-posted message.
- The v0.1.36 grouping rule stays for conversational replies that span several sessions.
- Tests pin the new rules as the current ones do.

### 10. Settings status

The Discord section in Settings gets one status line for the buttons connection: connected /
not connected (with the Polish reason, e.g. no token, chat not linked, gateway error). Copy and
placement are the builder's call within the existing `SupervisorDiscordSection`.

## Failure handling

- **Gateway down:** messages still post with buttons; a click shows Discord's own "interaction
  failed" to the user, and the footer reminds them they can answer by text. The status line says
  why.
- **Post fails:** `discord_post` returns the error; the supervisor falls back to a plain `reply`.
- **App restart:** the registry and pending approvals are in memory, so old buttons become stale;
  a click on one gets the stale row (case 2 above).
- **Rate limits:** retry after `retry_after`; never drop a callback (it must go out within 3 s).

## Testing

- Renderer: unit tests for the layout (header counts, containers, rows per item, approval rows,
  footer sample), resolved states, splitting by limits, and that approval text comes from the app's
  record.
- Key assignment: first-letter rule, shared letters, no reuse while open.
- Tools: `discord_post` validation errors, skip of already-posted items, result shape, forwarded
  escalations postable by their `question_id`; `discord_answered` closing keys and skipping unknown
  ones.
- Sync: each close signal in §8 (send_to_session, Human prompt, dismiss, rebind, approval resolved
  by app/poll/button, approval expiry) re-renders the right message; a click while the level is Off
  is refused.
- Gateway: a local WebSocket server (tokio-tungstenite accept) driving HELLO → IDENTIFY with
  `intents: 0`, heartbeats and ack timeout, op 7/9, dispatch of `INTERACTION_CREATE`, backoff.
- Interaction handler: non-allowlisted user, unknown id, approval approve/reject/already resolved,
  option → `discordAnswer` with `open_keys`; the callback is sent before any slow work.
- REST: `wiremock` (already used by `discord/`) for post, patch, callback and 429.
- `claude_md.rs` tests for the new rules and removed ones.
- Live QA checklist for the plan: tap approve and reject on a real block; tap an option and see the
  session get the answer; answer one key by text and see its buttons go; resolve an approval in the
  app and see the Discord message update; restart the app and tap an old button; drop the network and
  watch the status and reconnect; check the plugin's own permission buttons still work.

## Docs

- `DesktopApp/CLAUDE.md`, "Supervisor agent": a bullet on the buttons (tool, gateway, registry,
  sync, the `abeon:` prefix and why the plugin ignores it).
- `2026-10-28-supervisor-agent-design.md` §8 "Message style": point to this spec for Discord batches.

## Calls made in review (not decided by the user)

The builder check raised these; they follow from the user's decisions or are edge cases with an
obvious default:

1. Text answers close their keys through a new supervisor tool `discord_answered` (§1b). This is
   what decision 4 ("buttons disappear when decided elsewhere") requires.
2. A new batch is always a new message; app messages are never appended to (§1).
3. An option click while the supervisor is off is refused ephemerally; while it restarts it is
   queued (§6.5).
4. A block too big for one message continues in the next one as `(cd.)` (§3).
5. Escalations and `forwarded` escalations carry the `question_id`; approval expiry gets a signal
   (§8).

## Left to the builder

- Module split under `supervisor/discord/` (e.g. `gateway`, `render`, `registry`, `interactions`).
- How `handle_tool` waits for the async post.
- Resume vs. re-identify; exact backoff; coalescing window for PATCHes.
- The accent palette, decision-log wording, status copy.
