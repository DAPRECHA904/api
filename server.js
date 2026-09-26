const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const STREAM = 'http://mogullustradio.shoutcastnet.com:30800/stream';
const ORIGIN = 'http://mogullustradio.shoutcastnet.com:30800';
const PORT = Number(process.env.PORT || 3000);
let state = { title: '', status: 'Connecting to radio station', updatedAt: null };
let checking = false;

async function fromStats() {
  for (const endpoint of ['/stats?sid=1&json=1', '/stats?json=1', '/7.html']) {
    try {
      const response = await fetch(ORIGIN + endpoint, { signal: AbortSignal.timeout(4500), headers: { 'User-Agent': 'SlowTideNowPlaying/1.0' } });
      if (!response.ok) continue;
      const body = await response.text();
      if (endpoint.endsWith('.html')) {
        const match = body.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
        const fields = (match ? match[1] : body).replace(/<[^>]*>/g, '').split(',');
        if (fields.length >= 7 && fields.slice(6).join(',').trim()) return fields.slice(6).join(',').trim();
      } else {
        const data = JSON.parse(body);
        const item = Array.isArray(data) ? data[0] : (data.streams?.[0] || data);
        const title = item.songtitle || item.songTitle || item.currentSong || item.title;
        if (typeof title === 'string' && title.trim()) return title.trim();
      }
    } catch (_) { /* Try the next metadata method. */ }
  }
  return '';
}

function fromIcy() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value = '') => { if (!settled) { settled = true; resolve(value); } };
    const req = http.get(STREAM, { headers: { 'Icy-MetaData': '1', 'User-Agent': 'SlowTideNowPlaying/1.0' }, timeout: 6500 }, (res) => {
      const interval = Number(res.headers['icy-metaint']);
      if (!Number.isSafeInteger(interval) || interval <= 0 || interval > 2000000) { res.destroy(); finish(); return; }
      let remaining = interval, metadataBytes = -1, pieces = [], received = 0;
      res.on('data', (chunk) => {
        let i = 0;
        while (i < chunk.length) {
          if (remaining > 0) { const n = Math.min(remaining, chunk.length - i); i += n; remaining -= n; continue; }
          if (metadataBytes < 0) { metadataBytes = chunk[i++] * 16; if (metadataBytes === 0) { res.destroy(); finish(); return; } }
          const n = Math.min(metadataBytes - received, chunk.length - i);
          pieces.push(chunk.subarray(i, i + n)); received += n; i += n;
          if (received === metadataBytes) {
            const metadata = Buffer.concat(pieces).toString('utf8');
            const match = metadata.match(/StreamTitle='([^']*)'/i);
            res.destroy(); finish(match?.[1]?.trim() || ''); return;
          }
        }
      });
      res.on('error', () => finish()); res.on('end', () => finish());
    });
    req.on('timeout', () => req.destroy()); req.on('error', () => finish());
    setTimeout(() => { req.destroy(); finish(); }, 7500);
  });
}

async function checkStation() {
  if (checking) return;
  checking = true;
  try {
    const title = (await fromStats()) || (await fromIcy());
    if (title) state = { title, status: 'Live', updatedAt: new Date().toISOString() };
    else state = { ...state, status: state.title ? 'Last known song — station unavailable' : 'Waiting for station metadata' };
  } finally { checking = false; }
}

const html = fs.readFileSync(path.join(__dirname, 'index.html'));
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/now-playing') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(state));
  } else if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(html);
  } else { res.writeHead(404); res.end('Not found'); }
}).listen(PORT, '0.0.0.0', () => console.log(`Slow Tide display running on port ${PORT}`));
checkStation();
setInterval(checkStation, 15000);
