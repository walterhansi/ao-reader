// Kleine Nachrüstungen für ältere Browser (z. B. E-Book-Reader mit altem Android-WebView)
if (typeof Blob !== 'undefined') {
  if (!Blob.prototype.arrayBuffer) {
    Blob.prototype.arrayBuffer = function () {
      return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsArrayBuffer(this); });
    };
  }
  if (!Blob.prototype.text) {
    Blob.prototype.text = function () {
      return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsText(this); });
    };
  }
}
