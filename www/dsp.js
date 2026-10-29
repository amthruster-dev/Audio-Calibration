// Pure DSP / EQ math, no DOM. Used by app.js and testable in Node.
(function (root) {
  'use strict';

  const MIN_BANDS = 3;
  const MAX_BANDS = 24;

  const TARGETS = {
    flat: [[20, 0], [20000, 0]],
    // Harman-style in-room preference: bass shelf, flat mids, gentle treble roll-off
    audiophile: [[20, 4.5], [50, 4.5], [100, 3], [200, 1.5], [500, 0.3], [1000, 0], [2000, 0.5], [3000, 1], [5000, 0], [8000, -1.5], [12000, -3], [16000, -4.5], [20000, -6]],
    // Neutral with a mild downward tilt, common for studio-style listening rooms
    reference: [[20, 1], [100, 0.5], [1000, 0], [4000, -1], [8000, -2], [16000, -3.5], [20000, -4.5]],
    // Extra air and detail up top
    detailed: [[20, 2], [100, 1], [1000, 0], [4000, 0.5], [8000, 2], [12000, 3], [20000, 3]],
    warm: [[20, 3], [100, 2.5], [300, 1], [1000, 0], [4000, -0.5], [10000, -1.5], [20000, -3]],
    bass: [[20, 6], [60, 5], [100, 3.5], [200, 1.5], [500, 0], [1000, 0], [3000, 1], [6000, -1], [10000, -3], [20000, -6]]
  };

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  // Default centre frequencies for n bands (log spaced).
  function defaultFreqs(n) {
    n = clamp(Math.round(n), MIN_BANDS, MAX_BANDS);
    if (n === 3) return [100, 1000, 8000];
    const fmin = 40, fmax = 16000;
    const out = [];
    for (let i = 0; i < n; i++) {
      const f = fmin * Math.pow(fmax / fmin, i / (n - 1));
      out.push(niceRound(f));
    }
    return out;
  }

  function niceRound(f) {
    if (f < 100) return Math.round(f);
    if (f < 1000) return Math.round(f / 5) * 5;
    if (f < 10000) return Math.round(f / 50) * 50;
    return Math.round(f / 100) * 100;
  }

  // Parse "100, 1k, 8000" -> sorted unique numbers (Hz). Returns null if invalid.
  function parseFreqs(text) {
    const parts = String(text).split(/[\s,;]+/).filter(Boolean);
    const out = [];
    for (const p of parts) {
      const m = /^(\d+(?:\.\d+)?)(k|khz|hz)?$/i.exec(p);
      if (!m) return null;
      let f = parseFloat(m[1]);
      if (m[2] && m[2].toLowerCase().startsWith('k')) f *= 1000;
      if (!(f >= 20 && f <= 20000)) return null;
      out.push(f);
    }
    const uniq = Array.from(new Set(out)).sort((a, b) => a - b);
    if (uniq.length < MIN_BANDS || uniq.length > MAX_BANDS) return null;
    return uniq;
  }

  // Band edges [lo, hi] for each centre, boundaries at geometric means.
  function bandEdges(freqs, nyquist) {
    const n = freqs.length;
    const maxF = Math.min(20000, nyquist * 0.95);
    const edges = [];
    for (let i = 0; i < n; i++) {
      const f = freqs[i];
      const lo = i === 0
        ? f / Math.sqrt(n > 1 ? freqs[1] / f : 2)
        : Math.sqrt(freqs[i - 1] * f);
      const hi = i === n - 1
        ? f * Math.sqrt(n > 1 ? f / freqs[n - 2] : 2)
        : Math.sqrt(f * freqs[i + 1]);
      edges.push([Math.max(20, lo), Math.min(maxF, hi)]);
    }
    return edges;
  }

  // Power per octave in each band from an analyser dB spectrum (one value per bin).
  // Fractional-bin weighting so narrow low-frequency bands stay accurate.
  function bandPowers(dbSpectrum, sampleRate, edges) {
    const fftSize = (dbSpectrum.length) * 2;
    const bw = sampleRate / fftSize;
    const out = new Array(edges.length);
    for (let b = 0; b < edges.length; b++) {
      const lo = edges[b][0], hi = edges[b][1];
      const k0 = Math.max(0, Math.floor(lo / bw));
      const k1 = Math.min(dbSpectrum.length - 1, Math.ceil(hi / bw));
      let sum = 0;
      for (let k = k0; k <= k1; k++) {
        const a = Math.max(lo, (k - 0.5) * bw);
        const c = Math.min(hi, (k + 0.5) * bw);
        const w = (c - a) / bw;
        if (w <= 0) continue;
        const db = dbSpectrum[k];
        if (db === -Infinity || db < -200) continue;
        sum += w * Math.pow(10, db / 10);
      }
      const octaves = Math.log2(hi / lo);
      out[b] = octaves > 0 ? sum / octaves : 0;
    }
    return out;
  }

  function toDb(p) { return p > 1e-20 ? 10 * Math.log10(p) : -200; }

  function targetAt(curveName, f) {
    const pts = TARGETS[curveName] || TARGETS.flat;
    if (f <= pts[0][0]) return pts[0][1];
    if (f >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
    for (let i = 1; i < pts.length; i++) {
      if (f <= pts[i][0]) {
        const [f0, d0] = pts[i - 1], [f1, d1] = pts[i];
        const t = Math.log(f / f0) / Math.log(f1 / f0);
        return d0 + (d1 - d0) * t;
      }
    }
    return 0;
  }

  // levelsDb: per-octave band level (dB) for each band.
  // Returns {measured, target, gain, preamp}
  function computeEq(freqs, levelsDb, opts) {
    const n = freqs.length;
    // Reference = mean level of bands in 200 Hz - 4 kHz (else all bands).
    let ref = [];
    for (let i = 0; i < n; i++) if (freqs[i] >= 200 && freqs[i] <= 4000 && levelsDb[i] > -150) ref.push(levelsDb[i]);
    if (!ref.length) for (let i = 0; i < n; i++) if (levelsDb[i] > -150) ref.push(levelsDb[i]);
    const refDb = ref.length ? ref.reduce((a, b) => a + b, 0) / ref.length : 0;

    const range = opts.range, step = opts.step;
    const measured = [], target = [], raw = [];
    for (let i = 0; i < n; i++) {
      const m = levelsDb[i] > -150 ? levelsDb[i] - refDb : 0;
      const t = targetAt(opts.target, freqs[i]);
      measured.push(m);
      target.push(t);
      raw.push(t - m);
    }
    let preamp = 0;
    let adj = raw.slice();
    if (opts.preferCuts) {
      const mx = Math.max.apply(null, adj);
      preamp = -mx;
      adj = adj.map(g => g - mx);
    }
    const gain = adj.map(g => {
      const c = clamp(g, -range, 0 + (opts.preferCuts ? 0 : range));
      return Math.round(c / step) * step;
    });
    // With prefer-cuts the lowest cut may exceed range; clamp handled above (-range floor).
    return { measured, target, gain, preamp, refDb };
  }

  // ----- Slider test helpers (find which frequencies an EQ slider moves) -----
  // Fine 1/6-octave bands, 30 Hz - 16 kHz.
  function fineFreqs() {
    const out = [];
    for (let f = 30; f <= 16000; f *= Math.pow(2, 1 / 6)) out.push(f);
    return out;
  }

  // diff: dB difference per fine band (slider capture minus baseline).
  // Removes level drift (20th percentile = unaffected region), then finds the
  // region that moved by at least half of the maximum change.
  function analyzeDiff(freqs, diff) {
    const n = diff.length;
    const sorted = diff.slice().sort((a, b) => a - b);
    const off = sorted[Math.floor(0.2 * (n - 1))];
    const d = diff.map(v => v - off);
    const sm = d.map((v, i) => (d[Math.max(0, i - 1)] + v + d[Math.min(n - 1, i + 1)]) / 3);
    let M = -Infinity, p = 0;
    sm.forEach((v, i) => { if (v > M) { M = v; p = i; } });
    if (M < 1.5) return { ok: false, peakDb: M, curve: sm };
    const half = M / 2;
    let l = p; while (l > 0 && sm[l - 1] >= half) l--;
    let h = p; while (h < n - 1 && sm[h + 1] >= half) h++;
    const cross = (i, j) => {
      const a = sm[i], b = sm[j];
      const t = (a - half) / (a - b);
      return Math.exp(Math.log(freqs[i]) + (Math.log(freqs[j]) - Math.log(freqs[i])) * t);
    };
    const lowEdge = l === 0 ? null : cross(l, l - 1);
    const highEdge = h === n - 1 ? null : cross(h, h + 1);
    let shape, rep;
    if (lowEdge === null && highEdge === null) { shape = 'broad'; rep = Math.sqrt(freqs[0] * freqs[n - 1]); }
    else if (lowEdge === null) { shape = 'low-shelf'; rep = Math.sqrt(freqs[0] * highEdge); }
    else if (highEdge === null) { shape = 'high-shelf'; rep = Math.sqrt(lowEdge * freqs[n - 1]); }
    else { shape = 'band'; rep = Math.sqrt(lowEdge * highEdge); }
    return { ok: true, peakDb: M, peakHz: freqs[p], lowEdge, highEdge, shape, rep, curve: sm };
  }

  // ----- Sweep measurement (exponential sine sweep + deconvolution) -----
  function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

  // In-place radix-2 complex FFT. inverse=true also divides by n.
  function fft(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = 2 * Math.PI / len * (inverse ? 1 : -1);
      const wr = Math.cos(ang), wi = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let j = 0; j < half; j++) {
          const a = i + j, b = a + half;
          const xr = re[b] * cr - im[b] * ci;
          const xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  // Exponential (log) sine sweep from f1 to f2 over T seconds, 50 ms fades.
  function makeSweep(sr, T, f1, f2) {
    const n = Math.floor(sr * T);
    const out = new Float32Array(n);
    const L = Math.log(f2 / f1);
    const K = 2 * Math.PI * f1 * T / L;
    for (let i = 0; i < n; i++) out[i] = Math.sin(K * (Math.exp((i / sr) / T * L) - 1));
    const fade = Math.floor(sr * 0.05);
    for (let i = 0; i < fade; i++) {
      const g = Math.pow(Math.sin(0.5 * Math.PI * i / fade), 2);
      out[i] *= g; out[n - 1 - i] *= g;
    }
    return out;
  }

  // Deconvolve the recording by the played sweep to get the impulse response,
  // gate it (1 ms before the main peak, 250 ms after) and return |H(f)|^2.
  function sweepResponse(rec, ref, sr) {
    const N = nextPow2(rec.length);
    const rr = new Float64Array(N), ri = new Float64Array(N);
    const sR = new Float64Array(N), sI = new Float64Array(N);
    for (let i = 0; i < rec.length; i++) rr[i] = rec[i];
    for (let i = 0; i < ref.length; i++) sR[i] = ref[i];
    fft(rr, ri, false); fft(sR, sI, false);
    let maxS = 0;
    for (let k = 0; k < N; k++) { const p = sR[k] * sR[k] + sI[k] * sI[k]; if (p > maxS) maxS = p; }
    const eps = maxS * 1e-6;
    for (let k = 0; k < N; k++) {
      const den = sR[k] * sR[k] + sI[k] * sI[k] + eps;
      const hr = (rr[k] * sR[k] + ri[k] * sI[k]) / den;   // R * conj(S)
      const hi = (ri[k] * sR[k] - rr[k] * sI[k]) / den;
      rr[k] = hr; ri[k] = hi;
    }
    fft(rr, ri, true);
    let p = 0, best = 0;
    for (let i = 0; i < rec.length; i++) { const v = Math.abs(rr[i]); if (v > best) { best = v; p = i; } }
    const pre = Math.round(0.001 * sr), post = Math.round(0.25 * sr);
    const Lw = pre + post, M = nextPow2(Lw);
    const wr = new Float64Array(M), wi = new Float64Array(M);
    const flatEnd = pre + Math.round(post * 0.6);
    for (let i = 0; i < Lw; i++) {
      let w = 1;
      if (i < pre) w = Math.pow(Math.sin(0.5 * Math.PI * i / pre), 2);
      else if (i > flatEnd) w = Math.pow(Math.cos(0.5 * Math.PI * (i - flatEnd) / (Lw - flatEnd)), 2);
      wr[i] = rr[(p - pre + i + N) % N] * w;
    }
    fft(wr, wi, false);
    const half = M >> 1;
    const freq = new Float64Array(half - 1), pow = new Float64Array(half - 1);
    for (let k = 1; k < half; k++) {
      freq[k - 1] = k * sr / M;
      pow[k - 1] = wr[k] * wr[k] + wi[k] * wi[k];
    }
    return { freq, pow, peakIndex: p, delaySec: p / sr, sr };
  }

  // Band levels (dB) from a response, weighting bins by 1/f (even weight per octave).
  function responseBandLevels(resp, edges) {
    const f = resp.freq, P = resp.pow;
    return edges.map(e => {
      let s = 0, w = 0;
      for (let k = 0; k < f.length; k++) {
        if (f[k] < e[0]) continue;
        if (f[k] > e[1]) break;
        s += P[k] / f[k]; w += 1 / f[k];
      }
      if (w === 0) {
        const mid = Math.sqrt(e[0] * e[1]);
        let bk = 0;
        for (let k = 1; k < f.length; k++) if (Math.abs(f[k] - mid) < Math.abs(f[bk] - mid)) bk = k;
        return toDb(P[bk]);
      }
      return toDb(s / w);
    });
  }

  const api = { MIN_BANDS, MAX_BANDS, TARGETS, clamp, defaultFreqs, parseFreqs, bandEdges, bandPowers, toDb, targetAt, computeEq, fineFreqs, analyzeDiff, nextPow2, fft, makeSweep, sweepResponse, responseBandLevels };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EQDSP = api;
})(typeof self !== 'undefined' ? self : this);
