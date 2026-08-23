// CDP 求值辅助：通过 WebView 远程调试端口执行 JS 表达式并打印结果
// 用法：CDP_PORT=9223 node tests/cdp.mjs "<js expression>"  （表达式需返回 JSON 可序列化值）
const expr = process.argv[2];
if (!expr) {
  console.error('usage: CDP_PORT=<port> node tests/cdp.mjs "<expression>"');
  process.exit(1);
}
const PORT = process.env.CDP_PORT ?? '9222';
const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
const page = list.find((t) => t.type === 'page');
if (!page) {
  console.error('no page target');
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
const send = (method, params) =>
  new Promise((res) => {
    const mid = ++seq;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
const r = await send('Runtime.evaluate', {
  expression: expr,
  returnByValue: true,
  awaitPromise: true,
});
if (r.result?.exceptionDetails) {
  console.error('EVAL ERROR:', JSON.stringify(r.result.exceptionDetails, null, 2));
  process.exit(2);
}
console.log(JSON.stringify(r.result?.result?.value ?? r.result, null, 2));
ws.close();
