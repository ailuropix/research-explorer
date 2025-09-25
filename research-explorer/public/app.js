// --- DOM elements ---
const collegeSelect = document.getElementById('collegeSelect');
const deptSelect = document.getElementById('deptSelect');
const facultyInput = document.getElementById('facultyInput');
const findBtn = document.getElementById('findBtn');
const resultsList = document.getElementById('resultsList');
const summaryContent = document.getElementById('summaryContent');
const toggleSummary = document.getElementById('toggleSummary');
const summarySection = document.getElementById('summarySection');
const collegeOtherInput = document.getElementById('collegeOtherInput');
const deptOtherInput = document.getElementById('deptOtherInput');

// Filters / sort
const yearFromEl = document.getElementById('yearFrom');
const yearToEl = document.getElementById('yearTo');
const venueInputEl = document.getElementById('venueInput');
const typeSelectEl = document.getElementById('typeSelect');
const sortSelectEl = document.getElementById('sortSelect');
const applyFiltersBtn = document.getElementById('applyFilters');
const includeWebEl = document.getElementById('includeWeb');
const resultsMetaEl = document.getElementById('resultsMeta');

// KPIs
const kpiTotalPubsEl = document.getElementById('kpiTotalPubs');
const kpiUpdatedEl = document.getElementById('kpiUpdated');

// --- helpers ---
function renderLoading() {
  resultsList.innerHTML = '<div class="card"><div>Loading results…</div></div>';
  summaryContent.textContent = 'Generating summary…';
}

// unified JSON fetch (forces /api/* to return JSON, nice errors otherwise)
const API_BASE = '';
async function fetchJSON(input, init = {}) {
  const res = await fetch(`${API_BASE}${input}`, {
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    ...init,
  });
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  if (!ct.includes('application/json')) {
    throw new Error(`Expected JSON but got "${ct}". Body: ${text.slice(0, 200)}...`);
  }
  const data = JSON.parse(text);
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data;
}

function rowTemplate(item) {
  let hostname = '';
  try { hostname = item.link ? new URL(item.link).hostname : ''; } catch (_) { hostname = ''; }
  const hasDOI = !!(item.doi && String(item.doi).trim());
  const doiSlug = hasDOI ? String(item.doi).replace(/^https?:\/\/doi\.org\//i, '') : '';
  const action = [
    item.link ? `<button class="view-btn" data-link="${item.link}">View</button>` : '',
    hasDOI ? `<button class="view-btn open-doi-btn" data-doi="${doiSlug}">Open DOI</button>` : '',
    hasDOI ? `<button class="view-btn copy-doi-btn" data-doi="${doiSlug}">Copy DOI</button>` : '',
  ].filter(Boolean).join(' ');
  const safe = v => (v == null ? '' : String(v));
  const authors = Array.isArray(item.authors) ? item.authors.join(', ') : '';
  return `
    <tr>
      <td class="col-title"><div class="title">${safe(item.title)}</div><div class="snippet" title="${safe(item.snippet || '')}">${safe(item.snippet || '')}</div></td>
      <td class="col-authors">${safe(authors)}</td>
      <td class="col-venue">${safe(item.venue || '')}</td>
      <td class="col-year">${safe(item.year || '')}</td>
      <td class="col-source">${safe(hostname || item.source || '')}</td>
      <td class="col-action">${action}</td>
    </tr>
  `;
}

function bindCardButtons() {
  resultsList.querySelectorAll('.view-btn').forEach(btn => {
    const doi = btn.getAttribute('data-doi');
    const link = btn.getAttribute('data-link');
    if (btn.classList.contains('open-doi-btn') && doi) {
      btn.addEventListener('click', () => window.open(`https://doi.org/${doi}`, '_blank', 'noopener'));
    } else if (btn.classList.contains('copy-doi-btn') && doi) {
      btn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(doi);
          btn.textContent = 'Copied!';
          setTimeout(() => (btn.textContent = 'Copy DOI'), 1000);
        } catch {
          const el = document.createElement('input');
          el.value = doi;
          document.body.appendChild(el);
          el.select();
          document.execCommand('copy');
          document.body.removeChild(el);
          btn.textContent = 'Copied!';
          setTimeout(() => (btn.textContent = 'Copy DOI'), 1000);
        }
      });
    } else if (link) {
      btn.addEventListener('click', () => window.open(link, '_blank', 'noopener'));
    }
  });
}

let __allItems = [];
let __totalPublications = 0;

function renderResults(items) {
  if (!items || items.length === 0) {
    resultsList.innerHTML = '<div class="card"><div>No results found.</div></div>';
    if (resultsMetaEl) {
      resultsMetaEl.innerHTML = `<span class="results-count">0 shown</span> • <span class="pubs-count">0</span> / <span class="pubs-total">${__totalPublications || 0}</span> publications`;
    }
    return;
  }
  resultsList.innerHTML = `
    <table class="results-table" role="table">
      <thead>
        <tr>
          <th scope="col">Title</th>
          <th scope="col">Authors</th>
          <th scope="col">Venue</th>
          <th scope="col">Year</th>
          <th scope="col">Source</th>
          <th scope="col">Action</th>
        </tr>
      </thead>
      <tbody>${items.map(rowTemplate).join('')}</tbody>
    </table>
  `;
  bindCardButtons();
}

const parseYear = v => (Number.isFinite(+v) ? +v : null);

function isPublicationLike(href) {
  if (!href) return false;
  try {
    const u = new URL(href);
    const host = (u.hostname || '').toLowerCase();
    const path = (u.pathname || '').toLowerCase();
    const pubHosts = new Set([
      'arxiv.org','ieeexplore.ieee.org','dl.acm.org','link.springer.com','sciencedirect.com','www.sciencedirect.com',
      'nature.com','www.nature.com','mdpi.com','www.mdpi.com','onlinelibrary.wiley.com','tandfonline.com','www.tandfonline.com',
      'ncbi.nlm.nih.gov','pubmed.ncbi.nlm.nih.gov','researchgate.net','www.researchgate.net','openaccess.thecvf.com',
      'papers.nips.cc','ojs.aaai.org','proceedings.mlr.press'
    ]);
    const pubPathHints = ['/doi/','/abs/','/article/','/document/','/paper/','/publication/'];
    if (pubHosts.has(host)) return host.includes('researchgate.net') ? path.includes('/publication/') : true;
    return pubPathHints.some(h => path.includes(h));
  } catch { return false; }
}

function applyFiltersSort() {
  const yf = parseYear(yearFromEl?.value);
  const yt = parseYear(yearToEl?.value);
  const venueQ = (venueInputEl?.value || '').trim().toLowerCase();
  const typeQ = (typeSelectEl?.value || 'any').toLowerCase();
  const sort = (sortSelectEl?.value || 'relevance');
  const includeWeb = !!(includeWebEl && includeWebEl.checked);

  let arr = __allItems.slice();
  arr = arr.filter(it => {
    const t = (it.type || 'web').toLowerCase();
    if (!includeWeb && t === 'web') return false;
    if (includeWeb && t === 'web' && !isPublicationLike(it.link)) return false;
    if (yf && it.year && it.year < yf) return false;
    if (yt && it.year && it.year > yt) return false;
    if (venueQ && (!it.venue || !it.venue.toLowerCase().includes(venueQ))) return false;
    if (typeQ !== 'any' && t !== typeQ) return false;
    return true;
  });

  if (sort === 'yearDesc') arr.sort((a, b) => (b.year || -Infinity) - (a.year || -Infinity));
  else if (sort === 'yearAsc') arr.sort((a, b) => (a.year || Infinity) - (b.year || Infinity));

  renderResults(arr);
  if (resultsMetaEl) {
    const pubs = arr.filter(x => (x.type || 'web') !== 'web').length;
    resultsMetaEl.innerHTML = `<span class="results-count">${arr.length} shown</span> • <span class="pubs-count">${pubs}</span> / <span class="pubs-total">${__totalPublications || pubs}</span> publications`;
  }
}

// --- MAIN SEARCH PIPELINE (single, final version) ---
async function searchAndSummarize(query, opts = {}) {
  try {
    renderLoading();
    if (opts?.name && sortSelectEl) sortSelectEl.value = 'yearDesc';

    // web search + summary
    const webPromise = fetchJSON('/api/query', {
      method: 'POST',
      body: JSON.stringify({ query })
    });

    // publications by author
    const maybeName = opts.name || facultyInput.value?.trim();
    const pubsPromise = maybeName
      ? fetchJSON('/api/authorPublications', {
          method: 'POST',
          body: JSON.stringify({
            name: maybeName,
            affiliation: opts.affiliation || '',
            department: opts.department || ''
          })
        })
      : null;

    const data = await webPromise;
    if (!data) throw new Error('Empty response from /api/query');

    const baseItems = (Array.isArray(data.items) ? data.items : []).map(it => ({
      title: it.title,
      snippet: it.snippet,
      link: it.link,
      source: it.source,
      year: null,
      venue: '',
      type: 'web'
    }));

    let pubItems = [];
    if (pubsPromise) {
      try {
        const pjson = await pubsPromise;
        if (Array.isArray(pjson.publications)) {
          pubItems = pjson.publications.map(pub => ({
            title: pub.title,
            snippet: [pub.venue || '', pub.year || ''].filter(Boolean).join(' • '),
            link: pub.url || '',
            source: pub.url ? new URL(pub.url).hostname : 'publication',
            year: pub.year || null,
            venue: pub.venue || '',
            type: (pub.type || 'other').toLowerCase(),
            authors: Array.isArray(pub.authors) ? pub.authors : [],
            doi: pub.doi || ''
          }));
          if (pjson.metrics) {
            if (kpiTotalPubsEl) kpiTotalPubsEl.textContent = String(pjson.metrics.totalPublications ?? pubItems.length);
            if (kpiUpdatedEl) {
              const d = pjson.metrics.lastUpdated ? new Date(pjson.metrics.lastUpdated) : null;
              kpiUpdatedEl.textContent = d && !isNaN(d) ? d.toLocaleDateString() : '—';
            }
          } else {
            if (kpiTotalPubsEl) kpiTotalPubsEl.textContent = String(pubItems.length);
            if (kpiUpdatedEl) kpiUpdatedEl.textContent = '—';
          }
        }
      } catch (e) {
        console.warn('Publications fetch failed', e);
      }
    }

    const merged = [...baseItems, ...pubItems];
    const seen = new Set();
    __allItems = merged.filter(it => {
      const k = it.link || '';
      if (!k) return true;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    __totalPublications = __allItems.filter(x => (x.type || 'web') !== 'web').length;
    if (kpiTotalPubsEl) kpiTotalPubsEl.textContent = String(__totalPublications);

    applyFiltersSort();

    summaryContent.textContent = data.summary || 'No summary available.';
    summarySection.style.display = 'block';
  } catch (err) {
    console.error(err);
    resultsList.innerHTML = `<div class="card"><div>Error: ${String(err.message || err)}</div></div>`;
    summaryContent.textContent = 'Unable to generate summary.';
  }
}

// --- UI wiring ---
function onFindPublications() {
  const college = (collegeSelect.value === 'Others' ? (collegeOtherInput.value || '').trim() : (collegeSelect.value || '').trim());
  const dept    = (deptSelect.value === 'Others'   ? (deptOtherInput.value || '').trim()   : (deptSelect.value || '').trim());
  const faculty = (facultyInput.value || '').trim();

  if (!faculty) return facultyInput.focus();
  if ((collegeSelect.value === 'Others') && !college) return collegeOtherInput.focus();
  if ((deptSelect.value === 'Others') && !dept) return deptOtherInput.focus();

  const parts = [faculty, dept, college].filter(Boolean);
  parts.push('publications');

  searchAndSummarize(parts.join(' '), { name: faculty, affiliation: college, department: dept });
}

findBtn.addEventListener('click', onFindPublications);
facultyInput.addEventListener('keydown', e => { if (e.key === 'Enter') onFindPublications(); });

function syncOthersVisibility() {
  collegeOtherInput.style.display = (collegeSelect.value === 'Others') ? 'block' : 'none';
  deptOtherInput.style.display    = (deptSelect.value === 'Others')    ? 'block' : 'none';
}
collegeSelect.addEventListener('change', syncOthersVisibility);
deptSelect.addEventListener('change', syncOthersVisibility);
syncOthersVisibility();

toggleSummary.addEventListener('click', () => {
  const hidden = summaryContent.style.display === 'none';
  summaryContent.style.display = hidden ? 'block' : 'none';
  toggleSummary.textContent = hidden ? 'Hide' : 'Show';
  toggleSummary.setAttribute('aria-expanded', String(hidden));
});
