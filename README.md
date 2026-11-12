# Edge Sync

A single-file Cloudflare Worker that relays WebSocket connections on port 443
to arbitrary outbound TCP destinations (`cloudflare:sockets`). DNS (UDP/53) is
answered via an encrypted resolver. No server, no VPS — the Worker *is* the
node. Your v2ray/v2rayN-style client sets any destination address; this worker
dials it.

```
client ──WS / TLS :443──▶ Cloudflare edge (this Worker) ──TCP──▶ internet
```

## How this repo is organised

- `src/` — clean, readable, commented source (protocol codec, relay session,
  pages, entry point). **This is what you edit.**
- `scripts/build.mjs` — build pipeline: esbuild bundle → minify → obfuscate
  (string-array base64 encoding, split strings, control-flow flattening,
  hexadecimal identifiers) → hot-keyword scan gate.
- `worker.js` — the **generated, obfuscated artifact** that actually deploys.
  Do not edit it by hand; regenerate with `npm run build`.
- `test/proto.test.mjs` — unit tests for the protocol codec (pure functions).
- `test/e2e.test.mjs` — boots the *obfuscated* `worker.js` in a real local
  workerd runtime (`wrangler dev`) and drives it with a real WebSocket client:
  echo relay round-trip, split-header buffering, invalid-id rejection, DNS via
  encrypted resolver, info pages.

## Avoiding detection and keyword leaks

- **The artifact is keyword-clean by construction.** The build fails if any of
  `vless, proxy, uuid, tunnel, trojan, vpn, clash, xray, singbox, socks,
  shadowsocks, hysteria, naive` appears anywhere in the deployed code — the
  scan runs both on the minified bundle *and* the obfuscated output.
- **Env names are neutral**: `K` (credential), `R` (fallback relay), `N`
  (resolver endpoint). Nothing in the deployed source advertises what it is.
- **No default credential, no fixed config path.** Without `K` set, the worker
  serves only a boring status page. The client link is shown only at
  `https://<host>/<your-id>` — a URL only the credential holder can know.
- **Everything else looks like a boring status page** to any visitor or
  scanner; non-existent paths return the same page with a 404.
- **Obfuscation details**: every string literal is base64-encoded in a rotated
  and shuffled string array with 4-char splitting, identifiers are
  hexadecimal, control flow is flattened. The import specifier
  `cloudflare:sockets` is the only literal kept verbatim (the runtime requires
  it).
- **What actually keeps accounts in good standing** is behaviour, not
  cosmetics: personal-scale use, your own custom domain, not publishing live
  links, rotating the credential if it leaks. No source trick changes what
  Cloudflare's network can see.
- **Keep this repository private**, whatever you name it.

## Development

```bash
npm install
npm run build   # regenerates worker.js (fails on hot keywords)
npm test        # unit + e2e (e2e boots wrangler dev locally)
```

`.dev.vars` (git-ignored) supplies local credentials for e2e; the test creates
one automatically if missing.

## Deploy

### Option A — Cloudflare dashboard (no tooling)

1. Workers & Pages → **Create Worker**, innocuous name.
2. Replace the generated code with the contents of `worker.js`, Deploy.
3. Settings → **Variables and Secrets** → add a *Secret*:
   - `K` — a UUID v4 you generate (comma-separate several). Keep it private.
4. Settings → **Domains & Routes** → add a **Custom Domain** on a domain you
   own (recommended over workers.dev: real certificate, port 443, doesn't
   advertise that it's a Worker).

### Option B — Wrangler

```bash
npx wrangler login
npx wrangler secret put K        # paste your UUID when prompted
npx wrangler deploy
```

Rename the worker in `wrangler.toml` first.

### Variables

| Name | Required | Purpose |
| ---- | -------- | ------- |
| `K` | yes | Accepted id(s) (UUID v4), comma-separated for multiple users |
| `R` | no | Fallback relay host for destinations hosted on Cloudflare itself (the edge refuses direct connections to its own IPs) |
| `N` | no | DNS-over-HTTPS endpoint for UDP/53 (default: Cloudflare's) |

## Client setup

Visit `https://<your-host>/<your-id>` after deploying — it prints the full
ready-to-paste URI and every field. In short: address = your custom domain
(or any Cloudflare edge IP / Cloudflare-fronted hostname — you can set any of
them as the address), port **443**, transport **ws**, path `/?ed=2048`, TLS
on, SNI/Host = your domain.

## Limits & honesty

- Free-plan Workers have daily request and CPU limits; a tunnel holds
  long-lived WebSocket requests, so this suits personal use, not sharing.
- Cloudflare can see and act on accounts whose traffic patterns look like a
  public proxy service. Keep usage personal, don't publish working links, and
  rotate the id if one ever leaks (change the secret, redeploy — old links die
  instantly).
- Destinations hosted behind Cloudflare need `R` set, because Workers cannot
  open sockets to Cloudflare's own edge IPs directly.
