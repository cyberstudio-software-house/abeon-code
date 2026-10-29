use std::collections::HashMap;
use std::time::{Duration, Instant};
use parking_lot::Mutex;

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Sequence {
    Report,
    PasteStart,
    PasteEnd,
    Key,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum InputKind {
    Reports,
    Keys,
    Submit,
}

fn is_numeric(params: &[u8]) -> bool {
    !params.is_empty() && params.iter().all(|byte| byte.is_ascii_digit() || *byte == b';')
}

fn is_position(params: &[u8]) -> bool {
    let params = params.strip_prefix(b"?").unwrap_or(params);
    let parts: Vec<&[u8]> = params.split(|byte| *byte == b';').collect();
    (2..=3).contains(&parts.len())
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.iter().all(u8::is_ascii_digit))
}

fn classify_csi(params: &[u8], intermediates: &[u8], final_byte: u8) -> Sequence {
    match (params, intermediates, final_byte) {
        (b"200", b"", b'~') => Sequence::PasteStart,
        (b"201", b"", b'~') => Sequence::PasteEnd,
        (b"", b"", b'I' | b'O') => Sequence::Report,
        (_, b"", b'R') if is_position(params) => Sequence::Report,
        ([b'?' | b'>' | b'=', ..], b"", b'c') => Sequence::Report,
        ([b'?', ..], b"", b'u') => Sequence::Report,
        (_, b"$", b'y') => Sequence::Report,
        (_, b"", b'n') if is_numeric(params) => Sequence::Report,
        _ => Sequence::Key,
    }
}

fn scan_csi(data: &[u8]) -> (usize, Sequence) {
    let mut end = 2;
    while data.get(end).is_some_and(|byte| (0x30..=0x3f).contains(byte)) {
        end += 1;
    }
    let params_end = end;
    while data.get(end).is_some_and(|byte| (0x20..=0x2f).contains(byte)) {
        end += 1;
    }
    match data.get(end) {
        Some(&final_byte) if (0x40..=0x7e).contains(&final_byte) => (
            end + 1,
            classify_csi(&data[2..params_end], &data[params_end..end], final_byte),
        ),
        _ => (end, Sequence::Key),
    }
}

fn scan_string(data: &[u8]) -> (usize, Sequence) {
    let mut index = 2;
    while index < data.len() {
        match data[index] {
            BEL => return (index + 1, Sequence::Report),
            ESC if data.get(index + 1) == Some(&b'\\') => return (index + 2, Sequence::Report),
            _ => index += 1,
        }
    }
    (data.len(), Sequence::Key)
}

fn scan_escape(data: &[u8]) -> (usize, Sequence) {
    match data.get(1) {
        None => (1, Sequence::Key),
        Some(b'[') => scan_csi(data),
        Some(b']' | b'P' | b'_' | b'^' | b'X') => scan_string(data),
        Some(b'O') => (data.len().min(3), Sequence::Key),
        Some(_) => (2, Sequence::Key),
    }
}

fn classify(data: &[u8]) -> InputKind {
    let mut index = 0;
    let mut keys = false;
    let mut submit = false;
    let mut in_paste = false;
    while index < data.len() {
        if data[index] == ESC {
            let (length, sequence) = scan_escape(&data[index..]);
            match sequence {
                Sequence::Report => {}
                Sequence::PasteStart => {
                    keys = true;
                    in_paste = true;
                }
                Sequence::PasteEnd => {
                    keys = true;
                    in_paste = false;
                }
                Sequence::Key => keys = true,
            }
            index += length;
            continue;
        }
        keys = true;
        if !in_paste && data[index] == b'\r' {
            submit = true;
        }
        index += 1;
    }
    if submit {
        InputKind::Submit
    } else if keys {
        InputKind::Keys
    } else {
        InputKind::Reports
    }
}

#[derive(Default, Clone, Copy)]
struct PtyInput {
    last_input: Option<Instant>,
    last_submit: Option<Instant>,
}

#[derive(Default)]
pub struct InputActivity {
    inner: Mutex<HashMap<String, PtyInput>>,
}

impl InputActivity {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record(&self, pty_id: &str) {
        self.record_at(pty_id, Instant::now());
    }

    pub fn record_at(&self, pty_id: &str, at: Instant) {
        self.inner.lock().entry(pty_id.to_string()).or_default().last_input = Some(at);
    }

    pub fn observe(&self, pty_id: &str, data: &[u8]) {
        self.observe_at(pty_id, data, Instant::now());
    }

    pub fn observe_at(&self, pty_id: &str, data: &[u8], at: Instant) {
        let kind = classify(data);
        if kind == InputKind::Reports {
            return;
        }
        let mut inner = self.inner.lock();
        let input = inner.entry(pty_id.to_string()).or_default();
        input.last_input = Some(at);
        if kind == InputKind::Submit {
            input.last_submit = Some(at);
        }
    }

    pub fn quiet_for(&self, pty_id: &str, window: Duration) -> bool {
        match self.inner.lock().get(pty_id).and_then(|input| input.last_input) {
            Some(last) => last.elapsed() >= window,
            None => true,
        }
    }

    pub fn submitted_within(&self, pty_id: &str, window: Duration) -> bool {
        self.inner
            .lock()
            .get(pty_id)
            .and_then(|input| input.last_submit)
            .is_some_and(|last| last.elapsed() < window)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WINDOW: Duration = Duration::from_secs(5);

    const TERMINAL_REPORTS: [&[u8]; 11] = [
        b"\x1b[I",
        b"\x1b[O",
        b"\x1b[12;40R",
        b"\x1b[?12;40R",
        b"\x1b[?1;2c",
        b"\x1b[>0;276;0c",
        b"\x1b]11;rgb:1e1e/1e1e/1e1e\x07",
        b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\",
        b"\x1b[?2004;1$y",
        b"\x1b[0n",
        b"\x1b[I\x1b[12;40R\x1b]11;rgb:0000/0000/0000\x07",
    ];

    const KEYSTROKES: [&[u8]; 11] = [
        b"a",
        b"\x1b",
        b"\x1b[A",
        b"\x1b[1;5D",
        b"\x1b\r",
        b"\x1b[Ia",
        b"\x1b[200~line one\rline two\n\x1b[201~",
        b"\x1b[13;2u",
        b"\n",
        b"line one\nline two",
        b"git push\n",
    ];

    const SUBMITS: [&[u8]; 5] = [
        b"\r",
        b"fix the bug\r",
        b"\x1b[200~pasted text\x1b[201~\r",
        b"\x1b[O\r",
        b"line one\nline two\r",
    ];

    #[test]
    fn quiet_when_never_recorded() {
        let activity = InputActivity::new();
        assert!(activity.quiet_for("p1", Duration::from_secs(5)));
    }

    #[test]
    fn not_quiet_right_after_record() {
        let activity = InputActivity::new();
        activity.record("p1");
        assert!(!activity.quiet_for("p1", Duration::from_secs(5)));
    }

    #[test]
    fn quiet_after_window_elapsed() {
        let activity = InputActivity::new();
        activity.record_at("p1", Instant::now() - Duration::from_secs(6));
        assert!(activity.quiet_for("p1", Duration::from_secs(5)));
    }

    #[test]
    fn terminal_reports_are_not_input() {
        for report in TERMINAL_REPORTS {
            let activity = InputActivity::new();
            activity.observe("p1", report);
            assert!(activity.quiet_for("p1", WINDOW), "report counted as input: {report:?}");
            assert!(!activity.submitted_within("p1", WINDOW), "report counted as submit: {report:?}");
        }
    }

    #[test]
    fn keystrokes_are_input_without_submit() {
        for keys in KEYSTROKES {
            let activity = InputActivity::new();
            activity.observe("p1", keys);
            assert!(!activity.quiet_for("p1", WINDOW), "keys not counted as input: {keys:?}");
            assert!(!activity.submitted_within("p1", WINDOW), "keys counted as submit: {keys:?}");
        }
    }

    #[test]
    fn enter_outside_escape_sequences_is_a_submit() {
        for keys in SUBMITS {
            let activity = InputActivity::new();
            activity.observe("p1", keys);
            assert!(!activity.quiet_for("p1", WINDOW), "submit not counted as input: {keys:?}");
            assert!(activity.submitted_within("p1", WINDOW), "submit not detected: {keys:?}");
        }
    }

    #[test]
    fn report_after_keystroke_keeps_the_keystroke_time() {
        let activity = InputActivity::new();
        activity.observe_at("p1", b"a", Instant::now() - Duration::from_secs(6));
        activity.observe("p1", b"\x1b[O");
        assert!(activity.quiet_for("p1", WINDOW));
    }

    #[test]
    fn submit_expires_after_its_window() {
        let activity = InputActivity::new();
        activity.observe_at("p1", b"\r", Instant::now() - Duration::from_secs(11));
        assert!(!activity.submitted_within("p1", Duration::from_secs(10)));
        assert!(activity.submitted_within("p1", Duration::from_secs(12)));
        assert!(!activity.submitted_within("p2", Duration::from_secs(12)));
    }

    #[test]
    fn keystroke_after_submit_keeps_the_submit_time() {
        let activity = InputActivity::new();
        activity.observe("p1", b"\r");
        activity.observe("p1", b"x");
        assert!(activity.submitted_within("p1", WINDOW));
    }
}
