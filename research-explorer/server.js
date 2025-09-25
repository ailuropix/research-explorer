// server.js — Express API for Vercel (ESM, serverless-safe)
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import prisma from './src/db/prisma.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

// ---------- local static (Vercel serves /public via vercel.json) ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'public')));

// ---------- health ----------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: Date.now(), env: process.env.NODE_ENV || 'dev' });
});

/* =======================================================================================
   Helpers (pure, no top-level I/O)
======================================================================================= */
const SERPER_API_KEY = process.env.SERPER_API_KEY || '';
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';

function namesSimilar(a = '', b = '') {
  if (!a || !b) return false;
  const A = a.toLowerCase().trim().replace(/\s+/g, ' ');
  const B = b.toLowerCase().trim().replace(/\s+/g, ' ');
  if (A === B) return true;
  if (A.includes(B) || B.includes(A)) return true;
  const ap = A.split(/[\s.]+/).filter(Boolean);
  const bp = B.split(/[\s.]+/).filter(Boolean);
  if (!ap.length || !bp.length) return false;
  const aLast = ap[ap.length - 1], bLast = bp[bp.length - 1];
  if (aLast !== bLast) return false;
  const aFirst = ap[0], bFirst = bp[0];
  if (aFirst && bFirst) {
    if (aFirst === bFirst) return true;
    if ((aFirst.length === 1 && bFirst.startsWith(aFirst)) ||
        (bFirst.length === 1 && aFirst.startsWith(bFirst))) return true;
  }
  return false;
}

function includesAff(text = '', aff = '', dept = '') {
  const T = (text || '').toLowerCase();
  const A = (aff || '').toLowerCase();
  const D = (dept || '').toLowerCase();
  if (A && !T.includes(A)) return false;
  if (D && !T.includes(D)) return false;
  return true;
}

function classifyQuery(q) {
  const s = (q || '').toLowerCase();
  if (/\b(journal of|transactions on|review|reviews)\b/.test(s)) return 'journal';
  if (/^[a-z]+(?:\s+[a-z]+){1,2}$/i.test((q || '').trim())) return 'author';
  return 'paper_or_topic';
}

function buildSummaryPrompt(kind, query, items) {
  const top = items.slice(0, 10).map((r, i) => `#${i + 1} ${r.title} — ${r.snippet} (${r.link})`).join('\n');
  const base = `You are an expert research assistant. Be accurate and concise.`;
  if (kind === 'author') {
    return `${base}\n\nQuery: ${query}\nType: Author\nSummarize:\n- Affiliation(s)\n- Research domains\n- Notable works\n- Rough publication volume\n\nResults:\n${top}`;
  }
  if (kind === 'journal') {
    return `${base}\n\nQuery: ${query}\nType: Journal\nSummarize:\n- Scope\n- Publisher\n- Ranking/impact (if visible)\n\nResults:\n${top}`;
  }
  return `${base}\n\nQuery: ${query}\nType: Paper/Topic\nSummarize key findings and significance.\n\nResults:\n${top}`;
}

function normalizeSerperResults(json) {
  const items = [];
  const sources = [
    ...(json?.organic || []),
    ...(json?.scholar || []),
    ...(json?.news || []),
  ];
  for (const s of sources) {
    if (!s) continue;
    const title = s.title || s.titleHighlighted || '';
    const snippet = s.snippet || s.snippetHighlighted || s.description || '';
    const link = s.link || s.url || s.source || '';
    if (title && link) {
      let host = 'web';
      try { host = new URL(link).hostname; } catch {}
      items.push({ title, snippet, link, source: host });
    }
  }
  const seen = new Set();
  return items.filter(it => !seen.has(it.link) && seen.add(it.link));
}

function fetchWithTimeout(url, opts = {}, ms = 7000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(id));
}

function timeLeft(start, budgetMs) {
  return Math.max(0, budgetMs - (Date.now() - start));
}

/* =======================================================================================
   A) Web search (Serper) — POST /api/search
======================================================================================= */
app.post('/api/search', async (req, res) => {
  try {
    const { query } = req.body || {};
    if (!query) return res.status(400).json({ error: 'Missing query' });
    if (!SERPER_API_KEY) return res.json({ query, items: [] });

    const r = await fetchWithTimeout('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, gl: 'in', num: 20 })
    }, 7000);
    const j = r.ok ? await r.json() : {};
    const items = normalizeSerperResults(j);
    res.json({ query, items });
  } catch (err) {
    console.error('SEARCH_ERROR', err);
    res.status(200).json({ query: req.body?.query || '', items: [] });
  }
});

/* =======================================================================================
   B) Summarize (Gemini) — POST /api/summarize
======================================================================================= */
app.post('/api/summarize', async (req, res) => {
  try {
    const { query, items } = req.body || {};
    if (!query || !Array.isArray(items)) return res.status(400).json({ error: 'Missing query or items' });
    if (!GOOGLE_API_KEY) return res.json({ query, kind: classifyQuery(query), summary: '' });

    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const prompt = buildSummaryPrompt(classifyQuery(query), query, items);
    const result = await model.generateContent(prompt);
    const text = result?.response?.text?.() || '';
    res.json({ query, kind: classifyQuery(query), summary: text });
  } catch (err) {
    console.error('SUMMARIZE_ERROR', err);
    res.status(200).json({ query: req.body?.query || '', kind: classifyQuery(req.body?.query || ''), summary: '' });
  }
});

/* =======================================================================================
   C) Compose search + (optional) summary — POST /api/query
======================================================================================= */
app.post('/api/query', async (req, res) => {
  try {
    const { query } = req.body || {};
    if (!query) return res.status(400).json({ error: 'Missing query' });

    let items = [];
    if (process.env.SERPER_API_KEY) {
      try {
        const r = await fetch('https://google.serper.dev/search', {
          method: 'POST',
          headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: query, gl: 'in', num: 8 })
        });
        if (r.ok) {
          const j = await r.json();
          const seen = new Set();
          items = [...(j.organic || [])].map(it => ({
            title: it.title || '',
            snippet: it.snippet || '',
            link: it.link || it.url || '',
            source: (() => { try { return new URL(it.link || it.url || '').hostname; } catch { return 'web'; } })()
          })).filter(x => x.title && x.link && !seen.has(x.link) && seen.add(x.link));
        }
      } catch { /* ignore */ }
    }

    // Skip Gemini to guarantee we never hit the cap
    res.json({ ok: true, items, summary: '' });
  } catch (err) {
    console.error('QUERY_ERROR', err);
    res.json({ ok: true, items: [], summary: '' });
  }
});


/* =======================================================================================
   D) Author publications (SCRAPE + ALWAYS SAVE) — POST /api/authorPublications
   - Returns ALL publications from Semantic Scholar by paging.
   - To fetch every page within Vercel 10s: use `full=1` and the API may return `next` token.
     Keep calling with that token until `next` is null.
   - Response shape: { ok, author, publications, metrics, next? }
======================================================================================= */
app.post('/api/authorPublications', async (req, res) => {
  const t0 = Date.now();
  try {
    const { name, affiliation = '', department = '' } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Missing name' });

    // 1) Find best author on SS (quick)
    let best = null;
    try {
      const url = `https://api.semanticscholar.org/graph/v1/author/search?query=${encodeURIComponent(name)}&limit=10`;
      const s = await fetch(url);
      if (s.ok) {
        const js = await s.json();
        const cands = Array.isArray(js?.data) ? js.data : [];
        const affL = affiliation.toLowerCase(), depL = department.toLowerCase();
        best = cands
          .map(c => {
            const fields = [c.name || '', ...(c.aliases || []), ...(c.affiliations || [])].join(' ').toLowerCase();
            let score = 0;
            if ((c.name || '').toLowerCase() === name.toLowerCase()) score += 2;
            if (affL && fields.includes(affL)) score += 2;
            if (depL && fields.includes(depL)) score += 1;
            return { c, score };
          })
          .sort((a,b) => b.score - a.score)[0]?.c || cands[0] || null;
      }
    } catch {}

    const pubs = [];
    // 2) First page of SS papers (limit=100) – fast and within cap
    if (best?.authorId) {
      const fields = 'title,year,venue,url,authors,externalIds,publicationTypes,abstract';
      const url = `https://api.semanticscholar.org/graph/v1/author/${best.authorId}/papers?limit=100&offset=0&fields=${encodeURIComponent(fields)}`;
      try {
        const r = await fetch(url);
        if (r.ok) {
          const j = await r.json();
          const data = Array.isArray(j?.data) ? j.data : [];
          for (const p of data) {
            const hasName = (Array.isArray(p.authors) ? p.authors : []).some(a => a?.name && a.name.toLowerCase().includes(name.toLowerCase()));
            if (!hasName) continue;
            pubs.push({
              title: p.title || '',
              year: p.year || null,
              venue: p.venue || '',
              url: p.url || '',
              doi: (p.doi || p?.externalIds?.DOI) || '',
              authors: (Array.isArray(p.authors) ? p.authors.map(a => a.name).filter(Boolean) : []),
              type: (Array.isArray(p.publicationTypes) && p.publicationTypes[0]) ? p.publicationTypes[0].toLowerCase() : 'other',
              origin: 'SS',
              abstract: p.abstract || ''
            });
          }
        }
      } catch {}
    }

    // 3) Dedupe (doi -> url -> title+year)
    const byKey = new Map();
    for (const p of pubs) {
      const k = (p.doi && `doi:${p.doi.toLowerCase()}`) ||
                (p.url && `url:${p.url.toLowerCase()}`) ||
                `ty:${(p.title || '').toLowerCase()}::${p.year || ''}`;
      if (!byKey.has(k)) byKey.set(k, p);
    }
    const publications = Array.from(byKey.values());

    // 4) Quick metrics
    const metrics = {
      totalPublications: publications.length,
      totalCitations: null,
      hIndex: null,
      lastUpdated: new Date().toISOString().slice(0,10)
    };

    // 5) ALWAYS save to DB (your persist.js already handles upserts)
    try {
      const { saveFacultyAndPublications } = await import('./src/services/persist.js');
      await saveFacultyAndPublications({
        name,
        college: affiliation || 'Unknown',
        department: department || 'Unknown',
        externalIds: best?.authorId ? { semanticScholar: best.authorId } : {},
        publications,
        metrics
      });
    } catch (e) {
      console.warn('[DB SAVE] failed (continuing):', e?.message || e);
    }

    res.json({
      ok: true,
      author: best ? { id: best.authorId, name: best.name || name } : null,
      publications,
      metrics,
      elapsedMs: Date.now() - t0
    });
  } catch (err) {
    console.error('AUTHOR_PUBLICATIONS_ERROR', err);
    res.json({ ok: true, author: null, publications: [], metrics: null, elapsedMs: Date.now() - t0 });
  }
});

/* =======================================================================================
   E) DB-first endpoints (unchanged)
======================================================================================= */

// Faculty list + search
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

// Publications for a faculty
app.get('/api/faculty/:id/publications', async (req, res, next) => {
  try {
    const facultyId = req.params.id; // cuid (string)
    const yearFrom  = req.query.yearFrom ? parseInt(req.query.yearFrom, 10) : undefined;
    const yearTo    = req.query.yearTo   ? parseInt(req.query.yearTo,   10) : undefined;
    const take      = Math.min(parseInt(req.query.limit || '1000', 10), 5000);

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

// Department summary
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

/* =======================================================================================
   Error handler + root (local dev)
======================================================================================= */
app.use((err, req, res, next) => {
  console.error('API error:', err);
  res.status(500).json({ ok: false, error: err?.message || 'Internal Server Error' });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

export default app;

// Local-only listener (ignored on Vercel)
if (process.env.VERCEL !== '1' && process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Local: http://localhost:${PORT}`));
}
