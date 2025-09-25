import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { saveFacultyAndPublications, getAllFaculty, getFacultyPublications, getDepartmentSummary } from './src/services/persist.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// --- Helpers ---
const SERPER_API_KEY = process.env.SERPER_API_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

// Function to check if an affiliation string includes any of the search terms
function includesAff(affiliation = '', ...searchTerms) {
  if (!affiliation) return false;
  const affLower = String(affiliation).toLowerCase();
  return searchTerms
    .filter(term => term) // Remove empty/undefined terms
    .some(term => affLower.includes(term.toLowerCase()));
}

// Function to check if two names are similar
function namesSimilar(a = '', b = '') {
  if (!a || !b) return false;
  
  // Convert to lowercase and remove extra spaces
  const cleanA = a.toLowerCase().trim().replace(/\s+/g, ' ');
  const cleanB = b.toLowerCase().trim().replace(/\s+/g, ' ');
  
  // Exact match
  if (cleanA === cleanB) return true;
  
  // Check if one name is contained in the other
  if (cleanA.includes(cleanB) || cleanB.includes(cleanA)) {
    return true;
  }
  
  // Split on spaces and periods, and filter out empty parts
  const aParts = cleanA.split(/[\s.]+/).filter(Boolean);
  const bParts = cleanB.split(/[\s.]+/).filter(Boolean);
  
  // Check for initial-based matches (e.g., "A. Khandare" vs "Anand Khandare")
  if (aParts.length >= 1 && bParts.length >= 1) {
    const aLast = aParts[aParts.length - 1];
    const bLast = bParts[bParts.length - 1];
    
    // Match last names
    if (aLast !== bLast) return false;
    
    // If either first name is an initial, it's a match
    if (aParts[0].length === 1 || bParts[0].length === 1) {
      return true;
    }
    
    // Check if first names start with the same letter
    if (aParts[0][0] === bParts[0][0]) {
      return true;
    }
  }
  
  return false;
}

function classifyQuery(q) {
  const query = (q || '').trim();
  const lower = query.toLowerCase();
  // Simple heuristics
  if (lower.includes('journal') || /\b(journal of|transactions on|reviews?)\b/i.test(query)) {
    return 'journal';
  }

// --- Identity and matching helpers ---
function namesSimilar(a = '', b = '') {
  if (!a || !b) return false;
  
  // Convert to lowercase and remove extra spaces
  const cleanA = a.toLowerCase().trim().replace(/\s+/g, ' ');
  const cleanB = b.toLowerCase().trim().replace(/\s+/g, ' ');
  
  // Exact match
  if (cleanA === cleanB) return true;
  
  // Check if one name is contained in the other
  if (cleanA.includes(cleanB) || cleanB.includes(cleanA)) {
    return true;
  }
  
  // Split on spaces and periods, and filter out empty parts
  const aParts = cleanA.split(/[\s.]+/).filter(Boolean);
  const bParts = cleanB.split(/[\s.]+/).filter(Boolean);
  
  // Check for initial-based matches (e.g., "A. Khandare" vs "Anand Khandare")
  if (aParts.length >= 1 && bParts.length >= 1) {
    const aLast = aParts[aParts.length - 1];
    const bLast = bParts[bParts.length - 1];
    
    // Match last names
    if (aLast !== bLast) return false;
    
    // If either first name is an initial, it's a match
    if (aParts[0].length === 1 || bParts[0].length === 1) {
      return true;
    }
    
    // Check if first names start with the same letter
    if (aParts[0][0] === bParts[0][0]) {
      return true;
    }
  }
  const bLast = bParts[bParts.length - 1] || '';

  // Last names must match
  if (aLast !== bLast) return false;

  // First names match exactly or by initial
  if (aFirst && bFirst) {
    // Full first name match (e.g., 'anand' === 'anand')
    if (aFirst === bFirst) return true;
    
    // Initial match (e.g., 'a' matches 'anand' or 'anand' matches 'a')
    if ((aFirst.length === 1 && bFirst.startsWith(aFirst)) ||
        (bFirst.length === 1 && aFirst.startsWith(bFirst))) {
      return true;
    }
  }

  console.log('[AUTHOR_MATCH] No match:', a, b);
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
  if (/^[A-Z][a-z]+\s+[A-Z][a-z]+(\s+[A-Z][a-z]+)?$/.test(query)) { // Likely Person Name
    return 'author';
  }
  return 'paper_or_topic';
}

function buildSummaryPrompt(kind, query, results) {
  const topItems = results.slice(0, 10).map((r, i) => `#${i + 1} ${r.title} — ${r.snippet} (source: ${r.link})`).join('\n');
  const base = `You are an expert research assistant. Use the search results to produce a concise, structured summary in plain text with bullet points. Be accurate and avoid fabrications.`;
  if (kind === 'author') {
    return `${base}\n\nQuery: ${query}\nType: Author\n\nFrom the results, summarize:\n- Affiliation(s)\n- Key research domains\n- Approx. number of papers\n- Notable contributions or highly cited works\n\nSearch results:\n${topItems}`;
  }
  if (kind === 'journal') {
    return `${base}\n\nQuery: ${query}\nType: Journal\n\nFrom the results, summarize:\n- Scope and subject areas\n- (If available) Impact factor or ranking\n- Publishing body\n- Typical submission focus\n\nSearch results:\n${topItems}`;
  }
  return `${base}\n\nQuery: ${query}\nType: Paper/Topic\n\nFrom the results, provide:\n- Abstract-style overview\n- Key findings or methods\n- Significance and applications\n- Related notable works\n\nSearch results:\n${topItems}`;
}

function normalizeSerperResults(json) {
  const items = [];
  const sources = [
    ...(json.organic || []),
    ...(json.scholar || []),
    ...(json.news || []),
  ];
  for (const s of sources) {
    if (!s) continue;
    const title = s.title || s.titleHighlighted || '';
    const snippet = s.snippet || s.snippetHighlighted || s.description || '';
    const link = s.link || s.url || s.source || '';
    if (title && link) {
      items.push({ title, snippet, link, source: (new URL(link)).hostname });
    }
  }
  // Remove duplicates by link
  const seen = new Set();
  return items.filter(it => {
    if (seen.has(it.link)) return false;
    seen.add(it.link);
    return true;
  });
}

// --- Routes ---
app.post('/api/search', async (req, res) => {
  try {
    const { query } = req.body || {};
    if (!query) return res.status(400).json({ error: 'Missing query' });
    if (!SERPER_API_KEY) return res.status(500).json({ error: 'Missing SERPER_API_KEY on server' });

    // Fetch multiple pages from both web search and scholar to increase coverage
    const pages = [1, 2, 3]; // adjust as needed to balance quota and depth
    const numPerPage = 20;   // typical max page size supported

    const webRequests = pages.map(page =>
      fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: {
          'X-API-KEY': SERPER_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ q: query, gl: 'us', hl: 'en', page, num: numPerPage })
      })
    );

    const scholarRequests = pages.map(page =>
      fetch('https://google.serper.dev/scholar', {
        method: 'POST',
        headers: {
          'X-API-KEY': SERPER_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ q: query, page, num: numPerPage })
      })
    );

    const responses = await Promise.allSettled([...webRequests, ...scholarRequests]);
    const aggregated = [];
    for (const r of responses) {
      if (r.status !== 'fulfilled') continue;
      const resp = r.value;
      if (!resp.ok) continue;
      try {
        const data = await resp.json();
        aggregated.push(...normalizeSerperResults(data));
      } catch (_) {
        // ignore json parse errors for a single page
      }
    }

    if (aggregated.length === 0) {
      // As a fallback, try a single simple request to return an error body if any
      const resp = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: {
          'X-API-KEY': SERPER_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ q: query, gl: 'us', hl: 'en' })
      });
      if (!resp.ok) {
        const text = await resp.text();
        return res.status(502).json({ error: 'Serper error', detail: text });
      }
      const data = await resp.json();
      const items = normalizeSerperResults(data);
      console.log('[SEARCH] Fallback items:', items.length, 'Query:', query);
      return res.json({ query, items });
    }
    // De-duplicate across pages by link
    const seenLinks = new Set();
    const deduped = [];
    for (const it of aggregated) {
      const k = it.link || '';
      if (k && seenLinks.has(k)) continue;
      if (k) seenLinks.add(k);
      deduped.push(it);
    }
    console.log('[SEARCH] Aggregated items:', aggregated.length, 'Deduped:', deduped.length, 'Query:', query);
    res.json({ query, items: deduped });
  } catch (err) {
    console.error('SEARCH_ERROR', err);
    res.status(500).json({ error: 'Unexpected error', detail: String(err) });
  }
});

app.post('/api/summarize', async (req, res) => {
  try {
    const { query, items } = req.body || {};
    if (!query || !Array.isArray(items)) return res.status(400).json({ error: 'Missing query or items' });
    if (!GOOGLE_API_KEY) return res.status(500).json({ error: 'Missing GOOGLE_API_KEY on server' });

    const kind = classifyQuery(query);
    const prompt = buildSummaryPrompt(kind, query, items);

    const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const result = await model.generateContent(prompt);
    const text = result?.response?.text?.() || 'No summary generated.';

    res.json({ query, kind, summary: text });
  } catch (err) {
    console.error('SUMMARIZE_ERROR', err);
    res.status(500).json({ error: 'Unexpected error', detail: String(err) });
  }
});

app.post('/api/query', async (req, res) => {
  try {
    const { query } = req.body || {};
    if (!query) return res.status(400).json({ error: 'Missing query' });

    // 1) Search
    const sresp = await fetch('http://localhost:' + PORT + '/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });
    const sjson = await sresp.json();
    if (!sresp.ok) return res.status(sresp.status).json(sjson);

    // 2) Summarize
    const yresp = await fetch('http://localhost:' + PORT + '/api/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, items: sjson.items })
    });
    const yjson = await yresp.json();
    if (!yresp.ok) return res.status(yresp.status).json(yjson);

    res.json({ query, items: sjson.items, summary: yjson.summary, kind: yjson.kind });
  } catch (err) {
    console.error('QUERY_ERROR', err);
    res.status(500).json({ error: 'Unexpected error', detail: String(err) });
  }
});

// Fetch an author's publications aggregating multiple sources (Semantic Scholar, Crossref, OpenAlex)
// Input: { name: string, affiliation?: string, department?: string }
// Output: { author: { id, name }, publications: [ { title, year, venue, url, type } ] }
app.post('/api/authorPublications', async (req, res) => {
  try {
    const { name, affiliation, department } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Missing name' });

    // 1) Find author by name (get multiple candidates)
    const searchUrl = `https://api.semanticscholar.org/graph/v1/author/search?query=${encodeURIComponent(name)}&limit=10`;
    const sresp = await fetch(searchUrl);
    if (!sresp.ok) {
      const text = await sresp.text();
      return res.status(502).json({ error: 'Semantic Scholar search error', detail: text });
    }
    const sjson = await sresp.json();
    const candidates = Array.isArray(sjson?.data) ? sjson.data : [];
    // 1b) Pick best candidate by naive scoring against affiliation/department strings
    const aff = (affiliation || '').toLowerCase();
    const dept = (department || '').toLowerCase();
    let best = null;
    if (candidates.length > 0) {
      // First, restrict to candidates whose affiliations include provided college if any
      const affL = (affiliation || '').toLowerCase();
      const depL = (department || '').toLowerCase();
      const withAff = affL
        ? candidates.filter(c => (Array.isArray(c.affiliations) ? c.affiliations.join(' ').toLowerCase().includes(affL) : false))
        : candidates;
      const pool = withAff.length > 0 ? withAff : candidates;
      // Prefer exact name match if present within pool
      const exact = pool.find(c => (c.name || '').toLowerCase() === name.toLowerCase());
      if (exact) {
        best = exact;
      } else {
        let bestScore = -1;
        for (const c of pool) {
          const fields = [c.name || '', ...(c.aliases || []), ...(c.affiliations || [])].join(' ').toLowerCase();
          let score = 0;
          if (affL && fields.includes(affL)) score += 3; // stronger weight for college match
          if (depL && fields.includes(depL)) score += 1;
          if ((c.name || '').toLowerCase() === name.toLowerCase()) score += 2;
          if (score > bestScore) { bestScore = score; best = c; }
        }
      }
      if (best && affL && !(Array.isArray(best.affiliations) ? best.affiliations.join(' ').toLowerCase().includes(affL) : false)) {
        console.log('[AUTHOR_RESOLVE] SS best author has NO affiliation match; will skip SS papers');
      }
    } else {
      console.log('[AUTHOR_PUBS] No SS author found for name:', name, '— falling back to Crossref/OpenAlex only');
    }

    // 2) Fetch publications for the author (paginate to retrieve many) — Semantic Scholar
    const pubs = [];
    // Only fetch SS papers if the chosen author affiliations include the provided college (when provided)
    const bestHasAff = best && (!affiliation || !best.affiliations || 
      (Array.isArray(best.affiliations) && 
       best.affiliations.some(aff => 
         aff && aff.toLowerCase().includes((affiliation || '').toLowerCase())
       )
      ));
    if (best && best.authorId && bestHasAff) {
      const authorId = best.authorId;
      const fields = 'title,year,venue,url,authors,externalIds,publicationTypes,abstract';
      const pageSize = 100;
      const maxPages = 5; // up to 500 items; adjust if needed
      for (let page = 1; page <= maxPages; page++) {
        const url = `https://api.semanticscholar.org/graph/v1/author/${authorId}/papers?limit=${pageSize}&offset=${(page-1)*pageSize}&fields=${encodeURIComponent(fields)}`;
        const presp = await fetch(url);
        if (!presp.ok) {
          const t = await presp.text().catch(() => '');
          console.warn('[AUTHOR_PUBS] Page fetch failed', page, t);
          break;
        }
        const pjson = await presp.json();
        const items = Array.isArray(pjson?.data) ? pjson.data : [];
        pubs.push(...items);
        if (items.length < pageSize) break; // no more pages
      }
    }

    // Normalize publications (Semantic Scholar)
    const publicationsSS = pubs
      .filter(p => {
        try {
          const authors = Array.isArray(p.authors) ? p.authors : [];
          const hasAuthor = authors.some(a => a && a.name && namesSimilar(a.name, name));
          
          if (!hasAuthor) {
            console.log('[SEMANTIC_SCHOLAR_FILTER] Paper skipped - no matching author:', {
              title: p.title,
              authors: authors.map(a => a?.name || 'unknown'),
              targetAuthor: name
            });
          }
          
          return hasAuthor;
        } catch (err) {
          console.error('[SEMANTIC_SCHOLAR_FILTER] Error filtering authors:', err);
          return false;
        }
      })
      .map(p => ({
        title: p.title || '',
        year: p.year || null,
        venue: p.venue || '',
        url: p.url || '',
        doi: (p.doi || (p.externalIds && p.externalIds.DOI)) || '',
        authors: Array.isArray(p.authors) ? p.authors.map(a => a.name).filter(Boolean) : [],
        type: Array.isArray(p.publicationTypes) && p.publicationTypes.length > 0 ? (p.publicationTypes[0] || '').toLowerCase() : '',
        origin: 'SS'
      }))
      .filter(p => p.title);

    // 3) Crossref — query by author name and optional affiliation/department (strict filtering)
    const crQuery = new URL('https://api.crossref.org/works');
    crQuery.searchParams.set('query.author', name);
    if (affiliation || department) {
      const affStr = [affiliation || '', department || ''].filter(Boolean).join(' ');
      crQuery.searchParams.set('query.affiliation', affStr);
    }
    if (department) {
      crQuery.searchParams.set('query.title', `${name} ${department}`);
    }
    crQuery.searchParams.set('rows', '100');
    let publicationsCR = [];
    try {
      const crResp = await fetch(crQuery.toString(), { headers: { 'User-Agent': 'ResearchExplorer/1.0 (mailto:example@example.com)' } });
      if (crResp.ok) {
        const crJson = await crResp.json();
        const items = crJson?.message?.items || [];
        publicationsCR = items
          .filter(x => {
            const authors = Array.isArray(x.author) ? x.author : [];
            const nameOk = authors.some(a => namesSimilar(`${a.given || ''} ${a.family || ''}`.trim(), name));
            if (!nameOk) return false;
            if (affiliation || department) {
              try {
                return authors.some(a => {
                  const affiliations = Array.isArray(a.affiliation) ? a.affiliation : [];
                  return affiliations.some(aff => {
                    const affName = (aff && typeof aff === 'object' ? aff.name : aff) || '';
                    return includesAff(affName, affiliation, department);
                  });
                });
              } catch (err) {
                console.error('Error checking affiliations:', err);
                return true; // Include the paper if there's an error checking affiliations
              }
            }
            return true;
          })
          .map(x => ({
            title: Array.isArray(x.title) ? x.title[0] : (x.title || ''),
            year: (x.issued && Array.isArray(x.issued['date-parts']) && x.issued['date-parts'][0]?.[0]) || null,
            venue: x['container-title'] ? (Array.isArray(x['container-title']) ? x['container-title'][0] : x['container-title']) : '',
            url: x.URL || (x.DOI ? `https://doi.org/${x.DOI}` : ''),
            doi: x.DOI || '',
            authors: (Array.isArray(x.author) ? x.author.map(a => `${a.given || ''} ${a.family || ''}`.trim()).filter(Boolean) : []),
            type: (x.type || 'other').toLowerCase(),
            origin: 'CR'
          }))
          .filter(p => p.title);
      } else {
        console.warn('[CROSSREF] non-OK', crResp.status);
      }
    } catch (e) {
      console.warn('[CROSSREF] error', e);
    }

    // 4) OpenAlex — find author and fetch works (strict when no ORCID)
    let publicationsOA = [];
    try {
      const oaAuthorSearch = new URL('https://api.openalex.org/authors');
      oaAuthorSearch.searchParams.set('search', name);
      oaAuthorSearch.searchParams.set('per-page', '15');
      const oaAS = await fetch(oaAuthorSearch.toString());
      if (oaAS.ok) {
        const ajson = await oaAS.json();
        const candidatesOA = Array.isArray(ajson?.results) ? ajson.results : [];
        if (candidatesOA.length > 0) {
          const affL = (affiliation || '').toLowerCase();
          const depL = (department || '').toLowerCase();
          let bestOA = null;
          let bestScoreOA = -1;
          for (const c of candidatesOA) {
            const nameL = (c.display_name || '').toLowerCase();
            const inst = ((c.last_known_institution && c.last_known_institution.display_name) || '').toLowerCase();
            let score = 0;
            if (nameL === (name || '').toLowerCase()) score += 3;
            if (affL && inst.includes(affL)) score += 2;
            if (depL && inst.includes(depL)) score += 1;
            if (score > bestScoreOA) { bestScoreOA = score; bestOA = c; }
          }
          const target = bestOA || candidatesOA[0];
          const targetOrcid = target?.orcid ? String(target.orcid).replace('https://orcid.org/', '') : '';
          if (target?.id) {
            const oaWorksUrl = new URL('https://api.openalex.org/works');
            if (targetOrcid) {
              oaWorksUrl.searchParams.set('filter', `author.orcid:${targetOrcid}`);
            } else if (affiliation || department) {
              // fallback to display_name; strict post-filter below will enforce affiliation
              oaWorksUrl.searchParams.set('filter', `author.display_name:${name}`);
            } else {
              oaWorksUrl.searchParams.set('filter', `author.display_name:${name}`);
            }
            oaWorksUrl.searchParams.set('per-page', '200');
            const oaW = await fetch(oaWorksUrl.toString());
            if (oaW.ok) {
              const wjson = await oaW.json();
              const works = Array.isArray(wjson?.results) ? wjson.results : [];
              publicationsOA = works
                .filter(w => {
                  const auths = w.authorships || [];
                  if (targetOrcid) {
                    return auths.some(a => (a.author && a.author.orcid) && a.author.orcid.endsWith(targetOrcid));
                  }
                  const nameOk = auths.some(a => namesSimilar(a.author?.display_name || '', name));
                  if (!nameOk) return false;
                  if (!affiliation && !department) return true;
                  const instStr = auths.map(a => (a.institutions||[]).map(i => i.display_name).join(' ')).join(' ');
                  return includesAff(instStr, affiliation, department);
                })
                .map(w => ({
                  title: w.title || '',
                  year: w.publication_year || null,
                  venue: (w.host_venue && w.host_venue.display_name) || '',
                  url: (w.primary_location && w.primary_location.landing_page_url) || (w.doi ? `https://doi.org/${w.doi}` : ''),
                  doi: w.doi || '',
                  authors: (w.authorships || []).map(a => a.author?.display_name).filter(Boolean),
                  type: (w.type || 'other').toLowerCase(),
                  origin: 'OA'
                }))
                .filter(p => p.title);
            }
          }
        }
      }
    } catch (e) {
      console.warn('[OPENALEX] error', e);
    }

    // Combine and de-duplicate by URL or (title+year)
    const combined = [...publicationsSS, ...publicationsCR, ...publicationsOA];
    const seenKeys = new Set();
    const deduped = [];
    for (const p of combined) {
      const key = (p.url && p.url.toLowerCase()) || `${(p.title || '').toLowerCase()}::${p.year || ''}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      deduped.push(p);
    }

    // Fetch author metrics from SS (if available), else OpenAlex
    let metrics = { totalPublications: deduped.length, totalCitations: null, hIndex: null, lastUpdated: new Date().toISOString().slice(0,10) };
    try {
      if (best?.authorId) {
        const det = await fetch(`https://api.semanticscholar.org/graph/v1/author/${best.authorId}?fields=hIndex,citationCount,paperCount,updated`);
        if (det.ok) {
          const dj = await det.json();
          metrics.totalCitations = (typeof dj.citationCount === 'number') ? dj.citationCount : metrics.totalCitations;
          metrics.hIndex = (typeof dj.hIndex === 'number') ? dj.hIndex : metrics.hIndex;
          metrics.lastUpdated = dj.updated || metrics.lastUpdated;
        }
      }
    } catch (_) {}
    // Fallback to OpenAlex author metrics if SS not available
    try {
      if ((metrics.totalCitations == null || metrics.hIndex == null) && (typeof best === 'undefined' || best === null)) {
        // If SS not resolved, try OpenAlex top author candidate
        const oaAuthorSearch = new URL('https://api.openalex.org/authors');
        oaAuthorSearch.searchParams.set('search', name);
        oaAuthorSearch.searchParams.set('per-page', '1');
        const oaAS = await fetch(oaAuthorSearch.toString());
        if (oaAS.ok) {
          const ajson = await oaAS.json();
          const first = Array.isArray(ajson?.results) ? ajson.results[0] : null;
          if (first?.id) {
            const oaDet = await fetch(first.id);
            if (oaDet.ok) {
              const od = await oaDet.json();
              metrics.totalCitations = (typeof od.cited_by_count === 'number') ? od.cited_by_count : metrics.totalCitations;
              metrics.hIndex = (od.summary_stats && typeof od.summary_stats.h_index === 'number') ? od.summary_stats.h_index : metrics.hIndex;
              metrics.lastUpdated = od.updated_date || metrics.lastUpdated;
            }
          }
        }
      }
    } catch (_) {}

    const authorOut = best ? { id: best.authorId, name: best.name } : null;
    console.log('[AUTHOR_PUBS] Author:', authorOut?.name || 'unknown', 'SS:', publicationsSS.length, 'CR:', publicationsCR.length, 'OA:', publicationsOA.length, 'Deduped:', deduped.length);

    // Prepare external IDs for database storage
    const externalIds = {};
    if (best?.authorId) externalIds.semanticScholar = best.authorId;
    if (best?.externalIds?.ORCID) externalIds.orcid = best.externalIds.ORCID;

    // Save to database
    let savedData = null;
    try {
      console.log('[DB] Saving faculty and publications to database...');
      savedData = await saveFacultyAndPublications({
        name: name,
        college: affiliation || 'Unknown',
        department: department || 'Unknown',
        externalIds: externalIds,
        publications: deduped.map(p => ({
          title: p.title,
          year: p.year,
          venue: p.venue,
          doi: p.doi,
          url: p.url,
          abstract: p.abstract || '',
          externalIds: { [p.origin]: true }
        })),
        metrics: metrics
      });
      console.log(`[DB] Successfully saved faculty ${savedData.faculty.fullName} with ${savedData.publications.length} publications`);
    } catch (dbError) {
      console.error('[DB] Error saving to database:', dbError);
      // Continue with response even if DB save fails
    }

    res.json({
      author: authorOut,
      publications: deduped,
      metrics,
      facultyId: savedData?.faculty?.id || null
    });
  } catch (err) {
    console.error('AUTHOR_PUBLICATIONS_ERROR', err);
    res.status(500).json({ error: 'Unexpected error', detail: String(err) });
  }
});

// Admin API: Get faculty list with optional department filter
app.get('/api/faculty', async (req, res) => {
  try {
    const { department } = req.query;
    const faculty = await getAllFaculty(department);
    res.json({ faculty });
  } catch (err) {
    console.error('FACULTY_LIST_ERROR', err);
    res.status(500).json({ error: 'Failed to fetch faculty list', detail: String(err) });
  }
});

// Admin API: Get publications for a specific faculty
app.get('/api/faculty/:id/publications', async (req, res) => {
  try {
    const { id } = req.params;
    const { yearFrom, yearTo } = req.query;

    const publications = await getFacultyPublications(
      id,
      yearFrom ? parseInt(yearFrom) : null,
      yearTo ? parseInt(yearTo) : null
    );

    res.json({ publications });
  } catch (err) {
    console.error('FACULTY_PUBLICATIONS_ERROR', err);
    res.status(500).json({ error: 'Failed to fetch faculty publications', detail: String(err) });
  }
});

// Admin API: Get department summary
app.get('/api/admin/summary', async (req, res) => {
  try {
    const { department } = req.query;
    if (!department) {
      return res.status(400).json({ error: 'Department parameter is required' });
    }

    const summary = await getDepartmentSummary(department);
    res.json({ summary });
  } catch (err) {
    console.error('DEPARTMENT_SUMMARY_ERROR', err);
    res.status(500).json({ error: 'Failed to fetch department summary', detail: String(err) });
  }
});

// Fallback to index.html for root
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/// ✅ export app for serverless
export default app;

// ✅ only run a local server if you start it with `node server.js`
if (process.env.VERCEL !== "1" && process.env.NODE_ENV !== "production") {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running locally at http://localhost:${PORT}`);
  });
}

