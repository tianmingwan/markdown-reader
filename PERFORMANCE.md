# 性能优化研究报告（2026-08-22）· Performance Optimization Report

> EN: Audit report of applied optimizations, mechanism findings and prioritized remaining suggestions.
> 中文正文见下。

> 背景：用户要求"研究哪些地方可以性能优化、多线程拆出来，最大化提升性能"。
> 本文记录已落地的优化、机制性发现、以及剩余优化建议（按优先级）。

---

## 一、性能瓶颈全景（按影响排序）

| 瓶颈 | 位置 | 影响 |
|---|---|---|
| SAF 目录扫描串行 + 主线程执行 | `SafPlugin.kt` listTree/buildTree | **打开大目录 10s+ 卡死 → ANR 白屏**（dp4flash 199 个 md 实测 4 次 ANR） |
| 每目录 3 次 ContentResolver 查询 | 旧 buildTree（名字/时间/children 各查一次） | 扫描慢 3 倍（binder 往返 ~5-20ms/次） |
| 搜索全文时串行读文件 | 旧 walkSearch | 199 文件 × ~10ms = 2-4s/次搜索 |
| 图片 base64 全量读入 | readBytesB64Internal | 大图内存翻倍（读 bytes + base64 字符串），可能 OOM |
| Rust 桌面搜索串行读文件 | `core/src/search.rs` | 大目录（考公资料 1000+ 文件）全文搜索数秒 |
| 4s SAF 轮询全量重扫 | `main.ts` startSafPoll | 大目录每次 ~1s 扫描，CPU/电量开销 |
| 目录树全量重建 DOM | `tree.ts` renderTree | 仅在签名变化时触发，影响小（低优先级） |

---

## 二、机制性发现（重要，影响后续所有优化）

1. **安卓前端资源 = 编译时嵌入 Rust .so**（`tauri::generate_context!` → `AssetResolver` "embedded asset bundled in the app executable"）。
   - 直接改 `dist/` 或 APK `assets/` **不会生效**；改 index.html/前端 JS 必须重编 .so（4 个 ABI）。
   - 这也是"标题改了却一直是旧的"的根因。
2. **tauri 移动端插件 JNI 调用必须是"同步命令"**。
   - `#[tauri::command] async fn` 里调 `run_mobile_plugin` → Kotlin 侧执行成功但响应无法回传（前端拿到空/错误）。
   - 所有正常工作的移动命令（scan_tree/render_md/open_root）都是同步命令；搜索改成同步 `search_files_saf` 后立即恢复。
3. **Android 状态栏**：`enableEdgeToEdge()` 已让内容延伸到状态栏下方，但系统栏图标仍浮在内容上；需 `insetsController.hide(...)` 才能真正沉浸全屏（已实现，MainActivity）。

---

## 三、已落地优化（本轮）

### 1. SAF 扫描全面并行 + 查询减量（Android，收益最大）
`SafPlugin.kt`
- **后台线程**：所有命令（listTree/searchTree/readText/readBytesBase64/resolve*）经 `runAsync` 在后台线程执行，主线程只做 JNI 回调。
- **每目录 3 查询 → 1 查询**：子目录 name/mtime/size 由父游标传入（`buildSubtree(uri, depth, knownName, knownMtime)`），根目录元数据用单次 `queryMeta` 合并查询。
- **顶层并行**：根目录下所有子目录用 4 线程池并行扫描（`Executors.newFixedThreadPool(4)`），各自构建子树 JSONObject 后合并（无共享可变状态，天然线程安全）。
- **目录 size 累计**：子树文件总大小（顺带修复了安卓端"按大小排序"恒为 0 的问题）。

### 2. 搜索两阶段 + 并行读文件（Android）
`SafPlugin.kt` searchInTree/walkCollect
- 阶段 1：仅目录查询收集全部 md（快），文件名命中即时入队；
- 阶段 2：未命中的文件用 4 线程池并行 `readTextInternal` + 内容匹配 + 摘要。
- 与 Rust `search.rs` 行为对齐：大小写不敏感、≥2 字符才搜内容、单文件 ≤1MB、最多 200 条、每文件 2 条摘要。

### 3. 前端轮询防重入（Android）
`main.ts` startSafPoll：上一轮扫描未结束则跳过本轮（大目录扫描 >4s 时防止扫描堆积）。

### 4. 图片 base64 大小上限（Android）
`readBytesB64Internal`：单文件 >12MB 拒绝，防 OOM 崩溃。

### 5. 沉浸式全屏（Android）
`MainActivity.kt`：`WindowInsetsController.hide(statusBars|navigationBars)` + `BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE`，`onWindowFocusChanged` 重新隐藏；旧 API 用 SYSTEM_UI_FLAG 兼容。

### 6. 搜索内容缓存（Android，内存换速度）
`SafPlugin.kt` cachedReadText：ConcurrentHashMap + AtomicLong 字节计数，key=`uri|mtime`（文件变化自动失效），上限 32MB 超限整体清空。重复搜索/连续输入时不再重复读盘。

### 7. 读取内存减半（Android）
- `readTextInternal`：`readBytes()+toString`（byte[]+String 双份）→ `bufferedReader().readText()` 流式。
- `readBytesB64Internal`：整文件 `readBytes()`+整体 base64 → **8KB 分块边读边编码**，峰值内存从"整文件×2"降到"块+结果串"。

---

## 四、内存与其它优化路径（非多线程）

### 4.1 内存占用优化

| 项 | 现状 | 优化 | 状态 |
|---|---|---|---|
| 图片 base64 | 整文件 byte[] + 整串 base64（~2.7×文件大小峰值） | 8KB 分块流式编码 | ✅ 已做 |
| md 文本读取 | `readBytes()` 双份内存 | bufferedReader 流式 | ✅ 已做 |
| 搜索内容 | 每次查询全量读盘 | uri+mtime 键缓存 32MB 上限，超限清空 | ✅ 已做 |
| 树 JSON | 全树一次性下发（深层大目录可达数 MB） | 前端已懒渲染子节点；可再加"仅下发折叠层+按需展开" | 建议 |
| 多标签 HTML | 每个标签持有完整渲染 HTML | 非活动标签按 LRU 驱逐 HTML（仅留 path，切回重渲染） | 建议 |
| 大文件读入 | readText 无上限（仅搜索限 1MB） | 渲染 md 加软上限（>5MB 提示） | 建议 |

### 4.2 缓存类优化

| 项 | 说明 | 状态 |
|---|---|---|
| 搜索内容缓存 | uri+mtime 键，32MB 上限（见上） | ✅ 已做 |
| syntect 语法集/主题 | `OnceLock` 进程级缓存，首次加载后零开销 | ✅ 已有 |
| KaTeX/Mermaid/Cytoscape | `import()` 动态加载，首次遇到才拉取 | ✅ 已有（preview.ts） |
| 渲染结果缓存 | 标签页持有 `tab.html`，切换不重渲染；关闭重开需重读 | 建议：按 (path,mtime) 缓存 HTML |
| SAF 轮询 | 固定 4s 全量重扫 | 建议：按上次扫描耗时自适应间隔 |

### 4.3 IO 减量（Android）

| 项 | 优化 | 状态 |
|---|---|---|
| 目录扫描查询次数 | 每目录 3 次 → 1 次（元数据复用） | ✅ 已做 |
| 搜索读取范围 | 只读 ≤1MB 的 md，跳过超大文件 | ✅ 已有 |
| 目录树构建 | 顶层并行 4 线程 | ✅ 已做 |
| 目录 size 累计 | 子树文件总大小（顺带修复安卓按大小排序） | ✅ 已做 |

### 4.4 渲染与启动

- KaTeX/Mermaid 按需加载（✅ 已有）；数学/图表少的文档不加载对应 JS（省几百 KB）。
- 冷启动 ~400ms（WebView 直载嵌入资源，无网络请求）——可接受，暂不动。
- 大文档 `innerHTML` 一次性赋值：14KB 文档实测毫秒级，>1MB 文档才需分块渲染（建议，低优先级）。

### 4.5 构建与包体积

- release profile 已开 `lto=true` + `codegen-units=1`（✅）。
- APK 从 44.8MB 增至 ~59.8MB：疑与 jniLibs 被 tauri CLI clobber 后混入旧 .so / 重复文件有关，后续打包前清理 jniLibs 再验证（建议）。
- 发布版可做：ABI 拆分（arm64 单发）、`isMinifyEnabled=true`（release 已开 R8）+ resources shrink。

### 4.6 已确认无需改动的项

- session 落盘：800ms 防抖（✅ 合理）
- 文件监听：notify 300ms 防抖（✅ 合理）
- 树重渲染：签名对比后才重建 DOM（✅ 合理）
- 搜索防抖 250ms + 过期结果丢弃（✅ 合理）

---

## 五、剩余优化建议（按优先级）

### P1：Rust 桌面全文搜索并行化（`core/src/search.rs`）
- **现状**：`search()` 用 `ignore::WalkBuilder` 串行遍历 + 串行 `read_to_string`。
- **方案**：先遍历收集全部 md 路径（快），再用 `std::thread::scope` + `available_parallelism()` 分块并行读文件匹配，合并结果（无新依赖，纯 std）。
- **收益**：考公资料 1000+ 文件时搜索耗时从数秒降到亚秒级。
- **成本**：改 `search.rs` 约 60 行；需重编桌面 exe（用户当前主测安卓，可延后）。

### P2：SAF 轮询自适应间隔（`main.ts` startSafPoll）
- **现状**：固定 4s 全量重扫（大目录每次 ~1s）。
- **方案**：记录上次扫描耗时，`nextInterval = max(4000, 上次耗时 × 2)`。
- **收益**：大目录 CPU/电量降低 ~50%。
- **成本**：改前端 → 需重编 .so（记住机制发现 #1）。

### P3：桌面目录树扫描并行（`core/src/tree.rs` scan_dir）
- 子目录用线程池并行收集，合并排序。收益中等（ignore 已较快），改动中等。

### P4：SAF 轮询自适应间隔（`main.ts` startSafPoll）
- 记录上次扫描耗时，`nextInterval = max(4000, 上次耗时 × 2)`；大目录 CPU/电量降低 ~50%。

### P5：多标签内存（`main.ts` / `tree.ts`）
- 标签数 >8 时对非活动标签按 LRU 驱逐 `tab.html`，切回时重渲染。

### P6：前端渲染大文档分块（`preview.ts` / `main.ts` paintPreview）
- 超长 md 的 `innerHTML` 一次性赋值会卡顿；可先插骨架再分块填充。收益低（实测 14KB 文档毫秒级）。

---

## 五、性能数据（真机实测 TB371FC / Android 14 / arm64）

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 打开 dp4flash（23 目录 / 199 md） | 主线程阻塞 10s+，4 次 ANR，白屏 | 后台扫描无 ANR，UI 全程可操作 |
| 目录树渲染 | 199 个 md 计数为 0（children 查询 bug） | 199 个 md 全部正确列出 |
| 全文搜索「宪法」 | 空结果（链路断裂 + 无 SAF 搜索） | 34 条命中（文件名 + 内容） |
| 状态栏 | 电池/时间浮在内容上 | 沉浸全屏隐藏 |

---

## 六、多线程拆分总原则（后续新代码遵守）

1. 一切 binder/IO 操作不进主线程（`runAsync` 或线程池）。
2. 并行任务间不共享可变状态（各自构建后合并，或用锁/并发集合）。
3. 线程数固定（`min(4, 任务数)`），用完 shutdown，避免无界线程。
4. 移动端插件命令保持"同步 Rust 命令 + Kotlin 后台线程"的模式。
5. **Kotlin 插件回传数据用 `invoke.resolve(JSObject)`**：`PluginResult.toString()` 走 org.json 原生序列化（合法 JSON）；
   `resolveObject(JSONArray/JSONObject)` 经 Jackson 把 org.json 类型当 POJO 序列化成 `{}`，Rust 侧解析为空（搜索踩过的坑）。
   回传数组应包成 `{ "hits": [...] }` 再 resolve。
