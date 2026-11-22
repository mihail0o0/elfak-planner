// ===== Jezgro: transliteracija + parsiranje rasporeda ispita =====
const CYR = {
  'А':'A','Б':'B','В':'V','Г':'G','Д':'D','Ђ':'Đ','Е':'E','Ж':'Ž','З':'Z','И':'I','Ј':'J','К':'K','Л':'L','Љ':'Lj','М':'M','Н':'N','Њ':'Nj','О':'O','П':'P','Р':'R','С':'S','Т':'T','Ћ':'Ć','У':'U','Ф':'F','Х':'H','Ц':'C','Ч':'Č','Џ':'Dž','Ш':'Š',
  'а':'a','б':'b','в':'v','г':'g','д':'d','ђ':'đ','е':'e','ж':'ž','з':'z','и':'i','ј':'j','к':'k','л':'l','љ':'lj','м':'m','н':'n','њ':'nj','о':'o','п':'p','р':'r','с':'s','т':'t','ћ':'ć','у':'u','ф':'f','х':'h','ц':'c','ч':'č','џ':'dž','ш':'š'
};
function toLatin(s) {
  if (!s) return '';
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i], t = CYR[ch];
    if (t === undefined) { out += ch; continue; }
    // Lj/Nj/Dž u reči pisanoj velikim slovima -> LJ/NJ/DŽ
    if (t.length === 2 && ch === ch.toUpperCase()) {
      const nx = s[i + 1] || '', pv = s[i - 1] || '';
      const isUp = c => c && c !== c.toLowerCase();
      if (isUp(nx) || (!nx.trim() && isUp(pv))) { out += t.toUpperCase(); continue; }
    }
    out += t;
  }
  return out;
}
// za pretragu: latinica, mala slova, bez dijakritika
function fold(s) {
  return toLatin(String(s || '')).toLowerCase()
    .replace(/đ/g, 'dj').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'avg', 'sep', 'okt', 'nov', 'dec'];
function monthFromWord(w) {
  const f = fold(w);
  for (let i = 0; i < 12; i++) if (f.startsWith(MONTHS[i])) return i + 1;
  if (f.startsWith('aug')) return 8;
  return 0;
}
const pad = n => String(n).padStart(2, '0');

// "OAS 2026 1 SVI 4OEZ1O01 Matematika 1 subota, 5. decembar 2026. 9:00:00"
const RE_WORD = /^(\S+)\s+(\d{4})\s+(\d{1,2})\s+(\S+)\s+(\S+)\s+(.+?)\s+(?:\S+,\s*)?(\d{1,2})\.\s*([^\s\d.]+)\s+(\d{4})\.?\s+(\d{1,2})[:.](\d{2})(?:[:.]\d{2})?\s*h?$/;
// "... 05.12.2026. 9:00"
const RE_NUM = /^(\S+)\s+(\d{4})\s+(\d{1,2})\s+(\S+)\s+(\S+)\s+(.+?)\s+(?:\S+,\s*)?(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})\.?\s+(\d{1,2})[:.](\d{2})(?:[:.]\d{2})?\s*h?$/;

// Jedan red teksta -> red ispita (kompaktni niz) ili null
// Red: [nivo, akreditacija, semestar, modul, sifra, predmet, 'YYYY-MM-DD', 'HH:MM']
function parseLine(raw) {
  const line = toLatin(raw).replace(/\s+/g, ' ').trim();
  if (!line) return null;
  let m = line.match(RE_WORD), mon;
  if (m) mon = monthFromWord(m[8]);
  else if ((m = line.match(RE_NUM))) mon = +m[8];
  if (!m || !mon || mon > 12) return null;
  const day = +m[7];
  if (day < 1 || day > 31) return null;
  return [m[1], +m[2], +m[3], m[4], m[5], m[6].trim(),
    `${m[9]}-${pad(mon)}-${pad(day)}`, `${pad(+m[10])}:${m[11]}`];
}
function isHeader(raw) { return /nivo|predmet|šifra|sifra/i.test(toLatin(raw)) && !/\d{4}\./.test(raw); }

function parseLines(lines) {
  const rows = [], bad = [];
  for (const l of lines) {
    if (!l.trim() || isHeader(l)) continue;
    const r = parseLine(l);
    if (r) rows.push(r); else bad.push(toLatin(l).replace(/\s+/g, ' ').trim());
  }
  return { rows, bad };
}

// pdf.js dokument -> redovi teksta (grupisanje po y, sortiranje po x)
async function pdfToLines(pdf) {
  const lines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const items = tc.items.filter(it => it.str && it.str.trim() !== '' || (it.str === ' '))
      .map(it => ({ s: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: Math.abs(it.transform[3]) || 8 }));
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const groups = [];
    for (const it of items) {
      const g = groups.find(g => Math.abs(g.y - it.y) <= Math.max(2, it.h * 0.35));
      if (g) g.items.push(it); else groups.push({ y: it.y, items: [it] });
    }
    groups.sort((a, b) => b.y - a.y);
    for (const g of groups) {
      g.items.sort((a, b) => a.x - b.x);
      let s = '', end = null;
      for (const it of g.items) {
        if (end !== null && it.x - end > 1) s += ' ';
        s += it.s; end = it.x + it.w;
      }
      lines.push(s);
    }
    page.cleanup && page.cleanup();
  }
  return lines;
}

// pogađanje roka i školske godine
const ROKOVI = [
  ['januarski', 'Januarski'], ['februarski', 'Februarski'], ['martovski', 'Martovski'], ['aprilski', 'Aprilski'],
  ['majski', 'Majski'], ['junski', 'Junski'], ['julski', 'Julski'], ['avgustovski', 'Avgustovski'],
  ['septembarski', 'Septembarski'], ['oktobarski', 'Oktobarski'], ['oktobarski2', 'Oktobarski 2'],
  ['novembarski', 'Novembarski'], ['decembarski', 'Decembarski']
];
const ROK_BY_MONTH = { 1: 'januarski', 2: 'februarski', 3: 'martovski', 4: 'aprilski', 5: 'majski', 6: 'junski', 7: 'julski', 8: 'avgustovski', 9: 'septembarski', 10: 'oktobarski', 11: 'novembarski', 12: 'decembarski' };
function guessMeta(fileName, rows) {
  const f = fold(fileName || '');
  let rok = '';
  for (const [k] of ROKOVI) if (k !== 'oktobarski2' && f.includes(k.slice(0, 5))) { rok = k; break; }
  if (!rok) { const mm = f.match(/(jan|feb|mart|apr|maj|jun|jul|avg|sept|okt|nov|dec)/); if (mm) rok = ROK_BY_MONTH[monthFromWord(mm[1])]; }
  if (/okt\w*\s*(2|ii)\b|oktobarski[-_ ]?2/.test(f)) rok = 'oktobarski2';
  const cnt = {};
  for (const r of rows) { const k = r[6].slice(0, 7); cnt[k] = (cnt[k] || 0) + 1; }
  const top = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
  if (!rok && top) rok = ROK_BY_MONTH[+top[0].slice(5, 7)];
  let godina = '';
  const gm = f.match(/(20\d\d)\s*[-_/]\s*(20\d\d)/);
  if (gm) godina = `${gm[1]}/${gm[2]}`;
  else if (top) { const y = +top[0].slice(0, 4), mo = +top[0].slice(5, 7); godina = mo >= 10 ? `${y}/${y + 1}` : `${y - 1}/${y}`; }
  return { rok: rok || 'januarski', godina };
}
function rokLabel(k) { const r = ROKOVI.find(r => r[0] === k); return r ? r[1] : k; }
function rokId(godina, rok) { return `${godina.replace('/', '-')}__${rok}`; }

if (typeof module !== 'undefined') module.exports = { toLatin, fold, parseLine, parseLines, pdfToLines, guessMeta, rokLabel, rokId, ROKOVI };
