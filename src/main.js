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
import { CombatSystem } from './sim/combat.js';
import { RedcoatManager } from './sim/redcoats.js';
import { OnixField } from './sim/onixField.js';
import { WorldRenderer } from './render/worldRenderer.js';
import { HighlandAudio } from './audio/synth.js';

const FIXED_DT = 1 / 60;
const WEATHER_STATES = ['clear', 'mist', 'rain'];
const WEATHER_LABELS = { clear: 'SUNBREAK', mist: 'GLEN MIST', rain: 'HIGHLAND RAIN' };
const WEAPON_CYCLE = ['sword', 'flintlock', 'dirk', 'bow', 'holstered'];

function boot() {
  window.__GATHERING_BOOTED = true;

  const canvas = document.getElementById('game-canvas');
  const overlay = document.getElementById('overlay');
  const overlayStatus = document.getElementById('overlay-status');
  const errorBanner = document.getElementById('error-banner');
  const touchControls = document.getElementById('touch-controls');

  const healthFill = document.getElementById('health-fill');
  const staminaFill = document.getElementById('stamina-fill');
  const mountHud = document.getElementById('mount-hud');
  const mountStaminaFill = document.getElementById('mount-stamina-fill');
  const mountBondLabel = document.getElementById('mount-bond-label');
  const stancePill = document.getElementById('stance-pill');
  const surfacePill = document.getElementById('surface-pill');
  const wetnessPill = document.getElementById('wetness-pill');
  const weatherPill = document.getElementById('weather-pill');
  const stealthPill = document.getElementById('stealth-pill');
  const weaponReadout = document.getElementById('weapon-readout');
  const targeReadout = document.getElementById('targe-readout');
  const clockReadout = document.getElementById('clock-readout');
  const telemetryReadout = document.getElementById('telemetry-readout');
  const compassTape = document.getElementById('compass-tape');
  const regionBanner = document.getElementById('region-banner');
  const regionTitle = document.getElementById('region-title');
  const regionSub = document.getElementById('region-sub');
  const interactPrompt = document.getElementById('interact-prompt');
  const reticle = document.getElementById('reticle');

  let worldState = loadWorldState();
  let player = new PlayerController(worldState);
  let mount = new MountController(worldState);
  let combat = new CombatSystem(worldState);
  let redcoats = new RedcoatManager(worldState.worldSeed || 1744);
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
    combat.syncToWorldState(worldState);
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
      combat = new CombatSystem(worldState);
      redcoats = new RedcoatManager(worldState.worldSeed || 1744);
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
    combat = new CombatSystem(worldState);
    redcoats = new RedcoatManager(worldState.worldSeed || 1744);
    renderer.camPos.set(0, 0, 0);
    renderer.update(FIXED_DT, player, mount, combat, redcoats, worldState);
    renderer.render();
    overlayStatus.textContent = 'Reset to 1744 Ridge · Redcoat Patrol marching on Wade\'s Road below.';
  });

  window.addEventListener('resize', () => renderer.resize());
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

  // Tier 1 Mortality: "Left for Dead" — world moves forward 3 days, permanent scar, wake by Baile MacRae hearth
  function handleLeftForDead() {
    worldState.dayCount += 3;
    worldState.timeOfDay = 7.2;
    combat.health = 0.72;
    combat.damageFlash = 1.0;
    combat.dragTargetId = null;
    combat.scars.push(`Day ${worldState.dayCount - 3} — Left for dead in Lochaber`);
    const lostSilver = Math.ceil((worldState.player.silverShillings || 0) * 0.5);
    worldState.player.silverShillings = Math.max(0, (worldState.player.silverShillings || 0) - lostSilver);

    mount.mounted = false;
    const cl = LANDMARKS.clachan;
    player.x = cl.x - 4;
    player.z = cl.z + 4;
    player.y = heightAt(player.x, player.z);
    player.vx = player.vy = player.vz = 0;

    mount.x = cl.x - 9;
    mount.z = cl.z + 6;
    mount.y = heightAt(mount.x, mount.z);
    mount.vx = mount.vy = mount.vz = 0;
    mount.aiState = 'IDLE';

    redcoats.spawnSquad();
    renderer.camPos.set(0, 0, 0);
    syncAndSave();
    showNotice(`LEFT FOR DEAD · 3 DAYS PASSED · WOKE AT BAILE MACRAE (-${lostSilver}s, NEW SCAR)`, 5.2);
  }

  function formatCompass(yaw) {
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const deg = (((-yaw * 180) / Math.PI) % 360 + 360) % 360;
    const idx = Math.round(deg / 45) % 8;
    return `${dirs[(idx + 7) % 8]}  ·  ${dirs[idx]} (${String(Math.round(deg)).padStart(3, '0')}°)  ·  ${dirs[(idx + 1) % 8]}`;
  }

  function formatClock(hours) {
    const wrapped = ((hours % 24) + 24) % 24;
    const h = Math.floor(wrapped);
    const m = Math.floor((wrapped - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} · DAY ${worldState.dayCount} · 1744`;
  }

  function formatWeaponLabel() {
    const w = combat.weapon;
    if (w === 'sword') return `BROADSWORD${combat.bladeBlood > 0.35 ? ' (BLOODIED · Z)' : ''}`;
    if (w === 'dirk') return 'BELT DIRK · STEALTH';
    if (w === 'flintlock') {
      if (combat.flintlockReloadTimer > 0) return `FLINTLOCK · LOADING ${combat.flintlockReloadTimer.toFixed(1)}s`;
      return `FLINTLOCK · ${combat.flintlockLoaded ? 'PRIMED' : 'EMPTY [R]'} (${combat.powderCount})`;
    }
    if (w === 'bow') return `HIGHLAND BOW · ${combat.arrowCount} ARROWS`;
    return 'SHEATHED';
  }

  overlayStatus.textContent = `Ready · ${renderer.getBackendName()} · Day ${worldState.dayCount}`;
  renderer.update(FIXED_DT, player, mount, combat, redcoats, worldState);
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

    elapsed += frameDt;

    if (frameInput.weaponSelect === 'cycle') {
      const idx = WEAPON_CYCLE.indexOf(combat.weapon);
      frameInput.weaponSelect = WEAPON_CYCLE[(idx + 1) % WEAPON_CYCLE.length];
    }

    if (frameInput.weatherToggle) {
      const idx = WEATHER_STATES.indexOf(worldState.weather?.state || 'clear');
      worldState.weather = { state: WEATHER_STATES[(idx + 1) % WEATHER_STATES.length], intensity: 1.0 };
    }

    if (frameInput.muteToggle) {
      const muted = audio.toggleMute();
      showNotice(muted ? 'AUDIO MUTED' : 'HIGHLAND AUDIO ACTIVE', 1.8);
    }

    if (frameInput.whistle && !mount.mounted) {
      audio.playWhistle();
      mount.callTo(player.x, player.z);
      redcoats.notifyNoise(player.x, player.z, 26, false);
      showNotice(`WHISTLED FOR ${mount.name.toUpperCase()}`, 2.0);
    }

    const distToMount = mount.distanceTo(player.x, player.z);
    if (frameInput.mountToggle) {
      if (mount.mounted) {
        mount.mounted = false;
        mount.aiState = 'IDLE';
        mount.aiTimer = 3.5;
        const leftX = mount.x - Math.cos(mount.yaw) * 1.45;
        const leftZ = mount.z + Math.sin(mount.yaw) * 1.45;
        player.x = leftX; player.z = leftZ; player.y = heightAt(leftX, leftZ);
        player.vx = player.vy = player.vz = 0;
        player.grounded = true;
        audio.playStep(player.surface.id, 0.7, false, 0);
      } else if (distToMount < 3.8 && combat.dragTargetId === null) {
        mount.mounted = true;
        mount.aiState = 'IDLE';
        audio.playHorseVocal('nicker', 0);
        showNotice(`MOUNTED ${mount.name.toUpperCase()} · BOND ${Math.round(mount.bond * 100)}%`, 2.0);
      }
    }

    if (frameInput.tend && (mount.mounted || distToMount < 3.8)) {
      if (mount.tendMount()) {
        showNotice(`CALMED ${mount.name.toUpperCase()} · BOND ${Math.round(mount.bond * 100)}%`, 2.0);
      }
    }

    const wState = worldState.weather?.state || 'clear';
    const rainIntensity = wState === 'rain' ? 1.0 : 0.0;
    const windStrength = wState === 'rain' ? 1.65 : wState === 'mist' ? 0.65 : 1.05;

    worldState.timeOfDay += frameDt * (24 / 1440) + frameInput.timeDelta;
    if (worldState.timeOfDay >= 24) { worldState.timeOfDay -= 24; worldState.dayCount += 1; }
    else if (worldState.timeOfDay < 0) { worldState.timeOfDay += 24; }

    // 60Hz deterministic simulation with Hit-Stop freeze frames for tactile steel impact
    accumulator += frameDt;
    while (accumulator >= FIXED_DT) {
      const hitStopped = combat.update(FIXED_DT, frameInput, player, mount, redcoats, onixField, worldState, rainIntensity);
      if (!hitStopped) {
        if (!mount.mounted) player.update(FIXED_DT, frameInput);
        mount.update(FIXED_DT, frameInput, player, rainIntensity);
        redcoats.update(FIXED_DT, player, mount, combat, rainIntensity);

        if (rainIntensity > 0) player.wetness = clamp(player.wetness + 0.065 * FIXED_DT, 0, 1);
        if (mount.mounted && mount.speed > 10.5) redcoats.notifyNoise(mount.x, mount.z, 22, false);

        onixField.step(FIXED_DT, rainIntensity, windStrength);
        const wX = mount.mounted ? mount.x : player.x;
        const wY = mount.mounted ? mount.y : player.y;
        const wZ = mount.mounted ? mount.z : player.z;
        onixField.stepWaterRipples(FIXED_DT, wX, wY, wZ, mount.mounted ? mount.speed * 1.35 : player.speed, WATER_LEVEL);
      }
      accumulator -= FIXED_DT;
    }

    // Dispatch Audio & Combat Visual FX events
    audio.updateAmbient(frameDt, player.x, player.y, player.z, onixField, rainIntensity, elapsed);
    for (const ev of player.consumeEvents()) {
      if (ev.type === 'step') audio.playStep(ev.surfaceId, ev.intensity, false, 0);
    }
    for (const ev of mount.consumeEvents()) {
      if (ev.type === 'hoof') audio.playStep(ev.surfaceId, ev.intensity, true, ev.dist);
      if (ev.type === 'vocal') audio.playHorseVocal(ev.kind, ev.dist);
    }
    for (const ev of redcoats.consumeEvents()) {
      if (ev.type === 'bark') audio.playRedcoatBark(ev.kind, ev.dist);
      if (ev.type === 'dismember') renderer.combatFX.spawnDismemberment(ev);
    }
    for (const ev of combat.consumeEvents()) {
      if (ev.type === 'notice') showNotice(ev.text, ev.duration || 2.0);
      if (ev.type === 'swing') audio.playSwing(ev.kind, ev.heavy);
      if (ev.type === 'parry') {
        audio.playParry();
        renderer.combatFX.spawnSparks(ev.x, ev.y, ev.z, 18, false);
      }
      if (ev.type === 'targe_block') {
        audio.playTargeBlock(ev.isBall, ev.back);
        renderer.combatFX.spawnSparks(ev.x, ev.y, ev.z, ev.isBall ? 16 : 10, true);
      }
      if (ev.type === 'blood_hit') {
        audio.playBloodHit(ev.heavy, Boolean(ev.severPart));
        renderer.combatFX.spawnBloodBurst(ev.x, ev.y, ev.z, ev.dirX, ev.dirY, ev.dirZ, ev.heavy);
      }
      if (ev.type === 'gunshot') {
        const d = Math.hypot(ev.x - player.x, ev.z - player.z);
        audio.playGunshot(d);
        renderer.combatFX.spawnGunsmoke(ev.x, ev.y, ev.z, ev.dirX, ev.dirY, ev.dirZ);
        if (ev.owner === 'player') redcoats.notifyNoise(ev.x, ev.z, 85, true);
      }
      if (ev.type === 'misfire') {
        const d = Math.hypot(ev.x - player.x, ev.z - player.z);
        audio.playMisfire(d);
        renderer.combatFX.spawnSparks(ev.x, ev.y, ev.z, 6, false);
      }
      if (ev.type === 'bow_release') audio.playBowRelease();
      if (ev.type === 'player_died') handleLeftForDead();
    }

    // Contextual Prompts: Stealth Rob -> Corpse Loot/Drag -> Boundary Cairn -> Bramble
    const stealthVictim = !mount.mounted && combat.dragTargetId === null ? redcoats.findStealthVictim(player.x, player.z, player.facingYaw) : null;
    const nearCorpse = !mount.mounted && combat.dragTargetId === null ? redcoats.findNearestCorpse(player.x, player.z, 2.6) : null;
    const cairn = worldState.cairns[0];
    const dCairn = Math.hypot(player.x - LANDMARKS.stashCairn.x, player.z - LANDMARKS.stashCairn.z);

    if (combat.dragTargetId !== null) {
      interactPrompt.classList.remove('hidden');
      interactPrompt.textContent = player.surface?.id === 'heather'
        ? 'DRAGGING BODY (HIDDEN IN HEATHER) · [E] DROP'
        : 'DRAGGING BODY · PULL INTO HEATHER · [E] DROP';
    } else if (noticeTimer > 0) {
      noticeTimer -= frameDt;
      interactPrompt.classList.remove('hidden');
      interactPrompt.textContent = noticeText;
    } else if (stealthVictim) {
      interactPrompt.classList.remove('hidden');
      const robLabel = stealthVictim.robbed ? 'PURSE EMPTY' : '[E] ROB PURSE';
      const killLabel = combat.weapon === 'dirk' ? '  ·  [LMB] SILENT DIRK KILL' : '  ·  [3] EQUIP DIRK TO KILL';
      interactPrompt.textContent = `${robLabel}${killLabel}`;
      if (frameInput.interact && !stealthVictim.robbed) {
        const loot = redcoats.robSoldier(stealthVictim, worldState, combat);
        if (loot) showNotice(`ROBBED ${stealthVictim.rank} · +${loot.silver}s · +${loot.powder} POWDER`, 2.6);
      }
    } else if (nearCorpse) {
      interactPrompt.classList.remove('hidden');
      interactPrompt.textContent = nearCorpse.looted
        ? '[HOLD E] DRAG BODY INTO HEATHER'
        : `[E] LOOT ${nearCorpse.rank}  ·  [HOLD E] DRAG BODY`;
      if (frameInput.interact && !nearCorpse.looted) {
        const loot = redcoats.lootCorpse(nearCorpse, worldState, combat);
        if (loot) showNotice(`LOOTED ${nearCorpse.rank} · +${loot.silver}s · +${loot.powder} POWDER`, 2.6);
      } else if (frameInput.interactHold) {
        combat.dragTargetId = nearCorpse.id;
      }
    } else if (!mount.mounted && dCairn < 4.0) {
      interactPrompt.classList.remove('hidden');
      interactPrompt.textContent = cairn.discovered
        ? 'OLD CAIRN · Stash Logged (Powder & Arrows Claimed)'
        : '[E] Inspect Boundary Cairn Stash';
      if (frameInput.interact && !cairn.discovered) {
        cairn.discovered = true;
        combat.powderCount += 6;
        combat.arrowCount += 6;
        worldState.player.silverShillings = (worldState.player.silverShillings || 0) + 8;
        syncAndSave();
        showNotice('STASH LOGGED · +8s · +6 POWDER · +6 ARROWS', 3.0);
      }
    } else if (!mount.mounted && distToMount < 3.8) {
      interactPrompt.classList.remove('hidden');
      interactPrompt.textContent = `[F] Mount ${mount.name}  ·  [G] Brush & Calm (${Math.round(mount.bond * 100)}%)`;
    } else {
      interactPrompt.classList.add('hidden');
    }

    renderer.update(frameDt, player, mount, combat, redcoats, worldState);
    renderer.render();

    // Update Diegetic HUD & Aim Reticle
    const showReticle = (combat.weapon === 'bow' && combat.bowDrawing) || (combat.weapon === 'flintlock' && combat.flintlockReloadTimer <= 0);
    reticle?.classList.toggle('hidden', !showReticle);
    if (reticle && showReticle) {
      const spread = combat.weapon === 'bow' ? Math.round((1 - combat.bowDraw) * 18) : 6;
      reticle.style.setProperty('--spread', `${spread}px`);
    }

    if (healthFill) healthFill.style.width = `${Math.round(combat.health * 100)}%`;
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
    if (stealthPill) {
      const hidden = combat.stealthFactor >= 0.48;
      stealthPill.textContent = combat.stealthFactor >= 0.72 ? 'UNSEEN' : hidden ? 'CONCEALED' : 'EXPOSED';
      stealthPill.classList.toggle('hidden-state', hidden);
    }
    if (weaponReadout) weaponReadout.textContent = formatWeaponLabel();
    if (targeReadout) targeReadout.textContent = `TARGE: ${combat.targeOnArm ? 'LEFT ARM' : 'BACK ARMOR'} · ${worldState.player.silverShillings || 0}s`;

    clockReadout.textContent = formatClock(worldState.timeOfDay);
    compassTape.textContent = formatCompass(player.camYaw);
    telemetryReadout.textContent = `${renderer.getBackendName()} · ${Math.round(player.x)}E ${Math.round(player.z)}N · ${Math.round(player.y)}m${frameInput.gamepadConnected ? ' · PAD' : ''}${audio.muted ? ' · MUTE' : ''}`;

    const reg = getRegionName(player.x, player.z);
    if (reg.title !== lastRegionKey) {
      if (lastRegionKey !== '' && reg.title !== 'LOCHABER GLEN') audio.playRegionChord();
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
