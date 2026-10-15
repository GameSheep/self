import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');
const extDir = path.join(rootDir, 'extension');
const publicDir = path.join(rootDir, 'public');

// CRC32 implementation for standard PNG output
function crc32(buf) {
  let table = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ (-1)) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  const body = Buffer.concat([typeBuf, data]);
  crcBuf.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crcBuf]);
}

// 1. Generate Premium Vector SVG (for Web App, Favicon, README)
const brandSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="100%" height="100%">
  <defs>
    <!-- Background Gradient -->
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#181c24" />
      <stop offset="45%" stop-color="#0f1217" />
      <stop offset="100%" stop-color="#08090d" />
    </linearGradient>

    <!-- Neon Emerald to Cyan Flow -->
    <linearGradient id="neonGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#34d399" />
      <stop offset="50%" stop-color="#10b981" />
      <stop offset="100%" stop-color="#06b6d4" />
    </linearGradient>

    <!-- Core Glow Gradient -->
    <radialGradient id="coreGlow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#10b981" stop-opacity="0.35" />
      <stop offset="70%" stop-color="#06b6d4" stop-opacity="0.08" />
      <stop offset="100%" stop-color="#06b6d4" stop-opacity="0" />
    </radialGradient>

    <!-- Outer Glow Filter -->
    <filter id="softGlow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="16" result="blur" />
      <feComposite in="SourceGraphic" in2="blur" operator="over" />
    </filter>

    <filter id="innerBorder" x="0" y="0" width="512" height="512" filterUnits="userSpaceOnUse">
      <feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#000" flood-opacity="0.6" />
    </filter>
  </defs>

  <!-- Ambient Glow Behind Icon -->
  <circle cx="256" cy="256" r="210" fill="url(#coreGlow)" />

  <!-- Base Squircle Container -->
  <rect x="32" y="32" width="448" height="448" rx="112" ry="112" fill="url(#bgGrad)" stroke="rgba(255, 255, 255, 0.08)" stroke-width="4" filter="url(#innerBorder)" />

  <!-- Inner Subtle Accent Border -->
  <rect x="40" y="40" width="432" height="432" rx="104" ry="104" fill="none" stroke="rgba(16, 185, 129, 0.15)" stroke-width="2" />

  <!-- Central "S" Kinetic Monogram (Symbolizing Self-Hub: Data Stream & Security Vault) -->
  <g transform="translate(0, 0)" filter="url(#softGlow)">
    <!-- Top Arc Hook -->
    <path d="M 340 160 C 340 142 316 128 272 128 L 220 128 C 168 128 136 156 136 200 C 136 244 168 266 228 280 L 284 294 C 344 308 376 332 376 376 C 376 424 336 456 280 456 L 224 456 C 180 456 156 442 156 424" 
          fill="none" 
          stroke="url(#neonGrad)" 
          stroke-width="42" 
          stroke-linecap="round" 
          stroke-linejoin="round" />

    <!-- Center Radiant Hub Diamond (Point of Origin) -->
    <polygon points="256,228 284,256 256,284 228,256" fill="#ecfdf5" stroke="#10b981" stroke-width="6" />

    <!-- Top Left Accent Sparkle -->
    <circle cx="340" cy="160" r="10" fill="#a7f3d0" />
    <!-- Bottom Right Accent Sparkle -->
    <circle cx="156" cy="424" r="10" fill="#67e8f9" />
  </g>
</svg>`;

// Write SVG icons
fs.writeFileSync(path.join(publicDir, 'favicon.svg'), brandSvg);
fs.writeFileSync(path.join(extDir, 'icon.svg'), brandSvg);
console.log('✅ Generated public/favicon.svg & extension/icon.svg');

// 2. High-Precision Supersampled PNG Renderer (Anti-Aliased 4x SSAA)
function renderPng(size) {
  const width = size;
  const height = size;
  const ssaa = (size <= 48) ? 4 : 2; // 4x supersampling for crisp small icons
  const sWidth = width * ssaa;
  const sHeight = height * ssaa;

  const rawData = Buffer.alloc((width * 4 + 1) * height);

  // Compute bounding math on super-grid
  const sRadius = sWidth * 0.22;
  const sHalf = sWidth / 2;
  const sCx = sHalf;
  const sCy = sHalf;

  // Render to supersampled buffer first
  const sBuffer = Buffer.alloc(sWidth * sHeight * 4);

  for (let sy = 0; sy < sHeight; sy++) {
    const rowOffset = sy * sWidth * 4;
    const ny = sy / sHeight; // normalized 0..1

    for (let sx = 0; sx < sWidth; sx++) {
      const pxOffset = rowOffset + sx * 4;
      const nx = sx / sWidth;

      // Squircle check
      const dx = Math.abs(sx - (sHalf - 0.5));
      const dy = Math.abs(sy - (sHalf - 0.5));
      const r = sHalf - sRadius;

      let inBox = false;
      let distCorner = 0;
      if (dx <= r || dy <= r) {
        inBox = (dx <= sHalf && dy <= sHalf);
      } else {
        const cdx = dx - r;
        const cdy = dy - r;
        distCorner = cdx * cdx + cdy * cdy;
        inBox = (distCorner <= sRadius * sRadius);
      }

      if (!inBox) {
        // Transparent outside
        sBuffer[pxOffset] = 0;
        sBuffer[pxOffset + 1] = 0;
        sBuffer[pxOffset + 2] = 0;
        sBuffer[pxOffset + 3] = 0;
        continue;
      }

      // Base background: Obsidian Dark gradient
      let bgR = Math.round(24 - ny * 16);
      let bgG = Math.round(28 - ny * 18);
      let bgB = Math.round(36 - ny * 22);
      let bgA = 255;

      // Subtle Outer Rim Highlight (1px light border)
      const isRim = (dx >= sHalf - ssaa * 2 || dy >= sHalf - ssaa * 2 || (dx > r && dy > r && distCorner >= (sRadius - ssaa * 2) ** 2));
      if (isRim) {
        bgR = Math.min(255, bgR + 32);
        bgG = Math.min(255, bgG + 38);
        bgB = Math.min(255, bgB + 48);
      }

      // Stylized "S" curve math on unit square
      // Upper loop: center (0.5, 0.38), radius ~0.16
      // Lower loop: center (0.5, 0.62), radius ~0.16
      const ux = (sx - sCx) / (sWidth * 0.5); // -1 .. 1
      const uy = (sy - sCy) / (sHeight * 0.5); // -1 .. 1

      // Central Hub Core Glow
      const centerDist = Math.sqrt(ux * ux + uy * uy);
      if (centerDist < 0.65) {
        const glowFactor = Math.max(0, 1 - centerDist / 0.65);
        bgR = Math.round(bgR * (1 - glowFactor * 0.25) + 16 * glowFactor * 0.25);
        bgG = Math.round(bgG * (1 - glowFactor * 0.25) + 185 * glowFactor * 0.25);
        bgB = Math.round(bgB * (1 - glowFactor * 0.25) + 129 * glowFactor * 0.25);
      }

      // Draw Bold Dynamic "S" Geometry
      let isGlyph = false;
      const strokeW = 0.16;

      // Upper arch: y in [-0.55, -0.05]
      if (uy >= -0.52 && uy <= -0.02) {
        const arcY = uy + 0.27; // center at -0.27
        const arcR = Math.sqrt(ux * ux + arcY * arcY);
        // Half ring on top/left
        if (Math.abs(arcR - 0.26) <= strokeW / 2 && (ux <= 0.26 || uy < -0.35)) {
          isGlyph = true;
        }
      }

      // Lower arch: y in [0.02, 0.52]
      if (uy >= 0.02 && uy <= 0.52) {
        const arcY = uy - 0.27; // center at +0.27
        const arcR = Math.sqrt(ux * ux + arcY * arcY);
        // Half ring on bottom/right
        if (Math.abs(arcR - 0.26) <= strokeW / 2 && (ux >= -0.26 || uy > 0.35)) {
          isGlyph = true;
        }
      }

      // Diagonal connector through middle
      if (Math.abs(ux * 0.9 + uy * 1.1) <= strokeW * 0.65 && Math.abs(uy) <= 0.18) {
        isGlyph = true;
      }

      // Central Diamond Pivot
      const diamondDist = Math.abs(ux) + Math.abs(uy);
      const isDiamond = diamondDist <= 0.14;

      if (isDiamond) {
        // Bright white-mint core
        sBuffer[pxOffset] = 236;
        sBuffer[pxOffset + 1] = 253;
        sBuffer[pxOffset + 2] = 245;
        sBuffer[pxOffset + 3] = 255;
      } else if (isGlyph) {
        // Emerald to Cyan gradient
        const t = (uy + 0.5); // 0 (top) .. 1 (bottom)
        const gR = Math.round(52 * (1 - t) + 6 * t);
        const gG = Math.round(211 * (1 - t) + 182 * t);
        const gB = Math.round(153 * (1 - t) + 212 * t);
        sBuffer[pxOffset] = gR;
        sBuffer[pxOffset + 1] = gG;
        sBuffer[pxOffset + 2] = gB;
        sBuffer[pxOffset + 3] = 255;
      } else {
        sBuffer[pxOffset] = bgR;
        sBuffer[pxOffset + 1] = bgG;
        sBuffer[pxOffset + 2] = bgB;
        sBuffer[pxOffset + 3] = bgA;
      }
    }
  }

  // Downsample to target resolution with Box Filter (SSAA)
  const totalSub = ssaa * ssaa;
  const scanlineLength = width * 4 + 1;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * scanlineLength;
    rawData[rowOffset] = 0; // Filter None

    for (let x = 0; x < width; x++) {
      let sumR = 0, sumG = 0, sumB = 0, sumA = 0;

      for (let sy = 0; sy < ssaa; sy++) {
        for (let sx = 0; sx < ssaa; sx++) {
          const sOffset = ((y * ssaa + sy) * sWidth + (x * ssaa + sx)) * 4;
          const a = sBuffer[sOffset + 3] / 255;
          sumR += sBuffer[sOffset] * a;
          sumG += sBuffer[sOffset + 1] * a;
          sumB += sBuffer[sOffset + 2] * a;
          sumA += sBuffer[sOffset + 3];
        }
      }

      const avgA = sumA / totalSub;
      const targetOffset = rowOffset + 1 + x * 4;

      if (avgA > 0) {
        rawData[targetOffset] = Math.round(sumR / (sumA / 255));
        rawData[targetOffset + 1] = Math.round(sumG / (sumA / 255));
        rawData[targetOffset + 2] = Math.round(sumB / (sumA / 255));
        rawData[targetOffset + 3] = Math.round(avgA);
      } else {
        rawData[targetOffset] = 0;
        rawData[targetOffset + 1] = 0;
        rawData[targetOffset + 2] = 0;
        rawData[targetOffset + 3] = 0;
      }
    }
  }

  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(rawData);

  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

// Generate all target sizes
const sizes = [16, 48, 128, 512];
sizes.forEach(sz => {
  const buf = renderPng(sz);
  fs.writeFileSync(path.join(extDir, `icon${sz}.png`), buf);
  console.log(`✅ Generated extension/icon${sz}.png (${sz}x${sz}, ${(buf.length / 1024).toFixed(1)} KB)`);
});

// Also copy 512x512 and 128x128 into public/ for web app PWA & favicon
fs.writeFileSync(path.join(publicDir, 'icon-512.png'), renderPng(512));
fs.writeFileSync(path.join(publicDir, 'icon-128.png'), renderPng(128));
console.log('✅ Generated public/icon-512.png & public/icon-128.png');
