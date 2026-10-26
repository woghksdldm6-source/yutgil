// 윷길 친구와 하기 방 서버
// 방 하나를 Netlify Blobs의 JSON 한 개로 저장해요. 판 진행(던지기·이동)은 차례인 사람의 화면이 계산해서 보내고,
// 서버는 차례가 맞는지, 그 사이에 바뀐 게 없는지만 확인한 뒤 저장해요.
import { getStore } from '@netlify/blobs';
import { randomUUID } from 'node:crypto';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS = 4;
const MULTI_CHARMS = ['reroll', 'shortcut', 'piggy', 'chain', 'moCharm', 'yutCharm', 'noBack', 'quickDo', 'geol', 'sprint', 'hex'];
const CATCHUP_CHARMS = ['comeback', 'express', 'payback', 'double']; // 증강 라운드에서 가장 뒤처진 사람에게만 나오는 역전 부적
const ALL_CHARMS = MULTI_CHARMS.concat(CATCHUP_CHARMS);
// 부적 등급 가중치 (게임 화면과 같은 값): 일반 3, 희귀 2, 전설 1
const CHARM_WEIGHT = { reroll: 3, piggy: 3, chain: 3, yutCharm: 3, noBack: 3, quickDo: 3, sprint: 3, moCharm: 2, geol: 2, hex: 2, shortcut: 1 };
function weightedPick(pool, n) {
  const a = pool.slice(), out = [];
  while (out.length < n && a.length) {
    let tot = 0;
    for (const id of a) tot += CHARM_WEIGHT[id] || 3;
    let r = Math.random() * tot, k = 0;
    for (; k < a.length - 1; k++) { r -= CHARM_WEIGHT[a[k]] || 3; if (r < 0) break; }
    out.push(a.splice(k, 1)[0]);
  }
  return out;
}
const MAX_BODY = 200000;

const rooms = () => getStore({ name: 'yutgil-rooms', consistency: 'strong' });

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
const fail = (status, error, extra = {}) => json({ error, ...extra }, status);

const randInt = n => Math.floor(Math.random() * n);
function newCode() {
  let s = '';
  for (let i = 0; i < 5; i++) s += CODE_CHARS[randInt(CODE_CHARS.length)];
  return s;
}
const newId = () => randomUUID();
function cleanName(n) {
  const s = String(n ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 12);
  return s || '이름 없음';
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const validCode = c => typeof c === 'string' && /^[A-Z0-9]{5}$/.test(c);

function initialGame(n, k, augmentsOn) {
  const pieces = [];
  for (let s = 0; s < n; s++) for (let i = 0; i < k; i++) pieces.push({ id: `s${s}p${i}`, seat: s, node: -1, trail: [] });
  return {
    gid: newId(), n, nPieces: k, pieces, turn: randInt(n), throwsLeft: 1, chips: [], chipSeq: 0,
    rerollUsed: Array(n).fill(0), traps: [], trapOwner: -1, seq: 0, events: [], winner: null,
    charms: Array.from({ length: n }, () => ({})), augmentsOn: !!augmentsOn, augRound: 0, augment: null, bonus: Array(n).fill(0),
  };
}

function pushEvent(g, ev) {
  g.seq += 1;
  ev.seq = g.seq;
  g.events.push(ev);
  if (g.events.length > 40) g.events.splice(0, g.events.length - 40);
  g.rev = g.seq + '-' + Math.random().toString(36).slice(2, 8);
}

// 증강 라운드에서 모두 골랐으면 고른 부적을 각자에게 더하고 라운드를 끝내요.
function finishAugment(g) {
  const a = g.augment;
  a.picks.forEach((id, s) => {
    g.charms[s] = g.charms[s] || {};
    g.charms[s][id] = (g.charms[s][id] || 0) + 1;
  });
  g.augment = null;
  pushEvent(g, { t: 'augdone', round: a.round, picks: a.picks.slice() });
}

async function load(code) {
  const r = await rooms().getWithMetadata(code, { type: 'json', consistency: 'strong' });
  if (!r || !r.data) return null;
  return { room: r.data, etag: r.etag };
}

// 읽고 → 바꾸고 → "그 사이에 아무도 안 바꿨을 때만" 저장해요. 겹치면 다시 읽어서 재시도해요.
async function mutate(code, change) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await load(code);
    if (!cur) return fail(404, '방을 찾을 수 없어요. 방 코드를 다시 확인해 주세요.');
    const out = change(cur.room);
    if (out instanceof Response) return out;
    if (out && out.noWrite) return json(out.body(cur.room));
    cur.room.state.v += 1;
    cur.room.updatedAt = Date.now();
    const { modified } = await rooms().setJSON(code, cur.room, { onlyIfMatch: cur.etag });
    if (modified) return json(out && out.body ? out.body(cur.room) : { state: cur.room.state });
    await new Promise(r => setTimeout(r, 40 + randInt(120)));
  }
  return fail(503, '동시에 여러 요청이 몰렸어요. 잠시 후 다시 시도해 주세요.');
}

function who(room, pid, token) {
  if (typeof pid !== 'string' || typeof token !== 'string' || room.secrets[pid] !== token) return -1;
  return room.state.players.findIndex(p => p.pid === pid);
}

function validGame(g, cur) {
  if (!g || typeof g !== 'object') return false;
  if (g.gid !== cur.gid || g.n !== cur.n || g.nPieces !== cur.nPieces) return false;
  if (!Array.isArray(g.pieces) || g.pieces.length !== cur.pieces.length) return false;
  if (!Array.isArray(g.events) || g.events.length > 40) return false;
  if (!Number.isInteger(g.seq) || g.seq < cur.seq) return false;
  if (!Number.isInteger(g.turn) || g.turn < 0 || g.turn >= g.n) return false;
  if (g.winner !== null && !(Number.isInteger(g.winner) && g.winner >= 0 && g.winner < g.n)) return false;
  for (const p of g.pieces) {
    if (!p || typeof p.id !== 'string' || !Number.isInteger(p.seat) || !Number.isInteger(p.node)) return false;
    if (!(p.node === -1 || p.node === 99 || (p.node >= 1 && p.node <= 28))) return false;
  }
  if (g.augment) {
    const a = g.augment;
    if (!cur.augmentsOn || !Array.isArray(a.offers) || a.offers.length !== g.n || !Array.isArray(a.picks) || a.picks.length !== g.n) return false;
    if (a.picks.some(Boolean)) return false;
    for (const o of a.offers) if (!Array.isArray(o) || o.length < 1 || o.length > 3 || !o.every(id => ALL_CHARMS.includes(id))) return false;
  }
  return true;
}

async function handlePost(b) {
  const code = typeof b.code === 'string' ? b.code.trim().toUpperCase() : '';

  if (b.action === 'create') {
    const name = cleanName(b.name);
    for (let i = 0; i < 6; i++) {
      const c = newCode();
      const pid = newId(), token = newId();
      const room = {
        secrets: { [pid]: token },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        state: { v: 1, code: c, phase: 'lobby', players: [{ pid, name, charm: null }], settings: { pieces: 3, charms: true }, offers: null, game: null, round: 0 },
      };
      const { modified } = await rooms().setJSON(c, room, { onlyIfNew: true });
      if (modified) return json({ code: c, pid, token, state: room.state });
    }
    return fail(500, '방을 만들지 못했어요. 다시 시도해 주세요.');
  }

  if (!validCode(code)) return fail(400, '방 코드는 영문과 숫자 5자예요.');

  switch (b.action) {
    case 'join':
      return mutate(code, room => {
        const s = room.state;
        // 이미 이 방에 있던 사람이 다시 들어오는 경우 (새로고침 등)
        if (typeof b.pid === 'string' && typeof b.token === 'string' && room.secrets[b.pid] === b.token) {
          const seat = s.players.findIndex(p => p.pid === b.pid);
          if (seat >= 0) return { noWrite: true, body: r => ({ code, pid: b.pid, token: b.token, state: r.state }) };
        }
        if (s.phase !== 'lobby') return fail(409, '이미 판이 시작된 방이에요. 이번 판이 끝나고 방장이 "한 판 더"를 누르면 들어올 수 있어요.');
        if (s.players.length >= MAX_PLAYERS) return fail(409, '방이 가득 찼어요. 한 방에는 4명까지 들어올 수 있어요.');
        const pid = newId(), token = newId();
        room.secrets[pid] = token;
        s.players.push({ pid, name: cleanName(b.name), charm: null });
        return { body: r => ({ code, pid, token, state: r.state }) };
      });

    // 브라우저끼리 바로 연결할 때 쓰는 내 연결 주소를 알려요. 게임 진행에는 영향을 주지 않아요.
    case 'peer':
      return mutate(code, room => {
        const s = room.state;
        const seat = who(room, b.pid, b.token);
        if (seat < 0) return fail(403, '이 방의 참가자가 아니에요.');
        const id = String(b.peer || '').slice(0, 80);
        if (!/^[A-Za-z0-9_-]+$/.test(id)) return fail(400, '연결 정보가 올바르지 않아요.');
        if (s.players[seat].peer === id) return { noWrite: true, body: r => ({ state: r.state }) };
        s.players[seat].peer = id;
      });

    case 'leave':
      return mutate(code, room => {
        const s = room.state;
        const seat = who(room, b.pid, b.token);
        if (seat < 0) return { noWrite: true, body: r => ({ state: r.state }) };
        if (s.phase !== 'lobby') return { noWrite: true, body: r => ({ state: r.state }) }; // 판 중에는 자리를 지워 차례가 꼬이지 않게 해요. 방장이 차례를 넘길 수 있어요.
        s.players.splice(seat, 1);
        delete room.secrets[b.pid];
      });

    case 'settings':
      return mutate(code, room => {
        const s = room.state;
        if (who(room, b.pid, b.token) !== 0) return fail(403, '방장만 설정을 바꿀 수 있어요.');
        if (s.phase !== 'lobby') return fail(409, '대기실에서만 설정을 바꿀 수 있어요.', { state: s });
        const pieces = Number(b.settings && b.settings.pieces);
        s.settings = { pieces: [2, 3, 4].includes(pieces) ? pieces : 3, charms: !!(b.settings && b.settings.charms) };
      });

    case 'start':
      return mutate(code, room => {
        const s = room.state;
        if (who(room, b.pid, b.token) !== 0) return fail(403, '방장만 시작할 수 있어요.');
        if (s.phase !== 'lobby') return fail(409, '이미 시작했어요.', { state: s });
        if (s.players.length < 2) return fail(409, '두 명 이상 모여야 시작할 수 있어요.', { state: s });
        s.game = initialGame(s.players.length, s.settings.pieces, s.settings.charms);
        s.players.forEach(p => { p.charm = null; });
        s.offers = s.settings.charms ? s.players.map(() => weightedPick(MULTI_CHARMS, 3)) : null;
        s.phase = s.settings.charms ? 'charm' : 'play';
        s.round += 1;
      });

    case 'charm':
      return mutate(code, room => {
        const s = room.state;
        const seat = who(room, b.pid, b.token);
        if (seat < 0) return fail(403, '이 방의 참가자가 아니에요.');
        if (s.phase !== 'charm') return fail(409, '지금은 부적을 고를 때가 아니에요.', { state: s });
        if (!s.offers || !s.offers[seat] || !s.offers[seat].includes(b.charm)) return fail(400, '고를 수 없는 부적이에요.', { state: s });
        s.players[seat].charm = b.charm;
        if (s.players.every(p => p.charm)) {
          s.game.charms = s.players.map(p => ({ [p.charm]: 1 }));
          s.phase = 'play';
        }
      });

    case 'augment':
      return mutate(code, room => {
        const s = room.state;
        const seat = who(room, b.pid, b.token);
        if (seat < 0) return fail(403, '이 방의 참가자가 아니에요.');
        const g = s.game;
        if (s.phase !== 'play' || !g || !g.augment) return fail(409, '지금은 증강을 고를 때가 아니에요.', { state: s });
        const a = g.augment;
        if (a.picks[seat]) return { noWrite: true, body: r => ({ state: r.state }) };
        if (!Array.isArray(a.offers[seat]) || !a.offers[seat].includes(b.charm)) return fail(400, '고를 수 없는 부적이에요.', { state: s });
        a.picks[seat] = b.charm;
        pushEvent(g, { t: 'pick', seat });
        if (a.picks.every(Boolean)) finishAugment(g);
      });

    case 'update':
      return mutate(code, room => {
        const s = room.state;
        const seat = who(room, b.pid, b.token);
        if (seat < 0) return fail(403, '이 방의 참가자가 아니에요.');
        if (s.phase !== 'play' || !s.game) return fail(409, '지금은 판이 진행 중이 아니에요.', { state: s });
        if (s.game.augment) return fail(409, '증강을 고르는 중이에요.', { state: s });
        if (s.game.turn !== seat || b.baseSeq !== s.game.seq) return fail(409, '다른 사람 화면과 진행이 어긋났어요.', { state: s });
        if (JSON.stringify(b.game || null).length > MAX_BODY) return fail(413, '판 정보가 너무 커요.');
        if (!validGame(b.game, s.game)) return fail(400, '판 정보가 올바르지 않아요.', { state: s });
        s.game = b.game;
        if (s.game.winner !== null) s.phase = 'over';
      });

    case 'skip':
      return mutate(code, room => {
        const s = room.state;
        if (who(room, b.pid, b.token) !== 0) return fail(403, '방장만 차례를 넘길 수 있어요.');
        if (s.phase !== 'play' || !s.game) return fail(409, '지금은 판이 진행 중이 아니에요.', { state: s });
        const g = s.game;
        // 증강 라운드 중이면, 아직 안 고른 사람은 후보 중 하나로 대신 정하고 라운드를 끝내요.
        if (g.augment) {
          g.augment.picks = g.augment.picks.map((p, i) => p || g.augment.offers[i][randInt(g.augment.offers[i].length)]);
          finishAugment(g);
          return;
        }
        g.turn = (g.turn + 1) % g.n;
        const bonus = (g.bonus && g.bonus[g.turn]) || 0;
        if (g.bonus) g.bonus[g.turn] = 0;
        g.throwsLeft = 1 + bonus;
        g.chips = [];
        pushEvent(g, { t: 'turn', seat: g.turn, skipped: true, bonus });
      });

    case 'reset':
      return mutate(code, room => {
        const s = room.state;
        if (who(room, b.pid, b.token) !== 0) return fail(403, '방장만 새 판을 열 수 있어요.');
        s.phase = 'lobby';
        s.game = null;
        s.offers = null;
        s.players.forEach(p => { p.charm = null; });
      });

    default:
      return fail(400, '알 수 없는 요청이에요.');
  }
}

export default async req => {
  try {
    const url = new URL(req.url);
    if (req.method === 'GET') {
      if (url.searchParams.get('ping')) return json({ ok: true });
      const code = (url.searchParams.get('code') || '').toUpperCase();
      if (!validCode(code)) return fail(400, '방 코드는 영문과 숫자 5자예요.');
      const cur = await load(code);
      if (!cur) return fail(404, '방을 찾을 수 없어요.');
      if (Number(url.searchParams.get('v')) === cur.room.state.v) return json({ same: true, v: cur.room.state.v });
      return json({ state: cur.room.state });
    }
    if (req.method !== 'POST') return fail(405, '지원하지 않는 요청이에요.');
    const text = await req.text();
    if (text.length > MAX_BODY) return fail(413, '요청이 너무 커요.');
    let body;
    try { body = JSON.parse(text); } catch { return fail(400, '요청 형식이 올바르지 않아요.'); }
    if (!body || typeof body !== 'object') return fail(400, '요청 형식이 올바르지 않아요.');
    return await handlePost(body);
  } catch (e) {
    console.error(e);
    return fail(500, '서버에서 문제가 생겼어요. 잠시 후 다시 시도해 주세요.');
  }
};

export const config = { path: '/api/room' };
