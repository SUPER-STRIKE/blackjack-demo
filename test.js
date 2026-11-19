// Integration tests: rigged split + insurance scenarios, then a full 4-bot match to the final ranking.
process.env.PORT = 3999;
const { rooms } = require('./server.js');
const { io } = require('socket.io-client');
const assert = require('assert');
const url = 'http://localhost:3999';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (s, ev, d) => new Promise((r) => s.emit(ev, d, r));
const card = (r, s) => ({ r, s });

async function client(name) {
  const s = io(url, { forceNew: true });
  const c = { s, st: null };
  s.on('state', (st) => (c.st = st));
  await new Promise((r) => s.on('connect', r));
  return c;
}
const waitFor = async (fn, ms = 20000, label = '') => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return; await sleep(50); } throw new Error('timeout ' + label); };

async function solo(rig, money = 1000) {
  const c = await client('Solo');
  const r = await emit(c.s, 'create', { name: 'Solo', decks: 1, money, maxPlayers: 2, goal: 10 });
  c.s.emit('start');
  await waitFor(() => c.st?.phase === 'betting', 3000, 'betting');
  const room = rooms.get(r.code);
  room.shoe = [...Array(60).fill(card('2', '♣')), ...rig.reverse()];
  c.s.emit('bet', { amount: 100, ready: true });
  return { c, room };
}

(async () => {
  // ---- split scenario: 8,8 vs dealer 6 ----
  {
    const { c } = await solo([card('8', '♠'), card('6', '♥'), card('8', '♦'), card('10', '♣'), card('3', '♣'), card('10', '♥'), card('5', '♠'), card('9', '♠')]);
    await waitFor(() => c.st.phase === 'playing' && c.st.players[0].turn, 8000, 'player turn');
    assert(c.st.players[0].can.split, 'split should be allowed on 8,8');
    c.s.emit('split');
    await waitFor(() => c.st.players[0].hands.length === 2 && c.st.players[0].hands[0].cards.length === 2, 5000, 'split dealt');
    assert.strictEqual(c.st.players[0].money, 800, 'split takes a second bet');
    await waitFor(() => c.st.players[0].turn && c.st.players[0].turnHand === 0, 5000);
    c.s.emit('stand');
    await waitFor(() => c.st.players[0].turnHand === 1 && c.st.players[0].hands[1].cards.length === 2, 6000, 'second hand dealt');
    c.s.emit('stand');
    await waitFor(() => c.st.phase === 'results', 20000, 'results');
    const hs = c.st.players[0].hands;
    assert(hs.length === 2 && hs.every((h) => h.result), 'both hands settled');
    console.log('split ok:', hs.map((h) => `${h.value}:${h.result}`).join(' | '), 'dealer', c.st.dealer.value, 'money', c.st.players[0].money);
    c.s.close();
  }
  // ---- insurance scenario: dealer A + K ----
  {
    const { c } = await solo([card('9', '♠'), card('A', '♠'), card('7', '♦'), card('K', '♣')]);
    await waitFor(() => c.st.phase === 'insurance', 8000, 'insurance phase');
    c.s.emit('insure', { take: true });
    await waitFor(() => c.st.phase === 'results', 8000, 'results after insurance');
    assert.strictEqual(c.st.players[0].money, 1000, 'insurance pays 2:1 and covers the lost bet');
    console.log('insurance ok, money', c.st.players[0].money);
    c.s.close();
  }
  // ---- insurance declined + dealer blackjack = lose bet ----
  {
    const { c } = await solo([card('9', '♠'), card('A', '♠'), card('7', '♦'), card('K', '♣')]);
    await waitFor(() => c.st.phase === 'insurance', 8000);
    c.s.emit('insure', { take: false });
    await waitFor(() => c.st.phase === 'results', 8000);
    assert.strictEqual(c.st.players[0].money, 900);
    c.s.close();
  }
  // ---- full match: 4 bots, goal 2x, all-in betting ----
  {
    const bots = [];
    const mk = async (n, host, code) => {
      const c = await client(n);
      const r = host ? await emit(c.s, 'create', { name: n, decks: 2, money: 100, maxPlayers: 4, goal: 2 }) : await emit(c.s, 'join', { name: n, code });
      assert(r.ok, n);
      c.s.on('state', (st) => {
        const me = st.players.find((p) => p.me);
        if (st.phase === 'betting' && me.status === 'betting' && !me.ready) c.s.emit('bet', { amount: me.money, ready: true });
        if (st.phase === 'insurance' && me.insEligible && !me.insDecided) c.s.emit('insure', { take: false });
        if (st.phase === 'playing' && me.turn && me.can) {
          const h = me.hands[me.turnHand];
          if (me.can.split) c.s.emit('split');
          else c.s.emit(h.value < 16 ? 'hit' : 'stand');
        }
      });
      bots.push(c);
      return r.code;
    };
    const code = await mk('Host', true);
    for (const n of ['Ann', 'Bob', 'Cy']) await mk(n, false, code);
    const late = await client('late');
    assert(!(await emit(late.s, 'join', { name: 'x', code: 'ZZZZ' })).ok);
    late.s.close();
    bots[0].s.emit('start');
    await sleep(300);
    const lateJoin = await client('late2');
    const lj = await emit(lateJoin.s, 'join', { name: 'Late', code });
    assert(!lj.ok && /started/.test(lj.error), 'cannot join after start: ' + JSON.stringify(lj));
    lateJoin.s.close();
    await waitFor(() => bots[0].st?.phase === 'final', 180000, 'final');
    const st = bots[0].st;
    const ranks = st.players.map((p) => p.rank).sort();
    assert.deepStrictEqual(ranks, [1, 2, 3, 4], 'ranks 1..4');
    assert(st.hist.every((h) => h.length >= 2), 'history recorded');
    console.log('final:', st.players.slice().sort((a, b) => a.rank - b.rank).map((p) => `#${p.rank} ${p.name} $${p.money} (${p.reason})`).join(' | '));
    bots[0].s.emit('rematch');
    await waitFor(() => bots[0].st.phase === 'lobby', 3000, 'rematch');
    assert(bots[0].st.players.every((p) => p.money === 100));
    console.log('rematch ok');
  }
  console.log('ALL TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
