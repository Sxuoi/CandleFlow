/**
 * CandleFlow — Indicator Renderer (Phase 3)
 *
 * Manages indicator series lifecycle on Lightweight Charts.
 * Overlays (SMA/EMA/BB/VWAP) render on the main price scale.
 * Sub-pane indicators (RSI/MACD) render in additional panes.
 * Time Separators use vertical line markers on the candle series.
 */

import {
  calcSMA, calcEMA, calcRSI, calcMACD,
  calcBollingerBands, calcVWAP, calcTimeSeparators,
} from './indicators.js';

// ── Default colors (TradingView-matching) ──
const DEFAULT_COLORS = {
  SMA:  '#2962FF',
  EMA:  '#FF9800',
  RSI:  '#7B1FA2',
  MACD_LINE:   '#2962FF',
  MACD_SIGNAL: '#FF6D00',
  BB_UPPER:  '#9C27B0',
  BB_MIDDLE: '#9C27B0',
  BB_LOWER:  '#9C27B0',
  VWAP: '#FFD600',
  TIME_SEP: '#787b86',
};

// ── Default config per indicator type ──
const DEFAULT_CONFIGS = {
  SMA:  { period: 20, source: 'close', color: DEFAULT_COLORS.SMA },
  EMA:  { period: 9,  source: 'close', color: DEFAULT_COLORS.EMA },
  RSI:  { period: 14, overbought: 70, oversold: 30 },
  MACD: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
  BB:   { period: 20, stddev: 2, source: 'close', color: DEFAULT_COLORS.BB_UPPER },
  VWAP: { color: DEFAULT_COLORS.VWAP },
  TIME_SEP: { color: DEFAULT_COLORS.TIME_SEP },
};

let nextId = 1;

export class IndicatorRenderer {
  /**
   * @param {object} chart           Lightweight Charts instance
   * @param {object} candleSeries    Main candlestick series
   * @param {object} volumeSeries    Existing volume histogram series
   * @param {HTMLElement} legendEl   Legend container for indicator values
   * @param {Function} onChangeCallback  Called when indicators change (for persistence)
   */
  constructor(chart, candleSeries, volumeSeries, legendEl, onChangeCallback) {
    this.chart = chart;
    this.candleSeries = candleSeries;
    this.volumeSeries = volumeSeries;
    this.legendEl = legendEl;
    this.onChangeCallback = onChangeCallback;
    this.indicators = new Map(); // id → { type, config, series[], data }
    this.candles = [];
    this.timeframe = 'M1';
    this._volumeVisible = true;

    // Subscribe to crosshair for legend updates
    this._crosshairHandler = (param) => this._updateLegend(param);
    this.chart.subscribeCrosshairMove(this._crosshairHandler);
  }

  /** Store current candles for calculation. */
  setCandles(candles, timeframe) {
    this.candles = candles;
    this.timeframe = timeframe || this.timeframe;
  }

  /**
   * Incrementally calculate and update indicators for a new candle step.
   * @param {Array} candles All active candles up to the new step.
   * @param {string} timeframe Current timeframe.
   */
  update(candles, timeframe) {
    this.candles = candles;
    this.timeframe = timeframe || this.timeframe;
    if (candles.length === 0) return;

    for (const entry of this.indicators.values()) {
      this._calculateAndUpdate(entry);
    }
  }

  _calculateAndUpdate(entry) {
    const { type, config } = entry;
    const candles = this.candles;
    if (!candles || candles.length === 0) return;

    switch (type) {
      case 'SMA': {
        const data = calcSMA(candles, config.period, config.source);
        if (data.length > 0) {
          entry.series[0].update(data[data.length - 1]);
          entry.data = data;
        }
        break;
      }
      case 'EMA': {
        const data = calcEMA(candles, config.period, config.source);
        if (data.length > 0) {
          entry.series[0].update(data[data.length - 1]);
          entry.data = data;
        }
        break;
      }
      case 'BB': {
        const { upper, middle, lower } = calcBollingerBands(
          candles, config.period, config.stddev, config.source
        );
        if (upper.length > 0) {
          entry.series[0].update(upper[upper.length - 1]);
          entry.series[1].update(middle[middle.length - 1]);
          entry.series[2].update(lower[lower.length - 1]);
          entry.data = { upper, middle, lower };
        }
        break;
      }
      case 'VWAP': {
        const data = calcVWAP(candles);
        if (data.length > 0) {
          entry.series[0].update(data[data.length - 1]);
          entry.data = data;
        }
        break;
      }
      case 'RSI': {
        const data = calcRSI(candles, config.period);
        if (data.length > 0) {
          const last = data[data.length - 1];
          entry.series[0].update(last);
          const obVal = config.overbought || 70;
          const osVal = config.oversold || 30;
          entry.series[1].update({ time: last.time, value: obVal });
          entry.series[2].update({ time: last.time, value: osVal });
          entry.data = data;
        }
        break;
      }
      case 'MACD': {
        const { macd, signal, histogram } = calcMACD(
          candles, config.fastPeriod, config.slowPeriod, config.signalPeriod
        );
        if (macd.length > 0) {
          entry.series[0].update(histogram[histogram.length - 1]);
          entry.series[1].update(macd[macd.length - 1]);
          entry.series[2].update(signal[signal.length - 1]);
          entry.data = { macd, signal, histogram };
        }
        break;
      }
      case 'TIME_SEP': {
        const seps = calcTimeSeparators(candles, this.timeframe);
        entry.data = seps;
        this._applyTimeSeparators(seps, config);
        break;
      }
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Add / Remove / Update
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Add an indicator to the chart.
   * @param {string} type  SMA | EMA | RSI | MACD | BB | VWAP | TIME_SEP | VOLUME
   * @param {object} config  Overrides for default config
   * @returns {string} indicator ID
   */
  addIndicator(type, config = {}) {
    // Special case: Volume toggle
    if (type === 'VOLUME') {
      this._volumeVisible = true;
      this._showVolume(true);
      this._notifyChange();
      return 'volume';
    }

    const id = `ind_${nextId++}`;
    const mergedConfig = { ...DEFAULT_CONFIGS[type], ...config };
    const entry = { id, type, config: mergedConfig, series: [], markers: [] };

    this._createSeries(entry);
    this._calculateAndSet(entry);
    this.indicators.set(id, entry);
    this._notifyChange();
    this._renderLegendStatic();
    return id;
  }

  /**
   * Remove an indicator by ID.
   */
  removeIndicator(id) {
    if (id === 'volume') {
      this._volumeVisible = false;
      this._showVolume(false);
      this._notifyChange();
      return;
    }

    const entry = this.indicators.get(id);
    if (!entry) return;

    for (const s of entry.series) {
      try { this.chart.removeSeries(s); } catch (e) { /* already removed */ }
    }
    this.indicators.delete(id);
    this._notifyChange();
    this._renderLegendStatic();
  }

  /**
   * Update an indicator's config and recalculate.
   */
  updateIndicator(id, newConfig) {
    const entry = this.indicators.get(id);
    if (!entry) return;

    entry.config = { ...entry.config, ...newConfig };
    this._calculateAndSet(entry);
    this._notifyChange();
  }

  /**
   * Recalculate all indicators (called on timeframe switch).
   */
  recalculateAll(candles, timeframe) {
    this.setCandles(candles, timeframe);
    for (const entry of this.indicators.values()) {
      this._calculateAndSet(entry);
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Persistence helpers
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Get serializable list of active indicators for saving.
   */
  getActiveIndicators() {
    const list = [];
    if (this._volumeVisible) {
      list.push({ type: 'VOLUME', config: {} });
    }
    for (const entry of this.indicators.values()) {
      list.push({ type: entry.type, config: { ...entry.config } });
    }
    return list;
  }

  /**
   * Restore indicators from a saved list.
   */
  setIndicators(savedList) {
    // Clear existing
    this._silent = true;
    this.removeAll();

    if (savedList && savedList.length > 0) {
      for (const item of savedList) {
        this.addIndicator(item.type, item.config || {});
      }
    }
    this._silent = false;
    this._notifyChange();
  }

  /**
   * Remove all indicators.
   */
  removeAll() {
    const ids = [...this.indicators.keys()];
    for (const id of ids) {
      this.removeIndicator(id);
    }
  }

  /**
   * Check if a specific indicator type is active.
   */
  hasIndicator(type) {
    if (type === 'VOLUME') return this._volumeVisible;
    for (const entry of this.indicators.values()) {
      if (entry.type === type) return true;
    }
    return false;
  }

  /**
   * Get all entries of a type (for listing in UI).
   */
  getIndicatorsByType(type) {
    const result = [];
    for (const entry of this.indicators.values()) {
      if (entry.type === type) result.push({ id: entry.id, config: { ...entry.config } });
    }
    return result;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Series creation (internal)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  _createSeries(entry) {
    const { type, config } = entry;

    switch (type) {
      case 'SMA':
      case 'EMA': {
        const line = this.chart.addLineSeries({
          color: config.color || DEFAULT_COLORS[type],
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: true,
          crosshairMarkerRadius: 4,
        });
        entry.series = [line];
        entry._seriesLabel = `${type}(${config.period})`;
        break;
      }

      case 'BB': {
        const upper = this.chart.addLineSeries({
          color: config.color || DEFAULT_COLORS.BB_UPPER,
          lineWidth: 1,
          lineStyle: 0,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        const middle = this.chart.addLineSeries({
          color: config.color || DEFAULT_COLORS.BB_MIDDLE,
          lineWidth: 1,
          lineStyle: 2, // dashed
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        const lower = this.chart.addLineSeries({
          color: config.color || DEFAULT_COLORS.BB_LOWER,
          lineWidth: 1,
          lineStyle: 0,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        entry.series = [upper, middle, lower];
        entry._seriesLabel = `BB(${config.period}, ${config.stddev})`;
        break;
      }

      case 'VWAP': {
        const line = this.chart.addLineSeries({
          color: config.color || DEFAULT_COLORS.VWAP,
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: true,
          crosshairMarkerRadius: 4,
        });
        entry.series = [line];
        entry._seriesLabel = 'VWAP';
        break;
      }

      case 'RSI': {
        // RSI rendered on a separate price scale (simulated sub-pane)
        const rsiLine = this.chart.addLineSeries({
          color: '#7B1FA2',
          lineWidth: 2,
          priceScaleId: 'rsi',
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: true,
          crosshairMarkerRadius: 4,
        });
        // Configure RSI price scale at the bottom
        this.chart.priceScale('rsi').applyOptions({
          scaleMargins: { top: 0.75, bottom: 0.0 },
          borderVisible: true,
          borderColor: '#2a2e39',
        });
        // Overbought/oversold reference lines
        const obLine = this.chart.addLineSeries({
          color: 'rgba(239, 83, 80, 0.3)',
          lineWidth: 1,
          lineStyle: 2,
          priceScaleId: 'rsi',
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        const osLine = this.chart.addLineSeries({
          color: 'rgba(38, 166, 154, 0.3)',
          lineWidth: 1,
          lineStyle: 2,
          priceScaleId: 'rsi',
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        entry.series = [rsiLine, obLine, osLine];
        entry._seriesLabel = `RSI(${config.period})`;
        break;
      }

      case 'MACD': {
        // MACD histogram
        const hist = this.chart.addHistogramSeries({
          priceScaleId: 'macd',
          priceLineVisible: false,
          lastValueVisible: false,
        });
        // MACD line
        const macdLine = this.chart.addLineSeries({
          color: DEFAULT_COLORS.MACD_LINE,
          lineWidth: 2,
          priceScaleId: 'macd',
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: true,
          crosshairMarkerRadius: 4,
        });
        // Signal line
        const sigLine = this.chart.addLineSeries({
          color: DEFAULT_COLORS.MACD_SIGNAL,
          lineWidth: 2,
          priceScaleId: 'macd',
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: true,
          crosshairMarkerRadius: 4,
        });
        // Configure MACD price scale
        this.chart.priceScale('macd').applyOptions({
          scaleMargins: { top: 0.75, bottom: 0.0 },
          borderVisible: true,
          borderColor: '#2a2e39',
        });
        entry.series = [hist, macdLine, sigLine];
        entry._seriesLabel = `MACD(${config.fastPeriod},${config.slowPeriod},${config.signalPeriod})`;
        break;
      }

      case 'TIME_SEP': {
        // No series — uses markers on the candle series
        entry.series = [];
        entry._seriesLabel = 'Time Sep';
        break;
      }
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Calculate and set data (internal)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  _calculateAndSet(entry) {
    const { type, config } = entry;
    const candles = this.candles;
    if (!candles || candles.length === 0) return;

    switch (type) {
      case 'SMA': {
        const data = calcSMA(candles, config.period, config.source);
        entry.series[0].setData(data);
        entry.data = data;
        break;
      }
      case 'EMA': {
        const data = calcEMA(candles, config.period, config.source);
        entry.series[0].setData(data);
        entry.data = data;
        break;
      }
      case 'BB': {
        const { upper, middle, lower } = calcBollingerBands(
          candles, config.period, config.stddev, config.source
        );
        entry.series[0].setData(upper);
        entry.series[1].setData(middle);
        entry.series[2].setData(lower);
        entry.data = { upper, middle, lower };
        break;
      }
      case 'VWAP': {
        const data = calcVWAP(candles);
        entry.series[0].setData(data);
        entry.data = data;
        break;
      }
      case 'RSI': {
        const data = calcRSI(candles, config.period);
        entry.series[0].setData(data);
        // Overbought / oversold reference lines
        if (data.length > 0) {
          const obData = [
            { time: data[0].time, value: config.overbought || 70 },
            { time: data[data.length - 1].time, value: config.overbought || 70 },
          ];
          const osData = [
            { time: data[0].time, value: config.oversold || 30 },
            { time: data[data.length - 1].time, value: config.oversold || 30 },
          ];
          entry.series[1].setData(obData);
          entry.series[2].setData(osData);
        }
        entry.data = data;
        break;
      }
      case 'MACD': {
        const { macd, signal, histogram } = calcMACD(
          candles, config.fastPeriod, config.slowPeriod, config.signalPeriod
        );
        entry.series[0].setData(histogram);
        entry.series[1].setData(macd);
        entry.series[2].setData(signal);
        entry.data = { macd, signal, histogram };
        break;
      }
      case 'TIME_SEP': {
        const seps = calcTimeSeparators(candles, this.timeframe);
        // Use markers on candlestick series for vertical separators
        const markers = seps.map(s => ({
          time: s.time,
          position: 'aboveBar',
          shape: 'square',
          color: 'transparent',
          text: '',
        }));
        // We store the time separator info and render via vertical line workaround
        entry.data = seps;
        this._applyTimeSeparators(seps, config);
        break;
      }
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Time separator rendering via price line workaround
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  _applyTimeSeparators(seps, config) {
    // Use a dedicated line series per separator to draw verticals
    // This is the most compatible approach with Lightweight Charts
    // We create a thin, hidden area series that acts as a time marker
    const color = config.color || DEFAULT_COLORS.TIME_SEP;

    // Find existing time_sep entries and remove old series
    for (const entry of this.indicators.values()) {
      if (entry.type === 'TIME_SEP' && entry._sepSeries) {
        for (const s of entry._sepSeries) {
          try { this.chart.removeSeries(s); } catch (e) { /* */ }
        }
        entry._sepSeries = [];
      }
    }

    // Time separators are best rendered as markers on the candle series
    this._rebuildMarkers();
  }

  /**
   * Rebuild all markers on the candle series (time separators use marker-like indicators).
   */
  _rebuildMarkers() {
    // Collect time separator times
    let allMarkers = [];
    for (const entry of this.indicators.values()) {
      if (entry.type === 'TIME_SEP' && entry.data) {
        const color = entry.config.color || DEFAULT_COLORS.TIME_SEP;
        for (const sep of entry.data) {
          allMarkers.push({
            time: sep.time,
            position: 'aboveBar',
            color: color,
            shape: 'arrowDown',
            text: '│',
            size: 0,
          });
        }
      }
    }
    // Sort markers by time (required by Lightweight Charts)
    allMarkers.sort((a, b) => a.time - b.time);
    try {
      this.candleSeries.setMarkers(allMarkers);
    } catch (e) {
      console.warn('[IndicatorRenderer] Could not set markers:', e);
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Volume toggle
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  _showVolume(visible) {
    if (!this.volumeSeries) return;
    try {
      this.chart.priceScale('volume').applyOptions({
        scaleMargins: { top: visible ? 0.8 : 1.0, bottom: 0 },
      });
      // Make the series data transparent if hidden
      if (!visible) {
        this.volumeSeries.applyOptions({ visible: false });
      } else {
        this.volumeSeries.applyOptions({ visible: true });
      }
    } catch (e) {
      console.warn('[IndicatorRenderer] Volume toggle error:', e);
    }
  }

  isVolumeVisible() {
    return this._volumeVisible;
  }

  toggleVolume() {
    this._volumeVisible = !this._volumeVisible;
    this._showVolume(this._volumeVisible);
    this._notifyChange();
    return this._volumeVisible;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Legend (crosshair-synced indicator values)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  _updateLegend(param) {
    if (!this.legendEl) return;
    if (this.indicators.size === 0) {
      this.legendEl.innerHTML = '';
      return;
    }

    const parts = [];
    for (const entry of this.indicators.values()) {
      const label = entry._seriesLabel || entry.type;
      const color = entry.config?.color || DEFAULT_COLORS[entry.type] || '#d1d4dc';

      if (entry.type === 'TIME_SEP') continue;

      if (entry.series.length > 0 && param.seriesData) {
        // Single-series indicators
        if (['SMA', 'EMA', 'VWAP'].includes(entry.type)) {
          const d = param.seriesData.get(entry.series[0]);
          if (d && 'value' in d) {
            parts.push(`<span class="ind-legend-item" style="color:${color}">${label}: <b>${d.value.toFixed(2)}</b></span>`);
          }
        }
        // BB
        else if (entry.type === 'BB') {
          const u = param.seriesData.get(entry.series[0]);
          const m = param.seriesData.get(entry.series[1]);
          const l = param.seriesData.get(entry.series[2]);
          if (u && m && l) {
            parts.push(`<span class="ind-legend-item" style="color:${color}">${label}: <b>${u.value?.toFixed(2)}</b> / <b>${m.value?.toFixed(2)}</b> / <b>${l.value?.toFixed(2)}</b></span>`);
          }
        }
        // RSI
        else if (entry.type === 'RSI') {
          const d = param.seriesData.get(entry.series[0]);
          if (d && 'value' in d) {
            const rsiColor = d.value > 70 ? '#ef5350' : d.value < 30 ? '#26a69a' : '#7B1FA2';
            parts.push(`<span class="ind-legend-item" style="color:${rsiColor}">RSI(${entry.config.period}): <b>${d.value.toFixed(2)}</b></span>`);
          }
        }
        // MACD
        else if (entry.type === 'MACD') {
          const macdD = param.seriesData.get(entry.series[1]);
          const sigD = param.seriesData.get(entry.series[2]);
          if (macdD && sigD) {
            parts.push(`<span class="ind-legend-item" style="color:${DEFAULT_COLORS.MACD_LINE}">MACD: <b>${macdD.value?.toFixed(2)}</b></span>`);
            parts.push(`<span class="ind-legend-item" style="color:${DEFAULT_COLORS.MACD_SIGNAL}">Signal: <b>${sigD.value?.toFixed(2)}</b></span>`);
          }
        }
      }
    }

    this.legendEl.innerHTML = parts.join('');
  }

  /** Render a static label for each indicator (when crosshair is not active). */
  _renderLegendStatic() {
    if (!this.legendEl) return;
    if (this.indicators.size === 0) {
      this.legendEl.innerHTML = '';
      return;
    }
    const parts = [];
    for (const entry of this.indicators.values()) {
      if (entry.type === 'TIME_SEP') continue;
      const label = entry._seriesLabel || entry.type;
      const color = entry.config?.color || DEFAULT_COLORS[entry.type] || '#d1d4dc';
      parts.push(`<span class="ind-legend-item" style="color:${color}">${label}</span>`);
    }
    this.legendEl.innerHTML = parts.join('');
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Cleanup
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  _notifyChange() {
    if (this._silent) return;
    if (this.onChangeCallback) {
      this.onChangeCallback(this.getActiveIndicators());
    }
  }

  destroy() {
    try {
      this.chart.unsubscribeCrosshairMove(this._crosshairHandler);
    } catch (e) { /* */ }
    this.removeAll();
    // Clear markers
    try { this.candleSeries.setMarkers([]); } catch (e) { /* */ }
    if (this.legendEl) this.legendEl.innerHTML = '';
  }
}
