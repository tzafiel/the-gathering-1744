import { heightAt, normalAt, roadCenterX, LANDMARKS } from './terrain.js';
import { mulberry32, fbm2D, clamp, lerp } from '../core/prng.js';

const CELL_SIZE = 16;

export class WorldColliders {
  constructor() {
    this.circles = []; // { x, z, r, minY, maxY, material }
    this.boxes = [];   // { x, z, halfW, halfD, rotY, cos, sin, boundR, minY, maxY, material }
    this.grid = new Map();

    // Shared deterministic placement lists consumed directly by worldRenderer.js
    this.bothies = [];
    this.dykes = [];
    this.pines = [];
    this.rocks = [];
    this.milestones = [];

    this._buildStaticLandmarks();
    this._buildDeterministicProps();
  }

  _gridKey(cx, cz) {
    return `${cx},${cz}`;
  }

  _insertIntoGrid(type, index, x, z, boundR) {
    const minCX = Math.floor((x - boundR) / CELL_SIZE);
    const maxCX = Math.floor((x + boundR) / CELL_SIZE);
    const minCZ = Math.floor((z - boundR) / CELL_SIZE);
    const maxCZ = Math.floor((z + boundR) / CELL_SIZE);

    for (let cz = minCZ; cz <= maxCZ; cz++) {
      for (let cx = minCX; cx <= maxCX; cx++) {
        const key = this._gridKey(cx, cz);
        let bucket = this.grid.get(key);
        if (!bucket) {
          bucket = { circles: [], boxes: [] };
          this.grid.set(key, bucket);
        }
        if (type === 'circle') bucket.circles.push(index);
        else bucket.boxes.push(index);
      }
    }
  }

  addCircle(x, z, r, minY, maxY, material = 'wood') {
    const idx = this.circles.length;
    this.circles.push({ x, z, r, minY, maxY, material });
    this._insertIntoGrid('circle', idx, x, z, r);
  }

  addBox(x, z, width, depth, rotY, minY, maxY, material = 'stone') {
    const halfW = width * 0.5;
    const halfD = depth * 0.5;
    const boundR = Math.hypot(halfW, halfD);
    const idx = this.boxes.length;
    this.boxes.push({
      x,
      z,
      halfW,
      halfD,
      rotY,
      cos: Math.cos(rotY),
      sin: Math.sin(rotY),
      boundR,
      minY,
      maxY,
      material
    });
    this._insertIntoGrid('box', idx, x, z, boundR);
  }

  _buildStaticLandmarks() {
    const cl = LANDMARKS.clachan;

    // 1. Baile MacRae stone blackhouses
    const bothySpecs = [
      { dx: -12, dz: -7, w: 8.4, d: 5.0, rot: 0.25 },
      { dx: 11, dz: -10, w: 7.4, d: 4.6, rot: -0.42 },
      { dx: 4, dz: 12, w: 8.8, d: 5.2, rot: 1.38 }
    ];
    for (const b of bothySpecs) {
      const bx = cl.x + b.dx;
      const bz = cl.z + b.dz;
      const by = heightAt(bx, bz);
      this.bothies.push({ x: bx, y: by, z: bz, w: b.w, d: b.d, rot: b.rot });
      this.addBox(bx, bz, b.w + 0.15, b.d + 0.15, b.rot, by - 1.0, by + 4.9, 'stone');
    }

    // 2. Dry-stone enclosure dykes
    const dykeArcs = [
      { a0: 0.3, a1: 1.4, r: 21 },
      { a0: 2.1, a1: 3.5, r: 22 },
      { a0: 4.1, a1: 5.4, r: 20 }
    ];
    for (const arc of dykeArcs) {
      for (let i = 0; i < 6; i++) {
        const t0 = lerp(arc.a0, arc.a1, i / 6);
        const t1 = lerp(arc.a0, arc.a1, (i + 1) / 6);
        const mid = (t0 + t1) * 0.5;
        const wx = cl.x + Math.cos(mid) * arc.r;
        const wz = cl.z + Math.sin(mid) * arc.r;
        const wy = heightAt(wx, wz);
        const len = arc.r * (t1 - t0) + 0.35;
        const rotY = -mid + Math.PI / 2;
        this.dykes.push({ x: wx, y: wy, z: wz, len, rotY });
        this.addBox(wx, wz, len, 0.78, rotY, wy - 0.5, wy + 1.15, 'stone');
      }
    }

    // 3. Central Clachan Hearth ring (prevents walking straight through the fire logs)
    const fireY = heightAt(cl.x, cl.z);
    this.addCircle(cl.x, cl.z, 1.15, fireY - 0.4, fireY + 0.85, 'stone');

    // 4. Torr an Fhaire Stone Tower-House Keep & Base Plinth
    const tw = LANDMARKS.watchtower;
    const twY = heightAt(tw.x, tw.z);
    this.addBox(tw.x, tw.z, 9.2, 9.2, 0, twY - 2.0, twY + 3.0, 'stone');
    this.addBox(tw.x, tw.z, 7.8, 7.8, 0, twY + 2.5, twY + 16.5, 'stone');
    // Flanking watchtower fire brazier stands
    this.addCircle(tw.x - 6.2, tw.z + 3.4, 0.65, twY - 0.5, twY + 3.2, 'stone');
    this.addCircle(tw.x + 6.0, tw.z - 2.8, 0.65, twY - 0.5, twY + 3.0, 'stone');

    // 5. Boundary Cairn Stash
    const cr = LANDMARKS.stashCairn;
    const crY = heightAt(cr.x, cr.z);
    this.addCircle(cr.x, cr.z, 1.38, crY - 0.5, crY + 2.4, 'stone');

    // 6. General Wade's Road Stone Milestones
    for (let mz = -360; mz <= 360; mz += 120) {
      const mx = roadCenterX(mz) + 5.2;
      const my = heightAt(mx, mz);
      this.milestones.push({ x: mx, y: my, z: mz });
      this.addBox(mx, mz, 0.62, 0.50, 0, my - 0.5, my + 1.45, 'stone');
    }
  }

  _buildDeterministicProps() {
    const rng = mulberry32(174401);
    const maxPines = 600;
    const maxRocks = 560;

    for (let tries = 0; tries < 3800 && this.pines.length < maxPines; tries++) {
      const x = (rng() - 0.5) * 980;
      const z = (rng() - 0.5) * 980;
      const y = heightAt(x, z);
      if (y < 2.5 || y > 62) continue;
      if (Math.abs(x - roadCenterX(z)) < 11.5) continue;
      if (Math.hypot(x - LANDMARKS.clachan.x, z - LANDMARKS.clachan.z) < 34) continue;
      if (Math.hypot(x - LANDMARKS.watchtower.x, z - LANDMARKS.watchtower.z) < 26) continue;
      if (fbm2D(x * 0.011, z * 0.011, 3, 9101) < -0.14 && rng() > 0.16) continue;
      if (1 - normalAt(x, z, 1.0).y > 0.27) continue;

      const scale = 0.92 + rng() * 1.25;
      const rotX = (rng() - 0.5) * 0.10;
      const rotY = rng() * Math.PI * 2;
      const rotZ = (rng() - 0.5) * 0.10;
      const scaleY = scale * (0.90 + rng() * 0.36);
      const tone = 0.78 + rng() * 0.32;

      this.pines.push({ x, y, z, scale, scaleY, rotX, rotY, rotZ, tone });
      // Solid trunk cylinder collider (scales accurately with trunk girth!)
      this.addCircle(x, z, 0.42 * scale, y - 0.5, y + 7.2 * scaleY, 'wood');
    }

    for (let tries = 0; tries < 2200 && this.rocks.length < maxRocks; tries++) {
      const x = (rng() - 0.5) * 980;
      const z = (rng() - 0.5) * 980;
      const y = heightAt(x, z);
      if (y < 0.2 || Math.abs(x - roadCenterX(z)) < 6.5) continue;
      if (Math.hypot(x - LANDMARKS.clachan.x, z - LANDMARKS.clachan.z) < 24) continue;

      const sx = 0.65 + rng() * 2.6;
      const sy = 0.38 + rng() * 1.45;
      const sz = 0.65 + rng() * 2.6;
      const rotX = rng() * 0.6;
      const rotY = rng() * Math.PI * 2;
      const rotZ = rng() * 0.6;

      this.rocks.push({ x, y, z, sx, sy, sz, rotX, rotY, rotZ });
      const rockR = Math.max(sx, sz) * 0.78;
      if (sy > 0.52) {
        this.addCircle(x, z, rockR, y - 0.5, y + sy * 1.05, 'stone');
      }
    }
  }

  _collectNearby(x, z, r, outCircles, outBoxes) {
    const minCX = Math.floor((x - r) / CELL_SIZE);
    const maxCX = Math.floor((x + r) / CELL_SIZE);
    const minCZ = Math.floor((z - r) / CELL_SIZE);
    const maxCZ = Math.floor((z + r) / CELL_SIZE);

    for (let cz = minCZ; cz <= maxCZ; cz++) {
      for (let cx = minCX; cx <= maxCX; cx++) {
        const b = this.grid.get(this._gridKey(cx, cz));
        if (!b) continue;
        for (const ci of b.circles) outCircles.add(ci);
        for (const bi of b.boxes) outBoxes.add(bi);
      }
    }
  }

  // Smooth sliding horizontal collision resolution for Callum, Bramble & Redcoats (2-pass corner safe)
  resolveCircle(x, z, radius, entityY = 0) {
    let px = x;
    let pz = z;
    let collided = false;
    let hitNx = 0;
    let hitNz = 0;

    const nearCircles = new Set();
    const nearBoxes = new Set();
    this._collectNearby(px, pz, radius + 1.5, nearCircles, nearBoxes);

    for (let iter = 0; iter < 2; iter++) {
      for (const ci of nearCircles) {
        const c = this.circles[ci];
        // Allow jumping cleanly over low walls/rocks
        if (entityY > c.maxY - 0.15) continue;
        const dx = px - c.x;
        const dz = pz - c.z;
        const minDist = radius + c.r;
        const d2 = dx * dx + dz * dz;
        if (d2 < minDist * minDist) {
          const d = Math.sqrt(d2) || 0.0001;
          const push = minDist - d;
          const nx = dx / d;
          const nz = dz / d;
          px += nx * push;
          pz += nz * push;
          hitNx = nx;
          hitNz = nz;
          collided = true;
        }
      }

      for (const bi of nearBoxes) {
        const b = this.boxes[bi];
        if (entityY > b.maxY - 0.15) continue;

        const dx = px - b.x;
        const dz = pz - b.z;
        // Transform into OBB local space (rotate by -rotY)
        const lx = dx * b.cos - dz * b.sin;
        const lz = dx * b.sin + dz * b.cos;

        const cx = clamp(lx, -b.halfW, b.halfW);
        const cz = clamp(lz, -b.halfD, b.halfD);
        const dlx = lx - cx;
        const dlz = lz - cz;
        const d2 = dlx * dlx + dlz * dlz;

        if (d2 < radius * radius) {
          let plx = 0;
          let plz = 0;
          if (d2 > 1e-6) {
            const d = Math.sqrt(d2);
            const push = radius - d;
            plx = (dlx / d) * push;
            plz = (dlz / d) * push;
          } else {
            // Inside box fallback: eject through nearest face
            const penX = b.halfW - Math.abs(lx);
            const penZ = b.halfD - Math.abs(lz);
            if (penX < penZ) plx = (lx >= 0 ? 1 : -1) * (penX + radius);
            else plz = (lz >= 0 ? 1 : -1) * (penZ + radius);
          }

          // Transform push vector back to world space (rotate by +rotY)
          const wx = plx * b.cos + plz * b.sin;
          const wz = -plx * b.sin + plz * b.cos;
          px += wx;
          pz += wz;
          const wl = Math.hypot(wx, wz) || 1;
          hitNx = wx / wl;
          hitNz = wz / wl;
          collided = true;
        }
      }
    }

    return { x: px, z: pz, collided, nx: hitNx, nz: hitNz };
  }

  // Exact 3D Segment Raycast (blocks musket balls, sticks arrows into trees/walls, breaks Redcoat vision!)
  raycastSegment(x0, y0, z0, x1, y1, z1) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dz = z1 - z0;

    const minCX = Math.floor(Math.min(x0, x1) / CELL_SIZE) - 1;
    const maxCX = Math.floor(Math.max(x0, x1) / CELL_SIZE) + 1;
    const minCZ = Math.floor(Math.min(z0, z1) / CELL_SIZE) - 1;
    const maxCZ = Math.floor(Math.max(z0, z1) / CELL_SIZE) + 1;

    const nearCircles = new Set();
    const nearBoxes = new Set();
    for (let cz = minCZ; cz <= maxCZ; cz++) {
      for (let cx = minCX; cx <= maxCX; cx++) {
        const b = this.grid.get(this._gridKey(cx, cz));
        if (!b) continue;
        for (const ci of b.circles) nearCircles.add(ci);
        for (const bi of b.boxes) nearBoxes.add(bi);
      }
    }

    let bestT = 2.0;
    let bestMat = 'stone';

    // 1. Ray vs vertical cylinders (Scots pine trunks, boulders, cairn)
    const a2 = dx * dx + dz * dz;
    for (const ci of nearCircles) {
      const c = this.circles[ci];
      if (Math.max(y0, y1) < c.minY || Math.min(y0, y1) > c.maxY) continue;
      const fx = x0 - c.x;
      const fz = z0 - c.z;
      if (a2 < 1e-6) continue;
      const b2 = 2 * (fx * dx + fz * dz);
      const c2 = fx * fx + fz * fz - c.r * c.r;
      const disc = b2 * b2 - 4 * a2 * c2;
      if (disc < 0) continue;
      const sqrtD = Math.sqrt(disc);
      const tHit = (-b2 - sqrtD) / (2 * a2);
      if (tHit >= 0 && tHit <= 1 && tHit < bestT) {
        const hy = y0 + dy * tHit;
        if (hy >= c.minY && hy <= c.maxY) {
          bestT = tHit;
          bestMat = c.material;
        }
      }
    }

    // 2. Ray vs 3D oriented bounding boxes (cottages, dry-stone dykes, Torr an Fhaire keep)
    for (const bi of nearBoxes) {
      const b = this.boxes[bi];
      if (Math.max(y0, y1) < b.minY || Math.min(y0, y1) > b.maxY) continue;

      const rx0 = (x0 - b.x) * b.cos - (z0 - b.z) * b.sin;
      const rz0 = (x0 - b.x) * b.sin + (z0 - b.z) * b.cos;
      const rdx = dx * b.cos - dz * b.sin;
      const rdz = dx * b.sin + dz * b.cos;

      let tMin = 0.0;
      let tMax = 1.0;

      // X slab
      if (Math.abs(rdx) < 1e-7) {
        if (rx0 < -b.halfW || rx0 > b.halfW) continue;
      } else {
        let t1 = (-b.halfW - rx0) / rdx;
        let t2 = (b.halfW - rx0) / rdx;
        if (t1 > t2) [t1, t2] = [t2, t1];
        tMin = Math.max(tMin, t1);
        tMax = Math.min(tMax, t2);
        if (tMin > tMax) continue;
      }

      // Z slab
      if (Math.abs(rdz) < 1e-7) {
        if (rz0 < -b.halfD || rz0 > b.halfD) continue;
      } else {
        let t1 = (-b.halfD - rz0) / rdz;
        let t2 = (b.halfD - rz0) / rdz;
        if (t1 > t2) [t1, t2] = [t2, t1];
        tMin = Math.max(tMin, t1);
        tMax = Math.min(tMax, t2);
        if (tMin > tMax) continue;
      }

      // Y slab
      if (Math.abs(dy) < 1e-7) {
        if (y0 < b.minY || y0 > b.maxY) continue;
      } else {
        let t1 = (b.minY - y0) / dy;
        let t2 = (b.maxY - y0) / dy;
        if (t1 > t2) [t1, t2] = [t2, t1];
        tMin = Math.max(tMin, t1);
        tMax = Math.min(tMax, t2);
        if (tMin > tMax) continue;
      }

      if (tMin >= 0 && tMin <= 1 && tMin < bestT) {
        bestT = tMin;
        bestMat = b.material;
      }
    }

    if (bestT <= 1.0) {
      return {
        hit: true,
        t: bestT,
        x: x0 + dx * bestT,
        y: y0 + dy * bestT,
        z: z0 + dz * bestT,
        material: bestMat
      };
    }
    return null;
  }

  hasLineOfSight(x0, y0, z0, x1, y1, z1) {
    return this.raycastSegment(x0, y0, z0, x1, y1, z1) === null;
  }
}
