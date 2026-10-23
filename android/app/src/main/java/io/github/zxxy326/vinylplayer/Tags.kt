package io.github.zxxy326.vinylplayer

import android.content.ContentResolver
import android.net.Uri
import java.io.Closeable
import java.io.FileInputStream
import java.nio.charset.Charset

/**
 * 标签解析（纯手写字节解析，不引第三方标签库，保持 APK 体积）
 *
 * 覆盖四种最常见的容器：
 *   - MP3  → 文件开头的 ID3v2.2/2.3/2.4（USLT 歌词、APIC 封面）
 *   - WAV  → RIFF 容器里的 `id3 ` 块，**位置在 data 之后、文件尾部**
 *   - FLAC → Vorbis Comment 的 LYRICS、PICTURE 块
 *   - M4A  → moov/ilst 里的 ©lyr
 *
 * WAV 是重点：很多人把整张专辑转成 wav，标签被写成尾部的一个 `id3 ` chunk，
 * 一个 40MB 的文件里它可能落在 39MB 处。所以这里不能「读前 N 字节」了事，
 * 必须按 RIFF chunk 头一路 seek 过去，只读需要的那一块。
 */
object Tags {

    /** 封面：字节 + 正确的 MIME（前端要拼 data URL，MIME 错了会显示不出来） */
    data class Art(val mime: String, val bytes: ByteArray)

    private const val HEAD_LIMIT = 3 * 1024 * 1024      // ID3 / FLAC 元数据一般都在头部
    private const val TAIL_LIMIT = 4 * 1024 * 1024      // MP4 的 moov 可能在文件末尾
    private const val ART_LIMIT = 12 * 1024 * 1024      // 单张封面上限
    private const val ID3_LIMIT = 32 * 1024 * 1024      // 单个 id3 chunk 上限

    /* ================= 对外 ================= */

    fun lyricsOf(cr: ContentResolver, uri: Uri): String {
        val out = withSrc(cr, uri) { s ->
            parseId3v2(id3Tag(s) ?: ByteArray(0))
                ?: parseFlac(s.at(0, HEAD_LIMIT))
                ?: parseMp4(s)
        }
        // 统一换行：USLT 里常见的是单独的 \r，直接给前端会糊成一行
        return (out ?: "").replace("\r\n", "\n").replace('\r', '\n').trim()
    }

    fun coverOf(cr: ContentResolver, uri: Uri): Art? = withSrc(cr, uri) { s ->
        val id3 = id3Tag(s)
        val fromId3 = if (id3 != null) parseId3Art(id3) else null
        fromId3 ?: parseFlacArt(s.at(0, HEAD_LIMIT))
    }

    /* ================= 可 seek 的字节源 ================= */

    private class Src(cr: ContentResolver, uri: Uri) : Closeable {
        private val pfd = try {
            cr.openFileDescriptor(uri, "r")
        } catch (_: Throwable) {
            null
        }
        private val fis: FileInputStream? =
            if (pfd != null) try { FileInputStream(pfd.fileDescriptor) } catch (_: Throwable) { null } else null
        val size: Long = try { pfd?.statSize ?: 0L } catch (_: Throwable) { 0L }

        /** 从 offset 读 len 字节，读不满就返回实际读到的（文件尾自动截断） */
        fun at(offset: Long, len: Int): ByteArray {
            val f = fis ?: return ByteArray(0)
            if (len <= 0 || offset < 0) return ByteArray(0)
            val avail = if (size > 0) size - offset else len.toLong()
            val want = minOf(len.toLong(), avail).toInt()
            if (want <= 0) return ByteArray(0)
            return try {
                f.channel.position(offset)
                val buf = ByteArray(want)
                var read = 0
                while (read < want) {
                    val n = f.read(buf, read, want - read)
                    if (n <= 0) break
                    read += n
                }
                if (read == want) buf else buf.copyOf(read)
            } catch (_: Throwable) {
                ByteArray(0)
            }
        }

        override fun close() {
            try { fis?.close() } catch (_: Throwable) {}
            try { pfd?.close() } catch (_: Throwable) {}
        }
    }

    private inline fun <T> withSrc(cr: ContentResolver, uri: Uri, block: (Src) -> T?): T? =
        try {
            val src = Src(cr, uri)
            try {
                if (src.size <= 0) null else block(src)
            } finally {
                src.close()
            }
        } catch (_: Throwable) {
            null
        }

    /* ================= 小工具 ================= */

    private fun be32(b: ByteArray, o: Int): Int =
        ((b[o].toInt() and 0xff) shl 24) or ((b[o + 1].toInt() and 0xff) shl 16) or
            ((b[o + 2].toInt() and 0xff) shl 8) or (b[o + 3].toInt() and 0xff)

    private fun le32(b: ByteArray, o: Int): Int =
        (b[o].toInt() and 0xff) or ((b[o + 1].toInt() and 0xff) shl 8) or
            ((b[o + 2].toInt() and 0xff) shl 16) or ((b[o + 3].toInt() and 0xff) shl 24)

    /** 无符号小端，用于 chunk / 帧长度（不能让它变负） */
    private fun le32u(b: ByteArray, o: Int): Long = le32(b, o).toLong() and 0xFFFFFFFFL

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

    private fun indexOfZero(b: ByteArray, from: Int, end: Int): Int {
        var i = from
        while (i < end) {
            if (b[i].toInt() == 0) return i
            i++
        }
        return -1
    }

    /** 标签里写的 MIME 经常是空的，按文件头兜底 */
    private fun normalizeMime(mime: String, data: ByteArray): String {
        val m = mime.lowercase()
        if (m.startsWith("image/")) return m
        if (data.size >= 3 && data[0] == 0xFF.toByte() && data[1] == 0xD8.toByte()) return "image/jpeg"
        if (data.size >= 8 && data[0] == 0x89.toByte() && data[1] == 'P'.code.toByte()) return "image/png"
        if (data.size >= 12 && data[0] == 'R'.code.toByte() && data[8] == 'W'.code.toByte()) return "image/webp"
        if (data.size >= 6 && data[0] == 'G'.code.toByte() && data[1] == 'I'.code.toByte()) return "image/gif"
        return "image/jpeg"
    }

    /* ================= 定位 ID3 标签字节 ================= */

    /**
     * 返回「从 ID3 头开始的完整标签字节」。
     *  - RIFF/WAVE：扫 chunk，找到 `id3 `/`ID3 ` 块，只读这一块
     *  - 其它（MP3）：文件头就是 ID3，按 syncsafe 长度读
     */
    private fun id3Tag(s: Src): ByteArray? {
        val head = s.at(0, 12)
        if (head.size >= 12 &&
            String(head, 0, 4, Charsets.ISO_8859_1) == "RIFF" &&
            String(head, 8, 4, Charsets.ISO_8859_1) == "WAVE"
        ) {
            var p = 12L
            var guard = 0
            while (p + 8 <= s.size && guard++ < 256) {
                val h = s.at(p, 8)
                if (h.size < 8) return null
                val id = String(h, 0, 4, Charsets.ISO_8859_1).trim()
                val sz = le32u(h, 4)
                val body = p + 8
                if (id.equals("id3", true)) {
                    if (sz <= 0 || sz > ID3_LIMIT) return null
                    return s.at(body, sz.toInt())
                }
                if (sz <= 0) return null                 // 0 长度块会让指针原地打转
                p = body + sz + (sz and 1L)              // chunk 按偶数字节对齐
            }
            return null
        }

        if (head.size >= 10 &&
            head[0] == 'I'.code.toByte() && head[1] == 'D'.code.toByte() && head[2] == '3'.code.toByte()
        ) {
            val sz = syncsafe(head, 6).toLong()
            if (sz <= 0 || sz > ID3_LIMIT) return null
            return s.at(0, (10 + sz).toInt())
        }
        return null
    }

    /* ================= ID3v2：歌词 ================= */

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

    /* ================= ID3v2：封面 ================= */

    private fun parseId3Art(b: ByteArray): Art? {
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
            if (id == "APIC") return decodeApic(b, body, fs)
            if (id == "PIC") return decodePic(b, body, fs)
            p = body + fs
        }
        return null
    }

    /** enc(1) + MIME(0 结尾) + 描述(0 结尾) + 图片字节 */
    private fun decodeApic(b: ByteArray, off: Int, len: Int): Art? {
        val end = off + len
        if (len < 6) return null
        val enc = b[off].toInt() and 0xff
        var p = off + 1
        val mEnd = indexOfZero(b, p, end)
        if (mEnd < 0) return null
        val mime = String(b, p, mEnd - p, Charsets.ISO_8859_1)
        p = mEnd + 1

        if (enc == 1 || enc == 2) {
            while (p + 1 < end && !(b[p].toInt() == 0 && b[p + 1].toInt() == 0)) p += 2
            p += 2
        } else {
            val dEnd = indexOfZero(b, p, end)
            if (dEnd < 0) return null
            p = dEnd + 1
        }
        if (p >= end) return null
        val data = b.copyOfRange(p, end)
        if (data.isEmpty() || data.size > ART_LIMIT) return null
        return Art(normalizeMime(mime, data), data)
    }

    /** ID3v2.2 的 PIC：enc(1) + 3 字符格式 + 描述(0 结尾) + 字节 */
    private fun decodePic(b: ByteArray, off: Int, len: Int): Art? {
        val end = off + len
        if (len < 6) return null
        val enc = b[off].toInt() and 0xff
        val fmt = String(b, off + 1, 3, Charsets.ISO_8859_1).uppercase()
        var p = off + 4
        if (enc == 1 || enc == 2) {
            while (p + 1 < end && !(b[p].toInt() == 0 && b[p + 1].toInt() == 0)) p += 2
            p += 2
        } else {
            val dEnd = indexOfZero(b, p, end)
            if (dEnd < 0) return null
            p = dEnd + 1
        }
        if (p >= end) return null
        val data = b.copyOfRange(p, end)
        if (data.isEmpty() || data.size > ART_LIMIT) return null
        val mime = if (fmt.contains("PNG")) "image/png" else "image/jpeg"
        return Art(normalizeMime(mime, data), data)
    }

    /* ================= FLAC / Vorbis Comment ================= */

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

    private fun parseFlacArt(b: ByteArray): Art? {
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
            if (type == 6) parseFlacPicture(b, body, len)?.let { return it }
            if (last) return null
            p = body + len
        }
        return null
    }

    /** type(4) + mimeLen(4) + mime + descLen(4) + desc + w/h/depth/colors(16) + dataLen(4) + data */
    private fun parseFlacPicture(b: ByteArray, off: Int, len: Int): Art? {
        val end = off + len
        var p = off
        if (p + 8 > end) return null
        p += 4
        val mimeLen = be32(b, p); p += 4
        if (mimeLen < 0 || p + mimeLen > end) return null
        val mime = String(b, p, mimeLen, Charsets.ISO_8859_1); p += mimeLen
        if (p + 4 > end) return null
        val descLen = be32(b, p); p += 4
        if (descLen < 0 || p + descLen > end) return null
        p += descLen
        if (p + 20 > end) return null
        p += 16
        val dataLen = be32(b, p); p += 4
        if (dataLen <= 0 || p + dataLen > end) return null
        val data = b.copyOfRange(p, p + dataLen)
        if (data.size > ART_LIMIT) return null
        return Art(normalizeMime(mime, data), data)
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

    /* ================= MP4 / M4A 的 ©lyr ================= */

    private fun parseMp4(s: Src): String? {
        val size = s.size
        if (size < 32) return null
        val from = maxOf(0L, size - TAIL_LIMIT)
        val tail = s.at(from, (size - from).toInt().coerceAtMost(TAIL_LIMIT))
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
        val inner = atomStart + 8
        if (inner + 16 > b.size) return null
        val dataSize = be32(b, inner)
        if (dataSize <= 16) return null
        val textStart = inner + 16
        val textEnd = minOf(b.size, inner + dataSize)
        if (textStart >= textEnd) return null
        return String(b, textStart, textEnd - textStart, Charsets.UTF_8)
            .replace("\u0000", "").trim().ifBlank { null }
    }
}
