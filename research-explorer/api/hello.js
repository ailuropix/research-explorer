function handler(req, res) {
    res.status(200).json({ ok: true, msg: 'hello from vercel' });
  }
  module.exports = handler;
  module.exports.config = { runtime: 'nodejs20.x' };
  