import * as THREE from 'three';
import { clamp, lerp } from '../core/prng.js';

export class BrambleRig {
  constructor(plaidMat) {
    this.root = new THREE.Group();
    this.root.rotation.order = 'YXZ';

    // Authentic 1744 Highland Garron palette (warm mouse-dun coat, dark points & dorsal stripe)
    const coatMat = new THREE.MeshStandardMaterial({ color: 0x6b563f, roughness: 0.88 });
    const darkPointsMat = new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 0.90 });
    const maneMat = new THREE.MeshStandardMaterial({ color: 0x1b140f, roughness: 0.94 });
    const featherMat = new THREE.MeshStandardMaterial({ color: 0x4b3d2d, roughness: 0.92 });
    const hoofMat = new THREE.MeshStandardMaterial({ color: 0x181512, roughness: 0.65 });
    const leatherMat = new THREE.MeshStandardMaterial({ color: 0x352114, roughness: 0.72 });
    const brassMat = new THREE.MeshStandardMaterial({ color: 0xc29c4c, roughness: 0.35, metalness: 0.85 });

    this.bodyGroup = new THREE.Group();
    this.root.add(this.bodyGroup);

    // Sturdy barrel-chested torso & deep hindquarters
    const barrel = new THREE.Mesh(new THREE.CapsuleGeometry(0.41, 0.92, 8, 12), coatMat);
    barrel.rotation.x = Math.PI / 2;
    barrel.scale.set(0.92, 1.0, 1.08);
    barrel.position.set(0, 1.18, 0.04);
    barrel.castShadow = true;
    barrel.receiveShadow = true;
    this.bodyGroup.add(barrel);

    const chest = new THREE.Mesh(new THREE.SphereGeometry(0.40, 10, 10), coatMat);
    chest.scale.set(0.94, 1.06, 1.02);
    chest.position.set(0, 1.20, -0.52);
    chest.castShadow = true;
    this.bodyGroup.add(chest);

    const croup = new THREE.Mesh(new THREE.SphereGeometry(0.41, 10, 10), coatMat);
    croup.scale.set(0.96, 1.04, 1.08);
    croup.position.set(0, 1.22, 0.56);
    croup.castShadow = true;
    this.bodyGroup.add(croup);

    // Authentic Highland Garron dark dorsal eel-stripe
    const dorsal = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.05, 1.18), maneMat);
    dorsal.position.set(0, 1.60, 0.06);
    this.bodyGroup.add(dorsal);

    // Frontier leather saddle, girth strap, stirrups, rolled plaid & saddlebags
    const saddleSeat = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.14, 0.58), leatherMat);
    saddleSeat.position.set(0, 1.62, -0.02);
    saddleSeat.castShadow = true;
    this.bodyGroup.add(saddleSeat);

    const pommel = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 0.16, 8), leatherMat);
    pommel.position.set(0, 1.71, -0.26);
    this.bodyGroup.add(pommel);

    const cantle = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.18, 0.12), leatherMat);
    cantle.position.set(0, 1.71, 0.24);
    cantle.rotation.x = -0.28;
    this.bodyGroup.add(cantle);

    const girth = new THREE.Mesh(new THREE.CylinderGeometry(0.43, 0.43, 0.12, 12), leatherMat);
    girth.rotation.x = Math.PI / 2;
    girth.scale.set(0.91, 1.0, 1.08);
    girth.position.set(0, 1.18, -0.10);
    this.bodyGroup.add(girth);

    // Rolled Highland great plaid strapped behind the saddle
    const bedroll = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.62, 10), plaidMat);
    bedroll.rotation.z = Math.PI / 2;
    bedroll.position.set(0, 1.69, 0.39);
    bedroll.castShadow = true;
    this.bodyGroup.add(bedroll);

    // Twin frontier saddlebags
    for (const side of [-1, 1]) {
      const bag = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.34, 0.36), leatherMat);
      bag.position.set(side * 0.41, 1.38, 0.36);
      bag.rotation.z = side * -0.14;
      bag.castShadow = true;
      this.bodyGroup.add(bag);

      const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.07, 0.07), brassMat);
      buckle.position.set(side * 0.48, 1.40, 0.36);
      this.bodyGroup.add(buckle);
    }

    // Articulated arched neck + head + thick Highland mane
    this.neckPivot = new THREE.Group();
    this.neckPivot.position.set(0, 1.34, -0.64);
    this.bodyGroup.add(this.neckPivot);

    const neck = new THREE.Mesh(new THREE.CapsuleGeometry(0.21, 0.56, 6, 10), coatMat);
    neck.position.set(0, 0.30, -0.22);
    neck.rotation.x = 0.62;
    neck.scale.set(0.86, 1.0, 1.12);
    neck.castShadow = true;
    this.neckPivot.add(neck);

    const mane = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.68, 0.16), maneMat);
    mane.position.set(0, 0.38, -0.10);
    mane.rotation.x = 0.62;
    mane.castShadow = true;
    this.neckPivot.add(mane);

    this.headGroup = new THREE.Group();
    this.headGroup.position.set(0, 0.60, -0.44);
    this.neckPivot.add(this.headGroup);

    const skull = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.26, 0.44), coatMat);
    skull.position.set(0, -0.02, -0.16);
    skull.rotation.x = 0.38;
    skull.castShadow = true;
    this.headGroup.add(skull);

    const muzzle = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.19, 0.24), darkPointsMat);
    muzzle.position.set(0, -0.13, -0.40);
    muzzle.rotation.x = 0.38;
    muzzle.castShadow = true;
    this.headGroup.add(muzzle);

    const forelock = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.26, 6), maneMat);
    forelock.position.set(0, 0.08, -0.20);
    forelock.rotation.x = -0.65;
    this.headGroup.add(forelock);

    // Bridle straps
    const noseband = new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.05, 0.08), leatherMat);
    noseband.position.set(0, -0.10, -0.34);
    noseband.rotation.x = 0.38;
    this.headGroup.add(noseband);

    // Alert Highland ears
    for (const side of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.16, 5), darkPointsMat);
      ear.position.set(side * 0.09, 0.17, 0.02);
      ear.rotation.z = side * -0.16;
      ear.rotation.x = 0.15;
      this.headGroup.add(ear);
    }

    // Flowing Highland tail
    this.tailPivot = new THREE.Group();
    this.tailPivot.position.set(0, 1.38, 0.90);
    this.bodyGroup.add(this.tailPivot);

    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.95, 7), maneMat);
    tail.position.set(0, -0.44, 0.10);
    tail.rotation.x = 0.22;
    tail.castShadow = true;
    this.tailPivot.add(tail);

    // 4 Articulated Legs with feathered fetlocks & iron-shod hooves
    const makeLeg = (x, y, z) => {
      const hip = new THREE.Group();
      hip.position.set(x, y, z);

      const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.105, 0.36, 5, 8), coatMat);
      upper.position.y = -0.22;
      upper.castShadow = true;
      hip.add(upper);

      const knee = new THREE.Group();
      knee.position.y = -0.44;
      hip.add(knee);

      const shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.072, 0.34, 5, 7), darkPointsMat);
      shin.position.y = -0.20;
      shin.castShadow = true;
      knee.add(shin);

      // Characteristic Highland Garron feathered fetlock
      const feather = new THREE.Mesh(new THREE.CylinderGeometry(0.078, 0.105, 0.15, 7), featherMat);
      feather.position.y = -0.38;
      knee.add(feather);

      const hoof = new THREE.Mesh(new THREE.CylinderGeometry(0.078, 0.092, 0.10, 7), hoofMat);
      hoof.position.y = -0.47;
      knee.add(hoof);

      this.bodyGroup.add(hip);
      return { hip, knee };
    };

    this.legs = {
      fl: makeLeg(-0.24, 0.96, -0.58),
      fr: makeLeg(0.24, 0.96, -0.58),
      bl: makeLeg(-0.25, 0.98, 0.56),
      br: makeLeg(0.25, 0.98, 0.56)
    };
  }

  update(mount, elapsed) {
    this.root.position.set(mount.x, mount.y, mount.z);
    this.root.rotation.y = mount.yaw;
    this.root.rotation.x = mount.pitch;
    this.root.rotation.z = -mount.roll;

    const p = mount.stridePhase;
    const amp = clamp(mount.speed / 8.5, 0, 1.25);
    const isGallop = mount.gait === 'GALLOP' || mount.gait === 'CANTER';
    const isTrot = mount.gait === 'TROT';

    // Authentic biomechanical phase offsets per gait
    let flP = p;
    let frP = p + Math.PI;
    let blP = p + Math.PI * 0.5;
    let brP = p + Math.PI * 1.5;

    if (isTrot) {
      // Diagonal pairs strike in sync
      flP = p;
      brP = p;
      frP = p + Math.PI;
      blP = p + Math.PI;
    } else if (isGallop) {
      // Asymmetric bounding gallop lead
      flP = p;
      frP = p + 0.55;
      blP = p + Math.PI;
      brP = p + Math.PI + 0.55;
    }

    const swingScale = isGallop ? 0.68 : isTrot ? 0.55 : 0.42;
    const applyLeg = (leg, phase, isFront) => {
      const s = Math.sin(phase) * swingScale * amp;
      const lift = Math.max(0, Math.cos(phase)) * amp;
      if (!mount.grounded) {
        leg.hip.rotation.x = isFront ? 0.72 : -0.65;
        leg.knee.rotation.x = isFront ? -0.95 : 0.45;
      } else {
        leg.hip.rotation.x = s;
        leg.knee.rotation.x = isFront ? -lift * 0.85 : lift * 0.55;
      }
    };

    applyLeg(this.legs.fl, flP, true);
    applyLeg(this.legs.fr, frP, true);
    applyLeg(this.legs.bl, blP, false);
    applyLeg(this.legs.br, brP, false);

    // Body vertical cadence & gallop rock
    const bob = isGallop ? Math.sin(p) * 0.11 * amp : Math.abs(Math.sin(p)) * 0.06 * amp;
    this.bodyGroup.position.y = bob;
    this.bodyGroup.rotation.x = isGallop ? Math.cos(p) * 0.09 * amp : 0;

    // Neck & head animation: grazing heather, bounding gallop stretch, or affectionate nod when tended
    const grazePitch = mount.grazeBlend * -1.42;
    const careNod = mount.careTimer > 0 ? Math.sin(elapsed * 9.0) * 0.16 : 0;
    const strideNod = isGallop ? Math.sin(p - 0.5) * 0.18 * amp : Math.sin(p) * 0.07 * amp;
    const idleBreath = Math.sin(elapsed * 1.4) * 0.025;

    this.neckPivot.rotation.x = lerp(strideNod + idleBreath + careNod, grazePitch + Math.sin(elapsed * 2.8) * 0.04, mount.grazeBlend);
    this.headGroup.rotation.x = lerp(-strideNod * 0.4, 0.35, mount.grazeBlend);

    // Tail lifts & streams in gallop, swishes gently while grazing
    this.tailPivot.rotation.x = 0.20 + amp * 0.55 + Math.sin(elapsed * 1.8) * 0.06;
    this.tailPivot.rotation.z = Math.sin(elapsed * (1.5 + amp * 2.5)) * (0.14 + amp * 0.10);
  }
}
