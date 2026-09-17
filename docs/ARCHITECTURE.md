# 架构与模块契约

> 这份文档是 `pdf-zh-translator` v3 重构的设计说明，也是各模块之间的接口契约。
> 改代码前先看这里，避免破坏约定。

## 0. 硬约束

1. **保持纯静态**：不用打包器、不用 npm 依赖、不用 ES module（`import` 在 `file://` 下会被 CORS 拦掉，双击打不开）。
2. **经典脚本 + IIFE**，挂到全局：`(function (global) { ... })(typeof window !== "undefined" ? window : globalThis);`
3. **每个模块拆成"纯函数核心 + 薄画布适配层"**：
   - 纯函数只依赖 `{width, height, data}`（与 `ImageData` 同形状）和普通数组，**能在 Node 里直接跑单测**。
   - 只有需要 `drawImage` / `fillText` / `getImageData` 的地方才碰 canvas。
   - 创建画布一律走 `PZUtil.createCanvas(w, h)`，不要在模块里直接 `document.createElement`，否则无法测试。
4. **注释用中文**，重点解释**为什么**这么做，而不是复述代码在干什么。
5. 所有文件必须通过 `node --check`。
6. 不要在算法里硬编码任何具体产品/客户/角色的词汇——那属于 `js/config.js`。

## 1. 坐标系约定

**全程统一为「左上角原点、x 向右、y 向下」**。这是唯一的坐标系，不要出现第二套。

- 检测、裁切、排版、覆盖：都用这个。
- pdf.js 拿到的 `transform` 是「左下角原点、y 向上」，必须在 `pdf-engine.js` 内部转换掉，
  **不允许把 y 向上的坐标泄漏到模块外面**。原项目就是因为两套坐标混用，才在
  `renderPageComposed` 里出现 `canvas.height - (line.y + line.h) * scale` 这种易错算式。

## 2. 处理流水线

```
                        ┌──────────────────────────────┐
   输入（1 个 PDF 或 N 张图片）                            │
                        └──────────────┬───────────────┘
                                       │
              ┌────────────────────────┴────────────────────────┐
              │                                                 │
        【PDF 分支】                                        【图片分支】
   PZPdf.renderPage()                                  PZDetect.detect()
   → 原始页面 canvas（带文字层）                        → 文字区域 regions[]
              │                                                 │
              │                                    ┌────────────┴────────────┐
              │                                    │                         │
              │                          【云端识别】vision            【本地识别】local
              │                          PZVision.translate()      PZOcr.recognize()
              │                          （区域放大 + 整图兜底）    （区域条带 + worker池）
              │                                    │                         │
              │                                    │              PZTranslate.translateMany()
              │                                    │              （免费 / 大模型 / 术语表）
              └────────────────────┬───────────────┴─────────────────────────┘
                                   │
                     items[] = [{x, y, w, h, src, dst}]   ← 画布像素坐标
                                   │
                          PZOverlay.render(canvas, items)
                          （采样底色 → 盖住原文 → 重绘中文，统一排版引擎）
                                   │
                        ┌──────────┴──────────┐
                        │                     │
                  预览（canvas）         PZPdf.canvasesToPdf() → 下载
```

**关键点**：PDF 和图片最终都产出「一张 canvas + 一组 items」，然后走**同一个** `PZOverlay.render`。
原项目两套覆盖逻辑（`pdf-engine.renderPageComposed` / `image-engine.overlayLines`）字号策略不一致，
是排版问题的根源。

## 3. 模块职责

| 文件 | 全局对象 | 职责 |
|---|---|---|
| `js/util.js` | `PZUtil` | 几何、文本比对、并发池、中止、画布辅助、模型输出解析 |
| `js/config.js` | `PZConfig` | 供应商预设、领域配置（术语表+提示词）、参数上限、提示词构建 |
| `js/imageproc.js` | `PZImage` | 图像预处理：灰度、积分图、二值化、反锐化掩膜、清晰度评估 |
| `js/detect.js` | `PZDetect` | 纯 JS 文字区域检测（连通域 → 行 → 区域块） |
| `js/vision.js` | `PZVision` | 云端视觉模型客户端（Gemini / OpenAI 兼容），区域放大识别 + 整图兜底 |
| `js/ocr-local.js` | `PZOcr` | 本地 Tesseract OCR（worker 池 + 条带切分） |
| `js/translate.js` | `PZTranslate` | 翻译（免费公共接口 / 大模型 / 术语表），代码与型号保护 |
| `js/overlay.js` | `PZOverlay` | 中文排版与覆盖（唯一一套） |
| `js/pdf-engine.js` | `PZPdf` | pdf.js 文字层提取、页面渲染、jsPDF 导出 |
| `js/app.js` | —（无导出） | 控制器：状态机、UI 绑定、流水线编排、进度与取消 |

## 4. 各模块接口

### 4.1 `PZImage`（纯函数为主）

```js
// —— 纯函数：只吃 {width,height,data} 与 TypedArray ——
toGray(img)                       -> Uint8ClampedArray   // 长度 w*h，Rec.601 亮度
integral(gray, w, h)              -> { sum: Float64Array, sq: Float64Array, w, h }
otsu(gray)                        -> number              // 0..255
adaptiveThreshold(gray, w, h, o)  -> Uint8Array          // 每像素 0 或 1（1 = 墨）
   // o: { window, C }  window 为局部窗口边长（奇数），threshold = local_mean - C
boxBlurGray(gray, w, h, r, n)     -> Float32Array        // 可分离盒式模糊，跑 n 遍 ≈ 高斯
unsharpGray(gray, w, h, o)        -> Uint8ClampedArray   // o:{radius, amount}
laplacianVariance(gray, w, h)     -> number              // 清晰度指标，越大越锐
inkRatio(bin)                     -> number              // 墨像素占比

// —— 画布适配层 ——
canvasToImage(canvas)             -> {width,height,data}
imageToCanvas(img)                -> canvas
downscale(canvas, maxSide)        -> canvas              // 只缩不放
sharpenCanvas(canvas, o)          -> canvas              // o:{radius,amount}，先提亮再反锐化
prepareForOcr(canvas, o)          -> canvas              // o:{zoom,sharpen,binarize}
   // 针对「像素干净但边缘不锐利」的截图：放大 → 反锐化掩膜 → 可选自适应二值化
measureSharpness(canvas)          -> number              // 0..1，用于自动决定锐化强度
```

**为什么需要反锐化掩膜**：客户给的电子截图往往是缩放过或被 JPEG 压过的，字边缘是灰的。
原实现只做全局直方图拉伸，并没有把边缘变锐；再用双线性插值放大只会更糊。
`放大 → 反锐化掩膜` 才是让 Tesseract 能看清小字的正路。

### 4.2 `PZDetect`

```js
detect(canvas, opts) -> {
  width, height,                       // 原图像素尺寸
  regions: [ { x, y, w, h, lines: [{x,y,w,h}], score } ],   // 原图坐标
  lines:   [ { x, y, w, h } ],                              // 原图坐标
  stats:   { scale, components, kept, ms }
}
```

算法（每一步都导出成独立函数，便于单测）：
1. `downscale` 到长边 `opts.maxSide`（默认 1600）。检测不需要全分辨率。
2. 灰度 → `adaptiveThreshold`（局部均值 - C），这样彩色底、渐变底也能二分。
3. 水平膨胀，把相邻字形黏成词/行（结构元宽度按估计字宽取）。
4. `connectedComponents` 连通域标记（并查集或显式栈 BFS）。
5. 连通域过滤：
   - 高度在 `[minLineHeight, height * maxLineHeightRatio]`
   - **墨密度 `inkArea / (w*h)` 落在 `[0.06, 0.62]`** —— 这一条最关键：
     一条实心直线或边框的墨密度接近 1，大量空白的大框墨密度接近 0，两者都能被排掉。
   - 宽高比在 `[0.4, 80]`
6. 组件合并成行：垂直重叠 > 60% 且水平间距 < 1.6 × 行高。
7. 行聚类成区域：用 `PZUtil.groupBoxesIntoBlocks`。
8. 坐标按 `1/scale` 还原回原图坐标，外扩 `regionPad`。

`opts` 默认值全部从 `PZConfig.LIMITS` 取。

### 4.3 `PZVision`

```js
translate(canvas, opts, hooks) -> {
  items: [{ x, y, w, h, src, dst, source: "region"|"whole" }],
  stats: { regions, requests, failed, ms }
}

opts: {
  api: "gemini" | "openai",
  baseUrl, apiKey, model,
  targetLang, glossaryEntries, profileHint,
  translate: true,          // false = 只识别，dst 留空，交给 PZTranslate
  regions: null,            // 可传入已检测好的区域，省一次检测
  signal, concurrency, maxRegions, wholeImage, limits
}
hooks: { onProgress({ phase, done, total, message }), onLog(text) }

testKey(opts)   -> { ok, model, endpoint, latencyMs }
listModels(opts)-> [ "model-id", ... ]
```

两遍策略：
- **第一遍（区域放大）**：每个区域按 `regionCropPadRatio` 外扩、放大到 `regionCropMinSide`~`regionCropMaxSide`，
  用并发池逐个请求。之所以放大，是因为小字在整图里一个字符可能只有 5~8 px，
  送到模型等于糊成一团；放大到 20~40 px 后模型才认得出。
- **第二遍（整图兜底）**：整图缩到 `visionImageMaxSide` 再识别一次，捡回第一遍漏掉的文字
  （检测算法本身会漏）。这是**保召回**的关键，不能省。
- **合并去重**：先用 `PZUtil.overlapRatio > 0.5`，再用 `PZUtil.sameText` 相似度判重；
  冲突时保留「区域遍」的结果（分辨率更高、更准）。

请求失败的处理：单个区域失败不整体崩，记进 `stats.failed` 继续；若**全部**失败则抛出最后一次错误
（不能静默返回空结果，否则用户会以为图里没字）。

### 4.4 `PZOcr`（本地）

```js
recognize(canvas, opts, hooks) -> { lines: [{ x, y, w, h, text, conf }] }
opts: { regions, detectFirst, workers, signal, limits }
hooks: { onProgress({ phase, done, total, message }), onLog }
terminate()
```

- 用 Tesseract v5 的 `createScheduler()` + `addWorker()` 起 `ocrWorkers` 个 worker **并行**。
  原实现是单 worker 串行，最多 68 次 `recognize` 排成一队，这是慢的主因。
- 不再用"多尺度全图探测"（那本身就是 3 次全图 OCR）。改用 `PZDetect` 先算区域，
  再把区域按纵向聚成 ≤ `ocrMaxBands` 条带，每条放大 `ocrBandZoom` 倍后 OCR。
  调用次数从最多 68 次降到 ≤ 11 次。
- **去掉 `tessedit_char_whitelist`**：LSTM 引擎加了白名单反而会强行把噪声映射成合法字符，
  错误率更高。改为在结果过滤里剔除垃圾，而不是在识别阶段限制字符集。

### 4.5 `PZOverlay`

```js
render(sourceCanvas, items, opts) -> canvas      // 返回新画布，不改原图
opts: { cover, fontStack, minFontSize, maxGrowY, signal }

// 纯逻辑，可注入假的 ctx 做单测
layout(ctx, text, box, opts) -> { lines, fontSize, lineHeight, x, y, align, grew }
sampleBackground(ctx, box)   -> { fill, textColor }   // 采样底色与字色
```

要点：
- **按框（而不是按原文文本）索引**。原实现用 `map[line.text]` 做映射，
  同一段英文在不同位置会被强制翻成同一个结果，且重复文本会互相覆盖。改为每条 item 自带 `dst`。
- **覆盖底色逐列插值**：不是取一个平均色刷一整块。对每一列，取框上方和下方干净像素的中位色，
  在两者之间做垂直渐变填充。这样纵向渐变底、色块边界上的文字也能盖干净，不会留下突兀的矩形。
- **字号只缩不放（除有限放宽）**：先按原文行高定字号，若换行后超出 `box.h * maxGrowY` 就逐级缩小，
  下限 `minFontSize`。**并且 `clip` 到框内**，保证绝不压到相邻文字——这是原实现最直观的毛病。
- 原文若居中（框中心与文字视觉中心接近），中文也居中；否则左对齐。
- **覆盖范围会自动扩张到"外沿干净"为止**。详见下一节。

#### "去字不干净、留灰色残影"是怎么修的

用户反馈：识别没问题，但盖掉原文之后会留残影。根因有三个，都出在覆盖范围上：

1. **垂直方向完全没有余量**（原实现只加了水平 padding，垂直是 0）。
   原文的 bbox 通常不含抗锯齿边缘和降部（`g/y/p` 的下半截会伸出去），
   不留余量就会在中文下面留一道灰边。
2. **上游给的框本身可能偏小**。视觉模型给的是 0-1000 归一化后的**估计值**，
   经常比真实文字小一圈；OCR 的 bbox 也不含描边、斜体溢出。
3. **采样读了正在被涂改的画布**。前面画上去的补丁会污染后面框的环采样，
   相邻文字互相影响。现在一律读 `sourceCanvas`（原图，没被涂改过）。

修法是 `growCoverUntilClean`：从"原框 + 余量"出发，逐侧往外扩，
每扩一步就看**紧贴外沿那一圈像素脏不脏**（与这圈自身中位色的平均偏差 > 20 视为脏），
脏就继续扩，直到干净或触到边界。

边界只用**邻居位置**约束，不按行高拍一个"合理余量"——上游的框能偏多少没有
可靠先验，拍常数就是凭经验凑数。唯一的硬约束是"不能扩到别的文字上"，
所以 `left/right` 初始就是整张画布，只被同一行上的邻居收紧。

试过一条"扩张没让边缘变干净就收手"的启发（想用它区分残影和背景纹理），
**结果是坏的**：穿过字形时外沿会一直是脏的，要完全越过字形才变干净，
所以这种启发会在见效前就放弃。已撤掉 —— 评论里留着这个教训。

在真实素材上的实测（外沿脏污 = 四条边环偏差的均值）：

| 素材 | 上游框偏差 | 原框外沿 | 修复后 | 仍脏 |
|---|---|---|---|---|
| `sample-spec.png` | 1~3px（等同 OCR bbox） | 12.5 | **0.7** | 0/27 |
| `sample-spec.png` | −12% 宽 / −20% 高 | 28.6 | **0.7** | 0/27 |
| `sample-small-text.png` | 1~3px | 16.7 | **0.2** | 0/10 |
| `sample-small-text.png` | −12% 宽 / −20% 高 | 20.7 | **4.7** | 0/10 |

**"原框外沿"这一列很关键**：即使在 1~3px 这种很小的偏差下，原框的外沿本身就是脏的。
也就是说旧实现在**所有**情况下都会留残影，不只是极端情况。

**已知未完全解决**：偏差到 −25% 宽 / −35% 高 这种极端程度时，仍有约 1/3 的行清不干净
（脏污从 27 降到 15，明显改善但不彻底）。原因是垂直方向的扩张上限 `overlayMaxGrowY`
是从**已被压小的框高**推算的，误差会叠加。要彻底解决需要把"排版用的高度预算"
和"覆盖用的高度预算"分开，目前没做。

### 4.6 `PZTranslate`

```js
translateMany(texts, opts, hooks) -> [{ src, dst, engine }]
translateOne(text, opts)
opts: { engine: "free"|"llm"|"dict", targetLang, glossaryEntries, profileHint,
        signal, concurrency, llm: { api, baseUrl, apiKey, model } }
testLlm(opts) -> { ok, model, endpoint }
listLlmModels(opts) -> [ids]
applyGlossary(text, entries) -> string
```

- 术语表从 `PZConfig` 传入，**模块内部不得有硬编码词表**。
- 大模型分批（每批 24 条）走 JSON 数组；解析失败降级为逐条。
- 失败**大声抛错**，不静默降级到免费接口（这点原实现做对了，保留）。

### 4.7 `PZPdf`

```js
loadDocument(arrayBuffer) -> pdfjs 文档
extractPage(doc, pageNo)  -> {
  page, widthPt, heightPt,              // PDF 点单位
  lines: [{ x, y, w, h, text }]         // 点单位，左上角原点
}
renderPage(page, scale)   -> canvas     // 尺寸 = widthPt*scale × heightPt*scale
canvasesToPdf(canvases, opts) -> jsPDF  // opts: { pageSizes: [{wPt,hPt}], scale }
download(pdf, filename)
FONT_STACK
```

**必须修的 bug**：原 `canvasesToPdf` 里 `k = 1600 / pxMax`，是把大画布**缩小**贴到页面上，
等效 DPI 反而被压到约 107。正确做法是**保持 PDF 原始页面尺寸**（点单位），
渲染倍率 `scale` 决定分辨率，等效 DPI = `72 * scale`。`pageSizes` 由调用方从
`extractPage` 的 `widthPt/heightPt` 传进来。

### 4.8 DOM 契约

`app.js` 依赖以下元素 id（`index.html` 必须提供）：

面板：`panel-upload` `panel-process` `panel-result` `panel-error`
上传：`dropzone` `file-input` `file-list`
引擎选择：`opt-ocr-engine`（radio 组，name=`ocr-engine`，值 `vision`/`local`）
翻译选择：`opt-translate-engine`（select）`opt-target-lang`（select）
视觉配置：`opt-vision-provider` `opt-vision-base` `opt-vision-key` `opt-vision-model`
　　　　　`opt-vision-model-custom` `btn-vision-models` `btn-vision-test` `vision-status` `vision-key-link`
文本模型：`opt-llm-provider` `opt-llm-base` `opt-llm-key` `opt-llm-model`
　　　　　`opt-llm-model-custom` `btn-llm-models` `btn-llm-test` `llm-status` `llm-key-link`
领域：`opt-profile` `opt-glossary` `opt-profile-hint`
其他选项：`opt-cover` `opt-preserve-codes`
动作：`btn-start` `btn-cancel`
进度：`process-title` `process-file` `progress-bar` `progress-text` `steps` `process-log`
结果：`result-meta` `preview-canvas` `view-label` `page-indicator` `btn-prev` `btn-next`
　　　`btn-toggle-view` `btn-download` `btn-reset` `text-list` `text-count`
错误：`error-message` `btn-error-reset`

## 5. 验证方式

沙箱里跑不了无头浏览器（Chrome 的多进程架构需要命名管道，被沙箱禁止），
所以验证分三层，核心思路是**把算法写成纯函数**，让它们能在 Node 里跑真实数据。

```bash
node test/all.js          # 跑全部测试
node --check js/app.js    # 单文件语法检查
```

| 文件 | 覆盖什么 | 为什么这么测 |
|---|---|---|
| `test/run-tests.js` | `PZImage` / `PZDetect` 的算法正确性 | 用 `PZUtil.imageLike()` 手搓像素，把"文字"画成 1px 笔画字形。**不需要字体渲染，完全可控**，而且反例（实心横线、实心色块）可以精确构造 |
| `test/test-vision.js` | `PZVision` 的协议适配、字段兼容解析、去重、坐标映射 | 网络请求没法在 Node 里跑，但把纯逻辑导出成 `_mapBoxFromCrop` / `_parseItems` / `_dedupe` / `_endpoint` 之后就能测 |
| `test/test-translate.js` | `PZTranslate` 的术语表、代码保护往返、缓存、失败行为 | 注入假的 `fetch`（`PZTranslate.setFetch`），就能在无网络环境下验证真实的请求构造与回退逻辑 |
| `test/test-integration.js` | **模块之间的契约语义** | 坐标语义、数据形状、边界行为。这类错误单模块测不出来，但一错就肉眼可见 |
| `test/test-abort.js` | 中止机制 | 异步断言，单独一个文件以免打乱同步测试的汇总时机 |
| `test/test-dom.js` | `app.js` 引用的 DOM id 与页面一致性 | 拼错一个 id 就是 `null` 元素然后崩，靠 review 容易漏，脚本比对是零成本的 |
| `test/test-api-shape.js` | 跨模块接口没漂移、没有死配置 | 10 个模块的重写里，最常见的失败不是算法错，而是某个函数改名了 |
| `test/browser-check.js` | **真实浏览器**（可选，需 playwright） | Node 覆盖不到 canvas 文字度量、`getImageData`、Tesseract worker、真实图片解码 |

### 合成测试图必须"像文字"

写检测测试时有个坑值得记下来：用**实心矩形**模拟文字是错的。
实心矩形的墨密度接近 1.0，而真实英文行是 0.2 左右 —— 检测器会把实心矩形当作
"表格分隔线/色块"正确排除，于是测试表现为"一行都没找到"，看起来像算法坏了，
实际是**参照物本身不像文字**。必须用 1px 笔画画出有空隙的字形（H/E/T/L/O/I）。

### 只有真实端到端才能抓到的 bug

`browser-check.js` 抓到一个单测完全测不出来的问题：

Tesseract 的 TSV 输出里，**行级（level=4）那一行的 `conf` 字段恒为 `-1`**，
真实置信度只填在词级（level=5）上。早先 `parseTsv` 直接取行级 conf，
于是每一行的置信度都是 -1，然后被"低置信度判为垃圾"的规则**全部丢掉** ——
本地 OCR 在真实图片上恒定返回 0 行。

单测当时没抓到，因为 fixture 把行级 conf 编成了 `92.5`（真实值是 `-1`）。
**教训：测试数据要照真实输出抄，不要图方便编一个"看起来合理"的值。**

修法是在 `parseTsv` 里用词级置信度算行级值，并在过滤后加一道兜底
（若某个解析器抽出的行被过滤空了，换另一个解析器再试）。
`test/test-integration.js` 里有对应的回归断言，fixture 现在照真实 TSV 抄。

`selftest.html` 是给用户用的，也能覆盖真实浏览器行为——但它是交互式的，
适合排查"哪一环坏了"，不适合做回归。
