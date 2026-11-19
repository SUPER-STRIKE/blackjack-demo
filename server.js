// Royal Blackjack Online - authoritative game server (Express + Socket.IO)
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MIN_BET = 10;
const BET_TIME = 25000;
const TURN_TIME = 25000;
const INS_TIME = 12000;
const RESULT_TIME = 8000;
const DEAL_STEP = 650;     // ms between dealt cards (so the animation is visible)
const DEALER_STEP = 1000;
const GONE_AFTER = 120000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingTimeout: 20000 });
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.send('ok'));

const rooms = new Map();

// ---------- card helpers ----------
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function buildShoe(decks, exclude = []) {
  const s = [];
  for (let d = 0; d < decks; d++) for (const su of SUITS) for (const r of RANKS) s.push({ r, s: su });
  for (const c of exclude) { const i = s.findIndex((x) => x.r === c.r && x.s === c.s); if (i >= 0) s.splice(i, 1); }
  return shuffle(s);
}
const points = (c) => (c.r === 'A' ? 11 : 'JQK'.includes(c.r) || c.r === '10' ? 10 : parseInt(c.r, 10));
function info(cards) {
  let t = 0, aces = 0;
  for (const c of cards) { t += points(c); if (c.r === 'A') aces++; }
  while (t > 21 && aces) { t -= 10; aces--; }
  return { v: t, soft: aces > 0 && t <= 21 };
}
const isBJ = (cards) => cards.length === 2 && info(cards).v === 21;
const newHand = (cards, bet) => ({ cards, bet, status: 'playing', doubled: false, fromSplit: false, splitAce: false, result: '', delta: 0 });

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join(''); } while (rooms.has(c));
  return c;
}
const cleanName = (n) => String(n || '').replace(/[^\p{L}\p{N} _\-.]/gu, '').trim().slice(0, 14) || 'Player';
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function newPlayer(name, money) {
  return {
    token: crypto.randomBytes(12).toString('hex'), sid: null, name, money,
    bet: 0, lastBet: 0, ready: false, hands: [], status: 'waiting',
    ins: 0, insDecided: true, insEligible: false, insDelta: 0, roundDelta: 0,
    connected: true, lastSeen: Date.now(), left: false, hist: [money], elimRound: 0, rank: 0, reason: '',
  };
}
function log(room, msg) { room.log.push(msg); if (room.log.length > 40) room.log.shift(); }
const goalAmount = (room) => room.settings.money * room.settings.goal;

// ---------- snapshot ----------
function snapshot(room, forToken) {
  const hole = room.holeHidden;
  const dealerCards = room.dealer.map((c, i) => (i === 1 && hole ? null : c));
  const vis = dealerCards.filter(Boolean);
  const di = info(vis);
  return {
    now: Date.now(), code: room.code, round: room.round, phase: room.phase, settings: room.settings,
    goalAmount: goalAmount(room),
    host: room.hostToken === forToken,
    shoeLeft: room.shoe.length, shoeTotal: room.settings.decks * 52,
    deadline: room.deadline, deadlineTotal: room.deadlineTotal,
    turn: room.turnToken, turnHand: room.turnHand,
    msg: room.msg, log: room.log.slice(-12),
    dealer: { cards: dealerCards, value: vis.length ? di.v : 0, soft: di.soft && vis.length > 0, hidden: hole },
    hist: room.players.map((p) => p.hist),
    players: room.players.map((p) => {
      const isTurn = room.turnToken === p.token && room.phase === 'playing';
      const h = isTurn ? p.hands[room.turnHand] : null;
      return {
        me: p.token === forToken, name: p.name, money: p.money, bet: p.bet, ready: p.ready,
        status: p.status, left: p.left, connected: p.connected, isHost: p.token === room.hostToken,
        turn: isTurn, turnHand: isTurn ? room.turnHand : -1,
        hands: p.hands.map((x) => { const i = info(x.cards); return { cards: x.cards, value: i.v, soft: i.soft, bet: x.bet, status: x.status, doubled: x.doubled, result: x.result, delta: x.delta }; }),
        ins: p.ins, insDecided: p.insDecided, insEligible: p.insEligible, insDelta: p.insDelta, roundDelta: p.roundDelta,
        rank: p.rank, reason: p.reason,
        can: h && h.status === 'playing' ? {
          double: h.cards.length === 2 && p.money >= h.bet && !h.splitAce,
          split: p.hands.length === 1 && h.cards.length === 2 && points(h.cards[0]) === points(h.cards[1]) && p.money >= h.bet,
        } : null,
      };
    }),
  };
}
function broadcast(room) { for (const p of room.players) if (p.sid) io.to(p.sid).emit('state', snapshot(room, p.token)); }

// ---------- room + timers ----------
function createRoom(host, settings) {
  const room = {
    code: makeCode(), settings, players: [host], hostToken: host.token, phase: 'lobby',
    shoe: buildShoe(settings.decks), dealer: [], holeHidden: true, turnToken: null, turnHand: 0,
    deadline: 0, deadlineTotal: 0, timer: null, msg: '', log: [], round: 0,
  };
  rooms.set(room.code, room);
  log(room, `${host.name} created the table`);
  return room;
}
function setTimer(room, ms, fn) {
  clearTimeout(room.timer);
  room.deadline = ms ? Date.now() + ms : 0;
  room.deadlineTotal = ms || 0;
  room.timer = ms ? setTimeout(() => { if (rooms.has(room.code)) fn(); }, ms) : null;
}
function later(room, ms, fn) {
  clearTimeout(room.timer);
  room.deadline = 0;
  room.timer = setTimeout(() => { if (rooms.has(room.code)) fn(); }, ms);
}
function drawCard(room) {
  if (!room.shoe.length) {
    const inPlay = [...room.dealer, ...room.players.flatMap((p) => p.hands.flatMap((h) => h.cards))];
    room.shoe = buildShoe(room.settings.decks, inPlay);
    log(room, 'Shoe reshuffled mid-round');
  }
  return room.shoe.pop();
}
const inRound = (p) => p.hands.length > 0 && p.status === 'playing';

// ---------- betting ----------
function startBetting(room) {
  clearTimeout(room.timer);
  room.phase = 'betting';
  room.round++;
  room.dealer = []; room.holeHidden = true; room.turnToken = null;
  const total = room.settings.decks * 52;
  if (room.shoe.length < Math.max(20, total * 0.25)) {
    room.shoe = buildShoe(room.settings.decks);
    log(room, 'Shoe reshuffled'); room.msg = 'Fresh shoe - cards reshuffled';
  } else room.msg = '';
  for (const p of room.players) {
    p.hands = []; p.bet = 0; p.ready = false; p.ins = 0; p.insDecided = true; p.insEligible = false; p.insDelta = 0; p.roundDelta = 0;
    if (p.status === 'out') continue;
    p.status = 'betting';
    if (!p.connected || p.left) { p.bet = clamp(p.lastBet || MIN_BET, MIN_BET, p.money); p.ready = true; }
  }
  setTimer(room, BET_TIME, () => endBetting(room));
  broadcast(room);
  checkAllReady(room);
}
function checkAllReady(room) {
  if (room.phase !== 'betting') return;
  const pending = room.players.filter((p) => p.status === 'betting' && p.connected && !p.ready);
  if (!pending.length) endBetting(room);
}
function endBetting(room) {
  if (room.phase !== 'betting') return;
  clearTimeout(room.timer);
  const bettors = room.players.filter((p) => p.status === 'betting');
  for (const p of bettors) {
    if (!p.ready) p.bet = clamp(p.lastBet || MIN_BET, MIN_BET, p.money);
    p.bet = clamp(p.bet, MIN_BET, p.money);
    p.lastBet = p.bet;
    p.money -= p.bet;
    p.status = 'playing';
    p.hands = [newHand([], p.bet)];
  }
  startDealing(room, bettors);
}

// ---------- dealing (one card at a time so clients can animate) ----------
function startDealing(room, bettors) {
  room.phase = 'dealing'; room.holeHidden = true; room.turnToken = null; room.deadline = 0;
  const seq = [];
  for (let pass = 0; pass < 2; pass++) { for (const p of bettors) seq.push(p); seq.push('D'); }
  let i = 0;
  const step = () => {
    if (i >= seq.length) return afterDeal(room, bettors);
    const t = seq[i++], c = drawCard(room);
    if (t === 'D') room.dealer.push(c); else t.hands[0].cards.push(c);
    broadcast(room);
    room.timer = setTimeout(() => rooms.has(room.code) && step(), DEAL_STEP);
  };
  broadcast(room);
  room.timer = setTimeout(() => rooms.has(room.code) && step(), 500);
}
function afterDeal(room, bettors) {
  for (const p of bettors) if (isBJ(p.hands[0].cards)) p.hands[0].status = 'blackjack';
  if (room.dealer[0].r === 'A') return startInsurance(room, bettors);
  peek(room);
}
function startInsurance(room, bettors) {
  let any = false;
  for (const p of bettors) {
    const cost = Math.floor(p.bet / 2);
    p.insEligible = cost >= 1 && p.money >= cost && p.connected && !p.left;
    p.insDecided = !p.insEligible;
    if (p.insEligible) any = true;
  }
  if (!any) return peek(room);
  room.phase = 'insurance';
  room.msg = 'Dealer shows an Ace - insurance?';
  setTimer(room, INS_TIME, () => peek(room));
  broadcast(room);
}
function peek(room) {
  clearTimeout(room.timer);
  room.msg = '';
  const up = room.dealer[0];
  if ((up.r === 'A' || points(up) === 10) && isBJ(room.dealer)) {
    room.phase = 'dealer'; room.holeHidden = false; room.turnToken = null; room.deadline = 0;
    log(room, 'Dealer has Blackjack!'); room.msg = 'Dealer has Blackjack!';
    broadcast(room);
    return later(room, 1600, () => settle(room));
  }
  if (up.r === 'A' && room.players.some((p) => p.ins)) { log(room, 'No dealer blackjack - insurance lost'); room.msg = 'No dealer blackjack'; }
  nextTurn(room);
}

// ---------- player turns ----------
function armTurn(room, p) {
  setTimer(room, p.connected && !p.left ? TURN_TIME : 3000, () => {
    const h = p.hands[room.turnHand];
    if (h && h.status === 'playing') h.status = 'standing';
    log(room, `${p.name} timed out - stands`);
    nextTurn(room);
  });
}
function nextTurn(room) {
  clearTimeout(room.timer);
  for (const p of room.players) {
    for (let i = 0; i < p.hands.length; i++) {
      const h = p.hands[i];
      if (h.status !== 'playing') continue;
      room.phase = 'playing'; room.turnToken = p.token; room.turnHand = i; room.deadline = 0;
      if (h.cards.length === 1) { // second hand after a split: deal its second card now
        h.cards.push(drawCard(room));
        broadcast(room);
        return later(room, DEAL_STEP + 300, () => {
          if (h.splitAce || info(h.cards).v >= 21) { h.status = 'standing'; return later(room, 700, () => nextTurn(room)); }
          armTurn(room, p); broadcast(room);
        });
      }
      armTurn(room, p);
      return broadcast(room);
    }
  }
  room.turnToken = null;
  dealerPlay(room);
}
function playerAction(room, p, action) {
  if (room.phase !== 'playing' || room.turnToken !== p.token) return 'Not your turn';
  const h = p.hands[room.turnHand];
  if (!h || h.status !== 'playing') return 'Please wait';
  if (action === 'stand') { h.status = 'standing'; return nextTurn(room); }
  if (action === 'hit') {
    h.cards.push(drawCard(room));
    const v = info(h.cards).v;
    if (v > 21) { h.status = 'bust'; log(room, `${p.name} busts`); broadcast(room); return later(room, 900, () => nextTurn(room)); }
    if (v === 21) { h.status = 'standing'; broadcast(room); return later(room, 800, () => nextTurn(room)); }
    armTurn(room, p);
    return broadcast(room);
  }
  if (action === 'double') {
    if (h.cards.length !== 2 || h.splitAce) return 'You can only double on your first two cards';
    if (p.money < h.bet) return 'Not enough chips to double';
    p.money -= h.bet; h.bet *= 2; h.doubled = true;
    h.cards.push(drawCard(room));
    h.status = info(h.cards).v > 21 ? 'bust' : 'standing';
    if (h.status === 'bust') log(room, `${p.name} busts`);
    broadcast(room);
    return later(room, 1000, () => nextTurn(room));
  }
  if (action === 'split') {
    if (p.hands.length !== 1 || h.cards.length !== 2 || points(h.cards[0]) !== points(h.cards[1])) return 'You can only split a pair';
    if (p.money < h.bet) return 'Not enough chips to split';
    p.money -= h.bet;
    const [a, b] = h.cards;
    const aces = a.r === 'A';
    const h0 = newHand([a], h.bet), h1 = newHand([b], h.bet);
    for (const x of [h0, h1]) { x.fromSplit = true; x.splitAce = aces; }
    p.hands = [h0, h1];
    log(room, `${p.name} splits`);
    return nextTurn(room);
  }
  return 'Unknown action';
}

// ---------- dealer + settlement ----------
function dealerPlay(room) {
  room.phase = 'dealer'; room.turnToken = null; room.deadline = 0;
  const needDraw = room.players.some((p) => p.hands.some((h) => h.status === 'standing'));
  broadcast(room);
  const step = () => {
    if (room.holeHidden) { room.holeHidden = false; broadcast(room); return later(room, DEALER_STEP, step); }
    if (needDraw && info(room.dealer).v < 17) { room.dealer.push(drawCard(room)); broadcast(room); return later(room, DEALER_STEP, step); }
    settle(room);
  };
  later(room, 700, step);
}
function settle(room) {
  clearTimeout(room.timer);
  room.phase = 'results'; room.turnToken = null; room.holeHidden = false; room.msg = '';
  const dv = info(room.dealer).v, dBJ = isBJ(room.dealer);
  for (const p of room.players) {
    if (!p.hands.length) continue;
    let total = 0;
    for (const h of p.hands) {
      const v = info(h.cards).v;
      let payout = 0, res;
      if (h.status === 'bust' || v > 21) res = 'BUST';
      else if (h.status === 'blackjack' && !h.fromSplit) { if (dBJ) { payout = h.bet; res = 'PUSH'; } else { payout = h.bet * 2.5; res = 'BLACKJACK'; } }
      else if (dBJ) res = 'LOSE';
      else if (dv > 21 || v > dv) { payout = h.bet * 2; res = 'WIN'; }
      else if (v === dv) { payout = h.bet; res = 'PUSH'; }
      else res = 'LOSE';
      p.money += payout; h.result = res; h.delta = payout - h.bet; total += h.delta;
    }
    if (p.ins) {
      if (dBJ) { p.money += p.ins * 3; p.insDelta = p.ins * 2; } else p.insDelta = -p.ins;
      total += p.insDelta;
    }
    p.roundDelta = total;
    p.status = 'done';
  }
  for (const p of room.players) p.hist.push(p.money);
  log(room, `Round ${room.round}: dealer ${dv > 21 ? 'busts' : dv}`);
  setTimer(room, RESULT_TIME, () => nextRound(room));
  broadcast(room);
}

// ---------- match flow ----------
function nextRound(room) {
  const goal = goalAmount(room);
  for (const p of room.players) {
    if (p.status === 'out') continue;
    if (p.left) p.money = 0;
    if (p.money < MIN_BET) { p.status = 'out'; p.elimRound = room.round; log(room, `${p.name} is out of chips`); }
  }
  const alive = room.players.filter((p) => p.status !== 'out');
  const goalHit = alive.some((p) => p.money >= goal);
  if (goalHit || !alive.length || (room.players.length > 1 && alive.length <= 1)) return finish(room, goalHit);
  startBetting(room);
}
function finish(room, goalHit) {
  clearTimeout(room.timer);
  const goal = goalAmount(room);
  const cmp = (a, b) => {
    const ga = a.money >= goal && a.status !== 'out' ? 1 : 0, gb = b.money >= goal && b.status !== 'out' ? 1 : 0;
    if (ga !== gb) return gb - ga;
    const aa = a.status !== 'out' ? 1 : 0, ab = b.status !== 'out' ? 1 : 0;
    if (aa !== ab) return ab - aa;
    if (aa) return b.money - a.money;
    return b.elimRound - a.elimRound || b.money - a.money;
  };
  const order = [...room.players].sort(cmp);
  order.forEach((p, i) => {
    p.rank = i + 1;
    if (p.status === 'out') p.reason = `Out of chips in round ${p.elimRound}`;
    else if (p.money >= goal) p.reason = 'Reached the goal';
    else if (i === 0) p.reason = 'Last player standing';
    else p.reason = 'Survived the whole match';
  });
  room.phase = 'final'; room.turnToken = null; room.deadline = 0;
  room.msg = goalHit ? `${order[0].name} reached the goal!` : `${order[0].name} wins!`;
  log(room, room.msg);
  broadcast(room);
}
function removePlayer(room, p) {
  const idx = room.players.indexOf(p);
  if (idx < 0) return;
  if (room.phase === 'lobby' || room.phase === 'final') {
    room.players.splice(idx, 1);
    log(room, `${p.name} left`);
  } else {
    // mid-match: the seat is forfeited
    p.left = true; p.connected = false; p.sid = null;
    log(room, `${p.name} left the match`);
    if (p.status === 'betting') { p.status = 'out'; p.elimRound = room.round; p.money = 0; }
    if (room.turnToken === p.token && room.phase === 'playing') { const h = p.hands[room.turnHand]; if (h) h.status = 'standing'; nextTurn(room); }
    if (room.phase === 'insurance') { p.insDecided = true; checkInsDone(room); }
  }
  if (room.hostToken === p.token) {
    const nh = room.players.find((x) => x.connected && !x.left);
    if (nh) { room.hostToken = nh.token; log(room, `${nh.name} is the new host`); }
  }
  if (room.phase === 'betting') checkAllReady(room);
  broadcast(room);
}
function checkInsDone(room) {
  if (room.phase === 'insurance' && room.players.every((p) => p.insDecided)) peek(room);
}

setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    for (const p of [...room.players]) {
      if (!p.connected && !p.left && now - p.lastSeen > GONE_AFTER && (room.phase === 'lobby' || room.phase === 'final')) removePlayer(room, p);
    }
    if (!room.players.length || room.players.every((p) => !p.connected && now - p.lastSeen > GONE_AFTER)) {
      clearTimeout(room.timer); rooms.delete(room.code);
    }
  }
}, 15000);

// ---------- sockets ----------
io.on('connection', (socket) => {
  let room = null, me = null;
  const bind = (r, p) => { room = r; me = p; p.sid = socket.id; p.connected = true; p.lastSeen = Date.now(); socket.join(r.code); };

  socket.on('create', (d, ack) => {
    if (typeof ack !== 'function') return;
    const settings = {
      decks: clamp(parseInt(d?.decks, 10) || 6, 1, 6),
      money: clamp(parseInt(d?.money, 10) || 1000, 100, 10000000),
      maxPlayers: clamp(parseInt(d?.maxPlayers, 10) || 6, 2, 6),
      goal: clamp(parseInt(d?.goal, 10) || 10, 2, 100),
    };
    const p = newPlayer(cleanName(d?.name), settings.money);
    const r = createRoom(p, settings);
    bind(r, p);
    ack({ ok: true, token: p.token, code: r.code });
    broadcast(r);
  });

  socket.on('join', (d, ack) => {
    if (typeof ack !== 'function') return;
    const r = rooms.get(String(d?.code || '').toUpperCase().trim());
    if (!r) return ack({ ok: false, error: 'Room not found' });
    if (r.phase !== 'lobby') return ack({ ok: false, error: 'This match has already started' });
    if (r.players.length >= r.settings.maxPlayers) return ack({ ok: false, error: `Room is full (${r.settings.maxPlayers}/${r.settings.maxPlayers})` });
    let name = cleanName(d?.name);
    while (r.players.some((x) => x.name.toLowerCase() === name.toLowerCase())) name = name.slice(0, 11) + Math.floor(Math.random() * 90 + 10);
    const p = newPlayer(name, r.settings.money);
    r.players.push(p);
    bind(r, p);
    log(r, `${p.name} joined`);
    ack({ ok: true, token: p.token, code: r.code });
    broadcast(r);
  });

  socket.on('resume', (d, ack) => {
    if (typeof ack !== 'function') return;
    const r = rooms.get(String(d?.code || '').toUpperCase());
    const p = r?.players.find((x) => x.token === d?.token && !x.left);
    if (!p) return ack({ ok: false });
    bind(r, p);
    ack({ ok: true, token: p.token, code: r.code });
    broadcast(r);
  });

  socket.on('start', () => {
    if (!room || me.token !== room.hostToken || room.phase !== 'lobby') return;
    for (const p of room.players) { p.hist = [p.money]; p.elimRound = 0; p.rank = 0; p.reason = ''; }
    startBetting(room);
  });

  socket.on('bet', (d) => {
    if (!room || room.phase !== 'betting' || me.status !== 'betting') return;
    const amt = clamp(Math.floor(Number(d?.amount) || 0), 0, me.money);
    if (d?.ready) {
      if (amt < MIN_BET) return socket.emit('toast', `Minimum bet is $${MIN_BET}`);
      me.bet = amt; me.ready = true;
    } else { me.bet = amt; me.ready = false; }
    broadcast(room);
    checkAllReady(room);
  });

  for (const a of ['hit', 'stand', 'double', 'split']) {
    socket.on(a, () => {
      if (!room) return;
      const err = playerAction(room, me, a);
      if (typeof err === 'string') socket.emit('toast', err);
    });
  }

  socket.on('insure', (d) => {
    if (!room || room.phase !== 'insurance' || me.insDecided) return;
    if (d?.take) {
      const cost = Math.floor(me.bet / 2);
      if (me.money < cost) return socket.emit('toast', 'Not enough chips for insurance');
      me.money -= cost; me.ins = cost;
    }
    me.insDecided = true;
    broadcast(room);
    checkInsDone(room);
  });

  socket.on('rematch', () => {
    if (!room || me.token !== room.hostToken || room.phase !== 'final') return;
    room.players = room.players.filter((p) => p.connected && !p.left);
    for (const p of room.players) {
      Object.assign(p, { money: room.settings.money, hands: [], status: 'waiting', bet: 0, lastBet: 0, ready: false, ins: 0, insDelta: 0, roundDelta: 0, hist: [room.settings.money], elimRound: 0, rank: 0, reason: '' });
    }
    room.phase = 'lobby'; room.round = 0; room.dealer = []; room.msg = ''; room.shoe = buildShoe(room.settings.decks);
    log(room, 'New match - waiting in the lobby');
    broadcast(room);
  });

  socket.on('leave', () => {
    if (!room) return;
    socket.leave(room.code);
    const r = room, p = me; room = null; me = null;
    removePlayer(r, p);
  });

  socket.on('disconnect', () => {
    if (!room || !me || me.sid !== socket.id) return;
    me.connected = false; me.sid = null; me.lastSeen = Date.now();
    if (room.hostToken === me.token) {
      const nh = room.players.find((x) => x.connected && !x.left);
      if (nh) { room.hostToken = nh.token; log(room, `${nh.name} is the new host`); }
    }
    if (room.turnToken === me.token && room.phase === 'playing') armTurn(room, me);
    if (room.phase === 'insurance') { me.insDecided = true; checkInsDone(room); }
    if (room.phase === 'betting') { if (!me.ready && me.status === 'betting') { me.bet = clamp(me.lastBet || MIN_BET, MIN_BET, me.money); me.ready = true; } checkAllReady(room); }
    broadcast(room);
  });
});

server.listen(PORT, () => console.log(`Royal Blackjack Online running on http://localhost:${PORT}`));

module.exports = { rooms, server, io };
