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
    if (SERPER_API_KEY) {
      try {
        const r = await fetchWithTimeout('https://google.serper.dev/search', {
          method: 'POST',
          headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: query, gl: 'in', num: 12 })
        }, 7000);
        if (r.ok) {
          items = normalizeSerperResults(await r.json()).slice(0, 12);
        }
      } catch (e) {
        console.warn('[QUERY] serper timeout/err:', e?.name || e?.message || e);
      }
    }

    let summary = '';
    if (GOOGLE_API_KEY && items.length) {
      try {
        const { GoogleGenerativeAI } = await import('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const prompt = buildSummaryPrompt(classifyQuery(query), query, items);
        const summaryPromise = model.generateContent(prompt).then(r => r?.response?.text?.() || '');
        summary = await Promise.race([summaryPromise, new Promise(r => setTimeout(() => r(''), 2500))]);
      } catch (e) {
        console.warn('[QUERY] gemini err:', e?.message || e);
      }
    }

    res.json({ ok: true, items, summary });
  } catch (err) {
    console.error('QUERY_ERROR', err);
    res.status(200).json({ ok: true, items: [], summary: '' });
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
  const started = Date.now();
  const BUDGET_MS = 9000; // leave cushion for Vercel 10s cap

  try {
    const { name, affiliation = '', department = '', full = 0, next } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Missing name' });

    // --- 1) Pick best author on SS (one quick call) ---
    let best = null;
    try {
      const url = `https://api.semanticscholar.org/graph/v1/author/search?query=${encodeURIComponent(name)}&limit=10`;
      const sresp = await fetchWithTimeout(url, {}, Math.min(5000, timeLeft(started, BUDGET_MS)));
      if (sresp.ok) {
        const sjson = await sresp.json();
        const cands = Array.isArray(sjson?.data) ? sjson.data : [];
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
    } catch (e) {
      console.warn('[APUB] SS author search err:', e?.name || e?.message || e);
    }

    // No author → empty but still try Crossref/OpenAlex single page (best-effort)
    const ssAuthorId = best?.authorId || null;

    // --- 2) Gather publications ---
    const publications = [];
    let ssOffset = (next && typeof next.ssOffset === 'number') ? next.ssOffset : 0;
    const SS_PAGE = 100;

    // 2A) Semantic Scholar — page in a loop while time allows or until not full
    if (ssAuthorId) {
      const fields = 'title,year,venue,url,authors,externalIds,publicationTypes,abstract';
      const wantAll = String(full) === '1' || full === 1 || full === true;

      // loop while time left and either full requested or it's the first page
      while (timeLeft(started, BUDGET_MS) > 1500) {
        const pURL = `https://api.semanticscholar.org/graph/v1/author/${ssAuthorId}/papers?limit=${SS_PAGE}&offset=${ssOffset}&fields=${encodeURIComponent(fields)}`;
        let pageOK = false;
        try {
          const pResp = await fetchWithTimeout(pURL, {}, Math.min(4000, timeLeft(started, BUDGET_MS)));
          if (!pResp.ok) break;
          const pJson = await pResp.json();
          const data = Array.isArray(pJson?.data) ? pJson.data : [];
          pageOK = true;

          const mapped = data
            .filter(p => (Array.isArray(p.authors) ? p.authors : []).some(a => a?.name && namesSimilar(a.name, name)))
            .map(p => ({
              title: p.title || '',
              year: p.year || null,
              venue: p.venue || '',
              url: p.url || '',
              doi: (p.doi || p?.externalIds?.DOI) || '',
              authors: (Array.isArray(p.authors) ? p.authors.map(a => a.name).filter(Boolean) : []),
              type: (Array.isArray(p.publicationTypes) && p.publicationTypes[0]) ? p.publicationTypes[0].toLowerCase() : 'other',
              origin: 'SS',
              abstract: p.abstract || ''
            }))
            .filter(p => p.title);

          publications.push(...mapped);

          // if fewer than page size, we're done
          if (data.length < SS_PAGE) { ssOffset += data.length; break; }

          ssOffset += SS_PAGE;
          if (!wantAll) break; // first page only when not full
        } catch (e) {
          console.warn('[APUB] SS page err:', e?.name || e?.message || e);
          break;
        }
        if (!pageOK) break;
      }
    }

    // 2B) Crossref — one page for enrichment (best effort)
    let crItems = [];
    try {
      const cr = new URL('https://api.crossref.org/works');
      cr.searchParams.set('query.author', name);
      const affStr = [affiliation, department].filter(Boolean).join(' ');
      if (affStr) cr.searchParams.set('query.affiliation', affStr);
      cr.searchParams.set('rows', '100');
      const crResp = await fetchWithTimeout(cr.toString(), { headers: { 'User-Agent': 'ResearchExplorer/1.0 (mailto:contact@example.com)' } }, Math.min(4000, timeLeft(started, BUDGET_MS)));
      if (crResp.ok) {
        const j = await crResp.json();
        const items = j?.message?.items || [];
        crItems = items
          .filter(x => {
            const authors = Array.isArray(x.author) ? x.author : [];
            const nameOk = authors.some(a => namesSimilar(`${a.given || ''} ${a.family || ''}`.trim(), name));
            if (!nameOk) return false;
            if (!affiliation && !department) return true;
            return authors.some(a =>
              (Array.isArray(a.affiliation) ? a.affiliation : [])
                .some(af => includesAff((af?.name || ''), affiliation, department))
            );
          })
          .map(x => ({
            title: Array.isArray(x.title) ? x.title[0] : (x.title || ''),
            year: (x.issued && Array.isArray(x.issued['date-parts']) && x.issued['date-parts'][0]?.[0]) || null,
            venue: x['container-title'] ? (Array.isArray(x['container-title']) ? x['container-title'][0] : x['container-title']) : '',
            url: x.URL || (x.DOI ? `https://doi.org/${x.DOI}` : ''),
            doi: x.DOI || '',
            authors: (Array.isArray(x.author) ? x.author.map(a => `${a.given || ''} ${a.family || ''}`.trim()).filter(Boolean) : []),
            type: (x.type || 'other').toLowerCase(),
            origin: 'CR',
            abstract: ''
          }))
          .filter(p => p.title);
      }
    } catch (e) {
      console.warn('[APUB] CR err:', e?.name || e?.message || e);
    }

    // 2C) OpenAlex — one page for enrichment (best effort)
    let oaItems = [];
    try {
      const aURL = new URL('https://api.openalex.org/authors');
      aURL.searchParams.set('search', name);
      aURL.searchParams.set('per-page', '10');
      const aResp = await fetchWithTimeout(aURL.toString(), {}, Math.min(3000, timeLeft(started, BUDGET_MS)));
      if (aResp.ok) {
        const aj = await aResp.json();
        const cands = Array.isArray(aj?.results) ? aj.results : [];
        if (cands.length) {
          const affL = affiliation.toLowerCase(), depL = department.toLowerCase();
          let bestOA = null, bestScore = -1;
          for (const c of cands) {
            const nm = (c.display_name || '').toLowerCase();
            const inst = (c.last_known_institution?.display_name || '').toLowerCase();
            let s = 0;
            if (nm === name.toLowerCase()) s += 3;
            if (affL && inst.includes(affL)) s += 2;
            if (depL && inst.includes(depL)) s += 1;
            if (s > bestScore) { bestScore = s; bestOA = c; }
          }
          const target = bestOA || cands[0];
          const orcid = target?.orcid?.replace('https://orcid.org/', '') || '';
          const wURL = new URL('https://api.openalex.org/works');
          wURL.searchParams.set('per-page', '100');
          if (orcid) wURL.searchParams.set('filter', `author.orcid:${orcid}`);
          else wURL.searchParams.set('filter', `author.display_name:${name}`);
          const wResp = await fetchWithTimeout(wURL.toString(), {}, Math.min(3500, timeLeft(started, BUDGET_MS)));
          if (wResp.ok) {
            const wj = await wResp.json();
            const works = Array.isArray(wj?.results) ? wj.results : [];
            oaItems = works.map(w => ({
              title: w.title || '',
              year: w.publication_year || null,
              venue: w.host_venue?.display_name || '',
              url: w.primary_location?.landing_page_url || (w.doi ? `https://doi.org/${w.doi}` : ''),
              doi: w.doi || '',
              authors: (w.authorships || []).map(a => a.author?.display_name).filter(Boolean),
              type: (w.type || 'other').toLowerCase(),
              origin: 'OA',
              abstract: ''
            }))
            .filter(p => p.title);
          }
        }
      }
    } catch (e) {
      console.warn('[APUB] OA err:', e?.name || e?.message || e);
    }

    // --- 3) Merge & dedupe (doi -> url -> title+year) ---
    const byKey = new Map();
    const push = (p) => {
      const k = (p.doi && `doi:${p.doi.toLowerCase()}`) ||
                (p.url && `url:${p.url.toLowerCase()}`) ||
                `ty:${(p.title || '').toLowerCase()}::${p.year || ''}`;
      if (!byKey.has(k)) byKey.set(k, p);
    };
    [...publications, ...crItems, ...oaItems].forEach(push);
    const merged = Array.from(byKey.values());

    // --- 4) Metrics (best effort, quick) ---
    let metrics = {
      totalPublications: merged.length,
      totalCitations: null,
      hIndex: null,
      lastUpdated: new Date().toISOString().slice(0,10)
    };
    try {
      if (ssAuthorId) {
        const det = await fetchWithTimeout(
          `https://api.semanticscholar.org/graph/v1/author/${ssAuthorId}?fields=hIndex,citationCount,paperCount,updated`,
          {},
          Math.min(2500, timeLeft(started, BUDGET_MS))
        );
        if (det.ok) {
          const dj = await det.json();
          metrics.totalCitations = Number.isFinite(dj.citationCount) ? dj.citationCount : metrics.totalCitations;
          metrics.hIndex = Number.isFinite(dj.hIndex) ? dj.hIndex : metrics.hIndex;
          metrics.lastUpdated = dj.updated || metrics.lastUpdated;
        }
      }
    } catch {}

    // --- 5) ALWAYS save to DB (idempotent upserts in persist.js) ---
    try {
      const { saveFacultyAndPublications } = await import('./src/services/persist.js');
      await saveFacultyAndPublications({
        name,
        college: affiliation || 'Unknown',
        department: department || 'Unknown',
        externalIds: ssAuthorId ? { semanticScholar: ssAuthorId } : {},
        publications: merged,
        metrics
      });
    } catch (e) {
      console.error('[DB SAVE] failed:', e?.message || e);
      // continue response anyway
    }

    // --- 6) Continuation token if time ran out and user asked for full ---
    let nextToken = null;
    if (ssAuthorId && (String(full) === '1' || full === 1 || full === true)) {
      // If there is likely more SS data and we ran out of time, expose next state
      if (timeLeft(started, BUDGET_MS) < 1200) {
        nextToken = { ssOffset };
      } else {
        // If last page was exactly full page, we probably have more
        if (merged.length && merged.length % 100 === 0) {
          nextToken = { ssOffset };
        }
      }
    }

    res.json({
      ok: true,
      author: best ? { id: ssAuthorId, name: best.name || name } : null,
      publications: merged,
      metrics,
      next: nextToken
    });
  } catch (err) {
    console.error('AUTHOR_PUBLICATIONS_ERROR', err);
    res.status(200).json({ ok: true, author: null, publications: [], metrics: null, next: null });
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
