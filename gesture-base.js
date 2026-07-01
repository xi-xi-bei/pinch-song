/**
 * GestureBase v1.2 — Native camera + dual-hand support
 * ==========================================================================
 * Pure frontend, CDN-only, zero build-tool dependencies.
 * Designed for GestureGame-Agent: copy into any mini-game project as-is.
 *
 * Prerequisite CDN scripts (loaded by index.html before this file):
 *   @mediapipe/hands, @mediapipe/camera_utils, @mediapipe/drawing_utils
 *
 * Exports: window.GestureBase
 */

(function () {
  'use strict';

  // ── Landmark Index Constants ──────────────────────────────────────────
  const LM = {
    WRIST: 0,
    THUMB_CMC: 1, THUMB_MCP: 2, THUMB_IP: 3, THUMB_TIP: 4,
    INDEX_MCP: 5, INDEX_PIP: 6, INDEX_DIP: 7, INDEX_TIP: 8,
    MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_DIP: 11, MIDDLE_TIP: 12,
    RING_MCP: 13, RING_PIP: 14, RING_DIP: 15, RING_TIP: 16,
    PINKY_MCP: 17, PINKY_PIP: 18, PINKY_DIP: 19, PINKY_TIP: 20,
  };

  const FINGER_TIPS = {
    thumb: LM.THUMB_TIP,
    index: LM.INDEX_TIP,
    middle: LM.MIDDLE_TIP,
    ring: LM.RING_TIP,
    pinky: LM.PINKY_TIP,
  };

  const FINGER_PIPS = {
    thumb: LM.THUMB_IP,
    index: LM.INDEX_PIP,
    middle: LM.MIDDLE_PIP,
    ring: LM.RING_PIP,
    pinky: LM.PINKY_PIP,
  };

  // ── Geometry Helpers ──────────────────────────────────────────────────
  function distance2D(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** Clamp value to [lo, hi]. */
  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  /** Smooth a value toward target with exponential decay. */
  function smooth(current, target, factor) {
    return current + (target - current) * factor;
  }

  // ── GestureBase Class ─────────────────────────────────────────────────
  class GestureBase {
    /**
     * @param {Object} [opts]
     * @param {number} [opts.debounceDelay=300]       ms — gesture must persist this long to confirm
     * @param {number} [opts.tapDebounceDelay=500]     ms — minimum gap between successive taps
     * @param {number} [opts.pinchMaxDist=0.12]        normalized 0-1 — distance at which pinchProgress=0
     * @param {number} [opts.pinchConfirmThreshold=0.6] pinchProgress threshold for confirmed pinch
     * @param {number} [opts.swipeMinDist=0.08]        normalized — minimum displacement to register swipe
     * @param {number} [opts.swipeMaxDuration=400]     ms — max time for swipe gesture
     * @param {number} [opts.tapMinVelocity=0.03]      normalized/frame — speed threshold for tap
     * @param {number} [opts.velocitySmoothing=0.7]    0-1 — EMA factor for palm velocity
     * @param {Object} [opts.interactionZone]          {x,y,w,h} normalized 0-1
     * @param {boolean} [opts.mirrorCamera=true]        flip video horizontally
     * @param {boolean} [opts.showSkeleton=true]        draw hand skeleton overlay
     * @param {string} [opts.skeletonColor='#00FF88']
     * @param {string} [opts.skeletonDotColor='#FF4466']
     */
    constructor(opts) {
      const o = opts || {};
      this.debounceDelay = o.debounceDelay ?? 300;
      this.tapDebounceDelay = o.tapDebounceDelay ?? 500;
      this.pinchMaxDist = o.pinchMaxDist ?? 0.12;
      this.pinchConfirmThreshold = o.pinchConfirmThreshold ?? 0.6;
      this.swipeMinDist = o.swipeMinDist ?? 0.08;
      this.swipeMaxDuration = o.swipeMaxDuration ?? 400;
      this.tapMinVelocity = o.tapMinVelocity ?? 0.03;
      this.velocitySmoothing = o.velocitySmoothing ?? 0.7;
      this.mirrorCamera = o.mirrorCamera ?? true;
      this.showSkeleton = o.showSkeleton ?? true;
      this.skeletonColor = o.skeletonColor ?? '#00FF88';
      this.skeletonDotColor = o.skeletonDotColor ?? '#FF4466';

      // Interaction zone — normalized 0-1 relative to camera frame.
      // Hand must enter this zone for game input to respond.
      this.interactionZone = o.interactionZone || { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };

      // ── Runtime State ──
      this._handLandmarker = null;
      this._video = null;
      this._canvas = null;
      this._ctx = null;
      this._initialized = false;
      this._running = false;

      // Latest frame data
      this.landmarks = null;          // array of 21 {x,y,z} (normalized 0-1)
      this.handedness = null;         // 'Left' | 'Right'
      this.allLandmarks = [];
      this.allHandedness = [];
      this.handCount = 0;
      this.isHandPresent = false;
      this.isHandInZone = false;

      // Smoothed palm center & velocity
      this._palmCenter = { x: 0.5, y: 0.5 };
      this._palmVelocity = { x: 0, y: 0 };
      this._prevPalmCenter = { x: 0.5, y: 0.5 };
      this._palmVelocityMag = 0;

      // ── Gesture State Machines ──
      // Pinch (thumb + index)
      this._pinch = { active: false, startTime: 0, confirmed: false, progress: 0 };

      // Tap (index fingertip rapid down-up)
      this._tap = {
        detected: false,
        lastTapTime: 0,
        candidate: false,
        candidateTime: 0,
        // Tap trajectory tracking
        indexTipY: 0,
        indexTipPrevY: 0,
        indexTipVelocityY: 0,
        phase: 'idle', // idle | moving-down | moving-up
      };

      // Fist
      this._fist = { active: false, startTime: 0, confirmed: false };

      // Swipe (palm displacement)
      this._swipe = {
        detected: false,
        direction: null,       // 'left'|'right'|'up'|'down'
        startPos: null,        // {x, y}
        startTime: 0,
        tracking: false,
      };

      // Pinch-drag / two-finger spread
      this._spread = { initialDist: 0, currentDist: 0, progress: 0 };

      // ── Event Callbacks ──
      this._listeners = {};
      this._eventQueue = [];
    }

    // ═══════════════════════════════════════════════════════════════════
    //  INITIALIZATION
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Initialize MediaPipe Hands, camera, and overlay canvas.
     * Call once. Returns a Promise that resolves when ready.
     *
     * @param {HTMLVideoElement} videoEl
     * @param {HTMLCanvasElement} [overlayCanvas] — for skeleton drawing
     * @param {Object} [mpOptions] — forwarded to hands.setOptions()
     */
    async init(videoEl, overlayCanvas, handLandmarker) {
      if (this._initialized) return;
      this._video = videoEl;
      if (overlayCanvas) {
        this._canvas = overlayCanvas;
        this._ctx = overlayCanvas.getContext("2d");
      }
      this._handLandmarker = handLandmarker;
      this._lastVideoTime = -1;
      // Use existing video stream (caller must set up camera)
      if (!videoEl.srcObject) {
        throw new Error("Video element has no stream. Call getUserMedia() first.");
      }
      this._stream = videoEl.srcObject;
      videoEl.setAttribute("playsinline", "");
      if (videoEl.paused) { await videoEl.play(); }
      this._initialized = true;
      this._running = true;
      this._mpErrorCount = 0;
      this._mpResultCount = 0;
      this._startDetection();
      this._startLoop();
    }

    _startDetection() {
      var self = this;
      function detect() {
        if (!self._running || !self._handLandmarker) { requestAnimationFrame(detect); return; }
        if (self._video.currentTime !== self._lastVideoTime) {
          self._lastVideoTime = self._video.currentTime;
          try {
            var results = self._handLandmarker.detectForVideo(self._video, performance.now());
            self._onFrame(results);
          } catch(e) {
            self._mpErrorCount++;
          }
        }
        requestAnimationFrame(detect);
      }
      requestAnimationFrame(detect);
    }

    /** Stop camera and tracking. */
    stop() {
      this._running = false;
      if (this._stream) {
        this._stream.getTracks().forEach(function(t) { t.stop(); });
        this._stream = null;
      }
      if (this._handLandmarker) {
        try { this._handLandmarker.close(); } catch (_) { /* ignore */ }
        this._handLandmarker = null;
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  FRAME PROCESSING
    // ═══════════════════════════════════════════════════════════════════

    _onFrame(results) {
      this._mpResultCount = (this._mpResultCount || 0) + 1;
      // tasks-vision uses results.landmarks instead of results.multiHandLandmarks
      var landmarks = results.landmarks;
      if (!landmarks || landmarks.length === 0) {
        this.isHandPresent = false;
        this.landmarks = null;
        this.handedness = null;
        this.allLandmarks = [];
        this.allHandedness = [];
        this.handCount = 0;
        this.isHandInZone = false;
        this._resetGestureStates();
        return;
      }

      this.allLandmarks = landmarks;
      this.allHandedness = results.handedness ? results.handedness.map(function(h) { return h[0].categoryName; }) : [];
      this.handCount = landmarks.length;
      this.landmarks = landmarks[0];
      this.handedness = results.handedness
        ? results.handedness[0][0].categoryName
        : null;
      this.isHandPresent = true;

      // Update palm center & velocity
      this._updatePalmTracking();

      // Check interaction zone
      this.isHandInZone = this._checkZone();

      // Only update gesture states when hand is in the zone
      if (this.isHandInZone) {
        this._updateGestures();
      }

      // Draw skeleton overlay
      if (this._ctx && this._canvas && this.showSkeleton) {
        this._drawSkeleton();
      }
    }

    _updatePalmTracking() {
      const w = this.landmarks[LM.WRIST];
      const m = this.landmarks[LM.MIDDLE_MCP]; // middle finger base

      const raw = {
        x: (w.x + m.x) / 2,
        y: (w.y + m.y) / 2,
      };

      // EMA smoothing
      this._palmCenter.x = smooth(this._palmCenter.x, raw.x, this.velocitySmoothing);
      this._palmCenter.y = smooth(this._palmCenter.y, raw.y, this.velocitySmoothing);

      // Raw velocity (frame-to-frame)
      const dx = raw.x - this._prevPalmCenter.x;
      const dy = raw.y - this._prevPalmCenter.y;
      this._palmVelocity.x = smooth(this._palmVelocity.x, dx, 0.5);
      this._palmVelocity.y = smooth(this._palmVelocity.y, dy, 0.5);
      this._palmVelocityMag = Math.sqrt(
        this._palmVelocity.x ** 2 + this._palmVelocity.y ** 2
      );

      this._prevPalmCenter.x = raw.x;
      this._prevPalmCenter.y = raw.y;
    }

    /** Check if palm center is inside the interaction zone. */
    _checkZone() {
      const z = this.interactionZone;
      const p = this._palmCenter;
      return (
        p.x >= z.x &&
        p.x <= z.x + z.w &&
        p.y >= z.y &&
        p.y <= z.y + z.h
      );
    }

    // ═══════════════════════════════════════════════════════════════════
    //  GESTURE STATE MACHINES
    // ═══════════════════════════════════════════════════════════════════

    _updateGestures() {
      const now = performance.now();
      this._updatePinch(now);
      this._updateTap(now);
      this._updateFist(now);
      this._updateSwipe(now);
      this._updateSpread();
      this._dispatchEvents();
    }

    // ── Pinch (thumb tip ↔ index tip) ────────────────────────────────
    _updatePinch(now) {
      const dt = distance2D(
        this.landmarks[LM.THUMB_TIP],
        this.landmarks[LM.INDEX_TIP]
      );
      // Normalize: 0 = far apart, 1 = touching
      const progress = clamp(1 - dt / this.pinchMaxDist, 0, 1);
      this._pinch.progress = progress;

      const isActive = progress >= this.pinchConfirmThreshold;

      if (isActive && !this._pinch.active) {
        this._pinch.active = true;
        this._pinch.startTime = now;
        this._pinch.confirmed = false;
      } else if (!isActive && this._pinch.active) {
        // Released
        if (this._pinch.confirmed) {
          this._queueEvent('pinchend', { progress: this._pinch.progress });
        }
        this._pinch.active = false;
        this._pinch.confirmed = false;
      }

      // Debounce: must hold for debounceDelay ms to confirm
      if (
        this._pinch.active &&
        !this._pinch.confirmed &&
        now - this._pinch.startTime >= this.debounceDelay
      ) {
        this._pinch.confirmed = true;
        this._queueEvent('pinchstart', { progress });
      }
    }

    // ── Tap (index fingertip rapid down-up) ──────────────────────────
    _updateTap(now) {
      const tip = this.landmarks[LM.INDEX_TIP];
      if (!tip) return;

      this._tap.indexTipPrevY = this._tap.indexTipY;
      this._tap.indexTipY = tip.y;

      // Vertical velocity (positive = moving down in image coords)
      const vY = tip.y - this._tap.indexTipPrevY;
      this._tap.indexTipVelocityY = smooth(this._tap.indexTipVelocityY, vY, 0.6);

      switch (this._tap.phase) {
        case 'idle':
          // Detect rapid downward motion
          if (this._tap.indexTipVelocityY > this.tapMinVelocity) {
            this._tap.phase = 'moving-down';
            this._tap.candidate = true;
            this._tap.candidateTime = now;
          }
          break;

        case 'moving-down':
          // Detect reversal (moving up) or timeout
          if (this._tap.indexTipVelocityY < -this.tapMinVelocity * 0.5) {
            // Tap completed!
            this._tap.phase = 'idle';
            if (
              this._tap.candidate &&
              now - this._tap.lastTapTime >= this.tapDebounceDelay
            ) {
              this._tap.detected = true;
              this._tap.lastTapTime = now;
              this._queueEvent('tap', {
                position: { x: tip.x, y: tip.y },
              });
            }
            this._tap.candidate = false;
          } else if (now - this._tap.candidateTime > 400) {
            // Timed out
            this._tap.phase = 'idle';
            this._tap.candidate = false;
          }
          break;
      }
    }

    // ── Fist ─────────────────────────────────────────────────────────
    _updateFist(now) {
      // Check if all fingertips are below their PIP joints (y increases downward)
      const fingers = ['index', 'middle', 'ring', 'pinky'];
      let closedCount = 0;

      for (const f of fingers) {
        const tip = this.landmarks[FINGER_TIPS[f]];
        const pip = this.landmarks[FINGER_PIPS[f]];
        if (tip && pip && tip.y > pip.y) {
          closedCount++;
        }
      }

      // Also check thumb: thumb tip should be near index MCP for a fist
      const thumbTip = this.landmarks[LM.THUMB_TIP];
      const indexMcp = this.landmarks[LM.INDEX_MCP];
      const thumbClose = thumbTip && indexMcp && distance2D(thumbTip, indexMcp) < 0.15;

      const isFist = closedCount >= 3 && thumbClose;

      if (isFist && !this._fist.active) {
        this._fist.active = true;
        this._fist.startTime = now;
        this._fist.confirmed = false;
      } else if (!isFist && this._fist.active) {
        if (this._fist.confirmed) {
          this._queueEvent('fistend');
        }
        this._fist.active = false;
        this._fist.confirmed = false;
      }

      if (
        this._fist.active &&
        !this._fist.confirmed &&
        now - this._fist.startTime >= this.debounceDelay
      ) {
        this._fist.confirmed = true;
        this._queueEvent('fiststart');
      }
    }

    // ── Swipe (palm displacement) ────────────────────────────────────
    _updateSwipe(now) {
      if (this._palmVelocityMag < 0.005) {
        // Hand nearly still — check if a tracked swipe just ended
        if (this._swipe.tracking) {
          this._swipe.tracking = false;
          const disp = {
            x: this._palmCenter.x - this._swipe.startPos.x,
            y: this._palmCenter.y - this._swipe.startPos.y,
          };
          const dist = Math.sqrt(disp.x ** 2 + disp.y ** 2);
          const duration = now - this._swipe.startTime;

          if (
            dist >= this.swipeMinDist &&
            duration <= this.swipeMaxDuration
          ) {
            // Determine dominant direction
            if (Math.abs(disp.x) > Math.abs(disp.y)) {
              this._swipe.direction = disp.x > 0 ? 'right' : 'left';
            } else {
              this._swipe.direction = disp.y > 0 ? 'down' : 'up';
            }
            this._swipe.detected = true;
            this._queueEvent('swipe', {
              direction: this._swipe.direction,
              distance: dist,
            });
          }
        }
        return;
      }

      // Hand is moving
      if (!this._swipe.tracking) {
        this._swipe.tracking = true;
        this._swipe.startPos = { x: this._palmCenter.x, y: this._palmCenter.y };
        this._swipe.startTime = now;
        this._swipe.direction = null;
        this._swipe.detected = false;
      }
    }

    // ── Two-finger spread (index ↔ middle) ───────────────────────────
    _updateSpread() {
      const iTip = this.landmarks[LM.INDEX_TIP];
      const mTip = this.landmarks[LM.MIDDLE_TIP];
      if (!iTip || !mTip) return;

      const dist = distance2D(iTip, mTip);
      if (this._spread.initialDist === 0) {
        this._spread.initialDist = dist;
      }
      this._spread.currentDist = dist;
      // progress > 1 when spread wider than initial, < 1 when pinched
      this._spread.progress =
        this._spread.initialDist > 0
          ? dist / this._spread.initialDist
          : 1;
    }

    _resetGestureStates() {
      // Reset all gesture machines when hand disappears
      if (this._pinch.confirmed) this._queueEvent('pinchend');
      if (this._fist.confirmed) this._queueEvent('fistend');
      this._pinch = { active: false, startTime: 0, confirmed: false, progress: 0 };
      this._fist = { active: false, startTime: 0, confirmed: false };
      this._tap = { detected: false, lastTapTime: this._tap.lastTapTime, candidate: false,
        candidateTime: 0, indexTipY: 0, indexTipPrevY: 0, indexTipVelocityY: 0, phase: 'idle' };
      this._swipe = { detected: false, direction: null, startPos: null, startTime: 0, tracking: false };
      this._spread = { initialDist: 0, currentDist: 0, progress: 0 };
    }

    // ── Event Queue ──────────────────────────────────────────────────
    _queueEvent(name, data) {
      this._eventQueue.push({ name, data: data || {} });
    }

    _dispatchEvents() {
      for (const ev of this._eventQueue) {
        if (this._listeners[ev.name]) {
          for (const cb of this._listeners[ev.name]) {
            try { cb(ev.data); } catch (e) { console.warn('[GestureBase] event handler error:', e); }
          }
        }
      }
      this._eventQueue.length = 0;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  PUBLIC API — LANDMARK ACCESS
    // ═══════════════════════════════════════════════════════════════════

    /** Get raw landmark by index (0-20). Returns {x, y, z} or null. */
    getLandmark(idx) {
      return this.landmarks ? this.landmarks[idx] : null;
    }

    /** Get all 21 landmarks. Returns array or null. */
    getAllLandmarks() {
      return this.landmarks;
    }

    /**
     * Get fingertip position.
     * @param {'thumb'|'index'|'middle'|'ring'|'pinky'} finger
     * @returns {{x:number, y:number, z:number}|null}
     */
    getFingertip(finger) {
      const idx = FINGER_TIPS[finger];
      return idx !== undefined ? this.getLandmark(idx) : null;
    }

    getHandLandmarks(handIndex) {
      return (this.allLandmarks && handIndex < this.allLandmarks.length)
        ? this.allLandmarks[handIndex] : null;
    }

    getHandHandedness(handIndex) {
      return (this.allHandedness && handIndex < this.allHandedness.length)
        ? this.allHandedness[handIndex] : null;
    }

    pinchDistanceForHand(handIndex, fingerName) {
      var hand = this.getHandLandmarks(handIndex);
      if (!hand) return Infinity;
      return distance2D(hand[LM.THUMB_TIP], hand[FINGER_TIPS[fingerName]]);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  PUBLIC API — GESTURE QUERIES (polling)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Pinch progress 0~1: 0 = fingers spread, 1 = fully pinched.
     * Only meaningful when hand is in the interaction zone.
     */
    pinchProgress() {
      return this._pinch.progress;
    }

    /** Whether a confirmed pinch (debounced hold) is active. */
    isPinching() {
      return this._pinch.confirmed;
    }

    /** Whether a tap was just detected this frame (consumed on read). */
    isTapping() {
      if (this._tap.detected) {
        this._tap.detected = false;
        return true;
      }
      return false;
    }

    /** Whether a confirmed fist (debounced hold) is active. */
    isFist() {
      return this._fist.confirmed;
    }

    /**
     * Get the most recent swipe direction (consumed on read).
     * @returns {'left'|'right'|'up'|'down'|null}
     */
    getSwipeDirection() {
      if (this._swipe.detected) {
        const d = this._swipe.direction;
        this._swipe.detected = false;
        return d;
      }
      return null;
    }

    /**
     * Two-finger spread progress (relative to initial distance when first detected).
     * >1 = spread wider, <1 = pinched together.
     */
    spreadProgress() {
      return this._spread.progress;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  PUBLIC API — SPATIAL QUERIES
    // ═══════════════════════════════════════════════════════════════════

    /** Smoothed palm center {x, y} in normalized 0-1 coords. */
    palmCenter() {
      return { x: this._palmCenter.x, y: this._palmCenter.y };
    }

    /** Smoothed palm velocity {x, y} in normalized units per frame. */
    palmVelocity() {
      return { x: this._palmVelocity.x, y: this._palmVelocity.y, mag: this._palmVelocityMag };
    }

    /** Euclidean distance between two landmark indices. Normalized 0-1. */
    landmarkDistance(idxA, idxB) {
      const a = this.landmarks[idxA];
      const b = this.landmarks[idxB];
      return a && b ? distance2D(a, b) : Infinity;
    }

    /** Fingertip distance between two named fingers. */
    fingertipDistance(fingerA, fingerB) {
      const a = this.getFingertip(fingerA);
      const b = this.getFingertip(fingerB);
      return a && b ? distance2D(a, b) : Infinity;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  PUBLIC API — INTERACTION ZONE
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Set the interaction zone (normalized 0-1 relative to camera frame).
     * Hand must be inside this zone for gestures to respond.
     */
    setInteractionZone(x, y, w, h) {
      this.interactionZone = { x, y, w, h };
    }

    /** Check if hand is currently inside the interaction zone. */
    isInsideZone() {
      return this.isHandInZone;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  PUBLIC API — EVENT SYSTEM
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Register a gesture event listener.
     * Events: 'pinchstart', 'pinchend', 'tap', 'fiststart', 'fistend', 'swipe'
     */
    on(event, callback) {
      if (!this._listeners[event]) this._listeners[event] = [];
      this._listeners[event].push(callback);
    }

    /** Remove a gesture event listener. */
    off(event, callback) {
      const list = this._listeners[event];
      if (list) {
        const idx = list.indexOf(callback);
        if (idx >= 0) list.splice(idx, 1);
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  PUBLIC API — UTILITY
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Map a normalized landmark coordinate to canvas pixel space.
     * @param {{x:number, y:number}} point — normalized 0-1
     * @param {HTMLCanvasElement} canvas
     * @returns {{x:number, y:number}} pixel coordinates
     */
    static mapToCanvas(point, canvas) {
      return {
        x: point.x * canvas.width,
        y: point.y * canvas.height,
      };
    }

    /**
     * Map a normalized coordinate to game-world space.
     * @param {{x:number, y:number}} point — normalized 0-1
     * @param {number} worldWidth
     * @param {number} worldHeight
     * @returns {{x:number, y:number}}
     */
    static mapToWorld(point, worldWidth, worldHeight) {
      return {
        x: point.x * worldWidth,
        y: point.y * worldHeight,
      };
    }

    // ═══════════════════════════════════════════════════════════════════
    //  SKELETON RENDERING
    // ═══════════════════════════════════════════════════════════════════

    _drawSkeleton() {
      if (!this._ctx || !this._canvas || !this.allLandmarks || this.allLandmarks.length === 0) return;

      const ctx = this._ctx;
      const cw = this._canvas.width;
      const ch = this._canvas.height;

      ctx.clearRect(0, 0, cw, ch);

      // Draw interaction zone indicator
      const z = this.interactionZone;
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(z.x * cw, z.y * ch, z.w * cw, z.h * ch);
      ctx.setLineDash([]);

      for (var hi = 0; hi < this.allLandmarks.length; hi++) {
        var handLm = this.allLandmarks[hi];
        if (!handLm) continue;
      // Draw connections
      const connections = [
        [0,1],[1,2],[2,3],[3,4],       // thumb
        [0,5],[5,6],[6,7],[7,8],       // index
        [0,9],[9,10],[10,11],[11,12],  // middle (via wrist)
        [5,9],[9,13],[13,14],[14,15],[15,16], // ring
        [13,17],[17,18],[18,19],[19,20], // pinky
      ];

      ctx.strokeStyle = this.skeletonColor;
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';

      for (const [a, b] of connections) {
        const pa = handLm[a];
        const pb = handLm[b];
        if (!pa || !pb) continue;
        ctx.beginPath();
        ctx.moveTo(pa.x * cw, pa.y * ch);
        ctx.lineTo(pb.x * cw, pb.y * ch);
        ctx.stroke();
      }

      // Draw landmarks
      for (let i = 0; i < 21; i++) {
        const p = handLm[i];
        if (!p) continue;
        ctx.beginPath();
        ctx.arc(p.x * cw, p.y * ch, 3, 0, Math.PI * 2);
        ctx.fillStyle = i === LM.INDEX_TIP || i === LM.THUMB_TIP
          ? this.skeletonDotColor
          : 'rgba(255,255,255,0.7)';
        ctx.fill();
      }

      } // end per-hand loop

      // Draw zone status indicator
      const indicatorColor = this.isHandInZone ? '#00FF88' : '#FF4466';
      ctx.fillStyle = indicatorColor;
      ctx.beginPath();
      ctx.arc(cw - 20, 20, 8, 0, Math.PI * 2);
      ctx.fill();
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ANIMATION LOOP (for game-core.js to hook into)
    // ═══════════════════════════════════════════════════════════════════

    _startLoop() {
      const tick = () => {
        if (!this._running) return;
        this._emit('frame', {
          landmarks: this.landmarks,
          isHandPresent: this.isHandPresent,
          isHandInZone: this.isHandInZone,
          pinchProgress: this.pinchProgress(),
          isPinching: this.isPinching(),
          palmCenter: this.palmCenter(),
          palmVelocity: this.palmVelocity(),
        });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }

    _emit(name, data) {
      if (this._listeners[name]) {
        for (const cb of this._listeners[name]) {
          try { cb(data); } catch (e) { console.warn('[GestureBase] frame handler error:', e); }
        }
      }
    }
  }

  // ── Export ───────────────────────────────────────────────────────────
  window.GestureBase = GestureBase;
})();
