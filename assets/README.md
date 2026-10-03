# assets 说明

所有图片为真实项目的过程产物截图/对比图，来源路径均为原工作区 `.tooling/` 目录下的原始文件（本仓库做了重命名，未做任何图像内容修改）。

| 文件 | 用途 | 原始文件 |
|---|---|---|
| `01_generated_result.png` | 纯静态版完整功能形态：上传 → 生成 → 分块+全景导出（图中可见参数：色卡 Artkal · 400×400 · 用色 51 种 · 共 160000 颗 · 原图 200x200 · 321ms） | `.tooling/out_static/1_static_generated.png` |
| `02_dither_chroma_before.png` | 抖动缺陷修复前：色度误差全额扩散，灰区出现紫/蓝/粉零星异色点 | `.tooling/diag_out/e2e_before_scale100.png` |
| `03_dither_chroma_after.png` | 抖动缺陷修复后：色度误差按源像素饱和度自适应衰减，异色点消失 | `.tooling/diag_out/e2e_after_scale025.png` |
| `04_no_worker_fallback.png` | Web Worker 不可用时自动回退主线程计算的兜底形态（图中可见耗时 224ms，功能完整） | `.tooling/out_static/4_fallback_no_worker.png` |
| `05_mobile_375px.png` | 手机 375px 视口下的布局与导出指引 | `.tooling/out_static/3_static_375.png` |
| `06_mobile_export.png` | 手机端导出结果区：按设备分路的「长按图片 → 保存到相册」指引 | `.tooling/out_static/5_mobile_export.png` |
| `07_dither_chroma_scale_0.png` | 四组对照实验之一：色度衰减系数 = 0（完全衰减） | `.tooling/diag_out/dither_cs000.png` |
| `08_dither_chroma_scale_100.png` | 四组对照实验之一：色度衰减系数 = 1（不衰减，对照组） | `.tooling/diag_out/dither_cs100.png` |

> 说明：原目录中另有一张反馈弹窗截图未收录进本仓库（含联系邮箱，按脱敏要求排除）。

> 注 1：`02_dither_chroma_before.png` 与 `08_dither_chroma_scale_100.png` **源自同一张渲染结果**（色度衰减系数 = 1 即「不衰减」，在语义上等同于修复前状态），因用途不同各存一份，md5 相同属预期，不是重复收录错误。

> 注 2：图中可见的参数（01 图 `321ms` / 51 种 / 160000 颗，04 图 `224ms`）为**当时运行的实测快照，无独立文本留档**。其中 400×400 = 160000 颗为算术必然；耗时数字每次运行都会变化，**不作为性能指标引用**。
