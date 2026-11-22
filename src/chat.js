// ================= Poruke (chat) =================
// Model:
//  - Svaki korisnik piše SAMO u svoj prostor box/<uid>/c/<cid> (pravilo {self}) → pošiljalac je autentičan.
//  - Privatni četovi (DM i grupe) su šifrovani (AES-GCM). Ključ grupe je za svakog člana umotan
//    ECDH(P-256) ključem između vlasnika i člana. Metapodaci grupe su u javnoj kartici vlasnika (people/<uid>.chats).
//  - Fakultetski četovi su javni (bez šifrovanja), učlanjenje: people/<uid>.groups.
//  - Online status i „kuca…" idu preko `room` sposobnosti.
const C = {
  on: false, assets: null, room: null, priv: null, pairCache: new Map(), keyCache: new Map(),
  boxes: new Map(), subs: new Map(), dec: new Map(), online: new Set(), typing: new Map(),
  mini: null, full: false, active: null, info: false, reply: null, edit: null, pollDraft: null,
  q: '', newChat: null, seenAct: new Map(), renderTimer: 0, myBox: new Map(), writing: new Map(), pendingWrite: new Set(),
  mobilePane: 'list', lastTypingEmit: 0, preview: null
};
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉'];
const MAX_MSGS = 250, MAX_BOX_BYTES = 220000, MAX_SUBS = 48;

// ---------- pomoćne ----------
const b64 = buf => { const a = new Uint8Array(buf); let s = ''; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const rid = (n = 12) => b64(crypto.getRandomValues(new Uint8Array(n))).replace(/[+/=]/g, '').slice(0, n);
const enc = new TextEncoder(), dec = new TextDecoder();
const fmtTime = ts => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtSize = n => n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n > 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
const blobUrl = id => window.__blobUrl ? window.__blobUrl(id) : '/_blob/' + encodeURIComponent(id);
const slug = s => fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'fakultet';
function linkify(text) {
  return esc(text).replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]"'])/g, u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`).replace(/\n/g, '<br>');
}
function personById(uid) { if (uid === Me.uid) return { uid, ...(prof() || {}) }; return F.people.get(uid) || { uid, ime: 'Nepoznat', prezime: 'korisnik' }; }
const firstName = uid => { const p = personById(uid); return p.ime || fullName(p); };

// ---------- kriptografija ----------
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
async function ensureKeys() {
  const p = prof(); if (!p || !window.crypto || !crypto.subtle) return false;
  if (!p.ck || !p.ck.priv || !p.ck.pub) {
    const kp = await crypto.subtle.generateKey(ECDH, true, ['deriveKey']);
    p.ck = { priv: await crypto.subtle.exportKey('jwk', kp.privateKey), pub: await crypto.subtle.exportKey('jwk', kp.publicKey) };
    Me.save();
  }
  C.priv = await crypto.subtle.importKey('jwk', p.ck.priv, ECDH, false, ['deriveKey']);
  return true;
}
const pubOf = uid => uid === Me.uid ? (prof() && prof().ck && prof().ck.pub) : (F.people.get(uid) || {}).pub;
async function pairKey(uid) {
  const jwk = pubOf(uid); if (!jwk || !C.priv) return null;
  const k = uid + '|' + jwk.x;
  if (!C.pairCache.has(k)) C.pairCache.set(k, (async () => {
    const pub = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, ECDH, false, []);
    return crypto.subtle.deriveKey({ name: 'ECDH', public: pub }, C.priv, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  })().catch(() => null));
  return C.pairCache.get(k);
}
async function aesEnc(key, bytes) { const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes); return { iv: b64(iv), ct: b64(ct) }; }
async function aesDec(key, o) { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(o.iv) }, key, unb64(o.ct))); }
// ključ četa (verzija kv) koji je vlasnik `ko` umotao za mene
async function chatKey(ko, cid, kv) {
  const meta = chatMeta(ko, cid); if (!meta) return null;
  const w = meta.keys && meta.keys[kv] && meta.keys[kv][Me.uid]; if (!w) return null;
  const k = `${ko}|${cid}|${kv}|${w.ct.slice(0, 16)}`;
  if (!C.keyCache.has(k)) C.keyCache.set(k, (async () => {
    const pk = await pairKey(ko); if (!pk) return null;
    const raw = await aesDec(pk, w);
    return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  })().catch(() => null));
  return C.keyCache.get(k);
}
async function wrapKeyFor(uid, raw) { const pk = await pairKey(uid); return pk ? aesEnc(pk, raw) : null; }

// ---------- četovi ----------
function ownedChats() { return (prof() && prof().chatsOwned) || {}; }
function chatMeta(owner, cid) { return owner === Me.uid ? ownedChats()[cid] : ((F.people.get(owner) || {}).chats || {})[cid]; }
function facultyList() {
  const set = new Map();
  const add = f => { if (f && f.trim()) set.set(slug(f), f.trim()); };
  add(prof() && prof().fakultet);
  for (const o of F.people.values()) add(o.fakultet);
  return [...set.entries()].map(([s, name]) => ({ cid: 'fak-' + s, name }));
}
// svi četovi u kojima sam član
function myChats() {
  const p = prof(); if (!p) return [];
  const left = new Set(p.leftChats || []), out = new Map();
  const consider = (owner, cid, m) => {
    if (!m || !Array.isArray(m.members) || !m.members.includes(Me.uid) || left.has(cid)) return;
    const prev = out.get(cid);
    if (prev && prev.kind === 'dm' && prev.owner < owner) return; // DM: važi kopija vlasnika sa manjim id-jem
    out.set(cid, { cid, owner, kind: m.kind === 'dm' ? 'dm' : 'group', name: m.name || '', members: m.members, admins: m.admins || [], mode: m.mode === 'admins' ? 'admins' : 'all', kv: m.kv || 1, created: m.created || 0 });
  };
  for (const [cid, m] of Object.entries(ownedChats())) consider(Me.uid, cid, m);
  for (const o of F.people.values()) for (const [cid, m] of Object.entries(o.chats || {})) consider(o.uid, cid, m);
  for (const cid of p.groups || []) {
    const f = facultyList().find(x => x.cid === cid);
    const members = [Me.uid, ...[...F.people.values()].filter(o => (o.groups || []).includes(cid)).map(o => o.uid)];
    out.set(cid, { cid, owner: null, kind: 'fak', name: f ? f.name : cid.replace(/^fak-/, ''), members, admins: [], mode: 'all', kv: 0 });
  }
  return [...out.values()];
}
const chatById = cid => myChats().find(c => c.cid === cid) || null;
function chatTitle(c) {
  if (c.kind === 'dm') { const o = c.members.find(u => u !== Me.uid); return fullName(personById(o)); }
  return c.name || c.members.filter(u => u !== Me.uid).map(firstName).join(', ') || 'Grupa';
}
function chatAvatar(c, size = 40) {
  if (c.kind === 'dm') { const o = personById(c.members.find(u => u !== Me.uid)); return `<span class="avwrap">${avatarHtml(o, size)}${C.online.has(o.uid) ? '<i class="onl"></i>' : ''}</span>`; }
  const st = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px`;
  if (c.kind === 'fak') return `<span class="av grp fak" style="${st}">{{i:square-academic-cap:20}}</span>`;
  const w = chatTitle(c).split(/\s+/).filter(Boolean);
  return `<span class="av grp" style="${st};--h:${hueOf(c.cid)}">${esc(initials({ ime: w[0] || '#', prezime: w[1] || '' }))}</span>`;
}
function canWrite(c) { if (!c) return false; if (c.kind === 'fak' || c.kind === 'dm' || c.mode === 'all') return true; return c.owner === Me.uid || c.admins.includes(Me.uid); }
function isAdmin(c, uid) { return c.owner === uid || c.admins.includes(uid); }
function lastAct(c) { let t = 0; for (const u of c.members) { const p = u === Me.uid ? prof() : F.people.get(u); const a = p && p.act && p.act[c.cid]; if (a > t) t = a; } return t || c.created || 0; }
function othersAct(c) { let t = 0; for (const u of c.members) { if (u === Me.uid) continue; const p = F.people.get(u); const a = p && p.act && p.act[c.cid]; if (a > t) t = a; } return t; }
function isUnread(c) { const r = ((prof() || {}).readAt || {})[c.cid] || 0; return othersAct(c) > r && !(C.active === c.cid && chatVisible()); }
function unreadCount() { return myChats().filter(isUnread).length; }
const chatVisible = () => (C.full || !!C.mini) && document.visibilityState === 'visible';

// ---------- moj prostor (box) ----------
function boxRef(uid, cid) { return Store.db.doc(`box/${uid}/c/${cid}`); }
async function loadMyBox(cid) {
  if (C.myBox.has(cid)) return C.myBox.get(cid);
  let v = C.boxes.get(`${Me.uid}|${cid}`);
  if (!v) { try { const s = await boxRef(Me.uid, cid).get(); v = s.exists ? s.data() : null; } catch { v = null; } }
  const box = { cid, msgs: Array.isArray(v && v.msgs) ? JSON.parse(JSON.stringify(v.msgs)) : [], st: v && v.st ? JSON.parse(JSON.stringify(v.st)) : null };
  C.myBox.set(cid, box); return box;
}
// jedno pisanje po dokumentu; nagomilane izmene idu u sledeći upis
async function writeMyBox(cid) {
  if (C.writing.get(cid)) { C.pendingWrite.add(cid); return; }
  C.writing.set(cid, true);
  const box = C.myBox.get(cid);
  while (box.msgs.length > MAX_MSGS) box.msgs.shift();
  while (box.msgs.length > 1 && JSON.stringify(box).length > MAX_BOX_BYTES) box.msgs.shift();
  try { await boxRef(Me.uid, cid).set({ cid, msgs: box.msgs, st: box.st || null, at: Date.now() }); }
  catch (e) { toast(e && e.code === 'quota_exceeded' ? 'Baza poruka je puna. Obriši stare poruke ili grupe.' : 'Poruka nije poslata. Proveri vezu i pokušaj ponovo.'); }
  C.writing.set(cid, false);
  if (C.pendingWrite.delete(cid)) writeMyBox(cid);
}
// stanje (glasovi, reakcije, pročitano) – šifrovano kao i poruke
async function myState(c) {
  const box = await loadMyBox(c.cid);
  if (!box.st) return { votes: {}, reacts: {}, read: 0 };
  if (box.st.p) return box.st.p;
  const key = await chatKey(box.st.ko, c.cid, box.st.kv);
  if (!key) return { votes: {}, reacts: {}, read: 0 };
  try { return JSON.parse(dec.decode(await aesDec(key, box.st))); } catch { return { votes: {}, reacts: {}, read: 0 }; }
}
async function sealFor(c, obj) {
  if (c.kind === 'fak') return { p: obj };
  const key = await chatKey(c.owner, c.cid, c.kv);
  if (!key) throw { code: 'no_key' };
  return { ko: c.owner, kv: c.kv, ...(await aesEnc(key, enc.encode(JSON.stringify(obj)))) };
}
async function setMyState(c, fn) {
  const st = await myState(c); fn(st);
  const box = await loadMyBox(c.cid);
  box.st = await sealFor(c, st);
  await writeMyBox(c.cid);
}
async function sendMessage(c, body) {
  if (!canWrite(c)) { toast('U ovoj grupi pišu samo administratori.'); return false; }
  try {
    const box = await loadMyBox(c.cid);
    const id = rid(10), ts = Date.now();
    box.msgs.push({ id, ts, ...(await sealFor(c, body)) });
    C.dec.delete(`${Me.uid}|${c.cid}|${id}`);
    renderChatsSoon();
    await writeMyBox(c.cid);
    const p = prof(); p.act = { ...(p.act || {}), [c.cid]: ts }; p.readAt = { ...(p.readAt || {}), [c.cid]: ts }; Me.save();
    return true;
  } catch (e) {
    toast(e && e.code === 'no_key' ? 'Ključ za ovaj čet još nije stigao. Vlasnik grupe treba da otvori aplikaciju.' : 'Poruka nije poslata.');
    return false;
  }
}
async function editMessage(c, id, fn) {
  const box = await loadMyBox(c.cid);
  const i = box.msgs.findIndex(m => m.id === id); if (i < 0) return;
  const body = await decryptMsg(c, Me.uid, box.msgs[i]); if (!body) return;
  fn(body);
  box.msgs[i] = { id, ts: box.msgs[i].ts, ...(await sealFor(c, body)) };
  C.dec.delete(`${Me.uid}|${c.cid}|${id}`);
  renderChatsSoon();
  await writeMyBox(c.cid);
}
async function decryptMsg(c, from, m) {
  const k = `${from}|${c.cid}|${m.id}`, sig = (m.ct || '').slice(-12) + (m.p ? JSON.stringify(m.p).length : '');
  const hit = C.dec.get(k); if (hit && hit.sig === sig) return hit.body;
  let body = null;
  try {
    if (m.p && c.kind === 'fak') body = m.p;
    else if (m.ct && m.iv && c.kind !== 'fak') { const key = await chatKey(m.ko, c.cid, m.kv); if (key) body = JSON.parse(dec.decode(await aesDec(key, m))); }
  } catch { body = null; }
  if (body && typeof body === 'object') {
    body = { t: str(body.t, 10) || 'text', text: str(body.text, 4000), att: body.att && typeof body.att === 'object' ? { id: str(body.att.id, 40), name: str(body.att.name, 160), type: str(body.att.type, 60), size: +body.att.size || 0 } : null,
      poll: body.poll && Array.isArray(body.poll.opts) ? { q: str(body.poll.q, 200), opts: body.poll.opts.slice(0, 10).map(o => str(o, 100)), multi: !!body.poll.multi } : null,
      reply: str(body.reply, 40), edited: +body.edited || 0, del: !!body.del, url: /^https:\/\/meet\.jit\.si\/[A-Za-z0-9-]+$/.test(body.url || '') ? body.url : '', sys: str(body.sys, 200) };
  }
  C.dec.set(k, { sig, body }); return body;
}
async function decryptState(c, from, st) {
  if (!st) return null;
  try {
    if (st.p && c.kind === 'fak') return st.p;
    if (st.ct && c.kind !== 'fak') { const key = await chatKey(st.ko, c.cid, st.kv); if (key) return JSON.parse(dec.decode(await aesDec(key, st))); }
  } catch {}
  return null;
}

// ---------- pretplate na poruke otvorenih četova ----------
function wantedSubs() {
  const want = new Set(), cids = uniq([C.full && C.active, C.mini].filter(Boolean));
  for (const cid of cids) {
    const c = chatById(cid); if (!c) continue;
    let mem = c.members.slice();
    if (mem.length > MAX_SUBS) mem = mem.sort((a, b) => (b === Me.uid) - (a === Me.uid) || ((personById(b).act || {})[cid] || 0) - ((personById(a).act || {})[cid] || 0)).slice(0, MAX_SUBS);
    for (const u of mem) want.add(`${u}|${cid}`);
  }
  return want;
}
function syncSubs() {
  if (!C.on) return;
  const want = wantedSubs();
  for (const [k, un] of C.subs) if (!want.has(k)) { un(); C.subs.delete(k); C.boxes.delete(k); }
  for (const k of want) if (!C.subs.has(k)) {
    const [u, cid] = k.split('|');
    C.subs.set(k, boxRef(u, cid).onSnapshot(s => { C.boxes.set(k, s.exists ? s.data() : null); renderChatsSoon(); }, () => { C.subs.delete(k); }));
  }
}

// ---------- vremenska linija ----------
async function timeline(c) {
  const items = [], states = new Map();
  for (const u of c.members) {
    const v = C.boxes.get(`${u}|${c.cid}`); if (!v) continue;
    const st = await decryptState(c, u, v.st); if (st) states.set(u, st);
    for (const m of (Array.isArray(v.msgs) ? v.msgs : []).slice(-MAX_MSGS)) {
      if (!m || typeof m.id !== 'string' || !(m.ts > 0)) continue;
      const body = await decryptMsg(c, u, m);
      if (c.mode === 'admins' && c.kind === 'group' && !isAdmin(c, u) && !(body && body.sys)) continue; // samo admini
      items.push({ from: u, id: m.id, ts: m.ts, body });
    }
  }
  items.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  // glasovi i reakcije
  const votes = {}, reacts = {};
  for (const [u, st] of states) {
    for (const [mid, arr] of Object.entries(st.votes || {})) if (Array.isArray(arr)) (votes[mid] = votes[mid] || {})[u] = arr.filter(x => Number.isInteger(x)).slice(0, 10);
    for (const [mid, e] of Object.entries(st.reacts || {})) if (REACTIONS.includes(e)) (reacts[mid] = reacts[mid] || {})[u] = e;
  }
  return { items, votes, reacts, states };
}

// ---------- prikaz ----------
function renderChatsSoon() { clearTimeout(C.renderTimer); C.renderTimer = setTimeout(renderChats, 40); }
async function renderChats() {
  renderChatBadges();
  if (C.full) await renderFull();
  if (C.mini) await renderMini();
  markRead();
}
function renderChatBadges() {
  const n = unreadCount(), b = $('#chatBadge');
  if (b) { b.textContent = n; b.hidden = !n; }
  const on = FR.friends.filter(f => C.online.has(f.uid)).length, ob = $('#onlineCount');
  if (ob) { ob.textContent = on || ''; ob.hidden = !on; ob.title = `${on} ${on === 1 ? 'prijatelj je' : 'prijatelja je'} online`; }
  if (route === 'prijatelji') storeInfo();
}
function markRead() {
  const p = prof(); if (!p || !C.active || !chatVisible()) return;
  const c = chatById(C.active); if (!c) return;
  const a = othersAct(c), r = (p.readAt || {})[c.cid] || 0;
  if (a > r) {
    p.readAt = { ...(p.readAt || {}), [c.cid]: a }; Me.save();
    clearTimeout(C.readTimer); C.readTimer = setTimeout(() => setMyState(c, st => { st.read = Date.now(); }).catch(() => {}), 1500);
  }
}
function dayLabel(ts) { const d = iso(new Date(ts)); return d === todayIso ? 'Danas' : daysBetween(d, todayIso) === 1 ? 'Juče' : cap(fmtDay(d)); }
function attHtml(att) {
  const url = blobUrl(att.id);
  if (/^image\//.test(att.type)) return `<button class="att img" data-preview="${esc(att.id)}" data-ptype="${esc(att.type)}" data-pname="${esc(att.name)}"><img src="${url}" alt="${esc(att.name)}" loading="lazy"></button>`;
  if (/^video\//.test(att.type)) return `<video class="att vid" src="${url}" controls preload="metadata"></video>`;
  const icon = att.type === 'application/pdf' ? 'PDF' : (att.name.split('.').pop() || 'fajl').slice(0, 4).toUpperCase();
  return `<div class="att file"><span class="fic">${esc(icon)}</span><span class="fi"><b>${esc(att.name)}</b><span>${fmtSize(att.size)}</span></span><button class="btn sm" data-preview="${esc(att.id)}" data-ptype="${esc(att.type)}" data-pname="${esc(att.name)}">Pregled</button></div>`;
}
function pollHtml(c, it, votes) {
  const pv = votes[it.id] || {}, total = Object.keys(pv).length, mine = pv[Me.uid] || [];
  const counts = it.body.poll.opts.map((_, i) => Object.values(pv).filter(a => a.includes(i)).length);
  const max = Math.max(1, ...counts);
  return `<div class="poll"><div class="pq">{{i:checklist:16}} ${esc(it.body.poll.q)}</div>` + it.body.poll.opts.map((o, i) => {
    const who = Object.entries(pv).filter(([, a]) => a.includes(i)).map(([u]) => personById(u));
    return `<button class="popt${mine.includes(i) ? ' on' : ''}" data-vote="${esc(it.id)}" data-opt="${i}" data-from="${esc(it.from)}"><span class="bar" style="width:${Math.round(100 * counts[i] / max)}%"></span><span class="pt">${mine.includes(i) ? '{{i:check-circle:16}}' : '<i class="rb"></i>'} ${esc(o)}</span><span class="pc">${who.length ? avatarStack(who, 18, 3) : ''}${counts[i]}</span></button>`;
  }).join('') + `<div class="pf">${total} ${total === 1 ? 'glas' : 'glasova'}${it.body.poll.multi ? ' · više odgovora' : ''}</div></div>`;
}
function msgHtml(c, it, prev, tl, opts) {
  const mine = it.from === Me.uid, p = personById(it.from), b = it.body;
  if (b && b.sys) return `<div class="msys">${esc(b.sys)}</div>`;
  const grouped = prev && prev.from === it.from && it.ts - prev.ts < 5 * 60000 && !(prev.body && prev.body.sys);
  let inner;
  if (!b) inner = `<div class="bubble locked">{{i:lock-keyhole-minimalistic:14}} Poruka nije dostupna (nema ključa)</div>`;
  else if (b.del) inner = `<div class="bubble deleted">Poruka je obrisana</div>`;
  else {
    let content = '';
    if (b.reply) { const r = tl.items.find(x => x.id === b.reply); content += `<div class="rq">${r && r.body ? `<b>${esc(firstName(r.from))}</b> ${esc((r.body.text || (r.body.att ? r.body.att.name : r.body.poll ? r.body.poll.q : '')).slice(0, 90))}` : 'Poruka nije dostupna'}</div>`; }
    if (b.t === 'poll' && b.poll) content += pollHtml(c, it, tl.votes);
    else if (b.t === 'call') content += `<div class="callc">{{i:videocamera-record:20}}<span><b>${mine ? 'Pokrenuo/la si' : esc(firstName(it.from)) + ' je pokrenuo/la'} video poziv</b><br><span class="muted">Otvara se u novom tabu (Jitsi Meet)</span></span><a class="btn primary sm" href="${esc(b.url)}" target="_blank" rel="noopener noreferrer">Uđi u poziv</a></div>`;
    else {
      if (b.att) content += attHtml(b.att);
      if (b.text) content += `<div class="tx">${linkify(b.text)}</div>`;
    }
    inner = `<div class="bubble${b.att && !b.text && /^(image|video)\//.test(b.att.type) ? ' media' : ''}${b.t === 'poll' || b.t === 'call' ? ' card' : ''}">${content}</div>`;
  }
  const rx = tl.reacts[it.id] ? Object.entries(tl.reacts[it.id]) : [];
  const rxGroups = {}; for (const [u, e] of rx) (rxGroups[e] = rxGroups[e] || []).push(u);
  const rxHtml = rx.length ? `<div class="rx">${Object.entries(rxGroups).map(([e, us]) => `<button class="rxb${us.includes(Me.uid) ? ' on' : ''}" data-react="${esc(it.id)}" data-emoji="${e}" title="${esc(us.map(firstName).join(', '))}">${e} ${us.length}</button>`).join('')}</div>` : '';
  const actions = b && !b.del ? `<div class="mact">${canWrite(c) ? `<button data-mreply="${esc(it.id)}" title="Odgovori" aria-label="Odgovori">{{i:reply:16}}</button>` : ''}<button data-mreact="${esc(it.id)}" title="Reaguj" aria-label="Reaguj">{{i:smile-circle:16}}</button>${mine && b.t === 'text' && !b.att ? `<button data-medit="${esc(it.id)}" title="Izmeni" aria-label="Izmeni">{{i:pen:16}}</button>` : ''}${mine ? `<button data-mdel="${esc(it.id)}" title="Obriši" aria-label="Obriši">{{i:trash-bin-minimalistic:16}}</button>` : ''}</div>` : '';
  const picker = C.reactFor === it.id ? `<div class="rpick">${REACTIONS.map(e => `<button data-react="${esc(it.id)}" data-emoji="${e}">${e}</button>`).join('')}</div>` : '';
  return `<div class="msg${mine ? ' me' : ''}${grouped ? ' grp' : ''}" data-mid="${esc(it.id)}">
    ${mine ? '' : `<div class="mav">${grouped ? '' : avatarHtml(p, 30)}</div>`}
    <div class="mbody">${!mine && !grouped && c.kind !== 'dm' ? `<div class="mname">${esc(fullName(p))}${isAdmin(c, it.from) && c.kind === 'group' ? ' <span class="adm">admin</span>' : ''}</div>` : ''}
      <div class="mrow">${inner}${actions}</div>${picker}${rxHtml}
      <div class="mmeta">${fmtTime(it.ts)}${b && b.edited ? ' · izmenjeno' : ''}${opts.seenId === it.id ? ' · Viđeno' : ''}</div></div></div>`;
}
async function convHtml(c, mode) {
  const tl = await timeline(c);
  const loaded = c.members.some(u => C.boxes.has(`${u}|${c.cid}`));
  let h = '', prev = null, lastDay = '';
  let seenId = null;
  if (c.kind === 'dm') {
    const other = c.members.find(u => u !== Me.uid), r = (tl.states.get(other) || {}).read || 0;
    const mineSeen = tl.items.filter(i => i.from === Me.uid && i.ts <= r); if (mineSeen.length) seenId = mineSeen[mineSeen.length - 1].id;
  }
  for (const it of tl.items) {
    const d = dayLabel(it.ts); if (d !== lastDay) { lastDay = d; h += `<div class="mday"><span>${d}</span></div>`; prev = null; }
    h += msgHtml(c, it, prev, tl, { seenId }); prev = it;
  }
  if (!tl.items.length) h = loaded || !C.subs.size ? `<div class="cempty">${chatAvatar(c, 64)}<b>${esc(chatTitle(c))}</b><span>${c.kind === 'fak' ? 'Javni čet fakulteta. Pozdravi kolege!' : c.kind === 'dm' ? 'Napiši prvu poruku.' : 'Grupa je spremna. Napiši prvu poruku.'}</span><span class="muted">${c.kind === 'fak' ? 'Poruke u fakultetskom četu nisu šifrovane.' : '{{i:lock-keyhole-minimalistic:14}} Poruke su šifrovane i vide ih samo članovi.'}</span></div>` : `<div class="cempty"><span class="spinner"></span></div>`;
  const typers = [...(C.typing.get(c.cid) || new Map()).entries()].filter(([u, t]) => Date.now() - t < 4000 && u !== Me.uid).map(([u]) => firstName(u));
  return { msgs: h, typing: typers.length ? `${typers.join(', ')} ${typers.length === 1 ? 'kuca' : 'kucaju'}…` : '' };
}
function headSub(c) {
  if (c.kind === 'dm') { const o = c.members.find(u => u !== Me.uid); return C.online.has(o) ? '<span class="ondot"></span> online' : 'van mreže'; }
  const on = c.members.filter(u => u !== Me.uid && C.online.has(u)).length;
  return `${c.members.length} ${c.members.length === 1 ? 'član' : 'članova'}${on ? ` · ${on} online` : ''}${c.mode === 'admins' ? ' · pišu samo admini' : ''}`;
}
function composerHtml(c, where) {
  if (!canWrite(c)) return `<div class="ro">{{i:lock-keyhole-minimalistic:16}} U ovoj grupi pišu samo administratori.</div>`;
  let bar = '';
  if (C.reply && C.reply.cid === c.cid) bar = `<div class="cbar"><span>Odgovor na poruku: <b>${esc(C.reply.preview)}</b></span><button data-cbar-x aria-label="Otkaži">{{i:close:16}}</button></div>`;
  if (C.edit && C.edit.cid === c.cid) bar = `<div class="cbar"><span>Izmena poruke</span><button data-cbar-x aria-label="Otkaži">{{i:close:16}}</button></div>`;
  const poll = C.pollDraft && C.pollDraft.cid === c.cid ? `<div class="pdraft"><input class="pdq" placeholder="Pitanje ankete" maxlength="200" value="${esc(C.pollDraft.q)}" aria-label="Pitanje ankete">${C.pollDraft.opts.map((o, i) => `<input class="pdo" data-i="${i}" placeholder="Opcija ${i + 1}" maxlength="100" value="${esc(o)}" aria-label="Opcija ${i + 1}">`).join('')}
    <div class="pdrow">${C.pollDraft.opts.length < 10 ? '<button class="linkbtn" data-poll-add>+ Dodaj opciju</button>' : ''}<label class="switch"><input type="checkbox" class="pdm" ${C.pollDraft.multi ? 'checked' : ''}> Više odgovora</label><span class="grow"></span><button class="btn sm" data-poll-x>Otkaži</button><button class="btn primary sm" data-poll-send>Pošalji anketu</button></div></div>` : '';
  return `${bar}${poll}<div class="composer">
    <label class="cbtn" title="Pošalji sliku, video ili dokument" aria-label="Priloži fajl">{{i:paperclip:20}}<input type="file" class="cfile" multiple hidden accept="image/*,video/*,application/pdf,text/plain,text/csv,text/markdown,application/json,.md,.csv,.txt,.json"></label>
    <button class="cbtn" data-poll-new title="Anketa" aria-label="Napravi anketu">{{i:checklist:20}}</button>
    <textarea class="cin" rows="1" placeholder="${c.kind === 'fak' ? 'Poruka za ceo fakultet…' : 'Napiši poruku…'}" aria-label="Poruka">${C.edit && C.edit.cid === c.cid ? esc(C.edit.text) : esc(C.draft && C.draft[c.cid] || '')}</textarea>
    <button class="cbtn send" data-send title="Pošalji (Enter)" aria-label="Pošalji">{{i:plain:20}}</button></div>`;
}
function scrollKeep(el, fn) {
  const atBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  const old = el ? el.scrollTop : 0;
  fn();
  return atBottom ? 'bottom' : old;
}
async function paintConv(root, c, where) {
  const { msgs, typing } = await convHtml(c, where);
  const list = root.querySelector('.msgs'), prevTop = list ? list.scrollTop : 0;
  const atBottom = !list || list.scrollHeight - list.scrollTop - list.clientHeight < 80 || root.dataset.cid !== c.cid;
  const focused = document.activeElement && root.contains(document.activeElement) && document.activeElement.classList.contains('cin');
  const caret = focused ? document.activeElement.selectionStart : null;
  root.dataset.cid = c.cid;
  root.querySelector('.msgs').innerHTML = msgs;
  root.querySelector('.typing').textContent = typing;
  if (!root.querySelector('.cwrap').dataset.for || root.querySelector('.cwrap').dataset.for !== c.cid + '|' + canWrite(c) + '|' + !!C.reply + !!C.edit + !!C.pollDraft) {
    root.querySelector('.cwrap').innerHTML = composerHtml(c, where);
    root.querySelector('.cwrap').dataset.for = c.cid + '|' + canWrite(c) + '|' + !!C.reply + !!C.edit + !!C.pollDraft;
  }
  const l2 = root.querySelector('.msgs');
  l2.scrollTop = atBottom ? l2.scrollHeight : prevTop;
  if (focused) { const ta = root.querySelector('.cin'); ta.focus(); if (caret != null) ta.setSelectionRange(caret, caret); }
}

// ---------- mali prozor (dole desno) ----------
async function openMini(cid) {
  if (!C.on) { toast(NEED.chatText); return; }
  if (C.full) { C.active = cid; renderFull(); return; }
  C.mini = cid; C.active = cid; C.reply = C.edit = C.pollDraft = null;
  const w = $('#miniChat'); w.hidden = false; w.innerHTML = ''; delete w.dataset.cid;
  syncSubs(); await renderMini();
  const ta = w.querySelector('.cin'); ta && ta.focus();
}
function closeMini() { C.mini = null; if (!C.full) C.active = null; $('#miniChat').hidden = true; syncSubs(); renderChatBadges(); }
async function renderMini() {
  const w = $('#miniChat'); const c = C.mini && chatById(C.mini);
  if (!c) { if (C.mini) closeMini(); return; }
  if (!w.querySelector('.msgs') || w.dataset.shell !== c.cid) {
    w.dataset.shell = c.cid;
    w.innerHTML = `<div class="chead">${chatAvatar(c, 36)}<div class="ct"><b>${esc(chatTitle(c))}</b><span class="cs"></span></div>
      <button class="iconbtn sm" data-call="${esc(c.cid)}" title="Video poziv" aria-label="Video poziv">{{i:videocamera-record:18}}</button>
      <button class="iconbtn sm" data-expand title="Ceo ekran" aria-label="Otvori na celom ekranu">{{i:maximize-square-minimalistic:18}}</button>
      <button class="iconbtn sm" data-mini-x title="Zatvori" aria-label="Zatvori">{{i:close:18}}</button></div>
      <div class="msgs" role="log" aria-live="polite"></div><div class="typing"></div><div class="cwrap"></div>`;
  }
  w.querySelector('.cs').innerHTML = headSub(c);
  await paintConv(w, c, 'mini');
}

// ---------- ceo ekran ----------
function openFull(cid) {
  if (route !== 'poruke') { C.pendingCid = cid || C.mini || null; go('poruke'); return; }
  if (!C.on) { $('#chatFull').innerHTML = `<div class="card pagecard"><div class="empty"><strong>${NEED.chatTitle}</strong>${NEED.chatText}${NEED.loginBtn}</div></div>`; return; }
  if (C.mini && !cid) cid = C.mini;
  if (C.mini) { C.mini = null; $('#miniChat').hidden = true; }
  C.full = true;
  const list = myChats().sort((a, b) => lastAct(b) - lastAct(a));
  C.active = cid || C.active || (list[0] && list[0].cid) || null;
  C.mobilePane = cid ? 'conv' : 'list';
  $('#chatFull').innerHTML = '';
  syncSubs(); renderFull();
}
function closeFull() {
  C.full = false;
  if (C.mini) { $('#miniChat').hidden = false; C.active = C.mini; renderMini(); } else C.active = null;
  syncSubs(); renderChatBadges();
}
function chatListHtml() {
  const words = fold(C.q).split(/\s+/).filter(Boolean);
  const list = myChats().filter(c => !words.length || words.every(w => fold(chatTitle(c)).includes(w))).sort((a, b) => lastAct(b) - lastAct(a));
  let h = list.map(c => `<button class="crow${C.active === c.cid ? ' on' : ''}${isUnread(c) ? ' unread' : ''}" data-open-chat="${esc(c.cid)}">${chatAvatar(c, 44)}<span class="ci"><b>${esc(chatTitle(c))}</b><span>${c.kind === 'fak' ? 'Fakultet · javni čet' : c.kind === 'dm' ? headSub(c).replace(/<[^>]+>/g, '') : headSub(c)}</span></span><span class="cm">${lastAct(c) ? `<span>${iso(new Date(lastAct(c))) === todayIso ? fmtTime(lastAct(c)) : fmtShort(iso(new Date(lastAct(c))))}</span>` : ''}${isUnread(c) ? '<i class="udot"></i>' : ''}</span></button>`).join('');
  if (!list.length) h = `<div class="muted" style="padding:14px">${words.length ? 'Nema četova za ovu pretragu.' : 'Još nemaš poruka. Pokreni novi čet ili se pridruži četu fakulteta.'}</div>`;
  const joined = new Set((prof() || {}).groups || []);
  const sug = facultyList().filter(f => !joined.has(f.cid));
  if (sug.length && !words.length) h += `<div class="sugh">Predloženi četovi fakulteta</div>` + sug.map(f => {
    const n = [...F.people.values()].filter(o => (o.groups || []).includes(f.cid)).length;
    return `<div class="crow sug"><span class="av grp fak" style="width:44px;height:44px;font-size:18px">{{i:square-academic-cap:20}}</span><span class="ci"><b>${esc(f.name)}</b><span>${n ? `${n} ${n === 1 ? 'član' : 'članova'}` : 'budi prvi član'} · javni čet</span></span><button class="btn sm" data-join-fak="${esc(f.cid)}">Pridruži se</button></div>`;
  }).join('');
  return h;
}
async function renderFull() {
  const root = $('#chatFull'); if (!C.full) return;
  if (!root.querySelector('.cside')) {
    root.innerHTML = `<div class="cfull">
      <aside class="cside"><div class="csh"><h2>Poruke</h2><button class="btn primary sm" data-new-chat>{{i:pen-new-square:16}} Novi čet</button></div>
        <div class="search">${SEARCH_ICON}<input id="cq" type="search" placeholder="Pretraži četove" autocomplete="off" aria-label="Pretraži četove"></div>
        <div class="clist"></div></aside>
      <section class="cconv"></section><aside class="cinfo" hidden></aside></div>`;
    root.querySelector('#cq').addEventListener('input', e => { C.q = e.target.value; root.querySelector('.clist').innerHTML = chatListHtml(); });
  }
  root.querySelector('.cfull').dataset.pane = C.mobilePane;
  root.querySelector('.clist').innerHTML = chatListHtml();
  const conv = root.querySelector('.cconv'), c = C.active && chatById(C.active);
  if (C.newChat) { conv.innerHTML = newChatHtml(); conv.dataset.shell = 'new'; bindNewChat(conv); root.querySelector('.cinfo').hidden = true; return; }
  if (!c) { conv.dataset.shell = ''; conv.innerHTML = `<div class="cempty big">{{i:chat-round-dots:40}}<b>Izaberi čet ili pokreni novi</b><span class="muted">Privatne poruke i grupe su šifrovane – vide ih samo članovi.</span><button class="btn primary" data-new-chat>Novi čet</button></div>`; root.querySelector('.cinfo').hidden = true; return; }
  if (conv.dataset.shell !== c.cid) {
    conv.dataset.shell = c.cid; delete conv.dataset.cid;
    conv.innerHTML = `<div class="chead"><button class="iconbtn sm back" data-gopane="list" aria-label="Nazad na listu">{{i:arrow-left:18}}</button>${chatAvatar(c, 40)}<div class="ct"><b>${esc(chatTitle(c))}</b><span class="cs"></span></div>
      <button class="iconbtn sm" data-call="${esc(c.cid)}" title="Video poziv" aria-label="Video poziv">{{i:videocamera-record:18}}</button>
      <button class="iconbtn sm" data-info title="Detalji" aria-label="Detalji četa">{{i:info-circle:18}}</button></div>
      <div class="msgs" role="log" aria-live="polite"></div><div class="typing"></div><div class="cwrap"></div>`;
  }
  conv.querySelector('.cs').innerHTML = headSub(c);
  await paintConv(conv, c, 'full');
  const info = root.querySelector('.cinfo'); info.hidden = !C.info; if (C.info) info.innerHTML = infoHtml(c);
}
function infoHtml(c) {
  const owner = c.owner === Me.uid;
  let h = `<div class="ih"><b>Detalji</b><button class="iconbtn sm" data-info aria-label="Zatvori detalje">{{i:close:16}}</button></div><div class="ib">${chatAvatar(c, 72)}<h3>${esc(chatTitle(c))}</h3><span class="muted">${c.kind === 'fak' ? 'Javni čet fakulteta' : c.kind === 'dm' ? 'Privatna poruka' : 'Grupa'}</span></div>`;
  if (c.kind !== 'fak') h += `<div class="hint">{{i:lock-keyhole-minimalistic:16}}<span>Šifrovano: poruke mogu da pročitaju samo članovi.</span></div>`;
  else h += `<div class="hint">{{i:global:16}}<span>Javni čet: poruke vide svi članovi fakulteta koji koriste aplikaciju i nisu šifrovane.</span></div>`;
  if (c.kind === 'group' && owner) {
    h += `<div class="sgroup"><h3 class="sec">Ko može da piše</h3><div class="chips"><button class="chip" data-mode="all" aria-pressed="${c.mode === 'all'}">Svi članovi</button><button class="chip" data-mode="admins" aria-pressed="${c.mode === 'admins'}">Samo admini</button></div></div>`;
    h += `<div class="sgroup"><h3 class="sec">Naziv</h3><div class="row2"><input class="field-in" id="cname" value="${esc(c.name)}" maxlength="60" aria-label="Naziv grupe"><button class="btn sm" data-rename>Sačuvaj</button></div></div>`;
  }
  if (c.kind !== 'dm') {
    h += `<div class="sgroup"><h3 class="sec">Članovi · ${c.members.length}</h3><div class="plist">` + c.members.slice(0, 200).map(u => {
      const p = personById(u);
      const role = c.owner === u ? '<span class="pill planned">vlasnik</span>' : c.admins.includes(u) ? '<span class="pill planned">admin</span>' : '';
      const act = owner && u !== Me.uid && c.kind === 'group' ? `<button class="btn sm" data-admin="${esc(u)}">${c.admins.includes(u) ? 'Ukloni admina' : 'Postavi za admina'}</button><button class="iconbtn sm" data-kick="${esc(u)}" title="Ukloni iz grupe" aria-label="Ukloni iz grupe">{{i:user-cross-rounded:16}}</button>` : '';
      return `<div class="prow">${`<span class="avwrap">${avatarHtml(p, 34)}${C.online.has(u) ? '<i class="onl"></i>' : ''}</span>`}<div class="pi"><div class="pn">${esc(fullName(p))}${u === Me.uid ? ' (ti)' : ''}</div></div><div class="pa">${role}${act}</div></div>`;
    }).join('') + '</div></div>';
    if (owner && c.kind === 'group') {
      const can = FR.friends.filter(f => !c.members.includes(f.uid));
      if (can.length) h += `<div class="sgroup"><h3 class="sec">Dodaj prijatelje</h3><div class="plist">${can.map(f => `<div class="prow">${avatarHtml(f, 30)}<div class="pi"><div class="pn">${esc(fullName(f))}</div></div><button class="btn sm" data-addm="${esc(f.uid)}">Dodaj</button></div>`).join('')}</div></div>`;
    }
  }
  h += `<div class="actions" style="justify-content:flex-start">${c.kind === 'fak' ? `<button class="btn danger sm" data-leave-fak="${esc(c.cid)}">Napusti čet</button>` : c.kind === 'group' ? (owner ? `<button class="btn danger sm" data-del-chat="${esc(c.cid)}">Obriši grupu</button>` : `<button class="btn danger sm" data-leave="${esc(c.cid)}">Napusti grupu</button>`) : ''}</div>`;
  return h;
}

// ---------- novi čet ----------
function newChatHtml() {
  const n = C.newChat, sel = n.sel;
  const words = fold(n.q || '').split(/\s+/).filter(Boolean);
  const list = FR.friends.filter(f => !words.length || words.every(w => fold(fullName(f)).includes(w)));
  return `<div class="chead"><button class="iconbtn sm" data-new-x aria-label="Nazad">{{i:arrow-left:18}}</button><div class="ct"><b>Novi čet</b><span class="cs">${sel.size ? `Izabrano: ${sel.size}` : 'Izaberi jednog ili više prijatelja'}</span></div></div>
    <div class="ncbody">
      ${!FR.friends.length ? `<div class="empty"><strong>Nemaš još prijatelja</strong>Dodaj prijatelje da bi im slao/la poruke.<div><button class="btn primary" data-open-friends>Pronađi prijatelje</button></div></div>` : `
      <div class="search">${SEARCH_ICON}<input id="ncq" type="search" placeholder="Pretraži prijatelje" value="${esc(n.q || '')}" autocomplete="off" aria-label="Pretraži prijatelje"></div>
      <div class="plist">${list.map(f => `<button class="sopt" data-ncsel="${esc(f.uid)}" aria-pressed="${sel.has(f.uid)}"><span class="box">{{i:check:14}}</span><span class="avwrap">${avatarHtml(f, 32)}${C.online.has(f.uid) ? '<i class="onl"></i>' : ''}</span><span class="sn2">${esc(fullName(f))}</span></button>`).join('')}</div>
      ${sel.size > 1 ? `<div class="sgroup"><h3 class="sec">Naziv grupe</h3><input class="field-in" id="ncname" placeholder="npr. Učimo za Operativne" maxlength="60" value="${esc(n.name || '')}" aria-label="Naziv grupe"></div>
      <div class="sgroup"><h3 class="sec">Ko može da piše</h3><div class="chips"><button class="chip" data-ncmode="all" aria-pressed="${n.mode !== 'admins'}">Svi članovi</button><button class="chip" data-ncmode="admins" aria-pressed="${n.mode === 'admins'}">Samo admini</button></div></div>` : ''}
      <div class="actions"><button class="btn primary" data-nc-create ${sel.size ? '' : 'disabled'}>${sel.size > 1 ? 'Napravi grupu' : 'Otvori čet'}</button></div>`}
    </div>`;
}
function bindNewChat(conv) {
  const q = conv.querySelector('#ncq'); if (q) q.addEventListener('input', e => { C.newChat.q = e.target.value; const pos = e.target.selectionStart; renderFull(); const n2 = $('#ncq'); n2.focus(); n2.setSelectionRange(pos, pos); });
  const nm = conv.querySelector('#ncname'); if (nm) nm.addEventListener('input', e => { C.newChat.name = e.target.value; });
}
async function newKeysFor(members) {
  const raw = crypto.getRandomValues(new Uint8Array(32)), keys = {};
  for (const u of members) { const w = await wrapKeyFor(u, raw); if (w) keys[u] = w; }
  return { raw: b64(raw), keys };
}
async function createChat(members, name, mode) {
  const p = prof();
  if (!(await ensureKeys())) { toast('Ovaj pregledač ne podržava šifrovanje poruka.'); return null; }
  const isDm = members.length === 1;
  let cid;
  if (isDm) {
    const other = members[0];
    const existing = myChats().find(c => c.kind === 'dm' && c.members.includes(other));
    if (existing) return existing.cid;
    cid = 'dm-' + [Me.uid, other].sort().join('-').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 120);
  } else cid = 'g-' + rid(14);
  const all = uniq([Me.uid, ...members]);
  const { raw, keys } = await newKeysFor(all);
  p.chatsOwned = { ...(p.chatsOwned || {}), [cid]: { kind: isDm ? 'dm' : 'group', name: isDm ? '' : (name || '').trim().slice(0, 60), members: all, admins: [], mode: mode === 'admins' ? 'admins' : 'all', kv: 1, keys: { 1: keys }, raw: { 1: raw }, created: Date.now() } };
  p.leftChats = (p.leftChats || []).filter(x => x !== cid);
  Me.save();
  if (!isDm) { const c = chatById(cid); if (c) sendMessage(c, { t: 'sys', sys: `${firstName(Me.uid)} je napravio/la grupu` }); }
  return cid;
}
// vlasnik: dopuni ključeve za članove kojima fali (npr. nisu imali javni ključ kad su dodati)
async function ensureWrapped() {
  const p = prof(); if (!p || !p.chatsOwned || !C.priv) return;
  let changed = false;
  for (const [cid, m] of Object.entries(p.chatsOwned)) {
    const raw = m.raw && m.raw[m.kv]; if (!raw) continue;
    const ks = (m.keys[m.kv] = m.keys[m.kv] || {});
    for (const u of m.members) if (!ks[u] && pubOf(u)) { const w = await wrapKeyFor(u, unb64(raw)); if (w) { ks[u] = w; changed = true; } }
    // članovi koji su napustili grupu
    const leftUs = m.members.filter(u => u !== Me.uid && ((F.people.get(u) || {}).leftChats || []).includes(cid));
    if (leftUs.length && m.kind === 'group') { await rotateMembers(cid, m.members.filter(u => !leftUs.includes(u)), false); changed = true; }
  }
  if (changed) Me.save();
}
async function rotateMembers(cid, members, save = true) {
  const p = prof(), m = p.chatsOwned[cid]; if (!m) return;
  const kv = (m.kv || 1) + 1, { raw, keys } = await newKeysFor(members);
  m.members = members; m.admins = (m.admins || []).filter(u => members.includes(u));
  m.kv = kv; m.keys = { ...m.keys, [kv]: keys }; m.raw = { ...m.raw, [kv]: raw };
  // čuvamo poslednjih 5 verzija ključa (starije poruke ostaju čitljive)
  const vs = Object.keys(m.keys).map(Number).sort((a, b) => b - a);
  for (const v of vs.slice(5)) { delete m.keys[v]; delete m.raw[v]; }
  C.keyCache.clear();
  if (save) Me.save();
}

// ---------- prilozi ----------
const ALLOWED = /^(image\/(png|jpeg|gif|webp|svg\+xml)|video\/(mp4|webm|quicktime)|application\/pdf|text\/(plain|csv|markdown)|application\/json)$/;
function fileType(f) {
  if (f.type && ALLOWED.test(f.type)) return f.type;
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  return { md: 'text/markdown', csv: 'text/csv', txt: 'text/plain', json: 'application/json', pdf: 'application/pdf', mov: 'video/quicktime', mp4: 'video/mp4', webm: 'video/webm' }[ext] || '';
}
async function sendFiles(c, files) {
  if (!C.assets) { toast('Slanje fajlova ti trenutno nije dostupno (potreban je pristup za korišćenje aplikacije).'); return; }
  for (const f of files) {
    const type = fileType(f);
    if (!type) { toast(`„${f.name}" nije podržan. Šalji slike, video, PDF ili tekst (Word i PowerPoint sačuvaj kao PDF).`); continue; }
    if (f.size > 20 * 1048576) { toast(`„${f.name}" je veći od 20 MB.`); continue; }
    toast(`Šaljem ${f.name}…`);
    try {
      const r = await C.assets.upload(f, { type });
      await sendMessage(c, { t: /^image\//.test(type) ? 'img' : /^video\//.test(type) ? 'video' : 'file', att: { id: r.id, name: f.name.slice(0, 160), type: r.contentType || type, size: r.sizeBytes || f.size } });
    } catch (e) { toast(e && e.code === 'quota_exceeded' ? 'Prostor za fajlove je pun.' : `„${f.name}" nije poslat. Pokušaj ponovo.`); }
  }
}
async function openPreview(id, type, name) {
  const url = blobUrl(id);
  const dlg = $('#previewDlg'), body = $('#previewBody');
  $('#previewTitle').textContent = name || 'Pregled';
  $('#previewOpen').href = url;
  body.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  if (!dlg.open) dlg.showModal();
  try {
    if (/^image\//.test(type)) body.innerHTML = `<img class="pimg" src="${url}" alt="${esc(name)}">`;
    else if (/^video\//.test(type)) body.innerHTML = `<video class="pimg" src="${url}" controls autoplay></video>`;
    else if (type === 'application/pdf') {
      const lib = await loadPdfJs();
      const data = new Uint8Array(await (await fetch(url)).arrayBuffer());
      const pdf = await lib.getDocument({ data, isEvalSupported: false }).promise;
      body.innerHTML = `<div class="pdfpages"></div><div class="muted" style="text-align:center;padding:8px">${pdf.numPages} ${pdf.numPages === 1 ? 'strana' : 'strana'}${pdf.numPages > 30 ? ' · prikazano prvih 30' : ''}</div>`;
      const host = body.querySelector('.pdfpages');
      for (let i = 1; i <= Math.min(pdf.numPages, 30); i++) {
        if (!dlg.open) break;
        const page = await pdf.getPage(i), vp = page.getViewport({ scale: 1.4 });
        const cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height; host.appendChild(cv);
        await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
      }
    } else {
      const t = await (await fetch(url)).text();
      body.innerHTML = `<pre class="ptext">${esc(t.slice(0, 200000))}</pre>`;
    }
  } catch { body.innerHTML = `<div class="empty"><strong>Pregled nije uspeo</strong>Otvori fajl u novom tabu.</div>`; }
}

// ---------- prisutnost (online) i „kuca…" ----------
async function initRoom() {
  try { C.room = await window.claude.use('room'); } catch { C.room = null; }
  if (!C.room) return;
  try { C.room.presence({ app: 'planer' }); } catch {}
  C.room.onPeers(peers => {
    C.online = new Set(peers.filter(p => p.kind === 'viewer' && !p.isMe && p.by).map(p => p.by));
    renderChatBadges(); renderFriendsUi(); if (C.full || C.mini) renderChatsSoon();
  });
  C.room.on('typing', m => {
    if (!m.by || m.isMe || !m.data || typeof m.data.cid !== 'string') return;
    const c = chatById(m.data.cid); if (!c || !c.members.includes(m.by)) return;
    if (!C.typing.has(c.cid)) C.typing.set(c.cid, new Map());
    C.typing.get(c.cid).set(m.by, Date.now());
    renderChatsSoon(); setTimeout(renderChatsSoon, 4200);
  });
  C.room.on('call', m => {
    if (!m.by || m.isMe || !m.data) return;
    const c = chatById(m.data.cid); if (!c || !c.members.includes(m.by)) return;
    const url = String(m.data.url || ''); if (!/^https:\/\/meet\.jit\.si\/[A-Za-z0-9-]+$/.test(url)) return;
    toast(`${firstName(m.by)} započinje video poziv${c.kind !== 'dm' ? ' u „' + chatTitle(c) + '"' : ''}.`, { label: 'Otvori čet', fn: () => openMini(c.cid) });
  });
}
function emitTyping(cid) {
  if (!C.room || Date.now() - C.lastTypingEmit < 2500) return;
  C.lastTypingEmit = Date.now();
  C.room.emit('typing', { cid }).catch(() => {});
}
async function startCall(c) {
  const url = `https://meet.jit.si/PlanerIspita-${rid(16).replace(/[^A-Za-z0-9]/g, '')}`;
  const ok = await sendMessage(c, { t: 'call', url });
  if (!ok) return;
  if (C.room) C.room.emit('call', { cid: c.cid, url }).catch(() => {});
  const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; document.body.appendChild(a); a.click(); a.remove();
}

// ---------- obaveštenja o novim porukama ----------
function notifyNew() {
  const p = prof(); if (!p) return;
  for (const c of myChats()) {
    const a = othersAct(c), seen = C.seenAct.get(c.cid);
    if (seen != null && a > seen && isUnread(c)) {
      const who = c.members.find(u => u !== Me.uid && ((F.people.get(u) || {}).act || {})[c.cid] === a);
      toast(`Nova poruka${who ? ' od ' + firstName(who) : ''}${c.kind !== 'dm' ? ' u „' + chatTitle(c) + '"' : ''}`, { label: 'Otvori', fn: () => openMini(c.cid) });
    }
    C.seenAct.set(c.cid, a);
  }
}

// ---------- događaji ----------
function chatRootOf(el) { return el.closest('#miniChat, #chatFull .cconv'); }
async function handleSend(root) {
  const c = chatById(root.dataset.cid || C.active); if (!c) return;
  const ta = root.querySelector('.cin'); const text = ta.value.trim(); if (!text) return;
  if (text.length > 4000) { toast('Poruka je preduga (najviše 4000 znakova).'); return; }
  if (C.edit && C.edit.cid === c.cid) {
    const id = C.edit.id; C.edit = null; ta.value = '';
    await editMessage(c, id, b => { b.text = text; b.edited = Date.now(); });
    renderChatsSoon(); return;
  }
  const reply = C.reply && C.reply.cid === c.cid ? C.reply.id : '';
  C.reply = null; ta.value = ''; if (C.draft) delete C.draft[c.cid];
  ta.style.height = '';
  await sendMessage(c, { t: 'text', text, reply });
}
function chatClick(e) {
  const t = e.target;
  const root = chatRootOf(t); const c = chatById((root && root.dataset.cid) || C.active);
  const oc = t.closest('[data-open-chat]'); if (oc) { C.active = oc.dataset.openChat; C.info = false; C.newChat = null; C.reply = C.edit = C.pollDraft = null; C.mobilePane = 'conv'; syncSubs(); renderFull(); return; }
  if (t.closest('[data-mini-x]')) { closeMini(); return; }
  if (t.closest('[data-expand]')) { const cid = C.mini; closeMini(); C.pendingCid = cid; go('poruke'); return; }
  const pn = t.closest("[data-gopane]"); if (pn) { C.mobilePane = pn.dataset.gopane; renderFull(); return; }
  if (t.closest('[data-new-chat]')) { C.newChat = { sel: new Set(), q: '', name: '', mode: 'all' }; C.mobilePane = 'conv'; renderFull(); return; }
  if (t.closest('[data-new-x]')) { C.newChat = null; renderFull(); return; }
  if (t.closest('[data-open-friends]')) { openFriends(); return; }
  const ns = t.closest('[data-ncsel]'); if (ns) { const s = C.newChat.sel, u = ns.dataset.ncsel; s.has(u) ? s.delete(u) : s.add(u); renderFull(); return; }
  const nm = t.closest('[data-ncmode]'); if (nm) { C.newChat.mode = nm.dataset.ncmode; renderFull(); return; }
  if (t.closest('[data-nc-create]')) {
    const n = C.newChat; const btn = t.closest('[data-nc-create]'); btn.disabled = true;
    createChat([...n.sel], n.name, n.mode).then(cid => { C.newChat = null; if (cid) { C.active = cid; syncSubs(); } renderFull(); });
    return;
  }
  const jf = t.closest('[data-join-fak]'); if (jf) { const p = prof(); p.groups = uniq([...(p.groups || []), jf.dataset.joinFak]); Me.save(); C.active = jf.dataset.joinFak; C.mobilePane = 'conv'; syncSubs(); renderFull(); toast('Pridružio/la si se četu fakulteta.'); return; }
  const lf = t.closest('[data-leave-fak]'); if (lf) { const p = prof(); p.groups = (p.groups || []).filter(x => x !== lf.dataset.leaveFak); Me.save(); C.active = null; C.info = false; syncSubs(); renderFull(); return; }
  const lv = t.closest('[data-leave]'); if (lv) { const p = prof(); p.leftChats = uniq([...(p.leftChats || []), lv.dataset.leave]); Me.save(); C.active = null; C.info = false; syncSubs(); renderFull(); toast('Napustio/la si grupu.'); return; }
  const dl = t.closest('[data-del-chat]'); if (dl) { if (dl.dataset.confirm !== '1') { dl.dataset.confirm = '1'; dl.textContent = 'Klikni ponovo da obrišeš grupu za sve'; return; } const p = prof(); delete p.chatsOwned[dl.dataset.delChat]; Me.save(); C.active = null; C.info = false; syncSubs(); renderFull(); toast('Grupa je obrisana.'); return; }
  if (t.closest('[data-info]')) { C.info = !C.info; renderFull(); return; }
  const cl = t.closest('[data-call]'); if (cl) { const cc = chatById(cl.dataset.call); if (cc) startCall(cc); return; }
  if (!c) return;
  const md = t.closest('[data-mode]'); if (md) { const m = prof().chatsOwned[c.cid]; m.mode = md.dataset.mode; Me.save(); sendMessage(c, { t: 'sys', sys: md.dataset.mode === 'admins' ? 'Sada u grupi pišu samo admini' : 'Sada u grupi pišu svi članovi' }); renderFull(); return; }
  if (t.closest('[data-rename]')) { const v = $('#cname').value.trim().slice(0, 60); prof().chatsOwned[c.cid].name = v; Me.save(); renderFull(); return; }
  const ad = t.closest('[data-admin]'); if (ad) { const m = prof().chatsOwned[c.cid], u = ad.dataset.admin; m.admins = m.admins.includes(u) ? m.admins.filter(x => x !== u) : [...m.admins, u]; Me.save(); renderFull(); return; }
  const kk = t.closest('[data-kick]'); if (kk) { const u = kk.dataset.kick; rotateMembers(c.cid, c.members.filter(x => x !== u)).then(() => { sendMessage(chatById(c.cid), { t: 'sys', sys: `${firstName(u)} je uklonjen/a iz grupe` }); renderFull(); }); return; }
  const am = t.closest('[data-addm]'); if (am) { const u = am.dataset.addm; const m = prof().chatsOwned[c.cid]; (async () => { const raw = m.raw && m.raw[m.kv]; const w = raw ? await wrapKeyFor(u, unb64(raw)) : null; m.members = uniq([...m.members, u]); if (w) m.keys[m.kv][u] = w; Me.save(); await sendMessage(chatById(c.cid), { t: 'sys', sys: `${firstName(Me.uid)} je dodao/la ${firstName(u)}` }); renderFull(); })(); return; }
  if (t.closest('[data-send]')) { handleSend(root); return; }
  if (t.closest('[data-cbar-x]')) { C.reply = C.edit = null; const ta = root.querySelector('.cin'); if (ta) ta.value = ''; renderChatsSoon(); return; }
  const rp = t.closest('[data-mreply]'); if (rp) { const el = root.querySelector(`[data-mid="${CSS.escape(rp.dataset.mreply)}"] .bubble`); C.reply = { cid: c.cid, id: rp.dataset.mreply, preview: (el ? el.textContent : '').trim().slice(0, 80) }; C.edit = null; renderChatsSoon(); setTimeout(() => { const ta = root.querySelector('.cin'); ta && ta.focus(); }, 60); return; }
  const rr = t.closest('[data-mreact]'); if (rr) { C.reactFor = C.reactFor === rr.dataset.mreact ? null : rr.dataset.mreact; renderChatsSoon(); return; }
  const re = t.closest('[data-react]'); if (re) { const id = re.dataset.react, em = re.dataset.emoji; C.reactFor = null; setMyState(c, st => { st.reacts = st.reacts || {}; if (st.reacts[id] === em) delete st.reacts[id]; else st.reacts[id] = em; }).then(renderChatsSoon).catch(() => toast('Reakcija nije sačuvana.')); return; }
  const ed = t.closest('[data-medit]'); if (ed) { const el = root.querySelector(`[data-mid="${CSS.escape(ed.dataset.medit)}"] .tx`); C.edit = { cid: c.cid, id: ed.dataset.medit, text: el ? el.innerText : '' }; C.reply = null; root.querySelector('.cwrap').dataset.for = ''; renderChatsSoon(); setTimeout(() => { const ta = root.querySelector('.cin'); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }, 60); return; }
  const de = t.closest('[data-mdel]'); if (de) { if (de.dataset.confirm !== '1') { de.dataset.confirm = '1'; de.classList.add('warn-btn'); de.title = 'Klikni ponovo za brisanje'; setTimeout(() => { de.dataset.confirm = ''; de.classList.remove('warn-btn'); }, 3000); return; } editMessage(c, de.dataset.mdel, b => { b.del = true; b.text = ''; b.att = null; b.poll = null; }); return; }
  const vo = t.closest('[data-vote]'); if (vo) {
    const mid = vo.dataset.vote, i = +vo.dataset.opt;
    timeline(c).then(tl => { const it = tl.items.find(x => x.id === mid); const multi = it && it.body && it.body.poll && it.body.poll.multi;
      return setMyState(c, st => { st.votes = st.votes || {}; const cur = st.votes[mid] || []; st.votes[mid] = cur.includes(i) ? cur.filter(x => x !== i) : multi ? [...cur, i] : [i]; if (!st.votes[mid].length) delete st.votes[mid]; }); }).then(renderChatsSoon).catch(() => toast('Glas nije sačuvan.'));
    return;
  }
  if (t.closest('[data-poll-new]')) { C.pollDraft = { cid: c.cid, q: '', opts: ['', ''], multi: false }; renderChatsSoon(); setTimeout(() => { const q = root.querySelector('.pdq'); q && q.focus(); }, 60); return; }
  if (t.closest('[data-poll-x]')) { C.pollDraft = null; renderChatsSoon(); return; }
  if (t.closest('[data-poll-add]')) { readPollDraft(root); C.pollDraft.opts.push(''); root.querySelector('.cwrap').dataset.for = ''; renderChatsSoon(); return; }
  if (t.closest('[data-poll-send]')) {
    readPollDraft(root); const d = C.pollDraft, opts = d.opts.map(o => o.trim()).filter(Boolean);
    if (!d.q.trim() || opts.length < 2) { toast('Upiši pitanje i bar dve opcije.'); return; }
    C.pollDraft = null; sendMessage(c, { t: 'poll', poll: { q: d.q.trim(), opts, multi: d.multi } }); return;
  }
  const pv = t.closest('[data-preview]'); if (pv) { openPreview(pv.dataset.preview, pv.dataset.ptype, pv.dataset.pname); return; }
}
function readPollDraft(root) {
  const d = C.pollDraft; if (!d) return;
  const q = root.querySelector('.pdq'); if (q) d.q = q.value;
  root.querySelectorAll('.pdo').forEach(el => { d.opts[+el.dataset.i] = el.value; });
  const m = root.querySelector('.pdm'); if (m) d.multi = m.checked;
}
['#miniChat', '#chatFull'].forEach(sel => {
  const el = $(sel);
  el.addEventListener('click', chatClick);
  el.addEventListener('keydown', e => {
    if (e.target.classList.contains('cin') && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); handleSend(chatRootOf(e.target)); }
    if (e.key === 'Escape' && C.reactFor) { C.reactFor = null; renderChatsSoon(); }
  });
  el.addEventListener('input', e => {
    if (C.pollDraft && e.target.closest('.pdraft')) readPollDraft(chatRootOf(e.target));
    if (e.target.classList.contains('cin')) {
      const root = chatRootOf(e.target), cid = root && root.dataset.cid; e.target.style.height = ''; e.target.style.height = Math.min(140, e.target.scrollHeight) + 'px';
      if (cid && !C.edit) { C.draft = C.draft || {}; C.draft[cid] = e.target.value; }
      if (cid) emitTyping(cid);
    }
  });
  el.addEventListener('change', e => {
    if (e.target.classList.contains('cfile') && e.target.files.length) { const c = chatById(chatRootOf(e.target).dataset.cid); if (c) sendFiles(c, [...e.target.files]); e.target.value = ''; }
  });
  el.addEventListener('paste', e => {
    const files = [...(e.clipboardData && e.clipboardData.files || [])]; if (!files.length) return;
    const root = chatRootOf(e.target); const c = root && chatById(root.dataset.cid); if (!c) return;
    e.preventDefault(); sendFiles(c, files);
  });
  el.addEventListener('dragover', e => { if (chatRootOf(e.target)) { e.preventDefault(); chatRootOf(e.target).classList.add('drag'); } });
  el.addEventListener('dragleave', e => { const r = chatRootOf(e.target); if (r) r.classList.remove('drag'); });
  el.addEventListener('drop', e => { const r = chatRootOf(e.target); if (!r) return; e.preventDefault(); r.classList.remove('drag'); const c = chatById(r.dataset.cid); if (c && e.dataTransfer.files.length) sendFiles(c, [...e.dataTransfer.files]); });
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') markRead(); });

// pokretanje (posle učitavanja profila)
async function initChat() {
  if (Me.mode !== 'db' || !prof() || !prof().onboarded) { renderChatBadges(); return; }
  C.on = true;
  try { await ensureKeys(); } catch {}
  try { C.assets = await window.claude.use('assets'); } catch { C.assets = null; }
  initRoom();
  renderChatBadges();
}
// poziva se na svaku promenu javnih kartica
function onPeopleChanged() {
  if (!C.on) return;
  ensureWrapped().catch(() => {});
  notifyNew(); syncSubs(); renderChatsSoon();
}

