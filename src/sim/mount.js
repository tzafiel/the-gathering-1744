import { heightAt, normalAt, surfaceAt, WATER_LEVEL } from '../world/terrain.js';
import { clamp, lerp, mulberry32 } from '../core/prng.js';

export class MountController {
  constructor(worldState) {
    const m = worldState.mount || {};
    this.name = m.name || 'Bramble';
    this.coatSeed = m.coatSeed ?? 407;
    this.scars = Array.isArray(m.scars) ? [...m.scars] : [];

    this.x = typeof m.x === 'number' ? m.x : 29;
    this.z = typeof m.z === 'number' ? m.z : 28;
    this.y = heightAt(this.x, this.z);

    this.vx = 0;
    this.vz = 0;
    this.vy = 0;
    this.speed = 0;
    this.yaw = typeof m.yaw === 'number' ? m.yaw : 0.65;
    this.pitch = 0;
    this.roll = 0;

    this.grounded = true;
    this.mounted = false;

    this.bond = clamp(m.bond ?? 0.55, 0, 1);
    this.stamina = clamp(m.stamina ?? 1.0, 0, 1);
    this.calm = clamp(m.calm ?? 0.92, 0, 1);
    this.wetness = clamp(m.wetness ?? 0.0, 0, 1);

    this.gait = 'IDLE';
    this.stridePhase = 0;
    this.lastStepSlot = 0;
    this.grazeBlend = 0;
    this.careTimer = 0;
    this.rearTimer = 0;
    this.surface = surfaceAt(this.x, this.z);

    this.aiState = 'GRAZING';
    this.aiTimer = 3.5;
    this.targetX = this.x;
    this.targetZ = this.z;
    this.rng = mulberry32(this.coatSeed + 911);

    this.events = [];
  }

  consumeEvents() {
    if (this.events.length === 0) return [];
    const out = this.events;
    this.events = [];
    return out;
  }

  callTo(px, pz) {
    if (this.mounted) return false;
    const dist = Math.hypot(px - this.x, pz - this.z);

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

    if (this.y < WATER_LEVEL + 0.15) {
      this.wetness = clamp(this.wetness + 0.35 * dt, 0, 1);
    } else if (rainIntensity > 0.1) {
      this.wetness = clamp(this.wetness + 0.045 * rainIntensity * dt, 0, 1);
    } else {
      this.wetness = clamp(this.wetness - 0.018 * dt, 0, 1);
    }

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

    if (this.speed > 0.35 && this.grounded) {
      const freqMult =
        this.gait === 'GALLOP' ? 1.18 :
        this.gait === 'CANTER' ? 1.32 :
        this.gait === 'TROT' ? 1.55 : 1.85;
      this.stridePhase += this.speed * dt * freqMult;

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

    // Free First-Person head look from Bramble's saddle (independent of horse heading!)
    player.camYaw -= input.lookX;
    player.camPitch = clamp(player.camPitch + input.lookY, -1.15, 1.15);

    const forwardInput = -input.moveZ;
    const steerInput = input.moveX;

    const speedRatio = clamp(this.speed / 14.0, 0, 1);
    const turnRate = lerp(2.15, 1.05, speedRatio) * (this.surface.id === 'peat_bog' ? 0.78 : 1.0);

    // Direct rein steering with A/D; subtle gaze guidance only when looking forward & not aiming sideways
    if (Math.abs(steerInput) > 0.05) {
      const yawDelta = -steerInput * turnRate * dt;
      this.yaw += yawDelta;
      player.camYaw += yawDelta; // Rider's torso turns naturally with Bramble's shoulders
    } else if (forwardInput > 0.25 && this.speed > 1.2) {
      let diff = player.camYaw - this.yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      if (Math.abs(diff) < 0.62) {
        this.yaw += diff * 0.72 * dt;
      }
    }

    const inWater = this.surface.id === 'water';
    const canGallop = input.sprint && this.stamina > 0.08 && !inWater;
    let targetSpeed = 0;

    if (forwardInput > 0.08) {
      if (canGallop) targetSpeed = 14.2 * (0.94 + this.bond * 0.10);
      else if (forwardInput > 0.65) targetSpeed = 8.4;
      else targetSpeed = 3.8 * (forwardInput / 0.65);
    } else if (forwardInput < -0.15) {
      targetSpeed = this.speed > 1.0 ? 0 : -1.6;
    }

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

    const grip = clamp(this.surface.traction * (1 - rainIntensity * 0.22), 0.35, 0.98);
    const blend = 1 - Math.exp(-6.5 * grip * dt);
    this.vx = lerp(this.vx, fwdX * signedSpeed, blend);
    this.vz = lerp(this.vz, fwdZ * signedSpeed, blend);

    if (input.jump && this.grounded && this.stamina > 0.16 && !inWater) {
      this.vy = 6.6;
      this.grounded = false;
      this.stamina = clamp(this.stamina - 0.14, 0, 1);
      this.events.push({ type: 'vocal', kind: 'snort', dist: 0 });
    }

    this._integratePhysics(dt);

    this.speed = Math.hypot(this.vx, this.vz);
    if (signedSpeed < -0.25) this.gait = 'BACKING';
    else if (this.speed < 0.4) this.gait = 'IDLE';
    else if (this.speed < 4.6) this.gait = 'WALK';
    else if (this.speed < 9.0) this.gait = 'TROT';
    else if (this.speed < 11.8) this.gait = 'CANTER';
    else this.gait = 'GALLOP';

    if (this.gait === 'GALLOP') {
      const bondEfficiency = lerp(1.0, 0.65, this.bond);
      const drain = (0.11 + slope * 0.32 + (this.surface.id === 'peat_bog' ? 0.10 : 0)) * bondEfficiency;
      this.stamina = clamp(this.stamina - drain * dt, 0, 1);
    } else if (this.gait === 'CANTER') {
      this.stamina = clamp(this.stamina - 0.025 * dt, 0, 1);
    } else {
      this.stamina = clamp(this.stamina + (this.gait === 'IDLE' ? 0.20 : 0.09) * dt, 0, 1);
    }

    if (this.speed > 1.5) this.bond = clamp(this.bond + 0.0008 * dt, 0, 1);

    // Sync Callum's position to saddle while keeping facingYaw aligned with his First-Person eyes
    player.x = this.x;
    player.y = this.y + 1.08;
    player.z = this.z;
    player.vx = this.vx;
    player.vz = this.vz;
    player.speed = this.speed;
    player.facingYaw = player.camYaw;
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
