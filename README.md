# PDF 中文转换器

上传 PDF → 本地提取文字 → 多源翻译 → 覆盖原文并写入中文 → 下载中文版 PDF。

灵感来自 [ShinobuTranslator](https://github.com/DonutShinobu/ShinobuTranslator) 的「识别 → 翻译 → 嵌字」思路，针对 PDF 文档做了网页版实现。

## 使用

在本目录启动静态服务后打开 `index.html`：

```bash
# Python
python -m http.server 8765

# 或 Node
npx --yes serve -l 8765
```

浏览器访问 `http://127.0.0.1:8765`，拖入 PDF 即可。

## 功能

- 拖拽 / 选择上传 PDF
- 自动提取文字层并按行合并
- 翻译服务：Google（默认）/ MyMemory / 仅词表对照，自动回退
- 产品规格词表（配色部位、材质、视角等），并保留 PMS 色号、尺寸代码
- 覆盖原文后用系统中文字体重绘
- 原稿 / 中文版对照预览
- 下载多页中文 PDF

## 说明

- 当前支持**带文字层**的 PDF；纯扫描件 OCR 尚未接入
- 翻译请求会发往所选公共接口，请勿上传敏感文件
- 测试样例：`test/buff-duo-costume.pdf`（Duolingo Buff Duo 充气服饰配色表）

## 开发自测

```bash
npm install
node scripts/test-e2e.js
```
