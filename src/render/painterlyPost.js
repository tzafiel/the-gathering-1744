import * as THREE from 'three';

// 5-Pass Real-Time Romantic Oil Painting Post-Processing Engine
// Pass 1: Render 3D scene -> Linear HDR target
// Pass 2: Quarter-res HDR Bloom Extract + Separable Gaussian Blur (Turner sunbreaks & fire glow)
// Pass 3: HDR Composite + Romantic ACES Filmic Color Grading -> Balanced Linear target
// Pass 4: Half-res Structure Tensor (exact local ridge/edge orientation & anisotropy)
// Pass 5: Anisotropic Kuwahara Oil-Brush Filter + Impasto Relief + Linen Weave + Vignette -> Screen

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
    this.oilStrength = 1.0; // Toggleable live with [P] key (1.0 = Full Oil Painting, 0.0 = Raw 3D)

    this.orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quadGeo = new THREE.PlaneGeometry(2, 2);
    this.quadMesh = new THREE.Mesh(this.quadGeo, null);
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quadMesh);

    // Use HalfFloat HDR render targets when supported for genuine sun/firelight bloom
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
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    const w = Math.max(2, Math.floor(cssW * dpr));
    const h = Math.max(2, Math.floor(cssH * dpr));
    this.width = w;
    this.height = h;

    this.sceneRT?.dispose();
    this.bloomA?.dispose();
    this.bloomB?.dispose();
    this.compositeRT?.dispose();
    this.tensorRT?.dispose();

    this.sceneRT = this._makeRT(w, h, this.hdrType, true);
    this.bloomA = this._makeRT(w >> 2, h >> 2, this.hdrType, false);
    this.bloomB = this._makeRT(w >> 2, h >> 2, this.hdrType, false);
    this.compositeRT = this._makeRT(w, h, THREE.UnsignedByteType, false);
    this.tensorRT = this._makeRT(w >> 1, h >> 1, THREE.UnsignedByteType, false);
  }

  _createMaterials() {
    // Pass 2A: Extract warm sunbreak & firelight radiance for Turner atmospheric bloom
    this.bloomExtractMat = new THREE.ShaderMaterial({
      uniforms: {
        uSceneTex: { value: this.sceneRT.texture },
        uThreshold: { value: 0.88 }
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

    // Pass 2B / 2C: Separable 9-tap Gaussian Blur
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

    // Pass 3: Combine Scene + Bloom -> Romantic Chiaroscuro ACES Filmic Grade
    this.compositeMat = new THREE.ShaderMaterial({
      uniforms: {
        uSceneTex: { value: this.sceneRT.texture },
        uBloomTex: { value: this.bloomB.texture },
        uExposure: { value: 1.12 },
        uBloomStrength: { value: 0.44 }
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D uSceneTex;
        uniform sampler2D uBloomTex;
        uniform float uExposure;
        uniform float uBloomStrength;
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

          // Romantic Highland Oil Pigment Color Grade:
          // Deepen shadows into cool Atlantic slate-indigo while warming sunlit ochres & heather
          float luma = dot(col, vec3(0.299, 0.587, 0.114));
          vec3 shadowLift = vec3(0.92, 0.96, 1.08);
          vec3 highWarm = vec3(1.06, 1.01, 0.92);
          col *= mix(shadowLift, highWarm, smoothstep(0.15, 0.80, luma));

          // Subtle painterly contrast S-curve + natural pigment richness
          col = mix(col, col * col * (3.0 - 2.0 * col), 0.16);
          float g = dot(col, vec3(0.299, 0.587, 0.114));
          col = mix(vec3(g), col, 1.12);

          gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
        }
      `
    });

    // Pass 4: Half-Res Structure Tensor (tracks exact edge flow & anisotropy without noise)
    this.tensorMat = new THREE.ShaderMaterial({
      uniforms: {
        uTex: { value: this.compositeRT.texture },
        uTexel: { value: new THREE.Vector2(1 / this.width, 1 / this.height) }
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D uTex;
        uniform vec2 uTexel;
        varying vec2 vUv;

        float luma(vec2 uv) {
          vec3 c = texture2D(uTex, uv).rgb;
          return dot(c, vec3(0.299, 0.587, 0.114));
        }

        void main() {
          vec2 d = uTexel * 1.5;
          // 3x3 Sobel luminance gradient
          float tl = luma(vUv + vec2(-d.x,  d.y));
          float tc = luma(vUv + vec2( 0.0,  d.y));
          float tr = luma(vUv + vec2( d.x,  d.y));
          float ml = luma(vUv + vec2(-d.x,  0.0));
          float mr = luma(vUv + vec2( d.x,  0.0));
          float bl = luma(vUv + vec2(-d.x, -d.y));
          float bc = luma(vUv + vec2( 0.0, -d.y));
          float br = luma(vUv + vec2( d.x, -d.y));

          float gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
          float gy = (tl + 2.0 * tc + tr) - (bl + 2.0 * bc + br);

          float E = gx * gx;
          float F = gx * gy;
          float G = gy * gy;
          float trace = E + G + 0.0004;

          // Normalized double-angle orientation vector in [-1, 1] -> safe in 8-bit texture!
          float nx = (E - G) / trace;
          float ny = (2.0 * F) / trace;
          float edgeMag = clamp(sqrt(E + G) * 2.5, 0.0, 1.0);

          gl_FragColor = vec4(nx * 0.5 + 0.5, ny * 0.5 + 0.5, edgeMag, 1.0);
        }
      `
    });

    // Pass 5: Real-Time Anisotropic Kuwahara Oil-Painting Pass + Impasto Relief + Linen Canvas
    this.oilFinalMat = new THREE.ShaderMaterial({
      uniforms: {
        uColorTex: { value: this.compositeRT.texture },
        uTensorTex: { value: this.tensorRT.texture },
        uTexel: { value: new THREE.Vector2(1 / this.width, 1 / this.height) },
        uTensorTexel: { value: new THREE.Vector2(2 / this.width, 2 / this.height) },
        uOilStrength: { value: this.oilStrength }
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D uColorTex;
        uniform sampler2D uTensorTex;
        uniform vec2 uTexel;
        uniform vec2 uTensorTexel;
        uniform float uOilStrength;
        varying vec2 vUv;

        float hash21(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }

        void main() {
          vec3 rawCol = texture2D(uColorTex, vUv).rgb;
          vec3 finalCol = rawCol;

          if (uOilStrength > 0.01) {
            // 9-tap smoothed structure tensor -> silky coherent brushstrokes across ridges & clouds
            vec2 stSum = vec2(0.0);
            float edgeSum = 0.0;
            for (int y = -1; y <= 1; y++) {
              for (int x = -1; x <= 1; x++) {
                vec3 t = texture2D(uTensorTex, vUv + vec2(float(x), float(y)) * uTensorTexel * 1.6).rgb;
                stSum += (t.rg * 2.0 - 1.0);
                edgeSum += t.b;
              }
            }
            stSum /= 9.0;
            float aniso = clamp(length(stSum), 0.0, 1.0);
            float phi = 0.5 * atan(stSum.y, stSum.x);

            // Tangent flows ALONG edges (never smears across silhouettes!); normal sits across edge
            vec2 dirT = vec2(-sin(phi), cos(phi));
            vec2 dirN = vec2(cos(phi), sin(phi));

            // Brushstroke aspect ratio: broad along contours, tight across detail edges
            float brushRadius = 1.15;
            float stretchT = brushRadius * (1.0 + aniso * 0.95);
            float stretchN = brushRadius / (1.0 + aniso * 0.72);

            // Generalized 4-Sector Anisotropic Kuwahara Filter (7x7 kernel -> crisp oil dabs)
            vec3 m0 = vec3(0.0), m1 = vec3(0.0), m2 = vec3(0.0), m3 = vec3(0.0);
            vec3 s0 = vec3(0.0), s1 = vec3(0.0), s2 = vec3(0.0), s3 = vec3(0.0);
            float c0 = 0.0, c1 = 0.0, c2 = 0.0, c3 = 0.0;

            for (int j = -3; j <= 3; j++) {
              for (int i = -3; i <= 3; i++) {
                vec2 p = vec2(float(i), float(j));
                // Circular brush footprint avoids boxy pixel artifacts
                float r2 = dot(p, p);
                if (r2 > 10.5) continue;

                vec2 offset = (dirT * (p.x * stretchT) + dirN * (p.y * stretchN)) * uTexel;
                vec3 col = texture2D(uColorTex, vUv + offset).rgb;
                vec3 col2 = col * col;
                float gw = exp(-r2 * 0.09);

                if (i <= 0 && j <= 0) { m0 += col * gw; s0 += col2 * gw; c0 += gw; }
                if (i >= 0 && j <= 0) { m1 += col * gw; s1 += col2 * gw; c1 += gw; }
                if (i <= 0 && j >= 0) { m2 += col * gw; s2 += col2 * gw; c2 += gw; }
                if (i >= 0 && j >= 0) { m3 += col * gw; s3 += col2 * gw; c3 += gw; }
              }
            }

            m0 /= c0; s0 = abs(s0 / c0 - m0 * m0);
            m1 /= c1; s1 = abs(s1 / c1 - m1 * m1);
            m2 /= c2; s2 = abs(s2 / c2 - m2 * m2);
            m3 /= c3; s3 = abs(s3 / c3 - m3 * m3);

            vec3 lW = vec3(0.299, 0.587, 0.114);
            float v0 = dot(s0, lW);
            float v1 = dot(s1, lW);
            float v2 = dot(s2, lW);
            float v3 = dot(s3, lW);

            // Smooth sharpness weighting prevents flickering while keeping oil-paint crispness
            float kSharp = 260.0;
            float w0 = 1.0 / (1.0 + pow(v0 * kSharp, 2.2));
            float w1 = 1.0 / (1.0 + pow(v1 * kSharp, 2.2));
            float w2 = 1.0 / (1.0 + pow(v2 * kSharp, 2.2));
            float w3 = 1.0 / (1.0 + pow(v3 * kSharp, 2.2));

            vec3 oilCol = (m0 * w0 + m1 * w1 + m2 * w2 + m3 * w3) / (w0 + w1 + w2 + w3 + 0.0001);

            // Subtle impasto ridge lighting along paint transitions + fine woven canvas texture
            vec2 pxCoord = vUv / uTexel;
            float weave = sin(pxCoord.x * 1.15) * sin(pxCoord.y * 1.15) * 0.012;
            float grain = (hash21(floor(pxCoord * 0.5)) - 0.5) * 0.014;
            float impastoSpec = clamp((edgeSum / 9.0) * 0.045, 0.0, 0.05);

            oilCol += vec3(weave + grain + impastoSpec * (0.4 + dot(oilCol, lW)));
            finalCol = mix(rawCol, oilCol, uOilStrength);
          }

          // Subtle Romantic framing vignette (draws eye into the sunlit glen)
          vec2 vigUV = vUv * 2.0 - 1.0;
          float vig = 1.0 - dot(vigUV * vec2(0.75, 0.95), vigUV * vec2(0.75, 0.95)) * 0.22;
          finalCol *= clamp(vig, 0.68, 1.0);

          // Linear -> sRGB display encoding
          finalCol = pow(max(finalCol, vec3(0.0)), vec3(1.0 / 2.2));
          gl_FragColor = vec4(finalCol, 1.0);
        }
      `
    });
  }

  resize(cssW, cssH) {
    this._createTargets(cssW, cssH);
    this.bloomExtractMat.uniforms.uSceneTex.value = this.sceneRT.texture;
    this.compositeMat.uniforms.uSceneTex.value = this.sceneRT.texture;
    this.compositeMat.uniforms.uBloomTex.value = this.bloomB.texture;
    this.tensorMat.uniforms.uTex.value = this.compositeRT.texture;
    this.tensorMat.uniforms.uTexel.value.set(1 / this.width, 1 / this.height);
    this.oilFinalMat.uniforms.uColorTex.value = this.compositeRT.texture;
    this.oilFinalMat.uniforms.uTensorTex.value = this.tensorRT.texture;
    this.oilFinalMat.uniforms.uTexel.value.set(1 / this.width, 1 / this.height);
    this.oilFinalMat.uniforms.uTensorTexel.value.set(2 / this.width, 2 / this.height);
  }

  toggleOilMode() {
    this.oilStrength = this.oilStrength > 0.5 ? 0.0 : 1.0;
    this.oilFinalMat.uniforms.uOilStrength.value = this.oilStrength;
    return this.oilStrength > 0.5;
  }

  render(scene, camera) {
    const r = this.renderer;

    // Pass 1: Render 3D world to linear HDR buffer
    r.setRenderTarget(this.sceneRT);
    r.clear();
    r.render(scene, camera);

    // Pass 2A: Bloom threshold extract -> bloomA
    this.quadMesh.material = this.bloomExtractMat;
    r.setRenderTarget(this.bloomA);
    r.render(this.quadScene, this.orthoCam);

    // Pass 2B: Horizontal Gaussian blur -> bloomB
    this.blurMat.uniforms.uTex.value = this.bloomA.texture;
    this.blurMat.uniforms.uDir.value.set(4.0 / this.width, 0.0);
    this.quadMesh.material = this.blurMat;
    r.setRenderTarget(this.bloomB);
    r.render(this.quadScene, this.orthoCam);

    // Pass 2C: Vertical Gaussian blur -> bloomA -> back into bloomB for lush wide Turner glow
    this.blurMat.uniforms.uTex.value = this.bloomB.texture;
    this.blurMat.uniforms.uDir.value.set(0.0, 4.0 / this.height);
    r.setRenderTarget(this.bloomA);
    r.render(this.quadScene, this.orthoCam);

    this.blurMat.uniforms.uTex.value = this.bloomA.texture;
    this.blurMat.uniforms.uDir.value.set(7.0 / this.width, 0.0);
    r.setRenderTarget(this.bloomB);
    r.render(this.quadScene, this.orthoCam);

    // Pass 3: HDR Composite + Romantic ACES Color Grade -> compositeRT
    this.quadMesh.material = this.compositeMat;
    r.setRenderTarget(this.compositeRT);
    r.render(this.quadScene, this.orthoCam);

    // Pass 4: Half-Res Structure Tensor -> tensorRT (skip if oil mode toggled off)
    if (this.oilStrength > 0.01) {
      this.quadMesh.material = this.tensorMat;
      r.setRenderTarget(this.tensorRT);
      r.render(this.quadScene, this.orthoCam);
    }

    // Pass 5: Anisotropic Kuwahara Oil-Painting Pass -> Screen
    this.quadMesh.material = this.oilFinalMat;
    r.setRenderTarget(null);
    r.render(this.quadScene, this.orthoCam);
  }
}
