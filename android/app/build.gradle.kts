plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.github.zxxy326.vinylplayer"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.zxxy326.vinylplayer"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "2.0.0"
        resourceConfigurations += listOf("zh", "en")
    }

    signingConfigs {
        create("release") {
            val ks = System.getenv("VP_KEYSTORE") ?: "${rootDir}/keystore/vinyl-player.jks"
            val f = file(ks)
            if (f.exists()) {
                storeFile = f
                storePassword = System.getenv("VP_STORE_PASS") ?: "vinylplayer"
                keyAlias = System.getenv("VP_KEY_ALIAS") ?: "vinylplayer"
                keyPassword = System.getenv("VP_KEY_PASS") ?: "vinylplayer"
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            signingConfig = if (signingConfigs.getByName("release").storeFile != null) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources.excludes += setOf("META-INF/*.kotlin_module")
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.media3:media3-exoplayer:1.4.1")
    implementation("androidx.media3:media3-session:1.4.1")
    implementation("androidx.media3:media3-common:1.4.1")
}
