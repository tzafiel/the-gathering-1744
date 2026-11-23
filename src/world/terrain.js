import { fbm2D, ridgeNoise2D, clamp, lerp, smoothstep } from '../core/prng.js';

// 9.6 km x 9.6 km Lochaber world divided into an 8x8 sector grid (1.2 km per sector)
export const WORLD_CONFIG = {
  seed: 1744,
  sectorSize: 1200,
  worldHalfSize: 4800
};

export const WATER_LEVEL = 0.0;

// Canonical Sector (0,0) landmarks — coordinates remain locked across 1744 -> 1747
export const LANDMARKS = {
  clachan: {
    id: 'baile_macrae',
    name: 'Baile MacRae',
    x: -55,
    z: -18,
    radius: 34,
    targetHeight: 8.5
  },
  coveJetty: {
    id: 'smuggling_jetty',
    name: 'Linnhe Smuggling Cove',
    x: -148,
    z: 42,
    radius: 22
  },
  watchtower: {
    id: 'torr_an_fhaire',
    name: 'Hanoverian Watchtower (Torr an Fhaire)',
    x: 152,
    z: -118,
    radius: 24,
    targetHeight: 31.0
  },
  stashCairn: {
    id: 'cairn_north_ridge',
    name: 'Old Boundary Cairn',
    x: -92,
    z: -135,
    radius: 10
  }
};

// General Wade's Military Road spline (runs North-South through the eastern floor of the glen)
export function roadCenterX(z) {
  return 88 + Math.sin(z * 0.0042) * 46 + Math.cos(z * 0.0095) * 18;
}

// Pure deterministic elevation function — single source of truth for rendering & physics
export function heightAt(x, z) {
  const seed = WORLD_CONFIG.seed;

  // Macro coastline: Sea loch (Loch Linnhe) to the west, rising glens & Munros to the east
  const coastEdge = -148 + fbm2D(x * 0.0022, z * 0.0022, 3, seed + 11) * 85;
  const distInland = x - coastEdge;

  let h;
  if (distInland < 0) {
    // Sea-loch basin dipping under water level
    const depth = smoothstep(0, -140, distInland);
    h = -depth * 14 + fbm2D(x * 0.012, z * 0.012, 2, seed + 23) * 0.9;
  } else {
    // Gentle coastal meadow transitioning into rugged Munros further east
    const coastalRise = smoothstep(0, 120, distInland) * 14;
    const mountainFactor = smoothstep(160, 750, distInland);

    const rollingHills = fbm2D(x * 0.0026, z * 0.0026, 4, seed + 37) * 26;
    const crags = ridgeNoise2D(x * 0.0021, z * 0.0021, 4, seed + 71) * 135 * mountainFactor;
    const micro = fbm2D(x * 0.022, z * 0.022, 3, seed + 109) * (1.2 + mountainFactor * 3.5);

    h = coastalRise + rollingHills * (0.45 + mountainFactor * 0.55) + crags + micro;

    // Gentle valley floor carved along Wade's Road corridor
    const roadDist = Math.abs(x - roadCenterX(z));
    const valleyCarve = 1 - smoothstep(14, 95, roadDist);
    const roadBase = 11.5 + Math.sin(z * 0.003) * 4.5 + fbm2D(x * 0.004, z * 0.004, 2, seed + 5) * 3;
    h = lerp(h, roadBase, valleyCarve * 0.55);

    // Flatten exact roadbed
    const roadBed = 1 - smoothstep(3.4, 7.2, roadDist);
    if (roadBed > 0) {
      const smoothRoadH = 11.5 + Math.sin(z * 0.003) * 4.5;
      h = lerp(h, smoothRoadH, roadBed * 0.85);
    }
  }

  // Smooth grading for Callum's home clachan bench
  const dClachan = Math.hypot(x - LANDMARKS.clachan.x, z - LANDMARKS.clachan.z);
  const clachanBlend = 1 - smoothstep(LANDMARKS.clachan.radius * 0.6, LANDMARKS.clachan.radius * 1.45, dClachan);
  if (clachanBlend > 0) {
    h = lerp(h, LANDMARKS.clachan.targetHeight, clachanBlend);
  }

  // Defensive rocky knoll for the Hanoverian Watchtower
  const dTower = Math.hypot(x - LANDMARKS.watchtower.x, z - LANDMARKS.watchtower.z);
  const towerBlend = 1 - smoothstep(10, 42, dTower);
  if (towerBlend > 0) {
    h = lerp(h, LANDMARKS.watchtower.targetHeight, towerBlend);
  }

  // Sheltered sandy/shingle landing for the smuggling cove jetty
  const dCove = Math.hypot(x - LANDMARKS.coveJetty.x, z - LANDMARKS.coveJetty.z);
  const coveBlend = 1 - smoothstep(10, 34, dCove);
  if (coveBlend > 0) {
    const coveHeight = lerp(-1.8, 2.2, smoothstep(-168, -126, x));
    h = lerp(h, coveHeight, coveBlend * 0.85);
  }

  return h;
}

export function normalAt(x, z, eps = 0.6) {
  const hL = heightAt(x - eps, z);
  const hR = heightAt(x + eps, z);
  const hD = heightAt(x, z - eps);
  const hU = heightAt(x, z + eps);

  const nx = hL - hR;
  const ny = 2 * eps;
  const nz = hD - hU;
  const inv = 1 / Math.hypot(nx, ny, nz);
  return { x: nx * inv, y: ny * inv, z: nz * inv };
}

export function surfaceAt(x, z) {
  const y = heightAt(x, z);
  if (y < WATER_LEVEL - 0.05) {
    return { id: 'water', label: 'LOCH WATER', speedMult: 0.55, traction: 0.45 };
  }
  if (y < WATER_LEVEL + 1.35) {
    return { id: 'shingle', label: 'COAST SHINGLE', speedMult: 0.90, traction: 0.82 };
  }

  const roadDist = Math.abs(x - roadCenterX(z));
  if (roadDist < 4.2 && y > 2.0) {
    return { id: 'mud_road', label: "WADE'S ROAD", speedMult: 1.08, traction: 0.96 };
  }

  const n = normalAt(x, z, 1.0);
  const slope = 1 - n.y;
  if (slope > 0.24 || y > 62) {
    return { id: 'granite', label: 'GRANITE CRAG', speedMult: 0.72, traction: 0.65 };
  }

  const moisture = fbm2D(x * 0.015, z * 0.015, 2, WORLD_CONFIG.seed + 303);
  if (y < 14 && moisture > 0.28) {
    return { id: 'peat_bog', label: 'PEAT BOG', speedMult: 0.68, traction: 0.55 };
  }

  if (y > 22 || moisture < -0.1) {
    return { id: 'heather', label: 'HEATHER MOOR', speedMult: 0.93, traction: 0.86 };
  }

  return { id: 'grass', label: 'GLEN PASTURE', speedMult: 1.0, traction: 0.94 };
}

// 1744 vibrant pre-Culloden vertex palette (emerald moss, vivid purple heather, wet slate, gravel road)
export function getTerrainColor(x, z, y, slope, surfaceId) {
  const micro = fbm2D(x * 0.045, z * 0.045, 2, WORLD_CONFIG.seed + 555) * 0.5 + 0.5;

  if (surfaceId === 'water') {
    return [0.16, 0.23, 0.24];
  }
  if (surfaceId === 'shingle') {
    return [lerp(0.36, 0.48, micro), lerp(0.34, 0.45, micro), lerp(0.30, 0.39, micro)];
  }
  if (surfaceId === 'mud_road') {
    return [lerp(0.38, 0.47, micro), lerp(0.33, 0.40, micro), lerp(0.25, 0.30, micro)];
  }
  if (surfaceId === 'granite') {
    const g = lerp(0.34, 0.50, micro);
    return [g, g * 1.01, g * 1.04];
  }
  if (surfaceId === 'peat_bog') {
    return [lerp(0.22, 0.30, micro), lerp(0.25, 0.32, micro), lerp(0.16, 0.20, micro)];
  }
  if (surfaceId === 'heather') {
    // Rich 1744 Scottish heather bloom mixed with moss
    const bloom = clamp(fbm2D(x * 0.025, z * 0.025, 3, WORLD_CONFIG.seed + 888) * 0.6 + 0.55, 0, 1);
    const r = lerp(0.24, 0.44, bloom) * lerp(0.9, 1.08, micro);
    const g = lerp(0.36, 0.25, bloom) * lerp(0.9, 1.08, micro);
    const b = lerp(0.20, 0.43, bloom) * lerp(0.9, 1.08, micro);
    return [r, g, b];
  }

  // Lush 1744 emerald glen pasture
  return [
    lerp(0.22, 0.31, micro),
    lerp(0.39, 0.49, micro),
    lerp(0.19, 0.24, micro)
  ];
}

export function getSectorCoords(x, z) {
  return {
    sx: Math.round(x / WORLD_CONFIG.sectorSize),
    sz: Math.round(z / WORLD_CONFIG.sectorSize)
  };
}

export function getRegionName(x, z) {
  if (Math.hypot(x - LANDMARKS.clachan.x, z - LANDMARKS.clachan.z) < 55) {
    return { title: 'BAILE MACRAE', sub: 'Clan Clachan · Summer 1744' };
  }
  if (Math.hypot(x - LANDMARKS.watchtower.x, z - LANDMARKS.watchtower.z) < 48) {
    return { title: 'TORR AN FHAIRE', sub: 'Hanoverian Road Watchtower' };
  }
  if (Math.hypot(x - LANDMARKS.coveJetty.x, z - LANDMARKS.coveJetty.z) < 45) {
    return { title: 'LOCH LINNHE COVE', sub: 'Smuggling Landing · Sea Loch' };
  }
  if (Math.abs(x - roadCenterX(z)) < 14) {
    return { title: "GENERAL WADE'S ROAD", sub: 'Military Causeway · Mile IV' };
  }
  if (x > 210) {
    return { title: 'BEN NEVIS FOOTHILLS', sub: 'High Heather & Granite Crags' };
  }
  const { sx, sz } = getSectorCoords(x, z);
  return { title: 'LOCHABER GLEN', sub: `Western Highlands · Sector ${sx},${sz}` };
}
