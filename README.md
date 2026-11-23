# 让PDF看起来像扫描件

一个极简的纯前端工具：把普通的 PDF 变成"像是用扫描仪扫出来的"PDF。纸张泛黄、页面轻微歪斜、扫描噪点、镜头失焦、边缘阴影和 JPEG 压缩痕迹都可以在线调节。

**所有处理都在浏览器本地完成，文件不会上传到任何服务器，也不需要联网。**

## 使用方法

直接用浏览器打开 `index.html` 即可（双击文件也行，支持 `file://` 协议）。

1. 拖入 PDF，或点击上传区域选择文件（支持多页，单文件最大 50 MB）
2. 选择预设，或逐项调节效果参数
3. 点击「生成扫描件」
4. 预览满意后点击「下载 PDF」

也可以用任意静态服务器托管，例如：

```bash
python -m http.server 8080
```

然后访问 `http://localhost:8080`。

## 功能

- **四档预设**：轻微、标准、明显、复古，一键切换常用组合
- **七项可调参数**：倾斜角度、纸张色调、扫描噪点、镜头失焦、边缘阴影、JPEG 质量、渲染 DPI
- **黑白灰度开关**：关闭后保留彩色，仍带纸张色调
- **随机种子**：控制每页的倾斜角度与噪点分布；相同种子 + 相同参数 = 完全相同的输出。留空时根据文件内容生成，因此同一文件的结果固定可复现
- **多页支持**：逐页渲染、逐页处理，可翻页查看预览
- **纯图片 PDF**：输出中不含可选中的文字，和真实扫描件一致

## 效果原理

每一页先按设定 DPI 栅格化为图像，然后依次经过：

灰度 → 纸张色调 → 高斯失焦 → 噪点 → 边缘阴影 → 轻微旋转

最后以指定的 JPEG 质量编码，并重新组装成 PDF。参数默认值与效果顺序参考了 [scavin/make-look-scanned](https://github.com/scavin/make-look-scanned)，但实现改为纯 JavaScript，不依赖 Go/WASM，也没有构建步骤。

## 文件结构

```
.
├── index.html             页面结构
├── styles.css             样式（浅色极简风格，响应式）
├── app.js                 全部逻辑：效果算法、PDF 处理、界面交互
└── vendor/                本地依赖，无需联网
    ├── pdf.min.js         PDF.js（渲染 PDF 页面）
    ├── pdf.worker.min.js  PDF.js worker（备用）
    ├── pdf.worker.wrap.js Worker 源码的内联包装，使 file:// 直接打开也能运行
    └── pdf-lib.min.js     pdf-lib（组装输出 PDF）
```

样式与脚本均为独立文件，HTML 中没有内联 CSS 或 JavaScript。

## 隐私与兼容性

- PDF 只在你的浏览器中读取和处理，不会发起任何上传请求
- 不依赖 CDN，所有依赖已本地化，可离线使用
- 需要支持 Canvas 和 Web Worker 的现代浏览器（Chrome、Edge、Firefox、Safari 等）
- 输出 PDF 由 JPEG 图像组成，文件体积通常比原 PDF 大，文字将不可搜索或选中

## 第三方库

- [PDF.js](https://mozilla.github.io/pdf.js/) — Apache-2.0
- [pdf-lib](https://pdf-lib.js.org/) — MIT
