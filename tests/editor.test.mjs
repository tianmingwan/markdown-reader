/**
 * DOM-to-Markdown 序列化器单元测试（基于 jsdom）
 * 运行：node tests/editor.test.mjs
 */
import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';

const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="preview-content"></div></body></html>');
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.Node = window.Node;
globalThis.HTMLElement = window.HTMLElement;

const { serializeNode, cleanMarkdown } = await import('../src/editor.ts');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('标题转换', () => {
  const div = document.createElement('div');
  div.innerHTML = '<h1>主标题</h1><h2>副标题</h2>';
  const md = cleanMarkdown(serializeNode(div));
  assert.equal(md, '# 主标题\n\n## 副标题');
});

test('加粗与斜体转换', () => {
  const div = document.createElement('div');
  div.innerHTML = '<p>这里是<strong>加粗</strong>和<em>斜体</em>文字</p>';
  const md = serializeNode(div).trim();
  assert.equal(md, '这里是**加粗**和*斜体*文字');
});

test('颜色 span 转换', () => {
  const div = document.createElement('div');
  div.innerHTML = '<p>普通文字<span style="color: #e53935">红色强调</span>结尾</p>';
  const md = serializeNode(div).trim();
  assert.equal(md, '普通文字<span style="color: #e53935">红色强调</span>结尾');
});

test('颜色与加粗组合转换', () => {
  const div = document.createElement('div');
  div.innerHTML = '<p><span style="color: rgb(229, 57, 53)"><strong>红粗文本</strong></span></p>';
  const md = serializeNode(div).trim();
  assert.equal(md, '<span style="color: #e53935">**红粗文本**</span>');
});

test('无序与任务列表转换', () => {
  const div = document.createElement('div');
  div.innerHTML = '<ul><li>普通项</li><li><input type="checkbox" checked />已办事项</li><li><input type="checkbox" />待办事项</li></ul>';
  const md = serializeNode(div).trim();
  assert.equal(md, '- 普通项\n- [x] 已办事项\n- [ ] 待办事项');
});

test('代码块保留语言', () => {
  const div = document.createElement('div');
  div.innerHTML = '<pre class="code-block" data-lang="typescript"><code>const x: number = 42;</code></pre>';
  const md = serializeNode(div).trim();
  assert.equal(md, '```typescript\nconst x: number = 42;\n```');
});

test('Mermaid 图表保留原始代码', () => {
  const div = document.createElement('div');
  div.innerHTML = '<div class="mermaid" data-raw="graph TD;\n  A-->B;">svg-rendered</div>';
  const md = serializeNode(div).trim();
  assert.equal(md, '```mermaid\ngraph TD;\n  A-->B;\n```');
});

test('表格转换', () => {
  const div = document.createElement('div');
  div.innerHTML = '<table><thead><tr><th>姓名</th><th>年龄</th></tr></thead><tbody><tr><td>张三</td><td>20</td></tr></tbody></table>';
  const md = serializeNode(div).trim();
  assert.equal(md, '| 姓名 | 年龄 |\n| --- | --- |\n| 张三 | 20 |');
});

test('自动过滤手写画布 ink-canvas', () => {
  const div = document.createElement('div');
  div.innerHTML = '<p>正常正文</p><canvas id="ink-canvas" class="ink-canvas"></canvas>';
  const md = serializeNode(div).trim();
  assert.equal(md, '正常正文');
});

// 运行测试
let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log(`  ✓ ${t.name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${t.name}`);
    console.error(err);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
