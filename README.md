# ao Reader

Persönlicher, schneller E-Book-Reader für **EPUB und PDF** als installierbare Web-App (PWA).
Läuft offline, ohne Konto. Alle Bücher bleiben auf dem Gerät.

## Funktionen

- Bibliothek mit Cover, Fortschritt, Suche und Sortierung, „Weiterlesen“-Karte
- Import per Button, Drag & Drop, „Öffnen mit“ (ChromeOS/Windows) und „Teilen“ (Android)
- Seitenweises Lesen: Tippen links/rechts, Wischen, Pfeiltasten, Bild-auf/ab, Leertaste, Mausrad
- **Fortschrittsbalken unten: festhalten und ziehen** – eine Vorschau zeigt Kapitel, Prozent und ungefähre Seite, beim Loslassen springt das Buch dorthin
- **Prozentuale Größe:** Schrift 60–250 %, Bilder 30–200 % (EPUB), PDF-Zoom 25–500 % (auch Zwei-Finger-Zoom und Strg+Mausrad)
- Bild antippen → Bildlupe mit Zoom 25–400 %, verschieben, Doppeltipp
- Schriftart, Zeilenabstand, Ränder, Ausrichtung, Silbentrennung, 1 oder 2 Spalten
- 10 Farbschemas wie im zeta reader (Hell, Sepia, Dunkel, Nachtblau, Wald, Solarized Hell/Dunkel, Nord, Papier, Lavendel), Helligkeitsregler, E-Ink-Modus, „Bildschirm anlassen“
- Inhaltsverzeichnis, Lesezeichen, Volltextsuche mit Hervorhebung
- **Nachschlagen/Übersetzen:** Text markieren → Kurzinfo aus Wikipedia, Buttons für Wiktionary, Duden, Wikipedia, DeepL, Google Übersetzer, Kopieren (braucht Internet)
- **Backup:** klein (nur Lesestand/Lesezeichen/Einstellungen, .json) oder komplett mit Büchern (.zip). Import führt zusammen – neuerer Lesestand gewinnt.

## Auf GitHub Pages veröffentlichen

1. Auf github.com ein neues Repository anlegen, z. B. `ao-reader` (öffentlich).
2. Den **Inhalt** dieses Ordners hochladen („Add file → Upload files“, alle Dateien und Ordner hineinziehen, dann „Commit changes“).
   `index.html` muss direkt im Hauptverzeichnis liegen.
3. Im Repository: **Settings → Pages → Build and deployment → Source: „Deploy from a branch“**, Branch `main`, Ordner `/ (root)`, speichern.
4. Nach 1–2 Minuten ist die App unter `https://<dein-name>.github.io/ao-reader/` erreichbar.
5. Installieren: in Chrome das Installieren-Symbol in der Adressleiste (Chromebook/PC) bzw. Menü ⋮ → „App installieren“ (Android).

## Updates

Nach Änderungen an Dateien in `sw.js` die Zeile `const CACHE = 'ao-reader-v…'` hochzählen, damit installierte Apps die neue Version laden.

## Technik

Reines HTML/CSS/JavaScript ohne Build-Schritt. EPUB-Darstellung ist eine eigene, schlanke Umsetzung (ZIP-Entpacken über die Browser-Funktion `DecompressionStream`).
PDF über [pdf.js](https://mozilla.github.io/pdf.js/) 3.11.174 (Mozilla, Apache-2.0, Lizenz in `lib/pdfjs/LICENSE`).
Daten liegen in IndexedDB des Browsers. Empfohlen: aktuelles Chrome/Edge (Android, ChromeOS, Windows).
DRM-geschützte Bücher (z. B. Adobe DRM, Kindle) können nicht geöffnet werden.
