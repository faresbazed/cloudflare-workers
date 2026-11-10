# Edge Sync Worker

A single-file Cloudflare Worker that accepts VLESS connections over
WebSocket + TLS on port 443 and forwards them over outbound TCP sockets
(`cloudflare:sockets`). UDP is limited to DNS (port 53), answered via
DNS-over-HTTPS. No server, no VPS — the Worker *is* the node.

```
client ──VLESS / WS / TLS :443──▶ Cloudflare edge (this Worker) ──TCP──▶ internet
```

## Why it's built the way it is

- **Secrets from the environment only.** There is no default UUID and no
  hard-coded path in the source. An unset `UUID` makes the Worker serve
  only the status page.
- **The status page is the site.** Every non-WebSocket request gets a
  small, boring status page. Nothing else is exposed.
- **The client link lives behind the credential.** Visiting
  `https://<your-host>/<uuid>` returns that user's ready-to-copy
  `vless://` URI. Anyone without the UUID gets the status page —
  unlike setups with a fixed public "config path", which leak the UUID
  to anyone who reads the (often public) source.
- **No fingerprint tricks.** No fake headers, user-agent blocking or
  timing jitter: none of that is visible to anyone who matters, and
  some of it breaks real clients. What keeps an account in good
  standing is behaviour — personal-scale usage, your own domain, and
  not publishing working links — not source-code cosmetics.
- **Keep this repository private**, whatever you name it.

## Deploy

### Option A — Cloudflare dashboard (no tooling)

1. Workers & Pages → **Create Worker**, give it an innocuous name.
2. Replace the generated code with `worker.js`, Deploy.
3. Settings → **Variables and Secrets** → add a *Secret*:
   - `UUID` — a UUID v4 you generate (any "UUID generator"; keep it private)
4. Settings → **Domains & Routes** → add a **Custom Domain** on a domain
   you own (recommended over `workers.dev`: it routes on 443 with a real
   certificate and doesn't advertise that it's a Worker).

### Option B — Wrangler

```bash
npx wrangler login
npx wrangler secret put UUID     # paste your UUID when prompted
npx wrangler deploy
```

`wrangler.toml` is already in the repo; rename the worker there first.

### Optional variables

| Name      | Required | Purpose                                                     |
| --------- | -------- | ----------------------------------------------------------- |
| `UUID`    | yes      | User UUID(s), comma-separated for multiple users            |
| `PROXYIP` | no       | Fallback relay host for destinations hosted on Cloudflare itself (the edge refuses direct connections to its own IPs) |
| `DOH`     | no       | DNS-over-HTTPS endpoint for UDP/53 (default: Cloudflare DoH) |

## Client setup

Visit `https://<your-host>/<uuid>` after deploying — it prints the full
URI and every field. In short: address = your custom domain (or any
Cloudflare edge IP / Cloudflare-fronted hostname), port **443**,
transport **ws**, path `/?ed=2048`, TLS on, SNI/Host = your domain.

## Limits & honesty

- Free-plan Workers have daily request and CPU limits; a tunnel holds
  long-lived WebSocket requests, so this suits personal use, not sharing.
- Cloudflare can see and can act on accounts whose traffic patterns look
  like a public proxy service. There is no code trick that changes that;
  keep usage personal, don't publish live links, and rotate the UUID if
  one ever leaks (change the secret, redeploy — old links die instantly).
- Destinations hosted behind Cloudflare need `PROXYIP` set, because
  Workers cannot open sockets to Cloudflare's own edge IPs directly.
