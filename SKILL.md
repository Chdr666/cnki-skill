---
name: cnki-search
description: Use when the task needs real Chinese academic literature from CNKI (中国知网), Chinese journal papers, or Chinese citation verification — searches 知网空间 and returns verifiable titles, journals, years and openable cnki.com.cn links so answers never cite invented papers.
description_zh: 检索真实的中国知网（CNKI）期刊论文并获取公开摘要，用于中文文献综述、引用核实、避免编造中文参考文献。
description_en: Search real CNKI Chinese journal papers and fetch public abstracts for verifiable citations.
version: 1.0.0
display_name: 中国知网文献检索
display_name_en: CNKI Literature Search
visibility: public
---

# 中国知网（CNKI）文献检索

当回答涉及中文论文、中文文献综述或中国知网（CNKI）引用时使用本技能。它把“查一下相关文献”变成**知网空间**上的真实记录，并给出可直接打开的 `cnki.com.cn` 详情页链接，让引用可核验。

## 何时使用

- 中文文献问题：“帮我查一下关于 X 的中文论文”“国内对 Y 的研究进展”“近几年 Z 方面的期刊论文”。
- 核实一条中文参考文献：这篇论文是否存在、作者是谁、发表在哪个期刊哪一年哪一期、公开摘要是什么。
- 任何准备写成“有研究表明……”的中文论断：先取到真实记录再写。

CNKI 以中文期刊为主。查英文/国际文献请改用 PubMed 技能或其他检索工具；本技能返回期刊论文（CJFD），学位论文等缺少公开可打开链接的类型会被跳过。

## 不可协商的规则

1. 你提到的每一篇论文都必须来自本次会话中本技能的真实运行结果。
2. 引用时必须给出**文献标题 + 可打开的 `cnki.com.cn` 链接**；不得凭记忆编造标题、作者、期刊、年份、DOI 或链接。
3. 如果命令返回 0 条记录，就明确说“知网未检索到匹配记录”，不要用虚构文献补充。
4. 检索结果里的摘要只是公开页面的摘要片段，常被截断。引用具体摘要内容前，先用 `article` 打开详情页；**不得声称读过全文**。
5. 公开详情页通常没有 DOI、卷号和页码，不要编造这些字段。

## 命令

在本 `SKILL.md` 所在目录运行。优先 Node，其次 Python。

```bash
# 检索：真实记录 + 可打开链接（默认 8 条，最多 20 条）
node scripts/cnki.mjs search "疫苗" --max 5

# 按时间/下载量/被引排序
node scripts/cnki.mjs search "人工智能 教育" --sort date --max 8
node scripts/cnki.mjs search "数字经济" --sort downloads --max 5

# 打开详情页：核对标题、作者、期刊、公开摘要（可传 URL 或知网文件名）
node scripts/cnki.mjs article https://www.cnki.com.cn/Article/CJFDTOTAL-DCMY202603037.htm
node scripts/cnki.mjs article DCMY202603037
```

Python 兜底（依次尝试 `python`、`py -3`、`python3`）：

```bash
python scripts/cnki.py search "疫苗" --max 5
python scripts/cnki.py article DCMY202603037
```

两个运行时接受相同参数：`--json`、`--max N`、`--sort relevance|date|downloads|cited`、`--page N`、`--timeout MS`、`--interval MS`、`--attempts N`。

如果机器上既没有 Node（>= 20）也没有 Python（>= 3.8），告诉用户需要安装哪个运行时，不要猜测结果。

## 查询写法

- 直接用中文关键词：`疫苗`、`人工智能 教育`、`乡村振兴 数字经济`。
- 多个词用空格分开，知网空间按主题词匹配；不要写成 `AND`/`OR` 这类布尔表达式。
- 结果太多：增加限定词（学科、对象、地区），或翻页 `--page 2`。
- 结果太少：换成更常见的中文术语，去掉过细的修饰词。
- 单次查询不超过 200 个字符。

## 如何回答

- 给出编号文献列表：作者、标题、《期刊名》、年份、期号、可打开的 `cnki.com.cn` 链接。
- 明确区分“公开摘要中的原文”和“你的解读”。
- 打不开或核对不一致的记录，标为“未核实”，不要补全细节。
- 需要完整全文时说明：知网全文通常需要机构/个人账号，本技能只能访问公开页面。

## 限制与数据处理

- 数据来源：知网空间公开检索接口（`search.cnki.com.cn/api/search/listresult`）与公开详情页（`www.cnki.com.cn/Article/CJFDTOTAL-*.htm`），无需登录、无需 API key。
- 知网端点会临时限流或返回 504；脚本内置串行限速（默认 2 秒）、超时（默认 20 秒）和重试（默认 3 次）。
- 可选环境变量：`CNKI_TIMEOUT_MS`、`CNKI_MIN_INTERVAL_MS`、`CNKI_MAX_ATTEMPTS`。
- 只有查询词会发送给知网；不写入磁盘，不保存任何凭据。
- `references/cnki-public-search.md` 记录了接口字段与解析注意事项；`test/e2e.mjs` 是联网自测脚本。
