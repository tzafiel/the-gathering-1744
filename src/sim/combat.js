import { heightAt, WATER_LEVEL } from '../world/terrain.js';
import { clamp, lerp } from '../core/prng.js';

export class CombatSystem {
  constructor(worldState) {
    const c = worldState.combat || {};
    this.weapon = c.weapon || 'sword';
    this.targeOnArm = Boolean(c.targeOnArm ?? false);

    this.health = clamp(c.health ?? 1.0, 0.1, 1.0);
    this.bladeBlood = clamp(c.bladeBlood ?? 0.0, 0, 1);
    this.bladeSharpness = clamp(c.bladeSharpness ?? 1.0, 0.4, 1.0);
    this.scars = Array.isArray(worldState.player?.scars) ? [...worldState.player.scars] : [];

    this.flintlockLoaded = c.flintlockLoaded ?? true;
    this.flintlockReloadTimer = 0;
    this.flintlockReloadDuration = 5.4;
    this.powderCount = c.powderCount ?? 10;
    this.arrowCount = c.arrowCount ?? 12;

    this.bowDrawing = false;
    this.bowDraw = 0;

    this.attackState = 'NONE';
    this.attackKind = 'fast_left';
    this.attackTimer = 0;
    this.attackWindup = 0.12;
    this.attackActiveEnd = 0.26;
    this.attackDuration = 0.48;
    this.attackHeavy = false;
    this.attackHitIds = new Set();

    this.lmbDownPrev = false;
    this.lmbHoldTime = 0;
    this.rmbDownPrev = false;
    this.guarding = false;
    this.parryWindow = 0;

    this.hitStopTimer = 0;
    this.screenShake = 0;
    this.damageFlash = 0;
    this.wipeTimer = 0;
    this.dragTargetId = null;
    this.stealthFactor = 0;

    this.projectiles = [];
    this.nextProjId = 1;
    this.smokeZones = [];
    this.events = [];
  }

  consumeEvents() {
    if (this.events.length === 0) return [];
    const out = this.events;
    this.events = [];
    return out;
  }

  // Exact First-Person eye ray (ZERO third-person parallax!)
  getAimDir(player) {
    const cosP = Math.cos(player.camPitch);
    const sinP = Math.sin(player.camPitch);
    const sinY = Math.sin(player.camYaw);
    const cosY = Math.cos(player.camYaw);
    return {
      x: -sinY * cosP,
      y: -sinP,
      z: -cosY * cosP
    };
  }

  getEyeHeight(player, mount) {
    if (mount.mounted) return mount.y + 2.38;
    return player.y + lerp(1.68, 1.02, player.crouchBlend);
  }

  computeStealth(player, worldState, rainIntensity) {
    let score = 0;
    if (player.crouchBlend > 0.5) score += 0.36;
    if (this.weapon === 'dirk' || this.weapon === 'bow' || this.weapon === 'holstered') score += 0.14;
    if (player.surface?.id === 'heather') score += 0.22;
    if (worldState.weather?.state === 'mist') score += 0.22;
    if (rainIntensity > 0.2) score += 0.14;
    const h = ((worldState.timeOfDay % 24) + 24) % 24;
    if (h < 5.5 || h > 20.5) score += 0.24;
    else if (h < 7.0 || h > 19.0) score += 0.10;

    for (const s of this.smokeZones) {
      if (Math.hypot(player.x - s.x, player.z - s.z) < s.radius) {
        score += 0.45;
        break;
      }
    }

    if (player.speed > 5.0) score -= 0.30;
    this.stealthFactor = clamp(score, 0, 0.94);
    return this.stealthFactor;
  }

  update(dt, input, player, mount, redcoats, onixField, worldState, rainIntensity) {
    this.screenShake = Math.max(0, this.screenShake - dt * 3.4);
    this.damageFlash = Math.max(0, this.damageFlash - dt * 2.2);
    if (this.wipeTimer > 0) this.wipeTimer = Math.max(0, this.wipeTimer - dt);

    if (this.hitStopTimer > 0) {
      this.hitStopTimer = Math.max(0, this.hitStopTimer - dt);
      return true;
    }

    const wind = onixField.sampleWind(player.x, player.z);
    for (let i = this.smokeZones.length - 1; i >= 0; i--) {
      const s = this.smokeZones[i];
      s.age += dt;
      s.x += wind.x * 1.45 * dt;
      s.z += wind.z * 1.45 * dt;
      s.radius = lerp(2.2, 7.5, clamp(s.age / 3.5, 0, 1));
      if (s.age > s.maxAge) this.smokeZones.splice(i, 1);
    }

    if (player.y < WATER_LEVEL + 0.1 || rainIntensity > 0.25) {
      this.bladeBlood = Math.max(0, this.bladeBlood - dt * (player.y < WATER_LEVEL + 0.1 ? 0.35 : 0.08));
    }

    if (!redcoats.isAnyCombatActive() && this.health < 1.0 && this.health > 0) {
      this.health = Math.min(1.0, this.health + dt * 0.018);
    }

    this.computeStealth(player, worldState, rainIntensity);

    if (input.weaponSelect && this.attackState === 'NONE') {
      const next = input.weaponSelect === 'holster'
        ? (this.weapon === 'holstered' ? 'sword' : 'holstered')
        : input.weaponSelect;
      if (next !== this.weapon) {
        this.weapon = next;
        this.bowDrawing = false;
        this.bowDraw = 0;
        if ((next === 'bow' || next === 'flintlock') && this.targeOnArm) {
          this.targeOnArm = false;
          this.events.push({ type: 'notice', text: 'TARGE SLUNG ON BACK', duration: 1.5 });
        }
        const labels = {
          sword: "FATHER'S BROADSWORD",
          flintlock: 'HIGHLAND FLINTLOCK',
          dirk: 'BELT DIRK (STEALTH)',
          bow: 'HIGHLAND HUNTING BOW',
          holstered: 'WEAPONS SHEATHED'
        };
        this.events.push({ type: 'notice', text: labels[next] || next.toUpperCase(), duration: 1.5 });
      }
    }

    if (input.targeToggle && this.attackState === 'NONE') {
      this.targeOnArm = !this.targeOnArm;
      if (this.targeOnArm && (this.weapon === 'bow' || this.weapon === 'flintlock')) {
        this.weapon = 'sword';
        this.bowDrawing = false;
        this.bowDraw = 0;
      }
      this.events.push({
        type: 'notice',
        text: this.targeOnArm ? 'TARGE ON LEFT ARM · FRONT GUARD & BASH' : 'TARGE SLUNG ON BACK · REAR ARMOR ACTIVE',
        duration: 2.0
      });
    }

    if (input.wipeBlade && this.bladeBlood > 0.05 && this.attackState === 'NONE') {
      this.wipeTimer = 0.8;
      this.bladeBlood = 0;
      this.events.push({ type: 'swing', kind: 'wipe', heavy: false });
      this.events.push({ type: 'notice', text: 'WIPED STEEL CLEAN', duration: 1.4 });
    }

    if (this.flintlockReloadTimer > 0) {
      if (player.speed > 5.8 || this.attackState !== 'NONE') {
        this.flintlockReloadTimer = 0;
        this.events.push({ type: 'notice', text: 'RELOAD INTERRUPTED', duration: 1.4 });
      } else {
        this.flintlockReloadTimer -= dt;
        if (this.flintlockReloadTimer <= 0) {
          this.flintlockReloadTimer = 0;
          this.flintlockLoaded = true;
          this.powderCount = Math.max(0, this.powderCount - 1);
          this.events.push({ type: 'notice', text: 'FLINTLOCK PRIMED & LOADED', duration: 1.8 });
        }
      }
    } else if (input.reload && !this.flintlockLoaded) {
      if (this.powderCount <= 0) {
        this.events.push({ type: 'notice', text: 'NO DRY POWDER LEFT · LOOT PATROLS OR CAIRNS', duration: 2.2 });
      } else {
        this.flintlockReloadTimer = this.flintlockReloadDuration;
        this.events.push({ type: 'notice', text: 'LOADING FLINTLOCK... (STAY STEADY)', duration: 2.0 });
      }
    }

    if (this.dragTargetId !== null) {
      const corpse = redcoats.getById(this.dragTargetId);
      if (!corpse || !corpse.dead || mount.mounted || input.interact) {
        this.dragTargetId = null;
        this.events.push({ type: 'notice', text: 'BODY DROPPED', duration: 1.2 });
      } else {
        const backX = player.x + Math.sin(player.camYaw) * 1.15;
        const backZ = player.z + Math.cos(player.camYaw) * 1.15;
        corpse.x = lerp(corpse.x, backX, 1 - Math.exp(-8 * dt));
        corpse.z = lerp(corpse.z, backZ, 1 - Math.exp(-8 * dt));
        corpse.y = heightAt(corpse.x, corpse.z);
        corpse.hiddenInHeather = player.surface?.id === 'heather';
      }
    }

    const canGuard =
      (this.weapon === 'sword' || this.weapon === 'dirk' || this.targeOnArm) &&
      this.attackState === 'NONE' &&
      !this.bowDrawing &&
      player.stamina > 0.05;

    if (input.guardDown && canGuard) {
      if (!this.rmbDownPrev) this.parryWindow = 0.22;
      this.guarding = true;
      this.parryWindow = Math.max(0, this.parryWindow - dt);
    } else {
      this.guarding = false;
      this.parryWindow = 0;
    }
    this.rmbDownPrev = input.guardDown;

    if (input.bash && this.targeOnArm && this.attackState === 'NONE' && !mount.mounted && player.stamina > 0.15) {
      this._startBash(player);
    }

    this._handlePrimaryInput(dt, input, player, mount, redcoats, rainIntensity);

    if (this.attackState !== 'NONE') {
      this._updateMeleeAttack(dt, player, mount, redcoats);
    }

    this._updateProjectiles(dt, player, mount, redcoats, onixField);
    return false;
  }

  _handlePrimaryInput(dt, input, player, mount, redcoats, rainIntensity) {
    const down = input.attackDown;

    if (this.weapon === 'bow') {
      if (down && this.arrowCount > 0 && this.attackState === 'NONE') {
        this.bowDrawing = true;
        this.bowDraw = clamp(this.bowDraw + dt * 1.15, 0, 1);
      } else if (!down && this.bowDrawing) {
        if (this.bowDraw > 0.28) this._fireBow(player, mount);
        this.bowDrawing = false;
        this.bowDraw = 0;
      } else if (down && !this.lmbDownPrev && this.arrowCount <= 0) {
        this.events.push({ type: 'notice', text: 'OUT OF ARROWS · RECOVER FROM BODIES OR GROUND', duration: 2.0 });
      }
      this.lmbDownPrev = down;
      return;
    }

    if (this.weapon === 'flintlock') {
      if (down && !this.lmbDownPrev && this.attackState === 'NONE') {
        this._fireFlintlock(player, mount, rainIntensity);
      }
      this.lmbDownPrev = down;
      return;
    }

    if (this.weapon === 'sword' || this.weapon === 'dirk') {
      if (down && !this.lmbDownPrev && this.weapon === 'dirk' && !mount.mounted && this.attackState === 'NONE') {
        const victim = redcoats.findStealthVictim(player.x, player.z, player.camYaw);
        if (victim) {
          this._executeStealthKill(player, victim, redcoats);
          this.lmbDownPrev = down;
          this.lmbHoldTime = 0;
          return;
        }
      }

      if (down && this.attackState === 'NONE' && player.stamina > 0.08) {
        this.lmbHoldTime += dt;
        if (this.lmbHoldTime >= 0.34) {
          this._startMeleeSwing(player, mount, input, true);
          this.lmbHoldTime = 0;
        }
      } else if (!down && this.lmbDownPrev && this.lmbHoldTime > 0 && this.attackState === 'NONE') {
        if (player.stamina > 0.08) {
          this._startMeleeSwing(player, mount, input, this.lmbHoldTime >= 0.22);
        }
        this.lmbHoldTime = 0;
      } else if (!down) {
        this.lmbHoldTime = 0;
      }
    }

    this.lmbDownPrev = down;
  }

  _startMeleeSwing(player, mount, input, heavy) {
    const isDirk = this.weapon === 'dirk';
    this.attackState = 'WINDUP';
    this.attackTimer = 0;
    this.attackHeavy = heavy;
    this.attackHitIds.clear();

    if (isDirk) {
      this.attackKind = heavy ? 'dirk_thrust' : 'dirk_slash';
      this.attackWindup = heavy ? 0.14 : 0.08;
      this.attackActiveEnd = heavy ? 0.28 : 0.20;
      this.attackDuration = heavy ? 0.44 : 0.32;
      player.stamina = clamp(player.stamina - (heavy ? 0.14 : 0.08), 0, 1);
    } else if (heavy) {
      this.attackKind = 'heavy_cleave';
      this.attackWindup = 0.20;
      this.attackActiveEnd = 0.36;
      this.attackDuration = 0.64;
      player.stamina = clamp(player.stamina - 0.22, 0, 1);
    } else {
      if (input.moveX < -0.2) this.attackKind = 'fast_left';
      else if (input.moveX > 0.2) this.attackKind = 'fast_right';
      else if (input.moveZ < -0.3) this.attackKind = 'thrust';
      else this.attackKind = Math.random() > 0.5 ? 'fast_left' : 'fast_right';

      this.attackWindup = 0.10;
      this.attackActiveEnd = 0.24;
      this.attackDuration = 0.44;
      player.stamina = clamp(player.stamina - 0.12, 0, 1);
    }

    if (!mount.mounted) {
      const fwdX = -Math.sin(player.camYaw);
      const fwdZ = -Math.cos(player.camYaw);
      const lunge = heavy ? 4.0 : 2.4;
      player.vx += fwdX * lunge;
      player.vz += fwdZ * lunge;
    }

    this.events.push({ type: 'swing', kind: this.attackKind, heavy });
  }

  _startBash(player) {
    this.attackState = 'BASH';
    this.attackKind = 'bash';
    this.attackTimer = 0;
    this.attackWindup = 0.09;
    this.attackActiveEnd = 0.24;
    this.attackDuration = 0.46;
    this.attackHeavy = false;
    this.attackHitIds.clear();
    player.stamina = clamp(player.stamina - 0.16, 0, 1);
    this.events.push({ type: 'swing', kind: 'bash', heavy: false });
  }

  _executeStealthKill(player, victim, redcoats) {
    this.attackState = 'STEALTH_KILL';
    this.attackKind = 'dirk_stealth';
    this.attackTimer = 0;
    this.attackDuration = 0.42;
    this.bladeBlood = clamp(this.bladeBlood + 0.55, 0, 1);
    this.hitStopTimer = 0.045;
    this.screenShake = 0.25;

    const dirX = -Math.sin(player.camYaw);
    const dirZ = -Math.cos(player.camYaw);
    const result = redcoats.applyDamage(victim, {
      damage: 2.0,
      heavy: false,
      dirX,
      dirY: 0.15,
      dirZ,
      source: 'dirk_stealth',
      momentum: 1.0
    });

    this.events.push({
      type: 'blood_hit',
      x: victim.x,
      y: victim.y + 1.38,
      z: victim.z,
      dirX,
      dirY: 0.15,
      dirZ,
      heavy: false,
      severPart: result.severPart,
      targetId: victim.id
    });
    this.events.push({ type: 'notice', text: 'SILENT DIRK TAKEDOWN · [HOLD E] TO HIDE BODY', duration: 2.6 });
  }

  _updateMeleeAttack(dt, player, mount, redcoats) {
    this.attackTimer += dt;

    if (this.attackState === 'STEALTH_KILL') {
      if (this.attackTimer >= this.attackDuration) this.attackState = 'NONE';
      return;
    }

    if (this.attackTimer < this.attackWindup) {
      if (this.attackState !== 'BASH') this.attackState = 'WINDUP';
      return;
    }

    if (this.attackTimer <= this.attackActiveEnd) {
      if (this.attackState !== 'BASH') this.attackState = 'ACTIVE';

      const isDirk = this.weapon === 'dirk';
      const reach = this.attackState === 'BASH' ? 2.2 : isDirk ? 2.15 : mount.mounted ? 3.85 : 3.05;
      // Always strike in the exact First-Person gaze direction (even off Bramble's left/right flank!)
      const fwdX = -Math.sin(player.camYaw);
      const fwdZ = -Math.cos(player.camYaw);
      const speedBonus = clamp((mount.mounted ? mount.speed : player.speed) / 8.0, 0, 1.5);

      for (const soldier of redcoats.soldiers) {
        if (soldier.dead || this.attackHitIds.has(soldier.id)) continue;
        const dx = soldier.x - player.x;
        const dz = soldier.z - player.z;
        const dist = Math.hypot(dx, dz);
        if (dist > reach) continue;

        const dot = (dx * fwdX + dz * fwdZ) / (dist || 1);
        const minDot = mount.mounted ? 0.20 : 0.42;
        if (dot < minDot) continue;

        this.attackHitIds.add(soldier.id);

        if (this.attackState === 'BASH') {
          soldier.staggerTimer = 2.0;
          soldier.aiState = 'STAGGERED';
          soldier.vx += fwdX * 6.5;
          soldier.vz += fwdZ * 6.5;
          this.hitStopTimer = 0.04;
          this.screenShake = 0.35;
          this.events.push({ type: 'targe_block', back: false, x: soldier.x, y: soldier.y + 1.3, z: soldier.z, isBall: false });
          continue;
        }

        const isRiposte = soldier.staggerTimer > 0.05;
        let dmg = isDirk ? (this.attackHeavy ? 0.55 : 0.34) : (this.attackHeavy ? 0.72 : 0.44);
        dmg *= this.bladeSharpness * (1 + speedBonus * 0.45);
        if (isRiposte) dmg *= 1.85;

        const res = redcoats.applyDamage(soldier, {
          damage: dmg,
          heavy: this.attackHeavy || isRiposte || (mount.mounted && mount.speed > 7.5),
          dirX: fwdX,
          dirY: this.attackKind === 'heavy_cleave' ? -0.25 : 0.2,
          dirZ: fwdZ,
          source: isDirk ? 'dirk' : 'sword',
          momentum: 1.0 + speedBonus
        });

        if (res.blocked) {
          this.hitStopTimer = 0.035;
          this.screenShake = 0.20;
          this.events.push({ type: 'parry', x: soldier.x, y: soldier.y + 1.35, z: soldier.z, dirX: fwdX, dirZ: fwdZ });
        } else {
          this.bladeBlood = clamp(this.bladeBlood + (res.severPart ? 0.55 : 0.24), 0, 1);
          this.hitStopTimer = res.severPart ? 0.075 : this.attackHeavy || isRiposte ? 0.05 : 0.028;
          this.screenShake = res.severPart ? 0.55 : this.attackHeavy ? 0.34 : 0.16;
          this.events.push({
            type: 'blood_hit',
            x: soldier.x,
            y: soldier.y + (res.severPart === 'head' ? 1.62 : 1.28),
            z: soldier.z,
            dirX: fwdX,
            dirY: 0.25,
            dirZ: fwdZ,
            heavy: this.attackHeavy || Boolean(res.severPart),
            severPart: res.severPart,
            targetId: soldier.id
          });
          if (res.severPart) {
            this.events.push({ type: 'notice', text: res.severPart === 'head' ? 'DECAPITATION' : 'LIMB SEVERED', duration: 1.6 });
          }
        }
      }
      return;
    }

    this.attackState = 'RECOVERY';
    if (this.attackTimer >= this.attackDuration) {
      this.attackState = 'NONE';
    }
  }

  _fireFlintlock(player, mount, rainIntensity) {
    if (this.flintlockReloadTimer > 0) return;
    if (!this.flintlockLoaded) {
      this.events.push({ type: 'misfire', x: player.x, y: this.getEyeHeight(player, mount) - 0.1, z: player.z, owner: 'player' });
      this.events.push({ type: 'notice', text: 'FLINTLOCK EMPTY · PRESS [R] TO RELOAD', duration: 1.8 });
      return;
    }

    const aim = this.getAimDir(player);
    const eyeY = this.getEyeHeight(player, mount);
    const muzzleX = player.x + aim.x * 0.55;
    const muzzleY = eyeY - 0.06 + aim.y * 0.55;
    const muzzleZ = player.z + aim.z * 0.55;

    const foulChance = clamp(rainIntensity * 0.42 + player.wetness * 0.32, 0, 0.68);
    if (Math.random() < foulChance) {
      this.flintlockLoaded = false;
      this.events.push({ type: 'misfire', x: muzzleX, y: muzzleY, z: muzzleZ, owner: 'player' });
      this.events.push({ type: 'notice', text: 'FLASH IN THE PAN! WET POWDER MISFIRE', duration: 2.4 });
      return;
    }

    this.flintlockLoaded = false;
    this.screenShake = 0.48;

    const speed = 105.0;
    this.projectiles.push({
      id: this.nextProjId++,
      kind: 'musket_ball',
      owner: 'player',
      x: muzzleX,
      y: muzzleY,
      z: muzzleZ,
      vx: aim.x * speed,
      vy: aim.y * speed,
      vz: aim.z * speed,
      damage: 0.98,
      age: 0,
      stuck: false
    });

    this.smokeZones.push({
      x: muzzleX + aim.x * 1.4,
      z: muzzleZ + aim.z * 1.4,
      radius: 2.5,
      age: 0,
      maxAge: 7.5
    });

    this.events.push({
      type: 'gunshot',
      x: muzzleX,
      y: muzzleY,
      z: muzzleZ,
      dirX: aim.x,
      dirY: aim.y,
      dirZ: aim.z,
      owner: 'player'
    });
  }

  _fireBow(player, mount) {
    if (this.arrowCount <= 0) return;
    this.arrowCount--;

    const aim = this.getAimDir(player);
    const eyeY = this.getEyeHeight(player, mount);
    const startX = player.x + aim.x * 0.50;
    const startY = eyeY - 0.05 + aim.y * 0.50;
    const startZ = player.z + aim.z * 0.50;
    const speed = lerp(26.0, 62.0, this.bowDraw);

    this.projectiles.push({
      id: this.nextProjId++,
      kind: 'arrow',
      owner: 'player',
      x: startX,
      y: startY,
      z: startZ,
      vx: aim.x * speed,
      vy: (aim.y + 0.025) * speed,
      vz: aim.z * speed,
      damage: lerp(0.45, 1.08, this.bowDraw),
      age: 0,
      stuck: false,
      recovered: false
    });

    this.events.push({ type: 'bow_release', x: startX, y: startY, z: startZ });
  }

  spawnEnemyMusketShot(soldier, targetX, targetY, targetZ, spread = 0.065) {
    const startX = soldier.x - Math.sin(soldier.yaw) * 0.7;
    const startY = soldier.y + 1.42;
    const startZ = soldier.z - Math.cos(soldier.yaw) * 0.7;

    let dx = targetX - startX;
    let dy = targetY - startY;
    let dz = targetZ - startZ;
    const len = Math.hypot(dx, dy, dz) || 1;
    dx = dx / len + (Math.random() - 0.5) * spread;
    dy = dy / len + (Math.random() - 0.5) * spread * 0.6;
    dz = dz / len + (Math.random() - 0.5) * spread;

    const speed = 88.0;
    this.projectiles.push({
      id: this.nextProjId++,
      kind: 'musket_ball',
      owner: 'enemy',
      x: startX,
      y: startY,
      z: startZ,
      vx: dx * speed,
      vy: dy * speed,
      vz: dz * speed,
      damage: 0.42,
      age: 0,
      stuck: false
    });

    this.smokeZones.push({
      x: startX + dx * 1.4,
      z: startZ + dz * 1.4,
      radius: 2.2,
      age: 0,
      maxAge: 6.5
    });

    this.events.push({
      type: 'gunshot',
      x: startX,
      y: startY,
      z: startZ,
      dirX: dx,
      dirY: dy,
      dirZ: dz,
      owner: 'enemy'
    });
  }

  receiveIncomingHit(player, mount, attacker, { damage, dirX, dirZ, isBall = false }) {
    if (this.health <= 0) return 'dead';

    const fwdX = -Math.sin(player.camYaw);
    const fwdZ = -Math.cos(player.camYaw);
    const incomingDot = dirX * fwdX + dirZ * fwdZ;
    const hitFromFront = incomingDot < 0.22;
    const hitFromBack = incomingDot > 0.32;

    if (!this.targeOnArm && hitFromBack) {
      this.screenShake = 0.52;
      this.hitStopTimer = 0.035;
      this.events.push({
        type: 'targe_block',
        back: true,
        x: player.x - fwdX * 0.35,
        y: this.getEyeHeight(player, mount) - 0.3,
        z: player.z - fwdZ * 0.35,
        isBall
      });
      this.events.push({
        type: 'notice',
        text: isBall ? 'BACK TARGE DEFLECTED MUSKET BALL!' : 'BACK TARGE BLOCKED REAR STRIKE!',
        duration: 2.0
      });
      return 'back_targe';
    }

    if (!isBall && this.guarding && this.parryWindow > 0 && hitFromFront) {
      this.hitStopTimer = 0.06;
      this.screenShake = 0.36;
      if (attacker) {
        attacker.staggerTimer = 2.2;
        attacker.aiState = 'STAGGERED';
        attacker.attackPhase = 'NONE';
      }
      this.events.push({
        type: 'parry',
        x: player.x + fwdX * 0.75,
        y: this.getEyeHeight(player, mount) - 0.15,
        z: player.z + fwdZ * 0.75,
        dirX: fwdX,
        dirZ: fwdZ
      });
      this.events.push({ type: 'notice', text: 'PERFECT PARRY! STRIKE NOW!', duration: 1.5 });
      return 'parry';
    }

    if (this.guarding && hitFromFront && (this.targeOnArm || !isBall)) {
      const stamCost = isBall ? 0.24 : 0.20;
      if (player.stamina >= stamCost * 0.5) {
        player.stamina = clamp(player.stamina - stamCost, 0, 1);
        this.screenShake = 0.26;
        this.hitStopTimer = 0.025;
        if (this.targeOnArm) {
          this.events.push({
            type: 'targe_block',
            back: false,
            x: player.x + fwdX * 0.55,
            y: this.getEyeHeight(player, mount) - 0.15,
            z: player.z + fwdZ * 0.55,
            isBall
          });
        } else {
          this.events.push({
            type: 'parry',
            x: player.x + fwdX * 0.65,
            y: this.getEyeHeight(player, mount) - 0.15,
            z: player.z + fwdZ * 0.65,
            dirX: fwdX,
            dirZ: fwdZ
          });
        }
        return 'blocked';
      }
    }

    this.health = clamp(this.health - damage, 0, 1);
    this.damageFlash = 0.92;
    this.screenShake = 0.55;
    this.events.push({ type: 'player_hurt', amount: damage, backBlocked: false });
    this.events.push({
      type: 'blood_hit',
      x: player.x,
      y: this.getEyeHeight(player, mount) - 0.3,
      z: player.z,
      dirX,
      dirY: 0.2,
      dirZ,
      heavy: isBall,
      severPart: null,
      targetId: 'player'
    });

    if (this.health <= 0) this.events.push({ type: 'player_died' });
    return 'hit';
  }

  _updateProjectiles(dt, player, mount, redcoats, onixField) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.age += dt;

      if (p.stuck) {
        if (p.kind === 'arrow' && !p.recovered && Math.hypot(p.x - player.x, p.z - player.z) < 2.2) {
          p.recovered = true;
          this.arrowCount++;
          this.projectiles.splice(i, 1);
          this.events.push({ type: 'notice', text: `RECOVERED ARROW (${this.arrowCount})`, duration: 1.2 });
          continue;
        }
        if (p.age > 45) this.projectiles.splice(i, 1);
        continue;
      }

      const gravity = p.kind === 'arrow' ? 14.5 : 5.5;
      if (p.kind === 'arrow') {
        const w = onixField.sampleWind(p.x, p.z);
        p.vx += w.x * 2.2 * dt;
        p.vz += w.z * 2.2 * dt;
      }
      p.vy -= gravity * dt;

      const prevX = p.x, prevZ = p.z;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;

      let hitSomething = false;
      if (p.owner === 'player') {
        for (const s of redcoats.soldiers) {
          if (s.dead) continue;
          if (Math.hypot(p.x - s.x, p.z - s.z) < 0.72 && p.y >= s.y && p.y <= s.y + 2.0) {
            const headshot = p.y > s.y + 1.48;
            const spd = Math.hypot(p.vx, p.vy, p.vz) || 1;
            const res = redcoats.applyDamage(s, {
              damage: headshot ? p.damage * 2.1 : p.damage,
              heavy: p.kind === 'musket_ball' || headshot,
              dirX: p.vx / spd,
              dirY: p.vy / spd,
              dirZ: p.vz / spd,
              source: p.kind,
              momentum: p.kind === 'musket_ball' ? 1.8 : 1.1,
              headshot
            });
            this.events.push({
              type: 'blood_hit',
              x: p.x,
              y: p.y,
              z: p.z,
              dirX: p.vx / spd,
              dirY: 0.2,
              dirZ: p.vz / spd,
              heavy: p.kind === 'musket_ball' || headshot,
              severPart: res.severPart,
              targetId: s.id
            });
            if (headshot) {
              this.events.push({ type: 'notice', text: p.kind === 'arrow' ? 'SILENT HEADSHOT' : 'FLINTLOCK HEADSHOT', duration: 1.8 });
            }
            if (p.kind === 'arrow') {
              p.stuck = true;
              p.vx = p.vy = p.vz = 0;
            } else {
              this.projectiles.splice(i, 1);
            }
            hitSomething = true;
            break;
          }
        }
      } else {
        const pyBase = mount.mounted ? mount.y + 0.9 : player.y;
        if (Math.hypot(p.x - player.x, p.z - player.z) < 0.72 && p.y >= pyBase && p.y <= pyBase + 1.95) {
          const spd = Math.hypot(p.vx, p.vy, p.vz) || 1;
          this.receiveIncomingHit(player, mount, null, {
            damage: p.damage,
            dirX: p.vx / spd,
            dirZ: p.vz / spd,
            isBall: true
          });
          this.projectiles.splice(i, 1);
          hitSomething = true;
        }
      }

      if (hitSomething) continue;

      const gy = heightAt(p.x, p.z);
      if (p.y <= gy) {
        p.x = lerp(prevX, p.x, 0.5);
        p.z = lerp(prevZ, p.z, 0.5);
        p.y = gy + 0.04;
        if (p.kind === 'arrow') {
          p.stuck = true;
          p.vx = p.vy = p.vz = 0;
        } else {
          this.projectiles.splice(i, 1);
        }
      } else if (p.age > 3.5) {
        this.projectiles.splice(i, 1);
      }
    }
  }

  syncToWorldState(worldState) {
    worldState.combat = {
      weapon: this.weapon,
      targeOnArm: this.targeOnArm,
      health: Number(this.health.toFixed(3)),
      bladeBlood: Number(this.bladeBlood.toFixed(3)),
      bladeSharpness: Number(this.bladeSharpness.toFixed(3)),
      flintlockLoaded: this.flintlockLoaded,
      powderCount: this.powderCount,
      arrowCount: this.arrowCount
    };
    worldState.player.scars = this.scars;
  }
}
