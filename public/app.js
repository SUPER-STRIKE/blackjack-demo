(() => {
  const $ = (id) => document.getElementById(id);
  const socket = io();
  const CHIPS = [10, 25, 50, 100, 500, 1000, 5000, 10000, 50000, 100000, 500000, 1000000];
  const DEN = [...CHIPS].reverse();
  const MIN_BET = 10;
  const COLORS = ['#f5c15a', '#38bdf8', '#f472b6', '#a3e635', '#fb923c', '#c084fc'];
  const fmt = (n) => '$' + Math.round(n).toLocaleString('en-US');
  const short = (n) => (n >= 1e6 ? +(n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? +(n / 1e3).toFixed(1) + 'k' : String(n));
  const sgn = (n) => (n > 0 ? '+' + fmt(n) : n < 0 ? '-' + fmt(-n) : fmt(0));
  const ord = (n) => n + (['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10 < 4 ? n % 10 : 0]);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sfx = (n) => window.SFX && SFX.play(n);

  let S = null, P = null;          // current / previous state
  let offset = 0, myBet = 0, lastBet = 0;
  let seen = new Set(), quiet = true, decks = 6, maxPl = 6, goalX = 10;

  // ---------- session ----------
  const save = (token, code) => { try { sessionStorage.setItem('bj', JSON.stringify({ token, code })); } catch {} };
  const load = () => { try { return JSON.parse(sessionStorage.getItem('bj')); } catch { return null; } };
  const clear = () => { try { sessionStorage.removeItem('bj'); } catch {} };
  function show(id) {
    for (const s of ['home', 'lobby', 'table']) $(s).hidden = s !== id;
    document.body.dataset.screen = id;
  }
  let toastT;
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2800); }
  socket.on('toast', toast);

  // ---------- audio buttons ----------
  const ICON = {
    sfx: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M3 9v6h4l5 4V5L7 9H3z"/><path class="w" d="M16 8a5 5 0 010 8M18.5 5.5a9 9 0 010 13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    mus: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M9 17V5l11-2v12"/><circle cx="6.5" cy="17.5" r="3"/><circle cx="17.5" cy="15.5" r="3"/></svg>',
  };
  function paintAudio() {
    document.querySelectorAll('.sfxBtn').forEach((b) => { b.innerHTML = ICON.sfx; b.classList.toggle('off', !SFX.state.sfx); b.setAttribute('aria-pressed', SFX.state.sfx); });
    document.querySelectorAll('.musBtn').forEach((b) => { b.innerHTML = ICON.mus; b.classList.toggle('off', !SFX.state.music); b.setAttribute('aria-pressed', SFX.state.music); });
  }
  document.querySelectorAll('.sfxBtn').forEach((b) => (b.onclick = () => { SFX.setSfx(!SFX.state.sfx); paintAudio(); }));
  document.querySelectorAll('.musBtn').forEach((b) => (b.onclick = () => { SFX.setMusic(!SFX.state.music); paintAudio(); }));
  paintAudio();

  // ---------- modals ----------
  const modal = (id, on = true) => ($(id).hidden = !on);
  $('howBtn').onclick = $('lobbyHow').onclick = () => modal('howModal');
  $('howClose').onclick = () => modal('howModal', false);
  $('logBtn').onclick = () => modal('logModal');
  $('logClose').onclick = () => modal('logModal', false);
  $('chartBtn').onclick = () => { $('chartBox').innerHTML = chartHTML(); modal('chartModal'); };
  $('chartClose').onclick = () => modal('chartModal', false);
  document.querySelectorAll('.modal:not(.final)').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) m.hidden = true; }));

  // ---------- home ----------
  try { $('name').value = localStorage.getItem('bjname') || ''; } catch {}
  const qs = new URLSearchParams(location.search);
  function tab(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $('tab-host').hidden = name !== 'host'; $('tab-join').hidden = name !== 'join';
  }
  document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => tab(t.dataset.tab)));
  if (qs.get('room')) { tab('join'); $('code').value = qs.get('room').toUpperCase().slice(0, 4); }

  function pills(box, vals, label, get, set) {
    vals.forEach((v) => {
      const b = document.createElement('button'); b.textContent = label(v);
      b.onclick = () => { set(v); paint(); };
      box.appendChild(b);
    });
    const paint = () => [...box.children].forEach((b, i) => b.classList.toggle('on', vals[i] === get()));
    paint(); return paint;
  }
  const pDecks = pills($('deckPick'), [1, 2, 3, 4, 5, 6], (v) => v, () => decks, (v) => (decks = v));
  const pMax = pills($('maxPick'), [2, 3, 4, 5, 6], (v) => v, () => maxPl, (v) => (maxPl = v));
  const pGoal = pills($('goalPick'), [3, 5, 10, 20], (v) => v + '×', () => goalX, (v) => { goalX = v; goalHint(); });
  function goalHint() { const m = parseInt($('money').value, 10) || 0; $('goalHint').textContent = `first to ${fmt(m * goalX)} wins`; }
  [500, 1000, 5000, 10000, 100000].forEach((v) => {
    const b = document.createElement('button'); b.textContent = fmt(v);
    b.onclick = () => { $('money').value = v; paintMoney(); };
    $('moneyPresets').appendChild(b);
  });
  function paintMoney() { [...$('moneyPresets').children].forEach((b) => b.classList.toggle('on', b.textContent === fmt(+$('money').value))); goalHint(); }
  $('money').oninput = paintMoney; paintMoney();

  const name = () => { const n = $('name').value.trim(); try { localStorage.setItem('bjname', n); } catch {} return n; };
  const homeErr = (m) => ($('homeErr').textContent = m || '');
  $('createBtn').onclick = () => {
    if (!name()) return homeErr('Please enter your name');
    const money = parseInt($('money').value, 10);
    if (!(money >= 100)) return homeErr('Starting chips must be at least $100');
    socket.emit('create', { name: name(), decks, money, maxPlayers: maxPl, goal: goalX }, (r) => { if (!r.ok) return homeErr(r.error); homeErr(''); save(r.token, r.code); });
  };
  $('joinBtn').onclick = () => {
    if (!name()) return homeErr('Please enter your name');
    const code = $('code').value.trim().toUpperCase();
    if (code.length !== 4) return homeErr('Enter the 4-letter room code');
    socket.emit('join', { name: name(), code }, (r) => { if (!r.ok) return homeErr(r.error); homeErr(''); save(r.token, r.code); });
  };
  [$('name'), $('code'), $('money')].forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') ($('tab-host').hidden ? $('joinBtn') : $('createBtn')).click(); }));

  function tryResume() { const s = load(); if (!s) return; socket.emit('resume', s, (r) => { if (!r.ok) { clear(); S = P = null; show('home'); } }); }
  socket.on('connect', tryResume);
  socket.on('disconnect', () => toast('Connection lost - reconnecting…'));

  // ---------- lobby ----------
  function leave() { socket.emit('leave'); clear(); S = P = null; $('final').hidden = true; show('home'); }
  $('lobbyLeave').onclick = leave; $('finalLeave').onclick = leave;
  $('leaveBtn').onclick = () => modal('leaveModal');
  $('leaveStay').onclick = () => modal('leaveModal', false);
  $('leaveGo').onclick = () => { modal('leaveModal', false); leave(); };
  $('startBtn').onclick = () => { SFX.play('click'); socket.emit('start'); };
  $('rematchBtn').onclick = () => socket.emit('rematch');
  const link = () => `${location.origin}/?room=${S.code}`;
  const copy = async (t, m) => { try { await navigator.clipboard.writeText(t); toast(m); } catch { prompt('Copy this:', t); } };
  $('copyCode').onclick = () => copy(S.code, 'Code copied');
  $('copyLink').onclick = () => copy(link(), 'Invite link copied');

  function renderLobby() {
    const st = S.settings;
    $('lobbyCode').textContent = S.code;
    $('lobbySettings').innerHTML = `<span class="pill">${st.decks} deck${st.decks > 1 ? 's' : ''}</span><span class="pill">${fmt(st.money)} each</span><span class="pill">Goal ${fmt(S.goalAmount)}</span><span class="pill">${S.players.length}/${st.maxPlayers} players</span>`;
    let h = S.players.map((p) => `<li><span>${esc(p.name)}${p.me ? ' (you)' : ''}</span>${p.isHost ? '<span class="crown">Host</span>' : ''}</li>`).join('');
    for (let i = S.players.length; i < st.maxPlayers; i++) h += '<li class="empty"><span>Open seat</span></li>';
    $('lobbyPlayers').innerHTML = h;
    $('startBtn').hidden = !S.host; $('lobbyWait').hidden = S.host;
  }

  // ---------- cards ----------
  const L = 28, R = 72, C = 50;
  const PIPS = {
    '2': [[C, 16], [C, 84]], '3': [[C, 16], [C, 50], [C, 84]], '4': [[L, 16], [R, 16], [L, 84], [R, 84]], '5': [[L, 16], [R, 16], [C, 50], [L, 84], [R, 84]],
    '6': [[L, 16], [R, 16], [L, 50], [R, 50], [L, 84], [R, 84]], '7': [[L, 16], [R, 16], [C, 33], [L, 50], [R, 50], [L, 84], [R, 84]],
    '8': [[L, 16], [R, 16], [C, 33], [L, 50], [R, 50], [C, 67], [L, 84], [R, 84]],
    '9': [[L, 16], [R, 16], [L, 38], [R, 38], [C, 50], [L, 62], [R, 62], [L, 84], [R, 84]],
    '10': [[L, 16], [R, 16], [C, 27], [L, 38], [R, 38], [L, 62], [R, 62], [C, 73], [L, 84], [R, 84]],
  };
  function face(c) {
    if (c.r === 'A') return `<span class="pip ace" style="left:50%;top:50%">${c.s}</span>`;
    if ('JQK'.includes(c.r)) return `<div class="court"><b>${c.r}</b><span class="cs t">${c.s}</span><span class="cs b">${c.s}</span></div>`;
    return PIPS[c.r].map(([x, y]) => `<span class="pip${y > 50 ? ' flip' : ''}" style="left:${x}%;top:${y}%">${c.s}</span>`).join('');
  }
  let dealN = 0;
  function cardHTML(c, key) {
    const fresh = !seen.has(key);
    if (fresh) seen.add(key);
    const anim = fresh && !quiet;
    const cls = 'card' + (anim ? ' deal' : '');
    if (!c) return `<div class="${cls} back"><i></i></div>`;
    const red = c.s === '♥' || c.s === '♦' ? ' red' : '';
    return `<div class="${cls}${red}"><div class="idx"><span>${c.r}</span><span>${c.s}</span></div><div class="face">${face(c)}</div><div class="idx br"><span>${c.r}</span><span>${c.s}</span></div></div>`;
  }
  const cardsHTML = (cards, id) => cards.map((c, i) => cardHTML(c, `${id}-${i}-${c ? 'f' : 'b'}`)).join('');

  // ---------- table rendering ----------
  const me = () => S.players.find((p) => p.me);
  const live = (p) => p.status !== 'out';
  function stack(amount) {
    let left = amount; const chips = [];
    for (const d of DEN) while (left >= d && chips.length < 14) { chips.push(d); left -= d; }
    return chips.reverse().map((v, i) => `<i class="sc" data-v="${v}" style="bottom:${i * 5}px"></i>`).join('');
  }
  function totalHTML(h) {
    const bust = h.value > 21, bj = h.status === 'blackjack';
    return `<span class="total${bust ? ' bust' : ''}${bj ? ' bj' : ''}">${h.value}${h.soft && !bust ? '<small>soft</small>' : ''}</span>`;
  }
  function handBadge(h) {
    if (h.result) { const t = h.result; return `<span class="badge ${t.toLowerCase()}">${t === 'BLACKJACK' ? 'Blackjack' : t[0] + t.slice(1).toLowerCase()} ${h.delta ? sgn(h.delta) : ''}</span>`; }
    if (h.status === 'bust') return '<span class="badge bust">Bust</span>';
    if (h.status === 'blackjack') return '<span class="badge blackjack">Blackjack</span>';
    if (h.status === 'standing') return '<span class="badge">Stand</span>';
    return '';
  }
  function renderSeats() {
    const n = S.players.length;
    $('seats').dataset.n = n;
    let h = '';
    S.players.forEach((p, idx) => {
      const split = p.hands.length > 1;
      const totalBet = p.hands.reduce((a, x) => a + x.bet, 0);
      const amt = S.phase === 'betting' ? (p.ready ? p.bet : 0) : totalBet;
      const hands = p.hands.map((x, hi) => `<div class="hnd${p.turn && p.turnHand === hi ? ' cur' : ''}">
          <div class="hand">${cardsHTML(x.cards, `r${S.round}-p${idx}-h${hi}`)}</div>${x.cards.length ? totalHTML(x) : ''}${handBadge(x)}</div>`).join('');
      const out = p.status === 'out';
      const note = out ? 'Eliminated' : S.phase === 'betting' ? (p.ready ? 'Bet placed' : 'Betting…') : '';
      const rd = S.phase === 'results' && p.hands.length ? `<span class="rd ${p.roundDelta > 0 ? 'up' : p.roundDelta < 0 ? 'dn' : ''}">${sgn(p.roundDelta)}</span>` : '';
      h += `<div class="seat ${p.me ? 'me' : ''} ${p.turn ? 'turn' : ''} ${out ? 'out' : ''} ${split ? 'split' : ''}">
        <div class="hands">${hands}</div>
        <div class="spot">${stack(amt)}${amt ? `<em>${fmt(amt)}</em>` : ''}</div>
        ${p.ins ? `<span class="instag">Insured ${fmt(p.ins)}${S.phase === 'results' ? ' ' + sgn(p.insDelta) : ''}</span>` : ''}
        <div class="plate"><div class="sname">${p.connected ? '' : '<i class="off" title="Disconnected"></i>'}${p.isHost ? '♛ ' : ''}${esc(p.name)}${p.me ? ' (you)' : ''}</div>
          <div class="smoney">${fmt(p.money)} ${rd}</div>${note ? `<div class="snote">${note}</div>` : ''}</div></div>`;
    });
    $('seats').innerHTML = h;
  }

  function renderDock() {
    const m = me();
    $('myMoney').textContent = fmt(m.money);
    const betting = S.phase === 'betting' && m.status === 'betting';
    const myTurn = S.phase === 'playing' && m.turn && m.can;
    const insAsk = S.phase === 'insurance' && m.insEligible && !m.insDecided;
    $('betPanel').hidden = !betting; $('actPanel').hidden = !myTurn; $('insPanel').hidden = !insAsk;
    const total = m.hands.reduce((a, x) => a + x.bet, 0);
    $('myBet').textContent = fmt(betting ? (m.ready ? m.bet : myBet) : total);
    let info = '';
    if (m.status === 'out') info = 'You are out of chips. Watch the rest of the match - rankings are decided by who survives longest.';
    else if (S.phase === 'betting' && !betting) info = 'Waiting…';
    else if (S.phase === 'dealing') info = 'Dealing…';
    else if (S.phase === 'insurance' && !insAsk) info = m.ins ? 'Insurance placed - waiting for others…' : 'Waiting for insurance decisions…';
    else if (S.phase === 'playing' && !myTurn) { const t = S.players.find((p) => p.turn); info = m.hands.length ? `Waiting for ${t ? esc(t.name) : 'others'}…` : ''; }
    else if (S.phase === 'dealer') info = 'Dealer is playing…';
    else if (S.phase === 'results') info = m.hands.length ? `${m.roundDelta > 0 ? 'You won' : m.roundDelta < 0 ? 'You lost' : 'Push'} ${m.roundDelta ? fmt(Math.abs(m.roundDelta)) : ''} · next round starting…` : 'Next round starting…';
    $('infoPanel').hidden = betting || myTurn || insAsk || !info;
    $('infoPanel').innerHTML = info;
    if (insAsk) $('insText').innerHTML = `Dealer shows an Ace. Insurance costs <b>${fmt(Math.floor(m.bet / 2))}</b> and pays 2 to 1 if the dealer has Blackjack.`;
    if (betting) {
      if (!m.ready) myBet = Math.min(myBet, m.money);
      document.querySelectorAll('.chip').forEach((c) => (c.disabled = m.ready || myBet + +c.dataset.v > m.money));
      $('dealBtn').textContent = m.ready ? 'Ready - tap to change bet' : myBet >= MIN_BET ? `Place bet ${fmt(myBet)}` : `Bet at least ${fmt(MIN_BET)}`;
      $('dealBtn').disabled = !m.ready && myBet < MIN_BET;
      $('clearBet').disabled = $('allIn').disabled = m.ready;
      $('rebet').disabled = m.ready || !lastBet || lastBet > m.money;
    }
    if (myTurn) { $('dblBtn').disabled = !m.can.double; $('splBtn').disabled = !m.can.split; }
  }

  function renderGoal() {
    const alive = S.players.filter(live);
    const lead = [...alive].sort((a, b) => b.money - a.money)[0];
    const pct = lead ? Math.min(100, (lead.money / S.goalAmount) * 100) : 0;
    $('goalFill').style.width = pct + '%';
    $('goalTxt').textContent = `Goal ${fmt(S.goalAmount)}${lead ? ` · leader ${lead.name} ${fmt(lead.money)}` : ''} · round ${S.round}`;
    $('tGoal').textContent = `Goal ${fmt(S.goalAmount)}`;
  }

  function renderTable() {
    dealN = 0;
    $('tCode').textContent = S.code;
    $('shoeBar').style.width = (S.shoeLeft / S.shoeTotal) * 100 + '%';
    $('shoeTxt').textContent = `${S.shoeLeft} / ${S.shoeTotal}`;
    $('dHand').innerHTML = cardsHTML(S.dealer.cards, `r${S.round}-d`);
    $('dScore').innerHTML = S.dealer.cards.length ? `${S.dealer.value}${S.dealer.hidden ? '<small>+ hidden</small>' : S.dealer.soft ? '<small>soft</small>' : ''}` : '';
    $('dScore').className = 'total dealer-total' + (S.dealer.value > 21 ? ' bust' : '');
    $('banner').textContent = S.phase === 'betting' ? S.msg || 'Place your bets' : S.phase === 'dealing' ? 'Dealing' : S.phase === 'dealer' && !S.msg ? 'Dealer plays' : S.msg;
    renderGoal(); renderSeats(); renderDock();
    $('logList').innerHTML = [...S.log].reverse().map((l) => `<li>${esc(l)}</li>`).join('');
    if (!$('chartModal').hidden) $('chartBox').innerHTML = chartHTML();
  }

  // ---------- chart ----------
  function chartHTML() {
    const hist = S.hist, W = 640, H = 290, pd = { l: 54, r: 16, t: 16, b: 30 };
    const n = Math.max(...hist.map((h) => h.length));
    if (n < 2) return '<p class="sub">The chart appears after the first round.</p>';
    const ymax = Math.max(S.goalAmount, ...hist.flat()) * 1.05;
    const x = (i) => pd.l + ((W - pd.l - pd.r) * i) / (n - 1), y = (v) => H - pd.b - ((H - pd.t - pd.b) * v) / ymax;
    let g = '';
    for (let k = 0; k <= 4; k++) { const v = (ymax * k) / 4; g += `<line x1="${pd.l}" x2="${W - pd.r}" y1="${y(v)}" y2="${y(v)}" class="gl"/><text x="${pd.l - 6}" y="${y(v) + 4}" text-anchor="end" class="ax">${short(Math.round(v))}</text>`; }
    const step = Math.ceil((n - 1) / 8);
    for (let i = 0; i < n; i += step) g += `<text x="${x(i)}" y="${H - 10}" text-anchor="middle" class="ax">${i}</text>`;
    g += `<line x1="${pd.l}" x2="${W - pd.r}" y1="${y(S.goalAmount)}" y2="${y(S.goalAmount)}" class="goal"/><text x="${W - pd.r}" y="${y(S.goalAmount) - 5}" text-anchor="end" class="gt">Goal ${short(S.goalAmount)}</text>`;
    g += `<line x1="${pd.l}" x2="${W - pd.r}" y1="${y(S.settings.money)}" y2="${y(S.settings.money)}" class="base"/>`;
    S.players.forEach((p, k) => {
      const h = hist[k]; if (!h) return;
      const pts = h.map((v, i) => `${x(i)},${y(v)}`).join(' ');
      g += `<polyline points="${pts}" fill="none" stroke="${COLORS[k % 6]}" stroke-width="${p.me ? 3.6 : 2.4}" stroke-linejoin="round"/><circle cx="${x(h.length - 1)}" cy="${y(h[h.length - 1])}" r="4.5" fill="${COLORS[k % 6]}"/>`;
    });
    const legend = S.players.map((p, k) => { const net = p.money - S.settings.money; return `<li><i style="background:${COLORS[k % 6]}"></i><b>${esc(p.name)}</b> ${fmt(p.money)} <span class="${net > 0 ? 'up' : net < 0 ? 'dn' : ''}">${sgn(net)}</span></li>`; }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Chips per round for each player">${g}<text x="${(W + pd.l) / 2}" y="${H - 0}" text-anchor="middle" class="ax">Round</text></svg><ul class="legend">${legend}</ul>`;
  }

  // ---------- final ----------
  function renderFinal() {
    const order = [...S.players].sort((a, b) => a.rank - b.rank);
    $('finalTitle').textContent = `${order[0].name} wins!`;
    $('finalSub').textContent = `Goal was ${fmt(S.goalAmount)} · ${S.round} rounds played`;
    $('standings').innerHTML = order.map((p) => {
      const net = p.money - S.settings.money;
      return `<li class="r${p.rank}${p.me ? ' me' : ''}"><span class="rk">${ord(p.rank)}</span><span class="nm">${esc(p.name)}${p.me ? ' (you)' : ''}<em>${esc(p.reason)}</em></span><span class="ch">${fmt(p.money)}<small class="${net > 0 ? 'up' : net < 0 ? 'dn' : ''}">${sgn(net)}</small></span></li>`;
    }).join('');
    $('finalChart').innerHTML = chartHTML();
    $('rematchBtn').hidden = !S.host; $('rematchWait').hidden = S.host;
  }

  // ---------- state ----------
  const cardCount = (s) => s.dealer.cards.length + s.players.reduce((a, p) => a + p.hands.reduce((b, h) => b + h.cards.length, 0), 0);
  function sounds(s, p) {
    if (!p || s.round !== p.round) return;
    const m = s.players.find((x) => x.me), pm = p.players.find((x) => x.me);
    if (cardCount(s) > cardCount(p)) sfx(m && pm && m.hands.length > pm.hands.length ? 'split' : 'deal');
    if (p.dealer.hidden && !s.dealer.hidden) sfx('flip');
    if (m && pm) {
      if (m.turn && (!pm.turn || pm.turnHand !== m.turnHand)) sfx('turn');
      if (m.hands.some((h, i) => h.status === 'bust' && pm.hands[i] && pm.hands[i].status !== 'bust')) setTimeout(() => sfx('bust'), 150);
    }
    if (s.phase === 'results' && p.phase !== 'results' && m && m.hands.length) {
      sfx(m.hands.some((h) => h.result === 'BLACKJACK') ? 'blackjack' : m.roundDelta > 0 ? 'win' : m.roundDelta < 0 ? 'lose' : 'push');
    }
  }
  socket.on('state', (s) => {
    offset = s.now - Date.now();
    const first = !S;
    P = S; S = s;
    if (S.phase === 'betting' && (!P || P.phase !== 'betting')) { seen = new Set(); myBet = 0; }
    quiet = first || (P && P.round !== S.round && S.phase !== 'betting' && S.phase !== 'dealing');
    if (!first) sounds(S, P);
    if (S.phase === 'final' && P && P.phase !== 'final') sfx('final');
    if (S.phase === 'lobby') { $('final').hidden = true; show('lobby'); renderLobby(); return; }
    show('table'); renderTable();
    if (S.phase === 'final') { renderFinal(); $('final').hidden = false; } else $('final').hidden = true;
  });

  // ---------- actions ----------
  $('chips').innerHTML = CHIPS.map((v) => `<button class="chip" data-v="${v}" aria-label="Add ${fmt(v)}">${short(v)}</button>`).join('');
  $('chips').onclick = (e) => {
    const c = e.target.closest('.chip'); if (!c || !S) return;
    myBet = Math.min(myBet + +c.dataset.v, me().money); sfx('chip'); renderDock();
  };
  $('clearBet').onclick = () => { myBet = 0; sfx('click'); renderDock(); };
  $('allIn').onclick = () => { myBet = me().money; sfx('chip'); renderDock(); };
  $('rebet').onclick = () => { myBet = Math.min(lastBet, me().money); sfx('chip'); renderDock(); };
  $('dealBtn').onclick = () => {
    const m = me();
    if (m.ready) return socket.emit('bet', { amount: m.bet, ready: false });
    lastBet = myBet; sfx('chip');
    socket.emit('bet', { amount: myBet, ready: true });
  };
  $('hitBtn').onclick = () => socket.emit('hit');
  $('standBtn').onclick = () => socket.emit('stand');
  $('dblBtn').onclick = () => socket.emit('double');
  $('splBtn').onclick = () => socket.emit('split');
  $('insYes').onclick = () => { sfx('chip'); socket.emit('insure', { take: true }); };
  $('insNo').onclick = () => socket.emit('insure', { take: false });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.modal:not(.final)').forEach((m) => (m.hidden = true));
    if (!S || e.target.tagName === 'INPUT') return;
    const k = e.key.toLowerCase(), m = me();
    if (S.phase === 'playing' && m && m.turn && m.can) {
      if (k === 'h') $('hitBtn').click(); else if (k === 's') $('standBtn').click();
      else if (k === 'd' && m.can.double) $('dblBtn').click(); else if (k === 'p' && m.can.split) $('splBtn').click();
    } else if (S.phase === 'betting' && k === 'enter' && !$('dealBtn').disabled) $('dealBtn').click();
  });

  // countdown bar
  setInterval(() => {
    const f = $('timerFill');
    if (!S || !S.deadline || !S.deadlineTotal) { f.style.width = '0'; return; }
    const left = Math.max(0, S.deadline - (Date.now() + offset));
    f.style.width = Math.min(100, (left / S.deadlineTotal) * 100) + '%';
    f.style.background = left < 6000 ? '#ef4444' : '#f59e0b';
  }, 100);
})();
