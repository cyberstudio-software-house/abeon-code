//! Shared remote-control contract for AbeonCloud: the command/event protocol,
//! Centrifugo JWT minting, and the network-input validation allowlists.
//! Depended on by both the desktop bridge and CloudService so the two cannot drift.

pub mod channels;
pub mod protocol;
pub mod token;
pub mod validation;
