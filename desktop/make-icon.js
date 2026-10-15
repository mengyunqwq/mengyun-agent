'use strict';

/**
 * 梦云 Agent —— 图标生成器
 *
 * 为什么要有这个脚本，而不是直接放一张 png：
 *   图标要同时用于窗口、任务栏、打包后的 exe、以及网页 favicon，
 *   每种场景要的尺寸和格式都不一样（16/24/32/48/64/128/256）。
 *   手头没有 Photoshop，就干脆用代码画——好处是改个颜色重跑一遍就行，
 *   而且不需要引入任何图形库。
 *
 * 用法：
 *   node desktop/make-icon.js
 *
 * 产出：
 *   build/icon.png   1024×1024，源图（打包时 electron-builder 会用它生成各尺寸）
 *   build/icon.ico   多尺寸 ICO（16~256），Windows 窗口/任务栏/exe 用
 *
 * 设计：深色圆角方块 + 三个节点连线（青→紫渐变），配色取自界面的 :root。
 *       全部用几何图形，不依赖字体，所以在任何系统上渲染结果都一样。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const BUILD_DIR = path.join(ROOT, 'build');

/* ------------------------------------------------------------------ */
/* 配色（和 web/app.css 的 :root 保持一致）                            */
/* ------------------------------------------------------------------ */

const COLORS = {
  bgTop: [0x12, 0x18, 0x21], // 背景渐变起点
  bgBottom: [0x0a, 0x0e, 0x13], // 背景渐变终点
  edge: [0x2d, 0x38, 0x46], // 细边框
  accent: [0x38, 0xe0, 0xc8], // 青色（主色）
  violet: [0xa7, 0x8b, 0xfa], // 紫色（辅色）
};

/* ------------------------------------------------------------------ */
/* 位图                                                                */
/* ------------------------------------------------------------------ */

/**
 * 一张简单的 RGBA 位图。
 * 用 Float32 存颜色，方便叠加和高光计算，最后再转成 8 位。
 */
class Bitmap {
  constructor(size) {
    this.size = size;
    this.data = new Float64Array(size * size * 4); // r,g,b,a 都是 0..255
  }

  /** 写入一个像素（带 alpha 混合） */
  blend(x, y, [r, g, b], alpha = 1) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    if (alpha <= 0) return;
    const i = (y * this.size + x) * 4;
    const d = this.data;
    const a = Math.min(1, alpha);
    d[i] = d[i] * (1 - a) + r * a;
    d[i + 1] = d[i + 1] * (1 - a) + g * a;
    d[i + 2] = d[i + 2] * (1 - a) + b * a;
    d[i + 3] = Math.min(255, d[i + 3] + 255 * a);
  }

  /** 直接设值（不做混合） */
  set(x, y, [r, g, b], a = 255) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    const i = (y * this.size + x) * 4;
    this.data[i] = r;
    this.data[i + 1] = g;
    this.data[i + 2] = b;
    this.data[i + 3] = a;
  }

  /** 转成 PNG 需要的 RGBA Buffer */
  toRGBA() {
    const buf = Buffer.alloc(this.size * this.size * 4);
    for (let i = 0; i < buf.length; i += 1) {
      buf[i] = Math.max(0, Math.min(255, Math.round(this.data[i])));
    }
    return buf;
  }
}

/* ------------------------------------------------------------------ */
/* 绘图原语（用 4x4 超采样做抗锯齿）                                    */
/* ------------------------------------------------------------------ */

const SS = 4; // 超采样倍数：每个像素取 4×4 个样本

/**
 * 通用绘制：把形状描述成一个「判断点在不在形状内」的函数，
 * 然后用超采样算出每个像素的覆盖率，得到平滑边缘。
 *
 * @param {Bitmap} bmp
 * @param {(x:number,y:number)=>boolean} inside 点在形状内吗
 * @param {(x:number,y:number)=>number[]} colorFn 该点用什么颜色（可做渐变）
 * @param {(x:number,y:number)=>number} [alphaFn] 该点的不透明度 0..1
 * @param {object} [box] 限定重绘范围，省时间
 */
function drawShape(bmp, inside, colorFn, alphaFn = () => 1, box = null) {
  const size = bmp.size;
  const x0 = box ? Math.max(0, Math.floor(box.x0)) : 0;
  const y0 = box ? Math.max(0, Math.floor(box.y0)) : 0;
  const x1 = box ? Math.min(size, Math.ceil(box.x1)) : size;
  const y1 = box ? Math.min(size, Math.ceil(box.y1)) : size;

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      let hits = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      let aSum = 0;

      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (!inside(px, py)) continue;
          hits += 1;
          const c = colorFn(px, py);
          const a = alphaFn(px, py);
          r += c[0] * a;
          g += c[1] * a;
          b += c[2] * a;
          aSum += a;
        }
      }

      if (!hits) continue;
      const coverage = hits / (SS * SS);
      const avgAlpha = aSum / hits;
      // 颜色按带权平均，覆盖率决定整体不透明度
      bmp.blend(x, y, [r / (aSum || 1), g / (aSum || 1), b / (aSum || 1)], coverage * avgAlpha);
    }
  }
}

/** 圆角矩形 */
function roundRectPath(x0, y0, x1, y1, radius) {
  const r = Math.max(0, Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2));
  return (px, py) => {
    if (px < x0 || px > x1 || py < y0 || py > y1) return false;
    // 四个角单独判断
    const cx = px < x0 + r ? x0 + r : px > x1 - r ? x1 - r : px;
    const cy = py < y0 + r ? y0 + r : py > y1 - r ? y1 - r : py;
    if (cx === px || cy === py) return true;
    return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
  };
}

/** 线段（带圆头） */
function linePath(ax, ay, bx, by, width) {
  const half = width / 2;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  return (px, py) => {
    let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    return (px - cx) ** 2 + (py - cy) ** 2 <= half * half;
  };
}

/** 圆 */
function circlePath(cx, cy, r) {
  return (px, py) => (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

/** 两点之间按比例取色（做渐变） */
function mixColor(c1, c2, t) {
  const k = Math.max(0, Math.min(1, t));
  return [
    c1[0] + (c2[0] - c1[0]) * k,
    c1[1] + (c2[1] - c1[1]) * k,
    c1[2] + (c2[2] - c1[2]) * k,
  ];
}

/* ------------------------------------------------------------------ */
/* 画图标                                                              */
/* ------------------------------------------------------------------ */

/**
 * 在给定尺寸上渲染图标。
 * @param {number} size 边长（正方形）
 * @returns {Bitmap}
 */
function renderIcon(size) {
  const bmp = new Bitmap(size);
  // 以 1024 为设计基准，其他尺寸等比缩放
  const u = size / 1024;
  const px = (v) => v * u;

  /* ---- 1. 背景：深色圆角方块 + 从上到下的微渐变 ---- */
  const pad = px(8);
  const radius = px(224);
  const bg = roundRectPath(pad, pad, size - pad, size - pad, radius);
  drawShape(
    bmp,
    bg,
    (_x, y) => mixColor(COLORS.bgTop, COLORS.bgBottom, (y - pad) / (size - pad * 2)),
    () => 1,
    { x0: 0, y0: 0, x1: size, y1: size },
  );

  /* ---- 2. 细边框：让图标在浅色背景上也有轮廓 ---- */
  const outer = roundRectPath(pad, pad, size - pad, size - pad, radius);
  const inner = roundRectPath(pad + px(6), pad + px(6), size - px(14), size - px(14), radius - px(6));
  drawShape(bmp, (x, y) => outer(x, y) && !inner(x, y), () => COLORS.edge, () => 0.9, {
    x0: 0,
    y0: 0,
    x1: size,
    y1: size,
  });

  /* ---- 3. 三个节点 + 连线：表达「多个工具围绕一个智能体协作」 ---- */
  // 坐标（1024 基准）：上面一个，下面两个，构成稳定的三角形。
  // 整体做得饱满一些——图标在小尺寸（16/32）下主体太小会看不清。
  // 垂直位置刻意上调一点：下方两个节点带高光会显得更「重」，视觉重心要补偿。
  const top = { x: px(512), y: px(318), r: px(112) };
  const left = { x: px(308), y: px(652), r: px(112) };
  const right = { x: px(716), y: px(652), r: px(112) };

  const lineWidth = px(54);
  const linkColor = mixColor(COLORS.accent, COLORS.violet, 0.5);

  // 连线（先画线，节点再盖上去）
  const linkBox = (a, b, pad) => ({
    x0: Math.min(a.x, b.x) - pad,
    y0: Math.min(a.y, b.y) - pad,
    x1: Math.max(a.x, b.x) + pad,
    y1: Math.max(a.y, b.y) + pad,
  });
  const links = [
    [top, left],
    [top, right],
    [left, right],
  ];
  for (const [a, b] of links) {
    drawShape(bmp, linePath(a.x, a.y, b.x, b.y, lineWidth), () => linkColor, () => 0.92, linkBox(a, b, px(80)));
  }

  // 节点：上紫下青。不再用粗描边圈——那会让节点看起来和连线断开
  const nodes = [
    { pos: top, c1: mixColor(COLORS.violet, [255, 255, 255], 0.42), c2: mixColor(COLORS.violet, [0, 0, 0], 0.22) },
    { pos: left, c1: mixColor(COLORS.accent, [255, 255, 255], 0.42), c2: mixColor(COLORS.accent, [0, 0, 0], 0.28) },
    { pos: right, c1: mixColor(COLORS.accent, [255, 255, 255], 0.42), c2: mixColor(COLORS.accent, [0, 0, 0], 0.28) },
  ];

  for (const { pos, c1, c2 } of nodes) {
    // 节点底下垫一圈背景色，做出「节点压在连线上」的层次，同时也算个细描边
    drawShape(bmp, circlePath(pos.x, pos.y, pos.r + px(16)), () => COLORS.bgBottom, () => 1, {
      x0: pos.x - pos.r - px(20),
      y0: pos.y - pos.r - px(20),
      x1: pos.x + pos.r + px(20),
      y1: pos.y + pos.r + px(20),
    });
    // 节点本体：从上到下的渐变
    drawShape(
      bmp,
      circlePath(pos.x, pos.y, pos.r),
      (_x, y) => mixColor(c1, c2, (y - (pos.y - pos.r)) / (pos.r * 2)),
      () => 1,
      { x0: pos.x - pos.r - 2, y0: pos.y - pos.r - 2, x1: pos.x + pos.r + 2, y1: pos.y + pos.r + 2 },
    );
    // 高光（偏左上），小尺寸下也能看出球体感
    drawShape(
      bmp,
      circlePath(pos.x - pos.r * 0.3, pos.y - pos.r * 0.34, pos.r * 0.32),
      () => [255, 255, 255],
      () => 0.6,
      { x0: pos.x - pos.r, y0: pos.y - pos.r, x1: pos.x + pos.r, y1: pos.y + pos.r },
    );
  }

  return bmp;
}

/* ------------------------------------------------------------------ */
/* PNG 编码（手写，零依赖）                                             */
/* ------------------------------------------------------------------ */

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 把 RGBA 像素编码成 PNG */
function encodePng(rgba, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // 每行的滤波器类型：0 = None
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型：RGBA
  ihdr[10] = 0; // 压缩方法
  ihdr[11] = 0; // 滤波方法
  ihdr[12] = 0; // 隔行扫描：无

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* ICO 编码（多尺寸）                                                   */
/* ------------------------------------------------------------------ */

/**
 * 把多张 PNG 打包成 ICO。
 *
 * ICO 里的每一项可以是 BMP，也可以直接嵌 PNG（Vista 以后都支持）。
 * 32×32 以上用 PNG 体积小很多；16/24 这种小尺寸用 BMP 更保险
 * ——有些老程序的图标读取代码对 PNG 支持不全。
 */
function encodeIco(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // 保留
  header.writeUInt16LE(1, 2); // 类型：1 = 图标
  header.writeUInt16LE(count, 4);

  const entries = Buffer.alloc(16 * count);
  const blobs = [];
  let offset = 6 + 16 * count;

  images.forEach((img, i) => {
    const entry = 16 * i;
    // 尺寸 256 在 ICO 里记为 0
    entries.writeUInt8(img.size >= 256 ? 0 : img.size, entry);
    entries.writeUInt8(img.size >= 256 ? 0 : img.size, entry + 1);
    entries.writeUInt8(0, entry + 2); // 调色板数
    entries.writeUInt8(0, entry + 3); // 保留
    entries.writeUInt16LE(1, entry + 4); // 颜色平面
    entries.writeUInt16LE(32, entry + 6); // 位深
    entries.writeUInt32LE(img.data.length, entry + 8);
    entries.writeUInt32LE(offset, entry + 12);
    offset += img.data.length;
    blobs.push(img.data);
  });

  return Buffer.concat([header, entries, ...blobs]);
}

/**
 * 把位图编码成 ICO 内嵌的 BMP（BITMAPINFOHEADER + BGRA + AND 掩码）。
 * 小尺寸用它兼容性最好。
 */
function encodeIcoBmp(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // 头大小
  header.writeInt32LE(size, 4); // 宽
  header.writeInt32LE(size * 2, 8); // 高：ICO 里要写两倍（含 AND 掩码）
  header.writeUInt16LE(1, 12); // 平面数
  header.writeUInt16LE(32, 14); // 位深
  header.writeUInt32LE(0, 16); // 压缩：无
  header.writeUInt32LE(size * size * 4, 20); // 图像数据大小
  header.writeInt32LE(0, 24);
  header.writeInt32LE(0, 28);
  header.writeUInt32LE(0, 32);
  header.writeUInt32LE(0, 36);

  // 像素：ICO 的 BMP 是「自下而上」存的，而且通道顺序是 BGRA
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const srcY = size - 1 - y;
    for (let x = 0; x < size; x += 1) {
      const s = (srcY * size + x) * 4;
      const d = (y * size + x) * 4;
      pixels[d] = rgba[s + 2]; // B
      pixels[d + 1] = rgba[s + 1]; // G
      pixels[d + 2] = rgba[s]; // R
      pixels[d + 3] = rgba[s + 3]; // A
    }
  }

  // AND 掩码：每行按 4 字节对齐，全 0 表示「不透明」（现代 Windows 用 alpha 通道）
  const maskRow = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRow * size);

  return Buffer.concat([header, pixels, mask]);
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

function main() {
  console.log('\n\x1b[1m\x1b[35m生成应用图标\x1b[0m\n');

  fs.mkdirSync(BUILD_DIR, { recursive: true });

  // 1) 源图：1024×1024
  const master = renderIcon(1024);
  const masterPng = encodePng(master.toRGBA(), 1024, 1024);
  const masterPath = path.join(BUILD_DIR, 'icon.png');
  fs.writeFileSync(masterPath, masterPng);
  console.log(`  \x1b[32m✓\x1b[0m build/icon.png   1024×1024  ${(masterPng.length / 1024).toFixed(1)} KB`);

  // 2) ICO：小尺寸用 BMP，大尺寸用 PNG
  const sizes = ICO_SIZES;
  const images = sizes.map((size) => {
    const bmp = renderIcon(size);
    const rgba = bmp.toRGBA();
    const usePng = size >= 48;
    return {
      size,
      data: usePng ? encodePng(rgba, size, size) : encodeIcoBmp(rgba, size),
      kind: usePng ? 'PNG' : 'BMP',
    };
  });

  const ico = encodeIco(images);
  const icoPath = path.join(BUILD_DIR, 'icon.ico');
  fs.writeFileSync(icoPath, ico);
  console.log(`  \x1b[32m✓\x1b[0m build/icon.ico   ${sizes.join('/')}  ${(ico.length / 1024).toFixed(1)} KB`);

  // 3) 顺带给网页做个 favicon（浏览器标签页用）
  const webDir = path.join(ROOT, 'web');
  if (fs.existsSync(webDir)) {
    fs.writeFileSync(path.join(webDir, 'icon.png'), encodePng(renderIcon(256).toRGBA(), 256, 256));
    console.log('  \x1b[32m✓\x1b[0m web/icon.png    256×256（网页头部图标）');
  }

  console.log('');
  console.log('  打包时 electron-builder 会自动读取 build/icon.ico。');
  console.log('  改配色就改本文件顶部的 COLORS，然后重跑一遍。');
  console.log('');
}

/** ICO 里包含哪些尺寸。16/24/32/48 覆盖任务栏和列表视图，256 给大图标视图 */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

// 直接运行时才生成文件；被 require 时只导出函数（测试要用）
if (require.main === module) {
  main();
}

module.exports = {
  renderIcon,
  encodePng,
  encodeIco,
  encodeIcoBmp,
  crc32,
  Bitmap,
  ICO_SIZES,
  COLORS,
  roundRectPath,
  linePath,
  circlePath,
  mixColor,
};
