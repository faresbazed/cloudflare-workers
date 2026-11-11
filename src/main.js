// Entry point. All configuration comes from the environment:
//   K (required, secret) accepted id(s), comma-separated
//   R (optional) fallback relay host for edge-hosted destinations
//   N (optional) DNS-over-HTTPS endpoint for UDP/53

import { ID_RE } from './proto.js';
import { openSession } from './session.js';
import { statusPage, infoPage } from './pages.js';

export default {
  async fetch(request, env) {
    const ids = configuredIds(env);
    if (ids.size === 0) return statusPage();

    const url = new URL(request.url);
    if ((request.headers.get('Upgrade') || '').toLowerCase() === 'websocket') {
      return openSession(request, ids, env);
    }

    const first = url.pathname.split('/').filter(Boolean)[0];
    if (first && ids.has(first.toLowerCase())) {
      return infoPage(first.toLowerCase(), url.host);
    }
    return statusPage(url.pathname === '/' || url.pathname === '/index.html' ? 200 : 404);
  },
};

function configuredIds(env) {
  const set = new Set();
  for (const v of String(env.K || '').split(',')) {
    const id = v.trim().toLowerCase();
    if (ID_RE.test(id)) set.add(id);
  }
  return set;
}
