# PDF / 图片 中文转换器

上传 PDF 或多张图片 → 本地提取 / OCR → 翻译 → 覆盖原文写入中文 → 下载中文版 PDF。

**在线使用：** https://asd3129604700-alt.github.io/pdf-zh-translator/

灵感来自 [ShinobuTranslator](https://github.com/DonutShinobu/ShinobuTranslator) 的「识别 → 翻译 → 嵌字」思路，针对 PDF / 图片做了网页版实现。

## 使用

### 在线（推荐）

打开上面的链接，拖入 PDF，或一次多选 JPG / PNG 图片，无需安装。

### 本地运行

在本目录启动静态服务后打开 `index.html`：

```bash
# Python
python -m http.server 8765

# 或 Node
npx --yes serve -l 8765
```

浏览器访问 `http://127.0.0.1:8765`。

## 功能

- 拖拽 / 多选上传：PDF（1 个）+ JPG / PNG / WebP（可多张）
- PDF：自动提取文字层并按行合并
- 图片：浏览器本地 Tesseract OCR 识别英文
- 翻译服务：Google（默认）/ MyMemory / 仅词表对照，自动回退
- 产品规格词表（配色部位、材质、视角等），并保留 PMS 色号、尺寸代码
- 覆盖原文后用系统中文字体重绘
- 原稿 / 中文版对照预览，可翻页
- 下载合并后的多页中文 PDF

## 说明

- PDF 优先支持**带文字层**文档；图片走 OCR（清晰英文截图效果更好）
- 首次使用图片功能会下载 OCR 语言数据，可能稍慢
- 翻译请求会发往所选公共接口，请勿上传敏感文件
- 测试样例：`test/buff-duo-costume.pdf`（Duolingo Buff Duo 充气服饰配色表）

## 开发自测

```bash
npm install
node scripts/test-e2e.js
```
