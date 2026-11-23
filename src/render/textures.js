import * as THREE from 'three';
import { mulberry32, fbm2D, clamp, lerp } from '../core/prng.js';

function makeCanvas(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return { canvas, ctx: canvas.getContext('2d') };
}

function finalizeTexture(canvas, { repeat = false, srgb = true, anisotropy = 8 } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

// Tileable 2D value noise helper on [0, size)
function tileNoise(u, v, freq, seed) {
  const x = u * freq;
  const y = v * freq;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);

  const hash = (a, b) => {
    const wa = ((a % freq) + freq) % freq;
    const wb = ((b % freq) + freq) % freq;
    let h = (wa * 374761393 + wb * 668265263 + seed * 1442695041) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    h = h ^ (h >>> 16);
    return (h >>> 0) / 4294967296;
  };

  const n00 = hash(ix, iy);
  const n10 = hash(ix + 1, iy);
  const n01 = hash(ix, iy + 1);
  const n11 = hash(ix + 1, iy + 1);
  return lerp(lerp(n00, n10, sx), lerp(n01, n11, sx), sy);
}

function tileFbm(u, v, baseFreq, octaves, seed) {
  let val = 0;
  let amp = 0.5;
  let norm = 0;
  let f = baseFreq;
  for (let i = 0; i < octaves; i++) {
    val += tileNoise(u, v, f, seed + i * 73) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return val / norm;
}

function createTerrainTextures(anisotropy) {
  const size = 256;
  const { canvas: cCol, ctx: ctxCol } = makeCanvas(size, size);
  const { canvas: cBump, ctx: ctxBump } = makeCanvas(size, size);
  const { canvas: cRough, ctx: ctxRough } = makeCanvas(size, size);

  const imgCol = ctxCol.createImageData(size, size);
  const imgBump = ctxBump.createImageData(size, size);
  const imgRough = ctxRough.createImageData(size, size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const nMacro = tileFbm(u, v, 6, 4, 101);
      const nMicro = tileFbm(u, v, 24, 3, 211);
      const grain = nMacro * 0.55 + nMicro * 0.45;

      // Neutral-bright multiplier so vertex biome colors stay vivid while gaining crisp soil/moss texture
      const shade = Math.round(lerp(178, 252, grain));
      const warm = Math.round(lerp(172, 248, grain));
      const cool = Math.round(lerp(164, 240, grain));

      const idx = (y * size + x) * 4;
      imgCol.data[idx] = shade;
      imgCol.data[idx + 1] = warm;
      imgCol.data[idx + 2] = cool;
      imgCol.data[idx + 3] = 255;

      const bVal = Math.round(clamp(grain * 255, 0, 255));
      imgBump.data[idx] = bVal;
      imgBump.data[idx + 1] = bVal;
      imgBump.data[idx + 2] = bVal;
      imgBump.data[idx + 3] = 255;

      const rVal = Math.round(lerp(205, 250, 1 - nMicro));
      imgRough.data[idx] = rVal;
      imgRough.data[idx + 1] = rVal;
      imgRough.data[idx + 2] = rVal;
      imgRough.data[idx + 3] = 255;
    }
  }

  ctxCol.putImageData(imgCol, 0, 0);
  ctxBump.putImageData(imgBump, 0, 0);
  ctxRough.putImageData(imgRough, 0, 0);

  const terrainColor = finalizeTexture(cCol, { repeat: true, srgb: true, anisotropy });
  const terrainBump = finalizeTexture(cBump, { repeat: true, srgb: false, anisotropy });
  const terrainRoughness = finalizeTexture(cRough, { repeat: true, srgb: false, anisotropy });

  terrainColor.repeat.set(16, 16);
  terrainBump.repeat.set(16, 16);
  terrainRoughness.repeat.set(16, 16);

  return { terrainColor, terrainBump, terrainRoughness };
}

function createDryStoneTextures(anisotropy) {
  const size = 256;
  const { canvas: cCol, ctx: ctxCol } = makeCanvas(size, size);
  const { canvas: cBump, ctx: ctxBump } = makeCanvas(size, size);
  const rng = mulberry32(17449);

  // Dark peat/mortar crevices
  ctxCol.fillStyle = '#252421';
  ctxCol.fillRect(0, 0, size, size);
  ctxBump.fillStyle = '#181818';
  ctxBump.fillRect(0, 0, size, size);

  const rows = 9;
  const rowH = size / rows;
  for (let r = 0; r < rows; r++) {
    let x = -rng() * 18;
    const y = r * rowH;
    while (x < size) {
      const w = 24 + rng() * 32;
      const h = rowH - 3 - rng() * 2.5;
      const base = 78 + rng() * 54;
      const tintR = Math.round(base + (rng() - 0.4) * 14);
      const tintG = Math.round(base + (rng() - 0.45) * 12);
      const tintB = Math.round(base + (rng() - 0.5) * 16);

      const drawStone = (ox) => {
        ctxCol.fillStyle = `rgb(${tintR},${tintG},${tintB})`;
        ctxCol.beginPath();
        ctxCol.roundRect(ox + 1.5, y + 1.5, w - 3, h, 4);
        ctxCol.fill();

        // Subtle Highland lichen & moss fleck
        if (rng() > 0.62) {
          ctxCol.fillStyle = rng() > 0.5 ? 'rgba(92, 114, 72, 0.35)' : 'rgba(148, 152, 128, 0.25)';
          ctxCol.fillRect(ox + 4, y + 3, w * 0.45, h * 0.45);
        }

        const b = Math.round(150 + rng() * 95);
        ctxBump.fillStyle = `rgb(${b},${b},${b})`;
        ctxBump.beginPath();
        ctxBump.roundRect(ox + 2, y + 2, w - 4, h - 1, 4);
        ctxBump.fill();
      };

      drawStone(x);
      if (x + w > size) drawStone(x - size);
      x += w;
    }
  }

  const stoneColor = finalizeTexture(cCol, { repeat: true, srgb: true, anisotropy });
  const stoneBump = finalizeTexture(cBump, { repeat: true, srgb: false, anisotropy });
  stoneColor.repeat.set(2, 1.5);
  stoneBump.repeat.set(2, 1.5);
  return { stoneColor, stoneBump };
}

function createThatchTextures(anisotropy) {
  const size = 256;
  const { canvas: cCol, ctx: ctxCol } = makeCanvas(size, size);
  const { canvas: cBump, ctx: ctxBump } = makeCanvas(size, size);
  const rng = mulberry32(4417);

  ctxCol.fillStyle = '#3c3a25';
  ctxCol.fillRect(0, 0, size, size);
  ctxBump.fillStyle = '#404040';
  ctxBump.fillRect(0, 0, size, size);

  for (let i = 0; i < 1600; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const len = 10 + rng() * 24;
    const moss = rng() > 0.68;
    ctxCol.strokeStyle = moss
      ? `rgba(${56 + Math.round(rng() * 30)}, ${74 + Math.round(rng() * 34)}, ${36 + Math.round(rng() * 18)}, 0.7)`
      : `rgba(${88 + Math.round(rng() * 44)}, ${76 + Math.round(rng() * 32)}, ${46 + Math.round(rng() * 22)}, 0.7)`;
    ctxCol.lineWidth = 1.4 + rng() * 1.4;
    ctxCol.beginPath();
    ctxCol.moveTo(x, y);
    ctxCol.lineTo(x + (rng() - 0.5) * 4, y + len);
    ctxCol.stroke();

    const bv = Math.round(100 + rng() * 140);
    ctxBump.strokeStyle = `rgb(${bv},${bv},${bv})`;
    ctxBump.lineWidth = 1.6;
    ctxBump.beginPath();
    ctxBump.moveTo(x, y);
    ctxBump.lineTo(x, y + len);
    ctxBump.stroke();
  }

  const thatchColor = finalizeTexture(cCol, { repeat: true, srgb: true, anisotropy });
  const thatchBump = finalizeTexture(cBump, { repeat: true, srgb: false, anisotropy });
  thatchColor.repeat.set(3, 3);
  thatchBump.repeat.set(3, 3);
  return { thatchColor, thatchBump };
}

function createBarkTextures(anisotropy) {
  const size = 256;
  const { canvas: cCol, ctx: ctxCol } = makeCanvas(size, size);
  const { canvas: cBump, ctx: ctxBump } = makeCanvas(size, size);
  const rng = mulberry32(9917);

  ctxCol.fillStyle = '#473024';
  ctxCol.fillRect(0, 0, size, size);
  ctxBump.fillStyle = '#303030';
  ctxBump.fillRect(0, 0, size, size);

  // Scots pine fissured reddish-brown bark plates
  for (let i = 0; i < 480; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const w = 3 + rng() * 9;
    const h = 18 + rng() * 46;
    const r = 74 + Math.round(rng() * 48);
    const g = 46 + Math.round(rng() * 28);
    const b = 34 + Math.round(rng() * 20);
    ctxCol.fillStyle = `rgba(${r},${g},${b},0.85)`;
    ctxCol.fillRect(x, y, w, h);

    const bv = Math.round(120 + rng() * 120);
    ctxBump.fillStyle = `rgb(${bv},${bv},${bv})`;
    ctxBump.fillRect(x, y, w - 1, h);
  }

  const barkColor = finalizeTexture(cCol, { repeat: true, srgb: true, anisotropy });
  const barkBump = finalizeTexture(cBump, { repeat: true, srgb: false, anisotropy });
  barkColor.repeat.set(1, 3);
  barkBump.repeat.set(1, 3);
  return { barkColor, barkBump };
}

function createPineBoughTexture(anisotropy) {
  const size = 256;
  const { canvas, ctx } = makeCanvas(size, size);
  const rng = mulberry32(7731);

  ctx.clearRect(0, 0, size, size);

  // Radial organic Scots pine needle sprays with daylight gaps
  const cx = size * 0.5;
  const cy = size * 0.5;

  // Woody inner twigs
  ctx.strokeStyle = '#4b3424';
  ctx.lineWidth = 4;
  for (let b = 0; b < 7; b++) {
    const ang = (b / 7) * Math.PI * 2 + rng() * 0.4;
    const len = 68 + rng() * 34;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(ang) * len, cy + Math.sin(ang) * len);
    ctx.stroke();
  }

  // Dense layered needles
  for (let i = 0; i < 1100; i++) {
    const r = Math.pow(rng(), 0.65) * 108;
    const ang = rng() * Math.PI * 2;
    const px = cx + Math.cos(ang) * r;
    const py = cy + Math.sin(ang) * r;

    const tipLight = clamp(r / 108, 0, 1);
    const red = Math.round(lerp(24, 52, tipLight) + (rng() - 0.5) * 14);
    const grn = Math.round(lerp(46, 86, tipLight) + (rng() - 0.5) * 20);
    const blu = Math.round(lerp(28, 48, tipLight) + (rng() - 0.5) * 12);

    ctx.strokeStyle = `rgb(${red},${grn},${blu})`;
    ctx.lineWidth = 2.2;
    const nAng = ang + (rng() - 0.5) * 1.1;
    const nLen = 10 + rng() * 14;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + Math.cos(nAng) * nLen, py + Math.sin(nAng) * nLen);
    ctx.stroke();
  }

  return finalizeTexture(canvas, { repeat: false, srgb: true, anisotropy });
}

function createGrassTuftTexture(anisotropy) {
  const size = 256;
  const { canvas, ctx } = makeCanvas(size, size);
  const rng = mulberry32(5512);

  ctx.clearRect(0, 0, size, size);

  // 34 curved Highland sedge & moor grass blades rising from bottom center
  for (let i = 0; i < 38; i++) {
    const startX = size * 0.14 + rng() * size * 0.72;
    const h = size * (0.48 + rng() * 0.46);
    const lean = (rng() - 0.5) * 76;
    const dryTip = rng() > 0.62;

    const grad = ctx.createLinearGradient(startX, size, startX + lean, size - h);
    grad.addColorStop(0, '#23361b');
    grad.addColorStop(0.55, dryTip ? '#5d6b34' : '#3d632c');
    grad.addColorStop(1, dryTip ? '#96874a' : '#6f8d42');

    ctx.strokeStyle = grad;
    ctx.lineWidth = 4.5 + rng() * 3.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(startX, size + 4);
    ctx.quadraticCurveTo(startX + lean * 0.35, size - h * 0.58, startX + lean, size - h);
    ctx.stroke();
  }

  return finalizeTexture(canvas, { repeat: false, srgb: true, anisotropy });
}

function createHeatherTuftTexture(anisotropy) {
  const size = 256;
  const { canvas, ctx } = makeCanvas(size, size);
  const rng = mulberry32(8834);

  ctx.clearRect(0, 0, size, size);

  // Woody heather stems + dense clusters of 1744 purple-pink Highland bell heather blossoms
  for (let i = 0; i < 28; i++) {
    const sx = size * 0.18 + rng() * size * 0.64;
    const h = size * (0.45 + rng() * 0.45);
    const lean = (rng() - 0.5) * 70;

    ctx.strokeStyle = '#334023';
    ctx.lineWidth = 4.2;
    ctx.beginPath();
    ctx.moveTo(sx, size + 2);
    ctx.quadraticCurveTo(sx + lean * 0.4, size - h * 0.5, sx + lean, size - h);
    ctx.stroke();

    // Small leaves + purple heather florets along upper 60%
    for (let t = 0.35; t <= 1.0; t += 0.09) {
      const bx = sx + lean * t + (rng() - 0.5) * 14;
      const by = size - h * t + (rng() - 0.5) * 10;
      const isFlower = t > 0.48 && rng() > 0.22;
      if (isFlower) {
        const r = Math.round(118 + rng() * 58);
        const g = Math.round(62 + rng() * 40);
        const b = Math.round(134 + rng() * 56);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.beginPath();
        ctx.arc(bx, by, 4.5 + rng() * 4.5, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = '#2d4724';
        ctx.beginPath();
        ctx.arc(bx, by, 4.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  return finalizeTexture(canvas, { repeat: false, srgb: true, anisotropy });
}

function createPlaidTexture(anisotropy) {
  const size = 256;
  const { canvas, ctx } = makeCanvas(size, size);

  // Natural-dyed 1744 Lochaber wool sett (moss green, peat brown, madder crimson, ochre thread)
  ctx.fillStyle = '#2c4832';
  ctx.fillRect(0, 0, size, size);

  const stripes = [
    { pos: 0, w: 34, col: 'rgba(26, 36, 28, 0.55)' },
    { pos: 52, w: 18, col: 'rgba(126, 44, 38, 0.58)' },
    { pos: 78, w: 6, col: 'rgba(182, 146, 76, 0.52)' },
    { pos: 128, w: 40, col: 'rgba(30, 50, 56, 0.50)' },
    { pos: 186, w: 16, col: 'rgba(122, 42, 36, 0.56)' },
    { pos: 212, w: 6, col: 'rgba(186, 150, 82, 0.48)' }
  ];

  for (const s of stripes) {
    ctx.fillStyle = s.col;
    ctx.fillRect(s.pos, 0, s.w, size);
    ctx.fillRect(0, s.pos, size, s.w);
  }

  // Subtle twill weave grain
  ctx.fillStyle = 'rgba(0,0,0,0.08)';
  for (let y = 0; y < size; y += 4) {
    ctx.fillRect(0, y, size, 1);
  }

  const plaidColor = finalizeTexture(canvas, { repeat: true, srgb: true, anisotropy });
  plaidColor.repeat.set(2, 2);
  return plaidColor;
}

function createWaterNormalMap(anisotropy) {
  const size = 256;
  const { canvas, ctx } = makeCanvas(size, size);
  const img = ctx.createImageData(size, size);

  const heights = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      heights[y * size + x] =
        tileFbm(u, v, 8, 4, 613) * 0.65 +
        tileFbm(u + 0.3, v + 0.7, 16, 3, 919) * 0.35;
    }
  }

  const strength = 2.6;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xL = (x - 1 + size) % size;
      const xR = (x + 1) % size;
      const yD = (y - 1 + size) % size;
      const yU = (y + 1) % size;

      const dx = (heights[y * size + xR] - heights[y * size + xL]) * strength;
      const dy = (heights[yU * size + x] - heights[yD * size + x]) * strength;
      const inv = 1 / Math.hypot(dx, dy, 1);

      const idx = (y * size + x) * 4;
      img.data[idx] = Math.round(((-dx * inv) * 0.5 + 0.5) * 255);
      img.data[idx + 1] = Math.round(((-dy * inv) * 0.5 + 0.5) * 255);
      img.data[idx + 2] = Math.round(((inv) * 0.5 + 0.5) * 255);
      img.data[idx + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  const waterNormal = finalizeTexture(canvas, { repeat: true, srgb: false, anisotropy });
  waterNormal.repeat.set(36, 36);
  return waterNormal;
}

function createSmokeTexture() {
  const size = 128;
  const { canvas, ctx } = makeCanvas(size, size);
  const grad = ctx.createRadialGradient(size / 2, size / 2, 4, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(225, 222, 214, 0.72)');
  grad.addColorStop(0.45, 'rgba(185, 186, 184, 0.34)');
  grad.addColorStop(1, 'rgba(160, 165, 168, 0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return finalizeTexture(canvas, { repeat: false, srgb: true, anisotropy: 1 });
}

export function createProceduralTextures(maxAnisotropy = 8) {
  const aniso = Math.min(maxAnisotropy || 4, 8);
  return {
    ...createTerrainTextures(aniso),
    ...createDryStoneTextures(aniso),
    ...createThatchTextures(aniso),
    ...createBarkTextures(aniso),
    pineColor: createPineBoughTexture(aniso),
    grassTuft: createGrassTuftTexture(aniso),
    heatherTuft: createHeatherTuftTexture(aniso),
    plaidColor: createPlaidTexture(aniso),
    waterNormal: createWaterNormalMap(aniso),
    smokeTex: createSmokeTexture()
  };
}
