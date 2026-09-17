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

#### 去字：从"刷矩形色块"改成"文字掩膜 + 无缝修复"

用户三次反馈去字问题，前两次我只改了**范围**，第三次才意识到**方法本身**是错的。
整个过程值得完整记下来。

**第一版（错的）：刷一块采样底色的补丁。**
从框外一圈采样颜色，把框整个刷掉。白底上看着没事，一旦背景是渐变、色块、
纹理或图案，那就是一块看得见的涂抹痕迹。

**第二版（还是错的）：补丁 + 自动扩张到"外沿干净"。**
加了 `growCoverUntilClean`：不断向外扩，直到紧贴外沿的一圈像素"干净"。
这引入了更严重的问题 —— **文字旁边常常有表格线、边框、图案描边，
它们永远不会让外沿变干净**，于是扩张一路顶到上限，**把一大块表格线或图案擦掉**。
用户说的"涂抹做得太差"，主因就是这个。

更值得记的是：**我当时用来衡量效果的指标是"外沿还有没有墨"，
而"擦掉线条"正好让这个数字变好看**。指标本身在奖励错误行为，
所以我拿着漂亮的数字（脏污 26.9 → 14.8）交付了一个更糟的版本。
这是这次最大的教训：**指标必须能区分"擦干净了"和"擦多了"。**

**第三版（现在）：文字掩膜 + 无缝修复。** 参考 ShinobuTranslator 的做法
（它用 `aot_inpaint_512.onnx` 跑 AOT-GAN，见它的 `public/models/models.json`），
这里不下载 22MB 模型，而是用同一套思路的轻量版：

1. **`buildMask`** —— 只把**文字像素**圈进掩膜：
   - 墨迹判定用局部自适应阈值（不是全局中位亮度差）。全局阈值在渐变底上
     会把背景的暗端整片当成墨，掩膜一覆盖大半个矩形，又变回"刷补丁"。
   - **补封闭空洞**：局部均值法标不出实心笔画的内部（黑字内部的局部均值也是黑的），
     不做这一步，擦完还留个影子。
   - **剔除长条状实心结构**（表格线、边框、下划线）—— 它们是背景，要保留。
   - **剔除比字形大得多的连通块**（图案、色块）—— 那是插画不是字。
   - 掩膜**膨胀 2px**，把抗锯齿边一起吃掉，否则留一圈灰边。
2. **`inpaint`** —— 对掩膜区域解拉普拉斯方程（SOR 超松弛，**跑到收敛为止**）。
   解在边界上与周围严格连续，所以不会有可见的矩形或色差，渐变底也能自然接上。

修掉的两个实现坑（都是先跑出坏结果才发现的）：
- **迭代次数不能按包围盒拍**：三个分散的字包围盒跨度很大，但每个字只有十几像素厚，
  收敛快慢由**厚度**决定。按跨度估出 59 次，字心只填到 204/255，留一层灰影。
- **掩膜要给初始猜测**：不给的话掩膜里还是原文的黑色，扩散要从"全黑"爬到背景色，
  六百次迭代还差 2%；用矩形内未掩膜像素的中位色做初值后，**16 次**就精确到 255。

像素级回归测试在 `test/test-integration.js` 第 8 节（用一个内存里的软件 canvas
跑完整覆盖管线，断言的是像素结果）：原文被擦净、**表格线被保留**、
填充无缝、掩膜不误伤线条与图案。

**顺序上的两次改进仍然有效**，保留在上面：
1. **垂直方向补了余量**（第一版只加了水平 padding，垂直是 0）。
2. **采样一律读原图**（读正在被涂改的画布会让相邻文字互相污染）。

#### 去字第四版（现在默认）：`ink` —— 只把"与底色不同的像素"涂成底色

用户的原话点破了关键：**"你可以识别背景色嘛，识别完字直接涂抹一整块，
然后再把翻译的字贴上去……你这个字怎么是贴上去的啊，有底色的就光字不就行了嘛"**。

`repair`（掩膜 + 扩散）仍然能擦干净，但它有一个绕不过去的问题：
**要判断"哪些连通块是字、哪些是线条图案"，判错就留残留或啃掉线条**。
而 `ink` 换个问法就不需要这层判断了 —— 只问"这个像素和背景主色一样吗"：

- 背景色由框外一圈的**众数**给出（不是均值/中位数，见 `dominantColor`）。
- **与底色不同的像素 → 涂成底色**。底色、图案、线条原样不动，
  中文背后不会出现任何一块"贴纸"。
- 唯一需要保护的是**表格线 / 边框 / 下划线**，判据见下。

第四版踩过、也修掉的坑（都是先跑出坏结果才发现）：

1. **"跨到两条对边就保护"会把整行字保护掉。**
   糊成一团的小字，整行会连成一个横跨整个框的连通块 → 被判成表格线 →
   **那一行一个字都没擦**。这正是用户说的"有的去除不完整"。
   现在改用 `findStructureBands`：**整行（列）≥85% 铺满墨迹、且厚度 ≤6px**
   的连续带才算线条。厚度是决定性的 —— 一行字再糊也有 8~14px 厚。
   而且判据是"行/列"而不是"连通块"，所以字压着表格线时，线照样保留、字照样擦掉。
2. **固定阈值 44 会留下浅灰鬼影。**
   底色纯的时候（框外主色占比 ≥0.8）阈值自动降到 16，半纯降到 30，花底才用 44。
   纯底上把阈值压低几乎没有代价：那些像素本来就和底色差不多，
   涂成底色看不出区别，却能吃掉字边缘一圈抗锯齿灰。
3. **框里不保证只有字。** 实测一张装饰图上，检测框里套着整片插画
   （483×380、894×309）。判据只认"与底色不同"的话，插画会被整个涂成底色
   —— 等于在图里挖个白洞。所以补了**大块保护**：连通块高度 > 4 倍字高就保护。
   判据**只看高度、不看面积**：一行密排、糊成一条的文字块又宽又大，
   面积判据会把整行字保护下来（实测一张图上 170×12 的文字行就栽在这上面，
   擦除量直接掉到 0）。
4. **灰边扩散**：从掩膜向外沿"还不是纯底色"（距离 > 14）的像素再吃 1~2 圈，
   圈数固定。上一版那种"自适应扩张"已经删掉了，理由见上面第二版的教训。
5. **不跨整块的短线也要保护**：一条只画到单元格边的表格线，行/列判据（要求铺满
   85%）覆盖不到它。补一条连通块级判据：厚度 ≤4px、长度 ≥3 倍字高、实心度 ≥0.85
   —— 卡得死是有意的，因为"一行小字糊成一条"也是又长又实心，
   区别只在厚度和实心度，宁可漏保护一条粗边框也不能把一行字保护下来。

**残留怎么度量（这次先把尺子做好再动手）**：`coverText` 返回
`residual / residualRatio`（擦完还剩多少"明显不是底色"的像素，被保护的线条与插画不算）。
拿三张真实图纸（2600px 宽，检测出的行框当擦除框）做同输入对比：

| 图纸 | 旧版残留(>22) | 其中明显残留(>60) | 新版残留 | 纯底块 |
| --- | --- | --- | --- | --- |
| deco | 95,142 px | 70,276 px | **1,260 px** | 82,500 → **0** |
| material | 63,091 px | 52,358 px | **5,848 px** | 1,421 → **0** |
| to | 167,265 px | 121,921 px | **8,194 px** | 89,075 → **0** |

还测出旧版有**整块一点没擦**的情况（例如 material 的 `102×28` 框擦除 0 px、
留 4277 px 残墨；`35×38` 框同样擦 0 px），新版分别擦掉 4263 / 2888 px。
新版的擦除总量反而**更少**（deco 362k → 366k、material 387k → 274k、to 752k → 701k），
因为插画被保护下来了 —— 擦得少、残留少，这才是对的。

> ⚠ 度量本身要小心：三张图上被当成"擦除框"的是**检测器的行框**，
> 而真实管线里的擦除框来自视觉模型/OCR 返回的文字框。检测器会把整片插画
> 也当成"行"，所以这些数字用来说明**新旧算法在同输入下的差异**，
> 不能直接当成"用户会看到多少残留"。

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

### 字号与对齐：必须实测框内的墨迹，不能信传进来的框

这一条是在**真实客户图纸**上量出来的（`5100×3300` 的 TO detail 图）。用户反馈
"字体太大、对不齐"，根因两个：

1. **框常常比文字宽。** 实测某张 TO 图，框宽/墨迹宽中位数 1.17，最松的一个框左边
   留了 29px 空白。中文按框左边缘画就整体左偏 —— DECO 页中位偏 **29px**（10 行里 7 行 >10px），
   CS 页中位偏 **20px**（22 行里 16 行 >10px）。
2. **框可能装着一整段而不只是一行。** 视觉模型习惯把一段文字框成一块，实测出现过
   `1308×450`、`906×165` 这种框，里面是好幾行小字。按框高定字号会算出
   `fontSize = 0.92 × 450 = 414px`，而那块里每行原文只有 30px。

修法是 `measureInk(ctx, box)`：读框内像素，取亮度中位数当背景，与背景差 >38 的算墨，
量出**墨迹外接框**和**行带数量**，然后：

- 字号上限用**实测的单行高**（行带高度的中位数），而不是整块高
- 中文从**墨迹左边缘**起画，而不是框左边缘

修复后在真实图纸上的实测（拦截 `fillText` 看实际画在哪、多大）：

| 图纸 | 对齐 ≤1px | 对齐 >10px | 字号/单行高 >1.05 |
|---|---|---|---|
| DECO（10 行） | **10 / 10** | 0 | **0** |
| TO（65 行） | **65 / 65** | 0 | **0** |
| CS（22 行） | **22 / 22** | 0 | **0** |

多行块也验证到了：CS 页识别出 6 个 2~3 行的块，单行高 26~27px，
字号取 26~27（以前会按整块 55~84px 算）。

### 排版观感：行高、对齐、字距

参考 ShinobuTranslator 的 `packages/image-pipeline/src/pipeline/typeset/`（`fontFitCore.ts` 等），
它有一批调好的排版常数和两个我原来完全没做的机制：

| 它的做法 | 我原来的做法 | 现在 |
|---|---|---|
| `horizontalLineHeightRatio = 0.93` | 行高 1.16 | **1.02**。1.16 排出来松垮，多行块还占高、反过来逼字号缩小 |
| `minHorizontalLetterSpacingScale = 0.85` / `max = 1.5` | 没有字距概念 | 宽度差一点时**先收紧字距**（0 → -0.012 → -0.025 → -0.04 em），不够再掉字号 |
| `inferHorizontalAlignment` 推断 left/center/right | 一律左对齐 | `measureInk` 里加了 `inferAlignment` |
| `measureTextInkMetrics` 量真实墨迹 | 直接信传进来的框 | `measureInk` |
| `resolveColors` 用 **CIELAB** 距离判对比度 | 朴素 RGB 阈值 | 暂未改（现在的采样够用，记着） |

**对齐推断**两种情形：
- 多行：分别算左边缘、中心、右边缘的离散度，取最小的那个（用相对行宽容差，
  避免长行天然绝对偏差更大）。
- 单行：没有行间信息，只能看它在框里的左右留白 —— 两边都明显且接近 → 居中；
  左边留白明显更多 → 右对齐；否则左对齐。

为什么值得做：中文一般比英文短，如果原文是居中的标题，一律从左边起画就会明显偏左。

实测（用户的原图，2550×1650）：22 行里推断出 3 条居中、1 条右对齐，其余左对齐；
1 条靠收紧字距保住了字号；字号/单行高中位数 0.91。

**字距的边界要说清楚**：收紧到 -0.04 em 大约只能省 4% 宽度，而字号阶梯的跨度是 8%，
所以字距**跨不过一档字号**。它的价值在于避免"差一点点就掉一档"造成的视觉跳变，
不是替代缩字号。

**轻微溢出**同样来自 ShinobuTranslator（`minorOverflowMaxGlyphCount = 2`、
`minorOverflowShrinkMinScale = 0.8`）：如果严格放不下、字号已经被压到理想值的 0.8 倍以下，
那么"字号正确但略微超宽"比"宽度正好但字小一圈"更好看。

实现上加了两道约束，避免它变成事故：

1. **比例上限 12%**。只按"最多 2 个字形宽"算的话，一个装 6 个字的窄框允许超 2 个字 = 超 33%，
   视觉上明显出格。12% 刚好够跨一档字号（阶梯是 0.92，一档 = 8.7%），这正是该机制要解决的问题。
2. **不能超出可用横向空间**（`allowW`，由邻居边界算出）。而且 `render` 会把
   **实际绘制出来的中文范围**并进覆盖范围 —— 否则超出的部分会被 clip 掉。
   这一条是"轻微溢出"能成立的前提。

实测：9 个汉字 / 框宽 130 → 字号 16、超宽 10.8%（严格模式下只能给 14）；
把 `allowW` 限制到 118 时正确地退回 14 不溢出。

### 字号：允许比原文大（`fontGrow`）

用户的原话：**"字还可以再大一点，我说中文一定比英文字数少，你把英文的字体大一点"**。
这句话里有两个事实，都成立：

1. `measureInk` 量的是**墨迹高度**，而西文的墨迹高度（cap height）只有字号的 ~0.7 倍。
   拿它当字号，中文已经比英文小了一圈。
2. 中文比英文短 —— 24 个字母的一句英文，中文通常 8~10 个字，横向还富余一大截。

改法两处（缺一不可）：

- `sizeCap = max(原文单行墨迹高 × fontGrow, 可读下限)`，`fontGrow` 默认 **1.35**
  （界面上「中文字号」可选 跟随原文 1.0 / 稍大 1.2 / 更大 1.35 / 最大 1.6）。
- `layoutText` 新增 `startAtMax`：**从上限起排**，装不下时沿阶梯自己降。
  只改上限不改起点是没用的 —— 起点是 `h × 0.92`，照样把字号压在 0.65 倍。

为什么这次不怕重犯"字体太大、对不齐"：那一版的问题是**没有邻居约束**。
现在 `computeNeighborLimits` 给出 `allowH/allowW`，排版函数在宽高约束内尽量取大，
取不到就缩 —— 放大不是硬撑。回归测试锁了两件事：
`fontGrow` 1.35 时字号确实变大，以及"从上限起排、装不下会降下来"。



`PZDetect` 会把图缩到长边 `detectMaxSide`（1600）再检测。一张 5100px 的图纸缩到 1600
是 **0.31 倍** —— 15px 的小标签变成 4.7px，掉到最小行高以下**直接漏检**，
那一块永远不会被翻译；整图兜底那遍缩得更狠，救不回来。

`app.js` 的 `detectText()` 把大图切成带 12% 重叠的块（每块接近原分辨率），
分别检测后把坐标平移回整图、按重叠比例去重、按阅读顺序排序。
检测结果同时供视觉路径（`opts.regions`）和本地 OCR（切条带）使用。

在真实图纸上的召回对比：

| 图纸 | 整图缩图检测 | 分块检测 | 多找回 | 耗时 |
|---|---|---|---|---|
| DECO | 10 行 | **95 行** | +850% | 321 → 850ms |
| TO | 68 行 | **125 行** | +84% | 283 → 502ms |
| CS Comments | 22 行 | **120 行** | +445% | 669 → 592ms |

找回的正是小字：`30×9`、`115×8`、`58×13`、`52×6` —— 8~14px 的文字原来被整批丢掉。
这就是"该翻的地方完全没动，还是英文"。

代价是区域数从 ~24 涨到 50~100，而每块区域是一次 API 请求，所以
`visionMaxRegions` 提到 60（漏字比多花几分钱难受得多），并且当区域数接近上限时
会在日志里明确警告 —— 否则表现就是"页面某一段整块没翻"，用户只会以为是漏识别。

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
