(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);

  const els = {
    dropzone: $("#dropzone"),
    fileInput: $("#file-input"),
    fileList: $("#file-list"),
    modeNormal: $("#mode-normal"),
    modeComplex: $("#mode-complex"),
    modePill: $("#mode-pill"),
    modeHint: $("#mode-hint"),
    normalOptions: $("#normal-options"),
    complexOptions: $("#complex-options"),
    optLang: $("#opt-lang"),
    optLangC: $("#opt-lang-c"),
    optService: $("#opt-service"),
    optImageMode: $("#opt-image-mode"),
    optCover: $("#opt-cover"),
    optCoverC: $("#opt-cover-c"),
    optPreserve: $("#opt-preserve-codes"),
    optPreserveC: $("#opt-preserve-codes-c"),
    optProvider: $("#opt-provider"),
    optBaseUrl: $("#opt-base-url"),
    optApiKey: $("#opt-api-key"),
    optModel: $("#opt-model"),
    optModelCustom: $("#opt-model-custom"),
    btnFetchModels: $("#btn-fetch-models"),
    btnTestApi: $("#btn-test-api"),
    apiTestResult: $("#api-test-result"),
    apiStatusBadge: $("#api-status-badge"),
    apiNote: $("#api-note"),
    linkKey: $("#link-key"),
    panelUpload: $("#panel-upload"),
    panelProcess: $("#panel-process"),
    panelResult: $("#panel-result"),
    panelError: $("#panel-error"),
    processFile: $("#process-file"),
    progressBar: $("#progress-bar"),
    steps: $("#steps"),
    processLog: $("#process-log"),
    resultMeta: $("#result-meta"),
    previewCanvas: $("#preview-canvas"),
    viewLabel: $("#view-label"),
    pageIndicator: $("#page-indicator"),
    btnPrev: $("#btn-prev"),
    btnNext: $("#btn-next"),
    btnDownload: $("#btn-download"),
    btnToggle: $("#btn-toggle-view"),
    btnReset: $("#btn-reset"),
    btnErrorReset: $("#btn-error-reset"),
    errorMessage: $("#error-message"),
    textList: $("#text-list"),
    textCount: $("#text-count"),
  };

  const IMAGE_RE = /\.(png|jpe?g|webp|bmp|gif)$/i;
  const PDF_RE = /\.pdf$/i;

  const PROVIDER_PRESETS = {
    deepseek: {
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
      label: "DeepSeek",
      keyUrl: "https://platform.deepseek.com/api_keys",
      note: "DeepSeek：优化英文→中文译文（图片识别仍用本地切块 OCR）。",
    },
    openai: {
      baseUrl: "https://api.openai.com",
      model: "gpt-4o-mini",
      label: "OpenAI 兼容",
      keyUrl: "https://platform.openai.com/api-keys",
      note: "自定义 OpenAI 兼容：填任意兼容 /v1/chat/completions 的地址。",
    },
    gemini: {
      baseUrl: "https://generativelanguage.googleapis.com",
      model: "gemini-2.0-flash",
      label: "Gemini",
      keyUrl: "https://aistudio.google.com/apikey",
      note: "Gemini：直接看图识别文字并翻译，适合彩标 / 艺术字。",
    },
  };

  const state = {
    files: [],
    pages: [],
    pageIndex: 0,
    showOriginal: false,
    fileName: "translated-zh.pdf",
  };

  function runMode() {
    return els.modeComplex && els.modeComplex.checked ? "complex" : "normal";
  }

  function showPanel(name) {
    els.panelUpload.classList.toggle("hidden", name !== "upload");
    els.panelProcess.classList.toggle("hidden", name !== "process");
    els.panelResult.classList.toggle("hidden", name !== "result");
    els.panelError.classList.toggle("hidden", name !== "error");
  }

  function setProgress(pct, log) {
    els.progressBar.style.width = Math.max(0, Math.min(100, pct)) + "%";
    if (log) els.processLog.textContent = log;
  }

  function setStep(step) {
    const order = ["load", "extract", "translate", "compose", "done"];
    const idx = order.indexOf(step);
    els.steps.querySelectorAll("li").forEach(function (li, i) {
      li.classList.remove("active", "done");
      if (i < idx) li.classList.add("done");
      if (i === idx) li.classList.add("active");
      if (step === "done" && i <= idx) li.classList.add("done");
    });
  }

  function fail(message) {
    els.errorMessage.textContent = message || "处理失败。";
    showPanel("error");
  }

  function resetAll() {
    state.files = [];
    state.pages = [];
    state.pageIndex = 0;
    state.showOriginal = false;
    els.fileInput.value = "";
    updateFileList();
    showPanel("upload");
  }

  function classifyFiles(fileList) {
    const files = Array.from(fileList || []);
    const images = [];
    const pdfs = [];
    files.forEach(function (f) {
      if (PDF_RE.test(f.name) || f.type === "application/pdf") pdfs.push(f);
      else if (IMAGE_RE.test(f.name) || (f.type || "").startsWith("image/")) images.push(f);
    });
    return { images: images, pdfs: pdfs };
  }

  function updateFileList() {
    const files = state.files;
    if (!files.length) {
      els.fileList.classList.add("hidden");
      els.fileList.textContent = "";
      return;
    }
    els.fileList.classList.remove("hidden");
    els.fileList.textContent =
      "已选 " + files.length + " 个：" + files.map(function (f, i) {
        return i + 1 + ". " + f.name;
      }).join("　");
  }

  function acceptFiles(fileList) {
    const { images, pdfs } = classifyFiles(fileList);
    if (!images.length && !pdfs.length) {
      fail("请选择 PDF 或 JPG / PNG / WebP 图片。");
      return;
    }
    if (pdfs.length > 1) {
      fail("一次只能处理 1 个 PDF。图片可多选。");
      return;
    }
    state.files = pdfs.concat(images);
    updateFileList();
    handleFiles(state.files);
  }

  /* ---------- Mode / provider UI ---------- */

  function applyProviderPreset(provider, force) {
    const p = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.deepseek;
    if (force || !els.optBaseUrl.value.trim()) {
      els.optBaseUrl.value = p.baseUrl;
    }
    if (force || !els.optModelCustom.value.trim()) {
      if (force) {
        els.optModel.innerHTML =
          '<option value="' + p.model + '">' + p.model + "（默认）</option>";
        els.optModel.value = p.model;
        els.optModelCustom.value = "";
      }
    }
    if (els.linkKey) els.linkKey.href = p.keyUrl;
    if (els.apiNote) {
      els.apiNote.innerHTML =
        p.note +
        "<br />填好 Base URL + Key 后点「拉取模型列表」，再从下拉框选择模型。未配置成功不会静默改用免费接口。";
    }
  }

  function selectedModel() {
    const custom = (els.optModelCustom.value || "").trim();
    if (custom) return custom;
    return (els.optModel.value || "").trim();
  }

  function apiConfig() {
    const provider = els.optProvider.value || "deepseek";
    const preset = PROVIDER_PRESETS[provider];
    let baseUrl = (els.optBaseUrl.value || "").trim();
    if (!baseUrl && preset) baseUrl = preset.baseUrl;
    return {
      provider: provider,
      baseUrl: baseUrl,
      apiKey: (els.optApiKey.value || "").trim(),
      model: selectedModel(),
      label: preset ? preset.label : provider,
    };
  }

  function updateModeUi() {
    const complex = runMode() === "complex";
    els.normalOptions.classList.toggle("hidden", complex);
    els.complexOptions.classList.toggle("hidden", !complex);
    els.modePill.textContent = complex ? "复杂模式 · 调用 API" : "普通模式 · 不调 API";
    els.modePill.classList.toggle("warn", complex);
    if (els.modeHint) {
      els.modeHint.textContent = complex
        ? "复杂模式：本地切块放大识别；DeepSeek/OpenAI 负责译文，或选 Gemini 直接看图。必须配置并测试通过。"
        : "普通模式：本地 OCR + 免费 Google/MyMemory 翻译，不调用任何大模型 API。";
    }
    updateApiBadge();
  }

  function updateApiBadge() {
    if (!els.apiStatusBadge) return;
    if (runMode() !== "complex") {
      els.apiStatusBadge.textContent = "不调用 API";
      els.apiStatusBadge.classList.remove("on", "warn");
      return;
    }
    const cfg = apiConfig();
    els.apiStatusBadge.classList.remove("on", "warn");
    if (!cfg.apiKey) {
      els.apiStatusBadge.textContent = "未填 Key";
      els.apiStatusBadge.classList.add("warn");
    } else if (!cfg.model) {
      els.apiStatusBadge.textContent = "未选模型";
      els.apiStatusBadge.classList.add("warn");
    } else {
      els.apiStatusBadge.textContent =
        cfg.label + " · " + cfg.model;
      els.apiStatusBadge.classList.add("on");
    }
  }

  async function fetchModels() {
    const cfg = apiConfig();
    const out = els.apiTestResult;
    out.classList.remove("ok", "err");
    if (!cfg.apiKey) {
      out.textContent = "请先填写 API Key，再拉取模型列表。";
      out.classList.add("err");
      return;
    }
    out.textContent = "正在从 " + cfg.baseUrl + " 拉取模型列表…";
    els.btnFetchModels.disabled = true;
    try {
      let ids;
      if (cfg.provider === "gemini") {
        ids = await PdfTranslator.fetchGeminiModels(cfg.apiKey);
      } else {
        ids = await PdfTranslator.fetchOpenAIModels({
          llmProvider: cfg.provider,
          llmBaseUrl: cfg.baseUrl,
          llmApiKey: cfg.apiKey,
          llmModel: cfg.model || "x",
        });
      }
      const prev = selectedModel();
      els.optModel.innerHTML = "";
      ids.forEach(function (id) {
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = id;
        els.optModel.appendChild(opt);
      });
      if (prev && ids.indexOf(prev) >= 0) els.optModel.value = prev;
      else if (ids.length) els.optModel.value = ids[0];
      els.optModelCustom.value = "";
      out.textContent =
        "已拉取 " + ids.length + " 个模型。当前选择：" + els.optModel.value;
      out.classList.add("ok");
    } catch (err) {
      out.textContent =
        "拉取失败：" + (err && err.message ? err.message : err);
      out.classList.add("err");
    } finally {
      els.btnFetchModels.disabled = false;
      updateApiBadge();
    }
  }

  async function testApi() {
    const cfg = apiConfig();
    const out = els.apiTestResult;
    out.classList.remove("ok", "err");
    if (!cfg.apiKey) {
      out.textContent = "请先填写 API Key。";
      out.classList.add("err");
      return;
    }
    if (!cfg.model) {
      out.textContent = "请先拉取模型列表并选择模型，或手动输入模型名。";
      out.classList.add("err");
      return;
    }
    out.textContent = "正在测试 " + cfg.label + " · " + cfg.model + "…";
    els.btnTestApi.disabled = true;
    try {
      if (cfg.provider === "gemini") {
        await ImageEngine.testGeminiKey(cfg.apiKey);
        out.textContent =
          "Gemini Key 有效，已成功调用。模型：" + cfg.model;
      } else {
        const r = await PdfTranslator.testOpenAICompatKey({
          llmProvider: cfg.provider,
          llmBaseUrl: cfg.baseUrl,
          llmApiKey: cfg.apiKey,
          llmModel: cfg.model,
        });
        out.textContent =
          r.label +
          " 连接成功。模型：" +
          r.model +
          " · 端点：" +
          r.endpoint;
      }
      out.classList.add("ok");
    } catch (err) {
      out.textContent =
        "连接失败：" + (err && err.message ? err.message : err);
      out.classList.add("err");
    } finally {
      els.btnTestApi.disabled = false;
      updateApiBadge();
    }
  }

  function requireComplexApi() {
    const cfg = apiConfig();
    if (!cfg.apiKey) {
      fail(
        "已选择「复杂模式」，但未填写 API Key。\n" +
          "请在接口设置中填入 Key，或改回「普通模式」（不调 API）。"
      );
      return null;
    }
    if (cfg.apiKey.length < 10) {
      fail("API Key 看起来不正确（太短）。请检查后重试。");
      return null;
    }
    if (!cfg.model) {
      fail(
        "已选择「复杂模式」，但未选择模型。\n" +
          "请点「拉取模型列表」后选择，或在输入框手动填写模型名。"
      );
      return null;
    }
    if ((cfg.provider === "deepseek" || cfg.provider === "openai") && !cfg.baseUrl) {
      fail("请填写 Base URL。");
      return null;
    }
    return cfg;
  }

  function buildOptions() {
    const complex = runMode() === "complex";
    if (complex) {
      const cfg = apiConfig();
      const target = els.optLangC.value;
      if (cfg.provider === "gemini") {
        return {
          target: target,
          service: "glossary",
          preserveCodes: els.optPreserveC.checked,
          llmProvider: "deepseek",
          llmApiKey: "",
          runMode: "complex",
          vision: "gemini",
          geminiModel: cfg.model,
          geminiKey: cfg.apiKey,
          providerLabel: "Gemini",
        };
      }
      return {
        target: target,
        service: cfg.provider === "openai" ? "openai" : "deepseek",
        preserveCodes: els.optPreserveC.checked,
        llmProvider: cfg.provider,
        llmBaseUrl: cfg.baseUrl,
        llmModel: cfg.model,
        llmApiKey: cfg.apiKey,
        runMode: "complex",
        vision: "local-tiled",
        providerLabel: cfg.label,
      };
    }
    return {
      target: els.optLang.value,
      service: els.optService.value,
      preserveCodes: els.optPreserve.checked,
      runMode: "normal",
      vision: els.optImageMode.value === "tiled" ? "local-tiled" : "local-ocr",
      providerLabel: "免费接口",
    };
  }

  function engineLabel(code) {
    const map = {
      "local-ocr": "本地 OCR",
      "local-tiled": "本地切块 OCR",
      "gemini-whole": "Gemini 整图 API",
      "gemini-tiled": "Gemini 切块 API",
      pdf: "PDF 文字层",
      deepseek: "DeepSeek 译文",
      openai: "OpenAI 兼容译文",
      google: "Google 翻译",
      mymemory: "MyMemory",
      glossary: "本地词表",
    };
    return map[code] || code || "未知";
  }

  /* ---------- Preview ---------- */

  function renderPreview() {
    if (!state.pages.length) return;
    const page = state.pages[state.pageIndex];
    const src = state.showOriginal ? page.original : page.translated;
    const canvas = els.previewCanvas;
    const ctx = canvas.getContext("2d");
    canvas.width = src.width;
    canvas.height = src.height;
    ctx.drawImage(src, 0, 0);
    els.viewLabel.textContent = state.showOriginal ? "原稿" : "中文版";
    els.pageIndicator.textContent =
      state.pageIndex + 1 + " / " + state.pages.length;
    els.btnPrev.disabled = state.pageIndex <= 0;
    els.btnNext.disabled = state.pageIndex >= state.pages.length - 1;
  }

  function renderTextList(page) {
    els.textList.innerHTML = "";
    const lines = page.lines || [];
    els.textCount.textContent = lines.length + " 条";
    const frag = document.createDocumentFragment();
    lines.forEach(function (line) {
      const dst = page.map[line.text] != null ? page.map[line.text] : line.text;
      const item = document.createElement("div");
      item.className = "text-item";
      const srcP = document.createElement("p");
      srcP.className = "src";
      srcP.textContent = line.text;
      const dstP = document.createElement("p");
      dstP.className = "dst";
      dstP.textContent = dst;
      if (dst !== line.text) {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = "已译";
        dstP.appendChild(tag);
      }
      item.appendChild(srcP);
      item.appendChild(dstP);
      frag.appendChild(item);
    });
    els.textList.appendChild(frag);
  }

  /* ---------- Process ---------- */

  async function processPdfFile(file, options, cover) {
    const buffer = await file.arrayBuffer();
    const pdfDoc = await PdfEngine.loadDocument(buffer);
    const numPages = pdfDoc.numPages;
    const extracts = [];
    for (let i = 1; i <= numPages; i++) {
      const page = await pdfDoc.getPage(i);
      extracts.push(await PdfEngine.extractPage(page, 1));
    }
    const allTexts = [];
    extracts.forEach(function (ex) {
      ex.lines.forEach(function (line) {
        allTexts.push(line.text);
      });
    });
    if (!allTexts.length) {
      return { pages: [], empty: true };
    }
    const translated = await PdfTranslator.translateMany(allTexts, options);
    let cursor = 0;
    const pages = [];
    for (let i = 0; i < extracts.length; i++) {
      const ex = extracts[i];
      const map = {};
      const pairs = [];
      for (let j = 0; j < ex.lines.length; j++) {
        const t = translated[cursor++];
        map[ex.lines[j].text] = t.dst;
        pairs.push({ src: ex.lines[j].text, dst: t.dst, service: t.service });
      }
      const original = await PdfEngine.renderPageOriginal(ex.page, 3);
      const translatedCanvas = await PdfEngine.renderPageComposed(ex.page, {
        scale: 3,
        cover: cover,
        lines: ex.lines,
        map: map,
      });
      pages.push({
        original: original,
        translated: translatedCanvas,
        lines: ex.lines,
        map: map,
        pairs: pairs,
        label: file.name + " · 第 " + (i + 1) + " 页",
        engine: "pdf",
      });
    }
    return { pages: pages, empty: false, engine: "pdf" };
  }

  async function processImageFile(file, options, cover, onProgress) {
    const loaded = await ImageEngine.loadFileToCanvas(file, 2800);
    const original = document.createElement("canvas");
    original.width = loaded.canvas.width;
    original.height = loaded.canvas.height;
    original.getContext("2d").drawImage(loaded.canvas, 0, 0);

    let lines = null;
    let pretranslated = false;
    let engine = "local-ocr";

    if (options.vision === "gemini") {
      if (onProgress)
        onProgress({ status: "calling_gemini_api", progress: 0.15 });
      // Use whole or tiled based on image size
      const longSide = Math.max(original.width, original.height);
      if (longSide >= 1400) {
        lines = await ImageEngine.geminiExtractLinesTiled(
          original,
          options.target || "zh-CN",
          options.geminiKey,
          onProgress
        );
        engine = "gemini-tiled";
      } else {
        lines = await ImageEngine.geminiExtractLines(
          original,
          options.target || "zh-CN",
          options.geminiKey
        );
        engine = "gemini-whole";
      }
      pretranslated = true;
    } else if (options.vision === "local-tiled") {
      if (onProgress)
        onProgress({ status: "local_tiled_ocr", progress: 0.1 });
      const ocr = await ImageEngine.ocrCanvasComplex(loaded.canvas, onProgress, {
        zoom: 2,
      });
      lines = ocr.lines || [];
      engine = "local-tiled";
    } else {
      const ocr = await ImageEngine.ocrCanvas(loaded.canvas, onProgress);
      lines = ocr.lines || [];
      engine = "local-ocr";
    }

    if (!lines || !lines.length) {
      return {
        page: {
          original: original,
          translated: original,
          lines: [],
          map: {},
          pairs: [],
          label: file.name,
          engine: engine,
        },
        empty: true,
        texts: [],
        engine: engine,
      };
    }

    const texts = lines.map(function (l) {
      return l.text;
    });
    const map = {};
    const pairs = [];

    if (pretranslated) {
      for (let i = 0; i < lines.length; i++) {
        const dst = lines[i].translation || lines[i].text;
        map[lines[i].text] = dst;
        pairs.push({ src: lines[i].text, dst: dst, service: "gemini" });
      }
    } else {
      const translated = await PdfTranslator.translateMany(texts, options);
      for (let i = 0; i < lines.length; i++) {
        let dst = translated[i].dst;
        if (window.ImageEngine && ImageEngine.applyLocalGlossary) {
          const glossed = ImageEngine.applyLocalGlossary(lines[i].text);
          if (glossed !== lines[i].text) {
            const leftover = (glossed.match(/[A-Za-z]{3,}/g) || []).filter(
              function (w) {
                return !/^(please|use|sku|inch|color|and|for|the|with|from|under|years)$/i.test(
                  w
                );
              }
            );
            if (leftover.length === 0) dst = glossed;
          }
        }
        map[lines[i].text] = dst;
        pairs.push({
          src: lines[i].text,
          dst: dst,
          service: translated[i].service,
        });
      }
    }

    const outCanvas = ImageEngine.overlayLines(original, lines, map, {
      cover: cover,
    });
    return {
      page: {
        original: original,
        translated: outCanvas,
        lines: lines,
        map: map,
        pairs: pairs,
        label: file.name,
        engine: engine,
      },
      empty: false,
      texts: texts,
      engine: engine,
    };
  }

  function buildOutputName(files) {
    if (files.length === 1) {
      return files[0].name.replace(/\.[^.]+$/, "") + "-中文版.pdf";
    }
    return "翻译-" + files.length + "文件-中文版.pdf";
  }

  async function handleFiles(files) {
    if (!files || !files.length) return;

    const complex = runMode() === "complex";
    let apiCfg = null;
    if (complex) {
      apiCfg = requireComplexApi();
      if (!apiCfg) return;
    }

    const options = buildOptions();
    const cover = complex ? els.optCoverC.checked : els.optCover.checked;

    showPanel("process");
    setStep("load");
    setProgress(4, "准备处理 " + files.length + " 个文件…");
    els.processFile.textContent = files
      .map(function (f) {
        return f.name;
      })
      .join("、");

    state.pages = [];
    let totalTexts = 0;
    let emptyCount = 0;
    const enginesUsed = [];

    try {
      setStep("extract");
      const pdfs = files.filter(function (f) {
        return PDF_RE.test(f.name) || f.type === "application/pdf";
      });
      const images = files.filter(function (f) {
        return IMAGE_RE.test(f.name) || (f.type || "").startsWith("image/");
      });

      for (let i = 0; i < pdfs.length; i++) {
        setProgress(
          8 + (i / Math.max(1, pdfs.length)) * 20,
          "解析 PDF " + pdfs[i].name + "…"
        );
        const res = await processPdfFile(pdfs[i], options, cover);
        if (res.empty) emptyCount++;
        else {
          state.pages = state.pages.concat(res.pages);
          res.pages.forEach(function (p) {
            totalTexts += (p.lines || []).length;
            enginesUsed.push("pdf");
          });
        }
      }

      for (let i = 0; i < images.length; i++) {
        const file = images[i];
        const base = 28 + (i / Math.max(1, images.length)) * 45;
        setProgress(
          base,
          "识别 " +
            file.name +
            "（" +
            (options.vision === "gemini"
              ? "Gemini 视觉"
              : options.vision === "local-tiled"
                ? "本地切块"
                : "本地 OCR") +
            "）…"
        );
        const res = await processImageFile(
          file,
          options,
          cover,
          function (m) {
            if (!m || !m.status) return;
            const p = typeof m.progress === "number" ? m.progress : 0;
            const label = m.status.replace(/_/g, " ");
            setProgress(
              base + p * 8,
              file.name + "：" + label + " " + Math.round(p * 100) + "%"
            );
          }
        );
        state.pages.push(res.page);
        if (res.empty) emptyCount++;
        else {
          totalTexts += res.texts.length;
          enginesUsed.push(res.engine);
        }
        setProgress(
          28 + ((i + 1) / Math.max(1, images.length)) * 45,
          "已处理 " + (i + 1) + " / " + images.length + " 张图片"
        );
      }

      setStep("translate");
      setProgress(80, "整理结果…");
      setStep("compose");
      setProgress(92, "生成预览…");

      if (!state.pages.length) {
        fail(
          emptyCount
            ? "未能识别出文字。请用更清晰的图片，或改用复杂模式 / Gemini。"
            : "没有可处理的页面。"
        );
        return;
      }

      setStep("done");
      setProgress(100, "完成。");

      const uniq = [];
      enginesUsed.forEach(function (e) {
        const lab = engineLabel(e);
        if (uniq.indexOf(lab) < 0) uniq.push(lab);
      });
      let translateLab = "";
      if (complex) {
        if (options.vision === "gemini") translateLab = "Gemini 看图翻译";
        else if (options.service === "deepseek")
          translateLab = "DeepSeek 译文";
        else if (options.service === "openai")
          translateLab = "OpenAI 兼容译文";
        translateLab = options.providerLabel || translateLab;
      } else {
        translateLab =
          options.service === "auto"
            ? "免费自动翻译"
            : options.service === "google"
              ? "Google 翻译"
              : options.service === "mymemory"
                ? "MyMemory"
                : "本地词表";
      }

      els.resultMeta.textContent =
        (complex ? "复杂模式" : "普通模式") +
        " · " +
        files.length +
        " 文件 · " +
        state.pages.length +
        " 页 · " +
        totalTexts +
        " 条 · 识别：" +
        uniq.join(" + ") +
        " · 译文：" +
        translateLab;

      state.pageIndex = 0;
      state.showOriginal = false;
      state.fileName = buildOutputName(files);
      showPanel("result");
      renderPreview();
      renderTextList(state.pages[0]);
    } catch (err) {
      console.error(err);
      const msg = err && err.message ? err.message : String(err);
      if (/API|Gemini|DeepSeek|OpenAI|HTTP 4|HTTP 5|Key/i.test(msg)) {
        fail(
          "调用失败，已停止（不会悄悄改用免费接口）。\n" +
            msg +
            "\n\n请检查 Base URL / Key / 模型，或改回普通模式。"
        );
        return;
      }
      fail("处理出错：" + msg);
    }
  }

  /* ---------- Events ---------- */

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

  els.modeNormal.addEventListener("change", updateModeUi);
  els.modeComplex.addEventListener("change", updateModeUi);

  els.optProvider.addEventListener("change", function () {
    applyProviderPreset(els.optProvider.value, true);
    try {
      localStorage.setItem("pdfzh_provider", els.optProvider.value);
    } catch (e) { /* ignore */ }
    updateApiBadge();
  });

  els.btnFetchModels.addEventListener("click", fetchModels);
  els.btnTestApi.addEventListener("click", testApi);

  ["optBaseUrl", "optApiKey", "optModel", "optModelCustom"].forEach(function (k) {
    els[k].addEventListener("change", function () {
      try {
        localStorage.setItem("pdfzh_base", els.optBaseUrl.value);
        localStorage.setItem("pdfzh_key", els.optApiKey.value);
        localStorage.setItem("pdfzh_model", els.optModel.value);
        localStorage.setItem("pdfzh_model_custom", els.optModelCustom.value);
      } catch (e) { /* ignore */ }
      updateApiBadge();
    });
    els[k].addEventListener("input", updateApiBadge);
  });

  els.btnPrev.addEventListener("click", function () {
    if (state.pageIndex > 0) {
      state.pageIndex -= 1;
      renderPreview();
      renderTextList(state.pages[state.pageIndex]);
    }
  });
  els.btnNext.addEventListener("click", function () {
    if (state.pageIndex < state.pages.length - 1) {
      state.pageIndex += 1;
      renderPreview();
      renderTextList(state.pages[state.pageIndex]);
    }
  });
  els.btnToggle.addEventListener("click", function () {
    state.showOriginal = !state.showOriginal;
    renderPreview();
  });
  els.btnReset.addEventListener("click", resetAll);
  els.btnErrorReset.addEventListener("click", resetAll);
  els.btnDownload.addEventListener("click", function () {
    try {
      const canvases = state.pages.map(function (p) {
        return p.translated;
      });
      const pdf = PdfEngine.canvasesToPdf(canvases);
      PdfEngine.downloadPdf(pdf, state.fileName || "translated-zh.pdf");
    } catch (err) {
      alert("导出失败：" + (err && err.message ? err.message : err));
    }
  });

  // Restore prefs
  try {
    const provider = localStorage.getItem("pdfzh_provider") || "deepseek";
    els.optProvider.value = provider;
    applyProviderPreset(provider, false);
    els.optBaseUrl.value = localStorage.getItem("pdfzh_base") || els.optBaseUrl.value;
    els.optApiKey.value = localStorage.getItem("pdfzh_key") || "";
    const savedModel = localStorage.getItem("pdfzh_model");
    if (savedModel) {
      els.optModel.innerHTML =
        '<option value="' + savedModel + '">' + savedModel + "</option>";
      els.optModel.value = savedModel;
    }
    els.optModelCustom.value = localStorage.getItem("pdfzh_model_custom") || "";
  } catch (e) { /* ignore */ }

  applyProviderPreset(els.optProvider.value || "deepseek", !els.optBaseUrl.value);
  updateModeUi();
  showPanel("upload");
})();
