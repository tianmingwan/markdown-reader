/**
 * 渐进式分块渲染的 HTML 切块器单元测试。
 *
 * 运行：npm test（或 node tests/chunker.test.mjs）
 * 重点：切块必须**无损**（join 后与原串逐字节相同）且**不截断标签**——
 * 这是大文档渲染正确性的底线，一旦切坏就是整篇排版错乱。
 */
import assert from 'node:assert/strict';

const { splitHtmlChunks } = await import('../src/chunker.ts');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

/** 真实文档形态：1145 个题目块，每块含 details/summary/blockquote/ul/code */
function makeDoc(questions = 200) {
  const parts = [
    '<h1>【政治】全部错题集锦汇总</h1>',
    '<blockquote><p>包含全部 <strong>' + questions + '</strong> 道错题。</p></blockquote>',
    '<hr />',
  ];
  for (let i = 1; i <= questions; i++) {
    parts.push(
      `<h3>第 ${i} 题 【单选题】</h3>`,
      '<blockquote><p><strong>考点归属</strong>：<code>政治 &gt; 马克思主义哲学</code></p></blockquote>',
      '<p><strong>【题干】</strong>“信息茧房”描述了个体在海量信息中的现象。（&nbsp;&nbsp;&nbsp;）</p>',
      '<p><strong>【选项】</strong></p>',
      '<ul><li><strong>A.</strong> 天行有常</li><li><strong>B.</strong> 心外无物</li></ul>',
      '<details><summary><b>💡 点击查看【正确答案】与【名师解析】</b></summary>',
      `<ul><li><strong>【正确答案】</strong>：<code>${i % 4 === 0 ? 'A' : 'B'}</code></li></ul>`,
      '<p>本题考查马克思主义哲学。A项正确，荀子《天论》：“天行有常，不为尧存。”</p>',
      '</details>',
      '---',
    );
  }
  return parts.join('\n');
}

test('小文档不切块', () => {
  const html = '<p>hello</p>';
  assert.deepEqual(splitHtmlChunks(html, 1000), [html]);
});

test('切块后拼接与原串逐字节相同', () => {
  const html = makeDoc(200);
  for (const target of [500, 2000, 8000, 64000]) {
    const chunks = splitHtmlChunks(html, target);
    assert.equal(chunks.join(''), html, `target=${target} 拼接不一致`);
    if (html.length > target) assert.ok(chunks.length > 1, `target=${target} 应产生多块`);
  }
});

test('每块都不以半个标签结尾', () => {
  const html = makeDoc(200);
  const chunks = splitHtmlChunks(html, 3000);
  for (const [i, c] of chunks.entries()) {
    const lastLt = c.lastIndexOf('<');
    const lastGt = c.lastIndexOf('>');
    // 块尾若出现 '<' 却没有对应的 '>'，说明标签被切断
    assert.ok(lastLt < lastGt, `第 ${i} 块标签被截断：...${JSON.stringify(c.slice(-80))}`);
  }
});

test('不切断 HTML 实体与属性', () => {
  const html = '<p title="a>b<c">x &amp; y &lt; z</p>'.repeat(500);
  const chunks = splitHtmlChunks(html, 1000);
  assert.equal(chunks.join(''), html);
  for (const c of chunks) {
    assert.ok(!/&[a-zA-Z]*$/.test(c), '实体被切断');
    assert.ok(!/<[a-zA-Z][^>]*$/.test(c), '标签被切断');
  }
});

test('每块长度不超过「目标 + 单个标签」', () => {
  const html = makeDoc(200);
  const target = 4000;
  const chunks = splitHtmlChunks(html, target);
  // 切点选在上一个标签起点，因此单块最多是 target + 一个标签的长度
  for (const [i, c] of chunks.entries()) {
    assert.ok(c.length <= target + 200, `第 ${i} 块长度 ${c.length} 超出预期`);
  }
});

test('切块结果可被 jsdom 解析且结构等价', async () => {
  const { JSDOM } = await import('jsdom');
  const html = makeDoc(60);
  const whole = new JSDOM(`<body>${html}</body>`).window.document.body;
  const chunks = splitHtmlChunks(html, 2000);
  const rebuilt = new JSDOM(`<body>${chunks.join('')}</body>`).window.document.body;
  assert.equal(rebuilt.innerHTML, whole.innerHTML);
  assert.equal(rebuilt.querySelectorAll('details').length, 60);
  assert.equal(rebuilt.querySelectorAll('h3').length, 60);
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}
console.log(`\nchunker: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed === 0 ? 0 : 1);
