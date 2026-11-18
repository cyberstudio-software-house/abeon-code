use parking_lot::Mutex;
use std::collections::VecDeque;

pub const MAX_HELD_OUTPUT_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PtyEvent {
    Output(Vec<u8>),
    Exit(i32),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputDelivery {
    Immediate,
    OnAttach,
}

pub type PtyEventSink = Box<dyn Fn(PtyEvent) + Send + Sync>;

pub struct OutputGate {
    emit: PtyEventSink,
    held: Mutex<Option<HeldEvents>>,
}

#[derive(Default)]
struct HeldEvents {
    events: VecDeque<PtyEvent>,
    output_bytes: usize,
}

impl HeldEvents {
    fn push(&mut self, event: PtyEvent) {
        if let PtyEvent::Output(bytes) = &event {
            self.output_bytes += bytes.len();
        }
        self.events.push_back(event);
        while self.output_bytes > MAX_HELD_OUTPUT_BYTES {
            match self.events.front() {
                Some(PtyEvent::Output(bytes)) => {
                    self.output_bytes -= bytes.len();
                    self.events.pop_front();
                }
                _ => break,
            }
        }
    }
}

impl OutputGate {
    pub fn new(delivery: OutputDelivery, emit: PtyEventSink) -> Self {
        let held = match delivery {
            OutputDelivery::Immediate => None,
            OutputDelivery::OnAttach => Some(HeldEvents::default()),
        };
        OutputGate {
            emit,
            held: Mutex::new(held),
        }
    }

    pub fn send(&self, event: PtyEvent) {
        let mut held = self.held.lock();
        match held.as_mut() {
            Some(queue) => queue.push(event),
            None => (self.emit)(event),
        }
    }

    pub fn attach(&self) {
        let mut held = self.held.lock();
        if let Some(queue) = held.take() {
            for event in queue.events {
                (self.emit)(event);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn recorder() -> (
        Arc<parking_lot::Mutex<Vec<PtyEvent>>>,
        Box<dyn Fn(PtyEvent) + Send + Sync>,
    ) {
        let events = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let sink = events.clone();
        (events, Box::new(move |event| sink.lock().push(event)))
    }

    #[test]
    fn immediate_delivery_emits_every_event_at_once() {
        let (events, emit) = recorder();
        let gate = OutputGate::new(OutputDelivery::Immediate, emit);

        gate.send(PtyEvent::Output(b"hello".to_vec()));
        gate.send(PtyEvent::Exit(0));

        assert_eq!(
            *events.lock(),
            vec![PtyEvent::Output(b"hello".to_vec()), PtyEvent::Exit(0)]
        );
    }

    #[test]
    fn delivery_on_attach_holds_output_and_exit_until_attach() {
        let (events, emit) = recorder();
        let gate = OutputGate::new(OutputDelivery::OnAttach, emit);

        gate.send(PtyEvent::Output(b"first".to_vec()));
        gate.send(PtyEvent::Output(b"second".to_vec()));
        gate.send(PtyEvent::Exit(3));
        assert!(events.lock().is_empty());

        gate.attach();

        assert_eq!(
            *events.lock(),
            vec![
                PtyEvent::Output(b"first".to_vec()),
                PtyEvent::Output(b"second".to_vec()),
                PtyEvent::Exit(3),
            ],
        );
    }

    #[test]
    fn events_after_attach_pass_straight_through() {
        let (events, emit) = recorder();
        let gate = OutputGate::new(OutputDelivery::OnAttach, emit);
        gate.send(PtyEvent::Output(b"held".to_vec()));

        gate.attach();
        gate.send(PtyEvent::Output(b"live".to_vec()));

        assert_eq!(
            *events.lock(),
            vec![
                PtyEvent::Output(b"held".to_vec()),
                PtyEvent::Output(b"live".to_vec())
            ]
        );
    }

    #[test]
    fn a_second_attach_replays_nothing() {
        let (events, emit) = recorder();
        let gate = OutputGate::new(OutputDelivery::OnAttach, emit);
        gate.send(PtyEvent::Output(b"once".to_vec()));

        gate.attach();
        gate.attach();

        assert_eq!(*events.lock(), vec![PtyEvent::Output(b"once".to_vec())]);
    }

    #[test]
    fn held_output_keeps_the_newest_chunks_within_the_cap_and_never_drops_the_exit() {
        let (events, emit) = recorder();
        let gate = OutputGate::new(OutputDelivery::OnAttach, emit);
        let chunk = vec![b'x'; MAX_HELD_OUTPUT_BYTES / 2];

        gate.send(PtyEvent::Output(b"oldest".to_vec()));
        gate.send(PtyEvent::Output(chunk.clone()));
        gate.send(PtyEvent::Output(chunk.clone()));
        gate.send(PtyEvent::Exit(1));
        gate.attach();

        assert_eq!(
            *events.lock(),
            vec![
                PtyEvent::Output(chunk.clone()),
                PtyEvent::Output(chunk),
                PtyEvent::Exit(1)
            ],
        );
    }
}
