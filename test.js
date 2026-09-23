#!/usr/bin/env node
/* Pocket Aces self test. No dependencies.
   Pulls the page script out of index.html, runs it against a DOM stub,
   and asserts the logic worth guarding: clock carry, seat rotation,
   validation, prize math, persistence flow. Run: node test.js */
'use strict';

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const match = html.match(/<script>([\s\S]*)<\/script>/);
if (!match) { console.error('FAIL harness: no script block in index.html'); process.exit(1); }

/* ── DOM stubs ── */
function makeEl(id) {
  const el = {
    id, innerHTML: '', textContent: '', value: '', className: '',
    children: [], style: {}, dataset: {}, onclick: null, _handlers: {},
    _classes: new Set(),
    classList: {
      add: (...c) => c.forEach(x => el._classes.add(x)),
      remove: (...c) => c.forEach(x => el._classes.delete(x)),
      toggle: (c, force) => {
        const has = el._classes.has(c);
        const want = force === undefined ? !has : !!force;
        if (want) el._classes.add(c); else el._classes.delete(c);
        return want;
      },
      contains: c => el._classes.has(c),
    },
    addEventListener(type, fn) { (el._handlers[type] = el._handlers[type] || []).push(fn); },
    removeEventListener() {},
    appendChild(c) { el.children.push(c); return c; },
    remove() {},
    querySelector() { return makeEl(id + '>' + Math.random()); },
    querySelectorAll() { return []; },
    scrollIntoView() {},
  };
  return el;
}

const elements = {};
const alerts = [];
const store = {};
const audioStub = () => new Proxy(function () {}, {
  get(t, p) {
    if (p === 'sampleRate') return 44100;
    if (p === 'state') return 'running';
    if (p === 'length') return 0;
    if (p === Symbol.toPrimitive) return () => 0;
    return audioStub();
  },
  apply() { return audioStub(); },
  construct() { return audioStub(); },
  set() { return true; },
});

global.document = {
  getElementById(id) { return elements[id] || (elements[id] = makeEl(id)); },
  createElement() { return makeEl('created'); },
  addEventListener() {},
  activeElement: null,
  body: makeEl('body'),
};
global.window = {
  AudioContext: function () { return audioStub(); },
  addEventListener() {},
};
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};
global.alert = m => alerts.push(String(m));
global.confirm = () => true;

/* ── Tiny assert kit ── */
let pass = 0, fail = 0;
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || '') + ' expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ': ' + e.message); }
}

/* ── Load the page script ── */
new Function(match[1])();
const poker = global.window.__poker;

/* ── State factory ── */
function baseState(overrides) {
  const players = (overrides && overrides.players) || [
    { name: 'P1', active: true, rebuys: 0 },
    { name: 'P2', active: true, rebuys: 0 },
    { name: 'P3', active: true, rebuys: 0 },
  ];
  return Object.assign({
    phase: 'paused',
    currentLevel: 0,
    timeRemaining: 900,
    config: {
      chips: [{ id: 'white', label: 'White', css: '#fff', lightText: false, count: 100, value: 25, start: 8, rebuy: 4 }],
      buyin: 300, rebuyAmount: 150, maxRebuys: 1, rebuyWindow: 4, payout: [60, 30, 10],
    },
    players,
    lastTick: Date.now(),
    totalRebuys: 0,
    seatOrder: players.map((_, i) => i),
    dealerSeat: 0,
    direction: 'clockwise',
  }, overrides);
}

/* ── Time formatting ── */
test('formatTime basics', () => {
  const f = poker.fn.formatTime;
  assertEq(f(0), '00:00');
  assertEq(f(60), '01:00');
  assertEq(f(75), '01:15');
  assertEq(f(900), '15:00');
  assertEq(f(-5), '00:00', 'negative clamps');
});
test('formatChips abbreviates thousands', () => {
  const f = poker.fn.formatChips;
  assertEq(f(250), '250');
  assertEq(f(999), '999');
  assertEq(f(1000), '1k');
  assertEq(f(1500), '1.5k');
});

/* ── Seat rotation ── */
test('getNextActiveSeat rotates clockwise and skips eliminated', () => {
  const s = baseState();
  const next = poker.fn.getNextActiveSeat;
  assertEq(next(s, s.dealerSeat), 1, 'all active, clockwise from 0');
  s.players[1].active = false;
  assertEq(next(s, s.dealerSeat), 2, 'eliminated seat skipped');
  assertEq(next(s, 2), 0, 'wraps to first active');
  s.direction = 'anticlockwise';
  s.players[1].active = true;
  assertEq(next(s, s.dealerSeat), 2, 'anticlockwise from 0');
});

/* ── Config validation ── */
test('validateConfig accepts a sound config', () => {
  const cfg = baseState().config;
  cfg.players = baseState().players;
  assertEq(poker.fn.validateConfig(cfg), null);
});
test('validateConfig rejects fewer than 2 players', () => {
  const cfg = baseState().config;
  cfg.players = [{ name: 'Solo', active: true, rebuys: 0 }];
  assert(/2 players/.test(poker.fn.validateConfig(cfg)), 'mentions player minimum');
});
test('validateConfig rejects payouts not totalling 100', () => {
  const cfg = baseState().config;
  cfg.players = baseState().players;
  cfg.payout = [60, 30, 5];
  assert(/100%/.test(poker.fn.validateConfig(cfg)), 'mentions 100%');
});
test('validateConfig rejects insufficient chips', () => {
  const cfg = baseState().config;
  cfg.players = baseState().players;
  cfg.chips[0].start = 50;
  cfg.chips[0].count = 100;
  assert(/Not enough/.test(poker.fn.validateConfig(cfg)), 'names the shortfall');
});

/* ── Clock reconciliation (catch-up path) ── */
test('reconcileTime carries remainder across two levels', () => {
  const elapsed = 1850; // 5 min left on L1, 30m50s away
  const s = baseState({ phase: 'running', currentLevel: 0, timeRemaining: 300 });
  s.lastTick = Date.now() - elapsed * 1000 - 500;
  const out = poker.fn.reconcileTime(s);
  assertEq(out.currentLevel, 2, 'lands on level index 2');
  assertEq(out.timeRemaining, 250, 'carries the overshoot');
});
test('reconcileTime clamps at the final level', () => {
  const last = 15;
  const s = baseState({ phase: 'running', currentLevel: last, timeRemaining: 100 });
  s.lastTick = Date.now() - 500 * 1000 - 500;
  const out = poker.fn.reconcileTime(s);
  assertEq(out.currentLevel, last, 'stays on last level');
  assertEq(out.timeRemaining, 0, 'clamps to zero');
});
test('reconcileTime leaves paused state untouched', () => {
  const s = baseState({ phase: 'paused', currentLevel: 3, timeRemaining: 42 });
  s.lastTick = Date.now() - 999 * 1000;
  const out = poker.fn.reconcileTime(s);
  assertEq(out.currentLevel, 3);
  assertEq(out.timeRemaining, 42);
});

/* ── Prize pool ── */
test('prize pool is buyins plus paid rebuys', () => {
  poker.state = baseState({ totalRebuys: 2 });
  poker.fn.renderPrizePool();
  const expected = 'R' + (3 * 300 + 2 * 150).toLocaleString();
  assertEq(elements['prize-total'].textContent, expected);
});

/* ── Player actions ── */
test('rebuyPlayer brings a player back and counts the pot', () => {
  poker.state = baseState();
  poker.state.players[1].active = false;
  poker.fn.rebuyPlayer(1);
  assert(poker.state.players[1].active, 'active again');
  assertEq(poker.state.players[1].rebuys, 1);
  assertEq(poker.state.totalRebuys, 1);
});

/* ── Persistence flow ── */
test('resume banner appears for a saved game and resumes paused', () => {
  const saved = baseState({ phase: 'paused', currentLevel: 4 });
  store['poker-tournament-v1'] = JSON.stringify(saved);
  poker.fn.checkResume();
  assert(/Tournament in progress/.test(elements['resume-area'].innerHTML), 'banner rendered');
  document.getElementById('do-resume').onclick();
  assert(document.getElementById('setup').classList.contains('hidden'), 'setup hidden');
  assert(!document.getElementById('tournament').classList.contains('hidden'), 'tournament shown');
  assert(!document.getElementById('pause-overlay').classList.contains('hidden'), 'pause overlay shown for paused save');
});
test('no saved game means no banner', () => {
  delete store['poker-tournament-v1'];
  poker.fn.checkResume();
  assertEq(elements['resume-area'].innerHTML, '');
});

/* ── XSS hardening ── */
test('escapeHtml neutralises markup and attribute breakouts', () => {
  const e = poker.fn.escapeHtml;
  const payload = '<img src=x onerror="alert(1)">';
  const out = e(payload);
  assert(!/[<>"']/.test(out.replace(/&(?:amp|lt|gt|quot|#39);/g, '')), 'no raw specials survive');
  assert(out === '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;', 'full escape, got: ' + out);
  assertEq(e('O\'Brien & Sons <b>"x"</b>'), 'O&#39;Brien &amp; Sons &lt;b&gt;&quot;x&quot;&lt;/b&gt;');
});
test('renderPlayers renders hostile names inert', () => {
  poker.state = baseState();
  poker.state.players[0].name = '<img src=x onerror=window.__pwned=1>';
  poker.fn.renderPlayers();
  const html = elements['player-list'].innerHTML;
  assert(!html.includes('<img'), 'no raw img tag in player list');
  assert(html.includes('&lt;img'), 'name present but escaped');
});

/* ── Saved blob sanitisation ── */
test('sanitizeState accepts a well formed save', () => {
  const saved = baseState();
  const out = poker.fn.sanitizeState(JSON.parse(JSON.stringify(saved)));
  assert(out, 'valid blob survives');
  assertEq(out.currentLevel, 0);
  assertEq(out.seatOrder.length, 3);
});
test('sanitizeState keeps a valid seat permutation', () => {
  const s = baseState();
  s.seatOrder = [2, 0, 1];
  const out = poker.fn.sanitizeState(s);
  assertEq(out.seatOrder.join(','), '2,0,1');
});
test('sanitizeState rejects a hostile or corrupt shape', () => {
  const bad = mut => { const s = baseState(); mut(s); return poker.fn.sanitizeState(s); };
  assert(!bad(s => { s.phase = 'exploded'; }), 'bad phase');
  assert(!bad(s => { s.currentLevel = 99; }), 'out of range level');
  assert(!bad(s => { s.currentLevel = '0'; }), 'string level');
  assert(!bad(s => { s.players = 'all'; }), 'players not an array');
  assert(!bad(s => { s.players[0] = null; }), 'null player');
  assert(!bad(s => { s.players[0].name = 42; }), 'numeric name');
  assert(!bad(s => { s.config.payout = [60, 60, -20]; }), 'negative payout summing to 100');
  assert(!bad(s => { s.config.payout = [50, 30, 10]; }), 'payout summing to 90');
  assert(!bad(s => { s.config.buyin = 'free'; }), 'string buyin');
  assert(!bad(s => { s.lastTick = 'yesterday'; }), 'bad lastTick');
  assert(!bad(s => { s.timeRemaining = NaN; }), 'NaN time');
});
test('sanitizeState whitelists chip identity and rebuilds a broken seatOrder', () => {
  const s = baseState();
  s.config.chips[0].css = 'javascript:alert(1)';
  s.config.chips[0].label = '<b>x</b>';
  s.config.chips[0].count = -50;
  s.seatOrder = [2, 0];
  const out = poker.fn.sanitizeState(s);
  assertEq(out.config.chips[0].css, 'var(--chip-white)', 'css from whitelist');
  assertEq(out.config.chips[0].label, 'White', 'label from whitelist');
  assertEq(out.config.chips[0].count, 100, 'negative count reset to default');
  assertEq(out.seatOrder.join(','), '0,1,2', 'seatOrder rebuilt');
});

/* ── Corruption and save-failure handling ── */
test('corrupt save is cleared with a note, not thrown on', () => {
  store['poker-tournament-v1'] = '{not json';
  poker.fn.checkResume();
  assert(/corrupt/i.test(elements['resume-area'].innerHTML), 'note shown for unparseable json');
  assertEq(store['poker-tournament-v1'], undefined, 'key cleared');
  store['poker-tournament-v1'] = JSON.stringify({ phase: 'running', currentLevel: 999 });
  poker.fn.checkResume();
  assert(/corrupt/i.test(elements['resume-area'].innerHTML), 'shape failure treated as corrupt');
  assertEq(store['poker-tournament-v1'], undefined, 'cleared again');
});
test('save failure surfaces a warning', () => {
  poker.state = baseState();
  const original = global.localStorage.setItem;
  global.localStorage.setItem = () => { throw new Error('QuotaExceeded'); };
  poker.fn.saveState();
  global.localStorage.setItem = original;
  assert(!elements['storage-warning'].classList.contains('hidden'), 'warning visible');
  assert(/Could not save/.test(elements['storage-warning'].textContent), 'warning explains');
});

/* ── Config parsing and validation hardening ── */
test('parseIntField keeps zero, defaults on empty or junk', () => {
  const p = poker.fn.parseIntField;
  assertEq(p({ value: '0' }, 5), 0, 'zero is a value');
  assertEq(p({ value: '' }, 5), 5, 'empty falls back');
  assertEq(p({ value: 'abc' }, 5), 5, 'junk falls back');
  assertEq(p({ value: ' 12 ' }, 5), 12);
  assertEq(p({ value: '-3' }, 5), -3, 'sign preserved for validation to catch');
});
test('readConfig falls back per field and keeps zeros', () => {
  const byId = id => document.getElementById(id);
  byId('cfg-buyin').value = '';
  byId('cfg-rebuy').value = '';
  byId('cfg-max-rebuys').value = '0';
  byId('cfg-rebuy-window').value = '8';
  byId('cfg-payout-1').value = '60';
  byId('cfg-payout-2').value = '30';
  byId('cfg-payout-3').value = '10';
  const cfg = poker.fn.readConfig();
  assertEq(cfg.buyin, 300, 'empty buyin defaults');
  assertEq(cfg.rebuyAmount, 150, 'empty rebuy defaults');
  assertEq(cfg.maxRebuys, 0, 'zero max rebuys stays zero');
  assertEq(cfg.rebuyWindow, 8);
  assertEq(cfg.payout.join(','), '60,30,10', 'no NaN leaks into payout');
});
test('validateConfig rejects negatives and too few players for paid places', () => {
  const good = () => {
    const s = baseState();
    s.config.players = s.players;
    return s.config;
  };
  const cfg1 = good();
  cfg1.buyin = -300;
  assert(/whole numbers/.test(poker.fn.validateConfig(cfg1)), 'negative buyin');
  const cfg2 = good();
  cfg2.payout = [60, 60, -20];
  assert(/whole numbers/.test(poker.fn.validateConfig(cfg2)), 'negative payout place');
  const cfg3 = good();
  cfg3.payout = [50, 30, 10];
  assert(/100%/.test(poker.fn.validateConfig(cfg3)), 'sum 90 still caught');
  const cfg4 = good();
  cfg4.players = [{ name: 'A', active: true, rebuys: 0 }, { name: 'B', active: true, rebuys: 0 }];
  assert(/need at least 3/.test(poker.fn.validateConfig(cfg4)), '2 players cannot fill 3 paid places');
  const cfg5 = good();
  cfg5.maxRebuys = 0;
  assertEq(poker.fn.validateConfig(cfg5), null, 'zero max rebuys is valid');
});

/* ── Player interaction guards ── */
test('last player standing cannot be eliminated', () => {
  poker.state = baseState();
  poker.state.players[0].active = false;
  poker.state.players[2].active = false;
  poker.fn.eliminatePlayer(1);
  assert(poker.state.players[1].active, 'guard held');
  assertEq(alerts.length, 0, 'no win alert fired either');
});
test('eliminate button hidden on the last player, shown otherwise', () => {
  poker.state = baseState();
  poker.fn.renderPlayers();
  assert(elements['player-list'].innerHTML.includes('data-action="elim"'), 'three active, button present');
  assert(!elements['player-list'].innerHTML.includes('onclick='), 'no inline handlers');
  poker.state.players[1].active = false;
  poker.state.players[2].active = false;
  poker.fn.renderPlayers();
  assert(!elements['player-list'].innerHTML.includes('data-action="elim"'), 'one active, button gone');
});
test('eliminated dealer still names the seat', () => {
  poker.state = baseState();
  poker.state.dealerSeat = 1;
  poker.state.players[1].active = false;
  poker.fn.renderPlayers();
  assert(/\(eliminated\)/.test(elements['dealer-name'].textContent), 'dealer line marks the seat, got: ' + elements['dealer-name'].textContent);
});

/* ── Clock: tick and resume must agree ── */
test('tick and reconcileTime agree on a big catch up', () => {
  const elapsed = 1850; // 5 min left on L1, 30m50s away
  const a = baseState({ phase: 'running', currentLevel: 0, timeRemaining: 300 });
  a.lastTick = Date.now() - elapsed * 1000 - 500;
  const rec = poker.fn.reconcileTime(a);
  const b = baseState({ phase: 'running', currentLevel: 0, timeRemaining: 300 });
  b.lastTick = Date.now() - elapsed * 1000 - 500;
  poker.state = b;
  poker.fn.tick();
  assertEq(poker.state.currentLevel, rec.currentLevel, 'same level');
  assertEq(poker.state.timeRemaining, rec.timeRemaining, 'same remaining');
  assertEq(poker.state.dealerSeat, rec.dealerSeat, 'same dealer');
  assertEq(poker.state.currentLevel, 2, 'lands on level index 2');
  assertEq(poker.state.timeRemaining, 250, 'carries the overshoot');
  assertEq(poker.state.dealerSeat, 2, 'dealer turned twice');
});
test('tick ends the tournament when the last level expires', () => {
  const s = baseState({ phase: 'running', currentLevel: 15, timeRemaining: 100 });
  s.lastTick = Date.now() - 150 * 1000 - 500;
  poker.state = s;
  poker.fn.tick();
  assertEq(poker.state.phase, 'finished');
  assertEq(poker.state.timeRemaining, 0);
});
test('finished banner names the survivors', () => {
  const s = baseState({ phase: 'finished' });
  s.players[0].active = false;
  poker.state = s;
  poker.fn.renderTournament();
  assert(!elements['finished-banner'].classList.contains('hidden'), 'banner visible');
  assert(/P2, P3/.test(elements['finished-banner'].innerHTML), 'names survivors');
  const running = baseState();
  poker.state = running;
  poker.fn.renderTournament();
  assert(elements['finished-banner'].classList.contains('hidden'), 'hidden while running');
});
test('playingLevelNumber counts only real levels', () => {
  const f = poker.fn.playingLevelNumber;
  assertEq(f(0), 1);
  assertEq(f(3), 4);
  assertEq(f(4), 4, 'break adds nothing');
  assertEq(f(5), 5);
  assertEq(poker.fn.totalPlayingLevels(), 14);
});

/* ── Prize math ── */
test('computePrizes sums exactly to the pool with remainder to first', () => {
  const f = poker.fn.computePrizes;
  assertEq(f(1499, [50, 30, 20]).join(','), '749,450,300', 'rounding overrun lands on first');
  assertEq(f(1001, [60, 30, 10]).join(','), '601,300,100', 'rounding underrun lands on first');
  for (const pool of [0, 7, 997, 1500, 12345]) {
    for (const split of [[60, 30, 10], [50, 30, 20], [100, 0, 0], [34, 33, 33]]) {
      const amt = f(pool, split);
      assertEq(amt.reduce((a, b) => a + b, 0), pool, `split of ${pool} with ${split}`);
    }
  }
});
test('prize breakdown caps places at the player count', () => {
  poker.state = baseState({ players: [{ name: 'A', active: true, rebuys: 0 }, { name: 'B', active: true, rebuys: 0 }] });
  poker.fn.renderPrizePool();
  const rows2 = (elements['prize-breakdown'].innerHTML.match(/prize-place/g) || []).length;
  assertEq(rows2, 2, 'no third place row for two players');
  poker.state = baseState();
  poker.fn.renderPrizePool();
  const rows3 = (elements['prize-breakdown'].innerHTML.match(/prize-place/g) || []).length;
  assertEq(rows3, 3, 'three rows for three players');
});
test('validation catches a paid place beyond the roster', () => {
  const good = () => {
    const s = baseState();
    s.config.players = s.players;
    return s.config;
  };
  const sparse = good();
  sparse.players = [{ name: 'A', active: true, rebuys: 0 }, { name: 'B', active: true, rebuys: 0 }];
  sparse.payout = [0, 50, 50];
  assert(/need at least 3/.test(poker.fn.validateConfig(sparse)), 'place 3 pays with 2 players');
  const tail = good();
  tail.players = [{ name: 'A', active: true, rebuys: 0 }, { name: 'B', active: true, rebuys: 0 }];
  tail.payout = [60, 40, 0];
  assertEq(poker.fn.validateConfig(tail), null, 'zero third place is fine');
});

/* ── Win alert (async via setTimeout) ── */
(async () => {
  await new Promise(r => setTimeout(r, 50));
  poker.state = baseState({ players: [{ name: 'Ana', active: true, rebuys: 0 }, { name: 'Ben', active: true, rebuys: 0 }] });
  const before = alerts.length;
  poker.fn.eliminatePlayer(1);
  await new Promise(r => setTimeout(r, 400));
  test('winner alert names the last player standing', () => {
    assert(alerts.length > before, 'an alert fired');
    assert(/Ana wins/.test(alerts[alerts.length - 1]), 'alert names Ana, got: ' + alerts[alerts.length - 1]);
  });
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
