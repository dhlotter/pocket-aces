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
global.window = { AudioContext: function () { return audioStub(); } };
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
  poker.state = s;
  const next = poker.fn.getNextActiveSeat;
  assertEq(next(s.dealerSeat), 1, 'all active, clockwise from 0');
  s.players[1].active = false;
  assertEq(next(s.dealerSeat), 2, 'eliminated seat skipped');
  assertEq(next(2), 0, 'wraps to first active');
  s.direction = 'anticlockwise';
  s.players[1].active = true;
  assertEq(next(s.dealerSeat), 2, 'anticlockwise from 0');
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
