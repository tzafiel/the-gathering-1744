import { heightAt, LANDMARKS } from './terrain.js';

const STORAGE_KEY = 'the_gathering_1744_save_v1';

export function createDefaultWorldState() {
  const spawnX = 36;
  const spawnZ = 34;

  return {
    schemaVersion: 2,
    era: 1744,
    worldSeed: 1744,
    savedAt: new Date().toISOString(),
    dayCount: 1,
    timeOfDay: 18.6,
    weather: { state: 'clear', intensity: 0.0 },
    player: {
      name: 'Callum MacRae',
      x: spawnX,
      y: heightAt(spawnX, spawnZ),
      z: spawnZ,
      yaw: 0.92,
      stamina: 1.0,
      wetness: 0.0,
      silverShillings: 14,
      plaidVisible: true,
      scars: []
    },
    combat: {
      weapon: 'sword',
      targeOnArm: false,
      health: 1.0,
      bladeBlood: 0.0,
      bladeSharpness: 1.0,
      flintlockLoaded: true,
      powderCount: 10,
      arrowCount: 12
    },
    mount: {
      name: 'Bramble',
      breed: 'Highland Garron',
      coatSeed: 407,
      bond: 0.55,
      stamina: 1.0,
      calm: 0.92,
      scars: [],
      x: 29,
      z: 28,
      yaw: 0.65
    },
    campUpgrades: { smithyBuilt: true, jettyRepaired: true, watchFireLit: true },
    cairns: [
      {
        id: LANDMARKS.stashCairn.id,
        x: LANDMARKS.stashCairn.x,
        z: LANDMARKS.stashCairn.z,
        items: ['french_flintlock_pistol', 'powder_horn_dry'],
        silver: 8,
        discovered: false
      }
    ],
    garrison: {
      fortWilliamTroops: 64,
      powderStores: 1.0,
      officerNotoriety: 0.05,
      rememberedTactics: []
    },
    npcMemories: {}
  };
}

export function loadWorldState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createDefaultWorldState();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.player?.x !== 'number') return createDefaultWorldState();
    const def = createDefaultWorldState();
    return {
      ...def,
      ...parsed,
      player: { ...def.player, ...(parsed.player || {}) },
      combat: { ...def.combat, ...(parsed.combat || {}) },
      mount: { ...def.mount, ...(parsed.mount || {}) }
    };
  } catch (_) {
    return createDefaultWorldState();
  }
}

export function saveWorldState(state) {
  state.savedAt = new Date().toISOString();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (_) {}
}

export function exportWorldStateJSON(state) {
  saveWorldState(state);
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `1744-the-gathering-day${state.dayCount}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function importWorldStateJSON(file) {
  const text = await file.text();
  const parsed = JSON.parse(text);
  if (!parsed || parsed.era !== 1744 || !parsed.player) {
    throw new Error('Not a valid 1744 — The Gathering save file.');
  }
  const def = createDefaultWorldState();
  const merged = {
    ...def,
    ...parsed,
    player: { ...def.player, ...(parsed.player || {}) },
    combat: { ...def.combat, ...(parsed.combat || {}) },
    mount: { ...def.mount, ...(parsed.mount || {}) }
  };
  saveWorldState(merged);
  return merged;
}
