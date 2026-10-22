package io.github.zxxy326.vinylplayer

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.widget.FrameLayout
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private lateinit var host: FrameLayout
    private lateinit var bridge: PlayerBridge

    /** 选 .lrc 文件（SAF），选完把内容回吐给 JS */
    private val lrcPicker = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { res ->
        var text = ""
        if (res.resultCode == RESULT_OK) {
            val uri = res.data?.data
            if (uri != null) {
                text = try {
                    contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() } ?: ""
                } catch (e: Exception) {
                    ""
                }
            }
        }
        JsBridge.callJs("window.__onLyrics && window.__onLyrics(${JSONObject.quote(text)})")
    }

    private val permLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { grant ->
        val audioOk = grant.entries.any { (k, v) ->
            v && (k == Manifest.permission.READ_MEDIA_AUDIO ||
                  k == Manifest.permission.READ_EXTERNAL_STORAGE)
        }
        // 通知权限没开的话，播放器照样能用，但通知栏/胶囊卡片不会出现
        if (Build.VERSION.SDK_INT >= 33 &&
            grant.containsKey(Manifest.permission.POST_NOTIFICATIONS) &&
            grant[Manifest.permission.POST_NOTIFICATIONS] != true
        ) {
            JsBridge.callJs(
                "window.__playerEvent && window.__playerEvent('toast', '通知权限没开：通知栏不会显示播放控制，可在「设置 · 通知」里修复')"
            )
        }
        if (audioOk) {
            JsBridge.callJs("window.__rescan && window.__rescan()")
        } else {
            // 没权限就扫不到任何歌，必须让用户知道为什么
            Toast.makeText(
                this,
                "需要「音乐和音频」权限才能读取本机歌曲",
                Toast.LENGTH_LONG
            ).show()
            JsBridge.callJs(
                "window.__playerEvent && window.__playerEvent('toast', '没有读取音乐权限，去系统设置里打开')"
            )
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 必须在 setContentView 之前关掉「自动避让系统栏」，否则 AppCompat 的
        // 根布局会先把 inset 吃掉，WebView 就永远等不到 onApplyWindowInsets。
        WindowCompat.setDecorFitsSystemWindows(window, false)

        web = WebView(this)
        web.layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        )
        web.setBackgroundColor(0xFF8B1E26.toInt())

        host = FrameLayout(this)
        host.setBackgroundColor(0xFF8B1E26.toInt())
        host.addView(web, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ))
        setContentView(host)

        configureWebView()
        // 只有 debug 包开 WebView 调试口，release 包不受影响（真机/模拟器排查用）
        if (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            WebView.setWebContentsDebuggingEnabled(true)
        }
        applyWindowInsets()

        bridge = PlayerBridge(this)
        web.addJavascriptInterface(bridge, "AndroidPlayer")
        JsBridge.attach(web)

        // --ez diag true 启动可打开诊断面板
        val q = if (intent?.getBooleanExtra("diag", false) == true) "?diag" else ""
        web.loadUrl("https://appassets.androidplatform.net/assets/web/index.html$q")

        requestPermissionsIfNeeded()
    }

    /**
     * Android 15（targetSdk 35）强制 edge-to-edge：WebView 会画到状态栏和
     * 手势条底下，底部那排播放按钮就被导航条盖住了（"底部按钮被裁切"）。
     * WebView 本身不解 `env(safe-area-inset-*)`，所以只能在原生这边把
     * 系统栏的 inset 变成留白。
     *
     * 注意：不要直接给 WebView setPadding —— WebView 会忽略自己的 padding
     * 照旧铺满整块区域，于是白留了。套一层 FrameLayout，padding 加在容器上，
     * WebView 的可用高度才会真的缩下来。
     */
    private fun applyWindowInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(host) { v, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or
                    WindowInsetsCompat.Type.displayCutout()
            )
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        // onCreate 阶段视图还没 attach，直接 requestApplyInsets 会被丢掉，
        // 所以等第一帧结束后再要一次；再兜一层「直接读 rootWindowInsets」。
        host.post {
            ViewCompat.requestApplyInsets(host)
            host.post {
                if (host.paddingTop == 0 && host.paddingBottom == 0) {
                    val root = window.decorView.rootWindowInsets
                    if (root != null) {
                        val bars = WindowInsetsCompat.toWindowInsetsCompat(root).getInsets(
                            WindowInsetsCompat.Type.systemBars() or
                                WindowInsetsCompat.Type.displayCutout()
                        )
                        host.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                    }
                }
            }
        }
    }

    private fun configureWebView() {
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            allowFileAccess = false
            allowContentAccess = false
            cacheMode = WebSettings.LOAD_DEFAULT
            textZoom = 100
        }

        // 别让系统的强制深色把设计稿反色
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(web.settings, false)
        }

        // 前端 console / 报错都转到 logcat（tag: VPJS），真机排查靠它
        web.webChromeClient = object : android.webkit.WebChromeClient() {
            override fun onConsoleMessage(m: android.webkit.ConsoleMessage): Boolean {
                android.util.Log.d("VPJS", "${m.messageLevel()} ${m.message()} @${m.lineNumber()}")
                return true
            }
        }

        web.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? {
                return loader.shouldInterceptRequest(request.url)
            }

            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest
            ): Boolean {
                // 只允许本地资源，外链一律拦下（本地播放器不需要跳转）
                return request.url.host != "appassets.androidplatform.net"
            }
        }
    }

    private fun requestPermissionsIfNeeded() {
        val list = ArrayList<String>()
        val audio = if (Build.VERSION.SDK_INT >= 33)
            Manifest.permission.READ_MEDIA_AUDIO
        else
            Manifest.permission.READ_EXTERNAL_STORAGE

        if (ContextCompat.checkSelfPermission(this, audio) != PackageManager.PERMISSION_GRANTED) {
            list.add(audio)
        }
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            list.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        if (list.isNotEmpty()) permLauncher.launch(list.toTypedArray())
    }

    fun ensureService() {
        try {
            startService(Intent(this, PlaybackService::class.java))
        } catch (_: Exception) {
        }
    }

    fun pickLyrics() {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
        }
        try {
            lrcPicker.launch(intent)
        } catch (e: Exception) {
            JsBridge.callJs("window.__onLyrics && window.__onLyrics('')")
        }
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
    }

    override fun onPause() {
        web.onPause()
        super.onPause()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        web.evaluateJavascript("window.__back ? window.__back() : false") { r ->
            if (r != "true") moveTaskToBack(true)
        }
    }

    override fun onDestroy() {
        JsBridge.detach()
        web.removeJavascriptInterface("AndroidPlayer")
        (web.parent as? ViewGroup)?.removeView(web)
        web.destroy()
        super.onDestroy()
    }
}
