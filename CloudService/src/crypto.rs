use rand::Rng;
use sha2::{Digest, Sha256};

/// Lowercase hex SHA-256. Used to store/compare high-entropy bearer tokens.
pub fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex::encode(hasher.finalize())
}

/// A 256-bit random secret as 64 lowercase hex chars (device secrets, phone tokens).
pub fn generate_secret() -> String {
    let bytes: [u8; 32] = rand::thread_rng().gen();
    hex::encode(bytes)
}

/// An 8-char human-friendly pairing code from an unambiguous alphabet
/// (no 0/O/1/I/L). Shown by the desktop as text + QR.
pub fn generate_pairing_code() -> String {
    const ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    let mut rng = rand::thread_rng();
    (0..8).map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char).collect()
}

/// Unix epoch seconds (UTC). No chrono dependency; avoids tz mapping issues.
pub fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock before epoch")
        .as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_is_deterministic_and_64_hex() {
        let a = sha256_hex("hello");
        assert_eq!(a, sha256_hex("hello"));
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, sha256_hex("world"));
    }

    #[test]
    fn secret_is_64_hex_and_unique() {
        let a = generate_secret();
        let b = generate_secret();
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
    }

    #[test]
    fn pairing_code_is_8_chars_from_alphabet() {
        let code = generate_pairing_code();
        assert_eq!(code.len(), 8);
        assert!(code.chars().all(|c| "23456789ABCDEFGHJKMNPQRSTUVWXYZ".contains(c)));
    }
}
