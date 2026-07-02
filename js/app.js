/**
 * CandleFlow — Application entry point
 *
 * Wires together: CSV parser, file loader, chart manager, IndexedDB, filename inference, indicators.
 */

import { parseCSV } from './csv-parser.js';
import { inferFromFilename } from './infer.js';
import { openFilePicker, reopenLastFile, setupDragDrop, hasFileSystemAccess } from './file-loader.js';
import { generateSignature, saveDataset, listDatasets, loadDataset, deleteDataset, saveUserState, setLastActiveSignature, getLastActiveSignature } from './db.js';
import { ChartManager } from './chart.js';
import { DrawingsManager } from './drawings.js';
import { IndicatorRenderer } from './indicator-renderer.js';
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
let drawingsManager = null;
let indicatorRenderer = null;
let currentMeta  = null;
let currentSignature = null;

let currentBaseCandles = null;
let currentBaseTimeframe = null;
let currentTimeframe = null;
let aggregationCache = {};

// Global Drawings State (persisted across chart destroys)
let appMagnetMode = false;
let appDrawingsLocked = false;
let appDrawingsVisible = true;

// Indicator state for persistence across chart destroys
let pendingIndicators = null;


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
  if (indicatorRenderer) { indicatorRenderer.destroy(); indicatorRenderer = null; }
  chartManager = new ChartManager(chartContainer, chartLegend);
  chartManager.init();
  chartManager.setData(candles);

  // Initialize DrawingsManager
  const canvas = document.getElementById('drawing-canvas');
  if (drawingsManager) drawingsManager.destroy();
  drawingsManager = new DrawingsManager(
    chartManager.chart,
    chartManager.candleSeries,
    canvas,
    document.getElementById('chart-wrapper'),
    async (drawings) => {
      if (currentSignature) {
        try {
          await saveUserState(currentSignature, { drawings });
          refreshSidebarList();
        } catch (e) {
          console.error('[CandleFlow] Failed to autosave drawings:', e);
        }
      }
    }
  );

  drawingsManager.setBaseCandles(candles);
  drawingsManager.magnetMode = appMagnetMode;
  drawingsManager.locked = appDrawingsLocked;
  drawingsManager.visible = appDrawingsVisible;

  // Initialize IndicatorRenderer
  const indicatorLegend = document.getElementById('indicator-legend');
  indicatorRenderer = new IndicatorRenderer(
    chartManager.chart,
    chartManager.candleSeries,
    chartManager.volumeSeries,
    indicatorLegend,
    async (indicators) => {
      if (currentSignature) {
        try {
          await saveUserState(currentSignature, { indicators });
        } catch (e) {
          console.error('[CandleFlow] Failed to autosave indicators:', e);
        }
      }
    }
  );
  indicatorRenderer.setCandles(candles, currentTimeframe || currentBaseTimeframe);

  // Restore pending indicators if any (from dataset load)
  if (pendingIndicators) {
    indicatorRenderer.setIndicators(pendingIndicators);
    pendingIndicators = null;
  }

  syncToolbarButtons();
}

function syncToolbarButtons() {
  const btnMagnet = document.getElementById('btn-toggle-magnet');
  const btnLock = document.getElementById('btn-toggle-lock');
  const btnVisible = document.getElementById('btn-toggle-visibility');

  if (btnMagnet) btnMagnet.classList.toggle('enabled-active', appMagnetMode);
  if (btnLock) {
    btnLock.textContent = appDrawingsLocked ? '🔒' : '🔓';
    btnLock.classList.toggle('enabled-active', appDrawingsLocked);
  }
  if (btnVisible) {
    btnVisible.textContent = appDrawingsVisible ? '👁️' : '🙈';
    btnVisible.classList.toggle('enabled-active', !appDrawingsVisible);
  }
  
  // Reset selected tool button to active cursor
  const toolbar = document.getElementById('drawing-toolbar');
  if (toolbar) {
    const toolButtons = toolbar.querySelectorAll('.tool-btn[data-tool]');
    toolButtons.forEach(btn => {
      if (btn.dataset.tool === 'cursor') {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }
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
      if (drawingsManager) {
        drawingsManager.setBaseCandles(candles);
      }
      // Recalculate indicators for the new timeframe
      if (indicatorRenderer) {
        indicatorRenderer.recalculateAll(candles, targetTf);
      }
      
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

    // Queue indicators to be restored after chart init
    pendingIndicators = data.indicators && data.indicators.length > 0 ? data.indicators : null;

    renderChart(data.candles);
    if (drawingsManager) {
      drawingsManager.setDrawings(data.drawings);
    }
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

function initDrawingToolbar() {
  const toolbar = document.getElementById('drawing-toolbar');
  if (!toolbar) return;

  const toolButtons = toolbar.querySelectorAll('.tool-btn[data-tool]');
  const btnMagnet = document.getElementById('btn-toggle-magnet');
  const btnLock = document.getElementById('btn-toggle-lock');
  const btnVisible = document.getElementById('btn-toggle-visibility');
  const btnClear = document.getElementById('btn-clear-drawings');

  toolButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      toolButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tool = btn.dataset.tool;
      if (drawingsManager) {
        drawingsManager.setTool(tool);
      }
    });
  });

  if (btnMagnet) {
    btnMagnet.addEventListener('click', () => {
      appMagnetMode = !appMagnetMode;
      btnMagnet.classList.toggle('enabled-active', appMagnetMode);
      if (drawingsManager) {
        drawingsManager.magnetMode = appMagnetMode;
      }
      notify(appMagnetMode ? 'Magnet Snap Mode enabled' : 'Magnet Snap Mode disabled', 'info', 2000);
    });
  }

  if (btnLock) {
    btnLock.addEventListener('click', () => {
      appDrawingsLocked = !appDrawingsLocked;
      btnLock.textContent = appDrawingsLocked ? '🔒' : '🔓';
      btnLock.classList.toggle('enabled-active', appDrawingsLocked);
      if (drawingsManager) {
        drawingsManager.toggleLock();
      }
      notify(appDrawingsLocked ? 'Drawings locked' : 'Drawings unlocked', 'info', 2000);
    });
  }

  if (btnVisible) {
    btnVisible.addEventListener('click', () => {
      appDrawingsVisible = !appDrawingsVisible;
      btnVisible.textContent = appDrawingsVisible ? '👁️' : '🙈';
      btnVisible.classList.toggle('enabled-active', !appDrawingsVisible);
      if (drawingsManager) {
        drawingsManager.toggleVisibility();
      }
      notify(appDrawingsVisible ? 'Show drawings' : 'Hide drawings', 'info', 2000);
    });
  }

  if (btnClear) {
    btnClear.addEventListener('click', () => {
      if (drawingsManager) {
        drawingsManager.clearAllDrawings();
      }
    });
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Indicator Panel
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const INDICATOR_DISPLAY = {
  SMA:      { label: 'SMA', color: '#2962FF', configFields: ['period'] },
  EMA:      { label: 'EMA', color: '#FF9800', configFields: ['period'] },
  RSI:      { label: 'RSI', color: '#7B1FA2', configFields: ['period'] },
  MACD:     { label: 'MACD', color: '#2962FF', configFields: ['fastPeriod', 'slowPeriod', 'signalPeriod'] },
  BB:       { label: 'Bollinger Bands', color: '#9C27B0', configFields: ['period', 'stddev'] },
  VWAP:     { label: 'VWAP', color: '#FFD600', configFields: [] },
  TIME_SEP: { label: 'Time Separator', color: '#787b86', configFields: [] },
  VOLUME:   { label: 'Volume', color: '#26a69a', configFields: [] },
};

function initIndicatorPanel() {
  const btnIndicators = document.getElementById('btn-indicators');
  const indModal = document.getElementById('indicator-modal');
  const btnCloseIndModal = document.getElementById('btn-close-ind-modal');
  const indActiveList = document.getElementById('ind-active-list');

  if (!btnIndicators || !indModal) return;

  // Open modal
  btnIndicators.addEventListener('click', () => {
    refreshIndActiveList();
    indModal.showModal();
  });

  // Close modal
  if (btnCloseIndModal) {
    btnCloseIndModal.addEventListener('click', () => indModal.close());
  }
  indModal.addEventListener('click', (e) => {
    if (e.target === indModal) indModal.close();
  });

  // Add indicator buttons
  const addBtns = indModal.querySelectorAll('.ind-add-btn[data-ind-type]');
  addBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.indType;
      if (!indicatorRenderer) {
        notify('Load a dataset first to add indicators.', 'warning');
        return;
      }
      indicatorRenderer.addIndicator(type);
      refreshIndActiveList();
      notify(`Added ${INDICATOR_DISPLAY[type]?.label || type}`, 'success', 2000);
    });
  });

  // Active list click delegation (remove buttons)
  if (indActiveList) {
    indActiveList.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('.ind-item-btn.delete');
      if (removeBtn && indicatorRenderer) {
        const id = removeBtn.dataset.indId;
        indicatorRenderer.removeIndicator(id);
        refreshIndActiveList();
        notify('Indicator removed', 'info', 2000);
      }
    });

    // Handle config input changes
    indActiveList.addEventListener('change', (e) => {
      const input = e.target.closest('.ind-config-input');
      if (!input || !indicatorRenderer) return;
      const id = input.dataset.indId;
      const field = input.dataset.field;
      const val = parseFloat(input.value);
      if (isNaN(val) || val <= 0) return;
      indicatorRenderer.updateIndicator(id, { [field]: val });
      refreshIndActiveList();
    });
  }
}

function refreshIndActiveList() {
  const indActiveList = document.getElementById('ind-active-list');
  if (!indActiveList || !indicatorRenderer) return;

  const items = [];

  // Volume toggle
  if (indicatorRenderer.isVolumeVisible()) {
    items.push({ id: 'volume', type: 'VOLUME', config: {} });
  }

  // Regular indicators
  for (const entry of indicatorRenderer.indicators.values()) {
    items.push({ id: entry.id, type: entry.type, config: { ...entry.config } });
  }

  if (items.length === 0) {
    indActiveList.innerHTML = '<li class="ind-empty-msg">No indicators active</li>';
    return;
  }

  indActiveList.innerHTML = '';
  for (const item of items) {
    const display = INDICATOR_DISPLAY[item.type] || { label: item.type, color: '#d1d4dc', configFields: [] };
    const li = document.createElement('li');
    li.className = 'ind-active-item';

    // Config summary
    let configText = '';
    if (item.type === 'SMA' || item.type === 'EMA') configText = `Period: ${item.config.period}`;
    else if (item.type === 'RSI') configText = `Period: ${item.config.period}`;
    else if (item.type === 'BB') configText = `${item.config.period}, ${item.config.stddev}σ`;
    else if (item.type === 'MACD') configText = `${item.config.fastPeriod}/${item.config.slowPeriod}/${item.config.signalPeriod}`;

    li.innerHTML = `
      <div class="ind-active-item-info">
        <span class="ind-active-item-color" style="background:${display.color}"></span>
        <span class="ind-active-item-label">${display.label}</span>
        <span class="ind-active-item-config">${configText}</span>
      </div>
      <div class="ind-active-item-actions">
        <button class="ind-item-btn delete" data-ind-id="${item.id}" title="Remove">🗑️</button>
      </div>
    `;

    // Inline config row (if configurable)
    if (display.configFields.length > 0 && item.id !== 'volume') {
      const configRow = document.createElement('div');
      configRow.className = 'ind-config-row';
      for (const field of display.configFields) {
        const label = document.createElement('label');
        label.textContent = field.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '1';
        input.step = field === 'stddev' ? '0.5' : '1';
        input.value = item.config[field] ?? '';
        input.className = 'ind-config-input';
        input.dataset.indId = item.id;
        input.dataset.field = field;
        configRow.appendChild(label);
        configRow.appendChild(input);
      }
      li.appendChild(configRow);
    }

    indActiveList.appendChild(li);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Init
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

(async () => {
  initDrawingToolbar();
  initIndicatorPanel();

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
