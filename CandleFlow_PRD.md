# CandleFlow — Product Requirements Document

**Version:** 1.0
**Status:** Draft for review
**Type:** Offline-first, client-only web application
**Owner:** Sxuoi

---

## 1. Overview

CandleFlow is a browser-based charting and manual backtesting tool designed to replicate the core TradingView charting experience — candlestick rendering, drawing tools, indicators, timeframe switching, and bar-by-bar replay — while running **entirely client-side**. There is no backend, no data broker integration, and no server-side storage. Users supply their own historical price data (exported directly from MT5) and everything — data, drawings, indicator settings, and replay state — lives in the user's own browser via IndexedDB.

The app is intended to be published as a static site (GitHub Pages) so it is freely and publicly usable, while guaranteeing that no user's trading data ever leaves their machine.

### 1.1 Problem Statement

Manual backtesting on TradingView (or similar platforms) requires either a paid plan for full replay/drawing functionality, or pulling data through the platform's own broker integrations, which may not match a trader's actual broker feed (spread, session times, candle alignment). Traders who want to backtest against their **own broker's exact historical data** (e.g., pulled directly from MT5) have no lightweight, free, TradingView-equivalent tool to do so.

### 1.2 Goals

- Replicate TradingView's charting look, feel, and core interaction model closely enough that an existing TradingView user feels immediately at home.
- Let users load their own MT5-exported CSV data with zero setup friction.
- Support full manual backtesting: drawing tools, indicators, timeframe switching, and bar-by-bar replay.
- Persist a user's work (drawings, layout, replay position) locally, across sessions, without any account system.
- Ship as a single static site with no backend, no build-time secrets, and no ongoing hosting cost.

### 1.3 Non-Goals

- No live/streaming data feed of any kind (this is a historical/offline tool only).
- No user accounts, login, or cloud sync (v1). Data is device/browser-local.
- No server-side data storage — CandleFlow never receives or transmits the user's price data.
- No broker API integrations (no MT5 bridge, no live connection).
- No mobile-first design in v1 (desktop browser is the primary target; mobile may work but isn't optimized for).

---

## 2. Target User

Primary user: an individual trader (starting with Sxuoi) who:
- Exports historical OHLCV data directly from MT5.
- Wants to manually backtest strategies bar-by-bar against real broker data.
- Wants TradingView-grade drawing/annotation tools without a subscription or platform lock-in.
- Is comfortable pulling their own CSV exports; not expecting hand-holding on the trading side, but does need a frictionless load-and-go experience in the app itself.

Secondary users (once published): any trader with an MT5 (or MT5-format) CSV export who wants the same offline, private, TradingView-style backtesting environment.

---

## 3. High-Level Architecture

| Layer | Technology | Notes |
|---|---|---|
| Chart rendering core | [TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts) (Apache 2.0) | Candlestick + volume series, native pan/zoom/crosshair, time-scale sync |
| Drawing overlay | Custom `<canvas>` layer, absolutely positioned over the chart | Drawings stored in time/price space, not pixel space, re-projected on every `visibleTimeRangeChange` / resize |
| Data ingestion | In-browser CSV parser | Parses MT5-standard CSV export into normalized OHLCV arrays |
| Timeframe aggregation | Client-side bucketing engine | Aggregates from the lowest loaded timeframe (e.g. M1) into any higher timeframe on demand, with per-timeframe result caching |
| Persistence | IndexedDB | Stores base OHLCV data, per-dataset drawings, indicator configs, layout, and replay state |
| File access | File System Access API (`showOpenFilePicker`) with drag-and-drop CSV fallback | Chromium browsers get persistent file-handle "remember my file" behavior; Firefox/Safari fall back to manual drag-and-drop each session |
| Hosting | Static site on GitHub Pages | No backend, no server code, no environment secrets |

**Core architectural principle:** CandleFlow is a pure client application. At no point does price data, drawings, or any user-identifying information get transmitted to any server. This is what makes it safe to publish publicly — every user's data stays on their own device.

---

## 4. Data Specification

### 4.1 Input Format

Standard MT5 CSV export:

```
Date,Time,Open,High,Low,Close,Volume
2024.01.02,00:00,2062.45,2064.10,2061.80,2063.55,1245
2024.01.02,00:01,2063.55,2063.90,2063.10,2063.40,980
...
```

- `Date` format: `YYYY.MM.DD`
- `Time` format: `HH:MM` (broker server time, not normalized to UTC — see §4.4)
- Delimiter: comma (parser should also gracefully handle semicolon or tab, common in some MT5 export configurations)
- `Volume` may represent tick volume rather than real volume — treated as-is, no assumptions made about its meaning

### 4.2 Base Timeframe Requirement

Users load a **single base file at the lowest timeframe they intend to use** (e.g., M1). All higher timeframes (M5, M15, M30, H1, H4, D1, W1) are derived from this base file via client-side aggregation — no separate file per timeframe is required.

### 4.3 Aggregation Logic

Standard OHLCV bucketing:
- **Open:** first `Open` in bucket
- **High:** max `High` in bucket
- **Low:** min `Low` in bucket
- **Close:** last `Close` in bucket
- **Volume:** sum of `Volume` in bucket

Bucket boundaries align to UTC-normalized clock time (00:00, 00:05, 00:15, etc.), consistent with standard MT5/TradingView candle alignment. Aggregated results are cached per timeframe after first computation so repeated switching is instant.

### 4.4 Known Data Edge Case (carried over from EA work)

Sxuoi has already identified a broker-data quirk in older MT5 history where candles begin at 00:00 in some periods and 01:00 in others (likely a DST/server-time boundary shift on the broker's side). The CSV parser must:
- Not assume a fixed session start offset.
- Detect and normalize using the actual timestamps present in the file rather than a hardcoded anchor.
- Surface a non-blocking warning in the UI if a session-start misalignment is detected in the loaded file, so the user is aware rather than silently trusting misaligned bars.

### 4.5 Data Loading UX

Two supported paths, user's choice each time:
1. **File picker (persistent):** `showOpenFilePicker()` — browser remembers the file handle, so on return visits CandleFlow can re-read the same file from disk without the user reselecting it (Chromium-based browsers only; requires permission re-grant per browser session for security).
2. **Drag-and-drop:** manual drop of the CSV onto the chart area — universal fallback, required to be re-done each session in browsers without File System Access API support (Firefox, Safari).

Symbol name and timeframe are inferred from the filename where possible (e.g. `XAUUSD_M1.csv`), editable manually if inference fails or is wrong.

---

## 5. Feature Requirements by Phase

### Phase 1 — Core Chart & Data Loading
- Integrate Lightweight Charts candlestick + volume series.
- CSV parsing (MT5 format) with validation and error reporting (malformed rows, gaps, non-chronological data).
- File picker + drag-and-drop loading paths.
- Base timeframe storage in IndexedDB.

### Phase 2 — Timeframe Switching
- Timeframe selector UI (M1, M5, M15, M30, H1, H4, D1, W1).
- On-the-fly aggregation engine with per-timeframe caching.
- Smooth chart re-render on timeframe change, preserving approximate visible range where possible.

### Phase 3 — Indicators
- Indicator panel/menu (add, configure, remove).
- v1 indicator set:
  - Simple Moving Average (SMA)
  - Exponential Moving Average (EMA)
  - Relative Strength Index (RSI) — separate sub-pane
  - MACD — separate sub-pane
  - Bollinger Bands
  - VWAP
- Each indicator configurable (period, source, color) and persisted per dataset.

### Phase 4 — Drawing Tools (TradingView Parity) — *Critical path, highest design effort*
Toolbar matches the reference layout supplied (top to bottom):

| Tool | Behavior |
|---|---|
| Cursor / Crosshair | Default pointer mode; shows price/time crosshair, no drawing |
| Trend Line | Two-click line between arbitrary time/price points, draggable endpoints after placement |
| Horizontal Ray / Line | Single-click horizontal line at a price level, extends across visible chart, editable price via drag |
| Pattern/Path tool (multi-point) | Connects a sequence of clicked points (e.g. for marking structure/patterns), matching the "connected nodes" icon in the reference |
| Ruler / Measure | Click-drag to measure price distance, bar count, and % change between two points, shown as an overlay label |
| Magnet | Toggleable snap mode — when active, new points/drawings snap to nearest OHLC value on the nearest candle |
| Lock | Toggles editability of all placed drawings (locked drawings can't be moved/deleted until unlocked) |
| Eye / Show-Hide | Toggles visibility of all drawings without deleting them |
| Text | Click-to-place text annotation, editable content, position, and font size |
| Brush | Freehand drawing, stored as a series of time/price points |
| Zoom | Click-drag box-zoom to a specific chart region |
| Eraser / Trash | Deletes a selected drawing, or all drawings on long-press/confirm |

**Technical requirement:** all drawing objects are stored in **time+price coordinate space**, not pixel space, and re-projected to screen coordinates on every pan/zoom/resize event — this is what keeps drawings correctly anchored to the price action exactly as TradingView does, rather than drifting when the chart is zoomed or scrolled.

Each drawing object is individually selectable, draggable, and deletable after placement, and persists per dataset via IndexedDB.

### Phase 5 — Chart Replay
- "Start Replay" mode: user clicks a starting bar; chart truncates all bars after that point.
- Step-forward control: reveals one additional candle at a time (button + keyboard shortcut).
- Optional auto-play with adjustable speed (e.g. 1x, 2x, 4x bars/second).
- Replay position persisted per dataset, so returning to a dataset resumes at the last replay point.
- Exiting replay mode restores the full dataset view.

### Phase 6 — Persistence Layer
- IndexedDB schema keyed by a dataset signature (hash of symbol + timeframe + file size/first-last timestamp) so drawings, indicators, and replay state are correctly reattached when the same data is reloaded.
- Auto-save on every drawing/indicator/replay change (debounced) — no explicit "save" action required.
- No cross-device sync in v1 (explicitly out of scope — see §1.3).

### Phase 7 — Deployment
- Static build (HTML/CSS/JS, no server-side code) suitable for GitHub Pages.
- Fully functional offline once loaded (service worker optional/stretch goal for full offline-first caching of the app shell itself, not the user's data).
- README documenting: how to export MT5 CSV data, how to load it into CandleFlow, and an explicit statement that no data ever leaves the browser.

---

## 6. Non-Functional Requirements

- **Privacy:** No network calls involving user price data, ever. This should be verifiable by inspecting network activity — the deployed app should make zero outbound requests after initial page load (aside from loading the static assets themselves).
- **Performance:** Smooth interaction (pan/zoom/drawing) up to at least 500,000 base-timeframe candles (~1 year of M1 XAUUSD data) without noticeable lag. Aggregation results cached to avoid recomputation on every timeframe switch.
- **Browser support:** Primary target Chromium-based browsers (full File System Access API support). Firefox/Safari supported via drag-and-drop fallback, with feature-detection to hide/adjust UI accordingly.
- **Data integrity:** Parser must reject or flag malformed/non-chronological CSV data rather than silently rendering incorrect candles.
- **No account system:** Zero login friction — open the site, load a file, start working.

---

## 7. Success Criteria

- A user can load their own MT5 CSV export and see a fully rendered, TradingView-equivalent candlestick chart within seconds.
- All listed drawing tools function with correct time/price anchoring across pan, zoom, and timeframe changes.
- Replay mode accurately simulates bar-by-bar historical playback.
- Closing and reopening the browser (same device) restores the exact prior state: data, drawings, indicators, and replay position.
- The published GitHub Pages site works for a second, independent user loading their own data, with zero data crossover or leakage between users.

---

## 8. Open Questions / Risks

| Item | Notes |
|---|---|
| File System Access API browser support | Firefox and Safari lack support; drag-and-drop fallback UX needs to feel equally polished, not like a degraded experience |
| Large file performance | Multi-year M1 exports could be large (hundreds of MB); may need chunked parsing/streaming rather than loading the full file into memory at once |
| Session-start misalignment (00:00 vs 01:00) | Needs a robust, non-hardcoded detection/normalization approach — carried over as an open item from prior EA/data work |
| IndexedDB storage limits | Browser storage quotas vary; large datasets + drawings may need a storage-usage indicator and/or a "clear old datasets" management UI |
| Drawing tool precision at high zoom | Time/price re-projection must remain pixel-accurate at extreme zoom levels to avoid visible drift |

---

## 9. Out of Scope for v1 (Possible Future Phases)

- Cloud sync / multi-device access
- Live data feed integration
- Alerting / notifications
- Strategy scripting or automated backtest scoring (this tool is for *manual* visual backtesting only)
- Mobile-optimized layout
- Multi-symbol comparison / correlation view

---

## 10. Suggested Build Order

1. Phase 1 (chart + data loading) — validates the core rendering approach end-to-end.
2. Phase 2 (timeframe aggregation) — proves the data model scales correctly.
3. Phase 6 (persistence skeleton) — build the IndexedDB layer early so every subsequent phase saves into it rather than retrofitting later.
4. Phase 4 (drawing tools) — highest effort, most critical to "looks exactly like TradingView."
5. Phase 3 (indicators) — largely independent, can be built in parallel with Phase 4.
6. Phase 5 (replay) — builds on the now-stable data + rendering layers.
7. Phase 7 (deployment) — final packaging and GitHub Pages publish.
