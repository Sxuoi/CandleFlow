/**
 * CandleFlow — Application entry point
 *
 * Wires together: CSV parser, file loader, chart manager, IndexedDB, filename inference.
 */

import { parseCSV } from './csv-parser.js';
import { inferFromFilename } from './infer.js';
import { openFilePicker, reopenLastFile, setupDragDrop, hasFileSystemAccess } from './file-loader.js';
import { generateSignature, saveDataset, listDatasets, loadDataset, deleteDataset, saveUserState, setLastActiveSignature, getLastActiveSignature } from './db.js';
import { ChartManager } from './chart.js';
import { generateDemoData, DEMO_META } from './demo-data.js';
import { aggregateCandles, TIMEFRAME_MINUTES } from './aggregation.js';

// ── DOM refs ──
const chartContainer  = document.getElementById('chart-container');
const chartLegend     = document.getElementById('chart-legend');
const dropZone        = document.getElementById('drop-zone');
const demoBanner      = document.getElementById('demo-banner');
const symbolName      = document.getElementById('symbol-name');
const tfSelector      = document.getElementById('timeframe-selector');
const btnLoadTest     = document.getElementById('btn-load-test');
const btnOpenFile     = document.getElementById('btn-open-file');
const btnOpenFileHero = document.getElementById('btn-open-file-hero');
const btnEditMeta     = document.getElementById('btn-edit-meta');
const metaModal       = document.getElementById('meta-modal');
const inputSymbol     = document.getElementById('input-symbol');
const inputTimeframe  = document.getElementById('input-timeframe');
const loadingOverlay  = document.getElementById('loading-overlay');
const loadingText     = document.getElementById('loading-text');
const notifications   = document.getElementById('notifications');

// Sidebar DOM elements
const sidebar         = document.getElementById('sidebar');
const btnCloseSidebar = document.getElementById('btn-close-sidebar');
const btnToggleSide   = document.getElementById('btn-toggle-datasets');
const datasetsList    = document.getElementById('datasets-list');
const datasetsEmpty   = document.getElementById('datasets-list-empty');
const btnMockSave     = document.getElementById('btn-mock-save');

let chartManager = null;
let currentMeta  = null;
let currentSignature = null;

let currentBaseCandles = null;
let currentBaseTimeframe = null;
let currentTimeframe = null;
let aggregationCache = {};

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
    currentSignature = sig;
    await saveDataset(sig, currentMeta, result.candles);
    await setLastActiveSignature(sig);
    refreshSidebarList();
  } catch (e) {
    console.error('[CandleFlow] IndexedDB save failed:', e);
    notify('Could not save to IndexedDB — chart will still render.', 'warning');
  }

  // ── Render chart ──
  showLoading('Rendering chart…');
  await tick();
  renderChart(result.candles);

  // ── Update State ──
  currentBaseCandles = result.candles;
  currentBaseTimeframe = timeframe;
  currentTimeframe = timeframe;
  aggregationCache = { [timeframe]: result.candles };

  // ── Update UI ──
  updateHeader();
  updateTimeframeButtons();
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
}

function updateTimeframeButtons() {
  if (!tfSelector) return;
  const buttons = tfSelector.querySelectorAll('.tf-btn');
  const baseMinutes = TIMEFRAME_MINUTES[currentBaseTimeframe] || 1;

  buttons.forEach(btn => {
    const tf = btn.dataset.tf;
    const minutes = TIMEFRAME_MINUTES[tf] || 1;
    
    // Disable if the target timeframe is smaller than the base timeframe
    const isDisabled = minutes < baseMinutes;
    btn.disabled = isDisabled;
    
    // Set active class
    if (tf === currentTimeframe) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

async function switchTimeframe(targetTf) {
  if (!currentBaseCandles || !currentMeta) return;
  if (targetTf === currentTimeframe) return;

  showLoading(`Switching to ${targetTf}…`);
  await tick();

  try {
    let candles = aggregationCache[targetTf];
    if (!candles) {
      if (targetTf === currentBaseTimeframe) {
        candles = currentBaseCandles;
      } else {
        candles = aggregateCandles(currentBaseCandles, targetTf);
      }
      aggregationCache[targetTf] = candles;
    }

    // Get current visible time range to preserve it
    let visibleRange = null;
    if (chartManager && chartManager.chart) {
      try {
        visibleRange = chartManager.chart.timeScale().getVisibleRange();
      } catch (err) {
        console.warn('Could not get visible time range:', err);
      }
    }

    // Set new data on the chart
    if (chartManager) {
      chartManager.setData(candles);
      
      // Preserve visible time range if possible
      if (visibleRange && visibleRange.from && visibleRange.to) {
        try {
          chartManager.chart.timeScale().setVisibleRange(visibleRange);
        } catch (err) {
          console.warn('Could not restore visible time range:', err);
        }
      }
    }

    currentTimeframe = targetTf;
    updateTimeframeButtons();
  } catch (err) {
    console.error('Timeframe switch failed:', err);
    notify('Failed to switch timeframe.', 'error');
  } finally {
    hideLoading();
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Sidebar & Stored Datasets Controllers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function escapeHTML(str) {
  if (!str) return '';
  return str.toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function refreshSidebarList() {
  if (!datasetsList || !datasetsEmpty) return;

  try {
    const list = await listDatasets();
    datasetsList.innerHTML = '';

    if (list.length === 0) {
      datasetsEmpty.classList.remove('hidden');
      return;
    }

    datasetsEmpty.classList.add('hidden');
    list.forEach(item => {
      const li = document.createElement('li');
      const isActive = item.signature === currentSignature;
      li.className = `dataset-item ${isActive ? 'active' : ''}`;
      li.dataset.sig = item.signature;

      const start = new Date(item.meta.firstTimestamp * 1000).toLocaleDateString();
      const end = new Date(item.meta.lastTimestamp * 1000).toLocaleDateString();
      const bars = item.meta.candleCount.toLocaleString();

      li.innerHTML = `
        <div class="dataset-item-header">
          <span class="dataset-item-title">${escapeHTML(item.meta.symbol)}</span>
          <span class="dataset-item-tf">${escapeHTML(item.meta.timeframe)}</span>
        </div>
        <div class="dataset-item-details">
          <div>${start} - ${end}</div>
          <div>${bars} bars • ${item.drawingsCount} drawings</div>
        </div>
        <div class="dataset-item-actions">
          <button class="dataset-action-btn btn-load" title="Load dataset">📂 Load</button>
          <button class="dataset-action-btn btn-delete" title="Delete dataset">🗑️</button>
        </div>
      `;

      datasetsList.appendChild(li);
    });
  } catch (err) {
    console.error('Failed to list datasets:', err);
  }
}

function toggleSidebar(forceState) {
  if (!sidebar || !btnToggleSide) return;
  const isCollapsed = sidebar.classList.contains('collapsed');
  const shouldCollapse = forceState !== undefined ? !forceState : !isCollapsed;

  if (shouldCollapse) {
    sidebar.classList.add('collapsed');
    btnToggleSide.classList.remove('active');
  } else {
    sidebar.classList.remove('collapsed');
    btnToggleSide.classList.add('active');
    refreshSidebarList();
  }
}

async function loadStoredDataset(signature) {
  showLoading('Loading saved dataset…');
  await tick();

  try {
    const data = await loadDataset(signature);
    if (!data) {
      notify('Dataset not found in storage.', 'error');
      return false;
    }

    currentSignature = signature;
    currentMeta = data.meta;
    currentBaseCandles = data.candles;
    currentBaseTimeframe = data.meta.timeframe;
    currentTimeframe = data.meta.timeframe;
    aggregationCache = { [data.meta.timeframe]: data.candles };

    console.log('[CandleFlow] Loaded saved state:', {
      drawingsCount: data.drawings.length,
      indicatorsCount: data.indicators.length,
      replayState: data.replayState
    });

    renderChart(data.candles);
    updateHeader();
    updateTimeframeButtons();
    
    await setLastActiveSignature(signature);

    demoBanner?.classList.add('hidden');
    btnEditMeta.disabled = false;
    refreshSidebarList();
    
    notify(`Loaded ${data.meta.symbol} ${data.meta.timeframe} from storage`, 'success');
    return true;
  } catch (err) {
    console.error('Failed to load stored dataset:', err);
    notify('Failed to load dataset from IndexedDB.', 'error');
    return false;
  } finally {
    hideLoading();
  }
}

async function deleteStoredDataset(signature) {
  const list = await listDatasets();
  const dataset = list.find(d => d.signature === signature);
  if (!dataset) return;

  const confirmDelete = confirm(`Are you sure you want to delete the dataset for "${dataset.meta.symbol} ${dataset.meta.timeframe}"?\nThis will remove all candles, indicators, and drawings.`);
  if (!confirmDelete) return;

  try {
    await deleteDataset(signature);
    notify(`Deleted dataset ${dataset.meta.symbol} from storage`, 'success');

    if (signature === currentSignature) {
      currentSignature = null;
      await setLastActiveSignature(null);
      loadDemo();
    } else {
      refreshSidebarList();
    }
  } catch (err) {
    console.error('Failed to delete dataset:', err);
    notify('Failed to delete dataset from IndexedDB.', 'error');
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Event bindings
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ── Test CSV loader ──
if (btnLoadTest) {
  btnLoadTest.addEventListener('click', async () => {
    try {
      showLoading('Loading test CSV…');
      const resp = await fetch('/XAUUSDu_M1_202512190711_202604060756.csv');
      const text = await resp.text();
      await processFile({ text, fileName: 'XAUUSDu_M1_202512190711_202604060756.csv', fileSize: text.length });
    } catch (e) {
      console.error(e);
      notify('Failed to load test CSV', 'error');
    }
  });
}

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

// ── Timeframe selector ──
if (tfSelector) {
  tfSelector.addEventListener('click', (e) => {
    const btn = e.target.closest('.tf-btn');
    if (!btn || btn.disabled) return;
    const targetTf = btn.dataset.tf;
    switchTimeframe(targetTf);
  });
}

// ── Sidebar toggles ──
if (btnToggleSide) {
  btnToggleSide.addEventListener('click', () => toggleSidebar());
}
if (btnCloseSidebar) {
  btnCloseSidebar.addEventListener('click', () => toggleSidebar(false));
}

// ── Sidebar list clicks (Load / Delete) ──
if (datasetsList) {
  datasetsList.addEventListener('click', async (e) => {
    const itemEl = e.target.closest('.dataset-item');
    if (!itemEl) return;
    const sig = itemEl.dataset.sig;

    if (e.target.closest('.btn-delete')) {
      e.stopPropagation();
      await deleteStoredDataset(sig);
    } else if (e.target.closest('.btn-load') || e.target.closest('.dataset-item')) {
      await loadStoredDataset(sig);
    }
  });
}

// ── Mock Save trigger (Phase 6 testing) ──
if (btnMockSave) {
  btnMockSave.addEventListener('click', async () => {
    if (!currentSignature) {
      notify('Please load a user dataset first (demo data cannot be modified).', 'warning');
      return;
    }

    try {
      const mockDrawings = [
        { id: 1, type: 'trend', points: [{ t: Date.now(), p: 4300 }, { t: Date.now() + 3600, p: 4400 }] }
      ];
      const mockIndicators = [
        { type: 'SMA', period: 20 }
      ];

      await saveUserState(currentSignature, {
        drawings: mockDrawings,
        indicators: mockIndicators
      });

      notify('Saved mock drawings and indicators state successfully!', 'success');
      refreshSidebarList();
    } catch (e) {
      console.error(e);
      notify('Mock save failed', 'error');
    }
  });
}

// ── Edit meta ──
btnEditMeta.addEventListener('click', async () => {
  if (!currentMeta) return;
  inputSymbol.value    = currentMeta.symbol;
  inputTimeframe.value = currentBaseTimeframe;

  const choice = await showMetaModal();
  if (choice !== 'confirm') return;

  const newSymbol = inputSymbol.value.trim() || currentMeta.symbol;
  const newBaseTf = inputTimeframe.value;

  currentMeta.symbol = newSymbol;
  currentMeta.timeframe = newBaseTf;
  updateHeader();

  if (newBaseTf !== currentBaseTimeframe) {
    currentBaseTimeframe = newBaseTf;
    currentTimeframe = newBaseTf;
    aggregationCache = { [newBaseTf]: currentBaseCandles };
    updateTimeframeButtons();
    if (chartManager) {
      chartManager.setData(currentBaseCandles);
    }
  }

  if (currentSignature) {
    try {
      await saveUserState(currentSignature, { meta: currentMeta });
      refreshSidebarList();
      notify('Updated metadata in storage.', 'success');
    } catch (e) {
      console.error('Failed to update metadata in IndexedDB:', e);
    }
  }
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

  // Restore last active signature on startup
  try {
    const lastSig = await getLastActiveSignature();
    if (lastSig) {
      const loaded = await loadStoredDataset(lastSig);
      if (loaded) return;
    }
  } catch (e) {
    console.log('[CandleFlow] Could not restore last session:', e);
  }

  // No saved file or session — show demo chart
  loadDemo();
})();

function loadDemo() {
  const candles = generateDemoData();
  currentMeta = { ...DEMO_META, firstTimestamp: candles[0].time, lastTimestamp: candles[candles.length - 1].time, candleCount: candles.length };
  
  currentSignature = null;
  currentBaseCandles = candles;
  currentBaseTimeframe = DEMO_META.timeframe;
  currentTimeframe = DEMO_META.timeframe;
  aggregationCache = { [DEMO_META.timeframe]: candles };

  renderChart(candles);
  updateHeader();
  updateTimeframeButtons();
  demoBanner?.classList.remove('hidden');
  refreshSidebarList();
}
