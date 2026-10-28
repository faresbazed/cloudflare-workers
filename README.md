VLESS Cloudflare Worker Node (WS + TLS 443)
A lightweight, serverless VLESS over WebSocket + TLS (Port 443) node designed to run on Cloudflare Workers using the native ⁠cloudflare:sockets⁠ TCP outbound API.
Architecture Comparison: ⁠cloudflared⁠ vs. VLESS Worker
Feature
cloudflared (Cloudflare Tunnel)
VLESS Cloudflare Worker (worker.js)
Execution Environment
Self-hosted daemon on your own server/machine
Serverless JavaScript V8 isolate on Cloudflare's edge
Primary Direction
Inbound reverse tunnel (exposes local services to Cloudflare) or Zero Trust WARP
Outbound proxy tunnel (accepts VLESS over WebSocket on port 443 and opens outbound TCP sockets via cloudflare:sockets)
Transport & Security
QUIC / HTTP/2 tunnel to Cloudflare edge
WebSocket (ws) encapsulated in Cloudflare Edge TLS on port 443
UDP Support
Full UDP via WARP / QUIC
TCP outbound + DNS-over-HTTPS (UDP port 53)

Repository Structure
￼ ⁠worker.js⁠ — Complete ES Module Cloudflare Worker implementing VLESS header parsing, WebSocket 0-RTT early data (⁠/?ed=2048⁠), TCP socket bridging via ⁠cloudflare:sockets⁠, and DoH DNS resolution.
￼ ⁠wrangler.toml⁠ — Cloudflare Wrangler configuration file for one-command CLI or GitHub Actions deployment.
￼ ⁠README.md⁠ — Setup, deployment, and client configuration guide.
Quick Start & Deployment
Method 1: Deploy with Wrangler CLI (Recommended for GitHub Repos)
Method 2: Deploy via Cloudflare Dashboard
1. Log in to the Cloudflare Dashboard and navigate to Workers & Pages -> Create Worker.
2. Paste the contents of ⁠worker.js⁠ into the online editor and click Deploy.
3. Go to Settings -> Variables and Secrets and add:
￼ ⁠UUID⁠: Your generated UUID v4 string.
￼ ⁠PROXYIP⁠ (optional): A fallback IP or hostname for Cloudflare-hosted targets.
4. (Recommended) Under Settings -> Domains & Routes, attach a Custom Domain so TLS certificates and port ⁠443⁠ routing are automatically provisioned on your domain.
Client Connection Details (WS + TLS 443)
Once deployed, visit ⁠https://<your-worker-domain>/<your-uuid>⁠ in a browser to retrieve your ready-to-import ⁠vless://⁠ URI, or configure your VLESS client (v2rayN, Nekoray, Streisand, v2rayNG, Sing-box, or Clash Meta/Mihomo) with:
Parameter
Value
Protocol
VLESS
Address / Server
your-custom-domain.com (or any clean Cloudflare edge IP)
Port
443
UUID
Your configured UUID
Encryption
none
Transport (Network)
ws (WebSocket)
WebSocket Host
your-custom-domain.com
WebSocket Path
/?ed=2048
TLS
tls (Enabled)
SNI
your-custom-domain.com
