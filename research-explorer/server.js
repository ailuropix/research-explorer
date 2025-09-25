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

/* ---------------------------------------------------------------------------------------
   Helpers (pure, no I/O here)
--------------------------------------------------------------------------------------- */
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

/* ---------------------------------------------------------------------------------------
   A) Web search (Serper) — POST /api/search
--------------------------------------------------------------------------------------- */
app.post('/api/search', async (req, res) => {
  try {
    const { query } = req.body || {};
    if (!query) return res.status(400).json({ error: 'Missing query' });
    if (!SERPER_API_KEY) return res.json({ query, items: [] });

    const r = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, gl: 'in', num: 20 })
    });
    const j = r.ok ? await r.json() : {};
    const items = normalizeSerperResults(j);
    res.json({ query, items });
  } catch (err) {
    console.error('SEARCH_ERROR', err);
    res.status(500).json({ error: 'Unexpected error' });
  }
});

/* ---------------------------------------------------------------------------------------
   B) Summarize (Gemini) — POST /api/summarize
--------------------------------------------------------------------------------------- */
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
    res.status(500).json({ error: 'Unexpected error' });
  }
});

/* ---------------------------------------------------------------------------------------
   C) Compose search + (optional) summary — POST /api/query
--------------------------------------------------------------------------------------- */
app.post('/api/query', async (req, res) => {
  try {
    const { query } = req.body || {};
    if (!query) return res.status(400).json({ error: 'Missing query' });

    const items = await (async () => {
      if (!SERPER_API_KEY) return [];
      const r = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, gl: 'in', num: 20 })
      });
      const j = r.ok ? await r.json() : {};
      return normalizeSerperResults(j);
    })();

    const summary = await (async () => {
      if (!GOOGLE_API_KEY || items.length === 0) return '';
      try {
        const { GoogleGenerativeAI } = await import('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const prompt = buildSummaryPrompt(classifyQuery(query), query, items);
        const result = await model.generateContent(prompt);
        return result?.response?.text?.() || '';
      } catch (e) {
        console.warn('Gemini summarization failed:', e?.message || e);
        return '';
      }
    })();

    res.json({ ok: true, items, summary });
  } catch (err) {
    console.error('QUERY_ERROR', err);
    res.status(500).json({ error: 'Unexpected error' });
  }
});

/* ---------------------------------------------------------------------------------------
   D) Author publications (SCRAPE + ALWAYS SAVE) — POST /api/authorPublications
--------------------------------------------------------------------------------------- */
app.post('/api/authorPublications', async (req, res) => {
  try {
    const { name, affiliation = '', department = '' } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Missing name' });

    // -- Semantic Scholar: author candidates
    let best = null;
    try {
      const sresp = await fetch(`https://api.semanticscholar.org/graph/v1/author/search?query=${encodeURIComponent(name)}&limit=10`);
      if (sresp.ok) {
        const sjson = await sresp.json();
        const candidates = Array.isArray(sjson?.data) ? sjson.data : [];
        const affL = affiliation.toLowerCase(), depL = department.toLowerCase();
        best = candidates
          .map(c => {
            const fields = [c.name || '', ...(c.aliases || []), ...(c.affiliations || [])].join(' ').toLowerCase();
            let score = 0;
            if ((c.name || '').toLowerCase() === name.toLowerCase()) score += 2;
            if (affL && fields.includes(affL)) score += 3;
            if (depL && fields.includes(depL)) score += 1;
            return { c, score };
          })
          .sort((a, b) => b.score - a.score)[0]?.c || candidates[0] || null;
      }
    } catch (e) { console.warn('[SS] author search failed', e); }

    // -- SS publications (paged)
    const pubsSS = [];
    if (best?.authorId) {
      const fields = 'title,year,venue,url,authors,externalIds,publicationTypes,abstract';
      const pageSize = 100;
      for (let offset = 0; offset < 500; offset += pageSize) {
        const url = `https://api.semanticscholar.org/graph/v1/author/${best.authorId}/papers?limit=${pageSize}&offset=${offset}&fields=${encodeURIComponent(fields)}`;
        const presp = await fetch(url);
        if (!presp.ok) break;
        const pjson = await presp.json();
        const items = Array.isArray(pjson?.data) ? pjson.data : [];
        pubsSS.push(...items);
        if (items.length < pageSize) break;
      }
    }
    const publicationsSS = pubsSS
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

    // -- Crossref
    let publicationsCR = [];
    try {
      const cr = new URL('https://api.crossref.org/works');
      cr.searchParams.set('query.author', name);
      const affStr = [affiliation, department].filter(Boolean).join(' ');
      if (affStr) cr.searchParams.set('query.affiliation', affStr);
      cr.searchParams.set('rows', '100');
      const crResp = await fetch(cr.toString(), { headers: { 'User-Agent': 'ResearchExplorer/1.0 (mailto:contact@example.com)' } });
      if (crResp.ok) {
        const j = await crResp.json();
        const items = j?.message?.items || [];
        publicationsCR = items
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
    } catch (e) { console.warn('[CR] error', e); }

    // -- OpenAlex
    let publicationsOA = [];
    try {
      const oaAuthorSearch = new URL('https://api.openalex.org/authors');
      oaAuthorSearch.searchParams.set('search', name);
      oaAuthorSearch.searchParams.set('per-page', '15');
      const oaAS = await fetch(oaAuthorSearch.toString());
      if (oaAS.ok) {
        const ajson = await oaAS.json();
        const candidates = Array.isArray(ajson?.results) ? ajson.results : [];
        if (candidates.length) {
          const affL = affiliation.toLowerCase(), depL = department.toLowerCase();
          let bestOA = null, bestScore = -1;
          for (const c of candidates) {
            const nm = (c.display_name || '').toLowerCase();
            const inst = (c.last_known_institution?.display_name || '').toLowerCase();
            let s = 0;
            if (nm === name.toLowerCase()) s += 3;
            if (affL && inst.includes(affL)) s += 2;
            if (depL && inst.includes(depL)) s += 1;
            if (s > bestScore) { bestScore = s; bestOA = c; }
          }
          const target = bestOA || candidates[0];
          const targetOrcid = target?.orcid?.replace('https://orcid.org/', '') || '';
          if (target?.id) {
            const worksUrl = new URL('https://api.openalex.org/works');
            worksUrl.searchParams.set('per-page', '200');
            if (targetOrcid) worksUrl.searchParams.set('filter', `author.orcid:${targetOrcid}`);
            else worksUrl.searchParams.set('filter', `author.display_name:${name}`);
            const oaW = await fetch(worksUrl.toString());
            if (oaW.ok) {
              const wjson = await oaW.json();
              const works = Array.isArray(wjson?.results) ? wjson.results : [];
              publicationsOA = works
                .filter(w => {
                  const auths = w.authorships || [];
                  if (targetOrcid) {
                    return auths.some(a => a?.author?.orcid && a.author.orcid.endsWith(targetOrcid));
                  }
                  const nameOk = auths.some(a => namesSimilar(a?.author?.display_name || '', name));
                  if (!nameOk) return false;
                  if (!affiliation && !department) return true;
                  const instStr = auths.map(a => (a.institutions||[]).map(i => i.display_name).join(' ')).join(' ');
                  return includesAff(instStr, affiliation, department);
                })
                .map(w => ({
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
      }
    } catch (e) { console.warn('[OA] error', e); }

    // -- Merge & dedupe
    const combined = [...publicationsSS, ...publicationsCR, ...publicationsOA];
    const seen = new Set();
    const publications = combined.filter(p => {
      const key = (p.url && p.url.toLowerCase()) || `${(p.title || '').toLowerCase()}::${p.year || ''}`;
      if (seen.has(key)) return false; seen.add(key); return true;
    });

    // -- Author metrics (SS best effort)
    let metrics = {
      totalPublications: publications.length,
      totalCitations: null,
      hIndex: null,
      lastUpdated: new Date().toISOString().slice(0, 10)
    };
    try {
      if (best?.authorId) {
        const det = await fetch(`https://api.semanticscholar.org/graph/v1/author/${best.authorId}?fields=hIndex,citationCount,paperCount,updated`);
        if (det.ok) {
          const dj = await det.json();
          metrics.totalCitations = Number.isFinite(dj.citationCount) ? dj.citationCount : metrics.totalCitations;
          metrics.hIndex = Number.isFinite(dj.hIndex) ? dj.hIndex : metrics.hIndex;
          metrics.lastUpdated = dj.updated || metrics.lastUpdated;
        }
      }
    } catch {}

    // -- ALWAYS save to DB
    try {
      const { saveFacultyAndPublications } = await import('./src/services/persist.js');
      await saveFacultyAndPublications({
        name,
        college: affiliation || 'Unknown',
        department: department || 'Unknown',
        externalIds: (best?.authorId || best?.externalIds?.ORCID) ? {
          ...(best?.authorId ? { semanticScholar: best.authorId } : {}),
          ...(best?.externalIds?.ORCID ? { orcid: best.externalIds.ORCID } : {})
        } : {},
        publications: publications.map(p => ({
          title: p.title,
          year: p.year,
          venue: p.venue,
          doi: p.doi,
          url: p.url,
          abstract: p.abstract || '',
          externalIds: { [p.origin]: true }
        })),
        metrics
      });
    } catch (e) {
      console.error('[DB SAVE] failed:', e?.message || e);
      // still return results even if save fails
    }

    res.json({
      ok: true,
      author: best ? { id: best.authorId, name: best.name } : null,
      publications,
      metrics
    });
  } catch (err) {
    console.error('AUTHOR_PUBLICATIONS_ERROR', err);
    res.status(500).json({ error: 'Unexpected error' });
  }
});

/* ---------------------------------------------------------------------------------------
   E) DB-first endpoints (unchanged)
--------------------------------------------------------------------------------------- */

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
    const take      = Math.min(parseInt(req.query.limit || '100', 10), 200);

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

/* ---------------------------------------------------------------------------------------
   Error handler + root (local dev)
--------------------------------------------------------------------------------------- */
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
