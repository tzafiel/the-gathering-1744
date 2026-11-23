import { heightAt, normalAt, surfaceAt, WATER_LEVEL } from '../world/terrain.js';
import { clamp, lerp, mulberry32 } from '../core/prng.js';

// Bramble — Callum's single lifelong Highland Garron.
// Heavy, grounded horseback inertia, 4 real gaits (Walk/Trot/Canter/Gallop),
// autonomous grazing & whistle recall, and persistent bond/care state for 1747 carryover.

export class MountController {
  constructor(worldState) {
    const m = worldState.mount || {};
    this.name = m.name || 'Bramble';
    this.coatSeed = m.coatSeed ?? 407;
    this.scars = Array.isArray(m.scars) ? [...m.scars] : [];

    this.x = typeof m.x === 'number' ? m.x : 26;
    this.z = typeof m.z === 'number' ? m.z : 26;
    this.y = heightAt(this.x, this.z);

    this.vx = 0;
    this.vz = 0;
    this.vy = 0;
    this.speed = 0;
    this.yaw = typeof m.yaw === 'number' ? m.yaw : 0.7;
    this.pitch = 0; // Terrain slope pitch
    this.roll = 0;  // Subtle bank into turns + slope roll

    this.grounded = true;
    this.mounted = false;

    // Persistent bond & condition metrics
    this.bond = clamp(m.bond ?? 0.55, 0, 1);
    this.stamina = clamp(m.stamina ?? 1.0, 0, 1);
    this.calm = clamp(m.calm ?? 0.92, 0, 1);
    this.wetness = clamp(m.wetness ?? 0.0, 0, 1);

    // Gait & animation state
    this.gait = 'IDLE'; // IDLE | WALK | TROT | CANTER | GALLOP | BACKING
    this.stridePhase = 0;
    this.lastStepSlot = 0;
    this.grazeBlend = 0;
    this.careTimer = 0;
    this.rearTimer = 0;
    this.surface = surfaceAt(this.x, this.z);

    // Autonomous AI when Callum is on foot
    this.aiState = 'GRAZING'; // IDLE | GRAZING | WANDERING | CALLED
    this.aiTimer = 3.5;
    this.targetX = this.x;
    this.targetZ = this.z;
    this.rng = mulberry32(this.coatSeed + 911);

    // One-frame event queues consumed by AudioEngine & HUD
    this.events = [];
  }

  consumeEvents() {
    if (this.events.length === 0) return [];
    const out = this.events;
    this.events = [];
    return out;
  }

  // Callum whistles from across the glen — Bramble answers and trots/canters straight over
  callTo(px, pz) {
    if (this.mounted) return false;
    const dist = Math.hypot(px - this.x, pz - this.z);

    // If Callum wandered > 240m away across the highlands, bring Bramble onto a nearby ridge approach
    if (dist > 240) {
      const ang = this.rng() * Math.PI * 2;
      const rx = px + Math.cos(ang) * 58;
      const rz = pz + Math.sin(ang) * 58;
      if (heightAt(rx, rz) > WATER_LEVEL + 1.0) {
        this.x = rx;
        this.z = rz;
        this.y = heightAt(rx, rz);
      }
    }

    this.aiState = 'CALLED';
    this.targetX = px;
    this.targetZ = pz;
    this.aiTimer = 24.0;
    this.events.push({ type: 'vocal', kind: 'whinny', dist: Math.min(dist, 90) });
    return true;
  }

  // Brush, calm, or feed oats — builds permanent bond & restores calm/stamina
  tendMount() {
    if (this.careTimer > 0) return false;
    this.careTimer = 2.0;
    this.bond = clamp(this.bond + 0.035, 0, 1);
    this.calm = clamp(this.calm + 0.25, 0, 1);
    this.stamina = clamp(this.stamina + 0.18, 0, 1);
    this.events.push({ type: 'vocal', kind: 'nicker', dist: 1.5 });
    return true;
  }

  distanceTo(px, pz) {
    return Math.hypot(px - this.x, pz - this.z);
  }

  update(dt, input, player, rainIntensity = 0) {
    if (this.careTimer > 0) this.careTimer = Math.max(0, this.careTimer - dt);
    if (this.rearTimer > 0) this.rearTimer = Math.max(0, this.rearTimer - dt);

    this.surface = surfaceAt(this.x, this.z);
    const n = normalAt(this.x, this.z, 1.1);
    const slope = 1 - n.y;

    if (this.mounted) {
      this._updateMounted(dt, input, player, n, slope, rainIntensity);
    } else {
      this._updateAutonomous(dt, player, n, slope, rainIntensity);
    }

    // Wetness from rain, wading in Loch Linnhe, or bog mud
    if (this.y < WATER_LEVEL + 0.15) {
      this.wetness = clamp(this.wetness + 0.35 * dt, 0, 1);
    } else if (rainIntensity > 0.1) {
      this.wetness = clamp(this.wetness + 0.045 * rainIntensity * dt, 0, 1);
    } else {
      this.wetness = clamp(this.wetness - 0.018 * dt, 0, 1);
    }

    // Align horse body pitch & roll smoothly to Highland terrain slope + turn banking
    const fwdX = -Math.sin(this.yaw);
    const fwdZ = -Math.cos(this.yaw);
    const rgtX = Math.cos(this.yaw);
    const rgtZ = -Math.sin(this.yaw);

    const hFront = heightAt(this.x + fwdX * 1.1, this.z + fwdZ * 1.1);
    const hBack = heightAt(this.x - fwdX * 1.1, this.z - fwdZ * 1.1);
    const targetPitch = clamp(Math.atan2(hFront - hBack, 2.2), -0.42, 0.42);

    const hRight = heightAt(this.x + rgtX * 0.65, this.z + rgtZ * 0.65);
    const hLeft = heightAt(this.x - rgtX * 0.65, this.z - rgtZ * 0.65);
    const slopeRoll = clamp(Math.atan2(hLeft - hRight, 1.3), -0.25, 0.25);

    const steerBank = this.mounted ? clamp(-input.moveX * (this.speed / 15) * 0.16, -0.18, 0.18) : 0;
    this.pitch = lerp(this.pitch, targetPitch, 1 - Math.exp(-8.5 * dt));
    this.roll = lerp(this.roll, slopeRoll + steerBank, 1 - Math.exp(-8.0 * dt));

    // Stride cadence & synced 4-beat / 3-beat hoofbeat audio triggers
    if (this.speed > 0.35 && this.grounded) {
      const freqMult =
        this.gait === 'GALLOP' ? 1.18 :
        this.gait === 'CANTER' ? 1.32 :
        this.gait === 'TROT' ? 1.55 : 1.85;
      this.stridePhase += this.speed * dt * freqMult;

      // Trigger crisp rhythmic hoofbeats on quarter-cycles (walk/trot) or galloping triplets
      const stepsPerCycle = this.gait === 'GALLOP' || this.gait === 'CANTER' ? 3 : 4;
      const slot = Math.floor((this.stridePhase / (Math.PI * 2)) * stepsPerCycle);
      if (slot !== this.lastStepSlot) {
        this.lastStepSlot = slot;
        const intensity = clamp(this.speed / 13.5, 0.28, 1.0);
        this.events.push({
          type: 'hoof',
          surfaceId: this.surface.id,
          intensity,
          dist: this.mounted ? 0 : this.distanceTo(player.x, player.z)
        });
      }
    }
  }

  _updateMounted(dt, input, player, n, slope, rainIntensity) {
    this.grazeBlend = lerp(this.grazeBlend, 0, 1 - Math.exp(-8 * dt));

    // Camera orbit belongs to Callum's eyes even while riding
    player.camYaw -= input.lookX;
    player.camPitch = clamp(player.camPitch + input.lookY, -0.32, 0.95);
    if (input.zoomDelta !== 0) {
      player.camDistance = clamp(player.camDistance + input.zoomDelta * 0.45, 4.2, 10.5);
    }

    const forwardInput = -input.moveZ; // W / Stick Up > 0
    const steerInput = input.moveX;    // A < 0, D > 0

    // Heavy Highland Garron steering: agile at a walk, sweeping momentum arc at a gallop
    const speedRatio = clamp(this.speed / 14.0, 0, 1);
    const turnRate = lerp(2.15, 1.05, speedRatio) * (this.surface.id === 'peat_bog' ? 0.78 : 1.0);

    // Camera-assisted steering when moving forward, direct rein steering when turning
    if (Math.abs(steerInput) > 0.05) {
      this.yaw -= steerInput * turnRate * dt;
    } else if (forwardInput > 0.25 && this.speed > 1.2) {
      // Gently align horse toward camera look direction when holding straight forward
      let diff = player.camYaw - this.yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      if (Math.abs(diff) < 1.15) {
        this.yaw += diff * 0.85 * dt;
      }
    }

    // Target speed & 4-gait progression (Walk -> Trot -> Canter -> Gallop)
    const inWater = this.surface.id === 'water';
    const canGallop = input.sprint && this.stamina > 0.08 && !inWater;
    let targetSpeed = 0;

    if (forwardInput > 0.08) {
      if (canGallop) {
        targetSpeed = 14.2 * (0.94 + this.bond * 0.10); // Sturdy Highland Garron full gallop
      } else if (forwardInput > 0.65) {
        targetSpeed = 8.4; // Brisk Highlands trot / light canter
      } else {
        targetSpeed = 3.8 * forwardInput / 0.65; // Unhurried frontier walk
      }
    } else if (forwardInput < -0.15) {
      if (this.speed > 1.0) {
        // Hard rein brake
        targetSpeed = 0;
      } else {
        targetSpeed = -1.6; // Careful step backward
      }
    }

    // Terrain & uphill weight (Highland Garrons are sure-footed on crags, slowed by deep peat & water)
    const fwdX = -Math.sin(this.yaw);
    const fwdZ = -Math.cos(this.yaw);
    const uphillDot = -(fwdX * n.x + fwdZ * n.z);
    const uphillMult = uphillDot > 0 ? 1 - clamp(uphillDot * 0.95, 0, 0.48) : 1.0;
    const terrainMult =
      this.surface.id === 'mud_road' ? 1.08 :
      this.surface.id === 'peat_bog' ? 0.62 :
      this.surface.id === 'water' ? 0.48 :
      this.surface.id === 'granite' ? 0.82 : 1.0;

    const desiredSignedSpeed = targetSpeed * terrainMult * uphillMult;
    const isBraking = forwardInput < -0.15 && this.speed > 1.0;
    const accelRate = isBraking ? 6.8 : desiredSignedSpeed > this.speed ? 2.8 : 2.2;
    const signedSpeed = lerp(this.vx * fwdX + this.vz * fwdZ, desiredSignedSpeed, 1 - Math.exp(-accelRate * dt));

    // Preserve subtle lateral drift/inertia on wet mud & steep slopes
    const grip = clamp(this.surface.traction * (1 - rainIntensity * 0.22), 0.35, 0.98);
    const blend = 1 - Math.exp(-6.5 * grip * dt);
    this.vx = lerp(this.vx, fwdX * signedSpeed, blend);
    this.vz = lerp(this.vz, fwdZ * signedSpeed, blend);

    // Jump over dry-stone dykes & boulders
    if (input.jump && this.grounded && this.stamina > 0.16 && !inWater) {
      this.vy = 6.6;
      this.grounded = false;
      this.stamina = clamp(this.stamina - 0.14, 0, 1);
      this.events.push({ type: 'vocal', kind: 'snort', dist: 0 });
    }

    this._integratePhysics(dt);

    // Classify live gait for animation & HUD
    this.speed = Math.hypot(this.vx, this.vz);
    if (signedSpeed < -0.25) {
      this.gait = 'BACKING';
    } else if (this.speed < 0.4) {
      this.gait = 'IDLE';
    } else if (this.speed < 4.6) {
      this.gait = 'WALK';
    } else if (this.speed < 9.0) {
      this.gait = 'TROT';
    } else if (this.speed < 11.8) {
      this.gait = 'CANTER';
    } else {
      this.gait = 'GALLOP';
    }

    // Stamina & passive bond growth while riding together
    if (this.gait === 'GALLOP') {
      const bondEfficiency = lerp(1.0, 0.65, this.bond);
      const drain = (0.11 + slope * 0.32 + (this.surface.id === 'peat_bog' ? 0.10 : 0)) * bondEfficiency;
      this.stamina = clamp(this.stamina - drain * dt, 0, 1);
    } else if (this.gait === 'CANTER') {
      this.stamina = clamp(this.stamina - 0.025 * dt, 0, 1);
    } else {
      const regen = this.gait === 'IDLE' ? 0.20 : 0.09;
      this.stamina = clamp(this.stamina + regen * dt, 0, 1);
    }

    if (this.speed > 1.5) {
      this.bond = clamp(this.bond + 0.0008 * dt, 0, 1);
    }

    // Seat Callum cleanly in Bramble's saddle
    player.x = this.x;
    player.y = this.y + 1.08;
    player.z = this.z;
    player.vx = this.vx;
    player.vz = this.vz;
    player.speed = this.speed;
    player.facingYaw = this.yaw;
    player.crouchBlend = 0;
    player.surface = this.surface;
    player.stance = `RIDING · ${this.gait}`;
    player.stamina = clamp(player.stamina + 0.18 * dt, 0, 1);
  }

  _updateAutonomous(dt, player, n, slope, rainIntensity) {
    this.aiTimer -= dt;
    let targetSpeed = 0;

    if (this.aiState === 'CALLED') {
      this.targetX = player.x;
      this.targetZ = player.z;
      const dx = this.targetX - this.x;
      const dz = this.targetZ - this.z;
      const dist = Math.hypot(dx, dz);

      if (dist < 3.1 || this.aiTimer <= 0) {
        this.aiState = 'IDLE';
        this.aiTimer = 4.0 + this.rng() * 4.0;
        this.events.push({ type: 'vocal', kind: 'nicker', dist });
      } else {
        const desiredYaw = Math.atan2(-dx, -dz);
        let diff = desiredYaw - this.yaw;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        this.yaw += diff * (1 - Math.exp(-4.2 * dt));
        targetSpeed = dist > 18 ? 10.2 : dist > 7 ? 6.2 : 3.2;
      }
    } else if (this.aiState === 'WANDERING') {
      const dx = this.targetX - this.x;
      const dz = this.targetZ - this.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 1.4 || this.aiTimer <= 0) {
        this.aiState = 'GRAZING';
        this.aiTimer = 5.5 + this.rng() * 7.5;
      } else {
        const desiredYaw = Math.atan2(-dx, -dz);
        let diff = desiredYaw - this.yaw;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        this.yaw += diff * (1 - Math.exp(-2.6 * dt));
        targetSpeed = 1.9;
      }
    } else if (this.aiTimer <= 0) {
      // Alternate naturally between grazing heather/grass and meandering a few paces
      if (this.aiState === 'GRAZING' && this.rng() > 0.35) {
        const ang = this.rng() * Math.PI * 2;
        const r = 4.5 + this.rng() * 9.0;
        const tx = this.x + Math.cos(ang) * r;
        const tz = this.z + Math.sin(ang) * r;
        if (heightAt(tx, tz) > WATER_LEVEL + 1.2) {
          this.targetX = tx;
          this.targetZ = tz;
          this.aiState = 'WANDERING';
          this.aiTimer = 6.0 + this.rng() * 5.0;
        } else {
          this.aiTimer = 4.0;
        }
      } else {
        this.aiState = this.rng() > 0.25 ? 'GRAZING' : 'IDLE';
        this.aiTimer = 5.0 + this.rng() * 8.0;
      }
    }

    const fwdX = -Math.sin(this.yaw);
    const fwdZ = -Math.cos(this.yaw);
    const blend = 1 - Math.exp(-4.0 * dt);
    this.vx = lerp(this.vx, fwdX * targetSpeed, blend);
    this.vz = lerp(this.vz, fwdZ * targetSpeed, blend);

    this._integratePhysics(dt);

    this.speed = Math.hypot(this.vx, this.vz);
    this.gait =
      this.speed < 0.35 ? 'IDLE' :
      this.speed < 4.2 ? 'WALK' :
      this.speed < 8.5 ? 'TROT' : 'CANTER';

    const wantGraze = this.aiState === 'GRAZING' && this.speed < 0.35 && this.careTimer <= 0;
    this.grazeBlend = lerp(this.grazeBlend, wantGraze ? 1 : 0, 1 - Math.exp(-3.2 * dt));
    this.stamina = clamp(this.stamina + 0.16 * dt, 0, 1);
  }

  _integratePhysics(dt) {
    this.vy -= 17.5 * dt;
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    this.y += this.vy * dt;

    // Prevent horse from plunging past chest-deep sea-loch water
    const nextGroundY = heightAt(this.x, this.z);
    if (nextGroundY < WATER_LEVEL - 0.95) {
      this.x -= this.vx * dt;
      this.z -= this.vz * dt;
      this.vx *= 0.15;
      this.vz *= 0.15;
    }

    const finalGroundY = heightAt(this.x, this.z);
    if (this.y <= finalGroundY) {
      this.y = finalGroundY;
      this.vy = 0;
      this.grounded = true;
    } else if (this.grounded && this.y - finalGroundY < 0.75) {
      this.y = finalGroundY;
      this.vy = 0;
    } else {
      this.grounded = false;
    }
  }

  syncToWorldState(worldState) {
    worldState.mount = {
      name: this.name,
      breed: 'Highland Garron',
      coatSeed: this.coatSeed,
      bond: Number(this.bond.toFixed(3)),
      stamina: Number(this.stamina.toFixed(3)),
      calm: Number(this.calm.toFixed(3)),
      scars: this.scars,
      x: Number(this.x.toFixed(2)),
      z: Number(this.z.toFixed(2)),
      yaw: Number(this.yaw.toFixed(3))
    };
  }
}
