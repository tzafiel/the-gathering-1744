import { clamp } from '../core/prng.js';
import { LANDMARKS, WATER_LEVEL } from '../world/terrain.js';

// 100% Offline Procedural Web Audio Engine for 1744 — The Gathering.
// Zero audio file downloads: synthesizes Atlantic glen wind (coupled to ONIX wind),
// driving rain, lapping Loch Linnhe shoreline, crackling peat hearths, surface-aware
// footsteps & hoofbeats, Callum's echoed whistle, Bramble's calls, and Highland landmark drones.

export class HighlandAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.muted = false;
    this.crackleAccum = 0;
  }

  // Must be triggered from a user gesture (Enter the Glen click / keypress)
  unlock() {
    if (this.ready) {
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      return;
    }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    try {
      this.ctx = new AudioCtx();
      this._buildMasterGraph();
      this._buildAmbientBeds();
      this.ready = true;
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
    } catch (_) {
      this.ready = false;
    }
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.muted ? 0 : 0.78, this.ctx.currentTime, 0.08);
    }
    return this.muted;
  }

  _createNoiseBuffer(seconds = 4) {
    const sr = this.ctx.sampleRate;
    const len = Math.floor(sr * seconds);
    const buf = this.ctx.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);

    // Pink-weighted natural noise (warmer and far more realistic than harsh white static)
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.055;
      b6 = white * 0.115926;
    }
    return buf;
  }

  _buildMasterGraph() {
    const ctx = this.ctx;
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -16;
    this.compressor.knee.value = 18;
    this.compressor.ratio.value = 4;

    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = 0.78;

    this.compressor.connect(this.masterGain);
    this.masterGain.connect(ctx.destination);

    // Subtle glen canyon echo bus for Callum's whistle & distant calls
    this.echoIn = ctx.createGain();
    this.echoIn.gain.value = 0.35;
    const delay1 = ctx.createDelay(1.0);
    delay1.delayTime.value = 0.28;
    const delay2 = ctx.createDelay(1.0);
    delay2.delayTime.value = 0.58;
    const echoFilter = ctx.createBiquadFilter();
    echoFilter.type = 'lowpass';
    echoFilter.frequency.value = 1650;
    const echoGain1 = ctx.createGain();
    echoGain1.gain.value = 0.38;
    const echoGain2 = ctx.createGain();
    echoGain2.gain.value = 0.18;

    this.echoIn.connect(delay1);
    delay1.connect(echoFilter);
    echoFilter.connect(echoGain1);
    echoGain1.connect(this.compressor);

    this.echoIn.connect(delay2);
    delay2.connect(echoFilter);
    echoFilter.connect(echoGain2);
    echoGain2.connect(this.compressor);

    this.noiseBuffer = this._createNoiseBuffer(4);
  }

  _makeLoopingNoise() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    src.start(0, Math.random() * 2.5);
    return src;
  }

  _buildAmbientBeds() {
    const ctx = this.ctx;

    // 1. Highland Glen Wind Bed (sweeping filter coupled to live ONIX wind speed & ridge altitude)
    const windSrc = this._makeLoopingNoise();
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 340;
    this.windFilter.Q.value = 1.65;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0.12;
    windSrc.connect(this.windFilter).connect(this.windGain).connect(this.compressor);

    // Low moorland wind rumble
    const rumbleSrc = this._makeLoopingNoise();
    const rumbleFilter = ctx.createBiquadFilter();
    rumbleFilter.type = 'lowpass';
    rumbleFilter.frequency.value = 135;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0.16;
    rumbleSrc.connect(rumbleFilter).connect(this.rumbleGain).connect(this.compressor);

    // 2. Driving Highland Rain Bed
    const rainSrc = this._makeLoopingNoise();
    const rainHP = ctx.createBiquadFilter();
    rainHP.type = 'highpass';
    rainHP.frequency.value = 950;
    const rainLP = ctx.createBiquadFilter();
    rainLP.type = 'lowpass';
    rainLP.frequency.value = 5200;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0.0001;
    rainSrc.connect(rainHP).connect(rainLP).connect(this.rainGain).connect(this.compressor);

    // 3. Loch Linnhe Shoreline Surf (slow rhythmic wave wash when near sea level)
    const surfSrc = this._makeLoopingNoise();
    this.surfFilter = ctx.createBiquadFilter();
    this.surfFilter.type = 'lowpass';
    this.surfFilter.frequency.value = 320;
    this.surfGain = ctx.createGain();
    this.surfGain.gain.value = 0.0001;
    surfSrc.connect(this.surfFilter).connect(this.surfGain).connect(this.compressor);

    // 4. Peat Hearth & Brazier Fire Bed
    const fireSrc = this._makeLoopingNoise();
    const fireBP = ctx.createBiquadFilter();
    fireBP.type = 'bandpass';
    fireBP.frequency.value = 220;
    fireBP.Q.value = 0.9;
    this.fireGain = ctx.createGain();
    this.fireGain.gain.value = 0.0001;
    fireSrc.connect(fireBP).connect(this.fireGain).connect(this.compressor);
  }

  updateAmbient(dt, px, py, pz, onixField, rainIntensity, elapsed) {
    if (!this.ready || !this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;

    // Wind driven by live ONIX chiral vector + ridge exposure altitude
    const w = onixField.sampleWind(px, pz);
    const windMag = Math.hypot(w.x, w.z);
    const altFactor = clamp((py - 4) / 55, 0, 1);
    const gust = 0.72 + Math.sin(elapsed * 0.42) * 0.22 + Math.sin(elapsed * 1.13) * 0.12;
    const windLevel = clamp((0.10 + altFactor * 0.16 + rainIntensity * 0.18) * windMag * gust, 0.04, 0.48);

    this.windFilter.frequency.setTargetAtTime(240 + windMag * 280 + altFactor * 260 + gust * 90, now, 0.2);
    this.windGain.gain.setTargetAtTime(windLevel, now, 0.2);
    this.rumbleGain.gain.setTargetAtTime(windLevel * 0.75, now, 0.25);

    // Rain bed
    this.rainGain.gain.setTargetAtTime(rainIntensity * 0.34, now, 0.35);

    // Loch Linnhe shoreline surf proximity
    const shoreProx = clamp(1 - Math.max(0, py - WATER_LEVEL) / 14, 0, 1);
    const wavePulse = 0.55 + Math.sin(elapsed * 0.95) * 0.45;
    this.surfFilter.frequency.setTargetAtTime(200 + wavePulse * 260, now, 0.18);
    this.surfGain.gain.setTargetAtTime(shoreProx * (0.14 + wavePulse * 0.12), now, 0.25);

    // Nearest fire source (Baile MacRae hearth or Torr an Fhaire braziers)
    const dClachan = Math.hypot(px - LANDMARKS.clachan.x, pz - LANDMARKS.clachan.z);
    const dTower = Math.hypot(px - LANDMARKS.watchtower.x, pz - LANDMARKS.watchtower.z);
    const nearestFire = Math.min(dClachan, dTower);
    const fireProx = clamp(1 - nearestFire / 26, 0, 1);
    this.fireGain.gain.setTargetAtTime(fireProx * fireProx * 0.32, now, 0.15);

    // Organic stochastic peat-ember crackles when standing near a fire
    if (fireProx > 0.12) {
      this.crackleAccum += dt * (4.0 + fireProx * 12.0);
      if (this.crackleAccum >= 1) {
        this.crackleAccum -= 1;
        if (Math.random() < 0.65) this._playFirePop(fireProx * fireProx * 0.24);
      }
    }
  }

  _playFirePop(vol) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800 + Math.random() * 2600;
    bp.Q.value = 3.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, now);
    g.gain.exponentialRampToValueAtTime(0.0008, now + 0.025 + Math.random() * 0.025);
    src.connect(bp).connect(g).connect(this.compressor);
    src.start(now, Math.random() * 2.5, 0.06);
  }

  // Surface-accurate footstep (Callum) or rhythmic iron-shod hoofbeat (Bramble)
  playStep(surfaceId, intensity = 0.7, isHoof = false, dist = 0) {
    if (!this.ready || !this.ctx || this.ctx.state !== 'running') return;
    const atten = clamp(1 - dist / 45, 0, 1);
    if (atten <= 0.02) return;

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const vol = intensity * atten * (isHoof ? 0.34 : 0.18);

    // 1. Earth / hoof weight thump
    const osc = ctx.createOscillator();
    const oscGain = ctx.createGain();
    const baseFreq =
      surfaceId === 'granite' ? (isHoof ? 165 : 130) :
      surfaceId === 'mud_road' ? (isHoof ? 118 : 95) :
      surfaceId === 'water' ? 90 : (isHoof ? 92 : 76);

    osc.type = 'sine';
    osc.frequency.setValueAtTime(baseFreq * (0.9 + Math.random() * 0.2), now);
    osc.frequency.exponentialRampToValueAtTime(34, now + (isHoof ? 0.095 : 0.065));

    oscGain.gain.setValueAtTime(vol * (surfaceId === 'water' ? 0.45 : 1.0), now);
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + (isHoof ? 0.10 : 0.07));
    osc.connect(oscGain).connect(this.compressor);
    osc.start(now);
    osc.stop(now + 0.11);

    // 2. Surface texture noise burst (heather brush, mud squelch, gravel crunch, or loch splash)
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filt = ctx.createBiquadFilter();
    const nGain = ctx.createGain();

    let dur = 0.09;
    if (surfaceId === 'water') {
      filt.type = 'bandpass';
      filt.frequency.setValueAtTime(750 + Math.random() * 350, now);
      filt.frequency.exponentialRampToValueAtTime(1900, now + 0.16);
      filt.Q.value = 1.2;
      dur = isHoof ? 0.26 : 0.18;
      nGain.gain.setValueAtTime(vol * 1.45, now);
    } else if (surfaceId === 'peat_bog') {
      filt.type = 'bandpass';
      filt.frequency.setValueAtTime(520, now);
      filt.frequency.exponentialRampToValueAtTime(240, now + 0.11);
      filt.Q.value = 2.4;
      dur = 0.13;
      nGain.gain.setValueAtTime(vol * 1.05, now);
    } else if (surfaceId === 'granite' || surfaceId === 'mud_road' || surfaceId === 'shingle') {
      filt.type = 'bandpass';
      filt.frequency.value = isHoof ? 1850 + Math.random() * 650 : 1400 + Math.random() * 400;
      filt.Q.value = isHoof ? 3.0 : 1.8;
      dur = 0.065;
      nGain.gain.setValueAtTime(vol * (isHoof ? 1.2 : 0.85), now);
    } else {
      // Heather & Highland grass swish
      filt.type = 'bandpass';
      filt.frequency.value = 1100 + Math.random() * 450;
      filt.Q.value = 1.1;
      dur = 0.11;
      nGain.gain.setValueAtTime(vol * 0.72, now);
    }

    nGain.gain.exponentialRampToValueAtTime(0.001, now + dur);
    src.connect(filt).connect(nGain).connect(this.compressor);
    src.start(now, Math.random() * 2.5, dur + 0.02);
  }

  // Callum's sharp two-tone frontier whistle echoing across the glen
  playWhistle() {
    if (!this.ready || !this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1480, now);
    osc.frequency.exponentialRampToValueAtTime(2320, now + 0.14);
    osc.frequency.setValueAtTime(2320, now + 0.24);
    osc.frequency.exponentialRampToValueAtTime(1820, now + 0.44);

    // Subtle human breath vibrato
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 6.5;
    lfoGain.gain.value = 24;
    lfo.connect(lfoGain).connect(osc.frequency);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, now);
    g.gain.linearRampToValueAtTime(0.18, now + 0.035);
    g.gain.setValueAtTime(0.16, now + 0.28);
    g.gain.exponentialRampToValueAtTime(0.0008, now + 0.48);

    osc.connect(g);
    g.connect(this.compressor);
    g.connect(this.echoIn);

    osc.start(now);
    lfo.start(now);
    osc.stop(now + 0.50);
    lfo.stop(now + 0.50);
  }

  // Bramble's organic vocalizations: answering whinny, warm nicker, or energetic snort
  playHorseVocal(kind = 'nicker', dist = 0) {
    if (!this.ready || !this.ctx) return;
    const atten = clamp(1 - dist / 110, 0.12, 1);
    const ctx = this.ctx;
    const now = ctx.currentTime;

    if (kind === 'whinny') {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(760, now + 0.22);
      osc.frequency.exponentialRampToValueAtTime(420, now + 0.92);

      const vib = ctx.createOscillator();
      const vibG = ctx.createGain();
      vib.frequency.value = 15.5;
      vibG.gain.value = 42;
      vib.connect(vibG).connect(osc.frequency);

      const formant = ctx.createBiquadFilter();
      formant.type = 'bandpass';
      formant.frequency.setValueAtTime(1350, now + 0.22);
      formant.frequency.exponentialRampToValueAtTime(720, now + 0.92);
      formant.Q.value = 3.6;

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0008, now + 0.22);
      g.gain.linearRampToValueAtTime(0.18 * atten, now + 0.32);
      g.gain.exponentialRampToValueAtTime(0.0008, now + 0.96);

      osc.connect(formant).connect(g);
      g.connect(this.compressor);
      g.connect(this.echoIn);

      osc.start(now + 0.22);
      vib.start(now + 0.22);
      osc.stop(now + 0.98);
      vib.stop(now + 0.98);
    } else if (kind === 'nicker') {
      // Low warm fluttering greeting when Callum pats or mounts Bramble
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(135, now);
      osc.frequency.exponentialRampToValueAtTime(98, now + 0.42);

      const ampMod = ctx.createOscillator();
      const modGain = ctx.createGain();
      ampMod.frequency.value = 17;
      modGain.gain.value = 0.08 * atten;

      const bp = ctx.createBiquadFilter();
      bp.type = 'lowpass';
      bp.frequency.value = 440;

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.12 * atten, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.44);
      ampMod.connect(modGain).connect(g.gain);

      osc.connect(bp).connect(g).connect(this.compressor);
      osc.start(now);
      ampMod.start(now);
      osc.stop(now + 0.46);
      ampMod.stop(now + 0.46);
    } else {
      // Energetic nasal huff/snort on jump or gallop surge
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(640, now);
      bp.frequency.exponentialRampToValueAtTime(280, now + 0.22);
      bp.Q.value = 2.2;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.22 * atten, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
      src.connect(bp).connect(g).connect(this.compressor);
      src.start(now, Math.random() * 2, 0.26);
    }
  }

  // Subtle haunting Scottish open-fifth Highland drone swell on discovering a landmark
  playRegionChord() {
    if (!this.ready || !this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const freqs = [146.83, 220.0, 293.66]; // D3 - A3 - D4 (classic Highland modal fifth)

    for (let i = 0; i < freqs.length; i++) {
      const osc = ctx.createOscillator();
      osc.type = i === 0 ? 'sawtooth' : 'triangle';
      osc.frequency.value = freqs[i];

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 480;

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0005, now);
      g.gain.linearRampToValueAtTime(i === 0 ? 0.032 : 0.022, now + 1.1);
      g.gain.exponentialRampToValueAtTime(0.0005, now + 4.4);

      osc.connect(lp).connect(g).connect(this.compressor);
      osc.start(now);
      osc.stop(now + 4.5);
    }
  }
}
