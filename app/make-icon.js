// Draws the office's icons as vector art (SVG) and renders them smooth at every size with headless Chrome:
//  - app/claude-office.ico  the app: a little isometric office with a glowing monitor and a chat bubble
//  - app/lock.ico           "Show office and lock": the office on a monitor, with a padlock
// Small sizes (16–32 px) use simpler drawings so they stay readable in the taskbar and Explorer.
// The app icon is also embedded in public/index.html and public/setup.html as the page icon (Chrome uses it for the
// app window and taskbar). Usage: node app/make-icon.js [--preview]   (--preview also saves app/icon-preview-*.png)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------- Artwork ----------
// Isometric projection of the little office: x and y along the floor (0–100), z up
const P = (x, y, z = 0) => [128 + (x - y) * 0.866, 118 + (x + y) * 0.5 - z];
const pts = (...a) => a.map(p => P(...p).map(n => n.toFixed(1)).join(',')).join(' ');
// A drawing on a wall or screen plane: local units across (u) and down (v), placed at an iso point
const onPlaneY = (x, y, z) => `matrix(0.866 0.5 0 1 ${P(x, y, z).join(' ')})`;    // plane y = const (right wall, monitor)
const onPlaneX = (x, y, z) => `matrix(-0.866 0.5 0 1 ${P(x, y, z).join(' ')})`;   // plane x = const (left wall)
const codeGlyph = (stroke, w) => `<g fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">
  <polyline points="11,7 6,13 11,19"/><line x1="18" y1="6" x2="14" y2="20"/><polyline points="21,7 26,13 21,19"/></g>`;

const room = () => `
  <ellipse cx="128" cy="224" rx="92" ry="12" fill="#000" opacity=".35" filter="url(#soft)"/>
  <!-- back walls -->
  <polygon points="${pts([0, 0, 0], [100, 0, 0], [100, 0, 68], [0, 0, 68])}" fill="url(#wallR)"/>
  <polygon points="${pts([0, 0, 0], [0, 100, 0], [0, 100, 68], [0, 0, 68])}" fill="url(#wallL)"/>
  <polygon points="${pts([0, 0, 0], [100, 0, 0], [100, 0, 14], [0, 0, 14])}" fill="#000" opacity=".12"/>
  <polygon points="${pts([0, 0, 0], [0, 100, 0], [0, 100, 14], [0, 0, 14])}" fill="#000" opacity=".16"/>
  <polyline points="${pts([0, 100, 68], [0, 0, 68], [100, 0, 68])}" fill="none" stroke="#dfe8f5" stroke-width="3" stroke-linejoin="round"/>
  <!-- window and poster -->
  <g transform="${onPlaneY(58, 0, 58)}"><rect x="-2" y="-2" width="32" height="28" rx="2" fill="#f3f6fa"/><rect width="28" height="24" fill="url(#sky)"/>
    <rect x="0" y="16" width="28" height="8" fill="#9fd39a" opacity=".8"/><rect x="13" width="2" height="24" fill="#f3f6fa"/><rect y="11" width="28" height="2" fill="#f3f6fa"/></g>
  <g transform="${onPlaneX(0, 30, 54)}"><rect x="-2" y="-2" width="30" height="24" rx="2" fill="#3a2e26"/><rect width="26" height="20" fill="#fdf6e8"/>
    <rect x="3" y="3" width="11" height="9" fill="#3f6fd8"/><rect x="12" y="9" width="10" height="8" fill="#f2c14e"/><rect x="5" y="12" width="6" height="5" fill="#e0507a"/></g>
  <!-- floor and rug -->
  <polygon points="${pts([0, 0], [100, 0], [100, 100], [0, 100])}" fill="url(#floor)"/>
  <polygon points="${pts([18, 52], [84, 52], [84, 94], [18, 94])}" fill="#2f8f7c" opacity=".85"/>
  <!-- plant -->
  <polygon points="${pts([84, 10, 0], [94, 10, 0], [94, 20, 0], [84, 20, 0])}" fill="#000" opacity=".2"/>
  <path d="M186 158 h14 l-2 12 h-10 z" fill="#c97a4c"/>
  <g fill="#3fa35a"><circle cx="193" cy="146" r="10"/><circle cx="185" cy="152" r="7"/><circle cx="201" cy="151" r="7"/></g>
  <g fill="#6cc27c"><circle cx="196" cy="141" r="5"/><circle cx="188" cy="146" r="4"/></g>
  <!-- desk -->
  <polygon points="${pts([34, 46, 20], [78, 46, 20], [78, 46, 0], [34, 46, 0])}" fill="#b0743f"/>
  <polygon points="${pts([78, 26, 20], [78, 46, 20], [78, 46, 0], [78, 26, 0])}" fill="#8a5a31"/>
  <polygon points="${pts([34, 26, 20], [78, 26, 20], [78, 46, 20], [34, 46, 20])}" fill="#e2ab72"/>
  <!-- monitor with code on the screen, glowing -->
  <ellipse cx="${P(56, 30, 36)[0]}" cy="${P(56, 30, 36)[1]}" rx="34" ry="24" fill="#22c55e" opacity=".35" filter="url(#glow)"/>
  <g transform="${onPlaneY(40, 30, 50)}">
    <rect x="14" y="27" width="4" height="4" fill="#3a3f4a"/>
    <rect x="-3" y="-3" width="38" height="31" rx="3" fill="#1c222c"/>
    <rect width="32" height="25" rx="1.5" fill="url(#screen)"/>
    ${codeGlyph('#b6ffd0', 2.6)}
  </g>
  <!-- someone at the desk, seen from behind -->
  <ellipse cx="124" cy="186" rx="16" ry="5" fill="#000" opacity=".25"/>
  <rect x="111" y="153" width="27" height="28" rx="11" fill="#22c55e"/>
  <rect x="113" y="156" width="7" height="22" rx="3.5" fill="#5bea8c" opacity=".55"/>
  <circle cx="124.5" cy="144" r="11" fill="#2b1d14"/>
  <path d="M116 140 a9 9 0 0 1 14 -4" fill="none" stroke="#5a3d2b" stroke-width="3" stroke-linecap="round"/>`;

const DEFS = `<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#163f2a"/><stop offset="1" stop-color="#06120c"/></linearGradient>
  <radialGradient id="halo" cx=".5" cy=".62" r=".55"><stop offset="0" stop-color="#22c55e" stop-opacity=".28"/><stop offset="1" stop-color="#22c55e" stop-opacity="0"/></radialGradient>
  <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f0cf9c"/><stop offset="1" stop-color="#c58f55"/></linearGradient>
  <linearGradient id="wallR" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b9c8e3"/><stop offset="1" stop-color="#93a7cb"/></linearGradient>
  <linearGradient id="wallL" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9cb0d2"/><stop offset="1" stop-color="#7488b0"/></linearGradient>
  <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fd3f5"/><stop offset="1" stop-color="#d7f0fb"/></linearGradient>
  <linearGradient id="screen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#16a34a"/><stop offset="1" stop-color="#0b3b22"/></linearGradient>
  <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe390"/><stop offset=".55" stop-color="#f2b934"/><stop offset="1" stop-color="#c98a15"/></linearGradient>
  <linearGradient id="steel" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#aab3c2"/><stop offset=".5" stop-color="#f4f7fb"/><stop offset="1" stop-color="#8c96a6"/></linearGradient>
  <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="9"/></filter>
  <filter id="soft" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="5"/></filter>
  <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="6" stdDeviation="7" flood-color="#000" flood-opacity=".5"/></filter>
</defs>`;
const tile = `<rect x="8" y="8" width="240" height="240" rx="56" fill="url(#bg)"/><rect x="8" y="8" width="240" height="240" rx="56" fill="url(#halo)"/>`;
const rim = `<rect x="10.5" y="10.5" width="235" height="235" rx="54" fill="none" stroke="#22c55e" stroke-width="5" opacity=".95"/>
  <rect x="16" y="16" width="224" height="224" rx="48" fill="none" stroke="#ffffff" stroke-opacity=".06" stroke-width="2"/>`;
const svg = (body, view = 256) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${view} ${view}" width="${view}" height="${view}">${DEFS}${body}</svg>`;

// App icon: the little office, and a chat bubble "…" for the AI at work
const appLarge = svg(`${tile}${room()}
  <g filter="url(#shadow)"><path d="M168 24 h56 a14 14 0 0 1 14 14 v20 a14 14 0 0 1 -14 14 h-34 l-14 12 v-12 h-8 a14 14 0 0 1 -14 -14 v-20 a14 14 0 0 1 14 -14 z" fill="#22c55e"/></g>
  <g fill="#04110a"><circle cx="180" cy="48" r="5"/><circle cx="196" cy="48" r="5"/><circle cx="212" cy="48" r="5"/></g>${rim}`);
// Small app icon: a glowing monitor with code, and the green rim
const appSmall = svg(`${tile}
  <ellipse cx="128" cy="120" rx="80" ry="60" fill="#22c55e" opacity=".3" filter="url(#glow)"/>
  <rect x="44" y="60" width="168" height="118" rx="16" fill="#1c222c" stroke="#5a6578" stroke-width="5"/>
  <rect x="58" y="74" width="140" height="90" rx="8" fill="url(#screen)"/>
  <g transform="translate(70 70) scale(4.4)">${codeGlyph('#ffffff', 2.4)}</g>
  <rect x="116" y="178" width="24" height="18" fill="#4a5262"/><rect x="88" y="194" width="80" height="14" rx="7" fill="#8a94a6"/>${rim}`);

// Padlock in front of everything
const padlock = (cx, cy, s) => `<g transform="translate(${cx} ${cy}) scale(${s})" filter="url(#shadow)">
  <path d="M-24 4 V-18 a24 24 0 0 1 48 0 V4" fill="none" stroke="url(#steel)" stroke-width="12" stroke-linecap="round"/>
  <rect x="-40" y="-2" width="80" height="64" rx="14" fill="url(#gold)" stroke="#a8740f" stroke-width="2"/>
  <rect x="-34" y="3" width="68" height="8" rx="4" fill="#fff" opacity=".35"/>
  <circle cx="0" cy="24" r="8.5" fill="#5a3b06"/><rect x="-4" y="26" width="8" height="18" rx="3" fill="#5a3b06"/></g>`;
// Lock icon: the office on a monitor, locked
const lockLarge = svg(`${tile}
  <ellipse cx="112" cy="112" rx="88" ry="62" fill="#22c55e" opacity=".22" filter="url(#glow)"/>
  <rect x="26" y="40" width="178" height="132" rx="16" fill="#1c222c" stroke="#5a6578" stroke-width="3"/>
  <clipPath id="scr"><rect x="38" y="52" width="154" height="102" rx="8"/></clipPath>
  <rect x="38" y="52" width="154" height="102" rx="8" fill="#0d2a1b"/>
  <g clip-path="url(#scr)"><g transform="translate(115 103) scale(.6) translate(-128 -136)">${room()}</g></g>
  <rect x="38" y="52" width="154" height="102" rx="8" fill="none" stroke="#22c55e" stroke-opacity=".5" stroke-width="2"/>
  <rect x="103" y="172" width="24" height="16" fill="#4a5262"/><rect x="76" y="186" width="78" height="12" rx="6" fill="#8a94a6"/>
  ${padlock(180, 170, 1)}${rim}`);
const lockSmall = svg(`${tile}
  <ellipse cx="128" cy="140" rx="70" ry="60" fill="#22c55e" opacity=".25" filter="url(#glow)"/>
  ${padlock(128, 120, 1.75)}${rim}`);

// ---------- Render with headless Chrome ----------
const CHROME = ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'].map(v => path.join(process.env[v] || '', 'Google', 'Chrome', 'Application', 'chrome.exe')).find(p => fs.existsSync(p));
if (!CHROME) { console.error('Google Chrome is needed to render the icons.'); process.exit(1); }
const PORT = 9338, profile = fs.mkdtempSync(path.join(os.tmpdir(), 'office-icon-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function render(jobs) {   // jobs: [{svg, size}] -> PNG buffers
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  try {
    let t; for (let i = 0; i < 50 && !t; i++) { try { t = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(x => x.type === 'page'); } catch {} if (!t) await sleep(200); }
    const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
    let id = 0; const wait = {};
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && wait[m.id]) { wait[m.id](m); delete wait[m.id]; } };
    const evaluate = expression => new Promise(r => { const i = ++id; wait[i] = r; ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); });
    const out = [];
    for (const j of jobs) {
      const res = await evaluate(`new Promise((ok, fail) => { const i = new Image(); i.onload = () => { const c = document.createElement('canvas'); c.width = c.height = ${j.size};
        const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(i, 0, 0, ${j.size}, ${j.size}); ok(c.toDataURL('image/png').split(',')[1]); };
        i.onerror = () => fail('svg did not load'); i.src = 'data:image/svg+xml;base64,${Buffer.from(j.svg).toString('base64')}'; })`);
      if (!res.result || !res.result.result || typeof res.result.result.value !== 'string') throw new Error('Rendering failed: ' + JSON.stringify(res.result).slice(0, 200));
      out.push(Buffer.from(res.result.result.value, 'base64'));
    }
    ws.close();
    return out;
  } finally { chrome.kill(); }
}

function ico(pngs, sizes) {   // PNG-compressed icon entries (Windows Vista and later)
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let off = head.length;
  sizes.forEach((sz, i) => {
    const e = 6 + i * 16;
    head[e] = sz >= 256 ? 0 : sz; head[e + 1] = sz >= 256 ? 0 : sz; head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(pngs[i].length, e + 8); head.writeUInt32LE(off, e + 12); off += pngs[i].length;
  });
  return Buffer.concat([head, ...pngs]);
}

(async () => {
  const SIZES = [16, 24, 32, 48, 64, 128, 256];
  const pick = (small, large) => SIZES.map(size => ({ svg: size <= 32 ? small : large, size }));
  const jobs = [...pick(appSmall, appLarge), ...pick(lockSmall, lockLarge), { svg: appSmall, size: 32 }, { svg: appLarge, size: 192 }];
  const pngs = await render(jobs);
  const n = SIZES.length;
  fs.writeFileSync(path.join(__dirname, 'claude-office.ico'), ico(pngs.slice(0, n), SIZES));
  fs.writeFileSync(path.join(__dirname, 'lock.ico'), ico(pngs.slice(n, 2 * n), SIZES));
  const [fav32, fav192] = pngs.slice(2 * n);
  const links = '<!-- app icon (generated by app/make-icon.js) -->\n' +
    `<link rel="icon" type="image/png" sizes="32x32" href="data:image/png;base64,${fav32.toString('base64')}">\n` +
    `<link rel="icon" type="image/png" sizes="192x192" href="data:image/png;base64,${fav192.toString('base64')}">\n` +
    '<!-- /app icon -->';
  for (const page of ['index.html', 'setup.html']) {
    const file = path.join(__dirname, '..', 'public', page);
    let html = fs.readFileSync(file, 'utf8');
    html = /<!-- app icon[\s\S]*?<!-- \/app icon -->/.test(html)
      ? html.replace(/<!-- app icon[\s\S]*?<!-- \/app icon -->/, () => links)
      : html.replace(/(<title>[^<]*<\/title>)/, (m) => `${m}\n${links}`);
    fs.writeFileSync(file, html);
  }
  if (process.argv.includes('--preview')) {
    fs.writeFileSync(path.join(__dirname, 'icon-preview-app.png'), pngs[n - 1]);
    fs.writeFileSync(path.join(__dirname, 'icon-preview-lock.png'), pngs[2 * n - 1]);
    fs.writeFileSync(path.join(__dirname, 'icon-preview-small.png'), pngs[2]);
  }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  console.log('Icons written: app/claude-office.ico, app/lock.ico; page icon embedded in public/index.html and public/setup.html');
})().catch(e => { console.error(e.message); process.exit(1); });
