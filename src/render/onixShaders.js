import * as THREE from 'three';

// Shared GLSL math + world-anchored Romantic Oil Painting brushwork helpers
const OX_COMMON_GLSL = /* glsl */ `
uniform sampler2D uOnixField;
uniform float uTime;
uniform float uRain;
uniform float uMistStrength;
uniform float uDayFactor;
uniform vec3 uSunDir;
uniform vec3 uSunColor;

float oxHash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

vec2 oxHash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float oxNoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(oxHash21(i), oxHash21(i + vec2(1.0, 0.0)), u.x),
    mix(oxHash21(i + vec2(0.0, 1.0)), oxHash21(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float oxNoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n00 = oxHash21(i.xy + vec2(0.0, i.z * 37.0));
  float n10 = oxHash21(i.xy + vec2(1.0, i.z * 37.0));
  float n01 = oxHash21(i.xy + vec2(0.0, i.z * 37.0 + 1.0));
  float n11 = oxHash21(i.xy + vec2(1.0, i.z * 37.0 + 1.0));
  float nx0 = mix(mix(n00, n10, f.x), mix(n01, n11, f.x), f.y);

  float m00 = oxHash21(i.xy + vec2(0.0, (i.z + 1.0) * 37.0));
  float m10 = oxHash21(i.xy + vec2(1.0, (i.z + 1.0) * 37.0));
  float m01 = oxHash21(i.xy + vec2(0.0, (i.z + 1.0) * 37.0 + 1.0));
  float m11 = oxHash21(i.xy + vec2(1.0, (i.z + 1.0) * 37.0 + 1.0));
  float nx1 = mix(mix(m00, m10, f.x), mix(m01, m11, f.x), f.y);
  return mix(nx0, nx1, f.z);
}

float oxFbm2(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
  for (int i = 0; i < 4; i++) {
    v += a * oxNoise2(p);
    p = rot * p * 2.04 + vec2(1.9, 7.3);
    a *= 0.5;
  }
  return v;
}

// Voronoi cell distance (x = center dist, y = sharp edge dist, z = stable cell ID)
vec3 oxVoronoi2(vec2 x) {
  vec2 n = floor(x);
  vec2 f = fract(x);
  vec2 mg = vec2(0.0);
  vec2 mr = vec2(0.0);
  float md = 8.0;
  float id = 0.0;

  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = oxHash22(n + g);
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < md) {
        md = d;
        mr = r;
        mg = g;
        id = o.x;
      }
    }
  }

  float edge = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = mg + vec2(float(i), float(j));
      vec2 o = oxHash22(n + g);
      vec2 r = g + o - f;
      if (dot(mr - r, mr - r) > 0.0001) {
        edge = min(edge, dot(0.5 * (mr + r), normalize(r - mr)));
      }
    }
  }
  return vec3(sqrt(md), edge, id);
}

// Directional Romantic Oil-Paint Brushstroke evaluator in world space
// Returns: x = pigment value variation per dab, y = impasto bristle ridge height, z = dab edge
vec3 oxOilBrush(vec2 p, vec2 flowDir, float scale) {
  float len = length(flowDir);
  vec2 d = len > 0.001 ? flowDir / len : vec2(0.86, 0.51);
  vec2 perp = vec2(-d.y, d.x);
  // Rotate & anisotropically stretch coordinates along brushstroke trajectory
  vec2 st = vec2(dot(p, d) * 0.34, dot(p, perp) * 1.95) * scale;
  vec3 dab = oxVoronoi2(st + (oxNoise2(st * 0.65) - 0.5) * 0.45);
  // Fine bristle striations running lengthwise along each paint stroke
  float bristle = oxNoise2(vec2(st.x * 1.4, st.y * 9.5));
  float ridge = smoothstep(0.0, 0.16, dab.y) * (0.62 + bristle * 0.38);
  return vec3(dab.z, ridge, dab.y);
}

// Exact match to General Wade's Road spline in src/world/terrain.js
float oxRoadCenterX(float z) {
  return 88.0 + sin(z * 0.0042) * 46.0 + cos(z * 0.0095) * 18.0;
}
`;

// J.M.W. Turner Atmospheric Oil Wash: valley-trapped luminous mist + golden Mie sun scatter
const OX_PAINTERLY_FOG_GLSL = /* glsl */ `
#ifdef USE_FOG
  float oxHeightMist = exp(-max(vOxWorldPos.y - 2.0, 0.0) * 0.048) * uMistStrength;
  float oxFogD = fogDensity * (1.0 + oxHeightMist * 2.5);
  float oxFogFactor = 1.0 - exp(-oxFogD * oxFogD * vFogDepth * vFogDepth);

  vec3 oxViewW = normalize(vOxWorldPos - cameraPosition);
  float oxSunScatter = pow(max(dot(oxViewW, normalize(uSunDir)), 0.0), 4.0);
  // Soften distant mountains into sweeping golden-amber and slate-indigo Turner oil washes
  vec3 oxMistTint = mix(fogColor, uSunColor * 1.05, oxSunScatter * 0.58 * uDayFactor);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, oxMistTint, clamp(oxFogFactor, 0.0, 0.96));
#endif
`;

// Romantic Chiaroscuro shadow tinting: shifts indirect shadows toward deep Atlantic indigo/slate
const OX_CHIAROSCURO_AO_GLSL = /* glsl */ `
#include <aomap_fragment>
  vec3 oxShadowTint = mix(vec3(0.76, 0.84, 1.04), vec3(0.84, 0.89, 1.02), uDayFactor);
  reflectedLight.indirectDiffuse *= oxAO * oxShadowTint;
  reflectedLight.indirectSpecular *= mix(0.35, 1.0, oxAO);
`;

function injectWorldVaryings(shader, includeUv = false) {
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      `#include <common>
      varying vec3 vOxWorldPos;
      varying vec3 vOxWorldNorm;
      ${includeUv ? 'varying vec2 vOxUv;' : ''}`
    )
    .replace(
      '#include <project_vertex>',
      `#include <project_vertex>
      ${includeUv ? 'vOxUv = uv;' : ''}
      vec4 oxWp = vec4(transformed, 1.0);
      vec3 oxWn = objectNormal;
      #ifdef USE_INSTANCING
        oxWp = instanceMatrix * oxWp;
        oxWn = mat3(instanceMatrix) * oxWn;
      #endif
      oxWp = modelMatrix * oxWp;
      oxWn = normalize(mat3(modelMatrix) * oxWn);
      vOxWorldPos = oxWp.xyz;
      vOxWorldNorm = oxWn;`
    );
}

// 1. Romantic Oil-Painting Highland Terrain Shader (World-Anchored Impasto + Wet Road Puddles)
export function createOnixTerrainMaterial(sharedUniforms) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.88,
    metalness: 0.02
  });

  mat.customProgramCacheKey = () => 'onix-oil-terrain-v2';
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, sharedUniforms);
    injectWorldVaryings(shader);

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vOxWorldPos;
        varying vec3 vOxWorldNorm;
        ${OX_COMMON_GLSL}

        float oxPainterlyRelief(vec2 p, vec2 flow, float rockW, float roadW, float shingleW) {
          vec3 brushBroad = oxOilBrush(p, flow, 0.52);
          vec3 brushFine = oxOilBrush(p + vec2(3.7, 1.9), flow, 1.85);
          float impasto = brushBroad.y * 0.58 + brushFine.y * 0.42;

          // Bold chiseled granite planes (Dishonored-style painterly rock facets)
          vec3 crag = oxVoronoi2((p + flow * 0.45) * 0.44 + oxFbm2(p * 0.28) * 0.65);
          float cragH = smoothstep(0.0, 0.16, crag.y) * 0.85 + brushFine.y * 0.2;

          // Muddy wheel ruts & cobbles on General Wade's Road
          vec3 gravel = oxVoronoi2(p * 2.8);
          float roadH = smoothstep(0.0, 0.2, gravel.y) * 0.5 + brushFine.y * 0.35;

          float h = impasto * 0.72;
          h = mix(h, cragH * 1.25, rockW);
          h = mix(h, roadH * 0.68, roadW);
          h = mix(h, (1.0 - oxVoronoi2(p * 1.8).x) * 0.85, shingleW);
          return h;
        }`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec3 oxWPos = vOxWorldPos;
        vec3 oxWN = normalize(vOxWorldNorm);
        vec2 oxXZ = oxWPos.xz;
        float oxY = oxWPos.y;
        float oxSlope = 1.0 - clamp(oxWN.y, 0.0, 1.0);

        // Live ONIX toroidal lattice (coherence domains + chiral brush flow + moisture)
        vec4 oxF1 = texture2D(uOnixField, oxXZ * 0.011);
        vec4 oxF2 = texture2D(uOnixField, oxXZ * 0.035 + vec2(0.37, 0.61));
        float oxPsi = clamp(oxF1.r * 0.66 + oxF2.r * 0.34, 0.0, 1.0);
        vec2 oxFlow = (oxF1.gb * 2.0 - 1.0) + oxWN.xz * 1.4; // Brushstrokes sweep down slopes & wind!
        float oxFieldWet = oxF1.a;

        // World-anchored broad & fine oil brushstrokes
        vec3 oxBrushB = oxOilBrush(oxXZ, oxFlow, 0.52);
        vec3 oxBrushF = oxOilBrush(oxXZ + vec2(3.7, 1.9), oxFlow, 1.85);
        float oxDabTone = mix(0.80, 1.24, oxBrushB.x * 0.65 + oxBrushF.x * 0.35);

        float oxMacro = oxFbm2(oxXZ * 0.016);
        float oxMed = oxFbm2(oxXZ * 0.11 + oxFlow * 0.25);

        // Geomorphological strata masks
        float oxShingleW = 1.0 - smoothstep(0.15, 2.2, oxY);
        float oxRoadDist = abs(oxXZ.x - oxRoadCenterX(oxXZ.y));
        float oxRoadW = (1.0 - smoothstep(3.2, 5.4, oxRoadDist)) * smoothstep(1.5, 2.8, oxY);
        float oxRockW = smoothstep(0.15, 0.32, oxSlope + (oxMacro - 0.5) * 0.14) + smoothstep(46.0, 72.0, oxY) * 0.8;
        oxRockW = clamp(oxRockW * (1.0 - oxRoadW * 0.85), 0.0, 1.0);

        float oxPeatW = clamp(smoothstep(0.45, 0.74, oxFieldWet + (1.0 - smoothstep(2.0, 15.0, oxY)) * 0.22 - oxSlope * 1.4), 0.0, 1.0);
        oxPeatW *= (1.0 - oxRockW) * (1.0 - oxRoadW) * (1.0 - oxShingleW);

        float oxHeatherW = clamp(smoothstep(0.36, 0.64, oxPsi * 0.65 + oxMacro * 0.55) * smoothstep(4.5, 16.0, oxY), 0.0, 1.0);
        oxHeatherW *= (1.0 - oxRockW) * (1.0 - oxRoadW) * (1.0 - oxShingleW);

        // Muddy wagon ruts along General Wade's Road (reflecting golden dusk sky!)
        float oxRut1 = exp(-pow((oxRoadDist - 1.1) * 2.6, 2.0));
        float oxRut2 = exp(-pow((oxRoadDist - 2.3) * 2.4, 2.0));
        float oxRutMask = clamp((oxRut1 + oxRut2 * 0.75) * oxRoadW, 0.0, 1.0);

        // Rich 1744 Romantic Oil-Painting Earth Pigments (linear space)
        // Warm mossy highland sward + golden-ochre sunlit sedge strokes
        vec3 colMoss = mix(vec3(0.036, 0.068, 0.024), vec3(0.105, 0.122, 0.038), oxMed * 0.65 + oxBrushB.x * 0.35);
        colMoss = mix(colMoss, vec3(0.165, 0.122, 0.044), smoothstep(0.54, 0.86, oxMed + oxBrushF.x * 0.22) * 0.58);

        // Deep heather moorland: dark peat stems dusted with rich crimson-plum & violet bell heather dabs
        vec3 colHeatherBase = mix(vec3(0.042, 0.032, 0.026), vec3(0.058, 0.064, 0.032), oxBrushB.x);
        float oxBloomDab = smoothstep(0.42, 0.84, oxBrushF.x * 0.65 + oxNoise2(oxXZ * 3.8) * 0.35);
        vec3 colHeather = mix(colHeatherBase, vec3(0.165, 0.046, 0.108), oxBloomDab * 0.82);

        // Dark raw umber Highland peat bog
        vec3 colPeat = mix(vec3(0.026, 0.019, 0.014), vec3(0.062, 0.044, 0.028), oxBrushB.x);

        // Sculpted slate-indigo & warm ochre Highland granite crags
        vec3 oxCrag = oxVoronoi2((oxXZ + oxFlow * 0.45) * 0.44 + oxMed * 0.6);
        float oxCrack = 1.0 - smoothstep(0.0, 0.12, oxCrag.y);
        vec3 colGranite = mix(vec3(0.056, 0.068, 0.082), vec3(0.145, 0.135, 0.122), oxCrag.z * 0.7 + oxBrushB.x * 0.3);
        colGranite = mix(colGranite, vec3(0.095, 0.118, 0.058), smoothstep(0.60, 0.86, oxPsi * 1.25) * (1.0 - oxCrack) * 0.55);
        colGranite *= mix(1.0, 0.24, oxCrack);

        // General Wade's Road: ochre-gravel ridge track with deep umber muddy ruts
        vec3 colRoad = mix(vec3(0.115, 0.094, 0.064), vec3(0.175, 0.142, 0.098), oxBrushF.x);
        colRoad = mix(colRoad, vec3(0.036, 0.025, 0.017), oxRutMask * 0.86);

        // Coastal wet slate shingle
        vec3 colShingle = mix(vec3(0.048, 0.056, 0.066), vec3(0.125, 0.116, 0.102), oxVoronoi2(oxXZ * 1.8).z);

        // Blend pigments & apply painterly stroke value modulation
        vec3 oxAlbedo = colMoss;
        oxAlbedo = mix(oxAlbedo, colHeather, oxHeatherW);
        oxAlbedo = mix(oxAlbedo, colPeat, oxPeatW);
        oxAlbedo = mix(oxAlbedo, colGranite, oxRockW);
        oxAlbedo = mix(oxAlbedo, colRoad, oxRoadW);
        oxAlbedo = mix(oxAlbedo, colShingle, oxShingleW);
        oxAlbedo *= oxDabTone;

        // Wet puddles along Wade's Road ruts & peat hollows (always slightly damp like Scotland, floods in rain!)
        float oxShoreWet = 1.0 - smoothstep(0.0, 1.9, oxY);
        float oxPuddleSeed = oxRutMask * 0.92 + oxPeatW * 0.55;
        float oxPuddle = smoothstep(0.36, 0.70, oxPuddleSeed * (0.58 + uRain * 0.72 + oxFieldWet * 0.38) - oxSlope * 3.0);
        float oxWet = clamp(max(oxShoreWet, max(uRain * 0.85, oxPuddle)), 0.0, 1.0);
        oxAlbedo *= mix(1.0, 0.44, oxWet);

        // Analytical impasto relief normals (fades cleanly with distance for Turner atmospheric wash)
        float oxCamDist = length(oxWPos - cameraPosition);
        float oxDetailFade = 1.0 - smoothstep(32.0, 130.0, oxCamDist);
        float oxEps = 0.09;
        float oxH0 = oxPainterlyRelief(oxXZ, oxFlow, oxRockW, oxRoadW, oxShingleW);
        float oxHX = oxPainterlyRelief(oxXZ + vec2(oxEps, 0.0), oxFlow, oxRockW, oxRoadW, oxShingleW);
        float oxHZ = oxPainterlyRelief(oxXZ + vec2(0.0, oxEps), oxFlow, oxRockW, oxRoadW, oxShingleW);

        float oxBumpStr = mix(0.38, 0.02, oxPuddle) * oxDetailFade;
        vec3 oxNormalPerturb = vec3((oxH0 - oxHX) / oxEps, 0.0, (oxH0 - oxHZ) / oxEps) * oxBumpStr;

        float oxAO = clamp(0.64 + oxH0 * 0.38, 0.44, 1.0) * mix(1.0, 0.40, oxCrack * oxRockW);
        float oxRough = mix(0.90, 0.68, oxRockW * 0.5 + oxShingleW * 0.5);
        oxRough = mix(oxRough, 0.22, oxWet * 0.85);
        oxRough = mix(oxRough, 0.05, oxPuddle);

        diffuseColor.rgb = oxAlbedo;`
      )
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = oxRough;`)
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        normal = normalize((viewMatrix * vec4(normalize(oxWN + oxNormalPerturb), 0.0)).xyz);`
      )
      .replace('#include <aomap_fragment>', OX_CHIAROSCURO_AO_GLSL)
      .replace('#include <fog_fragment>', OX_PAINTERLY_FOG_GLSL);
  };

  return mat;
}

// 2. Painterly Highland Castle, Watchtower & Dry-Stone Masonry Shader
export function createOnixStoneMaterial(sharedUniforms, { coursed = true, tint = 0xffffff } = {}) {
  const mat = new THREE.MeshStandardMaterial({
    color: tint,
    roughness: 0.86,
    metalness: 0.04
  });

  mat.customProgramCacheKey = () => (coursed ? 'onix-oil-stone-v2' : 'onix-oil-boulder-v2');
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, sharedUniforms);
    injectWorldVaryings(shader);

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vOxWorldPos;
        varying vec3 vOxWorldNorm;
        ${OX_COMMON_GLSL}

        vec3 oxStoneCell(vec3 wp, vec3 wn) {
          vec2 uv = abs(wn.x) > abs(wn.z) ? wp.zy : wp.xy;
          if (abs(wn.y) > 0.72) uv = wp.xz;
          ${
            coursed
              ? `
          float row = floor(uv.y * 2.25);
          float rj = oxHash21(vec2(row, 19.3));
          vec2 st = vec2(uv.x * (1.05 + rj * 0.45) + row * 0.58, uv.y * 2.25);
          st += (oxFbm2(uv * 1.9) - 0.5) * 0.14;
          return oxVoronoi2(st);`
              : `
          return oxVoronoi2(uv * 0.72 + oxFbm2(uv * 0.5) * 0.62);`
          }
        }`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec3 oxWN = normalize(vOxWorldNorm);
        vec3 oxWP = vOxWorldPos;
        vec4 oxF = texture2D(uOnixField, oxWP.xz * 0.02);

        vec3 oxV = oxStoneCell(oxWP, oxWN);
        float oxJoint = 1.0 - smoothstep(0.015, 0.115, oxV.y);

        // Directional painterly stone brushwork
        vec2 oxTriUV = abs(oxWN.x) > abs(oxWN.z) ? oxWP.zy : (abs(oxWN.y) > 0.72 ? oxWP.xz : oxWP.xy);
        vec3 oxBrush = oxOilBrush(oxTriUV, vec2(0.92, 0.38), 1.75);

        // Romantic Scottish castle stone palette: cool slate blue-grey + warm sandstone ochre + iron umber
        vec3 stCool = vec3(0.068, 0.080, 0.096);
        vec3 stWarm = vec3(0.155, 0.132, 0.102);
        vec3 oxCol = mix(stCool, stWarm, oxV.z * 0.72 + oxBrush.x * 0.28);

        // Vertical rainwater grime & weathering streaks down tall watchtower/castle walls
        float oxStreak = smoothstep(0.45, 0.85, oxNoise2(vec2((oxWP.x + oxWP.z) * 1.8, oxWP.y * 0.28)));
        oxCol *= mix(1.0, 0.58, oxStreak * (1.0 - abs(oxWN.y)) * 0.65);

        // Lush olive moss creeping along horizontal stone ledges & crevices
        float oxMoss = smoothstep(0.28, 0.75, oxWN.y * 0.82 + oxF.r * 0.52 + (oxBrush.x - 0.5) * 0.35);
        oxCol = mix(oxCol, vec3(0.048, 0.078, 0.028), oxMoss * 0.75);

        // Deep painterly charcoal-indigo mortar shadows
        oxCol = mix(oxCol, vec3(0.014, 0.016, 0.020), oxJoint * 0.92);

        float oxWet = clamp(uRain * (0.5 + max(oxWN.y, 0.0) * 0.5) + oxF.a * 0.22, 0.0, 1.0);
        oxCol *= mix(1.0, 0.52, oxWet);

        // Bold sculpted normal relief on stone bevels + oil impasto
        float oxEps = 0.04;
        float h0 = smoothstep(0.0, 0.15, oxV.y) * 0.78 + oxBrush.y * 0.22;
        float hx = smoothstep(0.0, 0.15, oxStoneCell(oxWP + vec3(oxEps, 0.0, 0.0), oxWN).y) * 0.78 + oxBrush.y * 0.22;
        float hy = smoothstep(0.0, 0.15, oxStoneCell(oxWP + vec3(0.0, oxEps, 0.0), oxWN).y) * 0.78 + oxBrush.y * 0.22;
        float hz = smoothstep(0.0, 0.15, oxStoneCell(oxWP + vec3(0.0, 0.0, oxEps), oxWN).y) * 0.78 + oxBrush.y * 0.22;

        vec3 oxBump = vec3(h0 - hx, h0 - hy, h0 - hz) / oxEps * 0.06;
        float oxAO = mix(1.0, 0.24, oxJoint) * (0.76 + oxBrush.y * 0.24);
        float oxRough = mix(0.86, 0.24, oxWet * (0.45 + max(oxWN.y, 0.0) * 0.55));

        diffuseColor.rgb *= oxCol * 2.25;`
      )
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = oxRough;`)
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        normal = normalize((viewMatrix * vec4(normalize(oxWN + oxBump), 0.0)).xyz);`
      )
      .replace('#include <aomap_fragment>', OX_CHIAROSCURO_AO_GLSL)
      .replace('#include <fog_fragment>', OX_PAINTERLY_FOG_GLSL);
  };

  return mat;
}

// 3. Painterly Heather-Thatch & Mossy Turf Roof Shader
export function createOnixThatchMaterial(sharedUniforms) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.94,
    metalness: 0.0
  });
  mat.customProgramCacheKey = () => 'onix-oil-thatch-v2';
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, sharedUniforms);
    injectWorldVaryings(shader);

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vOxWorldPos;
        varying vec3 vOxWorldNorm;
        ${OX_COMMON_GLSL}`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec3 oxWP = vOxWorldPos;
        vec3 oxWN = normalize(vOxWorldNorm);
        vec4 oxF = texture2D(uOnixField, oxWP.xz * 0.03);

        // Downward-swept golden-straw & heather reed oil strokes
        vec3 brush = oxOilBrush(vec2(oxWP.x + oxWP.z, oxWP.y * 1.4), vec2(0.08, 1.0), 2.4);
        float clump = oxFbm2(oxWP.xz * 1.8);
        vec3 colReed = mix(vec3(0.068, 0.050, 0.028), vec3(0.168, 0.128, 0.068), brush.x * 0.65 + clump * 0.35);
        vec3 colMoss = vec3(0.044, 0.072, 0.026);
        vec3 oxCol = mix(colReed, colMoss, smoothstep(0.46, 0.82, oxF.r * 0.72 + clump * 0.42));
        oxCol *= mix(1.0, 0.56, uRain);

        float oxAO = 0.56 + brush.y * 0.44;
        vec3 oxBump = vec3((brush.y - 0.5) * 0.48, (clump - 0.5) * 0.25, (brush.y - 0.5) * 0.48);
        diffuseColor.rgb = oxCol;`
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        normal = normalize((viewMatrix * vec4(normalize(oxWN + oxBump), 0.0)).xyz);`
      )
      .replace('#include <aomap_fragment>', OX_CHIAROSCURO_AO_GLSL)
      .replace('#include <fog_fragment>', OX_PAINTERLY_FOG_GLSL);
  };
  return mat;
}

// 4. Painterly Scots Pine Bark & Weathered Timber Shader
export function createOnixBarkMaterial(sharedUniforms) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.92,
    metalness: 0.0
  });
  mat.customProgramCacheKey = () => 'onix-oil-bark-v2';
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, sharedUniforms);
    injectWorldVaryings(shader);

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vOxWorldPos;
        varying vec3 vOxWorldNorm;
        ${OX_COMMON_GLSL}`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec3 oxWP = vOxWorldPos;
        vec3 oxWN = normalize(vOxWorldNorm);
        vec2 bp = vec2((oxWP.x + oxWP.z) * 5.2, oxWP.y * 1.1);
        vec3 vor = oxVoronoi2(bp);
        vec3 brush = oxOilBrush(bp, vec2(0.05, 1.0), 1.4);
        float fissure = 1.0 - smoothstep(0.0, 0.14, vor.y);

        vec3 barkLow = vec3(0.052, 0.034, 0.022);
        vec3 barkHigh = vec3(0.142, 0.070, 0.036); // Warm reddish Scots pine upper trunk
        vec3 oxCol = mix(barkLow, barkHigh, smoothstep(1.5, 6.2, oxWP.y - 3.5) * 0.65 + brush.x * 0.35);
        oxCol = mix(oxCol, vec3(0.015, 0.012, 0.011), fissure * 0.86);
        oxCol *= mix(1.0, 0.56, uRain);

        float oxAO = mix(1.0, 0.30, fissure) * (0.76 + brush.y * 0.24);
        vec3 oxBump = vec3((brush.y - 0.5) * 0.45, 0.0, (fissure - 0.3) * 0.5);
        diffuseColor.rgb = oxCol;`
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        normal = normalize((viewMatrix * vec4(normalize(oxWN + oxBump), 0.0)).xyz);`
      )
      .replace('#include <aomap_fragment>', OX_CHIAROSCURO_AO_GLSL)
      .replace('#include <fog_fragment>', OX_PAINTERLY_FOG_GLSL);
  };
  return mat;
}

// 5. Painterly 3D Wind-Coupled Foliage (Grass, Woody Heather Cushions, 3D Scots Pine Boughs)
export function createOnixFoliageMaterial(sharedUniforms, kind = 'grass') {
  const isPine = kind === 'pine';
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: isPine ? 0.84 : 0.74,
    metalness: 0.0,
    side: isPine ? THREE.FrontSide : THREE.DoubleSide
  });

  mat.customProgramCacheKey = () => `onix-oil-foliage-${kind}-v2`;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, sharedUniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D uOnixField;
        uniform float uTime;
        uniform float uRain;
        varying vec3 vOxWorldPos;
        varying vec3 vOxWorldNorm;
        varying float vOxTip;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vOxTip = clamp(position.y * ${isPine ? '0.16' : '1.45'}, 0.0, 1.0);
        #ifdef USE_INSTANCING
          vec4 oxRoot = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          vec4 oxFld = texture2D(uOnixField, oxRoot.xz * 0.015 + vec2(uTime * 0.011, uTime * 0.005));
          vec2 oxWind = (oxFld.gb * 2.0 - 1.0) * (1.0 + uRain * 0.85);
          float oxGust = 0.65 + 0.35 * sin(uTime * 2.3 + oxRoot.x * 0.21 + oxRoot.z * 0.17);
          float oxBend = vOxTip * vOxTip * ${isPine ? '0.15' : kind === 'heather' ? '0.12' : '0.32'} * oxGust;
          transformed.x += oxWind.x * oxBend;
          transformed.z += oxWind.y * oxBend;
          transformed.y -= abs(oxBend) * 0.16;
        #endif`
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vec4 oxWp = vec4(transformed, 1.0);
        vec3 oxWn = objectNormal;
        #ifdef USE_INSTANCING
          oxWp = instanceMatrix * oxWp;
          oxWn = mat3(instanceMatrix) * oxWn;
        #endif
        oxWp = modelMatrix * oxWp;
        oxWn = normalize(mat3(modelMatrix) * oxWn);
        vOxWorldPos = oxWp.xyz;
        vOxWorldNorm = oxWn;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vOxWorldPos;
        varying vec3 vOxWorldNorm;
        varying float vOxTip;
        ${OX_COMMON_GLSL}`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec3 oxBrush = oxOilBrush(vOxWorldPos.xz + vOxWorldPos.y * 0.5, vec2(0.8, 0.6), ${isPine ? '1.35' : '2.8'});
        ${
          isPine
            ? `
        // Rich oil-painted Caledonian pine needle clusters: deep forest indigo shadows -> warm olive-gold tips
        vec3 pineDark = vec3(0.018, 0.036, 0.024);
        vec3 pineLit = vec3(0.072, 0.112, 0.045);
        diffuseColor.rgb *= mix(pineDark, pineLit, clamp(vOxTip * 0.55 + oxBrush.x * 0.45, 0.0, 1.0)) * 2.15;`
            : `
        diffuseColor.rgb *= mix(0.76, 1.24, oxBrush.x) * mix(1.0, 0.60, uRain);`
        }
        // Golden Romantic backlighting through sedge grass & heather blooms toward the sun
        vec3 oxViewW = normalize(vOxWorldPos - cameraPosition);
        float oxBacklit = pow(max(dot(oxViewW, normalize(uSunDir)), 0.0), 3.0) * vOxTip * uDayFactor;
        diffuseColor.rgb += diffuseColor.rgb * uSunColor * oxBacklit * 0.85;
        float oxAO = mix(0.62, 1.0, vOxTip);
        float oxRoughF = mix(${isPine ? '0.84' : '0.72'}, 0.26, uRain);`
      )
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = oxRoughF;`)
      .replace('#include <aomap_fragment>', OX_CHIAROSCURO_AO_GLSL)
      .replace('#include <fog_fragment>', OX_PAINTERLY_FOG_GLSL);
  };
  return mat;
}

// 6. Interactive Painterly Sea-Loch Water Shader (Coupled to Symplectic Ripples + ONIX Currents)
export function createOnixWaterMaterial(sharedUniforms) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0x0c2430,
    roughness: 0.11,
    metalness: 0.24,
    envMapIntensity: 1.85,
    transparent: true,
    opacity: 0.94
  });

  mat.customProgramCacheKey = () => 'onix-oil-water-v2';
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, sharedUniforms);
    injectWorldVaryings(shader);

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D uRippleTex;
        uniform vec2 uRippleOrigin;
        uniform float uRippleWorldSize;
        varying vec3 vOxWorldPos;
        varying vec3 vOxWorldNorm;
        ${OX_COMMON_GLSL}

        float oxSwellHeight(vec2 p, vec2 curr, float t) {
          // Broad painterly sea-loch brushstrokes gliding across Loch Linnhe
          vec2 p1 = p * 0.28 + vec2(t * 0.42, t * 0.18) + curr * 0.55;
          vec2 p2 = p * 0.72 - vec2(t * 0.30, -t * 0.46);
          return oxFbm2(p1) * 0.62 + oxNoise2(p2) * 0.38;
        }`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec2 oxXZ = vOxWorldPos.xz;
        vec4 oxF = texture2D(uOnixField, oxXZ * 0.014);
        vec2 oxCurr = oxF.gb * 2.0 - 1.0;

        // Ambient Atlantic swell normal
        float oxEps = 0.16;
        float w0 = oxSwellHeight(oxXZ, oxCurr, uTime);
        float wx = oxSwellHeight(oxXZ + vec2(oxEps, 0.0), oxCurr, uTime);
        float wz = oxSwellHeight(oxXZ + vec2(0.0, oxEps), oxCurr, uTime);
        float chop = 0.15 + uRain * 0.16;
        vec2 oxWaveGrad = vec2((w0 - wx) / oxEps * chop, (w0 - wz) / oxEps * chop);

        // Live Interactive Symplectic Ripples & Wakes around Callum's boots
        vec2 ripUV = (oxXZ - uRippleOrigin) / uRippleWorldSize + 0.5;
        float oxWakeFoam = 0.0;
        if (ripUV.x > 0.02 && ripUV.x < 0.98 && ripUV.y > 0.02 && ripUV.y < 0.98) {
          vec4 rip = texture2D(uRippleTex, ripUV);
          vec2 ripGrad = (rip.gb * 2.0 - 1.0) * 1.15;
          // Smooth edge feathering so ripple patch blends seamlessly into the open loch
          vec2 edge = smoothstep(0.02, 0.14, ripUV) * (1.0 - smoothstep(0.86, 0.98, ripUV));
          float mask = edge.x * edge.y;
          oxWaveGrad += ripGrad * mask;
          oxWakeFoam = rip.a * mask;
        }

        // Painterly horizontal impasto ripple strokes
        vec3 oxWaterBrush = oxOilBrush(oxXZ + vec2(uTime * 0.35, 0.0), vec2(1.0, 0.15), 0.9);
        vec3 oxWaterN = normalize(vec3(oxWaveGrad.x, 1.0, oxWaveGrad.y));

        vec3 oxViewW = normalize(cameraPosition - vOxWorldPos);
        float fresnel = pow(1.0 - max(dot(oxViewW, oxWaterN), 0.0), 3.6);

        // Deep Highland loch slate-indigo -> luminous painted sky & sun sheen
        vec3 deepCol = vec3(0.016, 0.038, 0.054);
        vec3 shallowRefl = mix(vec3(0.072, 0.108, 0.132), uSunColor * 0.38, pow(fresnel, 1.5) * uDayFactor);
        vec3 oxWaterCol = mix(deepCol, shallowRefl, fresnel) * mix(0.86, 1.16, oxWaterBrush.x);

        // Creamy impasto foam strokes along Callum's wading wake
        float oxFoamStroke = smoothstep(0.18, 0.65, oxWakeFoam * (0.75 + oxWaterBrush.y * 0.55));
        oxWaterCol = mix(oxWaterCol, vec3(0.58, 0.64, 0.66), oxFoamStroke * 0.78);

        float oxRoughW = mix(0.10, 0.52, oxFoamStroke);
        diffuseColor.rgb = oxWaterCol;`
      )
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = oxRoughW;`)
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        normal = normalize((viewMatrix * vec4(oxWaterN, 0.0)).xyz);`
      )
      .replace('#include <fog_fragment>', OX_PAINTERLY_FOG_GLSL);
  };
  return mat;
}

// 7. Painterly Natural-Dyed 1744 Lochaber Wool Plaid Shader (Zero external textures)
export function createOnixPlaidMaterial(sharedUniforms) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.90,
    metalness: 0.0
  });
  mat.customProgramCacheKey = () => 'onix-oil-plaid-v2';
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, sharedUniforms);
    injectWorldVaryings(shader, true);

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vOxWorldPos;
        varying vec3 vOxWorldNorm;
        varying vec2 vOxUv;
        ${OX_COMMON_GLSL}`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec2 u = fract(vOxUv * 3.0);
        // Natural-dyed moss green, peat indigo, madder crimson, and ochre thread
        vec3 col = vec3(0.044, 0.078, 0.044);
        float darkBand = step(0.0, u.x) * step(u.x, 0.26) + step(0.0, u.y) * step(u.y, 0.26);
        float redStripe = step(0.42, u.x) * step(u.x, 0.52) + step(0.42, u.y) * step(u.y, 0.52);
        float goldThread = step(0.76, u.x) * step(u.x, 0.80) + step(0.76, u.y) * step(u.y, 0.80);

        col = mix(col, vec3(0.018, 0.028, 0.032), clamp(darkBand * 0.52, 0.0, 0.86));
        col = mix(col, vec3(0.175, 0.038, 0.030), clamp(redStripe * 0.58, 0.0, 0.9));
        col = mix(col, vec3(0.26, 0.185, 0.068), clamp(goldThread * 0.65, 0.0, 0.9));

        // Tactile painted wool twill weave + rain darkening
        vec3 brush = oxOilBrush(vOxUv * 8.0, vec2(0.7, 0.7), 2.5);
        float twill = 0.84 + 0.24 * sin((vOxUv.x + vOxUv.y) * 240.0);
        diffuseColor.rgb = col * twill * mix(0.84, 1.16, brush.x) * mix(1.0, 0.50, uRain);`
      )
      .replace('#include <fog_fragment>', OX_PAINTERLY_FOG_GLSL);
  };
  return mat;
}
