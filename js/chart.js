/**
 * CandleFlow — Chart manager (TradingView Lightweight Charts wrapper)
 *
 * Renders candlestick + volume series with a TradingView-style dark theme.
 * Provides an OHLCV legend overlay updated on crosshair move.
 */

export class ChartManager {
  /**
   * @param {HTMLElement} container  Element to mount the chart into
   * @param {HTMLElement} legendEl   OHLCV legend overlay element
   */
  constructor(container, legendEl) {
    this.container = container;
    this.legendEl = legendEl;
    this.chart = null;
    this.candleSeries = null;
    this.volumeSeries = null;
    this._resizeObserver = null;
    this._lastCandle = null;
  }

  init() {
    this.chart = LightweightCharts.createChart(this.container, {
      layout: {
        background: { type: 'solid', color: '#131722' },
        textColor: '#d1d4dc',
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      },
      grid: {
        vertLines: { color: '#1e222d' },
        horzLines: { color: '#1e222d' },
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: { color: '#758696', width: 1, style: 3, labelBackgroundColor: '#2962ff' },
        horzLine: { color: '#758696', width: 1, style: 3, labelBackgroundColor: '#2962ff' },
      },
      rightPriceScale: { borderColor: '#2a2e39' },
      timeScale: {
        borderColor: '#2a2e39',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 25, // default offset to avoid sticking to right edge
      },
      handleScroll: { vertTouchDrag: false },
    });

    // ── Candlestick series ──
    this.candleSeries = this.chart.addCandlestickSeries({
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderUpColor: '#26a69a',
      borderDownColor: '#ef5350',
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
    });

    // ── Volume histogram ──
    this.volumeSeries = this.chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });
    this.chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });

    // ── Crosshair → legend ──
    this.chart.subscribeCrosshairMove((param) => {
      const data = param.seriesData?.get(this.candleSeries);
      if (data && 'open' in data) {
        this._updateLegend(data);
      } else if (this._lastCandle) {
        this._updateLegend(this._lastCandle);
      }
    });

    // ── Auto-resize ──
    this._resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          this.chart.resize(width, height);
        }
      }
    });
    this._resizeObserver.observe(this.container);
  }

  /**
   * Feed candle data into the chart.
   * @param {Array<{time:number, open:number, high:number, low:number, close:number, volume:number}>} candles
   * @param {boolean} fitContent Whether to auto-fit the content
   */
  setData(candles, fitContent = true) {
    this.candleSeries.setData(
      candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })),
    );

    this.volumeSeries.setData(
      candles.map(c => ({
        time: c.time,
        value: c.volume,
        color: c.close >= c.open ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)',
      })),
    );

    this._lastCandle = candles.length > 0 ? candles[candles.length - 1] : null;
    if (this._lastCandle) this._updateLegend(this._lastCandle);

    if (fitContent) {
      this.chart.timeScale().fitContent();
    }
  }

  /** Update the OHLCV legend overlay. */
  _updateLegend(d) {
    if (!this.legendEl) return;
    const dir = d.close >= d.open ? 'up' : 'down';
    this.legendEl.innerHTML = `
      <span>O <b class="${dir}">${d.open.toFixed(2)}</b></span>
      <span>H <b class="${dir}">${d.high.toFixed(2)}</b></span>
      <span>L <b class="${dir}">${d.low.toFixed(2)}</b></span>
      <span>C <b class="${dir}">${d.close.toFixed(2)}</b></span>
      <span>V <b>${(d.volume ?? 0).toLocaleString()}</b></span>
    `;
  }

  destroy() {
    this._resizeObserver?.disconnect();
    this.chart?.remove();
    this.chart = null;
  }
}
