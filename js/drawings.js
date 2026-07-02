/**
 * CandleFlow — Drawing tools engine (PRD §5 Phase 4)
 *
 * Implements interactive trend lines, horizontal rays, paths, brush strokes,
 * text annotations, rulers, box zoom, magnet snapping, lock and visibility toggle.
 * All positions are saved in time-price space and projected onto the canvas.
 */

export class DrawingsManager {
  constructor(chart, candleSeries, canvas, container, onDrawingsChanged) {
    this.chart = chart;
    this.series = candleSeries;
    this.canvas = canvas;
    this.container = container; // chart-wrapper div
    this.ctx = canvas.getContext('2d');
    this.onDrawingsChanged = onDrawingsChanged || (() => {});

    this.drawings = [];
    this.activeTool = 'cursor'; // cursor, trend, horizontal, path, brush, text, ruler, zoom
    
    // Snaps & Modifiers
    this.magnetMode = false;
    this.locked = false;
    this.visible = true;

    // Loaded candles reference for magnet snapping
    this.baseCandles = [];

    // Interaction states
    this.selectedId = null;
    this.hoveredId = null;
    this.hoveredHandleIndex = -1;
    this.isDrawing = false;
    this.isDragging = false;
    this.currentDrawing = null; // Temp drawing being drawn

    // Drag-move states
    this.dragStart = null; // { x, y, time, price, handleIndex, originalPoints: [] }
    this.lastMousePos = { x: 0, y: 0 };
    
    this._eventListeners = {};

    this.init();
  }

  init() {
    this.resizeCanvas();
    
    // Bind resize observer to update canvas width/height dynamically
    this._resizeObserver = new ResizeObserver(() => {
      this.resizeCanvas();
      this.repaint();
    });
    this._resizeObserver.observe(this.container);

    // Bind LWC scroll/zoom listeners
    this.chart.timeScale().subscribeVisibleTimeRangeChange(() => {
      this.repaint();
    });

    // Bind DOM mouse events
    this.bindEvents();
  }

  resizeCanvas() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.canvas.style.width = rect.width + 'px';
    this.canvas.style.height = rect.height + 'px';
    
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.scale(dpr, dpr);
  }

  setBaseCandles(candles) {
    this.baseCandles = candles;
  }

  setDrawings(drawings) {
    this.drawings = drawings || [];
    this.selectedId = null;
    this.repaint();
  }

  getDrawings() {
    return this.drawings;
  }

  setTool(tool) {
    this.activeTool = tool;
    this.selectedId = null;
    this.isDrawing = false;
    this.currentDrawing = null;
    this.isDragging = false;
    
    // Sync toolbar active button class in the DOM
    const btn = document.querySelector(`.tool-btn[data-tool="${tool}"]`);
    if (btn) {
      document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    }

    // Configure LWC scrolling based on tool
    this.configureChartInteraction();
    this.repaint();
  }

  configureChartInteraction() {
    // Disable LWC scroll/pan when drawing shapes so mouse drags draw rather than scroll the chart
    const isDrawingTool = [
      'trend', 'info_line', 'ray', 'extended', 'trend_angle', 'fib', 'cyclic', 'rectangle', 'circle',
      'path', 'brush', 'ruler', 'zoom'
    ].includes(this.activeTool);
    this.chart.applyOptions({
      handleScroll: {
        pressedMouseMove: !isDrawingTool,
        mouseWheel: true
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true
      }
    });
  }

  // ── Snapping & Projections ──

  timeToX(time) {
    return this.chart.timeScale().timeToCoordinate(time);
  }

  xToTime(x) {
    return this.chart.timeScale().coordinateToTime(x);
  }

  priceToY(price) {
    return this.series.priceToCoordinate(price);
  }

  yToPrice(y) {
    return this.series.coordinateToPrice(y);
  }

  getPixelCoords(point) {
    if (!point) return null;
    const x = this.timeToX(point.time);
    const y = this.priceToY(point.price);
    if (x === null || y === null) return null;
    return { x, y };
  }

  getSnappedPoint(x, y) {
    const rawTime = this.xToTime(x);
    const rawPrice = this.yToPrice(y);
    if (!this.magnetMode || this.baseCandles.length === 0 || rawTime === null || rawPrice === null) {
      return { time: rawTime, price: rawPrice };
    }

    // Binary search closest candle in time
    let closestCandle = this.baseCandles[0];
    let minDiff = Math.abs(closestCandle.time - rawTime);
    let low = 0;
    let high = this.baseCandles.length - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const diff = Math.abs(this.baseCandles[mid].time - rawTime);
      if (diff < minDiff) {
        minDiff = diff;
        closestCandle = this.baseCandles[mid];
      }
      if (this.baseCandles[mid].time < rawTime) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    // Snap to closest of Open, High, Low, Close
    const ohlc = [closestCandle.open, closestCandle.high, closestCandle.low, closestCandle.close];
    let snappedPrice = ohlc[0];
    let minPriceDiff = Math.abs(ohlc[0] - rawPrice);

    for (let i = 1; i < ohlc.length; i++) {
      const diff = Math.abs(ohlc[i] - rawPrice);
      if (diff < minPriceDiff) {
        minPriceDiff = diff;
        snappedPrice = ohlc[i];
      }
    }

    return { time: closestCandle.time, price: snappedPrice };
  }

  // ── Mouse & UI Events ──

  bindEvents() {
    const parent = this.canvas.parentElement; // chart-wrapper

    const onMouseDown = (e) => this.handleMouseDown(e);
    const onMouseMove = (e) => this.handleMouseMove(e);
    const onMouseUp = (e) => this.handleMouseUp(e);
    const onDoubleClick = (e) => this.handleDoubleClick(e);

    parent.addEventListener('mousedown', onMouseDown);
    parent.addEventListener('mousemove', onMouseMove);
    parent.addEventListener('mouseup', onMouseUp);
    parent.addEventListener('dblclick', onDoubleClick);

    this._eventListeners = { onMouseDown, onMouseMove, onMouseUp, onDoubleClick };

    // Keyboard bindings (Delete key removes selected drawing, Alt shortcuts activate tools)
    window.addEventListener('keydown', (e) => {
      if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') {
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        this.deleteSelected();
      } else if (e.key === 'Escape') {
        this.cancelActiveDrawing();
      } else if (e.altKey) {
        let tool = null;
        if (e.key.toLowerCase() === 't') {
          tool = 'trend';
        } else if (e.key.toLowerCase() === 'h') {
          tool = 'horizontal_line';
        } else if (e.key.toLowerCase() === 'j') {
          tool = 'horizontal_ray';
        } else if (e.key.toLowerCase() === 'v') {
          tool = 'vertical_line';
        } else if (e.key.toLowerCase() === 'c') {
          tool = 'crossline';
        }

        if (tool) {
          e.preventDefault();
          this.setTool(tool);
          
          // Sync toolbar active button class
          const btn = document.querySelector(`.tool-btn[data-tool="${tool}"]`);
          if (btn) {
            document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
          }
        }
      }
    });
  }

  getMousePos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  }

  handleMouseDown(e) {
    if (!this.visible) return;
    const pos = this.getMousePos(e);
    const rawTime = this.xToTime(pos.x);
    const rawPrice = this.yToPrice(pos.y);

    if (rawTime === null || rawPrice === null) return;

    const snapped = this.getSnappedPoint(pos.x, pos.y);

    // 1. Drawing Mode
    if (this.activeTool !== 'cursor') {
      this.startDrawingMode(snapped, pos);
      return;
    }

    // 2. Cursor Mode — Check if clicking handle or body of a selected drawing
    if (this.selectedId) {
      const drawing = this.drawings.find(d => d.id === this.selectedId);
      if (drawing && !this.locked) {
        // Check handle click
        for (let i = 0; i < drawing.points.length; i++) {
          const ptCoords = this.getPixelCoords(drawing.points[i]);
          if (ptCoords && this.distance(pos, ptCoords) < 8) {
            this.isDragging = true;
            this.dragStart = {
              x: pos.x,
              y: pos.y,
              handleIndex: i,
              originalPoints: JSON.parse(JSON.stringify(drawing.points))
            };
            this.chart.applyOptions({ handleScroll: { pressedMouseMove: false } });
            return;
          }
        }
      }
    }

    // Check click on any drawing to select/drag body
    const clicked = this.findDrawingAt(pos);
    if (clicked) {
      this.selectedId = clicked.id;
      if (!this.locked) {
        this.isDragging = true;
        const drawing = this.drawings.find(d => d.id === clicked.id);
        this.dragStart = {
          x: pos.x,
          y: pos.y,
          handleIndex: -1, // Dragging the whole body
          originalPoints: JSON.parse(JSON.stringify(drawing.points))
        };
        this.chart.applyOptions({ handleScroll: { pressedMouseMove: false } });
      }
      this.repaint();
    } else {
      this.selectedId = null;
      this.repaint();
    }
  }

  handleMouseMove(e) {
    const pos = this.getMousePos(e);
    this.lastMousePos = pos;

    if (!this.visible) return;

    const snapped = this.getSnappedPoint(pos.x, pos.y);

    // 1. Update drawing being created
    if (this.isDrawing && this.currentDrawing) {
      const pts = this.currentDrawing.points;
      if (this.activeTool === 'trend' || this.activeTool === 'ruler' || this.activeTool === 'zoom') {
        pts[1] = snapped;
      } else if (this.activeTool === 'brush') {
        const lastPt = pts[pts.length - 1];
        const lastCoords = this.getPixelCoords(lastPt);
        if (!lastCoords || this.distance(pos, lastCoords) > 4) {
          pts.push(snapped);
        }
      }
      this.repaint();
      return;
    }

    // 2. Handle dragging handles or bodies
    if (this.isDragging && this.selectedId && this.dragStart && !this.locked) {
      const drawing = this.drawings.find(d => d.id === this.selectedId);
      if (drawing) {
        const deltaX = pos.x - this.dragStart.x;
        const deltaY = pos.y - this.dragStart.y;

        if (this.dragStart.handleIndex !== -1) {
          // Drag individual point handle
          const originalPoint = this.dragStart.originalPoints[this.dragStart.handleIndex];
          const origCoords = this.getPixelCoords(originalPoint);
          if (origCoords) {
            const newX = origCoords.x + deltaX;
            const newY = origCoords.y + deltaY;
            const snappedPoint = this.getSnappedPoint(newX, newY);
            drawing.points[this.dragStart.handleIndex] = snappedPoint;

            // Sync horizontal boundaries for Long/Short Position
            if (drawing.type === 'long_position' || drawing.type === 'short_position') {
              if (this.dragStart.handleIndex === 1) {
                // Dragging Target: sync Stop's time to Target's time
                drawing.points[2].time = drawing.points[1].time;
              } else if (this.dragStart.handleIndex === 2) {
                // Dragging Stop: sync Target's time to Stop's time
                drawing.points[1].time = drawing.points[2].time;
              }
            }
          }
        } else {
          // Drag whole drawing
          for (let i = 0; i < drawing.points.length; i++) {
            const originalPoint = this.dragStart.originalPoints[i];
            const origCoords = this.getPixelCoords(originalPoint);
            if (origCoords) {
              const newX = origCoords.x + deltaX;
              const newY = origCoords.y + deltaY;
              
              const snappedTime = this.xToTime(newX);
              const snappedPrice = this.yToPrice(newY);
              
              if (snappedTime !== null && snappedPrice !== null) {
                drawing.points[i] = { time: snappedTime, price: snappedPrice };
              }
            }
          }
        }
        this.repaint();
      }
      return;
    }

    // 3. Highlight hovered drawing on cursor hover
    if (this.activeTool === 'cursor' && !this.isDragging) {
      const hover = this.findDrawingAt(pos);
      const oldHover = this.hoveredId;
      this.hoveredId = hover ? hover.id : null;
      if (oldHover !== this.hoveredId) {
        this.repaint();
      }
    }
  }

  handleMouseUp(e) {
    if (this.isDragging) {
      this.isDragging = false;
      this.dragStart = null;
      this.chart.applyOptions({ handleScroll: { pressedMouseMove: true } });
      this.saveAndNotify();
      this.repaint();
      return;
    }

    if (!this.isDrawing || !this.currentDrawing) return;

    const pos = this.getMousePos(e);
    const snapped = this.getSnappedPoint(pos.x, pos.y);

    if (this.activeTool === 'brush') {
      this.isDrawing = false;
      this.currentDrawing.points.push(snapped);
      this.drawings.push(this.currentDrawing);
      this.currentDrawing = null;
      this.setTool('cursor');
      this.saveAndNotify();
    } else if (this.activeTool === 'ruler') {
      this.isDrawing = false;
      this.currentDrawing = null;
      this.setTool('cursor');
    } else if (this.activeTool === 'zoom') {
      this.isDrawing = false;
      const pts = this.currentDrawing.points;
      if (pts.length >= 2) {
        const t1 = pts[0].time;
        const t2 = pts[1].time;
        if (t1 !== null && t2 !== null && t1 !== t2) {
          this.chart.timeScale().setVisibleRange({
            from: Math.min(t1, t2),
            to: Math.max(t1, t2)
          });
        }
      }
      this.currentDrawing = null;
      this.setTool('cursor');
    }
  }

  handleDoubleClick(e) {
    // Finish Path (multi-point) drawing on double-click
    if (this.activeTool === 'path' && this.isDrawing && this.currentDrawing) {
      this.isDrawing = false;
      if (this.currentDrawing.points.length > 2) {
        // Pop the double click duplicate point
        this.currentDrawing.points.pop();
        this.drawings.push(this.currentDrawing);
      }
      this.currentDrawing = null;
      this.setTool('cursor');
      this.saveAndNotify();
    }
  }

  startDrawingMode(snapped, pos) {
    const twoClickTools = ['trend', 'info_line', 'ray', 'extended', 'trend_angle', 'fib', 'cyclic', 'rectangle', 'circle'];
    const singleClickTools = ['horizontal_line', 'horizontal_ray', 'vertical_line', 'crossline', 'horizontal', 'long_position', 'short_position'];

    if (twoClickTools.includes(this.activeTool)) {
      if (!this.isDrawing) {
        this.isDrawing = true;
        this.currentDrawing = {
          id: Date.now().toString(),
          type: this.activeTool,
          points: [snapped, snapped]
        };
      } else {
        this.isDrawing = false;
        this.currentDrawing.points[1] = snapped;
        this.drawings.push(this.currentDrawing);
        this.currentDrawing = null;
        this.setTool('cursor');
        this.saveAndNotify();
      }
    } else if (singleClickTools.includes(this.activeTool)) {
      this.isDrawing = false;
      let newDrawing;
      if (this.activeTool === 'long_position' || this.activeTool === 'short_position') {
        const idx = this.baseCandles.findIndex(c => c.time === snapped.time);
        let rightTime = snapped.time + 20 * 60; // default 20 mins
        if (idx !== -1 && idx + 20 < this.baseCandles.length) {
          rightTime = this.baseCandles[idx + 20].time;
        } else if (this.baseCandles.length > 0) {
          rightTime = this.baseCandles[this.baseCandles.length - 1].time;
        }

        const price = snapped.price;
        const isLong = this.activeTool === 'long_position';
        const targetPrice = isLong ? price * 1.02 : price * 0.98;
        const stopPrice = isLong ? price * 0.99 : price * 1.01;

        newDrawing = {
          id: Date.now().toString(),
          type: this.activeTool,
          points: [
            snapped,
            { time: rightTime, price: targetPrice },
            { time: rightTime, price: stopPrice }
          ]
        };
      } else {
        const type = this.activeTool === 'horizontal' ? 'horizontal_ray' : this.activeTool;
        newDrawing = {
          id: Date.now().toString(),
          type: type,
          points: [snapped]
        };
      }
      this.drawings.push(newDrawing);
      this.setTool('cursor');
      this.saveAndNotify();
    } else if (this.activeTool === 'path') {
      if (!this.isDrawing) {
        this.isDrawing = true;
        this.currentDrawing = {
          id: Date.now().toString(),
          type: 'path',
          points: [snapped]
        };
      } else {
        this.currentDrawing.points.push(snapped);
      }
    } else if (this.activeTool === 'brush') {
      this.isDrawing = true;
      this.currentDrawing = {
        id: Date.now().toString(),
        type: 'brush',
        points: [snapped]
      };
    } else if (this.activeTool === 'ruler') {
      this.isDrawing = true;
      this.currentDrawing = {
        id: 'ruler_temp',
        type: 'ruler',
        points: [snapped, snapped]
      };
    } else if (this.activeTool === 'zoom') {
      this.isDrawing = true;
      this.currentDrawing = {
        id: 'zoom_temp',
        type: 'zoom',
        points: [snapped, snapped]
      };
    } else if (this.activeTool === 'text') {
      this.isDrawing = false;
      const textVal = prompt('Enter annotation text:');
      if (textVal && textVal.trim() !== '') {
        const newDrawing = {
          id: Date.now().toString(),
          type: 'text',
          points: [snapped],
          text: textVal.trim()
        };
        this.drawings.push(newDrawing);
        this.saveAndNotify();
      }
      this.setTool('cursor');
    }
    this.repaint();
  }

  cancelActiveDrawing() {
    this.isDrawing = false;
    this.currentDrawing = null;
    this.isDragging = false;
    this.dragStart = null;
    this.setTool('cursor');
    this.repaint();
  }

  deleteSelected() {
    if (this.selectedId && !this.locked) {
      this.drawings = this.drawings.filter(d => d.id !== this.selectedId);
      this.selectedId = null;
      this.saveAndNotify();
      this.repaint();
    }
  }

  clearAllDrawings() {
    if (this.drawings.length === 0) return;
    const confirmClear = confirm('Delete all drawings on this chart?');
    if (confirmClear) {
      this.drawings = [];
      this.selectedId = null;
      this.currentDrawing = null;
      this.saveAndNotify();
      this.repaint();
    }
  }

  toggleLock() {
    this.locked = !this.locked;
    if (this.locked) this.selectedId = null;
    this.repaint();
  }

  toggleVisibility() {
    this.visible = !this.visible;
    this.repaint();
  }

  saveAndNotify() {
    // Strip temp/ruler objects before saving
    const saved = this.drawings.filter(d => d.id !== 'ruler_temp' && d.id !== 'zoom_temp');
    this.onDrawingsChanged(saved);
  }

  // ── Geometry Algorithms (Hover Selection) ──

  findDrawingAt(pos) {
    // Search backward to select newest drawings first
    for (let i = this.drawings.length - 1; i >= 0; i--) {
      const d = this.drawings[i];
      if (d.id === 'ruler_temp' || d.id === 'zoom_temp') continue;
      
      const ptsCoords = d.points.map(pt => this.getPixelCoords(pt)).filter(Boolean);
      if (ptsCoords.length === 0) continue;

      if ((d.type === 'trend' || d.type === 'info_line' || d.type === 'trend_angle') && ptsCoords.length >= 2) {
        if (this.distToSegment(pos, ptsCoords[0], ptsCoords[1]) < 6) return d;
      } else if (d.type === 'fib' && ptsCoords.length >= 2) {
        if (this.distToSegment(pos, ptsCoords[0], ptsCoords[1]) < 6) return d;
        const price1 = d.points[0].price;
        const price2 = d.points[1].price;
        const diff = price2 - price1;
        const ratios = [0.0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0];
        for (const r of ratios) {
          const y = this.priceToY(price1 + r * diff);
          if (y !== null && Math.abs(pos.y - y) < 6) {
            const minX = Math.min(ptsCoords[0].x, ptsCoords[1].x);
            const maxX = Math.max(ptsCoords[0].x, ptsCoords[1].x);
            if (pos.x >= minX - 4 && pos.x <= maxX + 4) return d;
          }
        }
      } else if (d.type === 'cyclic' && ptsCoords.length >= 2) {
        const t1 = d.points[0].time;
        const t2 = d.points[1].time;
        const dt = Math.abs(t2 - t1);
        if (dt === 0) {
          if (Math.abs(pos.x - ptsCoords[0].x) < 6) return d;
        } else {
          const visibleRange = this.chart.timeScale().getVisibleRange();
          if (visibleRange && visibleRange.from && visibleRange.to) {
            let t = t1;
            while (t <= visibleRange.to) {
              const x = this.timeToX(t);
              if (x !== null && Math.abs(pos.x - x) < 6) return d;
              t += dt;
            }
            t = t1 - dt;
            while (t >= visibleRange.from) {
              const x = this.timeToX(t);
              if (x !== null && Math.abs(pos.x - x) < 6) return d;
              t -= dt;
            }
          }
        }
      } else if ((d.type === 'long_position' || d.type === 'short_position') && ptsCoords.length >= 3) {
        const xLeft = ptsCoords[0].x;
        const xRight = ptsCoords[1].x;
        const yEntry = ptsCoords[0].y;
        const yTarget = ptsCoords[1].y;
        const yStop = ptsCoords[2].y;

        const minX = Math.min(xLeft, xRight);
        const maxX = Math.max(xLeft, xRight);
        const minY = Math.min(yTarget, yStop);
        const maxY = Math.max(yTarget, yStop);

        if (pos.x >= minX - 4 && pos.x <= maxX + 4 && pos.y >= minY - 4 && pos.y <= maxY + 4) {
          return d;
        }
      } else if ((d.type === 'rectangle' || d.type === 'circle') && ptsCoords.length >= 2) {
        const minX = Math.min(ptsCoords[0].x, ptsCoords[1].x);
        const maxX = Math.max(ptsCoords[0].x, ptsCoords[1].x);
        const minY = Math.min(ptsCoords[0].y, ptsCoords[1].y);
        const maxY = Math.max(ptsCoords[0].y, ptsCoords[1].y);
        if (pos.x >= minX - 4 && pos.x <= maxX + 4 && pos.y >= minY - 4 && pos.y <= maxY + 4) {
          return d;
        }
      } else if (d.type === 'ray' && ptsCoords.length >= 2) {
        if (this.distToRay(pos, ptsCoords[0], ptsCoords[1]) < 6) return d;
      } else if (d.type === 'extended' && ptsCoords.length >= 2) {
        if (this.distToLine(pos, ptsCoords[0], ptsCoords[1]) < 6) return d;
      } else if (d.type === 'horizontal_line') {
        const y = ptsCoords[0].y;
        if (Math.abs(pos.y - y) < 6) return d;
      } else if (d.type === 'horizontal_ray' || d.type === 'horizontal') {
        const y = ptsCoords[0].y;
        const x = ptsCoords[0].x;
        if (Math.abs(pos.y - y) < 6 && pos.x >= x - 4) return d;
      } else if (d.type === 'vertical_line') {
        const x = ptsCoords[0].x;
        if (Math.abs(pos.x - x) < 6) return d;
      } else if (d.type === 'crossline') {
        const x = ptsCoords[0].x;
        const y = ptsCoords[0].y;
        if (Math.abs(pos.x - x) < 6 || Math.abs(pos.y - y) < 6) return d;
      } else if (d.type === 'path') {
        for (let j = 0; j < ptsCoords.length - 1; j++) {
          if (this.distToSegment(pos, ptsCoords[j], ptsCoords[j + 1]) < 6) return d;
        }
      } else if (d.type === 'brush') {
        for (let j = 0; j < ptsCoords.length - 1; j++) {
          if (this.distToSegment(pos, ptsCoords[j], ptsCoords[j + 1]) < 8) return d;
        }
      } else if (d.type === 'text') {
        const pt = ptsCoords[0];
        // Approximate text bounding box sizing
        const ctx = this.ctx;
        ctx.font = '12px Inter';
        const width = ctx.measureText(d.text).width;
        if (pos.x >= pt.x - 4 && pos.x <= pt.x + width + 4 && pos.y >= pt.y - 12 && pos.y <= pt.y + 4) {
          return d;
        }
      }
    }
    return null;
  }

  distance(p1, p2) {
    return Math.sqrt((p1.x - p2.x) ** 2 + (p1.y - p2.y) ** 2);
  }

  distToSegment(p, v, w) {
    const l2 = (v.x - w.x) ** 2 + (v.y - w.y) ** 2;
    if (l2 === 0) return this.distance(p, v);
    let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    return this.distance(p, {
      x: v.x + t * (w.x - v.x),
      y: v.y + t * (w.y - v.y)
    });
  }

  distToLine(p, v, w) {
    const l2 = (v.x - w.x) ** 2 + (v.y - w.y) ** 2;
    if (l2 === 0) return this.distance(p, v);
    const t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
    return this.distance(p, {
      x: v.x + t * (w.x - v.x),
      y: v.y + t * (w.y - v.y)
    });
  }

  distToRay(p, v, w) {
    const l2 = (v.x - w.x) ** 2 + (v.y - w.y) ** 2;
    if (l2 === 0) return this.distance(p, v);
    let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
    t = Math.max(0, t);
    return this.distance(p, {
      x: v.x + t * (w.x - v.x),
      y: v.y + t * (w.y - v.y)
    });
  }

  // ── Render loop ──

  repaint() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (!this.visible) return;

    // Draw saved drawings
    this.drawings.forEach(d => this.drawDrawing(d));

    // Draw active drawing in progress
    if (this.isDrawing && this.currentDrawing) {
      this.drawDrawing(this.currentDrawing);
    }
  }

  drawDrawing(d) {
    const coords = d.points.map(pt => this.getPixelCoords(pt));
    const validCoords = coords.filter(Boolean);
    if (validCoords.length === 0) return;

    const isSelected = d.id === this.selectedId;
    const isHovered = d.id === this.hoveredId;
    const drawColor = isSelected ? '#2962ff' : (isHovered ? '#588cff' : '#d1d4dc');
    const width = isSelected || isHovered ? 2 : 1.5;

    const canvasWidth = this.canvas.width / (window.devicePixelRatio || 1);
    const canvasHeight = this.canvas.height / (window.devicePixelRatio || 1);

    this.ctx.save();

    if (d.type === 'trend' && validCoords.length >= 2) {
      // Draw Trend Line
      this.ctx.strokeStyle = drawColor;
      this.ctx.lineWidth = width;
      this.ctx.beginPath();
      this.ctx.moveTo(validCoords[0].x, validCoords[0].y);
      this.ctx.lineTo(validCoords[1].x, validCoords[1].y);
      this.ctx.stroke();

      if (isSelected && !this.locked) {
        this.drawHandle(validCoords[0]);
        this.drawHandle(validCoords[1]);
      }
    } else if (d.type === 'fib' && validCoords.length >= 2) {
      const p1 = validCoords[0];
      const p2 = validCoords[1];
      const price1 = d.points[0].price;
      const price2 = d.points[1].price;
      const diff = price2 - price1;

      // Diagonal swing line (dotted reference line)
      this.ctx.strokeStyle = 'rgba(209, 212, 220, 0.4)';
      this.ctx.lineWidth = 1;
      this.ctx.setLineDash([3, 3]);
      this.ctx.beginPath();
      this.ctx.moveTo(p1.x, p1.y);
      this.ctx.lineTo(p2.x, p2.y);
      this.ctx.stroke();
      this.ctx.setLineDash([]);

      const levels = [
        { ratio: 0.0, label: '0.00%', color: 'rgba(239, 83, 80, 0.06)' },
        { ratio: 0.236, label: '23.6%', color: 'rgba(255, 152, 0, 0.05)' },
        { ratio: 0.382, label: '38.2%', color: 'rgba(76, 175, 80, 0.05)' },
        { ratio: 0.5, label: '50.0%', color: 'rgba(33, 150, 243, 0.05)' },
        { ratio: 0.618, label: '61.8%', color: 'rgba(255, 235, 59, 0.05)' },
        { ratio: 0.786, label: '78.6%', color: 'rgba(156, 39, 176, 0.05)' },
        { ratio: 1.0, label: '100.0%', color: 'rgba(239, 83, 80, 0.06)' }
      ];

      // Draw background bands
      for (let i = 0; i < levels.length - 1; i++) {
        const yA = this.priceToY(price1 + levels[i].ratio * diff);
        const yB = this.priceToY(price1 + levels[i + 1].ratio * diff);
        if (yA !== null && yB !== null) {
          this.ctx.fillStyle = levels[i].color;
          this.ctx.fillRect(Math.min(p1.x, p2.x), Math.min(yA, yB), Math.abs(p2.x - p1.x), Math.abs(yB - yA));
        }
      }

      // Draw horizontal lines & text labels
      levels.forEach(level => {
        const lvlPrice = price1 + level.ratio * diff;
        const y = this.priceToY(lvlPrice);
        if (y !== null) {
          this.ctx.strokeStyle = drawColor;
          this.ctx.lineWidth = 1;
          this.ctx.beginPath();
          this.ctx.moveTo(p1.x, y);
          this.ctx.lineTo(p2.x, y);
          this.ctx.stroke();

          const label = `${(level.ratio * 100).toFixed(1)}% (${lvlPrice.toFixed(2)})`;
          this.ctx.fillStyle = '#d1d4dc';
          this.ctx.font = '10px Inter';
          this.ctx.fillText(label, p1.x + 4, y - 4);
        }
      });

      if (isSelected && !this.locked) {
        this.drawHandle(p1);
        this.drawHandle(p2);
      }
    } else if (d.type === 'cyclic' && validCoords.length >= 2) {
      const p1 = validCoords[0];
      const p2 = validCoords[1];
      const t1 = d.points[0].time;
      const t2 = d.points[1].time;
      const dt = Math.abs(t2 - t1);

      const visibleRange = this.chart.timeScale().getVisibleRange();
      if (visibleRange && visibleRange.from && visibleRange.to && dt > 0) {
        const cycles = [];
        let t = t1;
        while (t <= visibleRange.to) {
          cycles.push(t);
          t += dt;
        }
        t = t1 - dt;
        while (t >= visibleRange.from) {
          cycles.push(t);
          t -= dt;
        }

        this.ctx.strokeStyle = drawColor;
        this.ctx.lineWidth = width;
        this.ctx.setLineDash([4, 4]);
        cycles.forEach(tCycle => {
          const x = this.timeToX(tCycle);
          if (x !== null) {
            this.ctx.beginPath();
            this.ctx.moveTo(x, 0);
            this.ctx.lineTo(x, canvasHeight);
            this.ctx.stroke();
          }
        });
        this.ctx.setLineDash([]);
      } else {
        const x = p1.x;
        this.ctx.strokeStyle = drawColor;
        this.ctx.lineWidth = width;
        this.ctx.beginPath();
        this.ctx.moveTo(x, 0);
        this.ctx.lineTo(x, canvasHeight);
        this.ctx.stroke();
      }

      if (isSelected && !this.locked) {
        this.drawHandle(p1);
        this.drawHandle(p2);
      }
    } else if ((d.type === 'long_position' || d.type === 'short_position') && validCoords.length >= 3) {
      const pEntry = validCoords[0];
      const pTarget = validCoords[1];
      const pStop = validCoords[2];

      const xLeft = pEntry.x;
      const xRight = pTarget.x;
      const yEntry = pEntry.y;
      const yTarget = pTarget.y;
      const yStop = pStop.y;

      const priceEntry = d.points[0].price;
      const priceTarget = d.points[1].price;
      const priceStop = d.points[2].price;

      const isLong = d.type === 'long_position';
      
      const targetFill = 'rgba(76, 175, 80, 0.16)'; // profit zone is always green
      const stopFill = 'rgba(239, 83, 80, 0.16)'; // risk zone is always red

      // Draw boxes
      this.ctx.fillStyle = targetFill;
      this.ctx.fillRect(Math.min(xLeft, xRight), Math.min(yEntry, yTarget), Math.abs(xRight - xLeft), Math.abs(yTarget - yEntry));

      this.ctx.fillStyle = stopFill;
      this.ctx.fillRect(Math.min(xLeft, xRight), Math.min(yEntry, yStop), Math.abs(xRight - xLeft), Math.abs(yStop - yEntry));

      // Draw borders and lines
      this.ctx.strokeStyle = drawColor;
      this.ctx.lineWidth = width;

      // Entry
      this.ctx.beginPath();
      this.ctx.moveTo(xLeft, yEntry);
      this.ctx.lineTo(xRight, yEntry);
      this.ctx.stroke();

      // Target
      this.ctx.beginPath();
      this.ctx.moveTo(xLeft, yTarget);
      this.ctx.lineTo(xRight, yTarget);
      this.ctx.stroke();

      // Stop
      this.ctx.beginPath();
      this.ctx.moveTo(xLeft, yStop);
      this.ctx.lineTo(xRight, yStop);
      this.ctx.stroke();

      // Left & Right bounds
      this.ctx.beginPath();
      this.ctx.moveTo(xLeft, Math.min(yTarget, yStop));
      this.ctx.lineTo(xLeft, Math.max(yTarget, yStop));
      this.ctx.moveTo(xRight, Math.min(yTarget, yStop));
      this.ctx.lineTo(xRight, Math.max(yTarget, yStop));
      this.ctx.stroke();

      // Calculate profit/loss %
      const targetDiff = priceTarget - priceEntry;
      const targetPct = (targetDiff / priceEntry) * 100;
      const stopDiff = priceStop - priceEntry;
      const stopPct = (stopDiff / priceEntry) * 100;

      const risk = Math.abs(priceEntry - priceStop);
      const reward = Math.abs(priceTarget - priceEntry);
      const rrRatio = risk > 0 ? (reward / risk).toFixed(2) : '0.00';

      // Labels
      this.ctx.fillStyle = '#ffffff';
      this.ctx.font = '10px Inter';
      this.ctx.fillText(`Target: ${priceTarget.toFixed(2)} (${targetPct.toFixed(2)}%)`, Math.min(xLeft, xRight) + 6, Math.min(yEntry, yTarget) + 12);
      this.ctx.fillText(`Stop: ${priceStop.toFixed(2)} (${stopPct.toFixed(2)}%)`, Math.min(xLeft, xRight) + 6, Math.max(yEntry, yStop) - 4);

      // R:R Center Box
      const rrLabel = `Risk/Reward: ${rrRatio}`;
      const boxWidth = 100;
      const boxHeight = 16;
      const boxX = (xLeft + xRight) / 2 - boxWidth / 2;
      const boxY = yEntry - boxHeight / 2;

      this.ctx.fillStyle = 'rgba(30, 34, 45, 0.85)';
      this.ctx.strokeStyle = '#2a2e39';
      this.ctx.lineWidth = 1;
      this.ctx.fillRect(boxX, boxY, boxWidth, boxHeight);
      this.ctx.strokeRect(boxX, boxY, boxWidth, boxHeight);

      this.ctx.fillStyle = '#d1d4dc';
      this.ctx.textAlign = 'center';
      this.ctx.fillText(rrLabel, (xLeft + xRight) / 2, boxY + 11);
      this.ctx.textAlign = 'left';

      if (isSelected && !this.locked) {
        this.drawHandle(pEntry);
        this.drawHandle(pTarget);
        this.drawHandle(pStop);
      }
    } else if (d.type === 'rectangle' && validCoords.length >= 2) {
      const p1 = validCoords[0];
      const p2 = validCoords[1];

      this.ctx.fillStyle = 'rgba(41, 98, 255, 0.06)';
      this.ctx.fillRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);

      this.ctx.strokeStyle = drawColor;
      this.ctx.lineWidth = width;
      this.ctx.strokeRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);

      if (isSelected && !this.locked) {
        this.drawHandle(p1);
        this.drawHandle(p2);
      }
    } else if (d.type === 'circle' && validCoords.length >= 2) {
      const p1 = validCoords[0];
      const p2 = validCoords[1];

      const cx = (p1.x + p2.x) / 2;
      const cy = (p1.y + p2.y) / 2;
      const rx = Math.abs(p2.x - p1.x) / 2;
      const ry = Math.abs(p2.y - p1.y) / 2;

      if (rx > 0.5 && ry > 0.5) {
        this.ctx.beginPath();
        this.ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        this.ctx.fillStyle = 'rgba(41, 98, 255, 0.06)';
        this.ctx.fill();

        this.ctx.strokeStyle = drawColor;
        this.ctx.lineWidth = width;
        this.ctx.stroke();
      }

      if (isSelected && !this.locked) {
        this.drawHandle(p1);
        this.drawHandle(p2);
      }
    } else if (d.type === 'ray' && validCoords.length >= 2) {
      const p1 = validCoords[0];
      const p2 = validCoords[1];
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len = Math.sqrt(dx * dx + dy * dy);

      this.ctx.strokeStyle = drawColor;
      this.ctx.lineWidth = width;
      this.ctx.beginPath();
      this.ctx.moveTo(p1.x, p1.y);
      if (len > 0.1) {
        const extendDist = Math.max(canvasWidth, canvasHeight) * 2;
        this.ctx.lineTo(p1.x + (dx / len) * extendDist, p1.y + (dy / len) * extendDist);
      } else {
        this.ctx.lineTo(p2.x, p2.y);
      }
      this.ctx.stroke();

      if (isSelected && !this.locked) {
        this.drawHandle(p1);
        this.drawHandle(p2);
      }
    } else if (d.type === 'extended' && validCoords.length >= 2) {
      const p1 = validCoords[0];
      const p2 = validCoords[1];
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len = Math.sqrt(dx * dx + dy * dy);

      this.ctx.strokeStyle = drawColor;
      this.ctx.lineWidth = width;
      this.ctx.beginPath();
      if (len > 0.1) {
        const extendDist = Math.max(canvasWidth, canvasHeight) * 2;
        this.ctx.moveTo(p1.x - (dx / len) * extendDist, p1.y - (dy / len) * extendDist);
        this.ctx.lineTo(p1.x + (dx / len) * extendDist, p1.y + (dy / len) * extendDist);
      } else {
        this.ctx.moveTo(p1.x, p1.y);
        this.ctx.lineTo(p2.x, p2.y);
      }
      this.ctx.stroke();

      if (isSelected && !this.locked) {
        this.drawHandle(p1);
        this.drawHandle(p2);
      }
    } else if (d.type === 'info_line' && validCoords.length >= 2) {
      const p1 = validCoords[0];
      const p2 = validCoords[1];

      // Draw segment line
      this.ctx.strokeStyle = drawColor;
      this.ctx.lineWidth = width;
      this.ctx.beginPath();
      this.ctx.moveTo(p1.x, p1.y);
      this.ctx.lineTo(p2.x, p2.y);
      this.ctx.stroke();

      // Calculate details
      const price1 = d.points[0].price;
      const price2 = d.points[1].price;
      const diffPrice = price2 - price1;
      const diffPct = (diffPrice / price1) * 100;

      // Calculate bars count
      const time1 = d.points[0].time;
      const time2 = d.points[1].time;
      let barCount = 0;
      if (this.baseCandles.length > 0 && time1 !== null && time2 !== null) {
        const i1 = this.baseCandles.findIndex(c => c.time === time1);
        const i2 = this.baseCandles.findIndex(c => c.time === time2);
        if (i1 !== -1 && i2 !== -1) {
          barCount = Math.abs(i2 - i1);
        }
      }

      // Draw metric label box at the center of the line segment
      const label = `${diffPrice.toFixed(2)} (${(diffPrice >= 0 ? '+' : '')}${diffPct.toFixed(2)}%) • ${barCount} bars`;
      const labelX = (p1.x + p2.x) / 2;
      const labelY = (p1.y + p2.y) / 2 - 12;

      this.ctx.fillStyle = 'rgba(30, 34, 45, 0.85)';
      this.ctx.strokeStyle = '#2a2e39';
      this.ctx.lineWidth = 1;

      this.ctx.font = '10px Inter';
      const textWidth = this.ctx.measureText(label).width;

      this.ctx.fillRect(labelX - textWidth / 2 - 4, labelY - 10, textWidth + 8, 16);
      this.ctx.strokeRect(labelX - textWidth / 2 - 4, labelY - 10, textWidth + 8, 16);

      this.ctx.fillStyle = '#d1d4dc';
      this.ctx.textAlign = 'center';
      this.ctx.fillText(label, labelX, labelY + 2);
      this.ctx.textAlign = 'left'; // restore default

      if (isSelected && !this.locked) {
        this.drawHandle(p1);
        this.drawHandle(p2);
      }
    } else if (d.type === 'trend_angle' && validCoords.length >= 2) {
      const p1 = validCoords[0];
      const p2 = validCoords[1];

      // Draw segment line
      this.ctx.strokeStyle = drawColor;
      this.ctx.lineWidth = width;
      this.ctx.beginPath();
      this.ctx.moveTo(p1.x, p1.y);
      this.ctx.lineTo(p2.x, p2.y);
      this.ctx.stroke();

      // Calculate angle in screen space (y down, so invert dy)
      const angleDeg = -Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180 / Math.PI;

      // Draw horizontal reference dashed line from p1 to p2.x
      this.ctx.strokeStyle = 'rgba(209, 212, 220, 0.3)';
      this.ctx.lineWidth = 1;
      this.ctx.setLineDash([2, 2]);
      this.ctx.beginPath();
      this.ctx.moveTo(p1.x, p1.y);
      this.ctx.lineTo(p2.x, p1.y);
      this.ctx.stroke();
      this.ctx.setLineDash([]);

      // Draw angle text bubble near p2
      const label = `${angleDeg.toFixed(1)}°`;
      const labelX = p2.x + 8;
      const labelY = p2.y;

      this.ctx.fillStyle = 'rgba(30, 34, 45, 0.85)';
      this.ctx.strokeStyle = '#2a2e39';
      this.ctx.lineWidth = 1;
      this.ctx.font = '10px Inter';
      const textWidth = this.ctx.measureText(label).width;

      this.ctx.fillRect(labelX - 4, labelY - 10, textWidth + 8, 16);
      this.ctx.strokeRect(labelX - 4, labelY - 10, textWidth + 8, 16);

      this.ctx.fillStyle = '#d1d4dc';
      this.ctx.fillText(label, labelX, labelY + 2);

      if (isSelected && !this.locked) {
        this.drawHandle(p1);
        this.drawHandle(p2);
      }
    } else if (d.type === 'horizontal_line') {
      const y = validCoords[0].y;
      this.ctx.strokeStyle = drawColor;
      this.ctx.lineWidth = width;
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(canvasWidth, y);
      this.ctx.stroke();

      if (isSelected && !this.locked) {
        this.drawHandle(validCoords[0]);
      }
    } else if (d.type === 'horizontal_ray' || d.type === 'horizontal') {
      const y = validCoords[0].y;
      const x = validCoords[0].x;
      this.ctx.strokeStyle = drawColor;
      this.ctx.lineWidth = width;
      this.ctx.beginPath();
      this.ctx.moveTo(x, y);
      this.ctx.lineTo(canvasWidth, y);
      this.ctx.stroke();

      if (isSelected && !this.locked) {
        this.drawHandle(validCoords[0]);
      }
    } else if (d.type === 'vertical_line') {
      const x = validCoords[0].x;
      this.ctx.strokeStyle = drawColor;
      this.ctx.lineWidth = width;
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, canvasHeight);
      this.ctx.stroke();

      if (isSelected && !this.locked) {
        this.drawHandle(validCoords[0]);
      }
    } else if (d.type === 'crossline') {
      const x = validCoords[0].x;
      const y = validCoords[0].y;
      this.ctx.strokeStyle = drawColor;
      this.ctx.lineWidth = width;

      // Horizontal segment
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(canvasWidth, y);
      this.ctx.stroke();

      // Vertical segment
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, canvasHeight);
      this.ctx.stroke();

      if (isSelected && !this.locked) {
        this.drawHandle(validCoords[0]);
      }
    } else if (d.type === 'path' && validCoords.length >= 1) {
      // Draw path line segment by segment
      this.ctx.strokeStyle = drawColor;
      this.ctx.lineWidth = width;
      this.ctx.beginPath();
      this.ctx.moveTo(validCoords[0].x, validCoords[0].y);
      for (let i = 1; i < validCoords.length; i++) {
        this.ctx.lineTo(validCoords[i].x, validCoords[i].y);
      }
      this.ctx.stroke();

      if (isSelected && !this.locked) {
        validCoords.forEach(c => this.drawHandle(c));
      }
    } else if (d.type === 'brush' && validCoords.length >= 1) {
      // Draw freehand stroke
      this.ctx.strokeStyle = drawColor;
      this.ctx.lineWidth = width + 1;
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';
      this.ctx.beginPath();
      this.ctx.moveTo(validCoords[0].x, validCoords[0].y);
      for (let i = 1; i < validCoords.length; i++) {
        this.ctx.lineTo(validCoords[i].x, validCoords[i].y);
      }
      this.ctx.stroke();

      if (isSelected && !this.locked && validCoords.length >= 2) {
        // Just show start and end handles for simplicity
        this.drawHandle(validCoords[0]);
        this.drawHandle(validCoords[validCoords.length - 1]);
      }
    } else if (d.type === 'text') {
      // Draw text label
      const pt = validCoords[0];
      this.ctx.fillStyle = drawColor;
      this.ctx.font = '12px Inter';
      this.ctx.fillText(d.text, pt.x, pt.y);

      if (isSelected && !this.locked) {
        this.drawHandle(pt);
      }
    } else if (d.type === 'ruler' && validCoords.length >= 2) {
      // Draw temporary ruler box and detail metrics label
      const p1 = validCoords[0];
      const p2 = validCoords[1];
      
      // Draw dotted bounds box
      this.ctx.strokeStyle = 'rgba(41, 98, 255, 0.4)';
      this.ctx.lineWidth = 1;
      this.ctx.setLineDash([4, 4]);
      this.ctx.strokeRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
      this.ctx.setLineDash([]);

      // Draw background tint
      this.ctx.fillStyle = 'rgba(41, 98, 255, 0.05)';
      this.ctx.fillRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);

      // Draw diagonal line
      this.ctx.strokeStyle = '#2962ff';
      this.ctx.lineWidth = 1.5;
      this.ctx.beginPath();
      this.ctx.moveTo(p1.x, p1.y);
      this.ctx.lineTo(p2.x, p2.y);
      this.ctx.stroke();

      // Calculate details
      const price1 = d.points[0].price;
      const price2 = d.points[1].price;
      const diffPrice = price2 - price1;
      const diffPct = (diffPrice / price1) * 100;
      
      // Calculate bars count
      const time1 = d.points[0].time;
      const time2 = d.points[1].time;
      let barCount = 0;
      if (this.baseCandles.length > 0 && time1 !== null && time2 !== null) {
        const i1 = this.baseCandles.findIndex(c => c.time === time1);
        const i2 = this.baseCandles.findIndex(c => c.time === time2);
        if (i1 !== -1 && i2 !== -1) {
          barCount = Math.abs(i2 - i1);
        }
      }

      // Draw metric label box
      const label = `${diffPrice.toFixed(2)} (${(diffPrice >= 0 ? '+' : '')}${diffPct.toFixed(2)}%)\n${barCount} bars`;
      const labelX = p2.x + 8;
      const labelY = p2.y;

      this.ctx.fillStyle = 'rgba(19, 23, 34, 0.85)';
      this.ctx.strokeStyle = '#2a2e39';
      this.ctx.lineWidth = 1;
      
      // Split label on newlines
      const lines = label.split('\n');
      const boxWidth = 130;
      const boxHeight = lines.length * 16 + 8;

      this.ctx.fillRect(labelX, labelY - 14, boxWidth, boxHeight);
      this.ctx.strokeRect(labelX, labelY - 14, boxWidth, boxHeight);

      this.ctx.fillStyle = '#d1d4dc';
      this.ctx.font = '11px Inter';
      lines.forEach((line, idx) => {
        this.ctx.fillText(line, labelX + 8, labelY + idx * 16);
      });
    } else if (d.type === 'zoom' && validCoords.length >= 2) {
      // Draw temporary Zoom box outline
      const p1 = validCoords[0];
      const p2 = validCoords[1];
      this.ctx.strokeStyle = '#ff9800';
      this.ctx.lineWidth = 1;
      this.ctx.setLineDash([3, 3]);
      this.ctx.strokeRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
      this.ctx.fillStyle = 'rgba(255, 152, 0, 0.08)';
      this.ctx.fillRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
      this.ctx.setLineDash([]);
    }

    this.ctx.restore();
  }

  drawHandle(coords) {
    this.ctx.save();
    this.ctx.fillStyle = '#2962ff';
    this.ctx.strokeStyle = '#ffffff';
    this.ctx.lineWidth = 1.5;
    this.ctx.beginPath();
    this.ctx.arc(coords.x, coords.y, 4, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.stroke();
    this.ctx.restore();
  }

  destroy() {
    this._resizeObserver?.disconnect();
    const parent = this.canvas.parentElement;
    if (this._eventListeners.onMouseDown) {
      parent.removeEventListener('mousedown', this._eventListeners.onMouseDown);
      parent.removeEventListener('mousemove', this._eventListeners.onMouseMove);
      parent.removeEventListener('mouseup', this._eventListeners.onMouseUp);
      parent.removeEventListener('dblclick', this._eventListeners.onDoubleClick);
    }
  }
}
