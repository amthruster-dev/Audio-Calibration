(function () {
  'use strict';
  const D = window.EQDSP;
  const $ = (id) => document.getElementById(id);

  const FFT_SIZE = 32768;
  const state = {
    ctx: null, analyser: null, stream: null, micSrc: null,
    noiseSrc: null, noiseGain: null,
    listening: false, hold: false, pink: false,
    freqs: D.defaultFreqs(10),
    avgPower: null,      // linear power per octave, per band (EMA)
    lastT: 0,
    peakDb: -120, rmsDb: -120,
    settings: { target: 'flat', tau: 8, range: 12, step: 1, preferCuts: false, noiseVol: 30 }
  };

  // ---------- persistence ----------
  function save() {
    try {
      localStorage.setItem('eqscope', JSON.stringify({ freqs: state.freqs, settings: state.settings }));
    } catch (e) { /* ignore */ }
  }
  function load() {
    try {
      const j = JSON.parse(localStorage.getItem('eqscope') || 'null');
      if (!j) return;
      if (Array.isArray(j.freqs) && j.freqs.length >= 3 && j.freqs.length <= 24) state.freqs = j.freqs;
      if (j.settings) Object.assign(state.settings, j.settings);
    } catch (e) { /* ignore */ }
  }

  // ---------- UI helpers ----------
  function setStatus(msg, warn) {
    const s = $('status');
    s.textContent = msg;
    s.className = 'status' + (warn ? ' warn' : '');
  }

  function syncControls() {
    $('bandCount').value = state.freqs.length;
    $('countLabel').textContent = state.freqs.length;
    $('freqText').value = state.freqs.join(', ');
    $('target').value = state.settings.target;
    $('tau').value = String(state.settings.tau);
    $('range').value = String(state.settings.range);
    $('step').value = String(state.settings.step);
    $('preferCuts').checked = !!state.settings.preferCuts;
    $('noiseVol').value = state.settings.noiseVol;
  }

  function resetAverage() { state.avgPower = null; }

  // ---------- audio ----------
  function ensureCtx() {
    if (!state.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      state.ctx = new AC({ latencyHint: 'interactive' });
    }
    if (state.ctx.state === 'suspended') state.ctx.resume();
    return state.ctx;
  }

  async function startMic() {
    const ctx = ensureCtx();
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1
        }
      });
    } catch (e) {
      setStatus('Microphone blocked. Allow microphone access for EQ Scope in Android settings.', true);
      return;
    }
    state.analyser = ctx.createAnalyser();
    state.analyser.fftSize = FFT_SIZE;
    state.analyser.smoothingTimeConstant = 0;
    state.analyser.minDecibels = -140;
    state.analyser.maxDecibels = 0;
    state.micSrc = ctx.createMediaStreamSource(state.stream);
    state.micSrc.connect(state.analyser); // not connected to output: no feedback
    state.listening = true;
    state.lastT = performance.now();
    resetAverage();
    $('btnMic').textContent = 'Stop listening';
    $('btnMic').classList.remove('primary');
    setStatus('Listening… keep the phone near where you sit, mic facing the speaker.');
    requestAnimationFrame(frame);
  }

  function stopMic() {
    state.listening = false;
    if (state.stream) state.stream.getTracks().forEach(t => t.stop());
    if (state.micSrc) state.micSrc.disconnect();
    state.stream = null; state.micSrc = null; state.analyser = null;
    $('btnMic').textContent = 'Start listening';
    $('btnMic').classList.add('primary');
    setStatus('Stopped.');
  }

  function makePinkBuffer(ctx) {
    const seconds = 20;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
    // short fade at the loop point to avoid a click
    const fade = Math.floor(ctx.sampleRate * 0.02);
    for (let i = 0; i < fade; i++) {
      const g = i / fade;
      d[i] *= g;
      d[len - 1 - i] *= g;
    }
    return buf;
  }

  function startPink() {
    const ctx = ensureCtx();
    state.noiseSrc = ctx.createBufferSource();
    state.noiseSrc.buffer = makePinkBuffer(ctx);
    state.noiseSrc.loop = true;
    state.noiseGain = ctx.createGain();
    state.noiseGain.gain.value = volToGain(state.settings.noiseVol);
    state.noiseSrc.connect(state.noiseGain).connect(ctx.destination);
    state.noiseSrc.start();
    state.pink = true;
    $('btnPink').textContent = 'Pink noise: on';
    $('btnPink').classList.add('on');
  }

  function stopPink() {
    if (state.noiseSrc) { try { state.noiseSrc.stop(); } catch (e) {} state.noiseSrc.disconnect(); }
    state.noiseSrc = null; state.noiseGain = null; state.pink = false;
    $('btnPink').textContent = 'Pink noise: off';
    $('btnPink').classList.remove('on');
  }

  function volToGain(v) { return Math.pow(v / 100, 2) * 0.8; }

  // ---------- analysis loop ----------
  const specBuf = new Float32Array(FFT_SIZE / 2);
  const timeBuf = new Float32Array(FFT_SIZE);
  let lastDraw = 0;

  function frame(now) {
    if (!state.listening) return;
    requestAnimationFrame(frame);
    if (now - lastDraw < 100) return;
    const dt = Math.max(0.01, (now - state.lastT) / 1000);
    state.lastT = now;
    lastDraw = now;

    // level meter (time domain)
    state.analyser.getFloatTimeDomainData(timeBuf);
    let peak = 0, sum = 0;
    for (let i = 0; i < timeBuf.length; i++) { const v = Math.abs(timeBuf[i]); if (v > peak) peak = v; sum += v * v; }
    state.peakDb = peak > 0 ? 20 * Math.log10(peak) : -120;
    state.rmsDb = sum > 0 ? 10 * Math.log10(sum / timeBuf.length) : -120;
    updateMeter();

    if (!state.hold) {
      state.analyser.getFloatFrequencyData(specBuf);
      const edges = D.bandEdges(state.freqs, state.ctx.sampleRate / 2);
      const p = D.bandPowers(specBuf, state.ctx.sampleRate, edges);
      if (!state.avgPower || state.avgPower.length !== p.length) {
        state.avgPower = p.slice();
      } else {
        const a = 1 - Math.exp(-dt / state.settings.tau);
        for (let i = 0; i < p.length; i++) state.avgPower[i] += a * (p[i] - state.avgPower[i]);
      }
    }
    render();
  }

  function updateMeter() {
    const pct = D.clamp((state.rmsDb + 80) / 80, 0, 1) * 100;
    $('meterFill').style.width = pct.toFixed(0) + '%';
    $('meterText').textContent = 'Input level: ' + state.rmsDb.toFixed(0) + ' dBFS (peak ' + state.peakDb.toFixed(0) + ')';
    if (state.peakDb > -1) setStatus('Mic is clipping. Lower the speaker volume or move the phone back.', true);
    else if (state.rmsDb < -70) setStatus('Signal too quiet. Raise the volume or move the phone closer.', true);
    else if ($('status').className.indexOf('warn') >= 0) setStatus(state.hold ? 'Held.' : 'Listening…');
  }

  // ---------- rendering ----------
  function currentEq() {
    if (!state.avgPower) return null;
    const levels = state.avgPower.map(D.toDb);
    return D.computeEq(state.freqs, levels, {
      target: state.settings.target,
      range: state.settings.range,
      step: state.settings.step,
      preferCuts: state.settings.preferCuts
    });
  }

  function fmtHz(f) { return f >= 1000 ? (f / 1000).toFixed(f % 1000 === 0 ? 0 : 2).replace(/\.?0+$/, '') + 'k' : String(Math.round(f)); }
  function fmtDb(v) { const s = (Math.round(v * 10) / 10).toFixed(1); return (v > 0 ? '+' : '') + s; }
  function fmtGain(v) { const dec = state.settings.step < 1 ? 1 : 0; const s = v.toFixed(dec); return (v > 0 ? '+' : '') + s; }

  function renderRecs() {
    const eq = currentEq();
    const ul = $('recs');
    ul.innerHTML = '';
    if (!eq) { $('summary').textContent = 'Start listening to get recommendations.'; return; }

    const avg = (pred) => {
      const v = [];
      state.freqs.forEach((f, i) => { if (pred(f)) v.push(eq.gain[i]); });
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    const describe = (name, g, lowWord, highWord) => {
      if (g === null || Math.abs(g) < 1.5) return null;
      return g > 0 ? name + ' is ' + lowWord : name + ' is ' + highWord;
    };
    const parts = [
      describe('Bass', avg(f => f < 250), 'weak', 'too strong'),
      describe('Mids', avg(f => f >= 250 && f < 4000), 'recessed', 'too forward'),
      describe('Treble', avg(f => f >= 4000), 'dull', 'too bright')
    ].filter(Boolean);
    $('summary').textContent = parts.length
      ? parts.join('. ') + '.'
      : 'Overall balance is close to your target.';

    const items = state.freqs.map((f, i) => ({ f, g: eq.gain[i] }))
      .filter(x => x.g !== 0)
      .sort((a, b) => Math.abs(b.g) - Math.abs(a.g));
    if (!items.length) {
      const li = document.createElement('li');
      li.textContent = 'No changes needed.';
      ul.appendChild(li);
      return;
    }
    items.forEach(x => {
      const li = document.createElement('li');
      const amt = Math.abs(x.g).toFixed(state.settings.step < 1 ? 1 : 0);
      li.innerHTML = (x.g > 0 ? '<span class="up">Raise</span> ' : '<span class="down">Lower</span> ') +
        fmtHz(x.f) + ' Hz by ' + amt + ' dB';
      ul.appendChild(li);
    });
  }

  function render() {
    renderRecs();
    renderTable();
    drawChart();
  }

  function renderTable() {
    const eq = currentEq();
    const tb = document.querySelector('#table tbody');
    tb.innerHTML = '';
    state.freqs.forEach((f, i) => {
      const tr = document.createElement('tr');
      const gain = eq ? eq.gain[i] : null;
      const cls = gain === null ? '' : (gain > 0 ? 'boost' : (gain < 0 ? 'cut' : ''));
      tr.innerHTML = '<td>' + fmtHz(f) + '</td>' +
        '<td>' + (eq ? fmtDb(eq.measured[i]) : '–') + '</td>' +
        '<td>' + (eq ? fmtDb(eq.target[i]) : '–') + '</td>' +
        '<td class="eq ' + cls + '">' + (eq ? fmtGain(gain) + ' dB' : '–') + '</td>';
      tb.appendChild(tr);
    });
    $('preamp').textContent = eq && state.settings.preferCuts
      ? 'Preamp / master volume: ' + fmtDb(eq.preamp) + ' dB (if your EQ has one)'
      : '';
  }

  function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }

  function drawChart() {
    const cv = $('chart');
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const eq = currentEq();
    const n = state.freqs.length;
    const padL = 30, padR = 6, padT = 8, padB = 22;
    const pw = w - padL - padR, ph = h - padT - padB;
    const R = state.settings.range;
    const yOf = (db) => padT + ph / 2 - (D.clamp(db, -R, R) / R) * (ph / 2);

    g.font = '11px system-ui, sans-serif';
    g.strokeStyle = css('--line'); g.fillStyle = css('--muted'); g.lineWidth = 1;
    g.textAlign = 'right'; g.textBaseline = 'middle';
    [-R, -R / 2, 0, R / 2, R].forEach(v => {
      const y = yOf(v);
      g.beginPath(); g.moveTo(padL, y); g.lineTo(w - padR, y); g.stroke();
      g.fillText(String(Math.round(v)), padL - 4, y);
    });

    const slot = pw / n;
    g.textAlign = 'center'; g.textBaseline = 'top';
    const labelEvery = n > 16 ? 3 : (n > 10 ? 2 : 1);
    for (let i = 0; i < n; i++) {
      if (i % labelEvery === 0) g.fillText(fmtHz(state.freqs[i]), padL + slot * (i + 0.5), h - padB + 6);
    }
    if (!eq) return;

    const zero = yOf(0);
    for (let i = 0; i < n; i++) {
      const gain = eq.gain[i];
      const x = padL + slot * i + slot * 0.15;
      const bw = slot * 0.7;
      g.fillStyle = gain >= 0 ? css('--accent') : css('--cut');
      const y = yOf(gain);
      g.fillRect(x, Math.min(y, zero), bw, Math.max(1, Math.abs(y - zero)));
    }
    g.strokeStyle = css('--measured'); g.lineWidth = 2; g.beginPath();
    for (let i = 0; i < n; i++) {
      const x = padL + slot * (i + 0.5);
      const y = yOf(eq.measured[i] - eq.target[i]);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  }

  // ---------- events ----------
  function applyCount(n) {
    state.freqs = D.defaultFreqs(n);
    resetAverage(); syncControls(); save(); render();
  }

  $('btnMic').addEventListener('click', () => { state.listening ? stopMic() : startMic(); });
  $('btnHold').addEventListener('click', () => {
    state.hold = !state.hold;
    $('btnHold').classList.toggle('on', state.hold);
    $('btnHold').textContent = state.hold ? 'Held' : 'Hold';
    setStatus(state.hold ? 'Held. Readings are frozen.' : 'Listening…');
  });
  $('btnReset').addEventListener('click', () => { resetAverage(); render(); });
  $('btnPink').addEventListener('click', () => { state.pink ? stopPink() : startPink(); });
  $('noiseVol').addEventListener('input', (e) => {
    state.settings.noiseVol = +e.target.value;
    if (state.noiseGain) state.noiseGain.gain.value = volToGain(state.settings.noiseVol);
    save();
  });
  $('bandCount').addEventListener('input', (e) => applyCount(+e.target.value));
  $('btnApplyFreqs').addEventListener('click', () => {
    const f = D.parseFreqs($('freqText').value);
    if (!f) { setStatus('Enter 3 to 24 frequencies between 20 and 20000 Hz, e.g. 100, 1k, 8k.', true); return; }
    state.freqs = f; resetAverage(); syncControls(); save(); render();
    setStatus(state.listening ? 'Listening…' : 'Frequencies applied.');
  });
  $('target').addEventListener('change', (e) => { state.settings.target = e.target.value; save(); render(); });
  $('tau').addEventListener('change', (e) => { state.settings.tau = +e.target.value; save(); });
  $('range').addEventListener('change', (e) => { state.settings.range = +e.target.value; save(); render(); });
  $('step').addEventListener('change', (e) => { state.settings.step = +e.target.value; save(); render(); });
  $('preferCuts').addEventListener('change', (e) => { state.settings.preferCuts = e.target.checked; save(); render(); });
  window.addEventListener('resize', drawChart);

  load();
  syncControls();
  render();
})();
