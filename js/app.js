/**
 * CandleFlow — Application entry point
 *
 * Wires together: CSV parser, file loader, chart manager, IndexedDB, filename inference.
 */

import { parseCSV } from './csv-parser.js';
import { inferFromFilename } from './infer.js';
import { openFilePicker, reopenLastFile, setupDragDrop, hasFileSystemAccess } from './file-loader.js';
import { generateSignature, saveDataset } from './db.js';
import { ChartManager } from './chart.js';
import { generateDemoData, DEMO_META } from './demo-data.js';

// ── DOM refs ──
const chartContainer  = document.getElementById('chart-container');
const chartLegend     = document.getElementById('chart-legend');
const dropZone        = document.getElementById('drop-zone');
const demoBanner      = document.getElementById('demo-banner');
const symbolName      = document.getElementById('symbol-name');
const timeframeBadge  = document.getElementById('timeframe-badge');
const btnOpenFile     = document.getElementById('btn-open-file');
const btnOpenFileHero = document.getElementById('btn-open-file-hero');
const btnEditMeta     = document.getElementById('btn-edit-meta');
const metaModal       = document.getElementById('meta-modal');
const inputSymbol     = document.getElementById('input-symbol');
const inputTimeframe  = document.getElementById('input-timeframe');
const loadingOverlay  = document.getElementById('loading-overlay');
const loadingText     = document.getElementById('loading-text');
const notifications   = document.getElementById('notifications');

let chartManager = null;
let currentMeta  = null;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Notifications
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function notify(message, type = 'info', duration = 5000) {
  const el = document.createElement('div');
  el.className = `notification ${type}`;
  el.textContent = message;
  notifications.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));

  if (duration > 0) {
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, duration);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Loading overlay
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function showLoading(msg) { loadingText.textContent = msg; loadingOverlay.classList.remove('hidden'); }
function hideLoading()    { loadingOverlay.classList.add('hidden'); }

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Meta-override modal
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function showMetaModal() {
  return new Promise((resolve) => {
    metaModal.showModal();
    metaModal.addEventListener('close', () => resolve(metaModal.returnValue), { once: true });
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Main pipeline: file → parse → validate → store → render
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function processFile({ text, fileName, fileSize }) {
  showLoading('Parsing CSV…');
  await tick(); // let the overlay render

  const result = parseCSV(text);

  // ── Report errors ──
  if (result.errors.length > 0) {
    notify(`${result.errors.length} parsing issue(s) — check console`, 'error', 8000);
    for (const e of result.errors.slice(0, 20)) console.error('[CandleFlow]', e.message);
  }

  // ── Report warnings ──
  for (const w of result.warnings) {
    notify(w.message, 'warning', 8000);
    console.warn('[CandleFlow]', w.message);
  }

  if (result.candles.length === 0) {
    hideLoading();
    notify('No valid candles found in file.', 'error');
    return;
  }

  // ── Infer symbol / timeframe ──
  let { symbol, timeframe } = inferFromFilename(fileName);

  if (!symbol || !timeframe) {
    hideLoading();
    inputSymbol.value    = symbol || '';
    inputTimeframe.value = timeframe || 'M1';

    const choice = await showMetaModal();
    if (choice === 'confirm') {
      symbol    = inputSymbol.value.trim() || 'UNKNOWN';
      timeframe = inputTimeframe.value;
    } else {
      symbol    = symbol || 'UNKNOWN';
      timeframe = timeframe || 'M1';
    }
    showLoading('Storing data…');
  }

  // ── Build metadata ──
  currentMeta = {
    symbol,
    timeframe,
    fileName,
    fileSize,
    firstTimestamp: result.candles[0].time,
    lastTimestamp:  result.candles[result.candles.length - 1].time,
    candleCount:   result.candles.length,
  };

  // ── Generate signature & persist ──
  showLoading('Storing in IndexedDB…');
  await tick();

  try {
    const sig = await generateSignature(currentMeta);
    currentMeta.signature = sig;
    await saveDataset(sig, currentMeta, result.candles);
  } catch (e) {
    console.error('[CandleFlow] IndexedDB save failed:', e);
    notify('Could not save to IndexedDB — chart will still render.', 'warning');
  }

  // ── Render chart ──
  showLoading('Rendering chart…');
  await tick();
  renderChart(result.candles);

  // ── Update UI ──
  updateHeader();
  btnEditMeta.disabled = false;
  demoBanner?.classList.add('hidden');
  hideLoading();

  notify(`Loaded ${result.candles.length.toLocaleString()} candles — ${symbol} ${timeframe}`, 'success');
}

/** Yield to the event loop so the UI can repaint. */
function tick() { return new Promise((r) => setTimeout(r, 0)); }

function renderChart(candles) {
  if (chartManager) chartManager.destroy();
  chartManager = new ChartManager(chartContainer, chartLegend);
  chartManager.init();
  chartManager.setData(candles);
}

function updateHeader() {
  if (!currentMeta) return;
  symbolName.textContent    = currentMeta.symbol;
  timeframeBadge.textContent = currentMeta.timeframe;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Event bindings
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ── File picker ──
async function handleOpenFile() {
  const data = await openFilePicker();
  if (data) await processFile(data);
}

btnOpenFile.addEventListener('click', handleOpenFile);
btnOpenFileHero.addEventListener('click', handleOpenFile);

// Hide picker buttons on browsers without File System Access API
if (!hasFileSystemAccess) {
  btnOpenFile.style.display = 'none';
  // Replace hero button text to reflect drag-only UX
  btnOpenFileHero.textContent = '📂 Select CSV File';
  // Use a standard <input type="file"> fallback
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.csv';
  fileInput.style.display = 'none';
  document.body.appendChild(fileInput);

  btnOpenFileHero.addEventListener('click', (e) => {
    e.stopImmediatePropagation();
    fileInput.click();
  }, { capture: true });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const text = await file.text();
    await processFile({ text, fileName: file.name, fileSize: file.size });
    fileInput.value = '';   // allow re-selecting same file
  });
}

// ── Drag and drop (always active) ──
setupDragDrop(document.body, dropZone, async (fileData, error) => {
  if (error) { notify(error.message, 'error'); return; }
  if (fileData) await processFile(fileData);
});

// ── Edit meta ──
btnEditMeta.addEventListener('click', async () => {
  if (!currentMeta) return;
  inputSymbol.value    = currentMeta.symbol;
  inputTimeframe.value = currentMeta.timeframe;

  const choice = await showMetaModal();
  if (choice !== 'confirm') return;

  currentMeta.symbol    = inputSymbol.value.trim() || currentMeta.symbol;
  currentMeta.timeframe = inputTimeframe.value;
  updateHeader();
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Init
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

(async () => {
  // Attempt to reopen last file via saved handle (Chromium only)
  if (hasFileSystemAccess) {
    try {
      const data = await reopenLastFile();
      if (data) { await processFile(data); return; }
    } catch (e) {
      console.log('[CandleFlow] Could not reopen last file:', e);
    }
  }

  // No saved file — show demo chart
  loadDemo();
})();

function loadDemo() {
  const candles = generateDemoData();
  currentMeta = { ...DEMO_META, firstTimestamp: candles[0].time, lastTimestamp: candles[candles.length - 1].time, candleCount: candles.length };
  renderChart(candles);
  updateHeader();
  demoBanner?.classList.remove('hidden');
}
