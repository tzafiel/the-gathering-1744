import { InputManager } from './core/input.js';
import {
  createDefaultWorldState,
  loadWorldState,
  saveWorldState,
  exportWorldStateJSON,
  importWorldStateJSON
} from './world/worldState.js';
import { getRegionName, LANDMARKS } from './world/terrain.js';
import { PlayerController } from './sim/player.js';
import { WorldRenderer } from './render/worldRenderer.js';

const FIXED_DT = 1 / 60;

async function boot() {
  const canvas = document.getElementById('game-canvas');
  const overlay = document.getElementById('overlay');
  const overlayStatus = document.getElementById('overlay-status');
  const errorBanner = document.getElementById('error-banner');
  const touchControls = document.getElementById('touch-controls');

  const staminaFill = document.getElementById('stamina-fill');
  const stancePill = document.getElementById('stance-pill');
  const surfacePill = document.getElementById('surface-pill');
  const wetnessPill = document.getElementById('wetness-pill');
  const clockReadout = document.getElementById('clock-readout');
  const telemetryReadout = document.getElementById('telemetry-readout');
  const compassTape = document.getElementById('compass-tape');
  const regionBanner = document.getElementById('region-banner');
  const regionTitle = document.getElementById('region-title');
  const regionSub = document.getElementById('region-sub');
  const interactPrompt = document.getElementById('interact-prompt');

  let worldState = loadWorldState();
  let player = new PlayerController(worldState);
  const input = new InputManager(canvas);
  const renderer = new WorldRenderer(canvas);

  try {
    await renderer.init();
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
    if (paused) {
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

  // Register offline Service Worker
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

  // Initial render behind title screen so the 1744 glen greets you immediately
  renderer.update(FIXED_DT, player, worldState);
  renderer.render();

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

    // Gentle real-time celestial progression (~24 real minutes per game day) + manual [ ] scrub
    worldState.timeOfDay += frameDt * (24 / 1440) + frameInput.timeDelta;
    if (worldState.timeOfDay >= 24) {
      worldState.timeOfDay -= 24;
      worldState.dayCount += 1;
    } else if (worldState.timeOfDay < 0) {
      worldState.timeOfDay += 24;
    }

    // Fixed 60Hz deterministic simulation loop
    accumulator += frameDt;
    while (accumulator >= FIXED_DT) {
      player.update(FIXED_DT, frameInput);
      accumulator -= FIXED_DT;
    }

    // Proximity check for hidden cairn stash
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

    // Render interpolated frame
    renderer.update(frameDt, player, worldState);
    renderer.render();

    // Update minimal diegetic HUD
    staminaFill.style.width = `${Math.round(player.stamina * 100)}%`;
    stancePill.textContent = player.stance;
    surfacePill.textContent = player.surface.label;
    wetnessPill.textContent = player.wetness > 0.55 ? 'SOAKED' : player.wetness > 0.15 ? 'DAMP' : 'DRY';
    clockReadout.textContent = formatClock(worldState.timeOfDay);
    compassTape.textContent = formatCompass(player.camYaw);
    telemetryReadout.textContent = `${renderer.getBackendName()} · ${Math.round(player.x)}E ${Math.round(player.z)}N · ${Math.round(player.y)}m${frameInput.gamepadConnected ? ' · PAD' : ''}`;

    // Region arrival banner
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

    // Background autosave every 15 seconds
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
