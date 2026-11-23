import * as THREE from 'three';
import { heightAt } from '../world/terrain.js';
import { clamp, lerp } from '../core/prng.js';

export class CombatFX {
  constructor(scene) {
    this.scene = scene;

    // Shared materials
    this.bloodMat = new THREE.MeshStandardMaterial({ color: 0x5c0505, roughness: 0.24, metalness: 0.08 });
    this.poolMat = new THREE.MeshStandardMaterial({
      color: 0x3b0303,
      roughness: 0.16,
      metalness: 0.10,
      transparent: true,
      opacity: 0.88,
      depthWrite: false
    });
    this.sparkMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(4.5, 3.0, 1.2), toneMapped: false });
    this.woodChipMat = new THREE.MeshStandardMaterial({ color: 0x6b4b2a, roughness: 0.85 });
    this.skinMat = new THREE.MeshStandardMaterial({ color: 0xc49576, roughness: 0.78 });
    this.coatMat = new THREE.MeshStandardMaterial({ color: 0x8f1c18, roughness: 0.86 });
    this.hatMat = new THREE.MeshStandardMaterial({ color: 0x17181c, roughness: 0.92 });
    this.goreMat = new THREE.MeshStandardMaterial({ color: 0x4d0606, roughness: 0.30 });
    this.arrowWoodMat = new THREE.MeshStandardMaterial({ color: 0x634527, roughness: 0.8 });
    this.fletchMat = new THREE.MeshStandardMaterial({ color: 0xd8d2c2, roughness: 0.9 });
    this.leadMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 2.0, 1.4), toneMapped: false });

    // Soft black-powder smoke sprite texture
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 4, 32, 32, 32);
    g.addColorStop(0, 'rgba(232,232,228,0.88)');
    g.addColorStop(0.55, 'rgba(188,190,192,0.48)');
    g.addColorStop(1, 'rgba(160,165,170,0.0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    this.smokeTex = new THREE.CanvasTexture(c);

    // Pooled / tracked active visual FX arrays
    this.droplets = [];
    this.bloodPools = [];
    this.debris = []; // Bouncing severed limbs, heads, hats
    this.sparks = [];
    this.smokePuffs = [];
    this.projMeshes = new Map();

    this.dropGeo = new THREE.SphereGeometry(0.045, 5, 5);
    this.poolGeo = new THREE.CircleGeometry(0.65, 10);
    this.poolGeo.rotateX(-Math.PI / 2);
    this.sparkGeo = new THREE.BoxGeometry(0.035, 0.035, 0.16);
    this.ballGeo = new THREE.SphereGeometry(0.038, 6, 6);
  }

  spawnBloodBurst(x, y, z, dirX, dirY, dirZ, heavy = false) {
    const count = heavy ? 28 : 14;
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(this.dropGeo, this.bloodMat);
      const s = 0.55 + Math.random() * (heavy ? 1.55 : 0.95);
      m.scale.setScalar(s);
      m.position.set(x, y, z);
      this.scene.add(m);

      const spd = (heavy ? 3.5 : 2.2) + Math.random() * (heavy ? 5.8 : 3.2);
      this.droplets.push({
        mesh: m,
        vx: dirX * spd + (Math.random() - 0.5) * 3.8,
        vy: Math.max(0.8, dirY * spd + 1.4 + Math.random() * 3.4),
        vz: dirZ * spd + (Math.random() - 0.5) * 3.8,
        age: 0,
        maxAge: 1.6,
        canPool: i < (heavy ? 5 : 2)
      });
    }

    // Immediate dark crimson pool spreading beneath the wound
    this._spawnBloodPool(x + dirX * 0.45, z + dirZ * 0.45, heavy ? 1.15 : 0.68);
  }

  _spawnBloodPool(x, z, targetRadius) {
    const m = new THREE.Mesh(this.poolGeo, this.poolMat);
    const y = heightAt(x, z) + 0.035;
    m.position.set(x, y, z);
    m.rotation.z = Math.random() * Math.PI * 2;
    m.scale.set(0.18, 1, 0.18);
    this.scene.add(m);
    this.bloodPools.push({ mesh: m, radius: 0.18, target: targetRadius, age: 0 });

    // Cap persistent pools for steady 60fps
    if (this.bloodPools.length > 48) {
      const old = this.bloodPools.shift();
      this.scene.remove(old.mesh);
    }
  }

  // Launch physically bouncing severed head, arm, or tricorne hat down the Highland slope!
  spawnDismemberment({ part, hatLost, x, y, z, dirX, dirY, dirZ }) {
    if (part === 'head') {
      const headObj = new THREE.Group();
      const skull = new THREE.Mesh(new THREE.SphereGeometry(0.14, 9, 9), this.skinMat);
      const stump = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.07, 7), this.goreMat);
      stump.position.y = -0.12;
      skull.castShadow = true;
      headObj.add(skull, stump);
      this._launchDebris(headObj, x, y + 1.72, z, dirX * 5.2 + (Math.random() - 0.5) * 2.0, 4.2, dirZ * 5.2 + (Math.random() - 0.5) * 2.0, 0.14, true);
    } else if (part === 'rightArm' || part === 'leftArm') {
      const armObj = new THREE.Group();
      const sleeve = new THREE.Mesh(new THREE.CapsuleGeometry(0.068, 0.44, 4, 7), this.coatMat);
      const stump = new THREE.Mesh(new THREE.SphereGeometry(0.072, 6, 6), this.goreMat);
      stump.position.y = 0.24;
      sleeve.castShadow = true;
      armObj.add(sleeve, stump);
      const side = part === 'rightArm' ? 0.3 : -0.3;
      this._launchDebris(armObj, x + side, y + 1.35, z, dirX * 4.4 + side * 4.0, 3.2, dirZ * 4.4, 0.09, true);
    }

    if (hatLost) {
      const hatObj = new THREE.Group();
      const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.145, 0.10, 8), this.hatMat);
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.03, 3), this.hatMat);
      brim.position.y = -0.02;
      hatObj.add(crown, brim);
      this._launchDebris(hatObj, x, y + 1.92, z, dirX * 3.2 + (Math.random() - 0.5) * 2.5, 4.6, dirZ * 3.2 + (Math.random() - 0.5) * 2.5, 0.08, false);
    }
  }

  _launchDebris(mesh, x, y, z, vx, vy, vz, radius, bleeds) {
    mesh.position.set(x, y, z);
    this.scene.add(mesh);
    this.debris.push({
      mesh,
      vx,
      vy,
      vz,
      rx: (Math.random() - 0.5) * 12,
      ry: (Math.random() - 0.5) * 12,
      rz: (Math.random() - 0.5) * 12,
      radius,
      bleeds,
      bounces: 0,
      age: 0
    });

    if (this.debris.length > 26) {
      const old = this.debris.shift();
      this.scene.remove(old.mesh);
    }
  }

  spawnSparks(x, y, z, count = 14, isWood = false) {
    const mat = isWood ? this.woodChipMat : this.sparkMat;
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(this.sparkGeo, mat);
      m.position.set(x, y, z);
      this.scene.add(m);
      const a = Math.random() * Math.PI * 2;
      const spd = 2.5 + Math.random() * 6.5;
      this.sparks.push({
        mesh: m,
        vx: Math.cos(a) * spd,
        vy: 1.5 + Math.random() * 4.5,
        vz: Math.sin(a) * spd,
        age: 0,
        maxAge: isWood ? 0.55 : 0.34
      });
    }
  }

  // Rolling 1744 black-powder smoke cloud pushed downwind by your live ONIX field!
  spawnGunsmoke(x, y, z, dirX, dirY, dirZ) {
    this.spawnSparks(x, y, z, 10, false);
    for (let i = 0; i < 12; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this.smokeTex,
        transparent: true,
        opacity: 0.78,
        depthWrite: false
      });
      const sp = new THREE.Sprite(mat);
      const jitter = 0.25 + i * 0.14;
      sp.position.set(
        x + dirX * jitter + (Math.random() - 0.5) * 0.45,
        y + dirY * jitter + (Math.random() - 0.5) * 0.35,
        z + dirZ * jitter + (Math.random() - 0.5) * 0.45
      );
      sp.scale.setScalar(0.85 + Math.random() * 0.65);
      this.scene.add(sp);
      this.smokePuffs.push({
        sprite: sp,
        vx: dirX * (2.6 + Math.random() * 2.2) + (Math.random() - 0.5) * 1.1,
        vy: 0.45 + Math.random() * 0.65,
        vz: dirZ * (2.6 + Math.random() * 2.2) + (Math.random() - 0.5) * 1.1,
        age: 0,
        maxAge: 5.5 + Math.random() * 2.5,
        startScale: sp.scale.x,
        endScale: 4.8 + Math.random() * 2.4
      });
    }
  }

  _makeArrowMesh() {
    const g = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.82, 5), this.arrowWoodMat);
    shaft.rotation.x = Math.PI / 2;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.024, 0.11, 4), this.leadMat);
    tip.rotation.x = Math.PI / 2;
    tip.position.z = 0.44;
    const fletch = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.015, 0.18), this.fletchMat);
    fletch.position.z = -0.32;
    g.add(shaft, tip, fletch);
    return g;
  }

  update(dt, combat, onixField) {
    // 1. Blood droplets (gravity + ONIX crosswind + splattering into ground pools)
    for (let i = this.droplets.length - 1; i >= 0; i--) {
      const d = this.droplets[i];
      d.age += dt;
      const w = onixField.sampleWind(d.mesh.position.x, d.mesh.position.z);
      d.vx += w.x * 1.4 * dt;
      d.vz += w.z * 1.4 * dt;
      d.vy -= 16.5 * dt;

      d.mesh.position.x += d.vx * dt;
      d.mesh.position.y += d.vy * dt;
      d.mesh.position.z += d.vz * dt;

      const gy = heightAt(d.mesh.position.x, d.mesh.position.z);
      if (d.mesh.position.y <= gy || d.age >= d.maxAge) {
        if (d.canPool && d.mesh.position.y <= gy + 0.1) {
          this._spawnBloodPool(d.mesh.position.x, d.mesh.position.z, 0.32 + Math.random() * 0.35);
        }
        this.scene.remove(d.mesh);
        this.droplets.splice(i, 1);
      }
    }

    // 2. Growing crimson ground pools
    for (const pool of this.bloodPools) {
      pool.age += dt;
      if (pool.radius < pool.target) {
        pool.radius = lerp(pool.radius, pool.target, 1 - Math.exp(-3.2 * dt));
        pool.mesh.scale.set(pool.radius, 1, pool.radius);
      }
    }

    // 3. Tumbling, bouncing severed limbs, heads & tricorne hats
    for (const db of this.debris) {
      db.age += dt;
      if (db.bounces >= 4 && Math.hypot(db.vx, db.vz) < 0.15) continue;

      db.vy -= 17.0 * dt;
      db.mesh.position.x += db.vx * dt;
      db.mesh.position.y += db.vy * dt;
      db.mesh.position.z += db.vz * dt;

      db.mesh.rotation.x += db.rx * dt;
      db.mesh.rotation.y += db.ry * dt;
      db.mesh.rotation.z += db.rz * dt;

      const gy = heightAt(db.mesh.position.x, db.mesh.position.z) + db.radius;
      if (db.mesh.position.y < gy) {
        db.mesh.position.y = gy;
        if (Math.abs(db.vy) > 1.2) {
          db.vy = -db.vy * 0.38;
          db.vx *= 0.65;
          db.vz *= 0.65;
          db.rx *= 0.65;
          db.ry *= 0.65;
          db.rz *= 0.65;
          db.bounces++;
          if (db.bleeds && db.bounces <= 2) {
            this._spawnBloodPool(db.mesh.position.x, db.mesh.position.z, 0.38);
          }
        } else {
          db.vy = 0;
          db.vx *= Math.exp(-6 * dt);
          db.vz *= Math.exp(-6 * dt);
          db.rx *= Math.exp(-6 * dt);
          db.ry *= Math.exp(-6 * dt);
          db.rz *= Math.exp(-6 * dt);
          db.bounces = 4;
        }
      }
    }

    // 4. Steel parry sparks & splintered oak targe chips
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const sp = this.sparks[i];
      sp.age += dt;
      sp.vy -= 14.0 * dt;
      sp.mesh.position.x += sp.vx * dt;
      sp.mesh.position.y += sp.vy * dt;
      sp.mesh.position.z += sp.vz * dt;
      sp.mesh.lookAt(sp.mesh.position.x + sp.vx, sp.mesh.position.y + sp.vy, sp.mesh.position.z + sp.vz);
      sp.mesh.scale.setScalar(clamp(1 - sp.age / sp.maxAge, 0.01, 1));
      if (sp.age >= sp.maxAge) {
        this.scene.remove(sp.mesh);
        this.sparks.splice(i, 1);
      }
    }

    // 5. Rolling ONIX-wind-carried black-powder gunsmoke clouds
    for (let i = this.smokePuffs.length - 1; i >= 0; i--) {
      const sm = this.smokePuffs[i];
      sm.age += dt;
      const w = onixField.sampleWind(sm.sprite.position.x, sm.sprite.position.z);
      sm.vx = lerp(sm.vx, w.x * 1.65, 1 - Math.exp(-1.5 * dt));
      sm.vz = lerp(sm.vz, w.z * 1.65, 1 - Math.exp(-1.5 * dt));
      sm.vy *= Math.exp(-1.1 * dt);

      sm.sprite.position.x += sm.vx * dt;
      sm.sprite.position.y += sm.vy * dt;
      sm.sprite.position.z += sm.vz * dt;

      const t = clamp(sm.age / sm.maxAge, 0, 1);
      sm.sprite.scale.setScalar(lerp(sm.startScale, sm.endScale, Math.pow(t, 0.65)));
      sm.sprite.material.opacity = Math.sin((1 - t) * Math.PI * 0.5) * 0.72;

      if (sm.age >= sm.maxAge) {
        this.scene.remove(sm.sprite);
        sm.sprite.material.dispose();
        this.smokePuffs.splice(i, 1);
      }
    }

    // 6. Sync live arrows & musket balls (preserving orientation when arrows stick in ground/bodies!)
    const activeIds = new Set();
    for (const p of combat.projectiles) {
      activeIds.add(p.id);
      let entry = this.projMeshes.get(p.id);
      if (!entry) {
        const mesh = p.kind === 'arrow' ? this._makeArrowMesh() : new THREE.Mesh(this.ballGeo, this.leadMat);
        this.scene.add(mesh);
        entry = { mesh };
        this.projMeshes.set(p.id, entry);
      }
      entry.mesh.position.set(p.x, p.y, p.z);
      if (!p.stuck && Math.hypot(p.vx, p.vy, p.vz) > 0.1) {
        entry.mesh.lookAt(p.x + p.vx, p.y + p.vy, p.z + p.vz);
      }
    }
    for (const [id, entry] of this.projMeshes.entries()) {
      if (!activeIds.has(id)) {
        this.scene.remove(entry.mesh);
        this.projMeshes.delete(id);
      }
    }
  }
}
