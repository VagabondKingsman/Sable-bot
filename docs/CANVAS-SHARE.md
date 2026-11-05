# Canvas share links (W2c)

- **Create:** Background → Canvas → pick a page → **Link chỉ xem** (view-only link). Choose 1 hour, 1 day, 7 days or 30 days, and optionally pin the current version.
  - The URL `https://<public origin>/s/<token>` is shown **once**.
  - Only the SHA-256 of the token is stored (`sable-data/canvas-shares.json`, mode 0600).
- **Read-only:** `/s/<token>` accepts only GET and HEAD.
  - The page is a wrapper. Its only script is a nonce'd navigation guard, and it sets `frame-ancestors 'none'`, `no-referrer` and `noindex`.
  - The canvas loads inside it in `sandbox="allow-scripts"`: an opaque origin with no network, no forms, no popups, and no top navigation.
- **Revoke:** **Thu hồi** (revoke) on a link, or `POST /api/canvas/shares {action:"revoke_all", canvasId?}`.
  - A link that is wrong, expired, revoked or disabled always returns the same 404.
- **Kill switch:** `SABLE_SHARE=0` makes every link 404 and blocks creating new ones. `SABLE_CANVAS=0` does the same.
- **Audit:** `canvas.share` and `canvas.share_revoke` are recorded as side effects by the owner.
- **Base URL:** `SABLE_SHARE_BASE` overrides the origin used in links. The default is the first entry of `SABLE_TRUSTED_ORIGINS`.

## Reaching a link from outside (needs He's decision)

The ngrok traffic policy puts basic auth in front of **every** path, including `/s/`. So today a link only opens for someone who has the desk password. Sable does **not** change that by itself.

To let people without the password open share links, He would edit `/home/box/.config/ngrok/sable-policy.yml` so basic auth skips only `/s/<43-char token>`, then restart the ngrok agent:

```yaml
on_http_request:
  - expressions:
      - "!(req.url.path.matches('^/s/[A-Za-z0-9_-]{43}$') && (req.method == 'GET' || req.method == 'HEAD'))"
    actions:
      - type: basic-auth
        config:
          realm: Sable
          credentials:
            - "sable:<unchanged>"
```

Everything else would still require basic auth. Share requests are rate-limited (`/s/` is 60 requests per minute per IP).
