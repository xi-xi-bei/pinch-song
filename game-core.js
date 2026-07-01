// ============================================================================
// Finger Pinch Symphony — game-core.js
// Dual-hand multi-finger pinch rhythm game with Web Audio synthesis
// ============================================================================
// Depends on: gesture-base.js (v1.1+ with dual-hand support)
// Exposes: window.Game { start, restart, nextLevel }
// ============================================================================

(function () {
  'use strict';
  var _T = (typeof window !== 'undefined' && window._T) || {};
  function _(key, fb) { return _T[key] || fb || key; }

  // ── Lane Configuration ──────────────────────────────────────────────
  var LANES = [
    { hand: 0, finger: 'index',  note: 'C4', freq: 261.63, label: '左手·食指', color: '#FF4466' },
    { hand: 0, finger: 'middle', note: 'D4', freq: 293.66, label: '左手·中指', color: '#FF8822' },
    { hand: 0, finger: 'ring',   note: 'E4', freq: 329.63, label: '左手·无名', color: '#FFCC00' },
    { hand: 0, finger: 'pinky',  note: 'F4', freq: 349.23, label: '左手·小指', color: '#88FF00' },
    { hand: 1, finger: 'index',  note: 'G4', freq: 392.00, label: '右手·食指', color: '#00FF88' },
    { hand: 1, finger: 'middle', note: 'A4', freq: 440.00, label: '右手·中指', color: '#00CCFF' },
    { hand: 1, finger: 'ring',   note: 'B4', freq: 493.88, label: '右手·无名', color: '#4488FF' },
    { hand: 1, finger: 'pinky',  note: 'C5', freq: 523.25, label: '右手·小指', color: '#AA44FF' },
  ];

  // ── Game Constants ──────────────────────────────────────────────────
  var PINCH_THRESHOLD = 0.08;     // distance below which a finger is "pinched"
  var HIT_ZONE_RATIO = 0.82;     // hit zone Y as fraction of canvas height
  var HIT_WINDOW_PERFECT = 60;   // ms — Perfect timing window
  var HIT_WINDOW_GOOD = 150;     // ms — Good timing window
  var NOTE_SPEED = 0.25;         // px per ms scroll speed (base)
  var NOTE_WIDTH_RATIO = 0.08;   // note width as fraction of canvas width
  var NOTE_HEIGHT = 24;          // note height in px
  var LATENCY_OFFSET = 40;       // ms — compensate for MediaPipe pipeline delay

  // ── State ───────────────────────────────────────────────────────────
  var canvas, ctx, gesture, hud, screens, finalScoreEl, levelCompleteMsg;
  var state = 'idle';            // idle | countdown | playing | paused | levelComplete | gameover
  var score = 0;
  var combo = 0;
  var maxCombo = 0;
  var perfectCount = 0;
  var goodCount = 0;
  var missCount = 0;
  var totalNotes = 0;
  var currentLevel = 0;
  var maxLevel = 3;
  var audioCtx = null;
  var oscillators = [];
  var gainNodes = [];
  var notes = [];
  var particles = [];
  var floatingTexts = [];
  var laneGlows = [0, 0, 0, 0, 0, 0, 0, 0];  // glow intensity per lane
  var laneWidth, laneOffsetX;
  var gameStartTime = 0;
  var levelDuration = 30000;     // ms per level
  var countdownValue = 0;
  var countdownStart = 0;
  var isHandInZone = false;
  var legendFills = null;
  var legendRows = null;
  var prevPinchStates = [false, false, false, false, false, false, false, false];

  // ── Audio Engine ────────────────────────────────────────────────────
  function initAudio() {
    if (audioCtx) return;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      console.warn('Web Audio not available');
      return;
    }
    for (var i = 0; i < LANES.length; i++) {
      var gain = audioCtx.createGain();
      gain.gain.value = 0;
      gain.connect(audioCtx.destination);
      gainNodes.push(gain);
      oscillators.push(null); // created on-demand per note
    }
  }

  async function playNote(laneIndex) {
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    // Stop existing oscillator for this lane
    if (oscillators[laneIndex]) {
      try { oscillators[laneIndex].stop(); } catch (e) { /* ignore */ }
    }

    var osc = audioCtx.createOscillator();
    var gain = gainNodes[laneIndex];
    osc.type = 'sine';
    osc.frequency.value = LANES[laneIndex].freq;
    osc.connect(gain);

    // Envelope: quick attack, sustain, release
    var now = audioCtx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.35, now + 0.01);
    gain.gain.linearRampToValueAtTime(0.25, now + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);

    osc.start(now);
    osc.stop(now + 0.45);
    oscillators[laneIndex] = osc;
  }

  // ── Note Chart Generator ────────────────────────────────────────────
  function generateNoteChart(level) {
    var chart = [];
    var bpm, patterns, duration;

    switch (level) {
      case 0: // Level 1 — slow intro
        bpm = 110;
        duration = 25000;
        patterns = [
          [0], null, [4], null, [1], null, [5], null,
          [2], null, [6], null, [3], null, [7], null,
          [0, 4], null, [1, 5], null, [2, 6], null, [3, 7], null,
          [0], [1], [2], [3], null, [4], [5], [6], [7],
        ];
        break;
      case 1: // Level 2 — two-hand patterns
        bpm = 140;
        duration = 30000;
        patterns = [
          [0, 4], null, [1, 5], null, [2, 6], null, [3, 7], null,
          [0], [4], [1], [5], [2], [6], [3], [7],
          [0, 2, 4, 6], null, null, null,
          [1, 3, 5, 7], null, null, null,
          [0, 4], null, [1], [5], [2, 6], null, [3], [7],
        ];
        break;
      case 2: // Level 3 — fast & complex
        bpm = 175;
        duration = 35000;
        patterns = [
          [0], [1], [2], [3], [4], [5], [6], [7],
          [0, 4], null, [1, 5], null, [2, 6], null, [3, 7], null,
          [0, 2, 4], null, null, [1, 3, 5], null, null,
          [0, 4, 7], null, [3, 6], null, [1, 5], null, [2, 7], null,
          [0], [2], [4], [6], [1], [3], [5], [7],
          [0, 1, 4, 5], null, null, [2, 3, 6, 7], null, null,
        ];
        break;
      default: // beyond level 3 — loop with faster BPM
        bpm = 200;
        duration = 40000;
        patterns = [
          [0, 4], [1, 5], [2, 6], [3, 7],
          [0, 2, 4, 6], null, [1, 3, 5, 7], null,
          [0], [4], [1], [5], [2], [6], [3], [7],
          [0, 1], [4, 5], [2, 3], [6, 7],
        ];
        break;
    }

    var beatInterval = 60000 / bpm;
    var t = 1000; // 1s buffer before first note

    for (var p = 0; p < patterns.length; p++) {
      var laneSet = patterns[p];
      var beatOffset = (p % 4 === 0 && p > 0) ? beatInterval * 0.5 : 0;
      t += beatInterval + beatOffset;

      if (t > duration) break;

      if (laneSet === null) continue;

      for (var j = 0; j < laneSet.length; j++) {
        chart.push({
          time: t,
          lane: laneSet[j],
          hit: false,
          judged: false,
        });
      }
    }

    return { chart: chart, duration: duration };
  }

  // ── Particle System ─────────────────────────────────────────────────
  function spawnParticles(x, y, count, color, spread, life) {
    for (var i = 0; i < count; i++) {
      var angle = Math.random() * Math.PI * 2;
      var speed = (Math.random() * 0.7 + 0.3) * spread;
      particles.push({
        x: x, y: y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 1.5,
        life: life || 600,
        maxLife: life || 600,
        color: color,
        size: Math.random() * 4 + 2,
      });
    }
  }

  function spawnFloatingText(x, y, text, color) {
    floatingTexts.push({
      x: x, y: y,
      text: text,
      color: color,
      life: 800,
      maxLife: 800,
    });
  }

  // ── Drawing ─────────────────────────────────────────────────────────
  function drawLanes() {
    if (!ctx || !canvas) return;
    var cw = canvas.width;
    var ch = canvas.height;

    // Lane backgrounds
    for (var i = 0; i < LANES.length; i++) {
      var lx = laneOffsetX + i * laneWidth;
      var glow = laneGlows[i];

      // Lane fill
      ctx.fillStyle = LANES[i].color.replace(')', ', 0.08)').replace('rgb', 'rgba');
      if (LANES[i].color.startsWith('#')) {
        ctx.fillStyle = LANES[i].color + '20';
      }
      ctx.fillRect(lx + 4, 0, laneWidth - 8, ch);

      // Lane border
      ctx.strokeStyle = LANES[i].color.replace(')', ', 0.15)').replace('rgb', 'rgba');
      if (LANES[i].color.startsWith('#')) {
        ctx.strokeStyle = LANES[i].color + '40';
      }
      ctx.lineWidth = 1;
      ctx.strokeRect(lx + 4, 0, laneWidth - 8, ch);

      // Active glow
      if (glow > 0.01) {
        var gradient = ctx.createLinearGradient(lx, 0, lx + laneWidth, 0);
        gradient.addColorStop(0, 'transparent');
        gradient.addColorStop(0.5, LANES[i].color.replace(')', ', ' + (glow * 0.3) + ')').replace('rgb', 'rgba'));
        gradient.addColorStop(1, 'transparent');
        ctx.fillStyle = gradient;
        ctx.fillRect(lx, 0, laneWidth, ch);
      }

      // Lane label at top
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = '10px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(LANES[i].label, lx + laneWidth / 2, 22);
      ctx.fillText(LANES[i].note, lx + laneWidth / 2, 36);
    }

    // Hit zone line
    var hitY = ch * HIT_ZONE_RATIO;
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 4]);
    ctx.beginPath();
    ctx.moveTo(0, hitY);
    ctx.lineTo(cw, hitY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Hit zone label
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('触碰区域', cw - 16, hitY - 8);
  }

  function drawNotes(now) {
    if (!ctx || !canvas) return;
    var cw = canvas.width;
    var ch = canvas.height;
    var hitY = ch * HIT_ZONE_RATIO;
    var elapsed = now - gameStartTime;

    for (var i = 0; i < notes.length; i++) {
      var note = notes[i];
      var noteTime = note.time - LATENCY_OFFSET;
      var y = hitY - (noteTime - elapsed) * NOTE_SPEED;

      // Cull notes that are far past the hit zone
      if (y > ch + 100 && note.judged) continue;
      if (y > ch + 200) continue;

      var lx = laneOffsetX + note.lane * laneWidth;
      var noteW = laneWidth - 16;
      var noteH = NOTE_HEIGHT;
      var nx = lx + 8;
      var ny = y - noteH / 2;

      // Note color — dim if missed, bright if waiting
      var alpha = note.judged ? 0.2 : 0.85;
      var color = LANES[note.lane].color;

      // Glow when near hit zone
      var distToHit = Math.abs(y - hitY);
      if (distToHit < 40 && !note.judged) {
        alpha = 1.0;
        ctx.shadowColor = color;
        ctx.shadowBlur = 12;
      }

      // Draw note body
      ctx.fillStyle = color;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.roundRect(nx, ny, noteW, noteH, 6);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;

      // Inner highlight
      if (!note.judged) {
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.fillRect(nx + 4, ny + 3, noteW - 8, noteH * 0.35);
      }
    }
  }

  function drawParticles(dt) {
    if (!ctx) return;
    for (var i = particles.length - 1; i >= 0; i--) {
      var p = particles[i];
      p.x += p.vx * dt / 16;
      p.y += p.vy * dt / 16;
      p.vy += 0.05;
      p.life -= dt;

      if (p.life <= 0) {
        particles.splice(i, 1);
        continue;
      }

      var alpha = p.life / p.maxLife;
      ctx.fillStyle = p.color;
      ctx.globalAlpha = alpha;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }

  function drawFloatingTexts(dt) {
    if (!ctx) return;
    for (var i = floatingTexts.length - 1; i >= 0; i--) {
      var ft = floatingTexts[i];
      ft.y -= 1.2 * dt / 16;
      ft.life -= dt;

      if (ft.life <= 0) {
        floatingTexts.splice(i, 1);
        continue;
      }

      var alpha = Math.min(1, ft.life / 200);
      ctx.fillStyle = ft.color;
      ctx.globalAlpha = alpha;
      ctx.font = 'bold 18px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(ft.text, ft.x, ft.y);
    }
    ctx.globalAlpha = 1;
  }

  function drawHandStatus(now) {
    if (!ctx || !canvas) return;
    var cw = canvas.width;
    var ch = canvas.height;

    // Hand indicators at bottom
    for (var h = 0; h < 2; h++) {
      var handLm = gesture.getHandLandmarks(h);
      var handedness = gesture.getHandHandedness(h);
      var present = !!handLm;

      var x = h === 0 ? cw * 0.25 : cw * 0.75;
      var y = ch - 30;

      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fillStyle = present ? '#00FF88' : '#FF4466';
      ctx.fill();

      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.font = '11px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      var label = handedness === 'Left' ? '左手' : (handedness === 'Right' ? '右手' : '手' + (h + 1));
      ctx.fillText(present ? label + ' ?' : '等待 ' + label, x, y + 22);
    }
  }

  // ── Game Logic Tick ─────────────────────────────────────────────────
  function tick(now) {
    if (state !== 'playing' && state !== 'countdown') {
      requestAnimationFrame(tick);
      return;
    }

    try { var dt = 16.67; // assume ~60fps
    if (tick._lastTime) {
      dt = Math.min(now - tick._lastTime, 33);
    }
    tick._lastTime = now;

    // Check hand-in-zone
    isHandInZone = gesture.isInsideZone();

    // Update lane glows based on current pinch states
    for (var i = 0; i < LANES.length; i++) {
      var dist = gesture.pinchDistanceForHand(LANES[i].hand, LANES[i].finger);
      var isPinching = dist < PINCH_THRESHOLD;

      // Rising edge: pinch just started
      if (isPinching && !prevPinchStates[i] && isHandInZone) {
        playNote(i);
        laneGlows[i] = 1.0;

        // Check for note hits
        checkNoteHit(i, now);
      }

      // Decay glow
      laneGlows[i] *= 0.88;
      // Sync sidebar legend bar
      if (legendFills && legendFills[i]) {
        legendFills[i].style.width = (laneGlows[i] * 100) + '%';
      }
      if (legendRows && legendRows[i]) {
        legendRows[i].className = 'legend-row' + (laneGlows[i] > 0.02 ? ' active' : '');
      }
      prevPinchStates[i] = isPinching;
    }

    // Countdown logic
    if (state === 'countdown') {
      var elapsedCount = now - countdownStart;
      var newCountdown = 3 - Math.floor(elapsedCount / 1000);
      if (newCountdown !== countdownValue && newCountdown >= 0) {
        countdownValue = newCountdown;
        // Show countdown via floating text
        if (countdownValue > 0) {
          spawnFloatingText(canvas.width / 2, canvas.height / 2, '' + countdownValue, '#FFFFFF');
        } else {
          spawnFloatingText(canvas.width / 2, canvas.height / 2, 'START!', '#00FF88');
          state = 'playing';
          gameStartTime = now;
        }
      }
      if (newCountdown < 0) {
        state = 'playing';
        gameStartTime = now;
      }
    }

    // Auto-judge missed notes
    if (state === 'playing') {
      var elapsed = now - gameStartTime;
      for (var j = 0; j < notes.length; j++) {
        var note = notes[j];
        if (note.judged) continue;
        var missTime = note.time - LATENCY_OFFSET + HIT_WINDOW_GOOD;
        if (elapsed > missTime) {
          note.judged = true;
          note.hit = false;
          missCount++;
          combo = 0;
          spawnFloatingText(
            laneOffsetX + note.lane * laneWidth + laneWidth / 2,
            canvas.height * HIT_ZONE_RATIO,
            'MISS', '#FF4466'
          );
          updateHUD();
        }
      }
    }

    // Level progress check
    if (state === 'playing') {
      var levelElapsed = now - gameStartTime;
      if (levelElapsed > levelDuration) {
        // Auto-judge all remaining notes as missed on time-up
        for (var j = 0; j < notes.length; j++) {
          if (!notes[j].judged) {
            notes[j].judged = true;
            notes[j].hit = false;
            missCount++;
          }
        }
        combo = 0;
        updateHUD();
        if (notes.length > 0) completeLevel();
      }
    }

    // Render
    if (ctx && canvas) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawLanes();
      if (state === 'playing') drawNotes(now);
      drawParticles(dt);
      drawFloatingTexts(dt);
      drawHandStatus(now);
    }

    requestAnimationFrame(tick); } catch(e) { console.error("tick error:", e); requestAnimationFrame(tick); }
  }

  function checkNoteHit(laneIndex, now) {
    var elapsed = now - gameStartTime;
    var hitY = canvas.height * HIT_ZONE_RATIO;

    // Find the closest unjudged note in this lane
    var bestNote = null;
    var bestDist = Infinity;

    for (var i = 0; i < notes.length; i++) {
      var note = notes[i];
      if (note.lane !== laneIndex || note.judged) continue;

      var noteTime = note.time - LATENCY_OFFSET;
      var timeDiff = Math.abs(elapsed - noteTime);

      if (timeDiff < HIT_WINDOW_GOOD && timeDiff < bestDist) {
        bestDist = timeDiff;
        bestNote = note;
      }
    }

    if (!bestNote) return;

    bestNote.judged = true;
    bestNote.hit = true;

    var noteX = laneOffsetX + laneIndex * laneWidth + laneWidth / 2;

    if (bestDist <= HIT_WINDOW_PERFECT) {
      // Perfect!
      perfectCount++;
      combo++;
      score += 100 * Math.max(1, Math.floor(combo / 10) + 1);
      spawnParticles(noteX, hitY, 14, LANES[laneIndex].color, 3, 500);
      spawnFloatingText(noteX, hitY - 10, 'PERFECT!', '#FFD700');
      laneGlows[laneIndex] = 1.5;
    } else {
      // Good
      goodCount++;
      combo++;
      score += 50 * Math.max(1, Math.floor(combo / 15) + 1);
      spawnParticles(noteX, hitY, 8, LANES[laneIndex].color, 2, 400);
      spawnFloatingText(noteX, hitY - 10, 'GOOD', '#00FF88');
    }

    if (combo > maxCombo) maxCombo = combo;
    updateHUD();
  }

  function updateHUD() {
    if (hud.score) hud.score.textContent = '得分: ' + score;
    if (hud.lives) hud.lives.textContent = ""+_('t_waiting_for', 'Waiting ')+"" + combo + ' combo';
    if (hud.level) hud.level.textContent = '关卡: ' + (currentLevel + 1);
    if (hud.timer && state === 'playing') {
      var remaining = Math.max(0, Math.ceil((levelDuration - (performance.now() - gameStartTime)) / 1000));
      hud.timer.textContent = remaining + 's';
    }
  }

  function completeLevel() {
    if (currentLevel + 1 >= maxLevel) {
      // Game complete
      state = 'gameover';
      var accuracy = totalNotes > 0 ? ((perfectCount + goodCount) / totalNotes * 100).toFixed(1) : '0';
      if (finalScoreEl) finalScoreEl.textContent = score + ' (精度 ' + accuracy + '%)';
      if (levelCompleteMsg) levelCompleteMsg.textContent = '全部通关！最大连击: ' + maxCombo;
      if (screens.gameOver) screens.gameOver.classList.remove('hidden');
    } else {
      state = 'levelComplete';
      if (levelCompleteMsg) levelCompleteMsg.textContent = '第 ' + (currentLevel + 1) + ' 关完成！准备下一关…';
      if (screens.levelComplete) screens.levelComplete.classList.remove('hidden');
    }
  }

  // ── Public API ──────────────────────────────────────────────────────
  window.Game = {
    start: function (opts) {
      canvas = opts.canvas;
      ctx = canvas.getContext('2d');
      gesture = opts.gesture;
      hud = opts.hud || {};
      screens = opts.screens || {};
      finalScoreEl = opts.finalScoreEl;
      levelCompleteMsg = opts.levelCompleteMsg;
      legendFills = opts.legendFills || null;
      legendRows = opts.legendRows || null;

      // Calculate lane geometry
      laneWidth = canvas.width / LANES.length;
      laneOffsetX = 0;

      // Initialize audio
      initAudio();

      // Start game
      this.restart();
    },

    restart: function () {
      score = 0;
      combo = 0;
      maxCombo = 0;
      perfectCount = 0;
      goodCount = 0;
      missCount = 0;
      currentLevel = 0;
      particles = [];
      floatingTexts = [];
      laneGlows = [0, 0, 0, 0, 0, 0, 0, 0];
      prevPinchStates = [false, false, false, false, false, false, false, false];

      // Generate level 0 chart
      var result = generateNoteChart(0);
      notes = result.chart;
      levelDuration = result.duration;
      totalNotes = notes.length;

      // Start countdown
      state = 'countdown';
      countdownStart = performance.now();
      countdownValue = 3;

      updateHUD();
      if (hud.timer) hud.timer.textContent = Math.ceil(levelDuration / 1000) + 's';

      if (screens.gameOver) screens.gameOver.classList.add('hidden');
      if (screens.levelComplete) screens.levelComplete.classList.add('hidden');

      // Start game loop if not already running
      if (!tick._running) {
        tick._running = true;
        requestAnimationFrame(tick);
      }
    },

    nextLevel: function () {
      currentLevel++;
      particles = [];
      floatingTexts = [];
      laneGlows = [0, 0, 0, 0, 0, 0, 0, 0];
      prevPinchStates = [false, false, false, false, false, false, false, false];

      var result = generateNoteChart(currentLevel);
      notes = result.chart;
      levelDuration = result.duration;
      totalNotes += notes.length;

      state = 'countdown';
      countdownStart = performance.now();
      countdownValue = 3;

      updateHUD();
      if (hud.timer) hud.timer.textContent = Math.ceil(levelDuration / 1000) + 's';

      if (screens.levelComplete) screens.levelComplete.classList.add('hidden');
    },
  };

  // ── Polyfill: CanvasRenderingContext2D.roundRect ─────────────────────
  if (!CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
      if (typeof r === 'number') r = { tl: r, tr: r, br: r, bl: r };
      this.beginPath();
      this.moveTo(x + r.tl, y);
      this.lineTo(x + w - r.tr, y);
      this.quadraticCurveTo(x + w, y, x + w, y + r.tr);
      this.lineTo(x + w, y + h - r.br);
      this.quadraticCurveTo(x + w, y + h, x + w - r.br, y + h);
      this.lineTo(x + r.bl, y + h);
      this.quadraticCurveTo(x, y + h, x, y + h - r.bl);
      this.lineTo(x, y + r.tl);
      this.quadraticCurveTo(x, y, x + r.tl, y);
      this.closePath();
    };
  }

})();


