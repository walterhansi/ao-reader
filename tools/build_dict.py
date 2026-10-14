#!/usr/bin/env python3
"""Baut aus dem Ding-Wörterbuch (TU Chemnitz, GPL) das Offline-Wörterbuch Englisch → Deutsch für ao Reader.

Eingabe: de-en.txt (Ding-Format: "Deutsch | Deutsch2 :: English | English2", Synonyme mit ";")
Ausgabe: dict/en-de.zip mit Teildateien <präfix>.tsv (Zeilen: schlüssel \t englisch \t deutsch)
         dict/meta.json mit Zahlen für die App
Aufruf:  python3 tools/build_dict.py de-en.txt dict
"""
import json, os, re, sys, zipfile, datetime
from collections import defaultdict

MAX_WORDS = 6        # längere englische Wendungen weglassen
MAX_DE = 180         # deutsche Übersetzung kürzen
MAX_PER_KEY = 14     # Einträge je Stichwort

ANNOT = re.compile(r'\{[^}]*\}|\[[^\]]*\]|<[^>]*>|/[^/\s][^/]*/')
ABBR = re.compile(r'/([^/\s][^/]*)/')
PAREN = re.compile(r'\([^)]*\)')
SPACES = re.compile(r'\s+')


def split_top(s, sep):
    """An sep trennen, aber nicht innerhalb von Klammern."""
    out, depth, cur, i = [], 0, [], 0
    while i < len(s):
        c = s[i]
        if c in '([{<': depth += 1
        elif c in ')]}>': depth = max(0, depth - 1)
        if depth == 0 and s.startswith(sep, i):
            out.append(''.join(cur)); cur = []; i += len(sep); continue
        cur.append(c); i += 1
    out.append(''.join(cur))
    return [x.strip() for x in out]


def key_of(term):
    k = ANNOT.sub(' ', term)
    k = PAREN.sub(' ', k)
    k = SPACES.sub(' ', k).strip().lower()
    k = k.replace('’', "'")
    if k.startswith('to ') and len(k) > 3: k = k[3:]
    k = k.strip(' .,;:!?"')
    return k


def keys_of(term):
    """Hauptschlüssel, Abkürzungen (/Lt./) und Variante ohne Bindestrich."""
    out = []
    k = key_of(term)
    if k: out.append(k)
    for a in ABBR.findall(term):
        for part in a.split('/'):
            ak = key_of(part)
            if ak and ak not in out: out.append(ak)
    for x in list(out):
        if '-' in x:
            v = x.replace('-', '')
            if v and v not in out: out.append(v)
    return out


def clean_display(term):
    t = re.sub(r'<[^>]*>', '', term)
    return SPACES.sub(' ', t).strip()


def main(src, outdir):
    index = defaultdict(list)
    lines = 0
    # Eigene Ergänzungen (US-Krimi-Slang) zuerst, damit sie oben stehen
    extra = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'slang-en-de.tsv')
    if os.path.exists(extra):
        with open(extra, encoding='utf-8') as f:
            for line in f:
                line = line.rstrip('\n')
                if not line or line.startswith('#') or '\t' not in line: continue
                en, de = line.split('\t', 1)
                for term in split_top(en, '; '):
                    for k in keys_of(term):
                        index[k].append((clean_display(term), de.strip()))
    with open(src, encoding='utf-8', errors='replace') as f:
        for line in f:
            line = line.rstrip('\n')
            if not line or line.startswith('#') or ' :: ' not in line: continue
            de, en = line.split(' :: ', 1)
            de_parts, en_parts = split_top(de, ' | '), split_top(en, ' | ')
            lines += 1
            for i, en_sub in enumerate(en_parts):
                de_sub = de_parts[i] if i < len(de_parts) and len(de_parts) == len(en_parts) else de_parts[0]
                de_txt = clean_display(de_sub)
                if not de_txt: continue
                if len(de_txt) > MAX_DE: de_txt = de_txt[:MAX_DE - 1].rstrip() + '…'
                for term in split_top(en_sub, '; '):
                    for k in keys_of(term):
                        if len(k.split(' ')) > MAX_WORDS: continue
                        if not re.match(r"[a-z0-9]", k): continue
                        index[k].append((clean_display(term), de_txt))

    shards = defaultdict(list)
    entries = 0
    for k in sorted(index):
        seen, rows = set(), []
        for en_t, de_t in index[k]:
            sig = (en_t.lower(), de_t)
            if sig in seen: continue
            seen.add(sig); rows.append((en_t, de_t))
            if len(rows) >= MAX_PER_KEY: break
        p = shard_of(k)
        for en_t, de_t in rows:
            shards[p].append(f'{k}\t{en_t.replace(chr(9), " ")}\t{de_t.replace(chr(9), " ")}')
            entries += 1

    os.makedirs(outdir, exist_ok=True)
    zpath = os.path.join(outdir, 'en-de.zip')
    raw = 0
    with zipfile.ZipFile(zpath, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in sorted(shards):
            data = ('\n'.join(shards[p]) + '\n').encode('utf-8')
            raw += len(data)
            z.writestr(p + '.tsv', data)
    meta = {
        'name': 'Ding Englisch → Deutsch', 'source': 'https://dict.tu-chemnitz.de (Frank Richter, TU Chemnitz)',
        'license': 'GNU GPL v2 oder neuer', 'built': datetime.date.today().isoformat(),
        'lines': lines, 'keys': len(index), 'entries': entries, 'shards': len(shards),
        'bytes': os.path.getsize(zpath), 'raw': raw,
    }
    with open(os.path.join(outdir, 'meta.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    print(json.dumps(meta, ensure_ascii=False))


def shard_of(k):
    """Präfix aus den ersten zwei Zeichen (a–z), sonst '_'. Muss zu dictShard() in js/dict.js passen."""
    a = k[0] if 'a' <= k[0] <= 'z' else '_'
    if a == '_': return '_'
    b = k[1] if len(k) > 1 and 'a' <= k[1] <= 'z' else '_'
    return a + b


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
