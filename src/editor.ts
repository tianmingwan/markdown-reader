// 预览直接编辑与 Markdown 序列化模块
// 支持：需手动开启、正文直接输入、加粗 (Bold)、文字颜色更改、保存回文件系统/SAF、未保存防误关提示

import { api } from './api.ts';

export interface EditorState {
  enabled: boolean;
  dirty: boolean;
  activePath: string | null;
}

export interface EditorCallbacks {
  onDirtyChange: (dirty: boolean) => void;
  onSaved: (path: string, markdown: string) => void;
  showToast: (msg: string) => void;
  onExit?: () => void;
}

export class DirectEditor {
  public state: EditorState = {
    enabled: false,
    dirty: false,
    activePath: null,
  };

  private container: HTMLElement | null = null;
  private callbacks: EditorCallbacks | null = null;
  private inputHandler: ((e: Event) => void) | null = null;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;

  public init(callbacks: EditorCallbacks): void {
    this.callbacks = callbacks;
  }

  /** 挂载到指定的预览内容容器 (#preview-content) */
  public mount(container: HTMLElement, filePath: string): void {
    this.container = container;
    this.state.activePath = filePath;
    this.state.dirty = false;
    this.notifyDirty();

    if (this.state.enabled) {
      this.applyEditableState();
    }
  }

  /**
   * 关闭编辑模式，若有未保存修改会弹窗确认。
   * @returns true 表示成功退出编辑模式；false 表示用户取消了退出
   */
  public close(): boolean {
    if (!this.state.enabled) return true;
    const stillEnabled = this.toggle(false);
    return !stillEnabled;
  }

  /** 切换编辑模式开启/关闭 */
  public toggle(force?: boolean): boolean {
    const next = force !== undefined ? force : !this.state.enabled;
    if (this.state.enabled === next) return this.state.enabled;

    if (!next && this.state.dirty) {
      const confirmExit = window.confirm('当前文档有未保存的修改，退出编辑将丢失修改，确定退出吗？');
      if (!confirmExit) return this.state.enabled;
    }

    this.state.enabled = next;
    if (!this.state.enabled) {
      this.state.dirty = false;
      this.notifyDirty();
    }

    this.applyEditableState();
    return this.state.enabled;
  }

  /** 应用 contenteditable 及事件监听 */
  private applyEditableState(): void {
    if (!this.container) return;
    const el = this.container;

    if (this.state.enabled) {
      el.setAttribute('contenteditable', 'true');
      el.classList.add('in-preview-editing');

      // 保护复杂组件不被内部直接打字破坏
      el.querySelectorAll('.mermaid, .mermaid-error, .katex, .code-block, #ink-canvas').forEach((node) => {
        (node as HTMLElement).setAttribute('contenteditable', 'false');
      });

      if (!this.inputHandler) {
        this.inputHandler = () => {
          if (!this.state.dirty) {
            this.state.dirty = true;
            this.notifyDirty();
          }
        };
        el.addEventListener('input', this.inputHandler);
      }

      if (!this.keydownHandler) {
        this.keydownHandler = (e: KeyboardEvent) => {
          if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
            e.preventDefault();
            void this.save();
          } else if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B')) {
            e.preventDefault();
            this.toggleBold();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            this.callbacks?.onExit?.();
          }
        };
        window.addEventListener('keydown', this.keydownHandler);
      }
    } else {
      el.removeAttribute('contenteditable');
      el.classList.remove('in-preview-editing');

      if (this.inputHandler) {
        el.removeEventListener('input', this.inputHandler);
        this.inputHandler = null;
      }
      if (this.keydownHandler) {
        window.removeEventListener('keydown', this.keydownHandler);
        this.keydownHandler = null;
      }
    }
  }

  /** 加粗切换选中文本 */
  public toggleBold(): void {
    if (!this.state.enabled) return;
    document.execCommand('bold', false);
    this.markDirty();
  }

  /** 为选中文本设置字体颜色 */
  public applyColor(color: string): void {
    if (!this.state.enabled) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      this.callbacks?.showToast('请先划选要改变颜色的文字');
      return;
    }

    // 使用 foreColor 或手动包裹 span 节点
    document.execCommand('styleWithCSS', false, 'true');
    document.execCommand('foreColor', false, color);
    this.markDirty();
  }

  /** 清除选中文本格式 */
  public removeFormat(): void {
    if (!this.state.enabled) return;
    document.execCommand('removeFormat', false);
    this.markDirty();
  }

  private markDirty(): void {
    if (!this.state.dirty) {
      this.state.dirty = true;
      this.notifyDirty();
    }
  }

  private notifyDirty(): void {
    this.callbacks?.onDirtyChange(this.state.dirty);
  }

  /** 保存当前编辑内容到文件 */
  public async save(): Promise<boolean> {
    if (!this.state.activePath || !this.container) return false;
    const path = this.state.activePath;

    try {
      const markdown = this.serializeToMarkdown();
      await api.saveFile(path, markdown);
      this.state.dirty = false;
      this.notifyDirty();
      this.callbacks?.onSaved(path, markdown);
      this.callbacks?.showToast('✓ 保存成功');
      return true;
    } catch (e) {
      this.callbacks?.showToast(`保存失败：${String(e)}`);
      return false;
    }
  }

  /**
   * 将当前 #preview-content DOM 树反向序列化为标准 Markdown
   */
  public serializeToMarkdown(): string {
    if (!this.container) return '';
    return cleanMarkdown(serializeNode(this.container)) + '\n';
  }

  public destroy(): void {
    if (this.container && this.inputHandler) {
      this.container.removeEventListener('input', this.inputHandler);
    }
    if (this.keydownHandler) {
      window.removeEventListener('keydown', this.keydownHandler);
    }
  }
}

export function normalizeColor(color: string): string {
  const c = color.trim();
  const match = c.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (match) {
    const r = parseInt(match[1], 10).toString(16).padStart(2, '0');
    const g = parseInt(match[2], 10).toString(16).padStart(2, '0');
    const b = parseInt(match[3], 10).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
  }
  return c;
}

export function cleanMarkdown(str: string): string {
  return str.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 递归将 DOM 节点序列化为 Markdown 字符串
 */
export function serializeNode(node: Node): string {
  // 1. 文本节点
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent || '';
  }

  // 2. 非元素节点跳过
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return '';
  }

  const el = node as HTMLElement;
  const tag = el.tagName.toUpperCase();

  // 忽略批注画布与内部临时控件
  if (el.id === 'ink-canvas' || el.classList.contains('ink-canvas') || el.classList.contains('pop-menu')) {
    return '';
  }

  // 处理 KaTeX 公式
  if (el.classList.contains('katex') || el.classList.contains('katex-display')) {
    const isDisplay = el.classList.contains('katex-display');
    const texAnnotation = el.querySelector('annotation[encoding="application/x-tex"]');
    const tex = texAnnotation?.textContent || el.textContent || '';
    return isDisplay ? `\n\n$$\n${tex.trim()}\n$$\n\n` : `$${tex.trim()}$`;
  }

  // 处理 Mermaid 图表
  if (el.classList.contains('mermaid')) {
    const rawCode = el.dataset.raw || el.textContent || '';
    return `\n\n\`\`\`mermaid\n${rawCode.trim()}\n\`\`\`\n\n`;
  }
  if (el.classList.contains('mermaid-error')) {
    const codeEl = el.querySelector('.mermaid-error-code');
    const rawCode = codeEl?.textContent || '';
    return `\n\n\`\`\`mermaid\n${rawCode.trim()}\n\`\`\`\n\n`;
  }

  // 处理代码块 (<pre class="code-block"> / <pre><code>)
  if (tag === 'PRE') {
    const codeEl = el.querySelector('code');
    const codeText = (codeEl || el).textContent || '';
    // 尝试提取语言标记
    const lang = el.dataset.lang || extractLang(el) || (codeEl ? extractLang(codeEl) : '');
    return `\n\n\`\`\`${lang}\n${codeText.replace(/\r\n/g, '\n').trimEnd()}\n\`\`\`\n\n`;
  }

  // 递归处理子节点
  const serializeChildren = (): string => {
    let result = '';
    for (const child of Array.from(el.childNodes)) {
      result += serializeNode(child);
    }
    return result;
  };

  const inner = serializeChildren();

  // 标题
  if (/^H[1-6]$/.test(tag)) {
    const level = parseInt(tag.charAt(1), 10);
    const hashes = '#'.repeat(level);
    return `\n\n${hashes} ${inner.trim()}\n\n`;
  }

  // 段落
  if (tag === 'P') {
    return `\n\n${inner.trim()}\n\n`;
  }

  // 换行
  if (tag === 'BR') {
    return '\n';
  }

  // 加粗
  if (tag === 'STRONG' || tag === 'B') {
    if (!inner.trim()) return '';
    return `**${inner.trim()}**`;
  }

  // 斜体
  if (tag === 'EM' || tag === 'I') {
    if (!inner.trim()) return '';
    return `*${inner.trim()}*`;
  }

  // 删除线
  if (tag === 'DEL' || tag === 'S') {
    if (!inner.trim()) return '';
    return `~~${inner.trim()}~~`;
  }

  // 行内代码
  if (tag === 'CODE') {
    return `\`${inner}\``;
  }

  // 颜色处理 (SPAN / FONT 带 color 样式)
  if (tag === 'SPAN' || tag === 'FONT') {
    const color = el.style.color || el.getAttribute('color');
    const isBold = el.style.fontWeight === 'bold' || parseInt(el.style.fontWeight || '400', 10) >= 700;

    if (color) {
      const hexOrRgb = normalizeColor(color);
      let text = inner;
      if (isBold) text = `**${text.trim()}**`;
      return `<span style="color: ${hexOrRgb}">${text}</span>`;
    }
    if (isBold) {
      return `**${inner.trim()}**`;
    }
    return inner;
  }

  // 引用
  if (tag === 'BLOCKQUOTE') {
    const lines = inner.trim().split('\n');
    return '\n\n' + lines.map((l) => `> ${l}`).join('\n') + '\n\n';
  }

  // 无序列表与有序列表
  if (tag === 'UL') {
    return `\n\n${inner.trim()}\n\n`;
  }
  if (tag === 'OL') {
    return `\n\n${inner.trim()}\n\n`;
  }

  // 列表项
  if (tag === 'LI') {
    const isOrdered = el.parentElement?.tagName === 'OL';
    const index = Array.from(el.parentElement?.children || []).indexOf(el) + 1;
    const prefix = isOrdered ? `${index}. ` : '- ';

    // 检查任务列表 checkbox
    const checkbox = el.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (checkbox) {
      const checked = checkbox.checked ? '[x] ' : '[ ] ';
      // 移除 inner 中由于 checkbox 产生的多余文字
      const cleanInner = inner.replace(/^\s*\[[ xX]\]\s*/, '').trim();
      return `${prefix}${checked}${cleanInner}\n`;
    }

    return `${prefix}${inner.trim()}\n`;
  }

  // 水平分割线
  if (tag === 'HR') {
    return '\n\n---\n\n';
  }

  // 链接
  if (tag === 'A') {
    let href = el.getAttribute('href') || '';
    if (href.startsWith('mdopen://local/')) {
      href = decodeURIComponent(href.slice('mdopen://local/'.length));
    }
    return `[${inner.trim()}](${href})`;
  }

  // 图片
  if (tag === 'IMG') {
    const alt = el.getAttribute('alt') || '';
    let src = el.getAttribute('src') || '';
    if (src.startsWith('mdimg://local/')) {
      src = decodeURIComponent(src.slice('mdimg://local/'.length));
    }
    return `![${alt}](${src})`;
  }

  // 表格
  if (tag === 'TABLE') {
    return `\n\n${serializeTable(el)}\n\n`;
  }

  // 默认透传容器（DIV 等）
  return inner;
}

function extractLang(el: HTMLElement): string {
  const cls = el.className || '';
  const match = cls.match(/language-([a-zA-Z0-9_-]+)/);
  return match ? match[1] : '';
}

function serializeTable(table: HTMLElement): string {
  const rows = Array.from(table.querySelectorAll('tr'));
  if (rows.length === 0) return '';

  const tableData: string[][] = [];
  for (const row of rows) {
    const cells = Array.from(row.querySelectorAll('th, td')).map((c) =>
      c.textContent?.trim().replace(/\|/g, '\\|') || '',
    );
    if (cells.length > 0) tableData.push(cells);
  }

  if (tableData.length === 0) return '';
  const colCount = Math.max(...tableData.map((r) => r.length));

  const formatRow = (cells: string[]): string => {
    const padded = [...cells];
    while (padded.length < colCount) padded.push('');
    return `| ${padded.join(' | ')} |`;
  };

  const lines: string[] = [];
  lines.push(formatRow(tableData[0]));
  // 分隔行
  lines.push(`| ${Array(colCount).fill('---').join(' | ')} |`);

  for (let i = 1; i < tableData.length; i++) {
    lines.push(formatRow(tableData[i]));
  }

  return lines.join('\n');
}

export const directEditor = new DirectEditor();
