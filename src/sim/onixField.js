import * as THREE from 'three';
import { mulberry32, clamp } from '../core/prng.js';

const PHI = (1 + Math.sqrt(5)) * 0.5; // Golden-ratio quartic coupling

export class OnixField {
  constructor(size = 64, seed = 1744) {
    this.size = size;
    const n = size * size;

    // 1. ONIX Toroidal Field Lattice
    // Pillar IV: Static relaxed morphogenesis field (moss, lichen, heather colonies)
    this.psiRe = new Float32Array(n);
    this.psiIm = new Float32Array(n);
    this.velRe = new Float32Array(n);
    this.velIm = new Float32Array(n);

    // Pillar II: Live chiral LLG spin vector field S = (sx, sy, sz) (swirling wind & currents)
    this.sx = new Float32Array(n);
    this.sy = new Float32Array(n);
    this.sz = new Float32Array(n);

    // Coupled surface moisture / drainage field
    this.moisture = new Float32Array(n);
    this.nextMoisture = new Float32Array(n);

    // Packed RGBA8 GPU texture: R = static |psi|^2, G = live Sx, B = live Sz, A = moisture
    this.data = new Uint8Array(n * 4);
    this.texture = new THREE.DataTexture(this.data, size, size, THREE.RGBAFormat);
    this.texture.wrapS = THREE.RepeatWrapping;
    this.texture.wrapT = THREE.RepeatWrapping;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;

    // 2. Local World-Snapped Symplectic 2D Wave Solver (Interactive Water Ripples around Callum)
    this.rippleSize = 64;
    this.rippleWorldSize = 32.0;
    this.rippleCellSize = this.rippleWorldSize / this.rippleSize;
    this.rippleOrigin = new THREE.Vector2(0, 0);
    this.rippleOriginInit = false;

    const rn = this.rippleSize * this.rippleSize;
    this.waveH = new Float32Array(rn);
    this.waveV = new Float32Array(rn);
    this.waveFoam = new Float32Array(rn);
    this.rippleData = new Uint8Array(rn * 4);

    this.rippleTexture = new THREE.DataTexture(
      this.rippleData,
      this.rippleSize,
      this.rippleSize,
      THREE.RGBAFormat
    );
    this.rippleTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.rippleTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.rippleTexture.magFilter = THREE.LinearFilter;
    this.rippleTexture.minFilter = THREE.LinearFilter;
    this.rippleTexture.generateMipmaps = false;

    this.time = 0;
    this.tickCounter = 0;
    this._seedLattice(seed);

    // Relax morphogenesis domains at boot, then lock them so ground biomes stay grounded
    for (let i = 0; i < 24; i++) {
      this._stepMorphogenesis(0.05);
      this._stepWindAndMoisture(0.05, 0.0, 1.0);
    }
    this._packFieldTexture();
    this._packRippleTexture();
  }

  _idx(x, z) {
    const m = this.size - 1;
    return ((z & m) * this.size) + (x & m);
  }

  _seedLattice(seed) {
    const rng = mulberry32(seed + 174409);
    const S = this.size;
    for (let z = 0; z < S; z++) {
      for (let x = 0; x < S; x++) {
        const i = z * S + x;
        const a = rng() * Math.PI * 2;
        const r = 0.25 + rng() * 0.65;
        this.psiRe[i] = Math.cos(a) * r;
        this.psiIm[i] = Math.sin(a) * r;
        this.velRe[i] = (rng() - 0.5) * 0.08;
        this.velIm[i] = (rng() - 0.5) * 0.08;

        const swirl = Math.sin(x * 0.22 + z * 0.14) * 0.7 + (rng() - 0.5) * 0.9;
        const wx = Math.cos(swirl);
        const wz = Math.sin(swirl);
        const wy = 0.22 + (rng() - 0.5) * 0.35;
        const inv = 1 / Math.hypot(wx, wy, wz);
        this.sx[i] = wx * inv;
        this.sy[i] = wy * inv;
        this.sz[i] = wz * inv;

        this.moisture[i] = 0.25 + rng() * 0.38;
      }
    }
  }

  // Pillar I + IV: Symplectic Leapfrog on V[|psi|^2] = phi*|psi|^4 - |psi|^2 + Laplacian
  _stepMorphogenesis(dt) {
    const S = this.size;
    const h = Math.min(dt, 0.04);
    const halfH = h * 0.5;
    const diffK = 0.38;
    const damp = 0.92;

    for (let z = 0; z < S; z++) {
      for (let x = 0; x < S; x++) {
        const i = z * S + x;
        const re = this.psiRe[i];
        const im = this.psiIm[i];

        const lapRe =
          this.psiRe[this._idx(x + 1, z)] +
          this.psiRe[this._idx(x - 1, z)] +
          this.psiRe[this._idx(x, z + 1)] +
          this.psiRe[this._idx(x, z - 1)] -
          4 * re;
        const lapIm =
          this.psiIm[this._idx(x + 1, z)] +
          this.psiIm[this._idx(x - 1, z)] +
          this.psiIm[this._idx(x, z + 1)] +
          this.psiIm[this._idx(x, z - 1)] -
          4 * im;

        const mag2 = re * re + im * im;
        const dV = 2 * (2 * PHI * mag2 - 1);
        const fRe = diffK * lapRe - 0.22 * dV * re;
        const fIm = diffK * lapIm - 0.22 * dV * im;

        const vRe = (this.velRe[i] + halfH * fRe) * damp;
        const vIm = (this.velIm[i] + halfH * fIm) * damp;
        this.psiRe[i] = clamp(re + h * vRe, -1.25, 1.25);
        this.psiIm[i] = clamp(im + h * vIm, -1.25, 1.25);
        this.velRe[i] = vRe;
        this.velIm[i] = vIm;
      }
    }
  }

  // Pillar II: Live Chiral LLG Wind Precession + Hydraulic Moisture Diffusion
  _stepWindAndMoisture(dt, rainIntensity, windStrength) {
    const S = this.size;
    const h = Math.min(dt, 0.04);
    const J = 0.45;
    const D = 0.24;
    const alpha = 0.32;
    const biasX = Math.cos(this.time * 0.14) * 0.48 * windStrength + 0.38;
    const biasZ = Math.sin(this.time * 0.11) * 0.42 * windStrength + 0.18;

    for (let z = 0; z < S; z++) {
      for (let x = 0; x < S; x++) {
        const i = z * S + x;
        const iR = this._idx(x + 1, z);
        const iL = this._idx(x - 1, z);
        const iU = this._idx(x, z + 1);
        const iD = this._idx(x, z - 1);

        const sx = this.sx[i];
        const sy = this.sy[i];
        const sz = this.sz[i];

        const hx = J * (this.sx[iR] + this.sx[iL] + this.sx[iU] + this.sx[iD]) + D * (this.sz[iU] - this.sz[iD]) + biasX;
        const hy = J * (this.sy[iR] + this.sy[iL] + this.sy[iU] + this.sy[iD]) + 0.15;
        const hz = J * (this.sz[iR] + this.sz[iL] + this.sz[iU] + this.sz[iD]) - D * (this.sx[iR] - this.sx[iL]) + biasZ;

        const cx = sy * hz - sz * hy;
        const cy = sz * hx - sx * hz;
        const cz = sx * hy - sy * hx;

        const dx = sy * cz - sz * cy;
        const dy = sz * cx - sx * cz;
        const dz = sx * cy - sy * cx;

        const nx = sx + h * (-0.55 * cx - alpha * dx);
        const ny = sy + h * (-0.55 * cy - alpha * dy);
        const nz = sz + h * (-0.55 * cz - alpha * dz);
        const inv = 1 / (Math.hypot(nx, ny, nz) || 1);

        this.sx[i] = nx * inv;
        this.sy[i] = ny * inv;
        this.sz[i] = nz * inv;

        const avgM =
          (this.moisture[iR] + this.moisture[iL] + this.moisture[iU] + this.moisture[iD]) * 0.25;
        const m = this.moisture[i] + (avgM - this.moisture[i]) * 0.14;
        const gain = rainIntensity * 0.08 * h;
        const evap = (1 - rainIntensity) * 0.015 * h;
        this.nextMoisture[i] = clamp(m + gain - evap, 0.08, 1.0);
      }
    }

    const tmp = this.moisture;
    this.moisture = this.nextMoisture;
    this.nextMoisture = tmp;
  }

  _packFieldTexture() {
    const n = this.size * this.size;
    const out = this.data;
    for (let i = 0; i < n; i++) {
      const mag = Math.min(1, Math.hypot(this.psiRe[i], this.psiIm[i]) * 1.15);
      const o = i * 4;
      out[o] = (mag * 255) | 0;
      out[o + 1] = (clamp(this.sx[i] * 0.5 + 0.5, 0, 1) * 255) | 0;
      out[o + 2] = (clamp(this.sz[i] * 0.5 + 0.5, 0, 1) * 255) | 0;
      out[o + 3] = (clamp(this.moisture[i], 0, 1) * 255) | 0;
    }
    this.texture.needsUpdate = true;
  }

  // Symplectic 2D wave solver around Callum for interactive loch ripples & wakes
  stepWaterRipples(dt, px, py, pz, speed, waterLevel) {
    const S = this.rippleSize;
    const cell = this.rippleCellSize;

    const targetOX = Math.round(px / cell) * cell;
    const targetOZ = Math.round(pz / cell) * cell;

    if (!this.rippleOriginInit) {
      this.rippleOrigin.set(targetOX, targetOZ);
      this.rippleOriginInit = true;
    } else {
      const shiftX = Math.round((targetOX - this.rippleOrigin.x) / cell);
      const shiftZ = Math.round((targetOZ - this.rippleOrigin.y) / cell);

      if (shiftX !== 0 || shiftZ !== 0) {
        const nextH = new Float32Array(S * S);
        const nextV = new Float32Array(S * S);
        const nextF = new Float32Array(S * S);

        for (let z = 0; z < S; z++) {
          const srcZ = z + shiftZ;
          if (srcZ < 0 || srcZ >= S) continue;
          for (let x = 0; x < S; x++) {
            const srcX = x + shiftX;
            if (srcX < 0 || srcX >= S) continue;
            const dstI = z * S + x;
            const srcI = srcZ * S + srcX;
            nextH[dstI] = this.waveH[srcI];
            nextV[dstI] = this.waveV[srcI];
            nextF[dstI] = this.waveFoam[srcI];
          }
        }
        this.waveH = nextH;
        this.waveV = nextV;
        this.waveFoam = nextF;
        this.rippleOrigin.set(targetOX, targetOZ);
      }
    }

    if (py < waterLevel + 0.12) {
      const halfW = this.rippleWorldSize * 0.5;
      const gx = Math.floor((px - (this.rippleOrigin.x - halfW)) / cell);
      const gz = Math.floor((pz - (this.rippleOrigin.y - halfW)) / cell);
      const impulse = clamp(0.18 + speed * 0.24, 0.15, 1.35);

      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cx = gx + dx;
          const cz = gz + dz;
          if (cx <= 1 || cx >= S - 2 || cz <= 1 || cz >= S - 2) continue;
          const falloff = dx === 0 && dz === 0 ? 1.0 : 0.45;
          const idx = cz * S + cx;
          const pulse = speed > 0.2 ? -impulse : Math.sin(this.time * 5.0) * 0.14;
          this.waveV[idx] = clamp(this.waveV[idx] + pulse * falloff * 1.4, -3.2, 3.2);
          this.waveFoam[idx] = clamp(this.waveFoam[idx] + (0.2 + speed * 0.22) * falloff * dt * 8, 0, 1);
        }
      }
    }

    const subDt = Math.min(dt, 0.025) * 0.5;
    const c2 = 16.0;
    const damp = Math.exp(-1.45 * subDt);

    for (let step = 0; step < 2; step++) {
      for (let z = 1; z < S - 1; z++) {
        const row = z * S;
        for (let x = 1; x < S - 1; x++) {
          const i = row + x;
          const lap =
            this.waveH[i - 1] +
            this.waveH[i + 1] +
            this.waveH[i - S] +
            this.waveH[i + S] -
            4 * this.waveH[i];
          this.waveV[i] = (this.waveV[i] + c2 * lap * subDt) * damp;
        }
      }
      for (let z = 1; z < S - 1; z++) {
        const row = z * S;
        for (let x = 1; x < S - 1; x++) {
          const i = row + x;
          this.waveH[i] = clamp(this.waveH[i] + this.waveV[i] * subDt, -1.0, 1.0);
          this.waveFoam[i] = Math.max(0, this.waveFoam[i] - subDt * 0.42);
        }
      }
    }

    this._packRippleTexture();
  }

  _packRippleTexture() {
    const S = this.rippleSize;
    const out = this.rippleData;

    for (let z = 0; z < S; z++) {
      const zU = Math.min(S - 1, z + 1);
      const zD = Math.max(0, z - 1);
      for (let x = 0; x < S; x++) {
        const xR = Math.min(S - 1, x + 1);
        const xL = Math.max(0, x - 1);
        const i = z * S + x;

        const hVal = this.waveH[i];
        const dHx = (this.waveH[z * S + xR] - this.waveH[z * S + xL]) * 1.6;
        const dHz = (this.waveH[zU * S + x] - this.waveH[zD * S + x]) * 1.6;
        const foam = clamp(this.waveFoam[i] + Math.abs(hVal) * 0.45, 0, 1);

        const o = i * 4;
        out[o] = (clamp(hVal * 0.5 + 0.5, 0, 1) * 255) | 0;
        out[o + 1] = (clamp(dHx * 0.5 + 0.5, 0, 1) * 255) | 0;
        out[o + 2] = (clamp(dHz * 0.5 + 0.5, 0, 1) * 255) | 0;
        out[o + 3] = (foam * 255) | 0;
      }
    }
    this.rippleTexture.needsUpdate = true;
  }

  step(dt, rainIntensity = 0.0, windStrength = 1.0) {
    this.time += dt;
    this.tickCounter++;
    if (this.tickCounter % 3 === 0) {
      this._stepWindAndMoisture(dt * 3, rainIntensity, windStrength);
      this._packFieldTexture();
    }
  }

  sampleWind(x, z) {
    const S = this.size;
    const gx = Math.floor(x * 0.014 * S) & (S - 1);
    const gz = Math.floor(z * 0.014 * S) & (S - 1);
    const i = gz * S + gx;
    return { x: this.sx[i], z: this.sz[i] };
  }
}
