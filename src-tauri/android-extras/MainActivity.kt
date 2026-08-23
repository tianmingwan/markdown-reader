package com.chensdong.mdreader

import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  private var appWebView: WebView? = null

  // 手机主从视图：返回键由前端决定「回列表」还是「退出」，不走 WebView 历史
  // （history.pushState 会让历史栈随每次打开文档永久增长，列表页按返回要连按 N 次才退出）
  override val handleBackNavigation = false

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // debug 构建开启 WebView 远程调试（Chrome DevTools Protocol，方便验证前端）
    if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
    hideSystemBars()
    onBackPressedDispatcher.addCallback(
      this,
      object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          val wv = appWebView
          if (wv == null) {
            finish()
            return
          }
          // 结果形如 "list" / "exit"（evaluateJavascript 返回值是 JSON 字符串，带引号）
          wv.evaluateJavascript("window.__mdBack ? window.__mdBack() : 'exit'") { result ->
            if (result?.trim('"') != "list") finish()
          }
        }
      },
    )
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    appWebView = webView
  }

  // 沉浸式全屏：隐藏状态栏（时间/电池）与导航栏；从边缘滑动可临时唤出
  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) hideSystemBars()
  }

  private fun hideSystemBars() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      window.setDecorFitsSystemWindows(false)
      window.insetsController?.let {
        it.hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
        it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      }
    } else {
      @Suppress("DEPRECATION")
      window.decorView.systemUiVisibility = (
        View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
          or View.SYSTEM_UI_FLAG_FULLSCREEN
          or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
          or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
          or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
          or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        )
    }
  }
}
