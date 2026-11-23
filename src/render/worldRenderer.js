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

const CHUNK_SIZE = 120;
const CHUNK_RADIUS = 4;

// Camera-forward foliage carpet: shifts 26m ahead of Callum and fades cleanly out to 86m
const FOLIAGE_STEP = 1.65;
const FOLIAGE_HALF_GRID = 38;
const MAX_GRASS = 3400;
const MAX_HEATHER = 2200;

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

// Painterly alpha-feathered Caledonian Scots Pine bough texture (airy sky gaps, zero solid blobs)
function createPainterlyPineBoughTexture(aniso = 8) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rng = mulberry32(41744);
  ctx.clearRect(0, 0, size, size);

  const cx = size * 0.5;
  const cy = size * 0.54;

  // Fine reddish-brown interior Scots pine twigs
  ctx.strokeStyle = '#3f281b';
  ctx.lineCap = 'round';
  for (let b = 0; b < 6; b++) {
    const a = -Math.PI * 0.92 + (b / 5) * Math.PI * 0.84 + (rng() - 0.5) * 0.25;
    const len = 58 + rng() * 44;
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    ctx.moveTo(cx, cy + 16);
    ctx.quadraticCurveTo(cx + Math.cos(a) * len * 0.5, cy + Math.sin(a) * len * 0.35, cx + Math.cos(a) * len, cy + Math.sin(a) * len);
    ctx.stroke();
  }

  // Clustered radiating painterly pine-needle fans (leaves organic daylight holes between clusters)
  const clusters = 15;
  for (let c = 0; c < clusters; c++) {
    const ang = rng() * Math.PI * 2;
    const dist = Math.pow(rng(), 0.72) * 74;
    const kx = cx + Math.cos(ang) * dist;
    const ky = cy + Math.sin(ang) * dist * 0.78 - 6;
    const sunBias = clamp(1 - ky / size + (rng() - 0.5) * 0.25, 0, 1);

    for (let n = 0; n < 38; n++) {
      const na = rng() * Math.PI * 2;
      const nr = 10 + rng() * 26;
      const r = Math.round(lerp(22, 64, sunBias) + (rng() - 0.5) * 14);
      const g = Math.round(lerp(42, 92, sunBias) + (rng() - 0.5) * 18);
      const b = Math.round(lerp(28, 46, sunBias) + (rng() - 0.5) * 10);

      ctx.strokeStyle = `rgb(${r},${g},${b})`;
      ctx.lineWidth = 2.0 + rng() * 1.4;
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

// Painterly feathery Highland Bell-Heather sprig texture (woody stems + delicate wine/plum floret strokes)
function createPainterlyHeatherSprigTexture(aniso = 8) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rng = mulberry32(81744);
  ctx.clearRect(0, 0, size, size);

  // Branching woody heather stems sweeping outward from root
  const stems = 26;
  for (let s = 0; s < stems; s++) {
    const sx = size * (0.20 + rng() * 0.60);
    const h = size * (0.36 + rng() * 0.52);
    const lean = (sx - size * 0.5) * 1.05 + (rng() - 0.5) * 58;
    const ex = clamp(sx + lean, 12, size - 12);
    const ey = clamp(size - h, 14, size - 20);
    const mx = (sx + ex) * 0.5 + (rng() - 0.5) * 18;
    const my = (size + ey) * 0.5;

    // Woody evergreen base stem
    ctx.strokeStyle = '#333b22';
    ctx.lineWidth = 3.2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(sx, size + 2);
    ctx.quadraticCurveTo(mx, my, ex, ey);
    ctx.stroke();

    // Fine olive foliage & feathery painterly heather blossom spikes along upper stem
    const hasFlower = rng() > 0.24;
    for (let t = 0.22; t <= 1.0; t += 0.075) {
      const omt = 1 - t;
      const px = omt * omt * sx + 2 * omt * t * mx + t * t * ex;
      const py = omt * omt * size + 2 * omt * t * my + t * t * ey;

      if (hasFlower && t > 0.44) {
        // Muted Romantic heather wine, dusky plum, and rose-violet oil dabs
        const r = Math.round(112 + rng() * 62);
        const g = Math.round(48 + rng() * 34);
        const b = Math.round(98 + rng() * 58);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.beginPath();
        ctx.ellipse(
          px + (rng() - 0.5) * 12,
          py + (rng() - 0.5) * 8,
          3.2 + rng() * 4.2,
          2.2 + rng() * 2.8,
          rng() * Math.PI,
          0,
          Math.PI * 2
        );
        ctx.fill();
      } else {
        // Deep Scottish heather-moss needles blending down into the turf
        const r = Math.round(46 + rng() * 26);
        const g = Math.round(68 + rng() * 32);
        const b = Math.round(30 + rng() * 18);
        ctx.strokeStyle = `rgb(${r},${g},${b})`;
        ctx.lineWidth = 2.4;
        const a = -Math.PI * 0.5 + (rng() - 0.5) * 1.9;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + Math.cos(a) * 11, py + Math.sin(a) * 11);
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

// Lush 16-blade arching Highland sedge & moor-grass clump with terrain-matched roots (zero dark rug seam!)
function create3DGrassClumpGeometry() {
  const rng = mulberry32(3041);
  const blades = 16;
  const positions = [];
  const normals = [];
  const colors = [];

  for (let b = 0; b < blades; b++) {
    const ang = (b / blades) * Math.PI * 2 + (rng() - 0.5) * 0.5;
    const rad = 0.04 + rng() * 0.34;
    const bx = Math.cos(ang) * rad;
    const bz = Math.sin(ang) * rad;
    const isTallReed = rng() > 0.62;
    const h = isTallReed ? 0.42 + rng() * 0.34 : 0.22 + rng() * 0.24;
    const w0 = 0.032 + rng() * 0.018;
    const lean = 0.14 + rng() * 0.28;
    const isGolden = rng() > 0.42;

    const dirX = Math.cos(ang);
    const dirZ = Math.sin(ang);
    const perpX = -dirZ;
    const perpZ = dirX;

    const p0L = [bx - perpX * w0, 0, bz - perpZ * w0];
    const p0R = [bx + perpX * w0, 0, bz + perpZ * w0];
    const p1L = [bx + dirX * lean * 0.45 - perpX * w0 * 0.5, h * 0.55, bz + dirZ * lean * 0.45 - perpZ * w0 * 0.5];
    const p1R = [bx + dirX * lean * 0.45 + perpX * w0 * 0.5, h * 0.55, bz + dirZ * lean * 0.45 + perpZ * w0 * 0.5];
    const p2T = [bx + dirX * lean, h, bz + dirZ * lean];

    // Terrain-matched warm moss root -> sunlit olive/ochre tip so mid-ground melts cleanly into the hillside
    const cRoot = [0.052, 0.074, 0.026];
    const cMid = isGolden ? [0.115, 0.098, 0.038] : [0.072, 0.098, 0.032];
    const cTip = isGolden ? [0.215, 0.165, 0.062] : [0.122, 0.140, 0.048];
    const nUp = [dirX * 0.18, 0.98, dirZ * 0.18];

    const pushTri = (a, cA, bV, cB, c, cC) => {
      positions.push(...a, ...bV, ...c);
      normals.push(...nUp, ...nUp, ...nUp);
      colors.push(...cA, ...cB, ...cC);
    };

    pushTri(p0L, cRoot, p0R, cRoot, p1R, cMid);
    pushTri(p0L, cRoot, p1R, cMid, p1L, cMid);
    pushTri(p1L, cMid, p1R, cMid, p2T, cTip);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geo;
}

// Feathered painterly heather bush (4 cupped crossed sprig planes with soft spherical upward normals)
function createFeatheredHeatherShrubGeometry() {
  const planes = [];
  const configs = [
    { rotY: 0.0, tilt: 0.14, w: 0.95, h: 0.56, ox: 0, oz: 0 },
    { rotY: Math.PI * 0.34, tilt: -0.14, w: 0.92, h: 0.52, ox: 0.06, oz: -0.05 },
    { rotY: Math.PI * 0.68, tilt: 0.16, w: 0.88, h: 0.50, ox: -0.06, oz: 0.05 },
    { rotY: Math.PI * 0.18, tilt: 0.38, w: 0.78, h: 0.46, ox: 0.0, oz: 0.08 }
  ];

  for (const cfg of configs) {
    const g = new THREE.PlaneGeometry(cfg.w, cfg.h, 2, 2);
    g.translate(0, cfg.h * 0.46, 0);
    g.rotateX(cfg.tilt);
    g.rotateY(cfg.rotY);
    g.translate(cfg.ox, 0, cfg.oz);

    const pos = g.attributes.position;
    const norm = g.attributes.normal;
    const cols = new Float32Array(pos.count * 3);

    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i);
      const py = pos.getY(i);
      const pz = pos.getZ(i);

      // Transferred upward spherical normal removes flat-card harshness
      const nx = px * 0.45;
      const ny = 1.0;
      const nz = pz * 0.45;
      const inv = 1 / Math.hypot(nx, ny, nz);
      norm.setXYZ(i, nx * inv, ny * inv, nz * inv);

      const yNorm = clamp(py / cfg.h, 0, 1);
      const shade = lerp(0.76, 1.06, yNorm);
      cols[i * 3] = shade;
      cols[i * 3 + 1] = shade;
      cols[i * 3 + 2] = shade;
    }
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    planes.push(g);
  }
  return mergeNonIndexedGeos(planes);
}

// Gnarled asymmetric Caledonian Scots Pine skeleton (crooked trunk + sweeping high umbrella boughs)
const PINE_BRANCH_TIPS = [
  { x: 2.05, y: 5.3, z: 0.55, r: 2.35 },
  { x: -1.75, y: 5.7, z: 1.55, r: 2.25 },
  { x: -1.85, y: 6.15, z: -1.35, r: 2.30 },
  { x: 1.35, y: 6.55, z: -1.65, r: 2.15 },
  { x: 0.25, y: 7.25, z: 0.20, r: 2.55 },
  { x: -0.65, y: 6.90, z: 0.65, r: 1.95 }
];

function createScotsPineWoodGeometry() {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.13, 0.36, 7.1, 7, 6);
  trunk.translate(0, 3.45, 0);
  const pos = trunk.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    pos.setX(i, pos.getX(i) + Math.sin(y * 0.46) * 0.28 + y * 0.04);
    pos.setZ(i, pos.getZ(i) + Math.cos(y * 0.38) * 0.18);
  }
  trunk.computeVertexNormals();
  parts.push(trunk);

  // Structural limbs reaching straight into each painterly foliage cluster
  for (let i = 0; i < 4; i++) {
    const tip = PINE_BRANCH_TIPS[i];
    const startY = tip.y - 1.25;
    const startX = Math.sin(startY * 0.46) * 0.28 + startY * 0.04;
    const startZ = Math.cos(startY * 0.38) * 0.18;

    const dx = tip.x - startX;
    const dy = tip.y - startY;
    const dz = tip.z - startZ;
    const len = Math.hypot(dx, dy, dz);

    const limb = new THREE.CylinderGeometry(0.05, 0.12, len, 6);
    limb.translate(0, len * 0.5, 0);
    const dir = new THREE.Vector3(dx, dy, dz).normalize();
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    limb.applyQuaternion(quat);
    limb.translate(startX, startY, startZ);
    parts.push(limb);
  }
  return mergeNonIndexedGeos(parts);
}

// Feathered Painterly Scots Pine Canopy: airy crossed bough sprays + transferred spherical crown normals!
function createScotsPineCanopyFeatheredGeometry() {
  const rng = mulberry32(61744);
  const cards = [];

  for (const cluster of PINE_BRANCH_TIPS) {
    // 5 randomly tilted feathered needle-bough cards per branch cluster -> rich airy oil-painted crown
    for (let k = 0; k < 5; k++) {
      const sz = cluster.r * (0.85 + rng() * 0.42);
      const g = new THREE.PlaneGeometry(sz, sz * 0.88);

      const ox = cluster.x + (rng() - 0.5) * 0.95;
      const oy = cluster.y + (rng() - 0.5) * 0.58;
      const oz = cluster.z + (rng() - 0.5) * 0.95;

      // Tilt cards organically so crown reads full from ground level AND from high ridges
      const pitch = k === 0 ? -Math.PI * 0.42 : (rng() - 0.5) * 1.15;
      const yaw = (k / 5) * Math.PI * 2 + rng() * 0.7;
      const roll = (rng() - 0.5) * 0.55;

      g.rotateX(pitch);
      g.rotateZ(roll);
      g.rotateY(yaw);
      g.translate(ox, oy, oz);

      const pos = g.attributes.position;
      const norm = g.attributes.normal;
      const cols = new Float32Array(pos.count * 3);

      for (let i = 0; i < pos.count; i++) {
        const px = pos.getX(i);
        const py = pos.getY(i);
        const pz = pos.getZ(i);

        // AAA Painterly Trick: Transfer spherical normals from the whole tree crown center
        const nx = px;
        const ny = (py - 5.2) * 1.45 + 1.1;
        const nz = pz;
        const inv = 1 / (Math.hypot(nx, ny, nz) || 1);
        norm.setXYZ(i, nx * inv, ny * inv, nz * inv);

        // Warm sunlit upper crown, deep cool-shaded bough undersides
        const crownLift = clamp((py - 4.4) / 3.4, 0, 1);
        const shade = lerp(0.56, 1.14, crownLift);
        cols[i * 3] = shade;
        cols[i * 3 + 1] = shade;
        cols[i * 3 + 2] = shade;
      }
      g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      cards.push(g);
    }
  }

  return mergeNonIndexedGeos(cards);
}

// Authentic pitched gable roof for Highland stone blackhouses
function createGableRoofGeometry(width, depth, ridgeHeight) {
  const hw = width * 0.5;
  const hd = depth * 0.5;
  const shape = new THREE.Shape();
  shape.moveTo(-hd, 0);
  shape.lineTo(0, ridgeHeight);
  shape.lineTo(hd, 0);
  shape.closePath();

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
    this.camera = new THREE.PerspectiveCamera(54, window.innerWidth / window.innerHeight, 0.2, 2800);
    this.renderer = null;
    this.chunks = new Map();
    this.flickerLights = [];
    this.smokeParticles = [];
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
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
      uMistStrength: { value: 0.52 },
      uDayFactor: { value: 1.0 },
      uSunDir: { value: new THREE.Vector3(0.5, 0.45, -0.45).normalize() },
      uSunColor: { value: new THREE.Color(0xffd79b) }
    };
  }

  init() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance'
    });

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;

    this.scene.fog = new THREE.FogExp2(0x7c8f9e, 0.00125);

    const aniso = this.renderer.capabilities.getMaxAnisotropy();
    this.pineBoughTex = createPainterlyPineBoughTexture(aniso);
    this.heatherSprigTex = createPainterlyHeatherSprigTexture(aniso);

    // Pure-physics Romantic Oil Painting shaders
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
    this._buildCallumMesh();
  }

  getBackendName() {
    return 'ONIX OIL PBR';
  }

  _setupSkyAndIBL() {
    this.skyUniforms = {
      uSunDir: this.sharedUniforms.uSunDir,
      uTime: this.sharedUniforms.uTime,
      uDayFactor: this.sharedUniforms.uDayFactor,
      uGoldenFactor: { value: 0.45 },
      uStormFactor: { value: 0.22 }
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

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
            mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
            f.y
          );
        }
        float fbm(vec2 p) {
          float v = 0.0;
          float a = 0.5;
          mat2 r = mat2(0.8, 0.6, -0.6, 0.8);
          for (int i = 0; i < 5; i++) {
            v += a * noise(p);
            p = r * p * 2.04 + vec2(3.1, 7.4);
            a *= 0.5;
          }
          return v;
        }

        void main() {
          vec3 dir = normalize(vWorldDir);
          float h = clamp(dir.y, 0.0, 1.0);

          vec3 nightZen = vec3(0.006, 0.012, 0.030);
          vec3 nightHor = vec3(0.020, 0.034, 0.062);

          vec3 dayZen = mix(vec3(0.055, 0.140, 0.295), vec3(0.065, 0.082, 0.112), uStormFactor);
          vec3 dayHor = mix(vec3(0.32, 0.42, 0.48), vec3(0.16, 0.19, 0.22), uStormFactor);
          vec3 goldHor = vec3(0.92, 0.48, 0.16);

          vec3 zenith = mix(nightZen, dayZen, uDayFactor);
          vec3 horizon = mix(nightHor, dayHor, uDayFactor);
          horizon = mix(horizon, goldHor, uGoldenFactor * 0.72 * (1.0 - uStormFactor * 0.65));

          vec3 col = mix(horizon, zenith, pow(h, 0.52));

          float sunDot = max(dot(dir, normalize(uSunDir)), 0.0);
          vec3 sunTint = mix(vec3(1.0, 0.56, 0.20), vec3(1.0, 0.90, 0.68), uDayFactor);
          float sunVis = (1.0 - uStormFactor * 0.78) * uDayFactor;
          col += sunTint * pow(sunDot, 6.0) * 0.46 * sunVis;
          col += sunTint * smoothstep(0.9975, 0.9994, sunDot) * 5.2 * sunVis;

          if (dir.y > 0.005) {
            vec2 uv = dir.xz / (dir.y + 0.15) * 1.15;
            uv += vec2(uTime * 0.010, uTime * 0.004);
            vec2 warp = vec2(fbm(uv * 0.8 + 1.4), fbm(uv * 0.8 + 5.2)) - 0.5;
            float c1 = fbm(uv + warp * 0.85);
            float c2 = fbm(uv * 2.3 - vec2(uTime * 0.005, 0.0) + warp * 0.45);
            float cover = mix(0.42, 0.20, uStormFactor);
            float mask = smoothstep(cover, cover + 0.34, c1 * 0.68 + c2 * 0.32);
            mask *= smoothstep(0.005, 0.18, dir.y);

            vec3 cLit = mix(vec3(0.04, 0.06, 0.09), vec3(0.84, 0.82, 0.78), uDayFactor);
            cLit = mix(cLit, vec3(1.0, 0.68, 0.34), clamp(uGoldenFactor * 0.85 + pow(sunDot, 3.0) * 0.6, 0.0, 1.0) * (1.0 - uStormFactor * 0.6));
            vec3 cDark = mix(vec3(0.015, 0.022, 0.038), mix(vec3(0.11, 0.14, 0.20), vec3(0.06, 0.08, 0.11), uStormFactor), uDayFactor);

            float rim = clamp(c2 * 1.1 + pow(sunDot, 4.0) * 0.9 * sunVis, 0.0, 1.0);
            vec3 cloudCol = mix(cDark, cLit, rim);
            col = mix(col, cloudCol, mask * mix(0.88, 0.97, uStormFactor));
          }

          if (uDayFactor < 0.3 && dir.y > 0.08) {
            float star = step(0.9968, hash(floor(dir.xz / max(dir.y, 0.1) * 150.0)));
            col += vec3(0.76, 0.84, 1.0) * star * (1.0 - uDayFactor * 3.2) * (1.0 - uStormFactor);
          }

          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `
    });

    this.skyDome = new THREE.Mesh(new THREE.SphereGeometry(2450, 32, 20), skyMat);
    this.skyDome.frustumCulled = false;
    this.scene.add(this.skyDome);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    const envSky = new THREE.Mesh(
      new THREE.SphereGeometry(30, 16, 12),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        vertexShader: `varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `
          varying vec3 vP;
          void main() {
            vec3 top = vec3(0.18, 0.30, 0.50);
            vec3 mid = vec3(0.54, 0.48, 0.42);
            vec3 bot = vec3(0.04, 0.05, 0.035);
            vec3 c = vP.y > 0.0 ? mix(mid, top, pow(vP.y, 0.58)) : mix(mid, bot, pow(-vP.y, 0.45));
            gl_FragColor = vec4(c, 1.0);
          }
        `
      })
    );
    envScene.add(envSky);
    this.envRT = pmrem.fromScene(envScene, 0.04);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = 0.78;
    pmrem.dispose();
  }

  _setupLighting() {
    this.hemiLight = new THREE.HemisphereLight(0x88b0d8, 0x282c1c, 0.56);
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
    const geo = new THREE.PlaneGeometry(4200, 4200, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.waterMesh = new THREE.Mesh(geo, this.waterMat);
    this.waterMesh.position.y = WATER_LEVEL;
    this.waterMesh.receiveShadow = true;
    this.scene.add(this.waterMesh);
  }

  // 2.4 km Lochaber Munro horizon ring (zero flat sky cutoff; frames Loch Linnhe with Ardgour hills to the west)
  _buildDistantMountains() {
    const segAng = 88;
    const segRad = 18;
    const rInner = 430;
    const rOuter = 2350;

    const verts = [];
    const indices = [];

    for (let ir = 0; ir <= segRad; ir++) {
      const t = ir / segRad;
      // Exponential radial spacing: denser near chunks, sweeping out to 2.35 km
      const r = lerp(rInner, rOuter, t * t * 0.7 + t * 0.3);

      for (let ia = 0; ia <= segAng; ia++) {
        const ang = (ia / segAng) * Math.PI * 2;
        const wx = Math.cos(ang) * r;
        const wz = Math.sin(ang) * r;

        const baseH = heightAt(wx, wz);
        const outerFade = smoothstep(0.04, 0.55, t);
        const edgeDip = ir === 0 ? -2.2 : 0.0;

        // Sea-loch channel runs SW-NE across western side; far Ardgour mountains rise beyond x < -650
        const isOpenLochChannel = wx < -190 && wx > -680 && Math.abs(wz) < 1200;
        const farWestShore = smoothstep(-580, -1080, wx);

        const macroPeaks = ridgeNoise2D(wx * 0.00095, wz * 0.00095, 4, 2744) * 285;
        const subRidges = fbm2D(wx * 0.0022, wz * 0.0022, 3, 3744) * 58;

        let extraH = 0;
        if (wx < -190) {
          // Far shore across Loch Linnhe rises dramatically out of the sea loch
          extraH = (macroPeaks * 0.72 + subRidges * 0.5 + 36) * farWestShore * outerFade;
          if (isOpenLochChannel) extraH = -8;
        } else {
          // Ben Nevis & Great Glen Munros ringing North, East, and South
          const eastBoost = lerp(0.68, 1.15, smoothstep(-190, 900, wx));
          extraH = (macroPeaks * eastBoost + subRidges + 28) * outerFade;
        }

        const wy = baseH + extraH + edgeDip;
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
        indices.push(a, c, b, b, c, d);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    this.horizonMesh = new THREE.Mesh(geo, this.horizonMat);
    this.horizonMesh.receiveShadow = false;
    this.scene.add(this.horizonMesh);
  }

  _buildSector01Landmarks() {
    const emberMat = new THREE.MeshBasicMaterial({ color: 0xff922e });

    const cl = LANDMARKS.clachan;
    const bothies = [
      { dx: -12, dz: -7, w: 8.4, d: 5.0, rot: 0.25 },
      { dx: 11, dz: -10, w: 7.4, d: 4.6, rot: -0.42 },
      { dx: 4, dz: 12, w: 8.8, d: 5.2, rot: 1.38 }
    ];

    this.smokeSources = [];

    for (const b of bothies) {
      const bx = cl.x + b.dx;
      const bz = cl.z + b.dz;
      const by = heightAt(bx, bz);
      const group = new THREE.Group();
      group.position.set(bx, by, bz);
      group.rotation.y = b.rot;

      const walls = new THREE.Mesh(new THREE.BoxGeometry(b.w, 2.7, b.d), this.stoneMat);
      walls.position.y = 1.15;
      walls.castShadow = true;
      walls.receiveShadow = true;
      group.add(walls);

      const gableWalls = new THREE.Mesh(createGableRoofGeometry(b.w - 0.1, b.d - 0.1, 2.25), this.stoneMat);
      gableWalls.position.y = 2.48;
      gableWalls.castShadow = true;
      gableWalls.receiveShadow = true;
      group.add(gableWalls);

      const roof = new THREE.Mesh(createGableRoofGeometry(b.w + 0.85, b.d + 0.95, 2.55), this.thatchMat);
      roof.position.y = 2.38;
      roof.castShadow = true;
      roof.receiveShadow = true;
      group.add(roof);

      const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.9, 0.95), this.darkStoneMat);
      chimney.position.set(b.w * 0.34, 4.4, 0);
      chimney.castShadow = true;
      group.add(chimney);

      const chLocalX = b.w * 0.34;
      const cosR = Math.cos(b.rot);
      const sinR = Math.sin(b.rot);
      this.smokeSources.push({
        x: bx + chLocalX * cosR,
        y: by + 5.35,
        z: bz - chLocalX * sinR
      });

      const door = new THREE.Mesh(new THREE.BoxGeometry(1.12, 1.9, 0.24), this.barkMat);
      door.position.set(0, 0.9, b.d * 0.5 + 0.02);
      group.add(door);

      const lintel = new THREE.Mesh(new THREE.BoxGeometry(1.65, 0.28, 0.36), this.darkStoneMat);
      lintel.position.set(0, 1.98, b.d * 0.5 + 0.06);
      group.add(lintel);

      const winFrame = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.86, 0.16), this.darkStoneMat);
      winFrame.position.set(b.w * 0.26, 1.38, b.d * 0.5);
      group.add(winFrame);

      const winGlow = new THREE.Mesh(
        new THREE.PlaneGeometry(0.66, 0.62),
        new THREE.MeshBasicMaterial({ color: 0xffae4a })
      );
      winGlow.position.set(b.w * 0.26, 1.38, b.d * 0.5 + 0.09);
      group.add(winGlow);

      this.scene.add(group);
    }

    // Dry-stone enclosure dykes
    const dykeArcs = [
      { a0: 0.3, a1: 1.4, r: 21 },
      { a0: 2.1, a1: 3.5, r: 22 },
      { a0: 4.1, a1: 5.4, r: 20 }
    ];
    for (const arc of dykeArcs) {
      const steps = 6;
      for (let i = 0; i < steps; i++) {
        const t0 = lerp(arc.a0, arc.a1, i / steps);
        const t1 = lerp(arc.a0, arc.a1, (i + 1) / steps);
        const mid = (t0 + t1) * 0.5;
        const wx = cl.x + Math.cos(mid) * arc.r;
        const wz = cl.z + Math.sin(mid) * arc.r;
        const wy = heightAt(wx, wz);
        const segLen = arc.r * (t1 - t0) + 0.35;
        const wall = new THREE.Mesh(new THREE.BoxGeometry(segLen, 1.18, 0.68), this.darkStoneMat);
        wall.position.set(wx, wy + 0.44, wz);
        wall.rotation.y = -mid + Math.PI / 2;
        wall.castShadow = true;
        wall.receiveShadow = true;
        this.scene.add(wall);
      }
    }

    // Central Clachan Peat Hearth
    const fireY = heightAt(cl.x, cl.z);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      const st = new THREE.Mesh(new THREE.DodecahedronGeometry(0.32, 0), this.boulderMat);
      st.position.set(cl.x + Math.cos(a) * 1.05, fireY + 0.14, cl.z + Math.sin(a) * 1.05);
      st.scale.set(1.15, 0.72, 1.15);
      st.castShadow = true;
      this.scene.add(st);
    }
    for (let i = 0; i < 4; i++) {
      const log = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 1.2, 6), this.barkMat);
      log.position.set(cl.x, fireY + 0.24, cl.z);
      log.rotation.set(Math.PI / 2 - 0.35, (i * Math.PI) / 2, 0);
      this.scene.add(log);
    }

    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.72, 6), emberMat);
    flame.position.set(cl.x, fireY + 0.48, cl.z);
    this.scene.add(flame);

    const hearthLight = new THREE.PointLight(0xff8428, 20, 40, 1.65);
    hearthLight.position.set(cl.x, fireY + 1.5, cl.z);
    this.scene.add(hearthLight);
    this.flickerLights.push({ light: hearthLight, flame, baseIntensity: 20, phase: 0.4 });
    this.smokeSources.push({ x: cl.x, y: fireY + 0.9, z: cl.z });

    // Scottish Stone Tower-House Keep (Torr an Fhaire)
    const tw = LANDMARKS.watchtower;
    const twY = heightAt(tw.x, tw.z);
    const towerGroup = new THREE.Group();
    towerGroup.position.set(tw.x, twY, tw.z);

    const keepPlinth = new THREE.Mesh(new THREE.CylinderGeometry(5.6, 6.6, 3.2, 4), this.darkStoneMat);
    keepPlinth.rotation.y = Math.PI / 4;
    keepPlinth.position.y = 1.1;
    keepPlinth.castShadow = true;
    keepPlinth.receiveShadow = true;
    towerGroup.add(keepPlinth);

    const keepShaft = new THREE.Mesh(new THREE.BoxGeometry(7.6, 12.2, 7.6), this.stoneMat);
    keepShaft.position.y = 8.4;
    keepShaft.castShadow = true;
    keepShaft.receiveShadow = true;
    towerGroup.add(keepShaft);

    const corbel = new THREE.Mesh(new THREE.BoxGeometry(8.5, 1.2, 8.5), this.darkStoneMat);
    corbel.position.y = 14.8;
    corbel.castShadow = true;
    towerGroup.add(corbel);

    const edgePts = [-3.6, -1.2, 1.2, 3.6];
    for (const p of edgePts) {
      for (const s of [-3.9, 3.9]) {
        const m1 = new THREE.Mesh(new THREE.BoxGeometry(1.35, 1.15, 0.72), this.stoneMat);
        m1.position.set(p, 15.9, s);
        m1.castShadow = true;
        towerGroup.add(m1);

        const m2 = new THREE.Mesh(new THREE.BoxGeometry(0.72, 1.15, 1.35), this.stoneMat);
        m2.position.set(s, 15.9, p);
        m2.castShadow = true;
        towerGroup.add(m2);
      }
    }

    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 6.8, 6), this.barkMat);
    pole.position.set(0, 18.4, 0);
    towerGroup.add(pole);

    this.towerFlag = new THREE.Mesh(
      new THREE.BoxGeometry(2.9, 1.4, 0.06),
      new THREE.MeshStandardMaterial({ color: 0x851c1a, roughness: 0.86 })
    );
    this.towerFlag.position.set(1.45, 20.8, 0);
    towerGroup.add(this.towerFlag);

    const beaconCoords = [
      { x: 0, y: 15.8, z: 0, power: 34 },
      { x: -6.2, y: 2.4, z: 3.4, power: 24 },
      { x: 6.0, y: 2.2, z: -2.8, power: 24 }
    ];
    for (let i = 0; i < beaconCoords.length; i++) {
      const bc = beaconCoords[i];
      const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.36, 1.25, 6), this.darkStoneMat);
      stand.position.set(bc.x, bc.y, bc.z);
      towerGroup.add(stand);

      const bFlame = new THREE.Mesh(new THREE.ConeGeometry(0.46, 1.1, 6), emberMat);
      bFlame.position.set(bc.x, bc.y + 0.95, bc.z);
      towerGroup.add(bFlame);

      const bLight = new THREE.PointLight(0xff8424, bc.power, 64, 1.5);
      bLight.position.set(tw.x + bc.x, twY + bc.y + 1.6, tw.z + bc.z);
      this.scene.add(bLight);
      this.flickerLights.push({ light: bLight, flame: bFlame, baseIntensity: bc.power, phase: i * 2.1 });
      this.smokeSources.push({ x: tw.x + bc.x, y: twY + bc.y + 1.4, z: tw.z + bc.z });
    }
    this.scene.add(towerGroup);

    // Smuggling Cove Timber Jetty on Loch Linnhe
    const jt = LANDMARKS.coveJetty;
    const deck = new THREE.Mesh(new THREE.BoxGeometry(14, 0.35, 3.2), this.barkMat);
    deck.position.set(jt.x - 4, WATER_LEVEL + 0.85, jt.z);
    deck.castShadow = true;
    deck.receiveShadow = true;
    this.scene.add(deck);

    for (let i = -5; i <= 5; i += 2.5) {
      for (const pz of [-1.2, 1.2]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 3.8, 6), this.barkMat);
        post.position.set(jt.x - 4 + i, WATER_LEVEL - 0.3, jt.z + pz);
        post.castShadow = true;
        this.scene.add(post);
      }
    }

    // Stacked Stone Boundary Cairn
    const cr = LANDMARKS.stashCairn;
    const crY = heightAt(cr.x, cr.z);
    for (let layer = 0; layer < 4; layer++) {
      const r = 1.4 - layer * 0.32;
      const st = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 1), this.boulderMat);
      st.position.set(cr.x, crY + 0.45 + layer * 0.5, cr.z);
      st.scale.set(1.1, 0.62, 1.1);
      st.rotation.y = layer * 1.1;
      st.castShadow = true;
      st.receiveShadow = true;
      this.scene.add(st);
    }

    // General Wade's Road Stone Milestones
    for (let mz = -360; mz <= 360; mz += 120) {
      const mx = roadCenterX(mz) + 5.2;
      const my = heightAt(mx, mz);
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.55, 1.45, 0.42), this.stoneMat);
      post.position.set(mx, my + 0.65, mz);
      post.castShadow = true;
      this.scene.add(post);
    }
  }

  _buildInstancedTreesAndRocks() {
    const rng = mulberry32(174401);
    const maxPines = 580;
    const maxRocks = 440;

    const trunkGeo = createScotsPineWoodGeometry();
    const crownGeo = createScotsPineCanopyFeatheredGeometry();
    const crownMat = createOnixFoliageMaterial(this.sharedUniforms, {
      kind: 'pine',
      map: this.pineBoughTex
    });

    const rockGeo = new THREE.IcosahedronGeometry(1.0, 2);
    const rPos = rockGeo.attributes.position;
    for (let i = 0; i < rPos.count; i++) {
      const vx = rPos.getX(i);
      const vy = rPos.getY(i);
      const vz = rPos.getZ(i);
      const n = 0.78 + Math.sin(vx * 3.4 + vy * 2.1) * 0.16 + Math.cos(vz * 4.3 - vx * 2.2) * 0.13;
      rPos.setXYZ(i, vx * n, vy * n, vz * n);
    }
    rockGeo.computeVertexNormals();

    const trunks = new THREE.InstancedMesh(trunkGeo, this.barkMat, maxPines);
    const crowns = new THREE.InstancedMesh(crownGeo, crownMat, maxPines);
    const rocks = new THREE.InstancedMesh(rockGeo, this.boulderMat, maxRocks);

    trunks.castShadow = true;
    trunks.receiveShadow = true;
    crowns.castShadow = true;
    crowns.receiveShadow = true;
    rocks.castShadow = true;
    rocks.receiveShadow = true;

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    let pineCount = 0;
    for (let tries = 0; tries < 3600 && pineCount < maxPines; tries++) {
      const x = (rng() - 0.5) * 980;
      const z = (rng() - 0.5) * 980;
      const y = heightAt(x, z);
      if (y < 2.5 || y > 60) continue;
      if (Math.abs(x - roadCenterX(z)) < 11.5) continue;
      if (Math.hypot(x - LANDMARKS.clachan.x, z - LANDMARKS.clachan.z) < 34) continue;
      if (Math.hypot(x - LANDMARKS.watchtower.x, z - LANDMARKS.watchtower.z) < 26) continue;

      // Group Scots pines into organic Caledonian groves rather than uniform orchards
      const grove = fbm2D(x * 0.011, z * 0.011, 3, 9101);
      if (grove < -0.14 && rng() > 0.15) continue;

      const n = normalAt(x, z, 1.0);
      if (1 - n.y > 0.27) continue;

      const scale = 0.85 + rng() * 1.15;
      dummy.position.set(x, y - 0.25, z);
      dummy.rotation.set((rng() - 0.5) * 0.10, rng() * Math.PI * 2, (rng() - 0.5) * 0.10);
      dummy.scale.set(scale, scale * (0.88 + rng() * 0.36), scale);
      dummy.updateMatrix();

      trunks.setMatrixAt(pineCount, dummy.matrix);
      crowns.setMatrixAt(pineCount, dummy.matrix);
      const tone = 0.78 + rng() * 0.32;
      color.setRGB(tone * 0.96, tone, tone * 0.92);
      crowns.setColorAt(pineCount, color);
      pineCount++;
    }
    trunks.count = pineCount;
    crowns.count = pineCount;
    trunks.instanceMatrix.needsUpdate = true;
    crowns.instanceMatrix.needsUpdate = true;
    if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;

    let rockCount = 0;
    for (let tries = 0; tries < 1800 && rockCount < maxRocks; tries++) {
      const x = (rng() - 0.5) * 980;
      const z = (rng() - 0.5) * 980;
      const y = heightAt(x, z);
      if (y < 0.2) continue;
      if (Math.abs(x - roadCenterX(z)) < 7.5) continue;
      if (Math.hypot(x - LANDMARKS.clachan.x, z - LANDMARKS.clachan.z) < 24) continue;

      const sx = 0.7 + rng() * 2.6;
      const sy = 0.42 + rng() * 1.45;
      const sz = 0.7 + rng() * 2.6;
      dummy.position.set(x, y + sy * 0.16, z);
      dummy.rotation.set(rng() * 0.6, rng() * Math.PI * 2, rng() * 0.6);
      dummy.scale.set(sx, sy, sz);
      dummy.updateMatrix();

      rocks.setMatrixAt(rockCount, dummy.matrix);
      rockCount++;
    }
    rocks.count = rockCount;
    rocks.instanceMatrix.needsUpdate = true;

    this.scene.add(trunks, crowns, rocks);
  }

  _buildStreaming3DFoliage() {
    const grassGeo = create3DGrassClumpGeometry();
    const heatherGeo = createFeatheredHeatherShrubGeometry();

    const grassMat = createOnixFoliageMaterial(this.sharedUniforms, {
      kind: 'grass',
      fadeStart: 42.0,
      fadeEnd: 84.0
    });
    const heatherMat = createOnixFoliageMaterial(this.sharedUniforms, {
      kind: 'heather',
      map: this.heatherSprigTex,
      fadeStart: 44.0,
      fadeEnd: 86.0
    });

    this.grassInst = new THREE.InstancedMesh(grassGeo, grassMat, MAX_GRASS);
    this.heatherInst = new THREE.InstancedMesh(heatherGeo, heatherMat, MAX_HEATHER);

    this.grassInst.receiveShadow = true;
    this.heatherInst.receiveShadow = true;
    this.grassInst.frustumCulled = false;
    this.heatherInst.frustumCulled = false;

    this.scene.add(this.grassInst, this.heatherInst);
  }

  _updateStreamingFoliage(px, pz, camYaw) {
    // Shift streaming disc 26m ahead along camera gaze -> doubles visible grass distance in front of you!
    const focusX = px - Math.sin(camYaw) * 26.0;
    const focusZ = pz - Math.cos(camYaw) * 26.0;

    if (Math.hypot(focusX - this.lastFoliageX, focusZ - this.lastFoliageZ) < 5.5) return;
    this.lastFoliageX = focusX;
    this.lastFoliageZ = focusZ;

    const baseGX = Math.round(focusX / FOLIAGE_STEP);
    const baseGZ = Math.round(focusZ / FOLIAGE_STEP);
    const maxR = FOLIAGE_HALF_GRID * FOLIAGE_STEP;
    const dummy = this.tmpDummy;
    const col = this.tmpColor;

    let gCount = 0;
    let hCount = 0;

    for (let dz = -FOLIAGE_HALF_GRID; dz <= FOLIAGE_HALF_GRID; dz++) {
      for (let dx = -FOLIAGE_HALF_GRID; dx <= FOLIAGE_HALF_GRID; dx++) {
        const gx = baseGX + dx;
        const gz = baseGZ + dz;

        const r1 = hash2D(gx, gz, 4101);
        const r2 = hash2D(gx, gz, 4201);
        const r3 = hash2D(gx, gz, 4301);

        const wx = (gx + (r1 - 0.5) * 0.96) * FOLIAGE_STEP;
        const wz = (gz + (r2 - 0.5) * 0.96) * FOLIAGE_STEP;

        if (Math.hypot(wx - focusX, wz - focusZ) > maxR) continue;

        const wy = heightAt(wx, wz);
        if (wy < WATER_LEVEL + 1.4 || wy > 56) continue;
        if (Math.abs(wx - roadCenterX(wz)) < 4.9) continue;
        if (Math.hypot(wx - LANDMARKS.clachan.x, wz - LANDMARKS.clachan.z) < 5.2) continue;

        const surf = surfaceAt(wx, wz);
        if (surf.id === 'granite' || surf.id === 'water' || surf.id === 'shingle') continue;

        // Organic sweeping Highland moorland drifts (dense patches + open mossy clearings, zero grid feel)
        const drift = fbm2D(wx * 0.026, wz * 0.026, 3, 17447);
        const density = fbm2D(wx * 0.065, wz * 0.065, 2, 17448);
        if (density < -0.26 && r3 < 0.72) continue;

        const isHeather = surf.id === 'heather' ? drift > -0.18 && r3 > 0.26 : drift > 0.22 && r3 > 0.45;
        const scale = 0.78 + r1 * 0.82;

        dummy.position.set(wx, wy - 0.05, wz);
        dummy.rotation.set(0, r2 * Math.PI * 2, 0);
        dummy.scale.set(scale, scale * (0.82 + r3 * 0.44), scale);
        dummy.updateMatrix();

        if (isHeather) {
          if (hCount >= MAX_HEATHER) continue;
          this.heatherInst.setMatrixAt(hCount, dummy.matrix);
          const shade = 0.76 + r2 * 0.38;
          col.setRGB(shade * 1.02, shade * 0.96, shade * 1.04);
          this.heatherInst.setColorAt(hCount, col);
          hCount++;
        } else {
          if (gCount >= MAX_GRASS) continue;
          this.grassInst.setMatrixAt(gCount, dummy.matrix);
          const shade = 0.78 + r1 * 0.36;
          col.setRGB(shade * 1.04, shade, shade * 0.90);
          this.grassInst.setColorAt(gCount, col);
          gCount++;
        }
      }
    }

    this.grassInst.count = gCount;
    this.heatherInst.count = hCount;
    this.grassInst.instanceMatrix.needsUpdate = true;
    this.heatherInst.instanceMatrix.needsUpdate = true;
    if (this.grassInst.instanceColor) this.grassInst.instanceColor.needsUpdate = true;
    if (this.heatherInst.instanceColor) this.heatherInst.instanceColor.needsUpdate = true;
  }

  _buildSmokeAndRain() {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
    g.addColorStop(0, 'rgba(215,212,204,0.56)');
    g.addColorStop(0.5, 'rgba(170,174,178,0.22)');
    g.addColorStop(1, 'rgba(145,150,156,0.0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    const smokeTex = new THREE.CanvasTexture(c);

    for (const src of this.smokeSources || []) {
      for (let i = 0; i < 9; i++) {
        const mat = new THREE.SpriteMaterial({
          map: smokeTex,
          transparent: true,
          opacity: 0.34,
          depthWrite: false
        });
        const sprite = new THREE.Sprite(mat);
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
    const rainMat = new THREE.LineBasicMaterial({
      color: 0xb6c6d4,
      transparent: true,
      opacity: 0.36,
      depthWrite: false
    });
    this.rainLines = new THREE.LineSegments(rainGeo, rainMat);
    this.rainLines.frustumCulled = false;
    this.rainLines.visible = false;
    this.scene.add(this.rainLines);
  }

  _buildCallumMesh() {
    this.callum = new THREE.Group();

    const woolCoatMat = new THREE.MeshStandardMaterial({ color: 0x2a241d, roughness: 0.92 });
    const leatherMat = new THREE.MeshStandardMaterial({ color: 0x221710, roughness: 0.76 });
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xc29372, roughness: 0.78 });
    const bonnetMat = new THREE.MeshStandardMaterial({ color: 0x1a2634, roughness: 0.94 });
    const hairMat = new THREE.MeshStandardMaterial({ color: 0x241811, roughness: 0.9 });
    const steelMat = new THREE.MeshStandardMaterial({ color: 0xb4bec7, roughness: 0.25, metalness: 0.88 });

    this.callumBody = new THREE.Group();
    this.callum.add(this.callumBody);

    const legGeo = new THREE.CapsuleGeometry(0.088, 0.62, 5, 8);
    legGeo.translate(0, -0.36, 0);
    this.leftLeg = new THREE.Mesh(legGeo, leatherMat);
    this.leftLeg.position.set(-0.13, 0.82, 0);
    this.leftLeg.castShadow = true;

    this.rightLeg = new THREE.Mesh(legGeo, leatherMat);
    this.rightLeg.position.set(0.13, 0.82, 0);
    this.rightLeg.castShadow = true;
    this.callumBody.add(this.leftLeg, this.rightLeg);

    const kilt = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.31, 0.54, 14), this.plaidMat);
    kilt.position.y = 0.86;
    kilt.castShadow = true;
    this.callumBody.add(kilt);

    const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.09, 12), leatherMat);
    belt.position.y = 1.07;
    this.callumBody.add(belt);

    const sporran = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.19, 0.08), leatherMat);
    sporran.position.set(0, 0.92, -0.25);
    this.callumBody.add(sporran);

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.32, 6, 10), woolCoatMat);
    torso.scale.set(1.12, 1.0, 0.72);
    torso.position.y = 1.34;
    torso.castShadow = true;
    this.callumBody.add(torso);

    const plaidWrap = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.28, 0.52, 12, 1, false, 0, Math.PI * 1.35), this.plaidMat);
    plaidWrap.position.set(-0.04, 1.36, 0.02);
    plaidWrap.rotation.z = -0.34;
    plaidWrap.castShadow = true;
    this.callumBody.add(plaidWrap);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.145, 12, 12), skinMat);
    head.position.y = 1.77;
    head.castShadow = true;
    this.callumBody.add(head);

    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.15, 10, 10, 0, Math.PI * 2, 0, Math.PI * 0.62), hairMat);
    hair.position.set(0, 1.78, 0.02);
    hair.rotation.x = 0.35;
    this.callumBody.add(hair);

    const bonnet = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.15, 0.09, 12), bonnetMat);
    bonnet.position.set(0.02, 1.9, 0.0);
    bonnet.rotation.z = -0.16;
    bonnet.castShadow = true;
    this.callumBody.add(bonnet);

    const armGeo = new THREE.CapsuleGeometry(0.072, 0.48, 5, 8);
    armGeo.translate(0, -0.26, 0);
    this.leftArm = new THREE.Mesh(armGeo, woolCoatMat);
    this.leftArm.position.set(-0.3, 1.54, 0);
    this.leftArm.castShadow = true;

    this.rightArm = new THREE.Mesh(armGeo, woolCoatMat);
    this.rightArm.position.set(0.3, 1.54, 0);
    this.rightArm.castShadow = true;
    this.callumBody.add(this.leftArm, this.rightArm);

    const scabbard = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.022, 1.06, 6), leatherMat);
    scabbard.position.set(-0.29, 0.92, 0.14);
    scabbard.rotation.x = 0.68;
    scabbard.rotation.z = 0.16;
    this.callumBody.add(scabbard);

    const basketHilt = new THREE.Mesh(new THREE.SphereGeometry(0.078, 8, 8), steelMat);
    basketHilt.position.set(-0.24, 1.24, -0.2);
    this.callumBody.add(basketHilt);

    this.scene.add(this.callum);
  }

  _buildChunk(cx, cz, highDetail) {
    const segs = highDetail ? 48 : 16;
    const geo = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE, segs, segs);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position;
    const originX = cx * CHUNK_SIZE;
    const originZ = cz * CHUNK_SIZE;

    for (let i = 0; i < pos.count; i++) {
      const wx = pos.getX(i) + originX;
      const wz = pos.getZ(i) + originZ;
      pos.setY(i, heightAt(wx, wz));
    }
    geo.computeVertexNormals();

    const mesh = new THREE.Mesh(geo, this.terrainMat);
    mesh.position.set(originX, 0, originZ);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    return { mesh, highDetail };
  }

  _updateTerrainChunks(px, pz) {
    const pcx = Math.round(px / CHUNK_SIZE);
    const pcz = Math.round(pz / CHUNK_SIZE);
    const needed = new Set();

    for (let dz = -CHUNK_RADIUS; dz <= CHUNK_RADIUS; dz++) {
      for (let dx = -CHUNK_RADIUS; dx <= CHUNK_RADIUS; dx++) {
        const cx = pcx + dx;
        const cz = pcz + dz;
        const key = `${cx},${cz}`;
        needed.add(key);

        const wantHigh = Math.abs(dx) <= 1 && Math.abs(dz) <= 1;
        const existing = this.chunks.get(key);
        if (!existing) {
          this.chunks.set(key, this._buildChunk(cx, cz, wantHigh));
        } else if (existing.highDetail !== wantHigh) {
          this.scene.remove(existing.mesh);
          existing.mesh.geometry.dispose();
          this.chunks.set(key, this._buildChunk(cx, cz, wantHigh));
        }
      }
    }

    for (const [key, entry] of this.chunks.entries()) {
      if (!needed.has(key)) {
        this.scene.remove(entry.mesh);
        entry.mesh.geometry.dispose();
        this.chunks.delete(key);
      }
    }
  }

  _updateAtmosphere(dt, worldState, px, pz) {
    const wState = worldState.weather?.state || 'clear';
    const targetRain = wState === 'rain' ? 1.0 : 0.0;
    const targetMist = wState === 'mist' ? 1.55 : wState === 'rain' ? 1.05 : 0.50;
    const targetStorm = wState === 'rain' ? 0.92 : wState === 'mist' ? 0.58 : 0.22;

    const blend = 1 - Math.exp(-1.5 * dt);
    this.sharedUniforms.uRain.value = lerp(this.sharedUniforms.uRain.value, targetRain, blend);
    this.sharedUniforms.uMistStrength.value = lerp(this.sharedUniforms.uMistStrength.value, targetMist, blend);
    this.skyUniforms.uStormFactor.value = lerp(this.skyUniforms.uStormFactor.value, targetStorm, blend);

    const storm = this.skyUniforms.uStormFactor.value;
    const rain = this.sharedUniforms.uRain.value;

    const sunAngle = ((worldState.timeOfDay - 6) / 24) * Math.PI * 2;
    const elev = Math.sin(sunAngle);
    const horiz = Math.cos(sunAngle);

    this.sharedUniforms.uSunDir.value.set(horiz * 0.78, Math.max(elev, -0.25), -0.46).normalize();
    const dayFactor = clamp((elev + 0.08) / 0.42, 0, 1);
    const goldenFactor = clamp(1 - Math.abs(elev - 0.16) / 0.30, 0, 1);

    this.sharedUniforms.uDayFactor.value = dayFactor;
    this.skyUniforms.uGoldenFactor.value = goldenFactor;

    const snapX = Math.round(px / 2) * 2;
    const snapZ = Math.round(pz / 2) * 2;
    const activeDir = elev > 0.02 ? this.sharedUniforms.uSunDir.value : new THREE.Vector3(-0.4, 0.55, 0.5).normalize();

    this.sunLight.position.set(snapX + activeDir.x * 160, activeDir.y * 160, snapZ + activeDir.z * 160);
    this.sunLight.target.position.set(snapX, 0, snapZ);
    this.sunLight.target.updateMatrixWorld();

    // Balanced fog density so 2.4 km Lochaber Munros read as sweeping layered Turner washes
    const fogNight = new THREE.Color(0x091220);
    const fogDay = new THREE.Color(0x6e8394).lerp(new THREE.Color(0x4b5762), storm);
    const fogGold = new THREE.Color(0xc47d46);
    this.scene.fog.color.copy(fogNight).lerp(fogDay, dayFactor).lerp(fogGold, goldenFactor * 0.58 * (1 - storm * 0.7));
    this.scene.fog.density = lerp(0.00115, 0.0034, clamp((targetMist - 0.45) / 1.1, 0, 1));

    const sunHex = elev > 0.02 ? (goldenFactor > 0.25 ? 0xffb66a : 0xffe8c6) : 0x7c9ec8;
    this.sunLight.color.setHex(sunHex);
    this.sharedUniforms.uSunColor.value.setHex(sunHex);

    const sunMult = 1 - storm * 0.60;
    this.sunLight.intensity = elev > 0.02 ? lerp(0.55, 3.35, dayFactor) * sunMult : 0.34;
    this.hemiLight.intensity = lerp(0.18, 0.64, dayFactor) * lerp(1.0, 0.78, storm);
    this.scene.environmentIntensity = lerp(0.24, 0.86, dayFactor) * lerp(1.0, 0.72, storm);

    for (const f of this.flickerLights) {
      const pulse = 0.88 + Math.sin(this.elapsed * 9.5 + f.phase) * 0.1 + Math.sin(this.elapsed * 21 + f.phase) * 0.06;
      const nightBoost = lerp(1.9, 0.88, dayFactor);
      f.light.intensity = f.baseIntensity * pulse * nightBoost;
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
      const pos = this.rainPositions;
      const off = this.rainOffsets;
      const count = off.length / 3;
      const fallSpeed = 24.0;
      const slantX = wind.x * 0.28;
      const slantZ = wind.z * 0.28;

      for (let i = 0; i < count; i++) {
        const oi = i * 3;
        off[oi + 1] -= fallSpeed * dt;
        if (off[oi + 1] < -2) off[oi + 1] += 22;

        const rx = this.camera.position.x + off[oi];
        const ry = this.camera.position.y - 6 + off[oi + 1];
        const rz = this.camera.position.z + off[oi + 2];

        const pi = i * 6;
        pos[pi] = rx;
        pos[pi + 1] = ry;
        pos[pi + 2] = rz;
        pos[pi + 3] = rx + slantX;
        pos[pi + 4] = ry - 0.85;
        pos[pi + 5] = rz + slantZ;
      }
      this.rainLines.geometry.attributes.position.needsUpdate = true;
    }
  }

  _updateSmoke(dt) {
    for (const p of this.smokeParticles) {
      p.age += dt * p.speed;
      if (p.age > 1) p.age -= 1;

      const wind = this.onixField.sampleWind(p.src.x, p.src.z);
      const rise = p.age * 9.5;
      const driftX = p.age * (2.6 + wind.x * 2.8) + Math.sin(this.elapsed * 0.9 + p.seed) * 0.4 * p.age;
      const driftZ = p.age * (1.2 + wind.z * 2.8) + Math.cos(this.elapsed * 0.7 + p.seed) * 0.35 * p.age;

      p.sprite.position.set(p.src.x + driftX, p.src.y + rise, p.src.z + driftZ);
      const scale = lerp(0.9, 4.8, p.age);
      p.sprite.scale.set(scale, scale, 1);
      p.sprite.material.opacity = Math.sin(p.age * Math.PI) * 0.36;
    }
  }

  update(dt, player, worldState) {
    this.elapsed += dt;
    this.sharedUniforms.uTime.value = this.elapsed;

    this._updateTerrainChunks(player.x, player.z);
    this._updateStreamingFoliage(player.x, player.z, player.camYaw);
    this._updateAtmosphere(dt, worldState, player.x, player.z);
    this._updateSmoke(dt);

    this.waterMesh.position.x = Math.round(player.x / 50) * 50;
    this.waterMesh.position.z = Math.round(player.z / 50) * 50;

    this.callum.position.set(player.x, player.y, player.z);
    this.callum.rotation.y = player.facingYaw;

    const strideAmp = clamp(player.speed / 5.0, 0, 1);
    const swing = Math.sin(player.stridePhase) * 0.55 * strideAmp;
    this.leftLeg.rotation.x = swing;
    this.rightLeg.rotation.x = -swing;
    this.leftArm.rotation.x = -swing * 0.75;
    this.rightArm.rotation.x = swing * 0.75;

    this.callumBody.position.y = -player.crouchBlend * 0.34 + Math.abs(Math.cos(player.stridePhase)) * 0.05 * strideAmp;
    this.callumBody.rotation.x = player.crouchBlend * 0.28 + strideAmp * 0.06;

    const shoulderRight = 0.55;
    const pivotY = player.y + lerp(1.62, 1.18, player.crouchBlend);

    const cosP = Math.cos(player.camPitch);
    const sinP = Math.sin(player.camPitch);
    const sinY = Math.sin(player.camYaw);
    const cosY = Math.cos(player.camYaw);

    const desiredX = player.x + sinY * cosP * player.camDistance + cosY * shoulderRight;
    const desiredZ = player.z + cosY * cosP * player.camDistance - sinY * shoulderRight;
    let desiredY = pivotY + sinP * player.camDistance;

    const camTerrainY = heightAt(desiredX, desiredZ) + 0.55;
    if (desiredY < camTerrainY) desiredY = camTerrainY;

    const camAlpha = 1 - Math.exp(-14 * dt);
    if (this.camPos.lengthSq() === 0) {
      this.camPos.set(desiredX, desiredY, desiredZ);
      this.camLook.set(player.x, pivotY, player.z);
    } else {
      this.camPos.lerp(new THREE.Vector3(desiredX, desiredY, desiredZ), camAlpha);
      this.camLook.lerp(new THREE.Vector3(player.x + cosY * 0.35, pivotY, player.z - sinY * 0.35), camAlpha);
    }

    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
    this.skyDome.position.copy(this.camera.position);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    if (!this.renderer) return;
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
  }
}
