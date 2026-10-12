package io.github.walterhansi.aoreader;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Message;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * ao Reader als Android-App: zeigt die Web-App in einer WebView und ergänzt,
 * was ein Browser nicht kann (Lautstärketasten zum Blättern, Zurück-Taste,
 * "Öffnen mit", Speichern von Backups, Bildschirm anlassen, Vollbild).
 */
public class MainActivity extends Activity {

    static final String BASE = "https://walterhansi.github.io/ao-reader/";
    static final int REQ_PICK = 1;
    static final int REQ_SAVE = 2;

    WebView web;
    ValueCallback<Uri[]> pickCallback;
    volatile boolean reading = false;
    volatile boolean pageLoaded = false;

    // Dateien, die per "Öffnen mit"/"Teilen" kamen und noch an die Web-App gehen
    final List<Uri> pendingUris = new ArrayList<>();
    final Map<String, InputStream> openStreams = new HashMap<>();
    final Map<String, File> outFiles = new HashMap<>();
    final Map<String, String[]> outMeta = new HashMap<>();
    File saveSource;
    int counter = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window w = getWindow();
        if (Build.VERSION.SDK_INT >= 21) {
            w.setStatusBarColor(Color.parseColor("#E46F00"));
        }

        web = new WebView(this);
        web.setBackgroundColor(Color.WHITE);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setTextZoom(100);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setLoadWithOverviewMode(false);
        s.setUseWideViewPort(true);
        s.setSupportMultipleWindows(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setUserAgentString(s.getUserAgentString() + " aoReaderApp/1");

        web.addJavascriptInterface(new Bridge(), "AoAndroid");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());

        collectIntent(getIntent());
        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        if (web.getUrl() == null) web.loadUrl(BASE);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        collectIntent(intent);
        if (pageLoaded) js("window.aoCheckFiles&&aoCheckFiles()");
    }

    void collectIntent(Intent i) {
        if (i == null) return;
        String a = i.getAction();
        synchronized (pendingUris) {
            if (Intent.ACTION_VIEW.equals(a) && i.getData() != null) {
                pendingUris.add(i.getData());
            } else if (Intent.ACTION_SEND.equals(a)) {
                Object u = i.getParcelableExtra(Intent.EXTRA_STREAM);
                if (u instanceof Uri) pendingUris.add((Uri) u);
            } else if (Intent.ACTION_SEND_MULTIPLE.equals(a)) {
                ArrayList<Uri> list = i.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (list != null) pendingUris.addAll(list);
            }
        }
    }

    void js(final String code) {
        runOnUiThread(new Runnable() {
            public void run() {
                if (Build.VERSION.SDK_INT >= 19) web.evaluateJavascript(code, null);
                else web.loadUrl("javascript:" + code);
            }
        });
    }

    // ---------- Tasten ----------
    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int k = e.getKeyCode();
        boolean next = k == KeyEvent.KEYCODE_VOLUME_DOWN || k == KeyEvent.KEYCODE_PAGE_DOWN;
        boolean prev = k == KeyEvent.KEYCODE_VOLUME_UP || k == KeyEvent.KEYCODE_PAGE_UP;
        if (reading && (next || prev)) {
            if (e.getAction() == KeyEvent.ACTION_DOWN) {
                js(next ? "window.aoNext&&aoNext()" : "window.aoPrev&&aoPrev()");
            }
            return true;
        }
        return super.dispatchKeyEvent(e);
    }

    @Override
    public void onBackPressed() {
        if (!pageLoaded || Build.VERSION.SDK_INT < 19) {
            if (web.canGoBack()) web.goBack(); else super.onBackPressed();
            return;
        }
        web.evaluateJavascript("(window.aoBack&&aoBack())?'ja':'nein'", new ValueCallback<String>() {
            public void onReceiveValue(String v) {
                if (v == null || !v.contains("ja")) finish();
            }
        });
    }

    void applyImmersive() {
        runOnUiThread(new Runnable() {
            public void run() {
                View d = getWindow().getDecorView();
                if (reading && Build.VERSION.SDK_INT >= 19) {
                    d.setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
                } else {
                    d.setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
                }
            }
        });
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && reading) applyImmersive();
    }

    @Override
    protected void onPause() {
        super.onPause();
        js("window.aoPause&&aoPause()");
    }

    // ---------- Datei auswählen / speichern ----------
    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_PICK) {
            if (pickCallback == null) return;
            Uri[] result = null;
            if (res == RESULT_OK && data != null) {
                ClipData clip = data.getClipData();
                if (clip != null && clip.getItemCount() > 0) {
                    result = new Uri[clip.getItemCount()];
                    for (int i = 0; i < clip.getItemCount(); i++) result[i] = clip.getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    result = new Uri[]{data.getData()};
                }
            }
            pickCallback.onReceiveValue(result);
            pickCallback = null;
        } else if (req == REQ_SAVE) {
            File src = saveSource;
            saveSource = null;
            if (src == null) return;
            if (res == RESULT_OK && data != null && data.getData() != null) {
                try {
                    copy(new FileInputStream(src), getContentResolver().openOutputStream(data.getData()));
                    toast("Gespeichert.");
                } catch (Exception ex) {
                    toast("Speichern fehlgeschlagen: " + ex.getMessage());
                }
            } else {
                toast("Speichern abgebrochen.");
            }
            src.delete();
        }
    }

    void startSave(File f, String name, String mime) {
        saveSource = f;
        if (Build.VERSION.SDK_INT >= 19) {
            Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
            i.putExtra(Intent.EXTRA_TITLE, name);
            try {
                startActivityForResult(i, REQ_SAVE);
                return;
            } catch (ActivityNotFoundException ignored) { }
        }
        // Rückfall: im App-eigenen Download-Ordner ablegen
        saveSource = null;
        try {
            File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            if (dir == null) dir = getFilesDir();
            File out = new File(dir, name);
            copy(new FileInputStream(f), new FileOutputStream(out));
            toast("Gespeichert unter " + out.getAbsolutePath());
        } catch (Exception ex) {
            toast("Speichern fehlgeschlagen: " + ex.getMessage());
        }
        f.delete();
    }

    static void copy(InputStream in, OutputStream out) throws Exception {
        try {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        } finally {
            try { in.close(); } catch (Exception ignored) { }
            try { out.close(); } catch (Exception ignored) { }
        }
    }

    void toast(final String msg) {
        runOnUiThread(new Runnable() {
            public void run() { Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show(); }
        });
    }

    String displayName(Uri u) {
        String name = null;
        try {
            Cursor c = getContentResolver().query(u, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null);
            if (c != null) {
                if (c.moveToFirst()) name = c.getString(0);
                c.close();
            }
        } catch (Exception ignored) { }
        if (name == null) name = u.getLastPathSegment();
        return name == null ? "buch" : name;
    }

    // ---------- Brücke zur Web-App ----------
    class Bridge {
        @JavascriptInterface
        public String version() { return "1"; }

        @JavascriptInterface
        public void setReading(boolean r) {
            reading = r;
            applyImmersive();
        }

        @JavascriptInterface
        public void keepScreenOn(final boolean on) {
            runOnUiThread(new Runnable() {
                public void run() {
                    if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            });
        }

        @JavascriptInterface
        public void openExternal(String url) {
            openOutside(url);
        }

        /** Liefert die per "Öffnen mit"/"Teilen" übergebenen Dateien als JSON-Liste. */
        @JavascriptInterface
        public String pendingFiles() {
            JSONArray arr = new JSONArray();
            synchronized (pendingUris) {
                for (Uri u : pendingUris) {
                    try {
                        String id = "f" + (++counter);
                        InputStream in = getContentResolver().openInputStream(u);
                        if (in == null) continue;
                        openStreams.put(id, in);
                        JSONObject o = new JSONObject();
                        o.put("id", id);
                        o.put("name", displayName(u));
                        String t = getContentResolver().getType(u);
                        o.put("type", t == null ? "" : t);
                        arr.put(o);
                    } catch (Exception ex) {
                        toast("Datei kann nicht geöffnet werden: " + ex.getMessage());
                    }
                }
                pendingUris.clear();
            }
            return arr.toString();
        }

        /** Nächstes Stück (Base64) einer übergebenen Datei, "" am Ende. */
        @JavascriptInterface
        public String readChunk(String id) {
            InputStream in = openStreams.get(id);
            if (in == null) return "";
            try {
                byte[] buf = new byte[512 * 1024];
                int total = 0, n;
                while (total < buf.length && (n = in.read(buf, total, buf.length - total)) > 0) total += n;
                if (total <= 0) {
                    in.close();
                    openStreams.remove(id);
                    return "";
                }
                return Base64.encodeToString(buf, 0, total, Base64.NO_WRAP);
            } catch (Exception ex) {
                openStreams.remove(id);
                return "";
            }
        }

        /** Speichern (Backup): beginFile → appendChunk… → finishFile */
        @JavascriptInterface
        public String beginFile(String name, String mime) {
            try {
                String id = "o" + (++counter);
                File f = File.createTempFile("aoreader", ".tmp", getCacheDir());
                outFiles.put(id, f);
                outMeta.put(id, new String[]{name, mime});
                return id;
            } catch (Exception ex) {
                return "";
            }
        }

        @JavascriptInterface
        public boolean appendChunk(String id, String b64) {
            File f = outFiles.get(id);
            if (f == null) return false;
            try {
                FileOutputStream out = new FileOutputStream(f, true);
                out.write(Base64.decode(b64, Base64.DEFAULT));
                out.close();
                return true;
            } catch (Exception ex) {
                return false;
            }
        }

        @JavascriptInterface
        public void finishFile(String id) {
            final File f = outFiles.remove(id);
            final String[] meta = outMeta.remove(id);
            if (f == null || meta == null) return;
            runOnUiThread(new Runnable() {
                public void run() { startSave(f, meta[0], meta[1]); }
            });
        }
    }

    void openOutside(String url) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Exception ex) {
            toast("Kein Browser zum Öffnen des Links gefunden.");
        }
    }

    // ---------- WebView ----------
    class Client extends WebViewClient {
        boolean handle(String url) {
            if (url == null) return false;
            if (url.startsWith(BASE) || url.startsWith("blob:") || url.startsWith("data:")) return false;
            openOutside(url);
            return true;
        }

        @Override
        @SuppressWarnings("deprecation")
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return handle(url);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return handle(request.getUrl().toString());
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            pageLoaded = true;
            synchronized (pendingUris) {
                if (!pendingUris.isEmpty()) js("window.aoCheckFiles&&aoCheckFiles()");
            }
        }

        @Override
        @SuppressWarnings("deprecation")
        public void onReceivedError(WebView view, int code, String description, String failingUrl) {
            if (failingUrl != null && failingUrl.startsWith(BASE)) {
                String html = "<html><head><meta name=viewport content='width=device-width'></head>"
                        + "<body style='font-family:sans-serif;padding:24px;line-height:1.5'>"
                        + "<h2>ao Reader</h2><p>Beim allerersten Start braucht ao Reader einmal Internet, "
                        + "danach funktioniert er offline.</p><p>Bitte WLAN einschalten und die App neu öffnen.</p>"
                        + "<p style='color:#888'>" + description + "</p></body></html>";
                view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
            }
        }
    }

    class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
            if (pickCallback != null) pickCallback.onReceiveValue(null);
            pickCallback = cb;
            Intent i = new Intent(Intent.ACTION_GET_CONTENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("*/*");
            if (params != null && params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            }
            try {
                startActivityForResult(Intent.createChooser(i, "Datei wählen"), REQ_PICK);
            } catch (ActivityNotFoundException ex) {
                pickCallback = null;
                toast("Kein Dateimanager gefunden.");
                return false;
            }
            return true;
        }

        // window.open (Wörterbuch, Übersetzer …) → externer Browser
        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean userGesture, Message resultMsg) {
            WebView tmp = new WebView(MainActivity.this);
            tmp.setWebViewClient(new WebViewClient() {
                boolean done = false;

                void go(WebView v, String url) {
                    if (done) return;
                    done = true;
                    openOutside(url);
                    v.destroy();
                }

                @Override
                @SuppressWarnings("deprecation")
                public boolean shouldOverrideUrlLoading(WebView v, String url) {
                    go(v, url);
                    return true;
                }

                @Override
                public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                    go(v, r.getUrl().toString());
                    return true;
                }

                @Override
                public void onPageStarted(WebView v, String url, android.graphics.Bitmap favicon) {
                    if (url != null && !url.equals("about:blank")) go(v, url);
                }
            });
            WebView.WebViewTransport t = (WebView.WebViewTransport) resultMsg.obj;
            t.setWebView(tmp);
            resultMsg.sendToTarget();
            return true;
        }
    }
}
