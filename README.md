# @pipeworx/china-customs

China's official monthly merchandise trade statistics — total exports/imports/balance, by trading partner, by HS commodity section/chapter, and trade indices — scraped from the General Administration of Customs (GACC) **English-language** site, which is reachable where the mainland Chinese statistics database (`stats.customs.gov.cn`) 412-blocks non-China IPs.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1576+ live data sources.

## Tools

- `china_trade_summary({ month? })` — total exports/imports/balance in both USD and CNY (100-million units), with official month-on-month and year-on-year % changes, from GACC's "preliminary" flash release.
- `china_trade_by_country({ month?, partner? })` — exports/imports/balance by trading partner country/region, month + year-to-date, with YoY %, from GACC's "final" monthly release. `partner` is an optional substring filter (e.g. `"United States"`, `"Japan"`, `"Asia"`).
- `china_trade_by_commodity({ month?, hs_section? })` — exports/imports by HS Section (21 sections) and 2-digit HS chapter (Division), month + year-to-date, with YoY %. Without `hs_section`, returns TOTAL + the 21 sections; with it (a 2-digit HS chapter code like `"84"`, or free text like `"machinery"`), also returns that section's individual chapters.
- `china_trade_indices({ month?, direction?, series?, chained?, hs2? })` — unit-value / quantum / value indices for exports or imports, base = same month of the prior year = 100. `series`: `hs2` (default), `sitc2`, `bec`, `industry`, `hs4`, `sitc3`. `chained` selects the chained-index variant. Pass a 2-digit `hs2` chapter code to drill into one chapter. **Chapter/section labels in this specific GACC table are Chinese-only** — cross-reference the HS2 code against `china_trade_by_commodity` for the English name.

## Auth

Keyless. GACC's English site (`english.customs.gov.cn`) serves these pages with no authentication.

## Data sources

- `http://english.customs.gov.cn/statics/report/monthly.html` — index of the "final" revised monthly report categories (18 tables, USD only): summary, by country/region, by HS section/division, by customs regime, major commodities, etc.
- `http://english.customs.gov.cn/statics/report/preliminary.html` — index of the "preliminary" flash-release tables (USD and CNY), published on a shorter lag than the final tables and carrying GACC's own month-on-month/year-on-year % figures.
- `http://english.customs.gov.cn/statics/report/trade.html` — index of trade-index tables (unit value/quantum/value, chained and non-chained, by HS2/SITC2/BEC/Industry/HS4/SITC3, for both exports and imports).

**HTTPS does not work** — the site resets the connection over TLS from this environment (checked 2026-09-07); use plain `http://`.

**The tables are real HTML, not images or client-rendered** — this was the open question the task started from. Fetching the raw HTML with a plain UA and parsing the `<table>` proves it: GACC's `monthly.html` report page for July 2026 (`http://english.customs.gov.cn/Statics/ec4779c4-69ac-4c1b-8792-1f2d0f423103.html`) contains the row `2026.07 | Total 683,366 | Export 397,852 | Import 285,514 | Balance 112,337` (US$ million) directly in the markup.

**Index pages link to per-month report pages, and the links are NOT derivable from the date** — each index table row has one cell per report category, and within that cell one `<a href>` per calendar month that's been published so far this year (an un-linked `<span>Aug.</span>` instead of `<a href>Aug.</a>` means that month isn't out yet). The linked URL is an opaque GUID (`/Statics/<uuid>.html`) that changes every time GACC republishes, so every tool call re-parses the relevant index page (cached 6h per isolate) to find the right link before fetching the report itself — there is no way to construct the report URL from a month number alone.

**The three families of report pages have different scopes and different HTML layouts:**
- `monthly.html`'s "(1) Summary … Monthly" report is a *trailing* table — any one month's link (e.g. "Jul.") returns a table with roughly the last 19 months of history (2025.01 through 2026.07 as of this build), one row per `YYYY.MM`. Its other rows (by country, by HS section, etc.) are single-month snapshots (current month + year-to-date only) — fetching an older month requires that specific month's own link.
- `preliminary.html`'s tables are single-month snapshots per link, with GACC's own MoM%/YoY% baked in. Data cells are `<span>value</span>`.
- `trade.html`'s index tables use a different, Word-pasted HTML shape (`<td><p>…</p></td>`, sometimes two `<p>` lines per cell for bilingual headers) and are Chinese-only for individual section/chapter names — only the numeric HS2 code is bilingual-safe.
- January is sometimes missing from `preliminary.html`'s linked months (GACC often reports the first two months combined due to the Lunar New Year distortion) — don't assume every month 1–12 has a link.

**Publication lag**: the "preliminary" release typically appears about a week after month-end; a revised "final" figure (used by `china_trade_by_country` and `china_trade_by_commodity`) follows in GACC's next monthly cycle. `china_trade_summary`'s response always states the actual period it read (`period_label`), and each tool lists `available_months` — the calendar months currently linked on the relevant GACC index page — so a caller can see the real freshness rather than assume today's month is covered.

**A requested month outside the linked range is a clear error, not a silent substitution.** `month` only ever matches by month-NUMBER against the index page (which never states a year); the actual period fetched is always read back out of the report page itself and returned as `period_label`, so a wrong-year guess surfaces as a visible mismatch rather than mislabeling the data.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "china-customs": {
      "url": "https://gateway.pipeworx.io/china-customs/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/china-customs/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1576+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/china_trade_summary \
  -H 'Content-Type: application/json' \
  -d '{}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/china_trade_summary`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "china-customs": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-china-customs"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-china-customs
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about China Customs data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
