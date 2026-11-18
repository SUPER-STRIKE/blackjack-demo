(() => {
  const $ = (id) => document.getElementById(id);
  const socket = io();
  const CHIPS = [10, 25, 50, 100, 500, 1000, 5000];
  const MIN_BET = 10;
  const fmt = (n) => '$' + Math.round(n).toLocaleString('en-US');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let S = null;            // latest state
  let offset = 0;          // server clock - client clock
  let myBet = 0, lastBet = 0;
  let seen = new Set();    // card keys already animated
  let prevPhase = null, prevRound = null;
  let decks = 6;

  // ---------- session ----------
  const save = (token, code) => { try { sessionStorage.setItem('bj', JSON.stringify({ token, code })); } catch {} };
  const load = () => { try { return JSON.parse(sessionStorage.getItem('bj')); } catch { return null; } };
  const clear = () => { try { sessionStorage.removeItem('bj'); } catch {} };

  function show(id) {
    for (const s of ['home', 'lobby', 'table']) $(s).hidden = s !== id;
  }
  let toastT;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600);
  }
  socket.on('toast', toast);

  // ---------- home ----------
  try { $('name').value = localStorage.getItem('bjname') || ''; } catch {}
  const qs = new URLSearchParams(location.search);
  function tab(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $('tab-host').hidden = name !== 'host';
    $('tab-join').hidden = name !== 'join';
  }
  document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => tab(t.dataset.tab)));
  if (qs.get('room')) { tab('join'); $('code').value = qs.get('room').toUpperCase().slice(0, 4); }

  const deckPick = $('deckPick');
  for (let i = 1; i <= 6; i++) {
    const b = document.createElement('button'); b.textContent = i;
    b.onclick = () => { decks = i; paintDecks(); };
    deckPick.appendChild(b);
  }
  function paintDecks() { [...deckPick.children].forEach((b, i) => b.classList.toggle('on', i + 1 === decks)); }
  paintDecks();
  [500, 1000, 5000, 10000, 100000].forEach((v) => {
    const b = document.createElement('button'); b.textContent = fmt(v);
    b.onclick = () => { $('money').value = v; paintMoney(); };
    $('moneyPresets').appendChild(b);
  });
  function paintMoney() { [...$('moneyPresets').children].forEach((b) => b.classList.toggle('on', b.textContent === fmt(+$('money').value))); }
  $('money').oninput = paintMoney; paintMoney();

  const name = () => { const n = $('name').value.trim(); try { localStorage.setItem('bjname', n); } catch {} return n; };
  const homeErr = (m) => ($('homeErr').textContent = m || '');

  $('createBtn').onclick = () => {
    if (!name()) return homeErr('Please enter your name');
    const money = parseInt($('money').value, 10);
    if (!(money >= 100)) return homeErr('Starting chips must be at least $100');
    socket.emit('create', { name: name(), decks, money }, (r) => {
      if (!r.ok) return homeErr(r.error); homeErr(''); save(r.token, r.code);
    });
  };
  $('joinBtn').onclick = () => {
    if (!name()) return homeErr('Please enter your name');
    const code = $('code').value.trim().toUpperCase();
    if (code.length !== 4) return homeErr('Enter the 4-letter room code');
    socket.emit('join', { name: name(), code }, (r) => {
      if (!r.ok) return homeErr(r.error); homeErr(''); save(r.token, r.code);
    });
  };
  [$('name'), $('code'), $('money')].forEach((i) => i.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') ($('tab-host').hidden ? $('joinBtn') : $('createBtn')).click();
  }));

  // resume session after refresh / reconnect
  function tryResume() {
    const s = load(); if (!s) return;
    socket.emit('resume', s, (r) => { if (!r.ok) { clear(); S = null; show('home'); } });
  }
  socket.on('connect', tryResume);
  socket.on('disconnect', () => toast('Connection lost - reconnecting…'));

  // ---------- lobby ----------
  function leave() { socket.emit('leave'); clear(); S = null; show('home'); }
  $('lobbyLeave').onclick = leave; $('leaveBtn').onclick = () => confirm('Leave the table?') && leave();
  $('startBtn').onclick = () => socket.emit('start');
  const link = () => `${location.origin}/?room=${S.code}`;
  const copy = async (t, m) => { try { await navigator.clipboard.writeText(t); toast(m); } catch { prompt('Copy this:', t); } };
  $('copyCode').onclick = () => copy(S.code, 'Code copied');
  $('copyLink').onclick = () => copy(link(), 'Invite link copied');

  function renderLobby() {
    $('lobbyCode').textContent = S.code;
    $('lobbySettings').innerHTML = `<span class="pill">🂠 ${S.settings.decks} deck${S.settings.decks > 1 ? 's' : ''}</span><span class="pill">💰 ${fmt(S.settings.money)} each</span><span class="pill">${S.players.length}/4 players</span>`;
    let h = S.players.map((p) => `<li><span>${esc(p.name)}${p.me ? ' (you)' : ''}</span>${p.isHost ? '<span class="crown">👑 HOST</span>' : ''}</li>`).join('');
    for (let i = S.players.length; i < 4; i++) h += '<li class="empty"><span>Open seat…</span></li>';
    $('lobbyPlayers').innerHTML = h;
    $('startBtn').hidden = !S.host; $('lobbyWait').hidden = S.host;
  }

  // ---------- cards ----------
  const L=28,R=72,C=50;
  const PIPS={
    '2':[[C,16],[C,84]],'3':[[C,16],[C,50],[C,84]],
    '4':[[L,16],[R,16],[L,84],[R,84]],'5':[[L,16],[R,16],[C,50],[L,84],[R,84]],
    '6':[[L,16],[R,16],[L,50],[R,50],[L,84],[R,84]],'7':[[L,16],[R,16],[C,33],[L,50],[R,50],[L,84],[R,84]],
    '8':[[L,16],[R,16],[C,33],[L,50],[R,50],[C,67],[L,84],[R,84]],
    '9':[[L,16],[R,16],[L,38],[R,38],[C,50],[L,62],[R,62],[L,84],[R,84]],
    '10':[[L,16],[R,16],[C,27],[L,38],[R,38],[L,62],[R,62],[C,73],[L,84],[R,84]]};
  function face(c){
    if(c.r==='A') return '<span class="pip ace" style="left:50%;top:50%">'+c.s+'</span>';
    if('JQK'.includes(c.r)) return '<div class="court"><b>'+c.r+'</b><span class="cs t">'+c.s+'</span><span class="cs b">'+c.s+'</span></div>';
    return PIPS[c.r].map(([x,y])=>'<span class="pip'+(y>50?' flip':'')+'" style="left:'+x+'%;top:'+y+'%">'+c.s+'</span>').join('');
  }
  function cardHTML(c, key, delay) {
    const anim = !seen.has(key);
    if (anim) seen.add(key);
    const cls = 'card' + (anim ? ' deal' : '');
    const st = anim ? ' style="animation-delay:'+delay+'ms"' : '';
    if (!c) return '<div class="'+cls+' back"'+st+'><i></i></div>';
    const red = c.s === '♥' || c.s === '♦' ? ' red' : '';
    return '<div class="'+cls+red+'"'+st+'><div class="idx"><span>'+c.r+'</span><span>'+c.s+'</span></div><div class="face">'+face(c)+'</div><div class="idx br"><span>'+c.r+'</span><span>'+c.s+'</span></div></div>';
  }
  const handHTML = (cards, id) => {
    let n = 0;
    return cards.map((c, i) => cardHTML(c, `${id}-${i}-${c ? 'f' : 'b'}`, (n++) * 120)).join('');
  };

  // ---------- table ----------
  const me = () => S.players.find((p) => p.me);
  function badge(p) {
    if (p.result) {
      const d = p.delta;
      const txt = p.result === 'BLACKJACK' ? 'BLACKJACK' : p.result;
      return `<span class="badge ${p.result.toLowerCase()}">${txt} ${d > 0 ? '+' + fmt(d) : d < 0 ? '-' + fmt(-d) : ''}</span>`;
    }
    if (p.status === 'bust') return '<span class="badge bust">BUST</span>';
    if (p.status === 'blackjack') return '<span class="badge blackjack">BLACKJACK</span>';
    if (p.status === 'standing') return '<span class="badge">STAND</span>';
    return '';
  }
  function betLabel(p) {
    if (S.phase === 'betting') {
      if (p.status === 'sitout') return '<span class="sbet">Sitting out</span>';
      if (p.status === 'broke') return '<span class="sbet">Out of chips</span>';
      return p.ready ? `<span class="sbet ready">✔ ${fmt(p.bet)}</span>` : '<span class="sbet">Betting…</span>';
    }
    if (p.bet && !['sitout', 'broke', 'waiting'].includes(p.status)) return `<span class="sbet ready">${fmt(p.bet * (p.doubled ? 2 : 1))}${p.doubled ? ' (2x)' : ''}</span>`;
    return '<span class="sbet">&nbsp;</span>';
  }
  const DEN=[5000,1000,500,100,50,25,10];
  function stack(amount){
    let left=amount,chips=[];
    for(const d of DEN){ while(left>=d&&chips.length<14){chips.push(d);left-=d;} }
    chips.reverse(); // big at bottom
    return chips.map((v,i)=>'<i class="sc" data-v="'+v+'" style="bottom:'+(i*5)+'px"></i>').join('');
  }
  function renderSeats() {
    let h = '';
    S.players.forEach((p, idx) => {
      const out = ['sitout', 'broke', 'waiting'].includes(p.status) && S.phase !== 'betting';
      const amt = S.phase === 'betting' ? (p.ready ? p.bet : 0) : (p.bet && !['sitout','broke','waiting'].includes(p.status) ? p.bet * (p.doubled ? 2 : 1) : 0);
      h += '<div class="seat '+(p.me?'me':'')+' '+(p.turn?'turn':'')+' '+(out?'out':'')+'">'+
        '<div class="hand">'+handHTML(p.cards,'p'+idx+'-'+S.round)+'</div>'+
        '<div class="mid">'+(p.cards.length?'<span class="score">'+p.value+'</span>':'')+badge(p)+'</div>'+
        '<div class="spot">'+stack(amt)+(amt?'<em>'+fmt(amt)+(p.doubled?' ×2':'')+'</em>':'')+'</div>'+
        '<div class="plate"><div class="sname">'+(p.connected?'':'<i class="off" title="Disconnected"></i>')+(p.isHost?'♛ ':'')+esc(p.name)+(p.me?' (you)':'')+'</div>'+
        '<div class="smoney">'+fmt(p.money)+(S.phase==='betting'&&p.status==='betting'&&!p.ready?' · betting…':'')+(S.phase==='betting'&&p.status==='sitout'?' · sitting out':'')+(p.status==='broke'?' · out of chips':'')+'</div></div></div>';
    });
    for (let i = S.players.length; i < 4; i++) h += '<div class="seat empty"><div class="spot"></div><div class="plate"><div class="sname">Open seat</div></div></div>';
    $('seats').innerHTML = h;
  }

  function renderDock() {
    const m = me();
    $('myMoney').textContent = fmt(m.money);
    const betting = S.phase === 'betting' && m.status === 'betting';
    const myTurn = S.phase === 'playing' && m.turn && m.status === 'playing';
    $('betPanel').hidden = !betting;
    $('actPanel').hidden = !myTurn;
    const showBet = betting ? (m.ready ? m.bet : myBet) : m.bet * (m.doubled ? 2 : 1);
    $('myBet').textContent = fmt(showBet);
    let info = '';
    if (S.phase === 'betting' && m.status === 'sitout') info = 'Sitting out this round';
    else if (S.phase === 'betting' && m.status === 'broke') info = 'You are out of chips';
    else if (S.phase === 'playing' && !myTurn) {
      const t = S.players.find((p) => p.turn);
      info = m.status === 'playing' ? `Waiting for ${t ? esc(t.name) : 'others'}…` : ['sitout', 'broke', 'waiting'].includes(m.status) ? 'Spectating – you join next round' : 'Waiting for other players…';
    } else if (S.phase === 'dealer') info = 'Dealer is playing…';
    else if (S.phase === 'results') info = m.result ? `${m.result}${m.delta ? ' ' + (m.delta > 0 ? '+' : '-') + fmt(Math.abs(m.delta)) : ''} · next round starting…` : 'Next round starting…';
    $('infoPanel').hidden = betting || myTurn || !info;
    $('infoPanel').innerHTML = info;
    $('rebuyBtn').hidden = !(m.money < MIN_BET && !['playing', 'standing', 'bust', 'blackjack'].includes(m.status));
    $('rebuyBtn').textContent = `Rebuy ${fmt(S.settings.money)}`;

    if (betting) {
      if (!m.ready) myBet = Math.min(myBet, m.money);
      document.querySelectorAll('.chip').forEach((c) => (c.disabled = m.ready || myBet + +c.dataset.v > m.money));
      $('dealBtn').textContent = m.ready ? 'Ready ✔ – tap to change bet' : myBet >= MIN_BET ? `Place bet ${fmt(myBet)}` : `Bet at least ${fmt(MIN_BET)}`;
      $('dealBtn').disabled = !m.ready && myBet < MIN_BET;
      $('clearBet').disabled = $('allIn').disabled = m.ready;
      $('rebet').disabled = m.ready || !lastBet || lastBet > m.money;
      $('sitOut').disabled = m.ready;
    }
    if (myTurn) {
      $('dblBtn').disabled = !(m.cards.length === 2 && m.money >= m.bet);
    }
  }

  function renderTable() {
    $('tCode').textContent = S.code;
    $('tDecks').textContent = `${S.settings.decks} deck${S.settings.decks > 1 ? 's' : ''} · ${fmt(S.settings.money)}`;
    const pct = (S.shoeLeft / S.shoeTotal) * 100;
    $('shoeBar').style.width = pct + '%';
    $('shoeTxt').textContent = `${S.shoeLeft} / ${S.shoeTotal} cards`;
    $('dHand').innerHTML = handHTML(S.dealer.cards, 'd' + S.round);
    $('dScore').textContent = S.dealer.cards.length ? S.dealer.value + (S.dealer.hidden ? '+?' : '') : '';
    $('banner').textContent = S.phase === 'betting' ? (S.msg || 'Place your bets') : S.phase === 'dealer' ? 'Dealer plays' : S.msg;
    renderSeats(); renderDock();
    $('logList').innerHTML = [...S.log].reverse().map((l) => `<li>${esc(l)}</li>`).join('');
  }

  // ---------- state ----------
  socket.on('state', (s) => {
    offset = s.now - Date.now();
    S = s;
    if (S.phase === 'betting' && prevPhase !== 'betting') { seen = new Set(); myBet = 0; }
    if (S.phase === 'betting' && prevPhase === 'betting') { /* keep local bet */ }
    prevPhase = S.phase;
    if (S.phase === 'lobby') { show('lobby'); renderLobby(); return; }
    show('table'); renderTable();
  });

  // ---------- actions ----------
  const mk = () => { $('chips').innerHTML = CHIPS.map((v) => `<button class="chip" data-v="${v}">${v >= 1000 ? v / 1000 + 'k' : v}</button>`).join(''); };
  mk();
  $('chips').onclick = (e) => {
    const c = e.target.closest('.chip'); if (!c || !S) return;
    myBet = Math.min(myBet + +c.dataset.v, me().money); renderDock();
  };
  $('clearBet').onclick = () => { myBet = 0; renderDock(); };
  $('allIn').onclick = () => { myBet = me().money; renderDock(); };
  $('rebet').onclick = () => { myBet = Math.min(lastBet, me().money); renderDock(); };
  $('sitOut').onclick = () => socket.emit('bet', { amount: 0, ready: true, sitout: true });
  $('dealBtn').onclick = () => {
    const m = me();
    if (m.ready) return socket.emit('bet', { amount: m.bet, ready: false });
    lastBet = myBet;
    socket.emit('bet', { amount: myBet, ready: true });
  };
  $('hitBtn').onclick = () => socket.emit('hit');
  $('standBtn').onclick = () => socket.emit('stand');
  $('dblBtn').onclick = () => socket.emit('double');
  $('rebuyBtn').onclick = () => socket.emit('rebuy');
  $('logBtn').onclick = () => ($('logModal').hidden = false);
  $('logClose').onclick = () => ($('logModal').hidden = true);
  document.addEventListener('keydown', (e) => {
    if (!S || e.target.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if (S.phase === 'playing' && me()?.turn) {
      if (k === 'h') $('hitBtn').click(); else if (k === 's') $('standBtn').click(); else if (k === 'd' && !$('dblBtn').disabled) $('dblBtn').click();
    } else if (S.phase === 'betting' && k === 'enter' && !$('dealBtn').disabled) $('dealBtn').click();
  });

  // countdown bar
  setInterval(() => {
    const f = $('timerFill');
    if (!S || !S.deadline || S.phase === 'lobby') { f.style.width = '0'; return; }
    const total = S.phase === 'betting' ? 25000 : S.phase === 'results' ? 8000 : 25000;
    const left = Math.max(0, S.deadline - (Date.now() + offset));
    f.style.width = Math.min(100, (left / total) * 100) + '%';
    f.style.background = left < 6000 ? '#ef4444' : '#f59e0b';
  }, 100);
})();
