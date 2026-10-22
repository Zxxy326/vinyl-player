package io.github.zxxy326.vinylplayer

import androidx.media3.common.C
import androidx.media3.exoplayer.audio.TeeAudioProcessor
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.log10
import kotlin.math.min
import kotlin.math.pow

/**
 * 从 ExoPlayer 的音频管道里抓 PCM，自己算 FFT。
 *
 * 为什么不用 android.media.audiofx.Visualizer：Android 9+ 抓输出混音需要
 * RECORD_AUDIO 权限，部分 OEM 直接返回空数据，而且本地播放器要录音权限很怪。
 *
 * 输出的 56 个 bin 与 JS 侧 buildBins() 用同一套对数分段，
 * 值域同样是 0..255，这样两端频谱形态一致。
 */
class FftTap : TeeAudioProcessor.AudioBufferSink {

    companion object {
        private const val FFT = 2048
        private const val BARS = 56
    }

    /** 回调在音频线程，实现方要自己 post 到主线程 */
    @Volatile
    var onBins: ((IntArray) -> Unit)? = null

    private var sampleRate = 44100
    private var channels = 2
    private var encoding = C.ENCODING_PCM_16BIT

    private val re = FloatArray(FFT)
    private val im = FloatArray(FFT)
    private val mono = FloatArray(FFT)
    private val hann = FloatArray(FFT) {
        (0.5 - 0.5 * cos(2.0 * PI * it / (FFT - 1))).toFloat()
    }
    private var fill = 0

    override fun flush(sampleRateHz: Int, channelCount: Int, encoding: Int) {
        sampleRate = if (sampleRateHz > 0) sampleRateHz else 44100
        channels = if (channelCount > 0) channelCount else 2
        this.encoding = encoding
        fill = 0
    }

    override fun handleBuffer(buffer: ByteBuffer) {
        val dup = buffer.duplicate().order(ByteOrder.LITTLE_ENDIAN)

        if (encoding == C.ENCODING_PCM_FLOAT) {
            val fb = dup.asFloatBuffer()
            val frames = fb.remaining() / channels
            for (f in 0 until frames) {
                var s = 0f
                for (c in 0 until channels) s += fb.get()
                push(s / channels)
            }
        } else {
            val sb = dup.asShortBuffer()
            val frames = sb.remaining() / channels
            for (f in 0 until frames) {
                var s = 0f
                for (c in 0 until channels) s += sb.get() / 32768f
                push(s / channels)
            }
        }
    }

    private fun push(v: Float) {
        mono[fill++] = v
        if (fill >= FFT) {
            compute()
            fill = 0
        }
    }

    private fun compute() {
        for (i in 0 until FFT) {
            re[i] = mono[i] * hann[i]
            im[i] = 0f
        }
        fft(re, im)

        val nyq = sampleRate / 2.0
        val fMin = 38.0
        val fMax = min(16500.0, nyq * 0.92)
        val half = FFT / 2
        val bins = IntArray(BARS)

        for (b in 0 until BARS) {
            val f0 = fMin * (fMax / fMin).pow(b.toDouble() / BARS)
            val f1 = fMin * (fMax / fMin).pow((b + 1).toDouble() / BARS)
            var s = (f0 / nyq * half).toInt()
            var e = ceil(f1 / nyq * half).toInt()
            if (e <= s) e = s + 1
            s = s.coerceIn(0, half - 1)
            e = e.coerceIn(s + 1, half)

            var m = 0f
            for (k in s until e) {
                val mag = hypot(re[k], im[k]) * 2f / FFT
                if (mag > m) m = mag
            }
            // 与 AnalyserNode 的默认 dB 映射对齐（-100..-30 dB → 0..255）
            val db = 20.0 * log10(m + 1e-9)
            bins[b] = (((db + 100.0) / 70.0) * 255.0).toInt().coerceIn(0, 255)
        }

        onBins?.invoke(bins)
    }

    /** 原地 radix-2 FFT */
    private fun fft(real: FloatArray, imag: FloatArray) {
        val n = real.size
        var j = 0
        for (i in 1 until n) {
            var bit = n shr 1
            while (j and bit != 0) {
                j = j xor bit
                bit = bit shr 1
            }
            j = j or bit
            if (i < j) {
                val tr = real[i]; real[i] = real[j]; real[j] = tr
                val ti = imag[i]; imag[i] = imag[j]; imag[j] = ti
            }
        }
        var len = 2
        while (len <= n) {
            val ang = -2.0 * PI / len
            val wr = cos(ang).toFloat()
            val wi = kotlin.math.sin(ang).toFloat()
            var i = 0
            while (i < n) {
                var cr = 1f
                var ci = 0f
                for (k in 0 until len / 2) {
                    val ur = real[i + k]
                    val ui = imag[i + k]
                    val vr = real[i + k + len / 2] * cr - imag[i + k + len / 2] * ci
                    val vi = real[i + k + len / 2] * ci + imag[i + k + len / 2] * cr
                    real[i + k] = ur + vr
                    imag[i + k] = ui + vi
                    real[i + k + len / 2] = ur - vr
                    imag[i + k + len / 2] = ui - vi
                    val ncr = cr * wr - ci * wi
                    ci = cr * wi + ci * wr
                    cr = ncr
                }
                i += len
            }
            len = len shl 1
        }
    }
}
