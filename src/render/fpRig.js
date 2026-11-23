import * as THREE from 'three';
import { clamp, lerp } from '../core/prng.js';

// Dedicated Dishonored-style First-Person Arms & Personal Arsenal Viewmodel Rig.
// Attached directly to the eye-level camera (and cleanly separable into tracked VR hands later).

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

    // --- RIGHT ARM & WEAPON PIVOT ---
    this.rightPivot = new THREE.Group();
    this.root.add(this.rightPivot);

    const rForearm = new THREE.Mesh(new THREE.CylinderGeometry(0.044, 0.056, 0.34, 8), sleeveMat);
    rForearm.rotation.x = Math.PI / 2;
    rForearm.position.set(0.04, -0.06, 0.20);
    const rCuff = new THREE.Mesh(new THREE.CylinderGeometry(0.050, 0.052, 0.06, 8), plaidMat);
    rCuff.rotation.x = Math.PI / 2;
    rCuff.position.set(0.02, -0.03, 0.08);
    const rHand = new THREE.Mesh(new THREE.BoxGeometry(0.072, 0.078, 0.10), skinMat);
    rHand.position.set(0, 0, 0);
    this.rightPivot.add(rForearm, rCuff, rHand);

    // 1. Father's Basket-Hilted Broadsword (detailed pierced iron cage + fullered steel blade)
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

    // 2. Belt Dirk / Biodag (Stealth blade)
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

    // 3. All-Metal Highland Flintlock Pistol (ram's-horn butt, steel barrel, brass flashpan)
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
    this.root.add(this.leftPivot);

    const lForearm = new THREE.Mesh(new THREE.CylinderGeometry(0.044, 0.056, 0.34, 8), sleeveMat);
    lForearm.rotation.x = Math.PI / 2;
    lForearm.position.set(-0.04, -0.06, 0.20);
    const lCuff = new THREE.Mesh(new THREE.CylinderGeometry(0.050, 0.052, 0.06, 8), plaidMat);
    lCuff.rotation.x = Math.PI / 2;
    lCuff.position.set(-0.02, -0.03, 0.08);
    const lHand = new THREE.Mesh(new THREE.BoxGeometry(0.072, 0.078, 0.10), skinMat);
    this.leftPivot.add(lForearm, lCuff, lHand);

    // 4. Studded Oak Targe (Left Forearm Guard & Bash)
    this.targeGroup = createFPTarge(oakMat, ironMat, brassMat);
    this.targeGroup.position.set(0.02, 0.06, -0.07);
    this.targeGroup.rotation.set(0.08, 0.48, -0.08);
    this.leftPivot.add(this.targeGroup);

    // 5. Short Highland Hunting Bow (Left Hand Stave + Nocked Arrow pulled by Right Hand)
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
    this.bowGroup.rotation.z = -0.22; // Slight natural hunting cant
    this.leftPivot.add(this.bowGroup);
  }

  update(dt, player, mount, combat, elapsed) {
    // Detect flintlock shot for punchy upward recoil kick
    if (this.prevLoaded && !combat.flintlockLoaded && combat.weapon === 'flintlock') {
      this.recoil = 1.0;
    }
    this.prevLoaded = combat.flintlockLoaded;
    this.recoil = Math.max(0, this.recoil - dt * 3.8);

    // Live steel blood staining on Father's Broadsword & Belt Dirk
    this.bladeMat.color.setHex(0xd0dae2).lerp(this.tmpColor.setHex(0x520404), combat.bladeBlood * 0.88);

    // Turn-lag inertial weapon sway (makes hands feel physically weighted like Dishonored)
    let dYaw = player.camYaw - this.prevCamYaw;
    while (dYaw > Math.PI) dYaw -= Math.PI * 2;
    while (dYaw < -Math.PI) dYaw += Math.PI * 2;
    const dPitch = player.camPitch - this.prevCamPitch;
    this.prevCamYaw = player.camYaw;
    this.prevCamPitch = player.camPitch;

    const swayAlpha = 1 - Math.exp(-10 * dt);
    this.swayX = lerp(this.swayX, clamp(-dYaw * 0.85, -0.055, 0.055), swayAlpha);
    this.swayY = lerp(this.swayY, clamp(dPitch * 0.65, -0.045, 0.045), swayAlpha);

    // Organic walk/gallop bob & quiet idle breathing
    const moveSpd = mount.mounted ? clamp(mount.speed / 12, 0, 1) : clamp(player.speed / 6.5, 0, 1);
    const phase = mount.mounted ? mount.stridePhase : player.stridePhase;
    const bobX = Math.cos(phase) * 0.016 * moveSpd;
    const bobY = Math.abs(Math.sin(phase)) * 0.018 * moveSpd + Math.sin(elapsed * 1.9) * 0.004;

    // Weapon visibility toggles
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

    // --- RIGHT HAND TARGET POSE ---
    let rx = 0.29 + this.swayX + bobX;
    let ry = -0.25 + this.swayY - bobY;
    let rz = -0.44;
    let rRotX = 0;
    let rRotY = 0;
    let rRotZ = 0;

    if (w === 'dirk') {
      rx = 0.24 + this.swayX + bobX;
      ry = -0.22 + this.swayY - bobY - player.crouchBlend * 0.03;
      rz = -0.38;
    } else if (w === 'flintlock') {
      if (combat.flintlockReloadTimer > 0) {
        // Reload dip & ramrod pumping motion
        const ram = Math.sin(elapsed * 8.5) * 0.04;
        rx = 0.14;
        ry = -0.36 + ram;
        rz = -0.36;
        rRotX = 0.65;
        rRotY = 0.35;
      } else {
        // Raised cleanly toward center-right sightline
        rx = 0.16 + this.swayX * 0.6 + bobX * 0.5;
        ry = -0.15 + this.swayY * 0.6 - bobY * 0.5 + this.recoil * 0.08;
        rz = -0.42 + this.recoil * 0.12;
        rRotX = this.recoil * 0.55;
      }
    } else if (w === 'bow' && combat.bowDrawing) {
      // Right hand draws bowstring & arrow nock back toward cheek
      rx = 0.08;
      ry = -0.10;
      rz = -0.30 + combat.bowDraw * 0.18;
      rRotY = -0.45;
    }

    // Melee strike, parry, and blade-wipe overrides
    if (combat.attackState !== 'NONE' && combat.attackState !== 'BASH') {
      const p = clamp(combat.attackTimer / combat.attackDuration, 0, 1);
      if (combat.attackKind === 'heavy_cleave') {
        if (p < 0.32) {
          const t = p / 0.32;
          rx = lerp(0.29, 0.36, t);
          ry = lerp(-0.25, 0.16, t);
          rz = lerp(-0.44, -0.34, t);
          rRotX = lerp(0, 0.95, t);
          rRotZ = lerp(0, -0.48, t);
        } else {
          const t = (p - 0.32) / 0.68;
          const ease = 1 - Math.pow(1 - t, 3);
          rx = lerp(0.36, -0.26, ease);
          ry = lerp(0.16, -0.38, ease);
          rz = lerp(-0.34, -0.62, Math.sin(t * Math.PI));
          rRotX = lerp(0.95, -1.45, ease);
          rRotZ = lerp(-0.48, 0.82, ease);
        }
      } else if (combat.attackKind === 'fast_left') {
        const sweep = Math.sin(p * Math.PI);
        rx = lerp(0.34, -0.32, p);
        ry = -0.16 - sweep * 0.04;
        rz = -0.44 - sweep * 0.18;
        rRotX = -0.45 * sweep;
        rRotY = lerp(-0.65, 1.35, p);
        rRotZ = 1.15;
      } else if (combat.attackKind === 'fast_right') {
        const sweep = Math.sin(p * Math.PI);
        rx = lerp(-0.22, 0.38, p);
        ry = -0.18;
        rz = -0.42 - sweep * 0.18;
        rRotX = -0.40 * sweep;
        rRotY = lerp(1.1, -0.95, p);
        rRotZ = -1.05;
      } else {
        // Forward thrust / dirk stab / stealth takedown
        const lunge = Math.sin(p * Math.PI);
        rx = lerp(rx, 0.06, lunge);
        ry = lerp(ry, -0.14, lunge);
        rz = -0.42 - lunge * 0.30;
        rRotX = -0.95 * lunge;
        rRotY = 0.25 * lunge;
      }
    } else if (combat.guarding && (w === 'sword' || w === 'dirk')) {
      if (combat.targeOnArm) {
        // Targe holds center-left; sword cocks high right ready for riposte
        rx = 0.34;
        ry = -0.14;
        rz = -0.40;
        rRotX = 0.25;
        rRotZ = -0.35;
      } else {
        // Steel cross-parry directly across view
        rx = 0.06;
        ry = -0.12;
        rz = -0.38;
        rRotX = -0.22;
        rRotY = 0.55;
        rRotZ = 1.18;
      }
    } else if (combat.wipeTimer > 0) {
      const wipe = Math.sin(elapsed * 14.0);
      rx = 0.08 + wipe * 0.06;
      ry = -0.16;
      rz = -0.38;
      rRotZ = 0.95;
    }

    // --- LEFT HAND TARGET POSE (Targe / Bow / Reload Support) ---
    let lx = -0.34 + this.swayX - bobX;
    let ly = -0.28 + this.swayY - bobY;
    let lz = -0.42;
    let lRotX = 0;
    let lRotY = 0;
    let lRotZ = 0;

    if (w === 'bow') {
      const d = combat.bowDraw;
      lx = lerp(-0.24, -0.09, d) + this.swayX * 0.5;
      ly = lerp(-0.20, -0.08, d) + this.swayY * 0.5;
      lz = lerp(-0.46, -0.52, d);
      lRotY = lerp(0.14, 0.02, d);
      this.bowArrowGroup.position.z = -0.18 + d * 0.26;
    } else if (combat.attackState === 'BASH') {
      const p = clamp(combat.attackTimer / combat.attackDuration, 0, 1);
      const bash = Math.sin(p * Math.PI);
      lx = lerp(-0.34, -0.04, bash);
      ly = lerp(-0.26, -0.08, bash);
      lz = -0.42 - bash * 0.28;
      lRotY = lerp(0, -0.35, bash);
    } else if (combat.guarding && combat.targeOnArm) {
      // Slam oak targe up across left-center vision to stop bayonets & musket balls
      lx = -0.12;
      ly = -0.10;
      lz = -0.36;
      lRotY = -0.36;
    } else if (w === 'flintlock' && combat.flintlockReloadTimer > 0) {
      lx = -0.12;
      ly = -0.34;
      lz = -0.36;
      lRotY = -0.45;
    }

    const poseBlend = 1 - Math.exp(-22 * dt);
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
