#!/usr/bin/env node
/* PWA 아이콘 생성 — 의존성 0 (Node 내장 zlib로 PNG 인코딩)
 * 사용: node scripts/make-icons.js  → client/icons/ 에 PNG/SVG 생성 */
'use strict';
var zlib = require('zlib');
var fs = require('fs');
var path = require('path');

// ---------- PNG 인코더 ----------
var CRC_TABLE = (function () {
  var t = new Int32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  var c = 0xFFFFFFFF;
  for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  var len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  var td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  var crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgba) {
  var sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  var raw = Buffer.alloc(h * (1 + w * 4));
  for (var y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0; // 필터 없음
    rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
  }
  var idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- 그리기 (정규화 좌표, 2x 슈퍼샘플) ----------
function lerp(a, b, t) { return a + (b - a) * t; }
function inRoundRect(x, y, cx, cy, hw, hh, r) {
  var dx = Math.abs(x - cx) - (hw - r);
  var dy = Math.abs(y - cy) - (hh - r);
  if (dx > r || dy > r) return false;
  if (dx <= 0 || dy <= 0) return true;
  return dx * dx + dy * dy <= r * r;
}
function inHeart(x, y, cx, cy, s) {
  var nx = (x - cx) / s, ny = -(y - cy) / s + 0.18;
  var a = nx * nx + ny * ny - 1;
  return a * a * a - nx * nx * ny * ny * ny <= 0;
}
// 픽셀 색 (u,v: 0~1)
function pixel(u, v) {
  // 배경: 펠트 그린 그라데이션 (마스커블 대비 풀블리드)
  var t = Math.min(1, Math.hypot(u - 0.5, v - 0.38) * 1.5);
  var bg = [Math.round(lerp(0x22, 0x0e, t)), Math.round(lerp(0x6b, 0x2c, t)), Math.round(lerp(0x4a, 0x1f, t)), 255];
  // 뒤 카드 (살짝 어긋난 회색)
  if (inRoundRect(u, v, 0.565, 0.535, 0.205, 0.295, 0.05)) bg = [0xc9, 0xc4, 0xb2, 255];
  // 앞 카드 (흰색)
  if (inRoundRect(u, v, 0.465, 0.475, 0.21, 0.30, 0.05)) {
    bg = [0xfc, 0xfb, 0xf4, 255];
    if (inHeart(u, v, 0.465, 0.46, 0.135)) bg = [0xd0, 0x35, 0x35, 255];
  }
  return bg;
}
function renderIcon(size) {
  var rgba = Buffer.alloc(size * size * 4);
  var SS = 2; // 슈퍼샘플
  for (var y = 0; y < size; y++) {
    for (var x = 0; x < size; x++) {
      var r = 0, g = 0, b = 0;
      for (var sy = 0; sy < SS; sy++) {
        for (var sx = 0; sx < SS; sx++) {
          var c = pixel((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      var o = (y * size + x) * 4;
      rgba[o] = Math.round(r / (SS * SS));
      rgba[o + 1] = Math.round(g / (SS * SS));
      rgba[o + 2] = Math.round(b / (SS * SS));
      rgba[o + 3] = 255;
    }
  }
  return encodePNG(size, size, rgba);
}

// ---------- SVG (파비콘/매니페스트 보조) ----------
var SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<defs><radialGradient id="g" cx="50%" cy="38%" r="75%">' +
  '<stop offset="0%" stop-color="#226b4a"/><stop offset="100%" stop-color="#0e2c1f"/></radialGradient></defs>' +
  '<rect width="100" height="100" rx="18" fill="url(#g)"/>' +
  '<rect x="36" y="24" width="41" height="59" rx="5" fill="#c9c4b2" transform="rotate(6 56.5 53.5)"/>' +
  '<rect x="25.5" y="17.5" width="42" height="60" rx="5" fill="#fcfbf4"/>' +
  '<path d="M46.5 65 C30 52 33 36 43 36 C47 36 46.5 40 46.5 40 C46.5 40 46 36 50 36 C60 36 63 52 46.5 65 Z" fill="#d03535"/>' +
  '</svg>\n';

var outDir = path.join(__dirname, '..', 'client', 'icons');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon-512.png'), renderIcon(512));
fs.writeFileSync(path.join(outDir, 'icon-192.png'), renderIcon(192));
fs.writeFileSync(path.join(outDir, 'apple-touch-icon.png'), renderIcon(180));
fs.writeFileSync(path.join(outDir, 'icon.svg'), SVG);
console.log('아이콘 생성 완료:', outDir);
