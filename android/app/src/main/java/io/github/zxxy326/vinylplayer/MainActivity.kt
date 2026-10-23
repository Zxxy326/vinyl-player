package io.github.zxxy326.vinylplayer

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.view.WindowManager
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
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import kotlin.math.roundToInt

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
     * Android 15（targetSdk 35）强制 edge-to-edge，WebView 会画到状态栏和手势条底下。
     *
     * 做法：系统栏全部透明、内容铺满整屏（沉浸），再把 inset 换算成 CSS 像素
     * 通过 __setInsets 推给前端，由 CSS 变量 --safe-t/-b/-l/-r 自己留白。
     *
     * 为什么不再给容器 setPadding：那样状态栏区域就是一块纯色带，永远做不到
     * "封面压到状态栏底下"的沉浸效果；而且 WebView 会忽略自己的 padding。
     */
    private var safeT = 0
    private var safeB = 0
    private var safeL = 0
    private var safeR = 0
    private var hideStatusBar = false

    private fun applyWindowInsets() {
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        if (Build.VERSION.SDK_INT >= 29) {
            // 去掉手势条后面那层半透明遮罩，不然底部会出现一条灰带
            window.isNavigationBarContrastEnforced = false
        }
        val ctl = WindowInsetsControllerCompat(window, window.decorView)
        ctl.isAppearanceLightStatusBars = false   // 深红底 → 状态栏用浅色图标
        ctl.isAppearanceLightNavigationBars = false
        ctl.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE

        ViewCompat.setOnApplyWindowInsetsListener(host) { _, insets ->
            val b = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or
                    WindowInsetsCompat.Type.displayCutout()
            )
            val d = resources.displayMetrics.density
            safeT = (b.top / d).roundToInt()
            safeB = (b.bottom / d).roundToInt()
            safeL = (b.left / d).roundToInt()
            safeR = (b.right / d).roundToInt()
            pushInsets()
            insets
        }
        // onCreate 阶段视图还没 attach，直接 requestApplyInsets 会被丢掉，
        // 所以等第一帧结束后再要一次；再兜一层「直接读 rootWindowInsets」。
        host.post {
            ViewCompat.requestApplyInsets(host)
            host.post {
                if (safeT == 0 && safeB == 0) {
                    val root = window.decorView.rootWindowInsets
                    if (root != null) {
                        val b = WindowInsetsCompat.toWindowInsetsCompat(root).getInsets(
                            WindowInsetsCompat.Type.systemBars() or
                                WindowInsetsCompat.Type.displayCutout()
                        )
                        val d = resources.displayMetrics.density
                        safeT = (b.top / d).roundToInt()
                        safeB = (b.bottom / d).roundToInt()
                        safeL = (b.left / d).roundToInt()
                        safeR = (b.right / d).roundToInt()
                        pushInsets()
                    }
                }
            }
        }
    }

    /** 把安全区宽度推给前端（CSS 像素）。页面还没加载完时静默失败，onPageFinished 会再推一次 */
    private fun pushInsets() {
        val js = "window.__setInsets&&window.__setInsets($safeT,$safeB,$safeL,$safeR)"
        try {
            web.evaluateJavascript(js, null)
        } catch (_: Throwable) {
        }
    }

    /** 设置项：保持屏幕常亮 */
    fun setKeepScreenOn(on: Boolean) {
        runOnUiThread {
            if (on) {
                window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } else {
                window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
    }

    /** 设置项：隐藏顶部状态栏（下拉仍可临时唤出） */
    fun setHideStatusBar(on: Boolean) {
        hideStatusBar = on
        runOnUiThread { applyStatusBarVisibility() }
    }

    private fun applyStatusBarVisibility() {
        val ctl = WindowInsetsControllerCompat(window, window.decorView)
        if (hideStatusBar) {
            ctl.systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            ctl.hide(WindowInsetsCompat.Type.statusBars())
        } else {
            ctl.show(WindowInsetsCompat.Type.statusBars())
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // 弹过对话框/切回前台后系统会把状态栏放回来，这里再收一次
        if (hasFocus && hideStatusBar) applyStatusBarVisibility()
    }

    /**
     * 旋转屏幕时 Activity 不重建（manifest 里声明了 configChanges），
     * 但 WebView 有概率不重算视口：真机实测旋转后 page scale 还停在 1.16，
     * 可视区只剩 787×354，界面整体放大、右侧被切、底部控件掉到屏幕外。
     * 这里在配置变化后主动重排一次，并让前端把视口自愈一遍。
     */
    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        super.onConfigurationChanged(newConfig)
        web.post {
            web.requestLayout()
            try {
                web.evaluateJavascript("window.__vpHeal&&window.__vpHeal()", null)
            } catch (_: Throwable) {
            }
        }
        // 刘海 / 手势条的方向变了，安全区要重新算
        ViewCompat.requestApplyInsets(host)
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

            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                // 页面加载完补推一次安全区：inset 事件可能比首屏更早到
                pushInsets()
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
