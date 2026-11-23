import { heightAt, roadCenterX, LANDMARKS, WATER_LEVEL } from '../world/terrain.js';
import { clamp, lerp, mulberry32 } from '../core/prng.js';

export class RedcoatManager {
  constructor(seed = 1744) {
    this.rng = mulberry32(seed + 4401);
    this.soldiers = [];
    this.events = [];
    this.spawnSquad();
  }

  consumeEvents() {
    if (this.events.length === 0) return [];
    const out = this.events;
    this.events = [];
    return out;
  }

  spawnSquad() {
    this.soldiers = [];
    const route = [
      { x: LANDMARKS.watchtower.x - 16, z: LANDMARKS.watchtower.z - 6 },
      { x: roadCenterX(-40), z: -40 },
      { x: roadCenterX(24), z: 24 },
      { x: roadCenterX(92), z: 92 },
      { x: roadCenterX(20) - 18, z: 20 },
      { x: LANDMARKS.watchtower.x - 14, z: LANDMARKS.watchtower.z + 12 }
    ];

    const roles = [
      { id: 'rc_corp', rank: 'CORPORAL', isOfficer: true, offset: { x: 0, z: 0 }, hp: 1.15 },
      { id: 'rc_pvt1', rank: 'PRIVATE', isOfficer: false, offset: { x: -2.4, z: 2.2 }, hp: 0.92 },
      { id: 'rc_pvt2', rank: 'PRIVATE', isOfficer: false, offset: { x: 2.4, z: 2.2 }, hp: 0.92 },
      { id: 'rc_pvt3', rank: 'PRIVATE', isOfficer: false, offset: { x: 0.0, z: 4.5 }, hp: 0.92 }
    ];

    const startX = roadCenterX(10);
    const startZ = 10;

    for (let i = 0; i < roles.length; i++) {
      const r = roles[i];
      const sx = startX + r.offset.x;
      const sz = startZ + r.offset.z;
      this.soldiers.push({
        id: r.id,
        rank: r.rank,
        isOfficer: r.isOfficer,
        x: sx,
        y: heightAt(sx, sz),
        z: sz,
        vx: 0,
        vz: 0,
        yaw: 0.3,
        speed: 0,
        stridePhase: i * 1.4,

        hp: r.hp,
        maxHp: r.hp,
        dead: false,
        deathTimer: 0,
        fallDirX: 0,
        fallDirZ: 1,
        hiddenInHeather: false,

        severed: { head: false, rightArm: false, leftArm: false },
        hatLost: false,
        robbed: false,
        looted: false,
        silver: r.isOfficer ? 9 : 4,
        powder: r.isOfficer ? 3 : 2,

        aiState: 'PATROL',
        awareness: 0,
        alertPos: { x: sx, z: sz },
        route,
        wpIndex: 2,
        formationOffset: r.offset,

        musketLoaded: true,
        reloadTimer: 0,
        aimTimer: 0,
        staggerTimer: 0,
        hitFlashTimer: 0,

        attackPhase: 'NONE',
        attackTimer: 0,
        attackDealt: false,
        meleeCooldown: 0.8 + i * 0.25,
        guarding: false,
        stateTimer: 0,
        flankSign: i % 2 === 0 ? 1 : -1
      });
    }
  }

  getById(id) {
    return this.soldiers.find((s) => s.id === id) || null;
  }

  isAnyCombatActive() {
    return this.soldiers.some(
      (s) => !s.dead && (s.aiState === 'AIM_MUSKET' || s.aiState === 'CHARGE' || s.aiState === 'MELEE' || s.aiState === 'RELOAD')
    );
  }

  notifyNoise(x, z, radius, loud = true) {
    for (const s of this.soldiers) {
      if (s.dead) continue;
      const d = Math.hypot(s.x - x, s.z - z);
      if (d < radius) {
        s.alertPos.x = x;
        s.alertPos.z = z;
        s.awareness = clamp(s.awareness + (loud ? 0.85 : 0.35), 0, 1);
        if (s.aiState === 'PATROL') {
          s.aiState = 'INVESTIGATE';
          s.stateTimer = 10.0;
          if (loud) this.events.push({ type: 'bark', kind: 'alert', dist: d });
        }
      }
    }
  }

  findStealthVictim(px, pz, playerYaw) {
    const pFwdX = -Math.sin(playerYaw);
    const pFwdZ = -Math.cos(playerYaw);
    for (const s of this.soldiers) {
      if (s.dead) continue;
      if (s.aiState !== 'PATROL' && s.aiState !== 'INVESTIGATE') continue;
      const dx = s.x - px;
      const dz = s.z - pz;
      const dist = Math.hypot(dx, dz);
      if (dist > 2.35) continue;

      const sFwdX = -Math.sin(s.yaw);
      const sFwdZ = -Math.cos(s.yaw);
      const behindDot = (dx * sFwdX + dz * sFwdZ) / (dist || 1);
      const facingDot = (dx * pFwdX + dz * pFwdZ) / (dist || 1);
      if (behindDot > 0.25 && facingDot > 0.45) {
        return s;
      }
    }
    return null;
  }

  findNearestCorpse(px, pz, maxDist = 2.6) {
    let best = null;
    let bestD = maxDist;
    for (const s of this.soldiers) {
      if (!s.dead) continue;
      const d = Math.hypot(s.x - px, s.z - pz);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  robSoldier(soldier, worldState, combat) {
    if (!soldier || soldier.dead || soldier.robbed) return null;
    soldier.robbed = true;
    const gainedSilver = soldier.silver;
    const gainedPowder = soldier.powder;
    soldier.silver = 0;
    soldier.powder = 0;
    worldState.player.silverShillings = (worldState.player.silverShillings || 0) + gainedSilver;
    combat.powderCount += gainedPowder;
    return { silver: gainedSilver, powder: gainedPowder };
  }

  lootCorpse(soldier, worldState, combat) {
    if (!soldier || !soldier.dead || soldier.looted) return null;
    soldier.looted = true;
    const gainedSilver = soldier.silver;
    const gainedPowder = soldier.powder;
    soldier.silver = 0;
    soldier.powder = 0;
    worldState.player.silverShillings = (worldState.player.silverShillings || 0) + gainedSilver;
    combat.powderCount += gainedPowder;
    return { silver: gainedSilver, powder: gainedPowder };
  }

  applyDamage(soldier, { damage, heavy, dirX, dirY, dirZ, source, momentum = 1.0, headshot = false }) {
    if (soldier.dead) return { blocked: false, killed: false, severPart: null };

    const sFwdX = -Math.sin(soldier.yaw);
    const sFwdZ = -Math.cos(soldier.yaw);
    const fromFront = (dirX * sFwdX + dirZ * sFwdZ) < -0.2;
    if (soldier.guarding && fromFront && !heavy && source === 'sword' && soldier.staggerTimer <= 0) {
      soldier.guarding = false;
      soldier.vx += dirX * 2.2;
      soldier.vz += dirZ * 2.2;
      return { blocked: true, killed: false, severPart: null };
    }

    soldier.hp -= damage;
    soldier.hitFlashTimer = 0.22;
    soldier.vx += dirX * (heavy ? 5.5 : 2.8) * momentum;
    soldier.vz += dirZ * (heavy ? 5.5 : 2.8) * momentum;

    if (source !== 'dirk_stealth') {
      this.notifyNoise(soldier.x, soldier.z, 34, source === 'musket_ball');
      soldier.aiState = 'MELEE';
      soldier.awareness = 1.0;
    }

    if (heavy && soldier.hp > 0) {
      soldier.staggerTimer = Math.max(soldier.staggerTimer, 0.85);
      soldier.attackPhase = 'NONE';
    }

    let severPart = null;
    if (soldier.hp <= 0) {
      soldier.dead = true;
      soldier.deathTimer = 0;
      soldier.fallDirX = dirX;
      soldier.fallDirZ = dirZ;
      soldier.attackPhase = 'NONE';
      soldier.hatLost = true;

      if (source === 'sword' && (heavy || momentum > 1.35)) {
        const roll = this.rng();
        if (headshot || roll < 0.48) {
          soldier.severed.head = true;
          severPart = 'head';
        } else if (roll < 0.80) {
          soldier.severed.rightArm = true;
          severPart = 'rightArm';
        } else {
          soldier.severed.leftArm = true;
          severPart = 'leftArm';
        }
      } else if (source === 'musket_ball' && headshot) {
        soldier.severed.head = true;
        severPart = 'head';
      }

      this.events.push({
        type: 'dismember',
        soldierId: soldier.id,
        part: severPart,
        hatLost: true,
        x: soldier.x,
        y: soldier.y,
        z: soldier.z,
        dirX,
        dirY: Math.max(0.25, dirY + 0.3),
        dirZ,
        isOfficer: soldier.isOfficer
      });

      if (soldier.isOfficer) {
        for (const mate of this.soldiers) {
          if (!mate.dead && this.rng() < 0.55) {
            mate.aiState = 'RETREAT';
            this.events.push({ type: 'bark', kind: 'retreat', dist: 12 });
          }
        }
      }

      return { blocked: false, killed: true, severPart };
    }

    return { blocked: false, killed: false, severPart: null };
  }

  update(dt, player, mount, combat, rainIntensity, colliders = null) {
    const stealth = combat.stealthFactor;
    const visionRange = lerp(52.0, 11.5, stealth);
    const playerEyeY = combat.getEyeHeight(player, mount) - 0.14;
    const livingLeader = this.soldiers.find((s) => !s.dead && s.isOfficer) || this.soldiers.find((s) => !s.dead);

    for (const s of this.soldiers) {
      if (s.hitFlashTimer > 0) s.hitFlashTimer = Math.max(0, s.hitFlashTimer - dt);

      if (s.dead) {
        s.deathTimer = Math.min(s.deathTimer + dt, 2.0);
        s.vx *= Math.exp(-7 * dt);
        s.vz *= Math.exp(-7 * dt);
        s.x += s.vx * dt;
        s.z += s.vz * dt;
        if (colliders) {
          const hit = colliders.resolveCircle(s.x, s.z, 0.45, s.y);
          if (hit.collided) { s.x = hit.x; s.z = hit.z; }
        }
        s.y = heightAt(s.x, s.z);
        continue;
      }

      if (s.meleeCooldown > 0) s.meleeCooldown = Math.max(0, s.meleeCooldown - dt);

      const dxP = player.x - s.x;
      const dzP = player.z - s.z;
      const distP = Math.hypot(dxP, dzP);
      const fwdX = -Math.sin(s.yaw);
      const fwdZ = -Math.cos(s.yaw);
      const dotToPlayer = (dxP * fwdX + dzP * fwdZ) / (distP || 1);

      let smokeBlocked = false;
      for (const sm of combat.smokeZones) {
        if (Math.hypot(s.x - sm.x, s.z - sm.z) < sm.radius + 3.0) {
          smokeBlocked = true;
          break;
        }
      }

      // True 3D Line-of-Sight check: stone cottages, dykes, boulders & thick pines hide Callum!
      const inCone = distP < visionRange && (dotToPlayer > 0.25 || distP < (player.crouchBlend > 0.5 ? 2.6 : 5.5));
      const hasLOS = inCone && !smokeBlocked && (!colliders || colliders.hasLineOfSight(s.x, s.y + 1.52, s.z, player.x, playerEyeY, player.z));
      const canSeePlayer = hasLOS && combat.health > 0;

      if (s.aiState === 'PATROL') {
        for (const other of this.soldiers) {
          if (other.dead && !other.hiddenInHeather && Math.hypot(other.x - s.x, other.z - s.z) < 16) {
            if (!colliders || colliders.hasLineOfSight(s.x, s.y + 1.5, s.z, other.x, other.y + 0.4, other.z)) {
              s.alertPos.x = other.x;
              s.alertPos.z = other.z;
              s.aiState = 'INVESTIGATE';
              s.stateTimer = 14.0;
              this.events.push({ type: 'bark', kind: 'alert', dist: distP });
              break;
            }
          }
        }
      }

      if (canSeePlayer) {
        const gain = distP < 12 ? 2.4 : lerp(1.3, 0.35, stealth);
        s.awareness = clamp(s.awareness + gain * dt, 0, 1);
        s.alertPos.x = player.x;
        s.alertPos.z = player.z;
        if (s.awareness >= 0.95 && (s.aiState === 'PATROL' || s.aiState === 'INVESTIGATE')) {
          s.aiState = s.musketLoaded && distP > 8.5 ? 'AIM_MUSKET' : 'CHARGE';
          s.aimTimer = 1.35 + this.rng() * 0.65;
          this.events.push({ type: 'bark', kind: 'spot', dist: distP });
          this.notifyNoise(player.x, player.z, 26, false);
        }
      } else {
        s.awareness = Math.max(0, s.awareness - dt * 0.14);
      }

      if (s.staggerTimer > 0) {
        s.staggerTimer -= dt;
        s.guarding = false;
        s.attackPhase = 'NONE';
        s.vx *= Math.exp(-6 * dt);
        s.vz *= Math.exp(-6 * dt);
        if (s.staggerTimer <= 0) {
          s.aiState = distP < 7 ? 'MELEE' : 'CHARGE';
        }
      } else if (s.aiState === 'PATROL') {
        this._stepPatrol(dt, s, livingLeader);
      } else if (s.aiState === 'INVESTIGATE') {
        this._stepInvestigate(dt, s);
      } else if (s.aiState === 'AIM_MUSKET') {
        this._stepAimMusket(dt, s, player, mount, combat, distP, dxP, dzP, rainIntensity, hasLOS);
      } else if (s.aiState === 'RELOAD') {
        this._stepReload(dt, s, distP);
      } else if (s.aiState === 'CHARGE') {
        this._stepCharge(dt, s, distP);
      } else if (s.aiState === 'MELEE') {
        this._stepMelee(dt, s, player, mount, combat, distP, dxP, dzP, hasLOS);
      } else if (s.aiState === 'RETREAT') {
        this._stepRetreat(dt, s);
      }

      // Move & resolve solid obstacles (with tangent flanking nudge so soldiers steer around corners)
      s.x += s.vx * dt;
      s.z += s.vz * dt;
      if (colliders) {
        const hit = colliders.resolveCircle(s.x, s.z, 0.45, s.y);
        if (hit.collided) {
          s.x = hit.x;
          s.z = hit.z;
          const inward = s.vx * hit.nx + s.vz * hit.nz;
          if (inward < 0) {
            s.vx -= inward * hit.nx;
            s.vz -= inward * hit.nz;
            // Slide briskly around wall edge rather than stalling head-on
            const tanX = -hit.nz * s.flankSign;
            const tanZ = hit.nx * s.flankSign;
            s.vx += tanX * 1.4;
            s.vz += tanZ * 1.4;
          }
        }
      }

      const gy = heightAt(s.x, s.z);
      if (gy < WATER_LEVEL - 0.5) {
        s.x -= s.vx * dt;
        s.z -= s.vz * dt;
        s.vx *= -0.3;
        s.vz *= -0.3;
      }
      s.y = heightAt(s.x, s.z);
      s.speed = Math.hypot(s.vx, s.vz);
      if (s.speed > 0.25) {
        s.stridePhase += s.speed * dt * 1.85;
      }
    }
  }

  _steerToward(dt, s, tx, tz, moveSpeed) {
    const dx = tx - s.x;
    const dz = tz - s.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.2) {
      s.vx = lerp(s.vx, 0, 1 - Math.exp(-8 * dt));
      s.vz = lerp(s.vz, 0, 1 - Math.exp(-8 * dt));
      return 0;
    }

    const desiredYaw = Math.atan2(-dx, -dz);
    let diff = desiredYaw - s.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    s.yaw += diff * (1 - Math.exp(-6.5 * dt));

    const nx = dx / dist;
    const nz = dz / dist;
    s.vx = lerp(s.vx, nx * moveSpeed, 1 - Math.exp(-6 * dt));
    s.vz = lerp(s.vz, nz * moveSpeed, 1 - Math.exp(-6 * dt));
    return dist;
  }

  _stepPatrol(dt, s, leader) {
    s.guarding = false;
    let tx, tz;
    if (!leader || s === leader) {
      const wp = s.route[s.wpIndex];
      tx = wp.x;
      tz = wp.z;
      if (Math.hypot(tx - s.x, tz - s.z) < 3.5) {
        s.wpIndex = (s.wpIndex + 1) % s.route.length;
      }
    } else {
      const cosY = Math.cos(leader.yaw);
      const sinY = Math.sin(leader.yaw);
      tx = leader.x + cosY * s.formationOffset.x + sinY * s.formationOffset.z;
      tz = leader.z - sinY * s.formationOffset.x + cosY * s.formationOffset.z;
    }
    this._steerToward(dt, s, tx, tz, 2.25);
  }

  _stepInvestigate(dt, s) {
    s.stateTimer -= dt;
    const dist = this._steerToward(dt, s, s.alertPos.x, s.alertPos.z, 3.0);
    if (dist < 2.2 || s.stateTimer <= 0) {
      s.vx *= 0.85;
      s.vz *= 0.85;
      if (s.stateTimer <= 0) s.aiState = 'PATROL';
    }
  }

  _stepAimMusket(dt, s, player, mount, combat, distP, dxP, dzP, rainIntensity, hasLOS) {
    s.vx = lerp(s.vx, 0, 1 - Math.exp(-8 * dt));
    s.vz = lerp(s.vz, 0, 1 - Math.exp(-8 * dt));
    const desiredYaw = Math.atan2(-dxP, -dzP);
    let diff = desiredYaw - s.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    s.yaw += diff * (1 - Math.exp(-7 * dt));

    // If Callum ducks behind a solid stone wall or closes in, stop shooting walls & advance!
    if (!hasLOS) {
      s.aiState = 'CHARGE';
      return;
    }
    if (distP < 6.5) {
      s.aiState = 'MELEE';
      return;
    }
    if (distP > 65 || combat.health <= 0) {
      s.aiState = 'PATROL';
      return;
    }

    s.aimTimer -= dt;
    if (s.aimTimer <= 0) {
      s.musketLoaded = false;
      if (Math.random() < rainIntensity * 0.45) {
        combat.events.push({ type: 'misfire', x: s.x, y: s.y + 1.4, z: s.z, owner: 'enemy' });
        s.aiState = 'CHARGE';
      } else {
        const targetY = mount.mounted ? mount.y + 1.95 : player.y + (player.crouchBlend > 0.5 ? 0.95 : 1.35);
        combat.spawnEnemyMusketShot(s, player.x, targetY, player.z, 0.075);
        s.aiState = distP < 18 ? 'CHARGE' : 'RELOAD';
        s.reloadTimer = 6.2;
      }
    }
  }

  _stepReload(dt, s, distP) {
    s.vx = lerp(s.vx, 0, 1 - Math.exp(-8 * dt));
    s.vz = lerp(s.vz, 0, 1 - Math.exp(-8 * dt));
    if (distP < 8.5) {
      s.aiState = 'CHARGE';
      return;
    }
    s.reloadTimer -= dt;
    if (s.reloadTimer <= 0) {
      s.musketLoaded = true;
      s.aiState = 'AIM_MUSKET';
      s.aimTimer = 1.4;
    }
  }

  _stepCharge(dt, s, distP) {
    if (distP > 65) {
      s.aiState = 'PATROL';
      return;
    }
    const dAlert = this._steerToward(dt, s, s.alertPos.x, s.alertPos.z, 4.9);
    if (distP < 3.0) {
      s.aiState = 'MELEE';
    } else if (dAlert < 1.8 && distP > 14) {
      s.aiState = 'INVESTIGATE';
      s.stateTimer = 7.0;
    }
  }

  _stepMelee(dt, s, player, mount, combat, distP, dxP, dzP, hasLOS) {
    if (combat.health <= 0 || distP > 55) {
      s.aiState = 'PATROL';
      s.attackPhase = 'NONE';
      return;
    }
    if (distP > 6.5 && s.attackPhase === 'NONE') {
      s.aiState = (s.musketLoaded && hasLOS) ? 'AIM_MUSKET' : 'CHARGE';
      s.aimTimer = 1.1;
      return;
    }

    const desiredYaw = Math.atan2(-dxP, -dzP);
    let diff = desiredYaw - s.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    s.yaw += diff * (1 - Math.exp(-9 * dt));

    if (s.attackPhase === 'NONE') {
      s.guarding = distP < 3.4;
      if (distP > 2.35) {
        this._steerToward(dt, s, player.x, player.z, 3.6);
      } else {
        s.vx = lerp(s.vx, 0, 1 - Math.exp(-7 * dt));
        s.vz = lerp(s.vz, 0, 1 - Math.exp(-7 * dt));
        if (s.meleeCooldown <= 0) {
          s.attackPhase = 'WINDUP';
          s.attackTimer = 0;
          s.attackDealt = false;
          s.guarding = false;
        }
      }
      return;
    }

    s.attackTimer += dt;
    if (s.attackPhase === 'WINDUP') {
      s.vx *= 0.85;
      s.vz *= 0.85;
      if (s.attackTimer >= 0.48) {
        s.attackPhase = 'STRIKE';
        s.attackTimer = 0;
        const fwdX = -Math.sin(s.yaw);
        const fwdZ = -Math.cos(s.yaw);
        s.vx = fwdX * 5.4;
        s.vz = fwdZ * 5.4;
      }
    } else if (s.attackPhase === 'STRIKE') {
      if (!s.attackDealt && s.attackTimer >= 0.06 && distP < 2.65) {
        s.attackDealt = true;
        const inv = 1 / (distP || 1);
        combat.receiveIncomingHit(player, mount, s, {
          damage: s.isOfficer ? 0.34 : 0.28,
          dirX: dxP * inv,
          dirZ: dzP * inv,
          isBall: false
        });
      }
      if (s.attackTimer >= 0.22) {
        s.attackPhase = 'RECOVER';
        s.attackTimer = 0;
      }
    } else if (s.attackPhase === 'RECOVER') {
      s.vx *= Math.exp(-8 * dt);
      s.vz *= Math.exp(-8 * dt);
      if (s.attackTimer >= 0.55) {
        s.attackPhase = 'NONE';
        s.meleeCooldown = 0.85 + this.rng() * 0.75;
      }
    }
  }

  _stepRetreat(dt, s) {
    const dist = this._steerToward(dt, s, LANDMARKS.watchtower.x, LANDMARKS.watchtower.z, 5.1);
    if (dist < 10) {
      s.aiState = 'PATROL';
      s.musketLoaded = true;
    }
  }
}
