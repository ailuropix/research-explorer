// server.js — minimal, fast import (no top-level I/O)
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import prisma from './src/db/prisma.js'; // singleton (no $connect here)

const app = express();
app.use(express.json());

// ---------- local static (Vercel serves /public via vercel.json) ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'public')));

// ---------- quick health (also routed by api/health.js) ----------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: Date.now(), env: process.env.NODE_ENV || 'dev' });
});

// ---------- Faculty list + search ----------
app.get('/api/faculty', async (req, res, next) => {
  try {
    const q          = (req.query.q || '').trim();
    const department = (req.query.department || '').trim();
    const college    = (req.query.college || '').trim();
    const take       = Math.min(parseInt(req.query.limit || '50', 10), 100);

    const where = {};
    if (q) {
      where.OR = [
        { fullName:   { contains: q, mode: 'insensitive' } },
        { department: { contains: q, mode: 'insensitive' } },
        { college:    { contains: q, mode: 'insensitive' } }
      ];
    }
    if (department) where.department = { contains: department, mode: 'insensitive' };
    if (college)    where.college    = { contains: college,    mode: 'insensitive' };

    const rows = await prisma.faculty.findMany({
      where,
      include: {
        metrics: true,
        _count: { select: { publications: true } }
      },
      orderBy: { fullName: 'asc' },
      take
    });

    res.json({ ok: true, data: rows });
  } catch (e) { next(e); }
});

// ---------- Publications for a faculty ----------
app.get('/api/faculty/:id/publications', async (req, res, next) => {
  try {
    const facultyId = req.params.id; // String cuid
    if (!facultyId) return res.status(400).json({ ok: false, error: 'Missing faculty id' });

    const yearFrom = req.query.yearFrom ? parseInt(req.query.yearFrom, 10) : undefined;
    const yearTo   = req.query.yearTo   ? parseInt(req.query.yearTo,   10) : undefined;
    const take     = Math.min(parseInt(req.query.limit || '100', 10), 200);

    const where = { facultyId };
    if (yearFrom || yearTo) {
      where.year = {};
      if (!Number.isNaN(yearFrom)) where.year.gte = yearFrom;
      if (!Number.isNaN(yearTo))   where.year.lte = yearTo;
    }

    const pubs = await prisma.publication.findMany({
      where,
      orderBy: { year: 'desc' },
      take
    });

    res.json({ ok: true, data: pubs });
  } catch (e) { next(e); }
});

// ---------- Optional: department summary ----------
app.get('/api/admin/summary', async (req, res, next) => {
  try {
    const department = (req.query.department || '').trim();
    if (!department) return res.status(400).json({ ok: false, error: 'department is required' });

    const faculty = await prisma.faculty.findMany({
      where: { department },
      include: {
        metrics: true,
        publications: { select: { year: true } }
      }
    });

    const totalFaculty      = faculty.length;
    const totalPublications = faculty.reduce((s, f) => s + (f.metrics?.totalPublications || 0), 0);
    const totalCitations    = faculty.reduce((s, f) => s + (f.metrics?.totalCitations   || 0), 0);
    const avgHIndex         = totalFaculty
      ? faculty.reduce((s, f) => s + (f.metrics?.hIndex || 0), 0) / totalFaculty
      : 0;

    const pubsByYear = {};
    for (const f of faculty) for (const p of f.publications) {
      pubsByYear[p.year] = (pubsByYear[p.year] || 0) + 1;
    }

    res.json({
      ok: true,
      data: { department, totalFaculty, totalPublications, totalCitations, avgHIndex, publicationsByYear: pubsByYear }
    });
  } catch (e) { next(e); }
});

// ---------- Global error handler ----------
app.use((err, req, res, next) => {
  console.error('API error:', err);
  res.status(500).json({ ok: false, error: err?.message || 'Internal Server Error' });
});

// ---------- Root route for local dev ----------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

export default app;

// local-only listener
if (process.env.VERCEL !== '1' && process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Local: http://localhost:${PORT}`));
}
