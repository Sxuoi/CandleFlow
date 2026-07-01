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
    
    // Configure LWC scrolling based on tool
    this.configureChartInteraction();
    this.repaint();
  }

  configureChartInteraction() {
    // Disable LWC scroll/pan when drawing shapes so mouse drags draw rather than scroll the chart
    const isDrawingTool = ['trend', 'path', 'brush', 'ruler', 'zoom'].includes(this.activeTool);
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

    // Keyboard bindings (Delete key removes selected drawing)
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // Only trigger if not typing in input annotation field
        if (document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
          this.deleteSelected();
        }
      } else if (e.key === 'Escape') {
        this.cancelActiveDrawing();
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
    if (this.activeTool === 'trend') {
      if (!this.isDrawing) {
        this.isDrawing = true;
        this.currentDrawing = {
          id: Date.now().toString(),
          type: 'trend',
          points: [snapped, snapped]
        };
      } else {
        // Second click completes Trend Line
        this.isDrawing = false;
        this.currentDrawing.points[1] = snapped;
        this.drawings.push(this.currentDrawing);
        this.currentDrawing = null;
        this.setTool('cursor');
        this.saveAndNotify();
      }
    } else if (this.activeTool === 'horizontal') {
      this.isDrawing = false;
      const newDrawing = {
        id: Date.now().toString(),
        type: 'horizontal',
        points: [snapped]
      };
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

      if (d.type === 'trend' && ptsCoords.length >= 2) {
        if (this.distToSegment(pos, ptsCoords[0], ptsCoords[1]) < 6) return d;
      } else if (d.type === 'horizontal') {
        const y = ptsCoords[0].y;
        if (Math.abs(pos.y - y) < 6) return d;
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
    } else if (d.type === 'horizontal') {
      // Draw Horizontal Ray (extends infinitely to the right)
      const y = validCoords[0].y;
      const x = validCoords[0].x;
      this.ctx.strokeStyle = drawColor;
      this.ctx.lineWidth = width;
      this.ctx.beginPath();
      this.ctx.moveTo(x, y);
      this.ctx.lineTo(this.canvas.width / (window.devicePixelRatio || 1), y);
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
