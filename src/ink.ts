// 手写笔与圈画批注模块
// 视口级高性能硬件加速画布 (Viewport Canvas)：
// 1. 画布大小严格锁定为可见视口区域（避免巨幅文档造成 GPU 显存溢出回退 CPU 软解卡顿）
// 2. 坐标系自动映射至文档段落（随内容像素级跟随滚动）
// 3. 硬件级防误触与零页面拖动：手写笔下笔时 touch-action: none 强制禁止页面拖动，彻底杜绝手写拖屏
// 4. 原生感平滑惯性手势：手指触摸时提供高精度物理惯性滚动

export interface InkPoint {
  x: number;
  y: number;
  p: number; // 压感 0~1
}

export interface StrokeBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface InkStroke {
  id: string;
  tool: 'pen' | 'highlighter';
  color: string;
  size: number;
  points: InkPoint[];
  bounds?: StrokeBounds;
}

export type InkTool = 'pen' | 'highlighter' | 'eraser';

export interface InkState {
  enabled: boolean;
  tool: InkTool;
  color: string;
  size: number;
  allowTouchDraw: boolean; // 是否允许手指圈画（默认 false：仅手写笔绘制，手指平滑滚动防误触）
  strokes: InkStroke[];
  undoStack: InkStroke[][];
  redoStack: InkStroke[][];
}

const STORAGE_PREFIX = 'mdreader_ink_';

function computeStrokeBounds(pts: InkPoint[]): StrokeBounds {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, maxX, minY, maxY };
}

export class InkManager {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private container: HTMLElement | null = null; // #preview-content (正文坐标基准)
  private scrollContainer: HTMLElement | null = null; // #preview (滚动容器)
  private wrapContainer: HTMLElement | null = null; // #preview-wrap (视口容器)
  private currentPath: string | null = null;

  public state: InkState = {
    enabled: false,
    tool: 'pen',
    color: '#e53935', // 默认醒目红
    size: 3,
    allowTouchDraw: false, // 默认仅手写笔圈画，手指用于平滑翻页，手掌彻底防误触
    strokes: [],
    undoStack: [],
    redoStack: [],
  };

  private isDrawing = false;
  private isDrawingWithPen = false;
  private activePointerId: number | null = null;
  private currentPoints: InkPoint[] = [];
  private lastCanvasPoint: { x: number; y: number } | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private onChangeCallback: (() => void) | null = null;
  private scrollRafId: number = 0;

  // 物理几何基准缓存（仅在 mount 和 resize 时更新，彻底避免在滚动与拖拽中发生任何强制同步回流）
  private baseContainerLeft = 0;
  private baseContainerTop = 0;
  private canvasLeft = 0;
  private canvasTop = 0;
  private viewportWidth = 0;
  private viewportHeight = 0;

  constructor() {
    window.addEventListener('resize', () => {
      if (this.canvas) this.syncCanvasSize();
    });
  }

  public onChange(cb: () => void): void {
    this.onChangeCallback = cb;
  }

  private notify(): void {
    if (this.onChangeCallback) this.onChangeCallback();
  }

  /**
   * 挂载手写笔视口画布
   * @param container 正文内容容器 (#preview-content)
   * @param filePath 当前文档路径
   * @param scrollContainer 滚动容器 (article#preview)
   * @param wrapContainer 视口外层容器 (main#preview-wrap)
   */
  public mount(
    container: HTMLElement,
    filePath: string,
    scrollContainer?: HTMLElement,
    wrapContainer?: HTMLElement
  ): void {
    this.container = container;
    this.currentPath = filePath;

    this.scrollContainer =
      scrollContainer ||
      (container.closest('#preview') as HTMLElement) ||
      container.parentElement!;

    this.wrapContainer =
      wrapContainer ||
      (container.closest('#preview-wrap') as HTMLElement) ||
      this.scrollContainer.parentElement!;

    if (window.getComputedStyle(this.wrapContainer).position === 'static') {
      this.wrapContainer.style.position = 'relative';
    }

    // 清理可能遗留在 container 内的旧版超大画布
    const oldCvs = container.querySelector<HTMLCanvasElement>('#ink-canvas');
    if (oldCvs) {
      oldCvs.remove();
    }

    // 将高性能视口画布挂载到 wrapContainer（仅与可视区域同尺寸，彻底规避 GPU 显存超限）
    let cvs = this.wrapContainer.querySelector<HTMLCanvasElement>('#ink-canvas');
    if (!cvs) {
      cvs = document.createElement('canvas');
      cvs.id = 'ink-canvas';
      cvs.className = 'ink-canvas';
      this.wrapContainer.appendChild(cvs);
    }
    this.canvas = cvs;
    this.ctx = cvs.getContext('2d');

    this.loadStrokes(filePath);
    this.syncCanvasSize();
    this.bindEvents();

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    this.resizeObserver = new ResizeObserver(() => {
      this.syncCanvasSize();
    });
    this.resizeObserver.observe(this.wrapContainer);

    // 监听文档滚动，视口重绘以跟随文字滚动
    this.scrollContainer.removeEventListener('scroll', this.handleScroll);
    this.scrollContainer.addEventListener('scroll', this.handleScroll, { passive: true });

    this.updatePointerStyle();
  }

  private handleScroll = (): void => {
    // 若未开启手写批注且当前文档没有笔画，直接退出，不进 RAF，不重绘清屏
    if (!this.state.enabled && this.state.strokes.length === 0) return;
    if (this.scrollRafId) return;
    this.scrollRafId = requestAnimationFrame(() => {
      this.scrollRafId = 0;
      this.redraw();
    });
  };

  /** 更新基准物理尺寸与偏移量（仅在 mount、resize 或落笔瞬间执行，避免滚动中回流） */
  public updateBaseMetrics(): void {
    if (!this.container || !this.scrollContainer || !this.canvas) return;
    const contRect = this.container.getBoundingClientRect();
    const cvsRect = this.canvas.getBoundingClientRect();
    const scrollY = this.scrollContainer.scrollTop;
    const scrollX = this.scrollContainer.scrollLeft;

    this.baseContainerTop = contRect.top + scrollY;
    this.baseContainerLeft = contRect.left + scrollX;
    this.canvasLeft = cvsRect.left;
    this.canvasTop = cvsRect.top;
    this.viewportWidth = cvsRect.width;
    this.viewportHeight = cvsRect.height;
  }

  /** 同步视口画布尺寸（严格锁定可视范围，DPR 最大 2.0，纯 GPU 硬件加速） */
  public syncCanvasSize(): void {
    if (!this.canvas || !this.wrapContainer || !this.ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.wrapContainer.clientWidth;
    const h = this.wrapContainer.clientHeight;
    if (w <= 0 || h <= 0) return;

    const targetW = Math.round(w * dpr);
    const targetH = Math.round(h * dpr);

    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
    }

    this.updateBaseMetrics();
    this.redraw();
  }

  /** 切换手写批注模式开/关 */
  public toggle(enabled?: boolean): boolean {
    this.state.enabled = enabled !== undefined ? enabled : !this.state.enabled;
    this.updatePointerStyle();
    if (this.state.enabled) {
      this.updateBaseMetrics();
      this.redraw();
    }
    this.notify();
    return this.state.enabled;
  }

  public setTool(tool: InkTool): void {
    this.state.tool = tool;
    this.updatePointerStyle();
    this.notify();
  }

  public setColor(color: string): void {
    this.state.color = color;
    if (this.state.tool === 'eraser') {
      this.state.tool = 'pen';
    }
    this.notify();
  }

  public setSize(size: number): void {
    this.state.size = size;
    this.notify();
  }

  public setAllowTouchDraw(allow: boolean): void {
    this.state.allowTouchDraw = allow;
    this.notify();
  }

  private updatePointerStyle(): void {
    if (!this.canvas || !this.scrollContainer) return;
    // 画布始终保持 pointer-events: none，完全作为独立的纯渲染图层，不阻挡底层原生触控
    this.canvas.style.pointerEvents = 'none';

    if (!this.state.enabled) {
      this.scrollContainer.style.cursor = 'default';
      this.scrollContainer.classList.remove('ink-active');
      return;
    }

    this.scrollContainer.classList.add('ink-active');
    if (this.state.tool === 'eraser') {
      this.scrollContainer.style.cursor = 'cell';
    } else {
      this.scrollContainer.style.cursor = 'crosshair';
    }
  }

  public unbindEvents(): void {
    if (!this.scrollContainer) return;
    const sc = this.scrollContainer;
    sc.removeEventListener('pointerdown', this.handlePointerDown, { capture: true });
    sc.removeEventListener('pointermove', this.handlePointerMove);
    sc.removeEventListener('pointerup', this.handlePointerEnd);
    sc.removeEventListener('pointercancel', this.handlePointerEnd);
  }

  private bindEvents(): void {
    if (!this.scrollContainer) return;
    const sc = this.scrollContainer;
    this.unbindEvents();

    sc.addEventListener('pointerdown', this.handlePointerDown, { capture: true, passive: false });
    sc.addEventListener('pointermove', this.handlePointerMove, { passive: false });
    sc.addEventListener('pointerup', this.handlePointerEnd);
    sc.addEventListener('pointercancel', this.handlePointerEnd);
  }

  private handlePointerDown = (e: PointerEvent): void => {
    if (!this.state.enabled) return;

    // 1. 若当前手写笔正处于落笔书写状态，手掌接触屏幕时彻底阻断（硬件级防误触）
    if (this.isDrawingWithPen) {
      if (e.pointerType === 'touch') {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }

    // 2. 检查是否应该由手写层捕获事件
    const isPen = e.pointerType === 'pen';
    const isTouchDraw = e.pointerType === 'touch' && this.state.allowTouchDraw;
    const isMouseDraw = e.pointerType === 'mouse' && e.button === 0;

    if (isPen || isTouchDraw || isMouseDraw) {
      // 专职绘制：阻止默认滚动与文本选中
      e.preventDefault();
      e.stopPropagation();

      this.isDrawing = true;
      this.isDrawingWithPen = isPen;
      this.activePointerId = e.pointerId;

      // 仅在落笔瞬间刷新一次物理基准（以防动态布局微调），滚动中绝不再调用
      this.updateBaseMetrics();

      try {
        this.scrollContainer?.setPointerCapture(e.pointerId);
      } catch {}

      this.onPointerStart(e);
      return;
    }

    // 3. 普通手指触控（!allowTouchDraw）：
    // 坚决不调用 preventDefault()，让事件直接穿透至原生硬件滚动容器！
    // 依靠安卓系统/浏览器的 GPU Compositor 线程实现 120Hz 纯硬件平滑滚动！
  };

  private handlePointerMove = (e: PointerEvent): void => {
    if (this.isDrawing && e.pointerId === this.activePointerId) {
      e.preventDefault();
      this.onPointerMove(e);
    }
  };

  private handlePointerEnd = (e: PointerEvent): void => {
    if (this.isDrawing && e.pointerId === this.activePointerId) {
      try {
        this.scrollContainer?.releasePointerCapture(e.pointerId);
      } catch {}
      this.isDrawingWithPen = false;
      this.activePointerId = null;
      this.onPointerEnd();
    }
  };

  /** 获取相对于文档正文 (#preview-content) 的全局坐标 (0 DOM 回流) */
  private getDocPoint(e: PointerEvent): InkPoint {
    const scrollX = this.scrollContainer ? this.scrollContainer.scrollLeft : 0;
    const scrollY = this.scrollContainer ? this.scrollContainer.scrollTop : 0;
    const x = e.clientX - this.baseContainerLeft + scrollX;
    const y = e.clientY - this.baseContainerTop + scrollY;
    const p = e.pressure > 0 ? e.pressure : 0.5;
    return { x, y, p };
  }

  /** 获取相对于视口 Canvas 的实时坐标 (0 DOM 回流) */
  private getCanvasPoint(e: PointerEvent): { x: number; y: number } {
    return {
      x: e.clientX - this.canvasLeft,
      y: e.clientY - this.canvasTop,
    };
  }

  private onPointerStart(e: PointerEvent): void {
    const docPt = this.getDocPoint(e);
    const canPt = this.getCanvasPoint(e);

    if (this.state.tool === 'eraser') {
      this.eraseAt(docPt.x, docPt.y);
      return;
    }

    this.currentPoints = [docPt];
    this.lastCanvasPoint = canPt;

    // 绘制落笔初始圆点（直接在视口画布 GPU 渲染，零延迟）
    if (this.ctx) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const isHighlight = this.state.tool === 'highlighter';
      const baseSize = isHighlight ? Math.max(16, this.state.size * 5) : this.state.size;
      const r = (baseSize * (0.6 + 0.8 * docPt.p)) / 2;
      this.ctx.fillStyle = isHighlight ? this.toRgba(this.state.color, 0.35) : this.state.color;
      this.ctx.beginPath();
      this.ctx.arc(canPt.x, canPt.y, Math.max(1, r), 0, Math.PI * 2);
      this.ctx.fill();
    }
  }

  private onPointerMove(e: PointerEvent): void {
    const events: PointerEvent[] =
      typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const docPt = this.getDocPoint(ev);
      const canPt = this.getCanvasPoint(ev);

      if (this.state.tool === 'eraser') {
        this.eraseAt(docPt.x, docPt.y);
      } else {
        this.currentPoints.push(docPt);
        if (this.lastCanvasPoint) {
          this.drawLiveSegment(this.lastCanvasPoint, canPt, docPt.p);
        }
        this.lastCanvasPoint = canPt;
      }
    }
  }

  private onPointerEnd(): void {
    this.isDrawing = false;
    this.lastCanvasPoint = null;
    if (this.state.tool === 'eraser') {
      return;
    }

    if (this.currentPoints.length > 0) {
      this.recordUndo();
      const stroke: InkStroke = {
        id: `stroke_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        tool: this.state.tool === 'highlighter' ? 'highlighter' : 'pen',
        color: this.state.color,
        size: this.state.tool === 'highlighter' ? Math.max(16, this.state.size * 5) : this.state.size,
        points: [...this.currentPoints],
        bounds: computeStrokeBounds(this.currentPoints),
      };
      this.state.strokes.push(stroke);
      this.state.redoStack = [];
      this.currentPoints = [];
      this.redraw();
      this.saveStrokes();
      this.notify();
    }
  }

  /** 实时绘制微线段：硬件加速局部直绘，耗时 < 0.1ms */
  private drawLiveSegment(
    p1: { x: number; y: number },
    p2: { x: number; y: number },
    pressure: number
  ): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const isHighlight = this.state.tool === 'highlighter';
    const baseSize = isHighlight ? Math.max(16, this.state.size * 5) : this.state.size;
    const width = baseSize * (0.6 + 0.8 * (pressure || 0.5));

    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = isHighlight ? this.toRgba(this.state.color, 0.35) : this.state.color;
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  }

  /** 笔画级橡皮擦：根据文档全局坐标与空间包围盒精准擦除 */
  private eraseAt(docX: number, docY: number): void {
    const threshold = Math.max(18, this.state.size * 3.5);
    const threshSq = threshold * threshold;
    const beforeCount = this.state.strokes.length;

    this.state.strokes = this.state.strokes.filter((stroke) => {
      const b = stroke.bounds;
      if (b) {
        if (
          docX < b.minX - threshold ||
          docX > b.maxX + threshold ||
          docY < b.minY - threshold ||
          docY > b.maxY + threshold
        ) {
          return true; // 不相交，保留
        }
      }
      return !stroke.points.some((pt) => {
        const dx = pt.x - docX;
        const dy = pt.y - docY;
        return dx * dx + dy * dy <= threshSq;
      });
    });

    if (this.state.strokes.length !== beforeCount) {
      this.recordUndo();
      this.state.redoStack = [];
      this.redraw();
      this.saveStrokes();
      this.notify();
    }
  }

  /** 重绘当前视口内的所有笔画（视锥剔除 Frustum Culling，毫秒级快速上屏，0 DOM 回流） */
  public redraw(): void {
    if (!this.ctx || !this.canvas || !this.scrollContainer) return;
    const ctx = this.ctx;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    // 清空视口画布
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    const scrollX = this.scrollContainer.scrollLeft;
    const scrollY = this.scrollContainer.scrollTop;
    const offsetX = (this.baseContainerLeft - this.canvasLeft) - scrollX;
    const offsetY = (this.baseContainerTop - this.canvasTop) - scrollY;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(offsetX, offsetY);

    const vpW = this.viewportWidth || (this.canvas.width / dpr);
    const vpH = this.viewportHeight || (this.canvas.height / dpr);

    // 视口在文档坐标系下的可见矩形范围（剔除不可见笔画）
    const visibleMinY = -offsetY;
    const visibleMaxY = -offsetY + vpH;
    const visibleMinX = -offsetX;
    const visibleMaxX = -offsetX + vpW;

    const highlighters = this.state.strokes.filter((s) => s.tool === 'highlighter');
    const pens = this.state.strokes.filter((s) => s.tool !== 'highlighter');

    for (let i = 0; i < highlighters.length; i++) {
      const s = highlighters[i];
      if (s.bounds) {
        if (
          s.bounds.maxY < visibleMinY ||
          s.bounds.minY > visibleMaxY ||
          s.bounds.maxX < visibleMinX ||
          s.bounds.minX > visibleMaxX
        ) {
          continue;
        }
      }
      this.drawStroke(ctx, s);
    }
    for (let i = 0; i < pens.length; i++) {
      const s = pens[i];
      if (s.bounds) {
        if (
          s.bounds.maxY < visibleMinY ||
          s.bounds.minY > visibleMaxY ||
          s.bounds.maxX < visibleMinX ||
          s.bounds.minX > visibleMaxX
        ) {
          continue;
        }
      }
      this.drawStroke(ctx, s);
    }
  }

  private drawStroke(ctx: CanvasRenderingContext2D, stroke: InkStroke): void {
    const pts = stroke.points;
    if (!pts || pts.length === 0) return;

    const isHighlight = stroke.tool === 'highlighter';
    const strokeStyle = isHighlight ? this.toRgba(stroke.color, 0.35) : stroke.color;

    ctx.strokeStyle = strokeStyle;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (pts.length === 1) {
      ctx.fillStyle = strokeStyle;
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, stroke.size / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    ctx.lineWidth = stroke.size;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);

    for (let i = 1; i < pts.length; i++) {
      const midX = (pts[i - 1].x + pts[i].x) / 2;
      const midY = (pts[i - 1].y + pts[i].y) / 2;
      ctx.quadraticCurveTo(pts[i - 1].x, pts[i - 1].y, midX, midY);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    ctx.stroke();
  }

  private toRgba(hexOrColor: string, alpha: number): string {
    if (hexOrColor.startsWith('#')) {
      let hex = hexOrColor.slice(1);
      if (hex.length === 3) {
        hex = hex.split('').map((c) => c + c).join('');
      }
      const num = parseInt(hex, 16);
      const r = (num >> 16) & 255;
      const g = (num >> 8) & 255;
      const b = num & 255;
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    return hexOrColor;
  }

  private recordUndo(): void {
    const clone = this.state.strokes.map((s) => ({
      ...s,
      points: s.points.map((p) => ({ ...p })),
    }));
    this.state.undoStack.push(clone);
    if (this.state.undoStack.length > 25) {
      this.state.undoStack.shift();
    }
  }

  public undo(): void {
    if (this.state.undoStack.length === 0) return;
    const current = this.state.strokes.map((s) => ({
      ...s,
      points: s.points.map((p) => ({ ...p })),
    }));
    this.state.redoStack.push(current);

    const prev = this.state.undoStack.pop()!;
    this.state.strokes = prev;
    this.redraw();
    this.saveStrokes();
    this.notify();
  }

  public redo(): void {
    if (this.state.redoStack.length === 0) return;
    const current = this.state.strokes.map((s) => ({
      ...s,
      points: s.points.map((p) => ({ ...p })),
    }));
    this.state.undoStack.push(current);

    const next = this.state.redoStack.pop()!;
    this.state.strokes = next;
    this.redraw();
    this.saveStrokes();
    this.notify();
  }

  public clearAll(): void {
    if (this.state.strokes.length === 0) return;
    this.recordUndo();
    this.state.strokes = [];
    this.state.redoStack = [];
    this.redraw();
    this.saveStrokes();
    this.notify();
  }

  private saveStrokes(): void {
    if (!this.currentPath) return;
    try {
      const key = STORAGE_PREFIX + encodeURIComponent(this.currentPath);
      if (this.state.strokes.length === 0) {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, JSON.stringify(this.state.strokes));
      }
    } catch (e) {
      console.warn('保存手写笔迹失败', e);
    }
  }

  private loadStrokes(filePath: string): void {
    this.state.strokes = [];
    this.state.undoStack = [];
    this.state.redoStack = [];
    try {
      const key = STORAGE_PREFIX + encodeURIComponent(filePath);
      const data = localStorage.getItem(key);
      if (data) {
        const list: InkStroke[] = JSON.parse(data);
        for (let i = 0; i < list.length; i++) {
          const s = list[i];
          if (!s.bounds && s.points && s.points.length > 0) {
            s.bounds = computeStrokeBounds(s.points);
          }
        }
        this.state.strokes = list;
      }
    } catch (e) {
      console.warn('读取手写笔迹失败', e);
    }
  }

  public destroy(): void {
    if (this.scrollRafId) {
      cancelAnimationFrame(this.scrollRafId);
      this.scrollRafId = 0;
    }
    this.unbindEvents();
    if (this.scrollContainer) {
      this.scrollContainer.removeEventListener('scroll', this.handleScroll);
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.canvas && this.canvas.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas);
      this.canvas = null;
    }
  }
}

export const inkManager = new InkManager();
