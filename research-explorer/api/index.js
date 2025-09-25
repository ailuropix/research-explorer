import serverless from 'serverless-http';

let cachedHandler = null;
let cachedError = null;

export default async function handler(req, res) {
  if (cachedError) {
    return res
      .status(500)
      .json({ ok: false, error: cachedError.message || String(cachedError) });
  }
  try {
    if (!cachedHandler) {
      const mod = await import('../server.js');
      const app = mod.default || mod.app || mod;
      cachedHandler = serverless(app);
    }
    return cachedHandler(req, res);
  } catch (err) {
    cachedError = err;
    return res
      .status(500)
      .json({ ok: false, error: err.message || String(err) });
  }
}
