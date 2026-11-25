#!/usr/bin/env python3
"""cnki-search - zero-dependency CNKI (中国知网) retrieval for AI agent skills.

Commands:
    python scripts/cnki.py search "<query>" [--max N] [--sort relevance|date|downloads|cited] [--page N] [--json]
    python scripts/cnki.py article <url-or-file-name>[,<...>] [--json]

Data source: the public 知网空间 index (https://search.cnki.com.cn) and the
public detail pages on https://www.cnki.com.cn. Only records actually returned
by those endpoints are emitted; nothing is invented.

Environment: CNKI_TIMEOUT_MS, CNKI_MIN_INTERVAL_MS, CNKI_MAX_ATTEMPTS.
Requires Python 3.8+; standard library only.
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# Windows consoles may default to a legacy code page (e.g. GBK) that cannot
# encode Chinese titles; force UTF-8 output.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

MAX_RESULTS = 20
MAX_PAGE = 50
MAX_ATTEMPTS = 5
TOOL_ID = "cnki-search-skill"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0"
)
BASE_URL = "https://search.cnki.com.cn"
DETAIL_BASE_URL = "https://www.cnki.com.cn"
CPFD_BASE_URL = "https://cpfd.cnki.com.cn"
CCND_BASE_URL = "https://mall.cnki.net"
SEARCH_PATH = "/api/search/listresult"
SORT_ORDERS = {"relevance": "1", "date": "2", "downloads": "3", "cited": "4"}

_last_request_at = 0.0


class Config:
    def __init__(self, timeout=None, interval=None, attempts=None):
        self.timeout_ms = _clamp_int(timeout if timeout is not None else os.environ.get("CNKI_TIMEOUT_MS"), 20000, 3000, 60000)
        self.min_interval_ms = _clamp_int(interval if interval is not None else os.environ.get("CNKI_MIN_INTERVAL_MS"), 2000, 0, 15000)
        self.max_attempts = _clamp_int(attempts if attempts is not None else os.environ.get("CNKI_MAX_ATTEMPTS"), 3, 1, MAX_ATTEMPTS)
        self.max_abstract_chars = 1500
        self.base_url = BASE_URL
        self.detail_base_url = DETAIL_BASE_URL
        self.cpfd_base_url = CPFD_BASE_URL
        self.ccnd_base_url = CCND_BASE_URL


def _clamp_int(value, fallback, minimum, maximum):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return fallback
    return min(maximum, max(minimum, number))


# ---------------------------------------------------------------- requests


class _HttpError(Exception):
    def __init__(self, status, message, retryable):
        super().__init__(message)
        self.status = status
        self.retryable = retryable


def _sleep_ms(ms):
    time.sleep(max(0.0, ms / 1000.0))


def _schedule():
    """Enforce the minimum gap between consecutive requests."""
    global _last_request_at
    cfg = _CURRENT.get("cfg")
    interval = cfg.min_interval_ms / 1000.0 if cfg else 0.0
    wait = _last_request_at + interval - time.time()
    if wait > 0:
        time.sleep(wait)
    _last_request_at = time.time()


_CURRENT = {}


def _request(url, cfg, method="GET", headers=None, body=None):
    _schedule()
    request = urllib.request.Request(url, data=body.encode("utf-8") if body is not None else None, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(request, timeout=cfg.timeout_ms / 1000.0) as response:
            return response.status, response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as error:
        try:
            text = error.read().decode("utf-8", errors="replace")
        except Exception:  # noqa: BLE001 - best-effort body for the message
            text = ""
        return error.code, text
    except urllib.error.URLError as error:
        reason = getattr(error, "reason", error)
        if isinstance(reason, TimeoutError) or "timed out" in str(reason).lower():
            raise TimeoutError("CNKI request timed out after %sms" % cfg.timeout_ms) from error
        raise RuntimeError("CNKI request failed: %s" % reason) from error
    except TimeoutError as error:
        raise TimeoutError("CNKI request timed out after %sms" % cfg.timeout_ms) from error


def _is_security_page(text):
    return bool(re.search(r"安全验证|人机验证|captcha|verify/js|滑动验证", text or "", re.IGNORECASE))


def _snippet(text):
    return re.sub(r"\s+", " ", text or "")[:300]


# ----------------------------------------------------------------- parsing


def _decode_entities(value):
    def from_code(match):
        raw = match.group(1)
        try:
            code = int(raw, 16) if raw.lower().startswith("x") else int(raw, 10)
            return chr(code)
        except (ValueError, OverflowError):
            return ""

    text = str(value or "")
    text = re.sub(r"&#x([0-9a-fA-F]+);", lambda m: from_code(_Wrap("x" + m.group(1))), text)
    text = re.sub(r"&#(\d+);", lambda m: from_code(_Wrap(m.group(1))), text)
    text = re.sub(r"&nbsp;", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"&lt;", "<", text, flags=re.IGNORECASE)
    text = re.sub(r"&gt;", ">", text, flags=re.IGNORECASE)
    text = re.sub(r"&quot;", '"', text, flags=re.IGNORECASE)
    text = re.sub(r"&#39;|&apos;", "'", text, flags=re.IGNORECASE)
    text = re.sub(r"&amp;", "&", text, flags=re.IGNORECASE)
    return text


class _Wrap:
    """Tiny adapter so the entity helpers can share one code path."""

    def __init__(self, value):
        self.value = value

    def group(self, _index=0):
        return self.value


def clean_text(fragment):
    """Strip tags/entities and collapse whitespace in a scraped HTML fragment."""
    stripped = re.sub(r"<[^>]*>", " ", str(fragment or ""))
    return re.sub(r"\s+", " ", _decode_entities(stripped)).strip()


def clean_title(title):
    """Remove 知网空间 keyword-highlight markers `~#@keyword@#~`."""
    text = str(title or "").replace("~#@", "").replace("@#~", "")
    return re.sub(r"\s+", " ", text).strip()


def split_list(value):
    """Split the API's `作者1;作者2;` / `关键词1;;关键词2` separator lists."""
    parts = re.split(r"[;；]+", str(value or ""))
    return [re.sub(r"\s+", " ", part).strip() for part in parts if part.strip()]


def _to_int(value):
    try:
        return int(str(value or "").strip())
    except (TypeError, ValueError):
        return 0


def build_detail_url(item, cfg=None):
    """Build the public, openable detail URL for one 知网空间 record."""
    if not isinstance(item, dict):
        return ""
    cfg = cfg or Config()
    file_name = str(item.get("fileName") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9]+", file_name):
        return ""
    db_type = str(item.get("dbType") or "").strip().upper()
    if not db_type or db_type == "CJFD":
        return "%s/Article/CJFDTOTAL-%s.htm" % (cfg.detail_base_url, file_name)
    if db_type in ("CPFD", "IPFD"):
        return "%s/Article/CPFDTOTAL-%s.htm" % (cfg.cpfd_base_url, file_name)
    if db_type == "CCND":
        return "%s/magazine/article/CCND/%s.htm" % (cfg.ccnd_base_url, file_name)
    return ""


def build_search_body(query, order="1", page=1):
    return urllib.parse.urlencode(
        {
            "searchType": "MulityTermsSearch",
            "ArticleType": "0",
            "Type": "0",
            "ParamIsNullOrEmpty": "true",
            "Islegal": "false",
            "Order": str(order),
            "Page": str(page),
            "PageIndex": str(page),
            "Theme": str(query),
        }
    )


def parse_search_payload(payload, max_abstract_chars=1500, cfg=None):
    cfg = cfg or Config()
    raw = payload if isinstance(payload, dict) else {}
    total = max(0, _to_int(raw.get("totalCount")))
    items = raw.get("articleList") if isinstance(raw.get("articleList"), list) else []
    page_index = max(1, _to_int(raw.get("pageIndex")) or 1)
    page_size = max(1, _to_int(raw.get("pageSize")) or 20)
    records = []
    skipped = 0
    for item in items:
        if not isinstance(item, dict):
            skipped += 1
            continue
        title = clean_title(item.get("title"))
        url = build_detail_url(item, cfg)
        if not title or not url:
            skipped += 1
            continue
        abstract = clean_title(clean_text(item.get("summary")))
        if len(abstract) > max_abstract_chars:
            abstract = abstract[:max_abstract_chars] + "..."
        records.append(
            {
                "title": title,
                "authors": split_list(item.get("author")),
                "source": str(item.get("originate") or "").strip(),
                "year": str(item.get("year") or "").strip(),
                "issue": str(item.get("period") or "").strip(),
                "publish_date": str(item.get("publishTime") or "").strip(),
                "type": str(item.get("arcitleType") or item.get("dbSource") or "").strip(),
                "downloads": _to_int(item.get("downloadCount")),
                "citations": _to_int(item.get("quoteCount")),
                "keywords": [clean_title(part) for part in split_list(item.get("keyWord"))],
                "abstract_snippet": abstract,
                "url": url,
                "file_name": str(item.get("fileName") or "").strip(),
            }
        )
    return {"total": total, "records": records, "skipped": skipped, "pageIndex": page_index, "pageSize": page_size}


def parse_detail_html(html, max_abstract_chars=1500):
    """Extract title, authors, journal/issue, keywords and the public abstract."""
    source = html if isinstance(html, str) else ""

    h1 = re.search(r'<h1[^>]*class="[^"]*xx_title[^"]*"[^>]*>([\s\S]*?)</h1>', source, re.IGNORECASE)
    if not h1:
        h1 = re.search(r"<h1[^>]*>([\s\S]*?)</h1>", source, re.IGNORECASE)
    title = clean_title(clean_text(h1.group(1))) if h1 else ""

    title_tag = re.search(r"<title[^>]*>([\s\S]*?)</title>", source, re.IGNORECASE)
    title_text = clean_text(title_tag.group(1)) if title_tag else ""
    venue = re.search(r"--《([^》]+)》\s*(\d{4})\s*年\s*([0-9A-Za-z]+)\s*期", title_text)
    journal_title = venue.group(1).strip() if venue else (title_text.split("--《")[1].split("》")[0].strip() if "--《" in title_text else "")
    year = venue.group(2) if venue else ""
    issue = venue.group(3) if venue else ""

    authors = []
    for match in re.finditer(r'<a[^>]+href="[^"]*Search/Result\?author=[^"]*"[^>]*>([\s\S]*?)</a>', source, re.IGNORECASE):
        name = clean_title(clean_text(match.group(1)))
        if name and name not in authors:
            authors.append(name)

    blocks = re.findall(r'<div[^>]*class="[^"]*xx_font[^"]*"[^>]*>([\s\S]*?)</div>', source, re.IGNORECASE)
    abstract = ""
    keywords = []
    for block in blocks:
        text = clean_text(block)
        if not abstract and "【摘要】" in text:
            abstract = re.sub(r"^.*?【摘要】\s*[:：]?\s*", "", text).strip()
        if "【关键词】" in text:
            tail = re.sub(r"^.*?【关键词】\s*[:：]?\s*", "", text).strip()
            parts = [clean_title(part) for part in re.split(r"[;；]", tail) if part.strip()]
            if parts:
                keywords = parts

    abstract_truncated = False
    if abstract:
        abstract_truncated = bool(re.search(r"(\.\.\.|…)\s*$", abstract))
        if abstract_truncated:
            abstract = re.sub(r"\.\.\.\s*$|…\s*$", "", abstract).strip()
        if len(abstract) > max_abstract_chars:
            abstract = abstract[:max_abstract_chars] + "..."
            abstract_truncated = True

    return {
        "title": title,
        "authors": authors,
        "source": journal_title,
        "year": year,
        "issue": issue,
        "keywords": keywords,
        "abstract": abstract,
        "abstract_truncated": abstract_truncated,
    }


def _is_allowed_cnki_url(value):
    try:
        parsed = urllib.parse.urlparse(value)
    except ValueError:
        return False
    if parsed.scheme not in ("http", "https"):
        return False
    host = (parsed.hostname or "").lower()
    return host == "cnki.com.cn" or host.endswith(".cnki.com.cn") or host == "cnki.net" or host.endswith(".cnki.net")


def _file_name_from_url(value):
    match = re.search(r"(?:CJFDTOTAL|CPFDTOTAL|CDMD|CCND)[-_]?([A-Za-z0-9]+)\.htm", value or "", re.IGNORECASE)
    if match:
        return match.group(1)
    tail = str(value or "").rstrip("/").split("/")[-1]
    return re.sub(r"[^A-Za-z0-9]", "", re.sub(r"\.html?$", "", tail, flags=re.IGNORECASE))


# ------------------------------------------------------------------ search


def _search_headers(query, cfg):
    return {
        "User-Agent": USER_AGENT,
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Origin": cfg.base_url,
        "Referer": "%s/Search/Result?content=%s" % (cfg.base_url, urllib.parse.quote(query)),
        "X-Requested-With": "XMLHttpRequest",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }


def _request_search_payload(query, cfg, sort, page):
    order = SORT_ORDERS.get(sort, SORT_ORDERS["relevance"])
    body = build_search_body(query, order, page)
    url = cfg.base_url + SEARCH_PATH
    headers = _search_headers(query, cfg)
    last_error = None
    for attempt in range(cfg.max_attempts):
        try:
            status, text = _request(url, cfg, method="POST", headers=headers, body=body)
            if status < 200 or status >= 300:
                retryable = status in (408, 429) or status >= 500
                raise _HttpError(status, "CNKI search API returned HTTP %s: %s" % (status, _snippet(text)), retryable)
            if _is_security_page(text):
                raise _HttpError(0, "CNKI returned a security-verification page instead of search results", True)
            try:
                return json.loads(text)
            except ValueError as error:
                raise _HttpError(0, "CNKI search API returned a non-JSON response", True) from error
        except _HttpError as error:
            last_error = error
            if not error.retryable or attempt + 1 >= cfg.max_attempts:
                break
            _sleep_ms(2000 * (attempt + 1))
        except (TimeoutError, RuntimeError) as error:
            last_error = error
            if attempt + 1 >= cfg.max_attempts:
                break
            _sleep_ms(2000 * (attempt + 1))
    raise RuntimeError(str(last_error) if last_error else "CNKI search request failed")


def search(query, max_results=None, sort="relevance", page=1, timeout=None, interval=None, attempts=None):
    text = query.strip() if isinstance(query, str) else ""
    if not text:
        raise ValueError("query must be a non-empty string")
    if len(text) > 200:
        raise ValueError("query is too long; keep it under 200 characters")
    cfg = Config(timeout=timeout, interval=interval, attempts=attempts)
    limit = min(MAX_RESULTS, max(1, int(max_results))) if max_results is not None else 8
    if sort not in SORT_ORDERS:
        sort = "relevance"
    page = min(MAX_PAGE, max(1, int(page or 1)))
    _CURRENT["cfg"] = cfg
    payload = _request_search_payload(text, cfg, sort, page)
    parsed = parse_search_payload(payload, cfg.max_abstract_chars, cfg)
    results = parsed["records"][:limit]
    return {
        "query": text,
        "sort": sort,
        "page": page,
        "total": parsed["total"],
        "results": results,
        "skipped": parsed["skipped"],
        "truncated": parsed["total"] > page * parsed["pageSize"] or len(parsed["records"]) > len(results),
    }


# ----------------------------------------------------------------- article


def _request_detail(url, cfg):
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Referer": cfg.base_url + "/",
    }
    last_error = None
    for attempt in range(cfg.max_attempts):
        try:
            status, text = _request(url, cfg, headers=headers)
            if status in (404, 410):
                return {"missing": True, "note": "the CNKI page returned HTTP %s" % status}
            if status < 200 or status >= 300:
                retryable = status in (408, 429) or status >= 500
                raise _HttpError(status, "CNKI detail page returned HTTP %s: %s" % (status, _snippet(text)), retryable)
            if _is_security_page(text):
                raise _HttpError(0, "CNKI returned a security-verification page instead of the article", True)
            return {"missing": False, "html": text, "note": ""}
        except _HttpError as error:
            last_error = error
            if not error.retryable or attempt + 1 >= cfg.max_attempts:
                break
            _sleep_ms(2000 * (attempt + 1))
        except (TimeoutError, RuntimeError) as error:
            last_error = error
            if attempt + 1 >= cfg.max_attempts:
                break
            _sleep_ms(2000 * (attempt + 1))
    return {"missing": True, "note": str(last_error) if last_error else "the CNKI page could not be fetched"}


def fetch_paper(url_or_file_name, timeout=None, interval=None, attempts=None, max_abstract_chars=None):
    cfg = Config(timeout=timeout, interval=interval, attempts=attempts)
    _CURRENT["cfg"] = cfg
    raw = url_or_file_name.strip() if isinstance(url_or_file_name, str) else ""
    if raw.lower().startswith(("http://", "https://")):
        if not _is_allowed_cnki_url(raw):
            return {"found": False, "title": "", "url": raw, "file_name": "", "note": "this is not a CNKI detail URL; only cnki.com.cn / *.cnki.com.cn / *.cnki.net pages can be opened"}
        url = raw
        file_name = _file_name_from_url(raw)
    elif re.fullmatch(r"[A-Za-z0-9]+", raw or ""):
        file_name = raw
        url = "%s/Article/CJFDTOTAL-%s.htm" % (cfg.detail_base_url, file_name)
    else:
        return {"found": False, "title": "", "url": raw, "file_name": "", "note": "provide a CNKI detail URL or a CNKI file name"}

    response = _request_detail(url, cfg)
    if response["missing"]:
        return {"found": False, "title": "", "url": url, "file_name": file_name, "note": response["note"]}
    parsed = parse_detail_html(response["html"], max_abstract_chars or cfg.max_abstract_chars)
    if not parsed["title"]:
        return {"found": False, "title": "", "url": url, "file_name": file_name, "note": "the page opened but no article title could be parsed"}
    return {
        "found": True,
        "title": parsed["title"],
        "authors": parsed["authors"],
        "source": parsed["source"],
        "year": parsed["year"],
        "issue": parsed["issue"],
        "keywords": parsed["keywords"],
        "abstract": parsed["abstract"],
        "abstract_truncated": parsed["abstract_truncated"],
        "url": url,
        "file_name": file_name,
        "note": "",
    }


def fetch_articles(inputs, timeout=None, interval=None, attempts=None):
    if isinstance(inputs, str):
        inputs = [inputs]
    papers = []
    missing = []
    seen = set()
    for item in inputs:
        raw = item.strip() if isinstance(item, str) else ""
        if not raw or raw in seen:
            continue
        seen.add(raw)
        paper = fetch_paper(raw, timeout=timeout, interval=interval, attempts=attempts)
        papers.append(paper)
        if not paper["found"]:
            missing.append(raw)
    if not papers:
        raise ValueError("provide at least one CNKI URL or file name")
    return {"papers": papers, "missing": missing}


# --------------------------------------------------------------- formatting


def _format_authors(authors, keep=6):
    if not authors:
        return "(authors unavailable)"
    shown = authors[:keep]
    suffix = ", et al." if len(authors) > len(shown) else ""
    return ", ".join(shown) + suffix


def format_search_text(value):
    lines = ['CNKI 知网空间 search "%s" — %s record(s) matched.' % (value["query"], value["total"])]
    if not value["results"]:
        lines.append("No CNKI record matched this query.")
        lines.append("Do not cite any paper for this topic and do not invent a citation: report that 知网 returned no matching record.")
        return "\n".join(lines)
    if value["truncated"]:
        lines.append("Showing %s record(s); more matches exist (refine the query or request the next page)." % len(value["results"]))
    else:
        lines.append("Showing %s record(s)." % len(value["results"]))
    lines.append("")
    for index, record in enumerate(value["results"], start=1):
        lines.append("%s. %s" % (index, record["title"]))
        lines.append("   Authors: %s" % _format_authors(record["authors"]))
        venue = " ".join(part for part in [record["source"], (record["year"] + "年") if record["year"] else "", (record["issue"] + "期") if record["issue"] else ""] if part)
        stats = " · ".join(part for part in [record["type"], ("downloads %s" % record["downloads"]) if record["downloads"] else "", ("cited %s" % record["citations"]) if record["citations"] else ""] if part)
        lines.append("   Journal: %s%s" % (venue or "(venue unavailable)", (" · " + stats) if stats else ""))
        if record["keywords"]:
            lines.append("   Keywords: %s" % "; ".join(record["keywords"]))
        if record["abstract_snippet"]:
            lines.append("   Abstract (public snippet): %s" % record["abstract_snippet"])
        lines.append("   URL: %s" % record["url"])
        lines.append("   CNKI file name: %s" % record["file_name"])
    lines.append("")
    lines.append("Every entry above is a real record in CNKI 知网空间; cite only the titles and cnki.com.cn URLs above. Call the article command on a URL before quoting an abstract: the public abstract is usually truncated, and full text may require a CNKI account.")
    return "\n".join(lines)


def format_article_text(value):
    blocks = []
    for paper in value["papers"]:
        if not paper["found"]:
            blocks.append(
                "\n".join(
                    [
                        "CNKI paper NOT verified: %s" % (paper["url"] or "(invalid input)"),
                        "Reason: %s" % (paper["note"] or "the page could not be verified"),
                        "Do not cite this paper and do not present its title, authors or abstract as verified literature.",
                    ]
                )
            )
            continue
        lines = ["CNKI paper: %s" % paper["title"], "Authors: %s" % _format_authors(paper["authors"])]
        venue = " ".join(part for part in [paper["source"], (paper["year"] + "年") if paper["year"] else "", (paper["issue"] + "期") if paper["issue"] else ""] if part)
        lines.append("Journal: %s" % (venue or "(venue unavailable)"))
        if paper["keywords"]:
            lines.append("Keywords: %s" % "; ".join(paper["keywords"]))
        lines.append("URL: %s" % paper["url"])
        lines.append("CNKI file name: %s" % paper["file_name"])
        label = "Abstract (public page, truncated)" if paper.get("abstract_truncated") else "Abstract (public page)"
        lines.append("%s: %s" % (label, paper["abstract"] or "(no public abstract on this page)"))
        lines.append("This metadata comes from the public CNKI page above; quote only what is visible here, and note that the full text may require a CNKI account.")
        blocks.append("\n".join(lines))
    if not blocks:
        blocks.append("No CNKI record was returned for the requested input.")
    return "\n\n".join(blocks)


# --------------------------------------------------------------------- CLI

HELP = """cnki-search - real CNKI 知网 retrieval for AI agents

Usage:
  python scripts/cnki.py search "<query>" [--max N] [--sort MODE] [--page N] [--json]
  python scripts/cnki.py article <url-or-file-name>[,<...>] [--json]

Options:
  --max N        records for search (1-20, default 8)
  --sort MODE    relevance (default), date, downloads or cited
  --page N       result page (1-50, 20 records per page)
  --json         print machine-readable JSON instead of text
  --timeout MS   per-request timeout (default: env CNKI_TIMEOUT_MS or 20000)
  --interval MS  minimum gap between requests (default: env CNKI_MIN_INTERVAL_MS or 2000)
  --attempts N   attempts per request (1-5, default: env CNKI_MAX_ATTEMPTS or 3)
  -h, --help     show this help

Examples:
  python scripts/cnki.py search "疫苗" --max 5
  python scripts/cnki.py search "人工智能 教育" --sort date --max 8
  python scripts/cnki.py article https://www.cnki.com.cn/Article/CJFDTOTAL-DCMY202603037.htm
  python scripts/cnki.py article DCMY202603037
"""


def _parse_cli(argv):
    command = argv[0] if argv else ""
    options = {"json": False, "max": None, "sort": "relevance", "page": None, "timeout": None, "interval": None, "attempts": None, "help": False}
    positional = []
    rest = argv[1:]
    index = 0
    while index < len(rest):
        token = rest[index]
        if token == "--json":
            options["json"] = True
        elif token in ("--max", "-n"):
            index += 1
            options["max"] = rest[index] if index < len(rest) else None
        elif token == "--sort":
            index += 1
            options["sort"] = rest[index] if index < len(rest) else None
        elif token == "--page":
            index += 1
            options["page"] = rest[index] if index < len(rest) else None
        elif token == "--timeout":
            index += 1
            options["timeout"] = rest[index] if index < len(rest) else None
        elif token == "--interval":
            index += 1
            options["interval"] = rest[index] if index < len(rest) else None
        elif token == "--attempts":
            index += 1
            options["attempts"] = rest[index] if index < len(rest) else None
        elif token in ("-h", "--help"):
            options["help"] = True
        elif token.startswith("--"):
            raise ValueError("unknown option %s" % token)
        else:
            positional.append(token)
        index += 1
    return command, positional, options


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    command, positional, options = _parse_cli(argv)
    if not command or command in ("-h", "--help") or options["help"]:
        sys.stdout.write(HELP)
        return 0
    if command == "search":
        query = " ".join(positional).strip()
        if not query:
            raise ValueError("search requires a query string")
        value = search(
            query,
            max_results=int(options["max"]) if options["max"] is not None else None,
            sort=options["sort"],
            page=int(options["page"]) if options["page"] is not None else 1,
            timeout=options["timeout"],
            interval=options["interval"],
            attempts=options["attempts"],
        )
        if options["json"]:
            sys.stdout.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
        else:
            sys.stdout.write(format_search_text(value) + "\n")
        return 0
    if command == "article":
        raw = " ".join(positional).strip()
        if not raw:
            raise ValueError("article requires one or more CNKI URLs or file names")
        parts = [part for part in re.split(r"[\s,]+", raw) if part]
        value = fetch_articles(parts, timeout=options["timeout"], interval=options["interval"], attempts=options["attempts"])
        if options["json"]:
            sys.stdout.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
        else:
            sys.stdout.write(format_article_text(value) + "\n")
        return 0
    raise ValueError('unknown command "%s" (expected search or article)' % command)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as error:  # noqa: BLE001 - CLI must print a clean message
        sys.stderr.write("cnki-search: %s\n" % error)
        sys.exit(1)
