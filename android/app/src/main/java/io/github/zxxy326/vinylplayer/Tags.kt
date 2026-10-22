package io.github.zxxy326.vinylplayer

import android.content.ContentResolver
import android.net.Uri
import java.io.FileInputStream
import java.nio.charset.Charset

/**
 * 内嵌歌词解析（只用系统 API + 手写字节解析，不引第三方标签库，保持 APK 体积）
 *
 * 覆盖三种最常见的容器：
 *   - MP3  → ID3v2.2/2.3/2.4 的 USLT（也兜 TXXX:LYRICS）
 *   - FLAC → Vorbis Comment 块里的 LYRICS / UNSYNCEDLYRICS
 *   - M4A  → moov/ilst 里的 ©lyr
 * OGG 的 Vorbis Comment 藏在 Ogg 页里，这里不处理（会退化成频谱视图）。
 */
object Tags {

    private const val HEAD_LIMIT = 3 * 1024 * 1024     // 3MB 覆盖 ID3 标签与 FLAC 元数据块
    private const val TAIL_LIMIT = 4 * 1024 * 1024     // MP4 的 moov 可能在文件末尾

    fun lyricsOf(cr: ContentResolver, uri: Uri): String {
        val head = readRange(cr, uri, 0L, HEAD_LIMIT)
        if (head.isEmpty()) return ""
        var out = parseId3v2(head)
        if (out.isNullOrBlank()) out = parseFlac(head)
        if (out.isNullOrBlank()) out = parseMp4(cr, uri)
        // 统一换行：USLT 里常见的是单独的 \r，直接给前端会糊成一行
        return (out ?: "").replace("\r\n", "\n").replace('\r', '\n').trim()
    }

    /* ---------------- 读字节 ---------------- */

    private fun readRange(cr: ContentResolver, uri: Uri, offset: Long, len: Int): ByteArray {
        if (len <= 0) return ByteArray(0)
        return try {
            cr.openFileDescriptor(uri, "r")?.use { pfd ->
                FileInputStream(pfd.fileDescriptor).use { fis ->
                    fis.channel.position(offset)
                    val buf = ByteArray(len)
                    var read = 0
                    while (read < len) {
                        val n = fis.read(buf, read, len - read)
                        if (n <= 0) break
                        read += n
                    }
                    buf.copyOf(read)
                }
            } ?: ByteArray(0)
        } catch (_: Throwable) {
            ByteArray(0)
        }
    }

    private fun sizeOf(cr: ContentResolver, uri: Uri): Long =
        try {
            cr.openFileDescriptor(uri, "r")?.use { it.statSize } ?: 0L
        } catch (_: Throwable) {
            0L
        }

    /* ---------------- 小工具 ---------------- */

    private fun be32(b: ByteArray, o: Int): Int =
        ((b[o].toInt() and 0xff) shl 24) or ((b[o + 1].toInt() and 0xff) shl 16) or
        ((b[o + 2].toInt() and 0xff) shl 8) or (b[o + 3].toInt() and 0xff)

    private fun le32(b: ByteArray, o: Int): Int =
        (b[o].toInt() and 0xff) or ((b[o + 1].toInt() and 0xff) shl 8) or
        ((b[o + 2].toInt() and 0xff) shl 16) or ((b[o + 3].toInt() and 0xff) shl 24)

    /** ID3 的长度字段每字节只用低 7 位 */
    private fun syncsafe(b: ByteArray, o: Int): Int =
        ((b[o].toInt() and 0x7f) shl 21) or ((b[o + 1].toInt() and 0x7f) shl 14) or
        ((b[o + 2].toInt() and 0x7f) shl 7) or (b[o + 3].toInt() and 0x7f)

    private fun charsetOf(enc: Int): Charset = when (enc) {
        1 -> Charsets.UTF_16      // 带 BOM，Java 的 UTF-16 会自己认
        2 -> Charsets.UTF_16BE
        3 -> Charsets.UTF_8
        else -> Charsets.ISO_8859_1
    }

    /* ---------------- ID3v2 ---------------- */

    private fun parseId3v2(b: ByteArray): String? {
        if (b.size < 10) return null
        if (b[0] != 'I'.code.toByte() || b[1] != 'D'.code.toByte() || b[2] != '3'.code.toByte()) return null

        val major = b[3].toInt() and 0xff
        val flags = b[5].toInt() and 0xff
        val tagSize = syncsafe(b, 6)

        var p = 10
        if (flags and 0x40 != 0) p += if (major >= 4) syncsafe(b, 10) else 4
        val end = minOf(b.size, 10 + tagSize)
        val idLen = if (major == 2) 3 else 4
        val headLen = if (major == 2) 6 else 10

        var uslt: String? = null
        var txxx: String? = null

        while (p + headLen <= end) {
            if (b[p].toInt() == 0) break
            val id = String(b, p, idLen, Charsets.ISO_8859_1)
            val fs = when {
                major == 2 -> ((b[p + 3].toInt() and 0xff) shl 16) or
                    ((b[p + 4].toInt() and 0xff) shl 8) or (b[p + 5].toInt() and 0xff)
                major >= 4 -> syncsafe(b, p + 4)
                else -> be32(b, p + 4)
            }
            val body = p + headLen
            if (fs <= 0 || body + fs > end) break

            if (id == "USLT" || id == "ULT") {
                if (uslt.isNullOrBlank()) uslt = decodeUslt(b, body, fs)
            } else if ((id == "TXXX" || id == "TXX") && txxx == null) {
                decodeTxxx(b, body, fs)?.let { txxx = it }
            }
            p = body + fs
        }
        return uslt?.takeIf { it.isNotBlank() } ?: txxx
    }

    /** enc(1) + 语言(3) + 内容描述(0 结尾) + 正文 */
    private fun decodeUslt(b: ByteArray, off: Int, len: Int): String? {
        if (len < 5) return null
        val enc = b[off].toInt() and 0xff
        val cs = charsetOf(enc)
        val end = off + len
        var p = off + 4

        if (enc == 1 || enc == 2) {
            while (p + 1 < end && !(b[p].toInt() == 0 && b[p + 1].toInt() == 0)) p += 2
            p += 2
        } else {
            while (p < end && b[p].toInt() != 0) p++
            p++
        }
        if (p >= end) return null
        return String(b, p, end - p, cs).trim('\u0000', '\uFEFF', '\n', '\r', ' ')
            .ifBlank { null }
    }

    /** TXXX 里放歌词时，描述字段一般写着 LYRICS */
    private fun decodeTxxx(b: ByteArray, off: Int, len: Int): String? {
        if (len < 6) return null
        val enc = b[off].toInt() and 0xff
        val cs = charsetOf(enc)
        val end = off + len
        var p = off + 1
        val descStart = p
        if (enc == 1 || enc == 2) {
            while (p + 1 < end && !(b[p].toInt() == 0 && b[p + 1].toInt() == 0)) p += 2
            val desc = String(b, descStart, p - descStart, cs)
            p += 2
            if (!desc.uppercase().contains("LYRIC")) return null
        } else {
            while (p < end && b[p].toInt() != 0) p++
            val desc = String(b, descStart, p - descStart, cs)
            p += 1
            if (!desc.uppercase().contains("LYRIC")) return null
        }
        if (p >= end) return null
        return String(b, p, end - p, cs).trim('\u0000', '\uFEFF', '\n', '\r', ' ')
            .ifBlank { null }
    }

    /* ---------------- FLAC / Vorbis Comment ---------------- */

    private fun parseFlac(b: ByteArray): String? {
        if (b.size < 8) return null
        if (String(b, 0, 4, Charsets.ISO_8859_1) != "fLaC") return null

        var p = 4
        while (p + 4 <= b.size) {
            val h = b[p].toInt() and 0xff
            val last = h and 0x80 != 0
            val type = h and 0x7f
            val len = ((b[p + 1].toInt() and 0xff) shl 16) or
                ((b[p + 2].toInt() and 0xff) shl 8) or (b[p + 3].toInt() and 0xff)
            val body = p + 4
            if (body + len > b.size) return null
            if (type == 4) return parseVorbisComment(b, body, len)
            if (last) return null
            p = body + len
        }
        return null
    }

    private fun parseVorbisComment(b: ByteArray, off: Int, len: Int): String? {
        val end = off + len
        var p = off
        if (p + 4 > end) return null
        val vlen = le32(b, p)
        p += 4 + vlen
        if (vlen < 0 || p + 4 > end) return null
        val count = le32(b, p)
        p += 4
        if (count < 0) return null

        var hit: String? = null
        for (i in 0 until count) {
            if (p + 4 > end) break
            val clen = le32(b, p)
            p += 4
            if (clen <= 0 || p + clen > end) break
            val s = String(b, p, clen, Charsets.UTF_8)
            p += clen
            val eq = s.indexOf('=')
            if (eq <= 0) continue
            val key = s.substring(0, eq).uppercase().replace(" ", "")
            if (key == "LYRICS" || key == "UNSYNCEDLYRICS" || key == "SYNCEDLYRICS") {
                hit = s.substring(eq + 1)
            }
        }
        return hit?.replace('\u0000', '\n')
    }

    /* ---------------- MP4 / M4A 的 ©lyr ---------------- */

    private fun parseMp4(cr: ContentResolver, uri: Uri): String? {
        val size = sizeOf(cr, uri)
        if (size < 32) return null
        val from = maxOf(0L, size - TAIL_LIMIT)
        val tail = readRange(cr, uri, from, (size - from).toInt().coerceAtMost(TAIL_LIMIT))
        if (tail.size < 32) return null

        val key0 = 0xA9.toByte()
        val keyL = 'l'.code.toByte()
        val keyY = 'y'.code.toByte()
        val keyR = 'r'.code.toByte()

        var i = 4
        while (i + 4 <= tail.size) {
            if (tail[i] == key0 && tail[i + 1] == keyL && tail[i + 2] == keyY && tail[i + 3] == keyR) {
                val text = mp4AtomText(tail, i - 4)
                if (!text.isNullOrBlank()) return text
            }
            i++
        }
        return null
    }

    /** 结构：[size][©lyr][ [size]['data'][type][locale][utf8 正文] ] */
    private fun mp4AtomText(b: ByteArray, atomStart: Int): String? {
        if (atomStart < 0 || atomStart + 12 > b.size) return null
        val inner = atomStart + 8           // 跳到子 atom（data）
        if (inner + 16 > b.size) return null
        val dataSize = be32(b, inner)
        if (dataSize <= 16) return null
        val textStart = inner + 16          // size + 'data' + type + locale
        val textEnd = minOf(b.size, inner + dataSize)
        if (textStart >= textEnd) return null
        return String(b, textStart, textEnd - textStart, Charsets.UTF_8)
            .replace("\u0000", "").trim().ifBlank { null }
    }
}
