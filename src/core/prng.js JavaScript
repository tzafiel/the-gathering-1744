// Deterministic math utilities & seeded noise (zero external dependencies)

export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

// Fast seeded Mulberry32 PRNG
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic 2D integer hash -> [0, 1)
export function hash2D(ix, iz, seed = 1744) {
  let h = (ix * 374761393 + iz * 668265263 + seed * 1442695041) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

// Smooth 2D value noise -> [-1, 1]
export function valueNoise2D(x, z, seed = 1744) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;

  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);

  const a = hash2D(ix, iz, seed);
  const b = hash2D(ix + 1, iz, seed);
  const c = hash2D(ix, iz + 1, seed);
  const d = hash2D(ix + 1, iz + 1, seed);

  const n = lerp(lerp(a, b, u), lerp(c, d, u), v);
  return n * 2 - 1;
}

// Fractional Brownian Motion -> roughly [-1, 1]
export function fbm2D(x, z, octaves = 4, seed = 1744) {
  let value = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;

  for (let i = 0; i < octaves; i++) {
    value += amp * valueNoise2D(x * freq, z * freq, seed + i * 97);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return value / norm;
}

// Ridged multifractal noise for craggy Highland Munros -> [0, 1]
export function ridgeNoise2D(x, z, octaves = 4, seed = 1744) {
  let value = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;

  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(valueNoise2D(x * freq, z * freq, seed + i * 131));
    value += amp * n * n;
    norm += amp;
    amp *= 0.5;
    freq *= 2.08;
  }
  return value / norm;
}
