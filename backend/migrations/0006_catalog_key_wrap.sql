-- Per-user wrap of the shared catalog media key (AES-256-GCM).
-- Server stores only the wrapped blob + salt; it never sees the plaintext key.
-- See rfcs/0006-storage-encryption-and-key-bootstrap.md.
ALTER TABLE users ADD COLUMN catalog_key_wrap BYTEA;
ALTER TABLE users ADD COLUMN catalog_key_wrap_salt BYTEA;
