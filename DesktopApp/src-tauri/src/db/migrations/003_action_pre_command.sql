ALTER TABLE actions ADD COLUMN pre_command TEXT;

INSERT OR IGNORE INTO schema_version(version) VALUES (3);
