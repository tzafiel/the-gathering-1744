import * as THREE from 'three';

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

float oxRidge2(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
  for (int i = 0; i < 3; i++) {
    float n = 1.0 - abs(oxNoise2(p) * 2.0 - 1.0);
    v += a * n * n;
    p = rot * p * 2.1 + vec2(3.7, 1.4);
    a *= 0.5;
  }
  return v;
}

// Exact match to General Wade's Road spline in src/world/terrain.js
float oxRoadCenterX(float z) {
  return 88.0 + sin(z * 0.0042) * 46.0 + cos(z * 0.0095) * 18.0;
}
`;

// Turner Atmospheric Oil Mist: valley-trapped mist + glowing golden sunbreak scatter
const OX_PAINTERLY_FOG_GLSL = /* glsl */ `
#ifdef USE_FOG
  {
    float oxHeightMist = exp(-max(vOxWorldPos.y - 2.0, 0.0) * 0.042) * uMistStrength;
    float oxFogD = fogDensity * (1.0 + oxHeightMist * 2.1);
    float oxFogFactor = 1.0 - exp(-oxFogD * oxFogD * vFogDepth * vFogDepth);

    vec3 oxFogViewW = normalize(vOxWorldPos - cameraPosition);
    float oxSunScatter = pow(max(dot(oxFogViewW, normalize(uSunDir)), 0.0), 4.0);
    vec3 oxMistTint = mix(fogColor, uSunColor * 1.15, oxSunScatter * 0.62 * uDayFactor);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, oxMistTint, clamp(oxFogFactor, 0.0, 0.93));
  }
#endif
`;

const OX_CHIAROSCURO_AO_GLSL = /* glsl */ `
#include <aomap_fragment>
  {
    vec3 oxShadowTint = mix(vec3(0.74, 0.84, 1.06), vec3(0.84, 0.89, 1.03), uDayFactor);
    reflectedLight.indirectDiffuse *= oxAO * oxShadowTint;
    reflectedLight.indirectSpecular *= mix(0.35, 1.0, oxAO);
  }
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

// 1. Seamless Geomorphological Highland Terrain Shader (Zero Mosaic Patches!)
export function createOnixTerrainMaterial(sharedUniforms) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.90,
    metalness: 0.02
  });

  mat.customProgramCacheKey = () => 'onix-oil-terrain-v5';
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

        // Smooth continuous organic micro-relief (earth clods, crag strata, gravel)
        float oxGroundHeight(vec2 p, float rockW, float roadW) {
          float soil = oxFbm2(p * 0.85) * 0.65 + oxNoise2(p * 3.4) * 0.35;
          float strata = oxRidge2(p * 0.32 + vec2(oxFbm2(p * 0.14) * 1.4));
          float gravel = oxNoise2(p * 4.5) * 0.55 + oxNoise2(p * 12.0) * 0.45;
          float h = soil * 0.55;
          h = mix(h, strata * 1.35, rockW);
          h = mix(h, gravel * 0.62, roadW);
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

        // ONIX morphogenesis domains (R) + live moisture (A)
        vec4 oxF1 = texture2D(uOnixField, oxXZ * 0.011);
        vec4 oxF2 = texture2D(uOnixField, oxXZ * 0.032 + vec2(0.37, 0.61));
        float oxPsi = clamp(oxF1.r * 0.65 + oxF2.r * 0.35, 0.0, 1.0);
        float oxFieldWet = oxF1.a;

        // Multi-scale domain-warped organic washes (sweeping hills, ZERO geometric tiles)
        vec2 oxWarp = vec2(oxFbm2(oxXZ * 0.025 + 1.7), oxFbm2(oxXZ * 0.025 + 6.3)) - 0.5;
        vec2 oxWP = oxXZ + oxWarp * 10.0;
        float oxMacro = oxFbm2(oxWP * 0.015);
        float oxMed = oxFbm2(oxWP * 0.075);
        float oxFine = oxFbm2(oxXZ * 0.55);
        float oxMicro = oxNoise2(oxXZ * 3.8);
        float oxDrift = oxFbm2(oxWP * 0.024 + vec2(4.1, -2.3));

        // Strata masks
        float oxShingleW = 1.0 - smoothstep(0.15, 2.2, oxY);
        float oxRoadDist = abs(oxXZ.x - oxRoadCenterX(oxXZ.y));
        float oxRoadW = (1.0 - smoothstep(3.1, 5.5, oxRoadDist)) * smoothstep(1.5, 2.8, oxY);
        float oxRockW = smoothstep(0.16, 0.34, oxSlope + (oxMacro - 0.5) * 0.16) + smoothstep(46.0, 74.0, oxY) * 0.85;
        oxRockW = clamp(oxRockW * (1.0 - oxRoadW * 0.85), 0.0, 1.0);

        float oxPeatW = clamp(smoothstep(0.46, 0.74, oxFieldWet + (1.0 - smoothstep(2.0, 14.0, oxY)) * 0.22 - oxSlope * 1.4), 0.0, 1.0);
        oxPeatW *= (1.0 - oxRockW) * (1.0 - oxRoadW) * (1.0 - oxShingleW);

        float oxHeatherW = clamp(smoothstep(0.36, 0.66, oxDrift * 0.58 + oxPsi * 0.42) * smoothstep(3.5, 13.0, oxY), 0.0, 1.0);
        oxHeatherW *= (1.0 - oxRockW) * (1.0 - oxRoadW) * (1.0 - oxShingleW);

        // Muddy wagon ruts along General Wade's Road (reflecting golden dusk sky!)
        float oxRut1 = exp(-pow((oxRoadDist - 1.1) * 2.5, 2.0));
        float oxRut2 = exp(-pow((oxRoadDist - 2.25) * 2.3, 2.0));
        float oxRutMask = clamp((oxRut1 + oxRut2 * 0.78) * oxRoadW, 0.0, 1.0);

        // Rich 1744 Romantic Highland Earth Pigments (matched to concept art)
        // Lush deep emerald moss + sunlit golden bracken & ochre grass washes
        vec3 colMoss = mix(vec3(0.030, 0.058, 0.020), vec3(0.095, 0.112, 0.034), oxMed * 0.68 + oxFine * 0.32);
        colMoss = mix(colMoss, vec3(0.165, 0.125, 0.042), smoothstep(0.50, 0.84, oxMed + oxFine * 0.28) * 0.58);

        // Deep heather moorland: rich peat-olive turf blanketed in velvety purple-plum heather blooms
        vec3 colHeatherStem = mix(vec3(0.034, 0.038, 0.022), vec3(0.056, 0.052, 0.028), oxFine);
        float oxHeatherBloom = smoothstep(0.32, 0.76, oxFine * 0.65 + oxMicro * 0.35);
        vec3 colHeather = mix(colHeatherStem, vec3(0.155, 0.046, 0.105), oxHeatherBloom * 0.84);

        // Dark raw umber Highland peat soil
        vec3 colPeat = mix(vec3(0.022, 0.017, 0.012), vec3(0.056, 0.040, 0.025), oxFine);

        // Layered metamorphic Highland granite crags with creeping olive lichen
        float oxStrata = oxRidge2(oxXZ * 0.32 + oxWarp * 0.25);
        vec3 colGranite = mix(vec3(0.045, 0.054, 0.068), vec3(0.140, 0.132, 0.120), oxStrata * 0.72 + oxFine * 0.28);
        colGranite = mix(colGranite, vec3(0.088, 0.108, 0.050), smoothstep(0.56, 0.84, oxPsi * 1.25) * 0.45);

        // General Wade's crushed gravel military causeway + dark muddy puddles
        vec3 colRoad = mix(vec3(0.102, 0.082, 0.056), vec3(0.165, 0.134, 0.092), oxFine * 0.6 + oxMicro * 0.4);
        colRoad = mix(colRoad, vec3(0.032, 0.022, 0.015), oxRutMask * 0.88);

        // Coastal slate & pebble shingle
        vec3 colShingle = mix(vec3(0.046, 0.054, 0.062), vec3(0.122, 0.114, 0.098), oxFine * 0.55 + oxMicro * 0.45);

        vec3 oxAlbedo = colMoss;
        oxAlbedo = mix(oxAlbedo, colHeather, oxHeatherW);
        oxAlbedo = mix(oxAlbedo, colPeat, oxPeatW);
        oxAlbedo = mix(oxAlbedo, colGranite, oxRockW);
        oxAlbedo = mix(oxAlbedo, colRoad, oxRoadW);
        oxAlbedo = mix(oxAlbedo, colShingle, oxShingleW);

        // Fine natural earth grain
        oxAlbedo *= mix(0.86, 1.14, oxMicro);

        // Standing puddles in Wade's Road wagon ruts & damp coastal shore
        float oxShoreWet = 1.0 - smoothstep(0.0, 2.0, oxY);
        float oxPuddleSeed = oxRutMask * 0.95 + oxPeatW * 0.50;
        float oxPuddle = smoothstep(0.32, 0.64, oxPuddleSeed * (0.64 + uRain * 0.75 + oxFieldWet * 0.35) - oxSlope * 3.0);
        float oxWet = clamp(max(oxShoreWet, max(uRain * 0.85, oxPuddle)), 0.0, 1.0);
        oxAlbedo *= mix(1.0, 0.42, oxWet);

        // Drifting Atlantic cloud shadows sweeping slowly over the Highland glens
        float oxCloudSh = smoothstep(0.42, 0.78, oxFbm2(oxXZ * 0.0028 + vec2(uTime * 0.012, uTime * 0.005)));
        oxAlbedo *= mix(1.0, 0.64, oxCloudSh * 0.68 * uDayFactor);

        // Analytical surface normal relief (smooth soil, crisp stratified crags, glass-smooth puddles)
        float oxCamDist = length(oxWPos - cameraPosition);
        float oxDetailFade = 1.0 - smoothstep(30.0, 125.0, oxCamDist);
        float oxEps = 0.12;
        float oxH0 = oxGroundHeight(oxXZ, oxRockW, oxRoadW);
        float oxHX = oxGroundHeight(oxXZ + vec2(oxEps, 0.0), oxRockW, oxRoadW);
        float oxHZ = oxGroundHeight(oxXZ + vec2(0.0, oxEps), oxRockW, oxRoadW);

        float oxBaseRelief = mix(0.16, 0.48, oxRockW + oxRoadW * 0.35);
        float oxBumpStr = mix(oxBaseRelief, 0.015, oxPuddle) * oxDetailFade;
        vec3 oxNormalPerturb = vec3((oxH0 - oxHX) / oxEps, 0.0, (oxH0 - oxHZ) / oxEps) * oxBumpStr;

        float oxAO = clamp(0.70 + oxH0 * 0.34, 0.48, 1.0);
        float oxRough = mix(0.92, 0.68, oxRockW * 0.5 + oxShingleW * 0.5);
        oxRough = mix(oxRough, 0.20, oxWet * 0.85);
        oxRough = mix(oxRough, 0.04, oxPuddle);

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

// 2. Distant Lochaber & Ardgour Munro Mountain Shader (Grounded, Sun-Caught Turner Ridges)
export function createOnixHorizonMaterial(sharedUniforms) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.92,
    metalness: 0.0
  });

  mat.customProgramCacheKey = () => 'onix-oil-horizon-v5';
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
        vec3 oxWN = normalize(vOxWorldNorm);
        vec2 oxXZ = vOxWorldPos.xz;
        float oxY = vOxWorldPos.y;
        float oxSlope = 1.0 - clamp(oxWN.y, 0.0, 1.0);

        float mNoise = oxFbm2(oxXZ * 0.0032);
        float detail = oxFbm2(oxXZ * 0.014);
        float heatherBand = smoothstep(8.0, 72.0, oxY) * (1.0 - smoothstep(115.0, 195.0, oxY));
        float cragMask = smoothstep(0.18, 0.42, oxSlope + (mNoise - 0.5) * 0.22) + smoothstep(130.0, 225.0, oxY);

        vec3 baseGrass = mix(vec3(0.044, 0.072, 0.030), vec3(0.095, 0.098, 0.042), detail);
        vec3 baseHeather = vec3(0.115, 0.052, 0.088);
        vec3 basePeak = vec3(0.074, 0.084, 0.104);

        vec3 oxCol = mix(baseGrass, baseHeather, clamp(heatherBand * (0.45 + mNoise * 0.72), 0.0, 1.0));
        oxCol = mix(oxCol, basePeak, clamp(cragMask, 0.0, 1.0));

        float cloudSh = smoothstep(0.42, 0.78, oxFbm2(oxXZ * 0.0024 + vec2(uTime * 0.012, uTime * 0.005)));
        oxCol *= mix(1.0, 0.60, cloudSh * 0.68 * uDayFactor);

        float oxAO = 0.88;
        diffuseColor.rgb = oxCol;`
      )
      .replace('#include <aomap_fragment>', OX_CHIAROSCURO_AO_GLSL)
      .replace('#include <fog_fragment>', OX_PAINTERLY_FOG_GLSL);
  };

  return mat;
}

// 3. Authentic Coursed Scottish Castle & Dry-Stone Masonry Shader (ZERO Cartoon Black Voronoi!)
export function createOnixStoneMaterial(sharedUniforms, { coursed = true, tint = 0xffffff } = {}) {
  const mat = new THREE.MeshStandardMaterial({
    color: tint,
    roughness: 0.86,
    metalness: 0.04
  });

  mat.customProgramCacheKey = () => (coursed ? 'onix-oil-stone-v5' : 'onix-oil-boulder-v5');
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

        // Authentic horizontal-coursed Scottish fieldstone ashlar (returns x=height, y=mortarMask, z=stoneID)
        vec3 oxCoursedStone(vec3 wp, vec3 wn) {
          vec2 uv = abs(wn.x) > abs(wn.z) ? wp.zy : wp.xy;
          if (abs(wn.y) > 0.72) uv = wp.xz;
          ${
            coursed
              ? `
          // Natural horizontal masonry courses with subtle hand-hewn wobble
          float wobbleY = (oxFbm2(uv * 1.4) - 0.5) * 0.10;
          float rowCoord = uv.y * 2.75 + wobbleY;
          float rowIdx = floor(rowCoord);
          float rowF = fract(rowCoord);

          // Variable stone block lengths per course
          float rowSeed = oxHash21(vec2(rowIdx, 17.3));
          float colScale = 1.15 + rowSeed * 0.55;
          float colCoord = uv.x * colScale + rowSeed * 3.7 + (oxNoise2(uv * 3.1) - 0.5) * 0.08;
          float colIdx = floor(colCoord);
          float colF = fract(colCoord);

          float stoneId = oxHash21(vec2(colIdx, rowIdx * 13.7));
          float hEdge = min(rowF, 1.0 - rowF);
          float vEdge = min(colF, 1.0 - colF);

          // Soft weathered mortar seam (NOT a thick black comic outline!)
          float mortarH = 1.0 - smoothstep(0.025, 0.11, hEdge);
          float mortarV = 1.0 - smoothstep(0.02, 0.085, vEdge);
          float mortar = clamp(max(mortarH, mortarV * 0.85), 0.0, 1.0);

          float bevel = smoothstep(0.0, 0.16, hEdge) * smoothstep(0.0, 0.14, vEdge);
          float faceGrain = oxFbm2(uv * 4.5 + stoneId * 9.0);
          float h = bevel * (0.65 + faceGrain * 0.35);
          return vec3(h, mortar, stoneId);`
              : `
          // Sculpted Highland granite boulder with layered glacial striations
          float strata = oxRidge2(uv * 0.75 + oxFbm2(uv * 0.35) * 0.9);
          float grain = oxFbm2(uv * 3.4);
          float crack = (1.0 - smoothstep(0.04, 0.14, abs(oxNoise2(uv * 1.2) - 0.5))) * 0.55;
          return vec3(strata * 0.7 + grain * 0.3, crack, grain);`
          }
        }`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec3 oxWN = normalize(vOxWorldNorm);
        vec3 oxWP = vOxWorldPos;
        vec4 oxF = texture2D(uOnixField, oxWP.xz * 0.02);

        vec3 oxSt = oxCoursedStone(oxWP, oxWN);
        float oxH = oxSt.x;
        float oxMortar = oxSt.y;
        float oxId = oxSt.z;

        float oxWeather = oxFbm2(vec2((oxWP.x + oxWP.z) * 0.85, oxWP.y * 0.25));
        float oxGrain = oxFbm2(oxWP.xz * 3.5 + oxWP.y * 2.5);

        // Weathered Scottish granite & sandstone tones (cool slate grey, warm buff, iron rust)
        vec3 stCool = vec3(0.072, 0.082, 0.094);
        vec3 stWarm = vec3(0.152, 0.132, 0.104);
        vec3 stBuff = vec3(0.118, 0.112, 0.098);
        vec3 oxCol = mix(stCool, stWarm, oxId * 0.75 + oxGrain * 0.25);
        oxCol = mix(oxCol, stBuff, smoothstep(0.35, 0.75, oxWeather) * 0.45);

        // Vertical rainwater dark streaks down tall keep & cottage walls
        float oxStreak = smoothstep(0.48, 0.86, oxNoise2(vec2((oxWP.x + oxWP.z) * 1.6, oxWP.y * 0.22)));
        oxCol *= mix(1.0, 0.64, oxStreak * (1.0 - abs(oxWN.y)) * 0.55);

        // Organic Highland moss & pale lichen clinging to damp stone ledges & base
        float oxMoss = smoothstep(0.32, 0.78, oxWN.y * 0.85 + oxF.r * 0.45 + (oxGrain - 0.5) * 0.38);
        oxCol = mix(oxCol, vec3(0.044, 0.074, 0.026), oxMoss * 0.72);

        // Soft warm-umber mortar joints (subtle grounded depth, zero harsh black outlines)
        vec3 mortarCol = vec3(0.036, 0.035, 0.032);
        oxCol = mix(oxCol, mortarCol, oxMortar * 0.72);

        float oxWet = clamp(uRain * (0.5 + max(oxWN.y, 0.0) * 0.5) + oxF.a * 0.20, 0.0, 1.0);
        oxCol *= mix(1.0, 0.54, oxWet);

        // Soft sculpted normal relief across courses & rock grain
        float oxEps = 0.045;
        float hx = oxCoursedStone(oxWP + vec3(oxEps, 0.0, 0.0), oxWN).x;
        float hy = oxCoursedStone(oxWP + vec3(0.0, oxEps, 0.0), oxWN).x;
        float hz = oxCoursedStone(oxWP + vec3(0.0, 0.0, oxEps), oxWN).x;

        vec3 oxBump = vec3(oxH - hx, oxH - hy, oxH - hz) / oxEps * 0.045;
        float oxAO = mix(1.0, 0.52, oxMortar) * (0.78 + oxGrain * 0.22);
        float oxRough = mix(0.86, 0.26, oxWet * (0.45 + max(oxWN.y, 0.0) * 0.55));

        diffuseColor.rgb *= oxCol * 2.15;`
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

// 4. Painterly Heather-Thatch & Mossy Turf Roof Shader
export function createOnixThatchMaterial(sharedUniforms) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.94,
    metalness: 0.0
  });
  mat.customProgramCacheKey = () => 'onix-oil-thatch-v5';
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

        // Combed golden-brown heather thatch reeds
        float reed = oxFbm2(vec2((oxWP.x + oxWP.z) * 7.5, oxWP.y * 1.4));
        float clump = oxFbm2(oxWP.xz * 1.6);
        vec3 colReed = mix(vec3(0.068, 0.050, 0.028), vec3(0.168, 0.128, 0.068), reed * 0.65 + clump * 0.35);
        vec3 colMoss = vec3(0.044, 0.072, 0.026);
        vec3 oxCol = mix(colReed, colMoss, smoothstep(0.46, 0.82, oxF.r * 0.72 + clump * 0.42));
        oxCol *= mix(1.0, 0.56, uRain);

        float oxAO = 0.62 + reed * 0.38;
        vec3 oxBump = vec3((reed - 0.5) * 0.35, (clump - 0.5) * 0.22, (reed - 0.5) * 0.35);
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

// 5. Painterly Scots Pine Bark & Weathered Timber Shader
export function createOnixBarkMaterial(sharedUniforms) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.92,
    metalness: 0.0
  });
  mat.customProgramCacheKey = () => 'onix-oil-bark-v5';
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
        vec2 bp = vec2((oxWP.x + oxWP.z) * 4.5, oxWP.y * 0.95);
        float barkRidge = oxRidge2(bp);
        float grain = oxFbm2(bp * 2.4);

        vec3 barkLow = vec3(0.048, 0.032, 0.020);
        vec3 barkHigh = vec3(0.142, 0.068, 0.036);
        vec3 oxCol = mix(barkLow, barkHigh, smoothstep(1.5, 6.2, oxWP.y - 3.5) * 0.6 + barkRidge * 0.4);
        oxCol *= (0.72 + grain * 0.45) * mix(1.0, 0.58, uRain);

        float oxAO = 0.56 + barkRidge * 0.44;
        vec3 oxBump = vec3((grain - 0.5) * 0.35, 0.0, (barkRidge - 0.5) * 0.42);
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

// 6. Feathered Painterly Foliage Shader (Distance Height-Sink Fade + ONIX Wind + Golden Backlighting)
export function createOnixFoliageMaterial(
  sharedUniforms,
  { kind = 'grass', map = null, fadeStart = 44.0, fadeEnd = 86.0 } = {}
) {
  const isPine = kind === 'pine';
  const hasFade = !isPine && fadeEnd < 500.0;

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: map || null,
    alphaTest: map ? 0.34 : 0.0,
    vertexColors: true,
    roughness: isPine ? 0.84 : 0.78,
    metalness: 0.0,
    side: THREE.DoubleSide
  });

  mat.customProgramCacheKey = () => `onix-oil-foliage-${kind}-${map ? 'tex' : 'mesh'}-v5`;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, sharedUniforms);
    shader.uniforms.uFadeStart = { value: fadeStart };
    shader.uniforms.uFadeEnd = { value: fadeEnd };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D uOnixField;
        uniform float uTime;
        uniform float uRain;
        uniform float uFadeStart;
        uniform float uFadeEnd;
        varying vec3 vOxWorldPos;
        varying vec3 vOxWorldNorm;
        varying float vOxTip;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vOxTip = ${isPine ? 'clamp((position.y - 3.6) / 4.8, 0.0, 1.0)' : 'clamp(position.y * 1.45, 0.0, 1.0)'};
        #ifdef USE_INSTANCING
          vec4 oxRoot = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          ${
            hasFade
              ? `
          float oxDistCam = length(oxRoot.xz - cameraPosition.xz);
          float oxSink = 1.0 - smoothstep(uFadeStart, uFadeEnd, oxDistCam);
          transformed.y *= oxSink;
          transformed.xz *= mix(0.65, 1.0, oxSink);`
              : ''
          }
          vec4 oxFld = texture2D(uOnixField, oxRoot.xz * 0.015 + vec2(uTime * 0.011, uTime * 0.005));
          vec2 oxWind = (oxFld.gb * 2.0 - 1.0) * (1.0 + uRain * 0.9);
          float oxGust = 0.62 + 0.38 * sin(uTime * 2.1 + oxRoot.x * 0.18 + oxRoot.z * 0.14);
          float oxBend = vOxTip * vOxTip * ${isPine ? '0.18' : kind === 'heather' ? '0.10' : '0.26'} * oxGust;
          transformed.x += oxWind.x * oxBend;
          transformed.z += oxWind.y * oxBend;
          transformed.y -= abs(oxBend) * 0.14;
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
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          float oxVar = oxFbm2(vOxWorldPos.xz * 0.12);
          float oxFCloud = smoothstep(0.42, 0.78, oxFbm2(vOxWorldPos.xz * 0.0028 + vec2(uTime * 0.012, uTime * 0.005)));
          diffuseColor.rgb *= mix(0.84, 1.18, oxVar) * mix(1.0, 0.62, uRain);
          diffuseColor.rgb *= mix(1.0, 0.64, oxFCloud * 0.68 * uDayFactor);

          vec3 oxFolViewW = normalize(vOxWorldPos - cameraPosition);
          float oxBacklit = pow(max(dot(oxFolViewW, normalize(uSunDir)), 0.0), 3.0) * vOxTip * uDayFactor;
          diffuseColor.rgb += diffuseColor.rgb * uSunColor * oxBacklit * ${isPine ? '0.72' : '0.95'};
        }`
      )
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = mix(${isPine ? '0.84' : '0.76'}, 0.28, uRain);`)
      .replace(
        '#include <aomap_fragment>',
        `float oxAO = mix(${isPine ? '0.58' : '0.84'}, 1.0, vOxTip);
        ${OX_CHIAROSCURO_AO_GLSL}`
      )
      .replace('#include <fog_fragment>', OX_PAINTERLY_FOG_GLSL);
  };
  return mat;
}

// 7. Interactive Painterly Sea-Loch Water Shader (Symplectic Ripples + ONIX Currents + Golden Sun Path)
export function createOnixWaterMaterial(sharedUniforms) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0x0c2430,
    roughness: 0.11,
    metalness: 0.22,
    envMapIntensity: 1.95,
    transparent: true,
    opacity: 0.94
  });

  mat.customProgramCacheKey = () => 'onix-oil-water-v5';
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

        float oxEps = 0.16;
        float w0 = oxSwellHeight(oxXZ, oxCurr, uTime);
        float wx = oxSwellHeight(oxXZ + vec2(oxEps, 0.0), oxCurr, uTime);
        float wz = oxSwellHeight(oxXZ + vec2(0.0, oxEps), oxCurr, uTime);
        float chop = 0.16 + uRain * 0.16;
        vec2 oxWaveGrad = vec2((w0 - wx) / oxEps * chop, (w0 - wz) / oxEps * chop);

        vec2 ripUV = (oxXZ - uRippleOrigin) / uRippleWorldSize + 0.5;
        float oxWakeFoam = 0.0;
        if (ripUV.x > 0.02 && ripUV.x < 0.98 && ripUV.y > 0.02 && ripUV.y < 0.98) {
          vec4 rip = texture2D(uRippleTex, ripUV);
          vec2 ripGrad = (rip.gb * 2.0 - 1.0) * 1.15;
          vec2 edge = smoothstep(0.02, 0.14, ripUV) * (1.0 - smoothstep(0.86, 0.98, ripUV));
          float mask = edge.x * edge.y;
          oxWaveGrad += ripGrad * mask;
          oxWakeFoam = rip.a * mask;
        }

        vec3 oxWaterN = normalize(vec3(oxWaveGrad.x, 1.0, oxWaveGrad.y));
        vec3 oxWatViewW = normalize(cameraPosition - vOxWorldPos);
        float fresnel = pow(1.0 - max(dot(oxWatViewW, oxWaterN), 0.0), 3.4);

        vec3 deepCol = vec3(0.016, 0.036, 0.056);
        vec3 shallowRefl = mix(vec3(0.075, 0.112, 0.138), uSunColor * 0.42, pow(fresnel, 1.4) * uDayFactor);
        vec3 oxWaterCol = mix(deepCol, shallowRefl, fresnel);

        float oxFoamStroke = smoothstep(0.18, 0.65, oxWakeFoam);
        oxWaterCol = mix(oxWaterCol, vec3(0.62, 0.66, 0.68), oxFoamStroke * 0.78);

        float oxRoughW = mix(0.09, 0.50, oxFoamStroke);
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

// 8. Natural-Dyed 1744 Lochaber Wool Plaid Shader
export function createOnixPlaidMaterial(sharedUniforms) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.90,
    metalness: 0.0
  });
  mat.customProgramCacheKey = () => 'onix-oil-plaid-v5';
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
        vec3 col = vec3(0.044, 0.078, 0.044);
        float darkBand = step(0.0, u.x) * step(u.x, 0.26) + step(0.0, u.y) * step(u.y, 0.26);
        float redStripe = step(0.42, u.x) * step(u.x, 0.52) + step(0.42, u.y) * step(u.y, 0.52);
        float goldThread = step(0.76, u.x) * step(u.x, 0.80) + step(0.76, u.y) * step(u.y, 0.80);

        col = mix(col, vec3(0.018, 0.028, 0.032), clamp(darkBand * 0.52, 0.0, 0.86));
        col = mix(col, vec3(0.175, 0.038, 0.030), clamp(redStripe * 0.58, 0.0, 0.9));
        col = mix(col, vec3(0.26, 0.185, 0.068), clamp(goldThread * 0.65, 0.0, 0.9));

        float twill = 0.84 + 0.24 * sin((vOxUv.x + vOxUv.y) * 240.0);
        diffuseColor.rgb = col * twill * mix(1.0, 0.50, uRain);`
      )
      .replace('#include <fog_fragment>', OX_PAINTERLY_FOG_GLSL);
  };
  return mat;
}
