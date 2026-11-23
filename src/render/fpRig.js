import * as THREE from 'three';
import { clamp, lerp } from '../core/prng.js';

function easeOutExpo(t) {
  return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - clamp(t, 0, 1), 3);
}

function createFPTarge(oakMat, ironMat, brassMat) {
  const g = new THREE.Group();
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.036, 18), oakMat);
  disc.rotation.x = Math.PI / 2;
  g.add(disc);

  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.018, 6, 20), ironMat);
  g.add(rim);

  const boss = new THREE.Mesh(new THREE.ConeGeometry(0.065, 0.085, 8), ironMat);
  boss.rotation.x = Math.PI / 2;
  boss.position.z = 0.045;
  g.add(boss);

  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const stud = new THREE.Mesh(new THREE.SphereGeometry(0.014, 5, 5), brassMat);
    stud.position.set(Math.cos(a) * 0.165, Math.sin(a) * 0.165, 0.02);
    g.add(stud);
  }
  return g;
}

// Full continuous arm geometry (hand -> plaid cuff -> forearm -> elbow -> extended upper arm behind camera!)
// Guarantees zero floating or cut-off arm stumps on ANY weapon, swing, parry, bash, or reload.
function buildFullArmLimb(side, sleeveMat, plaidMat, skinMat) {
  const g = new THREE.Group();

  const hand = new THREE.Mesh(new THREE.BoxGeometry(0.070, 0.074, 0.095), skinMat);
  g.add(hand);

  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.052, 0.065, 9), plaidMat);
  cuff.rotation.x = Math.PI / 2;
  cuff.position.set(side * 0.015, -0.02, 0.075);
  g.add(cuff);

  // Forearm extending cleanly back toward the elbow
  const forearm = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.060, 0.40, 9), sleeveMat);
  forearm.rotation.x = Math.PI / 2 + 0.16;
  forearm.rotation.z = side * -0.14;
  forearm.position.set(side * 0.05, -0.065, 0.28);
  g.add(forearm);

  const elbow = new THREE.Mesh(new THREE.SphereGeometry(0.062, 8, 8), sleeveMat);
  elbow.position.set(side * 0.085, -0.105, 0.47);
  g.add(elbow);

  // Upper arm sleeve anchoring far back behind the camera plane toward Callum's shoulder
  const upperArm = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.076, 0.52, 9), sleeveMat);
  upperArm.rotation.x = Math.PI / 2 + 0.28;
  upperArm.rotation.z = side * -0.22;
  upperArm.position.set(side * 0.15, -0.18, 0.72);
  g.add(upperArm);

  return g;
}

export class FirstPersonRig {
  constructor(plaidMat) {
    this.root = new THREE.Group();

    const sleeveMat = new THREE.MeshStandardMaterial({ color: 0x2a241d, roughness: 0.92 });
    const leatherMat = new THREE.MeshStandardMaterial({ color: 0x261911, roughness: 0.78 });
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xc29372, roughness: 0.76 });
    const ironMat = new THREE.MeshStandardMaterial({ color: 0x5c646c, roughness: 0.40, metalness: 0.86 });
    const brassMat = new THREE.MeshStandardMaterial({ color: 0xc8a04b, roughness: 0.34, metalness: 0.86 });
    const oakMat = new THREE.MeshStandardMaterial({ color: 0x4b311d, roughness: 0.84 });
    const fletchMat = new THREE.MeshStandardMaterial({ color: 0xd8d2c2, roughness: 0.9 });
    this.bladeMat = new THREE.MeshStandardMaterial({ color: 0xd0dae2, roughness: 0.20, metalness: 0.93 });

    this.tmpColor = new THREE.Color();
    this.swayX = 0;
    this.swayY = 0;
    this.prevCamYaw = 0;
    this.prevCamPitch = 0;
    this.recoil = 0;
    this.prevLoaded = true;

    // Subtle steel slash arc ribbon (flashes cleanly across strike zone during fast/heavy cuts)
    this.slashMat = new THREE.MeshBasicMaterial({
      color: 0xe6edf5,
      transparent: true,
      opacity: 0.0,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    const slashGeo = new THREE.RingGeometry(0.32, 0.56, 20, 1, -Math.PI * 0.38, Math.PI * 0.76);
    this.slashArc = new THREE.Mesh(slashGeo, this.slashMat);
    this.slashArc.position.set(0, -0.05, -0.66);
    this.root.add(this.slashArc);

    // --- RIGHT ARM & WEAPON PIVOT ---
    this.rightPivot = new THREE.Group();
    this.rightPivot.add(buildFullArmLimb(1, sleeveMat, plaidMat, skinMat));
    this.root.add(this.rightPivot);

    // 1. Father's Basket-Hilted Broadsword
    this.swordGroup = new THREE.Group();
    const sGrip = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.019, 0.16, 7), leatherMat);
    const sPommel = new THREE.Mesh(new THREE.SphereGeometry(0.028, 7, 7), ironMat);
    sPommel.position.y = -0.09;
    const sGuard = new THREE.Mesh(new THREE.TorusGeometry(0.068, 0.012, 6, 12, Math.PI * 1.45), ironMat);
    sGuard.rotation.y = Math.PI * 0.25;
    sGuard.position.set(0, 0.02, -0.02);
    const sCageRing = new THREE.Mesh(new THREE.TorusGeometry(0.064, 0.010, 6, 12), ironMat);
    sCageRing.rotation.x = Math.PI / 2;
    sCageRing.position.y = 0.068;
    const sBlade = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.78, 0.010), this.bladeMat);
    sBlade.position.y = 0.46;
    const sTip = new THREE.Mesh(new THREE.ConeGeometry(0.024, 0.12, 4), this.bladeMat);
    sTip.position.y = 0.91;
    sTip.scale.set(1.0, 1.0, 0.28);
    this.swordGroup.add(sGrip, sPommel, sGuard, sCageRing, sBlade, sTip);
    this.swordGroup.position.set(0, 0.02, -0.04);
    this.swordGroup.rotation.set(-0.34, 0.14, 0.18);
    this.rightPivot.add(this.swordGroup);

    // 2. Belt Dirk / Biodag
    this.dirkGroup = new THREE.Group();
    const dGrip = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.017, 0.12, 6), oakMat);
    const dCap = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.018, 0.025, 7), brassMat);
    dCap.position.y = -0.065;
    const dBlade = new THREE.Mesh(new THREE.ConeGeometry(0.020, 0.34, 4), this.bladeMat);
    dBlade.position.y = 0.23;
    dBlade.scale.set(1.0, 1.0, 0.35);
    this.dirkGroup.add(dGrip, dCap, dBlade);
    this.dirkGroup.position.set(0, 0.01, -0.04);
    this.dirkGroup.rotation.set(-0.55, 0.28, 0.36);
    this.rightPivot.add(this.dirkGroup);

    // 3. All-Metal Highland Flintlock Pistol
    this.flintlockGroup = new THREE.Group();
    const pGrip = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.11, 0.042), ironMat);
    pGrip.position.set(0, -0.03, 0.02);
    pGrip.rotation.x = 0.38;
    const pButt = new THREE.Mesh(new THREE.SphereGeometry(0.024, 6, 6), brassMat);
    pButt.position.set(0, -0.09, 0.045);
    const pBody = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.042, 0.18), ironMat);
    pBody.position.set(0, 0.02, -0.07);
    const pBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.016, 0.34, 8), ironMat);
    pBarrel.rotation.x = Math.PI / 2;
    pBarrel.position.set(0, 0.036, -0.22);
    const pCock = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.048, 0.022), brassMat);
    pCock.position.set(0.022, 0.052, -0.06);
    pCock.rotation.x = -0.25;
    this.flintlockGroup.add(pGrip, pButt, pBody, pBarrel, pCock);
    this.flintlockGroup.position.set(0, 0.02, -0.04);
    this.rightPivot.add(this.flintlockGroup);

    // --- LEFT ARM, TARGE & HIGHLAND BOW PIVOT ---
    this.leftPivot = new THREE.Group();
    this.leftPivot.add(buildFullArmLimb(-1, sleeveMat, plaidMat, skinMat));
    this.root.add(this.leftPivot);

    // 4. Studded Oak Targe
    this.targeGroup = createFPTarge(oakMat, ironMat, brassMat);
    this.targeGroup.position.set(0.02, 0.06, -0.07);
    this.targeGroup.rotation.set(0.08, 0.48, -0.08);
    this.leftPivot.add(this.targeGroup);

    // 5. Short Highland Hunting Bow
    this.bowGroup = new THREE.Group();
    const bowStave = new THREE.Mesh(new THREE.TorusGeometry(0.44, 0.016, 6, 18, Math.PI * 0.88), oakMat);
    bowStave.rotation.y = Math.PI / 2;
    bowStave.rotation.z = -Math.PI * 0.44;
    bowStave.position.set(0.02, 0.02, -0.06);
    const bowString = new THREE.Mesh(new THREE.CylinderGeometry(0.0025, 0.0025, 0.78, 4), fletchMat);
    bowString.position.set(0.02, 0.02, 0.09);
    this.bowArrowGroup = new THREE.Group();
    const aShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.68, 6), oakMat);
    aShaft.rotation.x = Math.PI / 2;
    const aTip = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.08, 4), ironMat);
    aTip.rotation.x = -Math.PI / 2;
    aTip.position.z = -0.37;
    const aFletch = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.012, 0.14), fletchMat);
    aFletch.position.z = 0.25;
    this.bowArrowGroup.add(aShaft, aTip, aFletch);
    this.bowArrowGroup.position.set(0.04, 0.04, -0.18);
    this.bowGroup.add(bowStave, bowString, this.bowArrowGroup);
    this.bowGroup.rotation.z = -0.22;
    this.leftPivot.add(this.bowGroup);
  }

  update(dt, player, mount, combat, elapsed) {
    if (this.prevLoaded && !combat.flintlockLoaded && combat.weapon === 'flintlock') {
      this.recoil = 1.0;
    }
    this.prevLoaded = combat.flintlockLoaded;
    this.recoil = Math.max(0, this.recoil - dt * 4.4);

    // Live steel bloodstaining
    this.bladeMat.color.setHex(0xd0dae2).lerp(this.tmpColor.setHex(0x520404), combat.bladeBlood * 0.88);

    // Smooth turn-lag weapon inertia
    let dYaw = player.camYaw - this.prevCamYaw;
    while (dYaw > Math.PI) dYaw -= Math.PI * 2;
    while (dYaw < -Math.PI) dYaw += Math.PI * 2;
    const dPitch = player.camPitch - this.prevCamPitch;
    this.prevCamYaw = player.camYaw;
    this.prevCamPitch = player.camPitch;

    const swayAlpha = 1 - Math.exp(-12 * dt);
    this.swayX = lerp(this.swayX, clamp(-dYaw * 0.75, -0.048, 0.048), swayAlpha);
    this.swayY = lerp(this.swayY, clamp(dPitch * 0.55, -0.038, 0.038), swayAlpha);

    // Walk/gallop cadence & subtle breathing
    const moveSpd = mount.mounted ? clamp(mount.speed / 12, 0, 1) : clamp(player.speed / 6.5, 0, 1);
    const phase = mount.mounted ? mount.stridePhase : player.stridePhase;
    const bobX = Math.cos(phase) * 0.015 * moveSpd;
    const bobY = Math.abs(Math.sin(phase)) * 0.016 * moveSpd + Math.sin(elapsed * 1.9) * 0.0035;

    // Physical draw/sheathe dip curve (smoothly drops hands down -> swaps weapon -> raises cleanly)
    let equipDip = 0;
    if (combat.equipTimer > 0) {
      const t = combat.equipTimer / combat.equipDuration;
      equipDip = Math.sin(t * Math.PI);
    }

    const w = combat.weapon;
    this.swordGroup.visible = w === 'sword';
    this.dirkGroup.visible = w === 'dirk';
    this.flintlockGroup.visible = w === 'flintlock';
    this.bowGroup.visible = w === 'bow';
    this.bowArrowGroup.visible = w === 'bow' && combat.arrowCount > 0;
    this.targeGroup.visible = combat.targeOnArm && w !== 'bow';

    const showRight = w !== 'holstered' && w !== 'bow';
    const showLeft = this.targeGroup.visible || w === 'bow' || (w === 'flintlock' && combat.flintlockReloadTimer > 0);
    this.rightPivot.visible = showRight || (w === 'bow' && combat.bowDrawing);
    this.leftPivot.visible = showLeft;

    // --- RIGHT HAND BASE STANCE ---
    let rx = 0.28 + this.swayX + bobX;
    let ry = -0.25 + this.swayY - bobY - equipDip * 0.28;
    let rz = -0.43;
    let rRotX = -equipDip * 0.55;
    let rRotY = 0;
    let rRotZ = 0;
    let blendRate = 22;

    if (w === 'dirk') {
      rx = 0.23 + this.swayX + bobX;
      ry = -0.22 + this.swayY - bobY - player.crouchBlend * 0.025 - equipDip * 0.26;
      rz = -0.37;
    } else if (w === 'flintlock') {
      if (combat.flintlockReloadTimer > 0) {
        const ram = Math.sin(elapsed * 8.5) * 0.035;
        rx = 0.14;
        ry = -0.34 + ram;
        rz = -0.36;
        rRotX = 0.62;
        rRotY = 0.35;
      } else {
        // Crisp center-right sight alignment down the steel barrel
        rx = 0.11 + this.swayX * 0.45 + bobX * 0.4;
        ry = -0.13 + this.swayY * 0.45 - bobY * 0.4 + this.recoil * 0.08 - equipDip * 0.26;
        rz = -0.42 + this.recoil * 0.11;
        rRotX = this.recoil * 0.58;
        rRotY = 0.06;
      }
    } else if (w === 'bow' && combat.bowDrawing) {
      rx = 0.12;
      ry = -0.14;
      rz = -0.26 + combat.bowDraw * 0.14;
      rRotY = -0.38;
    }

    // --- NON-LINEAR DISHONORED MELEE CURVES & STEEL SLASH TRAIL ---
    this.slashMat.opacity = 0;

    if (combat.attackState === 'CHARGE') {
      // Frame-1 immediate anticipation pullback (builds visible tension into Heavy Cleave!)
      const c = clamp(combat.chargeTimer / 0.34, 0, 1);
      const easeC = easeOutCubic(c);
      const tremor = c > 0.65 ? Math.sin(elapsed * 44) * 0.0045 : 0;
      blendRate = 28;

      if (c >= 0.52 && w === 'sword') {
        // Coiling high right for a brutal Heavy Overhead Cleave
        rx = lerp(0.28, 0.38, easeC) + tremor;
        ry = lerp(-0.25, 0.08, easeC) + tremor;
        rz = lerp(-0.43, -0.34, easeC);
        rRotX = lerp(0, 0.88, easeC);
        rRotY = lerp(0, -0.22, easeC);
        rRotZ = lerp(0, -0.52, easeC);
      } else if (combat.attackKind === 'fast_right') {
        // Coiling across left chest for crisp backhand return cut
        rx = lerp(0.28, -0.04, easeC) + tremor;
        ry = lerp(-0.25, -0.18, easeC);
        rz = -0.38;
        rRotY = lerp(0, 0.82, easeC);
        rRotZ = lerp(0, -0.82, easeC);
      } else if (combat.attackKind === 'thrust' || combat.attackKind === 'dirk_thrust') {
        // Pulling hilt tightly back to hip for lunging point thrust
        rx = 0.24 + tremor;
        ry = -0.24;
        rz = lerp(-0.42, -0.24, easeC);
        rRotX = lerp(0, -0.85, easeC);
        rRotY = 0.18;
      } else {
        // Coiling out to right flank for sweeping R->L slash
        rx = lerp(0.28, 0.42, easeC) + tremor;
        ry = lerp(-0.25, -0.14, easeC);
        rz = -0.38;
        rRotY = lerp(0, -0.68, easeC);
        rRotZ = lerp(0, 0.78, easeC);
      }
    } else if (combat.attackState === 'SWING' || combat.attackState === 'RECOVERY' || combat.attackState === 'STEALTH_KILL') {
      const p = clamp(combat.attackTimer / combat.attackDuration, 0, 1);
      // Explosive snap through first 42%, heavy weighted settle through remainder!
      const snap = easeOutExpo(clamp(p / 0.42, 0, 1));
      const settle = clamp((p - 0.55) / 0.45, 0, 1);
      const trailAlpha = p > 0.04 && p < 0.36 ? Math.sin(((p - 0.04) / 0.32) * Math.PI) : 0;
      blendRate = 48; // Ultra-responsive snap during strike frames

      if (combat.attackKind === 'heavy_cleave') {
        rx = lerp(0.38, -0.20, snap);
        ry = lerp(0.08, -0.34, snap);
        rz = -0.44 - Math.sin(snap * Math.PI) * 0.20;
        rRotX = lerp(0.88, -1.42, snap);
        rRotZ = lerp(-0.52, 0.78, snap);
        if (w === 'sword') {
          this.slashMat.opacity = trailAlpha * 0.42;
          this.slashArc.rotation.set(0.35, -0.25, -0.68);
        }
      } else if (combat.attackKind === 'fast_left') {
        rx = lerp(0.40, -0.22, snap);
        ry = -0.17 - Math.sin(snap * Math.PI) * 0.04;
        rz = -0.43 - Math.sin(snap * Math.PI) * 0.16;
        rRotX = -0.38 * Math.sin(snap * Math.PI);
        rRotY = lerp(-0.68, 1.25, snap);
        rRotZ = 1.05;
        if (w === 'sword') {
          this.slashMat.opacity = trailAlpha * 0.32;
          this.slashArc.rotation.set(0.85, 0.0, 0.12);
        }
      } else if (combat.attackKind === 'fast_right') {
        rx = lerp(-0.10, 0.40, snap);
        ry = -0.18;
        rz = -0.42 - Math.sin(snap * Math.PI) * 0.16;
        rRotX = -0.35 * Math.sin(snap * Math.PI);
        rRotY = lerp(0.95, -0.95, snap);
        rRotZ = -0.98;
        if (w === 'sword') {
          this.slashMat.opacity = trailAlpha * 0.32;
          this.slashArc.rotation.set(0.85, Math.PI, -0.12);
        }
      } else {
        // Crisp forward thrust / dirk stab
        const lunge = Math.sin(snap * Math.PI * 0.85);
        rx = lerp(0.24, 0.06, lunge);
        ry = lerp(-0.24, -0.14, lunge);
        rz = -0.34 - lunge * 0.28;
        rRotX = -1.02 * lunge;
        rRotY = 0.22 * lunge;
      }

      // Gently relax back toward guard stance during late recovery
      if (settle > 0) {
        rx = lerp(rx, 0.28, settle * 0.65);
        ry = lerp(ry, -0.25, settle * 0.65);
        rz = lerp(rz, -0.43, settle * 0.65);
        rRotX = lerp(rRotX, 0, settle * 0.65);
        rRotY = lerp(rRotY, 0, settle * 0.65);
        rRotZ = lerp(rRotZ, 0, settle * 0.65);
      }
    } else if (combat.guarding && (w === 'sword' || w === 'dirk')) {
      blendRate = 32;
      if (combat.targeOnArm) {
        rx = 0.32;
        ry = -0.14;
        rz = -0.40;
        rRotX = 0.24;
        rRotZ = -0.32;
      } else {
        rx = 0.07;
        ry = -0.13;
        rz = -0.38;
        rRotX = -0.20;
        rRotY = 0.52;
        rRotZ = 1.14;
      }
    } else if (combat.wipeTimer > 0) {
      const wipe = Math.sin(elapsed * 15.0);
      rx = 0.10 + wipe * 0.05;
      ry = -0.17;
      rz = -0.38;
      rRotZ = 0.92;
    }

    // --- LEFT HAND TARGET POSE (Targe / Bow / Reload) ---
    let lx = -0.33 + this.swayX - bobX;
    let ly = -0.28 + this.swayY - bobY - equipDip * 0.24;
    let lz = -0.42;
    let lRotX = 0;
    let lRotY = 0;
    let lRotZ = 0;

    if (w === 'bow') {
      const d = easeOutCubic(combat.bowDraw);
      lx = lerp(-0.22, -0.07, d) + this.swayX * 0.45;
      ly = lerp(-0.20, -0.07, d) + this.swayY * 0.45 - equipDip * 0.24;
      lz = lerp(-0.46, -0.52, d);
      lRotY = lerp(0.14, 0.02, d);
      this.bowArrowGroup.position.z = -0.18 + d * 0.26;
    } else if (combat.attackState === 'BASH') {
      const p = clamp(combat.attackTimer / combat.attackDuration, 0, 1);
      const bash = Math.sin(easeOutCubic(p) * Math.PI);
      blendRate = 38;
      lx = lerp(-0.33, -0.04, bash);
      ly = lerp(-0.26, -0.08, bash);
      lz = -0.42 - bash * 0.28;
      lRotY = lerp(0, -0.38, bash);
    } else if (combat.guarding && combat.targeOnArm) {
      blendRate = 34;
      lx = -0.12;
      ly = -0.11;
      lz = -0.36;
      lRotY = -0.36;
    } else if (w === 'flintlock' && combat.flintlockReloadTimer > 0) {
      lx = -0.12;
      ly = -0.33;
      lz = -0.36;
      lRotY = -0.45;
    }

    const poseBlend = 1 - Math.exp(-blendRate * dt);
    this.rightPivot.position.lerp(new THREE.Vector3(rx, ry, rz), poseBlend);
    this.rightPivot.rotation.set(
      lerp(this.rightPivot.rotation.x, rRotX, poseBlend),
      lerp(this.rightPivot.rotation.y, rRotY, poseBlend),
      lerp(this.rightPivot.rotation.z, rRotZ, poseBlend)
    );

    this.leftPivot.position.lerp(new THREE.Vector3(lx, ly, lz), poseBlend);
    this.leftPivot.rotation.set(
      lerp(this.leftPivot.rotation.x, lRotX, poseBlend),
      lerp(this.leftPivot.rotation.y, lRotY, poseBlend),
      lerp(this.leftPivot.rotation.z, lRotZ, poseBlend)
    );
  }
}
