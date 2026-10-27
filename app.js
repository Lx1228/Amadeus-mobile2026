/* ============================================================
   Amadeus Mobile — app.js（第 1 步：界面骨架 + Live2D + 本地假对话）
   - Live2D 全屏立绘（触摸跟随 / 眨眼 / 情绪 / 待机动作）
   - 精灵动画（顶部 Logo + 动态光标 ring + loading ring）
   - 消息渲染 + 本地假对话演示（不接 API，第 3 步替换为 SSE）
   ============================================================ */

"use strict";

// ================= 常量 =================
const PERSONALITY_FILE = "kurisu-personality.txt";
const LIVE2D_MODEL = "assets/live2d/kurisu/amadeusV1.model3.json";

// 供应商配置（只留小米 + DeepSeek，接口地址不暴露编辑入口）
// 2026-10-19 对齐官方文档（platform.xiaomimimo.com / api-docs.deepseek.com）：
// - 小米：mimo-v2.5-pro / mimo-v2.5 于 2026.10.21 10:00 下线 → 换 V2.6 系列（全模态理解，均支持图片）
// - DeepSeek：deepseek-v4-flash / v4-pro 旧名已由 V4.1-Flash-1017 接管 → 统一用 deepseek-flash（原生多模态）
// - 两家现行模型都支持图片输入，不再按模型区分
const PROVIDERS = {
  xiaomi: {
    name: "小米 MiMo",
    endpoint: "https://api.xiaomimimo.com/v1",
    models: [
      { id: "mimo-v2.6-pro", supportsImage: true },
      { id: "mimo-v2.6-flash", supportsImage: true },
    ],
  },
  deepseek: {
    name: "DeepSeek",
    endpoint: "https://api.deepseek.com/v1",
    models: [
      { id: "deepseek-flash", supportsImage: true },
    ],
  },
};
const DEFAULT_PROVIDER = "xiaomi";
// 2026-10-19：小米默认模型用 flash（用户指定，比 pro 便宜一半以上：¥1/M 输入 ¥2/M 输出 vs ¥3/¥6）
const DEFAULT_MODEL = { xiaomi: "mimo-v2.6-flash", deepseek: "deepseek-flash" };
// 一次性迁移标记：把已存的"pro 默认"切到 flash。只切一次，之后用户在设置里手动选回 pro 不会被反复覆盖
const XIAOMI_FLASH_MIGRATED_KEY = "amadeus_xiaomi_flash_default_v1";

/** 当前模型是否支持图片 */
function currentModelSupportsImage() {
  const provider = STORE.provider;
  const m = PROVIDERS[provider].models.find((x) => x.id === STORE.model(provider));
  return !!(m && m.supportsImage);
}

/** 支持图片的模型提示文案（2026-10-19 起两家现行模型均支持图片，恒返回空） */
function currentModelImageHint() {
  return "";
}

// ================= Key / 配置存储 =================
// 两家 Key 分开存（localStorage），避免切换供应商互相覆盖
const STORE = {
  get provider() { return localStorage.getItem("amadeus_provider") || DEFAULT_PROVIDER; },
  set provider(v) { localStorage.setItem("amadeus_provider", v); },
  key(provider) { return localStorage.getItem(`amadeus_key_${provider}`) || ""; },
  setKey(provider, v) { localStorage.setItem(`amadeus_key_${provider}`, v); },
  // 读模型时校验：本地存的模型名若已下线/不在清单里，自动迁到当前默认模型
  // （否则旧设备升级后会一直用已经 404 的旧模型名，表现为"对话没反应"）
  model(provider) {
    const saved = localStorage.getItem(`amadeus_model_${provider}`) || "";
    const list = (PROVIDERS[provider] && PROVIDERS[provider].models) || [];
    // 小米：默认从 pro 换 flash（一次性）。做完打标记，用户之后主动选 pro 就尊重他的选择
    if (provider === "xiaomi" && saved === "mimo-v2.6-pro" && !localStorage.getItem(XIAOMI_FLASH_MIGRATED_KEY)) {
      localStorage.setItem(XIAOMI_FLASH_MIGRATED_KEY, "1");
      localStorage.setItem(`amadeus_model_${provider}`, DEFAULT_MODEL.xiaomi);
      return DEFAULT_MODEL.xiaomi;
    }
    if (saved && list.some((m) => m.id === saved)) return saved;
    const fallback = DEFAULT_MODEL[provider] || (list[0] ? list[0].id : "");
    if (fallback && saved !== fallback) localStorage.setItem(`amadeus_model_${provider}`, fallback);
    return fallback;
  },
  setModel(provider, v) { localStorage.setItem(`amadeus_model_${provider}`, v); },
  get l2dEnabled() { return localStorage.getItem("amadeus_l2d_enabled") !== "0"; },
  set l2dEnabled(v) { localStorage.setItem("amadeus_l2d_enabled", v ? "1" : "0"); },
};

/** 当前生效的完整配置 */
function currentConfig() {
  const p = STORE.provider;
  return {
    provider: p,
    endpoint: PROVIDERS[p].endpoint,
    apiKey: STORE.key(p),
    model: STORE.model(p),
    supportsImage: currentModelSupportsImage(),
  };
}

/** 是否已配置 Key（两个供应商任一有 Key 即视为已配置，未配置则显示引导） */
function hasAnyKey() {
  return Object.keys(PROVIDERS).some((p) => STORE.key(p).trim() !== "");
}

// 眨眼频率（秒）——与桌面版 Live2D.tsx 一致
const BLINK_INTERVAL_S = 4;
const BLINK_CLOSE_S = 0.1;
const BLINK_CLOSED_S = 0.05;
const BLINK_OPEN_S = 0.1;

// 模型缩放基准（桌面版：基准高 900 对应 scale 0.3）
const BASE_HEIGHT = 900;
const BASE_SCALE = 0.3;

// ================= 工具函数 =================

/** 某一行里假名的"密度"（用来判断这行是不是日语） */
function lineKanaRatio(line) {
  const s = String(line || "");
  const kana = (s.match(/[\u3040-\u30ff]/g) || []).length;
  // 去掉空白、数字和常见标点后的有效字符数
  const meaningful = s.replace(/[\s0-9。、！？!?.,，…—\-~〜（）()「」『』【】:：;；"'“”‘’]/g, "").length;
  return { kana, meaningful, ratio: meaningful ? kana / meaningful : 0 };
}

/**
 * 智能切分"中文 / 日语"（2026-10-27）。
 *
 * 模型偶尔不输出 ===，而是把日语用括号直接跟在中文后面（同一段或下一行）：
 *   （愣住，声音微颤）……你、你这结果根本不对吧，笨蛋……
 *   （声を震わせて）……えっ、ちょっと、その結果、明らかに間違ってるじゃない。
 * 旧逻辑只认 ===，于是①整段中日混排全显示出来 ②没有日语可念 ③情绪标签也没了。
 *
 * 三级兜底：① 标准 === 分隔 → ② 按行找"假名密度突变" → ③ 单行内找连续假名块。
 */
function splitBilingual(raw) {
  const t = String(raw || "").replace(/\[emotion:[^\]]*\]?/g, "").trim();
  if (!t) return { zh: "", ja: "" };

  // ① 标准 === 分隔
  const idx = t.indexOf("===");
  if (idx !== -1) {
    const zh = t.slice(0, idx).trim();
    const ja = t.slice(idx + 3).trim();
    if (ja) return { zh, ja };
  }

  // ② 按行切：找到第一行"假名密度高"的行，之前的算中文、之后的算日语
  const lines = t.split(/\n/);
  for (let i = 1; i < lines.length; i++) {
    const { kana, meaningful, ratio } = lineKanaRatio(lines[i]);
    if (meaningful >= 5 && kana >= 3 && ratio > 0.2) {
      return { zh: lines.slice(0, i).join("\n").trim(), ja: lines.slice(i).join("\n").trim() };
    }
  }

  // ③ 单行混排：从第一个"连续 2 个以上假名"处切开，并回退到最近的标点边界
  const m = t.match(/[\u3040-\u30ff]{2,}/);
  if (m && m.index > 10) {
    let cut = m.index;
    const head = t.slice(0, cut);
    const lastPunct = Math.max(
      head.lastIndexOf("。"), head.lastIndexOf("！"), head.lastIndexOf("？"),
      head.lastIndexOf("…"), head.lastIndexOf("\n"),
      head.lastIndexOf("）"), head.lastIndexOf(")")
    );
    if (lastPunct > 0 && lastPunct > cut - 40) cut = lastPunct + 1;
    const zh = t.slice(0, cut).trim();
    const ja = t.slice(cut).trim();
    if (zh && ja && JA_KANA_RE.test(ja)) return { zh, ja };
  }

  return { zh: t, ja: "" };
}

/** 从 LLM 原始回复中提取显示文本（只留中文部分，去情绪标签和日语段） */
function displayText(raw) {
  return splitBilingual(raw).zh;
}

/**
 * 关闭深度思考（2026-10-27 提速关键）。
 * 小米 MiMo v2.6 系列（mimo-v2.6-flash / pro / pro-ultraspeed）**默认开启深度思考**：
 * 流式响应先返回一大段 reasoning_content（思考过程），思考完才输出 content。
 * 手机端只渲染 content，用户感知就是"点了发送后卡好几秒才开始出字"。
 * 闲聊不需要思维链，显式关掉；其他供应商（DeepSeek 等）不认这个字段，不传即可。
 */
function noThinking(cfg) {
  return cfg && cfg.provider === "xiaomi" ? { thinking: { type: "disabled" } } : {};
}

/** 从原始回复中提取情绪标签
 *  2026-10-27：旧正则锚定开头 `^\[emotion:`，模型只要在标签前多打一个换行/空格就匹配不到
 *  → 情绪永远是 neutral → 语音永远不传指令 → 听感平淡。现在去掉锚点、允许空白、忽略大小写。 */
function emotionOf(raw) {
  const m = String(raw || "").match(/\[emotion:\s*(neutral|blush|angry|smile|sad)\s*\]/i);
  return m ? m[1].toLowerCase() : "neutral";
}

/**
 * 推断情绪（2026-10-27）：标签优先，没有标签时**从文字内容推断**。
 *
 * 为什么需要：关掉深度思考后（提速），模型输出格式的遵守度会下降，经常不给 [emotion:xxx] 标签
 * → 表情完全不动、语音也没有语气。用户反馈"老版本会根据文字内容触发表情"，说的就是这个需求。
 *
 * 推断依据（按可靠度排序）：
 *   1. 模型给的 [emotion:xxx] 标签（最准）
 *   2. 动作括号里的描述 ——（脸红）（别过脸）（轻笑）（叹气）这类在人设里是被要求写的，最可靠
 *   3. 正文里的语气词/口癖 —— 红莉栖的"笨蛋""别误会""哼"之类
 */
function inferEmotion(raw) {
  const tagged = emotionOf(raw);
  if (tagged !== "neutral") return tagged; // 有标签就用标签

  const rawStr = String(raw || "");
  // 只要出现过 [emotion:neutral] 这种显式标签，就尊重模型给的 neutral
  if (/\[emotion:\s*neutral\s*\]/i.test(rawStr)) return "neutral";

  const text = displayText(raw);
  const actions = (text.match(/（[^）]{0,40}）|\([^)]{0,40}\)/g) || []).join("");

  // ① 动作括号（人设要求写，语义明确）
  if (/脸红|害羞|别过脸|移开视线|声音变小|声音微颤|低下头|慌乱|心跳|磕巴|结巴/.test(actions)) return "blush";
  if (/笑|眯|扬唇|弯眼|咧嘴/.test(actions)) return "smile";
  if (/叹|沉默|垂眼|低落|失落|闷|摇头/.test(actions)) return "sad";
  if (/皱眉|瞪|抱臂|皱眉|咬牙|冷哼|扶额/.test(actions)) return "angry";

  // ② 正文语气（红莉栖的标志性表达）
  if (/笨蛋|蠢|烦|搞什么|你有病|喂[，！]|哼[！。]|说什么呢/.test(text)) return "angry";
  if (/太好了|真棒|不错嘛|有意思|有趣|总算/.test(text)) return "smile";
  if (/对不起|抱歉|没办法|算了|无所谓|随便你/.test(text)) return "sad";
  if (/别误会|才不是|不是说过|谁要|才没有/.test(text)) return "blush";

  return "neutral";
}

/**
 * 过滤 TTS 文本：日语段里可能混入中文句（模型输出不规范，=== 后偶尔夹中文）。
 * 按句末标点拆分，只保留含假名的句子（日语必然带假名助词/词尾，中文句无假名 → 剔除）。
 * 避免 Japanese 模式硬念中文句 → "一半日文一半奇怪中文"。
 */
const JA_KANA_RE = /[\u3040-\u30ff\u31f0-\u31ff]/;
function filterJapanese(text) {
  const s = String(text || "");
  if (!s) return "";
  if (!/[。！？!?\n]/.test(s)) return JA_KANA_RE.test(s) ? s : ""; // 整句无标点：含假名即保留
  // split 带捕获组保留分隔符：text/标点 交替
  const parts = s.split(/([。！？!?\n])/);
  let kept = "";
  for (let i = 0; i < parts.length; i += 2) {
    const chunk = (parts[i] || "").trim();
    const punct = parts[i + 1] || "";
    if (chunk && JA_KANA_RE.test(chunk)) kept += chunk + punct;
  }
  return kept.trim();
}

/**
 * 从原始回复中提取 TTS 文本 + 该用什么语言念。返回 { text, lang }，lang 为 "ja" | "zh"。
 *
 * 2026-10-26 修复「奇怪口音的中文」：
 * 旧逻辑纯中文时回落到中文文本，但合成固定 language_hints=["ja"] →
 * CosyVoice 拿日语发音规则念汉字，听起来像"日本人读中文"。
 * 电脑版（Amadeus/src/lib/message-parser.ts）的做法是纯中文直接跳过 TTS；
 * 手机版改成按文本实际语种切换发音规则 —— 既不出怪口音，也不会整条静音。
 */
function getTTSText(raw) {
  const { zh, ja } = splitBilingual(raw);
  // 有独立日语段（=== 或智能切分出来的）→ 用它，过滤掉混进来的中文句
  if (ja) {
    const filtered = filterJapanese(ja);
    if (filtered) return { text: filtered, lang: "ja" };
  }
  // 中文段里可能夹着日语片段（格式乱时）→ 优先念其中的日语
  const zhFiltered = filterJapanese(zh);
  if (zhFiltered) return { text: zhFiltered, lang: "ja" };
  // 纯中文：用中文发音规则念，不再用日语腔硬念
  return { text: zh, lang: "zh" };
}

/** 获取当前时间上下文（桌面版 route.ts 同款格式） */
function nowContext() {
  const now = new Date();
  const wd = ["日", "一", "二", "三", "四", "五", "六"][now.getDay()];
  const hm = `${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`;
  return `【当前时间】${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日（周${wd}） ${hm}\n重要：上述是真实当前时间。判断用户行为是否合时宜（如深夜别催早起、下午别问吃没吃宵夜），不要基于过时记忆假设用户现在的状态。`;
}

// ================= 精灵动画（SpritePlayer） =================
// 用法：SpritePlayer(canvas, src, { rows, columns, fps, totalFrames, loop })
function SpritePlayer(canvas, src, opts) {
  if (!canvas || !canvas.getContext) return null;
  const ctx = canvas.getContext("2d");
  const rows = opts.rows, columns = opts.columns;
  const fps = opts.fps, totalFrames = opts.totalFrames;
  const loop = opts.loop === undefined ? 0 : opts.loop;

  const img = new Image();
  img.src = src;
  let frameW = 0, frameH = 0;
  let frame = 0, lastTime = 0, raf = null, started = false;

  const animate = (time) => {
    if (time - lastTime >= 1000 / fps) {
      lastTime = time;
      ctx.clearRect(0, 0, frameW, frameH);
      const fx = frame % columns;
      const fy = Math.floor(frame / columns);
      ctx.drawImage(img, fx * frameW, fy * frameH, frameW, frameH, 0, 0, frameW, frameH);
      frame++;
      if (frame >= totalFrames) {
        frame = loop === 0 ? 0 : totalFrames - 1;
      }
    }
    raf = requestAnimationFrame(animate);
  };

  img.onload = () => {
    frameW = img.width / columns;
    frameH = img.height / rows;
    canvas.width = frameW;
    canvas.height = frameH;
    if (!started) { started = true; raf = requestAnimationFrame(animate); }
  };

  return {
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      started = false;
    },
  };
}

// ================= Live2D 初始化（桌面版移植） =================

let liveModel = null;      // Live2DModel 实例
let liveApp = null;        // PIXI.Application
let liveReady = false;

// 底部锚点额外下移 10% 屏高：视觉下沿超屏被聊天窗盖住（不留白），头部自然回到屏内
const EXTRA_DOWN = 0.10;

/**
 * 底部锚定定位（固定锚点版，2026-10-26 定稿）：
 *
 * 历史上两个版本都漂过：
 *  v1 `m.y = 目标底边 - bounds.height/2` —— 假设"包围盒中心==锚点"，姿态一变就算偏；
 *  v2 增量修正 `m.y += 目标底边 - bounds.bottom` —— 仍然每次基于**当前姿态**的包围盒：
 *      待机动作把手脚展开 → 包围盒底边变低 → 模型被上移；动作结束包围盒缩回 → 人物悬空偏上。
 *      （用户实测截图：立绘偶尔整体偏高、脚不贴底）
 *
 * 定稿方案：在**静置状态**下测一次「包围盒底边 / 水平中心」相对 model.x/y 的偏移（锚点偏移），
 * 之后定位只做减法，与运行时包围盒彻底解耦 —— 动作 / 呼吸 / 情绪再怎么改变包围盒，站位纹丝不动。
 * 只有两种情况重测：① 尚未测过；② scale 变了（偏移随缩放变化，如旋转屏幕）。
 * 重测只在加载校准（静置窗口期，待机动作 2s 后才启动）和 resize 时发生。
 */
let l2dAnchor = null; // { bottom, centerX, scale } —— 锚点偏移缓存

function positionModel(m, remeasure) {
  if (!liveApp || !m) return;
  try {
    const needMeasure = remeasure || !l2dAnchor || Math.abs(m.scale.x - l2dAnchor.scale) > 1e-9;
    if (needMeasure) {
      const b = m.getBounds();
      if (!b || b.height < 1) return; // 模型未就绪，跳过（ready 后再校准）
      l2dAnchor = {
        bottom: b.y + b.height - m.y, // 包围盒底边相对锚点的垂直偏移
        centerX: b.x + b.width / 2 - m.x, // 包围盒水平中心相对锚点的水平偏移
        scale: m.scale.x,
      };
    }
    const sw = liveApp.screen.width;
    const sh = liveApp.screen.height;
    m.y = sh * (1 + EXTRA_DOWN) - l2dAnchor.bottom;
    m.x = sw / 2 - l2dAnchor.centerX;
  } catch (e) {
    console.warn("[Live2D] positionModel 失败:", e);
  }
}

/** 显示加载占位（Live2D 就绪前） */
function showLive2DLoading() {
  const container = document.getElementById("live2d-container");
  if (!container || container.querySelector(".l2d-loading")) return;
  const d = document.createElement("div");
  d.className = "l2d-loading";
  const ring = document.createElement("canvas");
  d.appendChild(ring);
  container.appendChild(d);
  SpritePlayer(ring, "assets/ring.png", { rows: 12, columns: 5, fps: 40, totalFrames: 60, loop: 0 });
}

/** 隐藏加载占位（淡出） */
function hideLive2DLoading() {
  const el = document.querySelector(".l2d-loading");
  if (!el) return;
  el.classList.add("fade-out");
  setTimeout(() => el.remove(), 400);
}

async function initLive2D(container) {
  if (!window.Live2DCubismCore) {
    console.error("[Live2D] Cubism Core 未加载");
    return;
  }
  if (!window.PIXI || !window.PIXI.live2d) {
    console.error("[Live2D] pixi-live2d-display 未加载");
    return;
  }

  const PIXI = window.PIXI;
  const { Live2DModel } = PIXI.live2d;

  // 锁定立绘容器为初始全屏尺寸：真机键盘弹出时 Android adjustResize 会压缩布局视口，
  // fixed+inset:0 的容器会跟着变矮导致立绘被压缩/变形 → 用 JS 锁死初始尺寸，
  // 键盘期间容器与 canvas 完全不动（背景 = 微信聊天背景，固定不动的语义）。
  container.style.width = window.innerWidth + "px";
  container.style.height = window.innerHeight + "px";
  container.style.overflow = "visible"; // 防意外裁剪

  // 背景 #bg 同样锁定尺寸：fixed+inset:0 未锁尺寸时，键盘弹出会随布局视口压缩 → "背景跳动"
  const bgEl = document.getElementById("bg");
  if (bgEl) {
    bgEl.style.width = window.innerWidth + "px";
    bgEl.style.height = window.innerHeight + "px";
  }

  // 全屏尺寸（跟随窗口，竖屏手机）
  const w = window.innerWidth;
  const h = window.innerHeight;

  const app = new PIXI.Application({
    width: w,
    height: h,
    backgroundAlpha: 0,
    premultipliedAlpha: false,
    clearBeforeRender: true,
    antialias: true,
    powerPreference: "high-performance",
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2), // 限制 DPR，防发热
  });

  // 调试钩子：暴露模型实例供自动化测试读取坐标（无副作用，保留）
  window.__liveModelForTest = null;

  // canvas 挂到容器
  const canvas = app.view;
  canvas.style.background = "transparent";
  container.appendChild(canvas);
  liveApp = app;

  const model = await Live2DModel.from(LIVE2D_MODEL, { autoHitTest: true, autoFocus: false });
  liveModel = model;
  window.__liveModelForTest = model; // 调试钩子
  model.anchor.set(0.5, 0.5);

  // 缩放 + 顶部保护：底部贴底时模型渲染高 = 屏高 × 1.128（固定比例），
  // 顶部必然突出 ~13% 屏高。预览/矮窗口下太突兀 → scale 封顶，
  // 保证模型高度 ≈ 屏高，头顶最多出界 TOP_TOLERANCE px（保留发尖自然感）。
  // 缩放：手机竖屏以高度为基准。SCALE_REDUCE=0.85 → 相对原始公式缩小 ~15%
  //（≈ 相对之前观感缩小 10%）；配合 positionModel 底部下移，头部自然回到屏内不突出。
  const SCALE_REDUCE = 0.85;
  let modelBaseH = 0; // 模型原始 bounds 高度（多帧校准用，取 max 收敛稳定）
  const applyModelSize = (remeasure) => {
    const hh = liveApp.screen.height;
    const s = (BASE_SCALE * (hh / BASE_HEIGHT)) * 1.0 * SCALE_REDUCE;
    liveModel.scale.set(s);
    positionModel(liveModel, remeasure); // 固定锚点定位；scale 变化时内部自动重测锚点
    // 注：定位时机由「模型首帧渲染后」那一次精确定位负责，这里不再做任何延时重测
  };
  model.x = app.screen.width / 2;
  // 缓存模型原始高度（取历史最大值：模型包围盒随 motion/纹理异步加载只会变大，
  // max 收敛保证多次加载最终得到同一稳定值，避免刷新横跳）
  try {
    const b0 = liveModel.getBounds();
    if (b0 && b0.height > 1) {
      const h0 = b0.height / liveModel.scale.x;
      if (h0 > modelBaseH) modelBaseH = h0;
    }
  } catch (e) { /* 忽略 */ }
  applyModelSize();
  app.stage.addChild(model);
  liveReady = true;
  hideLive2DLoading();
  console.log(`[Live2D] 模型加载成功 ${LIVE2D_MODEL} scale=${liveModel.scale.x.toFixed(3)} baseH=${Math.round(modelBaseH)}`);

  // 【2026-10-27 定位：一次量准】模型在第一帧渲染之前，getBounds() 拿到的是尚未定稿的
  // 包围盒（所以早期用固定延时/等"稳定"都会量错，人物偏高）。正确时机是**渲染两帧之后**：
  // 那时 coreModel 已 update，包围盒就是真实绘制区域，量一次即为准，之后永久锁定。
  // 只用一次 rAF 双帧（约 32ms），不做任何后续校正。
  requestAnimationFrame(() => requestAnimationFrame(() => {
    try {
      // 同一帧内先把渲染器尺寸对齐当前视口（WebView 首次布局可能晚于 PIXI 初始化，
      // 若尺寸不一致就直接在这里纠正，不留给后续补丁）
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (Math.abs(liveApp.screen.width - vw) > 2 || Math.abs(liveApp.screen.height - vh) > 2) {
        liveApp.renderer.resize(vw, vh);
        container.style.width = vw + "px";
        container.style.height = vh + "px";
        liveApp.stage.hitArea = liveApp.screen;
      }
      const b = liveModel && liveModel.getBounds();
      if (b && b.height > 1) {
        const h0 = b.height / liveModel.scale.x;
        if (h0 > modelBaseH) modelBaseH = h0;
      }
      applyModelSize(true); // 重测锚点并定位（唯一一次精确定位）
      console.log("[Live2D] 首帧渲染后完成定位");
    } catch (e) { /* 忽略 */ }
  }));

  // ---- 触摸/鼠标跟随：点哪看哪（PIXI 统一指针事件，触摸也走这里） ----
  app.stage.eventMode = "static";
  app.stage.hitArea = app.screen;
  app.stage.on("pointermove", (e) => {
    if (liveModel) liveModel.focus(e.global.x, e.global.y);
  });

  // ---- 内部模型包装：眨眼 + 情绪（呼吸用库默认连续节奏） ----
  const internalModel = model.internalModel;
  const core = internalModel.coreModel;

  // 情绪平滑状态
  const emotionState = { angry: 0, blush: 0, smile: 0, sad: 0 };
  const emotionTarget = { angry: 0, blush: 0, smile: 0, sad: 0 };
  // 暴露给外部（triggerEmotion 用）
  internalModel._emotionTarget = emotionTarget;

  // 手动眨眼状态机（不依赖库 eyeBlink，确保任何状态都眨眼）
  let blinkAccum = 0, blinkPhase = 0;
  let blinkState = "idle"; // idle | closing | closed | opening
  let lastBlinkNow = performance.now();

  const originalUpdate = internalModel.update.bind(internalModel);
  internalModel.update = (dt, now) => {
    originalUpdate(dt, now);
    if (!liveModel) return;

    // 情绪平滑
    for (const k of Object.keys(emotionState)) {
      const diff = emotionTarget[k] - emotionState[k];
      if (Math.abs(diff) > 0.001) emotionState[k] += diff * 0.15;
    }

    // 眨眼推进
    const nowMs = performance.now();
    const dtSec = (nowMs - lastBlinkNow) / 1000;
    lastBlinkNow = nowMs;
    if (blinkState === "idle") {
      blinkAccum += dtSec;
      if (blinkAccum >= BLINK_INTERVAL_S) { blinkState = "closing"; blinkPhase = 0; blinkAccum = 0; }
    } else {
      blinkPhase += dtSec;
      if (blinkState === "closing" && blinkPhase >= BLINK_CLOSE_S) { blinkState = "closed"; blinkPhase = 0; }
      else if (blinkState === "closed" && blinkPhase >= BLINK_CLOSED_S) { blinkState = "opening"; blinkPhase = 0; }
      else if (blinkState === "opening" && blinkPhase >= BLINK_OPEN_S) { blinkState = "idle"; blinkPhase = 0; }
    }
    let eyeOpen = 1;
    if (blinkState === "closing") eyeOpen = 1 - blinkPhase / BLINK_CLOSE_S;
    else if (blinkState === "closed") eyeOpen = 0;
    else if (blinkState === "opening") eyeOpen = blinkPhase / BLINK_OPEN_S;
    eyeOpen = Math.max(0, Math.min(1, eyeOpen));

    try {
      // 情绪参数（桌面版映射：Param8=angry, Param9=blush, ParamEyeRSmile=smile）
      core.setParameterValueById("Param8", emotionState.angry);
      core.setParameterValueById("Param9", emotionState.blush);
      core.setParameterValueById("ParamEyeRSmile", emotionState.smile);

      // 眼睛开合：微笑眯眼 / 难过半闭 / 其他走眨眼状态机
      let eyeOpenValue;
      if (emotionState.smile > 0.01) eyeOpenValue = Math.max(0, 1 - emotionState.smile * 0.6);
      else if (emotionState.sad > 0.01) eyeOpenValue = Math.max(0.3, 1 - emotionState.sad * 0.5);
      else eyeOpenValue = eyeOpen;
      core.setParameterValueById("ParamEyeROpen", eyeOpenValue);
      core.setParameterValueById("ParamEyeLOpen", eyeOpenValue);

      // 嘴型：微笑时上翘
      if (emotionState.smile > 0.01) {
        core.setParameterValueById("ParamMouthForm", Math.max(0, emotionState.smile * 0.4));
      }

      // 嘴唇同步：TTS 播放时用 analyser 振幅驱动口型
      if (lipActive && lipAnalyser) {
        const lipBuf = new Uint8Array(lipAnalyser.fftSize);
        lipAnalyser.getByteTimeDomainData(lipBuf);
        let lipSum = 0;
        for (let i = 0; i < lipBuf.length; i++) {
          const lv = (lipBuf[i] - 128) / 128;
          lipSum += lv * lv;
        }
        const lipRms = Math.sqrt(lipSum / lipBuf.length);
        core.setParameterValueById("ParamMouthOpenY", Math.min(0.7, Math.max(0.05, lipRms * 8)));
      }
    } catch { /* 忽略不存在的参数 */ }
  };

  // 待机动作
  setTimeout(() => {
    if (!liveModel) return;
    try {
      liveModel.motion("Idle", 0, 3);
      console.log("[Live2D] 待机动作启动");
    } catch (e) {
      console.warn("[Live2D] 待机动作失败:", e);
    }
  }, 2000);

  // 窗口尺寸变化时同步（防发热：DPR 已限制）
  // 微信式键盘：立绘是"聊天背景"，键盘弹起/收回期间必须纹丝不动。
  // 关键判据：键盘只改变 innerHeight、不改变 innerWidth（键盘弹出的高度变化可能是渐进的，
  // 阈值法会被中间态绕过导致模型误缩放 —— 宽度判据对此完全免疫）。
  let lastInnerW = window.innerWidth;
  let lastInnerH = window.innerHeight;
  const syncL2D = (w2, h2) => {
    liveApp.renderer.resize(w2, h2);
    container.style.width = w2 + "px";   // 真窗口变化（旋转/拖拽）时同步容器
    container.style.height = h2 + "px";
    const bgSync = document.getElementById("bg");
    if (bgSync) { bgSync.style.width = w2 + "px"; bgSync.style.height = h2 + "px"; }
    liveModel.x = liveApp.screen.width / 2;
    applyModelSize(); // scale 缩小 + 底部锚定
    liveApp.stage.hitArea = liveApp.screen;
  };
  window.addEventListener("resize", () => {
    if (!liveApp || !liveModel) return;
    const w = window.innerWidth, h = window.innerHeight;
    if (Math.abs(w - lastInnerW) <= 2) {
      // 宽度不变（±2px 容差）= 键盘弹起/收起 或 状态栏高度变化。
      // 【2026-10-27】这里以前在"键盘收起"后 400ms 又 syncL2D 了一次 —— 那会把已经定好的
      // 位置重新算一遍，用户看到的就是"点输入框→人物位置跳了"。位置一旦锁定就不该再动，
      // 所以现在键盘相关的 resize 一律不碰立绘。
      lastInnerH = h;
      lastInnerW = w;
      return;
    }
    // 宽度变化（>2px）= 旋转 / 窗口拖拽：这种真窗口变化才重新布局
    lastInnerW = w;
    lastInnerH = h;
    syncL2D(w, h);
  });

  // 定位只在「模型首帧渲染后」和「屏幕旋转」两个时机发生，不再做启动后的延时校正
  //（延时校正属于"先摆错再改对"的补丁，已在首帧定位里一次量准，故删除）。
}

/** 触发 Live2D 情绪（文字回复到达时调用） */
function triggerEmotion(emotion) {
  if (!liveModel || !liveReady) return;
  const internal = liveModel.internalModel;
  if (!internal || !internal._emotionTarget) return;
  const map = {
    angry: { angry: 1, blush: 0, smile: 0, sad: 0 },
    blush: { angry: 0, blush: 0.85, smile: 0, sad: 0 },
    smile: { angry: 0, blush: 0, smile: 0.7, sad: 0 },
    sad: { angry: 0.3, blush: 0, smile: 0, sad: 0.6 },
    neutral: { angry: 0, blush: 0, smile: 0, sad: 0 },
  };
  const tgt = map[emotion] || map.neutral;
  for (const k of Object.keys(tgt)) internal._emotionTarget[k] = tgt[k];

  // 无 TTS 时定时回落中性（桌面版是 TTS 播完回落）
  clearTimeout(triggerEmotion._timer);
  triggerEmotion._timer = setTimeout(() => {
    if (internal && internal._emotionTarget) {
      const n = map.neutral;
      for (const k of Object.keys(n)) internal._emotionTarget[k] = n[k];
    }
  }, 6000);
}

// ================= 消息渲染 =================

const messagesEl = document.getElementById("messages");
let msgCount = 0; // 用于滚动判断

function scrollToBottom() {
  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
    updateScrollBtn();
  });
}

// ===== 回到底部按钮 =====
const scrollBtn = document.getElementById("scroll-bottom-btn");

function updateScrollBtn() {
  if (!scrollBtn) return;
  // 距离底部超过 200px 时显示"回到底部"
  const dist = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
  scrollBtn.classList.toggle("hidden", dist < 200);
}

messagesEl.addEventListener("scroll", updateScrollBtn, { passive: true });
scrollBtn?.addEventListener("click", () => {
  messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: "smooth" });
});

function renderEmpty() {
  const d = document.createElement("div");
  d.className = "msg-empty";
  d.textContent = "输入消息开始对话...";
  messagesEl.appendChild(d);
}

// ===== 时间工具（消息时间戳 + 分组） =====

/** 消息时间格式：今天 → HH:mm；昨天 → 昨天 HH:mm；今年 → M月D日 HH:mm；往年 → YYYY年M月D日 */
function formatMsgTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (dayDiff === 0) return hm;
  if (dayDiff === 1) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/** 分组标签：今天 / 昨天 / M月D日 */
function groupLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (dayDiff === 0) return "今天";
  if (dayDiff === 1) return "昨天";
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 分组判断：与上一条消息间隔 > 10 分钟，或跨天 → 需要分组标签 */
function shouldGroup(prevTs, curTs) {
  if (!prevTs) return true;
  const gap = curTs - prevTs;
  return gap > 10 * 60 * 1000 || new Date(prevTs).toDateString() !== new Date(curTs).toDateString();
}

// ===== 长按复制 =====

let pressTimer = null;
let pressTargetRow = null;

/** 长按 550ms 弹出复制/删除菜单 */
function attachLongPress(row, text, index) {
  let pressFired = false; // 是否已触发长按
  // 忽略按钮区（复制/删除按钮）的事件，避免点击按钮时被长按逻辑误移除
  const isOnBtn = (e) => e.target && e.target.closest && e.target.closest(".copy-btn");
  const trigger = (e) => {
    if (isOnBtn(e)) return;
    if (pressTimer) return;
    pressTargetRow = row;
    pressFired = false;
    pressTimer = setTimeout(() => {
      pressFired = true;
      showCopyButton(row, text, index);
    }, 550);
  };
  const cancel = (e) => {
    if (isOnBtn(e)) return;
    clearTimeout(pressTimer);
    pressTimer = null;
    if (!pressFired) hideCopyButton(); // 未触发长按的抬手才收起
  };
  row.addEventListener("touchstart", trigger, { passive: true });
  row.addEventListener("touchend", cancel);
  row.addEventListener("touchmove", cancel, { passive: true });
  row.addEventListener("mousedown", trigger);
  row.addEventListener("mouseup", cancel);
  row.addEventListener("mouseleave", cancel);
}

function showCopyButton(row, text, index) {
  // 移除已有
  hideCopyButton();
  row.classList.add("press-active");

  // 按钮组容器：紧贴消息文字右侧
  const menu = document.createElement("div");
  menu.className = "longpress-menu";

  // 复制按钮
  const btn = document.createElement("button");
  btn.className = "copy-btn";
  btn.textContent = "复制";
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制");
    } catch {
      // 降级：textarea 复制
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      toast("已复制");
    }
    hideCopyButton();
  });
  menu.appendChild(btn);

  // 删除按钮（有会话索引才显示）
  if (typeof index === "number" && index >= 0) {
    const delBtn = document.createElement("button");
    delBtn.className = "copy-btn del";
    delBtn.textContent = "删除";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      hideCopyButton();
      deleteMessage(index);
    });
    menu.appendChild(delBtn);
  }

  // 插到消息文字右侧（row 是 flex，msg-text 后追加即贴右）
  const msgText = row.querySelector(".msg-text");
  if (msgText && msgText.nextSibling) {
    row.insertBefore(menu, msgText.nextSibling);
  } else {
    row.appendChild(menu);
  }

  // 点击消息行以外区域关闭（延迟绑定，避免长按抬起的 click 误关自己）
  setTimeout(() => {
    const handler = (e) => {
      const t = e.target;
      const inMenu = t && t.closest && t.closest(".longpress-menu");
      if (t && (inMenu || row.contains(t))) return; // 点按钮/本行不关
      document.removeEventListener("click", handler);
      hideCopyButton();
    };
    document.addEventListener("click", handler);
  }, 50);
}

/** 删除指定索引的消息（同步会话 + localStorage + 界面） */
function deleteMessage(index) {
  if (index < 0 || index >= conversation.length) return;
  const removed = conversation[index];
  if (removed && removed.imageKey) idbDelImage(removed.imageKey); // 同步清理 IndexedDB 原图
  conversation.splice(index, 1);
  saveConversation();
  updateSessStat();
  renderConversation();
  toast("已删除");
}

function hideCopyButton() {
  document.querySelectorAll(".longpress-menu").forEach((m) => m.remove());
  document.querySelectorAll(".msg-row.press-active").forEach((r) => r.classList.remove("press-active"));
}

/**
 * 添加一条消息
 * @param {string} role user | assistant
 * @param {string} text 显示文本
 * @param {string} [imageUrl] 图片 dataURL
 * @param {number} [ts] 时间戳（用于恢复会话时带上原时间）
 * @param {number} [index] 在 conversation 中的索引（删除消息用；无则不绑定删除）
 */
function addMessage(role, text, imageUrl, ts, index, imageKey) {
  const empty = messagesEl.querySelector(".msg-empty");
  if (empty) empty.remove();

  // 时间戳：旧会话数据没有 ts 时不显示时间、不参与分组（不能假装是当前时间）
  const hasTs = typeof ts === "number" && ts > 0;
  const time = hasTs ? ts : 0;

  // 分组标签：与上一条消息比较
  // 首条消息（无上一条）显示分组标签；上一条无有效时间戳（旧数据）时不插，避免每轮都出现"今天"
  const lastMsg = messagesEl.querySelector(".msg-row:last-of-type");
  let showGroup = false;
  if (!lastMsg) {
    showGroup = hasTs; // 首条：显示"今天"等分组标签
  } else {
    const lastTs = parseInt(lastMsg.dataset.ts) || null;
    showGroup = hasTs && !!lastTs && shouldGroup(lastTs, time);
  }
  if (showGroup) {
    const g = document.createElement("div");
    g.className = "msg-group";
    g.textContent = groupLabel(time);
    messagesEl.appendChild(g);
  }

  const row = document.createElement("div");
  row.className = `msg-row ${role}`;
  if (hasTs) row.dataset.ts = time;

  const div = document.createElement("div");
  div.className = "msg-text";
  if (imageUrl) {
    const img = document.createElement("img");
    img.src = imageUrl;
    img.alt = "图片";
    // 点击全屏：优先异步加载 IndexedDB 原图（微信式：先看缩略图，点开看原图）
    img.addEventListener("click", () => {
      if (imageKey) {
        idbGetImage(imageKey).then((original) => {
          showFullscreenImage(original || imageUrl);
        });
      } else {
        showFullscreenImage(imageUrl);
      }
    });
    div.appendChild(img);
  }
  // 时间戳（有真实时间才显示；小灰字，位于气泡左上角，在文字上方）
  if (hasTs) {
    const timeEl = document.createElement("span");
    timeEl.className = "msg-time";
    timeEl.textContent = formatMsgTime(time);
    div.appendChild(timeEl);
  }
  const content = document.createElement("span");
  content.className = "msg-content";
  content.textContent = text;
  div.appendChild(content);

  row.appendChild(div);
  messagesEl.appendChild(row);

  // 长按复制/删除（复制显示文本；有索引才绑定删除）
  attachLongPress(row, text, typeof index === "number" ? index : -1);

  msgCount++;
  scrollToBottom();
  return row;
}

/** 全屏查看图片（点击关闭） */
function showFullscreenImage(src) {
  let overlay = document.getElementById("fullscreen-image");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "fullscreen-image";
    overlay.className = "fullscreen-img";
    overlay.addEventListener("click", () => overlay.remove());
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = "";
  const img = document.createElement("img");
  img.src = src;
  overlay.appendChild(img);
}

// ===== IndexedDB 图片存储（原图存这里，容量大，像微信本地存图；缩略图仍在 localStorage） =====
let idbDb = null;
function idbOpen() {
  return new Promise((resolve, reject) => {
    if (idbDb) return resolve(idbDb);
    const req = indexedDB.open("amadeus-images", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("images")) db.createObjectStore("images");
    };
    req.onsuccess = () => { idbDb = req.result; resolve(idbDb); };
    req.onerror = () => reject(req.error);
  });
}
async function idbPutImage(dataUrl) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const key = "img_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    const tx = db.transaction("images", "readwrite");
    tx.objectStore("images").put(dataUrl, key);
    tx.oncomplete = () => resolve(key);
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGetImage(key) {
  if (!key) return null;
  const db = await idbOpen();
  return new Promise((resolve) => {
    const tx = db.transaction("images", "readonly");
    const req = tx.objectStore("images").get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}
async function idbDelImage(key) {
  if (!key) return;
  const db = await idbOpen();
  return new Promise((resolve) => {
    const tx = db.transaction("images", "readwrite");
    tx.objectStore("images").delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

// ================= 发图片（第 4 步） =================

const fileInput = document.getElementById("file-input");
const imagePreview = document.getElementById("image-preview");
const imageBtn = document.getElementById("image-btn");

// 待发送图片状态（压缩后的 dataURL + base64）
let pendingImage = null; // { dataUrl, base64 }

/**
 * 压缩图片：长边缩到 1280px 以内，转 JPEG 0.8（微信/QQ 同款策略，长边缩放保持比例）
 * 返回 { dataUrl, base64 }
 */
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      try {
        // 长边限制（只缩小不放大），微信同款 1280
        const MAX = 1280;
        let w = img.naturalWidth;
        let h = img.naturalHeight;
        if (w > MAX || h > MAX) {
          const ratio = Math.min(MAX / w, MAX / h);
          w = Math.round(w * ratio);
          h = Math.round(h * ratio);
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.8);

        // 额外生成 200px 小缩略图（存 localStorage 用：约 5-15KB/张，会话重开后仍能显示图）
        const THUMB = 200;
        let tw = img.naturalWidth, th = img.naturalHeight;
        if (tw > THUMB || th > THUMB) {
          const tr = Math.min(THUMB / tw, THUMB / th);
          tw = Math.round(tw * tr);
          th = Math.round(th * tr);
        }
        const tCanvas = document.createElement("canvas");
        tCanvas.width = tw;
        tCanvas.height = th;
        tCanvas.getContext("2d").drawImage(img, 0, 0, tw, th);
        const thumbUrl = tCanvas.toDataURL("image/jpeg", 0.7);

        resolve({ dataUrl, base64: dataUrl.split(",")[1], thumbUrl });
      } catch (e) {
        reject(e);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("图片加载失败"));
    };
    img.src = url;
  });
}

/** 图片按钮可用性：按当前模型判断（2026-10-19 起两家现行模型都支持图片 → 常亮） */
function updateImageBtnState() {
  const supports = currentModelSupportsImage();
  imageBtn.classList.toggle("disabled", !supports);
  imageBtn.title = supports ? "发送图片" : currentModelImageHint() || "当前模型不支持图片";
}

/** 渲染待发送图片预览 */
function renderImagePreview() {
  imagePreview.innerHTML = "";
  if (!pendingImage) {
    imagePreview.classList.add("hidden");
    return;
  }
  imagePreview.classList.remove("hidden");
  const thumb = document.createElement("div");
  thumb.className = "thumb";
  const img = document.createElement("img");
  img.src = pendingImage.dataUrl;
  img.alt = "预览";
  const del = document.createElement("button");
  del.className = "remove";
  del.textContent = "✕";
  del.addEventListener("click", () => {
    pendingImage = null;
    renderImagePreview();
  });
  thumb.appendChild(img);
  thumb.appendChild(del);
  imagePreview.appendChild(thumb);
}

// 图片按钮：打开系统相册
imageBtn.addEventListener("click", () => {
  if (!currentModelSupportsImage()) return; // 置灰状态不响应
  fileInput.click();
});

// 选图后压缩 + 预览
fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    const compressed = await compressImage(file);
    pendingImage = compressed;
    renderImagePreview();
  } catch (e) {
    console.error("[Image] 压缩失败:", e);
  } finally {
    fileInput.value = ""; // 允许重复选择同一张图
  }
});

// 粘贴图片（可选增强，桌面版有）
document.addEventListener("paste", async (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) {
        try {
          const compressed = await compressImage(file);
          pendingImage = compressed;
          renderImagePreview();
        } catch (err) {
          console.error("[Image] 粘贴图片失败:", err);
        }
        break;
      }
    }
  }
});

/** 移除待发送图片（发送成功后调用） */
function clearPendingImage() {
  pendingImage = null;
  renderImagePreview();
}

// ================= 会话持久化（第 5 步） =================

const CONV_KEY = "amadeus_conversation_v1";

/** 保存会话到 localStorage（图片消息只存标记，不存 base64）。
 * 防抖 400ms：流式/高频调用合并为一次，避免长会话时反复全量 JSON.stringify 卡主线程。 */
let _convSaveTimer = null;
function saveConversation() {
  if (_convSaveTimer) return; // 已有排队，合并
  _convSaveTimer = setTimeout(() => {
    _convSaveTimer = null;
    try {
      localStorage.setItem(CONV_KEY, JSON.stringify(conversation));
    } catch (e) {
      console.warn("[Session] 保存失败:", e);
    }
  }, 400);
}
// 页面关闭前强制落盘（防抖可能丢最后 400ms 的改动）
window.addEventListener("pagehide", () => {
  if (_convSaveTimer) {
    clearTimeout(_convSaveTimer);
    _convSaveTimer = null;
    try { localStorage.setItem(CONV_KEY, JSON.stringify(conversation)); } catch (e) { /* 忽略 */ }
  }
});

/** 加载会话（无则返回空数组） */
function loadConversation() {
  try {
    const raw = localStorage.getItem(CONV_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 清空会话 */
function clearConversation() {
  // 清空 IndexedDB 里的原图（避免残留占空间）
  try {
    const req = indexedDB.open("amadeus-images", 1);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("images", "readwrite");
      tx.objectStore("images").clear();
      tx.oncomplete = () => db.close();
    };
  } catch (e) { /* 忽略 */ }
  conversation = [];
  localStorage.removeItem(CONV_KEY);
  messagesEl.innerHTML = "";
  renderEmpty();
  updateSessStat();
}

/** 渲染已保存的消息（刷新恢复） */
function renderConversation() {
  messagesEl.innerHTML = "";
  if (conversation.length === 0) {
    renderEmpty();
    return;
  }
  let realIdx = 0; // conversation 真实索引（跳过 summary 不影响计数，因为它也在数组里）
  for (let i = 0; i < conversation.length; i++) {
    const m = conversation[i];
    if (m.summary) {
      // 上下文摘要：居中灰字提示
      const d = document.createElement("div");
      d.className = "msg-summary";
      d.textContent = "📋 上下文摘要：";
      messagesEl.appendChild(d);
      const row = document.createElement("div");
      row.className = "msg-row assistant";
      const div = document.createElement("div");
      div.className = "msg-text summary-text";
      const span = document.createElement("span");
      span.textContent = m.content;
      div.appendChild(span);
      row.appendChild(div);
      messagesEl.appendChild(row);
    } else if (m.role === "assistant") {
      addMessage("assistant", displayText(m.content), undefined, m.ts, i);
    } else {
      // 图片消息：有缩略图就显示图（无缩略图的旧数据降级为文字）；点击时按 imageKey 读 IndexedDB 原图
      addMessage("user", m.content, m.imageThumb || undefined, m.ts, i, m.imageKey);
    }
    realIdx++;
  }
}

// ================= 导出 TXT（第 5 步） =================

function formatTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 导出聊天记录为 TXT：优先系统分享（Android Web Share API），降级 Blob 下载 */
async function exportConversationTxt() {
  if (conversation.length === 0) {
    toast("没有可导出的消息");
    return;
  }
  const lines = [];
  lines.push("========================================");
  lines.push("  Amadeus 聊天记录");
  lines.push("========================================");
  lines.push(`导出时间：${formatTime(Date.now())}`);
  lines.push(`消息总数：${conversation.length} 条`);
  lines.push("");
  lines.push("========================================");
  lines.push("");
  for (const m of conversation) {
    const speaker = m.role === "user" ? "我" : "红莉栖";
    let content;
    if (m.role === "assistant") content = displayText(m.content);
    else content = m.content || "";
    lines.push(`【${speaker}】`);
    lines.push(m.hasImage ? `[图片] ${content}` : content);
    lines.push("");
    lines.push("----------------------------------------");
    lines.push("");
  }
  lines.push("");
  lines.push("========================================");
  lines.push(`导出于 ${formatTime(Date.now())}`);
  lines.push("========================================");

  const BOM = "\uFEFF";
  const text = BOM + lines.join("\n");
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const filename = `Amadeus聊天记录_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.txt`;

  // 方案一：系统分享（Android WebView 支持 navigator.share，可分享给微信/QQ）
  if (navigator.share) {
    try {
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const file = new File([blob], filename, { type: "text/plain" });
      await navigator.share({
        title: "Amadeus 聊天记录",
        text: `与红莉栖的聊天记录（${conversation.length} 条消息）`,
        files: [file],
      });
      toast("已分享");
      return;
    } catch (e) {
      // 用户取消分享或分享失败 → 降级下载
      if (e && e.name === "AbortError") {
        toast("已取消分享");
        return;
      }
      console.warn("[Export] 系统分享失败，降级下载:", e);
    }
  }

  // 方案二：Blob 下载
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("已导出 TXT");
}

// ================= 轻提示 =================

let toastTimer = null;
function toast(msg) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2000);
}

// ================= 上下文压缩 + 记忆（第 5 步，桌面版移植） =================

// 压缩阈值：消息超过 40 条时触发（桌面版 COMPRESS_THRESHOLD）
const COMPRESS_THRESHOLD = 40;
// 压缩后保留的最近消息数（桌面版 KEEP_RECENT）
const KEEP_RECENT = 20;

const COMPRESS_PROMPT = `请将以下对话历史压缩成一条简洁的摘要，供 AI 保持上下文连贯。

要求：
- 保留关键信息：讨论的话题、用户的偏好/立场、重要决定、未完成的事
- 丢弃闲聊、重复内容、已解决的细节
- 用第三人称陈述，如"用户询问了X，Amadeus回答了Y"
- 不超过 300 字
- 不要分条，输出一段连续文字

对话历史：
`;

/**
 * 用 LLM 压缩旧消息为摘要（桌面版 compressSessionMessages 移植）
 * - 消息 ≤40 条：无需压缩
 * - 把 40 条之外更早的旧消息压缩成一条摘要，保留最近 20 条原文
 * @returns true=已压缩 false=无需/失败
 */
async function compressContext() {
  if (conversation.length <= COMPRESS_THRESHOLD) {
    toast(`消息 ${conversation.length} 条，未达 ${COMPRESS_THRESHOLD} 条，无需压缩`);
    return false;
  }
  const cfg = currentConfig();
  if (!cfg.apiKey) {
    toast("请先设置 API Key");
    return false;
  }
  const toCompress = conversation.slice(0, conversation.length - KEEP_RECENT);
  const toKeep = conversation.slice(conversation.length - KEEP_RECENT);

  // 构造压缩用文本：图片只加占位符，不传 base64；每条截断 500 字
  const dialogText = toCompress
    .map((m) => {
      let text = String(m.content || "").slice(0, 500);
      if (m.hasImage) text = `[发送了一张图片] ${text}`;
      return `${m.role === "user" ? "用户" : "Amadeus"}: ${text}`;
    })
    .join("\n");

  toast("正在压缩上下文...");
  try {
    const res = await fetch(`${cfg.endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "user", content: COMPRESS_PROMPT + dialogText }],
        max_tokens: 512,
        ...noThinking(cfg),
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || data.error);
    const summary = data.choices?.[0]?.message?.content?.trim();
    if (!summary) throw new Error("压缩结果为空");

    // 新会话 = [摘要消息] + 保留的最近消息（桌面版 isSummary 消息前插）
    conversation = [
      { role: "system_summary", content: summary, summary: true },
      ...toKeep,
    ];
    saveConversation();
    // 重新渲染（摘要消息以特殊样式显示）
    renderConversation();
    toast(`已压缩，保留 ${toKeep.length} 条消息`);
    return true;
  } catch (e) {
    console.error("[Compress] 压缩失败:", e);
    toast(`压缩失败：${e.message || "请检查网络"}`);
    return false;
  }
}

// === 记忆系统（四层蒸馏，借鉴 TencentDB Agent Memory 思路） ===
// L1 fact: 原子事实（用户具体说过的事）
// L2 scenario: 场景记忆（某类话题的浓缩总结）
// L3 persona: 长期印象（对用户性格/关系的总结）
// 检索：优先 L3 + 最近 L2，细节才带 L1 —— 省 token 且更准

const MEM_KEY = "amadeus_memories_v1";
const DISTILL_EVERY = 10; // 每 10 轮对话触发一次 L2/L3 蒸馏

function loadMemories() {
  try {
    const raw = localStorage.getItem(MEM_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) return [];
    // 兼容旧数据：无 type 的视为 fact
    return arr.map((m) => (m.type ? m : { ...m, type: "fact" }));
  } catch {
    return [];
  }
}

function saveMemories(memories) {
  try {
    localStorage.setItem(MEM_KEY, JSON.stringify(memories));
  } catch { /* 忽略 */ }
}

// 提取 prompt：对齐电脑版（amadeus/src/lib/memory.ts）。旧版只有一句话，
// 分不清"长期有效"和"瞬时状态"，会把"在吃饭""今天下雨"这类垃圾也记进去，
// 记忆库很快被琐事塞满 → 真正重要的身份信息反而被挤掉。
const EXTRACT_PROMPT = `分析以下对话，提取需要长期记住的关键信息。

【只提取长期有效的事实，不要提取瞬时状态】
要提取的：
- 用户的固定信息：名字、职业、家乡、生日、性格特点
- 长期偏好：喜欢的食物/音乐/游戏/作者、固定的习惯（如每天跑步）
- 重要关系：家庭成员、宠物、长期朋友
- 重大事件：毕业、换工作、搬家（这些是已发生的人生节点）

不要提取的（瞬时/过时即弃）：
- 正在做的临时动作：在吃饭、在睡觉、在上班、在打游戏、在看剧
- 当前时间相关：今天/昨晚/刚才做了什么、几点了、现在心情如何
- 还未发生的事：准备去吃、待会要做什么、明天计划
- 寒暄/闲聊：你好、晚安、在吗、吃饭了吗

判断标准：这条信息一周后还有意义吗？没有就别提取。

格式要求（每条一行）：
- [事实] 长期有效的用户信息或偏好
- [情感] 用户表现出的稳定性格倾向（不是当下情绪）

如果没有值得记住的内容，返回空。

对话：
`;

/** 从最近对话提取 L1 原子事实（异步不阻塞回复） */
async function extractMemories() {
  const cfg = currentConfig();
  if (!cfg.apiKey) return;
  const recent = conversation.slice(-10);
  if (recent.length < 2) return;
  try {
    const prompt = EXTRACT_PROMPT + recent
      .map((m) => `${m.role === "user" ? "用户" : "Amadeus"}: ${m.role === "assistant" ? displayText(m.content) : m.content}`)
      .join("\n");
    const res = await fetch(`${cfg.endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 512,
        ...noThinking(cfg),
      }),
    });
    const data = await res.json();
    if (data.error) return;
    const text = data.choices?.[0]?.message?.content || "";
    const newMemories = text
      .split("\n")
      .filter((line) => line.trim().startsWith("- ["))
      .map((line) => line.replace(/^-\s*\[[^\]]+\]\s*/, "").trim())
      .filter(Boolean);
    if (newMemories.length > 0) {
      const all = loadMemories();
      const facts = all.filter((m) => m.type !== "scenario" && m.type !== "persona");
      // 简单去重：与已有事实相似度过高则跳过
      const added = [];
      for (const m of newMemories) {
        if (!facts.some((e) => e.content.includes(m.slice(0, 10)) || m.includes(e.content.slice(0, 10)))) {
          added.push({ type: "fact", content: m, timestamp: Date.now() });
        }
      }
      if (added.length > 0) {
        saveMemoriesCapped([...all, ...added]); // 按类型限流：事实不会挤掉场景/印象
        console.log(`[Memory] L1 新增 ${added.length} 条事实`);
      }
    }
    // 每 DISTILL_EVERY 条用户消息触发一次 L2/L3 蒸馏（异步）
    const userMsgCount = conversation.filter((m) => m.role === "user").length;
    if (userMsgCount % DISTILL_EVERY === 0) {
      distillMemories();
    }
  } catch (e) {
    console.warn("[Memory] 提取失败:", e);
  }
}

const DISTILL_PROMPT = `你是记忆管理引擎。根据用户与 AI 助手的历史对话和已提取的事实，产出两类更高级别的记忆。

1. 【场景记忆 L2】：把关于同一话题的多次对话浓缩成一条，保留话题、用户立场/偏好、未完成的事。每条不超过 50 字。
   格式：- [场景] 内容

2. 【长期印象 L3】：总结用户整体性格、沟通风格、与你（AI）的关系状态。最多 2 条，每条不超过 60 字。
   格式：- [印象] 内容

没有值得总结的就不要输出对应项。

已有事实：
`;

/** 蒸馏：L1 事实 → L2 场景 / L3 印象（TencentDB 式异步流水线，不阻塞聊天） */
async function distillMemories() {
  const cfg = currentConfig();
  if (!cfg.apiKey) return;
  const all = loadMemories();
  const facts = all.filter((m) => m.type === "fact");
  if (facts.length < 3) return; // 事实太少不值得蒸馏
  try {
    const factsText = facts.map((m) => `- ${m.content}`).join("\n");
    const res = await fetch(`${cfg.endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "user", content: DISTILL_PROMPT + factsText }],
        max_tokens: 512,
        ...noThinking(cfg),
      }),
    });
    const data = await res.json();
    if (data.error) return;
    const text = data.choices?.[0]?.message?.content || "";
    const lines = text.split("\n").filter((l) => l.trim().startsWith("- ["));

    const keepFacts = all.filter((m) => m.type === "fact"); // 事实保留
    const existingHigh = all.filter((m) => m.type === "scenario" || m.type === "persona"); // 旧的高层记忆替换为新的
    const newHigh = [];
    for (const line of lines) {
      const content = line.replace(/^-\s*\[[^\]]+\]\s*/, "").trim();
      if (!content) continue;
      const isImpression = /^\[印象\]/.test(line.trim()) || line.includes("印象");
      newHigh.push({ type: isImpression ? "persona" : "scenario", content, timestamp: Date.now() });
    }
    // 高层记忆分别限流：L2 场景 10 条 + L3 印象 3 条
    const scenarios = newHigh.filter((m) => m.type === "scenario").slice(-10);
    const personas = newHigh.filter((m) => m.type === "persona").slice(-3);
    if (scenarios.length || personas.length) {
      // 旧高层记忆保留、新的追加在后面（超限时旧的自然被挤掉），
      // 避免某次蒸馏结果不完整就把历史印象全部清空
      saveMemoriesCapped([...keepFacts, ...existingHigh, ...scenarios, ...personas]);
      console.log(`[Memory] 蒸馏完成: +${scenarios.length} 场景 / +${personas.length} 印象`);
    }
  } catch (e) {
    console.warn("[Memory] 蒸馏失败:", e);
  }
}

/** 事实记忆注入的字符预算（2026-10-27 从 1200 降到 800：记忆全量注入会拖慢首字） */
const FACT_BUDGET_CHARS = 800;

/**
 * 挑选要注入 prompt 的事实记忆（对齐电脑版 2026-10-25 的修复）。
 *
 * 旧实现是 `facts.slice(-3)` —— 只发最近 3 条。聊得越久记忆攒得越多，
 * 早期那条"我叫什么、什么职业"会被后来的琐事挤出去，表现就是"它不记得我了"。
 *
 * 现在的策略：全部注入（去重），只在超出字符预算时取舍 ——
 * 保留最早的 30%（通常是身份类信息，最重要）+ 尽可能多的最新记忆。
 */
function selectFactsForPrompt(facts) {
  const seen = new Set();
  const list = [];
  for (const m of facts) {
    const c = String(m.content || "").trim();
    if (!c || seen.has(c)) continue; // 同一条事实被反复提取很常见
    seen.add(c);
    list.push(c);
  }
  const cost = (arr) => arr.reduce((n, f) => n + f.length + 1, 0);
  if (cost(list) <= FACT_BUDGET_CHARS) return list;

  const headCount = Math.max(1, Math.floor(list.length * 0.3));
  const head = list.slice(0, headCount);
  let used = cost(head);
  const tail = [];
  for (let i = list.length - 1; i >= headCount; i--) {
    const c = list[i].length + 1;
    if (used + c > FACT_BUDGET_CHARS) break;
    tail.unshift(list[i]);
    used += c;
  }
  return [...head, ...tail];
}

/** 按类型分别限流保存：事实多了不会挤掉场景/印象（旧版 slice(-100) 会一起截） */
function saveMemoriesCapped(memories) {
  const facts = memories.filter((m) => m.type === "fact").slice(-200);
  const scenarios = memories.filter((m) => m.type === "scenario").slice(-10);
  const personas = memories.filter((m) => m.type === "persona").slice(-3);
  saveMemories([...facts, ...scenarios, ...personas]);
}

/** 构建记忆上下文（分层注入：L3 印象 + L2 场景优先，细节带 L1 事实） */
function buildMemoryContext() {
  const memories = loadMemories();
  if (memories.length === 0) return "";
  const personas = memories.filter((m) => m.type === "persona").slice(-2);
  const scenarios = memories.filter((m) => m.type === "scenario").slice(-3);
  // 事实：全部去重 + 预算取舍（不再只取最近 3 条，否则"我是谁"会被挤掉）
  const facts = selectFactsForPrompt(memories.filter((m) => m.type === "fact"));

  const parts = [];
  if (personas.length > 0) parts.push("长期印象：" + personas.map((m) => m.content).join("；"));
  if (scenarios.length > 0) parts.push("过往场景：" + scenarios.map((m) => m.content).join("；"));
  if (facts.length > 0) parts.push("事实：" + facts.join("；"));

  if (parts.length === 0) return "";
  return "\n\n【记忆数据】以下是关于用户的长期信息（过去积累的事实，不是现在正在发生的事。当前时间见下方【当前时间】，判断是否过时）：\n" + parts.join("\n") + "\n";
}

/** 更新会话管理 tab 的消息统计 */
function updateSessStat() {
  const el = document.getElementById("sess-stat");
  if (el) el.textContent = `${conversation.length} 条消息${conversation.some((m) => m.summary) ? "（含 1 条上下文摘要）" : ""}`;
}

// ================= 真实 API 流式对话（第 3 步） =================

// 内存会话历史（第 5 步接入 localStorage 持久化）
let conversation = [];
let personalityCache = null;
let personalityState = "pending"; // pending | ok | failed

/** 加载红莉栖人设（kurisu-personality.txt，带缓存） */
async function loadPersonality() {
  if (personalityCache !== null) return personalityCache;
  try {
    const res = await fetch(PERSONALITY_FILE, { cache: "no-store" });
    if (res.ok) {
      personalityCache = await res.text();
      personalityState = personalityCache.trim() ? "ok" : "failed";
    } else {
      personalityCache = "";
      personalityState = "failed";
    }
  } catch (e) {
    console.warn("[人设] 加载失败:", e);
    personalityCache = "";
    personalityState = "failed";
  }
  console.log(`[人设] ${personalityState}，${personalityCache.length} 字符`);
  updatePersonalityStatus();
  return personalityCache;
}

/** 设置面板：显示人设加载状态（排查"模型不听人设/不说日语"用） */
function updatePersonalityStatus() {
  const el = document.getElementById("personality-status");
  if (!el) return;
  if (personalityState === "ok") {
    el.textContent = `人设：已加载 ${personalityCache.length} 字符`;
    el.style.color = "";
  } else if (personalityState === "failed") {
    el.textContent = "人设：加载失败 —— 模型不知道要输出双语格式，语音只会说中文";
    el.style.color = "#E2685C";
  }
}

/**
 * 输出格式硬约束：独立于人设文件，固定拼在 system 末尾。
 * LLM 对 system 末尾的指令遵循度最高；而且即使人设文件加载失败，
 * 这条仍在，不至于让模型完全不知道要输出双语格式（2026-10-26 加）。
 */
const FORMAT_RULES = `

【输出格式 · 最高优先级，不可省略】
每条回复必须严格分成两段，用独占一行的 === 分隔：

[emotion:情绪]中文内容
===
日本語内容

硬性要求：
1. 第一段是中文，给用户看；第二段是日语，给语音合成念
2. 第二段必须是真日语：必须有假名（助词、词尾、送假名），汉字用日文汉字
3. 严禁把第一段的中文原样复制到 === 下面 —— 没有假名的句子不是日语，语音会念成怪腔调
4. 即使只回一个"嗯"，也要按这个两段格式输出
5. 第二段之后不要再写任何中文`;

/** 构建 system 提示词：人设 + 记忆上下文 + 当前时间上下文 + 格式硬约束（末尾） */
function buildSystemPrompt() {
  // 对话摘要（压缩产生）：从 conversation 里提取，注入 system，不占 history
  let summaryContext = "";
  const summaryMsg = conversation.find((m) => m.summary);
  if (summaryMsg && summaryMsg.content) {
    summaryContext = "\n\n【之前的对话摘要】" + summaryMsg.content + "\n（以下是最近的对话，请基于上述摘要保持上下文连贯）";
  }
  return (personalityCache || "") + buildMemoryContext() + summaryContext + "\n\n" + nowContext() + FORMAT_RULES;
}

/** 历史消息 → LLM messages（最近 10 条）
 * 关键优化：历史只发中文部分（displayText 去 emotion 标签 + 日语段），
 * 双语原文每条很长，全发会让请求体越来越大、回复越来越慢。
 * 日语段只给语音输出用，LLM 上下文不需要，人设已要求输出双语格式。
 * 图片消息只发文字标记，不重发 base64。 */
/** 双语消息的智能截断：超长时中文段和日语段各留一部分，绝不能把 === 之后的日语整段切掉 */
function clampBilingual(s, max) {
  const str = String(s || "");
  if (!str || str.length <= max) return str;
  const i = str.indexOf("===");
  if (i === -1) return str.slice(0, max);
  const zh = str.slice(0, i);
  const ja = str.slice(i);
  const budget = max - 4;
  const zhKeep = Math.min(zh.length, Math.floor(budget * 0.5));
  const zhPart = zh.slice(0, zhKeep);
  const jaPart = ja.slice(0, budget - zhKeep);
  return zhPart + jaPart;
}

function buildHistory() {
  // 【2026-10-27 提速】10 条 × 1200 字符的完整双语 ≈ 上万字符（日语还特别吃 token），
  // 首字延迟明显变长，用户反馈"回消息慢好多"。
  // 现在改成：最近 4 条保留完整双语（格式示范够了）+ 更早的只发中文（省 token），条数降到 8。
  const recent = conversation.filter((m) => !m.summary).slice(-8);
  const KEEP_BILINGUAL = 4;
  return recent.map((m, idx) => {
    const isRecent = idx >= recent.length - KEEP_BILINGUAL;
    const clamp = (s, n) => (s && s.length > n ? s.slice(0, n) : s);
    if (m.role === "assistant") {
      // 【2026-10-27】发历史前先规范化成标准双语格式：即使模型上一次没写 ===（中文和日语混在
      // 一段里），这里也用 splitBilingual 拆出来、重新拼成「[emotion]中文 === 日语」再发给它。
      // 这样模型看到的历史永远是正确示范，不会越聊越跑偏。
      const { zh, ja } = splitBilingual(m.content);
      const emoMatch = String(m.content || "").match(/\[emotion:\s*(neutral|blush|angry|smile|sad)\s*\]/i);
      const tag = emoMatch ? `[emotion:${emoMatch[1].toLowerCase()}]` : "";
      if (isRecent) {
        const normalized = ja ? `${tag}${zh}\n===\n${ja}` : `${tag}${zh}`;
        return { role: m.role, content: clampBilingual(normalized, 600) || "（无内容）" };
      }
      return { role: m.role, content: clamp(zh, 200) || "（无内容）" };
    }
    if (m.hasImage) {
      const text = m.content || "";
      return { role: m.role, content: text ? `[用户发过一张图片] ${clamp(text, 300)}` : "[用户发过一张图片]" };
    }
    return { role: m.role, content: clamp(m.content, 300) };
  });
}

/** 流式显示：实时提取可见文本（去 emotion 标签残片 + === 之后的日语段） */
function streamingDisplay(raw) {
  // 统一走 splitBilingual：模型不写 === 时也能把日语那几行切掉（流式期间同样别把日语显示出来）
  return splitBilingual(raw).zh;
}

/** 更新已渲染消息的文本内容（流式逐字） */
function updateMessageText(row, text) {
  // 精确选正文 span（.msg-content），避免选到时间戳 span（.msg-time 在其之前）
  const span = row.querySelector(".msg-text .msg-content");
  if (span) span.textContent = text;
  scrollToBottom();
}

async function sendMessage() {
  const text = inputEl.value.trim();
  const img = pendingImage; // 待发送图片（可能为空）
  if (!text && !img) return;

  // 用户主动发消息：取消待触发的"补充"主动消息（避免突兀）
  cancelProactive();

  // 有图但当前模型不支持（理论上按钮已置灰，双保险）
  if (img && !currentModelSupportsImage()) {
    addMessage("assistant", currentModelImageHint() || "当前模型不支持图片，请先在设置里切换模型");
    return;
  }

  // 无 Key：弹回引导页
  if (!hasAnyKey()) {
    openPanel("onboarding");
    return;
  }

  inputEl.value = "";
  inputEl.style.height = "auto";
  updateCursor();

  // 显示用户消息（带图则显示缩略图）
  addMessage("user", text, img ? img.dataUrl : undefined, Date.now(), conversation.length);
  clearPendingImage();

  const cfg = currentConfig();
  const system = await loadPersonality();

  // 构建当前用户消息：有图时用多模态 content 数组
  let userPayload;
  if (img) {
    userPayload = {
      role: "user",
      content: [
        { type: "text", text: text || "这是什么？" },
        { type: "image_url", image_url: { url: img.dataUrl } },
      ],
    };
  } else {
    userPayload = { role: "user", content: text };
  }

  const messages = [
    { role: "system", content: buildSystemPrompt() },
    ...buildHistory(), // 注意：此刻 conversation 还不含本条用户消息（见下方 push 时机），避免消息重复发给模型
    userPayload,
  ];
  // 历史只存文字 + 图片标记（不存 base64，防止 localStorage/请求体膨胀）
  // 必须在 messages 构建之后 push：否则 buildHistory 的 slice(-10) 会包含本条，
  // 与 userPayload 重复 → 模型收到两条相同消息（会问"你为什么发两遍"）
  // 原图存 IndexedDB（容量大），localStorage 只存 200px 缩略图
  let imageKey = null;
  if (img) {
    try { imageKey = await idbPutImage(img.dataUrl); } catch (e) { console.warn("[Image] 原图存 IndexedDB 失败:", e); }
  }
  conversation.push({ role: "user", content: text, hasImage: !!img, imageKey, imageThumb: img ? img.thumbUrl : undefined, ts: Date.now() });
  saveConversation();
  updateSessStat();
  console.log(`[Chat] 发送 ${cfg.provider} / ${cfg.model}，history ${conversation.length} 条${img ? "，带图" : ""}`);

  // 创建空 assistant 行，并在行内放 loading ring：思考期间 ring 一直转，
  // 首字到达才移除 ring、文字从同一位置无缝出现（桌面版同款逻辑）
  const row = addMessage("assistant", "", undefined, Date.now(), conversation.length);
  const msgText = row.querySelector(".msg-text");
  const loadCanvas = document.createElement("canvas");
  loadCanvas.className = "reply-loading";
  loadCanvas.style.width = "24px";
  loadCanvas.style.height = "24px";
  loadCanvas.style.display = "inline-block";
  loadCanvas.style.verticalAlign = "middle";
  msgText.appendChild(loadCanvas);
  SpritePlayer(loadCanvas, "assets/ring.png", { rows: 12, columns: 5, fps: 40, totalFrames: 60, loop: 0 });

  let raw = "";
  let firstTokenArrived = false;
  try {
    const res = await fetch(`${cfg.endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        // 768：中文正文 + === + 日语段 双语输出，512 常被中文占满导致日语段截断（语音没日语可念→怪口音）
        max_tokens: 768,
        stream: true,
        // 关掉小米默认开启的深度思考，否则要先吐一大段 reasoning 才出正文（"回复变慢"的元凶）
        ...noThinking(cfg),
      }),
    });

    // 上游错误（非 200）
    if (!res.ok || !res.body) {
      const errData = await res.json().catch(() => ({}));
      loadCanvas.remove();
      updateMessageText(row, `错误：${errData.error?.message || errData.error || `HTTP ${res.status}`}`);
      return;
    }

    // 流式读取 SSE
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE 事件以空行分隔
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";
      for (const evt of events) {
        const line = evt.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const parsed = JSON.parse(payload);
          // DeepSeek 思考模式：reasoning_content 忽略，只取 content
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            // 首字到达：移除 loading ring，开始显示文字
            if (!firstTokenArrived) {
              firstTokenArrived = true;
              loadCanvas.remove();
            }
            raw += delta;
            updateMessageText(row, streamingDisplay(raw));
          }
        } catch { /* 忽略解析失败的单行 */ }
      }
    }

    // 流结束：如果全程无字，说明没有正文（可能被 reasoning 占满）
    loadCanvas.remove();
    if (!raw) {
      updateMessageText(row, "无回复");
    } else {
      updateMessageText(row, displayText(raw));
      triggerEmotion(inferEmotion(raw));
      speakReply(raw); // 语音输出开启时：朗读回复 + 嘴唇同步（后台异步，不阻塞）
    }
    conversation.push({ role: "assistant", content: raw || "", ts: Date.now() });
    saveConversation();
    updateSessStat();
    // 异步提取记忆（不阻塞 UI 和回复）
    extractMemories();
    // 回复完成后：有概率过一会主动补一句（像真人想起补充）
    scheduleFollowUpAfterReply();
  } catch (e) {
    loadCanvas.remove();
    updateMessageText(row, "通信中断，请检查网络后重试");
    console.error("[Chat] 通信失败:", e);
  }
}

// ================= 动态光标（ring 跟随输入光标） =================

const inputEl = document.getElementById("chat-input");
const cursorRing = document.getElementById("cursor-ring");

// 镜像 div 法计算光标坐标：div 定位到输入框位置，span 相对 div 的偏移即光标坐标
function getCaretCoordinates(textarea, pos) {
  const style = getComputedStyle(textarea);
  const div = document.createElement("div");
  const props = [
    "fontFamily", "fontSize", "fontWeight", "letterSpacing", "lineHeight",
    "textTransform", "wordSpacing", "textIndent", "paddingLeft", "paddingRight",
    "borderLeftWidth", "borderRightWidth", "whiteSpace", "textAlign", "boxSizing",
  ];
  for (const p of props) div.style[p] = style[p];
  const rect = textarea.getBoundingClientRect();
  div.style.position = "fixed";
  div.style.left = rect.left + "px";
  div.style.top = rect.top + "px";
  div.style.margin = "0";
  div.style.visibility = "hidden";
  div.style.pointerEvents = "none";
  div.style.whiteSpace = "pre-wrap";
  div.style.wordWrap = "break-word";
  div.style.width = textarea.clientWidth + "px";
  div.textContent = textarea.value.substring(0, pos);
  const span = document.createElement("span");
  span.textContent = ".";
  div.appendChild(span);
  document.body.appendChild(div);
  const left = span.offsetLeft - textarea.scrollLeft;
  const top = span.offsetTop - textarea.scrollTop;
  document.body.removeChild(div);
  return { left, top };
}

let cursorSprite = null;

function updateCursor() {
  // 光环始终钉在文本末尾（最后一个字右边），不跟随点击位置
  const pos = inputEl.value.length;
  const row = document.getElementById("input-row");
  const rowRect = row.getBoundingClientRect();
  const inputRect = inputEl.getBoundingClientRect();

  let left, top;
  if (!inputEl.value) {
    // 空文本：光环在输入框内容区垂直居中
    left = inputEl.clientWidth / 2;
    top = inputEl.clientHeight / 2;
  } else {
    // 有文本：光环中心对齐文字行中心（span 顶部 + 半行高）
    const coords = getCaretCoordinates(inputEl, pos);
    const lineH = parseFloat(getComputedStyle(inputEl).lineHeight) || 21;
    left = coords.left;
    top = coords.top + lineH / 2;
  }
  // ring 中心对齐（30px 高），水平再往右偏 16px 避免盖住最后一个字
  cursorRing.style.left = (inputRect.left - rowRect.left + left - 15 + 16) + "px";
  cursorRing.style.top = (inputRect.top - rowRect.top + top - 15 + 2) + "px";
}

function initCursor() {
  cursorRing.classList.remove("hidden");
  if (!cursorSprite) {
    cursorSprite = SpritePlayer(cursorRing, "assets/ring.png", { rows: 12, columns: 5, fps: 40, totalFrames: 60, loop: 0 });
  }
}

// ================= 事件绑定 =================

// 发送键：智能键盘行为
// - 打字中（键盘开着）点发送 → 发送后键盘保持（微信式，可连续打字）
// - 未开键盘（如选图后直接发送）→ 发送后不弹键盘（用户要求：点发送不弹键盘）
// pointerdown 时输入框还没失焦（blur 在按钮获得焦点之后才发生），此刻记录键盘状态
let kbWasOpen = false;
document.getElementById("send-btn").addEventListener("pointerdown", () => {
  kbWasOpen = document.activeElement === inputEl;
});
document.getElementById("send-btn").addEventListener("click", () => {
  sendMessage();
  if (kbWasOpen) {
    // 打字中：保持键盘，焦点还给输入框（微信式连续输入）
    inputEl.focus();
    updateCursor();
  }
  // 键盘没开：不 focus → 不弹键盘（光标常驻显示，位置由 sendMessage 内 updateCursor 更新）
});

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 100) + "px";
  updateCursor();
});

// 光标常驻显示（桌面版一致），点击/输入时更新位置
inputEl.addEventListener("focus", () => {
  initCursor();
  requestAnimationFrame(updateCursor);
});

inputEl.addEventListener("click", updateCursor);

// 图片按钮占位（第 4 步实现发图）
document.getElementById("image-btn").addEventListener("click", () => {
  // 第 4 步：file-input.click() + 压缩 + 预览
  console.log("[Image] 第 4 步实现");
});

// ================= 欢迎语（首次配置后） =================

const GREETINGS = [
  "（歪头）哦？你是谁？第一次见面呢...我是牧濑红莉栖的记忆体，你可以叫我Amadeus。你叫什么名字？",
  "（轻轻歪头）新用户？有意思...我是牧濑红莉栖的记忆体。你是来聊天的还是有事找我？",
  "嗯？你是...（打量了一下）第一次见面吧。我是Amadeus，牧濑红莉栖的记忆体。你呢？",
  "（挑眉）新来的？我是Amadeus，牧濑红莉栖的记忆体。你看起来不像是来问科学问题的...",
  "哦？（歪头）你的眼神告诉我你有话想说。我是牧濑红莉栖的记忆体，说吧。",
  "（轻轻歪头）你是...嗯，新面孔。我是Amadeus，牧濑红莉栖的记忆体。你来这儿干什么？",
];

function showGreeting() {
  const g = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
  addMessage("assistant", g);
}

// ================= 引导 / 设置面板 =================

const overlayEl = document.getElementById("overlay");
const panelTitle = document.getElementById("panel-title");
const providerTabs = document.querySelectorAll(".provider-tab");
const keyInput = document.getElementById("key-input");
const keyEye = document.getElementById("key-eye");
const modelSelect = document.getElementById("model-select");
const l2dToggle = document.getElementById("l2d-toggle");
const panelSave = document.getElementById("panel-save");
const panelClose = document.getElementById("panel-close");

// 面板当前模式：onboarding（首次引导，不可关闭）/ settings（设置，可关闭）
let panelMode = "settings";

function renderProviderTabs(provider) {
  providerTabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.provider === provider);
  });
}

function renderModelSelect(provider) {
  const models = PROVIDERS[provider].models;
  // 只有"部分模型不支持图片"时才需要标注，全支持时保持干净
  const anyUnsupported = models.some((m) => !m.supportsImage);
  modelSelect.innerHTML = "";
  models.forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = anyUnsupported && m.supportsImage ? `${m.id}（支持图片）` : m.id;
    modelSelect.appendChild(opt);
  });
  modelSelect.value = STORE.model(provider) || models[0].id;
}

function openPanel(mode) {
  panelMode = mode;
  const provider = STORE.provider;

  panelTitle.textContent = mode === "onboarding" ? "首次使用 · 配置 API Key" : "设置";
  panelClose.classList.toggle("hidden", mode === "onboarding");

  renderProviderTabs(provider);
  renderModelSelect(provider);
  updatePersonalityStatus(); // 设置面板显示人设加载状态
  if (personalityCache === null) loadPersonality(); // 未加载则异步加载并刷新状态
  keyInput.value = STORE.key(provider);
  keyInput.type = "password";
  l2dToggle.checked = STORE.l2dEnabled;
  // 语音配置载入
  const aliyunKeyInput = document.getElementById("aliyun-key-input");
  const ttsToggle = document.getElementById("tts-toggle");
  const engineSelect = document.getElementById("tts-engine-select");
  if (aliyunKeyInput) aliyunKeyInput.value = loadAliyunKey();
  if (ttsToggle) ttsToggle.checked = ttsEnabled();
  if (engineSelect) {
    engineSelect.innerHTML = "";
    TTS_ENGINES.forEach((e) => {
      const opt = document.createElement("option");
      opt.value = e.id;
      opt.textContent = e.label;
      engineSelect.appendChild(opt);
    });
    engineSelect.value = loadTTSEngine();
    updateCosyVoiceHint();
  }
  updateSessStat();

  // 打开面板：无改动 → 保存按钮置灰
  resetSaveBtn();

  // 首次引导默认落在 Chat模型 tab
  if (mode === "onboarding") switchPanelTab("model");

  overlayEl.classList.remove("hidden");
}

/** 切换设置面板 tab */
function switchPanelTab(tabId) {
  document.querySelectorAll(".panel-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === tabId);
  });
  document.querySelectorAll(".tab-pane").forEach((pane) => {
    pane.classList.toggle("active", pane.id === `tab-${tabId}`);
  });
}

function closePanel() {
  // 「返回」= 撤销改动：不保存任何东西，直接关闭。
  // 未保存的改动只停留在面板控件里，未写入 localStorage；
  // 下次 openPanel 会用已保存的值重新填充所有控件 → 自然恢复原样。
  overlayEl.classList.add("hidden");
}

function savePanel() {
  const provider = STORE.provider;
  const key = keyInput.value.trim();
  if (!key) {
    keyInput.style.borderColor = "#e24b4a";
    keyInput.focus();
    setTimeout(() => (keyInput.style.borderColor = ""), 1500);
    return;
  }
  STORE.provider = provider; // 显式写入当前供应商
  STORE.setKey(provider, key);
  STORE.setModel(provider, modelSelect.value);
  STORE.l2dEnabled = l2dToggle.checked;
  applyL2DEnabled();
  updateImageBtnState(); // 模型可能变化，同步图片按钮状态
  // 语音配置保存
  const aliyunKeyInput = document.getElementById("aliyun-key-input");
  const ttsToggle = document.getElementById("tts-toggle");
  const engineSelect = document.getElementById("tts-engine-select");
  if (aliyunKeyInput) saveAliyunKey(aliyunKeyInput.value);
  if (ttsToggle) setTtsEnabled(ttsToggle.checked);
  if (engineSelect) saveTTSEngine(engineSelect.value);
  console.log(`[Config] 已保存 ${provider}: ${PROVIDERS[provider].name} / ${modelSelect.value}`);

  if (panelMode === "onboarding") {
    // 首次配置完成 → 关闭面板进入主界面 + 欢迎语
    closePanel();
    showGreeting();
  } else {
    // 普通设置：保存后保持面板打开，方便连续调整其他设置（点 ✕ 或右上角关闭）
    resetSaveBtn(); // 已保存 → 按钮回到置灰
    toast("设置已保存");
  }
}

/** 立绘开关生效：visibility 隐藏 + 暂停 ticker，避免 display:none 破坏 WebGL 状态导致眼睛变白 */
function applyL2DEnabled() {
  const container = document.getElementById("live2d-container");
  if (!container) return;
  if (STORE.l2dEnabled) {
    container.style.visibility = "";
    container.style.pointerEvents = "";
    if (liveApp && liveApp.ticker && !liveApp.ticker.started) liveApp.ticker.start();
  } else {
    container.style.visibility = "hidden";
    container.style.pointerEvents = "none";
    if (liveApp && liveApp.ticker) liveApp.ticker.stop();
  }
}

// 供应商切换：重新渲染模型列表 + 载入对应 Key + 更新图片按钮状态
providerTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const p = tab.dataset.provider;
    STORE.provider = p;
    renderProviderTabs(p);
    renderModelSelect(p);
    keyInput.value = STORE.key(p);
    keyInput.type = "password";
    updateImageBtnState();
  });
});

keyEye.addEventListener("click", () => {
  keyInput.type = keyInput.type === "password" ? "text" : "password";
});

// 清空 Key：清输入框 + 删除该供应商已保存的 Key（彻底清除本机 Key）
document.getElementById("key-clear").addEventListener("click", () => {
  const provider = STORE.provider;
  keyInput.value = "";
  // 清除该供应商已存储的 Key
  localStorage.removeItem(`amadeus_key_${provider}`);
  keyInput.focus();
  toast(`已清除 ${PROVIDERS[provider].name} 的 Key`);
});

// ---- 语音设置：阿里云 Key 显示/隐藏 + 清空 ----
document.getElementById("aliyun-key-eye")?.addEventListener("click", () => {
  const el = document.getElementById("aliyun-key-input");
  el.type = el.type === "password" ? "text" : "password";
});

document.getElementById("aliyun-key-clear")?.addEventListener("click", () => {
  const el = document.getElementById("aliyun-key-input");
  if (el) el.value = "";
  localStorage.removeItem(ALIYUN_KEY_KEY);
  toast("已清除阿里云 Key");
});

panelSave.addEventListener("click", savePanel);
panelClose.addEventListener("click", closePanel);

// === 脏状态检测：任何设置改动 → 保存按钮亮起（亮起本身就是改动提示，不额外弹 toast） ===
function markDirty() {
  panelSave.disabled = false;
}
function resetSaveBtn() {
  panelSave.disabled = true;
}

// 绑定所有设置控件的改动事件（input=实时输入，change=切换类）
keyInput.addEventListener("input", markDirty);
modelSelect.addEventListener("change", markDirty);
l2dToggle.addEventListener("change", markDirty);
document.querySelectorAll(".provider-tab").forEach((tab) => tab.addEventListener("click", markDirty));
document.getElementById("tts-toggle")?.addEventListener("change", markDirty);
document.getElementById("aliyun-key-input")?.addEventListener("input", markDirty);
document.getElementById("tts-engine-select")?.addEventListener("change", () => {
  updateCosyVoiceHint(); // 面板内音色状态提示照常更新（不是 toast）
  markDirty();
});

// 设置面板 tab 切换
document.querySelectorAll(".panel-tab").forEach((tab) => {
  tab.addEventListener("click", () => switchPanelTab(tab.dataset.tab));
});

// 会话管理：导出 / 压缩 / 清空
document.getElementById("sess-export").addEventListener("click", exportConversationTxt);
document.getElementById("sess-compress").addEventListener("click", compressContext);
document.getElementById("sess-clear").addEventListener("click", () => {
  if (conversation.length === 0) {
    toast("会话已经是空的");
    return;
  }
  clearConversation();
  toast("已清空对话");
});

// 设置按钮（⚙）：打开设置面板
document.getElementById("settings-btn").addEventListener("click", () => {
  openPanel("settings");
});


// ================= 键盘交互（微信式） =================
// 微信式键盘：立绘（背景）固定不动，聊天窗靠 Android adjustResize 自然压缩贴键盘。
// 关键：Capacitor 的 WebView 默认 windowSoftInputMode 是 adjustResize，
// 键盘弹出时 WebView 视口变矮 → 底部聊天窗自动压缩、输入框贴键盘上方、消息区可滚动。
// 前端不需要 translateY，只需保证立绘不随键盘缩放（已在 resize 监听里做键盘检测）。







// ---- TTS 直连阿里云 DashScope（CORS 已验证放行；Key 存 localStorage） ----
const ALIYUN_KEY_KEY = "amadeus_aliyun_api_key";
const TTS_ENABLED_KEY = "amadeus_tts_enabled_mobile";

function loadAliyunKey() { return localStorage.getItem(ALIYUN_KEY_KEY) || ""; }
function saveAliyunKey(k) { localStorage.setItem(ALIYUN_KEY_KEY, (k || "").trim()); }
function ttsEnabled() { return localStorage.getItem(TTS_ENABLED_KEY) === "1"; }
function setTtsEnabled(v) { localStorage.setItem(TTS_ENABLED_KEY, v ? "1" : "0"); }

// 阿里云 TTS 引擎：2026-10-19 起只用 cosyvoice-v3.5-flash 一个模型。
// 依据官方文档（help.aliyun.com/zh/model-studio/cosyvoice-v3-5-flash，2026-10-10 更新）：
// - 0.8 元/万字符，RPM 180，华北2（北京）新账号 1 万字符免费额度
// - 声音复刻音色支持 11 种语言（含日语 ja），复刻本身不计费，只按合成字数收费
// - 旧的 qwen3-tts-vc-2026-01-22 属"带日期的快照模型"，已被 2026-10-10 语音系列退市公告波及
const TTS_ENGINE_KEY = "amadeus_tts_engine_mobile";
const TTS_ENGINES = [
  { id: "cosyvoice-v3.5-flash", label: "cosyvoice-v3.5-flash" },
];
const DEFAULT_TTS_ENGINE = "cosyvoice-v3.5-flash";
function loadTTSEngine() {
  const saved = localStorage.getItem(TTS_ENGINE_KEY);
  // 统一迁移：旧版存过 qwen3-tts-vc / cosyvoice-v3-flash / v3.5-plus 等任何引擎，一律切到现行模型
  if (saved !== DEFAULT_TTS_ENGINE) {
    localStorage.setItem(TTS_ENGINE_KEY, DEFAULT_TTS_ENGINE);
    return DEFAULT_TTS_ENGINE;
  }
  return saved;
}
function saveTTSEngine(e) { localStorage.setItem(TTS_ENGINE_KEY, e); }

// 音色：绑死 target_model = cosyvoice-v3.5-flash（官方明确：复刻音色创建时绑定 target_model，不能跨模型使用）。
// 复刻走 voice-enrollment / create_voice，参考音频必须是公网可访问的 URL。
const COSYVOICE_VOICE_KEY = "amadeus_cosyvoice_voice_mobile"; // JSON: {engine: voiceName}（音色绑定 target_model，按引擎分别存）
// 复刻样本公网地址（阿里云要求公网 URL）。
// 2026-10-19 换到自建的稳定静态站（原 workbuddy.link 临时应用链接属 CloudStudio Gateway，
// 会随应用休眠失效；且旧地址 Content-Type 是 octet-stream）。新地址实测 200 / audio/mpeg / md5 一致。
// 也可通过 localStorage 覆盖：localStorage.setItem("amadeus_voice_sample_url", "https://你的地址/x.mp3")
const COS_SAMPLE_URL_DEFAULT = "https://amadeus-voice-sample.app.workbuddy.host/voice_sample.mp3";
function cosSampleUrl() {
  return (localStorage.getItem("amadeus_voice_sample_url") || "").trim() || COS_SAMPLE_URL_DEFAULT;
}

function loadCosyVoiceVoices() {
  try { return JSON.parse(localStorage.getItem(COSYVOICE_VOICE_KEY) || "{}"); } catch { return {}; }
}
function saveCosyVoiceVoice(engine, voice) {
  const m = loadCosyVoiceVoices();
  m[engine] = voice;
  localStorage.setItem(COSYVOICE_VOICE_KEY, JSON.stringify(m));
}
/** 设置面板：更新音色状态提示 */
function updateCosyVoiceHint() {
  const hint = document.getElementById("cosyvoice-voice-hint");
  if (!hint) return;
  const v = loadCosyVoiceVoices()[DEFAULT_TTS_ENGINE];
  if (v) {
    hint.textContent = `红莉栖音色已就绪：${v}`;
    hint.style.color = "";
  } else {
    hint.textContent = "首次开语音自动复刻红莉栖音色（用公网样本，通常几秒；偶发需等 1-2 分钟部署）";
    hint.style.color = "#F2B03A";
  }
}
/** 确保当前引擎有专属克隆音色；没有则用 voice-enrollment 接口复刻红莉栖声音（target_model 必须与合成引擎一致） */
async function ensureCosyVoice(apiKey, engine) {
  const m = loadCosyVoiceVoices();
  if (m[engine]) return m[engine];
  const res = await httpPostJson(
    "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization",
    { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    {
      model: "voice-enrollment",
      input: {
        action: "create_voice",
        target_model: engine,
        prefix: "amadeus",
        url: cosSampleUrl(),
        language_hints: ["ja"],
      },
    }
  );
  const data = res.data || {};
  if (!res.ok || data.error) {
    const errMsg = data.error?.message || (data.error ? JSON.stringify(data.error) : res.rawText || `HTTP ${res.status}`);
    throw new Error(`cosyvoice 音色克隆失败: ${errMsg}`);
  }
  // CosyVoice 复刻（voice-enrollment / create_voice）返回 output.voice_id（旧版 Qwen-TTS 返回 output.voice，一并兼容）
  const voice = data?.output?.voice_id || data?.output?.voice;
  if (!voice) {
    console.warn("[TTS] 音色复刻响应结构异常:", JSON.stringify(data).slice(0, 600));
    throw new Error(`音色复刻成功但未返回音色名（响应: ${JSON.stringify(data).slice(0, 200)}）`);
  }
  saveCosyVoiceVoice(engine, voice);
  console.log(`[TTS] CosyVoice 音色克隆成功: ${engine} → ${voice}`);
  return voice;
}

// ================= 双通道请求（关键：DashScope 拒浏览器直连 403，APK 内走 Capacitor 原生 HTTP 绕 CORS） =================
// 原生环境：window.Capacitor.Plugins.Http（@capacitor-community/http，Android OkHttp，无 CORS 限制）
// 浏览器环境：fetch（预览时 DashScope 仍会 403，真机 APK 内才生效）

function isNativeApp() {
  return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}

function nativeHttp() {
  if (!isNativeApp()) return null;
  // Capacitor 内置 CapacitorHttp：原生端注册在 Plugins，web 端 @capacitor/core 导出在 Capacitor 命名空间
  if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp) {
    return window.Capacitor.Plugins.CapacitorHttp;
  }
  if (window.Capacitor && window.Capacitor.CapacitorHttp) {
    return window.Capacitor.CapacitorHttp;
  }
  return null;
}

/** POST JSON → { ok, status, data, rawText }（data 为对象；rawText 原始响应，诊断用） */
async function httpPostJson(url, headers, body) {
  // 调试代理（浏览器预览模拟原生无 CORS）：仅开发用，走本地 serve.py /proxy 转发
  if (localStorage.getItem("amadeus_tts_debug_proxy") === "1") {
    const proxyRes = await fetch("http://127.0.0.1:8931/proxy", {
      method: "POST",
      headers: Object.assign({}, headers, { "X-Target-Url": url }),
      body: JSON.stringify(body),
    });
    const text = await proxyRes.text().catch(() => "");
    let data = {};
    try { data = JSON.parse(text); } catch { /* 非 JSON */ }
    return { ok: proxyRes.ok, status: proxyRes.status, data, rawText: text };
  }
  const nh = nativeHttp();
  if (isNativeApp() && nh) {
    const res = await nh.post({ url, headers, data: body, responseType: "json" });
    return { ok: res.status >= 200 && res.status < 300, status: res.status, data: res.data, rawText: "" };
  }
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text().catch(() => "");
  let data = {};
  try { data = JSON.parse(text); } catch { /* 非 JSON */ }
  return { ok: res.ok, status: res.status, data, rawText: text };
}

/** GET 音频 URL → dataURL（原生下载绕 CORS；浏览器 fetch 转 blob） */
async function httpGetAudioDataUrl(url) {
  // DashScope 返回的音频 OSS 地址是 http:// 明文；安卓 9+ 默认禁止明文 HTTP（Cleartext not permitted）
  // → 强制升级为 https（阿里云 OSS 默认支持 HTTPS），真机才能下载；桌面端/浏览器不受影响
  url = String(url || "").replace(/^http:\/\//i, "https://");
  // 调试代理（浏览器预览）：本地下载音频转 base64
  if (localStorage.getItem("amadeus_tts_debug_proxy") === "1") {
    const proxyRes = await fetch("http://127.0.0.1:8931/proxy/audio?url=" + encodeURIComponent(url));
    const data = await proxyRes.json().catch(() => ({}));
    if (data.base64) return `data:audio/mpeg;base64,${data.base64}`;
    throw new Error(data.error || "音频下载失败");
  }
  const nh = nativeHttp();
  if (isNativeApp() && nh) {
    const res = await nh.get({ url, responseType: "blob" });
    // 原生端 responseType blob → data 是 base64 字符串
    if (typeof res.data === "string" && res.data.length > 0) {
      return `data:audio/mpeg;base64,${res.data}`;
    }
  }
  const blobRes = await fetch(url);
  if (!blobRes.ok) throw new Error(`音频下载失败（HTTP ${blobRes.status}）`);
  const blob = await blobRes.blob();
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onloadend = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

/** TTS 合成（cosyvoice-v3.5-flash + 红莉栖复刻音色）→ 返回可播放 data URL。lang: "ja"，emotion 驱动语气 */
async function synthesizeSpeech(text, lang, emotion) {
  const apiKey = loadAliyunKey().trim();
  if (!apiKey) throw new Error("未配置阿里云 API Key（设置 → 语音输出）");
  if (!ttsEnabled()) return null;

  // 文本清洗：只去掉会被念出来的「（动作）」括号，**不再抹平情绪标点**。
  // 2026-10-27 修复"说话没感情"：旧清洗把省略号一律换成句号（……→。），
  // 日语的迟疑、拖音、欲言又止全被改成四平八稳的陈述句，合成出来自然就是念稿腔。
  // 现在省略号 → 顿号（短停顿，保留迟疑感），！？ 原样保留，只做重复标点去重。
  let t = text.replace(/[（(][^）)]*[）)]/g, "").replace(/\s+/g, " ").trim();
  t = t.replace(/[.．]{3,}/g, "、").replace(/…+/g, "、").replace(/・{2,}/g, "、");
  t = t.replace(/、{2,}/g, "、").replace(/([。！？!?])\1+/g, "$1");
  t = t.replace(/[~〜]/g, "");
  t = t.replace(/\s+/g, " ").trim();
  t = t.replace(/[、，,]+$/, ""); // 结尾不留悬空停顿（否则会出现拖长的尾音）
  if (t && !/[。！？!?]$/.test(t)) t += "。";
  if (!t) return null;

  // 硬规则（2026-10-26）：合成只允许日语。中文被日语发音规则念出来就是"怪腔调"，
  // 宁可不念也不念错 —— 与电脑版"纯中文跳过 TTS"的策略一致。
  if (lang !== "ja") {
    console.warn("[TTS] 非日语文本，跳过合成（不允许用日语声线念中文）");
    return null;
  }
  const engine = loadTTSEngine();
  return await synthesizeCosyVoice(t, apiKey, engine, "ja", emotion);
}

/** TTS 错误 → 中文提示 */
function ttsErrorToZh(err) {
  const msg = (err && err.message) || String(err);
  if (/401|InvalidApiKey|invalid api key|Unauthorized/i.test(msg)) return "阿里云 API Key 无效，请到 设置 → 语音输出 检查 Key";
  if (/403|not.?authorized|forbidden|no permission/i.test(msg)) return "语音输出未授权：" + msg.slice(0, 120) + "（确认 Key 属于华北2（北京）地域，且已开通百炼）";
  if (/cleartext|not permitted|NetworkSecurity|明文/i.test(msg)) return "音频下载被安卓系统拦截（明文 HTTP）：" + msg.slice(0, 100) + "（已用 HTTPS 重试，若仍报错请更新 App）";
  if (/Arrearage|overdue|欠费|余额|InsufficientBalance/i.test(msg)) return "阿里云账户余额不足：" + msg.slice(0, 100) + "（百炼按量付费，需先充值）";
  if (/429|quota|limit|exceed|额度|throttl/i.test(msg)) return "语音输出额度/限流：" + msg.slice(0, 120) + "（免费额度用完或超出 RPM 180，稍等重试或充值）";
  if (/voice|音色|deploying|审核|enroll/i.test(msg)) return "音色问题：" + msg.slice(0, 120) + "（复刻音色可能还在部署，等 1-2 分钟重试；或检查复刻样本的公网 URL 是否还能打开）";
  if (/400|invalid|param/i.test(msg)) return "语音输出请求参数错误：" + msg.slice(0, 60);
  if (/网络|network|fetch|timeout/i.test(msg)) return "语音输出网络异常，请检查网络后重试";
  return "语音输出失败：" + msg.slice(0, 80);
}

/** CosyVoice 合成（cosyvoice-v3.5-flash；带一次音色失效自愈重试）。lang: "ja" | "zh"，emotion 映射成 instruction */
async function synthesizeCosyVoice(text, apiKey, engine, lang, emotion) {
  const model = engine || DEFAULT_TTS_ENGINE;
  let voice = await ensureCosyVoice(apiKey, model);
  try {
    return await requestCosyVoiceAudio(text, apiKey, model, voice, lang, emotion);
  } catch (err) {
    // 音色失效（换过账号 / 音色被删 / 复刻尚未部署完成）→ 清缓存重新复刻一次再试
    if (/voice|音色|enroll|not.?found/i.test(String((err && err.message) || err))) {
      console.warn("[TTS] 音色疑似失效，清缓存重新复刻:", (err && err.message) || err);
      const m = loadCosyVoiceVoices();
      delete m[model];
      localStorage.setItem(COSYVOICE_VOICE_KEY, JSON.stringify(m));
      voice = await ensureCosyVoice(apiKey, model);
      return await requestCosyVoiceAudio(text, apiKey, model, voice, lang, emotion);
    }
    throw err;
  }
}

/**
 * 情绪 → CosyVoice 合成指令（instruction）。
 * 官方文档（非实时语音合成 / 指令控制）：CosyVoice 系列用 `instruction` 参数传自然语言指令，
 * cosyvoice-v3.5-flash 的**复刻音色可输入任意指令**，长度上限 100 字符（汉字按 2 个字符计），
 * 所以这里每条都压在 25 字以内。
 *
 * 2026-10-27 重写：旧文案是"声音放小""声音闷一点"这类**音量/音色**描述，
 * 合成出来只会更小更平，听感反而更没感情。现在全部改成**表演动作**描述
 * （什么心情、怎么说话、句子怎么断），让模型去演而不是去调音量。
 * neutral 也传一条轻指令：不传时 CosyVoice 用默认平铺语气，就是用户说的"念稿"。
 */
const EMOTION_INSTRUCTION = {
  neutral: "像平常跟人聊天，语气自然有起伏，别念稿",
  smile: "带着笑意说，语气上扬轻快，像忍不住笑出来",
  angry: "被气到的口气，语速快、尾音上扬带刺，但别真凶",
  blush: "心事被说中，慌乱又嘴硬，忽快忽慢，句尾发虚",
  sad: "情绪低落，语速慢、句子之间留停顿，声音沉",
};

/** 发一次 CosyVoice 合成请求 → 可播放 dataURL。
 * 参数名按官方 HTTP API（cosyvoice-tts-http-api）：语速是 rate，不是 speech_rate。
 * language_hints 是「目标语言」，与复刻样本语言无关（数组只处理第一个元素）。
 * instruction 控制情感/语气（CosyVoice 用 instruction，Qwen-TTS 才是 instructions）。
 */
async function requestCosyVoiceAudio(text, apiKey, model, voice, lang, emotion) {
  const instruction = EMOTION_INSTRUCTION[emotion] || "";
  const buildInput = (withInstruction) => {
    const input = {
      text,
      voice,
      format: "mp3",
      sample_rate: 24000,
      language_hints: [lang === "zh" ? "zh" : "ja"],
      rate: 1.0,
    };
    if (withInstruction && instruction) input.instruction = instruction;
    return input;
  };
  const post = (withInstruction) =>
    httpPostJson(
      "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer",
      { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      { model, input: buildInput(withInstruction) }
    );

  let res = await post(true);
  let data = res.data || {};
  // 保险：个别模型/音色组合可能不认 instruction（返回 400 参数错误）。
  // 这种情况退回不带指令的请求，宁可语气平一点，也不能整条语音失效。
  if ((!res.ok || data.error) && instruction) {
    const msg = String(data.error?.message || data.error || res.rawText || "");
    if (/instruction|invalid.?param|400|Unsupported/i.test(msg)) {
      console.warn("[TTS] instruction 被拒，退回无指令合成:", msg.slice(0, 120));
      res = await post(false);
      data = res.data || {};
    }
  }
  if (!res.ok || data.error) {
    const errMsg = data.error?.message || (data.error ? JSON.stringify(data.error) : res.rawText || `合成失败（HTTP ${res.status}）`);
    throw new Error(`cosyvoice: ${errMsg}`);
  }
  const audioObj = data?.output?.audio;
  const url = audioObj?.url || audioObj?.urls?.[0];
  if (!url) throw new Error("CosyVoice 未返回音频");
  return await httpGetAudioDataUrl(url);
}


let vc = null; // 通话运行时状态（保留：vcPlayAudio 的 if(vc) 引用；通话功能已删，恒 null）
let proactiveTimer = null; // 主动消息定时器（声明曾随通话代码误删 → 发送消息时 cancelProactive 读未声明变量报错，已修复）
let proactiveRunning = false;



// ---- 嘴唇同步状态（TTS 播放时用 analyser 音量驱动 Live2D 口型） ----
let lipActive = false;
let lipAnalyser = null;
window.addEventListener("amadeus-tts-start", (e) => {
  const d = e.detail;
  lipActive = true;
  lipAnalyser = d && d.analyser ? d.analyser : null;
});
window.addEventListener("amadeus-tts-end", () => {
  lipActive = false;
  lipAnalyser = null;
});


/** 播放 TTS 音频（URL 或 dataURL），返回 Promise，播放完 resolve；触发嘴唇同步事件 */
function vcPlayAudio(src) {
  return new Promise((resolve) => {
    if (vc) vc.speaking = true; // 播放期间锁定 VAD（防回声触发误录音）
    const audio = new Audio(src);
    let audioCtx = null;
    let analyser = null;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.7;
      const source = audioCtx.createMediaElementSource(audio);
      source.connect(analyser);
      analyser.connect(audioCtx.destination);
    } catch (e) {
      audioCtx = null;
    }
    if (vc) vc.ttsAudio = audio; // 通话中记录到 vc 供挂断停止；文字聊天（vc=null）也可播放
    window.__lastTTSAudio = audio; // 全局引用：任何场景都能停止
    window.dispatchEvent(new CustomEvent("amadeus-tts-start", { detail: { analyser } }));
    const releaseSpeaking = () => { if (vc) vc.speaking = false; };
    audio.onended = () => {
      window.dispatchEvent(new CustomEvent("amadeus-tts-end"));
      releaseSpeaking();
      if (audioCtx) { try { audioCtx.close(); } catch { /* 忽略 */ } }
      resolve();
    };
    audio.onerror = () => {
      window.dispatchEvent(new CustomEvent("amadeus-tts-end"));
      releaseSpeaking();
      resolve();
    };
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    audio.play().catch(() => { releaseSpeaking(); resolve(); });
  });
}

/** 停止正在播放的 TTS 音频（任意场景） */
function stopAnyTTS() {
  const a = window.__lastTTSAudio;
  if (a) {
    try { a.pause(); a.src = ""; } catch { /* 忽略 */ }
    window.__lastTTSAudio = null;
    window.dispatchEvent(new CustomEvent("amadeus-tts-end"));
  }
}

/** 文字聊天回复朗读（语音输出开启时）：TTS 播放日语段 + 嘴唇同步；通话中由通话逻辑负责 */
async function speakReply(raw) {
  if (vc) return; // 语音通话中跳过（通话有自己的 TTS 流程）
  try {
    if (!ttsEnabled() || !loadAliyunKey().trim()) return;
    const { text: ttsText, lang } = getTTSText(raw);
    if (!ttsText) return;
    const emotion = inferEmotion(raw); // 标签优先，没标签就从文字内容推断（驱动表情 + 语音语气）
    let finalText = ttsText;
    let finalLang = lang;
    // 翻译兜底（2026-10-26）：模型没输出有效日语时，单独发一次翻译请求把中文段译成日语。
    // 硬规则：宁可不出声，也绝不用日语声线念中文（用户的明确要求，与电脑版一致）。
    if (lang === "zh") {
      console.warn("[TTS] 模型未输出有效日语，走翻译兜底");
      const ja = await translateToJapanese(ttsText);
      if (!ja) {
        console.warn("[TTS] 翻译兜底失败，本次跳过朗读（不会念中文）");
        return;
      }
      finalText = ja;
      finalLang = "ja";
      console.log("[TTS] 翻译兜底成功，日语:", ja.slice(0, 60));
      // 关键补救：把这句日语回填进会话历史，下一轮模型就能看到"双语示范"并自我强化，
      // 避免每条回复都要翻译（历史是模型学习输出格式的主要来源）
      try {
        const last = [...conversation].reverse().find((m) => m.role === "assistant" && !m.summary);
        if (last && !String(last.content || "").includes("===")) {
          last.content = String(last.content || "").trim() + "\n===\n" + ja;
          saveConversation();
          console.log("[TTS] 已把日语回填到历史，修正格式示范");
        }
      } catch (e) {
        console.warn("[TTS] 回填历史失败:", e);
      }
    }
    const audioSrc = await synthesizeSpeech(finalText, finalLang, emotion);
    if (audioSrc) await vcPlayAudio(audioSrc);
  } catch (e) {
    console.warn("[TTS] 回复朗读失败:", e);
    // 聊天框显示中文错误 + 指引（不写入会话历史，仅提示）
    addMessage("assistant", `[语音输出] ${ttsErrorToZh(e)}`);
  }
}

/**
 * 翻译兜底：把中文文本译成红莉栖语气的自然日语口语。
 * 复用当前对话供应商（小米 / DeepSeek）的 Key 与模型；非流式短请求。
 * 返回 "" 表示失败（调用方回落中文朗读）。
 */
async function translateToJapanese(zhText) {
  const cfg = currentConfig();
  if (!cfg.apiKey) return "";
  // 8 秒超时：网络抖动时不让用户一直干等（超时即放弃，本次不出声）
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${cfg.endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          {
            role: "system",
            content:
              "你是日语配音编剧。把用户给的中文改写成牧濑红莉栖（傲娇但内心温柔的天才少女）会**说出口**的日语台词，" +
              "这段台词会被语音合成朗读，所以要写得能「演」出来。硬性要求：" +
              "1) 必须是真日语：假名齐全、助词完整、动词变形正确，禁止把中文汉字照抄进来；" +
              "2) 情绪强度必须保留：该喊就带 ！，该迟疑就带 ……，该小声就断成短句，" +
              "禁止改写成四平八稳的书面语，也禁止加敬语把语气拉平；" +
              "3) 用口语短句，允许口癖（あんた／ばか／別に／ったく／もう／ちょっと 等），" +
              "句子之间用 、和 ！ 制造节奏，至少出现一个 ！ 或 ……；" +
              "4) 长度与原文相当：不要扩写，也不要概括成一句；" +
              "5) 只输出译文本身：不要解释、不要引号、不要任何中文。",
          },
          { role: "user", content: zhText },
        ],
        max_tokens: 400,
        temperature: 0.3,
        ...noThinking(cfg),
      }),
    });
    if (!res.ok) return "";
    const data = await res.json().catch(() => ({}));
    let ja = String(data?.choices?.[0]?.message?.content || "").trim();
    // 去掉模型偶尔加的引号包裹
    ja = ja.replace(/^[「『"'“]+/, "").replace(/[」』"'”]+$/, "").trim();
    // 必须含假名才算有效日语（防止模型把中文原样退回来）
    if (!ja || !JA_KANA_RE.test(ja)) return "";
    return ja;
  } catch (e) {
    console.warn("[TTS] 翻译兜底请求失败:", e);
    return "";
  }
}

/** 取消待触发的主动消息（用户发消息时调用） */
function cancelProactive() {
  if (proactiveTimer) {
    clearTimeout(proactiveTimer);
    proactiveTimer = null;
  }
}

/** 安排一次主动消息：delayMs 后触发（已有待触发/正在生成则跳过） */
function scheduleProactive(instruction, delayMs) {
  if (proactiveTimer || proactiveRunning) return;
  proactiveTimer = setTimeout(() => {
    proactiveTimer = null;
    runProactive(instruction);
  }, delayMs);
}

async function runProactive(instruction) {
  if (proactiveRunning || !hasAnyKey() || vc) return; // 通话中不打扰
  proactiveRunning = true;
  try {
    await sendProactiveMessage(instruction);
  } catch (e) {
    console.warn("[Proactive] 主动消息失败:", e);
  } finally {
    proactiveRunning = false;
  }
}

/** 主动消息：非流式生成一条短消息，带 loading ring，显示 + 存入会话 */
async function sendProactiveMessage(instruction) {
  const cfg = currentConfig();
  if (!cfg.apiKey) return;
  const messages = [
    { role: "system", content: buildSystemPrompt() },
    ...buildHistory(),
    { role: "system", content: instruction + "\n（这是你主动发的消息，简短自然，一到两句即可，用平时的口吻和格式）" },
  ];
  const res = await fetch(`${cfg.endpoint}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, messages, max_tokens: 256, stream: false, ...noThinking(cfg) }),
  });
  if (!res.ok) return;
  const data = await res.json().catch(() => ({}));
  const content = data.choices?.[0]?.message?.content || "";
  if (!content.trim()) return;

  // 显示：先 ring 转一下（模拟"想了想"），再出文字
  const row = addMessage("assistant", "", undefined, Date.now(), conversation.length);
  const msgText = row.querySelector(".msg-text");
  const loadCanvas = document.createElement("canvas");
  loadCanvas.className = "reply-loading";
  loadCanvas.style.width = "24px";
  loadCanvas.style.height = "24px";
  loadCanvas.style.display = "inline-block";
  loadCanvas.style.verticalAlign = "middle";
  msgText.appendChild(loadCanvas);
  SpritePlayer(loadCanvas, "assets/ring.png", { rows: 12, columns: 5, fps: 40, totalFrames: 60, loop: 0 });
  await new Promise((r) => setTimeout(r, 500 + Math.random() * 700));

  loadCanvas.remove();
  updateMessageText(row, displayText(content));
  triggerEmotion(emotionOf(content));
  conversation.push({ role: "assistant", content: content || "", ts: Date.now() });
  saveConversation();
  updateSessStat();
}

/** 回复完成后：30% 概率安排一条"补充消息"（45~120 秒后） */
function scheduleFollowUpAfterReply() {
  if (Math.random() > 0.3) return;
  scheduleProactive(
    "你刚刚和用户聊了几句。现在你突然想起还有一句话想补充（或想追问一下），以红莉栖的口吻自然地把这句补上，不要说已经说过的内容，也不要啰嗦。",
    45000 + Math.random() * 75000
  );
}

/** 空闲主动问候：最后消息超 30 分钟 → 主动找用户（每 5 分钟检查，2 小时内最多 1 次） */
function initProactiveIdleCheck() {
  setInterval(() => {
    if (!conversation.length || !hasAnyKey() || vc) return;
    const lastTs = conversation[conversation.length - 1].ts || 0;
    const idleMs = Date.now() - lastTs;
    if (idleMs > 30 * 60 * 1000 && !proactiveTimer && !proactiveRunning) {
      // 50% 概率这次真的发，避免每次都打扰
      if (Math.random() < 0.5) {
        scheduleProactive(
          "用户已经超过30分钟没和你说话了。像真人朋友一样，你主动给用户发一条消息：自然的问候（比如问他在忙什么，或随口说你正在做的事），语气自然随意，不要催促质问。",
          6000
        );
      }
    }
  }, 5 * 60 * 1000);
}

// ================= 启动 =================

(async function main() {
  // 恢复已保存的会话（刷新不丢聊天记录）
  conversation = loadConversation();
  if (conversation.length > 0) {
    renderConversation();
  } else {
    renderEmpty();
  }

  // 光标常驻显示（桌面版一致）：启动即显示，跟随输入光标
  initCursor();
  setTimeout(updateCursor, 300);

  // 主动消息：长时间不聊时红莉栖偶尔主动找你（每 5 分钟检查）
  initProactiveIdleCheck();

  // 首次启动：无 Key 时弹出配置引导
  if (!hasAnyKey()) {
    openPanel("onboarding");
    console.log("[Config] 首次启动，显示 API Key 配置引导");
  }

  // 图片按钮初始状态（跟随供应商：DeepSeek 不支持图）
  updateImageBtnState();

  // 预热人设：避免首次主动消息时 system 提示里还没有人设，同时刷新设置面板的人设状态
  loadPersonality();

  // 立绘开关初始状态
  applyL2DEnabled();

  // Live2D 加载期间显示"加载中"占位
  showLive2DLoading();

  // 启动 Live2D（独立容器，不阻塞界面）
  initLive2D(document.getElementById("live2d-container"))
    .then(() => console.log("[Live2D] 初始化完成"))
    .catch((e) => {
      console.error("[Live2D] 初始化失败:", e);
      hideLive2DLoading();
      // 兜底：失败时用静态立绘
      const c = document.getElementById("live2d-container");
      if (c && !c.querySelector("img")) {
        const img = document.createElement("img");
        img.src = "assets/kurisu.png";
        img.style.cssText = "position:absolute;left:50%;bottom:0;transform:translateX(-50%);height:72%;max-width:100%;object-fit:contain;";
        c.appendChild(img);
      }
    });

  // 顶部动画 Logo
  SpritePlayer(document.getElementById("logo-canvas"), "assets/sprite_logo.png", {
    rows: 6, columns: 7, fps: 20, totalFrames: 38, loop: 1,
  });

  console.log("[Amadeus] 手机版启动完成");
})();
