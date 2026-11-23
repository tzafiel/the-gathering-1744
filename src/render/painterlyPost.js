import * as THREE from 'three';

// Clean Linear HDR Post-Processing Pipeline (ZERO Grain, ZERO Canvas Overlay):
// Pass 1: Render 3D scene -> Linear HDR target
// Pass 2: Quarter-res HDR Bloom Extract + Separable Gaussian Blur (sunbreaks, firelight, parry sparks)
// Pass 3: Clean ACES Filmic Color Grade + subtle damage red vignette -> sRGB Screen

const FULLSCREEN_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export class PainterlyPost {
  constructor(renderer) {
    this.renderer = renderer;
    this.bloomEnabled = true;

    this.orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quadGeo = new THREE.PlaneGeometry(2, 2);
    this.quadMesh = new THREE.Mesh(this.quadGeo, null);
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quadMesh);

    const hasFloat =
      renderer.extensions.has('EXT_color_buffer_float') ||
      renderer.extensions.has('EXT_color_buffer_half_float');
    this.hdrType = hasFloat ? THREE.HalfFloatType : THREE.UnsignedByteType;

    this.width = 1;
    this.height = 1;
    this._createTargets(window.innerWidth, window.innerHeight);
    this._createMaterials();
  }

  _makeRT(w, h, type = THREE.UnsignedByteType, depth = false) {
    return new THREE.WebGLRenderTarget(Math.max(2, w), Math.max(2, h), {
      type,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: depth,
      stencilBuffer: false,
      generateMipmaps: false
    });
  }

  _createTargets(cssW, cssH) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.0);
    const w = Math.max(2, Math.floor(cssW * dpr));
    const h = Math.max(2, Math.floor(cssH * dpr));
    this.width = w;
    this.height = h;

    this.sceneRT?.dispose();
    this.bloomA?.dispose();
    this.bloomB?.dispose();

    this.sceneRT = this._makeRT(w, h, this.hdrType, true);
    this.bloomA = this._makeRT(w >> 2, h >> 2, this.hdrType, false);
    this.bloomB = this._makeRT(w >> 2, h >> 2, this.hdrType, false);
  }

  _createMaterials() {
    this.bloomExtractMat = new THREE.ShaderMaterial({
      uniforms: {
        uSceneTex: { value: this.sceneRT.texture },
        uThreshold: { value: 0.90 }
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D uSceneTex;
        uniform float uThreshold;
        varying vec2 vUv;
        void main() {
          vec3 col = texture2D(uSceneTex, vUv).rgb;
          float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
          float soft = smoothstep(uThreshold, uThreshold + 0.65, lum);
          gl_FragColor = vec4(col * soft, 1.0);
        }
      `
    });

    this.blurMat = new THREE.ShaderMaterial({
      uniforms: {
        uTex: { value: null },
        uDir: { value: new THREE.Vector2(1, 0) }
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D uTex;
        uniform vec2 uDir;
        varying vec2 vUv;
        void main() {
          vec3 sum = texture2D(uTex, vUv).rgb * 0.227027;
          sum += texture2D(uTex, vUv + uDir * 1.384615).rgb * 0.316216;
          sum += texture2D(uTex, vUv - uDir * 1.384615).rgb * 0.316216;
          sum += texture2D(uTex, vUv + uDir * 3.230769).rgb * 0.070270;
          sum += texture2D(uTex, vUv - uDir * 3.230769).rgb * 0.070270;
          gl_FragColor = vec4(sum, 1.0);
        }
      `
    });

    this.finalMat = new THREE.ShaderMaterial({
      uniforms: {
        uSceneTex: { value: this.sceneRT.texture },
        uBloomTex: { value: this.bloomB.texture },
        uExposure: { value: 1.12 },
        uBloomStrength: { value: 0.42 },
        uDamageFlash: { value: 0.0 }
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D uSceneTex;
        uniform sampler2D uBloomTex;
        uniform float uExposure;
        uniform float uBloomStrength;
        uniform float uDamageFlash;
        varying vec2 vUv;

        vec3 acesFilm(vec3 x) {
          float a = 2.51;
          float b = 0.03;
          float c = 2.43;
          float d = 0.59;
          float e = 0.14;
          return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
        }

        void main() {
          vec3 hdr = texture2D(uSceneTex, vUv).rgb;
          vec3 bloom = texture2D(uBloomTex, vUv).rgb;
          vec3 col = (hdr + bloom * uBloomStrength) * uExposure;
          col = acesFilm(col);

          // Crisp Romantic Highland Color Grade (cool slate shadows, warm golden sunbreaks)
          float luma = dot(col, vec3(0.299, 0.587, 0.114));
          col *= mix(vec3(0.93, 0.96, 1.06), vec3(1.05, 1.01, 0.93), smoothstep(0.15, 0.82, luma));
          col = mix(col, col * col * (3.0 - 2.0 * col), 0.14);

          // Subtle cinematic edge framing + visceral crimson pulse when wounded
          vec2 vigUV = vUv * 2.0 - 1.0;
          float dist2 = dot(vigUV * vec2(0.75, 0.95), vigUV * vec2(0.75, 0.95));
          float vig = 1.0 - dist2 * 0.18;
          col *= clamp(vig, 0.72, 1.0);

          if (uDamageFlash > 0.01) {
            float edgeRed = smoothstep(0.22, 1.15, dist2) * uDamageFlash * 0.65;
            col = mix(col, vec3(0.42, 0.02, 0.02), clamp(edgeRed, 0.0, 0.85));
          }

          col = pow(max(col, vec3(0.0)), vec3(1.0 / 2.2));
          gl_FragColor = vec4(col, 1.0);
        }
      `
    });
  }

  setDamageFlash(val) {
    this.finalMat.uniforms.uDamageFlash.value = val;
  }

  resize(cssW, cssH) {
    this._createTargets(cssW, cssH);
    this.bloomExtractMat.uniforms.uSceneTex.value = this.sceneRT.texture;
    this.finalMat.uniforms.uSceneTex.value = this.sceneRT.texture;
    this.finalMat.uniforms.uBloomTex.value = this.bloomB.texture;
  }

  render(scene, camera) {
    const r = this.renderer;

    r.setRenderTarget(this.sceneRT);
    r.clear();
    r.render(scene, camera);

    this.quadMesh.material = this.bloomExtractMat;
    r.setRenderTarget(this.bloomA);
    r.render(this.quadScene, this.orthoCam);

    this.blurMat.uniforms.uTex.value = this.bloomA.texture;
    this.blurMat.uniforms.uDir.value.set(4.0 / this.width, 0.0);
    this.quadMesh.material = this.blurMat;
    r.setRenderTarget(this.bloomB);
    r.render(this.quadScene, this.orthoCam);

    this.blurMat.uniforms.uTex.value = this.bloomB.texture;
    this.blurMat.uniforms.uDir.value.set(0.0, 4.0 / this.height);
    r.setRenderTarget(this.bloomA);
    r.render(this.quadScene, this.orthoCam);

    this.blurMat.uniforms.uTex.value = this.bloomA.texture;
    this.blurMat.uniforms.uDir.value.set(7.0 / this.width, 0.0);
    r.setRenderTarget(this.bloomB);
    r.render(this.quadScene, this.orthoCam);

    this.quadMesh.material = this.finalMat;
    r.setRenderTarget(null);
    r.render(this.quadScene, this.orthoCam);
  }
}
