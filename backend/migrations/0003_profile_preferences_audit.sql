ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN default_subtitle_lang TEXT;
ALTER TABLE users ADD COLUMN autoplay_next BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE catalog_edit_log (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content_id TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
