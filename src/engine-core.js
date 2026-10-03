/* engine-core.js — 拼豆图纸量化引擎 · 核心 Demo 版
 * ============================================================================
 * ⚠️ 这是从完整项目 pindou-studio/frontend/engine.js 抽取的核心算法 Demo，
 *    非完整产品：去掉了 Pillow 定点 Lanczos 重采样复刻、中值降噪、Web Worker
 *    外壳、限色细节之外的工程化部分，只保留最能代表完整项目的三块核心：
 *
 *      1. sRGB → CIE Lab(D65) 转换 —— 色彩匹配不用朴素 RGB 欧氏距离的原因：
 *         RGB 数值上相近的两个颜色，人眼看可能差很远；Lab 空间的欧氏距离
 *         与人眼感知的色差更一致（完整项目 ENGINEERING_LOG.md 第 4.1 节）。
 *      2. 最近邻匹配 —— 在 Lab 空间对每个像素找 ΔE 最小的色卡色号。
 *      3. 可选的 Floyd–Steinberg 抖动 —— 且带「色度误差自适应衰减」门控：
 *         中性灰像素的色度误差纯粹是「色卡缺中性色」造成的噪声，如实扩散
 *         会把灰格互相传染成紫/蓝/粉的零星异色点；彩色像素的色度误差是真实
 *         信号，必须照常扩散。故按源像素饱和度线性插值（完整项目 v1.0.4
 *         用四组对照实验定位的缺陷修复，见 assets/07、08 两张对照图）。
 *
 * 与完整版的差异（有意为之，都在注释中标明）：
 *   - 缩放用 canvas drawImage 完成（完整版为逐位复刻 Pillow 的定点 Lanczos-3，
 *     731 行，见原项目 frontend/engine.js）；
 *   - 不含中值降噪、不含用量百分比的最大余数法（Demo 只给计数）；
 *   - 限色（maxColors）保留：按用量取 top-N 再整体重映射，与完整版同思路。
 * ============================================================================
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();          // Node：供验证脚本直接 require
  } else {
    root.PindouEngineCore = factory();   // 浏览器
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---- 常量：与完整项目 backend/quantize.py / frontend/engine.js 逐字一致 ---- */
  var WHITE = [0.95047, 1.0, 1.08883];   // D65 白点
  var M_RGB2XYZ = [
    [0.4124564, 0.3575761, 0.1804375],
    [0.2126729, 0.7151522, 0.0721750],
    [0.0193339, 0.1191920, 0.9503041]
  ];
  var EPS = 216.0 / 24389.0;
  var KAPPA = 24389.0 / 27.0;
  var ALPHA_THRESHOLD = 128;             // alpha 低于此值 = 该格不放豆子
  var DITHER_CHROMA_GATE = 20.0;         // 色度误差衰减门控：饱和度超过该值不衰减
  var DITHER_CHROMA_MIN_SCALE = 0.2;     // 完全中性像素的色度误差保留比例（防呆滞）

  function hexToRgb(hex) {
    var h = String(hex == null ? '' : hex).trim().replace(/^#/, '');
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16)
    ];
  }

  /* ========================================================================
   * sRGB → CIE Lab (D65)
   * ====================================================================== */
  function srgbToLabInto(r, g, b, out, off) {
    var c0 = r / 255.0, c1 = g / 255.0, c2 = b / 255.0;

    // 1) 逆 gamma（sRGB 传输曲线，分段：暗部直线 + 亮部 2.4 次幂）
    c0 = c0 > 0.04045 ? Math.pow((c0 + 0.055) / 1.055, 2.4) : c0 / 12.92;
    c1 = c1 > 0.04045 ? Math.pow((c1 + 0.055) / 1.055, 2.4) : c1 / 12.92;
    c2 = c2 > 0.04045 ? Math.pow((c2 + 0.055) / 1.055, 2.4) : c2 / 12.92;

    // 2) 线性 RGB → XYZ（D65）
    var x = (M_RGB2XYZ[0][0] * c0 + M_RGB2XYZ[0][1] * c1 + M_RGB2XYZ[0][2] * c2) / WHITE[0];
    var y = (M_RGB2XYZ[1][0] * c0 + M_RGB2XYZ[1][1] * c1 + M_RGB2XYZ[1][2] * c2) / WHITE[1];
    var z = (M_RGB2XYZ[2][0] * c0 + M_RGB2XYZ[2][1] * c1 + M_RGB2XYZ[2][2] * c2) / WHITE[2];

    // 3) XYZ → Lab（标准 CIE 定义，含低值区的线性段）
    var fx = x > EPS ? Math.cbrt(x) : (KAPPA * x + 16.0) / 116.0;
    var fy = y > EPS ? Math.cbrt(y) : (KAPPA * y + 16.0) / 116.0;
    var fz = z > EPS ? Math.cbrt(z) : (KAPPA * z + 16.0) / 116.0;

    out[off] = 116.0 * fy - 16.0;
    out[off + 1] = 500.0 * (fx - fy);
    out[off + 2] = 200.0 * (fy - fz);
  }

  /* ========================================================================
   * 最近邻匹配（CIE Lab 欧氏距离），取第一个最小值（与 np.argmin 一致）
   * ====================================================================== */
  function nearestIndices(vlab, m, palLab, P) {
    var out = new Int32Array(m);
    for (var i = 0; i < m; i++) {
      var o = i * 3;
      var c0 = vlab[o], c1 = vlab[o + 1], c2 = vlab[o + 2];
      var best = 0, bestD = Infinity;
      for (var t = 0; t < P; t++) {
        var q = t * 3;
        var d0 = palLab[q] - c0, d1 = palLab[q + 1] - c1, d2 = palLab[q + 2] - c2;
        var dd = d0 * d0 + d1 * d1 + d2 * d2;
        if (dd < bestD) { bestD = dd; best = t; }
      }
      out[i] = best;
    }
    return out;
  }

  /* ========================================================================
   * Floyd–Steinberg 误差扩散（Lab 空间 + 色度误差自适应衰减）
   * ====================================================================== */
  function floydSteinberg(lab, valid, w, h, palLab) {
    var P = palLab.length / 3;
    var n = w * h;
    var work = new Float64Array(lab);        // 拷贝，误差就地累加
    var idx = new Int32Array(n).fill(-1);
    var chroma = new Float64Array(n);
    for (var p = 0; p < n; p++) {
      var a = lab[p * 3 + 1], b = lab[p * 3 + 2];
      chroma[p] = Math.sqrt(a * a + b * b);  // 该像素的饱和度（Lab 色度分量）
    }

    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = y * w + x;
        if (!valid[i]) continue;

        var o = i * 3;
        var c0 = work[o], c1 = work[o + 1], c2 = work[o + 2];

        var best = 0, bestD = Infinity;
        for (var k = 0; k < P; k++) {
          var q = k * 3;
          var d0 = palLab[q] - c0, d1 = palLab[q + 1] - c1, d2 = palLab[q + 2] - c2;
          var dd = d0 * d0 + d1 * d1 + d2 * d2;
          if (dd < bestD) { bestD = dd; best = k; }
        }
        idx[i] = best;

        var qb = best * 3;
        var e0 = c0 - palLab[qb], e1 = c1 - palLab[qb + 1], e2 = c2 - palLab[qb + 2];

        // —— 色度误差自适应衰减（完整项目 v1.0.4 的缺陷修复核心）——
        // 越接近中性灰，色度误差越可能是「色卡缺中性色」的噪声，扩散系数越小。
        var tt = chroma[i] / DITHER_CHROMA_GATE;
        if (tt > 1.0) tt = 1.0;
        var sc = DITHER_CHROMA_MIN_SCALE + (1.0 - DITHER_CHROMA_MIN_SCALE) * tt;
        e1 *= sc;
        e2 *= sc;

        // Floyd–Steinberg 标准权重：右 7/16，左下 3/16，下 5/16，右下 1/16
        if (x + 1 < w && valid[i + 1]) {
          var n1 = (i + 1) * 3;
          work[n1] += e0 * (7.0 / 16.0);
          work[n1 + 1] += e1 * (7.0 / 16.0);
          work[n1 + 2] += e2 * (7.0 / 16.0);
        }
        if (y + 1 < h) {
          if (x - 1 >= 0 && valid[i + w - 1]) {
            var n2 = (i + w - 1) * 3;
            work[n2] += e0 * (3.0 / 16.0);
            work[n2 + 1] += e1 * (3.0 / 16.0);
            work[n2 + 2] += e2 * (3.0 / 16.0);
          }
          if (valid[i + w]) {
            var n3 = (i + w) * 3;
            work[n3] += e0 * (5.0 / 16.0);
            work[n3 + 1] += e1 * (5.0 / 16.0);
            work[n3 + 2] += e2 * (5.0 / 16.0);
          }
          if (x + 1 < w && valid[i + w + 1]) {
            var n4 = (i + w + 1) * 3;
            work[n4] += e0 * (1.0 / 16.0);
            work[n4 + 1] += e1 * (1.0 / 16.0);
            work[n4 + 2] += e2 * (1.0 / 16.0);
          }
        }
      }
    }
    return idx;
  }

  /* 按计数降序、同计数按色号索引升序取前 n 个（对应 np.argsort 稳定排序） */
  function topNStable(counts, n) {
    var idx = [];
    for (var i = 0; i < counts.length; i++) idx.push(i);
    idx.sort(function (a, b) {
      if (counts[b] !== counts[a]) return counts[b] - counts[a];
      return a - b;
    });
    var top = idx.slice(0, n);
    top.sort(function (a, b) { return a - b; });
    return top;
  }

  /* ========================================================================
   * 主入口：把 RGBA 像素量化为拼豆网格
   *
   * @param {Uint8Array|Uint8ClampedArray} rgba  已缩放到 gridW×gridH 的像素
   * @param {Array<{code,name,hex}>} colors 色卡
   * @param {Object} opts { maxColors: 0=不限, dither: bool }
   * @returns {{grid:Array, usage:Array, totalBeads:number}}
   *          grid[r][c] = 色号或 null；usage 按用量降序
   * ====================================================================== */
  function quantize(rgba, gridW, gridH, colors, opts) {
    opts = opts || {};
    var maxColors = opts.maxColors | 0;
    var dither = !!opts.dither;

    if (!colors || colors.length < 1) throw new Error('色卡为空');
    if (gridW < 1 || gridH < 1) throw new Error('目标尺寸无效');

    var P = colors.length;
    var n = gridW * gridH;

    /* ---- 1. 色卡 → Lab ---- */
    var palLab = new Float64Array(P * 3);
    var tmp = new Float64Array(3);
    for (var i = 0; i < P; i++) {
      var c = hexToRgb(colors[i].hex);
      srgbToLabInto(c[0], c[1], c[2], tmp, 0);
      palLab[i * 3] = tmp[0];
      palLab[i * 3 + 1] = tmp[1];
      palLab[i * 3 + 2] = tmp[2];
    }

    /* ---- 2. 全部像素转 Lab，并按 alpha 标出有效格 ---- */
    var lab = new Float64Array(n * 3);
    var valid = new Uint8Array(n);
    var validCount = 0;
    for (var p = 0; p < n; p++) {
      if (rgba[p * 4 + 3] >= ALPHA_THRESHOLD) {
        valid[p] = 1;
        validCount++;
        srgbToLabInto(rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2], lab, p * 3);
      }
    }

    var fullIdx = new Int32Array(n).fill(-1);

    if (validCount > 0) {
      /* ---- 3. 限色（可选）：先全色卡最近邻，再按用量取 top-N 重映射 ---- */
      var vlab = new Float64Array(validCount * 3);
      var vidx = new Int32Array(validCount);
      var m = 0;
      for (var q2 = 0; q2 < n; q2++) {
        if (valid[q2]) {
          vidx[m] = q2;
          vlab[m * 3] = lab[q2 * 3];
          vlab[m * 3 + 1] = lab[q2 * 3 + 1];
          vlab[m * 3 + 2] = lab[q2 * 3 + 2];
          m++;
        }
      }

      var selArr = null;
      var baseIdx = nearestIndices(vlab, m, palLab, P);
      if (maxColors >= 2 && maxColors <= 64) {
        var countsAll = new Int32Array(P);
        for (var r = 0; r < m; r++) countsAll[baseIdx[r]]++;
        var usedCount = 0;
        for (var s = 0; s < P; s++) if (countsAll[s] > 0) usedCount++;
        if (usedCount > maxColors) {
          selArr = topNStable(countsAll, maxColors);
          // 重映射：在选中的 N 色子集内重新做最近邻
          var palSel = new Float64Array(selArr.length * 3);
          for (var t2 = 0; t2 < selArr.length; t2++) {
            var s3 = selArr[t2] * 3;
            palSel[t2 * 3] = palLab[s3];
            palSel[t2 * 3 + 1] = palLab[s3 + 1];
            palSel[t2 * 3 + 2] = palLab[s3 + 2];
          }
          baseIdx = nearestIndices(vlab, m, palSel, selArr.length);
        }
      }

      /* ---- 4. 抖动 或 直接映射 ---- */
      if (dither) {
        var useSel = selArr;
        if (!useSel) {
          useSel = [];
          for (var u = 0; u < P; u++) useSel.push(u);
        }
        var palSel2 = new Float64Array(useSel.length * 3);
        for (var t3 = 0; t3 < useSel.length; t3++) {
          var s4 = useSel[t3] * 3;
          palSel2[t3 * 3] = palLab[s4];
          palSel2[t3 * 3 + 1] = palLab[s4 + 1];
          palSel2[t3 * 3 + 2] = palLab[s4 + 2];
        }
        var didx = floydSteinberg(lab, valid, gridW, gridH, palSel2);
        for (var v = 0; v < n; v++) {
          if (didx[v] >= 0) fullIdx[v] = useSel[didx[v]];
        }
      } else {
        for (var w2 = 0; w2 < m; w2++) {
          var bi = baseIdx[w2];
          fullIdx[vidx[w2]] = selArr ? selArr[bi] : bi;
        }
      }
    }

    /* ---- 5. 统计用量（按数量降序）---- */
    var counts = new Int32Array(P);
    var total = 0;
    for (var x2 = 0; x2 < n; x2++) {
      var fv = fullIdx[x2];
      if (fv >= 0) { counts[fv]++; total++; }
    }
    var used = [];
    for (var y2 = 0; y2 < P; y2++) if (counts[y2] > 0) used.push(y2);
    used.sort(function (a, b) {
      if (counts[b] !== counts[a]) return counts[b] - counts[a];
      return a - b;
    });

    var usage = used.map(function (pi) {
      return {
        code: colors[pi].code,
        name: colors[pi].name,
        hex: colors[pi].hex,
        count: counts[pi]
      };
    });

    /* ---- 6. 网格（色号二维数组，null = 不放豆子）---- */
    var grid = new Array(gridH);
    for (var gy = 0; gy < gridH; gy++) {
      var row = new Array(gridW);
      var ro = gy * gridW;
      for (var gx = 0; gx < gridW; gx++) {
        var gv = fullIdx[ro + gx];
        row[gx] = gv < 0 ? null : colors[gv].code;
      }
      grid[gy] = row;
    }

    return { grid: grid, usage: usage, totalBeads: total };
  }

  return {
    quantize: quantize,
    srgbToLabInto: srgbToLabInto,
    hexToRgb: hexToRgb
  };
});
