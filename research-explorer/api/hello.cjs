// api/hello.cjs
function handler(req, res) {
    res.status(200).json({ ok: true, flavor: 'cjs' });
  }
  module.exports = handler;
  module.exports.config = { runtime: 'nodejs20.x' };
  