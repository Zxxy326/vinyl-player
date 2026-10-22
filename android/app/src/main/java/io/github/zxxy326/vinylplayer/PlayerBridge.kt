package io.github.zxxy326.vinylplayer

import android.Manifest
import android.content.ContentUris
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import androidx.core.content.ContextCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import org.json.JSONArray
import org.json.JSONObject

/**
 * JS 与原生播放器的桥。
 * 所有方法签名统一为 (String json) -> String json，调用来自 WebView 的 JavaBridge 线程，
 * 涉及播放器的操作一律 post 到主线程。
 */
class PlayerBridge(private val act: MainActivity) {

    private fun player() = PlayerHolder.ensure(act)

    /** uri -> 歌词文本；读文件解析一次就够，来回切歌不再重复读 */
    private val lyricCache = HashMap<String, String>()

    @JavascriptInterface
    fun load(json: String): String {
        val o = JSONObject(json)
        val index = o.optInt("index", 0)
        val queue = o.optJSONArray("queue")
        val items = ArrayList<MediaItem>()

        if (queue != null) {
            for (i in 0 until queue.length()) {
                val t = queue.optJSONObject(i) ?: continue
                val albumId = t.optString("albumId", "")
                val artUri = if (albumId.isNotEmpty()) {
                    ContentUris.withAppendedId(
                        Uri.parse("content://media/external/audio/albumart"),
                        albumId.toLongOrNull() ?: 0L
                    )
                } else null

                val md = MediaMetadata.Builder()
                    .setTitle(t.optString("title", ""))
                    .setArtist(t.optString("artist", ""))
                    .setAlbumTitle(t.optString("album", ""))
                if (artUri != null) md.setArtworkUri(artUri)

                items.add(
                    MediaItem.Builder()
                        .setUri(t.optString("uri", ""))
                        .setMediaId(t.optString("id", ""))
                        .setMediaMetadata(md.build())
                        .build()
                )
            }
        }

        act.runOnUiThread {
            val p = player()
            if (items.isEmpty()) return@runOnUiThread
            val start = index.coerceIn(0, items.size - 1)
            p.setMediaItems(items, start, 0L)
            p.prepare()
        }
        return "{}"
    }

    @JavascriptInterface
    fun play(@Suppress("UNUSED_PARAMETER") json: String): String {
        act.ensureService()
        act.runOnUiThread {
            val p = player()
            if (p.playbackState == Player.STATE_IDLE) p.prepare()
            p.play()
        }
        return "{}"
    }

    @JavascriptInterface
    fun pause(@Suppress("UNUSED_PARAMETER") json: String): String {
        act.runOnUiThread { player().pause() }
        return "{}"
    }

    @JavascriptInterface
    fun seek(json: String): String {
        val ms = (JSONObject(json).optDouble("position", 0.0) * 1000).toLong()
        act.runOnUiThread { player().seekTo(ms.coerceAtLeast(0L)) }
        return "{}"
    }

    /** rate<=0 表示恢复常速；正向搓碟走变速弯音，pitch 跟着 speed 变（唱盘式变调） */
    @JavascriptInterface
    fun bend(json: String): String {
        val r = JSONObject(json).optDouble("rate", 0.0)
        act.runOnUiThread {
            val p = player()
            p.playbackParameters = if (r <= 0.0) {
                PlaybackParameters(1f, 1f)
            } else {
                val s = r.toFloat().coerceIn(0.25f, 2.2f)
                PlaybackParameters(s, s)
            }
        }
        return "{}"
    }

    @JavascriptInterface
    fun volume(json: String): String {
        val v = JSONObject(json).optDouble("level", 0.72).toFloat().coerceIn(0f, 1f)
        act.runOnUiThread { player().volume = v }
        return "{}"
    }

    @JavascriptInterface
    fun repeat(json: String): String {
        val mode = JSONObject(json).optString("mode", "all")
        act.runOnUiThread {
            player().repeatMode = when (mode) {
                "one" -> Player.REPEAT_MODE_ONE
                "off" -> Player.REPEAT_MODE_OFF
                else -> Player.REPEAT_MODE_ALL
            }
        }
        return "{}"
    }

    @JavascriptInterface
    fun shuffle(json: String): String {
        val on = JSONObject(json).optBoolean("on", false)
        act.runOnUiThread { player().shuffleModeEnabled = on }
        return "{}"
    }

    @JavascriptInterface
    fun next(@Suppress("UNUSED_PARAMETER") json: String): String {
        act.runOnUiThread { player().seekToNextMediaItem() }
        return "{}"
    }

    @JavascriptInterface
    fun prev(@Suppress("UNUSED_PARAMETER") json: String): String {
        act.runOnUiThread { player().seekToPreviousMediaItem() }
        return "{}"
    }

    @JavascriptInterface
    fun stop(@Suppress("UNUSED_PARAMETER") json: String): String {
        act.runOnUiThread {
            player().pause()
            player().clearMediaItems()
        }
        return "{}"
    }

    /** 曲库：MediaStore 查询，返回 JSON 数组 */
    @JavascriptInterface
    fun library(@Suppress("UNUSED_PARAMETER") json: String): String {
        return try {
            if (!hasAudioPermission()) return "[]"

            val arr = JSONArray()
            val proj = mutableListOf(
                MediaStore.Audio.Media._ID,
                MediaStore.Audio.Media.TITLE,
                MediaStore.Audio.Media.ARTIST,
                MediaStore.Audio.Media.ALBUM,
                MediaStore.Audio.Media.ALBUM_ID,
                MediaStore.Audio.Media.DURATION,
                MediaStore.Audio.Media.DISPLAY_NAME,
                MediaStore.Audio.Media.SIZE,
                MediaStore.Audio.Media.BITRATE
            )
            // 采样率列是 API 31 才有的；直接按列名取，老系统 getColumnIndex 会返回 -1
            if (Build.VERSION.SDK_INT >= 31) proj.add("samplerate")
            val sel = "${MediaStore.Audio.Media.IS_MUSIC} != 0 AND ${MediaStore.Audio.Media.DURATION} > 3000"

            try {
                act.contentResolver.query(
                    MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
                    proj.toTypedArray(), sel, null,
                    "${MediaStore.Audio.Media.TITLE} COLLATE NOCASE ASC"
                )?.use { c ->
                    val iId = c.getColumnIndexOrThrow(MediaStore.Audio.Media._ID)
                    val iTitle = c.getColumnIndexOrThrow(MediaStore.Audio.Media.TITLE)
                    val iArtist = c.getColumnIndexOrThrow(MediaStore.Audio.Media.ARTIST)
                    val iAlbum = c.getColumnIndexOrThrow(MediaStore.Audio.Media.ALBUM)
                    val iAlbumId = c.getColumnIndexOrThrow(MediaStore.Audio.Media.ALBUM_ID)
                    val iDur = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DURATION)
                    val iName = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DISPLAY_NAME)
                    val iSize = c.getColumnIndex(MediaStore.Audio.Media.SIZE)
                    val iBr = c.getColumnIndex(MediaStore.Audio.Media.BITRATE)
                    val iSr = c.getColumnIndex("samplerate")

                    while (c.moveToNext()) {
                        val id = c.getLong(iId)
                        val uri = ContentUris.withAppendedId(
                            MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, id
                        ).toString()
                        val name = c.getString(iName) ?: ""
                        val ext = name.substringAfterLast('.', "").uppercase()

                        val o = JSONObject()
                        o.put("uri", uri)
                        o.put("title", c.getString(iTitle) ?: name.substringBeforeLast('.'))
                        o.put("artist", c.getString(iArtist) ?: "未知艺人")
                        o.put("album", c.getString(iAlbum) ?: "")
                        o.put("albumId", c.getLong(iAlbumId))
                        o.put("duration", c.getLong(iDur) / 1000.0)
                        o.put("format", if (ext.isEmpty()) "AUDIO" else ext)
                        o.put("playable", true)
                        o.put("size", if (iSize >= 0) c.getLong(iSize) else 0L)
                        // MediaStore 的 BITRATE 是 bps，统一成 kbps
                        o.put("bitrate", if (iBr >= 0) c.getInt(iBr) / 1000 else 0)
                        o.put("sampleRate", if (iSr >= 0) c.getInt(iSr) else 0)
                        // MediaStore 不提供位深，0 表示未知
                        o.put("bitDepth", 0)
                        arr.put(o)
                    }
                }
            } catch (e: Exception) {
                Log.e("VPJS", "library() 查询失败: " + e)
                dumpCrash("library-query", e)
                // 把直接返回给前端，排查期先用
                return "[{\"__err\":\"" + e.toString().replace("\"", "'") + "\"}]"
            }
            arr.toString()
        } catch (e: Throwable) {
            dumpCrash("library", e)
            "[{\"__err\":\"outer:" + e.toString().replace("\"", "'") + "\"}]"
        }
    }

    /** 最小连通性测试：只返回常量，用来判断是"调用不通"还是"方法体炸了" */
    @JavascriptInterface
    fun ping(json: String): String {
        return "{\"pong\":true,\"echo\":\"$json\"}"
    }

    /** 诊断：权限状态 + 基础查询行数，真机排查用 */
    @JavascriptInterface
    fun probe(json: String): String {
        return try {
            val o = JSONObject()
            val perm = if (Build.VERSION.SDK_INT >= 33)
                Manifest.permission.READ_MEDIA_AUDIO else Manifest.permission.READ_EXTERNAL_STORAGE
            o.put("perm", ContextCompat.checkSelfPermission(act, perm) == PackageManager.PERMISSION_GRANTED)
            o.put("permName", perm)
            o.put("sdk", Build.VERSION.SDK_INT)
            try {
                act.contentResolver.query(
                    MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
                    arrayOf(MediaStore.Audio.Media._ID), null, null, null
                )?.use { c -> o.put("rows", c.count) }
            } catch (e: Exception) {
                o.put("err", e.toString())
            }
            o.toString()
        } catch (e: Throwable) {
            dumpCrash("probe", e)
            "{\"crash\":\"" + e.toString().replace("\"", "'") + "\"}"
        }
    }

    /** 把异常栈写进 cache 目录，ROM 吞 logcat 时用它排查 */
    private fun dumpCrash(tag: String, e: Throwable) {
        try {
            val f = java.io.File(act.cacheDir, "vinyl-crash.txt")
            val sw = java.io.StringWriter()
            e.printStackTrace(java.io.PrintWriter(sw))
            f.appendText("=== $tag @ ${System.currentTimeMillis()} ===\n$sw\n")
        } catch (_: Throwable) {
        }
    }

    /**
     * 封面：优先取音频文件里的内嵌图片（FLAC picture block / ID3 APIC / MP4 covr），
     * 取不到再退回 MediaStore 的专辑封面。返回 Base64，空串表示没有。
     */
    @JavascriptInterface
    fun cover(json: String): String {
        val o = JSONObject(json)
        val uriStr = o.optString("uri", "")
        val albumId = o.optString("albumId", "")

        // 1. 内嵌（最可靠：手机里大量歌曲没有专辑封面索引，但文件里有）
        if (uriStr.isNotEmpty()) {
            try {
                val mmr = android.media.MediaMetadataRetriever()
                try {
                    mmr.setDataSource(act, Uri.parse(uriStr))
                    val pic = mmr.embeddedPicture
                    if (pic != null && pic.size in 1..(12 * 1024 * 1024)) {
                        return Base64.encodeToString(pic, Base64.NO_WRAP)
                    }
                } finally {
                    try { mmr.release() } catch (_: Throwable) {}
                }
            } catch (_: Throwable) {
            }
        }

        // 2. 退回专辑封面
        if (albumId.isEmpty()) return ""
        return try {
            val uri = ContentUris.withAppendedId(
                Uri.parse("content://media/external/audio/albumart"),
                albumId.toLongOrNull() ?: 0L
            )
            act.contentResolver.openInputStream(uri)?.use { input ->
                val bytes = input.readBytes()
                if (bytes.size > 8 * 1024 * 1024) ""
                else Base64.encodeToString(bytes, Base64.NO_WRAP)
            } ?: ""
        } catch (_: Exception) {
            ""
        }
    }

    /**
     * 内嵌歌词：ID3v2 USLT / TXXX、FLAC Vorbis Comment 的 LYRICS、MP4 ©lyr。
     * 解析结果按 uri 缓存，切歌来回切不会反复读文件。
     */
    @JavascriptInterface
    fun lyrics(json: String): String {
        val uri = JSONObject(json).optString("uri", "")
        if (uri.isEmpty()) return ""
        lyricCache[uri]?.let { return it }
        return try {
            val text = Tags.lyricsOf(act.contentResolver, Uri.parse(uri))
            if (lyricCache.size > 24) lyricCache.clear()
            lyricCache[uri] = text
            text
        } catch (e: Throwable) {
            dumpCrash("lyrics", e)
            ""
        }
    }

    @JavascriptInterface
    fun pickLyrics() {
        act.pickLyrics()
    }

    /** 通知权限状态：没有它，通知栏/锁屏不会有媒体卡片 */
    @JavascriptInterface
    fun notif(@Suppress("UNUSED_PARAMETER") json: String): String {
        return try {
            val ok = if (Build.VERSION.SDK_INT >= 33) {
                ContextCompat.checkSelfPermission(
                    act, Manifest.permission.POST_NOTIFICATIONS
                ) == PackageManager.PERMISSION_GRANTED
            } else {
                androidx.core.app.NotificationManagerCompat.from(act).areNotificationsEnabled()
            }
            "{\"ok\":$ok,\"sdk\":${Build.VERSION.SDK_INT}}"
        } catch (_: Throwable) {
            "{\"ok\":false}"
        }
    }

    /** 跳到本应用的通知设置页（各 ROM 都能落地） */
    @JavascriptInterface
    fun openNotifSettings(@Suppress("UNUSED_PARAMETER") json: String): String {
        try {
            val i = Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, act.packageName)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            act.startActivity(i)
        } catch (_: Throwable) {
            try {
                act.startActivity(
                    Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                        .setData(Uri.parse("package:" + act.packageName))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            } catch (_: Throwable) {
            }
        }
        return "{}"
    }

    private fun hasAudioPermission(): Boolean {
        val perm = if (android.os.Build.VERSION.SDK_INT >= 33)
            Manifest.permission.READ_MEDIA_AUDIO
        else
            Manifest.permission.READ_EXTERNAL_STORAGE
        return ContextCompat.checkSelfPermission(act, perm) == PackageManager.PERMISSION_GRANTED
    }
}
