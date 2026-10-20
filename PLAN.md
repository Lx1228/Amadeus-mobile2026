# Amadeus Mobile — 手机版开工文档

> 本文件是新项目（amadeus-mobile）的开工依据，所有决策已在 2026-08-12 与用户确认。
> 开工流程：读本文件 → 按【开发步骤】逐项实现，**每完成一步先向用户确认再继续**。

## 一、项目定位

牧濑红莉栖数字伴侣的手机版（还原《命运石之门 0》凶真手机里的 Amadeus App）。
- 无登录、单角色（仅红莉栖）、首次启动填 API Key 存本地、打开即聊
- 纯聊天陪伴为主（不做代码/表格渲染）
- 极简单页：HTML + CSS + JS（不用框架），最后用 Capacitor 打包 APK

## 二、已确认功能清单（用户逐项拍板）

| 项 | 决定 |
|---|---|
| 模型供应商 | **只留小米 MiMo + DeepSeek**，去掉自定义；接口地址不暴露给用户，用默认 |
| 默认配置 | 小米：`https://api.xiaomimimo.com/v1`，模型 `mimo-v2.5-pro`（备选 `mimo-v2.5`）；DeepSeek：`https://api.deepseek.com/v1`，模型 `deepseek-v4-flash`（备选 `deepseek-v4-pro`） |
| API Key | 首次启动引导页填写，**两家供应商 Key 分开存**，存 localStorage，设置里可改 |
| 发送图片 | **进第一版**，图片按钮 → 系统相册 → 压缩（1024px/JPEG 0.85）→ 多模态发送，消息流缩略图 + 点击全屏。**仅小米 mimo-v2.5/mimo-v2.5-pro 支持；DeepSeek 纯文本不支持图片，选 DeepSeek 时图片按钮置灰/隐藏** |
| 语音通话 ASR | **先不加** |
| 语音合成 TTS | 第一版不加，V2 和语音通话一起上 |
| 多会话 | 砍，手机版单持续对话 |
| 导出聊天记录 | 保留（导出 TXT）。**手机 WebView 无 showSaveFilePicker，用 Blob 下载方案**（落到系统下载目录） |
| 背景音乐 | 砍 |
| 情绪标签 | 人设保留 `[emotion:xxx]`（驱动 Live2D 表情）；**显示时只显示中文部分，去掉 === 日语段** |
| 立绘 | **第一版直接上 Live2D**（不用静态占位），移植桌面版模型 + 逻辑 |
| 聊天记录存储 | 本地保存（localStorage，刷新不丢）。**图片消息只存文字，刷新后显示"（图片）"占位**（localStorage 5MB 装不下 base64 图） |

## 三、技术方案

- 纯静态三件套：`index.html` / `style.css` / `app.js`（+ `package.json` 仅 Capacitor 用）
- 直连 LLM：POST `{endpoint}/chat/completions`（OpenAI 兼容），无需中转服务器
- 流式：`stream: true`，SSE 解析 `choices[0].delta.content` 逐字渲染
- 图片：`<input type="file" accept="image/*">` → canvas 压缩 → `data:image/jpeg;base64,...` 作为 `image_url` 消息
- Key：localStorage；首次启动无 Key 时显示引导页
- 键盘交互：**`adjustPan` 模式**——键盘弹出时页面不动（立绘全屏不压缩），聊天窗（半透明 `meswin.png`）通过 `visualViewport` 浮动到键盘上方，键盘盖住立绘下半身但脸可见
- 回车行为：**回车 = 直接发送**（安卓输入法右下角"发送"键），屏幕发送键同时保留；单行输入（手机无 shift，不做换行）

## 四、界面（复刻桌面版，非微信式）

- 全屏背景 `bg.png`（1920x1080 缩放，居中）
- 全屏 Live2D 立绘（透明 canvas，底部对齐，覆盖全屏，不压缩）
- 顶部：红莉栖动画 Logo（`sprite_logo.png` 精灵动画 6x7 38帧 20fps）+ 右上角 ⚙ 设置
- 底部聊天窗：`meswin.png` 半透明游戏对话框式窗口（背景拉伸 100% 100%），含消息滚动区 + 输入区
- 消息：等宽字体（font-mono）小号，**无气泡框**（桌面版风格），用户靠右、红莉栖靠左，max-w 80%，带图片缩略图
- 输入区：透明居中 textarea（文字阴影、等宽字体、居中对齐）+ 左下角图片按钮 + 右侧发送键 + **`ring.png` 旋转光环动态光标**（跟随输入光标位置，textarea-caret 逻辑）
- 等待回复：消息区显示 `ring.png` 旋转光环动画（桌面版 loading 一致）
- 配色：桌面版黑灰白体系（#0a0a0a 底 / zinc 灰 / 文字阴影），Live2D canvas 透明
- 情绪驱动：`[emotion:xxx]` → Live2D 表情参数（Param8=angry / Param9=blush / ParamEyeRSmile=smile 等，桌面版 Live2D.tsx 逻辑）

## 五、Live2D（桌面版移植）

- 模型：`assets/live2d/kurisu/amadeusV1.model3.json`（Cubism 3+，moc3 + 物理 + 纹理 + idle 动作）
- 库：本地化三件套（离线可用，不依赖 CDN）：
  - `assets/vendor/live2dcubismcore.min.js`（官方 Cubism Core，须先加载）
  - `assets/vendor/pixi.min.js`（pixi.js@7.4.3）
  - `assets/vendor/cubism4.min.js`（pixi-live2d-display@0.5.0-beta cubism4）
- 逻辑移植（桌面版 Live2D.tsx）：
  - 手动眨眼状态机（4 秒间隔，0.1s 闭 0.05s 合 0.1s 开）
  - 待机循环动作（Idle[0]）
  - 情绪平滑驱动（emotionTarget 平滑插值）
  - **触摸跟随**：触摸/滑动时 `model.focus(x, y)` 眼睛跟随。**只绑立绘区和空白区，按钮/输入框操作时眼睛不动**
  - 嘴唇同步先不做（无 TTS）

## 六、请求体格式（从桌面版 route.ts 提取）

```json
{
  "model": "mimo-v2.5-pro",
  "messages": [
    { "role": "system", "content": "人设全文 + 记忆上下文 + 当前时间上下文" },
    { "role": "user", "content": "用户消息" }
  ],
  "max_tokens": 512,
  "stream": true
}
```
- 图片消息：`{ "role": "user", "content": [{ "type": "text", "text": "..." }, { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } }] }`
- 系统提示词时间上下文：`【当前时间】YYYY年M月D日（周X） HH:mm`（桌面版拼在 system 末尾）
- 历史消息：单持续对话，保留最近 N 条（建议 10 条）作 history
- DeepSeek 思考模式（v4-pro）流式会先推 `reasoning_content`，解析时忽略即可（桌面版逻辑已兼容）
- 人设见 `kurisu-personality.txt`（桌面版 personality.ts v19 原文）

## 七、文件结构

```
E:\amadeus-mobile\
├── index.html        # 聊天界面 + 首次引导 + 设置面板
├── style.css         # 世界线暗色主题（复刻桌面版）
├── app.js            # 流式对话 + Key 管理 + 发图 + 本地会话 + Live2D
├── kurisu-personality.txt  # 红莉栖人设（v19）
├── assets/
│   ├── bg.png / meswin.png / ring.png / sprite_logo.png  # 桌面版 UI 素材
│   ├── kurisu.png   # 静态立绘（欢迎/加载占位用）
│   ├── live2d/kurisu/  # Live2D 模型（moc3 + 纹理 + 动作）
│   └── vendor/      # live2dcubismcore.min.js + pixi.min.js + cubism4.min.js
├── package.json      # 仅 Capacitor 打包用
└── PLAN.md           # 本文档
```

## 八、开发步骤（每步完成后向用户确认）

1. 骨架 + 聊天界面（复刻桌面版 + Live2D 全屏立绘 + 触摸跟随 + 本地假对话演示）
2. Key 首次引导 + 设置面板（供应商 2 选 1 + 两家 Key 分开存 + 模型）
3. SSE 流式对话（红莉栖人设，只显示中文部分）
4. 发图片（图片按钮 + 系统相册 + 压缩 + 多模态 + 仅小米可用降级）
5. 本地会话保持（刷新不丢聊天记录，图片只存文字占位）+ 导出 TXT（Blob 下载）
6. 浏览器预览测试 → 真机浏览器预览 → Capacitor 打包 APK

## 九、补充决策（2026-08-12 开工确认，防坑清单）

1. **DeepSeek 不支持发图**：V4 API 纯文本，图片按钮仅小米模型可用，选 DeepSeek 时置灰/隐藏并提示
2. **两家 Key 分开存**：`amadeus_xiaomi_key` / `amadeus_deepseek_key` 分开，切换供应商各用各的
3. **CORS**：直连两家 API，开发时用本地 HTTP 服务预览（file:// 会被浏览器拦），实测若被跨域拦再处理
4. **图片存储**：聊天记录只存文字，图片消息刷新后显示"（图片）"占位；当前会话图片以 dataURL 参与请求
5. **键盘交互**：adjustPan + visualViewport，立绘不压缩，聊天窗上浮
6. **安全区**：顶部状态栏适配 safe-area-inset-top，锁竖屏
7. **导出 TXT**：Blob 下载（Android WebView 无 showSaveFilePicker）
8. **触摸跟随避开按钮**：只绑定立绘区和空白区
9. **欢迎语**：首次启动填完 Key 后红莉栖有开场白（桌面版 8 条问候语随机一条）
10. **错误提示**：Key 错 / 断网 / 流中断，明确提示可重试
11. **性能兜底**：立绘区全屏但 Live2D 仅在可见时渲染；设置里加"立绘显示/隐藏"开关
12. **回车直接发送**：键盘右下角发送键 = 回车，屏幕发送键保留，单行输入

## 十、参考（桌面版，只读参考不修改）

- 人设：`E:\Amadeus\amadeus\src\lib\personality.ts`
- 流式转发：`E:\Amadeus\amadeus\src\app\api\chat\route.ts`
- 图片压缩：`E:\Amadeus\amadeus\src\lib\image-compress.ts`
- 情绪标签：`E:\Amadeus\amadeus\src\lib\emotion.ts`
- 消息解析：`E:\Amadeus\amadeus\src\lib\message-parser.ts`
- Live2D 组件：`E:\Amadeus\amadeus\src\components\Live2D.tsx`
- 聊天界面：`E:\Amadeus\amadeus\src\components\Chat.tsx`
- 精灵动画：`E:\Amadeus\amadeus\src\components\SpritePlayer.tsx`
- 设置/导出：`E:\Amadeus\amadeus\src\components\Settings.tsx`
