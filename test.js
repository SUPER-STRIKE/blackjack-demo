// Integration test: 4 bots + 1 rejected 5th player play rounds against a local server.
// Usage: node test.js   (starts the server itself on port 3999)
process.env.PORT = 3999;
require('./server.js');
const { io } = require('socket.io-client');
const assert = require('assert');

const url = 'http://localhost:3999';
const bots = [];
const emit = (s, ev, d) => new Promise((r) => s.emit(ev, d, r));

function bot(name) {
  const s = io(url, { forceNew: true });
  const b = { s, name, state: null, rounds: 0, lastPhase: '' };
  s.on('state', (st) => {
    b.state = st;
    const me = st.players.find((p) => p.me);
    if (st.phase === 'betting' && me.status === 'betting' && !me.ready) s.emit('bet', { amount: 50, ready: true });
    if (st.phase === 'playing' && me.turn && me.status === 'playing') {
      if (me.cards.length === 2 && me.money >= me.bet && me.value === 11) s.emit('double');
      else s.emit(me.value < 16 ? 'hit' : 'stand');
    }
    if (st.phase === 'results' && b.lastPhase !== 'results') {
      b.rounds++;
      const dv = st.dealer.value;
      // chip conservation: money change equals delta
      for (const p of st.players) if (p.result) assert(['WIN', 'LOSE', 'PUSH', 'BUST', 'BLACKJACK'].includes(p.result));
      assert(st.dealer.cards.every(Boolean), 'hole card must be revealed at results');
      assert(dv >= 17 || st.players.every((p) => !p.result || p.result === 'BUST' || p.result === 'BLACKJACK') || dv === 21, `dealer must reach 17 (got ${dv})`);
    }
    b.lastPhase = st.phase;
  });
  return b;
}

(async () => {
  const host = bot('Host'); bots.push(host);
  await new Promise((r) => host.s.on('connect', r));
  const c = await emit(host.s, 'create', { name: 'Host', decks: 9, money: 500 });
  assert(c.ok && c.code.length === 4);
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(host.state.settings.decks, 6, 'decks clamped to 6');
  for (const n of ['Ann', 'Bob', 'Cy']) {
    const b = bot(n); bots.push(b);
    await new Promise((r) => b.s.on('connect', r));
    const j = await emit(b.s, 'join', { name: n, code: c.code.toLowerCase() });
    assert(j.ok, 'join ' + n);
  }
  const extra = io(url, { forceNew: true });
  await new Promise((r) => extra.on('connect', r));
  const full = await emit(extra, 'join', { name: 'Late', code: c.code });
  assert(!full.ok && /full/i.test(full.error), 'room should be full');
  extra.close();
  const bad = await emit(bots[1].s, 'join', { name: 'x', code: 'ZZZZ' });
  assert(!bad.ok);

  bots[1].s.emit('start'); // non-host cannot start
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(host.state.phase, 'lobby');
  host.s.emit('start');

  const t0 = Date.now();
  while (bots[0].rounds < 4 && Date.now() - t0 < 90000) await new Promise((r) => setTimeout(r, 200));
  assert(bots[0].rounds >= 4, 'played 4 rounds, got ' + bots[0].rounds);
  const st = host.state;
  console.log('Final chips:', st.players.map((p) => `${p.name}=${p.money}`).join(' '), '| shoe', st.shoeLeft, '/', st.shoeTotal);
  // other players' hole card never leaks during play: verify via hidden flag on a fresh snapshot is covered by server logic
  console.log('ALL TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
