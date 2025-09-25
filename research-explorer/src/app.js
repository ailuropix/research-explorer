// src/app.js
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { prisma } from './db/prisma.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp() {
  const app = express();

  // Core middleware
  app.use(cors());
  app.use(express.json({ limit: '5mb' }));

  // (Local dev) serve your SPA assets from /public
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // --- Health check (verifies DB connectivity via pooled URL on Vercel) ---
  app.get('/api/health', async (_req, res) => {
    try {
      const [row] = await prisma.$queryRawUnsafe('select now()');
      res.status(200).json({ ok: true, now: row?.now });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // TODO: add your real API routes here (e.g., /api/search, /api/summarize)

  // (Local dev) SPA fallback to index.html
  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  return app;
}
