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
   (kept fast to avoid 504s)
======================================================================================= */
app.post('/api/query', async (req, res) => {
  try {
    const { query } = req.body || {};
    if (!query) return res.status(400).json({ error: 'Missing query' });

    let items = [];
    if (SERPER_API_KEY) {
      const r = await fetchWithTimeout('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, gl: 'in', num: 8 })
      }, 7000);
      if (r.ok) {
        const j = await r.json();
        const seen = new Set();
        items = (j.organic || [])
          .map(it => ({
            title: it.title || '',
            snippet: it.snippet || '',
            link: it.link || it.url || '',
            source: (() => { try { return new URL(it.link || it.url || '').hostname; } catch { return 'web'; } })()
          }))
          .filter(x => x.title && x.link && !seen.has(x.link) && seen.add(x.link));
      }
    }

    res.json({ ok: true, items, summary: '' });
  } catch (err) {
    console.error('QUERY_ERROR', err);
    res.json({ ok: true, items: [], summary: '' });
  }
});

/* =======================================================================================
   D) Author publications — OpenAlex ONLY (scrape + ALWAYS SAVE + continuation tokens)
   Request body:
     { name, affiliation?, department?, next? }  // next = { oaCursor: "..." } from previous response
   Response:
     { ok, source:"openalex", author, publications:[...], metrics, next? }
======================================================================================= */
// ===== /api/authorPublications — OpenAlex-only (faster budget + soft cap) =====
app.post('/api/authorPublications', async (req, res) => {
  const started = Date.now();
  const BUDGET_MS = 6500;   // tighter: stay well under Vercel's 10s
  const WORKS_PAGE = 100;   // smaller page => quicker response
  const DEFAULT_LIMIT = 300; // soft cap on pubs per invocation

  const timeLeft = () => Math.max(0, BUDGET_MS - (Date.now() - started));
  const fetchWithTimeout = (url, opts = {}, ms = 4000) => {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), Math.min(ms, timeLeft()));
    return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(id));
  };
  const namesSimilar = (a = '', b = '') => {
    const A = a.toLowerCase().trim().replace(/\s+/g, ' ');
    const B = b.toLowerCase().trim().replace(/\s+/g, ' ');
    if (!A || !B) return false;
    if (A === B || A.includes(B) || B.includes(A)) return true;
    const ap = A.split(/\s+/), bp = B.split(/\s+/);
    const aLast = ap[ap.length-1], bLast = bp[bp.length-1];
    if (aLast !== bLast) return false;
    const aFirst = ap[0], bFirst = bp[0];
    if (aFirst === bFirst) return true;
    if ((aFirst.length === 1 && bFirst.startsWith(aFirst)) || (bFirst.length === 1 && aFirst.startsWith(bFirst))) return true;
    return false;
  };

  try {
    const { name, affiliation = '', department = '', next, limit } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Missing name' });
    const MAX_PUBS = Math.max(50, Math.min(Number(limit) || DEFAULT_LIMIT, 1000)); // safety bounds

    // 1) Find best author in OpenAlex (quick)
    let author = null;
    try {
      const aURL = new URL('https://api.openalex.org/authors');
      aURL.searchParams.set('search', name);
      aURL.searchParams.set('per-page', '12'); // smaller candidate set for speed

      const aResp = await fetchWithTimeout(aURL.toString(), {}, 3000);
      if (aResp.ok) {
        const aJson = await aResp.json();
        const cands = Array.isArray(aJson?.results) ? aJson.results : [];
        const affL = affiliation.toLowerCase();
        const depL = department.toLowerCase();

        let best = null, bestScore = -1;
        for (const c of cands) {
          const nm = (c.display_name || '').toLowerCase();
          const inst = (c.last_known_institution?.display_name || '').toLowerCase();
          let s = 0;
          if (nm === name.toLowerCase()) s += 2;
          if (affL && inst.includes(affL)) s += 2;
          if (depL && inst.includes(depL)) s += 1;
          if (s > bestScore) { bestScore = s; best = c; }
        }
        author = best || cands[0] || null;
      }
    } catch (e) {
      console.warn('[OA] author search failed:', e?.message || e);
    }

    if (!author) {
      return res.json({ ok: true, source: 'openalex', author: null, publications: [], metrics: null, next: null });
    }

    // 2) Works with cursor pagination (resume via next.oaCursor if provided) — stop early if we hit MAX_PUBS or budget
    const orcid = author?.orcid?.replace('https://orcid.org/', '') || '';
    const pubs = [];
    let cursor = (next && next.oaCursor) ? next.oaCursor : '*';
    let lastCursorUsed = cursor;

    try {
      while (timeLeft() > 1000 && cursor && pubs.length < MAX_PUBS) {
        const wURL = new URL('https://api.openalex.org/works');
        wURL.searchParams.set('per-page', String(WORKS_PAGE));
        wURL.searchParams.set('cursor', cursor);
        if (orcid) wURL.searchParams.set('filter', `author.orcid:${orcid}`);
        else       wURL.searchParams.set('filter', `author.display_name:${name}`);

        const wResp = await fetchWithTimeout(wURL.toString(), {}, 3000);
        if (!wResp.ok) break;

        const wj = await wResp.json();
        const batch = Array.isArray(wj?.results) ? wj.results : [];
        for (const w of batch) {
          if (pubs.length >= MAX_PUBS) break;
          const auths = w.authorships || [];
          const nameOk = orcid
            ? auths.some(a => a?.author?.orcid && a.author.orcid.endsWith(orcid))
            : auths.some(a => namesSimilar(a?.author?.display_name || '', name));
          if (!nameOk) continue;

          pubs.push({
            title: w.title || '',
            year: w.publication_year || null,
            venue: w.host_venue?.display_name || '',
            url: w.primary_location?.landing_page_url || (w.doi ? `https://doi.org/${w.doi}` : ''),
            doi: w.doi || '',
            authors: auths.map(a => a.author?.display_name).filter(Boolean),
            type: (w.type || 'other').toLowerCase(),
            origin: 'OA',
            abstract: ''
          });
        }

        lastCursorUsed = cursor;
        cursor = wj?.meta?.next_cursor || null;

        if (!cursor || batch.length < WORKS_PAGE) break;           // natural end
        if (pubs.length >= MAX_PUBS) break;                        // hit soft cap
      }
    } catch (e) {
      console.warn('[OA] works pagination failed:', e?.message || e);
    }

    // 3) Dedupe quickly: doi -> url -> title+year
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

    // 5) ALWAYS save to DB
    try {
      const { saveFacultyAndPublications } = await import('./src/services/persist.js');
      await saveFacultyAndPublications({
        name,
        college: affiliation || 'Unknown',
        department: department || 'Unknown',
        externalIds: author?.id
          ? { openAlex: author.id, ...(orcid ? { orcid } : {}) }
          : (orcid ? { orcid } : {}),
        publications,
        metrics
      });
    } catch (e) {
      console.warn('[DB SAVE] failed (continuing):', e?.message || e);
    }

    // 6) Continuation token: if more pages remain (cursor present) return it so UI can keep going
    // Only return a next token if we either ran out of budget or hit MAX_PUBS
    let nextToken = null;
    if (cursor && (timeLeft() < 900 || publications.length >= MAX_PUBS)) {
      nextToken = { oaCursor: cursor };
    }

    res.json({
      ok: true,
      source: 'openalex',
      author: {
        id: author?.id || null,
        name: author?.display_name || name,
        orcid: orcid || null,
        institution: author?.last_known_institution?.display_name || null
      },
      publications,
      metrics,
      next: nextToken
    });
  } catch (err) {
    console.error('AUTHOR_PUBLICATIONS_OA_ERROR', err);
    res.json({ ok: true, source: 'openalex', author: null, publications: [], metrics: null, next: null });
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
