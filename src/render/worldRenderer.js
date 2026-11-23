import * as THREE from 'three';
import {
  heightAt,
  normalAt,
  surfaceAt,
  roadCenterX,
  WATER_LEVEL,
  LANDMARKS
} from '../world/terrain.js';
import { mulberry32, hash2D, fbm2D, ridgeNoise2D, clamp, lerp, smoothstep } from '../core/prng.js';
import {
  createOnixTerrainMaterial,
  createOnixHorizonMaterial,
  createOnixStoneMaterial,
  createOnixThatchMaterial,
  createOnixBarkMaterial,
  createOnixFoliageMaterial,
  createOnixWaterMaterial,
  createOnixPlaidMaterial
} from './onixShaders.js';
import { PainterlyPost } from './painterlyPost.js';
import { BrambleRig } from './mountMesh.js';
import { RedcoatRenderer } from './redcoatMesh.js';
import { CombatFX } from './combatFX.js';
import { FirstPersonRig } from './fpRig.js';

const CHUNK_SIZE = 120;
const CHUNK_RADIUS = 4;

const FOLIAGE_STEP = 1.45;
const FOLIAGE_HALF_GRID = 40;
const MAX_GRASS = 4200;
const MAX_HEATHER = 2800;

function mergeNonIndexedGeos(geos) {
  const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g.clone()));
  let totalVerts = 0;
  for (const p of parts) totalVerts += p.attributes.position.count;

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const hasUv = parts.every((p) => Boolean(p.attributes.uv));
  const uvs = hasUv ? new Float32Array(totalVerts * 2) : null;
  const hasColor = parts.every((p) => Boolean(p.attributes.color));
  const colors = hasColor ? new Float32Array(totalVerts * 3) : null;

  let offset = 0;
  for (const p of parts) {
    const count = p.attributes.position.count;
    positions.set(p.attributes.position.array, offset * 3);
    normals.set(p.attributes.normal.array, offset * 3);
    if (hasUv) uvs.set(p.attributes.uv.array, offset * 2);
    if (hasColor) colors.set(p.attributes.color.array, offset * 3);
    offset += count;
    p.dispose();
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  if (hasUv) out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  if (hasColor) out.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return out;
}

function createPainterlyPineBoughTexture(aniso = 8) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rng = mulberry32(41744);
  ctx.clearRect(0, 0, size, size);

  const cx = size * 0.5, cy = size * 0.52;
  ctx.strokeStyle = '#3b2518';
  ctx.lineCap = 'round';
  for (let b = 0; b < 7; b++) {
    const a = -Math.PI * 0.94 + (b / 6) * Math.PI * 0.88 + (rng() - 0.5) * 0.25;
    const len = 62 + rng() * 44;
    ctx.lineWidth = 3.6;
    ctx.beginPath();
    ctx.moveTo(cx, cy + 16);
    ctx.quadraticCurveTo(cx + Math.cos(a) * len * 0.5, cy + Math.sin(a) * len * 0.35, cx + Math.cos(a) * len, cy + Math.sin(a) * len);
    ctx.stroke();
  }

  for (let c = 0; c < 22; c++) {
    const ang = rng() * Math.PI * 2;
    const dist = Math.pow(rng(), 0.68) * 82;
    const kx = cx + Math.cos(ang) * dist;
    const ky = cy + Math.sin(ang) * dist * 0.78 - 6;
    const sunBias = clamp(1 - ky / size + (rng() - 0.5) * 0.28, 0, 1);

    for (let n = 0; n < 44; n++) {
      const na = rng() * Math.PI * 2;
      const nr = 12 + rng() * 28;
      const r = Math.round(lerp(20, 70, sunBias) + (rng() - 0.5) * 14);
      const g = Math.round(lerp(40, 96, sunBias) + (rng() - 0.5) * 18);
      const b = Math.round(lerp(26, 44, sunBias) + (rng() - 0.5) * 10);
      ctx.strokeStyle = `rgb(${r},${g},${b})`;
      ctx.lineWidth = 2.4 + rng() * 1.6;
      ctx.beginPath();
      ctx.moveTo(kx, ky);
      ctx.lineTo(kx + Math.cos(na) * nr, ky + Math.sin(na) * nr * 0.82);
      ctx.stroke();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(aniso, 8);
  tex.needsUpdate = true;
  return tex;
}

function createPainterlyGrassTexture(aniso = 8) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rng = mulberry32(51744);
  ctx.clearRect(0, 0, size, size);

  ctx.lineCap = 'round';
  for (let i = 0; i < 64; i++) {
    const sx = size * (0.10 + rng() * 0.80);
    const h = size * (0.34 + rng() * 0.58);
    const lean = (sx - size * 0.5) * 0.75 + (rng() - 0.5) * 70;
    const ex = clamp(sx + lean, 8, size - 8);
    const ey = clamp(size - h, 8, size - 16);
    const mx = (sx + ex) * 0.5 + (rng() - 0.5) * 16;
    const my = (size + ey) * 0.52;

    const isGolden = rng() > 0.42;
    const grad = ctx.createLinearGradient(sx, size, ex, ey);
    grad.addColorStop(0, '#364622');
    grad.addColorStop(0.52, isGolden ? '#6c682e' : '#4a622a');
    grad.addColorStop(1, isGolden ? '#b09248' : '#7b8d42');

    ctx.strokeStyle = grad;
    ctx.lineWidth = 3.2 + rng() * 3.4;
    ctx.beginPath();
    ctx.moveTo(sx, size + 4);
    ctx.quadraticCurveTo(mx, my, ex, ey);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(aniso, 8);
  tex.needsUpdate = true;
  return tex;
}

function createPainterlyHeatherSprigTexture(aniso = 8) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rng = mulberry32(81744);
  ctx.clearRect(0, 0, size, size);

  for (let s = 0; s < 38; s++) {
    const sx = size * (0.14 + rng() * 0.72);
    const h = size * (0.34 + rng() * 0.56);
    const lean = (sx - size * 0.5) * 1.15 + (rng() - 0.5) * 62;
    const ex = clamp(sx + lean, 10, size - 10);
    const ey = clamp(size - h, 10, size - 16);
    const mx = (sx + ex) * 0.5 + (rng() - 0.5) * 18;
    const my = (size + ey) * 0.5;

    ctx.strokeStyle = '#394525';
    ctx.lineWidth = 3.4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(sx, size + 2);
    ctx.quadraticCurveTo(mx, my, ex, ey);
    ctx.stroke();

    const hasFlower = rng() > 0.16;
    for (let t = 0.20; t <= 1.0; t += 0.068) {
      const omt = 1 - t;
      const px = omt * omt * sx + 2 * omt * t * mx + t * t * ex;
      const py = omt * omt * size + 2 * omt * t * my + t * t * ey;

      if (hasFlower && t > 0.36) {
        ctx.fillStyle = `rgb(${Math.round(126 + rng() * 68)},${Math.round(48 + rng() * 38)},${Math.round(112 + rng() * 64)})`;
        ctx.beginPath();
        ctx.ellipse(px + (rng() - 0.5) * 14, py + (rng() - 0.5) * 10, 4.0 + rng() * 4.8, 2.6 + rng() * 3.2, rng() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.strokeStyle = `rgb(${Math.round(48 + rng() * 28)},${Math.round(70 + rng() * 34)},${Math.round(30 + rng() * 18)})`;
        ctx.lineWidth = 2.6;
        const a = -Math.PI * 0.5 + (rng() - 0.5) * 1.9;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + Math.cos(a) * 12, py + Math.sin(a) * 12);
        ctx.stroke();
      }
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(aniso, 8);
  tex.needsUpdate = true;
  return tex;
}

function createFeatheredTuftGeometry(width, height, cardCount = 3) {
  const planes = [];
  for (let c = 0; c < cardCount; c++) {
    const g = new THREE.PlaneGeometry(width, height, 2, 2);
    g.translate(0, height * 0.45, 0);

    const pos = g.attributes.position;
    const norm = g.attributes.normal;
    const cols = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const yNorm = clamp(pos.getY(i) / height, 0, 1);
      pos.setZ(i, pos.getZ(i) + yNorm * yNorm * 0.14);
    }

    g.rotateX(c === cardCount - 1 ? 0.34 : (c % 2 === 0 ? 0.14 : -0.14));
    g.rotateY((c / cardCount) * Math.PI + c * 0.18);

    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
      const nx = px * 0.35, ny = 1.0, nz = pz * 0.35;
      const inv = 1 / Math.hypot(nx, ny, nz);
      norm.setXYZ(i, nx * inv, ny * inv, nz * inv);

      const shade = lerp(0.84, 1.08, clamp(py / height, 0, 1));
      cols[i * 3] = shade; cols[i * 3 + 1] = shade; cols[i * 3 + 2] = shade;
    }
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    planes.push(g);
  }
  return mergeNonIndexedGeos(planes);
}

const PINE_BRANCH_TIPS = [
  { x: 2.55, y: 5.5, z: 0.70, r: 3.1 },
  { x: -2.25, y: 6.0, z: 1.85, r: 3.0 },
  { x: -2.35, y: 6.5, z: -1.65, r: 3.1 },
  { x: 1.85, y: 7.0, z: -2.05, r: 2.9 },
  { x: 0.35, y: 7.9, z: 0.25, r: 3.5 },
  { x: -0.95, y: 7.35, z: 0.90, r: 2.8 },
  { x: 1.10, y: 7.55, z: 1.25, r: 2.7 }
];

function createScotsPineWoodGeometry() {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.15, 0.42, 7.8, 8, 6);
  trunk.translate(0, 3.8, 0);
  const pos = trunk.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    pos.setX(i, pos.getX(i) + Math.sin(y * 0.42) * 0.34 + y * 0.045);
    pos.setZ(i, pos.getZ(i) + Math.cos(y * 0.36) * 0.20);
  }
  trunk.computeVertexNormals();
  parts.push(trunk);

  for (let i = 0; i < 4; i++) {
    const tip = PINE_BRANCH_TIPS[i];
    const startY = tip.y - 1.45;
    const startX = Math.sin(startY * 0.42) * 0.34 + startY * 0.045;
    const startZ = Math.cos(startY * 0.36) * 0.20;
    const dx = tip.x - startX, dy = tip.y - startY, dz = tip.z - startZ;
    const len = Math.hypot(dx, dy, dz);

    const limb = new THREE.CylinderGeometry(0.06, 0.14, len, 6);
    limb.translate(0, len * 0.5, 0);
    limb.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx, dy, dz).normalize()));
    limb.translate(startX, startY, startZ);
    parts.push(limb);
  }
  return mergeNonIndexedGeos(parts);
}

function createScotsPineCanopyFeatheredGeometry() {
  const rng = mulberry32(61744);
  const cards = [];

  for (const cluster of PINE_BRANCH_TIPS) {
    for (let k = 0; k < 6; k++) {
      const sz = cluster.r * (0.88 + rng() * 0.42);
      const g = new THREE.PlaneGeometry(sz, sz * 0.86);
      g.rotateX(k === 0 ? -Math.PI * 0.42 : (rng() - 0.5) * 1.15);
      g.rotateZ((rng() - 0.5) * 0.55);
      g.rotateY((k / 6) * Math.PI * 2 + rng() * 0.7);
      g.translate(cluster.x + (rng() - 0.5) * 1.1, cluster.y + (rng() - 0.5) * 0.68, cluster.z + (rng() - 0.5) * 1.1);

      const pos = g.attributes.position, norm = g.attributes.normal;
      const cols = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
        const nx = px, ny = (py - 5.5) * 1.4 + 1.1, nz = pz;
        const inv = 1 / (Math.hypot(nx, ny, nz) || 1);
        norm.setXYZ(i, nx * inv, ny * inv, nz * inv);

        const shade = lerp(0.54, 1.16, clamp((py - 4.8) / 3.8, 0, 1));
        cols[i * 3] = shade; cols[i * 3 + 1] = shade; cols[i * 3 + 2] = shade;
      }
      g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      cards.push(g);
    }
  }
  return mergeNonIndexedGeos(cards);
}

function createGableRoofGeometry(width, depth, ridgeHeight) {
  const hw = width * 0.5, hd = depth * 0.5;
  const shape = new THREE.Shape();
  shape.moveTo(-hd, 0); shape.lineTo(0, ridgeHeight); shape.lineTo(hd, 0); shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false });
  geo.translate(0, 0, -hw);
  geo.rotateY(Math.PI / 2);
  geo.computeVertexNormals();
  return geo;
}

export class WorldRenderer {
  constructor(canvas, onixField) {
    this.canvas = canvas;
    this.onixField = onixField;
    this.scene = new THREE.Scene();

    // Pure First-Person & WebXR-ready eye rig (0.06m near plane keeps hands & blades crisp)
    this.playerRig = new THREE.Group();
    this.camera = new THREE.PerspectiveCamera(68, window.innerWidth / window.innerHeight, 0.06, 3200);
    this.camera.rotation.order = 'YXZ';
    this.playerRig.add(this.camera);
    this.scene.add(this.playerRig);

    this.renderer = null;
    this.post = null;
    this.fpRig = null;
    this.chunks = new Map();
    this.flickerLights = [];
    this.smokeParticles = [];
    this.camPos = new THREE.Vector3();
    this.elapsed = 0;

    this.lastFoliageX = 1e9;
    this.lastFoliageZ = 1e9;
    this.tmpColor = new THREE.Color();
    this.tmpDummy = new THREE.Object3D();

    this.sharedUniforms = {
      uOnixField: { value: this.onixField.texture },
      uRippleTex: { value: this.onixField.rippleTexture },
      uRippleOrigin: { value: this.onixField.rippleOrigin },
      uRippleWorldSize: { value: this.onixField.rippleWorldSize },
      uTime: { value: 0 },
      uRain: { value: 0.0 },
      uMistStrength: { value: 0.55 },
      uDayFactor: { value: 0.85 },
      uSunDir: { value: new THREE.Vector3(-0.7, 0.22, -0.45).normalize() },
      uSunColor: { value: new THREE.Color(0xffbd70) }
    };
  }

  init() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      powerPreference: 'high-performance'
    });

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2.0));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.NoToneMapping;

    this.scene.fog = new THREE.FogExp2(0x7c8f9e, 0.00095);

    const aniso = this.renderer.capabilities.getMaxAnisotropy();
    this.pineBoughTex = createPainterlyPineBoughTexture(aniso);
    this.grassTex = createPainterlyGrassTexture(aniso);
    this.heatherSprigTex = createPainterlyHeatherSprigTexture(aniso);

    this.terrainMat = createOnixTerrainMaterial(this.sharedUniforms);
    this.horizonMat = createOnixHorizonMaterial(this.sharedUniforms);
    this.stoneMat = createOnixStoneMaterial(this.sharedUniforms, { coursed: true, tint: 0xd8d6d0 });
    this.darkStoneMat = createOnixStoneMaterial(this.sharedUniforms, { coursed: true, tint: 0x9ca0a2 });
    this.boulderMat = createOnixStoneMaterial(this.sharedUniforms, { coursed: false, tint: 0xc2c4c6 });
    this.thatchMat = createOnixThatchMaterial(this.sharedUniforms);
    this.barkMat = createOnixBarkMaterial(this.sharedUniforms);
    this.waterMat = createOnixWaterMaterial(this.sharedUniforms);
    this.plaidMat = createOnixPlaidMaterial(this.sharedUniforms);

    this._setupSkyAndIBL();
    this._setupLighting();
    this._buildWater();
    this._buildDistantMountains();
    this._buildSector01Landmarks();
    this._buildInstancedTreesAndRocks();
    this._buildStreaming3DFoliage();
    this._buildSmokeAndRain();

    // Dedicated Dishonored-style First-Person arms & arsenal attached to camera
    this.fpRig = new FirstPersonRig(this.plaidMat);
    this.camera.add(this.fpRig.root);

    this.bramble = new BrambleRig(this.plaidMat);
    this.scene.add(this.bramble.root);

    this.redcoatRenderer = new RedcoatRenderer(this.scene);
    this.combatFX = new CombatFX(this.scene);
    this.post = new PainterlyPost(this.renderer);
  }

  getBackendName() {
    return 'ONIX FP HDR';
  }

  _setupSkyAndIBL() {
    this.skyUniforms = {
      uSunDir: this.sharedUniforms.uSunDir,
      uTime: this.sharedUniforms.uTime,
      uDayFactor: this.sharedUniforms.uDayFactor,
      uGoldenFactor: { value: 0.72 },
      uStormFactor: { value: 0.28 }
    };

    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: this.skyUniforms,
      vertexShader: /* glsl */ `
        varying vec3 vWorldDir;
        void main() {
          vWorldDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uSunDir;
        uniform float uTime;
        uniform float uDayFactor;
        uniform float uGoldenFactor;
        uniform float uStormFactor;
        varying vec3 vWorldDir;

        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        float fbm(vec2 p) {
          float v = 0.0; float a = 0.5; mat2 r = mat2(0.8, 0.6, -0.6, 0.8);
          for (int i = 0; i < 5; i++) { v += a * noise(p); p = r * p * 2.04 + vec2(3.1, 7.4); a *= 0.5; }
          return v;
        }

        void main() {
          vec3 dir = normalize(vWorldDir);
          float h = clamp(dir.y, 0.0, 1.0);

          vec3 nightZen = vec3(0.005, 0.011, 0.028);
          vec3 nightHor = vec3(0.018, 0.032, 0.060);
          vec3 dayZen = mix(vec3(0.048, 0.130, 0.285), vec3(0.060, 0.075, 0.105), uStormFactor);
          vec3 dayHor = mix(vec3(0.32, 0.42, 0.48), vec3(0.16, 0.19, 0.22), uStormFactor);
          vec3 goldHor = vec3(1.18, 0.56, 0.18);

          vec3 zenith = mix(nightZen, dayZen, uDayFactor);
          vec3 horizon = mix(nightHor, dayHor, uDayFactor);
          horizon = mix(horizon, goldHor, uGoldenFactor * 0.78 * (1.0 - uStormFactor * 0.62));
          vec3 col = mix(horizon, zenith, pow(h, 0.52));

          float sunDot = max(dot(dir, normalize(uSunDir)), 0.0);
          vec3 sunTint = mix(vec3(1.4, 0.64, 0.20), vec3(1.3, 1.05, 0.74), uDayFactor);
          float sunVis = (1.0 - uStormFactor * 0.75) * uDayFactor;
          col += sunTint * pow(sunDot, 5.0) * 0.62 * sunVis;
          col += sunTint * smoothstep(0.9965, 0.9993, sunDot) * 4.5 * sunVis;

          if (dir.y > 0.004) {
            vec2 uv = dir.xz / (dir.y + 0.14) * 1.08 + vec2(uTime * 0.010, uTime * 0.004);
            vec2 warp = vec2(fbm(uv * 0.75 + 1.4), fbm(uv * 0.75 + 5.2)) - 0.5;
            float c1 = fbm(uv + warp * 0.92);
            float c2 = fbm(uv * 2.2 - vec2(uTime * 0.005, 0.0) + warp * 0.45);
            float cover = mix(0.40, 0.18, uStormFactor);
            float mask = smoothstep(cover, cover + 0.34, c1 * 0.68 + c2 * 0.32) * smoothstep(0.004, 0.16, dir.y);

            vec3 cLit = mix(vec3(0.04, 0.06, 0.09), vec3(0.92, 0.88, 0.80), uDayFactor);
            cLit = mix(cLit, vec3(1.55, 0.92, 0.40), clamp(uGoldenFactor * 0.88 + pow(sunDot, 3.0) * 0.7, 0.0, 1.0) * (1.0 - uStormFactor * 0.55));
            vec3 cDark = mix(vec3(0.014, 0.020, 0.036), mix(vec3(0.08, 0.10, 0.15), vec3(0.045, 0.060, 0.085), uStormFactor), uDayFactor);

            float rim = clamp(c2 * 1.12 + pow(sunDot, 3.5) * 1.05 * sunVis, 0.0, 1.0);
            col = mix(col, mix(cDark, cLit, rim), mask * mix(0.90, 0.97, uStormFactor));
          }

          if (uDayFactor < 0.3 && dir.y > 0.08) {
            float star = step(0.9968, hash(floor(dir.xz / max(dir.y, 0.1) * 150.0)));
            col += vec3(0.85, 0.92, 1.1) * star * (1.0 - uDayFactor * 3.2) * (1.0 - uStormFactor);
          }

          gl_FragColor = vec4(col, 1.0);
        }
      `
    });

    this.skyDome = new THREE.Mesh(new THREE.SphereGeometry(2850, 32, 20), skyMat);
    this.skyDome.frustumCulled = false;
    this.scene.add(this.skyDome);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    envScene.add(new THREE.Mesh(
      new THREE.SphereGeometry(30, 16, 12),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        vertexShader: `varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `
          varying vec3 vP;
          void main() {
            vec3 top = vec3(0.16, 0.28, 0.48);
            vec3 mid = vec3(0.62, 0.48, 0.36);
            vec3 bot = vec3(0.04, 0.05, 0.035);
            vec3 c = vP.y > 0.0 ? mix(mid, top, pow(vP.y, 0.58)) : mix(mid, bot, pow(-vP.y, 0.45));
            gl_FragColor = vec4(c, 1.0);
          }
        `
      })
    ));
    this.envRT = pmrem.fromScene(envScene, 0.04);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = 0.80;
    pmrem.dispose();
  }

  _setupLighting() {
    this.hemiLight = new THREE.HemisphereLight(0x88b0d8, 0x282c1c, 0.54);
    this.scene.add(this.hemiLight);

    this.sunLight = new THREE.DirectionalLight(0xffdfb0, 3.2);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.near = 10;
    this.sunLight.shadow.camera.far = 360;
    const d = 88;
    this.sunLight.shadow.camera.left = -d;
    this.sunLight.shadow.camera.right = d;
    this.sunLight.shadow.camera.top = d;
    this.sunLight.shadow.camera.bottom = -d;
    this.sunLight.shadow.bias = -0.0004;
    this.sunLight.shadow.normalBias = 0.032;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);
  }

  _buildWater() {
    const geo = new THREE.PlaneGeometry(5200, 5200, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.waterMesh = new THREE.Mesh(geo, this.waterMat);
    this.waterMesh.position.y = WATER_LEVEL;
    this.waterMesh.receiveShadow = true;
    this.scene.add(this.waterMesh);
  }

  _buildDistantMountains() {
    const segAng = 108;
    const segRad = 22;
    const rInner = 530;
    const rOuter = 2650;

    const verts = [];
    const indices = [];

    for (let ir = 0; ir <= segRad; ir++) {
      const t = ir / segRad;
      const r = lerp(rInner, rOuter, t * t * 0.65 + t * 0.35);

      for (let ia = 0; ia <= segAng; ia++) {
        const ang = (ia / segAng) * Math.PI * 2;
        const wx = Math.cos(ang) * r;
        const wz = Math.sin(ang) * r;

        const baseH = heightAt(wx, wz);
        const outerFade = smoothstep(0.02, 0.55, t);
        const seamTuck = ir === 0 ? -3.0 : 0.0;

        const farWestShore = smoothstep(-860, -1380, wx);
        const macroPeaks = ridgeNoise2D(wx * 0.00085, wz * 0.00085, 4, 2744) * 320;
        const subRidges = fbm2D(wx * 0.0022, wz * 0.0022, 3, 3744) * 62;

        let wy;
        if (wx < -220) {
          const ardgourPeak = (macroPeaks * 0.78 + subRidges * 0.5 + 54) * farWestShore;
          wy = -14.0 + ardgourPeak * outerFade;
        } else {
          const eastBoost = lerp(0.72, 1.20, smoothstep(-220, 950, wx));
          wy = baseH + (macroPeaks * eastBoost + subRidges + 32) * outerFade + seamTuck;
        }
        verts.push(wx, wy, wz);
      }
    }

    const row = segAng + 1;
    for (let ir = 0; ir < segRad; ir++) {
      for (let ia = 0; ia < segAng; ia++) {
        const a = ir * row + ia;
        const b = a + 1;
        const c = (ir + 1) * row + ia;
        const d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    this.horizonMesh = new THREE.Mesh(geo, this.horizonMat);
    this.scene.add(this.horizonMesh);
  }

  _buildSector01Landmarks() {
    const emberMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.6, 1.35, 0.24), toneMapped: false });
    const winGlowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 1.25, 0.38), toneMapped: false });

    const cl = LANDMARKS.clachan;
    const bothies = [
      { dx: -12, dz: -7, w: 8.4, d: 5.0, rot: 0.25 },
      { dx: 11, dz: -10, w: 7.4, d: 4.6, rot: -0.42 },
      { dx: 4, dz: 12, w: 8.8, d: 5.2, rot: 1.38 }
    ];

    this.smokeSources = [];

    for (const b of bothies) {
      const bx = cl.x + b.dx, bz = cl.z + b.dz, by = heightAt(bx, bz);
      const group = new THREE.Group();
      group.position.set(bx, by, bz);
      group.rotation.y = b.rot;

      const walls = new THREE.Mesh(new THREE.BoxGeometry(b.w, 2.7, b.d), this.stoneMat);
      walls.position.y = 1.15; walls.castShadow = true; walls.receiveShadow = true;
      group.add(walls);

      const gableWalls = new THREE.Mesh(createGableRoofGeometry(b.w - 0.1, b.d - 0.1, 2.25), this.stoneMat);
      gableWalls.position.y = 2.48; gableWalls.castShadow = true; gableWalls.receiveShadow = true;
      group.add(gableWalls);

      const roof = new THREE.Mesh(createGableRoofGeometry(b.w + 0.85, b.d + 0.95, 2.55), this.thatchMat);
      roof.position.y = 2.38; roof.castShadow = true; roof.receiveShadow = true;
      group.add(roof);

      const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.9, 0.95), this.darkStoneMat);
      chimney.position.set(b.w * 0.34, 4.4, 0); chimney.castShadow = true;
      group.add(chimney);

      this.smokeSources.push({ x: bx + b.w * 0.34 * Math.cos(b.rot), y: by + 5.35, z: bz - b.w * 0.34 * Math.sin(b.rot) });

      const door = new THREE.Mesh(new THREE.BoxGeometry(1.12, 1.9, 0.24), this.barkMat);
      door.position.set(0, 0.9, b.d * 0.5 + 0.02);
      const lintel = new THREE.Mesh(new THREE.BoxGeometry(1.65, 0.28, 0.36), this.darkStoneMat);
      lintel.position.set(0, 1.98, b.d * 0.5 + 0.06);
      const winFrame = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.86, 0.16), this.darkStoneMat);
      winFrame.position.set(b.w * 0.26, 1.38, b.d * 0.5);
      const winGlow = new THREE.Mesh(new THREE.PlaneGeometry(0.66, 0.62), winGlowMat);
      winGlow.position.set(b.w * 0.26, 1.38, b.d * 0.5 + 0.09);
      group.add(door, lintel, winFrame, winGlow);
      this.scene.add(group);
    }

    for (const arc of [{ a0: 0.3, a1: 1.4, r: 21 }, { a0: 2.1, a1: 3.5, r: 22 }, { a0: 4.1, a1: 5.4, r: 20 }]) {
      for (let i = 0; i < 6; i++) {
        const t0 = lerp(arc.a0, arc.a1, i / 6), t1 = lerp(arc.a0, arc.a1, (i + 1) / 6);
        const mid = (t0 + t1) * 0.5;
        const wx = cl.x + Math.cos(mid) * arc.r, wz = cl.z + Math.sin(mid) * arc.r;
        const wall = new THREE.Mesh(new THREE.BoxGeometry(arc.r * (t1 - t0) + 0.35, 1.18, 0.68), this.darkStoneMat);
        wall.position.set(wx, heightAt(wx, wz) + 0.44, wz);
        wall.rotation.y = -mid + Math.PI / 2;
        wall.castShadow = true; wall.receiveShadow = true;
        this.scene.add(wall);
      }
    }

    const fireY = heightAt(cl.x, cl.z);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      const st = new THREE.Mesh(new THREE.DodecahedronGeometry(0.32, 0), this.boulderMat);
      st.position.set(cl.x + Math.cos(a) * 1.05, fireY + 0.14, cl.z + Math.sin(a) * 1.05);
      st.scale.set(1.15, 0.72, 1.15); st.castShadow = true;
      this.scene.add(st);
    }
    for (let i = 0; i < 4; i++) {
      const log = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 1.2, 6), this.barkMat);
      log.position.set(cl.x, fireY + 0.24, cl.z);
      log.rotation.set(Math.PI / 2 - 0.35, (i * Math.PI) / 2, 0);
      this.scene.add(log);
    }

    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.78, 6), emberMat);
    flame.position.set(cl.x, fireY + 0.5, cl.z);
    this.scene.add(flame);

    const hearthLight = new THREE.PointLight(0xff8428, 22, 42, 1.6);
    hearthLight.position.set(cl.x, fireY + 1.5, cl.z);
    this.scene.add(hearthLight);
    this.flickerLights.push({ light: hearthLight, flame, baseIntensity: 22, phase: 0.4 });
    this.smokeSources.push({ x: cl.x, y: fireY + 0.9, z: cl.z });

    const tw = LANDMARKS.watchtower, twY = heightAt(tw.x, tw.z);
    const towerGroup = new THREE.Group();
    towerGroup.position.set(tw.x, twY, tw.z);

    const keepPlinth = new THREE.Mesh(new THREE.CylinderGeometry(5.6, 6.6, 3.2, 4), this.darkStoneMat);
    keepPlinth.rotation.y = Math.PI / 4; keepPlinth.position.y = 1.1; keepPlinth.castShadow = true; keepPlinth.receiveShadow = true;
    const keepShaft = new THREE.Mesh(new THREE.BoxGeometry(7.6, 12.2, 7.6), this.stoneMat);
    keepShaft.position.y = 8.4; keepShaft.castShadow = true; keepShaft.receiveShadow = true;
    const corbel = new THREE.Mesh(new THREE.BoxGeometry(8.5, 1.2, 8.5), this.darkStoneMat);
    corbel.position.y = 14.8; corbel.castShadow = true;
    towerGroup.add(keepPlinth, keepShaft, corbel);

    for (const p of [-3.6, -1.2, 1.2, 3.6]) {
      for (const s of [-3.9, 3.9]) {
        const m1 = new THREE.Mesh(new THREE.BoxGeometry(1.35, 1.15, 0.72), this.stoneMat);
        m1.position.set(p, 15.9, s); m1.castShadow = true;
        const m2 = new THREE.Mesh(new THREE.BoxGeometry(0.72, 1.15, 1.35), this.stoneMat);
        m2.position.set(s, 15.9, p); m2.castShadow = true;
        towerGroup.add(m1, m2);
      }
    }

    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 6.8, 6), this.barkMat);
    pole.position.set(0, 18.4, 0);
    this.towerFlag = new THREE.Mesh(new THREE.BoxGeometry(2.9, 1.4, 0.06), new THREE.MeshStandardMaterial({ color: 0x851c1a, roughness: 0.86 }));
    this.towerFlag.position.set(1.45, 20.8, 0);
    towerGroup.add(pole, this.towerFlag);

    const beacons = [{ x: 0, y: 15.8, z: 0, power: 38 }, { x: -6.2, y: 2.4, z: 3.4, power: 28 }, { x: 6.0, y: 2.2, z: -2.8, power: 28 }];
    for (let i = 0; i < beacons.length; i++) {
      const bc = beacons[i];
      const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.36, 1.25, 6), this.darkStoneMat);
      stand.position.set(bc.x, bc.y, bc.z);
      const bFlame = new THREE.Mesh(new THREE.ConeGeometry(0.52, 1.25, 6), emberMat);
      bFlame.position.set(bc.x, bc.y + 1.0, bc.z);
      towerGroup.add(stand, bFlame);

      const bLight = new THREE.PointLight(0xff8424, bc.power, 72, 1.45);
      bLight.position.set(tw.x + bc.x, twY + bc.y + 1.6, tw.z + bc.z);
      this.scene.add(bLight);
      this.flickerLights.push({ light: bLight, flame: bFlame, baseIntensity: bc.power, phase: i * 2.1 });
      this.smokeSources.push({ x: tw.x + bc.x, y: twY + bc.y + 1.4, z: tw.z + bc.z });
    }
    this.scene.add(towerGroup);

    const jt = LANDMARKS.coveJetty;
    const deck = new THREE.Mesh(new THREE.BoxGeometry(14, 0.35, 3.2), this.barkMat);
    deck.position.set(jt.x - 4, WATER_LEVEL + 0.85, jt.z); deck.castShadow = true; deck.receiveShadow = true;
    this.scene.add(deck);
    for (let i = -5; i <= 5; i += 2.5) {
      for (const pz of [-1.2, 1.2]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 3.8, 6), this.barkMat);
        post.position.set(jt.x - 4 + i, WATER_LEVEL - 0.3, jt.z + pz); post.castShadow = true;
        this.scene.add(post);
      }
    }

    const cr = LANDMARKS.stashCairn, crY = heightAt(cr.x, cr.z);
    for (let layer = 0; layer < 4; layer++) {
      const st = new THREE.Mesh(new THREE.DodecahedronGeometry(1.4 - layer * 0.32, 1), this.boulderMat);
      st.position.set(cr.x, crY + 0.45 + layer * 0.5, cr.z);
      st.scale.set(1.1, 0.62, 1.1); st.rotation.y = layer * 1.1; st.castShadow = true; st.receiveShadow = true;
      this.scene.add(st);
    }

    for (let mz = -360; mz <= 360; mz += 120) {
      const mx = roadCenterX(mz) + 5.2;
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.55, 1.45, 0.42), this.stoneMat);
      post.position.set(mx, heightAt(mx, mz) + 0.65, mz); post.castShadow = true;
      this.scene.add(post);
    }
  }

  _buildInstancedTreesAndRocks() {
    const rng = mulberry32(174401);
    const maxPines = 600, maxRocks = 560;
    const trunkGeo = createScotsPineWoodGeometry();
    const crownGeo = createScotsPineCanopyFeatheredGeometry();
    const crownMat = createOnixFoliageMaterial(this.sharedUniforms, { kind: 'pine', map: this.pineBoughTex });

    const rockGeo = new THREE.IcosahedronGeometry(1.0, 2);
    const rPos = rockGeo.attributes.position;
    for (let i = 0; i < rPos.count; i++) {
      const vx = rPos.getX(i), vy = rPos.getY(i), vz = rPos.getZ(i);
      const n = 0.78 + Math.sin(vx * 3.4 + vy * 2.1) * 0.16 + Math.cos(vz * 4.3 - vx * 2.2) * 0.13;
      rPos.setXYZ(i, vx * n, vy * n, vz * n);
    }
    rockGeo.computeVertexNormals();

    const trunks = new THREE.InstancedMesh(trunkGeo, this.barkMat, maxPines);
    const crowns = new THREE.InstancedMesh(crownGeo, crownMat, maxPines);
    const rocks = new THREE.InstancedMesh(rockGeo, this.boulderMat, maxRocks);
    trunks.castShadow = trunks.receiveShadow = crowns.castShadow = crowns.receiveShadow = rocks.castShadow = rocks.receiveShadow = true;

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    let pineCount = 0;
    for (let tries = 0; tries < 3800 && pineCount < maxPines; tries++) {
      const x = (rng() - 0.5) * 980, z = (rng() - 0.5) * 980, y = heightAt(x, z);
      if (y < 2.5 || y > 62) continue;
      if (Math.abs(x - roadCenterX(z)) < 11.5) continue;
      if (Math.hypot(x - LANDMARKS.clachan.x, z - LANDMARKS.clachan.z) < 34) continue;
      if (Math.hypot(x - LANDMARKS.watchtower.x, z - LANDMARKS.watchtower.z) < 26) continue;
      if (fbm2D(x * 0.011, z * 0.011, 3, 9101) < -0.14 && rng() > 0.16) continue;
      if (1 - normalAt(x, z, 1.0).y > 0.27) continue;

      const scale = 0.92 + rng() * 1.25;
      dummy.position.set(x, y - 0.25, z);
      dummy.rotation.set((rng() - 0.5) * 0.10, rng() * Math.PI * 2, (rng() - 0.5) * 0.10);
      dummy.scale.set(scale, scale * (0.90 + rng() * 0.36), scale);
      dummy.updateMatrix();
      trunks.setMatrixAt(pineCount, dummy.matrix);
      crowns.setMatrixAt(pineCount, dummy.matrix);
      const tone = 0.78 + rng() * 0.32;
      color.setRGB(tone * 0.96, tone, tone * 0.92);
      crowns.setColorAt(pineCount++, color);
    }
    trunks.count = crowns.count = pineCount;
    trunks.instanceMatrix.needsUpdate = crowns.instanceMatrix.needsUpdate = true;
    if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;

    let rockCount = 0;
    for (let tries = 0; tries < 2200 && rockCount < maxRocks; tries++) {
      const x = (rng() - 0.5) * 980, z = (rng() - 0.5) * 980, y = heightAt(x, z);
      if (y < 0.2 || Math.abs(x - roadCenterX(z)) < 6.5 || Math.hypot(x - LANDMARKS.clachan.x, z - LANDMARKS.clachan.z) < 24) continue;
      const sx = 0.65 + rng() * 2.6, sy = 0.38 + rng() * 1.45, sz = 0.65 + rng() * 2.6;
      dummy.position.set(x, y + sy * 0.14, z);
      dummy.rotation.set(rng() * 0.6, rng() * Math.PI * 2, rng() * 0.6);
      dummy.scale.set(sx, sy, sz);
      dummy.updateMatrix();
      rocks.setMatrixAt(rockCount++, dummy.matrix);
    }
    rocks.count = rockCount;
    rocks.instanceMatrix.needsUpdate = true;
    this.scene.add(trunks, crowns, rocks);
  }

  _buildStreaming3DFoliage() {
    const grassGeo = createFeatheredTuftGeometry(1.18, 0.64, 3);
    const heatherGeo = createFeatheredTuftGeometry(1.08, 0.56, 4);

    this.grassInst = new THREE.InstancedMesh(
      grassGeo,
      createOnixFoliageMaterial(this.sharedUniforms, { kind: 'grass', map: this.grassTex, fadeStart: 44.0, fadeEnd: 88.0 }),
      MAX_GRASS
    );
    this.heatherInst = new THREE.InstancedMesh(
      heatherGeo,
      createOnixFoliageMaterial(this.sharedUniforms, { kind: 'heather', map: this.heatherSprigTex, fadeStart: 46.0, fadeEnd: 90.0 }),
      MAX_HEATHER
    );
    this.grassInst.receiveShadow = this.heatherInst.receiveShadow = true;
    this.grassInst.frustumCulled = this.heatherInst.frustumCulled = false;
    this.scene.add(this.grassInst, this.heatherInst);
  }

  _updateStreamingFoliage(px, pz, camYaw) {
    const focusX = px - Math.sin(camYaw) * 28.0;
    const focusZ = pz - Math.cos(camYaw) * 28.0;
    if (Math.hypot(focusX - this.lastFoliageX, focusZ - this.lastFoliageZ) < 5.5) return;
    this.lastFoliageX = focusX; this.lastFoliageZ = focusZ;

    const baseGX = Math.round(focusX / FOLIAGE_STEP);
    const baseGZ = Math.round(focusZ / FOLIAGE_STEP);
    const maxR = FOLIAGE_HALF_GRID * FOLIAGE_STEP;
    const dummy = this.tmpDummy, col = this.tmpColor;
    let gCount = 0, hCount = 0;

    for (let dz = -FOLIAGE_HALF_GRID; dz <= FOLIAGE_HALF_GRID; dz++) {
      for (let dx = -FOLIAGE_HALF_GRID; dx <= FOLIAGE_HALF_GRID; dx++) {
        const gx = baseGX + dx, gz = baseGZ + dz;
        const r1 = hash2D(gx, gz, 4101), r2 = hash2D(gx, gz, 4201), r3 = hash2D(gx, gz, 4301);
        const wx = (gx + (r1 - 0.5) * 0.96) * FOLIAGE_STEP;
        const wz = (gz + (r2 - 0.5) * 0.96) * FOLIAGE_STEP;
        if (Math.hypot(wx - focusX, wz - focusZ) > maxR) continue;

        const wy = heightAt(wx, wz);
        if (wy < WATER_LEVEL + 1.4 || wy > 56) continue;
        if (Math.abs(wx - roadCenterX(wz)) < 4.9 || Math.hypot(wx - LANDMARKS.clachan.x, wz - LANDMARKS.clachan.z) < 5.2) continue;

        const surf = surfaceAt(wx, wz);
        if (surf.id === 'granite' || surf.id === 'water' || surf.id === 'shingle') continue;

        const drift = fbm2D(wx * 0.024, wz * 0.024, 3, 17447);
        if (fbm2D(wx * 0.06, wz * 0.06, 2, 17448) < -0.34 && r3 < 0.65) continue;

        const isHeather = surf.id === 'heather' ? r3 > 0.28 : (drift > 0.08 && wy > 4.0 && r3 > 0.36);
        const scale = 0.82 + r1 * 0.86;
        dummy.position.set(wx, wy - 0.06, wz);
        dummy.rotation.set(0, r2 * Math.PI * 2, 0);
        dummy.scale.set(scale, scale * (0.82 + r3 * 0.44), scale);
        dummy.updateMatrix();

        if (isHeather) {
          if (hCount >= MAX_HEATHER) continue;
          this.heatherInst.setMatrixAt(hCount, dummy.matrix);
          const shade = 0.78 + r2 * 0.36;
          col.setRGB(shade * 1.04, shade * 0.96, shade * 1.05);
          this.heatherInst.setColorAt(hCount++, col);
        } else {
          if (gCount >= MAX_GRASS) continue;
          this.grassInst.setMatrixAt(gCount, dummy.matrix);
          const shade = 0.78 + r1 * 0.36;
          col.setRGB(shade * 1.04, shade, shade * 0.90);
          this.grassInst.setColorAt(gCount++, col);
        }
      }
    }

    this.grassInst.count = gCount; this.heatherInst.count = hCount;
    this.grassInst.instanceMatrix.needsUpdate = this.heatherInst.instanceMatrix.needsUpdate = true;
    if (this.grassInst.instanceColor) this.grassInst.instanceColor.needsUpdate = true;
    if (this.heatherInst.instanceColor) this.heatherInst.instanceColor.needsUpdate = true;
  }

  _buildSmokeAndRain() {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
    g.addColorStop(0, 'rgba(215,212,204,0.56)');
    g.addColorStop(0.5, 'rgba(170,174,178,0.22)');
    g.addColorStop(1, 'rgba(145,150,156,0.0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
    const smokeTex = new THREE.CanvasTexture(c);

    for (const src of this.smokeSources || []) {
      for (let i = 0; i < 9; i++) {
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTex, transparent: true, opacity: 0.34, depthWrite: false }));
        this.scene.add(sprite);
        this.smokeParticles.push({ sprite, src, age: i / 9, speed: 0.13 + (i % 4) * 0.025, seed: i * 1.9 });
      }
    }

    const dropCount = 900;
    this.rainPositions = new Float32Array(dropCount * 6);
    this.rainOffsets = new Float32Array(dropCount * 3);
    const rng = mulberry32(17447);
    for (let i = 0; i < dropCount; i++) {
      this.rainOffsets[i * 3] = (rng() - 0.5) * 44;
      this.rainOffsets[i * 3 + 1] = rng() * 22;
      this.rainOffsets[i * 3 + 2] = (rng() - 0.5) * 44;
    }
    const rainGeo = new THREE.BufferGeometry();
    rainGeo.setAttribute('position', new THREE.BufferAttribute(this.rainPositions, 3));
    this.rainLines = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({ color: 0xb6c6d4, transparent: true, opacity: 0.36, depthWrite: false }));
    this.rainLines.frustumCulled = false;
    this.rainLines.visible = false;
    this.scene.add(this.rainLines);
  }

  _buildChunk(cx, cz, highDetail) {
    const segs = highDetail ? 48 : 16;
    const geo = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE, segs, segs);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const originX = cx * CHUNK_SIZE, originZ = cz * CHUNK_SIZE;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, heightAt(pos.getX(i) + originX, pos.getZ(i) + originZ));
    }
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, this.terrainMat);
    mesh.position.set(originX, 0, originZ);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    return { mesh, highDetail };
  }

  _updateTerrainChunks(px, pz) {
    const pcx = Math.round(px / CHUNK_SIZE), pcz = Math.round(pz / CHUNK_SIZE);
    const needed = new Set();
    for (let dz = -CHUNK_RADIUS; dz <= CHUNK_RADIUS; dz++) {
      for (let dx = -CHUNK_RADIUS; dx <= CHUNK_RADIUS; dx++) {
        const cx = pcx + dx, cz = pcz + dz, key = `${cx},${cz}`;
        needed.add(key);
        const wantHigh = Math.abs(dx) <= 1 && Math.abs(dz) <= 1;
        const existing = this.chunks.get(key);
        if (!existing) this.chunks.set(key, this._buildChunk(cx, cz, wantHigh));
        else if (existing.highDetail !== wantHigh) {
          this.scene.remove(existing.mesh); existing.mesh.geometry.dispose();
          this.chunks.set(key, this._buildChunk(cx, cz, wantHigh));
        }
      }
    }
    for (const [key, entry] of this.chunks.entries()) {
      if (!needed.has(key)) {
        this.scene.remove(entry.mesh); entry.mesh.geometry.dispose();
        this.chunks.delete(key);
      }
    }
  }

  _updateAtmosphere(dt, worldState, px, pz) {
    const wState = worldState.weather?.state || 'clear';
    const targetRain = wState === 'rain' ? 1.0 : 0.0;
    const targetMist = wState === 'mist' ? 1.55 : wState === 'rain' ? 1.05 : 0.55;
    const targetStorm = wState === 'rain' ? 0.92 : wState === 'mist' ? 0.58 : 0.28;

    const blend = 1 - Math.exp(-1.5 * dt);
    this.sharedUniforms.uRain.value = lerp(this.sharedUniforms.uRain.value, targetRain, blend);
    this.sharedUniforms.uMistStrength.value = lerp(this.sharedUniforms.uMistStrength.value, targetMist, blend);
    this.skyUniforms.uStormFactor.value = lerp(this.skyUniforms.uStormFactor.value, targetStorm, blend);

    const storm = this.skyUniforms.uStormFactor.value;
    const rain = this.sharedUniforms.uRain.value;

    const sunAngle = ((worldState.timeOfDay - 6) / 24) * Math.PI * 2;
    const elev = Math.sin(sunAngle), horiz = Math.cos(sunAngle);
    this.sharedUniforms.uSunDir.value.set(horiz * 0.85, Math.max(elev, -0.25), -0.40).normalize();
    const dayFactor = clamp((elev + 0.08) / 0.42, 0, 1);
    const goldenFactor = clamp(1 - Math.abs(elev - 0.16) / 0.32, 0, 1);

    this.sharedUniforms.uDayFactor.value = dayFactor;
    this.skyUniforms.uGoldenFactor.value = goldenFactor;

    const snapX = Math.round(px / 2) * 2, snapZ = Math.round(pz / 2) * 2;
    const activeDir = elev > 0.02 ? this.sharedUniforms.uSunDir.value : new THREE.Vector3(-0.4, 0.55, 0.5).normalize();
    this.sunLight.position.set(snapX + activeDir.x * 160, activeDir.y * 160, snapZ + activeDir.z * 160);
    this.sunLight.target.position.set(snapX, 0, snapZ);
    this.sunLight.target.updateMatrixWorld();

    const fogNight = new THREE.Color(0x091220);
    const fogDay = new THREE.Color(0x6b8092).lerp(new THREE.Color(0x47525e), storm);
    const fogGold = new THREE.Color(0xd28444);
    this.scene.fog.color.copy(fogNight).lerp(fogDay, dayFactor).lerp(fogGold, goldenFactor * 0.62 * (1 - storm * 0.68));
    this.scene.fog.density = lerp(0.00088, 0.0030, clamp((targetMist - 0.50) / 1.05, 0, 1));

    const sunHex = elev > 0.02 ? (goldenFactor > 0.22 ? 0xffb362 : 0xffe8c6) : 0x7c9ec8;
    this.sunLight.color.setHex(sunHex);
    this.sharedUniforms.uSunColor.value.setHex(sunHex);

    const sunMult = 1 - storm * 0.56;
    this.sunLight.intensity = elev > 0.02 ? lerp(0.65, 3.45, dayFactor) * sunMult : 0.34;
    this.hemiLight.intensity = lerp(0.18, 0.62, dayFactor) * lerp(1.0, 0.78, storm);
    this.scene.environmentIntensity = lerp(0.24, 0.88, dayFactor) * lerp(1.0, 0.72, storm);

    for (const f of this.flickerLights) {
      const pulse = 0.88 + Math.sin(this.elapsed * 9.5 + f.phase) * 0.1 + Math.sin(this.elapsed * 21 + f.phase) * 0.06;
      f.light.intensity = f.baseIntensity * pulse * lerp(2.0, 0.95, dayFactor);
      f.flame.scale.set(1, pulse, 1);
    }

    if (this.towerFlag) {
      const wind = this.onixField.sampleWind(LANDMARKS.watchtower.x, LANDMARKS.watchtower.z);
      this.towerFlag.rotation.y = Math.atan2(wind.z, wind.x) + Math.sin(this.elapsed * (4.2 + rain * 4)) * 0.2;
    }

    this.rainLines.visible = rain > 0.08;
    if (this.rainLines.visible) {
      this.rainLines.material.opacity = rain * 0.38;
      const wind = this.onixField.sampleWind(px, pz);
      const pos = this.rainPositions, off = this.rainOffsets;
      const slantX = wind.x * 0.28, slantZ = wind.z * 0.28;
      for (let i = 0; i < off.length / 3; i++) {
        const oi = i * 3;
        off[oi + 1] -= 24.0 * dt;
        if (off[oi + 1] < -2) off[oi + 1] += 22;
        const rx = this.camPos.x + off[oi];
        const ry = this.camPos.y - 6 + off[oi + 1];
        const rz = this.camPos.z + off[oi + 2];
        const pi = i * 6;
        pos[pi] = rx; pos[pi + 1] = ry; pos[pi + 2] = rz;
        pos[pi + 3] = rx + slantX; pos[pi + 4] = ry - 0.85; pos[pi + 5] = rz + slantZ;
      }
      this.rainLines.geometry.attributes.position.needsUpdate = true;
    }
  }

  _updateSmoke(dt) {
    for (const p of this.smokeParticles) {
      p.age += dt * p.speed;
      if (p.age > 1) p.age -= 1;
      const wind = this.onixField.sampleWind(p.src.x, p.src.z);
      p.sprite.position.set(
        p.src.x + p.age * (2.6 + wind.x * 2.8) + Math.sin(this.elapsed * 0.9 + p.seed) * 0.4 * p.age,
        p.src.y + p.age * 9.5,
        p.src.z + p.age * (1.2 + wind.z * 2.8) + Math.cos(this.elapsed * 0.7 + p.seed) * 0.35 * p.age
      );
      const scale = lerp(0.9, 4.8, p.age);
      p.sprite.scale.set(scale, scale, 1);
      p.sprite.material.opacity = Math.sin(p.age * Math.PI) * 0.36;
    }
  }

  update(dt, player, mount, combat, redcoats, worldState) {
    this.elapsed += dt;
    this.sharedUniforms.uTime.value = this.elapsed;

    this._updateTerrainChunks(player.x, player.z);
    this._updateStreamingFoliage(player.x, player.z, player.camYaw);
    this.bramble.update(mount, this.elapsed);

    // Compute exact First-Person eye position (on-foot stride bob OR horizon-stabilized saddle height)
    const isAiming = (combat.weapon === 'bow' && combat.bowDrawing) || (combat.weapon === 'flintlock' && combat.flintlockReloadTimer <= 0);
    let targetX = player.x;
    let targetZ = player.z;
    let targetY;
    let horizonRoll = 0;

    if (mount.mounted) {
      // Seat eyes squarely over Bramble's saddle looking out over his arched neck & ears
      const saddleBack = 0.06;
      targetX = mount.x + Math.sin(mount.yaw) * saddleBack;
      targetZ = mount.z + Math.cos(mount.yaw) * saddleBack;
      const horseBob = this.bramble.bodyGroup.position.y * (isAiming ? 0.18 : 0.44);
      targetY = mount.y + 2.38 + horseBob;
      horizonRoll = -mount.roll * 0.20;
    } else {
      const moveAmp = clamp(player.speed / 6.5, 0, 1) * (isAiming ? 0.25 : 1.0);
      const stepBob = Math.abs(Math.sin(player.stridePhase)) * 0.042 * moveAmp;
      targetY = player.y + lerp(1.68, 1.02, player.crouchBlend) + stepBob;
    }

    if (this.camPos.lengthSq() === 0) {
      this.camPos.set(targetX, targetY, targetZ);
    } else {
      // Zero-lag horizontal tracking + silky vertical terrain/saddle stabilization
      this.camPos.x = targetX;
      this.camPos.z = targetZ;
      this.camPos.y = lerp(this.camPos.y, targetY, 1 - Math.exp(-18 * dt));
    }

    this.playerRig.position.copy(this.camPos);

    // Dynamic First-Person FOV: 68° base for wide melee awareness, 50° focused aim, 74° gallop rush
    const speedNorm = mount.mounted ? clamp(mount.speed / 14.0, 0, 1) : 0;
    const targetFov = isAiming ? 50 : mount.mounted ? lerp(68, 74, speedNorm) : 68;
    if (Math.abs(this.camera.fov - targetFov) > 0.05) {
      this.camera.fov = lerp(this.camera.fov, targetFov, 1 - Math.exp(-8 * dt));
      this.camera.updateProjectionMatrix();
    }

    // Apply exact eye orientation + tactical combat impact shake (parries, back-targe jolts, flintlock recoil)
    const shake = combat.screenShake;
    const shakeX = (Math.random() - 0.5) * shake * 0.05;
    const shakeY = (Math.random() - 0.5) * shake * 0.05;
    const shakeRoll = (Math.random() - 0.5) * shake * 0.045;

    this.camera.position.set(shakeX, shakeY, 0);
    this.camera.rotation.set(-player.camPitch, player.camYaw, horizonRoll + shakeRoll);

    // Update Dishonored-style First-Person arms & weapons
    this.fpRig.update(dt, player, mount, combat, this.elapsed);

    // Update atmosphere, sky, water, smoke, Redcoats & gore FX around live eye position
    this._updateAtmosphere(dt, worldState, player.x, player.z);
    this._updateSmoke(dt);
    this.skyDome.position.copy(this.camPos);
    this.waterMesh.position.x = Math.round(player.x / 50) * 50;
    this.waterMesh.position.z = Math.round(player.z / 50) * 50;

    this.redcoatRenderer.sync(redcoats, this.elapsed);
    this.combatFX.update(dt, combat, this.onixField);
    this.post?.setDamageFlash(combat.damageFlash);
  }

  render() {
    if (this.post) this.post.render(this.scene, this.camera);
    else this.renderer.render(this.scene, this.camera);
  }

  resize() {
    if (!this.renderer) return;
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.post?.resize(window.innerWidth, window.innerHeight);
  }
}
