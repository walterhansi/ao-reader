// EPUB-Parser und -Ansicht (eigene Implementierung, seitenweise Darstellung per CSS-Spalten)
import { openZip } from './zip.js';

const XLINK = 'http://www.w3.org/1999/xlink';
const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', css: 'text/css', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
  mp3: 'audio/mpeg', mp4: 'video/mp4', xhtml: 'application/xhtml+xml', html: 'text/html', htm: 'text/html',
};

function dirname(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i + 1); }
export function resolvePath(base, rel) {
  if (!rel) return '';
  try {
    const u = new URL(rel, 'https://epub.invalid/' + base);
    if (u.host !== 'epub.invalid') return null; // externer Link
    return decodeURIComponent(u.pathname.slice(1)) + (u.hash || '');
  } catch { return null; }
}
function splitHash(p) { const i = p.indexOf('#'); return i < 0 ? [p, ''] : [p.slice(0, i), decodeURIComponent(p.slice(i + 1))]; }

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) return null;
  return doc;
}
export function parseChapter(text) {
  const cleaned = text.replace(/^﻿/, '');
  let doc = new DOMParser().parseFromString(cleaned, 'application/xhtml+xml');
  if (doc.getElementsByTagName('parsererror').length || !doc.documentElement) {
    doc = new DOMParser().parseFromString(cleaned, 'text/html');
  }
  return doc;
}
function byTag(node, name) { return [...node.getElementsByTagNameNS('*', name)]; }
function firstText(node, name) { const el = byTag(node, name)[0]; return el ? el.textContent.trim() : ''; }

export async function parseEpub(blob) {
  const zip = await openZip(blob);
  const container = parseXml(await zip.text('META-INF/container.xml'));
  if (!container) throw new Error('EPUB beschädigt (container.xml).');
  const rootfile = byTag(container, 'rootfile')[0];
  const opfPath = rootfile.getAttribute('full-path');
  const opfDir = dirname(opfPath);
  const opf = parseXml(await zip.text(opfPath)) || new DOMParser().parseFromString(await zip.text(opfPath), 'text/html');

  const title = firstText(opf, 'title') || 'Ohne Titel';
  const author = byTag(opf, 'creator').map((e) => e.textContent.trim()).filter(Boolean).join(', ');
  const lang = firstText(opf, 'language') || '';

  const manifest = new Map();
  for (const it of byTag(opf, 'item')) {
    const href = resolvePath(opfDir, it.getAttribute('href') || '');
    manifest.set(it.getAttribute('id'), {
      id: it.getAttribute('id'), href, type: it.getAttribute('media-type') || '',
      props: (it.getAttribute('properties') || '').split(/\s+/),
    });
  }
  const spineEl = byTag(opf, 'spine')[0];
  const spine = [];
  for (const ref of byTag(opf, 'itemref')) {
    const m = manifest.get(ref.getAttribute('idref'));
    if (!m || !m.href) continue;
    if (!/html|xml/.test(m.type) && !/\.x?html?$/i.test(m.href)) continue;
    spine.push({ href: m.href, type: m.type, linear: ref.getAttribute('linear') !== 'no' });
  }
  if (!spine.length) throw new Error('EPUB enthält keine lesbaren Kapitel.');

  // Cover
  let coverHref = null;
  for (const m of manifest.values()) if (m.props.includes('cover-image')) coverHref = m.href;
  if (!coverHref) {
    const meta = byTag(opf, 'meta').find((m) => m.getAttribute('name') === 'cover');
    if (meta) { const m = manifest.get(meta.getAttribute('content')); if (m && /image/.test(m.type)) coverHref = m.href; }
  }
  if (!coverHref) {
    for (const m of manifest.values()) if (/image/.test(m.type) && /cover/i.test(m.id + m.href)) { coverHref = m.href; break; }
  }

  // Inhaltsverzeichnis
  let toc = [];
  const navItem = [...manifest.values()].find((m) => m.props.includes('nav'));
  if (navItem && zip.has(navItem.href)) {
    try {
      const nav = parseChapter(await zip.text(navItem.href));
      const navEl = byTag(nav, 'nav').find((n) => (n.getAttribute('epub:type') || n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || '').includes('toc')) || byTag(nav, 'nav')[0];
      const navDir = dirname(navItem.href);
      const walk = (ol, level) => {
        const out = [];
        for (const li of [...ol.children].filter((c) => c.localName === 'li')) {
          const a = [...li.children].find((c) => c.localName === 'a' || c.localName === 'span');
          const sub = [...li.children].find((c) => c.localName === 'ol');
          const href = a && a.getAttribute('href') ? resolvePath(navDir, a.getAttribute('href')) : null;
          out.push({ label: (a ? a.textContent : '').replace(/\s+/g, ' ').trim() || '•', href, level, children: sub ? walk(sub, level + 1) : [] });
        }
        return out;
      };
      const ol = navEl && byTag(navEl, 'ol')[0];
      if (ol) toc = walk(ol, 0);
    } catch (e) { console.warn('nav', e); }
  }
  if (!toc.length) {
    const ncxId = spineEl && spineEl.getAttribute('toc');
    const ncx = (ncxId && manifest.get(ncxId)) || [...manifest.values()].find((m) => /ncx/.test(m.type));
    if (ncx && zip.has(ncx.href)) {
      const ndoc = parseXml(await zip.text(ncx.href));
      const ndir = dirname(ncx.href);
      const walk = (parent, level) => [...parent.children].filter((c) => c.localName === 'navPoint').map((np) => {
        const label = byTag(np, 'text')[0];
        const content = [...np.children].find((c) => c.localName === 'content');
        return {
          label: label ? label.textContent.replace(/\s+/g, ' ').trim() : '•',
          href: content ? resolvePath(ndir, content.getAttribute('src')) : null,
          level, children: walk(np, level + 1),
        };
      });
      const navMap = ndoc && byTag(ndoc, 'navMap')[0];
      if (navMap) toc = walk(navMap, 0);
    }
  }

  return { zip, title, author, lang, manifest, spine, toc, coverHref };
}

// Zeichenanzahl je Kapitel (für Fortschritt und Seitenschätzung)
export async function chapterChars(book) {
  const out = [];
  for (const it of book.spine) {
    try {
      const t = await book.zip.text(it.href);
      const body = t.replace(/^[\s\S]*?<body[^>]*>/i, '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
      out.push(body.replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').length);
    } catch { out.push(0); }
  }
  return out;
}

export async function epubMeta(blob) {
  const book = await parseEpub(blob);
  let cover = null;
  if (book.coverHref && book.zip.has(book.coverHref)) {
    const ext = book.coverHref.split('.').pop().toLowerCase();
    cover = await book.zip.blob(book.coverHref, MIME[ext] || 'image/jpeg');
  }
  return { title: book.title, author: book.author, lang: book.lang, cover, chars: await chapterChars(book) };
}

// ------------------------------------------------------------------
export class EpubView {
  constructor(host, blob, meta, settings, events) {
    this.host = host; this.blob = blob; this.meta = meta; this.s = settings; this.ev = events;
    this.ch = 0; this.page = 0; this.pages = 1; this.resCache = new Map(); this.cssCache = new Map();
    this.textCache = new Map(); this.busy = false; this.cpp = 1500;
  }

  async open(pos) {
    this.book = await parseEpub(this.blob);
    const chars = (this.meta.chars && this.meta.chars.length === this.book.spine.length) ? this.meta.chars : await chapterChars(this.book);
    this.meta.chars = chars;
    this.weights = chars.map((c) => Math.max(c, 300));
    this.cum = [0];
    for (const w of this.weights) this.cum.push(this.cum[this.cum.length - 1] + w);
    this.total = this.cum[this.cum.length - 1];
    this.lang = this.book.lang;
    this.flatToc = [];
    const flat = (items) => items.forEach((t) => {
      if (t.href) { const [p, frag] = splitHash(t.href); t.ch = this.book.spine.findIndex((s) => s.href === p); t.anchor = frag; }
      else t.ch = -1;
      this.flatToc.push(t); flat(t.children);
    });
    flat(this.book.toc);

    this.frame = document.createElement('iframe');
    this.frame.className = 'epub-frame';
    this.frame.setAttribute('sandbox', 'allow-same-origin');
    this.frame.setAttribute('title', 'Buchinhalt');
    this.frame.srcdoc = '<!DOCTYPE html><html><head><meta charset="utf-8"><style id="sr-base"></style><style id="sr-user"></style></head><body></body></html>';
    this.host.appendChild(this.frame);
    await new Promise((r) => this.frame.addEventListener('load', r, { once: true }));
    this.doc = this.frame.contentDocument;
    this.win = this.frame.contentWindow;
    this.bindInput();
    this.ro = new ResizeObserver(() => { clearTimeout(this._rt); this._rt = setTimeout(() => this.relayout(), 180); });
    this.ro.observe(this.host);
    const p = pos && typeof pos.ch === 'number' ? pos : { ch: 0, frac: 0 };
    await this.loadChapter(Math.min(p.ch, this.book.spine.length - 1), { frac: p.frac || 0 });
  }

  destroy() {
    this.ro && this.ro.disconnect();
    for (const u of this.resCache.values()) URL.revokeObjectURL(u);
    this.frame && this.frame.remove();
  }

  // ---------- Ressourcen ----------
  async resUrl(path) {
    if (this.resCache.has(path)) return this.resCache.get(path);
    if (!this.book.zip.has(path)) return '';
    const ext = path.split('.').pop().toLowerCase();
    let type = MIME[ext] || '';
    for (const m of this.book.manifest.values()) if (m.href === path && m.type) type = m.type;
    let blob;
    if (type === 'text/css') blob = new Blob([await this.cssText(path)], { type });
    else blob = await this.book.zip.blob(path, type);
    const url = URL.createObjectURL(blob);
    this.resCache.set(path, url);
    return url;
  }
  async rewriteCss(css, base) {
    css = css.replace(/@import[^;]+;/g, '');
    const urls = new Set();
    css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => { urls.add(u); return m; });
    const map = new Map();
    for (const u of urls) {
      if (/^(data:|blob:|https?:)/i.test(u)) continue;
      const p = resolvePath(base, u);
      if (p) map.set(u, await this.resUrl(splitHash(p)[0]));
    }
    return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => (map.get(u) ? `url("${map.get(u)}")` : m));
  }
  async cssText(path) {
    if (this.cssCache.has(path)) return this.cssCache.get(path);
    let css = '';
    try { css = await this.rewriteCss(await this.book.zip.text(path), path); } catch {}
    this.cssCache.set(path, css);
    return css;
  }

  async chapterText(i) {
    if (this.textCache.has(i)) return this.textCache.get(i);
    const d = parseChapter(await this.book.zip.text(this.book.spine[i].href));
    const body = d.body || byTag(d, 'body')[0] || d.documentElement;
    byTag(body, 'script').forEach((s) => s.remove());
    const t = body.textContent;
    this.textCache.set(i, t);
    return t;
  }

  // ---------- Kapitel laden ----------
  async loadChapter(i, opt = {}) {
    i = Math.max(0, Math.min(i, this.book.spine.length - 1));
    const token = (this._loadToken = (this._loadToken || 0) + 1);
    const item = this.book.spine[i];
    const src = parseChapter(await this.book.zip.text(item.href));
    const srcBody = src.body || byTag(src, 'body')[0];
    const head = src.head || byTag(src, 'head')[0];

    // Stylesheets
    const styles = [];
    if (head) {
      for (const el of [...head.children]) {
        if (el.localName === 'link' && /stylesheet/i.test(el.getAttribute('rel') || '')) {
          const p = resolvePath(item.href, el.getAttribute('href'));
          if (p) styles.push(await this.cssText(splitHash(p)[0]));
        } else if (el.localName === 'style') {
          styles.push(await this.rewriteCss(el.textContent, item.href));
        }
      }
    }
    const body = srcBody || src.documentElement;
    byTag(body, 'script').forEach((s) => s.remove());
    for (const el of byTag(body, 'style')) el.textContent = await this.rewriteCss(el.textContent, item.href);
    for (const el of [...body.querySelectorAll('[src]')]) {
      const p = resolvePath(item.href, el.getAttribute('src'));
      if (p) el.setAttribute('src', await this.resUrl(splitHash(p)[0]));
    }
    for (const el of byTag(body, 'image')) {
      const h = el.getAttributeNS(XLINK, 'href') || el.getAttribute('href');
      const p = h && resolvePath(item.href, h);
      if (p) { const u = await this.resUrl(splitHash(p)[0]); el.setAttributeNS(XLINK, 'xlink:href', u); el.setAttribute('href', u); }
    }
    if (token !== this._loadToken) return;

    const doc = this.doc;
    doc.querySelectorAll('style.pub').forEach((s) => s.remove());
    const userStyle = doc.getElementById('sr-base');
    for (const css of styles) {
      const st = doc.createElement('style'); st.className = 'pub'; st.textContent = css;
      doc.head.insertBefore(st, userStyle);
    }
    const htmlLang = (src.documentElement.getAttribute('lang') || src.documentElement.getAttribute('xml:lang') || this.lang || 'de');
    doc.documentElement.lang = htmlLang;
    const newBody = doc.importNode(body, true);
    let bodyEl;
    if (newBody.localName === 'body') bodyEl = newBody;
    else { bodyEl = doc.createElement('body'); bodyEl.appendChild(newBody); }
    doc.body.replaceWith(bodyEl);
    this.ch = i;
    this.applyStyles();
    await this.waitImages();
    if (token !== this._loadToken) return;
    this.measure();
    this.applyImageScale();
    this.measure();

    let page = 0;
    if (opt.toEnd) page = this.pages - 1;
    else if (opt.anchor) page = this.pageOfElement(doc.getElementById(opt.anchor) || doc.getElementsByName(opt.anchor)[0]);
    else if (opt.search) page = this.highlightSearch(opt.search.term, opt.search.n);
    else if (opt.frac) page = Math.min(this.pages - 1, Math.round(opt.frac * this.pages));
    if (!opt.search) this.clearHighlight();
    this.show(page);
  }

  waitImages() {
    const imgs = [...this.doc.images];
    const ps = imgs.map((img) => (img.complete ? Promise.resolve() : new Promise((r) => { img.onload = img.onerror = r; })));
    return Promise.race([Promise.all(ps), new Promise((r) => setTimeout(r, 2500))]);
  }

  // ---------- Layout ----------
  geometry() {
    const W = Math.floor(this.host.clientWidth);
    const H = Math.floor(this.host.clientHeight);
    let cols = this.s.columns === '2' ? 2 : this.s.columns === '1' ? 1 : (W >= 900 && W > H ? 2 : 1);
    const mm = { s: 12, m: Math.max(20, W * 0.04), l: Math.max(36, W * 0.08) };
    let m = Math.round(mm[this.s.margin] || mm.m);
    if (cols === 1 && W - 2 * m > 780) m = Math.round((W - 780) / 2);
    const pt = 6, pb = 4;
    return { W, H, cols, m, pt, pb, cw: (W - 2 * m * cols) / cols, chh: H - pt - pb };
  }

  applyStyles() {
    const g = (this.g = this.geometry());
    const s = this.s;
    let th = THEMES[s.theme] || THEMES.light;
    if (s.eink && s.theme === 'light') th = { ...th, fg: '#000000', link: '#000000' };
    const recolor = s.theme !== 'light' || s.eink;
    this.doc.getElementById('sr-base').textContent = `
html{margin:0!important;padding:0!important;height:${g.H}px!important;width:${g.W}px!important;overflow:hidden!important;background:${th.bg}!important;touch-action:none;-webkit-text-size-adjust:100%;}
body{box-sizing:border-box!important;margin:0!important;height:${g.H}px!important;width:${g.W}px!important;max-width:none!important;min-height:0!important;
padding:${g.pt}px ${g.m}px ${g.pb}px ${g.m}px!important;column-count:${g.cols}!important;column-gap:${2 * g.m}px!important;column-fill:auto!important;
overflow:visible!important;background:${th.bg}!important;color:${th.fg}!important;transform:translateX(0);will-change:transform;}
img,svg,video{max-width:100%!important;max-height:${g.chh}px!important;box-sizing:border-box;}
img{object-fit:contain;}
svg{height:auto;}
a{color:${th.link}!important;}
::selection{background:${th.sel};}
::highlight(sr-search){background-color:#ffd54a;color:#000;}
${recolor ? `body *:not(img):not(svg):not(svg *){color:inherit!important;background-color:transparent!important;border-color:${th.fg}55!important;}` : ''}
`;
    const ff = { serif: 'Georgia, "Iowan Old Style", "Noto Serif", "Times New Roman", serif', sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", Arial, sans-serif', mono: 'ui-monospace, "Cascadia Mono", "Roboto Mono", Menlo, monospace' }[s.font];
    let css = `html{font-size:${s.fontSize}%!important;} body{font-size:1rem!important;}`;
    if (ff) css += `body,body *:not(code):not(pre):not(kbd):not(samp){font-family:${ff}!important;}`;
    if (s.lineHeight !== 'orig') css += `body,body p,body div,body li,body blockquote,body span{line-height:${s.lineHeight}!important;}`;
    if (s.align === 'left') css += `body p,body div{text-align:left!important;}`;
    if (s.align === 'justify') css += `body p{text-align:justify!important;}`;
    if (s.hyphens) css += `body,body p{hyphens:auto!important;-webkit-hyphens:auto!important;}`;
    this.doc.getElementById('sr-user').textContent = css;
  }

  applyImageScale() {
    const k = (this.s.imageScale || 100) / 100;
    const g = this.g;
    for (const img of this.doc.images) {
      img.style.removeProperty('width'); img.style.removeProperty('height');
      img.style.removeProperty('max-width'); img.style.removeProperty('max-height');
    }
    for (const svg of this.doc.querySelectorAll('svg')) svg.style.removeProperty('width'), svg.style.removeProperty('height');
    if (k === 1) return;
    const imgs = [...this.doc.images].map((img) => ({ img, r: img.getBoundingClientRect() }));
    for (const { img, r } of imgs) {
      if (!r.width || !r.height) continue;
      let w = r.width * k, h = r.height * k;
      const f = Math.min(1, g.cw / w, g.chh / h);
      w *= f; h *= f;
      img.style.setProperty('width', w + 'px', 'important');
      img.style.setProperty('height', h + 'px', 'important');
      img.style.setProperty('max-width', 'none', 'important');
      img.style.setProperty('max-height', 'none', 'important');
    }
    if (k < 1) {
      for (const svg of this.doc.querySelectorAll('svg')) {
        if (svg.closest('svg') !== svg) continue;
        const r = svg.getBoundingClientRect();
        if (!r.width) continue;
        svg.style.setProperty('width', r.width * k + 'px', 'important');
        svg.style.setProperty('height', r.height * k + 'px', 'important');
      }
    }
  }

  measure() {
    const root = this.doc.documentElement;
    const W = this.g.W;
    this.pages = Math.max(1, Math.ceil((root.scrollWidth - 2) / W));
    const c = this.meta.chars[this.ch];
    if (c > 800 && this.pages > 1) this.cpp = c / this.pages;
  }

  show(page) {
    this.page = Math.max(0, Math.min(page, this.pages - 1));
    this.doc.body.style.transform = `translateX(${-this.page * this.g.W}px)`;
    this.ev.relocate && this.ev.relocate();
  }

  async relayout() {
    if (!this.doc || !this.doc.body) return;
    const frac = this.page / this.pages;
    this.applyStyles();
    this.measure();
    this.applyImageScale();
    this.measure();
    this.show(Math.min(this.pages - 1, Math.round(frac * this.pages)));
  }

  setSettings(s) { this.s = s; this.relayout(); }

  pageOfElement(el) {
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(this.pages - 1, Math.floor((r.left + this.page * this.g.W + 1) / this.g.W)));
  }

  // ---------- Navigation ----------
  async next() {
    if (this.busy) return;
    if (this.page < this.pages - 1) return this.show(this.page + 1);
    if (this.ch < this.book.spine.length - 1) { this.busy = true; try { await this.loadChapter(this.ch + 1, {}); } finally { this.busy = false; } }
  }
  async prev() {
    if (this.busy) return;
    if (this.page > 0) return this.show(this.page - 1);
    if (this.ch > 0) { this.busy = true; try { await this.loadChapter(this.ch - 1, { toEnd: true }); } finally { this.busy = false; } }
  }
  getPos() { return { ch: this.ch, frac: this.pages > 0 ? this.page / this.pages : 0 }; }
  async goTo(pos) {
    if (pos.ch === this.ch && !pos.anchor && !pos.search && pos.frac !== undefined) {
      return this.show(Math.min(this.pages - 1, Math.round(pos.frac * this.pages)));
    }
    if (pos.ch === this.ch && pos.anchor) {
      const el = this.doc.getElementById(pos.anchor);
      if (el) return this.show(this.pageOfElement(el));
    }
    await this.loadChapter(pos.ch, pos);
  }
  percentToPos(p) {
    const x = Math.max(0, Math.min(0.99999, p)) * this.total;
    let ch = 0;
    while (ch < this.weights.length - 1 && this.cum[ch + 1] <= x) ch++;
    return { ch, frac: (x - this.cum[ch]) / this.weights[ch] };
  }
  goToPercent(p) { return this.goTo(this.percentToPos(p)); }
  percent() { return (this.cum[this.ch] + (this.page / this.pages) * this.weights[this.ch]) / this.total; }

  chapterTitle(ch, page) {
    let best = null;
    for (const t of this.flatToc) {
      if (t.ch < 0 || t.ch > ch) continue;
      if (t.ch === ch && t.anchor && page !== undefined && ch === this.ch) {
        const el = this.doc.getElementById(t.anchor);
        if (el && this.pageOfElement(el) > page) continue;
      }
      if (!best || t.ch >= best.ch) best = t;
    }
    return best ? best.label : (this.book.title || '');
  }

  info() {
    const pct = this.percent();
    const totalPages = Math.max(1, Math.round(this.total / this.cpp));
    const cur = Math.min(totalPages, Math.floor((this.cum[this.ch] + (this.page / this.pages) * this.weights[this.ch]) / this.cpp) + 1);
    return {
      percent: pct,
      chapter: this.chapterTitle(this.ch, this.page),
      pageLabel: `≈ S. ${cur} / ${totalPages}`,
      chapterPages: `Kapitelseite ${this.page + 1} / ${this.pages}`,
      atStart: this.ch === 0 && this.page === 0,
      atEnd: this.ch === this.book.spine.length - 1 && this.page === this.pages - 1,
    };
  }
  previewLabel(p) {
    const pos = this.percentToPos(p);
    const totalPages = Math.max(1, Math.round(this.total / this.cpp));
    const pg = Math.min(totalPages, Math.floor((p * this.total) / this.cpp) + 1);
    return { title: this.chapterTitle(pos.ch), sub: `${Math.round(p * 100)} % · ≈ S. ${pg} / ${totalPages}` };
  }

  getToc() {
    const map = (items) => items.map((t) => ({ label: t.label, level: t.level, pos: t.ch >= 0 ? { ch: t.ch, anchor: t.anchor } : null, children: map(t.children) }));
    const toc = map(this.book.toc);
    if (toc.length) return toc;
    return this.book.spine.map((s, i) => ({ label: `Abschnitt ${i + 1}`, level: 0, pos: { ch: i, frac: 0 }, children: [] }));
  }
  isCurrentToc(pos) { return pos && pos.ch === this.ch; }

  bookmarkInfo() {
    let snippet = '';
    try {
      const g = this.g;
      for (let y = g.pt + 4; y < g.H / 2 && !snippet; y += 18) {
        const r = this.doc.caretRangeFromPoint(g.m + 4, y);
        if (r && r.startContainer.nodeType === 3) {
          const t = r.startContainer.textContent.slice(r.startOffset);
          let s = t; let n = r.startContainer;
          const w = this.doc.createTreeWalker(this.doc.body, NodeFilter.SHOW_TEXT);
          w.currentNode = n;
          while (s.length < 90 && (n = w.nextNode())) s += ' ' + n.textContent;
          snippet = s.replace(/\s+/g, ' ').trim().slice(0, 90);
        }
      }
    } catch {}
    return { pos: this.getPos(), label: this.chapterTitle(this.ch, this.page), snippet, percent: this.percent() };
  }
  samePage(pos) {
    return pos && pos.ch === this.ch && Math.min(this.pages - 1, Math.round(pos.frac * this.pages)) === this.page;
  }

  // ---------- Suche ----------
  async search(term, onProgress) {
    const q = term.toLowerCase();
    const res = [];
    for (let i = 0; i < this.book.spine.length && res.length < 300; i++) {
      const text = await this.chapterText(i);
      const low = text.toLowerCase();
      let idx = low.indexOf(q), n = 0;
      while (idx >= 0 && res.length < 300) {
        const a = Math.max(0, idx - 40), b = Math.min(text.length, idx + q.length + 50);
        res.push({
          pos: { ch: i, search: { term: q, n } },
          label: this.chapterTitle(i),
          before: (a > 0 ? '…' : '') + text.slice(a, idx).replace(/\s+/g, ' '),
          match: text.slice(idx, idx + q.length),
          after: text.slice(idx + q.length, b).replace(/\s+/g, ' ') + '…',
        });
        n++; idx = low.indexOf(q, idx + q.length);
      }
      onProgress && onProgress((i + 1) / this.book.spine.length);
    }
    return res;
  }
  highlightSearch(term, n) {
    const walker = this.doc.createTreeWalker(this.doc.body, NodeFilter.SHOW_TEXT);
    const nodes = []; let full = '';
    while (walker.nextNode()) { nodes.push({ node: walker.currentNode, start: full.length }); full += walker.currentNode.textContent; }
    const low = full.toLowerCase();
    let idx = -1, from = 0;
    for (let k = 0; k <= n; k++) { idx = low.indexOf(term, from); if (idx < 0) break; from = idx + term.length; }
    if (idx < 0) return 0;
    const locate = (off) => { for (let j = nodes.length - 1; j >= 0; j--) if (nodes[j].start <= off) return { node: nodes[j].node, off: off - nodes[j].start }; return null; };
    const a = locate(idx), b = locate(idx + term.length);
    if (!a || !b) return 0;
    const range = this.doc.createRange();
    range.setStart(a.node, Math.min(a.off, a.node.length));
    range.setEnd(b.node, Math.min(b.off, b.node.length));
    try { if (this.win.CSS && this.win.CSS.highlights) this.win.CSS.highlights.set('sr-search', new this.win.Highlight(range)); } catch {}
    const r = range.getClientRects()[0] || range.getBoundingClientRect();
    return Math.max(0, Math.min(this.pages - 1, Math.floor((r.left + this.page * this.g.W + 1) / this.g.W)));
  }
  clearHighlight() { try { this.win.CSS.highlights.delete('sr-search'); } catch {} }

  // ---------- Eingabe ----------
  bindInput() {
    const d = this.doc;
    let start = null;
    d.addEventListener('pointerdown', (e) => { start = { x: e.clientX, y: e.clientY, t: Date.now(), type: e.pointerType, hadSel: !!d.getSelection().toString().trim() }; });
    d.addEventListener('pointerup', (e) => {
      if (!start) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y, dt = Date.now() - start.t;
      const s = start; start = null;
      const sel = d.getSelection().toString().trim();
      if (s.type !== 'mouse' && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 900 && !sel) {
        dx < 0 ? this.next() : this.prev();
        return;
      }
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8 || dt > 600) return; // Ziehen / langes Drücken = Markieren
      if (sel || s.hadSel) { if (s.hadSel && !sel) this.ev.select && this.ev.select(''); return; }
      const a = e.target.closest && e.target.closest('a[href]');
      if (a) return; // Links behandelt click
      const img = e.target.closest && (e.target.closest('img') || e.target.closest('svg'));
      if (img) {
        const src = img.localName === 'img' ? img.currentSrc || img.src : (img.querySelector('image') && (img.querySelector('image').getAttribute('href') || img.querySelector('image').getAttributeNS(XLINK, 'href')));
        if (src) { this.ev.image && this.ev.image(src); return; }
      }
      const x = e.clientX / this.g.W;
      if (x < 0.3) this.prev(); else if (x > 0.7) this.next(); else this.ev.center && this.ev.center();
    });
    d.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute('href');
      if (/^(https?:|mailto:)/i.test(href)) { this.ev.external && this.ev.external(href); return; }
      const p = resolvePath(this.book.spine[this.ch].href, href);
      if (!p) return;
      const [path, frag] = splitHash(p);
      const ch = path ? this.book.spine.findIndex((s) => s.href === path) : this.ch;
      if (ch >= 0) { this.ev.jumpStart && this.ev.jumpStart(); this.goTo({ ch, anchor: frag || undefined, frac: frag ? undefined : 0 }); }
    });
    let wheelLock = 0;
    d.addEventListener('wheel', (e) => {
      if (e.ctrlKey) return;
      e.preventDefault();
      const now = Date.now();
      if (now < wheelLock || Math.abs(e.deltaY) + Math.abs(e.deltaX) < 4) return;
      wheelLock = now + 280;
      (e.deltaY || e.deltaX) > 0 ? this.next() : this.prev();
    }, { passive: false });
    d.addEventListener('keydown', (e) => this.ev.key && this.ev.key(e));
    let selT;
    d.addEventListener('selectionchange', () => {
      clearTimeout(selT);
      selT = setTimeout(() => this.ev.select && this.ev.select(d.getSelection().toString().trim()), 450);
    });
    d.addEventListener('contextmenu', (e) => { if (d.getSelection().toString().trim()) return; });
  }
}

// Farbschemas wie im Vorbild (zeta reader), Farben dort ausgelesen
export const THEMES = {
  light:     { name: 'Hell',             bg: '#ffffff', fg: '#333333', link: '#1f6f6b', dark: false },
  sepia:     { name: 'Sepia',            bg: '#f4ecd8', fg: '#5b4636', link: '#8a4b16', dark: false },
  dark:      { name: 'Dunkel',           bg: '#1a1a1a', fg: '#cccccc', link: '#7fc7c0', dark: true },
  nightblue: { name: 'Nachtblau',        bg: '#111b21', fg: '#e4e5f1', link: '#8ab4f8', dark: true },
  forest:    { name: 'Wald',             bg: '#2e3b33', fg: '#e8f5e9', link: '#a5d6a7', dark: true },
  sollight:  { name: 'Solarized Hell',   bg: '#fdf6e3', fg: '#657b83', link: '#268bd2', dark: false },
  soldark:   { name: 'Solarized Dunkel', bg: '#002b36', fg: '#839496', link: '#2aa198', dark: true },
  nord:      { name: 'Nord',             bg: '#2e3440', fg: '#d8dee9', link: '#88c0d0', dark: true },
  paper:     { name: 'Papier',           bg: '#f5f5f0', fg: '#2a2a2a', link: '#1f6f6b', dark: false },
  lavender:  { name: 'Lavendel',         bg: '#f3e5f5', fg: '#4a148c', link: '#7b1fa2', dark: false },
};
for (const t of Object.values(THEMES)) t.sel = t.link + '55';
