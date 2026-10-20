#!/usr/bin/env bash
# Amadeus Mobile - Android 构建环境变量（每次构建前 source 此文件）
# 用法: source android-env.sh && cd android && ./gradlew assembleDebug

export JAVA_HOME="E:/amadeus-mobile/tools/jdk-21.0.12+8"
export ANDROID_HOME="E:/amadeus-mobile/tools/android-sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/build-tools/34.0.0:$PATH"

echo "JAVA_HOME=$JAVA_HOME"
echo "ANDROID_HOME=$ANDROID_HOME"
java -version 2>&1 | head -1
