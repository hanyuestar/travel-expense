const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'routes.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');
}
function readRoutes() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8') || '[]'); }
  catch (e) { return []; }
}
function writeRoutes(arr) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(arr, null, 2));
}
function uid() {
  return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8' });
  res.end(body);
}
function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { send(res, 404, 'not found'); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];

  // ---- API ----
  if (url === '/api/routes') {
    if (req.method === 'GET') { send(res, 200, JSON.stringify(readRoutes())); return; }
    if (req.method === 'POST') {
      const b = await readBody(req);
      let o; try { o = JSON.parse(b); } catch (e) { send(res, 400, 'invalid json'); return; }
      const arr = readRoutes();
      const rec = Object.assign({ id: uid() }, o);
      arr.unshift(rec);
      writeRoutes(arr);
      send(res, 201, JSON.stringify(rec));
      return;
    }
    if (req.method === 'DELETE') {
      writeRoutes([]);
      send(res, 200, '{"ok":true}');
      return;
    }
  }
  if (url.startsWith('/api/routes/')) {
    const id = decodeURIComponent(url.slice('/api/routes/'.length));
    if (req.method === 'PUT') {
      const b = await readBody(req);
      let o; try { o = JSON.parse(b); } catch (e) { send(res, 400, 'invalid json'); return; }
      const arr = readRoutes();
      const i = arr.findIndex(r => r.id === id);
      if (i < 0) { send(res, 404, 'not found'); return; }
      arr[i] = Object.assign({}, arr[i], o, { id });
      writeRoutes(arr);
      send(res, 200, JSON.stringify(arr[i]));
      return;
    }
    if (req.method === 'DELETE') {
      const arr = readRoutes();
      const nf = arr.filter(r => r.id !== id);
      if (nf.length === arr.length) { send(res, 404, 'not found'); return; }
      writeRoutes(nf);
      send(res, 200, '{"ok":true}');
      return;
    }
  }

  // ---- static ----
  let f = path.join(PUBLIC_DIR, url === '/' ? 'index.html' : url);
  if (!f.startsWith(PUBLIC_DIR)) { send(res, 403, 'forbidden'); return; }
  if (fs.existsSync(f) && fs.statSync(f).isFile()) { sendFile(res, f); return; }
  // SPA fallback
  sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
});

ensureData();
server.listen(PORT, () => console.log('Travel expense workbench listening on :' + PORT));
