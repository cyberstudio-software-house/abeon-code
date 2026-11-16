# Supervisor question card: readable, at the bottom, more time while you read — design

Date: 2026-11-16 · App: `DesktopApp/` · Scope: the question card the supervisor shows over a held
`AskUserQuestion` menu (`components/supervisor/QuestionCard.tsx`). It moves from the top of the
session to a panel under the terminal, gets a look that cannot be mistaken for session output, and
its countdown stretches to 5 minutes while the user is active with the card on screen. Amends §3
(lifecycle, grace) of `2026-10-28-supervisor-agent-design.md`.

## Why

In the user's words: the questions „są bardzo mało czytelne — zlewają się z treścią sesji, i do
tego są na górze ekranu, gdzie niekoniecznie wzrok się kieruje”. And: „czasem potrzebuję więcej
czasu na zapoznanie się z tematem”.

Today the card is an overlay pinned to the top edge (`absolute top-0`, up to 60 % of the height),
on the session's own background with one thin bottom rule, no heading, the question in the same
13 px as everything else and the countdown in a small muted footer. The time problem has a concrete
cause: the countdown pauses while the session tab is focused, but only while the user counts as
present, and presence counts only key presses and clicks. Reading the card or scrolling the
terminal for 5 minutes makes the user absent, and the question goes to the supervisor at once, with
no countdown. The same happens when the user only watched the session for 5 minutes before the
question arrived: there is no grace at all.

## Decisions agreed with the user

1. **Placement: a panel under the terminal that pushes it up** (option B). Everything the session
   printed stays visible, including the lines right above the question that usually explain it.
   The cost, accepted: the PTY is resized when the card appears and disappears, so Claude redraws
   (the terminal drawer already does this).
2. **Time: one rule instead of the pause** (option A). While the card is visible, any mouse move,
   scroll, key press or click in the window moves its deadline to at least „now + 5 min”. The
   countdown is always shown. A card on a hidden tab keeps the normal grace (60 s by default).
3. Mouse movement and scrolling count as presence everywhere, not just for the card.

## Approaches considered

- Placement:
  - **A — overlay at the bottom.** No PTY resize, but it covers the last lines of output, where
    the context of the question usually is. Rejected for that.
  - **B — panel under the terminal (picked).** Nothing hidden; one redraw on show and on hide.
- Time:
  - **A — rolling 5 minutes replaces the pause (picked).** One predictable rule, the user always
    sees how long is left, and stepping away still hands the question over after 5 minutes.
  - **B — keep the pause, add 5 minutes only for a card in an unfocused split pane.** More cases,
    and when the pause ends (presence lapses) the question leaves without any warning. Rejected.

## Design

### Layout (`center/TabContent.tsx`, `supervisor/QuestionCard.tsx`)

- The card is positioned at the bottom of the tab panel (`absolute bottom-0 inset-x-0`), capped at
  half of the pane height, scrolling inside when longer.
- `TabPanel` measures the card (ResizeObserver) and gives the session layer — and the subagent
  layer, which shares the slot — a `bottom` inset equal to the card height. Only the inline style of
  the existing layer div changes; the layer never gets a new parent or key (content-layer gotcha in
  `DesktopApp/CLAUDE.md`). `TerminalView`'s own ResizeObserver refits and resizes the PTY.
- The inset follows the card's **existence**, not its visibility: a hidden tab is `invisible`, still
  measurable, so switching tabs does not toggle the inset. A card that appears or goes while the tab
  is hidden resizes the PTY once, on the next reveal (hidden terminals are not fitted).
- Shown in terminal mode only, as today.

### Look

- A heading row: „Pytanie sesji” on the left; on the right the countdown „Agent odpowie za 4:59”
  (tabular figures, `fg-strong`) or „Agent analizuje pytanie…” (`fg-secondary`). Accent stays on the
  frame and the tint; accent text and `muted` text fall below AA contrast on the tinted light card.
- A frame in the accent colour and a background distinct from the terminal (`bg-elev` family), so
  the card reads as app UI, not output.
- The question text larger and stronger than body text (about 14 px, `fg-strong`); the per-question
  `header` stays a small label above it. Options, „Inna odpowiedź”, „Odpowiem w terminalu” and
  „Wyślij” keep their behaviour.

### Time (`supervisor/core.rs`, new command)

- New constant `ACTIVE_CARD_GRACE` = 5 min.
- New command `supervisor_extend_card(question_id)`: for a `Menu` question in `Grace`, sets the
  deadline to `max(deadline, min(now + ACTIVE_CARD_GRACE, created + MENU_HOLD_CAP - DECISION_WINDOW))`
  (both `Instant` and `deadline_ms`; `Question` keeps `created_ms` for the second), marks the
  question as extended and publishes the snapshot. The cap, 450 s after the question opened, keeps
  the countdown honest: the supervisor always gets its 120 s decision window before the 570 s hold
  cap releases the menu to the terminal. If the cap is already past, the next tick hands off. For
  any other phase or an unknown id it does nothing and succeeds (the card may have just moved on).
- `QuestionCard`, while `visible` and in `grace`, listens on `window` (capture, passive) to
  `mousemove`, `wheel`, `keydown` and `mousedown`, and calls the command at most once per 10 s
  (leading edge, so the first move after the card appears extends at once).
- Menus no longer pause on focus: `settle_pause` skips `Menu` questions and `CardPhase::Paused`
  is removed. `TurnEnded` questions (no card) keep the pause unchanged.
- Hand-off of a `Menu` in `Grace`: when the deadline passes; immediately when the user set „Nie ma
  mnie” (`away`); on a presence lapse only while the card has never been extended. Once the user
  was active on the card, the countdown on screen is the only clock.
- Unchanged: the hold cap (570 s, then the menu is released to the TUI), the 600 s hook timeout,
  the decision window, human-prompt cancellation, attention, Discord routing.

### Presence (`lib/usePresenceReporter.ts`)

- `mousemove` and `wheel` join the activity events, with the existing 20 s throttle. They count only
  while the window has focus (an unfocused window would otherwise report `null` and clear the
  focused session).
- A `mousemove` at the same `screenX`/`screenY` as the previous one is ignored here and in the card
  extension (`lib/pointerMoveFilter.ts`): WebKit fires such synthetic moves when scrolled content
  moves under a still cursor, which would keep an absent user present.

## Non-goals

- No setting for the 5 minutes (constant; easy to promote later).
- No change to the hook timeout or the hold cap: a question held for ~9.5 minutes still falls back
  to the normal Claude menu in the terminal.
- No change to escalations, approvals or the Discord flows.

## Tests

- Rust (`core.rs`): extension pushes the deadline, never shortens it, is a no-op outside `Grace`
  and for unknown ids; an extended menu survives a presence lapse but is handed off on `away` and
  at the deadline; a focused menu keeps counting (no pause); a focused `TurnEnded` still pauses.
- Vitest: the card heading and countdown; extend calls are throttled, sent only while visible and
  in grace, and stop on unmount; the session layer gets the bottom inset while a card exists (also
  on a hidden tab) and loses it when the card goes; the presence reporter reacts to `mousemove`.

## Left to the builder

Exact colours and spacing within the Grafit tokens, the measurement hook's shape, and the update of
the „Supervisor agent” section in `DesktopApp/CLAUDE.md` and spec §3.
