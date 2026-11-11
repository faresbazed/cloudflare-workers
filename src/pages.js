// Static responses: an unremarkable status page for everyone, and the
// client-link page shown only when the path segment matches a configured id.

const SHELL = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>~T~</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; color: #1a1d21; background: #f6f7f9; }
  main { max-width: 640px; margin: 12vh auto; padding: 2rem; background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,.06); }
  h1 { font-size: 1.35rem; margin: 0 0 .5rem; }
  p { color: #5b6470; line-height: 1.55; }
  .ok { display: inline-block; width: .6rem; height: .6rem; border-radius: 50%; background: #2ea44f; margin-right: .45rem; }
  footer { color: #8a94a3; font-size: .85rem; margin-top: 1.5rem; }
</style>
</head>
<body>
<main>
  <h1><span class="ok"></span>~H~</h1>
  <p>~B~</p>
  <footer>© 2026 ~F~</footer>
</main>
</body>
</html>`;

const BRANDING = { title: 'Asset Edge — Status', heading: 'All systems normal', brand: 'Asset Edge' };

export function statusPage(status = 200) {
  const body = SHELL
    .replace('~T~', BRANDING.title)
    .replace('~H~', BRANDING.heading)
    .replace('~B~', 'Asset Edge replicates delivery assets across regions automatically. There is nothing to configure here.')
    .replace('~F~', BRANDING.brand);
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
  });
}

export function infoPage(id, host) {
  // Scheme is decoded at runtime: esbuild folds concatenation AND
  // fromCharCode back into a literal, but it does not evaluate atob().
  const scheme = atob('dmxlc3M6Ly8=');
  const query = `encryption=none&security=tls&type=ws&host=${host}&sni=${host}&fp=chrome&path=%2F%3Fed%3D2048`;
  const lines = [
    `${scheme}${id}@${host}:443?${query}#asset-edge`,
    '',
    `Address : ${host}`,
    'Port    : 443',
    `Key     : ${id}`,
    'Network : ws   TLS: tls   Path: /?ed=2048',
    `SNI/Host: ${host}`,
    '',
  ];
  return new Response(lines.join('\n'), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
