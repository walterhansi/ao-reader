// Offline-Wörterbuch Englisch → Deutsch (Daten: Ding, TU Chemnitz, GPL)
// Wird nur auf Geräten benutzt, auf denen es heruntergeladen wurde. Ohne Download wird hier nichts geöffnet.
// Speicher: eigene IndexedDB 'ao-dict' (nicht im Backup), Teildateien je Zwei-Buchstaben-Präfix.
import { openZip } from './zip.js';

const DB = 'ao-dict';
const FLAG = 'ao-dict';
let dbP = null;

export function dictInstalled() {
  try { return !!localStorage.getItem(FLAG); } catch (e) { return false; }
}
export function dictMeta() {
  try { return JSON.parse(localStorage.getItem(FLAG) || 'null'); } catch (e) { return null; }
}

function openDb() {
  if (!dbP) {
    dbP = new Promise(function (resolve, reject) {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = function () { if (!req.result.objectStoreNames.contains('shards')) req.result.createObjectStore('shards'); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { dbP = null; reject(req.error); };
    });
  }
  return dbP;
}
function putMany(pairs) {
  return openDb().then(function (d) {
    return new Promise(function (resolve, reject) {
      const t = d.transaction('shards', 'readwrite');
      const s = t.objectStore('shards');
      for (let i = 0; i < pairs.length; i++) s.put(pairs[i][1], pairs[i][0]);
      t.oncomplete = function () { resolve(); };
      t.onerror = function () { reject(t.error); };
      t.onabort = function () { reject(t.error || new Error('Speicher voll?')); };
    });
  });
}
function getShard(p) {
  return openDb().then(function (d) {
    return new Promise(function (resolve, reject) {
      const r = d.transaction('shards', 'readonly').objectStore('shards').get(p);
      r.onsuccess = function () { resolve(r.result || ''); };
      r.onerror = function () { reject(r.error); };
    });
  });
}

export async function dictInstall(progress) {
  progress('Lade Wörterbuch …');
  const mr = await fetch('dict/meta.json', { cache: 'no-store' });
  if (!mr.ok) throw new Error('Wörterbuch nicht gefunden (' + mr.status + ').');
  const meta = await mr.json();
  const r = await fetch('dict/en-de.zip', { cache: 'no-store' });
  if (!r.ok) throw new Error('Download fehlgeschlagen (' + r.status + ').');
  const blob = await r.blob();
  progress('Entpacke …');
  const zip = await openZip(blob);
  const names = zip.names().filter(function (n) { return /\.tsv$/.test(n); });
  await dictRemove();
  let batch = [];
  for (let i = 0; i < names.length; i++) {
    batch.push([names[i].replace(/\.tsv$/, ''), await zip.text(names[i])]);
    if (batch.length >= 25 || i === names.length - 1) {
      await putMany(batch); batch = [];
      progress('Speichere … ' + Math.round((i + 1) / names.length * 100) + ' %');
      await new Promise(function (res) { setTimeout(res, 0); });
    }
  }
  try { localStorage.setItem(FLAG, JSON.stringify({ entries: meta.entries, keys: meta.keys, built: meta.built, bytes: meta.bytes })); } catch (e) {}
  cache.clear();
  return meta;
}

export function dictRemove() {
  try { localStorage.removeItem(FLAG); } catch (e) {}
  cache.clear();
  const p = dbP; dbP = null;
  return (p ? p.then(function (d) { d.close(); }, function () {}) : Promise.resolve()).then(function () {
    return new Promise(function (resolve) {
      const r = indexedDB.deleteDatabase(DB);
      r.onsuccess = r.onerror = r.onblocked = function () { resolve(); };
    });
  });
}

// ---------- Nachschlagen ----------
const cache = new Map();
function shardOf(k) {
  const a = k.charAt(0);
  if (!(a >= 'a' && a <= 'z')) return '_';
  const b = k.charAt(1);
  return a + (b >= 'a' && b <= 'z' ? b : '_');
}
async function rowsOf(p) {
  if (cache.has(p)) return cache.get(p);
  const txt = await getShard(p);
  const rows = txt ? txt.split('\n') : [];
  cache.set(p, rows);
  if (cache.size > 6) cache.delete(cache.keys().next().value);
  return rows;
}
// Zeilen sind nach Schlüssel sortiert → binäre Suche nach dem ersten Treffer
function firstAt(rows, key) {
  let lo = 0, hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const k = rows[mid].slice(0, rows[mid].indexOf('\t'));
    if (k < key) lo = mid + 1; else hi = mid;
  }
  return lo;
}
async function find(key, prefix, limit) {
  const rows = await rowsOf(shardOf(key));
  const out = [];
  const want = prefix ? key + ' ' : key;
  for (let i = firstAt(rows, want); i < rows.length && out.length < limit; i++) {
    const parts = rows[i].split('\t');
    if (prefix ? parts[0].indexOf(want) !== 0 : parts[0] !== key) break;
    out.push({ key: parts[0], en: parts[1], de: parts[2] });
  }
  return out;
}

// Unregelmäßige Formen → Grundform (Auswahl, typisch für Erzähltexte)
const IRR = {};
('arose:arise,awoke:awake,was:be,were:be,been:be,is:be,are:be,am:be,bore:bear,borne:bear,beat:beat,beaten:beat,became:become,began:begin,begun:begin,' +
'bent:bend,bet:bet,bit:bite,bitten:bite,bled:bleed,blew:blow,blown:blow,broke:break,broken:break,brought:bring,built:build,burnt:burn,bought:buy,' +
'caught:catch,chose:choose,chosen:choose,clung:cling,came:come,cost:cost,crept:creep,cut:cut,dealt:deal,dug:dig,did:do,done:do,does:do,drew:draw,' +
'drawn:draw,dreamt:dream,drank:drink,drunk:drink,drove:drive,driven:drive,ate:eat,eaten:eat,fell:fall,fallen:fall,fed:feed,felt:feel,fought:fight,' +
'found:find,fled:flee,flung:fling,flew:fly,flown:fly,forbade:forbid,forgot:forget,forgotten:forget,forgave:forgive,froze:freeze,frozen:freeze,' +
'got:get,gotten:get,gave:give,given:give,went:go,gone:go,ground:grind,grew:grow,grown:grow,hung:hang,had:have,has:have,heard:hear,hid:hide,' +
'hidden:hide,hit:hit,held:hold,hurt:hurt,kept:keep,knelt:kneel,knew:know,known:know,laid:lay,led:lead,leapt:leap,left:leave,lent:lend,lay:lie,' +
'lain:lie,lit:light,lost:lose,made:make,meant:mean,met:meet,paid:pay,put:put,quit:quit,read:read,rode:ride,ridden:ride,rang:ring,rung:ring,' +
'rose:rise,risen:rise,ran:run,said:say,saw:see,seen:see,sought:seek,sold:sell,sent:send,set:set,shook:shake,shaken:shake,shed:shed,shone:shine,' +
'shot:shoot,shut:shut,shrank:shrink,sang:sing,sung:sing,sank:sink,sunk:sink,sat:sit,slew:slay,slain:slay,slept:sleep,slid:slide,slung:sling,' +
'slit:slit,smelt:smell,spoke:speak,spoken:speak,sped:speed,spent:spend,spilt:spill,spun:spin,spat:spit,split:split,spread:spread,sprang:spring,' +
'stood:stand,stole:steal,stolen:steal,stuck:stick,stung:sting,stank:stink,strode:stride,struck:strike,strung:string,strove:strive,swore:swear,' +
'sworn:swear,swept:sweep,swam:swim,swum:swim,swung:swing,took:take,taken:take,taught:teach,tore:tear,torn:tear,told:tell,thought:think,threw:throw,' +
'thrown:throw,understood:understand,woke:wake,woken:wake,wore:wear,worn:wear,wept:weep,won:win,wound:wind,wrung:wring,wrote:write,written:write,' +
'men:man,women:woman,children:child,feet:foot,teeth:tooth,mice:mouse,geese:goose,lives:life,knives:knife,wives:wife,wolves:wolf,thieves:thief,' +
'selves:self,halves:half,leaves:leaf,shelves:shelf,better:good,best:good,worse:bad,worst:bad,further:far,farther:far,dying:die,lying:lie,tying:tie')
  .split(',').forEach(function (p) { const x = p.split(':'); IRR[x[0]] = x[1]; });

function lemmas(w) {
  const out = [];
  function add(x) { if (x && x.length > 1 && x !== w && out.indexOf(x) < 0) out.push(x); }
  if (IRR[w]) add(IRR[w]);
  const cons = /[^aeiou]/;
  function dbl(b) { const n = b.length; return n > 2 && b[n - 1] === b[n - 2] && cons.test(b[n - 1]) && !/(ll|ss|zz|ff)$/.test(b); }
  if (/'s$/.test(w)) add(w.slice(0, -2));
  if (/ies$/.test(w)) add(w.slice(0, -3) + 'y');
  if (/(s|x|z|ch|sh|o)es$/.test(w)) add(w.slice(0, -2));
  if (/[^s]s$/.test(w)) add(w.slice(0, -1));
  if (/ied$/.test(w)) add(w.slice(0, -3) + 'y');
  if (/ed$/.test(w)) { const b = w.slice(0, -2); if (dbl(b)) add(b.slice(0, -1)); add(w.slice(0, -1)); add(b); }
  if (/ing$/.test(w)) { const b = w.slice(0, -3); if (dbl(b)) add(b.slice(0, -1)); add(b + 'e'); add(b); }
  if (/ier$/.test(w)) add(w.slice(0, -3) + 'y');
  if (/iest$/.test(w)) add(w.slice(0, -4) + 'y');
  if (/er$/.test(w)) { const b = w.slice(0, -2); if (dbl(b)) add(b.slice(0, -1)); add(b); add(w.slice(0, -1)); }
  if (/est$/.test(w)) { const b = w.slice(0, -3); if (dbl(b)) add(b.slice(0, -1)); add(b); add(w.slice(0, -2)); }
  if (/ily$/.test(w)) add(w.slice(0, -3) + 'y');
  if (/ly$/.test(w)) add(w.slice(0, -2));
  return out;
}

function norm(t) {
  return t.toLowerCase().replace(/[’‘`]/g, "'").replace(/[“”"«»„]/g, '')
    .replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '').replace(/'+$/, '').replace(/\s+/g, ' ');
}

// Ergebnis: Liste {key,en,de}, Genau-Treffer zuerst, dann Grundformen, dann Wendungen
export async function dictLookup(text) {
  const q = norm(text);
  if (!q || q.split(' ').length > 6) return [];
  const words = q.split(' ');
  const heads = [q];
  lemmas(words[0]).forEach(function (l) { heads.push([l].concat(words.slice(1)).join(' ')); });
  if (words.length > 1) lemmas(words[words.length - 1]).forEach(function (l) { heads.push(words.slice(0, -1).concat([l]).join(' ')); });
  const out = [], seen = {};
  function push(list) { list.forEach(function (r) { const s = r.en + '|' + r.de; if (!seen[s]) { seen[s] = 1; out.push(r); } }); }
  for (let i = 0; i < heads.length && out.length < 14; i++) push(await find(heads[i], false, 10));
  for (let i = 0; i < heads.length && out.length < 20; i++) push(await find(heads[i], true, i === 0 ? 8 : 4));
  return out.slice(0, 20);
}
