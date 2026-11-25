# 知网空间公开检索接口说明

本文件记录 `cnki-search` 技能依赖的公开接口、URL 规则和解析注意事项。所有
内容来自对 **知网空间**（`search.cnki.com.cn`）页面自身脚本和公开页面的观察，
仅用于稳定解析，不绕过任何登录或验证机制。

## 1. 检索接口

页面：`https://search.cnki.com.cn/Search/Result?content=<关键词>`

结果由页面脚本异步加载，接口为：

```
POST https://search.cnki.com.cn/api/search/listresult
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
X-Requested-With: XMLHttpRequest
Referer: https://search.cnki.com.cn/Search/Result?content=<关键词>
```

请求体（顺序不重要）：

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `searchType` | `MulityTermsSearch` | 固定值（原样拼写） |
| `ArticleType` | `0` | 0 = 默认（期刊） |
| `Type` | `0` | 0 = 默认 |
| `ParamIsNullOrEmpty` | `true` | 固定值 |
| `Islegal` | `false` | 固定值 |
| `Order` | `1` / `2` / `3` / `4` | 1 相关度、2 时间、3 下载、4 被引 |
| `Page` / `PageIndex` | `1..50` | 每页 20 条 |
| `Theme` | 关键词 | 单次建议 ≤ 200 字符 |

响应 JSON 关键字段：

- `totalCount`：命中总数（字符串）
- `totalPageCount`：总页数
- `articleList`：当前页记录数组（20 条）
- `pageIndex` / `pageSize`：分页信息

`articleList` 单条：

| 字段 | 含义 |
| --- | --- |
| `title` | 标题，含高亮标记 `~#@关键词@#~` |
| `fileName` | 知网文件名，用于拼详情页 URL |
| `summary` | 公开摘要片段（常以 `...` 截断） |
| `author` | `作者1;作者2;`（可能以 `;` 结尾） |
| `originate` | 期刊名 |
| `year` / `period` | 年 / 期 |
| `publishTime` | 出版日期 |
| `arcitleType` | 类型（如 `期刊`，原样拼写） |
| `downloadCount` / `quoteCount` | 下载 / 被引次数 |
| `keyWord` | `关键词1;关键词2` 或 `;;` 分隔 |
| `dbType` | `CJFD`、`CPFD`、`CCND`、`CDMD` 等 |
| `dbName` | 如 `CJFDLAST2026`、`CFJDTEMP` |
| `articleUrl` | 恒为 `null`，不要使用 |

## 2. 可打开的详情页 URL

只有下列规则能构造出公开可访问页面：

| dbType | URL |
| --- | --- |
| `CJFD` 或空 | `https://www.cnki.com.cn/Article/CJFDTOTAL-<fileName>.htm` |
| `CPFD` / `IPFD` | `https://cpfd.cnki.com.cn/Article/CPFDTOTAL-<fileName>.htm` |
| `CCND` | `https://mall.cnki.net/magazine/article/CCND/<fileName>.htm` |
| `CDMD` / `CMFD` 等 | 需要学位单位代码，公开接口不提供 → **跳过，不猜链接** |

`fileName` 必须匹配 `^[A-Za-z0-9]+$`。实测 CJFDTOTAL 页面返回约 128 KB，
标题形如：`论文标题--《期刊名》2026年03期`。

## 3. 详情页解析

- 标题：`<h1 class="xx_title">...</h1>`（兜底：任意 `<h1>`）
- 期刊/年/期：`<title>` 中 `--《期刊名》YYYY年NN期`（支持 S1、增刊 等字母期号）
- 作者：多个 `<a href="...Search/Result?author=...">作者名</a>`
- 摘要：`<div class="xx_font">` 内以 `【摘要】：` 开头，通常以 `...` 截断
- 关键词：同类 `xx_font` 块中的 `【关键词】：`
- 公开页通常**没有** DOI、卷号、页码；不要编造

## 4. 稳定性与反爬

- 接口无需 cookie、无需登录；成功请求约 0.4–1.0 秒。
- 常见 `504 Gateway Time-out`（可达约 50 秒），被引排序、部分类型更易触发；
  脚本必须串行限速（默认 2 秒）、设超时（默认 20 秒）并退避重试。
- `kns.cnki.net`（kns8s）有安全验证/验证码，**不要**依赖；本技能只访问
  知网空间的公开页面。
- 若返回“安全验证/人机验证/captcha”页面，视为失败并重试，不要伪造数据。

## 5. 已知边界

- 默认检索以期刊论文（CJFD）为主；学位论文因缺少公开 URL 被跳过。
- 摘要为公开片段，可能不完整；全文通常需要知网账号。
- 年份过滤参数（`PublishTimeBegin/End`）在公开接口上未验证成功，技能不暴露
  该参数，避免给出错误过滤结果。
- 详情页软 404 会返回 HTTP 200 但没有标题（页面约 17 KB），因此必须“取到页面
  但解析不出标题”时按未找到处理，禁止引用。
