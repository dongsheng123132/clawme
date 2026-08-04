#!/usr/bin/env bash
# 在纯 ASCII 路径下跑影核协议层的 JVM 测试，然后把结果取回仓库。
#
# 为什么需要这个脚本：本仓库目录名含中文（clawme-ai远程工具-手机版）。
# Gradle 的 test worker 是另起的 JVM，在 Windows 上从非 ASCII 项目路径加载
# 测试类会抛 ClassNotFoundException。已验证与下列因素**无关**：
#   * Android 插件（纯 Kotlin/JVM 的 :protocol 模块一样挂）
#   * classpath 长度 / pathing jar
#   * -Dfile.encoding / -Dsun.jnu.encoding（daemon 和 worker 两侧都试过）
#   * 目录 junction（Gradle 会把路径归一化回真实路径）
# 编译和打 APK 在中文路径下完全正常，只有 test worker 加载类这一步不行。
#
# 用法：
#   ./run-protocol-tests.sh              # 跑 :protocol:test
#   ./run-protocol-tests.sh :app:assembleDebug   # 也可以指定别的任务

set -euo pipefail

ANDROID_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$ANDROID_DIR")"
TASKS=("${@:-:protocol:test}")

WORK_BASE="${TEMP:-${TMPDIR:-/tmp}}"
WORK="$WORK_BASE/clawme-shadowcore-test"

if [[ "$WORK" =~ [^[:print:]] || "$WORK" == *[^\ -~]* ]]; then
  echo "镜像目录本身含非 ASCII 字符：$WORK" >&2
  echo "请设置 TEMP 到一个纯 ASCII 路径后重试。" >&2
  exit 2
fi

echo "镜像 → $WORK"
rm -rf "$WORK"
mkdir -p "$WORK"

# 只带源码和 fixture，不带 build 产物，避免把中文路径的绝对路径缓存一起搬过去。
cp -r "$ANDROID_DIR" "$WORK/android"
cp -r "$REPO_ROOT/fixtures" "$WORK/fixtures"
rm -rf "$WORK/android/.gradle" "$WORK/android/app/build" "$WORK/android/protocol/build"

status=0
( cd "$WORK/android" && ./gradlew "${TASKS[@]}" ) || status=$?

# 把测试报告取回仓库，让失败详情留在你实际工作的地方。
for module in protocol app; do
  src="$WORK/android/$module/build/test-results"
  if [[ -d "$src" ]]; then
    mkdir -p "$ANDROID_DIR/$module/build"
    rm -rf "$ANDROID_DIR/$module/build/test-results"
    cp -r "$src" "$ANDROID_DIR/$module/build/test-results"
    echo "测试结果 → android/$module/build/test-results"
  fi
done

exit "$status"
