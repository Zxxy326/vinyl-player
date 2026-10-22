package io.github.zxxy326.vinylplayer

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.webkit.WebView
import java.lang.ref.WeakReference

/** Kotlin → JS 的唯一出口，全部 post 回主线程 */
object JsBridge {

    @Volatile
    private var ref: WeakReference<WebView>? = null

    private val main = Handler(Looper.getMainLooper())
    private var lastSpectrum = 0L

    fun attach(web: WebView) {
        ref = WeakReference(web)
    }

    fun detach() {
        ref = null
    }

    fun callJs(js: String) {
        main.post {
            ref?.get()?.evaluateJavascript(js, null)
        }
    }

    fun emit(name: String, payloadJson: String) {
        // 频谱约 43 次/秒，再压到 60fps 以内
        if (name == "spectrum") {
            val now = SystemClock.uptimeMillis()
            if (now - lastSpectrum < 16) return
            lastSpectrum = now
        }
        callJs("window.__playerEvent && window.__playerEvent('$name', $payloadJson)")
    }
}
