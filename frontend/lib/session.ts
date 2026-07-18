export const SESSION_COOKIE = "tv_session";
// Holds a TV pairing's poll token between /api/tv/pair/start and
// /api/tv/pair/poll - never read by client JS, and separate from
// SESSION_COOKIE since the TV isn't signed in yet while this is set.
export const TV_PENDING_POLL_TOKEN_COOKIE = "tv_pending_poll_token";
