/**
 * 控制器：状态机、UI 绑定、流水线编排、进度与取消。
 *
 * 与原实现的编排差异：
 *  - 「识别引擎」和「翻译方式」解耦。原实现把它们捆在"普通/复杂模式"两个卡片里，
 *    结果界面文案（"复杂模式必须配置并测试通过"）和实际行为（无 Key 时静默用免费接口）
 *    互相矛盾。现在选了云端视觉就必须配好 Key，选了本地 OCR 就必然不调视觉 API。
 *  - 全流程支持取消。原实现一旦开始就没办法中止，一张图跑几分钟只能干等或刷新页面。
 *  - PDF 与图片共用同一套 items 结构和同一个 PZOverlay 排版引擎。
 *  - 逐环节报告失败原因，而不是把所有错误丢进一个正则去猜是不是 API 问题。
 */
(function () {
  "use strict";

  const U = window.PZUtil;
  const C = window.PZConfig;
  const OV = window.PZOverlay;

  const $ = function (sel) {
    return document.querySelector(sel);
  };

  const els = {
    dropzone: $("#dropzone"),
    fileInput: $("#file-input"),
    fileList: $("#file-list"),

    enginePill: $("#engine-pill"),
    versionPill: $("#version-pill"),
    engineHint: $("#engine-hint"),
    ocrVision: $("#opt-ocr-engine-vision"),
    ocrLocal: $("#opt-ocr-engine-local"),

    targetLang: $("#opt-target-lang"),
    translateEngine: $("#opt-translate-engine"),
    translateEngineField: $("#translate-engine-field"),
    cover: $("#opt-cover"),
    eraseMode: $("#opt-erase-mode"),
    fontGrow: $("#opt-font-grow"),
    preserveCodes: $("#opt-preserve-codes"),
    fieldColors: $("#opt-field-colors"),

    visionBox: $("#vision-box"),
    visionProvider: $("#opt-vision-provider"),
    visionBase: $("#opt-vision-base"),
    visionKey: $("#opt-vision-key"),
    visionModel: $("#opt-vision-model"),
    visionModelCustom: $("#opt-vision-model-custom"),
    visionRecognizeOnly: $("#opt-vision-recognize-only"),
    visionNote: $("#vision-note"),
    visionNoteResult: $("#vision-note-result"),
    visionStatus: $("#vision-status"),
    visionKeyLink: $("#vision-key-link"),
    btnVisionModels: $("#btn-vision-models"),
    btnVisionTest: $("#btn-vision-test"),

    llmBox: $("#llm-box"),
    llmProvider: $("#opt-llm-provider"),
    llmBase: $("#opt-llm-base"),
    llmKey: $("#opt-llm-key"),
    llmModel: $("#opt-llm-model"),
    llmModelCustom: $("#opt-llm-model-custom"),
    llmNote: $("#llm-note"),
    llmResult: $("#llm-result"),
    llmStatus: $("#llm-status"),
    llmKeyLink: $("#llm-key-link"),
    btnLlmModels: $("#btn-llm-models"),
    btnLlmTest: $("#btn-llm-test"),

    profile: $("#opt-profile"),
    profileHint: $("#opt-profile-hint"),
    glossary: $("#opt-glossary"),

    btnStart: $("#btn-start"),

    panelUpload: $("#panel-upload"),
    panelProcess: $("#panel-process"),
    panelResult: $("#panel-result"),
    panelError: $("#panel-error"),

    processTitle: $("#process-title"),
    processFile: $("#process-file"),
    progressBar: $("#progress-bar"),
    progressText: $("#progress-text"),
    steps: $("#steps"),
    processLog: $("#process-log"),
    btnCancel: $("#btn-cancel"),

    resultMeta: $("#result-meta"),
    resultWarnings: $("#result-warnings"),
    previewCanvas: $("#preview-canvas"),
    viewLabel: $("#view-label"),
    pageIndicator: $("#page-indicator"),
    btnPrev: $("#btn-prev"),
    btnNext: $("#btn-next"),
    btnToggleView: $("#btn-toggle-view"),
    previewZoom: $("#opt-preview-zoom"),
    btnDownload: $("#btn-download"),
    btnReset: $("#btn-reset"),
    textList: $("#text-list"),
    textCount: $("#text-count"),

    errorMessage: $("#error-message"),
    btnErrorReset: $("#btn-error-reset"),
  };

  const IMAGE_RE = /\.(png|jpe?g|webp|bmp|gif)$/i;
  const PDF_RE = /\.pdf$/i;
  const STORE_PREFIX = "pz3_";

  // 预览画布的最大显示边长。原实现每次都把 3 倍分辨率的整页画进预览画布，
  // 悬停高亮时会卡；这里按显示尺寸重绘，高亮才能跟得上鼠标。
  const PREVIEW_MAX_SIDE = 1400;
  // 放大档位时的背板上限：够看清小字，又不至于一次吃掉几百 MB
  const PREVIEW_ZOOM_MAX_SIDE = 2600;

  // 图片没有"原始页面尺寸"这个概念，导出 PDF 时按这个 DPI 反推页面物理大小。
  // 150 是电子文档截图的常见等效值，打出来尺寸不至于离谱。
  const IMAGE_EXPORT_DPI = 150;

  const state = {
    files: [],
    pages: [],
    pageIndex: 0,
    showOriginal: false,
    highlight: null,
    previewZoom: "fit",
    controller: null,
    fileName: "translated-zh.pdf",
    logLines: [],
  };

  /* ============================================================
   * 基础 UI
   * ============================================================ */

  function showPanel(name) {
    els.panelUpload.classList.toggle("hidden", name !== "upload");
    els.panelProcess.classList.toggle("hidden", name !== "process");
    els.panelResult.classList.toggle("hidden", name !== "result");
    els.panelError.classList.toggle("hidden", name !== "error");
  }

  function log(line) {
    state.logLines.push(line);
    if (state.logLines.length > 400) state.logLines.shift();
    // 只显示最后若干行：日志是用来判断"卡在哪一步"的，不需要全量滚动区
    els.processLog.textContent = state.logLines.slice(-14).join("\n");
  }

  function clearLog() {
    state.logLines = [];
    els.processLog.textContent = "";
  }

  function setProgress(percent, text) {
    els.progressBar.style.width = Math.max(0, Math.min(100, percent)) + "%";
    if (text) els.progressText.textContent = text;
  }

  const STEP_ORDER = ["load", "detect", "recognize", "translate", "compose"];

  function setStep(step) {
    const idx = STEP_ORDER.indexOf(step);
    Array.prototype.forEach.call(els.steps.querySelectorAll("li"), function (li, i) {
      li.classList.remove("active", "done");
      if (i < idx) li.classList.add("done");
      if (i === idx) li.classList.add("active");
      if (step === "done") li.classList.add("done");
    });
  }

  /** 分阶段进度：每个阶段有权重，set(阶段, 阶段内进度) 换算成总进度 */
  function createProgress(phases) {
    let total = 0;
    for (let i = 0; i < phases.length; i++) total += phases[i].weight;
    return function (name, frac) {
      let acc = 0;
      for (let i = 0; i < phases.length; i++) {
        if (phases[i].name === name) {
          acc += phases[i].weight * U.clamp(frac || 0, 0, 1);
          break;
        }
        acc += phases[i].weight;
      }
      setProgress((acc / total) * 100);
    };
  }

  function fail(message) {
    els.errorMessage.textContent = message || "处理失败。";
    showPanel("error");
  }

  /* ============================================================
   * 配置读取
   * ============================================================ */

  function getOcrEngine() {
    return els.ocrLocal.checked ? "local" : "vision";
  }

  function getTranslateEngine() {
    return els.translateEngine.value || "free";
  }

  /**
   * 中文字号放大系数。
   *
   * 用户的原话："字还可以再大一点，我说中文一定比英文字数少。"
   * 下拉框给四档，默认「更大」= 1.35；选了非法值就回落到配置默认值，
   * 不让一个空字符串把字号算成 NaN。
   */
  function getFontGrow() {
    const v = parseFloat(els.fontGrow && els.fontGrow.value);
    if (!isFinite(v) || v <= 0) return C.LIMITS.overlayFontGrow;
    return Math.min(3, Math.max(0.5, v));
  }

  function selectedValue(select, customInput) {
    const custom = (customInput.value || "").trim();
    return custom || (select.value || "").trim();
  }

  function visionConfig() {
    const preset = C.VISION_PRESETS[els.visionProvider.value] || C.VISION_PRESETS.gemini;
    const base = (els.visionBase.value || "").trim() || preset.baseUrl;
    return {
      provider: els.visionProvider.value,
      api: preset.api,
      baseUrl: base,
      apiKey: (els.visionKey.value || "").trim(),
      model: selectedValue(els.visionModel, els.visionModelCustom),
      label: preset.label,
    };
  }

  function llmConfig() {
    const preset = C.LLM_PRESETS[els.llmProvider.value] || C.LLM_PRESETS.deepseek;
    const base = (els.llmBase.value || "").trim() || preset.baseUrl;
    return {
      provider: els.llmProvider.value,
      api: preset.api,
      baseUrl: base,
      apiKey: (els.llmKey.value || "").trim(),
      model: selectedValue(els.llmModel, els.llmModelCustom),
      label: preset.label,
    };
  }

  function glossaryEntries() {
    return C.parseGlossary(els.glossary.value);
  }

  function profileHint() {
    return (els.profileHint.value || "").trim();
  }

  /* ============================================================
   * 引擎 UI 联动
   * ============================================================ */

  function fillSelect(sel, presets, selected) {
    sel.innerHTML = "";
    Object.keys(presets).forEach(function (id) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = presets[id].label;
      sel.appendChild(opt);
    });
    if (selected && presets[selected]) sel.value = selected;
  }

  function fillModels(sel, models, selected) {
    sel.innerHTML = "";
    if (!models || !models.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "（先拉取模型列表，或手动输入）";
      sel.appendChild(opt);
      return;
    }
    models.forEach(function (id) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = id;
      sel.appendChild(opt);
    });
    if (selected && models.indexOf(selected) >= 0) sel.value = selected;
  }

  function applyVisionPreset(force) {
    const p = C.VISION_PRESETS[els.visionProvider.value] || C.VISION_PRESETS.gemini;
    if (force || !els.visionBase.value.trim()) els.visionBase.value = p.baseUrl || "";
    if (force) {
      fillModels(els.visionModel, p.models || [], p.model);
      els.visionModelCustom.value = "";
    }
    els.visionNote.textContent = p.note || "";
    if (p.keyUrl) {
      els.visionKeyLink.href = p.keyUrl;
      els.visionKeyLink.classList.remove("hidden");
    } else {
      els.visionKeyLink.classList.add("hidden");
    }
  }

  function applyLlmPreset(force) {
    const p = C.LLM_PRESETS[els.llmProvider.value] || C.LLM_PRESETS.deepseek;
    if (force || !els.llmBase.value.trim()) els.llmBase.value = p.baseUrl || "";
    if (force) {
      fillModels(els.llmModel, p.models || [], p.model);
      els.llmModelCustom.value = "";
    }
    els.llmNote.textContent = p.note || "";
    if (p.keyUrl) {
      els.llmKeyLink.href = p.keyUrl;
      els.llmKeyLink.classList.remove("hidden");
    } else {
      els.llmKeyLink.classList.add("hidden");
    }
  }

  function setBadge(el, text, kind) {
    el.textContent = text;
    el.classList.remove("on", "warn");
    if (kind) el.classList.add(kind);
  }

  function syncEngineUi() {
    const engine = getOcrEngine();
    const isVision = engine === "vision";
    const recogOnly = isVision && els.visionRecognizeOnly.checked;
    const translateEngine = recogOnly ? getTranslateEngine() : isVision ? "vision" : getTranslateEngine();

    els.visionBox.classList.toggle("hidden", !isVision);

    // 翻译方式的选择框在「视觉模型直接翻译」时没有意义，禁掉并说明原因，
    // 而不是让它保持可点却不起作用（原实现就是那样，用户会以为改了设置生效了）
    const translateLocked = isVision && !recogOnly;
    els.translateEngine.disabled = translateLocked;
    els.translateEngineField.classList.toggle("dimmed", translateLocked);

    els.llmBox.classList.toggle("hidden", translateEngine !== "llm");

    if (isVision) {
      els.enginePill.textContent = recogOnly ? "云端识别 · 只识别" : "云端视觉模型";
      els.enginePill.classList.remove("subtle");
      els.engineHint.textContent = recogOnly
        ? "视觉模型只负责把英文认出来，译文由下面的「翻译方式」产出。"
        : "视觉模型看图识别并直接翻译。小字、糊字效果最好。需要 API Key。";
    } else {
      els.enginePill.textContent = "本地 OCR · 不传图";
      els.enginePill.classList.add("subtle");
      els.engineHint.textContent =
        "文字识别在本机完成，图片不外发。识别质量受分辨率影响，很糊的小字可能认不准。";
    }

    // 视觉模型状态
    if (isVision) {
      const v = visionConfig();
      if (!v.apiKey) setBadge(els.visionStatus, "未填 Key", "warn");
      else if (!v.model) setBadge(els.visionStatus, "未选模型", "warn");
      else setBadge(els.visionStatus, v.label + " · " + v.model, "on");
    }

    // 文本模型状态
    const l = llmConfig();
    if (translateEngine !== "llm") {
      setBadge(els.llmStatus, "未使用");
    } else if (!l.apiKey) setBadge(els.llmStatus, "未填 Key", "warn");
    else if (!l.model) setBadge(els.llmStatus, "未选模型", "warn");
    else setBadge(els.llmStatus, l.label + " · " + l.model, "on");

    els.btnStart.disabled = !state.files.length;
  }

  /* ============================================================
   * 校验
   * ============================================================ */

  function validate() {
    const engine = getOcrEngine();
    const recogOnly = engine === "vision" && els.visionRecognizeOnly.checked;
    const translateEngine = engine === "vision" && !recogOnly ? "vision" : getTranslateEngine();

    // 识别引擎只作用于图片；PDF 走自己的文字层。
    // 所以"全是 PDF"时不该要求视觉模型的 Key —— 否则用户处理一个带文字层的
    // PDF，却被拦下来要求先配一个根本不会被用到的 Key。
    const hasImages = state.files.some(function (f) {
      return !(PDF_RE.test(f.name) || f.type === "application/pdf");
    });

    if (engine === "vision" && hasImages) {
      const v = visionConfig();
      if (!v.apiKey) {
        return (
          "识别引擎选了「云端视觉模型」，但没有填 API Key。\n\n" +
          "两种选择：\n" +
          "  · 填上 Key（点界面上的「申请 Key」链接），或\n" +
          "  · 把识别引擎切回「本地 OCR」，那样不需要任何 Key。"
        );
      }
      if (v.apiKey.length < 12) {
        return "视觉模型 API Key 看起来太短，请检查是否复制完整。";
      }
      if (!v.baseUrl) return "请填写视觉模型的 Base URL。";
      if (!v.model) {
        return (
          "还没有选视觉模型。\n\n" +
          "点「拉取模型列表」从你的账号拉取真实可用的模型，\n" +
          "或在模型输入框里手动填写模型 ID。"
        );
      }
    }

    if (translateEngine === "llm") {
      const l = llmConfig();
      if (!l.apiKey) return "翻译方式选了「大模型翻译」，但没有填 API Key。";
      if (!l.baseUrl) return "请填写文本大模型的 Base URL。";
      if (!l.model) return "还没有选文本大模型，请点「拉取模型列表」或手动填写模型 ID。";
    }

    return null;
  }

  /* ============================================================
   * 拉取模型 / 测试连接
   * ============================================================ */

  async function fetchVisionModels() {
    const v = visionConfig();
    const out = els.visionNoteResult;
    out.classList.remove("ok", "err");
    if (!v.apiKey) {
      out.textContent = "请先填写 API Key。";
      out.classList.add("err");
      return;
    }
    out.textContent = "正在从 " + v.baseUrl + " 拉取模型列表…";
    els.btnVisionModels.disabled = true;
    try {
      const ids = await window.PZVision.listModels({
        api: v.api,
        baseUrl: v.baseUrl,
        apiKey: v.apiKey,
        model: v.model,
      });
      fillModels(els.visionModel, ids, v.model);
      els.visionModelCustom.value = "";
      out.textContent = "拉取到 " + ids.length + " 个模型，已选：" + els.visionModel.value;
      out.classList.add("ok");
    } catch (err) {
      out.textContent = "拉取失败：" + (err && err.message ? err.message : err);
      out.classList.add("err");
    } finally {
      els.btnVisionModels.disabled = false;
      syncEngineUi();
    }
  }

  async function testVision() {
    const v = visionConfig();
    const out = els.visionNoteResult;
    out.classList.remove("ok", "err");
    if (!v.apiKey) {
      out.textContent = "请先填写 API Key。";
      out.classList.add("err");
      return;
    }
    out.textContent = "正在测试 " + v.label + " · " + (v.model || "(未选模型)") + "…";
    els.btnVisionTest.disabled = true;
    try {
      const r = await window.PZVision.testKey({
        api: v.api,
        baseUrl: v.baseUrl,
        apiKey: v.apiKey,
        model: v.model,
      });
      out.textContent =
        "连接成功。模型 " + r.model + " · 端点 " + r.endpoint +
        (r.latencyMs ? " · " + r.latencyMs + "ms" : "");
      out.classList.add("ok");
    } catch (err) {
      out.textContent = "连接失败：" + (err && err.message ? err.message : err);
      out.classList.add("err");
    } finally {
      els.btnVisionTest.disabled = false;
      syncEngineUi();
    }
  }

  async function fetchLlmModels() {
    const l = llmConfig();
    const out = els.llmResult;
    out.classList.remove("ok", "err");
    if (!l.apiKey) {
      out.textContent = "请先填写 API Key。";
      out.classList.add("err");
      return;
    }
    out.textContent = "正在拉取模型列表…";
    els.btnLlmModels.disabled = true;
    try {
      const ids = await window.PZTranslate.listLlmModels({
        api: l.api,
        baseUrl: l.baseUrl,
        apiKey: l.apiKey,
      });
      fillModels(els.llmModel, ids, l.model);
      els.llmModelCustom.value = "";
      out.textContent = "拉取到 " + ids.length + " 个模型，已选：" + els.llmModel.value;
      out.classList.add("ok");
    } catch (err) {
      out.textContent = "拉取失败：" + (err && err.message ? err.message : err);
      out.classList.add("err");
    } finally {
      els.btnLlmModels.disabled = false;
      syncEngineUi();
    }
  }

  async function testLlm() {
    const l = llmConfig();
    const out = els.llmResult;
    out.classList.remove("ok", "err");
    if (!l.apiKey) {
      out.textContent = "请先填写 API Key。";
      out.classList.add("err");
      return;
    }
    out.textContent = "正在测试…";
    els.btnLlmTest.disabled = true;
    try {
      const r = await window.PZTranslate.testLlm({
        api: l.api,
        baseUrl: l.baseUrl,
        apiKey: l.apiKey,
        model: l.model,
      });
      out.textContent = "连接成功。模型 " + r.model + " · 端点 " + r.endpoint;
      out.classList.add("ok");
    } catch (err) {
      out.textContent = "连接失败：" + (err && err.message ? err.message : err);
      out.classList.add("err");
    } finally {
      els.btnLlmTest.disabled = false;
      syncEngineUi();
    }
  }

  /* ============================================================
   * 领域配置
   * ============================================================ */

  function fillProfileSelect() {
    els.profile.innerHTML = "";
    Object.keys(C.PROFILES).forEach(function (id) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = C.PROFILES[id].label;
      els.profile.appendChild(opt);
    });
  }

  function loadProfileIntoFields(id) {
    const p = C.PROFILES[id];
    if (!p) return;
    els.glossary.value = p.glossary || "";
    els.profileHint.value = p.hint || "";
  }

  /* ============================================================
   * 本地偏好持久化
   * ============================================================ */

  function store(key, value) {
    try {
      localStorage.setItem(STORE_PREFIX + key, value);
    } catch (e) {
      /* 隐私模式下 localStorage 可能不可用，不影响主流程 */
    }
  }

  function restore(key, fallback) {
    try {
      const v = localStorage.getItem(STORE_PREFIX + key);
      return v == null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function savePrefs() {
    store("ocr_engine", getOcrEngine());
    store("translate_engine", getTranslateEngine());
    store("target_lang", els.targetLang.value);
    store("cover", els.cover.checked ? "1" : "0");
    store("erase_mode", els.eraseMode.value);
    store("font_grow", els.fontGrow.value);
    store("preserve", els.preserveCodes.checked ? "1" : "0");
    store("field_colors", els.fieldColors.checked ? "1" : "0");
    store("vision_provider", els.visionProvider.value);
    store("vision_base", els.visionBase.value);
    store("vision_key", els.visionKey.value);
    store("vision_model", els.visionModel.value);
    store("vision_model_custom", els.visionModelCustom.value);
    store("vision_recog_only", els.visionRecognizeOnly.checked ? "1" : "0");
    store("llm_provider", els.llmProvider.value);
    store("llm_base", els.llmBase.value);
    store("llm_key", els.llmKey.value);
    store("llm_model", els.llmModel.value);
    store("llm_model_custom", els.llmModelCustom.value);
    store("profile", els.profile.value);
    store("glossary_" + els.profile.value, els.glossary.value);
    store("hint_" + els.profile.value, els.profileHint.value);
  }

  /* ============================================================
   * 文件选择
   * ============================================================ */

  function classify(fileList) {
    const images = [];
    const pdfs = [];
    Array.prototype.forEach.call(fileList || [], function (f) {
      if (PDF_RE.test(f.name) || f.type === "application/pdf") pdfs.push(f);
      else if (IMAGE_RE.test(f.name) || (f.type || "").indexOf("image/") === 0) images.push(f);
    });
    return { images: images, pdfs: pdfs };
  }

  function updateFileList() {
    if (!state.files.length) {
      els.fileList.classList.add("hidden");
      els.fileList.textContent = "";
      els.btnStart.disabled = true;
      return;
    }
    els.fileList.classList.remove("hidden");
    els.fileList.textContent =
      "已选 " + state.files.length + " 个：" +
      state.files
        .map(function (f, i) {
          return i + 1 + ". " + f.name;
        })
        .join("　");
    els.btnStart.disabled = false;
  }

  function acceptFiles(fileList) {
    const c = classify(fileList);
    if (!c.images.length && !c.pdfs.length) {
      fail("请选择 PDF 或图片文件（JPG / PNG / WebP / BMP）。");
      return;
    }
    if (c.pdfs.length > 1) {
      fail("一次只能处理 1 个 PDF。图片可以多选。");
      return;
    }
    state.files = c.pdfs.concat(c.images);
    updateFileList();
    showPanel("upload");
  }

  /* ============================================================
   * 图片载入
   * ============================================================ */

  /**
   * 读进 canvas。小图做温和放大 —— 注意：插值放大**不能凭空造出信息**，
   * 真正让糊掉的小字变清楚的是 PZImage 里的反锐化掩膜，这里只是给后续
   * 锐化和 OCR 一个够用的像素基数。
   */
  function loadImageToCanvas(file, maxSide) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        const nw = img.naturalWidth;
        const nh = img.naturalHeight;
        if (!nw || !nh) {
          reject(new Error("图片尺寸异常：" + file.name));
          return;
        }
        const long = Math.max(nw, nh);
        let k = Math.min(1, maxSide / long);
        if (long < 900) k = Math.min(2, 1600 / long);
        const w = Math.max(1, Math.round(nw * k));
        const h = Math.max(1, Math.round(nh * k));
        const cv = U.createCanvas(w, h);
        const ctx = U.ctx2d(cv);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        // JPEG 没有 alpha 通道，透明区域直接画会变黑，先铺白底
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(cv);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("无法读取图片：" + file.name));
      };
      img.src = url;
    });
  }

  /* ============================================================
   * 流水线：PDF
   * ============================================================ */

  /**
   * 排版 + 去字的公共参数。
   *
   * PDF 与图片两条流水线原来各抄了一份，抄漏过东西（一次是 PDF 漏传了
   * 字段配色）。集中成一处，新增参数只需要改这里。
   */
  function overlayOpts(ctx) {
    return {
      cover: ctx.cover,
      fieldColors: ctx.fieldColors,
      maxGrowY: C.LIMITS.overlayMaxGrowY,
      minFontSize: C.LIMITS.overlayMinFontSize,
      minReadableSize: C.LIMITS.overlayMinReadableSize,
      // 中文字号放大系数（用户可调，见「中文字号」下拉框）
      fontGrow: getFontGrow(),
      // 去字
      eraseMode: ctx.eraseMode,
      eraseRingWidth: C.LIMITS.eraseRingWidth,
      eraseInkThreshold: C.LIMITS.eraseInkThreshold,
      eraseInkThresholdFlat: C.LIMITS.eraseInkThresholdFlat,
      eraseInkThresholdMid: C.LIMITS.eraseInkThresholdMid,
      eraseHaloGrow: C.LIMITS.eraseHaloGrow,
      eraseHaloDelta: C.LIMITS.eraseHaloDelta,
      eraseResidualDelta: C.LIMITS.eraseResidualDelta,
      eraseLineFillRatio: C.LIMITS.eraseLineFillRatio,
      eraseLineMaxThickness: C.LIMITS.eraseLineMaxThickness,
      signal: ctx.signal,
      onLog: ctx.log,
    };
  }

  async function processPdfFile(file, ctx) {
    const buffer = await file.arrayBuffer();
    const doc = await window.PZPdf.loadDocument(buffer);
    const scale = C.LIMITS.pdfRenderScale;
    const pages = [];
    const warnings = [];

    for (let no = 1; no <= doc.numPages; no++) {
      U.throwIfAborted(ctx.signal);
      ctx.step("detect");
      ctx.progress("detect", (no - 1) / doc.numPages);
      ctx.log("解析第 " + no + "/" + doc.numPages + " 页文字层");

      const ex = await window.PZPdf.extractPage(doc, no);

      if (!ex.lines.length) {
        // 没有文字层（扫描页）→ 渲染成画布，走图片那条路。
        // 比原实现「跳过并让用户自己去导图片」有用得多，而且复用了同一套代码。
        ctx.log("第 " + no + " 页没有文字层，改为按图片识别");
        const scanned = await window.PZPdf.renderPage(ex.page, scale);
        const r = await processCanvasAsImage(scanned, ctx);
        pages.push({
          original: scanned,
          translated: r.composed,
          items: r.items,
          label: file.name + " · 第 " + no + " 页（扫描）",
          // 页面尺寸仍然取 PDF 本身的，不要用图片那套反推
          pageSize: { wPt: ex.widthPt, hPt: ex.heightPt },
          stats: r.composed._overlayStats,
          engine: "pdf-scanned",
        });
        warnings.push.apply(warnings, r.warnings);
        if (!r.items.length) {
          warnings.push("第 " + no + " 页是扫描页，且没有识别出文字，该页保持原样。");
        }
        continue;
      }

      // 翻译
      ctx.step("translate");
      ctx.progress("translate", (no - 1) / doc.numPages);
      const translated = await window.PZTranslate.translateMany(
        ex.lines.map(function (l) {
          return l.text;
        }),
        ctx.translateOpts,
        {
          onProgress: function (done, total) {
            ctx.progress("translate", ((no - 1) + done / Math.max(1, total)) / doc.numPages);
          },
        }
      );

      const items = ex.lines.map(function (l, k) {
        const t = translated[k] || {};
        return {
          x: l.x * scale,
          y: l.y * scale,
          w: l.w * scale,
          h: l.h * scale,
          src: l.text,
          dst: t.dst == null ? l.text : t.dst,
          engine: t.engine,
          warn: t.warn,
        };
      });

      // 渲染 + 排版
      ctx.step("compose");
      ctx.progress("compose", (no - 1) / doc.numPages);
      const rendered = await window.PZPdf.renderPage(ex.page, scale);
      const composed = OV.render(rendered, items, overlayOpts(ctx));

      pages.push({
        original: rendered,
        translated: composed,
        items: items,
        label: file.name + " · 第 " + no + " 页",
        pageSize: { wPt: ex.widthPt, hPt: ex.heightPt },
        stats: composed._overlayStats,
        engine: "pdf",
      });
    }

    return { pages: pages, warnings: warnings };
  }

  /* ============================================================
   * 流水线：图片
   * ============================================================ */

  /**
   * 文字区域检测（大图自动分块）。
   *
   * 为什么必须分块：`PZDetect` 会把图缩到长边 `detectMaxSide`（1600）再检测。
   * 一张 5100px 的图纸缩到 1600 是 **0.31 倍** —— 原本 15px 的小标签变成 4.7px，
   * 掉到最小行高以下就**直接漏检**，那一块永远不会被翻译；
   * 而且整图兜底那遍缩得更狠，根本救不回来。
   *
   * 所以大图切成带重叠的块，每块单独检测（此时每块的有效分辨率接近原图），
   * 再把坐标平移回整图、去重合并。小字就是这么保住的。
   */
  function detectText(canvas, log) {
    const maxSide = C.LIMITS.detectMaxSide;
    const W = canvas.width;
    const H = canvas.height;

    // 每块的目标边长略小于上限，给重叠留余地
    const target = Math.round(maxSide * 0.86);
    const cols = Math.max(1, Math.ceil(W / target));
    const rows = Math.max(1, Math.ceil(H / target));

    if (cols === 1 && rows === 1) {
      const det = window.PZDetect.detect(canvas, { maxSide: maxSide });
      det.stats = det.stats || {};
      det.stats.tiles = 1;
      return det;
    }

    const tileW = Math.ceil(W / cols);
    const tileH = Math.ceil(H / rows);
    // 重叠是为了不让正好压在两块交界上的文字被切掉
    const overlap = Math.round(Math.min(tileW, tileH) * 0.12);

    const allLines = [];
    const allRegions = [];
    let ms = 0;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x0 = Math.max(0, c * tileW - (c > 0 ? overlap : 0));
        const y0 = Math.max(0, r * tileH - (r > 0 ? overlap : 0));
        const x1 = Math.min(W, (c + 1) * tileW + (c < cols - 1 ? overlap : 0));
        const y1 = Math.min(H, (r + 1) * tileH + (r < rows - 1 ? overlap : 0));
        const tw = x1 - x0;
        const th = y1 - y0;
        if (tw < 32 || th < 32) continue;

        const tile = U.cropCanvas(canvas, { x: x0, y: y0, w: tw, h: th }, { pad: 0, scale: 1 });
        const det = window.PZDetect.detect(tile, { maxSide: maxSide });
        ms += (det.stats && det.stats.ms) || 0;

        for (let i = 0; i < det.lines.length; i++) {
          const l = det.lines[i];
          allLines.push({ x: l.x + x0, y: l.y + y0, w: l.w, h: l.h, fontHeight: l.h, conf: l.conf });
        }
        const regs = det.regions || [];
        for (let i = 0; i < regs.length; i++) {
          const g = regs[i];
          allRegions.push({ x: g.x + x0, y: g.y + y0, w: g.w, h: g.h, score: g.score, lines: g.lines });
        }
      }
    }

    // 重叠区里同一行会被相邻两块各检一次，按重叠比例去重
    const lines = [];
    for (let i = 0; i < allLines.length; i++) {
      const a = allLines[i];
      let dup = false;
      for (let j = 0; j < lines.length; j++) {
        if (U.overlapRatio(lines[j], a) > 0.5) {
          dup = true;
          break;
        }
      }
      if (!dup) lines.push(a);
    }

    const regions = [];
    for (let i = 0; i < allRegions.length; i++) {
      const a = allRegions[i];
      let dup = false;
      for (let j = 0; j < regions.length; j++) {
        if (U.overlapRatio(regions[j], a) > 0.4) {
          dup = true;
          break;
        }
      }
      if (!dup) regions.push(a);
    }

    // 按阅读顺序排（上到下、左到右）。下游会 `slice(0, maxRegions)` 截断，
    // 不排序的话截出来的是"前几块"而不是"页面靠上那部分"，截断位置就没意义了。
    const cmp = function (a, b) {
      if (Math.abs(a.y - b.y) > Math.max(a.h, b.h) * 0.6) return a.y - b.y;
      return a.x - b.x;
    };
    lines.sort(cmp);
    regions.sort(cmp);

    if (log) {
      log("  大图分 " + cols + "×" + rows + " 块检测，得到 " + lines.length + " 行 / " + regions.length + " 区域");
    }

    return {
      width: W,
      height: H,
      lines: lines,
      regions: regions,
      hasText: lines.length > 0,
      stats: {
        ms: ms,
        tiles: cols * rows,
        cols: cols,
        rows: rows,
        lines: lines.length,
        regions: regions.length,
      },
    };
  }

  /**
   * 对一张画布做「识别 → 翻译 → 排版」，返回 {items, composed, warnings}。
   *
   * 图片和「没有文字层的 PDF 页面」共用这一段。后者会先把 PDF 页渲染成画布
   * 再走同一条路 —— 原实现遇到扫描版 PDF 只会跳过，让用户自己去把页面导成图片。
   */
  async function processCanvasAsImage(canvas, ctx) {
    const items = [];
    const warnings = [];

    // 选了视觉模型但没填 Key 时（纯 PDF 批次不会强制要求 Key），
    // 扫描页只能退回本地 OCR —— 比直接报错或跳过有用得多。
    const wantVision = ctx.ocrEngine === "vision";
    const useVision = wantVision && !!(ctx.vision && ctx.vision.apiKey);
    if (wantVision && !useVision) {
      ctx.log("  未配置视觉模型 Key，本页退回本地 OCR");
    }

    // 先做一次检测，两条路都要用：
    //  · 视觉路径：把区域传下去做"区域放大识别"，比让视觉模块自己缩图检测强
    //  · 本地路径：给 OCR 切条带用
    ctx.step("detect");
    const det = detectText(canvas, ctx.log);
    ctx.log(
      "  定位到 " + det.lines.length + " 行 / " + det.regions.length + " 区域（" +
        (det.stats && det.stats.ms ? det.stats.ms + "ms" : "?") + "）"
    );
    if (!det.regions.length) ctx.log("  未定位到文字区域，将退化为整图识别");
    // 区域被截断时必须说出来：表现是"页面某一段整块没翻"，不说的话用户只会以为是漏识别
    if (det.regions.length >= C.LIMITS.visionMaxRegions * (C.LIMITS.visionRegionWarnRatio || 0.9)) {
      ctx.log(
        "  ！区域数（" + det.regions.length + "）接近上限 " + C.LIMITS.visionMaxRegions +
          "，超出的部分只会走整图兜底，可能翻不全"
      );
    }

    if (useVision) {
      // ---------- 云端视觉模型 ----------
      ctx.step("recognize");
      const res = await window.PZVision.translate(
        canvas,
        {
          api: ctx.vision.api,
          baseUrl: ctx.vision.baseUrl,
          apiKey: ctx.vision.apiKey,
          model: ctx.vision.model,
          targetLang: ctx.targetLang,
          glossaryEntries: ctx.glossary,
          profileHint: ctx.hint,
          translate: !ctx.recognizeOnly,
          signal: ctx.signal,
          concurrency: C.LIMITS.visionConcurrency,
          maxRegions: C.LIMITS.visionMaxRegions,
          // 用上面分块检测的结果。视觉模块自己检测时会先把图缩到 1600，
          // 大图纸上的小字就没了 —— 所以必须把区域显式传下去。
          regions: det.regions.length ? det.regions : null,
          wholeImage: true,
          limits: C.LIMITS,
        },
        {
          onProgress: function (p) {
            ctx.progress("recognize", p && p.total ? p.done / p.total : 0);
            if (p && p.message) ctx.log("  " + p.message);
          },
          onLog: ctx.log,
        }
      );

      res.items.forEach(function (it) {
        items.push({
          x: it.x,
          y: it.y,
          w: it.w,
          h: it.h,
          src: it.src,
          dst: ctx.recognizeOnly ? "" : it.dst,
          engine: it.source === "whole" ? "vision-whole" : "vision-region",
        });
      });

      if (res.stats && res.stats.failed) {
        warnings.push(
          "有 " + res.stats.failed + " 个区域调用视觉模型失败，这些区域的内容可能没有被翻译。"
        );
      }
      ctx.log(
        "  视觉模型返回 " + items.length + " 条（请求 " + (res.stats ? res.stats.requests : "?") + " 次）"
      );
    } else {
      // ---------- 本地 OCR ----------
      // 检测已经在上面做过了（分块），这里直接用它切条带
      ctx.step("recognize");
      const ocr = await window.PZOcr.recognize(
        canvas,
        { lines: det.lines, workers: C.LIMITS.ocrWorkers, signal: ctx.signal },
        {
          onProgress: function (p) {
            ctx.progress("recognize", p && p.total ? p.done / p.total : 0);
            if (p && p.message) ctx.log("  " + p.message);
          },
          onLog: ctx.log,
        }
      );
      ctx.log("  识别出 " + ocr.lines.length + " 条文字");

      if (!ocr.lines.length) {
        warnings.push("这张图没有识别出任何文字。可以试试改用「云端视觉模型」，它对模糊小字明显更强。");
      }

      ocr.lines.forEach(function (l) {
        items.push({
          x: l.x,
          y: l.y,
          w: l.w,
          h: l.h,
          src: l.text,
          dst: l.text,
          engine: "ocr",
        });
      });
    }

    // ---------- 翻译（仅本地 OCR 路线，或视觉模型"只识别"模式）----------
    // 注意判断用的是 useVision：视觉模型只有真的调用了才不需要翻译引擎。
    const needTranslate = !useVision || ctx.recognizeOnly;
    if (needTranslate && items.length) {
      ctx.step("translate");
      const translated = await window.PZTranslate.translateMany(
        items.map(function (it) {
          return it.src;
        }),
        ctx.translateOpts,
        {
          onProgress: function (done, total) {
            ctx.progress("translate", done / Math.max(1, total));
          },
        }
      );
      for (let i = 0; i < items.length; i++) {
        const t = translated[i];
        if (!t) continue;
        items[i].dst = t.dst == null ? items[i].src : t.dst;
        items[i].engine = t.engine;
        if (t.warn) warnings.push(t.warn);
      }
    }

    // ---------- 最终去重 ----------
    // 必须在排版前做：重叠的两条会让中文在几乎同一个位置画两遍，
    // 看起来就是"翻译了两次"。
    const dd = U.dedupeOverlappingItems(items);
    if (dd.merged) {
      ctx.log("  合并了 " + dd.merged + " 条重复识别（同一处被检出多次）");
    }

    // ---------- 排版 ----------
    ctx.step("compose");
    const composed = OV.render(canvas, dd.items, overlayOpts(ctx));

    // 纯色填充的前提是"文字压在纯色底上"。底色不纯时它会留下一块看得见的色块，
    // 这时要明确告诉用户换个方式，而不是默默交出一张有痕迹的图。
    const ost = composed._overlayStats;
    if (ost && ost.lowCoverage) {
      warnings.push(
        "有 " + ost.lowCoverage + " 处文字压在图案/渐变上，纯色填充在那里会留下一块色块。" +
          "这类图可以把「去字方式」切到「智能修复」再试。"
      );
    }
    // 擦完仍有残墨：说明这些块的底色不够纯，或者字色和底色太接近，
    // 自动阈值不敢再往下压。告诉用户是哪些块，而不是假装干净。
    if (ost && ost.residualBlocks) {
      ctx.log(
        "⚠ 有 " + ost.residualBlocks + " 处擦除后仍有残墨（残墨像素合计 " +
          (ost.eraseResidual || 0) + "），多半是底色不纯或字色接近底色"
      );
    }

    return { items: dd.items, composed: composed, warnings: warnings };
  }

  async function processImageFile(file, ctx) {
    ctx.step("load");
    ctx.log("载入图片 " + file.name);
    const canvas = await loadImageToCanvas(file, 3800);
    ctx.log("  → " + canvas.width + "×" + canvas.height);

    const r = await processCanvasAsImage(canvas, ctx);

    return {
      pages: [
        {
          original: canvas,
          translated: r.composed,
          items: r.items,
          label: file.name,
          // 图片没有"原始页面尺寸"这个概念，按 IMAGE_EXPORT_DPI 反推一个合理的物理大小
          pageSize: {
            wPt: (canvas.width * 72) / IMAGE_EXPORT_DPI,
            hPt: (canvas.height * 72) / IMAGE_EXPORT_DPI,
          },
          stats: r.composed._overlayStats,
          engine: ctx.ocrEngine,
        },
      ],
      warnings: r.warnings,
    };
  }

  /* ============================================================
   * 主流程
   * ============================================================ */

  function buildOutputName(files) {
    if (files.length === 1) return files[0].name.replace(/\.[^.]+$/, "") + "-中文版.pdf";
    return "翻译-" + files.length + "个文件-中文版.pdf";
  }

  async function handleStart() {
    const problem = validate();
    if (problem) {
      fail(problem);
      return;
    }

    const ocrEngine = getOcrEngine();
    const recognizeOnly = ocrEngine === "vision" && els.visionRecognizeOnly.checked;
    const controller = new AbortController();
    state.controller = controller;

    const signal = controller.signal;
    const isVision = ocrEngine === "vision";

    const ctx = {
      signal: signal,
      ocrEngine: ocrEngine,
      recognizeOnly: recognizeOnly,
      targetLang: els.targetLang.value,
      cover: els.cover.checked,
      eraseMode: els.eraseMode.value || "ink",
      fieldColors: els.fieldColors.checked,
      glossary: glossaryEntries(),
      hint: profileHint(),
      vision: visionConfig(),
      translateOpts: {
        // 注意：这里**不能**因为选了视觉模型就把 engine 改成 "dict"。
        // 视觉模型只作用于图片；PDF 走文字层，永远需要真正的翻译引擎。
        // （写错过一次：PDF + 视觉模型会让 PDF 只做词表替换，等于没翻。）
        engine: getTranslateEngine(),
        targetLang: els.targetLang.value,
        glossaryEntries: glossaryEntries(),
        profileHint: profileHint(),
        preserveCodes: els.preserveCodes.checked,
        signal: signal,
        llm: llmConfig(),
      },
      step: setStep,
      progress: null,
      log: log,
    };

    const phases = [
      { name: "load", weight: 5 },
      { name: "detect", weight: isVision ? 4 : 10 },
      { name: "recognize", weight: isVision ? 60 : 45 },
      { name: "translate", weight: isVision && !recognizeOnly ? 6 : 22 },
      { name: "compose", weight: 15 },
    ];
    ctx.progress = createProgress(phases);

    state.pages = [];
    state.pageIndex = 0;
    state.showOriginal = false;
    state.highlight = null;
    clearLog();
    showPanel("process");
    els.processTitle.textContent = "正在处理";
    els.processFile.textContent = state.files
      .map(function (f) {
        return f.name;
      })
      .join("、");
    setProgress(0, "准备中…");
    setStep("load");
    ctx.progress("load", 0.05);

    const allWarnings = [];
    const t0 = Date.now();

    if (isVision && !state.files.some(function (f) {
      return !(PDF_RE.test(f.name) || f.type === "application/pdf");
    })) {
      log("所选文件都是 PDF：直接用其文字层提取，不会调用视觉模型。");
      log("图片才会走识别引擎（当前为「" + (isVision ? "云端视觉模型" : "本地 OCR") + "」）。");
    }

    try {
      const pdfs = state.files.filter(function (f) {
        return PDF_RE.test(f.name) || f.type === "application/pdf";
      });
      const images = state.files.filter(function (f) {
        return !(PDF_RE.test(f.name) || f.type === "application/pdf");
      });

      for (let i = 0; i < pdfs.length; i++) {
        U.throwIfAborted(signal);
        ctx.progress("load", 0.05 + ((i + 0.5) / state.files.length) * 0.9);
        const res = await processPdfFile(pdfs[i], ctx);
        state.pages = state.pages.concat(res.pages);
        allWarnings.push.apply(allWarnings, res.warnings);
      }

      for (let i = 0; i < images.length; i++) {
        U.throwIfAborted(signal);
        ctx.progress("load", 0.05 + ((pdfs.length + i + 0.5) / state.files.length) * 0.9);
        const res = await processImageFile(images[i], ctx);
        state.pages = state.pages.concat(res.pages);
        allWarnings.push.apply(allWarnings, res.warnings);
      }

      ctx.progress("compose", 1);
      setStep("done");

      if (!state.pages.length) {
        fail(
          "没有产出任何页面。\n\n" +
            (allWarnings.length ? allWarnings.join("\n") : "请确认文件内容，或换一种识别引擎再试。")
        );
        return;
      }

      // ---------- 汇总 ----------
      let totalItems = 0;
      let drawn = 0;
      let shrunk = 0;
      let overflow = 0;
      state.pages.forEach(function (p) {
        totalItems += (p.items || []).length;
        if (p.stats) {
          drawn += p.stats.drawn || 0;
          shrunk += p.stats.shrunk || 0;
          overflow += p.stats.overflow || 0;
        }
      });

      if (overflow) {
        allWarnings.push(
          "有 " + overflow + " 处译文在最小字号下仍然放不下，已按裁剪处理。" +
            "这通常意味着原文那一格太小，或者译文比原文长得多。"
        );
      }
      if (shrunk) {
        allWarnings.push(
          "有 " + shrunk + " 处译文为了不压到相邻文字而缩小了字号。"
        );
      }
      const skipped = state.pages.reduce(function (s, p) {
        return s + (p.stats ? (p.stats.skippedEmpty || 0) + (p.stats.skippedSame || 0) : 0);
      }, 0);
      if (skipped) {
        allWarnings.push(
          "有 " + skipped + " 条没有替换（译文与原文相同或为空，属于「保持原样」的条目）。"
        );
      }

      els.resultMeta.textContent =
        (ocrEngine === "vision" ? "云端视觉模型" : "本地 OCR") +
        " · " +
        (isVision && !recognizeOnly ? "视觉模型翻译" : "译文：" + getTranslateEngine()) +
        " · " +
        state.files.length +
        " 个文件 · " +
        state.pages.length +
        " 页 · 识别 " +
        totalItems +
        " 条 · 覆盖 " +
        drawn +
        " 条 · 耗时 " +
        U.fmtDuration(Date.now() - t0);

      if (allWarnings.length) {
        els.resultWarnings.classList.remove("hidden");
        els.resultWarnings.textContent = allWarnings
          .filter(function (v, i, a) {
            return a.indexOf(v) === i;
          })
          .map(function (w) {
            return "· " + w;
          })
          .join("\n");
      } else {
        els.resultWarnings.classList.add("hidden");
        els.resultWarnings.textContent = "";
      }

      state.fileName = buildOutputName(state.files);
      setProgress(100, "完成");
      showPanel("result");
      renderPreview();
      renderTextList();
    } catch (err) {
      if (U.isAbortError(err)) {
        log("用户取消");
        state.controller = null;
        showPanel("upload");
        return;
      }
      console.error(err);
      fail(
        "处理中断：\n" +
          (err && err.message ? err.message : String(err)) +
          "\n\n已经处理完的页面不会被导出。可以调整设置后重试。"
      );
    } finally {
      state.controller = null;
    }
  }

  /* ============================================================
   * 预览与文本列表
   * ============================================================ */

  function renderPreview() {
    if (!state.pages.length) return;
    const page = state.pages[state.pageIndex];
    const src = state.showOriginal ? page.original : page.translated;
    const canvas = els.previewCanvas;

    // 缩放档位。"适应窗口"用一个较小的背板尺寸（悬停高亮要频繁重绘，太大就卡）；
    // 放大档位才把背板提到接近原分辨率，让人能看清小字到底糊不糊。
    const zoom = state.previewZoom;
    const zoomed = zoom !== "fit";
    const backCap = zoomed ? PREVIEW_ZOOM_MAX_SIDE : PREVIEW_MAX_SIDE;

    const k = Math.min(1, backCap / Math.max(src.width, src.height));
    const cw = Math.max(1, Math.round(src.width * k));
    const ch = Math.max(1, Math.round(src.height * k));
    canvas.width = cw;
    canvas.height = ch;

    // 显示尺寸独立于背板尺寸：放大档位把 canvas 拉大，外层容器负责滚动。
    // 这样"预览里糊"和"实际糊"就能区分开 —— 很多"糊成一团"其实是预览被缩小了。
    if (zoomed) {
      canvas.style.width = Math.round(cw * Number(zoom)) + "px";
      canvas.style.maxWidth = "none";
    } else {
      canvas.style.width = "";
      canvas.style.maxWidth = "";
    }

    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(src, 0, 0, cw, ch);

    if (state.highlight && !state.showOriginal) {
      const h = state.highlight;
      ctx.save();
      ctx.strokeStyle = "#e5533d";
      ctx.lineWidth = Math.max(1.5, cw / 700);
      ctx.strokeRect(h.x * k - 1, h.y * k - 1, h.w * k + 2, h.h * k + 2);
      ctx.restore();
    }

    els.viewLabel.textContent = state.showOriginal ? "原稿" : "中文版";
    els.pageIndicator.textContent = state.pageIndex + 1 + " / " + state.pages.length;
    els.btnPrev.disabled = state.pageIndex <= 0;
    els.btnNext.disabled = state.pageIndex >= state.pages.length - 1;
  }

  function renderTextList() {
    const page = state.pages[state.pageIndex];
    els.textList.innerHTML = "";
    if (!page) return;
    const items = page.items || [];
    els.textCount.textContent = items.length + " 条";
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "muted tiny";
      empty.style.padding = "12px";
      empty.textContent = "这一页没有识别到文字。";
      els.textList.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    items.forEach(function (it) {
      const box = document.createElement("div");
      box.className = "text-item";

      const srcP = document.createElement("p");
      srcP.className = "src";
      srcP.textContent = it.src;

      const dstP = document.createElement("p");
      dstP.className = "dst";
      dstP.textContent = it.dst || "（未翻译）";
      if (it.dst && it.dst !== it.src) {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = it.engine || "已译";
        dstP.appendChild(tag);
      }

      box.appendChild(srcP);
      box.appendChild(dstP);

      // 悬停时在预览图上框出对应位置 —— 原实现的列表是死的（有 pointer 光标但没绑事件），
      // 用户没法把译文和图上位置对上，小字识别错了也不容易发现。
      box.addEventListener("mouseenter", function () {
        state.highlight = { x: it.x, y: it.y, w: it.w, h: it.h };
        renderPreview();
      });
      box.addEventListener("mouseleave", function () {
        state.highlight = null;
        renderPreview();
      });

      frag.appendChild(box);
    });
    els.textList.appendChild(frag);
  }

  /* ============================================================
   * 事件绑定
   * ============================================================ */

  function bindUpload() {
    els.dropzone.addEventListener("click", function () {
      els.fileInput.click();
    });
    els.dropzone.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        els.fileInput.click();
      }
    });
    els.fileInput.addEventListener("change", function (e) {
      acceptFiles(e.target.files);
      e.target.value = "";
    });
    ["dragenter", "dragover"].forEach(function (name) {
      els.dropzone.addEventListener(name, function (e) {
        e.preventDefault();
        e.stopPropagation();
        els.dropzone.classList.add("dragover");
      });
    });
    ["dragleave", "drop"].forEach(function (name) {
      els.dropzone.addEventListener(name, function (e) {
        e.preventDefault();
        e.stopPropagation();
        els.dropzone.classList.remove("dragover");
      });
    });
    els.dropzone.addEventListener("drop", function (e) {
      if (e.dataTransfer && e.dataTransfer.files) acceptFiles(e.dataTransfer.files);
    });
  }

  function bindApiBoxes() {
    els.visionProvider.addEventListener("change", function () {
      applyVisionPreset(true);
      savePrefs();
      syncEngineUi();
    });
    els.llmProvider.addEventListener("change", function () {
      applyLlmPreset(true);
      savePrefs();
      syncEngineUi();
    });
    els.btnVisionModels.addEventListener("click", fetchVisionModels);
    els.btnVisionTest.addEventListener("click", testVision);
    els.btnLlmModels.addEventListener("click", fetchLlmModels);
    els.btnLlmTest.addEventListener("click", testLlm);

    [
      els.visionBase,
      els.visionKey,
      els.visionModel,
      els.visionModelCustom,
      els.llmBase,
      els.llmKey,
      els.llmModel,
      els.llmModelCustom,
    ].forEach(function (el) {
      el.addEventListener("input", syncEngineUi);
      el.addEventListener("change", function () {
        savePrefs();
        syncEngineUi();
      });
    });
  }

  function bindOptions() {
    [els.ocrVision, els.ocrLocal].forEach(function (el) {
      el.addEventListener("change", function () {
        savePrefs();
        syncEngineUi();
      });
    });
    els.visionRecognizeOnly.addEventListener("change", function () {
      savePrefs();
      syncEngineUi();
    });
    els.translateEngine.addEventListener("change", function () {
      savePrefs();
      syncEngineUi();
    });
    els.targetLang.addEventListener("change", savePrefs);
    els.cover.addEventListener("change", savePrefs);
    els.eraseMode.addEventListener("change", savePrefs);
    els.fontGrow.addEventListener("change", savePrefs);
    els.preserveCodes.addEventListener("change", savePrefs);
    els.fieldColors.addEventListener("change", savePrefs);

    els.profile.addEventListener("change", function () {
      loadProfileIntoFields(els.profile.value);
      savePrefs();
    });
    els.glossary.addEventListener("input", savePrefs);
    els.profileHint.addEventListener("input", savePrefs);
  }

  function bindResult() {
    els.btnPrev.addEventListener("click", function () {
      if (state.pageIndex > 0) {
        state.pageIndex--;
        state.highlight = null;
        renderPreview();
        renderTextList();
      }
    });
    els.btnNext.addEventListener("click", function () {
      if (state.pageIndex < state.pages.length - 1) {
        state.pageIndex++;
        state.highlight = null;
        renderPreview();
        renderTextList();
      }
    });
    els.btnToggleView.addEventListener("click", function () {
      state.showOriginal = !state.showOriginal;
      renderPreview();
    });
    // 预览缩放：默认"适应窗口"。放大档位是为了分辨
    // "预览里显得糊"和"实际输出糊"，这两件事很容易混。
    els.previewZoom.addEventListener("change", function () {
      state.previewZoom = els.previewZoom.value;
      renderPreview();
    });
    els.btnReset.addEventListener("click", resetAll);
    els.btnErrorReset.addEventListener("click", resetAll);
    els.btnCancel.addEventListener("click", function () {
      if (state.controller) {
        log("正在取消…");
        state.controller.abort(U.abortError("用户取消"));
      }
    });

    els.btnDownload.addEventListener("click", function () {
      try {
        const canvases = state.pages.map(function (p) {
          return p.translated;
        });
        const pageSizes = state.pages.map(function (p) {
          return p.pageSize;
        });
        const pdf = window.PZPdf.canvasesToPdf(canvases, { pageSizes: pageSizes });
        window.PZPdf.download(pdf, state.fileName || "translated-zh.pdf");
      } catch (err) {
        fail("导出失败：" + (err && err.message ? err.message : err));
      }
    });
  }

  function resetAll() {
    if (state.controller) state.controller.abort(U.abortError("用户取消"));
    state.files = [];
    state.pages = [];
    state.pageIndex = 0;
    state.showOriginal = false;
    state.highlight = null;
    els.fileInput.value = "";
    updateFileList();
    showPanel("upload");
  }

  /* ============================================================
   * 启动
   * ============================================================ */

  function init() {
    // 版本与降级提示（构建号让用户一眼看出 F5 之后有没有拿到新版）
    els.versionPill.textContent = "v" + (C.VERSION || "?") + (C.BUILD ? " · " + C.BUILD : "");

    // 引擎
    const savedEngine = restore("ocr_engine", "vision");
    if (savedEngine === "local") els.ocrLocal.checked = true;
    else els.ocrVision.checked = true;
    els.translateEngine.value = restore("translate_engine", "free");
    els.targetLang.value = restore("target_lang", "zh-CN");
    els.cover.checked = restore("cover", "1") === "1";
    els.eraseMode.value = restore("erase_mode", "ink");
    // 中文字号默认「更大」：中文比英文短，框里有余量就放大一点（用户要求）
    els.fontGrow.value = restore("font_grow", String(C.LIMITS.overlayFontGrow));
    els.preserveCodes.checked = restore("preserve", "1") === "1";
    // 字段配色默认关闭：它会改变原文档观感，不该默认生效
    els.fieldColors.checked = restore("field_colors", "0") === "1";
    els.visionRecognizeOnly.checked = restore("vision_recog_only", "0") === "1";

    // 供应商
    fillSelect(els.visionProvider, C.VISION_PRESETS, restore("vision_provider", "gemini"));
    fillSelect(els.llmProvider, C.LLM_PRESETS, restore("llm_provider", "deepseek"));

    applyVisionPreset(false);
    els.visionBase.value = restore("vision_base", els.visionBase.value);
    els.visionKey.value = restore("vision_key", "");
    const vModel = restore("vision_model", "");
    if (vModel) fillModels(els.visionModel, [vModel], vModel);
    els.visionModelCustom.value = restore("vision_model_custom", "");

    applyLlmPreset(false);
    els.llmBase.value = restore("llm_base", els.llmBase.value);
    els.llmKey.value = restore("llm_key", "");
    const lModel = restore("llm_model", "");
    if (lModel) fillModels(els.llmModel, [lModel], lModel);
    els.llmModelCustom.value = restore("llm_model_custom", "");

    // 领域
    fillProfileSelect();
    const prof = restore("profile", "general");
    els.profile.value = C.PROFILES[prof] ? prof : "general";
    loadProfileIntoFields(els.profile.value);
    const savedGlossary = restore("glossary_" + els.profile.value, null);
    if (savedGlossary != null) els.glossary.value = savedGlossary;
    const savedHint = restore("hint_" + els.profile.value, null);
    if (savedHint != null) els.profileHint.value = savedHint;

    bindUpload();
    bindApiBoxes();
    bindOptions();
    bindResult();

    els.btnStart.addEventListener("click", handleStart);

    updateFileList();
    syncEngineUi();
    showPanel("upload");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();