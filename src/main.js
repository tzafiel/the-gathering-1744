import { InputManager } from './core/input.js';
import { clamp } from './core/prng.js';
import {
  createDefaultWorldState,
  loadWorldState,
  saveWorldState,
  exportWorldStateJSON,
  importWorldStateJSON
} from './world/worldState.js';
import { getRegionName, heightAt, LANDMARKS, WATER_LEVEL } from './world/terrain.js';
import { PlayerController } from './sim/player.js';
import { MountController } from './sim/mount.js';
import { OnixField } from './sim/onixField.js';
import { WorldRenderer } from './render/worldRenderer.js';
import { HighlandAudio } from './audio/synth.js';

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
  const mountHud = document.getElementById('mount-hud');
  const mountStaminaFill = document.getElementById('mount-stamina-fill');
  const mountBondLabel = document.getElementById('mount-bond-label');
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
  let mount = new MountController(worldState);
  const onixField = new OnixField(64, worldState.worldSeed || 1744);
  const input = new InputManager(canvas);
  const audio = new HighlandAudio();
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
  let noticeTimer = 0;
  let noticeText = '';
  let autoSaveTimer = 0;
  let elapsed = 0;
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

  function showNotice(text, seconds = 2.4) {
    noticeText = text;
    noticeTimer = seconds;
  }

  function syncAndSave() {
    player.syncToWorldState(worldState);
    mount.syncToWorldState(worldState);
    saveWorldState(worldState);
  }

  function setPaused(next) {
    paused = next;
    overlay.classList.toggle('hidden', !paused);
    if (isTouch) touchControls.classList.toggle('hidden', paused);
    if (!paused) {
      audio.unlock();
      input.clearTransient();
    } else {
      syncAndSave();
      overlayStatus.textContent = `Saved locally · ${renderer.getBackendName()} · Day ${worldState.dayCount}`;
    }
  }

  document.getElementById('btn-play').addEventListener('click', () => {
    setPaused(false);
    if (!isTouch) input.requestPointerLock();
  });

  document.getElementById('btn-export').addEventListener('click', () => {
    syncAndSave();
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
      mount = new MountController(worldState);
      renderer.camPos.set(0, 0, 0);
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
    mount = new MountController(worldState);
    renderer.camPos.set(0, 0, 0);
    renderer.update(FIXED_DT, player, mount, worldState);
    renderer.render();
    overlayStatus.textContent = 'World reset to Golden Dusk 1744 — Bramble awaits nearby.';
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

  renderer.update(FIXED_DT, player, mount, worldState);
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

    elapsed += frameDt;

    if (frameInput.weatherToggle) {
      const idx = WEATHER_STATES.indexOf(worldState.weather?.state || 'clear');
      worldState.weather = {
        state: WEATHER_STATES[(idx + 1) % WEATHER_STATES.length],
        intensity: 1.0
      };
    }

    if (frameInput.oilToggle) {
      renderer.toggleOilMode();
    }

    if (frameInput.muteToggle) {
      const muted = audio.toggleMute();
      showNotice(muted ? 'AUDIO MUTED' : 'HIGHLAND AUDIO ACTIVE', 1.8);
    }

    // Whistle for Bramble from anywhere across the highlands
    if (frameInput.whistle && !mount.mounted) {
      audio.playWhistle();
      mount.callTo(player.x, player.z);
      showNotice(`WHISTLED FOR ${mount.name.toUpperCase()}`, 2.2);
    }

    // Mount / Dismount Bramble
    const distToMount = mount.distanceTo(player.x, player.z);
    if (frameInput.mountToggle) {
      if (mount.mounted) {
        // Dismount cleanly to Bramble's left flank
        mount.mounted = false;
        mount.aiState = 'IDLE';
        mount.aiTimer = 3.5;
        const leftX = mount.x - Math.cos(mount.yaw) * 1.45;
        const leftZ = mount.z + Math.sin(mount.yaw) * 1.45;
        player.x = leftX;
        player.z = leftZ;
        player.y = heightAt(leftX, leftZ);
        player.vx = 0;
        player.vz = 0;
        player.vy = 0;
        player.grounded = true;
        audio.playStep(player.surface.id, 0.7, false, 0);
      } else if (distToMount < 3.8) {
        mount.mounted = true;
        mount.aiState = 'IDLE';
        audio.playHorseVocal('nicker', 0);
        showNotice(`MOUNTED ${mount.name.toUpperCase()} · BOND ${Math.round(mount.bond * 100)}%`, 2.2);
      }
    }

    // Brush / calm Bramble (works beside him or patting his neck from the saddle)
    if (frameInput.tend && (mount.mounted || distToMount < 3.8)) {
      if (mount.tendMount()) {
        showNotice(`CALMED ${mount.name.toUpperCase()} · BOND ${Math.round(mount.bond * 100)}%`, 2.2);
      }
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

    // 60Hz deterministic simulation loop
    accumulator += frameDt;
    while (accumulator >= FIXED_DT) {
      if (!mount.mounted) {
        player.update(FIXED_DT, frameInput);
      }
      mount.update(FIXED_DT, frameInput, player, rainIntensity);

      if (rainIntensity > 0) {
        player.wetness = clamp(player.wetness + 0.065 * FIXED_DT, 0, 1);
      }

      onixField.step(FIXED_DT, rainIntensity, windStrength);

      // Feed active wading entity (Bramble's hooves when mounted, Callum's boots on foot) into wave solver
      const wX = mount.mounted ? mount.x : player.x;
      const wY = mount.mounted ? mount.y : player.y;
      const wZ = mount.mounted ? mount.z : player.z;
      const wSpd = mount.mounted ? mount.speed * 1.35 : player.speed;
      onixField.stepWaterRipples(FIXED_DT, wX, wY, wZ, wSpd, WATER_LEVEL);

      accumulator -= FIXED_DT;
    }

    // Dispatch procedural Web Audio events
    audio.updateAmbient(frameDt, player.x, player.y, player.z, onixField, rainIntensity, elapsed);
    for (const ev of player.consumeEvents()) {
      if (ev.type === 'step') audio.playStep(ev.surfaceId, ev.intensity, false, 0);
    }
    for (const ev of mount.consumeEvents()) {
      if (ev.type === 'hoof') audio.playStep(ev.surfaceId, ev.intensity, true, ev.dist);
      if (ev.type === 'vocal') audio.playHorseVocal(ev.kind, ev.dist);
    }

    // Contextual interaction prompt (Notice -> Boundary Cairn -> Bramble)
    const cairn = worldState.cairns[0];
    const dCairn = Math.hypot(player.x - LANDMARKS.stashCairn.x, player.z - LANDMARKS.stashCairn.z);

    if (noticeTimer > 0) {
      noticeTimer -= frameDt;
      interactPrompt.classList.remove('hidden');
      interactPrompt.textContent = noticeText;
    } else if (!mount.mounted && dCairn < 4.0) {
      interactPrompt.classList.remove('hidden');
      interactPrompt.textContent = cairn.discovered
        ? 'OLD CAIRN · Stash Logged (1 French Flintlock, 8s)'
        : '[E] Inspect Boundary Cairn Stash';
      if (frameInput.interact && !cairn.discovered) {
        cairn.discovered = true;
        syncAndSave();
        showNotice('STASH LOGGED · FRENCH FLINTLOCK & 8 SHILLINGS', 3.0);
      }
    } else if (!mount.mounted && distToMount < 3.8) {
      interactPrompt.classList.remove('hidden');
      interactPrompt.textContent = `[F] Mount ${mount.name}  ·  [G] Brush & Calm (${Math.round(mount.bond * 100)}%)`;
    } else {
      interactPrompt.classList.add('hidden');
    }

    renderer.update(frameDt, player, mount, worldState);
    renderer.render();

    // Update minimal diegetic HUD
    staminaFill.style.width = `${Math.round(player.stamina * 100)}%`;
    const showMountHud = mount.mounted || distToMount < 11.0;
    mountHud?.classList.toggle('hidden', !showMountHud);
    if (showMountHud) {
      mountStaminaFill.style.width = `${Math.round(mount.stamina * 100)}%`;
      mountBondLabel.textContent = `${mount.name.toUpperCase()} · ${Math.round(mount.bond * 100)}%`;
    }

    stancePill.textContent = player.stance;
    surfacePill.textContent = player.surface.label;
    wetnessPill.textContent = player.wetness > 0.55 ? 'SOAKED' : player.wetness > 0.15 ? 'DAMP' : 'DRY';
    if (weatherPill) weatherPill.textContent = WEATHER_LABELS[wState] || 'SUNBREAK';
    clockReadout.textContent = formatClock(worldState.timeOfDay);
    compassTape.textContent = formatCompass(player.camYaw);
    telemetryReadout.textContent = `${renderer.getBackendName()} · ${Math.round(player.x)}E ${Math.round(player.z)}N · ${Math.round(player.y)}m${frameInput.gamepadConnected ? ' · PAD' : ''}${audio.muted ? ' · MUTE' : ''}`;

    const reg = getRegionName(player.x, player.z);
    if (reg.title !== lastRegionKey) {
      if (lastRegionKey !== '' && reg.title !== 'LOCHABER GLEN') {
        audio.playRegionChord();
      }
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
      syncAndSave();
    }
  }

  requestAnimationFrame(frame);
}

boot();
