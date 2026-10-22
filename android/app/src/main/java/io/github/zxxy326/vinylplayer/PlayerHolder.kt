package io.github.zxxy326.vinylplayer

import android.content.Context
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.SonicAudioProcessor
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.media3.exoplayer.audio.SilenceSkippingAudioProcessor
import androidx.media3.exoplayer.audio.TeeAudioProcessor

/**
 * 全局播放器单例：Application 里创建，UI 与前台服务共用。
 *
 * 音频链里插了 TeeAudioProcessor 取 PCM 算频谱，同时保留
 * SilenceSkipping 与 Sonic —— Sonic 是 setPlaybackSpeed 的实现，
 * 搓碟的变速弯音全靠它，不能丢。
 *
 * media3 1.4 起 `ExoPlayer.Builder` 不再有 `setAudioSink`，只能通过自定义
 * `RenderersFactory.buildAudioSink()` 把带 ProcessorChain 的 sink 塞进去。
 */
object PlayerHolder {

    @Volatile
    private var exo: ExoPlayer? = null

    @Volatile
    var tap: FftTap? = null
        private set

    fun ensure(ctx: Context): ExoPlayer {
        exo?.let { return it }
        synchronized(this) {
            exo?.let { return it }

            val app = ctx.applicationContext
            val fft = FftTap()
            tap = fft

            val renderers = object : DefaultRenderersFactory(app) {
                override fun buildAudioSink(
                    context: Context,
                    enableFloatOutput: Boolean,
                    enableAudioTrackPlaybackParams: Boolean
                ): AudioSink {
                    val chain = DefaultAudioSink.DefaultAudioProcessorChain(
                        arrayOf<AudioProcessor>(TeeAudioProcessor(fft)),
                        SilenceSkippingAudioProcessor(),
                        SonicAudioProcessor()
                    )
                    return DefaultAudioSink.Builder(context)
                        .setAudioProcessorChain(chain)
                        .setEnableFloatOutput(enableFloatOutput)
                        // 关键：必须关掉 AudioTrack 原生变速。它只改速度不改音高，
                        // 开了之后 setPlaybackSpeed 就绕过了 Sonic，搓碟会变成
                        // 「变快但音高不变」，完全没有黑胶的转速手感。
                        .setEnableAudioTrackPlaybackParams(false)
                        .build()
                }
            }

            val p = ExoPlayer.Builder(app, renderers)
                .setHandleAudioBecomingNoisy(true)
                .build()

            p.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                    .build(),
                true
            )
            p.repeatMode = Player.REPEAT_MODE_ALL
            p.volume = 0.72f

            exo = p
            return p
        }
    }

    fun peek(): ExoPlayer? = exo
}
