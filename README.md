# cnki-search

A portable **AI agent skill** that searches real Chinese academic literature on
**CNKI (中国知网)** and returns verifiable titles, journals and openable
`cnki.com.cn` links, so an assistant cites real papers instead of inventing
references.

Works in **WorkBuddy / CodeBuddy** and other Agent Skills hosts, and in
**DeepSeek Harness (DSH)**. No dependencies: one Node script and one Python
script (standard library only), both using CNKI's public 知网空间 index.

## What it gives the agent

| Command | Purpose |
| --- | --- |
| `search "<关键词>"` | real records: title, authors, journal, year/issue, keywords, public abstract snippet, openable URL |
| `article <url-or-file-name>` | opens a public CNKI detail page and returns verified title, authors, journal/issue, keywords, public abstract |

Searches that match nothing explicitly tell the model "知网未检索到匹配记录，
不要编造"; records whose public URL cannot be built are skipped instead of
guessed. Every returned record has an openable link.

## Install in WorkBuddy

1. Download the skill package zip (see the repository release or
   `cnki-search-1.0.0.zip`), or clone this repo.
2. In WorkBuddy open **专家 · 技能 · 连接器 → 技能 → 添加技能 → 上传技能** and
   select the zip, or copy the folder to the user skill directory:
   `%USERPROFILE%\.workbuddy\skills\cnki-search\` (macOS/Linux:
   `~/.workbuddy/skills/cnki-search/`).
3. The skill appears under **已安装**; keep it enabled and ask
   "帮我查一下近两年关于疫苗的中文文献".

`~/.agents/skills/cnki-search/` (and `<project>/.agents/skills/...`) is also
accepted by WorkBuddy and by DSH.

## Install in DeepSeek Harness (DSH)

Copy this folder to one of the scanned skill roots, for example:

- project: `<project>/.agents/skills/cnki-search/`
- user: `~/.agents/skills/cnki-search/` or `~/.dsh/skills/cnki-search/`

DSH discovers `<root>/<name>/SKILL.md`, reads the frontmatter, and loads the
body on demand.

## Usage examples

```bash
node scripts/cnki.mjs search "疫苗" --max 5
node scripts/cnki.mjs search "人工智能 教育" --sort date --max 8
node scripts/cnki.mjs article https://www.cnki.com.cn/Article/CJFDTOTAL-DCMY202603037.htm
node scripts/cnki.mjs article DCMY202603037 --json
```

Python fallback (`python`, `py -3` or `python3`):

```bash
python scripts/cnki.py search "疫苗" --max 5
python scripts/cnki.py article DCMY202603037
```

Optional environment: `CNKI_TIMEOUT_MS` (default 20000),
`CNKI_MIN_INTERVAL_MS` (default 2000), `CNKI_MAX_ATTEMPTS` (default 3).
Requires Node.js >= 20 or Python >= 3.8.

## Self-test

```bash
node test/e2e.mjs
```

Runs offline parser assertions plus live checks (search, sort, detail page,
file-name lookup, soft-404 handling). Needs internet access to
`search.cnki.com.cn` and `www.cnki.com.cn`; when the endpoints are throttled the
live checks are reported as skipped rather than failed.

## Files

```text
SKILL.md                      skill instructions (frontmatter: name/description/...)
scripts/cnki.mjs              Node CLI + parser (zero dependencies)
scripts/cnki.py               Python CLI + parser (stdlib only)
references/cnki-public-search.md  API contract, URL patterns, parsing pitfalls
workbuddy.json                WorkBuddy display metadata (zh/en)
_icon.svg                     skill icon
test/e2e.mjs                  offline + live self-test
```

## Privacy and safety

Only the search query / CNKI URL leaves the machine, and only to CNKI's public
endpoints. Nothing is written to disk and no credentials are stored. The scripts
are plain readable source, suitable for the security check on skill upload.

## Scope and limits

- Covers journal articles indexed by 知网空间 (CJFD). Conference papers and
  newspapers have their own public pages; theses (CDMD) need a school code the
  public API does not expose, so they are skipped rather than linked wrongly.
- Public detail pages usually omit DOI, volume and page numbers; the skill never
  invents them.
- Public abstracts are often truncated. Full text normally requires a CNKI
  institutional or personal account.
- CNKI occasionally throttles or returns 504; the scripts serialize requests,
  add a delay and retry. If it still fails, report the failure — do not invent
  results.

## Related

DeepSeek Harness plugin version (same data source, native tools):
<https://github.com/Chdr666/dsh-cnki>

## License

MIT
