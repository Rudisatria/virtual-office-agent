// Capture the Setup page in Chrome with isolated office settings.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'office-visual-'));
const home = path.join(temp, 'home');
const data = path.join(temp, 'data');
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
for (const dir of [path.join(home, '.claude'), path.join(home, '.codex'), data]) fs.mkdirSync(dir, { recursive: true });
const server = spawn(process.execPath, ['server.js'], {
  cwd: root, env: { ...process.env, PORT: '4399', OFFICE_HOME: home, OFFICE_DATA: data },
  windowsHide: true, stdio: 'ignore'
});

(async () => {
  let browser;
  try {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const port = 9400 + Math.floor(Math.random() * 500);
    browser = spawn(chrome, [
      '--headless=new', '--no-first-run', '--no-default-browser-check',
      '--no-sandbox', '--disable-gpu', '--disable-gpu-sandbox',
      '--use-gl=angle', '--use-angle=swiftshader', '--disable-features=Vulkan',
      `--user-data-dir=${require('./chrome-profile')('setup-visual')}`, `--remote-debugging-port=${port}`, 'about:blank'
    ], { windowsHide: true, stdio: 'ignore' });
    let target;
    for (let i = 0; i < 50 && !target; i++) {
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(item => item.type === 'page'); }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    if (!target) throw new Error('Chrome DevTools did not start');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(resolve => ws.onopen = resolve);
    let id = 0;
    const pending = new Map();
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    };
    const call = (method, params = {}) => new Promise(resolve => {
      const next = ++id;
      pending.set(next, resolve);
      ws.send(JSON.stringify({ id: next, method, params }));
    });
    for (const [name, width] of [['mobile', 375], ['desktop', 1365]]) {
      const output = path.join(root, 'dist', `setup-${name}.png`);
      await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: name === 'mobile' });
      await call('Page.navigate', { url: 'http://127.0.0.1:4399/setup' });
      await new Promise(resolve => setTimeout(resolve, 1100));
      const metrics = await call('Runtime.evaluate', { expression: '({viewport: innerWidth, page: document.documentElement.scrollWidth, version: document.querySelector("#appVersion").textContent})', returnByValue: true });
      const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      if (!shot.result?.data) throw new Error(`${name}: screenshot failed`);
      fs.writeFileSync(output, Buffer.from(shot.result.data, 'base64'));
      const { viewport, page, version } = metrics.result.result.value;
      if (page > viewport) throw new Error(`${name}: horizontal overflow ${page}px > ${viewport}px`);
      if (version !== `Virtual Office v${require('../package.json').version}`) throw new Error(`${name}: wrong version label: ${version}`);
      const looks = await call('Runtime.evaluate', { expression: '({members:document.querySelectorAll(".member").length,gender:document.querySelector(".member .gender").value,hair:document.querySelector(".member .hairStyle").value,accessory:document.querySelector(".member .accessory").value})', returnByValue: true });
      if (looks.result.result.value.members !== 7 || looks.result.result.value.gender !== 'woman' || looks.result.result.value.hair !== 'long' || looks.result.result.value.accessory !== 'badge') throw new Error(`${name}: appearance controls did not load`);
      await call('Runtime.evaluate', { expression: 'document.querySelector(".member").scrollIntoView({block:"start"})' });
      await new Promise(resolve => setTimeout(resolve, 150));
      const teamShot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.join(root, 'dist', `setup-team-${name}.png`), Buffer.from(teamShot.result.data, 'base64'));
      console.log(`${name}: ${viewport}px viewport, ${page}px page; ${output}`);
      if (name === 'mobile') {
        await call('Runtime.evaluate', { expression: 'document.querySelector("#form").requestSubmit()' });
        let installed = false;
        for (let i = 0; i < 40; i++) {
          await new Promise(resolve => setTimeout(resolve, 150));
          const state = await call('Runtime.evaluate', {
            expression: '({claude:document.querySelector("#iHooksBadge").textContent,codex:document.querySelector("#iCodexHooksBadge").textContent})',
            returnByValue: true
          });
          installed = state.result.result.value.claude.includes('Installed') && state.result.result.value.codex.includes('Installed');
          if (installed) break;
        }
        if (!installed) throw new Error('Hook badges did not turn green after Save and install');
      }
      await call('Runtime.evaluate', { expression: 'document.querySelector("#checks").scrollIntoView({block:"center"})' });
      await new Promise(resolve => setTimeout(resolve, 150));
      const installShot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.join(root, 'dist', `setup-install-${name}.png`), Buffer.from(installShot.result.data, 'base64'));
      await call('Runtime.evaluate', { expression: 'document.querySelector(".manage").scrollIntoView({block:"center"})' });
      await new Promise(resolve => setTimeout(resolve, 150));
      const manageShot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.join(root, 'dist', `setup-manage-${name}.png`), Buffer.from(manageShot.result.data, 'base64'));
    }
    ws.close();
  } finally {
    if (browser) browser.kill();
    try { await fetch('http://127.0.0.1:4399/shutdown', { method: 'POST', headers: { 'X-Office': 'stop' } }); }
    catch { server.kill(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
