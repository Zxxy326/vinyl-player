package io.github.zxxy326.vinylplayer

import android.app.Application

class VinylApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // 主线程建播放器，UI 与服务共用同一个实例
        PlayerHolder.ensure(this)
    }
}
