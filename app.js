(function () {
  'use strict';

  // ---------- 依赖初始化 ----------
  // 优先使用内联的 worker 源码，这样直接双击打开 HTML（file://）也能运行。
  if (window.__PDFJS_WORKER_SRC__) {
    var workerBlob = new Blob([window.__PDFJS_WORKER_SRC__], { type: 'text/javascript' });
    pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(workerBlob);
  } else {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  }

  var PAPER = 'rgb(250, 247, 236)';

  var PRESETS = {
    light:   { skew: 0.3, paperTone: 0.30, noise: 0.04, blur: 0.2, edgeShadow: 0.08, jpegQuality: 82, dpi: 150, grayscale: true },
    standard:{ skew: 0.6, paperTone: 0.60, noise: 0.08, blur: 0.4, edgeShadow: 0.15, jpegQuality: 70, dpi: 150, grayscale: true },
    strong:  { skew: 1.5, paperTone: 0.80, noise: 0.20, blur: 0.8, edgeShadow: 0.35, jpegQuality: 50, dpi: 150, grayscale: true },
    vintage: { skew: 2.5, paperTone: 1.00, noise: 0.35, blur: 1.2, edgeShadow: 0.50, jpegQuality: 35, dpi: 120, grayscale: true }
  };

  var el = {};
  [
    'dropzone', 'fileInput', 'replaceBtn', 'fileBar', 'fileName', 'fileDetail',
    'workspace', 'previewWrap', 'previewCanvas', 'previewLabel', 'pageIndicator', 'prevPage', 'nextPage',
    'status', 'presets', 'resetBtn', 'generateBtn', 'generateLabel', 'downloadBtn',
    'progressTrack', 'progressFill', 'seed',
    'skew', 'paperTone', 'noise', 'blur', 'edgeShadow', 'jpegQuality', 'dpi', 'grayscale'
  ].forEach(function (id) { el[id] = document.getElementById(id); });

  var valueIds = ['skew', 'paperTone', 'noise', 'blur', 'edgeShadow', 'jpegQuality', 'dpi'];
  valueIds.forEach(function (id) { el[id + 'Value'] = document.getElementById(id + 'Value'); });

  var state = {
    file: null,
    bytes: null,
    pdfDoc: null,
    pageCount: 0,
    previewIndex: 0,
    originalPreviews: [],
    processedPreviews: [],
    showingProcessed: false,
    resultBlob: null,
    busy: false
  };

  // ---------- 工具 ----------
  function setStatus(message, kind) {
    el.status.textContent = message || '';
    el.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function gaussian(rng) {
    var u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function computeSeed(bytes, text) {
    var h = 2166136261;
    var i, ch;
    if (text) {
      for (i = 0; i < text.length; i++) {
        ch = text.codePointAt(i);
        h ^= ch;
        h = Math.imul(h, 16777619);
        if (ch > 0xFFFF) i++;
      }
    } else {
      // 对文件做抽样哈希：大文件也不必逐字节扫描。
      var step = Math.max(1, Math.floor(bytes.length / 65536));
      for (i = 0; i < bytes.length; i += step) {
        h ^= bytes[i];
        h = Math.imul(h, 16777619);
      }
    }
    return h >>> 0;
  }

  function copyCanvas(src) {
    var out = document.createElement('canvas');
    out.width = src.width;
    out.height = src.height;
    out.getContext('2d').drawImage(src, 0, 0);
    return out;
  }

  // ---------- 像素级效果 ----------
  function applyGrayscale(data) {
    var d = data.data;
    for (var i = 0; i < d.length; i += 4) {
      var y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      d[i] = d[i + 1] = d[i + 2] = y;
    }
  }

  function applyPaperTone(data, strength) {
    var d = data.data;
    var sr = 250 / 255, sg = 247 / 255, sb = 236 / 255;
    var lift = 18, k = 1 - lift / 255;
    for (var i = 0; i < d.length; i += 4) {
      var r = d[i], g = d[i + 1], b = d[i + 2];
      d[i]     = r + (lift + r * sr * k - r) * strength;
      d[i + 1] = g + (lift + g * sg * k - g) * strength;
      d[i + 2] = b + (lift + b * sb * k - b) * strength;
    }
  }

  function applyNoise(data, amount, rng) {
    var d = data.data;
    var sd = amount * 40;
    for (var i = 0; i < d.length; i += 4) {
      var n = gaussian(rng) * sd;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
  }

  function applyEdgeShadow(data, strength) {
    var w = data.width, h = data.height, d = data.data;
    var band = Math.max(1, Math.min(w, h) * 0.12);
    for (var y = 0; y < h; y++) {
      var dy = Math.min(y, h - 1 - y);
      for (var x = 0; x < w; x++) {
        var dx = Math.min(x, w - 1 - x);
        var dist = Math.min(dx, dy);
        if (dist >= band) continue;
        var f = 1 - strength * (1 - dist / band);
        var i = (y * w + x) * 4;
        d[i] *= f; d[i + 1] *= f; d[i + 2] *= f;
      }
    }
  }

  function applyBlur(src, sigma) {
    var pad = Math.max(1, Math.ceil(sigma * 3));
    var padded = document.createElement('canvas');
    padded.width = src.width + pad * 2;
    padded.height = src.height + pad * 2;
    var pctx = padded.getContext('2d');
    pctx.fillStyle = PAPER;
    pctx.fillRect(0, 0, padded.width, padded.height);
    pctx.drawImage(src, pad, pad);

    var out = document.createElement('canvas');
    out.width = src.width;
    out.height = src.height;
    var octx = out.getContext('2d');
    octx.filter = 'blur(' + sigma + 'px)';
    octx.drawImage(padded, -pad, -pad);
    octx.filter = 'none';
    return out;
  }

  function applySkew(src, maxDeg, rng) {
    var angle = (rng() * 2 - 1) * maxDeg * Math.PI / 180;
    if (Math.abs(angle) < 1e-9) return src;
    var out = document.createElement('canvas');
    out.width = src.width;
    out.height = src.height;
    var ctx = out.getContext('2d');
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.save();
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate(angle);
    ctx.drawImage(src, -src.width / 2, -src.height / 2);
    ctx.restore();
    return out;
  }

  // 按参考项目的顺序：灰度 → 纸张色调 → 失焦 → 噪点 → 边缘阴影 → 倾斜
  function runEffects(source, p, rngNoise, rngSkew) {
    var current = copyCanvas(source);
    var ctx = current.getContext('2d', { willReadFrequently: true });
    var data = ctx.getImageData(0, 0, current.width, current.height);
    if (p.grayscale) applyGrayscale(data);
    if (p.paperTone > 0) applyPaperTone(data, p.paperTone);
    ctx.putImageData(data, 0, 0);

    if (p.blur > 0) current = applyBlur(current, p.blur);

    if (p.noise > 0 || p.edgeShadow > 0) {
      current = copyCanvas(current);
      ctx = current.getContext('2d', { willReadFrequently: true });
      data = ctx.getImageData(0, 0, current.width, current.height);
      if (p.noise > 0) applyNoise(data, p.noise, rngNoise);
      if (p.edgeShadow > 0) applyEdgeShadow(data, p.edgeShadow);
      ctx.putImageData(data, 0, 0);
    }

    if (p.skew > 0) current = applySkew(current, p.skew, rngSkew);
    return current;
  }

  function makePreviewCanvas(src, maxHeight) {
    var scale = Math.min(1, maxHeight / src.height);
    var out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(src.width * scale));
    out.height = Math.max(1, Math.round(src.height * scale));
    out.getContext('2d').drawImage(src, 0, 0, out.width, out.height);
    return out;
  }

  // ---------- PDF 处理 ----------
  function readParams() {
    return {
      skew: parseFloat(el.skew.value),
      paperTone: parseFloat(el.paperTone.value),
      noise: parseFloat(el.noise.value),
      blur: parseFloat(el.blur.value),
      edgeShadow: parseFloat(el.edgeShadow.value),
      jpegQuality: parseInt(el.jpegQuality.value, 10),
      dpi: parseInt(el.dpi.value, 10),
      grayscale: el.grayscale.checked,
      seed: el.seed.value.trim()
    };
  }

  function canvasToJpegBytes(canvas, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (!blob) { reject(new Error('JPEG 编码失败')); return; }
        blob.arrayBuffer().then(function (buf) { resolve(new Uint8Array(buf)); }, reject);
      }, 'image/jpeg', quality / 100);
    });
  }

  async function generate() {
    if (state.busy || !state.pdfDoc || !state.bytes) return;
    state.busy = true;
    el.generateBtn.disabled = true;
    el.downloadBtn.classList.add('hidden');
    el.progressTrack.classList.add('visible');
    el.progressFill.style.width = '0%';
    setStatus('正在处理第 1 / ' + state.pageCount + ' 页…');

    try {
      var p = readParams();
      var baseSeed = computeSeed(state.bytes, p.seed);
      var outPdf = await PDFLib.PDFDocument.create();
      outPdf.setTitle('扫描件');
      outPdf.setProducer('拟扫 · 纯前端扫描件生成器');

      var processedPreviews = [];
      var scale = p.dpi / 72;

      for (var i = 1; i <= state.pageCount; i++) {
        var page = await state.pdfDoc.getPage(i);
        var viewport = page.getViewport({ scale: scale });
        var renderCanvas = document.createElement('canvas');
        renderCanvas.width = Math.max(1, Math.round(viewport.width));
        renderCanvas.height = Math.max(1, Math.round(viewport.height));
        var rctx = renderCanvas.getContext('2d', { willReadFrequently: true });
        rctx.fillStyle = '#ffffff';
        rctx.fillRect(0, 0, renderCanvas.width, renderCanvas.height);
        await page.render({ canvasContext: rctx, viewport: viewport }).promise;

        // 每页独立派生随机流，风格一致但每页的噪点与角度不同。
        var master = mulberry32((baseSeed + Math.imul(i, 0x9E3779B1)) >>> 0);
        var rngNoise = mulberry32(Math.floor(master() * 4294967296));
        var rngSkew = mulberry32(Math.floor(master() * 4294967296));

        var processed = runEffects(renderCanvas, p, rngNoise, rngSkew);
        processedPreviews.push(makePreviewCanvas(processed, 640));

        var jpegBytes = await canvasToJpegBytes(processed, p.jpegQuality);
        var sizeViewport = page.getViewport({ scale: 1 });
        var outPage = outPdf.addPage([sizeViewport.width, sizeViewport.height]);
        var image = await outPdf.embedJpg(jpegBytes);
        outPage.drawImage(image, {
          x: 0, y: 0,
          width: sizeViewport.width,
          height: sizeViewport.height
        });

        el.progressFill.style.width = Math.round(i / state.pageCount * 100) + '%';
        if (i < state.pageCount) setStatus('正在处理第 ' + (i + 1) + ' / ' + state.pageCount + ' 页…');
      }

      var outBytes = await outPdf.save({ useObjectStreams: true });
      state.resultBlob = new Blob([outBytes], { type: 'application/pdf' });
      state.processedPreviews = processedPreviews;
      state.showingProcessed = true;
      state.previewIndex = 0;
      drawPreview();

      el.downloadBtn.classList.remove('hidden');
      setStatus('完成：已生成 ' + state.pageCount + ' 页扫描件（' + formatBytes(state.resultBlob.size) + '）', 'success');
    } catch (err) {
      console.error(err);
      setStatus('处理失败：' + (err && err.message ? err.message : String(err)), 'error');
    } finally {
      state.busy = false;
      el.generateBtn.disabled = false;
      el.progressTrack.classList.remove('visible');
    }
  }

  // ---------- 预览 ----------
  async function renderOriginalPreview(index) {
    var page = await state.pdfDoc.getPage(index + 1);
    var base = page.getViewport({ scale: 1 });
    var scale = Math.min(1.6, 640 / base.height);
    var viewport = page.getViewport({ scale: scale });
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: viewport }).promise;
    return canvas;
  }

  async function drawPreview() {
    if (!state.pdfDoc) return;
    var index = state.previewIndex;
    var source;
    if (state.showingProcessed && state.processedPreviews[index]) {
      source = state.processedPreviews[index];
    } else {
      if (!state.originalPreviews[index]) {
        state.originalPreviews[index] = await renderOriginalPreview(index);
      }
      source = state.originalPreviews[index];
    }
    var target = el.previewCanvas;
    target.width = source.width;
    target.height = source.height;
    target.getContext('2d').drawImage(source, 0, 0);
    el.previewLabel.textContent = state.showingProcessed ? '扫描效果预览' : '原始页面';
    el.pageIndicator.textContent = (index + 1) + ' / ' + state.pageCount;
    el.prevPage.disabled = index <= 0;
    el.nextPage.disabled = index >= state.pageCount - 1;
  }

  // ---------- 文件载入 ----------
  async function loadFile(file) {
    if (!file) return;
    var nameOk = /\.pdf$/i.test(file.name);
    var typeOk = file.type === 'application/pdf' || file.type === '';
    if (!nameOk && !typeOk) { setStatus('请选择 PDF 文件', 'error'); return; }
    if (file.size > 50 * 1024 * 1024) { setStatus('文件超过 50 MB 限制', 'error'); return; }

    setStatus('正在读取文件…');
    try {
      var bytes = new Uint8Array(await file.arrayBuffer());
      var task = pdfjsLib.getDocument({ data: bytes.slice(), useSystemFonts: true });
      var doc = await task.promise;

      state.file = file;
      state.bytes = bytes;
      state.pdfDoc = doc;
      state.pageCount = doc.numPages;
      state.previewIndex = 0;
      state.originalPreviews = [];
      state.processedPreviews = [];
      state.showingProcessed = false;
      state.resultBlob = null;

      el.fileName.textContent = file.name;
      el.fileDetail.textContent = state.pageCount + ' 页 · ' + formatBytes(file.size);
      el.dropzone.classList.add('hidden');
      el.workspace.classList.add('has-file');
      el.fileBar.classList.remove('hidden');
      el.previewWrap.classList.remove('hidden');
      el.generateBtn.disabled = false;
      el.downloadBtn.classList.add('hidden');
      setStatus('已载入，选择效果后点击生成。');
      await drawPreview();
    } catch (err) {
      console.error(err);
      setStatus('无法打开这个 PDF：' + (err && err.message ? err.message : String(err)), 'error');
    }
  }

  function download() {
    if (!state.resultBlob || !state.file) return;
    var url = URL.createObjectURL(state.resultBlob);
    var a = document.createElement('a');
    a.href = url;
    var base = state.file.name.replace(/\.pdf$/i, '');
    a.download = base + '-scanned.pdf';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  // ---------- 控件绑定 ----------
  function updateValueLabels() {
    valueIds.forEach(function (id) {
      var v = parseFloat(el[id].value);
      var text = (id === 'jpegQuality' || id === 'dpi') ? String(Math.round(v))
        : (id === 'paperTone' || id === 'noise' || id === 'edgeShadow') ? v.toFixed(2)
        : String(v);
      el[id + 'Value'].textContent = text;
    });
  }

  function applyPreset(name) {
    var preset = PRESETS[name];
    if (!preset) return;
    Object.keys(preset).forEach(function (key) {
      if (key === 'grayscale') el.grayscale.checked = preset[key];
      else el[key].value = preset[key];
    });
    updateValueLabels();
    Array.prototype.forEach.call(el.presets.children, function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-preset') === name);
    });
    invalidateResult();
  }

  function invalidateResult() {
    if (!state.resultBlob) return;
    state.resultBlob = null;
    state.showingProcessed = false;
    el.downloadBtn.classList.add('hidden');
    setStatus('参数已更改，重新生成以下载新版本。');
    drawPreview();
  }

  el.presets.addEventListener('click', function (e) {
    var btn = e.target.closest('.preset');
    if (btn) applyPreset(btn.getAttribute('data-preset'));
  });

  valueIds.concat(['grayscale']).forEach(function (id) {
    el[id].addEventListener('input', function () {
      updateValueLabels();
      Array.prototype.forEach.call(el.presets.children, function (btn) { btn.classList.remove('active'); });
      invalidateResult();
    });
  });

  el.seed.addEventListener('input', invalidateResult);
  el.resetBtn.addEventListener('click', function () { applyPreset('standard'); });

  el.dropzone.addEventListener('click', function () { el.fileInput.click(); });
  el.dropzone.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); }
  });
  el.replaceBtn.addEventListener('click', function () { el.fileInput.click(); });
  el.fileInput.addEventListener('change', function () {
    if (el.fileInput.files && el.fileInput.files[0]) loadFile(el.fileInput.files[0]);
    el.fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach(function (type) {
    el.dropzone.addEventListener(type, function (e) { e.preventDefault(); el.dropzone.classList.add('dragover'); });
  });
  ['dragleave', 'drop'].forEach(function (type) {
    el.dropzone.addEventListener(type, function (e) { e.preventDefault(); el.dropzone.classList.remove('dragover'); });
  });
  el.dropzone.addEventListener('drop', function (e) {
    var files = e.dataTransfer && e.dataTransfer.files;
    if (files && files[0]) loadFile(files[0]);
  });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });

  el.prevPage.addEventListener('click', function () {
    if (state.previewIndex > 0) { state.previewIndex--; drawPreview(); }
  });
  el.nextPage.addEventListener('click', function () {
    if (state.previewIndex < state.pageCount - 1) { state.previewIndex++; drawPreview(); }
  });

  el.generateBtn.addEventListener('click', generate);
  el.downloadBtn.addEventListener('click', download);

  updateValueLabels();
})();
