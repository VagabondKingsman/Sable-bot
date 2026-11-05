# OAuth setup: Gmail + Google Calendar (W2b)

Status: **the code is shipped and tested against a local mock Google. Live Google still needs He's credentials.**
Sable has never signed in to a real Google account. The steps below are for He. Nothing here should be pasted into chat.

## 0. Prerequisites on the Sable box

1. **Vault key.** OAuth tokens are stored only in the encrypted W0 vault.
   - Add `SABLE_VAULT_KEY=<32 random bytes, base64>` to `/workspace/sable/.env.local`.
   - Generate it locally with `openssl rand -base64 32`, and never print or share it.
   - Then restart Sable.
   - Without the key, every connector shows **not-configured (vault key)**.
2. **Public origin.**
   - The redirect URI is built from `SABLE_OAUTH_REDIRECT_BASE`.
   - If that is unset, the first entry of `SABLE_TRUSTED_ORIGINS` is used. Today that entry is `https://undone-emcee-tributary.ngrok-free.dev`.
   - The URI must be https. Plain http is allowed only on localhost.
3. **Kill switch.** `SABLE_OAUTH=0` turns everything off: no connect, no callback, no connector tools, and no sync.

## 1. Google Cloud project

1. Go to https://console.cloud.google.com/ and create (or pick) a project, e.g. `sable-personal`.
2. Under **APIs & Services → Library**, enable **Gmail API** and **Google Calendar API**.

## 2. OAuth consent screen (Google Auth Platform)

1. Set **User type: External**. Set **Publishing status: Testing** and leave it there; do not publish.
2. Fill in the app name (`Sable`), the support email, and the developer email.
3. Add these four scopes, and only these:

   | Scope | Why |
   |---|---|
   | `https://www.googleapis.com/auth/gmail.readonly` | read/search threads, messages, labels; triage + brief |
   | `https://www.googleapis.com/auth/gmail.compose` | create drafts; send (each send goes through an approval card) |
   | `https://www.googleapis.com/auth/calendar.readonly` | list calendars/events, free/busy, today's events in the brief |
   | `https://www.googleapis.com/auth/calendar.events` | create/update/delete events (approval required; invitations are never sent) |

4. Under **Test users**, add He's Google account. Only test users can grant consent while the app is in Testing mode.
5. ⚠️ In Testing mode, Google **expires refresh tokens after 7 days**. When that happens:
   - Sable marks the connector **error** or **needs-auth**.
   - Click **Connect** again to renew it.

## 3. OAuth client

1. Go to **Credentials → Create credentials → OAuth client ID → Web application**.
2. Add this under **Authorized redirect URIs**. It must match exactly, with no trailing slash:

   ```
   https://undone-emcee-tributary.ngrok-free.dev/api/oauth/callback
   ```

   If the ngrok domain or `SABLE_OAUTH_REDIRECT_BASE` ever changes, update this entry. The current value is shown under **Settings → Kết nối** in Sable.
3. Leave **Authorized JavaScript origins** empty; it is not needed.

## 4. Give Sable the client credentials (pick one)

- **Preferred: the vault.** In Sable, go to Settings → Vault and add:
  - `GOOGLE_OAUTH_CLIENT_ID`
  - `GOOGLE_OAUTH_CLIENT_SECRET`
- **Alternative: env.** Put these in `.env.local`, then restart:
  - `SABLE_GOOGLE_CLIENT_ID`
  - `SABLE_GOOGLE_CLIENT_SECRET`

## 5. Connect

1. Open Sable through ngrok. Basic auth is required, so only He can reach it.
2. Go to **Settings → Kết nối → Gmail → Connect**. Google's consent page opens in a new tab.
3. Approve. Google redirects to `/api/oauth/callback`, which shows "Đã kết nối" (connected). Close the tab.
   - ngrok basic auth also protects the callback, so the browser must already be signed in to Sable. It is, because you started the flow from Sable.
4. Repeat the same steps for **Google Calendar**. Each connector gets its own token and its own consent.
5. **Disconnect** revokes the token with Google (best effort) and deletes it from the vault.

## How it behaves

- **Sign-in flow:** authorization-code with PKCE (S256) and a single-use `state` that expires after 10 minutes. `access_type=offline` and `prompt=consent` are set so Google returns a refresh token.
- **Token storage:**
  - Each connector's token is stored in the vault as `OAUTH_TOKEN_GMAIL` or `OAUTH_TOKEN_GCAL`.
  - `/api/vault` refuses to return `OAUTH_TOKEN_*` values.
  - `oauth.json` (mode 0600) holds only timestamps, granted scopes, and the last error code.
- **Token use:**
  - Tokens are refreshed 60 s before they expire, and once more after a 401.
  - If Google answers `invalid_grant`, the token is deleted and the connector goes to needs-auth.
  - API calls may only go to the connector's own https base (`gmail.googleapis.com/gmail/v1/users/me/` or `www.googleapis.com/calendar/v3/`), and redirects are refused.
- **Redaction:** tokens, client secrets, `?code=` values, and token JSON are redacted from logs, traces, audit and memory (`ya29.`, `1//`, `GOCSPX-`, `access_token`, …).
- **Sending mail:** `gmail_send` always needs the approval card.
  - Routine, trigger, agent and subagent initiators are refused before any card is shown. That includes a chain that *started* in the background.
  - Routine runs do not see approval-needing connector tools at all.
- **Calendar writes:** create, update and delete need approval and use `sendUpdates=none`, so no invitations go out. Attendees are not supported yet.
- **Mail sync:**
  - New mail (`in:inbox newer_than:2d`, up to 25 messages) is synced into triage every 10 minutes and before the morning brief.
  - Manual sync: **Đồng bộ thư** (sync mail).
- **Morning brief:** includes **Lịch hôm nay** (today's calendar) when Calendar is connected, using the local day in the brief's time zone.
