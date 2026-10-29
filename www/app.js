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
    peakDb: -120, rmsDb: -120, rmsPow: null, peakHold: -120, rmsHist: [],
    noiseFloor: null, noiseCap: null,
    settings: { target: 'audiophile', tau: 8, range: 12, step: 1, preferCuts: false, noiseVol: 30, micOffset: null }
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
      setStatus('Microphone blocked. Allow microphone access for Audio Calibration in Android settings.', true);
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
    state.rmsPow = null; state.rmsDb = -120; state.peakDb = -120; state.peakHold = -120;
    state.rmsHist = []; state.noiseCap = null; state.cap = null;
    updateMeter();
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
    const LW = 4096; // last ~85 ms for a responsive meter
    let peak = 0, sum = 0;
    for (let i = timeBuf.length - LW; i < timeBuf.length; i++) { const v = Math.abs(timeBuf[i]); if (v > peak) peak = v; sum += v * v; }
    const inst = sum / LW;
    state.peakDb = peak > 0 ? 20 * Math.log10(peak) : -120;
    state.rmsPow = state.rmsPow == null ? inst : state.rmsPow + 0.4 * (inst - state.rmsPow);
    state.rmsDb = state.rmsPow > 1e-12 ? 10 * Math.log10(state.rmsPow) : -120;
    state.peakHold = Math.max(state.peakDb, state.peakHold - 1);
    state.rmsHist.push(inst); if (state.rmsHist.length > 20) state.rmsHist.shift();
    if (state.noiseCap) {
      state.noiseCap.sum += inst; state.noiseCap.n++;
      const left = 3 - (now - state.noiseCap.t0) / 1000;
      if (left <= 0) {
        state.noiseFloor = toDbPow(state.noiseCap.sum / state.noiseCap.n);
        state.noiseCap = null;
        setCalMsg('Room noise: ' + state.noiseFloor.toFixed(0) + ' dBFS. Now turn pink noise on to see how far above it your signal is.');
      } else setCalMsg('Measuring room noise… ' + Math.ceil(left) + ' s. Keep the speaker silent.');
    }
    updateMeter();

    if (!state.hold || state.cap) state.analyser.getFloatFrequencyData(specBuf);
    if (state.cap) stepCapture();
    if (!state.hold) {
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

  // ---------- mic check / calibration ----------
  function toDbPow(p) { return p > 1e-12 ? 10 * Math.log10(p) : -120; }
  function setCalMsg(t) { $('calMsg').textContent = t; }

  function levelVerdict(rms, peak) {
    if (peak > -3) return { text: 'Too loud: the mic is at or near clipping. Lower the volume or move the phone back.', cls: 'bad' };
    if (rms < -50) return { text: 'Too quiet. Raise the volume or move the phone closer.', cls: 'bad' };
    if (rms < -35) return { text: 'A bit low. Raise the volume a little.', cls: 'warn' };
    if (rms > -10) return { text: 'Too loud. Lower the volume.', cls: 'bad' };
    if (rms > -20) return { text: 'A bit hot. Lower the volume a little.', cls: 'warn' };
    return { text: 'Good level. The mic is receiving the right volume.', cls: 'ok' };
  }

  const METER_MIN = -80;
  function drawMeter(active) {
    const cv = $('meterCanvas');
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const xOf = (db) => D.clamp((db - METER_MIN) / -METER_MIN, 0, 1) * w;
    const zones = [[-80, -50, '#ff6b5c'], [-50, -35, '#f2c14e'], [-35, -20, css('--accent')], [-20, -10, '#f2c14e'], [-10, 0, '#ff6b5c']];
    const y0 = 6, bh = 26;
    zones.forEach(z => {
      const x0 = xOf(z[0]), x1 = xOf(z[1]);
      g.globalAlpha = 0.28; g.fillStyle = z[2]; g.fillRect(x0, y0, x1 - x0, bh);
      if (active) {
        const lv = D.clamp(state.rmsDb, z[0], z[1]);
        if (state.rmsDb > z[0]) { g.globalAlpha = 1; g.fillRect(x0, y0, xOf(lv) - x0, bh); }
      }
    });
    g.globalAlpha = 1;
    if (active && state.peakHold > METER_MIN) {
      g.fillStyle = '#ffffff'; g.fillRect(Math.min(w - 2, xOf(state.peakHold)), y0 - 3, 2, bh + 6);
    }
    g.fillStyle = css('--muted'); g.font = '11px system-ui, sans-serif'; g.textBaseline = 'top';
    [-80, -60, -40, -20, 0].forEach(v => {
      g.textAlign = v === -80 ? 'left' : (v === 0 ? 'right' : 'center');
      g.fillText(v + ' dBFS'.slice(0, v === 0 ? 5 : 0), xOf(v), y0 + bh + 6);
    });
  }

  function updateMeter() {
    const active = state.listening;
    drawMeter(active);
    const v = $('meterVerdict');
    if (!active) {
      v.textContent = 'Start listening to check the mic level.'; v.className = 'verdict';
      $('rdRms').textContent = '–'; $('rdPeak').textContent = '–';
      $('rdSpl').textContent = state.settings.micOffset == null ? 'not calibrated' : '–';
      $('snrLine').textContent = '';
      return;
    }
    const r = levelVerdict(state.rmsDb, state.peakHold);
    v.textContent = r.text; v.className = 'verdict ' + r.cls;
    $('rdRms').textContent = state.rmsDb.toFixed(0) + ' dBFS';
    $('rdPeak').textContent = state.peakHold.toFixed(0) + ' dBFS';
    $('rdSpl').textContent = state.settings.micOffset == null ? 'not calibrated'
      : (state.rmsDb + state.settings.micOffset).toFixed(0) + ' dB';
    let snr = '';
    if (state.noiseFloor != null) {
      snr = 'Room noise: ' + state.noiseFloor.toFixed(0) + ' dBFS.';
      if (state.pink) {
        const d = state.rmsDb - state.noiseFloor;
        snr += ' Signal is ' + d.toFixed(0) + ' dB above it: ' +
          (d >= 20 ? 'good.' : (d >= 10 ? 'okay, a quieter room would help.' : 'too noisy for accurate results.'));
      }
    }
    $('snrLine').textContent = snr;
    if (r.cls === 'bad') setStatus(r.text, true);
    else if ($('status').className.indexOf('warn') >= 0) setStatus(state.hold ? 'Held.' : 'Listening…');
  }

  function calibrateMic() {
    const ref = parseFloat($('refSpl').value);
    if (!state.listening) { setCalMsg('Tap "Start listening" first.'); return; }
    if (!(ref > 20 && ref < 140)) { setCalMsg('Enter the dB reading from your sound level meter (20 to 140).'); return; }
    if (state.rmsHist.length < 10) { setCalMsg('Wait a second, then try again.'); return; }
    const measured = toDbPow(state.rmsHist.reduce((a, b) => a + b, 0) / state.rmsHist.length);
    if (measured < -70) { setCalMsg('Signal is too quiet to calibrate. Play steady sound first.'); return; }
    state.settings.micOffset = ref - measured;
    save();
    setCalMsg('Calibrated. 0 dBFS now reads as ' + state.settings.micOffset.toFixed(0) + ' dB SPL.');
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

  // ---------- slider test: find which frequencies an EQ slider moves ----------
  const CAP_SECONDS = 6;
  const fine = D.fineFreqs();
  const fineEdges = (function () {
    const e = [];
    for (let i = 0; i < fine.length; i++) {
      const lo = i === 0 ? fine[0] / Math.pow(2, 1 / 12) : Math.sqrt(fine[i - 1] * fine[i]);
      const hi = i === fine.length - 1 ? fine[i] * Math.pow(2, 1 / 12) : Math.sqrt(fine[i] * fine[i + 1]);
      e.push([lo, hi]);
    }
    return e;
  })();
  const sliderData = { base: null, bass: null, mid: null, treble: null };
  const sliderNames = { bass: 'Bass', mid: 'Midrange', treble: 'Treble' };
  const sliderColors = { bass: '--accent', mid: '--measured', treble: '--cut' };
  let sliderResult = {};

  function setSliderMsg(t, warn) {
    const el = $('sliderMsg');
    el.textContent = t;
    el.className = 'small' + (warn ? ' warnText' : '');
  }

  function beginCapture(name) {
    if (!state.listening) { setSliderMsg('Tap "Start listening" and turn Pink noise on first.', true); return; }
    if (!state.pink) { setSliderMsg('Turn Pink noise on first.', true); return; }
    if (name !== 'base' && !sliderData.base) { setSliderMsg('Capture the baseline first (all Alexa sliders at 0).', true); return; }
    state.cap = { name: name, t0: performance.now(), sum: new Float64Array(fine.length), n: 0 };
    setSliderMsg('Capturing ' + (name === 'base' ? 'baseline' : sliderNames[name]) + '… keep quiet and still.');
  }

  function stepCapture() {
    const c = state.cap;
    const p = D.bandPowers(specBuf, state.ctx.sampleRate, fineEdges);
    for (let i = 0; i < p.length; i++) c.sum[i] += p[i];
    c.n++;
    const left = CAP_SECONDS - (performance.now() - c.t0) / 1000;
    if (left > 0) { setSliderMsg('Capturing… ' + Math.ceil(left) + ' s'); return; }
    const db = Array.from(c.sum, v => D.toDb(v / c.n));
    sliderData[c.name] = db;
    state.cap = null;
    if (c.name === 'base') {
      sliderResult = {};
      sliderData.bass = sliderData.mid = sliderData.treble = null;
      setSliderMsg('Baseline saved. Now set Alexa Bass to +6 (others at 0), then tap "Bass at +6".');
    } else {
      const diff = db.map((v, i) => v - sliderData.base[i]);
      sliderResult[c.name] = D.analyzeDiff(fine, diff);
      setSliderMsg(sliderResult[c.name].ok
        ? sliderNames[c.name] + ' captured. Reset it to 0 before testing the next slider.'
        : 'No change detected. Check the slider was really at +6 and the volume was unchanged.', !sliderResult[c.name].ok);
    }
    renderSlider();
  }

  function fmtHzFull(f) { return f >= 1000 ? (f / 1000).toFixed(1) + ' kHz' : Math.round(f) + ' Hz'; }

  function describeSlider(r) {
    if (!r.ok) return 'no change detected';
    const g = '+' + r.peakDb.toFixed(1) + ' dB';
    if (r.shape === 'low-shelf') return 'boosts everything below about ' + fmtHzFull(r.highEdge) + ' (' + g + ')';
    if (r.shape === 'high-shelf') return 'boosts everything above about ' + fmtHzFull(r.lowEdge) + ' (' + g + ')';
    if (r.shape === 'band') return 'boosts about ' + fmtHzFull(r.lowEdge) + ' to ' + fmtHzFull(r.highEdge) + ', strongest near ' + fmtHzFull(r.peakHz) + ' (' + g + ')';
    return 'boosts the whole range (' + g + ')';
  }

  function renderSlider() {
    const ul = $('sliderResults');
    ul.innerHTML = '';
    ['bass', 'mid', 'treble'].forEach(k => {
      if (!sliderResult[k]) return;
      const li = document.createElement('li');
      li.textContent = sliderNames[k] + ': ' + describeSlider(sliderResult[k]);
      ul.appendChild(li);
    });
    $('btnUseSliders').style.display = ['bass', 'mid', 'treble'].every(k => sliderResult[k] && sliderResult[k].ok) ? '' : 'none';
    drawSliderChart();
  }

  function drawSliderChart() {
    const cv = $('sliderChart');
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const keys = ['bass', 'mid', 'treble'].filter(k => sliderResult[k]);
    let top = 8;
    keys.forEach(k => sliderResult[k].curve.forEach(v => { if (v > top) top = Math.ceil(v + 1); }));
    const padL = 30, padR = 6, padT = 8, padB = 22;
    const pw = w - padL - padR, ph = h - padT - padB;
    const lf0 = Math.log(30), lf1 = Math.log(16000);
    const xOf = (f) => padL + (Math.log(f) - lf0) / (lf1 - lf0) * pw;
    const yOf = (v) => padT + ph - ((D.clamp(v, -2, top) + 2) / (top + 2)) * ph;
    g.font = '11px system-ui, sans-serif';
    g.strokeStyle = css('--line'); g.fillStyle = css('--muted'); g.lineWidth = 1;
    g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let v = 0; v <= top; v += 2) {
      const y = yOf(v);
      g.beginPath(); g.moveTo(padL, y); g.lineTo(w - padR, y); g.stroke();
      g.fillText(String(v), padL - 4, y);
    }
    g.textAlign = 'center'; g.textBaseline = 'top';
    [50, 100, 500, 1000, 5000, 10000].forEach(f => g.fillText(fmtHz(f), xOf(f), h - padB + 6));
    keys.forEach(k => {
      g.strokeStyle = css(sliderColors[k]); g.lineWidth = 2; g.beginPath();
      sliderResult[k].curve.forEach((v, i) => {
        const x = xOf(fine[i]), y = yOf(v);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      });
      g.stroke();
    });
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
  window.addEventListener('resize', () => { drawChart(); drawSliderChart(); drawMeter(state.listening); });
  $('btnCal').addEventListener('click', calibrateMic);
  $('btnClearCal').addEventListener('click', () => {
    state.settings.micOffset = null; save(); setCalMsg('Calibration cleared.'); updateMeter();
  });
  $('btnNoise').addEventListener('click', () => {
    if (!state.listening) { setCalMsg('Tap "Start listening" first.'); return; }
    if (state.pink) { setCalMsg('Turn Pink noise off and silence the speaker first.'); return; }
    state.noiseCap = { t0: performance.now(), sum: 0, n: 0 };
  });
  $('btnBase').addEventListener('click', () => beginCapture('base'));
  $('btnBass').addEventListener('click', () => beginCapture('bass'));
  $('btnMid').addEventListener('click', () => beginCapture('mid'));
  $('btnTreble').addEventListener('click', () => beginCapture('treble'));
  $('btnUseSliders').addEventListener('click', () => {
    const f = ['bass', 'mid', 'treble'].map(k => Math.round(sliderResult[k].rep));
    state.freqs = f.sort((a, b) => a - b);
    state.settings.range = 6; state.settings.step = 1;
    resetAverage(); syncControls(); save(); render();
    setSliderMsg('Bands set to ' + state.freqs.join(', ') + ' Hz with ±6 dB range.');
  });

  load();
  syncControls();
  render();
  updateMeter();
  if (state.settings.micOffset != null) setCalMsg('Calibrated. 0 dBFS reads as ' + state.settings.micOffset.toFixed(0) + ' dB SPL.');
})();
