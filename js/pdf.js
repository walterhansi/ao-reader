// PDF-Ansicht auf Basis von pdf.js (wird erst beim Öffnen eines PDFs geladen)
const BASE = new URL('../lib/pdfjs/', import.meta.url).href;       // pdf.js 3.11 (moderne Browser)
const BASE_OLD = new URL('../lib/pdfjs2/', import.meta.url).href;  // pdf.js 2.16 (ältere Browser, z. B. E-Book-Reader)
const libs = {};

// Kann der Browser pdf.js 3.11? (braucht etwa Chromium 92+)
function modernOk() {
  try {
    if (typeof [].at !== 'function') return false;
    // logische Zuweisung + private Methoden/Felder
    new Function('let a = null; a ||= 1; class X { #b = 1; static #c() { return 1; } m() { return this.#b; } } return new X().m();')();
    return true;
  } catch { return false; }
}
let useOld = false;
try { useOld = localStorage.getItem('sr-pdfjs') === '2'; } catch {}
if (!useOld && !document.getElementById('sr-pdfjs') && !modernOk()) useOld = true;

function loadScriptLib(key, src, workerSrc) {
  if (!libs[key]) {
    libs[key] = new Promise((resolve, reject) => {
      const prev = window.pdfjsLib;
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => {
        const lib = window.pdfjsLib || window['pdfjs-dist/build/pdf'];
        if (!lib) { reject(new Error('PDF-Modul konnte nicht geladen werden.')); return; }
        lib.GlobalWorkerOptions.workerSrc = workerSrc;
        lib.__old = key === 'old';
        if (prev && prev !== lib) window.pdfjsLib = lib;
        resolve(lib);
      };
      s.onerror = () => reject(new Error('PDF-Modul konnte nicht geladen werden.'));
      document.head.appendChild(s);
    });
  }
  return libs[key];
}

export function loadPdfLib() {
  if (useOld) return loadScriptLib('old', BASE_OLD + 'pdf.js', BASE_OLD + 'pdf.worker.js');
  const inline = document.getElementById('sr-pdfjs');
  if (inline) {
    const w = document.getElementById('sr-pdfworker');
    return loadScriptLib('inline', URL.createObjectURL(new Blob([inline.textContent], { type: 'text/javascript' })),
      URL.createObjectURL(new Blob([w.textContent], { type: 'text/javascript' })));
  }
  return loadScriptLib('new', BASE + 'pdf.js', BASE + 'pdf.worker.js');
}

async function openDoc(blob) {
  const buf = await blob.arrayBuffer();
  const attempt = async () => {
    const lib = await loadPdfLib();
    const single = !!document.getElementById('sr-pdfjs') && !useOld;
    const opts = { data: new Uint8Array(buf.slice(0)), isEvalSupported: false };
    if (!single) Object.assign(opts, { cMapUrl: BASE + 'cmaps/', cMapPacked: true, standardFontDataUrl: BASE + 'standard_fonts/' });
    return lib.getDocument(opts).promise;
  };
  try {
    return await attempt();
  } catch (e) {
    const msg = String((e && e.message) || e);
    // Neuer PDF-Kern läuft nicht (z. B. alter Browser): einmalig auf die ältere Version umschalten
    if (!useOld && /worker|WorkerMessageHandler|Unexpected token|is not a function|is not defined|private/i.test(msg)) {
      useOld = true;
      try { localStorage.setItem('sr-pdfjs', '2'); } catch {}
      return attempt();
    }
    throw e;
  }
}

export async function pdfMeta(blob, fileName) {
  const pdf = await openDoc(blob);
  let title = '', author = '';
  try {
    const m = await pdf.getMetadata();
    title = (m.info && m.info.Title) || '';
    author = (m.info && m.info.Author) || '';
  } catch {}
  if (!title || /^untitled|^microsoft word|\.(docx?|pdf)$/i.test(title)) title = fileName.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ');
  let cover = null;
  try {
    const page = await pdf.getPage(1);
    const vp0 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 360 / vp0.width });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    cover = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
  } catch {}
  const pages = pdf.numPages;
  pdf.destroy();
  return { title, author, cover, pages };
}

const CSS_UNITS = 96 / 72;

export class PdfView {
  constructor(host, blob, meta, settings, events) {
    this.host = host; this.blob = blob; this.meta = meta; this.s = settings; this.ev = events;
    this.page = 1; this.textCache = new Map(); this.term = '';
  }

  async open(pos) {
    this.pdf = await openDoc(this.blob);
    this.lib = await loadPdfLib(); // nach openDoc: evtl. auf ältere Version umgeschaltet
    this.n = this.pdf.numPages;
    this.wrap = document.createElement('div');
    this.wrap.className = 'pdf-wrap';
    this.wrap.tabIndex = -1;
    this.pageEl = document.createElement('div');
    this.pageEl.className = 'pdf-page';
    this.wrap.appendChild(this.pageEl);
    this.host.appendChild(this.wrap);
    this.bindInput();
    this.ro = new ResizeObserver(() => { clearTimeout(this._rt); this._rt = setTimeout(() => this.render(), 200); });
    this.ro.observe(this.host);
    this.page = Math.max(1, Math.min(this.n, (pos && pos.page) || 1));
    await this.render();
    try { this.outline = await this.pdf.getOutline(); } catch { this.outline = null; }
  }

  destroy() { this.ro && this.ro.disconnect(); this.task && this.task.cancel(); this.pdf && this.pdf.destroy(); this.wrap && this.wrap.remove(); }

  zoomValue() { return this.s.pdfZoom || 'width'; }

  async render(keepScroll) {
    const token = (this._tok = (this._tok || 0) + 1);
    const page = await this.pdf.getPage(this.page);
    if (token !== this._tok) return;
    const base = page.getViewport({ scale: 1 });
    const cw = this.wrap.clientWidth - 16, chh = this.wrap.clientHeight - 16;
    const z = this.zoomValue();
    let scale;
    if (z === 'width') scale = cw / base.width;
    else if (z === 'page') scale = Math.min(cw / base.width, chh / base.height);
    else scale = (Number(z) / 100) * CSS_UNITS;
    scale = Math.max(0.1, scale);
    this.scale = scale;
    this.percentZoom = Math.round((scale / CSS_UNITS) * 100);
    const vp = page.getViewport({ scale });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let out = dpr;
    const maxPx = 10e6;
    if (vp.width * vp.height * out * out > maxPx) out = Math.sqrt(maxPx / (vp.width * vp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width * out); canvas.height = Math.floor(vp.height * out);
    canvas.style.width = Math.floor(vp.width) + 'px'; canvas.style.height = Math.floor(vp.height) + 'px';
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (this.task) this.task.cancel();
    this.task = page.render({ canvasContext: ctx, viewport: vp, transform: out !== 1 ? [out, 0, 0, out, 0, 0] : null });
    try { await this.task.promise; } catch (e) { if (e && e.name === 'RenderingCancelledException') return; throw e; }
    if (token !== this._tok) return;
    const scrollTop = this.wrap.scrollTop;
    this.pageEl.innerHTML = '';
    this.pageEl.style.transform = '';
    this.pageEl.style.width = Math.floor(vp.width) + 'px';
    this.pageEl.style.height = Math.floor(vp.height) + 'px';
    this.pageEl.style.marginTop = Math.max(8, (this.wrap.clientHeight - vp.height) / 2) + 'px';
    this.pageEl.style.setProperty('--scale-factor', vp.scale);
    this.pageEl.appendChild(canvas);
    const tl = document.createElement('div');
    tl.className = 'textLayer';
    this.pageEl.appendChild(tl);
    this.wrap.scrollTop = keepScroll ? scrollTop : 0;
    this.ev.relocate && this.ev.relocate();
    try {
      const t = this.lib.__old
        ? this.lib.renderTextLayer({ textContentStream: page.streamTextContent(), container: tl, viewport: vp, textDivs: [] })
        : this.lib.renderTextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: vp, textDivs: [] });
      await t.promise;
      if (this.term) this.markTerm(tl);
    } catch (e) { console.warn('textLayer', e); }
  }

  markTerm(tl) {
    let first = null;
    for (const span of tl.querySelectorAll('span')) {
      if (span.textContent.toLowerCase().includes(this.term)) { span.classList.add('hl'); first = first || span; }
    }
    if (first) {
      const r = first.getBoundingClientRect(), wr = this.wrap.getBoundingClientRect();
      if (r.top > wr.bottom - 40 || r.top < wr.top) this.wrap.scrollTop += r.top - wr.top - 80;
    }
  }

  setSettings(s) { this.s = s; this.render(true); }
  setZoom(z) { this.s.pdfZoom = z; return this.render(true); }

  async next() { if (this.page < this.n) { this.page++; await this.render(); } }
  async prev() { if (this.page > 1) { this.page--; await this.render(); } }
  getPos() { return { page: this.page }; }
  async goTo(pos) {
    if (pos.search) this.term = pos.search.term;
    this.page = Math.max(1, Math.min(this.n, pos.page || 1));
    await this.render();
  }
  clearHighlight() { this.term = ''; this.pageEl.querySelectorAll('.hl').forEach((s) => s.classList.remove('hl')); }
  percent() { return this.n > 1 ? (this.page - 1) / (this.n - 1) : 1; }
  pageFromPercent(p) { return Math.max(1, Math.min(this.n, Math.round(p * (this.n - 1)) + 1)); }
  goToPercent(p) { return this.goTo({ page: this.pageFromPercent(p) }); }

  info() {
    return {
      percent: this.percent(), chapter: this.meta.title, pageLabel: `S. ${this.page} / ${this.n}`,
      chapterPages: `Zoom ${this.percentZoom} %`, atStart: this.page === 1, atEnd: this.page === this.n,
    };
  }
  previewLabel(p) { const pg = this.pageFromPercent(p); return { title: `Seite ${pg} von ${this.n}`, sub: `${Math.round(p * 100)} %` }; }

  getToc() {
    const map = (items, level) => (items || []).map((o) => ({ label: o.title, level, pos: { dest: o.dest }, children: map(o.items, level + 1) }));
    const t = map(this.outline, 0);
    if (t.length) return t;
    return [];
  }
  async resolveDest(dest) {
    try {
      const d = typeof dest === 'string' ? await this.pdf.getDestination(dest) : dest;
      if (!d) return null;
      const ref = d[0];
      const idx = typeof ref === 'number' ? ref : await this.pdf.getPageIndex(ref);
      return idx + 1;
    } catch { return null; }
  }
  async goToToc(pos) { const p = await this.resolveDest(pos.dest); if (p) await this.goTo({ page: p }); }

  bookmarkInfo() {
    let snippet = '';
    const tl = this.pageEl.querySelector('.textLayer');
    if (tl) snippet = tl.textContent.replace(/\s+/g, ' ').trim().slice(0, 90);
    return { pos: this.getPos(), label: `Seite ${this.page}`, snippet, percent: this.percent() };
  }
  samePage(pos) { return pos && pos.page === this.page; }

  async pageText(i) {
    if (this.textCache.has(i)) return this.textCache.get(i);
    const page = await this.pdf.getPage(i);
    const tc = await page.getTextContent();
    const t = tc.items.map((it) => it.str + (it.hasEOL ? '\n' : '')).join('');
    this.textCache.set(i, t);
    return t;
  }
  async search(term, onProgress) {
    const q = term.toLowerCase();
    const res = [];
    for (let i = 1; i <= this.n && res.length < 300; i++) {
      const text = await this.pageText(i);
      const low = text.toLowerCase();
      let idx = low.indexOf(q);
      while (idx >= 0 && res.length < 300) {
        const a = Math.max(0, idx - 40), b = Math.min(text.length, idx + q.length + 50);
        res.push({ pos: { page: i, search: { term: q } }, label: `Seite ${i}`, before: (a > 0 ? '…' : '') + text.slice(a, idx).replace(/\s+/g, ' '), match: text.slice(idx, idx + q.length), after: text.slice(idx + q.length, b).replace(/\s+/g, ' ') + '…' });
        idx = low.indexOf(q, idx + q.length);
      }
      if (i % 5 === 0) onProgress && onProgress(i / this.n);
    }
    onProgress && onProgress(1);
    return res;
  }

  bindInput() {
    const w = this.wrap;
    let start = null;
    w.addEventListener('pointerdown', (e) => { start = { x: e.clientX, y: e.clientY, t: Date.now(), hadSel: !!document.getSelection().toString().trim() }; });
    w.addEventListener('pointerup', (e) => {
      if (!start || this.pinching) { start = null; return; }
      const s = start; start = null;
      const dx = e.clientX - s.x, dy = e.clientY - s.y, dt = Date.now() - s.t;
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8 || dt > 600) return;
      if (document.getSelection().toString().trim() || s.hadSel) return;
      const r = w.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      if (x < 0.22) this.prev(); else if (x > 0.78) this.next(); else this.ev.center && this.ev.center();
    });
    // Wischen (nur wenn nicht horizontal gescrollt werden kann)
    let ts = null;
    w.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        const [a, b] = e.touches;
        this.pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), z: this.percentZoom, ratio: 1 };
        this.pinching = true; ts = null;
      } else if (e.touches.length === 1) {
        ts = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now(), sl: w.scrollLeft };
      }
    }, { passive: true });
    w.addEventListener('touchmove', (e) => {
      if (this.pinch && e.touches.length === 2) {
        e.preventDefault();
        const [a, b] = e.touches;
        this.pinch.ratio = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / this.pinch.d;
        this.pageEl.style.transformOrigin = 'center top';
        this.pageEl.style.transform = `scale(${this.pinch.ratio})`;
      }
    }, { passive: false });
    w.addEventListener('touchend', (e) => {
      if (this.pinch && e.touches.length < 2) {
        const z = Math.round(Math.max(25, Math.min(500, this.pinch.z * this.pinch.ratio)));
        this.pinch = null;
        setTimeout(() => { this.pinching = false; }, 50);
        this.ev.zoom && this.ev.zoom(z);
        return;
      }
      if (!ts || e.changedTouches.length !== 1) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - ts.x, dy = t.clientY - ts.y, dt = Date.now() - ts.t;
      const canScrollX = w.scrollWidth > w.clientWidth + 2;
      if (!canScrollX && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 2 && dt < 900 && !document.getSelection().toString().trim()) {
        dx < 0 ? this.next() : this.prev();
      }
      ts = null;
    });
    w.addEventListener('wheel', (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        const z = Math.round(Math.max(25, Math.min(500, this.percentZoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1))));
        this.ev.zoom && this.ev.zoom(z);
        return;
      }
      const canScrollY = w.scrollHeight > w.clientHeight + 2;
      if (!canScrollY) {
        e.preventDefault();
        const now = Date.now();
        if (now < (this._wl || 0)) return;
        this._wl = now + 300;
        e.deltaY > 0 ? this.next() : this.prev();
      }
    }, { passive: false });
  }

  // Leertaste / Pfeil runter: erst scrollen, dann blättern
  scrollOrNext(dir) {
    const w = this.wrap;
    if (dir > 0) {
      if (w.scrollTop + w.clientHeight < w.scrollHeight - 4) { w.scrollBy({ top: w.clientHeight * 0.85, behavior: 'smooth' }); return; }
      this.next();
    } else {
      if (w.scrollTop > 4) { w.scrollBy({ top: -w.clientHeight * 0.85, behavior: 'smooth' }); return; }
      this.prev();
    }
  }
}
