-- Invite-bound media key envelope (RFC 0006 handoff without #mk= raw key).
-- AES-GCM ciphertext of the 32-byte catalog key, sealed under a key derived
-- from the invite token (client-side). Server stores opaque bytes only and
-- returns them once on successful signup, then clears the column.
ALTER TABLE invites ADD COLUMN media_key_envelope BYTEA;
