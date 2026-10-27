# Amadeus Mobile

基于《命运石之门》牧濑红莉栖人设的 AI 数字伴侣 **手机版**。

> 本项目与桌面版（Electron/Tauri + 本地语音引擎）是**两个独立项目**，代码不共享，各自独立演进。
> 桌面版追求本地离线与最高音质，手机版追求「随时打开就能聊」，所以语音走云端 API。

## 下载

最新安装包见 [Releases](https://github.com/Lx1228/Amadeus-mobile2026/releases/latest)（当前 v1.0.12）。

## 功能

- **Live2D 立绘**：全屏立绘、触摸跟随、眨眼、呼吸、5 种情绪（neutral / blush / angry / smile / sad）
- **文字对话**：支持图片输入（多模态）、会话保存与导出、上下文压缩
- **语音输出**：阿里云百炼 `cosyvoice-v3.5-flash` 合成，首次使用时自动复刻红莉栖音色
- **主动消息**：按空闲时间主动发起对话

## 技术栈

| 层 | 选型 |
|---|---|
| 容器 | Capacitor 8（Android） |
| 前端 | 原生 JavaScript，无框架、无构建步骤 |
| 立绘 | Live2D Cubism 4 + pixi-live2d-display + PIXI |
| 对话模型 | 小米 MiMo（`mimo-v2.6-flash` / `mimo-v2.6-pro`）、DeepSeek（`deepseek-flash`） |
| 语音合成 | 阿里云百炼 `cosyvoice-v3.5-flash`（0.8 元/万字符） |
| 语音复刻 | 阿里云百炼 `voice-enrollment`（创建音色免费） |

## 目录结构

```
.
├── app.js                  # 主逻辑（立绘 / 对话 / TTS / 设置）
├── index.html              # 页面骨架
├── style.css               # 样式
├── kurisu-personality.txt  # 人设提示词
├── assets/                 # 图片、Live2D 模型、音色样本
├── www/                    # 发布目录（app.js / index.html / style.css 的副本）
├── serve.py                # 本地预览服务器（带 DashScope 调试代理）
├── android/                # Capacitor 生成的 Android 工程
└── package.json
```

> **改代码注意**：根目录的 `app.js` / `index.html` / `style.css` 是源文件，
> 改完必须同步到 `www/`，再执行 `npx cap sync android`，否则打出来的包还是旧代码。

## 构建

```bash
# 1. 安装依赖
npm install

# 2. 同步网页资源到 Android 工程
npx cap sync android

# 3. 编译 APK（需要 JDK 21 + Android SDK）
export JAVA_HOME=/path/to/jdk-21
export ANDROID_HOME=/path/to/android-sdk
cd android && ./gradlew assembleDebug
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk`

## 配置

所有 API Key 都由使用者在 App 内的「设置」里填写，**保存在设备本地 `localStorage`，仓库里没有任何 Key**。

需要三样东西：

1. **小米 MiMo API Key** — https://platform.xiaomimimo.com
2. **DeepSeek API Key**（可选）— https://platform.deepseek.com
3. **阿里云百炼 API Key**（语音功能需要）— https://bailian.console.aliyun.com （华北2 北京地域）

### 语音音色复刻说明

- 复刻音色绑定 `target_model`，**换模型必须重新复刻**，不能跨模型复用
- 复刻需要一段**公网可访问**的 10~20 秒音色样本（本项目默认用 `assets/voice_sample.mp3` 的托管地址）
- 音色存在**各自账号**下：每个使用者填自己的 Key，App 会在他本人账号下自动复刻一份（复刻免费，只有合成计费）

## 声明

- 本项目为非官方同人作品，与《命运石之门》版权方无任何关联，未获任何授权
- 项目内 Live2D 模型、音色样本等素材均来自网络，版权归原作者所有，本人不主张任何权利
- 仅供个人学习交流，禁止商用、二次分发或单独提取素材
- 如有版权问题请联系删除，本人不承担使用本项目产生的任何责任

## 致谢

- 红莉栖 Live2D 模型来自开源社区，感谢原作者
- 技术依赖：[Capacitor](https://capacitorjs.com)、[PIXI](https://pixijs.com)、[pixi-live2d-display](https://github.com/guansss/pixi-live2d-display)、[Live2D Cubism SDK](https://www.live2d.com/sdk/cubism/)
- 云服务：小米 MiMo、DeepSeek、阿里云百炼
- 反馈与交流：QQ 群 **1046949762**

## License

本项目代码以 MIT 协议开源（见 `LICENSE`）。
第三方素材（Live2D 模型、角色形象等）不在 MIT 协议覆盖范围内。
