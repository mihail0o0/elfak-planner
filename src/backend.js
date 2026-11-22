// ================= Supabase: prijava + isti interfejs kao claude.ai (db, user, room, assets) =================
// Aplikacija poziva window.claude.use('db' | 'user' | 'room' | 'assets'); ovde ih pravimo nad Supabase-om.
(function () {
  const CFG = window.PLANER_CONFIG || {};
  if (!CFG.supabaseUrl || !CFG.supabaseKey || !window.supabase) { window.__auth = null; return; }
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' } });
  const LS_GUEST = 'planer:guest', LS_PENDING = 'planer:pending-email';
  const ls = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} } };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const redirectTo = location.origin + location.pathname;
  let resolveReady; const READY = new Promise(r => { resolveReady = r; });
  const A = { mode: 'pending', user: null, session: null, sb };

  // ---------- prijava ----------
  const ICON_G = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';
  const ICON_F = '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.96.93-1.96 1.89v2.25h3.33l-.53 3.49h-2.8V24C19.61 23.1 24 18.1 24 12.07z"/></svg>';
  let gateState = 'login', gateMsg = '', gateErr = '', busy = false;
  function gateEl() {
    let g = document.getElementById('authGate');
    if (!g) { g = document.createElement('div'); g.id = 'authGate'; g.className = 'authgate'; document.body.appendChild(g); g.addEventListener('click', onGateClick); g.addEventListener('submit', onGateSubmit); }
    return g;
  }
  function renderGate() {
    const g = gateEl(); g.hidden = false; document.body.classList.add('gate-open');
    const pending = ls.get(LS_PENDING) || '';
    let body = '';
    if (gateState === 'check') {
      body = `<div class="agicon">✉️</div><h2>Potvrdi email</h2><p class="alead">Poslali smo link za potvrdu na <b>${esc(pending)}</b>. Klikni na njega, pa se prijavi.</p>
        ${gateMsg ? `<div class="aok">${esc(gateMsg)}</div>` : ''}${gateErr ? `<div class="aerr">${esc(gateErr)}</div>` : ''}
        <button class="btn primary ablock" data-a="resend" ${busy ? 'disabled' : ''}>Pošalji link ponovo</button>
        <button class="btn ablock" data-a="tologin">Već sam potvrdio/la – prijava</button>
        <button class="linkbtn acenter" data-a="guest">Nastavi kao gost dok ne potvrdiš</button>`;
    } else if (gateState === 'reset') {
      body = `<h2>Zaboravljena šifra</h2><p class="alead">Upiši email i poslaćemo ti link za novu šifru.</p>
        <form class="aform" data-f="reset"><label class="field" for="aEmail">Email<input id="aEmail" type="email" autocomplete="email" required value="${esc(pending)}"></label>
        ${gateMsg ? `<div class="aok">${esc(gateMsg)}</div>` : ''}${gateErr ? `<div class="aerr">${esc(gateErr)}</div>` : ''}
        <button class="btn primary ablock" ${busy ? 'disabled' : ''}>Pošalji link</button></form>
        <button class="linkbtn acenter" data-a="tologin">Nazad na prijavu</button>`;
    } else if (gateState === 'newpass') {
      body = `<h2>Nova šifra</h2><form class="aform" data-f="newpass"><label class="field" for="aPass">Nova šifra<input id="aPass" type="password" minlength="8" autocomplete="new-password" required></label>
        ${gateErr ? `<div class="aerr">${esc(gateErr)}</div>` : ''}<button class="btn primary ablock" ${busy ? 'disabled' : ''}>Sačuvaj šifru</button></form>`;
    } else {
      const reg = gateState === 'register';
      body = `<div class="alogo">${document.querySelector('.rlogo') ? document.querySelector('.rlogo').innerHTML : ''}</div>
        <h2>${reg ? 'Napravi nalog' : 'Prijavi se'}</h2><p class="alead">Planiraj ispite, prati rokove i uči zajedno sa prijateljima.</p>
        <button class="btn ablock aprov" data-a="google">${ICON_G} Nastavi sa Google nalogom</button>
        <button class="btn ablock aprov fb" data-a="facebook">${ICON_F} Nastavi sa Facebook nalogom</button>
        <div class="aor"><span>ili email</span></div>
        <form class="aform" data-f="${reg ? 'register' : 'login'}">
          <label class="field" for="aEmail">Email<input id="aEmail" type="email" autocomplete="email" required></label>
          <label class="field" for="aPass">Šifra${reg ? ' (najmanje 8 znakova)' : ''}<input id="aPass" type="password" minlength="${reg ? 8 : 1}" autocomplete="${reg ? 'new-password' : 'current-password'}" required></label>
          ${gateErr ? `<div class="aerr">${esc(gateErr)}</div>` : ''}${gateMsg ? `<div class="aok">${esc(gateMsg)}</div>` : ''}
          <button class="btn primary ablock" ${busy ? 'disabled' : ''}>${busy ? 'Sačekaj…' : reg ? 'Napravi nalog' : 'Prijavi se'}</button>
        </form>
        <div class="arow">${reg ? '<span>Već imaš nalog?</span><button class="linkbtn" data-a="tologin">Prijavi se</button>' : '<button class="linkbtn" data-a="toreset">Zaboravljena šifra?</button><span class="grow"></span><button class="linkbtn" data-a="toregister">Napravi nalog</button>'}</div>
        <div class="aguest"><button class="btn ghost ablock" data-a="guest">Nastavi kao gost</button><span>Gost može da planira ispite na ovom uređaju. Prijatelji i poruke traže nalog.</span></div>`;
    }
    g.innerHTML = `<div class="acard" role="dialog" aria-modal="true" aria-label="Prijava">${body}</div>`;
    const f = g.querySelector('input'); if (f) setTimeout(() => f.focus(), 30);
  }
  function hideGate() { const g = document.getElementById('authGate'); if (g) g.hidden = true; document.body.classList.remove('gate-open'); }
  const msgOf = e => {
    const m = (e && (e.code || e.message)) || '';
    if (/invalid.*credentials|invalid_credentials/i.test(m)) return 'Pogrešan email ili šifra.';
    if (/already.*registered|user_already_exists/i.test(m)) return 'Nalog sa ovim email-om već postoji. Prijavi se.';
    if (/weak_password|password/i.test(m)) return 'Šifra je preslaba. Upiši najmanje 8 znakova.';
    if (/rate|too many/i.test(m)) return 'Previše pokušaja. Sačekaj minut pa pokušaj ponovo.';
    if (/provider.*not enabled|unsupported provider/i.test(m)) return 'Ova vrsta prijave još nije uključena. Koristi email ili drugi nalog.';
    return 'Nešto nije u redu. Proveri vezu i pokušaj ponovo.';
  };
  async function onGateSubmit(e) {
    e.preventDefault(); if (busy) return;
    const f = e.target.dataset.f, email = (document.getElementById('aEmail') || {}).value, pass = (document.getElementById('aPass') || {}).value;
    gateErr = gateMsg = ''; busy = true; renderGate();
    try {
      if (f === 'login') {
        const { error } = await sb.auth.signInWithPassword({ email, password: pass });
        if (error) { if (/not.*confirmed|email_not_confirmed/i.test(error.code || error.message)) { ls.set(LS_PENDING, email); gateState = 'check'; } else gateErr = msgOf(error); }
      } else if (f === 'register') {
        const { data, error } = await sb.auth.signUp({ email, password: pass, options: { emailRedirectTo: redirectTo } });
        if (error) gateErr = msgOf(error);
        else if (data.session) { /* potvrda je isključena u projektu */ }
        else { ls.set(LS_PENDING, email); gateState = 'check'; }
      } else if (f === 'reset') {
        ls.set(LS_PENDING, email);
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo });
        if (error) gateErr = msgOf(error); else gateMsg = 'Ako nalog postoji, link je poslat. Proveri inbox.';
      } else if (f === 'newpass') {
        const { error } = await sb.auth.updateUser({ password: pass });
        if (error) gateErr = msgOf(error); else { gateState = 'login'; location.replace(redirectTo); return; }
      }
    } catch (err) { gateErr = msgOf(err); }
    busy = false; if (A.mode === 'pending' || gateState !== 'login' || gateErr || gateMsg) renderGate();
  }
  async function onGateClick(e) {
    const b = e.target.closest('[data-a]'); if (!b) return;
    const a = b.dataset.a; gateErr = gateMsg = '';
    if (a === 'google' || a === 'facebook') {
      const { error } = await sb.auth.signInWithOAuth({ provider: a, options: { redirectTo } });
      if (error) { gateErr = msgOf(error); renderGate(); }
      return;
    }
    if (a === 'guest') { ls.set(LS_GUEST, '1'); finish('guest', null); return; }
    if (a === 'tologin') gateState = 'login';
    if (a === 'toregister') gateState = 'register';
    if (a === 'toreset') gateState = 'reset';
    if (a === 'resend') {
      busy = true; renderGate();
      const { error } = await sb.auth.resend({ type: 'signup', email: ls.get(LS_PENDING) || '', options: { emailRedirectTo: redirectTo } });
      busy = false; if (error) gateErr = msgOf(error); else gateMsg = 'Link je ponovo poslat.';
    }
    renderGate();
  }

  // ---------- traka gore (gost / nepotvrđen email) ----------
  function renderBar() {
    let bar = document.getElementById('authBar');
    const wrap = document.querySelector('.wrap');
    if (A.mode === 'user' || !wrap) { if (bar) bar.remove(); return; }
    if (!bar) { bar = document.createElement('div'); bar.id = 'authBar'; bar.className = 'authbar'; wrap.insertBefore(bar, wrap.firstChild); bar.addEventListener('click', onBarClick); }
    const pending = ls.get(LS_PENDING);
    bar.innerHTML = pending
      ? `<span><b>Potvrdi email.</b> Poslali smo link na ${esc(pending)}. Dok ne potvrdiš, prijatelji i poruke nisu dostupni.</span><button class="btn sm" data-b="resend">Pošalji ponovo</button><button class="btn primary sm" data-b="login">Prijavi se</button>`
      : `<span><b>Koristiš aplikaciju kao gost.</b> Plan se čuva samo na ovom uređaju. Prijavi se da bi dodao/la prijatelje i slao/la poruke.</span><button class="btn primary sm" data-b="login">Prijavi se ili napravi nalog</button>`;
  }
  async function onBarClick(e) {
    const b = e.target.closest('[data-b]'); if (!b) return;
    if (b.dataset.b === 'login') { ls.set(LS_GUEST, null); gateState = ls.get(LS_PENDING) ? 'check' : 'login'; renderGate(); }
    if (b.dataset.b === 'resend') { b.disabled = true; const { error } = await sb.auth.resend({ type: 'signup', email: ls.get(LS_PENDING) || '', options: { emailRedirectTo: redirectTo } }); b.textContent = error ? 'Greška, pokušaj kasnije' : 'Poslato'; }
  }

  function finish(mode, session) {
    const first = A.mode === 'pending';
    A.mode = mode; A.session = session; A.user = session ? session.user : null;
    if (mode === 'user') { ls.set(LS_GUEST, null); ls.set(LS_PENDING, null); }
    hideGate();
    if (first) resolveReady(A); else location.reload();
    const tick = () => { if (document.querySelector('.wrap')) renderBar(); else setTimeout(tick, 50); }; tick();
  }
  const verified = u => !!(u && (u.email_confirmed_at || u.confirmed_at) && !u.is_anonymous);
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') { gateState = 'newpass'; renderGate(); return; }
    if (event === 'SIGNED_IN' && A.mode !== 'pending' && A.mode !== 'user' && verified(session && session.user)) location.reload();
    if (event === 'SIGNED_OUT' && A.mode === 'user') location.reload();
  });
  (async () => {
    const { data } = await sb.auth.getSession();
    const s = data && data.session;
    if (s && verified(s.user)) finish('user', s);
    else if (ls.get(LS_GUEST) === '1') finish('guest', null);
    else { gateState = ls.get(LS_PENDING) ? 'check' : 'login'; const go = () => (document.body ? renderGate() : setTimeout(go, 20)); go(); }
  })();

  // ---------- javni API za podešavanja ----------
  window.__auth = {
    get mode() { return A.mode; }, get user() { return A.user; },
    ready: READY,
    profile() {
      const u = A.user; if (!u) return null; const m = u.user_metadata || {};
      const full = (m.full_name || m.name || '').trim(), parts = full.split(/\s+/);
      return { ime: m.given_name || parts[0] || '', prezime: m.family_name || parts.slice(1).join(' ') || '', email: u.email || '', avatar: m.avatar_url || m.picture || '' };
    },
    async identities() { try { const { data } = await sb.auth.getUserIdentities(); return (data && data.identities || []).map(i => i.provider); } catch { return []; } },
    async link(provider) { const { error } = await sb.auth.linkIdentity({ provider, options: { redirectTo } }); if (error) throw error; },
    async signOut() { await sb.auth.signOut(); ls.set(LS_GUEST, null); location.replace(redirectTo); },
    login() { ls.set(LS_GUEST, null); gateState = 'login'; renderGate(); },
    message: e => msgOf(e)
  };
  window.__blobUrl = id => `${CFG.supabaseUrl}/storage/v1/object/public/attachments/${encodeURIComponent(id)}`;

  // ---------- db: dokumenti nad tabelom `docs` ----------
  const parentOf = p => p.replace(/\/[^/]+$/, '');
  const clone = v => v == null ? v : JSON.parse(JSON.stringify(v));
  const snapDoc = (path, data) => ({ id: path.split('/').pop(), exists: data != null, data: () => clone(data), metadata: { fromCache: false, hasPendingWrites: false } });
  const qsnap = (rows) => { const docs = rows.map(r => snapDoc(r.path, r.data)); return { docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false, hasPendingWrites: false }, docChanges: () => [] }; };
  const dbErr = e => ({ code: e && (e.code === '42501' || /row-level security|permission/i.test(e.message || '')) ? 'not_granted' : /too large/i.test((e && e.message) || '') ? 'invalid_argument' : 'unavailable', message: (e && e.message) || 'greška' });
  const docListeners = new Map(), collListeners = new Map(), collCache = new Map();
  function emitChange(path, data) {
    const ls1 = docListeners.get(path); if (ls1) ls1.forEach(l => l.next(snapDoc(path, data)));
    const parent = parentOf(path), cache = collCache.get(parent);
    if (cache) { if (data == null) cache.delete(path); else cache.set(path, data); const rows = [...cache.entries()].map(([p, d]) => ({ path: p, data: d })).sort((a, b) => a.path.localeCompare(b.path)); (collListeners.get(parent) || []).forEach(l => l.next(qsnap(rows))); }
  }
  let rtStarted = false;
  function startRealtime() {
    if (rtStarted) return; rtStarted = true;
    sb.channel('docs-all').on('postgres_changes', { event: '*', schema: 'public', table: 'docs' }, p => {
      const path = (p.new && p.new.path) || (p.old && p.old.path); if (!path) return;
      emitChange(path, p.eventType === 'DELETE' ? null : p.new.data);
    }).subscribe();
  }
  function doc(path) {
    return {
      id: path.split('/').pop(), path,
      async get() { const { data, error } = await sb.from('docs').select('data').eq('path', path).maybeSingle(); if (error) throw dbErr(error); return snapDoc(path, data ? data.data : null); },
      async set(d) { const { error } = await sb.from('docs').upsert({ path, parent: parentOf(path), data: d }); if (error) throw dbErr(error); emitChange(path, clone(d)); },
      async update(d) { const cur = await this.get(); if (!cur.exists) throw { code: 'invalid_argument', message: 'missing' }; await this.set({ ...cur.data(), ...d }); },
      async delete() { const { error } = await sb.from('docs').delete().eq('path', path); if (error) throw dbErr(error); emitChange(path, null); },
      onSnapshot(next, err) {
        startRealtime();
        const l = { next }; if (!docListeners.has(path)) docListeners.set(path, new Set()); docListeners.get(path).add(l);
        this.get().then(next, e => err && err(e));
        return () => { const s = docListeners.get(path); if (s) s.delete(l); };
      },
      collection: sub => coll(path + '/' + sub)
    };
  }
  function coll(path, lim = 1000) {
    const q = {
      path, doc: id => doc(path + '/' + (id || Math.random().toString(36).slice(2, 12))),
      limit: n => coll(path, n),
      async get() { const { data, error } = await sb.from('docs').select('path,data').eq('parent', path).order('path').limit(lim); if (error) throw dbErr(error); return qsnap(data || []); },
      onSnapshot(next, err) {
        startRealtime();
        const l = { next }; if (!collListeners.has(path)) collListeners.set(path, new Set()); collListeners.get(path).add(l);
        q.get().then(s => { collCache.set(path, new Map(s.docs.map(d => [path + '/' + d.id, d.data()]))); next(s); }, e => err && err(e));
        return () => { const s = collListeners.get(path); if (s) s.delete(l); };
      },
      add: async d => { const r = q.doc(); await r.set(d); return r; }
    };
    return q;
  }
  const DB = { doc, collection: coll };

  // ---------- room: online status i događaji ----------
  let ROOM = null;
  function room(uid) {
    if (ROOM) return ROOM;
    const ch = sb.channel('planer-room', { config: { presence: { key: uid }, broadcast: { self: false } } });
    const peersCbs = [], handlers = {}; let mine = {};
    const peers = () => Object.entries(ch.presenceState()).map(([k, v]) => ({ by: k, peer: k, isMe: k === uid, kind: 'viewer', guest: false, presence: (v && v[0]) || {}, updatedAt: Date.now() }));
    ch.on('presence', { event: 'sync' }, () => { const p = peers(); peersCbs.forEach(cb => cb(p)); });
    ch.on('broadcast', { event: '*' }, m => { const pl = m.payload || {}; (handlers[m.event] || []).forEach(h => h({ topic: m.event, data: pl.data, by: pl.by, peer: pl.by, isMe: false, kind: 'viewer', guest: false })); });
    ch.subscribe(st => { if (st === 'SUBSCRIBED') ch.track({ ...mine, uid }); });
    ROOM = {
      presence: async p => { mine = { ...mine, ...p }; await ch.track({ ...mine, uid }); },
      onPeers: cb => { peersCbs.push(cb); cb(peers()); return () => { const i = peersCbs.indexOf(cb); if (i >= 0) peersCbs.splice(i, 1); }; },
      on: (t, h) => { (handlers[t] = handlers[t] || []).push(h); return () => {}; },
      emit: async (t, d) => { await ch.send({ type: 'broadcast', event: t, payload: { data: d, by: uid } }); }
    };
    return ROOM;
  }
  // ---------- assets: prilozi u Storage bucket-u ----------
  const ASSETS = {
    async upload(blob, o) {
      const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
      const type = (o && o.type) || blob.type || 'application/octet-stream';
      const { error } = await sb.storage.from('attachments').upload(id, blob, { contentType: type, upsert: false });
      if (error) throw { code: /size|large/i.test(error.message) ? 'too_large' : /quota/i.test(error.message) ? 'quota_exceeded' : 'not_granted', message: error.message };
      return { id, url: window.__blobUrl(id), sizeBytes: blob.size, contentType: type };
    }
  };

  window.claude = {
    async use(name) {
      await READY;
      const full = A.mode === 'user';
      if (name === 'db') return DB;
      if (name === 'user') return { id: async () => (full ? A.user.id : null), isOwner: async () => false, canEdit: async () => full, me: async () => ({ id: full ? A.user.id : null, name: '' }) };
      if (name === 'room') return full ? room(A.user.id) : null;
      if (name === 'assets') return full ? ASSETS : null;
      return null;
    }
  };
})();
