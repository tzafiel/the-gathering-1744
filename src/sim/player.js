import { heightAt, normalAt, surfaceAt, WATER_LEVEL } from '../world/terrain.js';
import { clamp, lerp } from '../core/prng.js';

export class PlayerController {
  constructor(worldState) {
    const p = worldState.player;
    this.x = p.x;
    this.y = heightAt(p.x, p.z);
    this.z = p.z;
    this.vx = 0;
    this.vy = 0;
    this.vz = 0;

    this.facingYaw = p.yaw ?? 0;
    this.camYaw = this.facingYaw;
    this.camPitch = 0.24;
    this.camDistance = 5.4;

    this.grounded = true;
    this.stamina = p.stamina ?? 1.0;
    this.wetness = p.wetness ?? 0.0;
    this.crouchBlend = 0;
    this.stridePhase = 0;
    this.speed = 0;
    this.stance = 'STANDING';
    this.surface = surfaceAt(this.x, this.z);
  }

  update(dt, input) {
    // Camera orbit
    this.camYaw -= input.lookX;
    this.camPitch = clamp(this.camPitch + input.lookY, -0.35, 1.05);
    if (input.zoomDelta !== 0) {
      this.camDistance = clamp(this.camDistance + input.zoomDelta * 0.45, 3.2, 9.0);
    }

    // Surface & slope queries
    this.surface = surfaceAt(this.x, this.z);
    const groundY = heightAt(this.x, this.z);
    const n = normalAt(this.x, this.z, 0.7);
    const slope = 1 - n.y;

    // Camera-relative movement direction
    const forwardX = -Math.sin(this.camYaw);
    const forwardZ = -Math.cos(this.camYaw);
    const rightX = Math.cos(this.camYaw);
    const rightZ = -Math.sin(this.camYaw);

    const wishX = rightX * input.moveX - forwardX * input.moveZ;
    const wishZ = rightZ * input.moveX - forwardZ * input.moveZ;
    const wishMag = Math.hypot(wishX, wishZ);
    const dirX = wishMag > 0.001 ? wishX / wishMag : 0;
    const dirZ = wishMag > 0.001 ? wishZ / wishMag : 0;

    // Stance & stamina economics (RDR2-style weight, zero arcade zoom)
    const canSprint = input.sprint && !input.crouch && wishMag > 0.25 && this.stamina > 0.06 && this.surface.id !== 'water';
    let baseSpeed = 4.3; // brisk Highland stride
    if (input.crouch) {
      baseSpeed = 2.15;
      this.stance = wishMag > 0.1 ? 'STALKING' : 'CROUCHED';
    } else if (canSprint) {
      baseSpeed = 7.4;
      this.stance = 'SPRINTING';
    } else if (wishMag > 0.1) {
      this.stance = 'WALKING';
    } else {
      this.stance = 'STANDING';
    }

    // Uphill drag & terrain speed multipliers
    const moveDotSlope = -(dirX * n.x + dirZ * n.z); // > 0 when climbing uphill
    const uphillPenalty = moveDotSlope > 0 ? 1 - clamp(moveDotSlope * 1.15, 0, 0.55) : 1.0;
    const targetSpeed = baseSpeed * this.surface.speedMult * uphillPenalty * wishMag;

    // Physical acceleration / deceleration inertia scaled by surface traction
    const accelRate = (wishMag > 0.05 ? 7.5 : 10.5) * this.surface.traction;
    const blend = 1 - Math.exp(-accelRate * dt);
    this.vx = lerp(this.vx, dirX * targetSpeed, blend);
    this.vz = lerp(this.vz, dirZ * targetSpeed, blend);

    // Jump
    if (input.jump && this.grounded && this.stamina > 0.14 && this.surface.id !== 'water') {
      this.vy = 5.6;
      this.grounded = false;
      this.stamina = clamp(this.stamina - 0.12, 0, 1);
    }

    // Gravity & horizontal integration
    this.vy -= 16.5 * dt;
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    this.y += this.vy * dt;

    // Prevent walking into deep sea-loch water (wading stops at chest depth)
    const nextGroundY = heightAt(this.x, this.z);
    if (nextGroundY < WATER_LEVEL - 1.15) {
      this.x -= this.vx * dt;
      this.z -= this.vz * dt;
      this.vx *= 0.2;
      this.vz *= 0.2;
    }

    const finalGroundY = heightAt(this.x, this.z);
    if (this.y <= finalGroundY) {
      this.y = finalGroundY;
      this.vy = 0;
      this.grounded = true;
    } else if (this.grounded && this.y - finalGroundY < 0.65) {
      // Stick smoothly to downhill slopes without hopping
      this.y = finalGroundY;
      this.vy = 0;
    } else {
      this.grounded = false;
    }

    // Smooth character body rotation toward travel vector
    this.speed = Math.hypot(this.vx, this.vz);
    if (this.speed > 0.35) {
      const targetYaw = Math.atan2(-this.vx, -this.vz);
      let diff = targetYaw - this.facingYaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      this.facingYaw += diff * (1 - Math.exp(-9.0 * dt));
      this.stridePhase += this.speed * dt * (input.crouch ? 2.4 : 1.75);
    }

    // Stamina drain / recovery
    if (canSprint) {
      const drain = 0.15 + (slope * 0.45) + (this.surface.id === 'peat_bog' ? 0.12 : 0);
      this.stamina = clamp(this.stamina - drain * dt, 0, 1);
    } else {
      const regen = wishMag < 0.1 ? 0.24 : 0.11;
      this.stamina = clamp(this.stamina + regen * dt, 0, 1);
    }

    // Wetness from wading in Loch Linnhe or peat bogs; slowly dries in sun
    if (this.y < WATER_LEVEL + 0.05) {
      this.wetness = clamp(this.wetness + 0.35 * dt, 0, 1);
    } else if (this.surface.id === 'peat_bog' && this.speed > 0.5) {
      this.wetness = clamp(this.wetness + 0.06 * dt, 0, 0.65);
    } else {
      this.wetness = clamp(this.wetness - 0.025 * dt, 0, 1);
    }

    this.crouchBlend = lerp(this.crouchBlend, input.crouch ? 1 : 0, 1 - Math.exp(-10 * dt));
  }

  syncToWorldState(worldState) {
    worldState.player.x = Number(this.x.toFixed(2));
    worldState.player.y = Number(this.y.toFixed(2));
    worldState.player.z = Number(this.z.toFixed(2));
    worldState.player.yaw = Number(this.facingYaw.toFixed(3));
    worldState.player.stamina = Number(this.stamina.toFixed(3));
    worldState.player.wetness = Number(this.wetness.toFixed(3));
  }
}
