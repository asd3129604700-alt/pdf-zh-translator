/**
 * PZConfig — 供应商预设 / 领域配置 / 提示词构建
 *
 * 这个文件是"把所有硬编码集中到一处"的地方。
 * 换领域只改这里（或在界面上填），不用碰算法。
 *
 * 说明：模型 ID 会随供应商更新而变化，预设里的 models 只是"起始值"，
 * 真正可靠的用法是界面上的「拉取模型列表」。所以不要把这里的 ID 当作真理。
 */
(function (global) {
  "use strict";

  const VERSION = "3.0.0";
  // 构建标记：每次改动都往上加，页面右上角会显示 "v3.0.0 · b12"。
  // 用户只要按一次 F5 看到这个数字变了，就说明拿到的是新版。
  const BUILD = "b14";

  /* ============================================================
   * 目标语言
   * ============================================================ */

  const TARGET_LANGS = [
    { id: "zh-CN", label: "简体中文", name: "简体中文", google: "zh-CN" },
    { id: "zh-TW", label: "繁體中文", name: "繁體中文", google: "zh-TW" },
  ];

  function langName(id) {
    for (let i = 0; i < TARGET_LANGS.length; i++) {
      if (TARGET_LANGS[i].id === id) return TARGET_LANGS[i].name;
    }
    return "简体中文";
  }

  /* ============================================================
   * 识别引擎
   * ============================================================ */

  const OCR_ENGINES = [
    {
      id: "vision",
      label: "云端视觉模型",
      short: "视觉模型",
      desc: "把图片交给视觉大模型识别并翻译。小字、糊字、彩底字最准，<strong>推荐</strong>。",
      needsKey: true,
    },
    {
      id: "local",
      label: "本地 OCR",
      short: "本地 OCR",
      desc: "浏览器内 Tesseract 识别，图片不出本机。<strong>不花钱、可离线</strong>，但对模糊小字弱于视觉模型。",
      needsKey: false,
    },
  ];

  /* ============================================================
   * 翻译引擎（本地 OCR 路线下使用）
   * ============================================================ */

  const TRANSLATE_ENGINES = [
    {
      id: "free",
      label: "免费公共接口",
      desc: "Google / MyMemory，无需 Key。质量一般，长句和术语较差。",
      needsKey: false,
    },
    {
      id: "llm",
      label: "大模型翻译",
      desc: "用你配置的文本大模型翻译。质量最好，可按术语表约束。",
      needsKey: true,
    },
    {
      id: "dict",
      label: "仅术语表",
      desc: "不联网，只用术语表替换。适合只想知道关键词对应关系时。",
      needsKey: false,
    },
  ];

  /* ============================================================
   * 视觉模型供应商预设
   * api: "gemini" 用 generateContent 协议；"openai" 用 /chat/completions 协议
   * ============================================================ */

  const VISION_PRESETS = {
    gemini: {
      id: "gemini",
      api: "gemini",
      label: "Google Gemini",
      baseUrl: "https://generativelanguage.googleapis.com",
      model: "gemini-2.5-flash",
      models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
      keyUrl: "https://aistudio.google.com/apikey",
      note: "识别小字能力强，性价比高。Key 在 Google AI Studio 申请。",
    },
    qwen: {
      id: "qwen",
      api: "openai",
      label: "通义千问 Qwen-VL",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen-vl-max-latest",
      models: ["qwen-vl-max-latest", "qwen-vl-plus-latest", "qwen3-vl-plus"],
      keyUrl: "https://bailian.console.aliyun.com/",
      note: "中文场景友好，对中英混排和表格线框处理不错。国内直连。",
    },
    zhipu: {
      id: "zhipu",
      api: "openai",
      label: "智谱 GLM-4V",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      model: "glm-4v-plus",
      models: ["glm-4v-plus", "glm-4v", "glm-4.5v"],
      keyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
      note: "国内直连，按量计费便宜。",
    },
    siliconflow: {
      id: "siliconflow",
      api: "openai",
      label: "硅基流动 SiliconFlow",
      baseUrl: "https://api.siliconflow.cn/v1",
      model: "Qwen/Qwen2.5-VL-72B-Instruct",
      models: [
        "Qwen/Qwen2.5-VL-72B-Instruct",
        "Qwen/Qwen2.5-VL-32B-Instruct",
        "THUDM/GLM-4.1V-9B-Thinking",
      ],
      keyUrl: "https://cloud.siliconflow.cn/account/ak",
      note: "一个 Key 可切多家开源视觉模型。",
    },
    openai: {
      id: "openai",
      api: "openai",
      label: "OpenAI 兼容",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1"],
      keyUrl: "https://platform.openai.com/api-keys",
      note: "任何兼容 /chat/completions 且支持图片输入的服务都能填这里。",
    },
    custom: {
      id: "custom",
      api: "openai",
      label: "自定义",
      baseUrl: "",
      model: "",
      models: [],
      keyUrl: "",
      note: "自己填 Base URL 和模型名。需要服务端支持图片输入。",
    },
  };

  /* ============================================================
   * 文本大模型预设（本地 OCR 路线下的翻译）
   * ============================================================ */

  const LLM_PRESETS = {
    deepseek: {
      id: "deepseek",
      api: "openai",
      label: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
      models: ["deepseek-chat", "deepseek-reasoner"],
      keyUrl: "https://platform.deepseek.com/api_keys",
      note: "纯文本翻译，便宜。注意 DeepSeek 目前没有图片输入能力，不能用于视觉识别。",
    },
    openai: {
      id: "openai",
      api: "openai",
      label: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
      keyUrl: "https://platform.openai.com/api-keys",
      note: "文本翻译。",
    },
    qwen: {
      id: "qwen",
      api: "openai",
      label: "通义千问（文本）",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen-plus",
      models: ["qwen-plus", "qwen-max", "qwen-turbo"],
      keyUrl: "https://bailian.console.aliyun.com/",
      note: "国内直连。",
    },
    custom: {
      id: "custom",
      api: "openai",
      label: "自定义",
      baseUrl: "",
      model: "",
      models: [],
      keyUrl: "",
      note: "任何兼容 /chat/completions 的文本服务。",
    },
  };

  /* ============================================================
   * 领域配置（术语表 + 提示词补充）
   *
   * 术语表格式：每行一条     原文 => 译文
   * 右侧留空或写「原样」表示该词保持原样不翻译。
   * ============================================================ */

  /**
   * 「玩具 / 产品规格表」预设自带的**通用**示例词表。
   *
   * ⚠ 这里只能放行业通用词汇 —— 仓库是要公开的（GitHub Pages）。
   * 客户专有词、品牌名、客户原话一律不要写进这个文件，放到仓库外的
   * `glossary.local.txt`（已在 .gitignore 里），页面启动时会自动加载并覆盖这份预设。
   * 有回归测试守着这一条，见 test/test-api-shape.js 的「领域过拟合」一节。
   */
  const SPEC_SHEET_GLOSSARY = [
    "SEPARATE PIECE => 独立部件",
    "MATERIAL SPEC => 材质规格",
    "MATERIALS => 材质",
    "PRINTED GRAPHIC => 印花图案",
    "EMBROIDERY => 刺绣",
    "APPLIQUE => 贴布绣",
    "GRADIENT => 渐变",
    "PRODUCT TITLE => 产品名称",
    "PRODUCT DIMS => 产品尺寸",
    "PACKAGING DIMS => 包装尺寸",
    "PIECE COUNT => 部件数量",
    "DEV. STAGE => 开发阶段",
    "SEASON => 季度",
    "COMPLEXITY => 复杂度",
    "MATERIAL => 材质",
    "DECO => 装饰",
    "SCALE => 比例",
    "COLORS => 配色",
    "Polyester => 聚酯纤维",
    "Cotton => 棉",
    "Front => 正面",
    "Side => 侧面",
    "Back => 背面",
    "Body => 身体",
    "Eyes => 眼睛",
    "Pupils => 瞳孔",
    "Skin => 肤色",
    "Sleeves => 袖子",
    "Shoes => 鞋子",
    "Hair accessories => 发饰",
    "Hair Ribbon => 发带",
    "Keep away from fire => 远离火源",
    "Not for children under 3 years => 不适合3岁以下儿童",
    "Proprietary and Confidential => 专有及保密文件",
    "All rights reserved => 保留所有权利",
    "Not to be distributed or reproduced without permission => 未经许可不得分发或复制",
    // 色号系统名：行业通用，保持原样
    "PANTONE => 原样",
    "PMS => 原样",
  ].join("\n");

  const PROFILES = {
    general: {
      id: "general",
      label: "通用文档",
      hint: "",
      glossary: "",
      desc: "默认。不预设任何领域词汇，适合合同、说明书、论文、邮件等。",
    },
    toy_spec: {
      id: "toy_spec",
      label: "玩具 / 产品规格表",
      hint:
        "这是玩具或周边产品的规格图/工艺说明表，包含材质、配色、工艺（刺绣、贴布绣、印花）、" +
        "PMS 色号、尺寸标注。请按行业习惯用词。",
      glossary: SPEC_SHEET_GLOSSARY,
      desc:
        "玩具/周边产品的通用规格词表（材质、工艺、部件、尺寸）。" +
        "要换成你自己的专有词表，就把仓库根目录的 glossary.local.txt 填上 —— " +
        "它不会进仓库，页面启动时自动加载并覆盖这份预设。",
    },
    custom: {
      id: "custom",
      label: "自定义",
      hint: "",
      glossary: "",
      desc: "完全自己写领域说明和术语表。",
    },
  };

  /* ============================================================
   * 运行参数
   * ============================================================ */

  const LIMITS = {
    // 检测
    detectMaxSide: 1600, // 检测阶段把图缩到这个长边（检测不需要全分辨率）
    detectMinLineHeight: 6, // 判定为文字的最小行高（检测尺度）
    detectMaxLineHeightRatio: 0.28, // 行高不得超过图高的这个比例
    detectMaxRegions: 40, // 最多送去识别的区域数（防止一张图拆出上百块）
    detectRegionPad: 6, // 区域外扩像素（检测尺度）

    // 送视觉模型的裁切
    regionCropMaxSide: 1400, // 单个裁切放大后的长边上限
    regionCropMinSide: 640, // 太小的区域也要放到这个尺寸，小字才看得清
    regionCropZoomMax: 4, // 最大放大倍数，超过无意义
    regionCropPadRatio: 0.12, // 裁切时按区域尺寸外扩，避免切掉字
    visionImageMaxSide: 1800, // 整图兜底时传给模型的长边上限
    visionConcurrency: 4, // 并发请求数
    visionMaxRegions: 60,
    // ↑ 逐块识别的区域上限，是「召回 vs 花费」的折中：每块一次 API 请求。
    // 大图纸分块检测后区域数会到 50~100，上限太小就会按阅读顺序截断 ——
    // 表现是**页面下半部分整段没翻**。这里定得偏大，因为漏字比多花几分钱难受得多。
    // 如果哪天想省钱，调小这个值即可，其余逻辑不用动。
    visionRegionWarnRatio: 0.9, // 区域数达到上限的这个比例就在日志里提醒

    // 本地 OCR
    ocrWorkers: 3, // Tesseract worker 数（并行）
    ocrMaxBands: 10, // 最多切几条送去 OCR
    // 这里**故意没有**"统一放大倍数"这个配置项：
    // 每条条带的放大倍数由该条带的行高反推（放大后字高逼近 32px），
    // 小字自动放大得更多 —— 一个全局倍数做不到这件事。

    // 导出
    // 渲染倍率直接决定等效 DPI（72 × 倍率）；页面尺寸取自 PDF 本身，不从这里来。
    pdfRenderScale: 2.5, // → 180 DPI

    // 覆盖排版
    overlayMaxGrowY: 1.6,
    overlayMinFontSize: 7,
    // 字号可读下限。原文只有 8~9px 的标注，照搬原尺寸会小到看不清
    // （用户反馈"有的字还是太小了"），允许放大到这个尺寸。
    overlayMinReadableSize: 11,
    // 中文字号相对原文的放大系数（上限，实际受框宽/可用高度约束）。
    //
    // 为什么敢让它**超过原文**：用户点破了关键 —— "中文一定比英文字数少"。
    // 一句 24 个字母的英文，中文通常 8~10 个字，横向还富余一大截；
    // 而且 measureInk 量到的是**墨迹高度**（西文的 cap height ≈ 0.7em），
    // 照搬墨迹高度当字号，中文会比英文视觉上小一圈。
    // 1.35 大约让中文的 em 尺寸 ≈ 原来英文的字号。
    //
    // 上限只放宽"理想字号"，装不下时排版函数照样会往下缩 —— 不会撑破邻居，
    // 这一点由 computeNeighborLimits + allowW/allowH 保证。
    overlayFontGrow: 1.35,
    // 去字方式：
    //   "ink"    = 只把"和背景色不同的像素"涂成背景色（默认）。
    //              底色、图案、线条都不动，中文背后不会有一块贴纸。
    //   "fill"   = 采背景主色整块实心填充。底色纯时最省事，但不纯时会留一块色块。
    //   "repair" = 文字掩膜 + 无缝扩散修复。背景是渐变/纹理时更自然。
    eraseMode: "ink",
    eraseRingWidth: 6, // 采背景主色时，往外看几圈
    // "只擦文字"模式下，与背景色的差异超过这个值才算"字"（RGB 欧氏距离）。
    // 这是**底色花**时的阈值；底色纯的时候会自动降到 eraseInkThresholdFlat
    // —— 纯底上把阈值放低几乎没有代价（那些像素本来就和底色差不多），
    // 却能吃掉字边缘一圈浅灰，修掉"去除不完整"。
    eraseInkThreshold: 44,
    eraseInkThresholdFlat: 16, // 环上主色占比 ≥ 0.8（底色纯）时用这个
    eraseInkThresholdMid: 30, // 环上主色占比 0.55~0.8 时用这个
    // 结构保护（表格线 / 边框 / 下划线）：整行或整列墨迹铺满 ≥ 85%、
    // 且厚度 ≤ 6px 的连续带才保护。厚度是决定性的 —— 一行字再糊也有 8~14px。
    eraseLineFillRatio: 0.85,
    eraseLineMaxThickness: 6,
    // 擦除后的残墨统计：还剩多少"明显不是底色"的像素就报警
    eraseResidualDelta: 22,
    // 字边缘的抗锯齿灰边：向掩膜外多长出去几圈（只沿着"还不是纯底色"的像素走）
    eraseHaloGrow: 2,
    eraseHaloDelta: 14, // "还不是纯底色"的判据

    // 相邻碎块合并（见 PZUtil.mergeAdjacentItems）
    //
    // 上游常把一整行切成好几块，碎块之间会互相夹住排版空间 ——
    // "贴不全 + 有的字小"这两个症状、以及"同一批里有的正常有的糟"，
    // 都是这一个原因。这里定"多近才算挨得近"。
    //   1.2 = 间距小于 1.2 倍字高就并；表格列之间的空隙远大于此，不会被并掉。
    mergeGapRatio: 1.2,
    // 高度比超过这个值就不并（别把大标题和小标注并到一起）
    mergeMaxHeightRatio: 1.8,
  };

  /* ============================================================
   * 术语表解析
   * ============================================================ */

  const KEEP_MARKERS = /^(原样|保持原样|keep|keep as is|keep as-is|不译|不翻译|-|—)$/i;

  /**
   * 把界面上的文本解析成 [{from, to, keep}]。
   * 支持分隔符：=>  ＝>  ->  →  ::  |  =（最后一个兜底）
   * 以 # 或 // 开头的行是注释。
   */
  function parseGlossary(text) {
    const out = [];
    const lines = String(text || "").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i].trim();
      if (!line) continue;
      if (/^(#|\/\/)/.test(line)) continue;
      let from = null;
      let to = null;
      const seps = ["=>", "＝>", "->", "→", "::", "＝", "="];
      for (let s = 0; s < seps.length; s++) {
        const idx = line.indexOf(seps[s]);
        if (idx > 0) {
          from = line.slice(0, idx).trim();
          to = line.slice(idx + seps[s].length).trim();
          break;
        }
      }
      if (from == null) {
        // 只有原文，没有译文 → 当"保持原样"处理
        from = line;
        to = "";
      }
      if (!from) continue;
      out.push({ from: from, to: to, keep: !to || KEEP_MARKERS.test(to) });
    }
    return out;
  }

  /** 术语表 → 提示词片段 */
  function glossaryToPrompt(entries) {
    if (!entries || !entries.length) return "";
    const keep = [];
    const map = [];
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].keep) keep.push(entries[i].from);
      else map.push(entries[i].from + " => " + entries[i].to);
    }
    let out = "";
    if (map.length) {
      out +=
        "\n用户指定的术语对照，必须严格遵守（优先级高于你自己的判断）：\n" +
        map.join("\n") +
        "\n";
    }
    if (keep.length) {
      out +=
        "\n以下词汇保持英文原样，不要翻译、不要音译：\n" +
        keep.join("、") +
        "\n";
    }
    return out;
  }

  /* ============================================================
   * 提示词
   * ============================================================ */

  const COMMON_RULES =
    "识别规则：\n" +
    "- 逐字看清再写。看不清的字符不要猜，宁可跳过那一条。\n" +
    "- 不要臆造图中没有的文字，不要补全被裁切截断的句子。\n" +
    "- 数字、单位、编号、型号、SKU、色号、尺寸、百分比原样保留，不要改写成中文数字。\n" +
    "- 专有名词、品牌名、人名、商标保持原样，不要音译。\n" +
    "- 原本全大写的标题保持大写风格。\n" +
    "- 图中的线条、图标、边框、装饰碎片不是文字，忽略。\n" +
    "- 同一段文字只输出一次，不要重复。\n";

  const BOX_RULE =
    "坐标规则：以本图左上角为原点，x 向右、y 向下，归一化成 0-1000 的整数。\n" +
    "外接框要紧贴文字本身，不要框住图案、线条或大片空白。\n";

  const OUTPUT_RULE =
    '输出格式：只输出 JSON，不要 markdown 代码块，不要任何解释文字。\n' +
    '{"items":[{"text":"原文","translation":"译文","box":[x0,y0,x1,y1]}]}\n' +
    '如果图中没有任何可读文字，返回 {"items":[]}。\n';

  /**
   * 只识别不翻译时的输出规则。
   * 为什么单独一份：让模型少写一个字段，既省 token 也少一处出错的地方；
   * 反正是 PZTranslate 后面再翻，这里给译文只是浪费。
   */
  const OUTPUT_RULE_NO_TRANSLATE =
    '输出格式：只输出 JSON，不要 markdown 代码块，不要任何解释文字。\n' +
    '{"items":[{"text":"原文","box":[x0,y0,x1,y1]}]}\n' +
    '如果图中没有任何可读文字，返回 {"items":[]}。\n';

  /** 翻译相关规则。translate=false 时整段不出现，提示词里就一个"翻译"字样都没有 */
  function translationRules(lang) {
    return (
      "\n翻译规则：\n" +
      "- 忠实、简洁，符合" + lang + "的行业表达习惯。\n" +
      "- 短标签直译即可，不要扩写成句子。\n" +
      "- 术语按下面给定的对照表翻译。\n"
    );
  }

  /**
   * 区域裁切识别提示词。
   * opts: {targetLang, glossaryEntries, profileHint, cropLabel, translate}
   * translate === false 时只识别不翻译（译文交给 PZTranslate 那条链路）。
   */
  function buildRegionPrompt(opts) {
    opts = opts || {};
    const lang = langName(opts.targetLang);
    const wantTranslate = opts.translate !== false;
    let p =
      "你是专业的文档识别" + (wantTranslate ? "与翻译" : "") + "引擎。\n" +
      "下面这张图是整页文档中的一个**局部裁切**，可能包含被截断的行。\n\n" +
      "任务：\n" +
      "1. 逐条识别图中所有真实可读的英文文字\n";
    if (wantTranslate) p += "2. 把每条翻译成" + lang + "\n3. 给出每条文字在这张裁切图中的外接框\n\n";
    else p += "2. 给出每条文字在这张裁切图中的外接框\n\n";
    if (opts.cropLabel) p += "（本图编号 " + opts.cropLabel + "）\n\n";
    p += BOX_RULE + "\n" + (wantTranslate ? OUTPUT_RULE : OUTPUT_RULE_NO_TRANSLATE) + "\n" + COMMON_RULES;
    if (wantTranslate) p += translationRules(lang);
    if (opts.profileHint) p += "\n背景信息：" + opts.profileHint + "\n";
    p += glossaryToPrompt(opts.glossaryEntries);
    return p;
  }

  /**
   * 整图识别提示词（兜底，负责捡回漏检的文字）。
   * opts: {targetLang, glossaryEntries, profileHint, translate}
   */
  function buildWholePrompt(opts) {
    opts = opts || {};
    const lang = langName(opts.targetLang);
    const wantTranslate = opts.translate !== false;
    let p =
      "你是专业的文档识别" + (wantTranslate ? "与翻译" : "") + "引擎。\n" +
      "下面是一整页文档或图片。请识别其中**所有**可读的英文文字" +
      (wantTranslate ? "并翻译" : "") + "。\n\n" +
      "任务：\n" +
      "1. 完整扫描整张图，逐条识别所有英文文字，包括很小的标注、角落里的编号、图注\n";
    if (wantTranslate) p += "2. 把每条翻译成" + lang + "\n3. 给出每条文字在整图中的外接框\n\n";
    else p += "2. 给出每条文字在整图中的外接框\n\n";
    p += BOX_RULE + "\n" + (wantTranslate ? OUTPUT_RULE : OUTPUT_RULE_NO_TRANSLATE) + "\n" + COMMON_RULES;
    if (wantTranslate) {
      p +=
        "\n翻译规则：\n" +
        "- 忠实、简洁，符合" + lang + "的行业表达习惯。\n" +
        "- 短标签直译即可。\n";
    }
    if (opts.profileHint) p += "\n背景信息：" + opts.profileHint + "\n";
    p += glossaryToPrompt(opts.glossaryEntries);
    return p;
  }

  /** 纯文本翻译的系统提示词 */
  function buildTranslateSystem(opts) {
    opts = opts || {};
    const lang = langName(opts.targetLang);
    let p =
      "你是专业的英译" + lang + "翻译引擎，负责把文档条目翻译成" + lang + "。\n\n" +
      "要求：\n" +
      "1. 先纠正明显的 OCR 错误再翻译\n" +
      "2. 数字、单位、编号、型号、SKU、色号原样保留\n" +
      "3. 专有名词、品牌名、人名保持原样，不要音译\n" +
      "4. 只输出译文，不要解释、不要加引号\n";
    if (opts.profileHint) p += "\n背景信息：" + opts.profileHint + "\n";
    p += glossaryToPrompt(opts.glossaryEntries);
    return p;
  }

  /** 批量翻译的 user 提示词 */
  function buildTranslateBatchUser(texts, opts) {
    opts = opts || {};
    const lang = langName(opts.targetLang);
    return (
      "把下列条目翻译成" + lang + "。返回 JSON 数组，每项 {\"id\":数字,\"translation\":\"译文\"}。\n" +
      "不要输出 JSON 以外的任何内容。\n\n" +
      JSON.stringify(texts)
    );
  }

  global.PZConfig = {
    VERSION: VERSION,
    BUILD: BUILD,
    TARGET_LANGS: TARGET_LANGS,
    OCR_ENGINES: OCR_ENGINES,
    TRANSLATE_ENGINES: TRANSLATE_ENGINES,
    VISION_PRESETS: VISION_PRESETS,
    LLM_PRESETS: LLM_PRESETS,
    PROFILES: PROFILES,
    LIMITS: LIMITS,
    langName: langName,
    parseGlossary: parseGlossary,
    glossaryToPrompt: glossaryToPrompt,
    buildRegionPrompt: buildRegionPrompt,
    buildWholePrompt: buildWholePrompt,
    buildTranslateSystem: buildTranslateSystem,
    buildTranslateBatchUser: buildTranslateBatchUser,
  };
})(typeof window !== "undefined" ? window : globalThis);
