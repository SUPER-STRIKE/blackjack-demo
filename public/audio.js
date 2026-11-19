// Procedural sound effects + lounge music (Web Audio, no asset files).
window.SFX = (() => {
  let ctx = null, master, sfxG, musG, noiseBuf;
  const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } };
  const state = { sfx: store('bj_sfx') !== '0', music: store('bj_music') !== '0' };
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

  function init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = 0.9; master.connect(ctx.destination);
    sfxG = ctx.createGain(); sfxG.gain.value = state.sfx ? 0.8 : 0; sfxG.connect(master);
    musG = ctx.createGain(); musG.gain.value = state.music ? 0.32 : 0; musG.connect(master);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    if (state.music) startMusic();
  }

  // ---- building blocks ----
  function tone(type, f0, t, dur, vol, out, f1) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t);
    if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(out || sfxG); o.start(t); o.stop(t + dur + 0.05);
  }
  function noise(t, dur, vol, type, f0, f1, out, q = 1) {
    const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
    const f = ctx.createBiquadFilter(); f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t); if (f1) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(out || sfxG); s.start(t, Math.random()); s.stop(t + dur + 0.05);
  }

  const fx = {
    deal() { const t = ctx.currentTime; noise(t, 0.11, 0.5, 'bandpass', 3200, 1100, null, 0.9); tone('sine', 140, t, 0.06, 0.18, null, 70); },
    flip() { const t = ctx.currentTime; noise(t, 0.14, 0.45, 'bandpass', 1400, 3800, null, 1.2); },
    chip() { const t = ctx.currentTime; tone('triangle', 2400, t, 0.05, 0.3); tone('triangle', 1750, t + 0.045, 0.06, 0.3); noise(t, 0.04, 0.25, 'highpass', 4000); },
    click() { const t = ctx.currentTime; tone('square', 900, t, 0.03, 0.08); },
    turn() { const t = ctx.currentTime; tone('sine', 988, t, 0.6, 0.22); tone('sine', 1976, t, 0.4, 0.08); },
    win() { const t = ctx.currentTime; [523, 659, 784, 1047].forEach((f, i) => tone('triangle', f, t + i * 0.09, 0.35, 0.28)); },
    blackjack() { const t = ctx.currentTime; [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => { tone('triangle', f, t + i * 0.1, 0.4, 0.3); tone('sine', f / 2, t + i * 0.1, 0.4, 0.15); }); },
    lose() { const t = ctx.currentTime; tone('sawtooth', 196, t, 0.45, 0.12, null, 130); tone('sine', 98, t, 0.5, 0.2, null, 65); },
    bust() { const t = ctx.currentTime; tone('sine', 120, t, 0.35, 0.4, null, 38); noise(t, 0.2, 0.3, 'lowpass', 600, 120); },
    push() { const t = ctx.currentTime; tone('sine', 440, t, 0.25, 0.2); tone('sine', 440, t + 0.15, 0.25, 0.2); },
    split() { const t = ctx.currentTime; noise(t, 0.1, 0.4, 'bandpass', 2600, 1500); noise(t + 0.11, 0.1, 0.4, 'bandpass', 2600, 1500); },
    final() { const t = ctx.currentTime; [392, 523, 659, 784, 1047, 1319].forEach((f, i) => { tone('triangle', f, t + i * 0.13, 0.9, 0.26); }); tone('sine', 196, t, 1.6, 0.25); },
  };
  function play(name) {
    if (!ctx || !state.sfx || !fx[name]) return;
    if (ctx.state === 'suspended') ctx.resume();
    try { fx[name](); } catch {}
  }

  // ---- lounge music: Dm9 - G13 - Cmaj9 - A7, ~84 bpm, soft pads + walking bass + brushes + sparse melody ----
  const prog = [
    { root: 38, chord: [53, 57, 60, 64, 67] },
    { root: 43, chord: [53, 59, 64, 69] },
    { root: 36, chord: [52, 55, 59, 62] },
    { root: 45, chord: [55, 61, 64, 67] },
  ];
  const scale = [62, 64, 65, 67, 69, 72, 74, 76];
  let timer = null, nextT = 0, step = 0;
  function pad(chord, t, dur) {
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1100; lp.connect(musG);
    for (const m of chord) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'triangle'; o.frequency.value = hz(m); o.detune.value = (Math.random() - 0.5) * 8;
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.03, t + 0.4); g.gain.linearRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(lp); o.start(t); o.stop(t + dur + 0.1);
    }
  }
  function schedule() {
    const beat = 60 / 84, eighth = beat / 2;
    while (nextT < ctx.currentTime + 0.5) {
      const bar = Math.floor(step / 8) % 4, within = step % 8, c = prog[bar], t = nextT;
      if (within === 0) pad(c.chord, t, beat * 4.2);
      if (within % 2 === 0) { // walking bass on beats
        const b = within / 2, next = prog[(bar + 1) % 4].root;
        const m = b === 0 ? c.root : b === 1 ? c.root + 7 : b === 2 ? c.root + 12 : next + (Math.random() < 0.5 ? 1 : -1) + 12 - 12;
        tone('sine', hz(m), t, beat * 0.9, 0.2, musG);
      }
      if (within === 2 || within === 6) noise(t, 0.16, 0.06, 'bandpass', 3000, 2200, musG, 0.8); // brush on 2 & 4
      if (within % 2 === 1) noise(t, 0.04, 0.025, 'highpass', 6500, null, musG);
      if (within === 0) tone('sine', 62, t, 0.18, 0.12, musG, 40);
      if (within % 2 === 0 && Math.random() < 0.38) {
        const m = scale[Math.floor(Math.random() * scale.length)];
        tone('sine', hz(m), t, beat * 1.2, 0.07, musG); tone('triangle', hz(m) * 2, t, beat * 0.6, 0.015, musG);
      }
      nextT += eighth; step++;
    }
  }
  function startMusic() { if (!ctx || timer) return; nextT = ctx.currentTime + 0.1; step = 0; timer = setInterval(schedule, 120); }
  function stopMusic() { clearInterval(timer); timer = null; }

  function setSfx(on) { state.sfx = on; store('bj_sfx', on ? '1' : '0'); if (sfxG) sfxG.gain.value = on ? 0.8 : 0; if (on) { init(); play('click'); } }
  function setMusic(on) {
    state.music = on; store('bj_music', on ? '1' : '0'); init();
    if (!ctx) return;
    musG.gain.setTargetAtTime(on ? 0.32 : 0, ctx.currentTime, 0.15);
    if (on) startMusic(); else setTimeout(() => { if (!state.music) stopMusic(); }, 600);
  }
  ['pointerdown', 'keydown'].forEach((e) => window.addEventListener(e, init, { once: false, passive: true }));
  return { init, play, state, setSfx, setMusic };
})();
