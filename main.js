(function () {
  'use strict';

  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');

  const img = new Image();
  // file:// 에서는 crossOrigin 없이 로드해야 할 수 있음
  if (window.location.protocol !== 'file:') {
    img.crossOrigin = 'anonymous';
  }
  img.src = 'bada.jpg';

  // 터치한 위치에서 퍼져 나가는 물결 (더 출렁이게)
  const ripples = [];
  const RIPPLE_DURATION = 2200;
  const RIPPLE_AMPLITUDE = 7;     // 더 크게 출렁
  const RIPPLE_WAVELENGTH = 60;
  const RIPPLE_SPEED = 0.01;
  const RIPPLE_RADIUS = 95;       // 영향 반경 넓게
  const SPLASH_DURATION = 1400;
  const SPLASH_RADIUS = 110;
  const SPLASH_AMPLITUDE = 5;

  let imgWidth = 0;
  let imgHeight = 0;
  let drawWidth = 0;
  let drawHeight = 0;
  let offsetX = 0;
  let offsetY = 0;
  let glCanvas = null;
  let gl = null;
  let glProgram = null;
  let glTexture = null;
  let glQuadBuffer = null;
  let glUniformLocs = null;
  let glUseRipple = false;
  let mode = 'wave';             // 'wave' | 'rain'
  const splashes = [];
  const rainDrops = [];
  const RAIN_DROP_SPEED = 5;
  const MAX_SPLASHES = 8;
  const MAX_RAIN_DROPS = 40;
  let cameraEnabled = false;
  let handsInstance = null;
  let cameraVideo = null;
  let cameraStream = null;
  let lastHandRippleTime = 0;
  const INDEX_FINGER_TIP = 8;

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight || document.documentElement.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    drawWidth = w;
    drawHeight = h;
    if (img.naturalWidth) fitImage();
  }

  function fitImage() {
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    const vw = drawWidth;
    const vh = drawHeight;
    const scale = Math.max(vw / iw, vh / ih);
    imgWidth = iw * scale;
    imgHeight = ih * scale;
    offsetX = (vw - imgWidth) / 2;
    offsetY = (vh - imgHeight) / 2;
    initWebGL();
  }

  const VERTEX_SHADER = [
    'attribute vec2 aPos;',
    'varying vec2 vUv;',
    'void main() {',
    '  vUv = vec2(aPos.x * 0.5 + 0.5, 1.0 - (aPos.y * 0.5 + 0.5));',
    '  gl_Position = vec4(aPos, 0.0, 1.0);',
    '}'
  ].join('\n');

  const FRAGMENT_SHADER = [
    'precision mediump float;',
    'uniform sampler2D uTex;',
    'uniform float uTime;',
    'uniform vec2 uOffset;',
    'uniform vec2 uImgSize;',
    'uniform float uRadius;',
    'uniform float uAmplitude;',
    'uniform float uDuration;',
    'uniform float uSpeed;',
    'uniform float uSplashRadius;',
    'uniform float uSplashAmp;',
    'uniform float uSplashDuration;',
    'uniform int uMode;',
    'uniform int uCount;',
    'uniform vec3 uR0, uR1, uR2, uR3, uR4, uR5;',
    'varying vec2 vUv;',
    'void main() {',
    '  vec2 screenPos = vec2(gl_FragCoord.x + uOffset.x, uOffset.y + uImgSize.y - gl_FragCoord.y);',
    '  float dx = 0.0, dy = 0.0;',
    '  vec3 r; float elapsed, dist, progress, fade, phase, wave, falloff, strength, invDist;',
    '  for (int i = 0; i < 6; i++) {',
    '    if (i >= uCount) break;',
    '    if (i == 0) r = uR0; else if (i == 1) r = uR1; else if (i == 2) r = uR2;',
    '    else if (i == 3) r = uR3; else if (i == 4) r = uR4; else r = uR5;',
    '    elapsed = uTime - r.z;',
    '    if (uMode == 0) {',
    '      if (elapsed > uDuration) continue;',
    '      dist = distance(screenPos, r.xy);',
    '      if (dist > uRadius) continue;',
    '      progress = elapsed / uDuration;',
    '      fade = pow(1.0 - progress, 1.2);',
    '      phase = (dist * 0.04) - (elapsed * uSpeed);',
    '      wave = sin(phase) * fade * uAmplitude;',
    '      falloff = pow(1.0 - dist / uRadius, 1.5);',
    '      strength = wave * falloff;',
    '      if (dist > 0.1) { invDist = 1.0 / dist; dx += strength * (screenPos.x - r.x) * invDist; dy += strength * (screenPos.y - r.y) * invDist; }',
    '    } else {',
    '      if (elapsed > uSplashDuration) continue;',
    '      dist = distance(screenPos, r.xy);',
    '      if (dist > uSplashRadius) continue;',
    '      progress = elapsed / uSplashDuration;',
    '      fade = pow(1.0 - progress, 1.4);',
    '      falloff = pow(1.0 - dist / uSplashRadius, 2.0);',
    '      strength = uSplashAmp * fade * falloff;',
    '      if (dist > 0.1) { invDist = 1.0 / dist; dx += strength * (screenPos.x - r.x) * invDist; dy += strength * (screenPos.y - r.y) * invDist; }',
    '    }',
    '  }',
    '  vec2 uvOffset = vec2(dx / uImgSize.x, dy / uImgSize.y);',
    '  gl_FragColor = texture2D(uTex, vUv + uvOffset);',
    '}'
  ].join('\n');

  function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  function initWebGL() {
    if (!imgWidth || !imgHeight || !img.naturalWidth) return;
    const w = Math.round(imgWidth);
    const h = Math.round(imgHeight);
    if (glCanvas && glCanvas.width === w && glCanvas.height === h) {
      updateGlTexture();
      return;
    }
    glCanvas = document.createElement('canvas');
    glCanvas.width = w;
    glCanvas.height = h;
    gl = glCanvas.getContext('webgl', { preserveDrawingBuffer: true }) ||
         glCanvas.getContext('experimental-webgl', { preserveDrawingBuffer: true });
    if (!gl) {
      glUseRipple = false;
      return;
    }
    const vs = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = createShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!vs || !fs) {
      glUseRipple = false;
      return;
    }
    glProgram = gl.createProgram();
    gl.attachShader(glProgram, vs);
    gl.attachShader(glProgram, fs);
    gl.linkProgram(glProgram);
    if (!gl.getProgramParameter(glProgram, gl.LINK_STATUS)) {
      glUseRipple = false;
      return;
    }
    glUniformLocs = {
      uTex: gl.getUniformLocation(glProgram, 'uTex'),
      uTime: gl.getUniformLocation(glProgram, 'uTime'),
      uOffset: gl.getUniformLocation(glProgram, 'uOffset'),
      uImgSize: gl.getUniformLocation(glProgram, 'uImgSize'),
      uRadius: gl.getUniformLocation(glProgram, 'uRadius'),
      uAmplitude: gl.getUniformLocation(glProgram, 'uAmplitude'),
      uDuration: gl.getUniformLocation(glProgram, 'uDuration'),
      uSpeed: gl.getUniformLocation(glProgram, 'uSpeed'),
      uSplashRadius: gl.getUniformLocation(glProgram, 'uSplashRadius'),
      uSplashAmp: gl.getUniformLocation(glProgram, 'uSplashAmp'),
      uSplashDuration: gl.getUniformLocation(glProgram, 'uSplashDuration'),
      uMode: gl.getUniformLocation(glProgram, 'uMode'),
      uCount: gl.getUniformLocation(glProgram, 'uCount'),
      uR0: gl.getUniformLocation(glProgram, 'uR0'),
      uR1: gl.getUniformLocation(glProgram, 'uR1'),
      uR2: gl.getUniformLocation(glProgram, 'uR2'),
      uR3: gl.getUniformLocation(glProgram, 'uR3'),
      uR4: gl.getUniformLocation(glProgram, 'uR4'),
      uR5: gl.getUniformLocation(glProgram, 'uR5')
    };
    glQuadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, glQuadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    glTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, glTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    updateGlTexture();
    glUseRipple = true;
  }

  function updateGlTexture() {
    if (!gl || !glTexture || !img.naturalWidth) return;
    gl.bindTexture(gl.TEXTURE_2D, glTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  }

  const MIN_RIPPLE_DIST = 18;   // 드래그 시 경로를 따라 물결 (작을수록 촘촘)
  const MAX_RIPPLES = 8;

  function addRipple(x, y) {
    const last = ripples[ripples.length - 1];
    if (last && Math.hypot(x - last.x, y - last.y) < MIN_RIPPLE_DIST) return;
    ripples.push({ x, y, start: performance.now() });
    while (ripples.length > MAX_RIPPLES) ripples.shift();
  }

  function addSplash(x, y) {
    const scale = 0.45 + Math.random() * 0.55;
    const duration = 500 + Math.random() * 800;
    splashes.push({ x, y, start: performance.now(), scale: scale, duration: duration });
    while (splashes.length > MAX_SPLASHES) splashes.shift();
  }

  function addRainDrop(x, y) {
    const px = x + (Math.random() - 0.5) * 48;
    const py = y + (Math.random() - 0.5) * 28;
    const len = 10 + Math.random() * 6;
    const maxFall = 50 + Math.random() * 90;
    rainDrops.push({ x: px, y: py, startY: py, maxFall: maxFall, vy: RAIN_DROP_SPEED, len: len });
    while (rainDrops.length > MAX_RAIN_DROPS) rainDrops.shift();
  }

  function cleanupSplashes(now) {
    for (let i = splashes.length - 1; i >= 0; i--) {
      const d = splashes[i].duration != null ? splashes[i].duration : SPLASH_DURATION;
      if (now - splashes[i].start > d) splashes.splice(i, 1);
    }
  }

  function updateRainDrops() {
    const landY = (d) => d.startY + d.maxFall;
    for (let i = rainDrops.length - 1; i >= 0; i--) {
      const d = rainDrops[i];
      d.y += d.vy;
      if (d.y >= landY(d)) {
        addSplash(d.x, d.y);
        rainDrops.splice(i, 1);
      }
    }
    while (rainDrops.length > MAX_RAIN_DROPS) rainDrops.shift();
  }

  function cleanupRipples(now) {
    for (let i = ripples.length - 1; i >= 0; i--) {
      if (now - ripples[i].start > RIPPLE_DURATION) ripples.splice(i, 1);
    }
  }

  let loadError = false;

  function drawSplashWaveRings(now) {
    for (let i = 0; i < splashes.length; i++) {
      const s = splashes[i];
      const elapsed = now - s.start;
      const splashDuration = s.duration != null ? s.duration : SPLASH_DURATION;
      if (elapsed > splashDuration) continue;
      const progress = elapsed / splashDuration;
      const fade = 1 - progress * progress;
      const sizeScale = s.scale != null ? s.scale : 1;
      const baseR = (elapsed * 0.14) * sizeScale;
      const ringStep = 12 * sizeScale;
      const t = elapsed * 0.004;
      const seed = (s.x * 0.1 + s.y) * 0.2;
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.22 * fade) + ')';
      ctx.lineWidth = 1.2;
      for (let ring = 0; ring < 3; ring++) {
        const r = Math.max(0, baseR - ring * ringStep);
        if (r < 3) continue;
        ctx.beginPath();
        const segs = 80;
        for (let k = 0; k <= segs; k++) {
          const angle = (k / segs) * Math.PI * 2;
          const a1 = angle * 2.3 + t + seed;
          const a2 = angle * 5.7 + t * 1.1 + seed * 1.3;
          const a3 = angle * 8.1 + t * 0.8 + seed * 0.7;
          const a4 = angle * 11.3 + t * 1.4;
          const wobble = 1.8 * Math.sin(a1) + 1.2 * Math.sin(a2) + 0.9 * Math.sin(a3) + 0.6 * Math.sin(a4);
          const R = r + wobble;
          const px = s.x + R * Math.cos(angle);
          const py = s.y + R * Math.sin(angle);
          if (k === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.stroke();
      }
    }
  }

  function drawImageOnly() {
    ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, offsetX, offsetY, imgWidth, imgHeight);
  }

  function getDisplacement(tx, ty, now) {
    let dx = 0, dy = 0;
    if (mode === 'wave') {
      for (let i = ripples.length - 1; i >= 0; i--) {
        const r = ripples[i];
        const elapsed = now - r.start;
        if (elapsed > RIPPLE_DURATION) continue;
        const dist = Math.hypot(tx - r.x, ty - r.y);
        if (dist > RIPPLE_RADIUS) continue;
        const progress = elapsed / RIPPLE_DURATION;
        const fade = Math.pow(1 - progress, 1.2);
        const phase = (dist * 0.04) - (elapsed * RIPPLE_SPEED);
        const wave = Math.sin(phase) * fade * RIPPLE_AMPLITUDE;
        const falloff = Math.pow(1 - dist / RIPPLE_RADIUS, 1.5);
        const strength = wave * falloff;
        if (dist > 0.1) {
          dx += (strength * (tx - r.x)) / dist;
          dy += (strength * (ty - r.y)) / dist;
        }
      }
    } else {
      for (let i = splashes.length - 1; i >= 0; i--) {
        const s = splashes[i];
        const elapsed = now - s.start;
        if (elapsed > SPLASH_DURATION) continue;
        const dist = Math.hypot(tx - s.x, ty - s.y);
        if (dist > SPLASH_RADIUS) continue;
        const progress = elapsed / SPLASH_DURATION;
        const fade = Math.pow(1 - progress, 1.4);
        const falloff = Math.pow(1 - dist / SPLASH_RADIUS, 2);
        const strength = SPLASH_AMPLITUDE * fade * falloff;
        if (dist > 0.1) {
          dx += (strength * (tx - s.x)) / dist;
          dy += (strength * (ty - s.y)) / dist;
        }
      }
    }
    return { dx, dy };
  }

  function drawWithTiles(now) {
    const tw = 10;
    const th = 10;
    const scaleX = img.naturalWidth / imgWidth;
    const scaleY = img.naturalHeight / imgHeight;
    const cols = Math.ceil(imgWidth / tw) + 1;
    const rows = Math.ceil(imgHeight / th) + 1;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const tx = col * tw;
        const ty = row * th;
        const tw_ = Math.min(tw, imgWidth - tx);
        const th_ = Math.min(th, imgHeight - ty);
        if (tw_ <= 0 || th_ <= 0) continue;
        const cx = offsetX + tx + tw_ / 2;
        const cy = offsetY + ty + th_ / 2;
        const { dx, dy } = getDisplacement(cx, cy, now);
        ctx.drawImage(img, tx * scaleX, ty * scaleY, tw_ * scaleX, th_ * scaleY, offsetX + tx + dx, offsetY + ty + dy, tw_, th_);
      }
    }
  }

  function drawWebGL(now) {
    if (!gl || !glProgram || !glTexture || !glQuadBuffer || !glUniformLocs) return;
    const isRain = mode === 'rain';
    const active = isRain ? splashes.slice(0, 6) : ripples.slice(0, 6);
    const loc = glUniformLocs;
    gl.viewport(0, 0, glCanvas.width, glCanvas.height);
    gl.useProgram(glProgram);
    const aPos = gl.getAttribLocation(glProgram, 'aPos');
    gl.bindBuffer(gl.ARRAY_BUFFER, glQuadBuffer);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, glTexture);
    if (loc.uTex !== null) gl.uniform1i(loc.uTex, 0);
    if (loc.uTime !== null) gl.uniform1f(loc.uTime, now);
    if (loc.uOffset !== null) gl.uniform2f(loc.uOffset, offsetX, offsetY);
    if (loc.uImgSize !== null) gl.uniform2f(loc.uImgSize, imgWidth, imgHeight);
    if (loc.uRadius !== null) gl.uniform1f(loc.uRadius, RIPPLE_RADIUS);
    if (loc.uAmplitude !== null) gl.uniform1f(loc.uAmplitude, RIPPLE_AMPLITUDE);
    if (loc.uDuration !== null) gl.uniform1f(loc.uDuration, RIPPLE_DURATION);
    if (loc.uSpeed !== null) gl.uniform1f(loc.uSpeed, RIPPLE_SPEED);
    if (loc.uSplashRadius !== null) gl.uniform1f(loc.uSplashRadius, SPLASH_RADIUS);
    if (loc.uSplashAmp !== null) gl.uniform1f(loc.uSplashAmp, SPLASH_AMPLITUDE);
    if (loc.uSplashDuration !== null) gl.uniform1f(loc.uSplashDuration, SPLASH_DURATION);
    if (loc.uMode !== null) gl.uniform1i(loc.uMode, isRain ? 1 : 0);
    if (loc.uCount !== null) gl.uniform1i(loc.uCount, active.length);
    const rLocs = [loc.uR0, loc.uR1, loc.uR2, loc.uR3, loc.uR4, loc.uR5];
    for (let i = 0; i < 6; i++) {
      if (rLocs[i] !== null) {
        if (i < active.length) gl.uniform3f(rLocs[i], active[i].x, active[i].y, active[i].start);
        else gl.uniform3f(rLocs[i], 0, 0, 0);
      }
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  function draw() {
    const now = performance.now();
    if (!imgWidth || !imgHeight || !img.naturalWidth) {
      if (loadError) drawLoadError();
      requestAnimationFrame(draw);
      return;
    }
    cleanupRipples(now);
    cleanupSplashes(now);
    if (mode === 'rain') updateRainDrops();

    ctx.fillStyle = '#0a0a12';
    ctx.fillRect(0, 0, drawWidth, drawHeight);
    ctx.save();
    ctx.beginPath();
    ctx.rect(offsetX, offsetY, imgWidth, imgHeight);
    ctx.clip();

    if (glUseRipple && gl && glProgram) {
      drawWebGL(now);
      ctx.drawImage(glCanvas, 0, 0, glCanvas.width, glCanvas.height, offsetX, offsetY, imgWidth, imgHeight);
    } else {
      drawWithTiles(now);
    }
    if (mode === 'rain') drawSplashWaveRings(now);
    ctx.restore();

    if (mode === 'rain' && rainDrops.length > 0) {
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1.8;
      ctx.lineCap = 'round';
      for (let i = 0; i < rainDrops.length; i++) {
        const d = rainDrops[i];
        const len = d.len || 12;
        ctx.beginPath();
        ctx.moveTo(d.x, d.y - len);
        ctx.lineTo(d.x, d.y);
        ctx.stroke();
      }
    }
    requestAnimationFrame(draw);
  }

  function getCanvasPoint(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: clientX - rect.left,
      y: clientY - rect.top
    };
  }

  function onTouchStart(e) {
    e.preventDefault();
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      const { x, y } = getCanvasPoint(t.clientX, t.clientY);
      if (mode === 'rain') addRainDrop(x, y); else addRipple(x, y);
    }
  }

  function onTouchMove(e) {
    e.preventDefault();
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      const { x, y } = getCanvasPoint(t.clientX, t.clientY);
      if (mode === 'rain') addRainDrop(x, y); else addRipple(x, y);
    }
  }

  let isPointerDown = false;
  let isMouseDown = false;

  function docMouseMove(e) {
    if (!isMouseDown) return;
    e.preventDefault();
    const { x, y } = getCanvasPoint(e.clientX, e.clientY);
    if (mode === 'rain') addRainDrop(x, y); else addRipple(x, y);
  }

  function docMouseUp() {
    if (!isMouseDown) return;
    isMouseDown = false;
    document.removeEventListener('mousemove', docMouseMove, true);
    document.removeEventListener('mouseup', docMouseUp, true);
  }

  function onPointerDown(e) {
    if (e.pointerType === 'mouse') return;
    e.preventDefault();
    isPointerDown = true;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    const { x, y } = getCanvasPoint(e.clientX, e.clientY);
    addRipple(x, y);
  }

  function onPointerMove(e) {
    if (e.pointerType === 'mouse') return;
    if (!isPointerDown) return;
    e.preventDefault();
    const { x, y } = getCanvasPoint(e.clientX, e.clientY);
    addRipple(x, y);
  }

  function onPointerUp(e) {
    if (e.pointerType === 'mouse') return;
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}
    isPointerDown = false;
  }

  function onMouseDown(e) {
    e.preventDefault();
    e.stopPropagation();
    isMouseDown = true;
    const { x, y } = getCanvasPoint(e.clientX, e.clientY);
    if (mode === 'rain') addRainDrop(x, y); else addRipple(x, y);
    document.addEventListener('mousemove', docMouseMove, true);
    document.addEventListener('mouseup', docMouseUp, true);
  }

  img.onload = function () {
    loadError = false;
    fitImage();
  };

  img.onerror = function () {
    loadError = true;
  };

  function drawLoadError() {
    const w = drawWidth;
    const h = drawHeight;
    if (!w || !h) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const scale = canvas.width / w;
    ctx.scale(scale, scale);
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#e0e0e0';
    ctx.font = '18px sans-serif';
    ctx.textAlign = 'center';
    const msg1 = 'bada.jpg를 불러올 수 없습니다.';
    const msg2 = '이 폴더에서 터미널을 열고';
    const msg3 = "  npx serve .  ";
    const msg4 = '실행 후 브라우저에서 http://localhost:3000 으로 접속하세요.';
    ctx.fillText(msg1, w / 2, h / 2 - 50);
    ctx.fillText(msg2, w / 2, h / 2 - 20);
    ctx.font = 'bold 20px monospace';
    ctx.fillText(msg3, w / 2, h / 2 + 15);
    ctx.font = '18px sans-serif';
    ctx.fillText(msg4, w / 2, h / 2 + 50);
    ctx.restore();
  }

  function toggleFullscreen() {
    const doc = document;
    const body = doc.body;
    if (body.classList.contains('fullscreen')) {
      body.classList.remove('fullscreen');
      setTimeout(resize, 50);
      updateFullscreenButton();
      return;
    }
    if (doc.fullscreenElement || doc.webkitFullscreenElement || doc.mozFullScreenElement || doc.msFullscreenElement) {
      if (doc.exitFullscreen) doc.exitFullscreen();
      else if (doc.webkitExitFullscreen) doc.webkitExitFullscreen();
      else if (doc.mozCancelFullScreen) doc.mozCancelFullScreen();
      else if (doc.msExitFullscreen) doc.msExitFullscreen();
      updateFullscreenButton();
      return;
    }
    const el = doc.documentElement;
    const requested = el.requestFullscreen ? el.requestFullscreen() : el.webkitRequestFullscreen ? el.webkitRequestFullscreen() : el.mozRequestFullScreen ? el.mozRequestFullScreen() : el.msRequestFullscreen ? el.msRequestFullscreen() : null;
    if (requested && typeof requested.then === 'function') {
      requested.catch(function () { body.classList.add('fullscreen'); updateFullscreenButton(); });
    }
    setTimeout(function () {
      if (!doc.fullscreenElement && !doc.webkitFullscreenElement && !doc.mozFullScreenElement && !doc.msFullscreenElement) {
        body.classList.add('fullscreen');
        setTimeout(resize, 50);
      }
      updateFullscreenButton();
    }, 250);
  }

  function updateFullscreenButton() {
    const btn = document.getElementById('btn-fullscreen');
    if (!btn) return;
    const on = document.body.classList.contains('fullscreen') || !!document.fullscreenElement || !!document.webkitFullscreenElement;
    btn.textContent = on ? '✕' : '⛶';
    btn.setAttribute('aria-label', on ? '전체화면 나가기' : '전체화면');
  }

  function setMode(m) {
    mode = m;
    document.body.classList.toggle('wave-mode', m === 'wave');
    const waveBtn = document.getElementById('btn-wave');
    const rainBtn = document.getElementById('btn-rain');
    if (waveBtn && rainBtn) {
      waveBtn.classList.toggle('active', m === 'wave');
      waveBtn.setAttribute('aria-pressed', m === 'wave');
      rainBtn.classList.toggle('active', m === 'rain');
      rainBtn.setAttribute('aria-pressed', m === 'rain');
    }
  }

  function onHandResult(results) {
    if (mode !== 'wave' || !cameraEnabled || !drawWidth || !drawHeight) return;
    if (results.multiHandLandmarks && results.multiHandLandmarks[0]) {
      const tip = results.multiHandLandmarks[0][INDEX_FINGER_TIP];
      const x = (1 - tip.x) * drawWidth;
      const y = tip.y * drawHeight;
      const now = performance.now();
      if (now - lastHandRippleTime > 140) {
        addRipple(x, y);
        lastHandRippleTime = now;
      }
    }
  }

  function runHandDetect() {
    if (!cameraEnabled || !handsInstance || !cameraVideo || mode !== 'wave') return;
    if (cameraVideo.readyState < 2) {
      requestAnimationFrame(runHandDetect);
      return;
    }
    handsInstance.send({ image: cameraVideo }).then(function (res) {
      if (res) onHandResult(res);
      requestAnimationFrame(runHandDetect);
    }).catch(function () {
      requestAnimationFrame(runHandDetect);
    });
  }

  function startCamera() {
    const video = document.getElementById('camera-video');
    if (!video) return;
    cameraVideo = video;
    video.setAttribute('playsinline', 'true');
    video.setAttribute('webkit-playsinline', 'true');
    function onStream(stream) {
      cameraStream = stream;
      video.srcObject = stream;
      video.play().catch(function () {});
      if (typeof Hands !== 'undefined') {
        handsInstance = new Hands({
          locateFile: function (file) {
            return 'https://cdn.jsdelivr.net/npm/@mediapipe/hands/' + file;
          }
        });
        handsInstance.onResults(onHandResult);
        handsInstance.setOptions({ maxNumHands: 1, modelComplexity: 1 });
        handsInstance.initialize().then(function () {
          runHandDetect();
        }).catch(function () {
          alert('손 인식 초기화에 실패했습니다.');
        });
      } else {
        alert('손 인식 라이브러리를 불러올 수 없습니다. 페이지를 새로고침해 보세요.');
      }
    }
    var constraints = {
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        facingMode: { ideal: 'user' }
      },
      audio: false
    };
    navigator.mediaDevices.getUserMedia(constraints).then(onStream).catch(function () {
      navigator.mediaDevices.getUserMedia({ video: true, audio: false }).then(onStream).catch(function () {
        alert('카메라 접근이 거부되었거나 사용할 수 없습니다. HTTPS에서 실행 중인지, 브라우저에서 카메라 권한을 허용했는지 확인해 주세요.');
      });
    });
  }

  function stopCamera() {
    if (cameraStream) {
      cameraStream.getTracks().forEach(function (t) { t.stop(); });
      cameraStream = null;
    }
    if (cameraVideo) {
      cameraVideo.srcObject = null;
    }
    handsInstance = null;
  }

  document.body.classList.add('wave-mode');

  document.getElementById('btn-fullscreen').addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    toggleFullscreen();
  });
  document.getElementById('btn-wave').addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    setMode('wave');
  });
  document.getElementById('btn-rain').addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    setMode('rain');
  });
  document.getElementById('camera-check').addEventListener('change', function (e) {
    cameraEnabled = e.target.checked;
    if (cameraEnabled) {
      if (mode === 'wave') startCamera();
    } else {
      stopCamera();
    }
  });
  document.addEventListener('fullscreenchange', updateFullscreenButton);
  document.addEventListener('webkitfullscreenchange', updateFullscreenButton);

  window.addEventListener('resize', resize);
  canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('mousedown', onMouseDown);

  resize();
  draw();
})();
