import * as THREE from 'three';
import { clamp, lerp } from '../core/prng.js';

class SingleRedcoatRig {
  constructor(soldier, sharedMats) {
    this.id = soldier.id;
    this.root = new THREE.Group();
    this.root.rotation.order = 'YXZ';

    this.body = new THREE.Group();
    this.root.add(this.body);

    const coatMat = soldier.isOfficer ? sharedMats.officerCoat : sharedMats.scarletCoat;

    // Legs (white gaiters + dark boots)
    const legGeo = new THREE.CapsuleGeometry(0.082, 0.60, 4, 7);
    legGeo.translate(0, -0.35, 0);
    this.leftLeg = new THREE.Mesh(legGeo, sharedMats.gaiter);
    this.leftLeg.position.set(-0.13, 0.82, 0);
    this.leftLeg.castShadow = true;

    this.rightLeg = new THREE.Mesh(legGeo, sharedMats.gaiter);
    this.rightLeg.position.set(0.13, 0.82, 0);
    this.rightLeg.castShadow = true;
    this.body.add(this.leftLeg, this.rightLeg);

    // Scarlet regimental coat torso & coat tails
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.21, 0.34, 5, 9), coatMat);
    torso.scale.set(1.12, 1.0, 0.72);
    torso.position.y = 1.32;
    torso.castShadow = true;
    this.body.add(torso);

    const tails = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 0.42, 10), coatMat);
    tails.position.y = 0.90;
    tails.castShadow = true;
    this.body.add(tails);

    // Crisp white Hanoverian crossbelts + cartridge box
    for (const ang of [0.58, -0.58]) {
      const belt = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.56, 0.34), sharedMats.whiteBelt);
      belt.position.set(0, 1.33, 0);
      belt.rotation.z = ang;
      this.body.add(belt);
    }

    const waistBelt = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.23, 0.08, 10), sharedMats.whiteBelt);
    waistBelt.position.y = 1.08;
    this.body.add(waistBelt);

    if (soldier.isOfficer) {
      const sash = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.10, 10), sharedMats.goldTrim);
      sash.position.y = 1.12;
      this.body.add(sash);
    }

    // Crimson neck & shoulder stumps (revealed only when head or arms are severed)
    this.neckStump = new THREE.Mesh(new THREE.CylinderGeometry(0.068, 0.082, 0.10, 8), sharedMats.gore);
    this.neckStump.position.y = 1.66;
    this.neckStump.visible = false;
    this.body.add(this.neckStump);

    this.leftArmStump = new THREE.Mesh(new THREE.SphereGeometry(0.085, 6, 6), sharedMats.gore);
    this.leftArmStump.position.set(-0.29, 1.50, 0);
    this.leftArmStump.visible = false;
    this.body.add(this.leftArmStump);

    this.rightArmStump = new THREE.Mesh(new THREE.SphereGeometry(0.085, 6, 6), sharedMats.gore);
    this.rightArmStump.position.set(0.29, 1.50, 0);
    this.rightArmStump.visible = false;
    this.body.add(this.rightArmStump);

    // Modular Head + Tricorne Hat
    this.headGroup = new THREE.Group();
    this.headGroup.position.y = 1.76;
    this.body.add(this.headGroup);

    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 10), sharedMats.skin);
    skull.castShadow = true;
    this.headGroup.add(skull);

    this.hatGroup = new THREE.Group();
    this.hatGroup.position.y = 0.11;
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.145, 0.10, 8), sharedMats.tricorne);
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.03, 3), sharedMats.tricorne);
    brim.position.y = -0.02;
    brim.rotation.y = Math.PI;
    this.hatGroup.add(crown, brim);
    if (soldier.isOfficer) {
      const lace = new THREE.Mesh(new THREE.TorusGeometry(0.145, 0.014, 5, 12), sharedMats.goldTrim);
      lace.rotation.x = Math.PI / 2;
      lace.position.y = 0.04;
      this.hatGroup.add(lace);
    }
    this.headGroup.add(this.hatGroup);

    // Modular Arms
    const armGeo = new THREE.CapsuleGeometry(0.068, 0.46, 4, 7);
    armGeo.translate(0, -0.25, 0);

    this.leftArm = new THREE.Group();
    this.leftArm.position.set(-0.29, 1.52, 0);
    const leftMesh = new THREE.Mesh(armGeo, coatMat);
    leftMesh.castShadow = true;
    this.leftArm.add(leftMesh);
    this.body.add(this.leftArm);

    this.rightArm = new THREE.Group();
    this.rightArm.position.set(0.29, 1.52, 0);
    const rightMesh = new THREE.Mesh(armGeo, coatMat);
    rightMesh.castShadow = true;
    this.rightArm.add(rightMesh);

    // Brown Bess Musket + Fixed Bayonet (or Officer Hanger Saber)
    this.weaponGroup = new THREE.Group();
    this.weaponGroup.position.set(0, -0.44, -0.06);

    if (soldier.isOfficer) {
      const hilt = new THREE.Mesh(new THREE.SphereGeometry(0.06, 7, 7), sharedMats.goldTrim);
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.015, 0.92), sharedMats.steel);
      blade.position.set(0, 0, -0.48);
      blade.castShadow = true;
      this.weaponGroup.add(hilt, blade);
    } else {
      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.08, 1.25), sharedMats.wood);
      stock.position.set(0, 0, -0.35);
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.025, 1.15, 6), sharedMats.steel);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, 0.035, -0.52);
      const bayonet = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.48, 4), sharedMats.steel);
      bayonet.rotation.x = -Math.PI / 2;
      bayonet.position.set(0, 0.01, -1.28);
      stock.castShadow = true;
      barrel.castShadow = true;
      this.weaponGroup.add(stock, barrel, bayonet);
    }
    this.rightArm.add(this.weaponGroup);
    this.body.add(this.rightArm);

    // Subtle alert glinting point on bayonet tip during melee windup (diegetic telegraph—no HUD bar!)
    this.telegraphMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(2.4, 2.1, 1.5),
      transparent: true,
      opacity: 0.0,
      toneMapped: false
    });
    this.telegraphGlint = new THREE.Mesh(new THREE.OctahedronGeometry(0.085, 0), this.telegraphMat);
    this.telegraphGlint.position.set(0, 0.02, soldier.isOfficer ? -0.82 : -1.32);
    this.weaponGroup.add(this.telegraphGlint);
  }

  update(s, elapsed) {
    this.root.position.set(s.x, s.y, s.z);
    this.root.rotation.y = s.yaw;

    // Toggle severed modular limbs & crimson stumps immediately
    this.headGroup.visible = !s.severed.head;
    this.neckStump.visible = s.severed.head;
    this.hatGroup.visible = !s.hatLost && !s.severed.head;

    this.leftArm.visible = !s.severed.leftArm;
    this.leftArmStump.visible = s.severed.leftArm;

    this.rightArm.visible = !s.severed.rightArm;
    this.rightArmStump.visible = s.severed.rightArm;

    // Ragdoll-style heavy hillside collapse on death
    if (s.dead) {
      const t = clamp(s.deathTimer / 0.48, 0, 1);
      const ease = 1 - Math.pow(1 - t, 3);
      // Convert world knockback direction into local forward/back collapse pitch
      const fwdX = -Math.sin(s.yaw);
      const fwdZ = -Math.cos(s.yaw);
      const fallFwd = s.fallDirX * fwdX + s.fallDirZ * fwdZ;
      const pitchSign = fallFwd >= 0 ? -1 : 1;

      this.body.rotation.x = pitchSign * ease * (Math.PI * 0.48);
      this.body.rotation.z = ease * 0.24;
      this.body.position.y = lerp(0, 0.16, ease);
      this.leftLeg.rotation.x = ease * 0.25;
      this.rightLeg.rotation.x = -ease * 0.2;
      this.leftArm.rotation.set(-0.6 * ease, 0, 0.55 * ease);
      this.rightArm.rotation.set(-0.4 * ease, 0, -0.45 * ease);
      this.telegraphMat.opacity = 0;
      return;
    }

    // Living posture & locomotion
    this.body.position.y = 0;
    this.body.rotation.set(0, 0, 0);

    const strideAmp = clamp(s.speed / 4.2, 0, 1.15);
    const swing = Math.sin(s.stridePhase) * 0.52 * strideAmp;
    this.leftLeg.rotation.x = swing;
    this.rightLeg.rotation.x = -swing;
    this.body.position.y = Math.abs(Math.cos(s.stridePhase)) * 0.04 * strideAmp;

    // Clear visual posture telegraphs (AIM, STAGGER, WINDUP, STRIKE, PATROL)
    this.telegraphMat.opacity = 0;

    if (s.staggerTimer > 0) {
      // Thrown violently backward & wide open for Callum's killing riposte
      const wobble = Math.sin(elapsed * 14) * 0.08;
      this.body.rotation.x = -0.34 + wobble;
      this.leftArm.rotation.set(0.3, 0, 0.72);
      this.rightArm.rotation.set(0.2, 0, -0.82);
    } else if (s.attackPhase === 'WINDUP') {
      // Clear shoulder draw-back + subtle steel glint right before lunge so player can time Perfect Parry!
      const p = clamp(s.attackTimer / 0.48, 0, 1);
      this.body.rotation.y = -0.42 * p;
      this.rightArm.rotation.set(lerp(0.6, 2.25, p), 0, -0.25);
      this.leftArm.rotation.set(0.75, 0, 0.22);
      this.telegraphMat.opacity = smoothBell(p) * 0.95;
    } else if (s.attackPhase === 'STRIKE') {
      const p = clamp(s.attackTimer / 0.22, 0, 1);
      this.body.rotation.y = lerp(-0.35, 0.45, p);
      this.body.rotation.x = 0.24;
      this.rightArm.rotation.set(lerp(2.2, 0.85, p), 0, 0.12);
      this.leftArm.rotation.set(0.55, 0, 0.15);
    } else if (s.aiState === 'AIM_MUSKET') {
      // Shouldered Brown Bess leveled straight at Callum
      this.body.rotation.y = -0.32;
      this.rightArm.rotation.set(1.48, 0.18, 0);
      this.leftArm.rotation.set(1.38, -0.34, 0.25);
    } else if (s.aiState === 'RELOAD') {
      // Lowered musket pouring powder & working ramrod
      const ram = Math.sin(elapsed * 7.5) * 0.18;
      this.rightArm.rotation.set(0.85 + ram, 0.25, 0);
      this.leftArm.rotation.set(0.95, -0.22, 0.2);
    } else if (s.guarding) {
      // Crossed bayonet guard
      this.rightArm.rotation.set(1.18, 0.45, -0.35);
      this.leftArm.rotation.set(1.12, -0.32, 0.30);
    } else {
      // Marching / charging carry
      const carry = s.aiState === 'CHARGE' || s.aiState === 'MELEE' ? 1.15 : 0.48;
      this.rightArm.rotation.set(carry + swing * 0.25, 0, 0);
      this.leftArm.rotation.set(-swing * 0.55 + (s.aiState === 'CHARGE' ? 0.65 : 0), 0, 0);
    }
  }
}

function smoothBell(t) {
  return Math.sin(clamp(t, 0, 1) * Math.PI);
}

export class RedcoatRenderer {
  constructor(scene) {
    this.scene = scene;
    this.rigs = new Map();

    this.sharedMats = {
      scarletCoat: new THREE.MeshStandardMaterial({ color: 0x8f1c18, roughness: 0.86 }),
      officerCoat: new THREE.MeshStandardMaterial({ color: 0xa61d17, roughness: 0.82 }),
      whiteBelt: new THREE.MeshStandardMaterial({ color: 0xd6d1c4, roughness: 0.90 }),
      gaiter: new THREE.MeshStandardMaterial({ color: 0x262421, roughness: 0.88 }),
      skin: new THREE.MeshStandardMaterial({ color: 0xc89a7a, roughness: 0.78 }),
      tricorne: new THREE.MeshStandardMaterial({ color: 0x17181c, roughness: 0.92 }),
      goldTrim: new THREE.MeshStandardMaterial({ color: 0xd4a948, roughness: 0.35, metalness: 0.82 }),
      wood: new THREE.MeshStandardMaterial({ color: 0x4a2e1b, roughness: 0.82 }),
      steel: new THREE.MeshStandardMaterial({ color: 0xc2ccd6, roughness: 0.24, metalness: 0.90 }),
      gore: new THREE.MeshStandardMaterial({ color: 0x4d0606, roughness: 0.35 })
    };
  }

  sync(redcoats, elapsed) {
    const seen = new Set();
    for (const s of redcoats.soldiers) {
      seen.add(s.id);
      let rig = this.rigs.get(s.id);
      if (!rig) {
        rig = new SingleRedcoatRig(s, this.sharedMats);
        this.scene.add(rig.root);
        this.rigs.set(s.id, rig);
      }
      rig.update(s, elapsed);
    }
    for (const [id, rig] of this.rigs.entries()) {
      if (!seen.has(id)) {
        this.scene.remove(rig.root);
        this.rigs.delete(id);
      }
    }
  }
}
