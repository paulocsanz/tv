# Account Signup & Cost Sharing

**Status:** Draft

## Background

- Today there's a single shared catalog and one Postgres `users` table. A fixed admin account
  is seeded from `ADMIN_USERNAME`/`ADMIN_PASSWORD`, and every other account is created manually
  by the admin through a hidden `/admin/users` page (not linked from any nav).
- There's no self-serve signup, no invite flow, no notion of groups or tenants, and no
  cost-sharing of any kind — the admin absorbs all S3/storage/compute cost personally.
- **Open question this RFC assumes an answer to:** "multi-tenant" here means supporting more
  people *you already know* (friends/family) with less manual admin overhead and optional
  cost-splitting — not opening public paid signups to strangers. The catalog is sourced from
  torrents; selling subscription access to the public would mean operating a commercial service
  built on unlicensed copyrighted content — real DMCA/criminal-copyright exposure and a payment
  processor ToS violation. If the actual goal is a public paid product, that's a different
  conversation and this RFC's proposed solution doesn't apply — flag it back before building
  anything below.

## Problems This Solves

- **Manual account creation doesn't scale** — every new person requires the admin to personally
  create their login via the terminal-adjacent admin page.
- **No visibility into who's using how much** — no per-user signal on storage or watch-time to
  inform any kind of cost conversation with the group.
- **No self-serve onboarding** — there's no invite link or signup flow, just a hidden admin page
  that isn't discoverable without being told the URL.

## Proposed Solution

- [x] **P0** Invite-link signup: admin generates a single-use or time-limited invite link; the
      invitee sets their own username/password, replacing admin-only `CreateUserForm` submission.
      Implemented 2026-07-09: `POST /api/admin/invites` (admin-only) + `/signup?token=` page,
      7-day single-use tokens in a new `invites` table (migration `0002_invites.sql`).
- [ ] **P0** Per-user attribution: track bytes served / minutes watched per user (derivable from
      existing sessions + S3 access patterns) — a signal, not a billing engine.
- [ ] **P1** A simple periodic cost summary (e.g. monthly, emailed or shown on `/account`)
      showing the group's total spend and each person's share of usage — no payment processing.
- [ ] **P2** Let invited users set a display name distinct from login username.
- Keep the single shared catalog model — no per-tenant catalog isolation. "Tenant" means
  "invited person," not "paying customer."
- **Explicitly out of scope** unless the open question above gets a different answer: public
  signup, subscription billing, payment processing integrations.
