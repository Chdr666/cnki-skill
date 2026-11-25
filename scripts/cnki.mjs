#!/usr/bin/env node
/**
 * cnki-search - zero-dependency CNKI (中国知网) retrieval for AI agent skills.
 *
 * Commands:
 *   node scripts/cnki.mjs search "<query>" [--max N] [--sort relevance|date|downloads|cited] [--page N] [--json]
 *   node scripts/cnki.mjs article <url-or-file-name>[,<...>] [--json]
 *
 * Data source: the public 知网空间 index (https://search.cnki.com.cn) and the
 * public detail pages on https://www.cnki.com.cn. Only records actually
 * returned by those endpoints are emitted; nothing is invented.
 *
 * Environment: CNKI_TIMEOUT_MS, CNKI_MIN_INTERVAL_MS, CNKI_MAX_ATTEMPTS.
 * Requires Node.js >= 20 (global fetch).
 */

import process from 'node:process';

const MAX_RESULTS = 20;
const MAX_PAGE = 50;
const PAGE_SIZE = 20;
const MAX_ATTEMPTS = 5;
const TOOL_ID = 'cnki-search-skill';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';
const BASE_URL = 'https://search.cnki.com.cn';
const DETAIL_BASE_URL = 'https://www.cnki.com.cn';
const CPFD_BASE_URL = 'https://cpfd.cnki.com.cn';
const CCND_BASE_URL = 'https://mall.cnki.net';
const SEARCH_PATH = '/api/search/listresult';

const SORT_ORDERS = Object.freeze({ relevance: '1', date: '2', downloads: '3', cited: '4' });

function resolveConfig(options = {}) {
  const fromEnv = process.env;
  const integer = (value, fallback, min, max) => {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
  };
  return {
    timeoutMs: integer(options.timeout ?? fromEnv.CNKI_TIMEOUT_MS, 20000, 3000, 60000),
    minIntervalMs: integer(options.interval ?? fromEnv.CNKI_MIN_INTERVAL_MS, 2000, 0, 15000),
    maxAttempts: integer(options.attempts ?? fromEnv.CNKI_MAX_ATTEMPTS, 3, 1, MAX_ATTEMPTS),
    maxResults: 8,
    maxAbstractChars: 1500,
    baseUrl: BASE_URL,
    detailBaseUrl: DETAIL_BASE_URL,
    cpfdBaseUrl: CPFD_BASE_URL,
    ccndBaseUrl: CCND_BASE_URL,
  };
}

// ---------------------------------------------------------------- requests

function abortError() {
  const error = new Error('CNKI request aborted');
  error.name = 'AbortError';
  return error;
}

function createTimeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), ms);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return controller.signal;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let queueTail = Promise.resolve();
let lastRequestAt = 0;

function scheduleRequest(intervalMs, task) {
  const run = queueTail.then(async () => {
    const waitMs = lastRequestAt + intervalMs - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    lastRequestAt = Date.now();
    return task();
  });
  queueTail = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Perform one HTTP request with a hard timeout. Throws on network/timeout
 * failures; resolves with { status, ok, text } for any HTTP response.
 */
async function requestOnce(url, { method = 'GET', headers = {}, body } = {}, timeoutMs = 20000) {
  let response;
  try {
    response = await fetch(url, { method, headers, body, signal: createTimeoutSignal(timeoutMs) });
  } catch (error) {
    if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new Error(`CNKI request timed out after ${timeoutMs}ms`);
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
  const text = await response.text();
  return { status: response.status, ok: response.ok, text };
}

function isSecurityPage(text) {
  return /安全验证|人机验证|captcha|verify\/js|滑动验证/i.test(String(text ?? ''));
}

function snippetOf(text) {
  return String(text ?? '').replace(/\s+/g, ' ').slice(0, 300);
}

// ----------------------------------------------------------------- parsing

function decodeEntities(value) {
  const fromCode = (code) => {
    try {
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    } catch {
      return '';
    }
  };
  return String(value ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => fromCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => fromCode(Number.parseInt(dec, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

/** Strip tags/entities and collapse whitespace in a scraped HTML fragment. */
export function cleanText(fragment) {
  const stripped = String(fragment ?? '').replace(/<[^>]*>/g, ' ');
  return decodeEntities(stripped).replace(/\s+/g, ' ').trim();
}

/** Remove 知网空间 keyword-highlight markers `~#@keyword@#~`. */
export function cleanTitle(title) {
  return String(title ?? '')
    .replace(/~#@/g, '')
    .replace(/@#~/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split the API's `作者1;作者2;` / `关键词1;;关键词2` separator lists. */
export function splitList(value) {
  return String(value ?? '')
    .split(/[;；]+/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function toInt(value) {
  const number = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(number) ? number : 0;
}

/**
 * Build the public, openable detail URL for one 知网空间 record. Journal
 * articles open on www.cnki.com.cn; conference papers and newspapers have
 * their own paths. Theses need a school code the API does not expose, so
 * they get '' and are reported as skipped instead of a guessed link.
 */
export function buildDetailUrl(item, cfg = resolveConfig()) {
  if (item === null || typeof item !== 'object') return '';
  const fileName = String(item.fileName ?? '').trim();
  if (!/^[A-Za-z0-9]+$/.test(fileName)) return '';
  const dbType = String(item.dbType ?? '').trim().toUpperCase();
  if (!dbType || dbType === 'CJFD') {
    return `${cfg.detailBaseUrl}/Article/CJFDTOTAL-${fileName}.htm`;
  }
  if (dbType === 'CPFD' || dbType === 'IPFD') {
    return `${cfg.cpfdBaseUrl}/Article/CPFDTOTAL-${fileName}.htm`;
  }
  if (dbType === 'CCND') {
    return `${cfg.ccndBaseUrl}/magazine/article/CCND/${fileName}.htm`;
  }
  return '';
}

export function buildSearchBody(query, order = '1', page = 1) {
  return new URLSearchParams({
    searchType: 'MulityTermsSearch',
    ArticleType: '0',
    Type: '0',
    ParamIsNullOrEmpty: 'true',
    Islegal: 'false',
    Order: String(order),
    Page: String(page),
    PageIndex: String(page),
    Theme: String(query),
  }).toString();
}

/**
 * Map the `articleList` payload into records. Records whose public detail URL
 * cannot be built are counted in `skipped` and dropped, so every returned
 * record really does have an openable page.
 */
export function parseSearchPayload(payload, options = {}) {
  const maxAbstractChars = Number.isInteger(options.maxAbstractChars) ? options.maxAbstractChars : 1500;
  const cfg = options.config ?? resolveConfig(undefined);
  const raw = payload !== null && typeof payload === 'object' ? payload : {};
  const total = Math.max(0, toInt(raw.totalCount));
  const list = Array.isArray(raw.articleList) ? raw.articleList : [];
  const pageIndex = Math.max(1, toInt(raw.pageIndex) || 1);
  const pageSize = Math.max(1, toInt(raw.pageSize) || PAGE_SIZE);
  const records = [];
  let skipped = 0;
  for (const item of list) {
    if (item === null || typeof item !== 'object') {
      skipped += 1;
      continue;
    }
    const title = cleanTitle(item.title);
    const url = buildDetailUrl(item, cfg);
    if (!title || !url) {
      skipped += 1;
      continue;
    }
    let abstract = cleanTitle(cleanText(item.summary));
    if (abstract.length > maxAbstractChars) abstract = `${abstract.slice(0, maxAbstractChars)}...`;
    records.push({
      title,
      authors: splitList(item.author),
      source: String(item.originate ?? '').trim(),
      year: String(item.year ?? '').trim(),
      issue: String(item.period ?? '').trim(),
      publish_date: String(item.publishTime ?? '').trim(),
      type: String(item.arcitleType ?? item.dbSource ?? '').trim(),
      downloads: toInt(item.downloadCount),
      citations: toInt(item.quoteCount),
      keywords: splitList(item.keyWord).map(cleanTitle),
      abstract_snippet: abstract,
      url,
      file_name: String(item.fileName ?? '').trim(),
    });
  }
  return { total, records, skipped, pageIndex, pageSize };
}

/**
 * Extract everything the public detail page exposes: title, authors, journal
 * and issue, keywords, and the (usually truncated) public abstract.
 */
export function parseDetailHtml(html, options = {}) {
  const maxAbstractChars = Number.isInteger(options.maxAbstractChars) ? options.maxAbstractChars : 1500;
  const source = typeof html === 'string' ? html : '';

  const h1 = source.match(/<h1[^>]*class="[^"]*xx_title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) || source.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = h1 ? cleanTitle(cleanText(h1[1])) : '';

  const titleTag = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const titleText = titleTag ? cleanText(titleTag[1]) : '';
  const venueMatch = titleText.match(/--《([^》]+)》\s*(\d{4})\s*年\s*([0-9A-Za-z]+)\s*期/);
  let journalTitle = venueMatch ? venueMatch[1].trim() : '';
  if (!journalTitle) journalTitle = (titleText.split('--《')[1] ?? '').split('》')[0].trim();
  const year = venueMatch ? venueMatch[2] : '';
  const issue = venueMatch ? venueMatch[3] : '';

  const authors = [];
  const authorRe = /<a[^>]+href="[^"]*Search\/Result\?author=[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let authorMatch;
  while ((authorMatch = authorRe.exec(source)) !== null) {
    const name = cleanTitle(cleanText(authorMatch[1]));
    if (name && !authors.includes(name)) authors.push(name);
  }

  const blocks = [];
  const blockRe = /<div[^>]*class="[^"]*xx_font[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  let blockMatch;
  while ((blockMatch = blockRe.exec(source)) !== null) blocks.push(blockMatch[1]);

  let abstract = '';
  let keywords = [];
  for (const block of blocks) {
    const text = cleanText(block);
    if (!abstract && text.includes('【摘要】')) {
      abstract = text.replace(/^.*?【摘要】\s*[:：]?\s*/, '').trim();
    }
    if (text.includes('【关键词】')) {
      const tail = text.replace(/^.*?【关键词】\s*[:：]?\s*/, '').trim();
      const parts = tail.split(/[;；]/).map((part) => cleanTitle(part)).filter(Boolean);
      if (parts.length > 0) keywords = parts;
    }
  }

  let abstractTruncated = false;
  if (abstract) {
    abstractTruncated = /(\.\.\.|…)\s*$/.test(abstract);
    if (abstractTruncated) abstract = abstract.replace(/\.\.\.\s*$|…\s*$/, '').trim();
    if (abstract.length > maxAbstractChars) {
      abstract = `${abstract.slice(0, maxAbstractChars)}...`;
      abstractTruncated = true;
    }
  }

  return { title, authors, source: journalTitle, year, issue, keywords, abstract, abstract_truncated: abstractTruncated };
}

function isAllowedCnkiUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'cnki.com.cn' || host.endsWith('.cnki.com.cn') || host === 'cnki.net' || host.endsWith('.cnki.net');
}

function fileNameFromUrl(value) {
  const match = String(value ?? '').match(/(?:CJFDTOTAL|CPFDTOTAL|CDMD|CCND)[-_]?([A-Za-z0-9]+)\.htm/i);
  if (match) return match[1];
  const tail = String(value ?? '').split('/').pop() ?? '';
  return tail.replace(/\.html?$/i, '').replace(/[^A-Za-z0-9]/g, '');
}

// ------------------------------------------------------------------ search

async function requestSearchPayload(query, cfg, sort, page) {
  const order = SORT_ORDERS[sort] ?? SORT_ORDERS.relevance;
  const body = buildSearchBody(query, order, page);
  const url = `${cfg.baseUrl}${SEARCH_PATH}`;
  const headers = {
    'User-Agent': USER_AGENT,
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    origin: cfg.baseUrl,
    referer: `${cfg.baseUrl}/Search/Result?content=${encodeURIComponent(query)}`,
    'x-requested-with': 'XMLHttpRequest',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  };

  let lastError = null;
  for (let attempt = 0; attempt < cfg.maxAttempts; attempt += 1) {
    try {
      const response = await scheduleRequest(cfg.minIntervalMs, () =>
        requestOnce(url, { method: 'POST', headers, body }, cfg.timeoutMs),
      );
      if (!response.ok) {
        const retryableStatus = response.status === 408 || response.status === 429 || response.status >= 500;
        const error = new Error(`CNKI search API returned HTTP ${response.status}: ${snippetOf(response.text)}`);
        error.retryable = retryableStatus;
        throw error;
      }
      if (isSecurityPage(response.text)) {
        const error = new Error('CNKI returned a security-verification page instead of search results');
        error.retryable = true;
        throw error;
      }
      try {
        return JSON.parse(response.text);
      } catch {
        const error = new Error('CNKI search API returned a non-JSON response');
        error.retryable = true;
        throw error;
      }
    } catch (error) {
      if (error && error.name === 'AbortError') throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
      const retryable = lastError.retryable !== false;
      if (!retryable || attempt + 1 >= cfg.maxAttempts) break;
      await sleep(2000 * (attempt + 1));
    }
  }
  throw lastError ?? new Error('CNKI search request failed');
}

/**
 * Search the public 知网空间 index and return real records with openable URLs.
 *
 * @param {string} query
 * @param {{maxResults?: number, sort?: 'relevance'|'date'|'downloads'|'cited', page?: number, timeout?: number, interval?: number, attempts?: number}} [options]
 */
export async function search(query, options = {}) {
  const text = typeof query === 'string' ? query.trim() : '';
  if (!text) throw new Error('query must be a non-empty string');
  if (text.length > 200) throw new Error('query is too long; keep it under 200 characters');
  const cfg = resolveConfig(options);
  const maxResults = Number.isInteger(options.maxResults) ? Math.min(MAX_RESULTS, Math.max(1, options.maxResults)) : 8;
  const sort = Object.hasOwn(SORT_ORDERS, options.sort ?? '') ? options.sort : 'relevance';
  const page = Number.isInteger(options.page) ? Math.min(MAX_PAGE, Math.max(1, options.page)) : 1;
  const payload = await requestSearchPayload(text, cfg, sort, page);
  const parsed = parseSearchPayload(payload, { maxAbstractChars: cfg.maxAbstractChars, config: cfg });
  const results = parsed.records.slice(0, maxResults);
  return {
    query: text,
    sort,
    page,
    total: parsed.total,
    results,
    skipped: parsed.skipped,
    truncated: parsed.total > page * parsed.pageSize || parsed.records.length > results.length,
  };
}

// ----------------------------------------------------------------- article

async function requestDetailHtml(url, cfg) {
  const headers = {
    'User-Agent': USER_AGENT,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    referer: `${cfg.baseUrl}/`,
  };
  let lastError = null;
  for (let attempt = 0; attempt < cfg.maxAttempts; attempt += 1) {
    try {
      const response = await scheduleRequest(cfg.minIntervalMs, () => requestOnce(url, { headers }, cfg.timeoutMs));
      if (response.status === 404 || response.status === 410) return { missing: true, note: `the CNKI page returned HTTP ${response.status}` };
      if (!response.ok) {
        const retryableStatus = response.status === 408 || response.status === 429 || response.status >= 500;
        const error = new Error(`CNKI detail page returned HTTP ${response.status}: ${snippetOf(response.text)}`);
        error.retryable = retryableStatus;
        throw error;
      }
      if (isSecurityPage(response.text)) {
        const error = new Error('CNKI returned a security-verification page instead of the article');
        error.retryable = true;
        throw error;
      }
      return { missing: false, html: response.text, note: '' };
    } catch (error) {
      if (error && error.name === 'AbortError') throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
      if (lastError.retryable === false || attempt + 1 >= cfg.maxAttempts) break;
      await sleep(2000 * (attempt + 1));
    }
  }
  return { missing: true, note: lastError ? lastError.message : 'the CNKI page could not be fetched' };
}

/**
 * Open one public CNKI detail page. Never throws for a missing/unparsable
 * page: the returned record has found=false with a reason the caller must
 * surface instead of citing the paper.
 *
 * @param {string} input a CNKI detail URL or a CNKI file name
 * @param {{timeout?: number, interval?: number, attempts?: number, maxAbstractChars?: number}} [options]
 */
export async function fetchPaper(input, options = {}) {
  const cfg = resolveConfig(options);
  const raw = typeof input === 'string' ? input.trim() : '';
  let url = '';
  let fileName = '';
  if (/^https?:\/\//i.test(raw)) {
    if (!isAllowedCnkiUrl(raw)) {
      return {
        found: false,
        title: '',
        url: raw,
        file_name: '',
        note: 'this is not a CNKI detail URL; only cnki.com.cn / *.cnki.com.cn / *.cnki.net pages can be opened',
      };
    }
    url = raw;
    fileName = fileNameFromUrl(raw);
  } else if (/^[A-Za-z0-9]+$/.test(raw)) {
    fileName = raw;
    url = `${cfg.detailBaseUrl}/Article/CJFDTOTAL-${fileName}.htm`;
  } else {
    return { found: false, title: '', url: raw, file_name: '', note: 'provide a CNKI detail URL or a CNKI file name' };
  }

  const response = await requestDetailHtml(url, cfg);
  if (response.missing) {
    return { found: false, title: '', url, file_name: fileName, note: response.note };
  }
  const parsed = parseDetailHtml(response.html, { maxAbstractChars: options.maxAbstractChars ?? cfg.maxAbstractChars });
  if (!parsed.title) {
    return { found: false, title: '', url, file_name: fileName, note: 'the page opened but no article title could be parsed' };
  }
  return {
    found: true,
    title: parsed.title,
    authors: parsed.authors,
    source: parsed.source,
    year: parsed.year,
    issue: parsed.issue,
    keywords: parsed.keywords,
    abstract: parsed.abstract,
    abstract_truncated: parsed.abstract_truncated,
    url,
    file_name: fileName,
    note: '',
  };
}

/**
 * Open several CNKI detail pages serially.
 *
 * @param {Array<string>} inputs
 * @param {object} [options]
 */
export async function fetchArticles(inputs, options = {}) {
  const list = Array.isArray(inputs) ? inputs : [inputs];
  const papers = [];
  const missing = [];
  const seen = new Set();
  for (const input of list) {
    const raw = typeof input === 'string' ? input.trim() : '';
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    const paper = await fetchPaper(raw, options);
    papers.push(paper);
    if (!paper.found) missing.push(raw);
  }
  if (papers.length === 0) throw new Error('provide at least one CNKI URL or file name');
  return { papers, missing };
}

// --------------------------------------------------------------- formatting

function formatAuthors(authors, keep = 6) {
  if (!Array.isArray(authors) || authors.length === 0) return '(authors unavailable)';
  const shown = authors.slice(0, keep);
  return `${shown.join(', ')}${authors.length > shown.length ? ', et al.' : ''}`;
}

export function formatSearchText(value) {
  const lines = [`CNKI 知网空间 search "${value.query}" — ${value.total} record(s) matched.`];
  if (!Array.isArray(value.results) || value.results.length === 0) {
    lines.push('No CNKI record matched this query.');
    lines.push('Do not cite any paper for this topic and do not invent a citation: report that 知网 returned no matching record.');
    return lines.join('\n');
  }
  lines.push(
    value.truncated
      ? `Showing ${value.results.length} record(s); more matches exist (refine the query or request the next page).`
      : `Showing ${value.results.length} record(s).`,
    '',
  );
  value.results.forEach((record, index) => {
    lines.push(`${index + 1}. ${record.title}`);
    lines.push(`   Authors: ${formatAuthors(record.authors)}`);
    const venue = [record.source, record.year ? `${record.year}年` : '', record.issue ? `${record.issue}期` : ''].filter(Boolean).join(' ');
    const stats = [record.type, record.downloads ? `downloads ${record.downloads}` : '', record.citations ? `cited ${record.citations}` : '']
      .filter(Boolean)
      .join(' · ');
    lines.push(`   Journal: ${venue || '(venue unavailable)'}${stats ? ` · ${stats}` : ''}`);
    if (record.keywords.length > 0) lines.push(`   Keywords: ${record.keywords.join('; ')}`);
    if (record.abstract_snippet) lines.push(`   Abstract (public snippet): ${record.abstract_snippet}`);
    lines.push(`   URL: ${record.url}`, `   CNKI file name: ${record.file_name}`);
  });
  lines.push(
    '',
    'Every entry above is a real record in CNKI 知网空间; cite only the titles and cnki.com.cn URLs above. Call the article command on a URL before quoting an abstract: the public abstract is usually truncated, and full text may require a CNKI account.',
  );
  return lines.join('\n');
}

export function formatArticleText(value) {
  const blocks = [];
  for (const paper of value.papers ?? []) {
    if (!paper.found) {
      blocks.push(
        [
          `CNKI paper NOT verified: ${paper.url || '(invalid input)'}`,
          `Reason: ${paper.note || 'the page could not be verified'}`,
          'Do not cite this paper and do not present its title, authors or abstract as verified literature.',
        ].join('\n'),
      );
      continue;
    }
    const lines = [`CNKI paper: ${paper.title}`, `Authors: ${formatAuthors(paper.authors)}`];
    const venue = [paper.source, paper.year ? `${paper.year}年` : '', paper.issue ? `${paper.issue}期` : ''].filter(Boolean).join(' ');
    lines.push(`Journal: ${venue || '(venue unavailable)'}`);
    if (paper.keywords.length > 0) lines.push(`Keywords: ${paper.keywords.join('; ')}`);
    lines.push(`URL: ${paper.url}`, `CNKI file name: ${paper.file_name}`);
    const label = paper.abstract_truncated ? 'Abstract (public page, truncated)' : 'Abstract (public page)';
    lines.push(`${label}: ${paper.abstract || '(no public abstract on this page)'}`);
    lines.push('This metadata comes from the public CNKI page above; quote only what is visible here, and note that the full text may require a CNKI account.');
    blocks.push(lines.join('\n'));
  }
  if (blocks.length === 0) blocks.push('No CNKI record was returned for the requested input.');
  return blocks.join('\n\n');
}

// --------------------------------------------------------------------- CLI

const HELP = `cnki-search - real CNKI 知网 retrieval for AI agents

Usage:
  node scripts/cnki.mjs search "<query>" [--max N] [--sort MODE] [--page N] [--json]
  node scripts/cnki.mjs article <url-or-file-name>[,<...>] [--json]

Options:
  --max N        records for search (1-${MAX_RESULTS}, default 8)
  --sort MODE    relevance (default), date, downloads or cited
  --page N       result page (1-${MAX_PAGE}, 20 records per page)
  --json         print machine-readable JSON instead of text
  --timeout MS   per-request timeout (default: env CNKI_TIMEOUT_MS or 20000)
  --interval MS  minimum gap between requests (default: env CNKI_MIN_INTERVAL_MS or 2000)
  --attempts N   attempts per request (1-${MAX_ATTEMPTS}, default: env CNKI_MAX_ATTEMPTS or 3)
  -h, --help     show this help

Examples:
  node scripts/cnki.mjs search "疫苗" --max 5
  node scripts/cnki.mjs search "人工智能 教育" --sort date --max 8
  node scripts/cnki.mjs article https://www.cnki.com.cn/Article/CJFDTOTAL-DCMY202603037.htm
  node scripts/cnki.mjs article DCMY202603037
`;

function parseCli(argv) {
  const [command, ...rest] = argv;
  const options = { json: false, maxResults: undefined, sort: 'relevance', page: undefined };
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === '--json') options.json = true;
    else if (token === '--max' || token === '-n') options.maxResults = Number(rest[(i += 1)]);
    else if (token === '--sort') options.sort = rest[(i += 1)];
    else if (token === '--page') options.page = Number(rest[(i += 1)]);
    else if (token === '--timeout') options.timeout = Number(rest[(i += 1)]);
    else if (token === '--interval') options.interval = Number(rest[(i += 1)]);
    else if (token === '--attempts') options.attempts = Number(rest[(i += 1)]);
    else if (token === '-h' || token === '--help') options.help = true;
    else if (token.startsWith('--')) throw new Error(`unknown option ${token}`);
    else positional.push(token);
  }
  return { command, positional, options };
}

function jsonOut(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const { command, positional, options } = parseCli(argv);
  const runOptions = {
    timeout: options.timeout,
    interval: options.interval,
    attempts: options.attempts,
  };

  if (!command || command === '-h' || command === '--help' || options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === 'search') {
    const query = positional.join(' ').trim();
    if (!query) throw new Error('search requires a query string');
    const value = await search(query, { ...runOptions, maxResults: options.maxResults, sort: options.sort, page: options.page });
    if (options.json) jsonOut(value);
    else process.stdout.write(`${formatSearchText(value)}\n`);
    return 0;
  }
  if (command === 'article') {
    const raw = positional.join(' ').trim();
    if (!raw) throw new Error('article requires one or more CNKI URLs or file names');
    const value = await fetchArticles(raw.split(/[\s,]+/).filter(Boolean), runOptions);
    if (options.json) jsonOut(value);
    else process.stdout.write(`${formatArticleText(value)}\n`);
    return 0;
  }
  throw new Error(`unknown command "${command}" (expected search or article)`);
}

const isDirectRun = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/scripts/cnki.mjs');
if (isDirectRun) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`cnki-search: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
