// ===== Squircle =====
// Chrome/Edge: CSS `corner-shape: squircle` (u stilu). Ostali pregledači: ovaj kod crta
// glatke uglove (Figma-style smoothing) kao SVG pozadinu sa ivicom i senkom koja prati oblik.
(function () {
  const SUPPORTED = window.CSS && CSS.supports && CSS.supports('corner-shape', 'squircle');
  const SMOOTH = 0.8;
  const SEL = '.btn, .iconbtn, .card, .chip, .seg, .seg button, .mcell, .search input, .dates input, .field input, .field select, .sugg, .subj, .ym, .doc, .stat > div, .drop, .preview, dialog, .toast, .logo, .banner';
  const rad = d => d * Math.PI / 180;

  function corner(r, budget) {
    let s = SMOOTH, p = (1 + s) * r;
    if (p > budget) { s = Math.max(0, Math.min(budget / r - 1, s)); p = Math.min(p, budget); }
    const arc = 90 * (1 - s);
    const L = Math.sin(rad(arc / 2)) * r * Math.SQRT2;
    const alpha = (90 - arc) / 2;
    const p34 = r * Math.tan(rad(alpha / 2));
    const beta = 45 * s;
    const c = p34 * Math.cos(rad(beta));
    const d = c * Math.tan(rad(beta));
    const b = (p - L - c - d) / 3, a = 2 * b;
    return { a, b, c, d, p, L, r };
  }
  function path(x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    if (r < 0.5) return `M${x} ${y}h${w}v${h}h${-w}Z`;
    const k = corner(r, Math.min(w, h) / 2), { a, b, c, d, p, L } = k, f = n => +n.toFixed(3);
    return [
      `M${f(x + w - p)} ${f(y)}`,
      `c${f(a)} 0 ${f(a + b)} 0 ${f(a + b + c)} ${f(d)}`,
      `a${f(r)} ${f(r)} 0 0 1 ${f(L)} ${f(L)}`,
      `c${f(d)} ${f(c)} ${f(d)} ${f(b + c)} ${f(d)} ${f(a + b + c)}`,
      `L${f(x + w)} ${f(y + h - p)}`,
      `c0 ${f(a)} 0 ${f(a + b)} ${f(-d)} ${f(a + b + c)}`,
      `a${f(r)} ${f(r)} 0 0 1 ${f(-L)} ${f(L)}`,
      `c${f(-c)} ${f(d)} ${f(-(b + c))} ${f(d)} ${f(-(a + b + c))} ${f(d)}`,
      `L${f(x + p)} ${f(y + h)}`,
      `c${f(-a)} 0 ${f(-(a + b))} 0 ${f(-(a + b + c))} ${f(-d)}`,
      `a${f(r)} ${f(r)} 0 0 1 ${f(-L)} ${f(-L)}`,
      `c${f(-d)} ${f(-c)} ${f(-d)} ${f(-(b + c))} ${f(-d)} ${f(-(a + b + c))}`,
      `L${f(x)} ${f(y + p)}`,
      `c0 ${f(-a)} 0 ${f(-(a + b))} ${f(d)} ${f(-(a + b + c))}`,
      `a${f(r)} ${f(r)} 0 0 1 ${f(L)} ${f(-L)}`,
      `c${f(c)} ${f(-d)} ${f(b + c)} ${f(-d)} ${f(a + b + c)} ${f(-d)}Z`
    ].join('');
  }
  window.squirclePath = path;
  if (SUPPORTED) return;

  const visible = col => col && col !== 'transparent' && !/rgba?\([^)]*,\s*0\)$/.test(col) && !/\/\s*0\)$/.test(col);
  function paint(el) {
    if (!el.isConnected) return;
    el.style.transition = 'none'; // tranzicije bi vratile međuvrednost boje
    el.classList.remove('sq-on');
    const cs = getComputedStyle(el);
    const r = parseFloat(cs.borderTopLeftRadius) || 0;
    const w = el.offsetWidth, h = el.offsetHeight;
    if (!r || !w || !h || cs.display === 'none') return;
    const bg = cs.backgroundColor, bw = parseFloat(cs.borderTopWidth) || 0, bc = cs.borderTopColor, dashed = cs.borderTopStyle === 'dashed';
    const sh = cs.boxShadow, outer = !!sh && sh !== 'none' && sh.split(/,(?![^(]*\))/).some(x => !/inset/.test(x));
    const glow = sh && /inset/.test(sh) && /255,\s*255,\s*255|255 255 255/.test(sh);
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;
    if (glow) svg += `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="${Math.min(1, 10 / h)}"><stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>`;
    if (bw > 0 && visible(bc) && !dashed && visible(bg)) {
      svg += `<path d="${path(0, 0, w, h, r)}" fill="${bc}"/>`;
      svg += `<path d="${path(bw, bw, w - 2 * bw, h - 2 * bw, Math.max(0, r - bw))}" fill="${bg}"/>`;
    } else {
      if (visible(bg)) svg += `<path d="${path(0, 0, w, h, r)}" fill="${bg}"/>`;
      if (bw > 0 && visible(bc)) svg += `<path d="${path(bw / 2, bw / 2, w - bw, h - bw, Math.max(0, r - bw / 2))}" fill="none" stroke="${bc}" stroke-width="${bw}"${dashed ? ` stroke-dasharray="${bw * 4} ${bw * 3}"` : ''}/>`;
    }
    if (glow) svg += `<path d="${path(0, 0, w, h, r)}" fill="url(#g)"/>`;
    svg += '</svg>';
    el.style.setProperty('--sq-img', `url("data:image/svg+xml,${encodeURIComponent(svg)}")`);
    el.style.setProperty('--sq-drop', outer ? 'var(--drop)' : 'none');
    el.classList.add('sq-on');
  }

  const ro = new ResizeObserver(entries => { for (const e of entries) schedule(e.target); });
  const pending = new Set(); let raf = 0;
  function schedule(el) { pending.add(el); if (!raf) raf = requestAnimationFrame(flush); }
  function flush() { raf = 0; const els = [...pending]; pending.clear(); els.forEach(paint); }
  function scan(root) {
    const list = root.matches && root.matches(SEL) ? [root] : [];
    if (root.querySelectorAll) list.push(...root.querySelectorAll(SEL));
    for (const el of list) { if (!el.dataset.sq) { el.dataset.sq = '1'; ro.observe(el); } schedule(el); }
  }
  function repaintAll() { document.querySelectorAll('[data-sq]').forEach(schedule); }
  const strip = v => (v || '').replace(/\bsq-on\b/g, '').trim();
  new MutationObserver(recs => {
    for (const r of recs) {
      if (r.type === 'childList') r.addedNodes.forEach(n => n.nodeType === 1 && scan(n));
      else if (r.attributeName === 'class' && strip(r.oldValue) === strip(r.target.getAttribute('class'))) continue;
      else if (r.target.dataset && r.target.dataset.sq) schedule(r.target);
      else if (r.target === document.documentElement) repaintAll();
    }
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['class', 'aria-pressed', 'aria-selected', 'open', 'data-theme', 'disabled'] });
  const hov = e => { const el = e.target.closest && e.target.closest('[data-sq]'); if (el) setTimeout(() => schedule(el), 0); };
  ['pointerover', 'pointerout', 'focusin', 'focusout', 'pointerdown', 'pointerup'].forEach(t => document.addEventListener(t, hov, true));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', repaintAll);
  if (document.fonts) document.fonts.ready.then(repaintAll);
  scan(document.body);
})();
