/**
 * Mermaid 渲染管线深度测试（真实 mermaid + jsdom）。
 *
 * 运行：npm test
 * 覆盖：基本渲染（flowchart / sequence）、错误隔离、重复图表 id 唯一性、
 *       缓存命中与主题分离、FIFO 淘汰、dedent / rekeySvg / cacheKey 边界。
 */
import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';

// ---- jsdom 全局环境（必须先于 mermaid 动态导入建立） ----
const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
});
const { window } = dom;
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  SVGElement: window.SVGElement,
  Node: window.Node,
  DOMParser: window.DOMParser,
  getComputedStyle: window.getComputedStyle,
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  MutationObserver: window.MutationObserver,
  CustomEvent: window.CustomEvent,
  Event: window.Event,
  DocumentFragment: window.DocumentFragment,
  CSSStyleSheet: window.CSSStyleSheet,
  self: window,
};
for (const [k, v] of Object.entries(globals)) {
  if (k === 'navigator') {
    // Node ≥21 的 globalThis.navigator 是只读 getter，需 defineProperty 覆盖
    Object.defineProperty(globalThis, 'navigator', { value: v, configurable: true });
  } else {
    globalThis[k] = v;
  }
}

// jsdom 不实现 SVG 测量方法，mermaid 布局需要；补 polyfill（mermaid 官方测试同款做法）
// getBBox 不能全零：时序图会据此判定“不在渲染树”而抛错
window.SVGElement.prototype.getBBox = () => ({ x: 0, y: 0, width: 10, height: 10 });
window.SVGElement.prototype.getComputedTextLength = () => 0;
window.SVGElement.prototype.getTotalLength = () => 0;

// 静默 mermaid 的调试输出（mermaid 用 console.error/warn 打日志）
const muted = () => {};
console.warn = muted;
console.error = muted;

const { renderMermaidIn, __internals } = await import('../src/mermaid.ts');
const { dedent, rekeySvg, cacheKey, setCached, cacheSize, cacheClear, cacheKeys } = __internals;

// ---- 极简测试框架 ----
const failures = [];
let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  \u2713 ${name}`);
    })
    .catch((e) => failures.push({ name, error: e }));
}

function containerWith(...codes) {
  const c = document.createElement('div');
  c.id = 'preview-content';
  for (const code of codes) {
    const pre = document.createElement('pre');
    pre.className = 'mermaid';
    pre.textContent = code;
    c.append(pre);
  }
  document.body.append(c);
  return c;
}

/** 去掉 SVG id / url 引用 / style 选择器里的 id 前缀（比较"同一张图"用） */
function normalizeIds(html) {
  return html
    .replace(/id="[^"]*"/g, '')
    .replace(/url\(#[^)]*\)/g, '')
    .replace(/#mmd-\d+/g, '');
}

function allIds(c) {
  return Array.from(c.querySelectorAll('[id]'), (el) => el.getAttribute('id'));
}

// ==================== 用例 ====================
const FLOW = 'graph TD\n  A[开始] --> B[结束]';
const SEQ = 'sequenceDiagram\n  A->>B: 你好\n  B-->>A: 收到';
const INVALID = '这不是任何图表语法!!!';

// ---- 基本渲染 ----
await test('flowchart 渲染出 svg 并替换 pre', async () => {
  const c = containerWith(FLOW);
  await renderMermaidIn(c, 'light');
  assert.ok(c.querySelector('div.mermaid svg'), '应生成 div.mermaid > svg');
  assert.equal(c.querySelectorAll('pre.mermaid').length, 0, 'pre 应被替换');
  assert.match(c.innerHTML, /开始/);
  c.remove();
});

await test('sequence 时序图渲染', async () => {
  const c = containerWith(SEQ);
  await renderMermaidIn(c, 'light');
  assert.ok(c.querySelector('div.mermaid svg'));
  c.remove();
});

// ---- 错误隔离 ----
await test('单个坏图不影响其它图，并显示可见错误占位', async () => {
  const c = containerWith(INVALID, FLOW);
  await renderMermaidIn(c, 'light');
  assert.ok(c.querySelector('.mermaid-error'), '坏图应显示 .mermaid-error');
  assert.match(
    c.querySelector('.mermaid-error-code').textContent,
    /这不是任何图表语法/,
    '错误占位应保留原始源码',
  );
  assert.ok(c.querySelector('div.mermaid svg'), '好图应照常渲染');
  c.remove();
});

await test('空图表显示“空图表”占位', async () => {
  const c = containerWith('   \n  ');
  await renderMermaidIn(c, 'light');
  assert.ok(c.querySelector('.mermaid-error'));
  assert.match(c.querySelector('.mermaid-error-code').textContent, /空图表/);
  c.remove();
});

// ---- 重复图表 id 唯一性 ----
await test('同一文档重复图表：id 全部唯一', async () => {
  const c = containerWith(FLOW, FLOW);
  await renderMermaidIn(c, 'light');
  assert.equal(c.querySelectorAll('div.mermaid svg').length, 2);
  const ids = allIds(c);
  assert.equal(new Set(ids).size, ids.length, 'SVG 内部 id 不应重复');
  c.remove();
});

// ---- 缓存 ----
await test('重复渲染命中缓存：条目不增、SVG 等价', async () => {
  cacheClear();
  const c = containerWith(FLOW);
  await renderMermaidIn(c, 'light');
  assert.equal(cacheSize(), 1, '首次渲染应入缓存');
  const first = normalizeIds(c.querySelector('div.mermaid').innerHTML);

  // 模拟切走再切回：innerHTML 重建相同图表
  c.innerHTML = `<pre class="mermaid">${FLOW}</pre>`;
  await renderMermaidIn(c, 'light');
  assert.equal(cacheSize(), 1, '应命中缓存，不产生新条目');
  const second = normalizeIds(c.querySelector('div.mermaid').innerHTML);
  assert.equal(second, first, '缓存复用的 SVG 应与首次等价（忽略 id）');
  assert.equal(new Set(allIds(c)).size, allIds(c).length, '缓存复用后 id 仍唯一');
  c.remove();
});

await test('明暗主题分别缓存', async () => {
  cacheClear();
  const c1 = containerWith(FLOW);
  await renderMermaidIn(c1, 'light');
  const c2 = containerWith(FLOW);
  await renderMermaidIn(c2, 'dark');
  assert.equal(cacheSize(), 2, 'light/dark 各占一个缓存条目');
  assert.notEqual(
    normalizeIds(c1.querySelector('div.mermaid').innerHTML),
    normalizeIds(c2.querySelector('div.mermaid').innerHTML),
    '明暗主题 SVG 应不同',
  );
  c1.remove();
  c2.remove();
});

await test('不同图表不共享缓存条目', async () => {
  cacheClear();
  const c1 = containerWith(FLOW);
  await renderMermaidIn(c1, 'light');
  const c2 = containerWith(SEQ);
  await renderMermaidIn(c2, 'light');
  assert.equal(cacheSize(), 2);
  c1.remove();
  c2.remove();
});

// ---- 列表缩进代码块（dedent 集成） ----
await test('缩进（列表内）的 mermaid 块能正常渲染', async () => {
  const c = containerWith('    graph TD\n      A --> B');
  await renderMermaidIn(c, 'light');
  assert.ok(c.querySelector('div.mermaid svg'));
  c.remove();
});

// ---- 纯函数边界 ----
await test('dedent：去掉公共前导空白', () => {
  assert.equal(dedent('    a\n    b\n  '), 'a\nb\n');
  assert.equal(dedent('  x\n    y'), 'x\n  y');
  assert.equal(dedent('plain'), 'plain');
  assert.equal(dedent(''), '');
  assert.equal(dedent('\n  a\n'), '\na\n');
});

await test('rekeySvg：重编号且不误伤其它 id', () => {
  const svg =
    'id="mmd-3" id="mmd-3-A-0" id="mmd-3_flowchart-v2-pointEnd" url(#mmd-3-A-0-0) ' +
    'url(#mmd-3_flowchart-v2-pointEnd) url(#mmd-3) #mmd-3{color:red} #mmd-3 .node{fill:#fff} ' +
    'id="mmd-30" id="mmd-3x" id="x-mmd-3" #mmd-30{color:blue}';
  const out = rekeySvg(svg, 'mmd-3', 'mmd-9');
  assert.equal(
    out,
    'id="mmd-9" id="mmd-9-A-0" id="mmd-9_flowchart-v2-pointEnd" url(#mmd-9-A-0-0) ' +
      'url(#mmd-9_flowchart-v2-pointEnd) url(#mmd-9) #mmd-9{color:red} #mmd-9 .node{fill:#fff} ' +
      'id="mmd-30" id="mmd-3x" id="x-mmd-3" #mmd-30{color:blue}',
  );
});

await test('cacheKey：主题隔离、同码同键', () => {
  assert.equal(cacheKey('x', 'light'), 'l\u0000x');
  assert.notEqual(cacheKey('x', 'light'), cacheKey('x', 'dark'));
  assert.equal(cacheKey('x', 'light'), cacheKey('x', 'light'));
  assert.notEqual(cacheKey('x', 'light'), cacheKey('y', 'light'));
});

await test('setCached：FIFO 上限 48，最旧淘汰', () => {
  cacheClear();
  for (let i = 0; i < 50; i += 1) {
    setCached(`k${i}`, { svg: 's', renderId: 'r' });
  }
  assert.equal(cacheSize(), 48, '超出上限后应保持 48');
  const keys = cacheKeys();
  assert.equal(keys.length, 48);
  assert.ok(!keys.includes('k0') && !keys.includes('k1'), '最旧的 k0/k1 应被淘汰');
  assert.ok(keys.includes('k49'), '最新的 k49 应保留');
  cacheClear();
});

// ==================== 汇总 ====================
console.log(`\n${passed} passed, ${failures.length} failed`);
for (const { name, error } of failures) {
  process.stderr.write(`FAIL: ${name}\n  ${error.message}\n`);
}
process.exit(failures.length === 0 ? 0 : 1);
