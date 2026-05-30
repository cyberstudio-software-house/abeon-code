CREATE TABLE devices (
    id                  CHAR(36)     NOT NULL,
    device_secret_hash  CHAR(64)     NOT NULL,
    label               VARCHAR(128) NULL,
    created_at          BIGINT       NOT NULL,
    last_seen_at        BIGINT       NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_devices_secret_hash (device_secret_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE phone_tokens (
    id            CHAR(36)     NOT NULL,
    device_id     CHAR(36)     NOT NULL,
    token_hash    CHAR(64)     NOT NULL,
    created_at    BIGINT       NOT NULL,
    last_used_at  BIGINT       NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_phone_token_hash (token_hash),
    KEY idx_phone_device (device_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE pairing_codes (
    code_hash   CHAR(64) NOT NULL,
    device_id   CHAR(36) NOT NULL,
    expires_at  BIGINT   NOT NULL,
    created_at  BIGINT   NOT NULL,
    PRIMARY KEY (code_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
