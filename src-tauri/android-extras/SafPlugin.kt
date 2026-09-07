// 安卓 SAF 插件（新版 tauri-android API：@TauriPlugin + @Command + @ActivityCallback）
// 构建安卓版时拷入：src-tauri\gen\android\app\src\main\java\com\chensdong\mdreader\SafPlugin.kt
// 注意：类全名必须为 com.chensdong.mdreader.SafPlugin（与 Rust 侧 register_android_plugin("com.chensdong.mdreader", "SafPlugin") 一致），
// 新版 tauri 用 register_android_plugin 自动实例化插件，无需 MainActivity 注册。
// 性能设计：
// - 所有耗时 SAF 查询/文件读取都在后台线程执行（tauri 插件命令默认跑主线程，大目录扫描会 ANR 白屏）
// - buildTree：每目录仅 1 次 children 查询（子目录元数据由父游标传入，不再重复查询）；
//   顶层子目录用固定线程池并行扫描
// - searchTree：两阶段——先遍历目录收集文件名（快），再并行读文件内容匹配
package com.chensdong.mdreader

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Callable
import java.util.concurrent.Executors

@InvokeArg
class UriArgs {
    var uri: String = ""
}

@InvokeArg
class CtxArgs {
    var ctx: String = ""
    var rel: String = ""
}

@InvokeArg
class SearchArgs {
    var uri: String = ""
    var query: String = ""
}

@InvokeArg
class WriteArgs {
    var uri: String = ""
    var text: String = ""
}

/** 待内容匹配的文件（搜索阶段 2 用） */
private data class PendingFile(val uri: String, val name: String, val mtime: Long)

@TauriPlugin
class SafPlugin(private val activity: Activity) : Plugin(activity) {

    companion object {
        private const val MAX_DEPTH = 12
        private const val MAX_READ_BYTES = 1024L * 1024L // 搜索内容匹配单个文件最多读 1MB
        private const val MAX_FILE_BYTES = 12L * 1024L * 1024L // 图片 base64 单文件上限（防 OOM）
        private const val MAX_HITS = 200
        private const val MAX_SNIPPETS = 2
        private const val SNIPPET_LEN = 80
        private const val PARALLEL = 4 // 并行扫描/读文件线程数
        private const val TEXT_CACHE_MAX_BYTES = 32L * 1024L * 1024L // 搜索内容缓存上限
    }

    /** 搜索内容缓存（key=uri|mtime，mtime 变化自动失效；超限整体清空，简单可控） */
    private val textCache = java.util.concurrent.ConcurrentHashMap<String, String>()
    private val textCacheBytes = java.util.concurrent.atomic.AtomicLong()

    /** 在后台线程执行耗时操作；resolve/reject 为 JNI 调用，可从任意线程安全回调 */
    private fun runAsync(invoke: Invoke, block: () -> Unit) {
        Thread {
            try {
                block()
            } catch (e: Exception) {
                try {
                    invoke.reject(e.message ?: "操作失败")
                } catch (_: Exception) {
                    // 忽略二次异常
                }
            }
        }.start()
    }

    // —— 目录树选择（ACTION_OPEN_DOCUMENT_TREE + 持久化授权）——
    @Command
    fun pickFolder(invoke: Invoke) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION
                    or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
            )
        }
        startActivityForResult(invoke, intent, "pickFolderResult")
    }

    @ActivityCallback
    fun pickFolderResult(invoke: Invoke, result: ActivityResult) {
        val data = result.data
        if (result.resultCode != Activity.RESULT_OK || data?.data == null) {
            invoke.reject("cancelled")
            return
        }
        val uri = data.data!!
        try {
            val flags = data.flags and
                (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            activity.contentResolver.takePersistableUriPermission(uri, flags)
        } catch (_: Exception) {
            // 持久化授权失败不致命，本次会话仍可用
        }
        val obj = JSObject()
        obj.put("uri", uri.toString())
        obj.put("name", queryDisplayName(uri) ?: uri.lastPathSegment ?: "文档库")
        invoke.resolve(obj)
    }

    // —— 递归列出目录树（后台线程 + 顶层并行；返回与 tree.rs 同构的 JSON）——
    @Command
    fun listTree(invoke: Invoke) {
        val args = invoke.parseArgs(UriArgs::class.java)
        val uri = try { Uri.parse(args.uri) } catch (_: Exception) { null }
        if (uri == null) {
            invoke.reject("invalid uri")
            return
        }
        runAsync(invoke) {
            val tree = buildTree(uri)
            val root = JSObject()
            root.put("name", tree.optString("name", "文档库"))
            root.put("mdCount", tree.optLong("mdCount", 0))
            root.put("children", tree.optJSONArray("children") ?: JSONArray())
            root.put("path", uri.toString())
            invoke.resolve(root)
        }
    }

    // —— 全文搜索（文件名 + md 内容；后台线程；与 core/src/search.rs 行为对齐）——
    @Command
    fun searchTree(invoke: Invoke) {
        val args = invoke.parseArgs(SearchArgs::class.java)
        val uri = try { Uri.parse(args.uri) } catch (_: Exception) { null }
        if (uri == null) {
            invoke.reject("invalid uri")
            return
        }
        runAsync(invoke) {
            val hits = searchInTree(uri, args.query)
            // 注意：必须用 resolve(JSObject) 走 org.json 原生 toString 序列化；
            // resolveObject(JSONArray) 会经 Jackson 把 JSONArray 当 POJO 序列化成 {}，Rust 侧解析为空
            val wrapper = JSObject()
            wrapper.put("hits", hits)
            invoke.resolve(wrapper)
        }
    }

    /** 构建“某目录的 children”查询 Uri（树根与子目录统一处理） */
    private fun childrenUriOf(dirUri: Uri): Uri {
        val uriStr = dirUri.toString()
        val treePart = uriStr.substringBeforeLast("/document/")
        val treeUri = Uri.parse(treePart)
        val docId = if (uriStr.contains("/document/")) {
            DocumentsContract.getDocumentId(dirUri)
        } else {
            DocumentsContract.getTreeDocumentId(treeUri)
        }
        return DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, docId)
    }

    /** 遍历某目录的子条目（每目录仅 1 次查询；单目录失败静默跳过） */
    private inline fun forEachChild(dirUri: Uri, body: (docId: String, name: String, mime: String, mtime: Long, size: Long) -> Unit) {
        val childrenUri = childrenUriOf(dirUri)
        try {
            activity.contentResolver.query(childrenUri, null, null, null, null)?.use { c ->
                val idCol = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
                val nameCol = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
                val mimeCol = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_MIME_TYPE)
                val mtimeIdx = c.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED)
                val sizeIdx = c.getColumnIndex(DocumentsContract.Document.COLUMN_SIZE)
                while (c.moveToNext()) {
                    val docId = c.getString(idCol)
                    val name = c.getString(nameCol) ?: continue
                    val mime = c.getString(mimeCol) ?: ""
                    val mtime = if (mtimeIdx >= 0 && !c.isNull(mtimeIdx)) c.getLong(mtimeIdx) else 0L
                    val size = if (sizeIdx >= 0 && !c.isNull(sizeIdx)) c.getLong(sizeIdx) else 0L
                    body(docId, name, mime, mtime, size)
                }
            }
        } catch (_: Exception) {
            // 单个目录查询失败跳过
        }
    }

    private fun isMd(name: String): Boolean {
        val lower = name.lowercase()
        return lower.endsWith(".md") || lower.endsWith(".markdown")
    }

    // ==================== 目录树 ====================

    /** 根目录：一次元数据查询 + children 查询，顶层子目录并行扫描 */
    private fun buildTree(rootUri: Uri): JSONObject {
        val meta = queryMeta(rootUri)
        val node = JSONObject()
        node.put("name", meta.first ?: "?")
        node.put("path", rootUri.toString())
        node.put("kind", "dir")
        node.put("size", 0)
        node.put("mtime", meta.second)
        val children = JSONArray()
        var mdCount = 0L
        var totalSize = 0L

        data class TopChild(val uri: Uri, val name: String, val mtime: Long)
        val dirs = ArrayList<TopChild>()
        forEachChild(rootUri) { docId, name, mime, mtime, size ->
            val docUri = DocumentsContract.buildDocumentUriUsingTree(rootUri, docId)
            if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                dirs.add(TopChild(docUri, name, mtime))
            } else if (isMd(name)) {
                mdCount += 1
                totalSize += size
            }
        }

        if (dirs.isNotEmpty()) {
            val pool = Executors.newFixedThreadPool(minOf(PARALLEL, dirs.size))
            try {
                val futures = dirs.map { d ->
                    pool.submit(Callable<JSONObject> { buildSubtree(d.uri, 1, d.name, d.mtime) })
                }
                for (f in futures) {
                    val sub = f.get() // 等待；各线程独立 JSONObject，无共享可变状态
                    mdCount += sub.optLong("mdCount", 0)
                    totalSize += sub.optLong("size", 0)
                    children.put(sub)
                }
            } finally {
                pool.shutdown()
            }
        }

        node.put("size", totalSize)
        node.put("children", children)
        node.put("mdCount", mdCount)
        return node
    }

    /** 子树串行递归；name/mtime 由父游标传入，不再重复查询目录元数据 */
    private fun buildSubtree(uri: Uri, depth: Int, knownName: String, knownMtime: Long): JSONObject {
        val node = JSONObject()
        node.put("name", knownName)
        node.put("path", uri.toString())
        node.put("kind", "dir")
        node.put("size", 0)
        node.put("mtime", knownMtime)
        val children = JSONArray()
        var mdCount = 0L
        var totalSize = 0L
        if (depth < MAX_DEPTH) {
            forEachChild(uri) { docId, name, mime, mtime, size ->
                val docUri = DocumentsContract.buildDocumentUriUsingTree(uri, docId)
                if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                    val sub = buildSubtree(docUri, depth + 1, name, mtime)
                    mdCount += sub.optLong("mdCount", 0)
                    totalSize += sub.optLong("size", 0)
                    children.put(sub)
                } else if (isMd(name)) {
                    mdCount += 1
                    totalSize += size
                    val child = JSONObject()
                    child.put("name", name)
                    child.put("mtime", mtime)
                    child.put("size", size)
                    child.put("kind", "file")
                    child.put("path", docUri.toString())
                    children.put(child)
                }
            }
        }
        node.put("size", totalSize)
        node.put("children", children)
        node.put("mdCount", mdCount)
        return node
    }

    /** 一次查询取目录名 + 修改时间 */
    private fun queryMeta(uri: Uri): Pair<String?, Long> {
        return try {
            var name: String? = null
            var mtime = 0L
            activity.contentResolver.query(
                uri,
                arrayOf(
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_LAST_MODIFIED
                ),
                null,
                null,
                null
            )?.use { c ->
                if (c.moveToFirst()) {
                    name = c.getString(0)
                    val mIdx = c.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED)
                    if (mIdx >= 0 && !c.isNull(mIdx)) mtime = c.getLong(mIdx)
                }
            }
            name to mtime
        } catch (_: Exception) {
            null to 0L
        }
    }

    // ==================== 全文搜索 ====================

    /**
     * 两阶段搜索：
     * 1) 遍历目录收集全部 md（仅目录查询，快），文件名命中即时入队；
     * 2) 未命中的文件并行读内容匹配（线程池）。
     */
    private fun searchInTree(rootUri: Uri, query: String): JSONArray {
        val nameHits = JSONArray()
        val pending = ArrayList<PendingFile>()
        val q = query.trim().lowercase()
        if (q.isEmpty()) return nameHits

        walkCollect(rootUri, q, nameHits, pending)

        if (q.length >= 2 && pending.isNotEmpty() && nameHits.length() < MAX_HITS) {
            val pool = Executors.newFixedThreadPool(minOf(PARALLEL, pending.size))
            try {
                val futures = pending.map { pf ->
                    pool.submit(Callable<JSONObject?> {
                        val text = cachedReadText(pf.uri, pf.mtime) ?: return@Callable null
                        val snippets = JSONArray()
                        val lowerText = text.lowercase()
                        var from = 0
                        while (snippets.length() < MAX_SNIPPETS) {
                            val idx = lowerText.indexOf(q, from)
                            if (idx < 0) break
                            snippets.put(snippetAround(text, idx, q.length))
                            from = idx + q.length
                        }
                        if (snippets.length() > 0) hit(pf.name, pf.uri, "content", snippets) else null
                    })
                }
                for (f in futures) {
                    val h = f.get()
                    if (h != null) nameHits.put(h)
                    if (nameHits.length() >= MAX_HITS) break
                }
            } finally {
                pool.shutdown()
            }
        }
        return nameHits
    }

    private fun walkCollect(dirUri: Uri, q: String, nameHits: JSONArray, pending: ArrayList<PendingFile>) {
        forEachChild(dirUri) { docId, name, mime, mtime, size ->
            val docUri = DocumentsContract.buildDocumentUriUsingTree(dirUri, docId)
            if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                if (nameHits.length() < MAX_HITS) walkCollect(docUri, q, nameHits, pending)
                return@forEachChild
            }
            if (!isMd(name)) return@forEachChild
            val lower = name.lowercase()
            if (lower.contains(q)) {
                if (nameHits.length() < MAX_HITS) nameHits.put(hit(name, docUri.toString(), "name", JSONArray()))
                return@forEachChild
            }
            if (q.length >= 2 && size <= MAX_READ_BYTES && pending.size < MAX_HITS) {
                pending.add(PendingFile(docUri.toString(), name, mtime))
            }
        }
    }

    /** 带缓存的内容读取（key 含 mtime，文件变化自动失效；超限清空） */
    private fun cachedReadText(uri: String, mtime: Long): String? {
        val key = "$uri|$mtime"
        textCache[key]?.let { return it }
        val text = readTextInternal(uri) ?: return null
        if (textCache.putIfAbsent(key, text) == null) {
            if (textCacheBytes.addAndGet(text.length.toLong()) > TEXT_CACHE_MAX_BYTES) {
                textCache.clear()
                textCacheBytes.set(0)
            }
        }
        return text
    }

    private fun hit(name: String, path: String, matchedBy: String, snippets: JSONArray): JSONObject {
        val h = JSONObject()
        h.put("name", name)
        h.put("path", path)
        h.put("matchedBy", matchedBy)
        h.put("snippets", snippets)
        return h
    }

    /** 从匹配位置周围截取摘要（UTF-16 代理对安全） */
    private fun snippetAround(text: String, matchIdx: Int, matchLen: Int): String {
        fun boundary(idx: Int): Int {
            var i = idx.coerceIn(0, text.length)
            if (i < text.length && Character.isLowSurrogate(text[i])) i -= 1
            return i
        }
        val start = boundary(matchIdx - SNIPPET_LEN / 2)
        val end = boundary((matchIdx + matchLen + SNIPPET_LEN / 2 + 10).coerceAtMost(text.length))
        val sb = StringBuilder()
        if (start > 0) sb.append('…')
        sb.append(text.substring(start, end).trim().take(SNIPPET_LEN))
        if (end < text.length) sb.append('…')
        return sb.toString()
    }

    // ==================== 读写命令 ====================

    // —— 按文档 Uri 读文本（后台线程）——
    @Command
    fun readText(invoke: Invoke) {
        val args = invoke.parseArgs(UriArgs::class.java)
        runAsync(invoke) {
            val result = readTextInternal(args.uri)
            if (result == null) invoke.reject("read failed")
            else invoke.resolveObject(result)
        }
    }

    // —— 按文档 Uri 写文本（后台线程）——
    @Command
    fun writeText(invoke: Invoke) {
        val args = invoke.parseArgs(WriteArgs::class.java)
        runAsync(invoke) {
            val uri = try { Uri.parse(args.uri) } catch (_: Exception) { null }
            if (uri == null) {
                invoke.reject("invalid uri")
                return@runAsync
            }
            val ok = try {
                activity.contentResolver.openOutputStream(uri, "wt")?.use { out ->
                    out.bufferedWriter(Charsets.UTF_8).use { it.write(args.text) }
                    true
                } ?: false
            } catch (e: Exception) {
                invoke.reject(e.message ?: "write failed")
                return@runAsync
            }
            if (ok) {
                // 写成功后清除搜索文本缓存中对应的条目
                textCache.keys().toList().filter { it.startsWith("${args.uri}|") }.forEach { textCache.remove(it) }
                invoke.resolve()
            } else {
                invoke.reject("write failed")
            }
        }
    }

    // —— 按文档 Uri 读二进制（base64；后台线程；超 12MB 拒绝防 OOM）——
    @Command
    fun readBytesBase64(invoke: Invoke) {
        val args = invoke.parseArgs(UriArgs::class.java)
        runAsync(invoke) {
            val obj = readBytesB64Internal(args.uri)
            if (obj == null) invoke.reject("read failed")
            else invoke.resolve(obj)
        }
    }

    // —— 解析相对路径（相对 md 文档所在目录）→ 文档 Uri（后台线程）——
    @Command
    fun resolveRelative(invoke: Invoke) {
        val args = invoke.parseArgs(CtxArgs::class.java)
        runAsync(invoke) {
            val doc = resolveInTree(args.ctx, args.rel)
            if (doc == null) invoke.reject("not found")
            else invoke.resolveObject(doc.toString())
        }
    }

    // —— 解析相对路径并读二进制（mdimg 相对图片；后台线程）——
    @Command
    fun resolveBytesBase64(invoke: Invoke) {
        val args = invoke.parseArgs(CtxArgs::class.java)
        runAsync(invoke) {
            val doc = resolveInTree(args.ctx, args.rel)
            if (doc == null) {
                invoke.reject("not found")
                return@runAsync
            }
            val obj = readBytesB64Internal(doc.toString())
            if (obj == null) invoke.reject("read failed")
            else invoke.resolve(obj)
        }
    }

    // ==================== 内部工具 ====================

    private fun queryDisplayName(uri: Uri): String? {
        return try {
            activity.contentResolver.query(
                uri,
                arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME),
                null,
                null,
                null
            )?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
        } catch (_: Exception) {
            null
        }
    }

    private fun queryLastModified(uri: Uri): Long {
        return try {
            activity.contentResolver.query(
                uri,
                arrayOf(DocumentsContract.Document.COLUMN_LAST_MODIFIED),
                null,
                null,
                null
            )?.use { c ->
                if (c.moveToFirst() && !c.isNull(0)) c.getLong(0) else 0L
            } ?: 0L
        } catch (_: Exception) {
            0L
        }
    }

    private fun readTextInternal(uriStr: String): String? {
        val uri = Uri.parse(uriStr)
        return try {
            // 流式读取：避免 readBytes() 的 byte[] + String 双倍内存
            activity.contentResolver.openInputStream(uri)?.use { input ->
                input.bufferedReader(Charsets.UTF_8).use { it.readText() }
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun readBytesB64Internal(uriStr: String): JSObject? {
        val uri = Uri.parse(uriStr)
        // 分块 base64：8KB 一块，峰值内存 = 块 + 结果串，而非整文件 byte[] + 结果串
        val sb = StringBuilder()
        var total = 0L
        val buf = ByteArray(8192)
        val ok = try {
            activity.contentResolver.openInputStream(uri)?.use { input ->
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    total += n
                    if (total > MAX_FILE_BYTES) return@use false // 超限中止
                    sb.append(android.util.Base64.encodeToString(buf, 0, n, android.util.Base64.NO_WRAP))
                }
                true
            } ?: false
        } catch (_: Exception) {
            false
        }
        if (!ok) return null
        val mime = activity.contentResolver.getType(uri) ?: "application/octet-stream"
        val obj = JSObject()
        obj.put("base64", sb.toString())
        obj.put("mime", mime)
        return obj
    }

    /**
     * 在 SAF 树中沿相对路径逐段查找文档。
     * ctx 为 md 文档的 docUri；rel 形如 "img/a.png" 或 "../sub/note.md"。
     * 返回目标 docUri；找不到返回 null。
     */
    private fun resolveInTree(ctx: String, rel: String): Uri? {
        if (rel.isEmpty()) return null
        if (rel.startsWith("http://") || rel.startsWith("https://") || rel.startsWith("data:")) {
            return null
        }
        val segments = rel.split('/').filter { it.isNotEmpty() && it != "." }
        if (segments.isEmpty()) return null

        // 起始目录 = md 文档所在目录 docId
        val treePart = ctx.substringBeforeLast("/document/")
        if (treePart.isEmpty()) return null
        val treeUri = Uri.parse(treePart)
        val treeDocId = DocumentsContract.getTreeDocumentId(treeUri)
        val mdDocId = try {
            DocumentsContract.getDocumentId(Uri.parse(ctx))
        } catch (_: Exception) {
            return null
        }
        var dirDocId = parentDocIdOfDocId(mdDocId, treeDocId) ?: return null

        var target: Uri? = null
        for ((i, seg) in segments.withIndex()) {
            if (seg == "..") {
                dirDocId = parentDocIdOfDocId(dirDocId, treeDocId) ?: return null
                continue
            }
            val found = findChildInDir(treeUri, dirDocId, seg) ?: return null
            if (i == segments.size - 1) {
                target = DocumentsContract.buildDocumentUriUsingTree(treeUri, found)
            } else {
                dirDocId = found
            }
        }
        return target
    }

    private fun parentDocIdOfDocId(docId: String, treeDocId: String): String? {
        if (docId == treeDocId) return null
        val idx = docId.lastIndexOf('/')
        return if (idx > 0) docId.substring(0, idx) else treeDocId
    }

    /** 列出某目录的子文档，按名字查找，返回 docId */
    private fun findChildInDir(treeUri: Uri, dirDocId: String, name: String): String? {
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, dirDocId)
        return try {
            activity.contentResolver.query(
                childrenUri,
                arrayOf(
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME
                ),
                null,
                null,
                null
            )?.use { c ->
                val idCol = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
                val nameCol = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
                while (c.moveToNext()) {
                    if (c.getString(nameCol) == name) return@use c.getString(idCol)
                }
                null
            }
        } catch (_: Exception) {
            null
        }
    }
}
