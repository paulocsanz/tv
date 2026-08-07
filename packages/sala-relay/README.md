# sala-relay

PC/phone **decrypt relay** for living-room playback (RFC 0011).

- Fetches HLS AES-128 ciphertext (S3 via auth)
- Decrypts with the unlocked catalog key (local only)
- Serves **clear** HLS on the LAN for TV browser / VLC

**Not docs-only.** Implementation target for P0.2. Scaffold only until RFC is approved and implementing starts.

```bash
# after P0.2 lands:
node --test packages/sala-relay/src/lan-decrypt-relay.test.js
ENCRYPTION_CATALOG_KEY=… node packages/sala-relay/src/lan-decrypt-relay.js --title-id matrix-1999-movie --port 8787
```
