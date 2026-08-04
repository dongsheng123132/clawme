plugins {
    `java-library`
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

/**
 * 影核协议层：纯 Kotlin/JVM，不依赖任何 Android API。
 *
 * 独立成模块不是为了好看 —— 是让"协议层不碰 Android"从一条口头约定变成
 * 构建强制的事实：这里根本没有 android.jar，谁不小心 import 了 android.*
 * 会当场编译失败。附带的好处是这层能在普通 JVM 上毫秒级测完，
 * 不用模拟器、不用设备、不用截图。
 */
java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    // api 而不是 implementation：JsonObject 出现在 SyncEvent.payload 这个公开契约上，
    // 调用方要能读事件负载，就必须看得见这个类型。
    api(libs.kotlinx.serialization.json)
    testImplementation(libs.junit)
}

tasks.withType<Test>().configureEach {
    testLogging {
        events("passed", "failed", "skipped")
    }
}
