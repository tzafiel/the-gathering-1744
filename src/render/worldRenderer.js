import * as THREE from 'three';
import {
  heightAt,
  normalAt,
  surfaceAt,
  roadCenterX,
  WATER_LEVEL,
  LANDMARKS
} from '../world/terrain.js';
import { mulberry32, hash2D, clamp, lerp } from '../core/prng.js';
import {
  createOnixTerrainMaterial,
  createOnixStoneMaterial,
  createOnixThatchMaterial,
  createOnixBarkMaterial,
  createOnixFoliageMaterial,
  createOnixWaterMaterial,
  createOnixPlaidMaterial
} from './onixShaders.js';

const CHUNK_SIZE = 120;
const CHUNK_RADIUS = 4;

// Dense 3D sculpted ground vegetation carpet (zero flat dot cards)
const FOLIAGE_STEP = 1.45;
const FOLIAGE_HALF_GRID = 27;
const MAX_GRASS = 2500;
const MAX_HEATHER = 1700;

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

// True 3D curved tapered Highland moor-grass clump (11 arching blades, dark peat root -> golden ochre tip)
function create3DGrassClumpGeometry() {
  const rng = mulberry32(3041);
  const blades = 11;
  const positions = [];
  const normals = [];
  const colors = [];

  for (let b = 0; b < blades; b++) {
    const ang = (b / blades) * Math.PI * 2 + (rng() - 0.5) * 0.45;
    const rad = 0.04 + rng() * 0.24;
    const bx = Math.cos(ang) * rad;
    const bz = Math.sin(ang) * rad;
    const h = 0.34 + rng() * 0.40;
    const w0 = 0.044 + rng() * 0.024;
    const lean = 0.14 + rng() * 0.26;
    const isDryTip = rng() > 0.48;

    const dirX = Math.cos(ang);
    const dirZ = Math.sin(ang);
    const perpX = -dirZ;
    const perpZ = dirX;

    const p0L = [bx - perpX * w0, 0, bz - perpZ * w0];
    const p0R = [bx + perpX * w0, 0, bz + perpZ * w0];
    const p1L = [bx + dirX * lean * 0.42 - perpX * w0 * 0.55, h * 0.54, bz + dirZ * lean * 0.42 - perpZ * w0 * 0.55];
    const p1R = [bx + dirX * lean * 0.42 + perpX * w0 * 0.55, h * 0.54, bz + dirZ * lean * 0.42 + perpZ * w0 * 0.55];
    const p2T = [bx + dirX * lean, h, bz + dirZ * lean];

    const cRoot = [0.022, 0.036, 0.015];
    const cMid = isDryTip ? [0.095, 0.082, 0.032] : [0.052, 0.082, 0.026];
    const cTip = isDryTip ? [0.195, 0.148, 0.055] : [0.105, 0.128, 0.044];
    const nUp = [dirX * 0.35, 0.92, dirZ * 0.35];

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

// True 3D gnarled Highland bell-heather shrub cushion (deep wine/plum painterly blossoms over woody stems)
function create3DHeatherCushionGeometry() {
  const rng = mulberry32(8819);
  const parts = [];
  const subCushions = 5;

  for (let i = 0; i < subCushions; i++) {
    const ang = (i / subCushions) * Math.PI * 2 + rng() * 0.6;
    const dist = i === 0 ? 0 : 0.16 + rng() * 0.18;
    const r = i === 0 ? 0.28 : 0.18 + rng() * 0.10;
    const g = new THREE.IcosahedronGeometry(r, 1);

    const pos = g.attributes.position;
    const cols = new Float32Array(pos.count * 3);
    const hasBloom = rng() > 0.22;

    for (let v = 0; v < pos.count; v++) {
      let vx = pos.getX(v);
      let vy = pos.getY(v);
      let vz = pos.getZ(v);

      const n = 0.78 + Math.sin(vx * 11 + vy * 7) * 0.14 + Math.cos(vz * 13) * 0.14;
      vx = vx * n * 1.15 + Math.cos(ang) * dist;
      vy = Math.max(0.0, (vy + r * 0.65) * 0.72 * n);
      vz = vz * n * 1.15 + Math.sin(ang) * dist;
      pos.setXYZ(v, vx, vy, vz);

      const yNorm = clamp(vy / 0.36, 0, 1);
      const rC = lerp(0.024, hasBloom ? 0.165 : 0.056, yNorm * yNorm);
      const gC = lerp(0.030, hasBloom ? 0.048 : 0.076, yNorm);
      const bC = lerp(0.018, hasBloom ? 0.108 : 0.030, yNorm * yNorm);
      cols[v * 3] = rC;
      cols[v * 3 + 1] = gC;
      cols[v * 3 + 2] = bC;
    }
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    g.computeVertexNormals();
    parts.push(g);
  }
  return mergeNonIndexedGeos(parts);
}

// Sculpted windswept Caledonian Scots Pine trunk + structural upper limbs
function createScotsPineWoodGeometry() {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.14, 0.38, 6.8, 8, 5);
  trunk.translate(0, 3.3, 0);
  const pos = trunk.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    pos.setX(i, pos.getX(i) + Math.sin(y * 0.48) * 0.24);
    pos.setZ(i, pos.getZ(i) + Math.cos(y * 0.38) * 0.16);
  }
  trunk.computeVertexNormals();
  parts.push(trunk);

  const branches = [
    { y: 4.4, ang: 0.3, len: 2.4, tilt: 1.05 },
    { y: 5.0, ang: 2.1, len: 2.2, tilt: 0.96 },
    { y: 5.5, ang: 3.9, len: 2.3, tilt: 1.02 },
    { y: 6.1, ang: 5.3, len: 1.9, tilt: 0.84 }
  ];
  for (const b of branches) {
    const limb = new THREE.CylinderGeometry(0.055, 0.13, b.len, 6);
    limb.translate(0, b.len * 0.5, 0);
    limb.rotateZ(-b.tilt);
    limb.rotateY(b.ang);
    limb.translate(Math.sin(b.y * 0.48) * 0.24, b.y, Math.cos(b.y * 0.38) * 0.16);
    parts.push(limb);
  }
  return mergeNonIndexedGeos(parts);
}

// True 3D painterly Scots pine needle bough clouds (zero flat discs)
function createScotsPineCanopy3DGeometry() {
  const clusters = [
    { x: 1.5, y: 5.2, z: 0.5, rx: 1.8, ry: 0.82, rz: 1.6 },
    { x: -1.15, y: 5.8, z: 1.3, rx: 1.7, ry: 0.80, rz: 1.65 },
    { x: -1.4, y: 6.25, z: -1.1, rx: 1.75, ry: 0.84, rz: 1.55 },
    { x: 1.0, y: 6.75, z: -1.15, rx: 1.6, ry: 0.78, rz: 1.5 },
    { x: 0.0, y: 7.5, z: 0.05, rx: 1.95, ry: 0.90, rz: 1.9 }
  ];

  const parts = [];
  for (let c = 0; c < clusters.length; c++) {
    const cl = clusters[c];
    const g = new THREE.IcosahedronGeometry(1.0, 2);
    const pos = g.attributes.position;
    const cols = new Float32Array(pos.count * 3);

    for (let i = 0; i < pos.count; i++) {
      const vx = pos.getX(i);
      const vy = pos.getY(i);
      const vz = pos.getZ(i);
      const n =
        1.0 +
        Math.sin(vx * 5.2 + c * 1.7) * 0.16 +
        Math.cos(vz * 4.8 - vy * 3.5) * 0.15 +
        Math.sin((vx + vz) * 9.0) * 0.07;

      pos.setXYZ(i, vx * cl.rx * n + cl.x, vy * cl.ry * n + cl.y, vz * cl.rz * n + cl.z);
      const ao = clamp(0.42 + (vy * 0.5 + 0.5) * 0.68, 0.34, 1.12);
      cols[i * 3] = ao;
      cols[i * 3 + 1] = ao;
      cols[i * 3 + 2] = ao;
    }
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    g.computeVertexNormals();
    parts.push(g);
  }
  return mergeNonIndexedGeos(parts);
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
    this.camera = new THREE.PerspectiveCamera(54, window.innerWidth / window.innerHeight, 0.2, 1250);
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

    // Shared GPU uniforms driving every Romantic Oil Painting + ONIX shader simultaneously
    this.sharedUniforms = {
      uOnixField: { value: this.onixField.texture },
      uRippleTex: { value: this.onixField.rippleTexture },
      uRippleOrigin: { value: this.onixField.rippleOrigin },
      uRippleWorldSize: { value: this.onixField.rippleWorldSize },
      uTime: { value: 0 },
      uRain: { value: 0.0 },
      uMistStrength: { value: 0.58 },
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

    this.scene.fog = new THREE.FogExp2(0x7c8f9e, 0.0020);

    // Pure-physics Romantic Oil Painting shaders
    this.terrainMat = createOnixTerrainMaterial(this.sharedUniforms);
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

    // J.M.W. Turner Romantic Highland Oil Sky Dome: painterly storm billows & luminous golden sunbreaks
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

          // Luminous Turner sunbreak glow
          float sunDot = max(dot(dir, normalize(uSunDir)), 0.0);
          vec3 sunTint = mix(vec3(1.0, 0.56, 0.20), vec3(1.0, 0.90, 0.68), uDayFactor);
          float sunVis = (1.0 - uStormFactor * 0.78) * uDayFactor;
          col += sunTint * pow(sunDot, 6.0) * 0.46 * sunVis;
          col += sunTint * smoothstep(0.9975, 0.9994, sunDot) * 5.2 * sunVis;

          // Domain-warped painterly oil-brush Atlantic storm clouds
          if (dir.y > 0.005) {
            vec2 uv = dir.xz / (dir.y + 0.15) * 1.15;
            uv += vec2(uTime * 0.010, uTime * 0.004);
            // Swirl cloud strokes for unmistakable oil-on-canvas sky brushwork
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

    this.skyDome = new THREE.Mesh(new THREE.SphereGeometry(1020, 32, 20), skyMat);
    this.skyDome.frustumCulled = false;
    this.scene.add(this.skyDome);

    // Chiaroscuro PMREM bounce environment (cool slate-blue zenith, golden horizon, dark peat earth)
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
    const geo = new THREE.PlaneGeometry(1900, 1900, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.waterMesh = new THREE.Mesh(geo, this.waterMat);
    this.waterMesh.position.y = WATER_LEVEL;
    this.waterMesh.receiveShadow = true;
    this.scene.add(this.waterMesh);
  }

  _buildSector01Landmarks() {
    const emberMat = new THREE.MeshBasicMaterial({ color: 0xff922e });

    // 1. Baile MacRae — Stone-Gabled Highland Blackhouses with chimney smoke
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

      // World position of chimney top for curling peat smoke
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

    // 2. Scottish Stone Tower-House Keep (Torr an Fhaire — Hanoverian Garrison Watchtower)
    const tw = LANDMARKS.watchtower;
    const twY = heightAt(tw.x, tw.z);
    const towerGroup = new THREE.Group();
    towerGroup.position.set(tw.x, twY, tw.z);

    // Heavy battered square stone keep with dramatic silhouette
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

    // Corner battlements & crenels
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

    // Flagpole & crimson garrison pennant
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 6.8, 6), this.barkMat);
    pole.position.set(0, 18.4, 0);
    towerGroup.add(pole);

    this.towerFlag = new THREE.Mesh(
      new THREE.BoxGeometry(2.9, 1.4, 0.06),
      new THREE.MeshStandardMaterial({ color: 0x851c1a, roughness: 0.86 })
    );
    this.towerFlag.position.set(1.45, 20.8, 0);
    towerGroup.add(this.towerFlag);

    // Three warm fire braziers (rooftop + flanking crag beacons like the Romantic concept art)
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

    // 3. Smuggling Cove Timber Jetty on Loch Linnhe
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

    // 4. Stacked Stone Boundary Cairn
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

    // 5. General Wade's Road Stone Milestones
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
    const maxPines = 560;
    const maxRocks = 420;

    const trunkGeo = createScotsPineWoodGeometry();
    const crownGeo = createScotsPineCanopy3DGeometry();
    const crownMat = createOnixFoliageMaterial(this.sharedUniforms, 'pine');

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
    for (let tries = 0; tries < 3200 && pineCount < maxPines; tries++) {
      const x = (rng() - 0.5) * 960;
      const z = (rng() - 0.5) * 960;
      const y = heightAt(x, z);
      if (y < 2.5 || y > 58) continue;
      if (Math.abs(x - roadCenterX(z)) < 11.5) continue;
      if (Math.hypot(x - LANDMARKS.clachan.x, z - LANDMARKS.clachan.z) < 34) continue;
      if (Math.hypot(x - LANDMARKS.watchtower.x, z - LANDMARKS.watchtower.z) < 26) continue;

      const n = normalAt(x, z, 1.0);
      if (1 - n.y > 0.27) continue;

      const scale = 0.82 + rng() * 1.05;
      dummy.position.set(x, y - 0.25, z);
      dummy.rotation.set((rng() - 0.5) * 0.08, rng() * Math.PI * 2, (rng() - 0.5) * 0.08);
      dummy.scale.set(scale, scale * (0.9 + rng() * 0.34), scale);
      dummy.updateMatrix();

      trunks.setMatrixAt(pineCount, dummy.matrix);
      crowns.setMatrixAt(pineCount, dummy.matrix);
      const tone = 0.72 + rng() * 0.34;
      color.setRGB(tone * 0.94, tone, tone * 0.92);
      crowns.setColorAt(pineCount, color);
      pineCount++;
    }
    trunks.count = pineCount;
    crowns.count = pineCount;
    trunks.instanceMatrix.needsUpdate = true;
    crowns.instanceMatrix.needsUpdate = true;
    if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;

    let rockCount = 0;
    for (let tries = 0; tries < 1600 && rockCount < maxRocks; tries++) {
      const x = (rng() - 0.5) * 960;
      const z = (rng() - 0.5) * 960;
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
    const heatherGeo = create3DHeatherCushionGeometry();

    const grassMat = createOnixFoliageMaterial(this.sharedUniforms, 'grass');
    const heatherMat = createOnixFoliageMaterial(this.sharedUniforms, 'heather');

    this.grassInst = new THREE.InstancedMesh(grassGeo, grassMat, MAX_GRASS);
    this.heatherInst = new THREE.InstancedMesh(heatherGeo, heatherMat, MAX_HEATHER);

    this.grassInst.receiveShadow = true;
    this.heatherInst.castShadow = true;
    this.heatherInst.receiveShadow = true;
    this.grassInst.frustumCulled = false;
    this.heatherInst.frustumCulled = false;

    this.scene.add(this.grassInst, this.heatherInst);
  }

  _updateStreamingFoliage(px, pz) {
    if (Math.hypot(px - this.lastFoliageX, pz - this.lastFoliageZ) < 5.0) return;
    this.lastFoliageX = px;
    this.lastFoliageZ = pz;

    const baseGX = Math.round(px / FOLIAGE_STEP);
    const baseGZ = Math.round(pz / FOLIAGE_STEP);
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

        const wx = (gx + (r1 - 0.5) * 0.88) * FOLIAGE_STEP;
        const wz = (gz + (r2 - 0.5) * 0.88) * FOLIAGE_STEP;

        if (Math.hypot(wx - px, wz - pz) > FOLIAGE_HALF_GRID * FOLIAGE_STEP) continue;

        const wy = heightAt(wx, wz);
        if (wy < WATER_LEVEL + 1.4 || wy > 56) continue;
        if (Math.abs(wx - roadCenterX(wz)) < 4.9) continue;
        if (Math.hypot(wx - LANDMARKS.clachan.x, wz - LANDMARKS.clachan.z) < 5.0) continue;

        const surf = surfaceAt(wx, wz);
        if (surf.id === 'granite' || surf.id === 'water' || surf.id === 'shingle') continue;

        const isHeather = surf.id === 'heather' ? r3 > 0.34 : r3 > 0.80;
        const scale = 0.72 + r1 * 0.78;

        dummy.position.set(wx, wy - 0.04, wz);
        dummy.rotation.set(0, r2 * Math.PI * 2, 0);
        dummy.scale.set(scale, scale * (0.85 + r3 * 0.4), scale);
        dummy.updateMatrix();

        if (isHeather) {
          if (hCount >= MAX_HEATHER) continue;
          this.heatherInst.setMatrixAt(hCount, dummy.matrix);
          const shade = 0.74 + r2 * 0.42;
          col.setRGB(shade, shade * 0.96, shade * 1.02);
          this.heatherInst.setColorAt(hCount, col);
          hCount++;
        } else {
          if (gCount >= MAX_GRASS) continue;
          this.grassInst.setMatrixAt(gCount, dummy.matrix);
          const shade = 0.74 + r1 * 0.4;
          col.setRGB(shade * 1.02, shade, shade * 0.92);
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

    // Driving Highland Rain Curtain driven by ONIX LLG wind vector
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
    const targetMist = wState === 'mist' ? 1.65 : wState === 'rain' ? 1.15 : 0.56;
    const targetStorm = wState === 'rain' ? 0.92 : wState === 'mist' ? 0.58 : 0.22;

    const blend = 1 - Math.exp(-1.5 * dt);
    this.sharedUniforms.uRain.value = lerp(this.sharedUniforms.uRain.value, targetRain, blend);
    this.sharedUniforms.uMistStrength.value = lerp(this.sharedUniforms.uMistStrength.value, targetMist, blend);
    this.skyUniforms.uStormFactor.value = lerp(this.skyUniforms.uStormFactor.value, targetStorm, blend);

    const storm = this.skyUniforms.uStormFactor.value;
    const rain = this.sharedUniforms.uRain.value;

    // 24h Highland Sun Arc
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

    // Sync Turner valley fog color with storm & golden hour
    const fogNight = new THREE.Color(0x091220);
    const fogDay = new THREE.Color(0x6e8394).lerp(new THREE.Color(0x4b5762), storm);
    const fogGold = new THREE.Color(0xc47d46);
    this.scene.fog.color.copy(fogNight).lerp(fogDay, dayFactor).lerp(fogGold, goldenFactor * 0.58 * (1 - storm * 0.7));
    this.scene.fog.density = lerp(0.0017, 0.0044, clamp((targetMist - 0.5) / 1.15, 0, 1));

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

    // Falling rain streaks slanted by live ONIX wind vector
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
    this._updateStreamingFoliage(player.x, player.z);
    this._updateAtmosphere(dt, worldState, player.x, player.z);
    this._updateSmoke(dt);

    this.waterMesh.position.x = Math.round(player.x / 50) * 50;
    this.waterMesh.position.z = Math.round(player.z / 50) * 50;

    // Update Callum
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

    // Over-the-shoulder RDR2 camera
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
