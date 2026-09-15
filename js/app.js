(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);

  const els = {
    dropzone: $("#dropzone"),
    fileInput: $("#file-input"),
    optLang: $("#opt-lang"),
    optService: $("#opt-service"),
    optCover: $("#opt-cover"),
    optPreserve: $("#opt-preserve-codes"),
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

  const state = {
    pdfDoc: null,
    file: null,
    pages: [], // { original: canvas, translated: canvas, lines, map }
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
    state.pdfDoc = null;
    state.file = null;
    state.pages = [];
    state.pageIndex = 0;
    state.showOriginal = false;
    els.fileInput.value = "";
    showPanel("upload");
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
      item.addEventListener("click", () => {
        els.textList
          .querySelectorAll(".text-item")
          .forEach((el) => el.classList.remove("active"));
        item.classList.add("active");
      });
      frag.appendChild(item);
    });
    els.textList.appendChild(frag);
  }

  async function handleFile(file) {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
      fail("请选择 PDF 文件。当前文件：" + (file.name || file.type || "未知"));
      return;
    }

    state.file = file;
    state.fileName = file.name.replace(/\.pdf$/i, "") + "-中文版.pdf";
    showPanel("process");
    setStep("load");
    setProgress(4, "读取文件…");
    els.processFile.textContent = file.name;

    try {
      const buffer = await file.arrayBuffer();
      setProgress(10, "解析 PDF…");
      const pdfDoc = await PdfEngine.loadDocument(buffer);
      state.pdfDoc = pdfDoc;

      const options = {
        target: els.optLang.value,
        service: els.optService.value,
        preserveCodes: els.optPreserve.checked,
      };
      const cover = els.optCover.checked;

      const numPages = pdfDoc.numPages;
      state.pages = [];

      // Phase 1: extract all pages
      setStep("extract");
      const extracts = [];
      for (let i = 1; i <= numPages; i++) {
        setProgress(10 + (i / numPages) * 25, "提取第 " + i + " / " + numPages + " 页文字…");
        const page = await pdfDoc.getPage(i);
        const extracted = await PdfEngine.extractPage(page, 1);
        extracts.push(extracted);
      }

      const allTexts = [];
      extracts.forEach((ex) => {
        ex.lines.forEach((line) => allTexts.push(line.text));
      });

      if (!allTexts.length) {
        fail(
          "这个 PDF 没有可提取的文字层（可能是纯扫描图）。当前版本支持带文字层的 PDF；扫描件 OCR 将在后续版本加入。"
        );
        return;
      }

      // Phase 2: translate
      setStep("translate");
      setProgress(40, "开始翻译 " + allTexts.length + " 条文本…");
      const translated = await PdfTranslator.translateMany(
        allTexts,
        options,
        (done, total) => {
          const pct = 40 + (done / Math.max(1, total)) * 35;
          setProgress(pct, "翻译 " + done + " / " + total + " 条…");
        }
      );

      // Build per-page maps
      let cursor = 0;
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
            line: ex.lines[j],
          });
        }
        ex.map = map;
        ex.pairs = pairs;
      }

      // Phase 3: compose canvases
      setStep("compose");
      for (let i = 0; i < extracts.length; i++) {
        setProgress(
          75 + ((i + 1) / extracts.length) * 20,
          "生成中文页面 " + (i + 1) + " / " + extracts.length + "…"
        );
        const ex = extracts[i];
        const original = await PdfEngine.renderPageOriginal(ex.page, 2);
        const translatedCanvas = await PdfEngine.renderPageComposed(ex.page, {
          scale: 2,
          cover: cover,
          lines: ex.lines,
          map: ex.map,
        });
        state.pages.push({
          original: original,
          translated: translatedCanvas,
          lines: ex.lines,
          map: ex.map,
          pairs: ex.pairs,
          pdfPage: ex.page,
        });
      }

      setStep("done");
      setProgress(100, "完成。共 " + numPages + " 页。");
      els.resultMeta.textContent =
        file.name +
        " · " +
        numPages +
        " 页 · " +
        allTexts.length +
        " 条文本 · 目标 " +
        (els.optLang.value === "zh-TW" ? "繁體中文" : "简体中文");
      state.pageIndex = 0;
      state.showOriginal = false;
      showPanel("result");
      renderPreview();
      renderTextList(state.pages[0]);
    } catch (err) {
      console.error(err);
      fail("处理出错：" + (err && err.message ? err.message : String(err)));
    }
  }

  // Events
  els.dropzone.addEventListener("click", () => els.fileInput.click());
  els.dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      els.fileInput.click();
    }
  });
  els.fileInput.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    handleFile(file);
  });

  ["dragenter", "dragover"].forEach((name) => {
    els.dropzone.addEventListener(name, (e) => {
      e.preventDefault();
      e.stopPropagation();
      els.dropzone.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach((name) => {
    els.dropzone.addEventListener(name, (e) => {
      e.preventDefault();
      e.stopPropagation();
      els.dropzone.classList.remove("dragover");
    });
  });
  els.dropzone.addEventListener("drop", (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    handleFile(file);
  });

  els.btnPrev.addEventListener("click", () => {
    if (state.pageIndex > 0) {
      state.pageIndex -= 1;
      renderPreview();
      renderTextList(state.pages[state.pageIndex]);
    }
  });
  els.btnNext.addEventListener("click", () => {
    if (state.pageIndex < state.pages.length - 1) {
      state.pageIndex += 1;
      renderPreview();
      renderTextList(state.pages[state.pageIndex]);
    }
  });
  els.btnToggle.addEventListener("click", () => {
    state.showOriginal = !state.showOriginal;
    renderPreview();
  });
  els.btnReset.addEventListener("click", resetAll);
  els.btnErrorReset.addEventListener("click", resetAll);

  els.btnDownload.addEventListener("click", () => {
    try {
      const canvases = state.pages.map((p) => p.translated);
      const pdf = PdfEngine.canvasesToPdf(canvases);
      PdfEngine.downloadPdf(pdf, state.fileName || "translated-zh.pdf");
    } catch (err) {
      alert("导出失败：" + (err && err.message ? err.message : err));
    }
  });

  // Init
  showPanel("upload");
})();
