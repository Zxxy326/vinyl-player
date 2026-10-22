package io.github.zxxy326.vinylplayer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

/**
 * 前台服务 + MediaSession。
 *
 * 为什么通知是自己拼的，不用 media3 的 DefaultMediaNotificationProvider：
 * MediaNotificationManager 在发通知前要求「本服务内部有一个已连上的
 * MediaController、且 timeline 非空、状态不是 IDLE」，而这个 App 的播放
 * 指令是从 WebView 直接打到 ExoPlayer 的，服务端没有控制器，于是
 * onUpdateNotification() 每次都静默 return —— 通知永远不出现。
 * 自己发就只有一条规则：播放器什么状态，通知就长什么样。
 *
 * MediaSession 仍然保留：锁屏、蓝牙、以及国产 ROM 的「胶囊」媒体卡片
 * 都是靠 MediaStyle + session token 从系统那边拿元信息和控件的。
 */
class PlaybackService : MediaSessionService() {

    private var session: MediaSession? = null
    private val handler = Handler(Looper.getMainLooper())
    private var ticker: Runnable? = null
    private var openIntent: PendingIntent? = null
    private var inForeground = false
    private var lastKey = ""
    private var lastArtUri: String? = null
    private var lastArt: Bitmap? = null

    override fun onCreate() {
        super.onCreate()
        val p = PlayerHolder.ensure(this)

        createChannel()
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        openIntent = open

        // 锁屏 / 蓝牙 / 系统媒体卡片认这个 session
        session = MediaSession.Builder(this, p)
            .setSessionActivity(open)
            .build()

        PlayerHolder.tap?.onBins = { bins ->
            val sb = StringBuilder(bins.size * 4 + 2)
            sb.append('[')
            for (i in bins.indices) {
                if (i > 0) sb.append(',')
                sb.append(bins[i])
            }
            sb.append(']')
            JsBridge.emit("spectrum", sb.toString())
        }

        p.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                JsBridge.emit("state", if (isPlaying) "\"playing\"" else "\"paused\"")
                refresh(force = true)
            }

            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_ENDED) JsBridge.emit("state", "\"ended\"")
                refresh()
            }

            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                val id = mediaItem?.mediaId ?: ""
                JsBridge.emit(
                    "track",
                    "{\"index\":${p.currentMediaItemIndex},\"id\":\"$id\"}"
                )
                refresh(force = true)
            }

            override fun onMediaMetadataChanged(mediaMetadata: MediaMetadata) {
                refresh()
            }
        })

        ticker = object : Runnable {
            override fun run() {
                if (p.isPlaying) {
                    val dur = if (p.duration == C.TIME_UNSET) 0L else p.duration
                    JsBridge.emit(
                        "position",
                        "{\"position\":${p.currentPosition / 1000.0},\"duration\":${dur / 1000.0},\"playing\":true}"
                    )
                }
                handler.postDelayed(this, 250)
            }
        }
        handler.postDelayed(ticker!!, 250)
    }

    /* ---------------- 通知 ---------------- */

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            val ch = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.notif_channel),
                NotificationManager.IMPORTANCE_LOW   // 低优先级：不出声、不弹横幅
            )
            ch.setShowBadge(false)
            ch.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            getSystemService(NotificationManager::class.java)?.createNotificationChannel(ch)
        }
    }

    private fun serviceIntent(action: String): PendingIntent = PendingIntent.getService(
        this,
        action.hashCode(),
        Intent(this, PlaybackService::class.java).setAction(action),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )

    private fun buildNotification(p: Player): Notification {
        val md = p.mediaMetadata
        val title = md.title?.toString()?.takeIf { it.isNotBlank() } ?: "未在播放"
        val artist = md.artist?.toString()?.takeIf { it.isNotBlank() }
            ?: md.albumTitle?.toString().orEmpty()
        val playing = p.isPlaying

        val b = if (Build.VERSION.SDK_INT >= 26)
            Notification.Builder(this, CHANNEL_ID)
        else
            @Suppress("DEPRECATION")
            Notification.Builder(this)

        b.setSmallIcon(R.drawable.ic_stat_vinyl)
            .setContentTitle(title)
            .setContentText(artist)
            .setContentIntent(openIntent)
            .setDeleteIntent(serviceIntent(ACTION_CLOSE))
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setOngoing(playing)
            .setVisibility(Notification.VISIBILITY_PUBLIC)

        loadArt(md)?.let { b.setLargeIcon(it) }

        // 紧凑视图必须显式给出三个按钮的下标，否则系统只塞「播放/暂停」
        b.setActions(
            *arrayOf(
                action(R.drawable.ic_notif_prev, "上一首", ACTION_PREV),
                action(
                    if (playing) R.drawable.ic_notif_pause else R.drawable.ic_notif_play,
                    if (playing) "暂停" else "播放",
                    ACTION_TOGGLE
                ),
                action(R.drawable.ic_notif_next, "下一首", ACTION_NEXT)
            )
        )

        val style = Notification.MediaStyle().setShowActionsInCompactView(0, 1, 2)
        session?.platformToken?.let { style.setMediaSession(it) }
        b.setStyle(style)

        return b.build()
    }

    private fun action(icon: Int, title: String, act: String): Notification.Action =
        Notification.Action.Builder(
            android.graphics.drawable.Icon.createWithResource(this, icon),
            title,
            serviceIntent(act)
        ).build()

    /** 通知大图：优先媒体自带的 artworkUri（系统相册缩略图），失败就不放图 */
    private fun loadArt(md: MediaMetadata): Bitmap? {
        val uri = md.artworkUri ?: return null
        val key = uri.toString()
        if (key == lastArtUri) return lastArt
        lastArtUri = key
        lastArt = try {
            contentResolver.openInputStream(uri)?.use { ins ->
                val opts = BitmapFactory.Options().apply { inSampleSize = 2 }
                BitmapFactory.decodeStream(ins, null, opts)
            }
        } catch (_: Throwable) {
            null
        }
        return lastArt
    }

    private fun refresh(force: Boolean = false) {
        val p = PlayerHolder.peek() ?: return
        val md = p.mediaMetadata
        val key = "${md.title}|${md.artist}|${md.artworkUri}|${p.isPlaying}|${p.currentMediaItemIndex}"
        if (!force && key == lastKey) return
        lastKey = key

        val n = try {
            buildNotification(p)
        } catch (t: Throwable) {
            android.util.Log.w(TAG, "拼通知失败", t)
            return
        }
        try {
            if (p.isPlaying) {
                if (Build.VERSION.SDK_INT >= 29) {
                    startForeground(
                        NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                    )
                } else {
                    startForeground(NOTIF_ID, n)
                }
                inForeground = true
            } else {
                nm().notify(NOTIF_ID, n)
                if (inForeground) {
                    // 暂停后留在通知栏，但退出前台（省电、也符合系统预期）
                    stopForeground(false)
                    inForeground = false
                }
            }
        } catch (t: Throwable) {
            android.util.Log.w(TAG, "发通知失败", t)
        }
    }

    private fun nm(): NotificationManager =
        getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val p = PlayerHolder.peek()
        when (intent?.action) {
            ACTION_PREV -> p?.seekToPreviousMediaItem()
            ACTION_NEXT -> p?.seekToNextMediaItem()
            ACTION_TOGGLE -> if (p != null) {
                if (p.isPlaying) p.pause() else p.play()
            }
            ACTION_CLOSE -> {
                if (p != null && p.isPlaying) p.pause()
                stopSelf()
                return START_NOT_STICKY
            }
        }
        if (intent?.action?.startsWith("io.github.zxxy326.vinylplayer.") == true) {
            return START_STICKY
        }
        return super.onStartCommand(intent, flags, startId)
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    override fun onTaskRemoved(rootIntent: Intent?) {
        // 从最近任务里划掉后继续播；只有真的停了才结束服务
        val p = PlayerHolder.peek()
        if (p == null || !p.isPlaying) stopSelf()
    }

    override fun onDestroy() {
        ticker?.let { handler.removeCallbacks(it) }
        PlayerHolder.tap?.onBins = null
        session?.release()
        session = null
        super.onDestroy()
    }

    companion object {
        private const val TAG = "VPJS"
        private const val CHANNEL_ID = "vinyl_playback"
        private const val NOTIF_ID = 1001
        private const val ACTION_PREV = "io.github.zxxy326.vinylplayer.PREV"
        private const val ACTION_NEXT = "io.github.zxxy326.vinylplayer.NEXT"
        private const val ACTION_TOGGLE = "io.github.zxxy326.vinylplayer.TOGGLE"
        private const val ACTION_CLOSE = "io.github.zxxy326.vinylplayer.CLOSE"
    }
}
