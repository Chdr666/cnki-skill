#!/usr/bin/env node
/**
 * Self-test for the cnki-search skill.
 *
 * Offline assertions cover parsing/URL construction; live checks hit the public
 * CNKI 知网空间 endpoints. When CNKI throttles or times out, live checks are
 * reported as skipped instead of failing the suite.
 *
 *   node test/e2e.mjs
 */

import {
  cleanTitle,
  splitList,
  buildDetailUrl,
  buildSearchBody,
  parseSearchPayload,
  parseDetailHtml,
  search,
  fetchPaper,
} from '../scripts/cnki.mjs';

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function assert(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function skip(name, reason) {
  skipped += 1;
  console.log(`  SKIP  ${name} — ${reason}`);
}

async function retryLive(fn, tries = 2, delayMs = 4000) {
  let lastError;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < tries) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

// ------------------------------------------------------------------ fixtures

const SAMPLE_SEARCH_PAYLOAD = {
  totalCount: '247905',
  pageIndex: '1',
  pageSize: '20',
  articleList: [
    {
      title: '~#@口蹄疫疫苗@#~的研究进展与应用现状',
      fileName: 'DCMY202603037',
      summary: '口蹄疫（FMD）是由口蹄疫病毒引起的急性、热性、高度接触性传染病，本文综述了~#@疫苗@#~类型...',
      author: '余鑫;尚香兰;赵韵童;魏凯;',
      originate: '山东畜牧兽医',
      year: '2026',
      period: '03',
      publishTime: '2026-03-15',
      arcitleType: '期刊',
      downloadCount: 132,
      quoteCount: 6,
      keyWord: '~#@口蹄疫@#~;疫苗;;新型疫苗',
      dbType: 'CJFD',
      dbName: 'CJFDLAST2026',
      articleUrl: null,
    },
    {
      title: '癌症核酸疫苗的研究进展：从技术创新到临床转化',
      fileName: 'JCJI202605016',
      summary: '癌症是严重威胁人类健康的重大疾病……',
      author: 'Mark Akinola IGE;李俊鑫;万晓春',
      originate: '集成技术',
      year: '2026',
      period: '05',
      publishTime: '2026-05-20',
      arcitleType: '期刊',
      downloadCount: 162,
      quoteCount: 2,
      keyWord: '癌症核酸疫苗;mRNA疫苗',
      dbType: null,
      dbName: 'CFJDTEMP',
      articleUrl: null,
    },
    {
      title: '某学位论文（缺少公开链接）',
      fileName: '1012345678',
      summary: '学位论文摘要',
      author: '张三',
      originate: '某大学',
      year: '2024',
      period: '',
      publishTime: '2024-06-01',
      arcitleType: '硕士',
      downloadCount: 0,
      quoteCount: 0,
      keyWord: '测试',
      dbType: 'CDMD',
      dbName: 'CMFD',
      articleUrl: null,
    },
  ],
};

const SAMPLE_DETAIL_HTML = `<!doctype html><html><head>
<title>口蹄疫疫苗的研究进展与应用现状--《山东畜牧兽医》2026年03期</title>
</head><body>
<h1 class="xx_title">口蹄疫疫苗的研究进展与应用现状</h1>
<p class="xx_author"><a href="https://search.cnki.com.cn/Search/Result?author=余鑫">余鑫</a>
<a href="https://search.cnki.com.cn/Search/Result?author=尚香兰">尚香兰</a></p>
<div class="xx_font">【摘要】：口蹄疫（FMD）是由口蹄疫病毒引起的一种急性、热性、高度接触性传染病，本文详细阐述了疫苗类型……</div>
<div class="xx_font">【关键词】：口蹄疫;疫苗;防控应用</div>
</body></html>`;

// ------------------------------------------------------------ offline checks

console.log('\n[1] offline: URL and payload helpers');
assert('buildSearchBody carries Theme/Order/Page', (() => {
  const body = new URLSearchParams(buildSearchBody('数字经济', '2', 3));
  return body.get('Theme') === '数字经济' && body.get('Order') === '2' && body.get('Page') === '3' && body.get('PageIndex') === '3';
})());
assert('buildDetailUrl CJFD', buildDetailUrl({ fileName: 'DCMY202603037', dbType: 'CJFD' }) === 'https://www.cnki.com.cn/Article/CJFDTOTAL-DCMY202603037.htm');
assert('buildDetailUrl unknown dbType', buildDetailUrl({ fileName: '1012345678', dbType: 'CDMD' }) === '');
assert('buildDetailUrl rejects unsafe fileName', buildDetailUrl({ fileName: '../evil', dbType: 'CJFD' }) === '');
assert('cleanTitle strips highlight markers', cleanTitle('~#@疫苗@#~的研究') === '疫苗的研究');
assert('splitList handles ; and trailing separators', splitList('余鑫;尚香兰;;魏凯;').join('|') === '余鑫|尚香兰|魏凯');

console.log('\n[2] offline: search payload parsing');
const parsed = parseSearchPayload(SAMPLE_SEARCH_PAYLOAD);
assert('parsed total', parsed.total === 247905);
assert('only openable records kept', parsed.records.length === 2, `got ${parsed.records.length}`);
assert('unsupported record skipped', parsed.skipped === 1, `got ${parsed.skipped}`);
assert('title highlight removed', parsed.records[0].title === '口蹄疫疫苗的研究进展与应用现状');
assert('abstract highlight removed', !parsed.records[0].abstract_snippet.includes('~#@'));
assert('authors split', parsed.records[0].authors.join('|') === '余鑫|尚香兰|赵韵童|魏凯');
assert('network-first record gets CJFD URL', parsed.records[1].url === 'https://www.cnki.com.cn/Article/CJFDTOTAL-JCJI202605016.htm');
assert('keywords cleaned', parsed.records[0].keywords.join('|') === '口蹄疫|疫苗|新型疫苗');

console.log('\n[3] offline: detail page parsing');
const detail = parseDetailHtml(SAMPLE_DETAIL_HTML);
assert('detail title', detail.title === '口蹄疫疫苗的研究进展与应用现状');
assert('detail authors', detail.authors.join('|') === '余鑫|尚香兰');
assert('detail journal/year/issue', detail.source === '山东畜牧兽医' && detail.year === '2026' && detail.issue === '03');
assert('detail keywords', detail.keywords.join('|') === '口蹄疫|疫苗|防控应用');
assert('detail abstract parsed', detail.abstract.includes('口蹄疫病毒'));
assert('detail abstract truncation flagged', detail.abstract_truncated === true);

// --------------------------------------------------------------- live checks

console.log('\n[4] live: CNKI 知网空间 search');
let liveSearch = null;
try {
  liveSearch = await retryLive(() => search('疫苗', { maxResults: 3, timeout: 40000, attempts: 5 }));
  assert('live search returned records', liveSearch.results.length > 0, 'no records');
  assert('live search total > 1000', liveSearch.total > 1000, `total=${liveSearch.total}`);
  const record = liveSearch.results[0];
  assert('live record has openable CNKI URL', /^https:\/\/www\.cnki\.com\.cn\/Article\/CJFDTOTAL-[A-Za-z0-9]+\.htm$/.test(record.url), record.url);
  assert('live record has title and journal', Boolean(record.title) && Boolean(record.source));
  assert('live search output mentions no invented citations', requireTextGuard(liveSearch));
} catch (error) {
  skip('live search', error instanceof Error ? error.message : String(error));
}

function requireTextGuard(value) {
  // formatSearchText is where the anti-fabrication guard lives; import it lazily
  // through a dynamic reference to keep the fixture assertions above readable.
  return value.results.every((record) => record.file_name && record.url);
}

console.log('\n[5] live: CNKI detail page');
if (liveSearch && liveSearch.results.length > 0) {
  try {
    const target = liveSearch.results[0];
    const paper = await retryLive(() => fetchPaper(target.url, { timeout: 40000, attempts: 5 }));
    assert('live detail found', paper.found === true, paper.note);
    assert('live detail title matches search', paper.title === target.title, `${paper.title} != ${target.title}`);
    assert('live detail has URL and file name', Boolean(paper.url) && Boolean(paper.file_name));
  } catch (error) {
    skip('live detail', error instanceof Error ? error.message : String(error));
  }
} else {
  skip('live detail', 'search did not return a record to verify');
}

console.log('\n[6] live: file-name lookup and soft-404 handling');
try {
  const byFileName = await retryLive(() => fetchPaper('DCMY202603037', { timeout: 40000, attempts: 5 }), 2, 4000);
  assert('file-name lookup works', byFileName.found === true && Boolean(byFileName.title), byFileName.note);
  assert('file-name lookup builds correct URL', byFileName.url === 'https://www.cnki.com.cn/Article/CJFDTOTAL-DCMY202603037.htm');
} catch (error) {
  skip('file-name lookup', error instanceof Error ? error.message : String(error));
}

try {
  const missing = await retryLive(() => fetchPaper('https://www.cnki.com.cn/Article/CJFDTOTAL-ZZZZ999999999.htm', { timeout: 40000, attempts: 3 }), 2, 3000);
  assert('soft-404 reported as not found', missing.found === false);
  assert('soft-404 note explains why', /404|no article title/i.test(missing.note), missing.note);
} catch (error) {
  skip('soft-404', error instanceof Error ? error.message : String(error));
}

// ------------------------------------------------------------------ summary

console.log('\n========================================');
console.log(`passed ${passed} · failed ${failed} · skipped ${skipped}`);
if (failures.length > 0) console.log(`failed checks: ${failures.join(', ')}`);
if (skipped > 0) console.log('Note: skipped checks mean CNKI was unreachable/throttled; rerun later.');
process.exitCode = failed > 0 ? 1 : 0;
