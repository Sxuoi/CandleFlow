/**
 * CandleFlow — Chart Replay Manager (Phase 5)
 *
 * Simulates bar-by-bar historical replay.
 * Truncates base timeframe data at a cutoff time, and aggregates/re-renders
 * all chart series, indicators, and drawings up to that point.
 */

export class ReplayManager {
  /**
   * @param {object} chartManager     Active ChartManager instance
   * @param {Function} getBaseCandles  Function returning current base candles array
   * @param {Function} getBaseTimeframe Function returning current base timeframe code (e.g. M1)
   * @param {Function} getCurrentTimeframe Function returning currently viewed timeframe code
   * @param {Function} onUpdateData   Callback when dataset is truncated: (candles, timeframe) => void
   * @param {Function} onStateChange  Callback when replay state changes (for IndexedDB save)
   */
  constructor({
    chartManager,
    getBaseCandles,
    getBaseTimeframe,
    getCurrentTimeframe,
    onUpdateData,
    onStateChange
  }) {
    this.chartManager = chartManager;
    this.getBaseCandles = getBaseCandles;
    this.getBaseTimeframe = getBaseTimeframe;
    this.getCurrentTimeframe = getCurrentTimeframe;
    this.onUpdateData = onUpdateData;
    this.onStateChange = onStateChange;

    this.active = false;
    this.isSelecting = false;
    this.startTime = null;
    this.currentTime = null;
    
    // Playback state
    this.isPlaying = false;
    this.speed = 1000; // ms per bar (default 1s)
    this.playInterval = null;

    this.toolbarEl = null;

    // Chart click listener
    this._chartClickHandler = (param) => this._handleChartClick(param);
    this.chartManager.chart.subscribeClick(this._chartClickHandler);

    // Keyboard handler bound to this
    this._keydownHandler = (e) => this._handleKeyDown(e);
    window.addEventListener('keydown', this._keydownHandler);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Replay Lifecycle
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /** Start selection mode - user selects starting candle on chart */
  startSelection() {
    if (this.active) {
      // If already active, just trigger "Jump to" mode
      this.isSelecting = true;
      this.chartManager.container.classList.add('replay-select-cursor');
      if (this.isPlaying) this.pause();
      return;
    }

    this.isSelecting = true;
    this.chartManager.container.classList.add('replay-select-cursor');
  }

  cancelSelection() {
    this.isSelecting = false;
    this.chartManager.container.classList.remove('replay-select-cursor');
  }

  /**
   * Set start point of replay by timestamp.
   */
  setStartPoint(timestamp) {
    const baseCandles = this.getBaseCandles();
    if (!baseCandles || baseCandles.length === 0) return;

    // Find closest candle index in base data
    let idx = baseCandles.findIndex(c => c.time === timestamp);
    if (idx === -1) {
      // Find the last candle before or at timestamp
      for (let i = baseCandles.length - 1; i >= 0; i--) {
        if (baseCandles[i].time <= timestamp) {
          idx = i;
          break;
        }
      }
    }

    if (idx === -1) idx = 0; // fallback to beginning

    this.active = true;
    this.isSelecting = false;
    this.chartManager.container.classList.remove('replay-select-cursor');

    this.startTime = baseCandles[idx].time;
    this.currentTime = baseCandles[idx].time;

    this._showToolbar();
    this._updateChart();
    this._notifyState();
  }

  /** Step forward 1 bar on the base timeframe */
  stepForward() {
    if (!this.active) return;
    const baseCandles = this.getBaseCandles();
    const idx = baseCandles.findIndex(c => c.time === this.currentTime);
    
    if (idx !== -1 && idx < baseCandles.length - 1) {
      this.currentTime = baseCandles[idx + 1].time;
      this._updateChart();
      this._notifyState();
    } else {
      this.pause();
    }
  }

  /** Play / Pause autoplay */
  togglePlay() {
    if (!this.active) return;
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  play() {
    if (!this.active || this.isPlaying) return;
    this.isPlaying = true;
    this._updatePlayButtonUI();

    this.playInterval = setInterval(() => {
      this.stepForward();
    }, this.speed);
  }

  pause() {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    this._updatePlayButtonUI();

    if (this.playInterval) {
      clearInterval(this.playInterval);
      this.playInterval = null;
    }
  }

  /** Set playback speed in seconds per bar */
  setSpeed(seconds) {
    this.speed = seconds * 1000;
    if (this.isPlaying) {
      this.pause();
      this.play();
    }
    this._notifyState();
  }

  /** Close replay mode and restore full chart data */
  exit() {
    this.pause();
    this.active = false;
    this.isSelecting = false;
    this.startTime = null;
    this.currentTime = null;

    this.chartManager.container.classList.remove('replay-select-cursor');
    this._removeToolbar();

    // Restore full dataset
    this.onUpdateData(this.getBaseCandles(), this.getCurrentTimeframe());
    this._notifyState();
  }

  /** Restore state from DB load */
  loadSavedState(state) {
    if (!state) return;
    this.speed = state.speed || 1000;
    if (state.currentTime) {
      this.active = true;
      this.startTime = state.startTime;
      this.currentTime = state.currentTime;
      this._showToolbar();
      this._updateChart();
    }
  }

  /**
   * Get the subset of base candles up to currentTime.
   * @returns {Array} Truncated base candles.
   */
  getTruncatedCandles() {
    if (!this.active) return this.getBaseCandles();
    const base = this.getBaseCandles();
    const idx = base.findIndex(c => c.time === this.currentTime);
    return idx === -1 ? base : base.slice(0, idx + 1);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Internal Operations
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  _handleChartClick(param) {
    if (!this.isSelecting) return;
    const timestamp = param.time;
    if (timestamp) {
      this.setStartPoint(timestamp);
    }
  }

  /** Slice the base candles up to current time and notify listeners */
  _updateChart() {
    const baseCandles = this.getBaseCandles();
    const idx = baseCandles.findIndex(c => c.time === this.currentTime);
    if (idx === -1) return;

    const truncated = baseCandles.slice(0, idx + 1);
    this.onUpdateData(truncated, this.getCurrentTimeframe());
  }

  _notifyState() {
    if (this.onStateChange) {
      this.onStateChange(this.active ? {
        startTime: this.startTime,
        currentTime: this.currentTime,
        speed: this.speed
      } : null);
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Floating Toolbar Rendering & Dragging
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  _showToolbar() {
    if (this.toolbarEl) return;

    const wrapper = document.getElementById('chart-wrapper');
    if (!wrapper) return;

    const toolbar = document.createElement('div');
    toolbar.id = 'replay-toolbar';
    toolbar.className = 'floating-replay-toolbar';
    toolbar.innerHTML = `
      <div class="replay-drag-handle" title="Drag Replay Toolbar">⋮⋮</div>
      <button class="replay-btn" id="replay-btn-jump" title="Jump to start point (Bar Select)">⏮️</button>
      <button class="replay-btn" id="replay-btn-play" title="Play / Pause (Space)">▶️</button>
      <button class="replay-btn" id="replay-btn-step" title="Step Forward (Right Arrow)">➡️</button>
      <div class="replay-speed-wrapper">
        <select id="replay-speed-select" title="Speed selector">
          <option value="5">5s / bar</option>
          <option value="3">3s / bar</option>
          <option value="2">2s / bar</option>
          <option value="1" selected>1s / bar</option>
          <option value="0.5">0.5s / bar</option>
        </select>
      </div>
      <button class="replay-btn exit" id="replay-btn-exit" title="Exit Replay (Esc)">✕</button>
    `;

    wrapper.appendChild(toolbar);
    this.toolbarEl = toolbar;

    // Select correct option for speed dropdown
    const select = toolbar.querySelector('#replay-speed-select');
    if (select) {
      select.value = (this.speed / 1000).toString();
    }

    // Set initial position
    toolbar.style.top = '60px';
    toolbar.style.left = '50%';
    toolbar.style.transform = 'translateX(-50%)';

    this._bindToolbarEvents();
  }

  _updatePlayButtonUI() {
    const playBtn = document.getElementById('replay-btn-play');
    if (playBtn) {
      playBtn.textContent = this.isPlaying ? '⏸️' : '▶️';
    }
  }

  _bindToolbarEvents() {
    const toolbar = this.toolbarEl;
    if (!toolbar) return;

    // Button event listeners
    toolbar.querySelector('#replay-btn-jump').addEventListener('click', () => this.startSelection());
    toolbar.querySelector('#replay-btn-play').addEventListener('click', () => this.togglePlay());
    toolbar.querySelector('#replay-btn-step').addEventListener('click', () => this.stepForward());
    toolbar.querySelector('#replay-btn-exit').addEventListener('click', () => this.exit());

    const select = toolbar.querySelector('#replay-speed-select');
    select.addEventListener('change', (e) => {
      this.setSpeed(parseFloat(e.target.value));
    });

    // Make widget draggable
    const handle = toolbar.querySelector('.replay-drag-handle');
    let isDragging = false;
    let offsetX = 0;
    let offsetY = 0;

    const onMouseDown = (e) => {
      isDragging = true;
      // Temporarily disable transition transforms during drag
      toolbar.style.transform = 'none';
      const rect = toolbar.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      e.preventDefault();
    };

    const onMouseMove = (e) => {
      if (!isDragging) return;
      const parentRect = toolbar.parentElement.getBoundingClientRect();
      let left = e.clientX - parentRect.left - offsetX;
      let top = e.clientY - parentRect.top - offsetY;

      // Constrain position within chart container
      const maxLeft = parentRect.width - toolbar.offsetWidth;
      const maxTop = parentRect.height - toolbar.offsetHeight;
      left = Math.max(0, Math.min(left, maxLeft));
      top = Math.max(0, Math.min(top, maxTop));

      toolbar.style.left = `${left}px`;
      toolbar.style.top = `${top}px`;
    };

    const onMouseUp = () => {
      isDragging = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    handle.addEventListener('mousedown', onMouseDown);
  }

  _removeToolbar() {
    if (this.toolbarEl) {
      this.toolbarEl.remove();
      this.toolbarEl = null;
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Keyboard Shortcuts Handler
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  _handleKeyDown(e) {
    // Avoid triggered shortcuts when user is typing in forms or input fields
    const active = document.activeElement;
    if (active && (
      active.tagName === 'INPUT' ||
      active.tagName === 'TEXTAREA' ||
      active.tagName === 'SELECT' ||
      active.hasAttribute('contenteditable')
    )) {
      return;
    }

    if (!this.active) return;

    if (e.key === 'ArrowRight') {
      e.preventDefault();
      this.stepForward();
    } else if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      this.togglePlay();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.exit();
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Cleanup
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  destroy() {
    this.pause();
    try {
      this.chartManager.chart.unsubscribeClick(this._chartClickHandler);
    } catch (e) { /* */ }
    window.removeEventListener('keydown', this._keydownHandler);
    this._removeToolbar();
  }
}
