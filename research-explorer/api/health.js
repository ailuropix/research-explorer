// api/health.js
export default async function handler(req, res) {
    res.status(200).json({ ok: true, ts: Date.now(), env: process.env.NODE_ENV || 'preview' });
  }
  