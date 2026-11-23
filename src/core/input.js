import { clamp } from './prng.js';

export class InputManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pointerLocked = false;
    this.mouseDragging = false;
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    this.wheelDelta = 0;
    this.crouchToggled = false;
    this.pauseQueued = false;
    this.interactQueued = false;
    this.jumpQueued = false;
    this.weatherQueued = false;

    this.touchMoveX = 0;
    this.touchMoveZ = 0;
    this.touchSprint = false;
    this.touchLookDeltaX = 0;
    this.touchLookDeltaY = 0;

    this.prevPadPause = false;
    this.prevPadCrouch = false;
    this.prevPadJump = false;
    this.prevPadInteract = false;
    this.prevPadWeather = false;

    this._bindKeyboardMouse();
    this._bindTouch();
  }

  clearTransient() {
    this.pauseQueued = false;
    this.interactQueued = false;
    this.jumpQueued = false;
    this.weatherQueued = false;
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    this.wheelDelta = 0;
  }

  _bindKeyboardMouse() {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') {
        this.pauseQueued = true;
        return;
      }
      if (!this.keys.has(e.code)) {
        if (e.code === 'KeyC' || e.code === 'ControlLeft') {
          this.crouchToggled = !this.crouchToggled;
        }
        if (e.code === 'Space') this.jumpQueued = true;
        if (e.code === 'KeyE') this.interactQueued = true;
        if (e.code === 'KeyV') this.weatherQueued = true;
      }
      this.keys.add(e.code);
    });

    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });

    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseDragging = false;
    });

    document.addEventListener('pointerlockchange', () => {
      const wasLocked = this.pointerLocked;
      this.pointerLocked = document.pointerLockElement === this.canvas;
      if (wasLocked && !this.pointerLocked) {
        this.pauseQueued = true;
      }
    });

    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        this.mouseDragging = true;
        if (!this.pointerLocked) this.requestPointerLock();
      }
    });

    window.addEventListener('mouseup', () => {
      this.mouseDragging = false;
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked && !this.mouseDragging) return;
      this.mouseDeltaX += e.movementX;
      this.mouseDeltaY += e.movementY;
    });

    window.addEventListener('wheel', (e) => {
      this.wheelDelta += Math.sign(e.deltaY);
    }, { passive: true });
  }

  _bindTouch() {
    const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    const container = document.getElementById('touch-controls');
    if (!isTouch || !container) return;

    const pad = document.getElementById('touch-left-pad');
    const knob = document.getElementById('touch-knob');
    let padTouchId = null;
    let lookTouchId = null;
    let lastLookX = 0;
    let lastLookY = 0;

    pad.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      padTouchId = t.identifier;
      this._updatePad(t, pad, knob);
    }, { passive: true });

    pad.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === padTouchId) this._updatePad(t, pad, knob);
      }
    }, { passive: true });

    const resetPad = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === padTouchId) {
          padTouchId = null;
          this.touchMoveX = 0;
          this.touchMoveZ = 0;
          knob.style.transform = 'translate(0px, 0px)';
        }
      }
    };
    pad.addEventListener('touchend', resetPad, { passive: true });
    pad.addEventListener('touchcancel', resetPad, { passive: true });

    this.canvas.addEventListener('touchstart', (e) => {
      for (const t of e.changedTouches) {
        if (t.clientX > window.innerWidth * 0.4 && lookTouchId === null) {
          lookTouchId = t.identifier;
          lastLookX = t.clientX;
          lastLookY = t.clientY;
        }
      }
    }, { passive: true });

    this.canvas.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === lookTouchId) {
          this.touchLookDeltaX += (t.clientX - lastLookX) * 1.4;
          this.touchLookDeltaY += (t.clientY - lastLookY) * 1.4;
          lastLookX = t.clientX;
          lastLookY = t.clientY;
        }
      }
    }, { passive: true });

    const endLook = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === lookTouchId) lookTouchId = null;
      }
    };
    this.canvas.addEventListener('touchend', endLook, { passive: true });
    this.canvas.addEventListener('touchcancel', endLook, { passive: true });

    document.getElementById('touch-sprint')?.addEventListener('click', () => {
      this.touchSprint = !this.touchSprint;
    });
    document.getElementById('touch-crouch')?.addEventListener('click', () => {
      this.crouchToggled = !this.crouchToggled;
    });
    document.getElementById('touch-jump')?.addEventListener('click', () => {
      this.jumpQueued = true;
    });
  }

  _updatePad(touch, pad, knob) {
    const rect = pad.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const maxR = rect.width * 0.42;
    const dx = clamp((touch.clientX - cx) / maxR, -1, 1);
    const dy = clamp((touch.clientY - cy) / maxR, -1, 1);
    this.touchMoveX = dx;
    this.touchMoveZ = dy;
    knob.style.transform = `translate(${dx * maxR * 0.7}px, ${dy * maxR * 0.7}px)`;
  }

  requestPointerLock() {
    if (this.canvas.requestPointerLock) {
      try {
        const res = this.canvas.requestPointerLock();
        if (res && typeof res.catch === 'function') res.catch(() => {});
      } catch (_) {}
    }
  }

  poll(dt) {
    let moveX = 0;
    let moveZ = 0;

    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) moveX -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) moveX += 1;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) moveZ -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) moveZ += 1;

    moveX += this.touchMoveX;
    moveZ += this.touchMoveZ;

    let lookX = this.mouseDeltaX * 0.0024 + this.touchLookDeltaX * 0.004;
    let lookY = this.mouseDeltaY * 0.0020 + this.touchLookDeltaY * 0.0035;
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    this.touchLookDeltaX = 0;
    this.touchLookDeltaY = 0;

    const zoomDelta = this.wheelDelta;
    this.wheelDelta = 0;

    let sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this.touchSprint;
    let timeDelta = 0;
    if (this.keys.has('BracketLeft')) timeDelta -= 2.5 * dt;
    if (this.keys.has('BracketRight')) timeDelta += 2.5 * dt;

    let gamepadConnected = false;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = pads.find((p) => p && p.connected);
    if (pad) {
      gamepadConnected = true;
      const deadzone = (v, dz = 0.16) => (Math.abs(v) < dz ? 0 : (v - Math.sign(v) * dz) / (1 - dz));

      const lx = deadzone(pad.axes[0] || 0);
      const ly = deadzone(pad.axes[1] || 0);
      const rx = deadzone(pad.axes[2] || 0);
      const ry = deadzone(pad.axes[3] || 0);

      if (Math.abs(lx) > 0 || Math.abs(ly) > 0) {
        moveX = lx;
        moveZ = ly;
      }
      lookX += rx * 2.4 * dt;
      lookY += ry * 1.8 * dt;

      if (pad.buttons[0]?.pressed || pad.buttons[10]?.pressed) sprint = true;

      const crouchBtn = Boolean(pad.buttons[1]?.pressed || pad.buttons[11]?.pressed);
      if (crouchBtn && !this.prevPadCrouch) this.crouchToggled = !this.crouchToggled;
      this.prevPadCrouch = crouchBtn;

      const jumpBtn = Boolean(pad.buttons[3]?.pressed);
      if (jumpBtn && !this.prevPadJump) this.jumpQueued = true;
      this.prevPadJump = jumpBtn;

      const interactBtn = Boolean(pad.buttons[2]?.pressed);
      if (interactBtn && !this.prevPadInteract) this.interactQueued = true;
      this.prevPadInteract = interactBtn;

      const weatherBtn = Boolean(pad.buttons[12]?.pressed);
      if (weatherBtn && !this.prevPadWeather) this.weatherQueued = true;
      this.prevPadWeather = weatherBtn;

      const pauseBtn = Boolean(pad.buttons[9]?.pressed);
      if (pauseBtn && !this.prevPadPause) this.pauseQueued = true;
      this.prevPadPause = pauseBtn;
    }

    const len = Math.hypot(moveX, moveZ);
    if (len > 1) {
      moveX /= len;
      moveZ /= len;
    }

    if (sprint && this.crouchToggled && len > 0.2) {
      this.crouchToggled = false;
    }

    const pausePressed = this.pauseQueued;
    const jump = this.jumpQueued;
    const interact = this.interactQueued;
    const weatherToggle = this.weatherQueued;
    this.pauseQueued = false;
    this.jumpQueued = false;
    this.interactQueued = false;
    this.weatherQueued = false;

    return {
      moveX,
      moveZ,
      lookX,
      lookY,
      zoomDelta,
      sprint,
      crouch: this.crouchToggled,
      jump,
      interact,
      weatherToggle,
      pausePressed,
      timeDelta,
      gamepadConnected
    };
  }
}
