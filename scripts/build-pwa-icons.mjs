// dsh-pocket PWA 图标生成器（无第三方依赖：node:zlib 手写 PNG 编码器）
//
// 为什么自己画：仓库里没有品牌素材（docs/ 只有截图），DSH 的 favicon.svg 是复杂路径
// 图形，手工栅格化不现实。这里用几何图形生成一套"手机剪影"图标：蓝底 + 白色手机，
// 屏幕镂空露出底色 —— 与插件"把 DSH 装进口袋"的定位一致。
//
// 产物是**提交进仓库**的 PNG（assets/pwa/），安装态直接读盘即可，不需要在用户机器上
// 跑生成器。`--check` 只比对不写盘，测试用它证明仓库里的 PNG 与生成器一致（防止
// 改了画法却忘了重新生成）。
//
// 用法：
//   node scripts/build-pwa-icons.mjs           # 重新生成四个 PNG
//   node scripts/build-pwa-icons.mjs --check   # 只校验，过期/缺失时退出码 1

import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 目标目录：<包根>/assets/pwa/（随 package.json 的 files 一起发布）。 */
const OUT_DIR = fileURLToPath(new URL('../assets/pwa/', import.meta.url));

// ---------- 极简 PNG 编码（8bit RGBA，无交错） ----------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** @param {Uint8Array} rgba 长度必须是 width*height*4 */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  // 每扫描行前置 filter=0（None）：尺寸小、生成确定，不折腾更优过滤器。
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 形状与配色 ----------

/** 插件主色（与登录页按钮、设置页强调色一致）的竖向渐变。 */
const GRADIENT_TOP = [0x5b, 0x7c, 0xff];
const GRADIENT_BOTTOM = [0x3f, 0x57, 0xd6];
const WHITE = [0xff, 0xff, 0xff];

/** 圆角方形的内部判定：中心 (cx,cy)、半宽高 (hw,hh)、圆角半径 r，坐标 0..1。 */
function insideRoundRect(u, v, cx, cy, hw, hh, r) {
  const dx = Math.abs(u - cx) - (hw - r);
  const dy = Math.abs(v - cy) - (hh - r);
  if (dx <= 0 && dy <= 0) return true;
  const qx = Math.max(dx, 0);
  const qy = Math.max(dy, 0);
  return qx * qx + qy * qy <= r * r;
}

function gradientAt(v) {
  const t = Math.min(1, Math.max(0, v));
  return [
    Math.round(GRADIENT_TOP[0] + (GRADIENT_BOTTOM[0] - GRADIENT_TOP[0]) * t),
    Math.round(GRADIENT_TOP[1] + (GRADIENT_BOTTOM[1] - GRADIENT_TOP[1]) * t),
    Math.round(GRADIENT_TOP[2] + (GRADIENT_BOTTOM[2] - GRADIENT_TOP[2]) * t),
  ];
}

/**
 * 一个像素的颜色（未做抗锯齿：靠 4× 超采样平均出边缘）。
 * @param {number} u 归一化 x（0..1）
 * @param {number} v 归一化 y（0..1）
 * @param {{maskable:boolean}} opts maskable 走满幅底 + 内容缩到安全区
 * @returns {[number,number,number,number]}
 */
function samplePixel(u, v, { maskable }) {
  // maskable：整幅填满（由系统套遮罩），内容缩到 80% 安全圆内
  if (!maskable && !insideRoundRect(u, v, 0.5, 0.5, 0.5, 0.5, 0.22)) return [0, 0, 0, 0];

  let color = gradientAt(v);
  const k = maskable ? 0.72 : 1;
  const bodyHw = 0.21 * k;
  const bodyHh = 0.3 * k;
  const bodyR = 0.075 * k;
  if (insideRoundRect(u, v, 0.5, 0.5, bodyHw, bodyHh, bodyR)) {
    color = WHITE;
    // 屏幕镂空：露出底色渐变，形成"手机边框"
    if (insideRoundRect(u, v, 0.5, 0.5, bodyHw * 0.8, bodyHh * 0.86, bodyR * 0.5)) {
      color = gradientAt(v);
    }
  }
  return [color[0], color[1], color[2], 255];
}

/** 4× 超采样渲染（再盒式降采样），得到边缘平滑的 RGBA 缓冲。 */
function render(size, opts) {
  const SS = 4;
  const out = new Uint8Array(size * size * 4);
  const sums = new Float64Array(size * size * 4);
  for (let sy = 0; sy < size * SS; sy++) {
    const v = (sy + 0.5) / (size * SS);
    for (let sx = 0; sx < size * SS; sx++) {
      const u = (sx + 0.5) / (size * SS);
      const [r, g, b, a] = samplePixel(u, v, opts);
      // 预乘 alpha 再平均，避免透明边缘发黑
      const o = ((sy / SS) | 0) * size * 4 + (((sx / SS) | 0) * 4);
      sums[o] += r * a;
      sums[o + 1] += g * a;
      sums[o + 2] += b * a;
      sums[o + 3] += a;
    }
  }
  const n = SS * SS;
  for (let i = 0; i < size * size; i++) {
    // 颜色先按「预乘和 / alpha 和」还原（不是除以归一化后的 alpha：那会放大 n 倍）
    const sumA = sums[i * 4 + 3];
    if (sumA <= 0) continue; // 全透明像素保持 0,0,0,0
    out[i * 4] = Math.round(sums[i * 4] / sumA);
    out[i * 4 + 1] = Math.round(sums[i * 4 + 1] / sumA);
    out[i * 4 + 2] = Math.round(sums[i * 4 + 2] / sumA);
    out[i * 4 + 3] = Math.round(sumA / n);
  }
  return out;
}

/** 产物清单：名字 → {size, maskable}。apple-touch-icon 只要 180，iOS 会自己取整。 */
export const ICONS = Object.freeze({
  'icon-192.png': { size: 192, maskable: false },
  'icon-512.png': { size: 512, maskable: false },
  'maskable-512.png': { size: 512, maskable: true },
  'apple-touch-icon.png': { size: 180, maskable: false },
});

/** 生成全部图标（name → Buffer）。纯函数式，便于测试比对。 */
export function buildIcons() {
  const files = new Map();
  for (const [name, { size, maskable }] of Object.entries(ICONS)) {
    files.set(name, encodePng(size, size, render(size, { maskable })));
  }
  return files;
}

// ---------- CLI ----------

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const check = process.argv.includes('--check');
  const files = buildIcons();
  let drift = 0;
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, buf] of files) {
    const target = `${OUT_DIR}${name}`;
    if (check) {
      const same = existsSync(target) && readFileSync(target).equals(buf);
      if (!same) { drift += 1; console.error(`✗ ${name} 与生成器不一致（重跑 node scripts/build-pwa-icons.mjs）`); }
      else console.log(`✓ ${name} ${buf.length} B`);
    } else {
      writeFileSync(target, buf);
      console.log(`✓ ${name} ${buf.length} B`);
    }
  }
  if (check && drift > 0) process.exitCode = 1;
}
