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
// Filter/sort controls
const yearFromEl = document.getElementById('yearFrom');
const yearToEl = document.getElementById('yearTo');
const venueInputEl = document.getElementById('venueInput');
const typeSelectEl = document.getElementById('typeSelect');
const sortSelectEl = document.getElementById('sortSelect');
const applyFiltersBtn = document.getElementById('applyFilters');
const includeWebEl = document.getElementById('includeWeb');
const resultsMetaEl = document.getElementById('resultsMeta');
// KPI elements
const kpiTotalPubsEl = document.getElementById('kpiTotalPubs');
const kpiUpdatedEl = document.getElementById('kpiUpdated');

function renderLoading() {
  resultsList.innerHTML = '<div class="card"><div>Loading results…</div></div>';
  summaryContent.textContent = 'Generating summary…';
}

function rowTemplate(item) {
  let hostname = '';
  try {
    hostname = item.link ? new URL(item.link).hostname : '';
  } catch (_) {
    hostname = '';
  }
  const hasDOI = !!(item.doi && String(item.doi).trim());
  const doiSlug = hasDOI ? String(item.doi).replace(/^https?:\/\/doi\.org\//i, '') : '';
  const actionParts = [];
  if (item.link) actionParts.push(`<button class="view-btn" data-link="${item.link}">View</button>`);
  if (hasDOI) actionParts.push(`<button class="view-btn open-doi-btn" data-doi="${doiSlug}">Open DOI</button>`);
  if (hasDOI) actionParts.push(`<button class="view-btn copy-doi-btn" data-doi="${doiSlug}">Copy DOI</button>`);
  const action = actionParts.join(' ');
  const safe = (v) => (v == null ? '' : String(v));
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
    btn.addEventListener('click', () => {
      const link = btn.getAttribute('data-link');
      window.open(link, '_blank', 'noopener');
    });
  });
  // Open DOI buttons
  resultsList.querySelectorAll('.open-doi-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const doi = btn.getAttribute('data-doi');
      if (doi) window.open(`https://doi.org/${doi}`, '_blank', 'noopener');
    });
  });
  // Copy DOI buttons
  resultsList.querySelectorAll('.copy-doi-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const doi = btn.getAttribute('data-doi');
      if (!doi) return;
      try {
        await navigator.clipboard.writeText(doi);
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy DOI'; }, 1000);
      } catch (_) {
        // Fallback: create temporary input
        const el = document.createElement('input');
        el.value = doi;
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy DOI'; }, 1000);
      }
    });
  });
}

let __allItems = [];
let __totalPublications = 0;

function renderResults(items) {
  if (!items || items.length === 0) {
    resultsList.innerHTML = '<div class="card"><div>No results found.</div></div>';
    if (resultsMetaEl) {
      const totalPubs = __totalPublications || 0;
      resultsMetaEl.innerHTML = `<span class="results-count">0 shown</span> • <span class="pubs-count">0</span> / <span class=\"pubs-total\">${totalPubs}</span> publications`;
    }
    return;
  }
  const header = `
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
      <tbody>
        ${items.map(rowTemplate).join('')}
      </tbody>
    </table>
  `;
  resultsList.innerHTML = header;
  bindCardButtons();
}

function parseYear(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return null;
  return n;
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
    // publications-only by default
    const itemType = (it.type || 'web').toLowerCase();
    if (!includeWeb && itemType === 'web') return false;
    // if web results are included, keep only publication-like web links
    if (includeWeb && itemType === 'web') {
      if (!isPublicationLike(it.link)) return false;
    }
    if (yf && it.year && it.year < yf) return false;
    if (yt && it.year && it.year > yt) return false;
    if (venueQ && (!it.venue || !it.venue.toLowerCase().includes(venueQ))) return false;
    if (typeQ !== 'any') {
      const t = itemType;
      if (t !== typeQ) return false;
    }
    return true;
  });

  if (sort === 'yearDesc') {
    arr.sort((a, b) => (b.year || -Infinity) - (a.year || -Infinity));
  } else if (sort === 'yearAsc') {
    arr.sort((a, b) => (a.year || Infinity) - (b.year || Infinity));
  } // relevance = keep original order

  renderResults(arr);
  // Update counts
  if (resultsMetaEl) {
    const pubs = arr.filter(x => (x.type || 'web') !== 'web').length;
    const totalPubs = __totalPublications || pubs;
    resultsMetaEl.innerHTML = `<span class="results-count">${arr.length} shown</span> • <span class="pubs-count">${pubs}</span> / <span class=\"pubs-total\">${totalPubs}</span> publications`;
  }
}

function isPublicationLike(href) {
  if (!href) return false;
  try {
    const u = new URL(href);
    const host = (u.hostname || '').toLowerCase();
    const path = (u.pathname || '').toLowerCase();
    const pubHosts = new Set([
      'arxiv.org',
      'ieeexplore.ieee.org',
      'dl.acm.org',
      'link.springer.com',
      'sciencedirect.com',
      'www.sciencedirect.com',
      'nature.com',
      'www.nature.com',
      'mdpi.com',
      'www.mdpi.com',
      'onlinelibrary.wiley.com',
      'tandfonline.com',
      'www.tandfonline.com',
      'ncbi.nlm.nih.gov',
      'pubmed.ncbi.nlm.nih.gov',
      'researchgate.net',
      'www.researchgate.net',
      'openaccess.thecvf.com',
      'papers.nips.cc',
      'ojs.aaai.org',
      'proceedings.mlr.press'
    ]);
    const pubPathHints = ['/doi/', '/abs/', '/article/', '/document/', '/paper/', '/publication/'];
    if (pubHosts.has(host)) {
      // For ResearchGate, ensure it points to a publication page
      if (host.includes('researchgate.net')) return path.includes('/publication/');
      return true;
    }
    return pubPathHints.some(h => path.includes(h));
  } catch (_) {
    return false;
  }
}

async function searchAndSummarize(query, opts = {}) {
  try {
    renderLoading();
    // Default sort to Year ↓ when we have a faculty name
    if (opts?.name && sortSelectEl) {
      sortSelectEl.value = 'yearDesc';
    }

    // Kick off two requests in parallel: web query+summary and author publications
    const webPromise = fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });

    // Try to infer faculty name from query (first token(s) before known words)
    const maybeName = opts.name || facultyInput.value?.trim();
    const pubsPayload = maybeName ? {
      name: maybeName,
      affiliation: opts.affiliation || '',
      department: opts.department || ''
    } : null;
    const pubsPromise = maybeName
      ? fetch('/api/authorPublications', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(pubsPayload)
        })
      : null;

    const resp = await webPromise;
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Request failed');

    // Prepare base items from web search
    const baseItems = (Array.isArray(data.items) ? data.items : []).map(it => ({
      title: it.title,
      snippet: it.snippet,
      link: it.link,
      source: it.source,
      year: null,
      venue: '',
      type: 'web'
    }));

    // Attempt to retrieve publications and merge
    let pubItems = [];
    if (pubsPromise) {
      try {
        const presp = await pubsPromise;
        const pjson = await presp.json();
        if (presp.ok && Array.isArray(pjson.publications)) {
          pubItems = pjson.publications.map(pub => {
            const link = pub.url || '';
            let hostname = '';
            try { hostname = link ? new URL(link).hostname : ''; } catch (_) {}
            return {
              title: pub.title,
              snippet: [pub.venue || '', pub.year || ''].filter(Boolean).join(' • '),
              link,
              source: hostname || 'publication',
              year: pub.year || null,
              venue: pub.venue || '',
              type: (pub.type || 'other').toLowerCase(),
              authors: Array.isArray(pub.authors) ? pub.authors : [],
              doi: pub.doi || ''
            };
          });
          // Update KPI cards if available
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
        console.warn('Publications fetch/parse failed', e);
        if (kpiTotalPubsEl) kpiTotalPubsEl.textContent = '—';
        if (kpiUpdatedEl) kpiUpdatedEl.textContent = '—';
      }
    }

    // Merge and de-duplicate by link
    const mergedItems = [...baseItems, ...pubItems];
    const seen = new Set();
    __allItems = mergedItems.filter(it => {
      const k = it.link || '';
      if (!k) return true; // keep items without link
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    // Capture total publications after initial merge
    __totalPublications = __allItems.filter(x => (x.type || 'web') !== 'web').length;
    if (kpiTotalPubsEl && !isNaN(__totalPublications)) {
      kpiTotalPubsEl.textContent = String(__totalPublications);
    }
    applyFiltersSort();

    // Render summary
    summaryContent.textContent = data.summary || 'No summary available.';
    summarySection.style.display = 'block';

    // Publications are now merged into results list
  } catch (err) {
    console.error(err);
    resultsList.innerHTML = `<div class="card"><div>Error: ${String(err.message || err)}</div></div>`;
    summaryContent.textContent = 'Unable to generate summary.';
  }
}

// Bind filters
if (applyFiltersBtn) applyFiltersBtn.addEventListener('click', applyFiltersSort);
if (yearFromEl) yearFromEl.addEventListener('keydown', e => { if (e.key === 'Enter') applyFiltersSort(); });
if (yearToEl) yearToEl.addEventListener('keydown', e => { if (e.key === 'Enter') applyFiltersSort(); });
if (venueInputEl) venueInputEl.addEventListener('keydown', e => { if (e.key === 'Enter') applyFiltersSort(); });
if (typeSelectEl) typeSelectEl.addEventListener('change', applyFiltersSort);
if (sortSelectEl) sortSelectEl.addEventListener('change', applyFiltersSort);
if (includeWebEl) includeWebEl.addEventListener('change', applyFiltersSort);

function onFindPublications() {
  // Resolve actual values, using custom inputs if 'Others' is chosen
  const college = (collegeSelect.value === 'Others'
    ? (collegeOtherInput.value || '').trim()
    : (collegeSelect.value || '').trim());
  const dept = (deptSelect.value === 'Others'
    ? (deptOtherInput.value || '').trim()
    : (deptSelect.value || '').trim());
  const faculty = (facultyInput.value || '').trim();
  if (!faculty) {
    facultyInput.focus();
    return;
  }
  if ((collegeSelect.value === 'Others') && !college) {
    collegeOtherInput.focus();
    return;
  }
  if ((deptSelect.value === 'Others') && !dept) {
    deptOtherInput.focus();
    return;
  }
  // Construct a targeted query combining faculty, department, and college
  const parts = [];
  if (faculty) parts.push(faculty);
  if (dept) parts.push(dept);
  if (college) parts.push(college);
  parts.push('publications');
  const q = parts.join(' ');
  searchAndSummarize(q, { name: faculty, affiliation: college, department: dept });
}

findBtn.addEventListener('click', onFindPublications);
facultyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') onFindPublications();
});

function syncOthersVisibility() {
  const showCollegeOther = collegeSelect.value === 'Others';
  collegeOtherInput.style.display = showCollegeOther ? 'block' : 'none';
  const showDeptOther = deptSelect.value === 'Others';
  deptOtherInput.style.display = showDeptOther ? 'block' : 'none';
}

collegeSelect.addEventListener('change', syncOthersVisibility);
deptSelect.addEventListener('change', syncOthersVisibility);
// Initialize visibility on load
syncOthersVisibility();

toggleSummary.addEventListener('click', () => {
  const content = summaryContent;
  const isHidden = content.style.display === 'none';
  content.style.display = isHidden ? 'block' : 'none';
  toggleSummary.textContent = isHidden ? 'Hide' : 'Show';
  toggleSummary.setAttribute('aria-expanded', String(isHidden));
});

// GOOD:
await fetch(`/api/faculty?q=${encodeURIComponent(name)}&department=${encodeURIComponent(dept)}&college=${encodeURIComponent(college)}`)

await fetch(`/api/faculty/${facultyId}/publications?yearFrom=${y1}&yearTo=${y2}`)

// BAD (returns HTML → “Unexpected token '<'”):
// fetch('/faculty?...')
// fetch('/search?...')

