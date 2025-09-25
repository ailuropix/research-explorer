// server.js — minimal boot to isolate timeouts
import express from 'express';

const app = express();
app.use(express.json());

// early probe route (should return instantly)
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: Date.now(), env: process.env.NODE_ENV || 'dev' });
});

// keep also a ping here for redundancy
app.get('/api/ping', (req, res) => {
  res.json({ pong: true, ts: Date.now() });
});

// DO NOT import prisma, gemini, serper, or any other module here yet.

export default app;

if (process.env.VERCEL !== '1' && process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running locally at http://localhost:${PORT}`);
  });
}
