import './compat.js';
import { db } from './db.js';
import { openZip, writeZip } from './zip.js';
import { EpubView, epubMeta, THEMES } from './epub.js';
import { PdfView, pdfMeta } from './pdf.js';

const VERSION = '1.5.2';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ---------------- Einstellungen ----------------
const DEFAULTS = {
  fontSize: 100, imageScale: 100, font: 'orig', lineHeight: 'orig', margin: 'm', align: 'orig', columns: 'auto',
  hyphens: false, theme: 'light', brightness: 100, keepAwake: false, pdfZoom: 'width', targetLang: 'de', sort: 'recent', eink: false,
};
let settings = loadSettings();
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('sr-settings') || '{}') }; } catch { return { ...DEFAULTS }; }
}
function saveSettings() { try { localStorage.setItem('sr-settings', JSON.stringify(settings)); } catch {} }

// ---------------- Hilfsfunktionen ----------------
let toastT;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms);
}
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function hashBuf(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function fmtSize(b) { return b > 1e6 ? (b / 1e6).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB'; }
function hueOf(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
async function shrinkImage(blob, max = 420) {
  try {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
  } catch { return blob; }
}

// ---------------- Overlays ----------------
const openLayers = [];
function updateScrim() {
  $('#scrim').hidden = !(openLayers.some((x) => x !== 'dict' && x !== 'lightbox') || (curPanel && !wide()));
}
function openLayer(id) {
  const el = document.getElementById(id);
  el.hidden = false;
  if (!openLayers.includes(id)) openLayers.push(id);
  updateScrim();
}
function closeLayer(id) {
  const el = document.getElementById(id);
  if (el) el.hidden = true;
  const i = openLayers.indexOf(id); if (i >= 0) openLayers.splice(i, 1);
  updateScrim();
}
document.addEventListener('click', (e) => { const c = e.target.closest('[data-close]'); if (c) closeLayer(c.dataset.close); });
$('#scrim').addEventListener('click', () => {
  if (openLayers.some((x) => x !== 'dict' && x !== 'lightbox' && x !== 'deviceSheet')) [...openLayers].filter((x) => x !== 'lightbox' && x !== 'deviceSheet').forEach(closeLayer);
  else if (curPanel) closePanel();
});

// ---------------- Menüleiste links + Seitenfeld (wie in der Vorlage) ----------------
const PANEL_TITLES = { toc: 'Inhalt', search: 'Suche', marks: 'Lesezeichen', type: 'Schrift & Bilder', theme: 'Farben & Helligkeit', settings: 'Einstellungen' };
let curPanel = null;
// Leiste links blendet sich beim Lesen aus
let railT = null, openedAt = 0, lastScrub = 0;
function setRail(show) {
  document.body.classList.toggle('rail-hidden', !show);
  const r = document.getElementById('reader');
  if (r) r.classList.toggle('ui-hidden', !show);
}
function scheduleRailHide(ms) {
  clearTimeout(railT);
  railT = setTimeout(() => { if (view && !curPanel && !openLayers.length) setRail(false); }, ms);
}
function wide() { return window.innerWidth >= 1000; }
function openPanel(name) {
  if (name === 'library') {
    closePanel();
    if (view) { if (location.hash === '#lesen') history.back(); else closeReader(); }
    else window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  if (['toc', 'search', 'marks'].includes(name) && !view) return;
  curPanel = name;
  clearTimeout(railT); setRail(true);
  $('#panelTitle').textContent = PANEL_TITLES[name];
  $$('#panel [data-p]').forEach((sec) => { sec.hidden = sec.dataset.p !== name; });
  $$('#rail [data-panel]').forEach((b) => b.classList.toggle('active', b.dataset.panel === name));
  $('#panel').hidden = false;
  document.body.classList.toggle('panel-push', wide());
  updateScrim();
  if (name === 'toc') renderToc();
  if (name === 'marks') renderMarks();
  if (['type', 'theme', 'settings'].includes(name)) syncSettingsUi();
  if (name === 'settings') refreshAbout();
  if (name === 'search') setTimeout(() => $('#searchInput').focus(), 50);
}
function closePanel() {
  curPanel = null;
  if (view) scheduleRailHide(2500);
  $('#panel').hidden = true;
  $$('#rail [data-panel]').forEach((b) => b.classList.remove('active'));
  document.body.classList.remove('panel-push');
  updateScrim();
}
function closePanelIfOverlay() { if (!wide()) closePanel(); }
$('#rail').addEventListener('click', (e) => {
  const b = e.target.closest('[data-panel]'); if (!b) return;
  if (curPanel === b.dataset.panel) closePanel(); else openPanel(b.dataset.panel);
});
$('#panelClose').addEventListener('click', closePanel);
window.addEventListener('resize', () => { if (curPanel) { document.body.classList.toggle('panel-push', wide()); updateScrim(); } });

// ================= BIBLIOTHEK =================
let books = [];
let states = new Map();
const coverUrls = new Map();

async function loadLibrary() {
  books = await db.all('books');
  states = new Map((await db.all('states')).map((s) => [s.id, s]));
  renderLibrary();
}
function coverUrl(b) {
  if (!b.cover) return null;
  if (!coverUrls.has(b.id)) coverUrls.set(b.id, URL.createObjectURL(b.cover));
  return coverUrls.get(b.id);
}
function coverHtml(b) {
  const u = coverUrl(b);
  if (u) return `<img src="${u}" alt="" loading="lazy">`;
  const h = hueOf(b.title || b.id);
  return `<div class="gen" style="background:linear-gradient(160deg,hsl(${h} 38% 36%),hsl(${(h + 40) % 360} 42% 22%))"><b>${esc(b.title)}</b><small>${esc(b.author || '')}</small></div>`;
}
function progressOf(id) { const s = states.get(id); return s && typeof s.percent === 'number' ? s.percent : 0; }

function renderLibrary() {
  const q = $('#libSearch').value.trim().toLowerCase();
  const sort = settings.sort;
  $('#libSort').value = sort;
  let list = books.filter((b) => !q || (b.title + ' ' + (b.author || '')).toLowerCase().includes(q));
  const last = (b) => (states.get(b.id) && states.get(b.id).lastOpened) || 0;
  const cmp = {
    recent: (a, b) => last(b) - last(a) || b.added - a.added,
    added: (a, b) => b.added - a.added,
    title: (a, b) => a.title.localeCompare(b.title, 'de'),
    author: (a, b) => (a.author || '').localeCompare(b.author || '', 'de') || a.title.localeCompare(b.title, 'de'),
    progress: (a, b) => progressOf(b.id) - progressOf(a.id),
  }[sort];
  list.sort(cmp);
  $('#bookCount').textContent = books.length;
  $('#empty').hidden = books.length > 0;
  $('#grid').innerHTML = list.map((b) => {
    const p = Math.round(progressOf(b.id) * 100);
    return `<div class="card" data-id="${b.id}" role="button" tabindex="0" aria-label="${esc(b.title)} öffnen">
      <div class="cover">${coverHtml(b)}<span class="badge">${b.type.toUpperCase()}</span>
        <button class="more" data-menu="${b.id}" aria-label="Optionen"><svg><use href="#i-more"/></svg></button></div>
      <div class="meta"><div class="t">${esc(b.title)}</div><div class="a">${esc(b.author || '—')}</div>
      <div class="p"><div class="bar"><i style="width:${p}%"></i></div><span>${p} %</span></div></div></div>`;
  }).join('');
  if (q && !list.length) $('#grid').innerHTML = '<p class="muted">Nichts gefunden.</p>';

  // Weiterlesen
  const recent = books.filter((b) => last(b)).sort((a, b) => last(b) - last(a))[0];
  const cc = $('#continueCard');
  if (recent) {
    const p = Math.round(progressOf(recent.id) * 100);
    const u = coverUrl(recent);
    cc.innerHTML = `${u ? `<img src="${u}" alt="">` : '<div class="ph"></div>'}<div class="c-txt"><div class="c-k">Weiterlesen</div><h3>${esc(recent.title)}</h3><p>${esc(recent.author || '')}</p><div class="bar"><i style="width:${p}%"></i></div></div><strong>${p} %</strong>`;
    cc.dataset.id = recent.id; cc.hidden = false;
    $('#heroTitle').textContent = 'Willkommen zurück';
  } else {
    cc.hidden = true;
    $('#heroTitle').textContent = books.length ? 'Was liest du heute?' : 'Willkommen';
  }
}

$('#grid').addEventListener('click', (e) => {
  const m = e.target.closest('[data-menu]');
  if (m) { e.stopPropagation(); return openBookMenu(m.dataset.menu); }
  const c = e.target.closest('.card'); if (c) openBook(c.dataset.id);
});
$('#grid').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const c = e.target.closest('.card'); if (c) openBook(c.dataset.id); } });
$('#continueCard').addEventListener('click', () => openBook($('#continueCard').dataset.id));
$('#libSearch').addEventListener('input', renderLibrary);
$('#libSort').addEventListener('change', (e) => { settings.sort = e.target.value; saveSettings(); renderLibrary(); });

let menuBook = null;
function openBookMenu(id) {
  const b = books.find((x) => x.id === id); if (!b) return;
  menuBook = b;
  $('#bmTitle').textContent = b.title;
  const st = states.get(id);
  $('#bmInfo').textContent = [b.author, b.type.toUpperCase(), fmtSize(b.size || 0), `${Math.round(progressOf(id) * 100)} % gelesen`, st && st.bookmarks && st.bookmarks.length ? `${st.bookmarks.length} Lesezeichen` : ''].filter(Boolean).join(' · ');
  openLayer('bookMenu');
}
$('#bmOpen').addEventListener('click', () => { closeLayer('bookMenu'); openBook(menuBook.id); });
$('#bmReset').addEventListener('click', async () => {
  const st = states.get(menuBook.id) || { id: menuBook.id, bookmarks: [] };
  st.pos = null; st.percent = 0; st.updated = Date.now();
  await db.put('states', st); states.set(st.id, st);
  closeLayer('bookMenu'); renderLibrary(); toast('Fortschritt zurückgesetzt.');
});
$('#bmDelete').addEventListener('click', async () => {
  if (!confirm(`„${menuBook.title}“ wirklich löschen? Lesestand und Lesezeichen gehen dabei verloren.`)) return;
  await db.del('books', menuBook.id); await db.del('files', menuBook.id); await db.del('states', menuBook.id);
  if (coverUrls.has(menuBook.id)) { URL.revokeObjectURL(coverUrls.get(menuBook.id)); coverUrls.delete(menuBook.id); }
  closeLayer('bookMenu'); await loadLibrary(); toast('Buch gelöscht.');
});

// ---------------- Import ----------------
$('#btnImport').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', async (e) => { await importFiles([...e.target.files]); e.target.value = ''; });

function typeOf(file) {
  const n = (file.name || '').toLowerCase();
  if (n.endsWith('.pdf') || file.type === 'application/pdf') return 'pdf';
  if (n.endsWith('.epub') || file.type === 'application/epub+zip') return 'epub';
  return null;
}

async function importFiles(files, openAfter = false) {
  let added = 0, firstId = null;
  for (const f of files) {
    try {
      const id = await importFile(f);
      if (id) { added++; firstId = firstId || id; }
    } catch (err) {
      console.error(err);
      toast(`„${f.name}“ konnte nicht importiert werden: ${err.message || err}`, 5000);
    }
  }
  await loadLibrary();
  if (added && files.length > 1) toast(`${added} von ${files.length} Dateien importiert.`);
  if (openAfter && firstId) openBook(firstId);
  return firstId;
}

async function importFile(file) {
  const type = typeOf(file);
  if (!type) { toast(`„${file.name}“: nur EPUB und PDF werden unterstützt.`, 4000); return null; }
  toast(`Importiere „${file.name}“ …`, 60000);
  const buf = await file.arrayBuffer();
  const id = await hashBuf(buf);
  const existing = await db.get('books', id);
  if (existing) { toast(`„${existing.title}“ ist schon in der Bibliothek.`); return id; }
  const blob = new Blob([buf], { type: type === 'pdf' ? 'application/pdf' : 'application/epub+zip' });
  const meta = type === 'epub' ? await epubMeta(blob) : await pdfMeta(blob, file.name);
  const cover = meta.cover ? await shrinkImage(meta.cover) : null;
  const book = {
    id, type, title: meta.title || file.name, author: meta.author || '', lang: meta.lang || '',
    cover, chars: meta.chars || null, pages: meta.pages || null, size: buf.byteLength, fileName: file.name, added: Date.now(),
  };
  await db.put('files', blob, id);
  await db.put('books', book);
  requestPersist();
  toast(`„${book.title}“ hinzugefügt.`);
  return id;
}

async function requestPersist() {
  try { if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch {}
}

// Drag & Drop
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (!$('#library').hidden && e.dataTransfer.types.includes('Files')) { dragDepth++; $('#dropHint').hidden = false; } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropHint').hidden = true; });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('#dropHint').hidden = true;
  const files = [...e.dataTransfer.files];
  if (files.length && !$('#library').hidden) importFiles(files);
});

// Datei-Öffnen über das Betriebssystem (ChromeOS / Windows) und Teilen (Android)
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    if (!params.files || !params.files.length) return;
    const files = await Promise.all(params.files.map((h) => h.getFile()));
    importFiles(files, true);
  });
}
async function handleShare() {
  if (!location.search.includes('share=1')) return;
  history.replaceState(null, '', location.pathname);
  try {
    const cache = await caches.open('sr-share');
    const keys = await cache.keys();
    const files = [];
    for (const k of keys) {
      const r = await cache.match(k);
      const name = decodeURIComponent(r.headers.get('x-name') || 'buch');
      files.push(new File([await r.blob()], name, { type: r.headers.get('content-type') || '' }));
      await cache.delete(k);
    }
    if (files.length) importFiles(files, true);
  } catch (e) { console.warn(e); }
}

// ---------------- Gerätename (nur lokal, wird nicht synchronisiert) ----------------
function getDevice() { try { return localStorage.getItem('sr-device') || ''; } catch { return ''; } }
function fileSafe(n) { return (n || 'Geraet').replace(/[^A-Za-z0-9ÄÖÜäöüß_-]+/g, '-').replace(/^-+|-+$/g, '') || 'Geraet'; }
function askDevice() {
  const cur = getDevice();
  $$('#deviceSheet [data-dev]').forEach((b) => b.classList.toggle('on', b.dataset.dev === cur));
  $('#deviceInput').value = cur && !$(`#deviceSheet [data-dev="${cur}"]`) ? cur : '';
  openLayer('deviceSheet');
}
function setDevice(name) {
  name = (name || '').trim().slice(0, 30);
  if (!name) return;
  try { localStorage.setItem('sr-device', name); } catch {}
  closeLayer('deviceSheet');
  $('#deviceName').textContent = name;
  if (curPanel === 'settings') refreshAbout();
  toast(`Gerät: ${name}`);
}
$('#deviceSheet').addEventListener('click', (e) => { const b = e.target.closest('[data-dev]'); if (b) setDevice(b.dataset.dev); });
$('#deviceForm').addEventListener('submit', (e) => { e.preventDefault(); setDevice($('#deviceInput').value); });
$('#mDevice').addEventListener('click', () => askDevice());

// ---------------- Menü & Backup ----------------
async function refreshAbout() {
  $('#appVersion').textContent = VERSION + ' · ' + browserInfo();
  $('#deviceName').textContent = getDevice() || '–';
  try {
    const est = await navigator.storage.estimate();
    const pers = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    $('#storageInfo').textContent = `Belegt: ${fmtSize(est.usage || 0)} von ca. ${fmtSize(est.quota || 0)} verfügbar${pers ? ' · Speicher geschützt' : ''}`;
  } catch { $('#storageInfo').textContent = ''; }
}
$('#mExportData').addEventListener('click', () => exportBackup(false));
$('#mExportAll').addEventListener('click', () => exportBackup(true));
$('#mImport').addEventListener('click', () => $('#backupInput').click());
$('#backupInput').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) await importBackup(f); });

// ---------------- Android-App (APK): Brücke zur nativen Hülle ----------------
const android = window.AoAndroid || null;
if (android) document.documentElement.classList.add('in-apk');
if (!android && !(document.fullscreenEnabled || document.webkitFullscreenEnabled)) document.documentElement.classList.add('no-fs');
function readAsArrayBuffer(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsArrayBuffer(blob); });
}
function bytesToB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToBytes(b64) {
  const s = atob(b64); const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}
async function androidSave(blob, name) {
  const id = android.beginFile(name, blob.type || 'application/octet-stream');
  if (!id) { toast('Speichern nicht möglich.'); return; }
  const CH = 384 * 1024;
  for (let o = 0; o < blob.size; o += CH) {
    const part = new Uint8Array(await readAsArrayBuffer(blob.slice(o, o + CH)));
    if (!android.appendChunk(id, bytesToB64(part))) { toast('Speichern fehlgeschlagen.'); return; }
  }
  android.finishFile(id);
}
// vom Gerät per „Öffnen mit“ / „Teilen“ übergebene Dateien holen
window.aoCheckFiles = async () => {
  if (!android) return;
  let list = [];
  try { list = JSON.parse(android.pendingFiles() || '[]'); } catch { list = []; }
  if (!list.length) return;
  const files = [];
  for (const f of list) {
    const parts = [];
    for (;;) { const c = android.readChunk(f.id); if (!c) break; parts.push(b64ToBytes(c)); }
    let type = f.type || '';
    if (!type || type === 'application/octet-stream') type = /\.pdf$/i.test(f.name) ? 'application/pdf' : /\.epub$/i.test(f.name) ? 'application/epub+zip' : '';
    let name = f.name || 'buch';
    if (!/\.(epub|pdf)$/i.test(name)) name += type === 'application/pdf' ? '.pdf' : '.epub';
    files.push(new File(parts, name, { type }));
  }
  if (view) await closeReader();
  importFiles(files, true);
};
window.aoNext = () => { if (view && $('#lightbox').hidden) view.next(); };
window.aoPrev = () => { if (view && $('#lightbox').hidden) view.prev(); };
window.aoPause = () => { savePosNow(); };
window.aoBack = () => {
  if (!$('#lightbox').hidden) { closeLightbox(); return true; }
  if (openLayers.length) {
    const top = openLayers[openLayers.length - 1];
    if (top !== 'deviceSheet') closeLayer(top);
    return true;
  }
  if (curPanel) { closePanel(); return true; }
  if (view) { if (location.hash === '#lesen') history.back(); else closeReader(); return true; }
  return false;
};

function cssToHex(c) {
  const m = String(c).match(/\d+(\.\d+)?/g);
  if (!m || m.length < 3) return '#ffffff';
  return '#' + m.slice(0, 3).map((v) => Math.round(+v).toString(16).padStart(2, '0')).join('');
}
function androidBg(color) {
  if (android && typeof android.setBackground === 'function') { try { android.setBackground(color); } catch {} }
}

function download(blob, name) {
  if (android) { androidSave(blob, name); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

async function exportBackup(withBooks) {
  closeLayer('libMenu');
  const allBooks = await db.all('books');
  const allStates = await db.all('states');
  const data = {
    app: 'ao-reader', format: 1, exported: new Date().toISOString(), device: getDevice(), settings,
    books: allBooks.map(({ cover, chars, ...b }) => b),
    states: allStates,
  };
  const day = new Date().toISOString().slice(0, 10);
  const dev = fileSafe(getDevice());
  if (!withBooks) {
    download(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }), `ao-reader-backup-${dev}-${day}.json`);
    if (!android) toast('Backup gespeichert (Downloads).');
    return;
  }
  toast('Backup wird erstellt …', 60000);
  const files = [{ name: 'backup.json', data: new TextEncoder().encode(JSON.stringify(data, null, 1)) }];
  for (const b of allBooks) {
    const blob = await db.get('files', b.id);
    if (blob) files.push({ name: `books/${b.id}.${b.type}`, data: new Uint8Array(await blob.arrayBuffer()) });
  }
  download(writeZip(files), `ao-reader-komplett-${dev}-${day}.zip`);
  toast(android ? 'Bitte Speicherort wählen …' : `Backup mit ${allBooks.length} Büchern gespeichert (Downloads).`, 4000);
}

async function importBackup(file) {
  closeLayer('libMenu');
  try {
    let data, zip = null;
    if (/\.zip$/i.test(file.name) || file.type === 'application/zip') {
      zip = await openZip(file);
      data = JSON.parse(await zip.text('backup.json'));
    } else data = JSON.parse(await file.text());
    if (data.app !== 'ao-reader' && data.app !== 'simple-reader') throw new Error('Keine ao-Reader-Sicherung.');
    let newBooks = 0, updated = 0;
    if (zip) {
      for (const b of data.books) {
        if (await db.get('books', b.id)) continue;
        const path = `books/${b.id}.${b.type}`;
        if (!zip.has(path)) continue;
        const blob = await zip.blob(path, b.type === 'pdf' ? 'application/pdf' : 'application/epub+zip');
        const file2 = new File([blob], b.fileName || `${b.title}.${b.type}`, { type: blob.type });
        const id = await importFile(file2);
        if (id) newBooks++;
      }
    }
    for (const s of data.states || []) {
      const cur = await db.get('states', s.id);
      if (!cur) { await db.put('states', s); updated++; continue; }
      const merged = { ...cur };
      if ((s.updated || 0) > (cur.updated || 0)) { merged.pos = s.pos; merged.percent = s.percent; merged.updated = s.updated; updated++; }
      merged.lastOpened = Math.max(cur.lastOpened || 0, s.lastOpened || 0);
      const seen = new Set((cur.bookmarks || []).map((b) => b.id));
      merged.bookmarks = [...(cur.bookmarks || []), ...(s.bookmarks || []).filter((b) => !seen.has(b.id))];
      await db.put('states', merged);
    }
    if (data.settings && confirm('Leseeinstellungen (Schrift, Farben …) aus dem Backup übernehmen?')) {
      settings = { ...DEFAULTS, ...data.settings }; saveSettings();
    }
    await loadLibrary();
    toast(`Backup${data.device ? ' von „' + data.device + '“' : ''} importiert: ${newBooks} neue Bücher, ${updated} Lesestände aktualisiert.`, 4500);
  } catch (err) {
    console.error(err);
    toast('Backup konnte nicht gelesen werden: ' + (err.message || err), 5000);
  }
}

// ================= LESEANSICHT =================
let view = null, cur = null, curState = null, wakeLock = null;
const reader = $('#reader');

async function openBook(id) {
  const book = await db.get('books', id);
  const blob = await db.get('files', id);
  if (!book || !blob) { toast('Buchdatei nicht gefunden.'); return; }
  closeAllLayers();
  cur = book;
  curState = (await db.get('states', id)) || { id, bookmarks: [] };
  curState.bookmarks = curState.bookmarks || [];
  curState.lastOpened = Date.now();
  await db.put('states', curState); states.set(id, curState);

  $('#library').hidden = true;
  reader.hidden = false;
  document.body.classList.add('reading');
  if (android) android.setReading(true);
  document.body.classList.toggle('reader-pdf', book.type === 'pdf');
  document.body.classList.toggle('reader-epub', book.type === 'epub');
  reader.classList.remove('ui-hidden');
  setRail(true); openedAt = Date.now(); scheduleRailHide(4000);
  applyTheme();
  $('#rBookTitle').textContent = book.title;
  $('#rChapter').textContent = '';
  $('#loading').hidden = false;
  document.title = book.title + ' – ao Reader';
  if (location.hash !== '#lesen') history.pushState({ reading: id }, '', '#lesen');

  const stage = $('#stage');
  stage.innerHTML = '';
  const events = {
    relocate: onRelocate, center: toggleUi, select: onSelect, image: openLightbox, key: onKey,
    external: (url) => { if (confirm('Externen Link öffnen?\n' + url)) window.open(url, '_blank', 'noopener'); },
    zoom: (z) => setPdfZoom(z),
  };
  try {
    view = book.type === 'pdf' ? new PdfView(stage, blob, book, settings, events) : new EpubView(stage, blob, book, settings, events);
    await view.open(curState.pos);
    if (book.type === 'epub' && (!book.chars || book.chars.length !== view.meta.chars.length)) { book.chars = view.meta.chars; db.put('books', book); }
  } catch (err) {
    console.error(err);
    $('#loading').hidden = true;
    toast('Buch konnte nicht geöffnet werden: ' + (err.message || err), 5000);
    closeReader();
    return;
  }
  $('#loading').hidden = true;
  updateWakeLock();
  syncSettingsUi();
  try {
    if (!localStorage.getItem('sr-hint-aa')) { localStorage.setItem('sr-hint-aa', '1'); toast('Tipp: Beim Umblättern verschwinden alle Leisten. Zurückholen: in die Bildmitte tippen.', 7000); }
  } catch {}
}

function closeAllLayers() { [...openLayers].forEach(closeLayer); }

async function closeReader() {
  await savePosNow();
  closeAllLayers();
  if (view) { view.destroy(); view = null; }
  cur = null;
  reader.hidden = true;
  clearTimeout(railT); setRail(true);
  document.body.classList.remove('reader-epub', 'reader-pdf', 'reading');
  if (android) { android.setReading(false); android.keepScreenOn(false); androidBg(cssToHex(getComputedStyle(document.body).backgroundColor)); }
  if (['toc', 'search', 'marks'].includes(curPanel)) closePanel();
  $('#searchList').innerHTML = ''; $('#searchStatus').textContent = ''; $('#searchInput').value = '';
  $('#library').hidden = false;
  document.title = 'ao Reader';
  releaseWakeLock();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  await loadLibrary();
}
$('#btnBack').addEventListener('click', () => { if (location.hash === '#lesen') history.back(); else closeReader(); });
window.addEventListener('popstate', () => { if (view && location.hash !== '#lesen') closeReader(); });

function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function mixHex(a, b, t) { const x = hexRgb(a), y = hexRgb(b); return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join(''); }
function applyTheme() {
  if (!THEMES[settings.theme]) { settings.theme = settings.theme === 'black' ? 'dark' : 'light'; saveSettings(); }
  const th = THEMES[settings.theme];
  reader.className = reader.className.replace(/\bt-\S+/g, '').trim();
  reader.classList.add('t-' + settings.theme);
  reader.classList.toggle('is-dark', th.dark);
  const v = {
    '--r-bg': th.bg, '--r-fg': th.fg, '--r-bar': th.bg + 'f7', '--r-line': mixHex(th.bg, th.fg, 0.15), '--r-muted': mixHex(th.bg, th.fg, 0.6),
  };
  for (const [k, val] of Object.entries(v)) reader.style.setProperty(k, val);
  reader.style.colorScheme = th.dark ? 'dark' : 'light';
  // Leiste, Seitenfeld & Dialoge beim Lesen im gleichen Farbschema
  const surf = mixHex(th.bg, th.fg, th.dark ? 0.06 : 0.03);
  const accent = th.dark ? '#5fb8b0' : '#1f6f6b';
  let css = `body.reading :is(.rail,.panel,.dict,.sheet){--bg:${th.bg};--surface:${surf};--surface-2:${mixHex(th.bg, th.fg, 0.12)};--text:${th.fg};--muted:${mixHex(th.bg, th.fg, 0.6)};--line:${mixHex(th.bg, th.fg, 0.18)};--accent:${accent};--accent-soft:${mixHex(th.bg, accent, 0.2)};--accent-ink:${th.dark ? '#0d1f1d' : '#ffffff'};color-scheme:${th.dark ? 'dark' : 'light'}}`;
  let st = document.getElementById('theme-vars');
  if (!st) { st = document.createElement('style'); st.id = 'theme-vars'; document.head.appendChild(st); }
  st.textContent = css;
  $('#dimmer').style.opacity = String((100 - settings.brightness) / 100);
  $('meta[name=theme-color]').setAttribute('content', view || !reader.hidden ? th.bg : '#FF8A00');
  if (view || !reader.hidden) androidBg(th.bg);
}
function buildSwatches() {
  $('#themeSwatches').innerHTML = Object.entries(THEMES).map(([k, t]) =>
    `<button data-v="${k}" class="sw" style="background:${t.bg};color:${t.fg}" aria-label="${t.name}"><b>Aa</b><small>${t.name}</small></button>`).join('');
}
buildSwatches();

// Position & Fortschritt
let saveT;
function onRelocate() {
  if (!view) return;
  if (!curPanel && Date.now() - openedAt > 1500 && Date.now() - lastScrub > 2500) { clearTimeout(railT); setRail(false); }
  const inf = view.info();
  $('#rChapter').textContent = inf.chapter && inf.chapter !== cur.title ? inf.chapter : (cur.author || '');
  $('#miniTitle').textContent = cur.type === 'pdf' ? cur.title : inf.chapter;
  $('#miniLeft').textContent = inf.pageLabel;
  $('#miniRight').textContent = Math.round(inf.percent * 100) + ' %';
  $('#lblLeft').textContent = cur.type === 'pdf' ? inf.pageLabel : inf.chapterPages;
  $('#lblRight').textContent = cur.type === 'pdf' ? `${Math.round(inf.percent * 100)} %` : `${inf.pageLabel} · ${Math.round(inf.percent * 100)} %`;
  if (!scrubbing) setScrub(inf.percent);
  const marked = curState.bookmarks.some((b) => view.samePage(b.pos));
  $('#btnMark').classList.toggle('on', marked);
  $('#markPanelLbl').textContent = marked ? 'Lesezeichen dieser Seite entfernen' : 'Lesezeichen für diese Seite setzen';
  if (cur.type === 'pdf') $('#pdfZoomOut').textContent = view.percentZoom + ' %';
  clearTimeout(saveT); saveT = setTimeout(savePosNow, 600);
  closeLayer('dict');
}
async function savePosNow() {
  if (!view || !cur) return;
  clearTimeout(saveT);
  curState.pos = view.getPos();
  curState.percent = view.percent();
  curState.updated = Date.now();
  try { await db.put('states', curState); states.set(cur.id, curState); } catch (e) { console.warn(e); }
}
document.addEventListener('visibilitychange', () => { if (document.hidden) savePosNow(); else if (view) updateWakeLock(); });
window.addEventListener('pagehide', savePosNow);

// Bedienleisten
function toggleUi() {
  if (curPanel && !wide()) { closePanel(); return; }
  if (openLayers.includes('dict')) { closeLayer('dict'); return; }
  const hidden = reader.classList.contains('ui-hidden') || document.body.classList.contains('rail-hidden');
  clearTimeout(railT);
  setRail(hidden);
}
$('#btnRail').addEventListener('click', () => {
  const show = document.body.classList.contains('rail-hidden');
  clearTimeout(railT); setRail(show);
  if (!show && curPanel) closePanel();
});
$('#btnPrev').addEventListener('click', () => view && view.prev());
$('#btnPrevSide').addEventListener('click', () => view && view.prev());
$('#btnNextSide').addEventListener('click', () => view && view.next());
$('#btnNext').addEventListener('click', () => view && view.next());
$('#btnFull').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => toast('Vollbild nicht möglich.'));
});

function onKey(e) {
  if (!view) return;
  if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName) && e.target.type !== 'range') return;
  if (e.key === 'Escape') { if (!$('#lightbox').hidden) closeLightbox(); else if (openLayers.length) closeLayer(openLayers[openLayers.length - 1]); else if (curPanel) closePanel(); else toggleUi(); return; }
  if (openLayers.includes('lightbox')) return;
  const pdf = cur.type === 'pdf';
  switch (e.key) {
    case 'ArrowRight': case 'PageDown': e.preventDefault(); view.next(); break;
    case 'ArrowLeft': case 'PageUp': e.preventDefault(); view.prev(); break;
    case 'ArrowDown': if (pdf) return; e.preventDefault(); view.next(); break;
    case 'ArrowUp': if (pdf) return; e.preventDefault(); view.prev(); break;
    case ' ': e.preventDefault(); pdf ? view.scrollOrNext(e.shiftKey ? -1 : 1) : (e.shiftKey ? view.prev() : view.next()); break;
    case 'f': case 'F': if (!e.ctrlKey && !e.metaKey) $('#btnFull').click(); break;
    case '+': if (pdf) { e.preventDefault(); stepPdfZoom(1); } else stepSetting('fontSize', 1); break;
    case '-': if (pdf) { e.preventDefault(); stepPdfZoom(-1); } else stepSetting('fontSize', -1); break;
  }
}
document.addEventListener('keydown', (e) => { if (!reader.hidden) onKey(e); });

// ---------------- Fortschrittsbalken (ziehen = schnell navigieren) ----------------
const scrub = $('#scrub');
let scrubbing = false;
function setScrub(p) { scrub.value = Math.round(p * 1000); scrub.style.setProperty('--p', p * 100 + '%'); }
function showBubble() {
  const p = scrub.value / 1000;
  const lbl = view.previewLabel(p);
  const b = $('#scrubBubble');
  b.querySelector('strong').textContent = lbl.title;
  b.querySelector('span').textContent = lbl.sub;
  b.hidden = false;
  const r = scrub.getBoundingClientRect(), pr = scrub.parentElement.getBoundingClientRect();
  const x = r.left - pr.left + 12 + (r.width - 24) * p;
  const half = Math.min(b.offsetWidth / 2, pr.width / 2);
  b.style.left = Math.max(half - 40, Math.min(pr.width - half + 40, x)) + 'px';
  scrub.style.setProperty('--p', p * 100 + '%');
}
scrub.addEventListener('pointerdown', () => { scrubbing = true; lastScrub = Date.now(); clearTimeout(railT); });
scrub.addEventListener('input', () => { scrubbing = true; if (view) showBubble(); });
const endScrub = async () => {
  if (!scrubbing) return;
  scrubbing = false;
  $('#scrubBubble').hidden = true;
  if (view) { await view.goToPercent(scrub.value / 1000); }
};
scrub.addEventListener('change', endScrub);
scrub.addEventListener('pointerup', () => setTimeout(endScrub, 0));
scrub.addEventListener('keydown', (e) => e.stopPropagation());

// ---------------- Inhalt / Lesezeichen / Suche ----------------

let tocItems = [];
function renderToc() {
  const toc = view.getToc();
  tocItems = [];
  const out = [];
  let curIdx = -1;
  const walk = (items) => items.forEach((t) => {
    const i = tocItems.push(t) - 1;
    if (cur.type === 'epub' && t.pos && t.pos.ch <= view.ch) curIdx = i;
    out.push(`<li><button data-toc="${i}" style="padding-left:${12 + t.level * 16}px" ${t.pos ? '' : 'disabled'}>${esc(t.label)}</button></li>`);
    walk(t.children || []);
  });
  walk(toc);
  if (cur.type === 'epub' && curIdx >= 0) {
    // genauer: letzter Eintrag im aktuellen Kapitel, dessen Anker vor der aktuellen Seite liegt
    const title = view.info().chapter;
    const exact = tocItems.findIndex((t) => t.label === title && t.pos && t.pos.ch === view.ch);
    if (exact >= 0) curIdx = exact;
  }
  $('#tocList').innerHTML = out.length ? out.join('') : '<li class="empty-note">Dieses Buch hat kein Inhaltsverzeichnis.</li>';
  if (curIdx >= 0) {
    const b = $(`[data-toc="${curIdx}"]`); b.classList.add('cur');
    setTimeout(() => b.scrollIntoView({ block: 'center' }), 30);
  }
}
$('#tocList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-toc]'); if (!b) return;
  const t = tocItems[+b.dataset.toc];
  closePanelIfOverlay();
  if (cur.type === 'pdf') await view.goToToc(t.pos); else await view.goTo({ ...t.pos, frac: t.pos.anchor ? undefined : 0 });
});

async function toggleMark() {
  if (!view) return;
  const existing = curState.bookmarks.findIndex((b) => view.samePage(b.pos));
  if (existing >= 0) { curState.bookmarks.splice(existing, 1); toast('Lesezeichen entfernt.'); }
  else {
    const info = view.bookmarkInfo();
    curState.bookmarks.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), created: Date.now(), ...info });
    toast('Lesezeichen gesetzt.');
  }
  curState.updated = Date.now();
  await db.put('states', curState);
  onRelocate();
  if (curPanel === 'marks') renderMarks();
}
$('#btnMark').addEventListener('click', toggleMark);
$('#btnMarkPanel').addEventListener('click', toggleMark);
function renderMarks() {
  const list = [...curState.bookmarks].sort((a, b) => (a.percent || 0) - (b.percent || 0));
  $('#markList').innerHTML = list.length ? list.map((b) => `<li><button class="mk" data-mk="${b.id}"><b>${esc(b.label)} · ${Math.round((b.percent || 0) * 100)} %</b><span>${esc(b.snippet || '')}</span></button>
    <button class="icon-btn sm" data-mkdel="${b.id}" aria-label="Lesezeichen löschen"><svg><use href="#i-trash"/></svg></button></li>`).join('')
    : '<li class="empty-note">Noch keine Lesezeichen. Tippe oben auf das Lesezeichen-Symbol, um die aktuelle Seite zu merken.</li>';
}
$('#markList').addEventListener('click', async (e) => {
  const d = e.target.closest('[data-mkdel]');
  if (d) {
    curState.bookmarks = curState.bookmarks.filter((b) => b.id !== d.dataset.mkdel);
    curState.updated = Date.now(); await db.put('states', curState); renderMarks(); onRelocate(); return;
  }
  const m = e.target.closest('[data-mk]'); if (!m) return;
  const bm = curState.bookmarks.find((b) => b.id === m.dataset.mk);
  closePanelIfOverlay();
  if (bm) await view.goTo(bm.pos);
});

let searchRun = 0, searchResults = [];
$('#searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const term = $('#searchInput').value.trim();
  if (term.length < 2) { $('#searchStatus').textContent = 'Bitte mindestens 2 Zeichen eingeben.'; return; }
  const run = ++searchRun;
  $('#searchList').innerHTML = '';
  $('#searchStatus').textContent = 'Suche läuft …';
  const res = await view.search(term, (p) => { if (run === searchRun) $('#searchStatus').textContent = `Suche läuft … ${Math.round(p * 100)} %`; });
  if (run !== searchRun) return;
  searchResults = res;
  $('#searchStatus').textContent = res.length ? `${res.length}${res.length >= 300 ? '+' : ''} Treffer` : 'Keine Treffer.';
  $('#searchList').innerHTML = res.map((r, i) => `<li><button data-res="${i}"><b>${esc(r.label)}</b><span>${esc(r.before)}<mark>${esc(r.match)}</mark>${esc(r.after)}</span></button></li>`).join('');
});
$('#searchList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-res]'); if (!b) return;
  const r = searchResults[+b.dataset.res];
  closePanelIfOverlay();
  await view.goTo(r.pos);
});

// ---------------- Darstellung ----------------
function syncSettingsUi() {
  $$('#panel .stepper[data-key]').forEach((st) => { st.querySelector('output').textContent = settings[st.dataset.key] + ' %'; });
  $$('#panel .seg, #panel .swatches').forEach((sg) => {
    const v = String(settings[sg.dataset.key]);
    sg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  });
  $$('#panel input[type=checkbox][data-key]').forEach((c) => { c.checked = !!settings[c.dataset.key]; });
  $('#brightness').value = settings.brightness;
  $('#targetLang').value = settings.targetLang;
  if (view && cur && cur.type === 'pdf') $('#pdfZoomOut').textContent = view.percentZoom + ' %';
}
function applyEink() { document.body.classList.toggle('eink', !!settings.eink); }
function changed(key) {
  saveSettings(); syncSettingsUi();
  if (key === 'eink') applyEink();
  if (key === 'theme' || key === 'brightness') applyTheme();
  if (key === 'keepAwake') updateWakeLock();
  if (view && !['brightness', 'keepAwake', 'targetLang', 'sort'].includes(key)) view.setSettings(settings);
}
function stepSetting(key, d) {
  const st = $(`#panel .stepper[data-key="${key}"]`);
  const min = +st.dataset.min, max = +st.dataset.max, step = +st.dataset.step;
  settings[key] = Math.max(min, Math.min(max, settings[key] + d * step));
  changed(key);
}
$$('#panel .stepper[data-key]').forEach((st) => st.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-d]'); if (b) stepSetting(st.dataset.key, +b.dataset.d);
}));
$$('#panel .seg, #panel .swatches').forEach((sg) => sg.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-v]'); if (!b) return;
  const key = sg.dataset.key;
  if (key === 'pdfZoom') return setPdfZoom(b.dataset.v);
  settings[key] = b.dataset.v; changed(key);
}));
$$('#panel input[type=checkbox][data-key]').forEach((c) => c.addEventListener('change', () => { settings[c.dataset.key] = c.checked; changed(c.dataset.key); }));
$('#brightness').addEventListener('input', (e) => { settings.brightness = +e.target.value; changed('brightness'); });
$('#targetLang').addEventListener('change', (e) => { settings.targetLang = e.target.value; changed('targetLang'); });

const ZOOM_STEPS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500];
function stepPdfZoom(d) {
  if (!view || cur.type !== 'pdf') return;
  const z = view.percentZoom;
  const next = d > 0 ? ZOOM_STEPS.find((s) => s > z) || 500 : [...ZOOM_STEPS].reverse().find((s) => s < z) || 25;
  setPdfZoom(next);
}
async function setPdfZoom(z) {
  settings.pdfZoom = /^(width|page)$/.test(String(z)) ? z : String(Math.round(+z));
  saveSettings();
  if (view && cur.type === 'pdf') await view.setZoom(settings.pdfZoom);
  syncSettingsUi();
}
$('#pdfZoomStepper').addEventListener('click', (e) => { const b = e.target.closest('[data-zd]'); if (b) stepPdfZoom(+b.dataset.zd); });

// Bildschirm anlassen
async function updateWakeLock() {
  if (android) { android.keepScreenOn(!!(settings.keepAwake && view)); return; }
  if (!settings.keepAwake || !view) return releaseWakeLock();
  try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch {}
}
function releaseWakeLock() { if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; } }

// ---------------- Nachschlagen / Übersetzen ----------------
let dictText = '', dictReq = 0;
function onSelect(text) {
  if (!view) return;
  if (!text) { closeLayer('dict'); return; }
  if (text.length > 500) text = text.slice(0, 500);
  dictText = text;
  $('#dictWord').textContent = text.length > 60 ? text.slice(0, 60) + '…' : text;
  $('#dictBody').textContent = '';
  openLayer('dict');
  const words = text.split(/\s+/).length;
  if (words <= 4) lookupWikipedia(text);
}
document.addEventListener('selectionchange', () => {
  if (!view || cur.type !== 'pdf') return;
  clearTimeout(onSelect._t);
  onSelect._t = setTimeout(() => {
    const sel = document.getSelection();
    if (sel.anchorNode && $('#stage').contains(sel.anchorNode)) onSelect(sel.toString().trim());
  }, 450);
});
function bookLang() { return ((cur && cur.lang) || 'de').slice(0, 2).toLowerCase(); }
async function lookupWikipedia(text) {
  const req = ++dictReq;
  if (!navigator.onLine) { $('#dictBody').textContent = 'Offline – zum Nachschlagen wird Internet benötigt.'; return; }
  const lang = bookLang();
  const clean = text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  const tries = [clean, clean.charAt(0).toUpperCase() + clean.slice(1)];
  $('#dictBody').textContent = 'Suche Kurzinfo …';
  for (const t of [...new Set(tries)]) {
    try {
      const r = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t)}`);
      if (req !== dictReq) return;
      if (!r.ok) continue;
      const j = await r.json();
      if (j.type === 'disambiguation' || !j.extract) continue;
      $('#dictBody').textContent = (j.extract.length > 420 ? j.extract.slice(0, 420) + '…' : j.extract) + '  (Wikipedia)';
      return;
    } catch { break; }
  }
  if (req === dictReq) $('#dictBody').textContent = '';
}
$('#dict').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-look]'); if (!b) return;
  const t = dictText, q = encodeURIComponent(t), lang = bookLang(), tl = settings.targetLang;
  const word = encodeURIComponent(t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
  const urls = {
    wiktionary: `https://${lang}.wiktionary.org/w/index.php?search=${word}&go=1`,
    duden: `https://www.duden.de/suchen/dudenonline/${word}`,
    wikipedia: `https://${lang}.wikipedia.org/w/index.php?search=${word}`,
    deepl: `https://www.deepl.com/translator#auto/${tl}/${q}`,
    google: `https://translate.google.com/?sl=auto&tl=${tl}&text=${q}&op=translate`,
  };
  if (b.dataset.look === 'copy') {
    try { await navigator.clipboard.writeText(t); toast('Kopiert.'); } catch { toast('Kopieren nicht möglich.'); }
    return;
  }
  window.open(urls[b.dataset.look], '_blank', 'noopener');
});

// ---------------- Bild-Lupe ----------------
// Einfach und sparsam: echte Bildgröße statt CSS-Transform, Verschieben per normalem Scrollen,
// begrenzte Pixelzahl (E-Book-Reader haben wenig Speicher), Schließen per ×, Button, Tipp daneben oder Zurück-Taste.
const lb = { z: 1, fit: 1, w: 0, h: 0, maxZ: 4, openedAt: 0 };
function lbLayout(keepCenter) {
  const st = $('#lbStage'), img = $('#lbImg'), inner = $('#lbInner');
  if (!lb.w) return;
  const sw = st.clientWidth, sh = st.clientHeight;
  const cx = keepCenter ? (st.scrollLeft + sw / 2) / Math.max(1, inner.offsetWidth) : 0.5;
  const cy = keepCenter ? (st.scrollTop + sh / 2) / Math.max(1, inner.offsetHeight) : 0.5;
  const w = Math.max(1, Math.round(lb.w * lb.z)), h = Math.max(1, Math.round(lb.h * lb.z));
  const iw = Math.max(sw, w), ih = Math.max(sh, h);
  inner.style.width = iw + 'px'; inner.style.height = ih + 'px';
  img.style.width = w + 'px'; img.style.height = h + 'px';
  img.style.left = Math.round((iw - w) / 2) + 'px'; img.style.top = Math.round((ih - h) / 2) + 'px';
  st.scrollLeft = Math.max(0, cx * iw - sw / 2); st.scrollTop = Math.max(0, cy * ih - sh / 2);
  $('#lbPct').textContent = Math.round(lb.z * 100) + ' %';
}
function lbZoom(z) {
  if (!isFinite(z) || z <= 0) z = lb.fit;
  lb.z = Math.max(Math.min(0.25, lb.fit), Math.min(lb.maxZ, z));
  lbLayout(true);
}
function openLightbox(src) {
  const img = $('#lbImg');
  lb.w = 0;
  img.onload = () => {
    const st = $('#lbStage');
    lb.w = img.naturalWidth || 600; lb.h = img.naturalHeight || 400;
    const fit = Math.min((st.clientWidth - 16) / lb.w, (st.clientHeight - 16) / lb.h);
    lb.fit = isFinite(fit) && fit > 0 ? Math.min(fit, 4) : 1;
    lb.maxZ = Math.max(lb.fit, Math.min(4, Math.sqrt(12e6 / (lb.w * lb.h))));
    lb.z = lb.fit; lbLayout(false);
  };
  img.onerror = () => { toast('Bild kann nicht vergrößert werden.'); closeLightbox(); };
  img.src = src;
  lb.openedAt = Date.now();
  openLayer('lightbox');
  try { history.pushState({ lb: 1 }, '', '#bild'); } catch {}
}
function closeLightbox() {
  if ($('#lightbox').hidden) return;
  closeLayer('lightbox');
  $('#lbImg').removeAttribute('src');
  if (location.hash === '#bild') { try { history.back(); } catch {} }
}
window.addEventListener('popstate', () => { if (!$('#lightbox').hidden && location.hash !== '#bild') { closeLayer('lightbox'); $('#lbImg').removeAttribute('src'); } });
const lbCloseBtn = () => { if (Date.now() - lb.openedAt > 400) closeLightbox(); };
$('#lbClose').addEventListener('click', lbCloseBtn);
$('#lbBack').addEventListener('click', lbCloseBtn);
$('#lbIn').addEventListener('click', () => lbZoom(lb.z * 1.25));
$('#lbOut').addEventListener('click', () => lbZoom(lb.z / 1.25));
$('#lbFit').addEventListener('click', () => { lb.z = lb.fit; lbLayout(false); });
const lbStage = $('#lbStage');
// Tipp neben das Bild schließt, Doppeltipp zoomt
let lbTap = 0;
lbStage.addEventListener('click', (e) => {
  if (Date.now() - lb.openedAt < 600) return; // Nachklick des Öffnen-Tipps ignorieren
  if (e.target !== $('#lbImg')) { closeLightbox(); return; }
  const now = Date.now();
  if (now - lbTap < 350) { lbZoom(lb.z > lb.fit * 1.05 ? lb.fit : lb.fit * 2.5); lbTap = 0; } else lbTap = now;
});
lbStage.addEventListener('wheel', (e) => { if (!e.ctrlKey) return; e.preventDefault(); lbZoom(lb.z * (e.deltaY < 0 ? 1.12 : 1 / 1.12)); }, { passive: false });
// Zwei-Finger-Zoom
let lbPinch = null, lbRaf = 0;
lbStage.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2) { const [a, b] = e.touches; lbPinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1, z: lb.z }; }
}, { passive: true });
lbStage.addEventListener('touchmove', (e) => {
  if (!lbPinch || e.touches.length !== 2) return;
  e.preventDefault();
  const [a, b] = e.touches;
  const z = lbPinch.z * Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / lbPinch.d;
  if (!lbRaf) lbRaf = requestAnimationFrame(() => { lbRaf = 0; lbZoom(z); });
}, { passive: false });
lbStage.addEventListener('touchend', (e) => { if (e.touches.length < 2) lbPinch = null; });

// ================= Start =================
function browserInfo() {
  const m = navigator.userAgent.match(/Chrom(?:e|ium)\/(\d+)/);
  return m ? `Browser-Engine: Chromium ${m[1]}` : 'Browser-Engine: unbekannt';
}
async function init() {
  applyEink();
  if ('serviceWorker' in navigator && location.protocol !== 'file:' && !document.getElementById('sr-pdfjs')) navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
  await loadLibrary();
  if (!getDevice()) askDevice();
  await handleShare();
  if (android) { androidBg(cssToHex(getComputedStyle(document.body).backgroundColor)); window.aoCheckFiles(); }
  if (location.hash === '#lesen') history.replaceState(null, '', location.pathname + location.search);
}
init();
