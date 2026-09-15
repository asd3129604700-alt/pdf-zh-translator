(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);

  const els = {
    dropzone: $("#dropzone"),
    fileInput: $("#file-input"),
    fileList: $("#file-list"),
    optLang: $("#opt-lang"),
    optService: $("#opt-service"),
    optCover: $("#opt-cover"),
    optPreserve: $("#opt-preserve-codes"),
    optImageMode: $("#opt-image-mode"),
    optGeminiKey: $("#opt-gemini-key"),
    panelUpload: $("#panel-upload"),
    panelProcess: $("#panel-process"),
    panelResult: $("#panel-result"),
    panelError: $("#panel-error"),
    processTitle: $("#process-title"),
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

  const state = {
    files: [],
    pages: [],
    pageIndex: 0,
    showOriginal: false,
    fileName: "translated-zh.pdf",
  };

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
    els.steps.querySelectorAll("li").forEach((li, i) => {
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
    const other = [];
    files.forEach((f) => {
      const name = f.name || "";
      if (PDF_RE.test(name) || f.type === "application/pdf") pdfs.push(f);
      else if (IMAGE_RE.test(name) || (f.type || "").startsWith("image/")) images.push(f);
      else other.push(f);
    });
    return { images: images, pdfs: pdfs, other: other };
  }

  function updateFileList() {
    const files = state.files;
    if (!files.length) {
      els.fileList.classList.add("hidden");
      els.fileList.textContent = "";
      return;
    }
    const names = files.map((f, i) => i + 1 + ". " + f.name).join("　");
    els.fileList.classList.remove("hidden");
    els.fileList.textContent =
      "已选 " + files.length + " 个文件：" + names;
  }

  function acceptFiles(fileList) {
    const { images, pdfs, other } = classifyFiles(fileList);
    if (other.length && !images.length && !pdfs.length) {
      fail("仅支持 PDF 或 JPG / PNG / WebP 等图片。");
      return;
    }
    if (pdfs.length > 1) {
      fail("一次只能处理 1 个 PDF。图片可以多选；若同时选了 PDF 与图片，将先处理 PDF 再处理图片。");
      return;
    }
    const merged = pdfs.concat(images);
    if (!merged.length) return;
    state.files = merged;
    updateFileList();
    // Auto-start when files are chosen
    handleFiles(state.files);
  }

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
    lines.forEach((line, i) => {
      const dst = page.map[line.text] != null ? page.map[line.text] : line.text;
      const item = document.createElement("div");
      item.className = "text-item";
      item.dataset.index = String(i);
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
      item.addEventListener("click", function () {
        els.textList.querySelectorAll(".text-item").forEach(function (el) {
          el.classList.remove("active");
        });
        item.classList.add("active");
      });
      frag.appendChild(item);
    });
    els.textList.appendChild(frag);
  }

  async function processPdfFile(file, options, cover) {
    const buffer = await file.arrayBuffer();
    const pdfDoc = await PdfEngine.loadDocument(buffer);
    const numPages = pdfDoc.numPages;
    const extracts = [];
    for (let i = 1; i <= numPages; i++) {
      const page = await pdfDoc.getPage(i);
      const extracted = await PdfEngine.extractPage(page, 1);
      extracts.push(extracted);
    }
    const allTexts = [];
    extracts.forEach(function (ex) {
      ex.lines.forEach(function (line) {
        allTexts.push(line.text);
      });
    });
    if (!allTexts.length) {
      return {
        pages: [],
        empty: true,
        label: file.name,
      };
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
        pairs.push({
          src: ex.lines[j].text,
          dst: t.dst,
          service: t.service,
        });
      }
      const original = await PdfEngine.renderPageOriginal(ex.page, 2);
      const translatedCanvas = await PdfEngine.renderPageComposed(ex.page, {
        scale: 2,
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
      });
    }
    return { pages: pages, empty: false, label: file.name };
  }

  async function processImageFile(file, options, cover, onOcrProgress, onTranslateProgress) {
    const loaded = await ImageEngine.loadFileToCanvas(file, 2200);
    const original = document.createElement("canvas");
    original.width = loaded.canvas.width;
    original.height = loaded.canvas.height;
    original.getContext("2d").drawImage(loaded.canvas, 0, 0);

    let lines = null;
    let pretranslated = false;

    const imageMode = (els.optImageMode && els.optImageMode.value) || "ocr";
    const geminiKey =
      (els.optGeminiKey && els.optGeminiKey.value || "").trim();

    if (imageMode === "gemini" && geminiKey) {
      if (onOcrProgress) onOcrProgress({ status: "gemini_vision", progress: 0.2 });
      try {
        lines = await ImageEngine.geminiExtractLines(
          original,
          options.target || "zh-CN",
          geminiKey
        );
        pretranslated = true;
      } catch (err) {
        console.warn("Gemini failed, falling back to OCR:", err);
        if (onOcrProgress)
          onOcrProgress({ status: "gemini_failed_use_ocr", progress: 0.3 });
        lines = null;
        pretranslated = false;
      }
    }

    if (!lines || !lines.length) {
      const ocr = await ImageEngine.ocrCanvas(loaded.canvas, onOcrProgress);
      lines = ocr.lines || [];
      pretranslated = false;
    }

    if (!lines.length) {
      return {
        page: {
          original: original,
          translated: original,
          lines: [],
          map: {},
          pairs: [],
          label: file.name,
        },
        empty: true,
        texts: [],
      };
    }

    const texts = lines.map(function (l) {
      return l.text;
    });
    const map = {};
    const pairs = [];

    if (pretranslated) {
      // Gemini already returned translations
      for (let i = 0; i < lines.length; i++) {
        const dst = lines[i].translation || lines[i].text;
        map[lines[i].text] = dst;
        pairs.push({
          src: lines[i].text,
          dst: dst,
          service: "gemini",
        });
      }
    } else {
      const translated = await PdfTranslator.translateMany(
        texts,
        options,
        onTranslateProgress
      );
      for (let i = 0; i < lines.length; i++) {
        let dst = translated[i].dst;
        if (window.ImageEngine && ImageEngine.applyLocalGlossary) {
          const glossed = ImageEngine.applyLocalGlossary(lines[i].text);
          // Only trust glossary when it fully covers the phrase (little English left)
          if (glossed !== lines[i].text) {
            const leftover = (glossed.match(/[A-Za-z]{3,}/g) || []).filter(function (w) {
              return !/^(please|use|sku|inch|color|and|for|the|with|from|under|years)$/i.test(w);
            });
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
      },
      empty: false,
      texts: texts,
    };
  }

  async function handleFiles(files) {
    if (!files || !files.length) return;

    showPanel("process");
    setStep("load");
    setProgress(4, "准备处理 " + files.length + " 个文件…");
    els.processFile.textContent = files.map(function (f) {
      return f.name;
    }).join("、");

    const options = {
      target: els.optLang.value,
      service: els.optService.value,
      preserveCodes: els.optPreserve.checked,
    };
    const cover = els.optCover.checked;

    state.pages = [];
    let totalTexts = 0;
    let emptyCount = 0;

    try {
      setStep("extract");
      const pdfs = files.filter(function (f) {
        return PDF_RE.test(f.name) || f.type === "application/pdf";
      });
      const images = files.filter(function (f) {
        return IMAGE_RE.test(f.name) || (f.type || "").startsWith("image/");
      });

      // PDF first
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
          });
        }
      }

      // Images with OCR
      for (let i = 0; i < images.length; i++) {
        const file = images[i];
        const base = 28 + (i / Math.max(1, images.length)) * 40;
        setProgress(base, "OCR 识别 " + file.name + "（第 " + (i + 1) + "/" + images.length + " 张）…");
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
              "OCR " + file.name + "：" + label + " " + Math.round(p * 100) + "%"
            );
          },
          function (done, total) {
            setStep("translate");
            setProgress(
              base + 10 + (done / Math.max(1, total)) * 10,
              "翻译 " + file.name + "：" + done + " / " + total + " 条"
            );
          }
        );
        state.pages.push(res.page);
        if (res.empty) emptyCount++;
        else totalTexts += res.texts.length;

        // Translate progress is inside processImageFile via translateMany (no callback wired here for simplicity)
        setProgress(
          28 + ((i + 1) / Math.max(1, images.length)) * 40,
          "已处理 " + (i + 1) + " / " + images.length + " 张图片"
        );
      }

      setStep("translate");
      setProgress(75, "翻译已完成，正在整理结果…");

      setStep("compose");
      setProgress(90, "生成预览…");

      if (!state.pages.length) {
        fail(
          emptyCount
            ? "未能从所选文件中识别出文字。图片请尽量使用清晰、对比度高的英文截图。"
            : "没有可处理的页面。"
        );
        return;
      }

      setStep("done");
      setProgress(100, "完成。共 " + state.pages.length + " 页。");
      els.resultMeta.textContent =
        files.length +
        " 个文件 · " +
        state.pages.length +
        " 页 · " +
        totalTexts +
        " 条文本 · 目标 " +
        (els.optLang.value === "zh-TW" ? "繁體中文" : "简体中文") +
        (emptyCount ? " · " + emptyCount + " 页无文字" : "");
      state.pageIndex = 0;
      state.showOriginal = false;
      state.fileName = buildOutputName(files);
      showPanel("result");
      renderPreview();
      renderTextList(state.pages[0]);
    } catch (err) {
      console.error(err);
      fail("处理出错：" + (err && err.message ? err.message : String(err)));
    }
  }

  function buildOutputName(files) {
    if (files.length === 1) {
      return files[0].name.replace(/\.[^.]+$/, "") + "-中文版.pdf";
    }
    return "图片PDF翻译-" + files.length + "文件-中文版.pdf";
  }

  // Events
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
    // allow re-selecting the same file later
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
    if (e.dataTransfer && e.dataTransfer.files) {
      acceptFiles(e.dataTransfer.files);
    }
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

  // Persist image-mode prefs locally
  try {
    const savedKey = localStorage.getItem("pdfzh_gemini_key") || "";
    const savedMode = localStorage.getItem("pdfzh_image_mode") || "ocr";
    if (els.optGeminiKey && savedKey) els.optGeminiKey.value = savedKey;
    if (els.optImageMode && savedMode) els.optImageMode.value = savedMode;
  } catch (e) { /* private mode */ }

  if (els.optGeminiKey) {
    els.optGeminiKey.addEventListener("change", function () {
      try {
        localStorage.setItem("pdfzh_gemini_key", els.optGeminiKey.value.trim());
      } catch (e) { /* ignore */ }
    });
  }
  if (els.optImageMode) {
    els.optImageMode.addEventListener("change", function () {
      try {
        localStorage.setItem("pdfzh_image_mode", els.optImageMode.value);
      } catch (e) { /* ignore */ }
    });
  }

  showPanel("upload");
})();
