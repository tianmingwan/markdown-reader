/**
 * 渐进式渲染阈值与分块粒度（WebKitGTK 实测调参，见 PERF_FIX_PLAN.md）。
 *
 * 问题：政治 1145 题 → 2.4MB HTML / 41850 DOM 节点；`content.innerHTML = html`
 * 之后首次完整布局要 1.1~2.0s，期间主线程被独占，表现为「点开文档卡一下」。
 *
 * 方案：按标签边界切块、逐帧追加，每块追加后主动触发一次布局。
 *   - 首屏可见：1317ms → 200~235ms
 *   - 补齐过程中的滚动：36.7ms/帧、18 帧掉帧 → 11.9ms/帧、3 帧掉帧
 *   - 补齐完成后滚动：稳定 16ms/帧（60fps）
 * 每块追加后**必须**主动读一次几何，让布局在受控时机发生；
 * 否则布局会推迟到用户滚动的那一帧，滚动立刻掉到 100ms+/帧。
 *
 * 反例：不要用 `content-visibility: auto` 做分块 —— WebKit 在滚动路径上会反复
 * 重算 contain-intrinsic-size，滚动帧耗时从 16ms 恶化到 213ms。
 */
export const PROGRESSIVE_THRESHOLD = 400_000; // 超过约 400KB HTML 才分块（普通文档零影响）
export const CHUNK_TARGET = 64_000; // 每块目标字符数（实测 64KB 是首屏与总耗时的最优折中）

/** 在标签边界把 HTML 切成若干块（严格避开标签/属性/实体的中断） */
export function splitHtmlChunks(html: string, target = CHUNK_TARGET): string[] {
  if (html.length <= target) return [html];
  const chunks: string[] = [];
  const tagRe = /<[a-zA-Z!/][^>]*>/g;
  let start = 0; // 当前块起点（上一个安全边界）
  let lastSafe = 0; // 本块内最后一个可用作切点的标签起点
  let m: RegExpExecArray | null;
  let scanning = true;
  while (scanning && (m = tagRe.exec(html))) {
    const tagStart = m.index;
    if (tagStart - start >= target) {
      // 用上一块的末尾切点；若本块内还没有切点，就在当前标签前切
      const cut = lastSafe > start ? lastSafe : tagStart;
      chunks.push(html.slice(start, cut));
      start = cut;
      tagRe.lastIndex = start;
      lastSafe = start;
      continue;
    }
    lastSafe = tagStart;
    if (tagRe.lastIndex >= html.length) scanning = false;
  }
  if (start < html.length) chunks.push(html.slice(start));
  return chunks.filter((c) => c.length > 0);
}
