// server.js — Express API for Vercel
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import prisma from './src/db/prisma.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

// ---------- local static (Vercel serves /public via vercel.json) ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'public')));

// ---------- health ----------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: Date.now(), env: process.env.NODE_ENV || 'dev' });
});

// ---------- Faculty list + search ----------
app.get('/api/faculty', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const department = (req.query.department || '').trim();
    const college = (req.query.college || '').trim();
    const take = Math.min(parseInt(req.query.limit || '50', 10), 100);

    const where = {};
    if (q) {
      where.OR = [
        { fullName: { contains: q, mode: 'insensitive' } },
        { department: { contains: q, mode: 'insensitive' } },
        { college: { contains: q, mode: 'insensitive' } }
      ];
    }
    if (department) where.department = { contains: department, mode: 'insensitive' };
    if (college) where.college = { contains: college, mode: 'insensitive' };

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
  } catch (e) {
    next(e);
  }
});

// ---------- Publications for a faculty ----------
app.get('/api/faculty/:id/publications', async (req, res, next) => {
  try {
    const facultyId = req.params.id;
    if (!facultyId) return res.status(400).json({ ok: false, error: 'Missing faculty id' });

    const yearFrom = req.query.yearFrom ? parseInt(req.query.yearFrom, 10) : undefined;
    const yearTo = req.query.yearTo ? parseInt(req.query.yearTo, 10) : undefined;
    const take = Math.min(parseInt(req.query.limit || '100', 10), 200);

    const where = { facultyId };
    if (yearFrom || yearTo) {
      where.year = {};
      if (!Number.isNaN(yearFrom)) where.year.gte = yearFrom;
      if (!Number.isNaN(yearTo)) where.year.lte = yearTo;
    }

    const pubs = await prisma.publication.findMany({
      where,
      orderBy: { year: 'desc' },
      take
    });

    res.json({ ok: true, data: pubs });
  } catch (e) {
    next(e);
  }
});

// ---------- Department summary ----------
app.get('/api/admin/summary', async (req, res, next) => {
  try {
    const department = (req.query.department || '').trim();
    if (!department)
      return res.status(400).json({ ok: false, error: 'department is required' });

    const faculty = await prisma.faculty.findMany({
      where: { department },
      include: {
        metrics: true,
        publications: { select: { year: true } }
      }
    });

    const totalFaculty = faculty.length;
    const totalPublications = faculty.reduce(
      (s, f) => s + (f.metrics?.totalPublications || 0),
      0
    );
    const totalCitations = faculty.reduce(
      (s, f) => s + (f.metrics?.totalCitations || 0),
      0
    );
    const avgHIndex = totalFaculty
      ? faculty.reduce((s, f) => s + (f.metrics?.hIndex || 0), 0) / totalFaculty
      : 0;

    const pubsByYear = {};
    for (const f of faculty) {
      for (const p of f.publications) {
        pubsByYear[p.year] = (pubsByYear[p.year] || 0) + 1;
      }
    }

    res.json({
      ok: true,
      data: {
        department,
        totalFaculty,
        totalPublications,
        totalCitations,
        avgHIndex,
        publicationsByYear: pubsByYear
      }
    });
  } catch (e) {
    next(e);
  }
});

// ---------- Author publications (UI expects this) ----------
app.post('/api/authorPublications', async (req, res, next) => {
  try {
    const name = (req.body?.name || '').trim();
    const affiliation = (req.body?.affiliation || '').trim();
    const department = (req.body?.department || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'name is required' });

    const where = { fullName: { equals: name, mode: 'insensitive' } };
    if (affiliation)
      where.college = { contains: affiliation, mode: 'insensitive' };
    if (department)
      where.department = { contains: department, mode: 'insensitive' };

    let faculty = await prisma.faculty.findFirst({
      where,
      include: { metrics: true }
    });

    if (!faculty) {
      const relaxed = {
        OR: [
          { fullName: { contains: name, mode: 'insensitive' } },
          department ? { department: { contains: department, mode: 'insensitive' } } : null,
          affiliation ? { college: { contains: affiliation, mode: 'insensitive' } } : null
        ].filter(Boolean)
      };
      faculty = await prisma.faculty.findFirst({
        where: relaxed,
        orderBy: { fullName: 'asc' },
        include: { metrics: true }
      });
    }

    if (!faculty)
      return res.json({ ok: true, publications: [], metrics: null, faculty: null });

    const publications = await prisma.publication.findMany({
      where: { facultyId: faculty.id },
      orderBy: { year: 'desc' },
      take: 200
    });

    return res.json({
      ok: true,
      publications,
      metrics: faculty.metrics ?? null,
      faculty: {
        id: faculty.id,
        fullName: faculty.fullName,
        department: faculty.department,
        college: faculty.college
      }
    });
  } catch (e) {
    next(e);
  }
});

// ---------- Query (web search + optional Gemini summary) ----------
app.post('/api/query', async (req, res, next) => {
  try {
    const q = (req.body?.query || '').trim();
    if (!q) return res.status(400).json({ ok: false, error: 'query is required' });

    const items = [];
    const serperKey = process.env.SERPER_API_KEY || '';

    if (serperKey) {
      const r = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: {
          'X-API-KEY': serperKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ q, num: 10, gl: 'in' })
      });
      if (r.ok) {
        const j = await r.json();
        const organic = Array.isArray(j.organic) ? j.organic : [];
        for (const it of organic) {
          items.push({
            title: it.title || '',
            snippet: it.snippet || '',
            link: it.link || it.url || '',
            source: (() => {
              try {
                return new URL(it.link || it.url || '').hostname;
              } catch {
                return 'web';
              }
            })()
          });
        }
      }
    }

    // Optional Gemini summary
    let summary = '';
    const geminiKey = process.env.GOOGLE_API_KEY || '';
    if (geminiKey && items.length) {
      try {
        const { GoogleGenerativeAI } = await import('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(geminiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const prompt =
          `Summarize these results for query "${q}" in under 120 words:\n\n` +
          items.map((it, i) => `- [${i + 1}] ${it.title} — ${it.snippet}`).join('\n');
        const resp = await model.generateContent(prompt);
        summary = resp?.response?.text?.() ?? '';
      } catch (err) {
        console.warn('Gemini summarization failed:', err?.message || err);
      }
    }

    res.json({ ok: true, items, summary });
  } catch (e) {
    next(e);
  }
});

// ---------- Error handler ----------
app.use((err, req, res, next) => {
  console.error('API error:', err);
  res
    .status(500)
    .json({ ok: false, error: err?.message || 'Internal Server Error' });
});

// ---------- Root route for local dev ----------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

export default app;

if (process.env.VERCEL !== '1' && process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () =>
    console.log(`Local: http://localhost:${PORT}`)
  );
}
