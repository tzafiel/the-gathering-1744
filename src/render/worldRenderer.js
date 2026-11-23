import * as THREE from 'three/webgpu';
import {
  heightAt,
  normalAt,
  surfaceAt,
  getTerrainColor,
  roadCenterX,
  WATER_LEVEL,
  LANDMARKS
} from '../world/terrain.js';
import { mulberry32, clamp, lerp } from '../core/prng.js';

const CHUNK_SIZE = 120;
const CHUNK_RADIUS = 4; // 9x9 streaming chunks (~1.08 km active view radius)

export class WorldRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.2, 1100);
    this.renderer = null;
    this.chunks = new Map();
    this.flickerLights = [];
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this.elapsed = 0;
  }

  async init() {
    this.renderer = new THREE.WebGPURenderer({
      canvas: this.canvas,
      antialias: true
    });
    await this.renderer.init();

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;

    this.scene.background = new THREE.Color(0x6ea6d4);
    this.scene.fog = new THREE.FogExp2(0x8db6d4, 0.0019);

    this.terrainMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.93,
      metalness: 0.02
    });

    this._setupLighting();
    this._buildWater();
    this._buildSector01Landmarks();
    this._buildInstancedFoliage();
    this._buildCallumMesh();
  }

  getBackendName() {
    return this.renderer?.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
  }

  _setupLighting() {
    this.hemiLight = new THREE.HemisphereLight(0xb8dcff, 0x3b4a2f, 0.72);
    this.scene.add(this.hemiLight);

    this.sunLight = new THREE.DirectionalLight(0xfff1d6, 2.35);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.near = 10;
    this.sunLight.shadow.camera.far = 360;
    const d = 95;
    this.sunLight.shadow.camera.left = -d;
    this.sunLight.shadow.camera.right = d;
    this.sunLight.shadow.camera.top = d;
    this.sunLight.shadow.camera.bottom = -d;
    this.sunLight.shadow.bias = -0.0005;
    this.sunLight.shadow.normalBias = 0.035;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);

    // Subtle sun disc in the sky
    this.sunDisc = new THREE.Mesh(
      new THREE.SphereGeometry(18, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xfff5d8, fog: false })
    );
    this.scene.add(this.sunDisc);
  }

  _buildWater() {
    const geo = new THREE.PlaneGeometry(1800, 1800, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x1b4254,
      roughness: 0.16,
      metalness: 0.32,
      transparent: true,
      opacity: 0.9
    });
    this.waterMesh = new THREE.Mesh(geo, mat);
    this.waterMesh.position.y = WATER_LEVEL;
    this.waterMesh.receiveShadow = true;
    this.scene.add(this.waterMesh);
  }

  _buildSector01Landmarks() {
    const stoneMat = new THREE.MeshStandardMaterial({ color: 0x6f6e68, roughness: 0.95 });
    const darkStoneMat = new THREE.MeshStandardMaterial({ color: 0x4f4f4b, roughness: 0.96 });
    const turfRoofMat = new THREE.MeshStandardMaterial({ color: 0x424d2f, roughness: 0.98 });
    const timberMat = new THREE.MeshStandardMaterial({ color: 0x4f3825, roughness: 0.9 });
    const emberMat = new THREE.MeshBasicMaterial({ color: 0xff8c2b });

    // 1. Baile MacRae — Callum's Home Clachan
    const cl = LANDMARKS.clachan;
    const bothies = [
      { dx: -11, dz: -6, w: 7.5, d: 4.8, rot: 0.25 },
      { dx: 10, dz: -10, w: 6.8, d: 4.5, rot: -0.4 },
      { dx: 4, dz: 11, w: 8.2, d: 5.0, rot: 1.35 }
    ];

    for (const b of bothies) {
      const bx = cl.x + b.dx;
      const bz = cl.z + b.dz;
      const by = heightAt(bx, bz);
      const group = new THREE.Group();
      group.position.set(bx, by, bz);
      group.rotation.y = b.rot;

      const walls = new THREE.Mesh(new THREE.BoxGeometry(b.w, 2.7, b.d), stoneMat);
      walls.position.y = 1.25;
      walls.castShadow = true;
      walls.receiveShadow = true;
      group.add(walls);

      const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(b.w, b.d) * 0.72, 2.4, 4), turfRoofMat);
      roof.position.y = 3.7;
      roof.rotation.y = Math.PI / 4;
      roof.scale.set(b.w / Math.max(b.w, b.d), 1, b.d / Math.max(b.w, b.d));
      roof.castShadow = true;
      roof.receiveShadow = true;
      group.add(roof);

      const door = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.9, 0.2), timberMat);
      door.position.set(0, 0.95, b.d * 0.5 + 0.04);
      group.add(door);

      this.scene.add(group);
    }

    // Central Clachan Peat Hearth
    const fireY = heightAt(cl.x, cl.z);
    const hearthRing = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.24, 6, 12), darkStoneMat);
    hearthRing.rotation.x = Math.PI / 2;
    hearthRing.position.set(cl.x, fireY + 0.15, cl.z);
    this.scene.add(hearthRing);

    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.45, 0.95, 6), emberMat);
    flame.position.set(cl.x, fireY + 0.55, cl.z);
    this.scene.add(flame);

    const hearthLight = new THREE.PointLight(0xff8e36, 14, 34, 1.8);
    hearthLight.position.set(cl.x, fireY + 1.5, cl.z);
    this.scene.add(hearthLight);
    this.flickerLights.push({ light: hearthLight, flame, baseIntensity: 14, phase: 0.4 });

    // 2. Hanoverian Redcoat Watchtower overlooking Wade's Road
    const tw = LANDMARKS.watchtower;
    const twY = heightAt(tw.x, tw.z);
    const towerGroup = new THREE.Group();
    towerGroup.position.set(tw.x, twY, tw.z);

    const towerBase = new THREE.Mesh(new THREE.CylinderGeometry(4.4, 5.2, 12.5, 8), darkStoneMat);
    towerBase.position.y = 6.0;
    towerBase.castShadow = true;
    towerBase.receiveShadow = true;
    towerGroup.add(towerBase);

    const parapet = new THREE.Mesh(new THREE.CylinderGeometry(5.1, 4.9, 1.4, 8), stoneMat);
    parapet.position.y = 12.6;
    parapet.castShadow = true;
    towerGroup.add(parapet);

    // Watchtower Flagpole & British Union Pennant
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 6.5, 6), timberMat);
    pole.position.set(0, 16.0, 0);
    towerGroup.add(pole);

    const flag = new THREE.Mesh(
      new THREE.BoxGeometry(2.6, 1.35, 0.08),
      new THREE.MeshStandardMaterial({ color: 0xa42422, roughness: 0.85 })
    );
    flag.position.set(1.3, 18.2, 0);
    towerGroup.add(flag);

    // Twin Watchtower Braziers (visible from across the glen)
    for (const bx of [-3.6, 3.6]) {
      const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.35, 1.2, 6), darkStoneMat);
      stand.position.set(bx, 13.6, 0);
      towerGroup.add(stand);

      const bFlame = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.0, 6), emberMat);
      bFlame.position.set(bx, 14.5, 0);
      towerGroup.add(bFlame);

      const bLight = new THREE.PointLight(0xff8429, 22, 52, 1.6);
      bLight.position.set(tw.x + bx, twY + 15.1, tw.z);
      this.scene.add(bLight);
      this.flickerLights.push({ light: bLight, flame: bFlame, baseIntensity: 22, phase: bx * 1.7 });
    }
    this.scene.add(towerGroup);

    // 3. Smuggling Cove Timber Jetty on Loch Linnhe
    const jt = LANDMARKS.coveJetty;
    const deck = new THREE.Mesh(new THREE.BoxGeometry(14, 0.35, 3.2), timberMat);
    deck.position.set(jt.x - 4, WATER_LEVEL + 0.85, jt.z);
    deck.castShadow = true;
    deck.receiveShadow = true;
    this.scene.add(deck);

    for (let i = -5; i <= 5; i += 2.5) {
      for (const pz of [-1.2, 1.2]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 3.6, 6), timberMat);
        post.position.set(jt.x - 4 + i, WATER_LEVEL - 0.3, jt.z + pz);
        post.castShadow = true;
        this.scene.add(post);
      }
    }

    // 4. Old Boundary Stash Cairn
    const cr = LANDMARKS.stashCairn;
    const crY = heightAt(cr.x, cr.z);
    const cairn = new THREE.Mesh(new THREE.ConeGeometry(1.5, 2.2, 7), stoneMat);
    cairn.position.set(cr.x, crY + 1.0, cr.z);
    cairn.castShadow = true;
    cairn.receiveShadow = true;
    this.scene.add(cairn);

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

  _buildInstancedFoliage() {
    const rng = mulberry32(174401);
    const maxPines = 520;
    const maxRocks = 320;

    const trunkGeo = new THREE.CylinderGeometry(0.22, 0.38, 4.6, 6);
    trunkGeo.translate(0, 2.3, 0);
    const crownGeo = new THREE.ConeGeometry(2.35, 6.2, 7);
    crownGeo.translate(0, 6.4, 0);
    const rockGeo = new THREE.DodecahedronGeometry(1.0, 0);

    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4b3526, roughness: 0.95 });
    const crownMat = new THREE.MeshStandardMaterial({ color: 0x26442c, roughness: 0.9 });
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x5c605e, roughness: 0.96 });

    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, maxPines);
    const crowns = new THREE.InstancedMesh(crownGeo, crownMat, maxPines);
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, maxRocks);

    trunks.castShadow = true;
    crowns.castShadow = true;
    crowns.receiveShadow = true;
    rocks.castShadow = true;
    rocks.receiveShadow = true;

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    let pineCount = 0;
    for (let tries = 0; tries < 2400 && pineCount < maxPines; tries++) {
      const x = (rng() - 0.5) * 900;
      const z = (rng() - 0.5) * 900;
      const y = heightAt(x, z);
      if (y < 2.5 || y > 54) continue;
      if (Math.abs(x - roadCenterX(z)) < 11) continue;
      if (Math.hypot(x - LANDMARKS.clachan.x, z - LANDMARKS.clachan.z) < 38) continue;
      if (Math.hypot(x - LANDMARKS.watchtower.x, z - LANDMARKS.watchtower.z) < 26) continue;

      const n = normalAt(x, z, 1.0);
      if (1 - n.y > 0.26) continue;

      const scale = 0.78 + rng() * 0.95;
      dummy.position.set(x, y - 0.2, z);
      dummy.rotation.set((rng() - 0.5) * 0.08, rng() * Math.PI * 2, (rng() - 0.5) * 0.08);
      dummy.scale.set(scale, scale * (0.9 + rng() * 0.3), scale);
      dummy.updateMatrix();

      trunks.setMatrixAt(pineCount, dummy.matrix);
      crowns.setMatrixAt(pineCount, dummy.matrix);
      color.setHSL(0.36 + (rng() - 0.5) * 0.05, 0.34, 0.18 + rng() * 0.08);
      crowns.setColorAt(pineCount, color);
      pineCount++;
    }
    trunks.count = pineCount;
    crowns.count = pineCount;

    let rockCount = 0;
    for (let tries = 0; tries < 1200 && rockCount < maxRocks; tries++) {
      const x = (rng() - 0.5) * 900;
      const z = (rng() - 0.5) * 900;
      const y = heightAt(x, z);
      if (y < 0.2) continue;
      if (Math.abs(x - roadCenterX(z)) < 7.5) continue;
      if (Math.hypot(x - LANDMARKS.clachan.x, z - LANDMARKS.clachan.z) < 24) continue;

      const sx = 0.7 + rng() * 2.4;
      const sy = 0.45 + rng() * 1.4;
      const sz = 0.7 + rng() * 2.4;
      dummy.position.set(x, y + sy * 0.25, z);
      dummy.rotation.set(rng() * 0.6, rng() * Math.PI * 2, rng() * 0.6);
      dummy.scale.set(sx, sy, sz);
      dummy.updateMatrix();

      rocks.setMatrixAt(rockCount, dummy.matrix);
      const shade = 0.32 + rng() * 0.16;
      color.setRGB(shade, shade * 1.01, shade * 1.03);
      rocks.setColorAt(rockCount, color);
      rockCount++;
    }
    rocks.count = rockCount;

    this.scene.add(trunks, crowns, rocks);
  }

  _buildCallumMesh() {
    // Articulated procedural Highlander rig (swappable later via AssetRegistry for rigged GLB)
    this.callum = new THREE.Group();

    const woolCoatMat = new THREE.MeshStandardMaterial({ color: 0x3b3328, roughness: 0.92 });
    const plaidMat = new THREE.MeshStandardMaterial({ color: 0x2f533b, roughness: 0.92 }); // Natural-dyed Lochaber moss plaid
    const accentMat = new THREE.MeshStandardMaterial({ color: 0x7a2b25, roughness: 0.9 });
    const leatherMat = new THREE.MeshStandardMaterial({ color: 0x2b1d14, roughness: 0.85 });
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xd9ad8b, roughness: 0.8 });
    const bonnetMat = new THREE.MeshStandardMaterial({ color: 0x243447, roughness: 0.92 });
    const steelMat = new THREE.MeshStandardMaterial({ color: 0xb9c2c9, roughness: 0.35, metalness: 0.85 });

    this.callumBody = new THREE.Group();
    this.callum.add(this.callumBody);

    // Legs
    const legGeo = new THREE.CylinderGeometry(0.11, 0.09, 0.82, 7);
    legGeo.translate(0, -0.41, 0);
    this.leftLeg = new THREE.Mesh(legGeo, leatherMat);
    this.leftLeg.position.set(-0.14, 0.84, 0);
    this.leftLeg.castShadow = true;

    this.rightLeg = new THREE.Mesh(legGeo, leatherMat);
    this.rightLeg.position.set(0.14, 0.84, 0);
    this.rightLeg.castShadow = true;
    this.callumBody.add(this.leftLeg, this.rightLeg);

    // Belted Kilt / Great Plaid Skirt
    const kilt = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.32, 0.56, 8), plaidMat);
    kilt.position.y = 0.86;
    kilt.castShadow = true;
    this.callumBody.add(kilt);

    // Torso
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.50, 0.62, 0.30), woolCoatMat);
    torso.position.y = 1.32;
    torso.castShadow = true;
    this.callumBody.add(torso);

    // Draped Great Plaid Shoulder Sash
    const sash = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.64, 0.33), accentMat);
    sash.position.set(-0.04, 1.34, 0.01);
    sash.scale.set(0.45, 1.0, 1.04);
    sash.rotation.z = -0.38;
    sash.castShadow = true;
    this.callumBody.add(sash);

    // Head & Blue Highland Bonnet
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 10), skinMat);
    head.position.y = 1.78;
    head.castShadow = true;
    this.callumBody.add(head);

    const bonnet = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.17, 0.11, 10), bonnetMat);
    bonnet.position.set(0.02, 1.91, -0.01);
    bonnet.rotation.z = -0.14;
    bonnet.castShadow = true;
    this.callumBody.add(bonnet);

    // Arms
    const armGeo = new THREE.CylinderGeometry(0.08, 0.07, 0.64, 6);
    armGeo.translate(0, -0.32, 0);
    this.leftArm = new THREE.Mesh(armGeo, woolCoatMat);
    this.leftArm.position.set(-0.32, 1.54, 0);
    this.leftArm.castShadow = true;

    this.rightArm = new THREE.Mesh(armGeo, woolCoatMat);
    this.rightArm.position.set(0.32, 1.54, 0);
    this.rightArm.castShadow = true;
    this.callumBody.add(this.leftArm, this.rightArm);

    // Basket-Hilted Broadsword Scabbard at Left Hip
    const scabbard = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.025, 1.08, 6), leatherMat);
    scabbard.position.set(-0.30, 0.92, 0.12);
    scabbard.rotation.x = 0.65;
    scabbard.rotation.z = 0.18;
    this.callumBody.add(scabbard);

    const basketHilt = new THREE.Mesh(new THREE.SphereGeometry(0.085, 8, 8), steelMat);
    basketHilt.position.set(-0.24, 1.24, -0.22);
    this.callumBody.add(basketHilt);

    this.scene.add(this.callum);
  }

  _buildChunk(cx, cz, highDetail) {
    const segs = highDetail ? 32 : 12;
    const geo = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE, segs, segs);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const originX = cx * CHUNK_SIZE;
    const originZ = cz * CHUNK_SIZE;

    for (let i = 0; i < pos.count; i++) {
      const wx = pos.getX(i) + originX;
      const wz = pos.getZ(i) + originZ;
      const wy = heightAt(wx, wz);
      pos.setY(i, wy);

      const n = normalAt(wx, wz, 1.1);
      const surf = surfaceAt(wx, wz);
      const [r, g, b] = getTerrainColor(wx, wz, wy, 1 - n.y, surf.id);
      colors[i * 3] = r;
      colors[i * 3 + 1] = g;
      colors[i * 3 + 2] = b;
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
    // Sun elevation angle from 0..24h clock (sunrise ~05:30, sunset ~20:30 in Highland summer)
    const sunAngle = ((timeOfDay - 6) / 24) * Math.PI * 2;
    const elev = Math.sin(sunAngle);
    const horiz = Math.cos(sunAngle);

    const sunDir = new THREE.Vector3(horiz * 0.78, Math.max(elev, -0.25), -0.46).normalize();
    const dayFactor = clamp((elev + 0.08) / 0.45, 0, 1);
    const goldenFactor = clamp(1 - Math.abs(elev - 0.14) / 0.26, 0, 1);

    // Snap shadow anchor to 2m grid to prevent shadow swimming
    const snapX = Math.round(px / 2) * 2;
    const snapZ = Math.round(pz / 2) * 2;
    const activeDir = elev > 0.02 ? sunDir : new THREE.Vector3(-0.4, 0.55, 0.5).normalize();

    this.sunLight.position.set(snapX + activeDir.x * 160, activeDir.y * 160, snapZ + activeDir.z * 160);
    this.sunLight.target.position.set(snapX, 0, snapZ);
    this.sunLight.target.updateMatrixWorld();

    this.sunDisc.position.set(px + sunDir.x * 780, sunDir.y * 780, pz + sunDir.z * 780);
    this.sunDisc.visible = elev > -0.05;

    // 1744 Atlantic sky & fog palette
    const nightSky = new THREE.Color(0x0c1522);
    const daySky = new THREE.Color(0x5e9cd4);
    const goldenSky = new THREE.Color(0xd98a52);
    const skyColor = nightSky.clone().lerp(daySky, dayFactor).lerp(goldenSky, goldenFactor * 0.55);

    this.scene.background.copy(skyColor);
    this.scene.fog.color.copy(skyColor).lerp(new THREE.Color(0xa6c5db), dayFactor * 0.35);

    this.sunLight.intensity = elev > 0.02 ? lerp(0.45, 2.55, dayFactor) : 0.32;
    this.sunLight.color.setHex(elev > 0.02 ? (goldenFactor > 0.4 ? 0xffc688 : 0xfff3db) : 0x89a9d6);
    this.hemiLight.intensity = lerp(0.18, 0.78, dayFactor);

    // Flickering peat fire & watchtower braziers
    for (const f of this.flickerLights) {
      const pulse = 0.88 + Math.sin(this.elapsed * 9.5 + f.phase) * 0.1 + Math.sin(this.elapsed * 21 + f.phase) * 0.06;
      const nightBoost = lerp(1.65, 0.75, dayFactor);
      f.light.intensity = f.baseIntensity * pulse * nightBoost;
      f.flame.scale.set(1, pulse, 1);
    }
  }

  update(dt, player, worldState) {
    this.elapsed += dt;

    this._updateTerrainChunks(player.x, player.z);
    this._updateSkyAndSun(worldState.timeOfDay, player.x, player.z);

    // Keep water plane centered under player
    this.waterMesh.position.x = Math.round(player.x / 50) * 50;
    this.waterMesh.position.z = Math.round(player.z / 50) * 50;

    // Update Callum's 3D rig & grounded procedural gait
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

    // Over-the-shoulder RDR2 camera with ground-clip guard
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
