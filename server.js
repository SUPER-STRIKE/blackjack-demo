// Royal Blackjack Online - authoritative game server (Express + Socket.IO)
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 4;
const MIN_BET = 10;
const BET_TIME = 25000;
const TURN_TIME = 25000;
const RESULT_TIME = 8000;
const GONE_AFTER = 120000; // drop disconnected players after 2 min (when safe)

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingTimeout: 20000 });
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.send('ok'));

const rooms = new Map();

// ---------- helpers ----------
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function buildShoe(decks, exclude = []) {
  const s = [];
  for (let d = 0; d < decks; d++)
    for (const su of SUITS) for (const r of RANKS) s.push({ r, s: su });
  // remove cards currently on the table (one copy each)
  for (const c of exclude) {
    const i = s.findIndex((x) => x.r === c.r && x.s === c.s);
    if (i >= 0) s.splice(i, 1);
  }
  return shuffle(s);
}
function handValue(cards) {
  let t = 0, aces = 0;
  for (const c of cards) {
    if (c.r === 'A') { aces++; t += 11; }
    else if ('JQK'.includes(c.r)) t += 10;
    else t += parseInt(c.r, 10);
  }
  while (t > 21 && aces) { t -= 10; aces--; }
  return t;
}
const isBJ = (cards) => cards.length === 2 && handValue(cards) === 21;

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join(''); }
  while (rooms.has(c));
  return c;
}
const cleanName = (n) => String(n || '').replace(/[^\p{L}\p{N} _\-.]/gu, '').trim().slice(0, 14) || 'Player';

function newPlayer(name, money) {
  return {
    token: crypto.randomBytes(12).toString('hex'),
    sid: null, name, money, bet: 0, ready: false, cards: [],
    status: 'waiting', doubled: false, delta: 0, result: '', connected: true,
    lastSeen: Date.now(), rebuys: 0,
  };
}

function log(room, msg) {
  room.log.push(msg);
  if (room.log.length > 30) room.log.shift();
}

// ---------- state broadcast ----------
function snapshot(room, forToken) {
  const hideHole = room.phase === 'playing' || room.phase === 'betting_deal';
  const dealerCards = room.dealer.map((c, i) => (i === 1 && room.holeHidden ? null : c));
  const visible = dealerCards.filter(Boolean);
  return {
    now: Date.now(),
    code: room.code,
    round: room.round,
    phase: room.phase,
    settings: room.settings,
    host: room.players.find((p) => p.token === room.hostToken)?.token === forToken,
    hostName: room.players.find((p) => p.token === room.hostToken)?.name,
    shoeLeft: room.shoe.length,
    shoeTotal: room.settings.decks * 52,
    deadline: room.deadline,
    turn: room.turnToken,
    msg: room.msg,
    log: room.log.slice(-10),
    dealer: { cards: dealerCards, value: visible.length ? handValue(visible) : 0, hidden: room.holeHidden },
    players: room.players.map((p) => ({
      id: p.token === forToken ? 'me' : p.token.slice(0, 6),
      me: p.token === forToken,
      name: p.name, money: p.money, bet: p.bet, ready: p.ready,
      cards: p.cards, value: p.cards.length ? handValue(p.cards) : 0,
      status: p.status, doubled: p.doubled, delta: p.delta, result: p.result,
      connected: p.connected, isHost: p.token === room.hostToken,
      turn: room.turnToken === p.token,
    })),
  };
}
function broadcast(room) {
  for (const p of room.players) if (p.sid) io.to(p.sid).emit('state', snapshot(room, p.token));
}

// ---------- room lifecycle ----------
function createRoom(host, settings) {
  const room = {
    code: makeCode(), settings, players: [host], hostToken: host.token,
    phase: 'lobby', shoe: [], dealer: [], holeHidden: true,
    turnToken: null, deadline: 0, timer: null, msg: '', log: [], round: 0,
  };
  room.shoe = buildShoe(settings.decks);
  rooms.set(room.code, room);
  log(room, `${host.name} created the table`);
  return room;
}
function setTimer(room, ms, fn) {
  clearTimeout(room.timer);
  room.deadline = ms ? Date.now() + ms : 0;
  room.timer = ms ? setTimeout(fn, ms) : null;
}
function activePlayers(room) { return room.players.filter((p) => p.status === 'playing' || p.status === 'standing' || p.status === 'bust' || p.status === 'blackjack'); }

function startBetting(room) {
  clearTimeout(room.timer);
  room.phase = 'betting';
  room.round++;
  room.dealer = []; room.holeHidden = true; room.turnToken = null;
  // reshuffle if shoe is low
  const total = room.settings.decks * 52;
  if (room.shoe.length < Math.max(15, total * 0.25)) {
    room.shoe = buildShoe(room.settings.decks);
    log(room, 'Shoe reshuffled');
    room.msg = 'Shoe reshuffled';
  } else room.msg = '';
  for (const p of room.players) {
    p.cards = []; p.bet = 0; p.ready = false; p.doubled = false; p.delta = 0; p.result = '';
    p.status = p.money >= MIN_BET ? 'betting' : 'broke';
    if (!p.connected) { p.status = 'sitout'; p.ready = true; }
  }
  setTimer(room, BET_TIME, () => endBetting(room));
  broadcast(room);
}

function checkAllReady(room) {
  if (room.phase !== 'betting') return;
  const waiting = room.players.filter((p) => p.status === 'betting' && p.connected && !p.ready);
  const anyone = room.players.some((p) => p.status === 'betting');
  if (anyone && waiting.length === 0) endBetting(room);
}

function drawCard(room) {
  if (!room.shoe.length) {
    const inPlay = [...room.dealer, ...room.players.flatMap((p) => p.cards)];
    room.shoe = buildShoe(room.settings.decks, inPlay);
    log(room, 'Shoe reshuffled mid-round');
  }
  return room.shoe.pop();
}

function endBetting(room) {
  clearTimeout(room.timer);
  const bettors = room.players.filter((p) => p.status === 'betting' && p.ready && p.bet >= MIN_BET && p.bet <= p.money);
  for (const p of room.players) if (!bettors.includes(p) && p.status === 'betting') p.status = 'sitout';
  if (!bettors.length) {
    room.msg = 'No bets placed - place your bets!';
    startBetting(room);
    room.round--;
    return;
  }
  room.phase = 'playing';
  room.holeHidden = true;
  for (const p of bettors) { p.money -= p.bet; p.status = 'playing'; p.cards = []; }
  // deal: one card each, dealer, one each, dealer(hole)
  for (let pass = 0; pass < 2; pass++) {
    for (const p of bettors) p.cards.push(drawCard(room));
    room.dealer.push(drawCard(room));
  }
  const up = room.dealer[0];
  const peek = up.r === 'A' || ['10', 'J', 'Q', 'K'].includes(up.r);
  for (const p of bettors) if (isBJ(p.cards)) p.status = 'blackjack';
  if (peek && isBJ(room.dealer)) {
    room.holeHidden = false;
    log(room, 'Dealer has Blackjack!');
    return settle(room);
  }
  nextTurn(room);
}

function nextTurn(room) {
  clearTimeout(room.timer);
  const p = room.players.find((x) => x.status === 'playing');
  if (!p) { room.turnToken = null; return dealerPlay(room); }
  room.turnToken = p.token;
  setTimer(room, p.connected ? TURN_TIME : 3000, () => {
    log(room, `${p.name} timed out - stands`);
    p.status = 'standing';
    nextTurn(room);
  });
  broadcast(room);
}

function dealerPlay(room) {
  room.phase = 'dealer';
  room.turnToken = null;
  room.deadline = 0;
  const needDealer = room.players.some((p) => p.status === 'standing' || p.status === 'blackjack');
  broadcast(room);
  const step = () => {
    if (!rooms.has(room.code)) return;
    if (room.holeHidden) {
      room.holeHidden = false;
      broadcast(room);
      return (room.timer = setTimeout(step, 900));
    }
    const onlyBJ = !room.players.some((p) => p.status === 'standing');
    if (needDealer && !onlyBJ && handValue(room.dealer) < 17) {
      room.dealer.push(drawCard(room));
      broadcast(room);
      return (room.timer = setTimeout(step, 900));
    }
    settle(room);
  };
  room.timer = setTimeout(step, 600);
}

function settle(room) {
  clearTimeout(room.timer);
  room.phase = 'results';
  room.turnToken = null;
  room.holeHidden = false;
  const dv = handValue(room.dealer);
  const dBJ = isBJ(room.dealer);
  for (const p of room.players) {
    if (!['playing', 'standing', 'bust', 'blackjack'].includes(p.status)) continue;
    const v = handValue(p.cards);
    const stake = p.bet * (p.doubled ? 2 : 1);
    let payout = 0, res;
    if (p.status === 'bust' || v > 21) { res = 'BUST'; }
    else if (p.status === 'blackjack' && !dBJ) { payout = stake * 2.5; res = 'BLACKJACK'; }
    else if (p.status === 'blackjack' && dBJ) { payout = stake; res = 'PUSH'; }
    else if (dBJ) { res = 'LOSE'; }
    else if (dv > 21 || v > dv) { payout = stake * 2; res = 'WIN'; }
    else if (v === dv) { payout = stake; res = 'PUSH'; }
    else { res = 'LOSE'; }
    p.money += payout;
    p.delta = payout - stake;
    p.result = res;
    p.status = 'done';
  }
  log(room, `Round ${room.round}: dealer ${dv > 21 ? 'busts' : dv}`);
  setTimer(room, RESULT_TIME, () => startBetting(room));
  broadcast(room);
}

function playerAction(room, p, action) {
  if (room.phase !== 'playing' || room.turnToken !== p.token || p.status !== 'playing') return 'Not your turn';
  if (action === 'hit') {
    p.cards.push(drawCard(room));
    const v = handValue(p.cards);
    if (v > 21) { p.status = 'bust'; log(room, `${p.name} busts`); return nextTurn(room); }
    if (v === 21) { p.status = 'standing'; return nextTurn(room); }
    setTimer(room, TURN_TIME, () => { p.status = 'standing'; nextTurn(room); });
    return broadcast(room);
  }
  if (action === 'stand') { p.status = 'standing'; return nextTurn(room); }
  if (action === 'double') {
    if (p.cards.length !== 2) return 'Can only double on first two cards';
    if (p.money < p.bet) return 'Not enough chips to double';
    p.money -= p.bet; p.doubled = true;
    p.cards.push(drawCard(room));
    p.status = handValue(p.cards) > 21 ? 'bust' : 'standing';
    if (p.status === 'bust') log(room, `${p.name} busts`);
    return nextTurn(room);
  }
  return 'Unknown action';
}

function removePlayer(room, p) {
  const idx = room.players.indexOf(p);
  if (idx < 0) return;
  const wasTurn = room.turnToken === p.token;
  const inRound = ['playing', 'standing', 'bust', 'blackjack'].includes(p.status);
  if (inRound && room.phase !== 'results') {
    // keep the seat until the round ends (their bet is already in play)
    p.connected = false; p.sid = null; p.leaving = true;
    if (wasTurn) { p.status = 'standing'; nextTurn(room); }
    return broadcast(room);
  }
  room.players.splice(idx, 1);
  log(room, `${p.name} left`);
  if (!room.players.some((x) => x.connected)) {
    // nobody connected; keep room briefly for reconnects
    return;
  }
  if (room.hostToken === p.token) {
    const nh = room.players.find((x) => x.connected) || room.players[0];
    room.hostToken = nh.token;
    log(room, `${nh.name} is the new host`);
  }
  if (room.phase === 'betting') checkAllReady(room);
  broadcast(room);
}

// sweeper: drop long-disconnected players and empty rooms
setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    for (const p of [...room.players]) {
      const safe = !['playing', 'standing', 'bust', 'blackjack'].includes(p.status) || room.phase === 'results';
      if (!p.connected && now - p.lastSeen > GONE_AFTER && safe) removePlayer(room, p);
    }
    if (!room.players.length || room.players.every((p) => !p.connected && now - p.lastSeen > GONE_AFTER)) {
      clearTimeout(room.timer);
      rooms.delete(room.code);
    }
  }
}, 15000);

// ---------- sockets ----------
io.on('connection', (socket) => {
  let room = null, me = null;
  const bind = (r, p) => {
    room = r; me = p; p.sid = socket.id; p.connected = true; p.lastSeen = Date.now(); p.leaving = false;
    socket.join(r.code);
  };

  socket.on('create', (d, ack) => {
    if (typeof ack !== 'function') return;
    const decks = Math.min(6, Math.max(1, parseInt(d?.decks, 10) || 6));
    const money = Math.min(10_000_000, Math.max(100, parseInt(d?.money, 10) || 1000));
    const p = newPlayer(cleanName(d?.name), money);
    const r = createRoom(p, { decks, money });
    bind(r, p);
    ack({ ok: true, token: p.token, code: r.code });
    broadcast(r);
  });

  socket.on('join', (d, ack) => {
    if (typeof ack !== 'function') return;
    const r = rooms.get(String(d?.code || '').toUpperCase().trim());
    if (!r) return ack({ ok: false, error: 'Room not found' });
    if (r.players.length >= MAX_PLAYERS) return ack({ ok: false, error: 'Room is full (4/4)' });
    let name = cleanName(d?.name);
    while (r.players.some((x) => x.name.toLowerCase() === name.toLowerCase())) name = (name.slice(0, 11) + Math.floor(Math.random() * 90 + 10));
    const p = newPlayer(name, r.settings.money);
    if (r.phase === 'lobby') p.status = 'waiting';
    else p.status = 'sitout'; // joins next round
    if (r.phase === 'betting') p.status = 'betting';
    r.players.push(p);
    bind(r, p);
    log(r, `${p.name} joined`);
    ack({ ok: true, token: p.token, code: r.code });
    broadcast(r);
  });

  socket.on('resume', (d, ack) => {
    if (typeof ack !== 'function') return;
    const r = rooms.get(String(d?.code || '').toUpperCase());
    const p = r?.players.find((x) => x.token === d?.token);
    if (!p) return ack({ ok: false });
    bind(r, p);
    ack({ ok: true, token: p.token, code: r.code });
    broadcast(r);
  });

  socket.on('start', () => {
    if (!room || me.token !== room.hostToken || room.phase !== 'lobby') return;
    startBetting(room);
  });

  socket.on('bet', (d) => {
    if (!room || room.phase !== 'betting' || me.status !== 'betting') return;
    let amt = Math.floor(Number(d?.amount) || 0);
    amt = Math.max(0, Math.min(amt, me.money));
    if (d?.ready && d?.sitout) { me.bet = 0; me.ready = true; me.status = 'sitout'; }
    else if (d?.ready) {
      if (amt < MIN_BET) return socket.emit('toast', `Minimum bet is $${MIN_BET}`);
      me.bet = amt; me.ready = true;
    } else { me.bet = amt; me.ready = false; }
    broadcast(room);
    checkAllReady(room);
  });

  for (const a of ['hit', 'stand', 'double']) {
    socket.on(a, () => {
      if (!room) return;
      const err = playerAction(room, me, a);
      if (typeof err === 'string') socket.emit('toast', err);
    });
  }

  socket.on('rebuy', () => {
    if (!room || !me) return;
    if (me.money >= MIN_BET) return socket.emit('toast', 'You still have chips!');
    if (['playing', 'standing', 'bust', 'blackjack'].includes(me.status)) return;
    me.money += room.settings.money; me.rebuys++;
    log(room, `${me.name} re-bought ($${room.settings.money})`);
    if (room.phase === 'betting') { me.status = 'betting'; me.ready = false; }
    else if (me.status === 'broke') me.status = 'sitout';
    broadcast(room);
  });

  socket.on('sitin', () => {
    if (room && room.phase === 'betting' && me.status === 'sitout' && me.money >= MIN_BET) {
      me.status = 'betting'; me.ready = false; broadcast(room);
    }
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
      const nh = room.players.find((x) => x.connected);
      if (nh) { room.hostToken = nh.token; log(room, `${nh.name} is the new host`); }
    }
    if (room.turnToken === me.token) {
      const r = room, p = me;
      setTimer(r, 3000, () => { p.status = 'standing'; nextTurn(r); });
    }
    if (room.phase === 'betting') checkAllReady(room);
    broadcast(room);
  });
});

server.listen(PORT, () => console.log(`Royal Blackjack Online running on http://localhost:${PORT}`));
