'use strict';
/**
 * PARTY PANİK – 1-4 kişilik gerçek zamanlı çevrimiçi parti oyunu (Node.js + Socket.io)
 *
 * Çalıştırma:  npm install  →  npm start   →  http://localhost:3000
 * Tek bir modu denemek için:  FORCE_MODE=tiles|bomb|gold|soccer npm start
 * Hızlı test (kısa süreler):   TEST_FAST=1 npm start
 *
 * Mimari: SUNUCU OTORİTERDİR. İstemci yalnızca girdi (hareket vektörü + aksiyon) gönderir;
 * fizik, çarpışma, eleme ve skor kararları sunucuda 60 Hz çalışır, durum 30 Hz yayınlanır,
 * istemci bunu interpolasyonla akıcı çizer.
 *
 * Akış (PLAYLIST / TUR SİSTEMİ):
 *   lobi (ev sahibi oyun listesini + oyun sayısını ayarlar; herkes "Hazır")
 *     → 3 sn geri sayım → playlist kurulur
 *     → [ giriş ekranı → oyun → kısa sonuç afişi → SKOR TABLOSU ]  × N oyun
 *     → son tabloda "GENEL ŞAMPİYON" → lobiye dönüş (hazırlar ve puanlar sıfırlanır)
 *
 * Puanlama (her oyun sonunda yerleşime göre): 1. = 3 puan ... sonuncu = 0 (oyuncu sayısına göre ölçeklenir,
 * eşitlikte puan paylaşılır). Tek kişilik antrenmanda puan = oyundaki skor (altın / tur / saniye / gol).
 * Genel şampiyon: en çok toplam puan; eşitlikte en çok oyun kazanan; yine eşitse ortak şampiyon.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');

// ---------------------------------------------------------------------------
// Ayarlar (istemciye de gönderilir; denge ayarı için burayı değiştirmek yeterli)
// ---------------------------------------------------------------------------
const CFG = {
  tickRate: 60,          // fizik adımı / sn
  snapEvery: 2,          // her 2 adımda bir yayın (= 30 Hz)
  maxPlayers: 4,
  arenaW: 960, arenaH: 600,
  playerR: 20,
  accel: 880,            // ivme (yüksek ivme + düşük sürtünme = kayma/momentum hissi)
  drag: 2.3,
  maxSpeed: 620,
  restitution: 1.0,      // çarpışma sekmesi
  dashSpeed: 430,        // aksiyon butonu: atılma (futbolda aynı zamanda ŞUT)
  dashTime: 0.22,
  dashCd: 1.5,
  dashPush: 200,
  readyCountdown: 3,     // herkes hazır olunca bekleme (sn)
  introTime: 4,          // mini oyun tanıtım ekranı (sn)
  resultTime: 2.2,       // oyun bitince kazanan afişi (sn)
  boardTime: 3.5,        // oyunlar arası SKOR TABLOSU (sn)
  finalTime: 8,          // son tablo / genel şampiyon ekranı (sn)
  maxRounds: 12,         // bir playlist'teki en fazla oyun sayısı
  tileCols: 8, tileRows: 5, tileSize: 120, tileColors: 5,
  goldTime: 40,          // Altın Yağmuru süresi (sn)
  // Arcade Sokak Futbolu
  soccerTime: 50,        // normal süre (sn)
  soccerOT: 15,          // beraberlikte "altın gol" uzatması (sn)
  ballR: 14, ballDrag: 0.9, ballMax: 950, kickPower: 560,
  goalY0: 215, goalY1: 385, goalDepth: 40,
  goalPause: 2,          // gol sonrası bekleme (sn)
};
if (process.env.TEST_FAST) {
  Object.assign(CFG, { readyCountdown: 1, introTime: 1.5, resultTime: 1, boardTime: 1.2, finalTime: 2,
    goldTime: 6, soccerTime: 8, soccerOT: 4, goalPause: 1 });
}
const COLORS = ['#ff4d6d', '#4dabf7', '#51cf66', '#ffd43b'];
const TAU = Math.PI * 2;
const r1 = v => Math.round(v * 10) / 10;
const r2 = v => Math.round(v * 100) / 100;
const rnd = (a, b) => a + Math.random() * (b - a);

// ---------------------------------------------------------------------------
// HTTP: public/ klasöründen statik dosya sun
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
const server = http.createServer((req, res) => {
  let url;
  try { url = decodeURIComponent(req.url.split('?')[0]); } catch (e) { res.writeHead(400); return res.end('Bad request'); }
  if (url === '/') url = '/index.html';
  const file = path.normalize(path.join(PUBLIC, url));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(url === '/favicon.ico' ? 204 : 404); return res.end(url === '/favicon.ico' ? undefined : 'Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});
const io = new Server(server);

// ---------------------------------------------------------------------------
// Oda yönetimi
// ---------------------------------------------------------------------------
const rooms = new Map();
const emitTo = (room, ev, data) => io.to(room.code).emit(ev, data);

function genCode() {
  for (let i = 0; i < 200; i++) {
    const c = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    if (!rooms.has(c)) return c;
  }
  return null;
}
function sanitizeName(raw, fallback) {
  const s = String(raw == null ? '' : raw).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12);
  return s || fallback;
}
function freeColorIndex(room) {
  const used = new Set([...room.players.values()].map(p => p.ci));
  for (let i = 0; i < CFG.maxPlayers; i++) if (!used.has(i)) return i;
  return 0;
}
function addPlayer(room, socket, rawName) {
  const ci = freeColorIndex(room);
  const p = {
    id: socket.id, name: sanitizeName(rawName, 'Oyuncu ' + (ci + 1)), ci, color: COLORS[ci],
    ready: false, wins: 0,
    pts: 0, gpts: 0, sw: 0, titles: 0,     // pts: playlist toplam puanı, gpts: son oyunun puanı, sw: playlist'te kazanılan oyun, titles: şampiyonluk
    x: 0, y: 0, vx: 0, vy: 0, ix: 0, iy: 0, fx: 0, fy: 1,
    out: 0, outAt: 0, fallT: 0,            // out: 0=canlı, 1=düştü, 2=bombayla elendi
    dashT: 0, dashCd: 0, bumpCd: 0, hitCd: 0, kickCd: 0, coins: 0,
  };
  room.players.set(socket.id, p);
  socket.join(room.code);
  socket.data.code = room.code;
  return p;
}
function roomPayload(room) {
  return {
    code: room.code, hostId: room.hostId, state: room.state, multi: room.multi, cfg: CFG,
    modeIds: Object.keys(MODES),
    settings: { games: room.settings.games.slice(), rounds: room.settings.rounds, order: room.settings.order },
    session: room.session ? { idx: room.session.idx, total: room.session.total } : null,
    startsIn: room.startIn == null ? null : r2(Math.max(room.startIn, 0)),
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color, ready: p.ready, wins: p.wins, pts: p.pts, titles: p.titles,
    })),
  };
}
function emitRoom(room) { emitTo(room, 'room', roomPayload(room)); }
function getCtx(socket) {
  const room = rooms.get(socket.data.code);
  const p = room && room.players.get(socket.id);
  return { room, p };
}
const aliveList = room => [...room.players.values()].filter(p => !p.out);

// Herkes hazırsa geri sayımı başlat, biri hazır değilse iptal et
function updateReady(room) {
  if (room.state !== 'lobby') return;
  const all = room.players.size > 0 && [...room.players.values()].every(p => p.ready);
  if (all && room.startIn == null) room.startIn = CFG.readyCountdown;
  else if (!all) room.startIn = null;
}

function leaveCurrentRoom(socket) {
  const code = socket.data.code;
  if (!code) return;
  socket.data.code = null;
  socket.leave(code);
  const room = rooms.get(code);
  if (!room) return;
  room.players.delete(socket.id);
  if (room.players.size === 0) { rooms.delete(code); return; }
  if (room.hostId === socket.id) room.hostId = room.players.keys().next().value;
  if (room.state === 'lobby') {
    updateReady(room);
  } else if (room.multi && room.players.size < 2) {
    toLobby(room, 'Rakipler ayrıldı, lobiye dönüldü.');
    return;
  } else {
    const m = MODES[room.mode];
    if (m && m.onLeave) m.onLeave(room, socket.id);
  }
  emitRoom(room);
}

// ---------------------------------------------------------------------------
// PLAYLIST: oyun listesi kurma
// ---------------------------------------------------------------------------
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
/**
 * settings = { games:[modId...], rounds:N, order:'seq'|'rand' }
 *  - seq : seçili oyunlar listedeki sırayla döner (A B C A B ...)
 *  - rand: her "torba" karıştırılır; her oyun, torba bitmeden tekrar etmez ve torbalar arasında art arda aynı oyun gelmez
 *  - rounds > seçili oyun sayısı ise liste başa sarar
 */
function buildPlaylist(s) {
  const forced = MODES[process.env.FORCE_MODE] ? process.env.FORCE_MODE : null;
  if (forced) return Array(s.rounds).fill(forced);
  const out = [];
  while (out.length < s.rounds) {
    const bag = s.order === 'rand' ? shuffle(s.games.slice()) : s.games.slice();
    if (s.order === 'rand' && out.length && bag.length > 1 && bag[0] === out[out.length - 1]) {
      const k = 1 + Math.floor(Math.random() * (bag.length - 1));
      [bag[0], bag[k]] = [bag[k], bag[0]];
    }
    for (const m of bag) if (out.length < s.rounds) out.push(m);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Oyun akışı: oturum başlat → (intro) → oyna → sonuç → skor tablosu → sıradaki oyun ... → şampiyon → lobi
// ---------------------------------------------------------------------------
function startSession(room) {
  const playlist = buildPlaylist(room.settings);
  room.session = { playlist, idx: -1, total: playlist.length };
  for (const p of room.players.values()) { p.pts = 0; p.gpts = 0; p.sw = 0; }
  nextGame(room);
}
function nextGame(room) {
  const s = room.session;
  s.idx++;
  startGame(room, s.playlist[s.idx]);
}

function startGame(room, mode) {
  room.mode = mode;
  room.multi = room.players.size > 1;      // tek kişiyse "antrenman" kuralları
  room.state = 'intro';
  room.timer = CFG.introTime;
  room.elapsed = 0;
  room.startIn = null;
  room.endIn = null;
  room.forced = null;

  const list = [...room.players.values()], n = list.length;
  list.forEach((p, i) => {
    const a = (i / n) * TAU + Math.PI / 4;
    const solo = n === 1;
    p.x = CFG.arenaW / 2 + (solo ? 0 : Math.cos(a) * 270);
    p.y = CFG.arenaH / 2 + (solo ? 0 : Math.sin(a) * 160);
    p.vx = p.vy = p.ix = p.iy = 0;
    p.out = 0; p.outAt = 0; p.fallT = 0; p.gpts = 0;
    p.dashT = p.dashCd = p.bumpCd = p.hitCd = p.kickCd = 0; p.coins = 0;
    const dx = CFG.arenaW / 2 - p.x, dy = CFG.arenaH / 2 - p.y, L = Math.hypot(dx, dy);
    p.fx = L > 1 ? dx / L : 0; p.fy = L > 1 ? dy / L : 1;
  });
  MODES[room.mode].init(room);
  emitRoom(room);
}

// Oyun sonu yerleşim puanı: 1. = 3 puan ... sonuncu = 0 (oyuncu sayısına göre ölçeklenir, eşitlikte paylaşılır)
function awardPoints(room, winners) {
  const m = MODES[room.mode], all = [...room.players.values()], n = all.length;
  all.forEach(p => { p.gpts = 0; });
  if (!room.multi) {                                   // tek kişilik antrenman: puan = oyundaki skor
    const p = all[0];
    if (p) p.gpts = Math.max(0, Math.round(m.solo ? m.solo(room, p) : 0));
  } else if (winners.length) {                         // kimse kazanamadıysa (beraberlik / boş oyun) kimseye puan yok
    const sf = m.score || ((rm, p, w) => (w.includes(p) ? 1e9 : p.outAt));
    const ranked = all.map(p => ({ p, s: sf(room, p, winners) })).sort((a, b) => b.s - a.s);
    let place = 0;
    ranked.forEach((e, i) => {
      if (i > 0 && e.s < ranked[i - 1].s - 1e-6) place = i;
      e.p.gpts = n > 1 ? Math.round(3 * (n - 1 - place) / (n - 1)) : 3;
    });
    winners.forEach(w => { w.sw++; });
  }
  all.forEach(p => { p.pts += p.gpts; });
}

function finish(room, winners, extra) {
  room.state = 'result';
  room.timer = CFG.resultTime;
  room.endIn = null;
  const solo = !room.multi;
  if (!solo) winners.forEach(w => { w.wins++; });
  awardPoints(room, winners);
  const pub = p => ({ id: p.id, name: p.name, color: p.color });
  const m = MODES[room.mode];
  emitTo(room, 'result', Object.assign({
    mode: room.mode, title: m.title, solo,
    draw: !solo && winners.length > 1, winners: winners.map(pub),
    scores: [...room.players.values()].map(p => Object.assign(pub(p), { coins: p.coins, gp: p.gpts })),
    survived: r1(room.elapsed),
  }, m.result ? m.result(room) : {}, extra || {}));
  emitRoom(room);
}

// Sonuç afişinden sonra: SKOR TABLOSU (son oyunsa genel şampiyon ekranı)
function enterBoard(room) {
  const s = room.session;
  const final = s.idx >= s.total - 1;
  room.state = 'board';
  room.timer = final ? CFG.finalTime : CFG.boardTime;
  const rows = [...room.players.values()].map(p => ({
    id: p.id, name: p.name, color: p.color, gp: p.gpts, total: p.pts, sw: p.sw,
  })).sort((a, b) => (b.total - a.total) || (b.sw - a.sw));
  let rank = 1;
  rows.forEach((r, i) => {
    if (i > 0 && (r.total !== rows[i - 1].total || r.sw !== rows[i - 1].sw)) rank = i + 1;
    r.rank = rank;
  });
  const champions = final ? rows.filter(r => r.rank === 1).map(r => r.id) : [];
  if (final && room.multi) champions.forEach(id => { const p = room.players.get(id); if (p) p.titles++; });
  const next = final ? null : { mode: s.playlist[s.idx + 1], title: MODES[s.playlist[s.idx + 1]].title };
  emitTo(room, 'board', {
    idx: s.idx + 1, total: s.total, final, solo: !room.multi,
    mode: room.mode, title: MODES[room.mode].title, rows, champions, next, dur: room.timer,
  });
  emitRoom(room);
}

function toLobby(room, notice) {
  room.state = 'lobby';
  room.timer = 0; room.elapsed = 0; room.startIn = null; room.endIn = null; room.forced = null;
  room.session = null;
  for (const p of room.players.values()) {
    p.ready = false; p.out = 0; p.ix = p.iy = 0; p.coins = 0; p.pts = 0; p.gpts = 0; p.sw = 0;
  }
  if (notice) emitTo(room, 'notice', notice);
  emitRoom(room);
}

// "Hayatta kalma" modları için ortak bitiş kontrolü (Karo Kapmaca, Sıcak Bomba)
function checkSurvival(room) {
  if (room.endIn != null) return;
  if (aliveList(room).length <= (room.multi ? 1 : 0)) room.endIn = 1.2;   // son düşüşü göstermek için kısa bekleme
}
function finishSurvival(room) {
  let winners = [];
  const alive = aliveList(room);
  if (room.forced) winners = room.forced;
  else if (room.multi && alive.length) winners = alive;
  else if (room.multi) {                      // hepsi aynı anda elendi → son elenenler berabere
    const all = [...room.players.values()];
    const last = Math.max(...all.map(p => p.outAt));
    winners = all.filter(p => p.outAt >= last - 0.3);
  }
  finish(room, winners);
}

// ---------------------------------------------------------------------------
// Fizik (tüm modlarda ortak)
// ---------------------------------------------------------------------------
function physics(room, dt, allowInput) {
  const mode = MODES[room.mode];
  const A = CFG;
  const list = [...room.players.values()];

  for (const p of list) {
    if (p.out) {                                   // elenen: düşerken süzülür / bombalıysa durur
      p.fallT += dt;
      if (p.out === 1) {
        p.x += p.vx * dt; p.y += p.vy * dt;
        const d = Math.exp(-1.2 * dt); p.vx *= d; p.vy *= d;
      }
      continue;
    }
    const mul = allowInput && mode.accelMul ? mode.accelMul(room, p) : 1;
    const ix = allowInput ? p.ix : 0, iy = allowInput ? p.iy : 0;
    p.vx += ix * A.accel * mul * dt;
    p.vy += iy * A.accel * mul * dt;
    const damp = Math.exp(-A.drag * dt);
    p.vx *= damp; p.vy *= damp;
    const sp = Math.hypot(p.vx, p.vy), mx = A.maxSpeed * mul;
    if (sp > mx) { const k = mx / sp; p.vx *= k; p.vy *= k; }
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.dashT = Math.max(0, p.dashT - dt);
    p.dashCd = Math.max(0, p.dashCd - dt);
    p.bumpCd = Math.max(0, p.bumpCd - dt);
    p.hitCd = Math.max(0, p.hitCd - dt);
  }

  // Daire-daire çarpışma (eşit kütle)
  const act = list.filter(p => !p.out);
  const minD = A.playerR * 2;
  for (let i = 0; i < act.length; i++) {
    for (let j = i + 1; j < act.length; j++) {
      const a = act[i], b = act[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      let dist = Math.hypot(dx, dy);
      if (dist >= minD) continue;
      let nx = 1, ny = 0;
      if (dist > 0.0001) { nx = dx / dist; ny = dy / dist; } else dist = 0;
      const overlap = minD - dist;
      a.x -= nx * overlap / 2; a.y -= ny * overlap / 2;
      b.x += nx * overlap / 2; b.y += ny * overlap / 2;
      const sa = Math.hypot(a.vx, a.vy), sb = Math.hypot(b.vx, b.vy);   // çarpışma öncesi hızlar
      const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      let impact = 0;
      if (vn < 0) {
        const j2 = -(1 + A.restitution) * vn / 2;
        a.vx -= j2 * nx; a.vy -= j2 * ny;
        b.vx += j2 * nx; b.vy += j2 * ny;
        if (a.dashT > 0) { b.vx += nx * A.dashPush; b.vy += ny * A.dashPush; }
        if (b.dashT > 0) { a.vx -= nx * A.dashPush; a.vy -= ny * A.dashPush; }
        impact = -vn;
        if (impact > 150 && a.bumpCd <= 0 && b.bumpCd <= 0) {
          a.bumpCd = b.bumpCd = 0.12;
          io.to(room.code).volatile.emit('bump', {
            x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2), s: Math.min(impact / 500, 1.5),
          });
        }
      }
      if (allowInput && mode.onHit) mode.onHit(room, a, b, { impact, sa, sb });
    }
  }

  // Duvarlı modlarda arena kenarlarından sek
  if (mode.walls) {
    const r = A.playerR;
    for (const p of act) {
      if (p.x < r) { p.x = r; if (p.vx < 0) p.vx *= -0.55; }
      else if (p.x > A.arenaW - r) { p.x = A.arenaW - r; if (p.vx > 0) p.vx *= -0.55; }
      if (p.y < r) { p.y = r; if (p.vy < 0) p.vy *= -0.55; }
      else if (p.y > A.arenaH - r) { p.y = A.arenaH - r; if (p.vy > 0) p.vy *= -0.55; }
    }
  }
}

function knockOut(room, p, type) {
  p.out = type; p.outAt = room.elapsed; p.fallT = 0;
}

// ---------------------------------------------------------------------------
// MİNİ OYUN 1: Renkli Karo Kapmaca
//  Zemin 8x5 renkli karo. Hedef renk söylenir; süre bitince diğer renkler yok olur,
//  boşlukta kalanlar (veya arenadan itilenler) düşer. Son kalan kazanır.
// ---------------------------------------------------------------------------
const tileIndexAt = (x, y) => {
  const c = Math.floor(x / CFG.tileSize), r = Math.floor(y / CFG.tileSize);
  return (c < 0 || r < 0 || c >= CFG.tileCols || r >= CFG.tileRows) ? -1 : r * CFG.tileCols + c;
};
function newTileRound(room, again) {
  const g = room.g, n = CFG.tileCols * CFG.tileRows;
  g.r++;
  g.tl = Array.from({ length: n }, (_, i) => i % CFG.tileColors);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [g.tl[i], g.tl[j]] = [g.tl[j], g.tl[i]]; }
  g.al = new Array(n).fill(true);
  g.tg = Math.floor(Math.random() * CFG.tileColors);
  g.T = Math.max(2.4, 5.2 - 0.45 * (g.r - 1));       // her turda süre kısalır
  g.st = 'announce'; g.t = 1.5; g.again = !!again;
}
function tileVoidCheck(room) {
  const g = room.g;
  for (const p of aliveList(room)) {
    const i = tileIndexAt(p.x, p.y);
    if (i < 0 || !g.al[i]) knockOut(room, p, 1);
  }
}

// ---------------------------------------------------------------------------
// MİNİ OYUN 2: Sıcak Bomba
//  Rastgele birinde bomba başlar. Başkasına çarparak pasla. Süre bitince bomba kimdeyse elenir.
// ---------------------------------------------------------------------------
function giveBomb(room) {
  const g = room.g, alive = aliveList(room);
  if (!alive.length) return;
  g.round++;
  g.tot = g.fuse = Math.max(6, 14 - 2 * g.round);    // 12, 10, 8, 6 sn
  g.holder = alive[Math.floor(Math.random() * alive.length)].id;
  g.passCd = 0.6; g.st = 'fuse';
}
function passBomb(room, from, to) {
  const g = room.g;
  g.holder = to.id; g.passCd = 0.8;
  io.to(room.code).emit('pass', { x: Math.round((from.x + to.x) / 2), y: Math.round((from.y + to.y) / 2), i: to.id });
}

// ---------------------------------------------------------------------------
// MİNİ OYUN 3: Çılgın Altın Yağmuru
//  Haritaya altın düşer. Toplayanın puanı artar; sert çarpışmada itilen oyuncu 1 altın kaybeder.
// ---------------------------------------------------------------------------
function spawnCoin(room, x, y, v, lt, life) {
  const g = room.g;
  g.coins.push({ id: g.nid++, x, y, v, lt, life });
}

// ---------------------------------------------------------------------------
// MİNİ OYUN 4: Arcade Sokak Futbolu
//  Oyuncular sırayla 2 takıma bölünür (1.,3. oyuncu = takım 0 / sol kaleyi savunur; 2.,4. = takım 1 / sağ kale).
//  3 kişide 2'ye 1; tek kişide antrenman (sağ kaleye gol at). Aksiyon tuşu = atılma + ŞUT (topa yakınken güçlü vuruş).
//  Süre bitince çok gol atan takım kazanır; beraberlikte "altın gol" uzatması, yine olmazsa berabere.
// ---------------------------------------------------------------------------
function soccerKickoff(room) {
  const g = room.g, A = CFG;
  g.b = { x: A.arenaW / 2, y: A.arenaH / 2, vx: 0, vy: 0 };
  g.last = null; g.fxCd = 0;
  const teams = [[], []];
  for (const p of room.players.values()) teams[g.team[p.id] || 0].push(p);
  teams.forEach((arr, ti) => arr.forEach((p, i) => {
    p.x = ti === 0 ? 300 : 660;
    p.y = A.arenaH * (i + 1) / (arr.length + 1);
    p.vx = p.vy = 0; p.dashT = 0;
    p.fx = ti === 0 ? 1 : -1; p.fy = 0;
  }));
}
function soccerGoal(room, team) {
  const g = room.g, A = CFG;
  g.sc[team]++;
  g.st = 'goal'; g.pauseT = A.goalPause; g.gl = g.last;
  g.b.vx = g.b.vy = 0;
  emitTo(room, 'goal', { x: team === 0 ? A.arenaW : 0, y: Math.round(g.b.y), t: team, i: g.last });
}
function finishSoccer(room) {
  const g = room.g;
  if (!room.multi) { finish(room, []); return; }
  if (g.sc[0] === g.sc[1]) { finish(room, [], { tie: true }); return; }
  const wt = g.sc[0] > g.sc[1] ? 0 : 1;
  finish(room, [...room.players.values()].filter(p => g.team[p.id] === wt));
}

// ---------------------------------------------------------------------------
// Mod tablosu
//  score(room,p,winners): oyun sonu sıralaması için (yüksek = iyi). Tanımsızsa "hayatta kalma" sıralaması.
//  solo(room,p): tek kişilik antrenmanda playlist puanı.
// ---------------------------------------------------------------------------
const MODES = {
  tiles: {
    title: 'Renkli Karo Kapmaca', walls: false,
    init(room) { room.g = { r: 0, st: 'announce', t: 1.5, T: 5, tg: 0, tl: [], al: [], again: false }; newTileRound(room); },
    start(room) { room.g.t = 1.5; },
    solo(room) { return room.g.r; },
    step(room, dt) {
      const g = room.g;
      tileVoidCheck(room);
      g.t -= dt;
      if (g.st === 'announce' && g.t <= 0) { g.st = 'run'; g.t = g.T; }
      else if (g.st === 'run' && g.t <= 0) {
        const next = g.tl.map(c => c === g.tg);
        const alive = aliveList(room);
        const fallers = alive.filter(p => { const i = tileIndexAt(p.x, p.y); return i < 0 || !next[i]; });
        if (room.multi && alive.length && fallers.length === alive.length) newTileRound(room, true);  // herkes kaçırdıysa tur tekrar
        else { g.al = next; g.st = 'drop'; g.t = 1.6; tileVoidCheck(room); }
      } else if (g.st === 'drop' && g.t <= 0) newTileRound(room, false);
      checkSurvival(room);
    },
    snap(room) {
      const g = room.g;
      return { r: g.r, st: g.st, t: r2(Math.max(g.t, 0)), T: r1(g.T), tg: g.tg, tl: g.tl.join(''), al: g.al.map(a => (a ? 1 : 0)).join(''), ag: g.again ? 1 : 0 };
    },
    result(room) { return { rounds: room.g.r }; },
  },

  bomb: {
    title: 'Sıcak Bomba', walls: true,
    init(room) { room.g = { st: 'pause', fuse: 0, tot: 1, holder: null, passCd: 0, pauseT: 0, round: 0, le: null }; },
    start(room) { giveBomb(room); },
    solo(room) { return room.elapsed; },
    accelMul(room, p) { return room.g.st === 'fuse' && room.g.holder === p.id ? 1.18 : 1; },   // bombalı biraz daha hızlı
    onHit(room, a, b) {
      const g = room.g;
      if (g.st !== 'fuse' || g.passCd > 0) return;
      if (g.holder === a.id) passBomb(room, a, b);
      else if (g.holder === b.id) passBomb(room, b, a);
    },
    onLeave(room, id) {
      const g = room.g;
      if (g.holder === id) {
        const alive = aliveList(room);
        g.holder = alive.length ? alive[Math.floor(Math.random() * alive.length)].id : null;
        g.passCd = 0.6;
      }
    },
    step(room, dt) {
      const g = room.g;
      if (g.st === 'fuse') {
        g.passCd = Math.max(0, g.passCd - dt);
        g.fuse -= dt;
        if (g.fuse <= 0) {
          const h = room.players.get(g.holder);
          if (h && !h.out) {
            knockOut(room, h, 2); h.vx = h.vy = 0; g.le = h.id;
            emitTo(room, 'boom', { x: Math.round(h.x), y: Math.round(h.y), i: h.id });
            for (const o of aliveList(room)) {              // patlamanın şok dalgası
              const dx = o.x - h.x, dy = o.y - h.y, d = Math.hypot(dx, dy) || 1;
              if (d < 170) { const k = (1 - d / 170) * 420; o.vx += dx / d * k; o.vy += dy / d * k; }
            }
          }
          g.holder = null; g.st = 'pause'; g.pauseT = 1.8;
        }
      } else if (g.pauseT > 0 || g.round > 0) {
        g.pauseT -= dt;
        if (g.pauseT <= 0 && aliveList(room).length > 0) giveBomb(room);
      }
      checkSurvival(room);
    },
    snap(room) {
      const g = room.g;
      return { st: g.st, fu: r2(Math.max(g.fuse, 0)), ft: g.tot, h: g.holder, le: g.le };
    },
  },

  gold: {
    title: 'Çılgın Altın Yağmuru', walls: true, duration: CFG.goldTime,
    init(room) { room.g = { coins: [], nid: 1, spawnT: 0.4 }; },
    start(room) { room.timer = CFG.goldTime; room.g.spawnT = 0.2; },
    score(room, p) { return p.coins; },
    solo(room, p) { return p.coins; },
    onHit(room, a, b, h) {
      if (h.impact < 340) return;
      const victim = h.sa <= h.sb ? a : b;               // daha yavaş olan = itilen
      if (victim.coins > 0 && victim.hitCd <= 0) {
        victim.coins--; victim.hitCd = 0.7;
        const ang = Math.random() * TAU;
        spawnCoin(room, Math.min(Math.max(victim.x + Math.cos(ang) * 38, 30), CFG.arenaW - 30),
          Math.min(Math.max(victim.y + Math.sin(ang) * 38, 30), CFG.arenaH - 30), 1, 0.45, 9);
        emitTo(room, 'lose', { x: Math.round(victim.x), y: Math.round(victim.y), i: victim.id });
      }
    },
    step(room, dt) {
      const g = room.g;
      room.timer -= dt;
      g.spawnT -= dt;
      if (g.spawnT <= 0) {
        g.spawnT = room.timer < 10 ? rnd(0.25, 0.45) : rnd(0.5, 0.9);   // son 10 sn yağmur hızlanır
        if (g.coins.length < 14) spawnCoin(room, rnd(40, CFG.arenaW - 40), rnd(40, CFG.arenaH - 40), Math.random() < 0.15 ? 3 : 1, 0.8, 9);
      }
      const alive = aliveList(room), reach = CFG.playerR + 14;
      for (let i = g.coins.length - 1; i >= 0; i--) {
        const c = g.coins[i];
        if (c.lt > 0) { c.lt = Math.max(0, c.lt - dt); continue; }
        c.life -= dt;
        let taker = null;
        for (const p of alive) if (Math.hypot(p.x - c.x, p.y - c.y) < reach) { taker = p; break; }
        if (taker) {
          taker.coins += c.v;
          emitTo(room, 'coin', { x: Math.round(c.x), y: Math.round(c.y), v: c.v, i: taker.id });
          g.coins.splice(i, 1);
        } else if (c.life <= 0) g.coins.splice(i, 1);
      }
      if (room.timer <= 0) {
        room.timer = 0;
        const all = [...room.players.values()];
        const top = Math.max(...all.map(p => p.coins));
        finish(room, top > 0 ? all.filter(p => p.coins === top) : []);
      }
    },
    snap(room) {
      return { cn: room.g.coins.map(c => [c.id, r1(c.x), r1(c.y), c.v, r2(c.lt), r1(c.life)]) };
    },
  },

  soccer: {
    title: 'Arcade Sokak Futbolu', walls: true, duration: CFG.soccerTime,
    init(room) {
      const team = {};
      [...room.players.values()].forEach((p, i) => { team[p.id] = i % 2; });
      room.g = { team, sc: [0, 0], b: { x: 0, y: 0, vx: 0, vy: 0 }, st: 'play', pauseT: 0, last: null, gl: null, ot: false, fxCd: 0 };
      soccerKickoff(room);
    },
    start(room) { room.timer = CFG.soccerTime; },
    score(room, p, winners) { return winners.includes(p) ? 1 : 0; },
    solo(room) { return room.g.sc[0]; },
    accelMul(room) { return room.g.st === 'goal' ? 0 : 1; },           // gol sonrası herkes donar
    result(room) {
      const g = room.g;
      return { soccer: true, draw: false, sc: g.sc.slice(), goals: g.sc[0], wt: g.sc[0] > g.sc[1] ? 0 : g.sc[1] > g.sc[0] ? 1 : null };
    },
    step(room, dt) {
      const g = room.g, A = CFG, b = g.b, r = A.ballR;
      const list = [...room.players.values()];
      for (const p of list) p.kickCd = Math.max(0, p.kickCd - dt);
      g.fxCd = Math.max(0, g.fxCd - dt);

      if (room.multi) {                                               // bir takımın herkesi ayrıldıysa kalanlar kazanır
        const cnt = [0, 0];
        list.forEach(p => { cnt[g.team[p.id] || 0]++; });
        if (!cnt[0] || !cnt[1]) { finish(room, list); return; }
      }

      if (g.st === 'goal') {                                          // gol sevinci bekleme süresi
        g.pauseT -= dt;
        if (g.pauseT <= 0) {
          if (g.ot) { finishSoccer(room); return; }                   // altın gol → maç biter
          g.st = 'play'; g.gl = null; soccerKickoff(room);
        }
        return;
      }

      room.timer -= dt;                                               // saat yalnızca oyun sürerken akar
      if (room.timer <= 0) {
        room.timer = 0;
        if (!room.multi || g.sc[0] !== g.sc[1] || g.ot) { finishSoccer(room); return; }
        g.ot = true; room.timer = A.soccerOT;                         // beraberlik → altın gol uzatması
      }

      // --- top fiziği
      const damp = Math.exp(-A.ballDrag * dt);
      b.vx *= damp; b.vy *= damp;
      b.x += b.vx * dt; b.y += b.vy * dt;

      for (const p of list) {
        if (p.out) continue;
        const dx = b.x - p.x, dy = b.y - p.y, minD = A.playerR + r, d = Math.hypot(dx, dy);
        const nx = d > 0.001 ? dx / d : p.fx, ny = d > 0.001 ? dy / d : p.fy;
        if (d < minD) {                                               // temas: top oyuncudan sekip kayar
          b.x = p.x + nx * minD; b.y = p.y + ny * minD;
          const vn = (b.vx - p.vx) * nx + (b.vy - p.vy) * ny;
          if (vn < 0) {
            const j = -(1 + 0.3) * vn;
            b.vx += nx * j; b.vy += ny * j;
            p.vx -= nx * j * 0.12; p.vy -= ny * j * 0.12;
            if (-vn > 140 && g.fxCd <= 0) {
              g.fxCd = 0.1;
              io.to(room.code).volatile.emit('kick', { x: Math.round(b.x), y: Math.round(b.y), s: Math.min(-vn / 600, 1) });
            }
          }
          g.last = p.id;
        }
        if (p.dashT > 0 && p.kickCd <= 0 && d < minD + 16) {          // aksiyon tuşu: ŞUT
          let kx = nx * 0.45 + p.fx * 0.55, ky = ny * 0.45 + p.fy * 0.55;
          const kl = Math.hypot(kx, ky) || 1; kx /= kl; ky /= kl;
          b.vx += kx * A.kickPower; b.vy += ky * A.kickPower;
          p.kickCd = 0.3; g.last = p.id;
          io.to(room.code).volatile.emit('kick', { x: Math.round(b.x), y: Math.round(b.y), s: 1.4 });
        }
      }
      const bs = Math.hypot(b.vx, b.vy);
      if (bs > A.ballMax) { const k = A.ballMax / bs; b.vx *= k; b.vy *= k; }

      // --- kaleler: top tamamen ağın içine girerse gol (tek kişilik antrenmanda sol kale kapalı)
      const inMouth = b.y > A.goalY0 && b.y < A.goalY1;
      if (inMouth && room.multi && b.x < A.goalDepth - r) { soccerGoal(room, 1); return; }
      if (inMouth && b.x > A.arenaW - A.goalDepth + r) { soccerGoal(room, 0); return; }

      // --- duvarlar
      if (b.x < r) { b.x = r; if (b.vx < 0) b.vx *= -0.85; }
      else if (b.x > A.arenaW - r) { b.x = A.arenaW - r; if (b.vx > 0) b.vx *= -0.85; }
      if (b.y < r) { b.y = r; if (b.vy < 0) b.vy *= -0.85; }
      else if (b.y > A.arenaH - r) { b.y = A.arenaH - r; if (b.vy > 0) b.vy *= -0.85; }
    },
    snap(room) {
      const g = room.g, b = g.b;
      return { st: g.st, sc: g.sc, b: [r1(b.x), r1(b.y), Math.round(b.vx), Math.round(b.vy)], tn: g.team, gl: g.gl, ot: g.ot ? 1 : 0 };
    },
  },
};

// ---------------------------------------------------------------------------
// Oyun döngüsü
// ---------------------------------------------------------------------------
function sendSnapshot(room) {
  const m = MODES[room.mode];
  const snap = {
    ph: room.state, tm: r2(Math.max(room.timer, 0)), el: r1(room.elapsed), m: room.mode,
    g: m && m.snap ? m.snap(room) : null, p: [],
  };
  for (const p of room.players.values()) {
    snap.p.push({
      i: p.id, x: r1(p.x), y: r1(p.y), vx: Math.round(p.vx), vy: Math.round(p.vy),
      o: p.out, f: r2(p.fallT), d: p.dashT > 0 ? 1 : 0, c: r2(p.dashCd), k: p.coins,
    });
  }
  io.to(room.code).volatile.emit('state', snap);
}

function stepRoom(room, dt) {
  room.tick++;
  if (room.state === 'lobby') {
    if (room.startIn != null) {
      room.startIn -= dt;
      if (room.startIn <= 0) startSession(room);
    }
    return;
  }
  const mode = MODES[room.mode];
  if (room.state === 'intro') {
    room.timer -= dt;
    physics(room, dt, false);
    if (room.timer <= 0) { room.state = 'playing'; room.elapsed = 0; room.timer = 0; mode.start(room); }
  } else if (room.state === 'playing') {
    room.elapsed += dt;
    physics(room, dt, true);
    if (room.endIn != null) {                       // biri kazandı; son animasyon için kısa bekleme
      room.endIn -= dt;
      if (room.endIn <= 0) finishSurvival(room);
    } else mode.step(room, dt);
  } else if (room.state === 'result') {
    room.timer -= dt;
    physics(room, dt, false);
    if (room.timer <= 0) enterBoard(room);          // kazanan afişi bitti → skor tablosu
  } else if (room.state === 'board') {
    room.timer -= dt;
    if (room.timer <= 0) {
      if (room.session && room.session.idx < room.session.total - 1) nextGame(room);   // sıradaki mini oyun
      else toLobby(room);                                                              // playlist bitti → lobi
    }
  }
  if (room.state !== 'lobby' && room.tick % CFG.snapEvery === 0) sendSnapshot(room);
}

let last = process.hrtime.bigint();
setInterval(() => {
  const now = process.hrtime.bigint();
  const dt = Math.min(Number(now - last) / 1e9, 0.05);
  last = now;
  for (const room of rooms.values()) if (room.state !== 'lobby' || room.startIn != null) stepRoom(room, dt);
}, Math.round(1000 / CFG.tickRate));

// ---------------------------------------------------------------------------
// Socket olayları
// ---------------------------------------------------------------------------
io.on('connection', socket => {
  socket.on('createRoom', (data, cb) => {
    if (typeof cb !== 'function') return;
    leaveCurrentRoom(socket);
    const code = genCode();
    if (!code) return cb({ ok: false, error: 'Oda üretilemedi, tekrar dene.' });
    const ids = Object.keys(MODES);
    const room = {
      code, hostId: socket.id, state: 'lobby', multi: false, mode: null,
      players: new Map(), timer: 0, elapsed: 0, tick: 0, startIn: null, endIn: null, forced: null, g: null,
      settings: { games: ids.slice(), rounds: ids.length, order: 'rand' },   // varsayılan: hepsi bir kez, rastgele sırayla
      session: null,
    };
    rooms.set(code, room);
    addPlayer(room, socket, data && data.name);
    cb({ ok: true, code });
    emitRoom(room);
  });

  socket.on('joinRoom', (data, cb) => {
    if (typeof cb !== 'function') return;
    const code = String((data && data.code) || '').trim();
    if (!/^\d{4}$/.test(code)) return cb({ ok: false, error: 'Oda kodu 4 haneli olmalı.' });
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'Bu kodla bir oda bulunamadı.' });
    if (socket.data.code === code) return cb({ ok: true, code });
    if (room.state !== 'lobby') return cb({ ok: false, error: 'Bu odada oyun sürüyor, bitmesini bekle.' });
    if (room.players.size >= CFG.maxPlayers) return cb({ ok: false, error: 'Oda dolu (en fazla 4 kişi).' });
    leaveCurrentRoom(socket);
    addPlayer(room, socket, data && data.name);
    updateReady(room);                              // yeni gelen hazır değil → geri sayım iptal
    cb({ ok: true, code });
    emitRoom(room);
  });

  // Ev sahibi: oyun listesi / oyun sayısı / sıralama ayarı (yalnızca lobide, geri sayım sırasında değil)
  socket.on('settings', d => {
    const { room } = getCtx(socket);
    if (!room || room.hostId !== socket.id || room.state !== 'lobby' || !d || typeof d !== 'object') return;
    if (room.startIn != null) { socket.emit('notice', 'Geri sayım sırasında ayar değiştirilemez.'); emitRoom(room); return; }
    const s = room.settings, ids = Object.keys(MODES);
    if (Array.isArray(d.games)) {
      const want = new Set(d.games.filter(x => ids.includes(x)));
      if (want.size) s.games = ids.filter(id => want.has(id));       // kanonik sıra korunur; boş liste reddedilir
    }
    if (d.rounds != null) {
      const n = Math.floor(Number(d.rounds));
      if (isFinite(n)) s.rounds = Math.min(CFG.maxRounds, Math.max(1, n));
    }
    if (d.order === 'seq' || d.order === 'rand') s.order = d.order;
    emitRoom(room);
  });

  socket.on('ready', v => {
    const { room, p } = getCtx(socket);
    if (!room || !p || room.state !== 'lobby') return;
    p.ready = typeof v === 'boolean' ? v : !p.ready;
    updateReady(room);
    emitRoom(room);
  });

  socket.on('input', d => {
    const { p } = getCtx(socket);
    if (!p || !d) return;
    let x = Number(d.x), y = Number(d.y);
    if (!isFinite(x) || !isFinite(y)) return;
    const m = Math.hypot(x, y);
    if (m > 1) { x /= m; y /= m; }
    p.ix = x; p.iy = y;
    const fm = Math.hypot(x, y);
    if (fm > 0.15) { p.fx = x / fm; p.fy = y / fm; }      // son bakış yönü (atılma / şut bu yöne olur)
  });

  socket.on('dash', () => {
    const { room, p } = getCtx(socket);
    if (!room || !p || p.out || p.dashCd > 0 || room.state !== 'playing') return;
    p.vx += p.fx * CFG.dashSpeed; p.vy += p.fy * CFG.dashSpeed;
    p.dashT = CFG.dashTime; p.dashCd = CFG.dashCd;
  });

  socket.on('leaveRoom', () => leaveCurrentRoom(socket));
  socket.on('disconnect', () => leaveCurrentRoom(socket));
});

server.listen(PORT, '0.0.0.0', () => {
  const port = server.address().port;
  console.log('\n🎉  Party Panik çalışıyor!' + (MODES[process.env.FORCE_MODE] ? '   [FORCE_MODE=' + process.env.FORCE_MODE + ']' : '') + (process.env.TEST_FAST ? '   [TEST_FAST]' : ''));
  console.log(`    Bilgisayar:            http://localhost:${port}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) {
      if ((n.family === 'IPv4' || n.family === 4) && !n.internal) console.log(`    Telefon (aynı Wi-Fi):  http://${n.address}:${port}`);
    }
  }
  console.log('');
});

module.exports = { rooms, CFG, MODES, server, io, buildPlaylist };   // testler için
