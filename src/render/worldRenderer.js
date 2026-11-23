import * as THREE from 'three';
import {
  heightAt,
  normalAt,
  surfaceAt,
  getTerrainColor,
  roadCenterX,
  WATER_LEVEL,
  LANDMARKS
} from '../world/terrain.js';
import { mulberry32, hash2D, clamp, lerp } from '../core/prng.js';
import { createProceduralTextures } from './textures.js';

const CHUNK_SIZE = 120;
const CHUNK_RADIUS = 4;

// Ground foliage streaming grid (world-locked so blades never swim as Callum moves)
const FOLIAGE_STEP = 1.75;
const FOLIAGE_HALF_GRID = 26; // 53x53 = 2,809 cells (~92m diameter lush carpet)
const MAX_GRASS = 2200;
const MAX_HEATHER = 1800;

function mergeNonIndexedGeos(geos) {
  const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g.clone()));
  let totalVerts = 0;
  for (const p of parts) totalVerts += p.attributes.position.count;

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const hasColor = parts.every((p) => Boolean(p.attributes.color));
  const colors = hasColor ? new Float32Array(totalVerts * 3) : null;

  let offset = 0;
  for (const p of parts) {
    const count = p.attributes.position.count;
    positions.set(p.attributes.position.array, offset * 3);
    normals.set(p.attributes.normal.array, offset * 3);
    uvs.set(p.attributes.uv.array, offset * 2);
    if (hasColor) colors.set(p.attributes.color.array, offset * 3);
    offset += count;
    p.dispose();
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  if (hasColor) out.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return out;
}

// 3-crossed curved star tuft (each instance displays ~18-30 detailed stems with root-to-tip AO)
function createTuftGeometry(width, height) {
  const planes = [];
  for (let i = 0; i < 3; i++) {
    const g = new THREE.PlaneGeometry(width, height, 1, 2);
    g.translate(0, height * 0.5, 0);

    const pos = g.attributes.position;
    const cols = new Float32Array(pos.count * 3);
    for (let v = 0; v < pos.count; v++) {
      const yNorm = clamp(pos.getY(v) / height, 0, 1);
      // Slight natural outward arch at blade tips
      pos.setZ(v, pos.getZ(v) + yNorm * yNorm * 0.14);
      // Darken base for grounded ambient occlusion
      const ao = lerp(0.38, 1.0, yNorm);
      cols[v * 3] = ao;
      cols[v * 3 + 1] = ao;
      cols[v * 3 + 2] = ao;
    }
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    g.rotateY((i * Math.PI) / 3);
    g.computeVertexNormals();
    planes.push(g);
  }
  return mergeNonIndexedGeos(planes);
}

// Multi-tier windswept Caledonian Scots pine canopy (layered feathery needle boughs, zero cones)
function createScotsPineCanopyGeometry() {
  const cards = [];
  const tiers = [
    { y: 4.5, r: 2.35, tilt: 0.34, count: 4, angOffset: 0.0 },
    { y: 5.8, r: 2.05, tilt: 0.28, count: 4, angOffset: 0.65 },
    { y: 6.9, r: 1.55, tilt: 0.22, count: 3, angOffset: 0.35 }
  ];

  for (const tier of tiers) {
    for (let i = 0; i < tier.count; i++) {
      const ang = (i / tier.count) * Math.PI * 2 + tier.angOffset;
      const g = new THREE.PlaneGeometry(tier.r * 2.1, tier.r * 2.1);
      g.rotateX(-Math.PI / 2 + tier.tilt);
      g.rotateY(ang);
      g.translate(Math.cos(ang) * tier.r * 0.42, tier.y, Math.sin(ang) * tier.r * 0.42);
      cards.push(g);
    }
  }

  // Crown cap
  const cap = new THREE.PlaneGeometry(2.6, 2.6);
  cap.rotateX(-Math.PI / 2 + 0.1);
  cap.translate(0, 7.6, 0);
  cards.push(cap);

  return mergeNonIndexedGeos(cards);
}

function createScotsPineTrunkGeometry() {
  const trunk = new THREE.CylinderGeometry(0.16, 0.38, 6.4, 7, 4);
  trunk.translate(0, 3.1, 0);
  const pos = trunk.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    // Subtle windswept S-curve characteristic of old Highland pines
    pos.setX(i, pos.getX(i) + Math.sin(y * 0.55) * 0.16);
    pos.setZ(i, pos.getZ(i) + Math.cos(y * 0.42) * 0.11);
  }
  trunk.computeVertexNormals();
  return trunk;
}

export class WorldRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(56, window.innerWidth / window.innerHeight, 0.2, 1200);
    this.renderer = null;
    this.chunks = new Map();
    this.flickerLights = [];
    this.smokeParticles = [];
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this.elapsed = 0;

    this.windUniforms = { uTime: { value: 0 } };
    this.lastFoliageX = 1e9;
    this.lastFoliageZ = 1e9;
    this.tmpColor = new THREE.Color();
    this.tmpDummy = new THREE.Object3D();
    this.sunDir = new THREE.Vector3(0.5, 0.6, -0.4).normalize();
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

    this.textures = createProceduralTextures(this.renderer.capabilities.getMaxAnisotropy());

    this.scene.fog = new THREE.FogExp2(0x8db2cc, 0.00165);

    // Rich PBR terrain material combining linear biome vertex colors with tiled soil/moss bump & roughness
    this.terrainMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      map: this.textures.terrainColor,
      bumpMap: this.textures.terrainBump,
      bumpScale: 0.42,
      roughnessMap: this.textures.terrainRoughness,
      roughness: 0.94,
      metalness: 0.02
    });

    this._setupSkyAndIBL();
    this._setupLighting();
    this._buildWater();
    this._buildSector01Landmarks();
    this._buildInstancedTreesAndRocks();
    this._buildStreamingGroundFoliage();
    this._buildSmokeSystem();
    this._buildCallumMesh();
  }

  getBackendName() {
    return 'WebGL2 PBR';
  }

  _setupSkyAndIBL() {
    // Procedural Rayleigh/Mie Highland sky dome with sun glow & drifting clouds
    this.skyUniforms = {
      uSunDir: { value: new THREE.Vector3(0.5, 0.5, -0.4).normalize() },
      uTime: { value: 0 },
      uDayFactor: { value: 1.0 },
      uGoldenFactor: { value: 0.25 }
    };

    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: this.skyUniforms,
      vertexShader: /* glsl */ `
        varying vec3 vWorldDir;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldDir = normalize(position);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uSunDir;
        uniform float uTime;
        uniform float uDayFactor;
        uniform float uGoldenFactor;
        varying vec3 vWorldDir;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
        }

        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          float a = hash(i);
          float b = hash(i + vec2(1.0, 0.0));
          float c = hash(i + vec2(0.0, 1.0));
          float d = hash(i + vec2(1.0, 1.0));
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }

        float fbm(vec2 p) {
          float v = 0.0;
          float a = 0.5;
          for (int i = 0; i < 4; i++) {
            v += a * noise(p);
            p = p * 2.04 + vec2(1.7, 9.2);
            a *= 0.5;
          }
          return v;
        }

        void main() {
          vec3 dir = normalize(vWorldDir);
          float h = clamp(dir.y, 0.0, 1.0);

          // Linear Atlantic sky palette
          vec3 nightZenith = vec3(0.008, 0.015, 0.036);
          vec3 nightHorizon = vec3(0.025, 0.042, 0.075);

          vec3 dayZenith = vec3(0.065, 0.21, 0.48);
          vec3 dayHorizon = vec3(0.36, 0.54, 0.68);

          vec3 goldenHorizon = vec3(0.82, 0.42, 0.16);

          vec3 zenith = mix(nightZenith, dayZenith, uDayFactor);
          vec3 horizon = mix(nightHorizon, dayHorizon, uDayFactor);
          horizon = mix(horizon, goldenHorizon, uGoldenFactor * 0.62);

          vec3 col = mix(horizon, zenith, pow(h, 0.52));

          // Mie sun scattering & crisp solar disc
          float sunDot = max(dot(dir, normalize(uSunDir)), 0.0);
          vec3 sunTint = mix(vec3(1.0, 0.62, 0.28), vec3(1.0, 0.94, 0.80), uDayFactor);
          col += sunTint * pow(sunDot, 12.0) * 0.32 * uDayFactor;
          col += sunTint * smoothstep(0.9985, 0.9996, sunDot) * 4.5 * uDayFactor;

          // Layered drifting Atlantic Highland clouds
          if (dir.y > 0.02) {
            vec2 cloudUV = dir.xz / (dir.y + 0.18) * 1.45;
            cloudUV += vec2(uTime * 0.009, uTime * 0.004);
            float c1 = fbm(cloudUV);
            float c2 = fbm(cloudUV * 2.3 - vec2(uTime * 0.005, 0.0));
            float cloudMask = smoothstep(0.47, 0.78, c1 * 0.72 + c2 * 0.28);
            cloudMask *= smoothstep(0.02, 0.22, dir.y);

            vec3 cloudLit = mix(vec3(0.06, 0.08, 0.12), vec3(0.92, 0.94, 0.96), uDayFactor);
            cloudLit = mix(cloudLit, vec3(1.0, 0.72, 0.48), uGoldenFactor * 0.6);
            vec3 cloudShadow = mix(vec3(0.02, 0.03, 0.06), vec3(0.32, 0.40, 0.48), uDayFactor);
            float edgeLight = clamp(c2 * 1.2 + pow(sunDot, 4.0) * 0.55, 0.0, 1.0);
            vec3 cloudCol = mix(cloudShadow, cloudLit, edgeLight);

            col = mix(col, cloudCol, cloudMask * 0.84);
          }

          // Subtle night stars
          if (uDayFactor < 0.35 && dir.y > 0.08) {
            float star = step(0.9965, hash(floor(dir.xz / max(dir.y, 0.1) * 140.0)));
            col += vec3(0.75, 0.82, 1.0) * star * (1.0 - uDayFactor * 2.8);
          }

          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `
    });

    this.skyDome = new THREE.Mesh(new THREE.SphereGeometry(980, 32, 20), skyMat);
    this.skyDome.frustumCulled = false;
    this.scene.add(this.skyDome);

    // Bake soft Atlantic sky + moss ground IBL cubemap so shadow sides have real bounce light (never black)
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
            vec3 top = vec3(0.28, 0.52, 0.82);
            vec3 mid = vec3(0.55, 0.66, 0.74);
            vec3 bot = vec3(0.16, 0.20, 0.13);
            vec3 c = vP.y > 0.0 ? mix(mid, top, pow(vP.y, 0.6)) : mix(mid, bot, pow(-vP.y, 0.5));
            gl_FragColor = vec4(c, 1.0);
          }
        `
      })
    );
    envScene.add(envSky);
    this.envRT = pmrem.fromScene(envScene, 0.04);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = 0.72;
    pmrem.dispose();
  }

  _setupLighting() {
    this.hemiLight = new THREE.HemisphereLight(0xb2d4f5, 0x3b482e, 0.68);
    this.scene.add(this.hemiLight);

    this.sunLight = new THREE.DirectionalLight(0xfff0d4, 2.8);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.near = 10;
    this.sunLight.shadow.camera.far = 360;
    const d = 90;
    this.sunLight.shadow.camera.left = -d;
    this.sunLight.shadow.camera.right = d;
    this.sunLight.shadow.camera.top = d;
    this.sunLight.shadow.camera.bottom = -d;
    this.sunLight.shadow.bias = -0.0004;
    this.sunLight.shadow.normalBias = 0.03;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);
  }

  _buildWater() {
    const geo = new THREE.PlaneGeometry(1900, 1900, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x163847,
      normalMap: this.textures.waterNormal,
      normalScale: new THREE.Vector2(0.55, 0.55),
      roughness: 0.14,
      metalness: 0.28,
      envMapIntensity: 1.5,
      transparent: true,
      opacity: 0.92
    });
    this.waterMesh = new THREE.Mesh(geo, mat);
    this.waterMesh.position.y = WATER_LEVEL;
    this.waterMesh.receiveShadow = true;
    this.scene.add(this.waterMesh);
  }

  _buildSector01Landmarks() {
    const stoneMat = new THREE.MeshStandardMaterial({
      map: this.textures.stoneColor,
      bumpMap: this.textures.stoneBump,
      bumpScale: 0.28,
      roughness: 0.92
    });
    const darkStoneMat = new THREE.MeshStandardMaterial({
      color: 0x7b7c78,
      map: this.textures.stoneColor,
      bumpMap: this.textures.stoneBump,
      bumpScale: 0.34,
      roughness: 0.94
    });
    const thatchMat = new THREE.MeshStandardMaterial({
      map: this.textures.thatchColor,
      bumpMap: this.textures.thatchBump,
      bumpScale: 0.32,
      roughness: 0.96
    });
    const timberMat = new THREE.MeshStandardMaterial({
      map: this.textures.barkColor,
      bumpMap: this.textures.barkBump,
      bumpScale: 0.18,
      roughness: 0.88
    });
    const emberMat = new THREE.MeshBasicMaterial({ color: 0xff9a38 });

    // 1. Baile MacRae — Dry-stone Highland blackhouses with pitched turf/thatch roofs & stone dykes
    const cl = LANDMARKS.clachan;
    const bothies = [
      { dx: -12, dz: -7, w: 8.2, d: 5.0, rot: 0.25 },
      { dx: 11, dz: -10, w: 7.2, d: 4.6, rot: -0.42 },
      { dx: 4, dz: 12, w: 8.6, d: 5.2, rot: 1.38 }
    ];

    for (const b of bothies) {
      const bx = cl.x + b.dx;
      const bz = cl.z + b.dz;
      const by = heightAt(bx, bz);
      const group = new THREE.Group();
      group.position.set(bx, by, bz);
      group.rotation.y = b.rot;

      // Stone walls
      const walls = new THREE.Mesh(new THREE.BoxGeometry(b.w, 2.6, b.d), stoneMat);
      walls.position.y = 1.2;
      walls.castShadow = true;
      walls.receiveShadow = true;
      group.add(walls);

      // Pitched gable roof with overhanging eaves
      const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(b.w, b.d) * 0.76, 2.5, 4), thatchMat);
      roof.position.y = 3.65;
      roof.rotation.y = Math.PI / 4;
      roof.scale.set((b.w + 0.9) / Math.max(b.w, b.d), 1, (b.d + 0.9) / Math.max(b.w, b.d));
      roof.castShadow = true;
      roof.receiveShadow = true;
      group.add(roof);

      // Stone chimney stack
      const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.9, 0.9), darkStoneMat);
      chimney.position.set(b.w * 0.28, 3.85, 0);
      chimney.castShadow = true;
      group.add(chimney);

      // Timber door & warm shuttered window glow
      const door = new THREE.Mesh(new THREE.BoxGeometry(1.15, 1.95, 0.22), timberMat);
      door.position.set(0, 0.95, b.d * 0.5 + 0.04);
      group.add(door);

      const lintel = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.26, 0.34), darkStoneMat);
      lintel.position.set(0, 2.02, b.d * 0.5 + 0.06);
      group.add(lintel);

      const winGlow = new THREE.Mesh(
        new THREE.PlaneGeometry(0.7, 0.65),
        new THREE.MeshBasicMaterial({ color: 0xffb662 })
      );
      winGlow.position.set(b.w * 0.25, 1.35, b.d * 0.5 + 0.03);
      group.add(winGlow);

      this.scene.add(group);
    }

    // Dry-stone enclosure wall segments around Baile MacRae
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
        const wall = new THREE.Mesh(new THREE.BoxGeometry(segLen, 1.15, 0.65), darkStoneMat);
        wall.position.set(wx, wy + 0.45, wz);
        wall.rotation.y = -mid + Math.PI / 2;
        wall.castShadow = true;
        wall.receiveShadow = true;
        this.scene.add(wall);
      }
    }

    // Central Clachan Peat Hearth + logs
    const fireY = heightAt(cl.x, cl.z);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      const st = new THREE.Mesh(new THREE.DodecahedronGeometry(0.32, 0), darkStoneMat);
      st.position.set(cl.x + Math.cos(a) * 1.05, fireY + 0.16, cl.z + Math.sin(a) * 1.05);
      st.scale.set(1.1, 0.75, 1.1);
      st.castShadow = true;
      this.scene.add(st);
    }
    for (let i = 0; i < 4; i++) {
      const log = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 1.2, 6), timberMat);
      log.position.set(cl.x, fireY + 0.25, cl.z);
      log.rotation.set(Math.PI / 2 - 0.35, (i * Math.PI) / 2, 0);
      this.scene.add(log);
    }

    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.78, 6), emberMat);
    flame.position.set(cl.x, fireY + 0.5, cl.z);
    this.scene.add(flame);

    const hearthLight = new THREE.PointLight(0xff8c32, 16, 36, 1.7);
    hearthLight.position.set(cl.x, fireY + 1.5, cl.z);
    this.scene.add(hearthLight);
    this.flickerLights.push({ light: hearthLight, flame, baseIntensity: 16, phase: 0.4 });
    this.smokeSources = [{ x: cl.x, y: fireY + 0.9, z: cl.z, spread: 0.45 }];

    // 2. Hanoverian Watchtower (Torr an Fhaire)
    const tw = LANDMARKS.watchtower;
    const twY = heightAt(tw.x, tw.z);
    const towerGroup = new THREE.Group();
    towerGroup.position.set(tw.x, twY, tw.z);

    const towerBase = new THREE.Mesh(new THREE.CylinderGeometry(4.4, 5.4, 12.6, 10), darkStoneMat);
    towerBase.position.y = 6.0;
    towerBase.castShadow = true;
    towerBase.receiveShadow = true;
    towerGroup.add(towerBase);

    const parapet = new THREE.Mesh(new THREE.CylinderGeometry(5.1, 4.9, 1.5, 10), stoneMat);
    parapet.position.y = 12.6;
    parapet.castShadow = true;
    towerGroup.add(parapet);

    // Stone crenellations around parapet
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const merlon = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.95, 0.7), stoneMat);
      merlon.position.set(Math.cos(a) * 4.65, 13.75, Math.sin(a) * 4.65);
      merlon.rotation.y = -a + Math.PI / 2;
      merlon.castShadow = true;
      towerGroup.add(merlon);
    }

    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 6.8, 6), timberMat);
    pole.position.set(0, 16.1, 0);
    towerGroup.add(pole);

    this.towerFlag = new THREE.Mesh(
      new THREE.BoxGeometry(2.8, 1.4, 0.06),
      new THREE.MeshStandardMaterial({ color: 0x9c201e, roughness: 0.85 })
    );
    this.towerFlag.position.set(1.4, 18.4, 0);
    towerGroup.add(this.towerFlag);

    for (const bx of [-3.4, 3.4]) {
      const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.32, 1.2, 6), darkStoneMat);
      stand.position.set(bx, 13.6, 0);
      towerGroup.add(stand);

      const bFlame = new THREE.Mesh(new THREE.ConeGeometry(0.36, 0.9, 6), emberMat);
      bFlame.position.set(bx, 14.4, 0);
      towerGroup.add(bFlame);

      const bLight = new THREE.PointLight(0xff8429, 24, 54, 1.6);
      bLight.position.set(tw.x + bx, twY + 15.1, tw.z);
      this.scene.add(bLight);
      this.flickerLights.push({ light: bLight, flame: bFlame, baseIntensity: 24, phase: bx * 1.7 });
      this.smokeSources.push({ x: tw.x + bx, y: twY + 14.9, z: tw.z, spread: 0.35 });
    }
    this.scene.add(towerGroup);

    // 3. Smuggling Cove Timber Jetty
    const jt = LANDMARKS.coveJetty;
    const deck = new THREE.Mesh(new THREE.BoxGeometry(14, 0.35, 3.2), timberMat);
    deck.position.set(jt.x - 4, WATER_LEVEL + 0.85, jt.z);
    deck.castShadow = true;
    deck.receiveShadow = true;
    this.scene.add(deck);

    for (let i = -5; i <= 5; i += 2.5) {
      for (const pz of [-1.2, 1.2]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 3.8, 6), timberMat);
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
      const st = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 0), stoneMat);
      st.position.set(cr.x, crY + 0.45 + layer * 0.52, cr.z);
      st.scale.set(1.1, 0.65, 1.1);
      st.rotation.y = layer * 1.1;
      st.castShadow = true;
      st.receiveShadow = true;
      this.scene.add(st);
    }

    // 5. General Wade's Road Stone Milestones
    for (let mz = -360; mz <= 360; mz += 120) {
      const mx = roadCenterX(mz) + 5.2;
      const my = heightAt(mx, mz);
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.55, 1.45, 0.42), stoneMat);
      post.position.set(mx, my + 0.65, mz);
      post.castShadow = true;
      this.scene.add(post);
    }
  }

  _buildInstancedTreesAndRocks() {
    const rng = mulberry32(174401);
    const maxPines = 640;
    const maxRocks = 420;

    const trunkGeo = createScotsPineTrunkGeometry();
    const crownGeo = createScotsPineCanopyGeometry();
    const rockGeo = new THREE.IcosahedronGeometry(1.0, 1);

    // Perturb rock vertices for angular Highland granite boulders
    const rPos = rockGeo.attributes.position;
    for (let i = 0; i < rPos.count; i++) {
      const vx = rPos.getX(i);
      const vy = rPos.getY(i);
      const vz = rPos.getZ(i);
      const n = 0.8 + Math.sin(vx * 3.7 + vy * 2.3) * 0.14 + Math.cos(vz * 4.1) * 0.12;
      rPos.setXYZ(i, vx * n, vy * n, vz * n);
    }
    rockGeo.computeVertexNormals();

    const trunkMat = new THREE.MeshStandardMaterial({
      map: this.textures.barkColor,
      bumpMap: this.textures.barkBump,
      bumpScale: 0.25,
      roughness: 0.94
    });

    const crownMat = new THREE.MeshStandardMaterial({
      map: this.textures.pineColor,
      alphaTest: 0.4,
      side: THREE.DoubleSide,
      roughness: 0.88
    });

    const rockMat = new THREE.MeshStandardMaterial({
      map: this.textures.stoneColor,
      bumpMap: this.textures.stoneBump,
      bumpScale: 0.3,
      roughness: 0.93
    });

    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, maxPines);
    const crowns = new THREE.InstancedMesh(crownGeo, crownMat, maxPines);
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, maxRocks);

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
      if (y < 2.4 || y > 58) continue;
      if (Math.abs(x - roadCenterX(z)) < 11) continue;
      if (Math.hypot(x - LANDMARKS.clachan.x, z - LANDMARKS.clachan.z) < 34) continue;
      if (Math.hypot(x - LANDMARKS.watchtower.x, z - LANDMARKS.watchtower.z) < 24) continue;

      const n = normalAt(x, z, 1.0);
      if (1 - n.y > 0.28) continue;

      const scale = 0.8 + rng() * 1.05;
      dummy.position.set(x, y - 0.25, z);
      dummy.rotation.set((rng() - 0.5) * 0.08, rng() * Math.PI * 2, (rng() - 0.5) * 0.08);
      dummy.scale.set(scale, scale * (0.9 + rng() * 0.32), scale);
      dummy.updateMatrix();

      trunks.setMatrixAt(pineCount, dummy.matrix);
      crowns.setMatrixAt(pineCount, dummy.matrix);
      color.setHSL(0.32 + (rng() - 0.5) * 0.04, 0.28, 0.72 + rng() * 0.24);
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

      const sx = 0.65 + rng() * 2.5;
      const sy = 0.4 + rng() * 1.45;
      const sz = 0.65 + rng() * 2.5;
      dummy.position.set(x, y + sy * 0.2, z);
      dummy.rotation.set(rng() * 0.6, rng() * Math.PI * 2, rng() * 0.6);
      dummy.scale.set(sx, sy, sz);
      dummy.updateMatrix();

      rocks.setMatrixAt(rockCount, dummy.matrix);
      const shade = 0.62 + rng() * 0.34;
      color.setRGB(shade, shade * 1.01, shade * 1.03);
      rocks.setColorAt(rockCount, color);
      rockCount++;
    }
    rocks.count = rockCount;
    rocks.instanceMatrix.needsUpdate = true;
    if (rocks.instanceColor) rocks.instanceColor.needsUpdate = true;

    this.scene.add(trunks, crowns, rocks);
  }

  _makeWindFoliageMaterial(map, key) {
    const mat = new THREE.MeshStandardMaterial({
      map,
      alphaTest: 0.36,
      side: THREE.DoubleSide,
      roughness: 0.88,
      metalness: 0.0,
      vertexColors: true
    });
    mat.customProgramCacheKey = () => key;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.windUniforms.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\nuniform float uTime;`)
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          #ifdef USE_INSTANCING
            vec4 wInst = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
            float sway = clamp(position.y * 1.15, 0.0, 1.0);
            float ph = wInst.x * 0.24 + wInst.z * 0.18 + uTime * 2.1;
            float gust = sin(ph) * 0.14 + sin(ph * 2.1 + 1.3) * 0.045;
            transformed.x += gust * sway * sway;
            transformed.z += cos(ph * 0.85) * 0.08 * sway * sway;
          #endif`
        );
    };
    return mat;
  }

  _buildStreamingGroundFoliage() {
    const grassGeo = createTuftGeometry(1.15, 0.74);
    const heatherGeo = createTuftGeometry(1.05, 0.62);

    const grassMat = this._makeWindFoliageMaterial(this.textures.grassTuft, 'wind-grass-v1');
    const heatherMat = this._makeWindFoliageMaterial(this.textures.heatherTuft, 'wind-heather-v1');

    this.grassInst = new THREE.InstancedMesh(grassGeo, grassMat, MAX_GRASS);
    this.heatherInst = new THREE.InstancedMesh(heatherGeo, heatherMat, MAX_HEATHER);

    this.grassInst.receiveShadow = true;
    this.heatherInst.receiveShadow = true;
    this.grassInst.frustumCulled = false;
    this.heatherInst.frustumCulled = false;

    this.scene.add(this.grassInst, this.heatherInst);
  }

  _updateStreamingFoliage(px, pz) {
    if (Math.hypot(px - this.lastFoliageX, pz - this.lastFoliageZ) < 6.0) return;
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

        const wx = (gx + (r1 - 0.5) * 0.85) * FOLIAGE_STEP;
        const wz = (gz + (r2 - 0.5) * 0.85) * FOLIAGE_STEP;

        // Circular radius cutoff around player
        if (Math.hypot(wx - px, wz - pz) > FOLIAGE_HALF_GRID * FOLIAGE_STEP) continue;

        const wy = heightAt(wx, wz);
        if (wy < WATER_LEVEL + 1.35 || wy > 56) continue;
        if (Math.abs(wx - roadCenterX(wz)) < 4.9) continue;

        // Leave central clachan hearth clear
        if (Math.hypot(wx - LANDMARKS.clachan.x, wz - LANDMARKS.clachan.z) < 4.5) continue;

        const surf = surfaceAt(wx, wz);
        if (surf.id === 'granite' || surf.id === 'water' || surf.id === 'shingle') continue;

        const isHeather = surf.id === 'heather' ? r3 > 0.28 : r3 > 0.78;
        const scale = 0.78 + r1 * 0.65;

        dummy.position.set(wx, wy - 0.06, wz);
        dummy.rotation.set(0, r2 * Math.PI * 2, 0);
        dummy.scale.set(scale, scale * (0.85 + r3 * 0.4), scale);
        dummy.updateMatrix();

        if (isHeather) {
          if (hCount >= MAX_HEATHER) continue;
          this.heatherInst.setMatrixAt(hCount, dummy.matrix);
          const shade = 0.8 + r2 * 0.35;
          col.setRGB(shade, shade * 0.96, shade * 1.05);
          this.heatherInst.setColorAt(hCount, col);
          hCount++;
        } else {
          if (gCount >= MAX_GRASS) continue;
          this.grassInst.setMatrixAt(gCount, dummy.matrix);
          const shade = 0.78 + r1 * 0.36;
          col.setRGB(shade * 0.98, shade * 1.04, shade * 0.9);
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

  _buildSmokeSystem() {
    if (!this.smokeSources) return;
    for (const src of this.smokeSources) {
      for (let i = 0; i < 12; i++) {
        const mat = new THREE.SpriteMaterial({
          map: this.textures.smokeTex,
          transparent: true,
          opacity: 0.4,
          depthWrite: false
        });
        const sprite = new THREE.Sprite(mat);
        this.scene.add(sprite);
        this.smokeParticles.push({
          sprite,
          src,
          age: i / 12,
          speed: 0.14 + (i % 4) * 0.025,
          seed: i * 1.9
        });
      }
    }
  }

  _buildCallumMesh() {
    this.callum = new THREE.Group();

    const woolCoatMat = new THREE.MeshStandardMaterial({ color: 0x3b3328, roughness: 0.9 });
    const plaidMat = new THREE.MeshStandardMaterial({ map: this.textures.plaidColor, roughness: 0.9 });
    const leatherMat = new THREE.MeshStandardMaterial({ color: 0x2e1f15, roughness: 0.78 });
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xd9ac88, roughness: 0.75 });
    const bonnetMat = new THREE.MeshStandardMaterial({ color: 0x213245, roughness: 0.92 });
    const hairMat = new THREE.MeshStandardMaterial({ color: 0x2a1d15, roughness: 0.9 });
    const steelMat = new THREE.MeshStandardMaterial({ color: 0xc2cbd2, roughness: 0.28, metalness: 0.88 });

    this.callumBody = new THREE.Group();
    this.callum.add(this.callumBody);

    // Tapered legs & leather brogues
    const legGeo = new THREE.CapsuleGeometry(0.09, 0.62, 5, 8);
    legGeo.translate(0, -0.36, 0);
    this.leftLeg = new THREE.Mesh(legGeo, leatherMat);
    this.leftLeg.position.set(-0.13, 0.82, 0);
    this.leftLeg.castShadow = true;

    this.rightLeg = new THREE.Mesh(legGeo, leatherMat);
    this.rightLeg.position.set(0.13, 0.82, 0);
    this.rightLeg.castShadow = true;
    this.callumBody.add(this.leftLeg, this.rightLeg);

    // Belted Great Plaid Kilt with real woven Lochaber tartan
    const kilt = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.31, 0.54, 12), plaidMat);
    kilt.position.y = 0.86;
    kilt.castShadow = true;
    this.callumBody.add(kilt);

    // Leather belt & front sporran
    const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.09, 12), leatherMat);
    belt.position.y = 1.07;
    this.callumBody.add(belt);

    const sporran = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.19, 0.08), leatherMat);
    sporran.position.set(0, 0.92, -0.25);
    this.callumBody.add(sporran);

    // Rounded torso & wool doublet
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.32, 6, 10), woolCoatMat);
    torso.scale.set(1.12, 1.0, 0.72);
    torso.position.y = 1.34;
    torso.castShadow = true;
    this.callumBody.add(torso);

    // Draped Great Plaid shoulder wrap
    const plaidWrap = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.28, 0.52, 10, 1, false, 0, Math.PI * 1.35), plaidMat);
    plaidWrap.position.set(-0.04, 1.36, 0.02);
    plaidWrap.rotation.z = -0.34;
    plaidWrap.castShadow = true;
    this.callumBody.add(plaidWrap);

    // Head, beard/hair & Blue Highland Bonnet
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

    // Articulated arms
    const armGeo = new THREE.CapsuleGeometry(0.072, 0.48, 5, 8);
    armGeo.translate(0, -0.26, 0);
    this.leftArm = new THREE.Mesh(armGeo, woolCoatMat);
    this.leftArm.position.set(-0.3, 1.54, 0);
    this.leftArm.castShadow = true;

    this.rightArm = new THREE.Mesh(armGeo, woolCoatMat);
    this.rightArm.position.set(0.3, 1.54, 0);
    this.rightArm.castShadow = true;
    this.callumBody.add(this.leftArm, this.rightArm);

    // Basket-hilted Scottish Broadsword at Left Hip
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
    const segs = highDetail ? 40 : 14;
    const geo = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE, segs, segs);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const originX = cx * CHUNK_SIZE;
    const originZ = cz * CHUNK_SIZE;
    const tmp = this.tmpColor;

    for (let i = 0; i < pos.count; i++) {
      const wx = pos.getX(i) + originX;
      const wz = pos.getZ(i) + originZ;
      const wy = heightAt(wx, wz);
      pos.setY(i, wy);

      const n = normalAt(wx, wz, 1.0);
      const surf = surfaceAt(wx, wz);
      const [r, g, b] = getTerrainColor(wx, wz, wy, 1 - n.y, surf.id);

      // CRITICAL FIX: Convert biome sRGB palette into true Linear space for PBR rendering
      tmp.setRGB(r, g, b, THREE.SRGBColorSpace);
      colors[i * 3] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;
    }

    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
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

  _updateSkyAndSun(timeOfDay, px, pz) {
    const sunAngle = ((timeOfDay - 6) / 24) * Math.PI * 2;
    const elev = Math.sin(sunAngle);
    const horiz = Math.cos(sunAngle);

    this.sunDir.set(horiz * 0.78, Math.max(elev, -0.25), -0.46).normalize();
    const dayFactor = clamp((elev + 0.08) / 0.42, 0, 1);
    const goldenFactor = clamp(1 - Math.abs(elev - 0.14) / 0.26, 0, 1);

    this.skyUniforms.uSunDir.value.copy(this.sunDir);
    this.skyUniforms.uTime.value = this.elapsed;
    this.skyUniforms.uDayFactor.value = dayFactor;
    this.skyUniforms.uGoldenFactor.value = goldenFactor;

    const snapX = Math.round(px / 2) * 2;
    const snapZ = Math.round(pz / 2) * 2;
    const activeDir = elev > 0.02 ? this.sunDir : new THREE.Vector3(-0.4, 0.55, 0.5).normalize();

    this.sunLight.position.set(snapX + activeDir.x * 160, activeDir.y * 160, snapZ + activeDir.z * 160);
    this.sunLight.target.position.set(snapX, 0, snapZ);
    this.sunLight.target.updateMatrixWorld();

    // Sync distance fog to sky horizon color
    const fogNight = new THREE.Color(0x0c1626);
    const fogDay = new THREE.Color(0x8bb0c9);
    const fogGold = new THREE.Color(0xd18a58);
    this.scene.fog.color.copy(fogNight).lerp(fogDay, dayFactor).lerp(fogGold, goldenFactor * 0.55);

    this.sunLight.intensity = elev > 0.02 ? lerp(0.55, 2.95, dayFactor) : 0.36;
    this.sunLight.color.setHex(elev > 0.02 ? (goldenFactor > 0.35 ? 0xffbe7a : 0xfff3dc) : 0x8baad6);
    this.hemiLight.intensity = lerp(0.22, 0.72, dayFactor);
    this.scene.environmentIntensity = lerp(0.22, 0.78, dayFactor);

    for (const f of this.flickerLights) {
      const pulse = 0.88 + Math.sin(this.elapsed * 9.5 + f.phase) * 0.1 + Math.sin(this.elapsed * 21 + f.phase) * 0.06;
      const nightBoost = lerp(1.8, 0.8, dayFactor);
      f.light.intensity = f.baseIntensity * pulse * nightBoost;
      f.flame.scale.set(1, pulse, 1);
    }

    if (this.towerFlag) {
      this.towerFlag.rotation.y = Math.sin(this.elapsed * 3.8) * 0.18;
    }
  }

  _updateSmoke(dt) {
    for (const p of this.smokeParticles) {
      p.age += dt * p.speed;
      if (p.age > 1) p.age -= 1;

      const rise = p.age * 9.5;
      const driftX = p.age * 3.8 + Math.sin(this.elapsed * 0.9 + p.seed) * 0.45 * p.age;
      const driftZ = p.age * 1.4 + Math.cos(this.elapsed * 0.7 + p.seed) * 0.35 * p.age;

      p.sprite.position.set(p.src.x + driftX, p.src.y + rise, p.src.z + driftZ);
      const scale = lerp(0.9, 4.6, p.age);
      p.sprite.scale.set(scale, scale, 1);
      p.sprite.material.opacity = Math.sin(p.age * Math.PI) * 0.38;
    }
  }

  update(dt, player, worldState) {
    this.elapsed += dt;
    this.windUniforms.uTime.value = this.elapsed;

    // Scroll water wave normals
    this.textures.waterNormal.offset.x += dt * 0.022;
    this.textures.waterNormal.offset.y += dt * 0.013;

    this._updateTerrainChunks(player.x, player.z);
    this._updateStreamingFoliage(player.x, player.z);
    this._updateSkyAndSun(worldState.timeOfDay, player.x, player.z);
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
