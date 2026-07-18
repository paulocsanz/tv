CREATE TABLE tv_pairings (
    id BIGSERIAL PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    poll_token_hash TEXT NOT NULL UNIQUE,
    claimed_by BIGINT REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
