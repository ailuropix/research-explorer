// public/api-bridge.js
// Rewrites legacy frontend calls like "/faculty" → "/api/faculty"
// so you don't have to touch public/app.js. Also guards against HTML responses.

(() => {
    const _fetch = window.fetch.bind(window);
  
    const mapPath = (url) => {
      try {
        const u = new URL(url, location.origin);
        // Only rewrite same-origin calls
        if (u.origin !== location.origin) return url;
  
        // Already /api → leave as-is
        if (u.pathname.startsWith('/api/')) return url;
  
        // Legacy endpoints to map
        const legacy = [
          '/faculty',
          '/authorPublications',
          '/search',
          '/summarize',
          '/query',
          '/admin/summary'
        ];
  
        for (const base of legacy) {
          if (u.pathname === base || u.pathname.startsWith(base + '/')) {
            u.pathname = '/api' + u.pathname;
            return u.toString();
          }
        }
        return url;
      } catch {
        return url;
      }
    };
  
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const rewritten = mapPath(url);
      const res = await _fetch(rewritten, init);
  
      // If it's an API call, ensure JSON to avoid "Unexpected token <"
      const isApi = rewritten.startsWith('/api/') || rewritten.includes('/api/');
      if (isApi) {
        const ct = res.headers.get('content-type') || '';
        // Clone by reading text once; callers can parse JSON from returned text if needed
        const text = await res.text();
        if (!ct.includes('application/json')) {
          throw new Error(`Expected JSON from ${rewritten} but got "${ct}". Body: ${text.slice(0, 200)}...`);
        }
        // Create a Response-like object with .ok and parsed JSON
        const data = JSON.parse(text);
        // Return a minimal facade so existing code calling res.json() still works if it does
        return {
          ok: res.ok,
          status: res.status,
          headers: res.headers,
          json: async () => data,
          text: async () => text
        };
      }
      return res;
    };
  })();
  