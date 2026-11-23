import { InputManager } from './core/input.js';
import { clamp } from './core/prng.js';
import {
  createDefaultWorldState,
  loadWorldState,
  saveWorldState,
  exportWorldStateJSON,
  importWorldStateJSON
} from './world/worldState.js';
import { getRegionName, LANDMARKS, WATER_LEVEL } from './world/terrain.js';
import { PlayerController } from './sim/player.js';
import { OnixField } from './sim/onixField.js';
import { WorldRenderer } from './render/worldRenderer.js';

const FIXED_DT = 1 / 60;
const WEATHER_STATES = ['clear', 'mist', 'rain'];
const WEATHER_LABELS = { clear: 'SUNBREAK', mist: 'GLEN MIST', rain: 'HIGHLAND RAIN' };

function boot() {
  window.__GATHERING_BOOTED = true;

  const canvas = document.getElementById('game-canvas');
  const overlay = document.getElementById('overlay');
  const overlayStatus = document.getElementById('overlay-status');
  const errorBanner = document.getElementById('error-banner');
  const touchControls = document.getElementById('touch-controls');

  const staminaFill = document.getElementById('stamina-fill');
  const stancePill = document.getElementById('stance-pill');
  const surfacePill = document.getElementById('surface-pill');
  const wetnessPill = document.getElementById('wetness-pill');
  const weatherPill = document.getElementById('weather-pill');
  const clockReadout = document.getElementById('clock-readout');
  const telemetryReadout = document.getElementById('telemetry-readout');
  const compassTape = document.getElementById('compass-tape');
  const regionBanner = document.getElementById('region-banner');
  const regionTitle = document.getElementById('region-title');
  const regionSub = document.getElementById('region-sub');
  const interactPrompt = document.getElementById('interact-prompt');

  let worldState = loadWorldState();
  let player = new PlayerController(worldState);
  const onixField = new OnixField(64, worldState.worldSeed || 1744);
  const input = new InputManager(canvas);
  const renderer = new WorldRenderer(canvas, onixField);

  try {
    renderer.init();
  } catch (err) {
    errorBanner.textContent = `Renderer failed to initialize: ${err.message}`;
    errorBanner.classList.remove('hidden');
    console.error(err);
    return;
  }

  let paused = true;
  let lastRegionKey = '';
  let bannerTimer = 0;
  let autoSaveTimer = 0;
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

  function setPaused(next) {
    paused = next;
    overlay.classList.toggle('hidden', !paused);
    if (isTouch) touchControls.classList.toggle('hidden', paused);
    if (!paused) {
      input.clearTransient();
    } else {
      player.syncToWorldState(worldState);
      saveWorldState(worldState);
      overlayStatus.textContent = `Saved locally · ${renderer.getBackendName()} · Day ${worldState.dayCount}`;
    }
  }

  document.getElementById('btn-play').addEventListener('click', () => {
    setPaused(false);
    if (!isTouch) input.requestPointerLock();
  });

  document.getElementById('btn-export').addEventListener('click', () => {
    player.syncToWorldState(worldState);
    exportWorldStateJSON(worldState);
    overlayStatus.textContent = 'Exported 1744 portable JSON save.';
  });

  const fileInput = document.getElementById('file-import');
  document.getElementById('btn-import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      worldState = await importWorldStateJSON(file);
      player = new PlayerController(worldState);
      overlayStatus.textContent = `Loaded 1744 save (Day ${worldState.dayCount}).`;
    } catch (err) {
      overlayStatus.textContent = err.message;
    }
    fileInput.value = '';
  });

  document.getElementById('btn-reset').addEventListener('click', () => {
    worldState = createDefaultWorldState();
    saveWorldState(worldState);
    player = new PlayerController(worldState);
    overlayStatus.textContent = 'World reset to Summer 1744 defaults.';
  });

  window.addEventListener('resize', () => renderer.resize());

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  function formatCompass(yaw) {
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const deg = (((-yaw * 180) / Math.PI) % 360 + 360) % 360;
    const idx = Math.round(deg / 45) % 8;
    const prev = dirs[(idx + 7) % 8];
    const next = dirs[(idx + 1) % 8];
    return `${prev}  ·  ${dirs[idx]} (${String(Math.round(deg)).padStart(3, '0')}°)  ·  ${next}`;
  }

  function formatClock(hours) {
    const wrapped = ((hours % 24) + 24) % 24;
    const h = Math.floor(wrapped);
    const m = Math.floor((wrapped - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} · DAY ${worldState.dayCount} · 1744`;
  }

  overlayStatus.textContent = `Ready · ${renderer.getBackendName()} · Day ${worldState.dayCount}`;

  renderer.update(FIXED_DT, player, worldState);
  renderer.render();
  telemetryReadout.textContent = `${renderer.getBackendName()} · ${Math.round(player.x)}E ${Math.round(player.z)}N · ${Math.round(player.y)}m`;

  let lastTime = performance.now();
  let accumulator = 0;

  function frame(now) {
    requestAnimationFrame(frame);
    const frameDt = Math.min((now - lastTime) / 1000, 0.08);
    lastTime = now;

    const frameInput = input.poll(frameDt);
    if (frameInput.pausePressed && !paused) {
      setPaused(true);
      return;
    }

    if (paused) {
      renderer.render();
      return;
    }

    if (frameInput.weatherToggle) {
      const idx = WEATHER_STATES.indexOf(worldState.weather?.state || 'clear');
      worldState.weather = {
        state: WEATHER_STATES[(idx + 1) % WEATHER_STATES.length],
        intensity: 1.0
      };
    }

    const wState = worldState.weather?.state || 'clear';
    const rainIntensity = wState === 'rain' ? 1.0 : 0.0;
    const windStrength = wState === 'rain' ? 1.65 : wState === 'mist' ? 0.65 : 1.05;

    worldState.timeOfDay += frameDt * (24 / 1440) + frameInput.timeDelta;
    if (worldState.timeOfDay >= 24) {
      worldState.timeOfDay -= 24;
      worldState.dayCount += 1;
    } else if (worldState.timeOfDay < 0) {
      worldState.timeOfDay += 24;
    }

    // Fixed 60Hz deterministic simulation: Callum kinematics + ONIX lattice + symplectic water wakes
    accumulator += frameDt;
    while (accumulator >= FIXED_DT) {
      player.update(FIXED_DT, frameInput);
      if (rainIntensity > 0) {
        player.wetness = clamp(player.wetness + 0.065 * FIXED_DT, 0, 1);
      }
      onixField.step(FIXED_DT, rainIntensity, windStrength);
      onixField.stepWaterRipples(FIXED_DT, player.x, player.y, player.z, player.speed, WATER_LEVEL);
      accumulator -= FIXED_DT;
    }

    const cairn = worldState.cairns[0];
    const dCairn = Math.hypot(player.x - LANDMARKS.stashCairn.x, player.z - LANDMARKS.stashCairn.z);
    if (dCairn < 4.0) {
      interactPrompt.classList.remove('hidden');
      interactPrompt.textContent = cairn.discovered
        ? 'OLD CAIRN · Stash Logged (1 French Flintlock, 8s)'
        : '[E] Inspect Boundary Cairn Stash';
      if (frameInput.interact && !cairn.discovered) {
        cairn.discovered = true;
        player.syncToWorldState(worldState);
        saveWorldState(worldState);
      }
    } else {
      interactPrompt.classList.add('hidden');
    }

    renderer.update(frameDt, player, worldState);
    renderer.render();

    staminaFill.style.width = `${Math.round(player.stamina * 100)}%`;
    stancePill.textContent = player.stance;
    surfacePill.textContent = player.surface.label;
    wetnessPill.textContent = player.wetness > 0.55 ? 'SOAKED' : player.wetness > 0.15 ? 'DAMP' : 'DRY';
    if (weatherPill) weatherPill.textContent = WEATHER_LABELS[wState] || 'SUNBREAK';
    clockReadout.textContent = formatClock(worldState.timeOfDay);
    compassTape.textContent = formatCompass(player.camYaw);
    telemetryReadout.textContent = `${renderer.getBackendName()} · ${Math.round(player.x)}E ${Math.round(player.z)}N · ${Math.round(player.y)}m${frameInput.gamepadConnected ? ' · PAD' : ''}`;

    const reg = getRegionName(player.x, player.z);
    if (reg.title !== lastRegionKey) {
      lastRegionKey = reg.title;
      regionTitle.textContent = reg.title;
      regionSub.textContent = reg.sub;
      regionBanner.classList.add('visible');
      bannerTimer = 4.2;
    } else if (bannerTimer > 0) {
      bannerTimer -= frameDt;
      if (bannerTimer <= 0) regionBanner.classList.remove('visible');
    }

    autoSaveTimer += frameDt;
    if (autoSaveTimer >= 15) {
      autoSaveTimer = 0;
      player.syncToWorldState(worldState);
      saveWorldState(worldState);
    }
  }

  requestAnimationFrame(frame);
}

boot();
