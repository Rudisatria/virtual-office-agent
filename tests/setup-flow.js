// Run the Setup flow against an isolated office, never the user's settings.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Script } = require('node:vm');

const root = path.join(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'virtual-office-setup-'));
const home = path.join(temp, 'home');
const data = path.join(temp, 'data');
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
const origin = 'http://127.0.0.1:4399';
let server;
let serverError = '';

async function getJson(url) {
  const response = await fetch(origin + url);
  assert.equal(response.status, 200, url);
  return response.json();
}

async function main() {
  for (const file of ['public/setup.html', 'public/index.html']) {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length, `${file} has an inline script`);
    for (const [, source] of scripts) new Script(source, { filename: file });
  }

  server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: '4399', OFFICE_DATA: data, OFFICE_HOME: home },
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe']
  });
  server.stderr.on('data', chunk => { serverError += chunk.toString(); });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw new Error(`Server exited: ${server.exitCode}: ${serverError.slice(-500)}`);
    try { await getJson('/health'); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(ready, 'isolated server started');

  const appAction = await fetch(origin + '/setup/app/uninstall', { method: 'POST', headers: { 'X-Office': 'setup' } });
  assert.equal(appAction.status, 409, 'uninstall is unavailable outside an installed office');
  const noHeader = await fetch(origin + '/setup/app/uninstall', { method: 'POST' });
  assert.equal(noHeader.status, 404, 'management actions require the setup header');

  const before = await getJson('/setup/data');
  assert.equal(before.config.breaks.coffee.start, '15:30');
  assert.equal(before.hooks.hint, false);
  assert.equal(before.codexHooks, false);
  assert.equal(before.extension, null);

  const rejectedReconnect = await fetch(origin + '/setup/extension/reconnect', { method: 'POST' });
  assert.equal(rejectedReconnect.status, 404, 'reconnect requires the setup header');
  const reconnect = await fetch(origin + '/setup/extension/reconnect', { method: 'POST', headers: { 'X-Office': 'setup' } });
  assert.equal(reconnect.status, 200);
  const { reconnectId } = await reconnect.json();
  assert.equal((await getJson('/extension/control')).reconnectId, reconnectId);
  const hello = await fetch(origin + '/hook', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hook_event_name: 'ExtensionHello', version: '1.9.0', reconnectId }) });
  assert.equal(hello.status, 204);
  assert.equal((await getJson('/setup/data')).extension.reconnectId, reconnectId);
  assert.equal((await getJson('/extension/control')).reconnectId, 0, 'acknowledged reconnect is cleared');

  const config = { ...before.config, hours: { start: '08:00', end: '17:00' }, breaks: { lunch: { start: '12:30', end: '13:15' }, coffee: { start: '10:15', end: '10:35' } } };
  const response = await fetch(origin + '/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Office': 'setup' },
    body: JSON.stringify({ config, install: { hooks: true, codexHooks: true } })
  });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.data.config.breaks.coffee.start, '10:15');
  assert.equal(saved.data.config.breaks.coffee.end, '10:35');
  assert.equal(saved.data.config.breaks.lunch.start, '12:30');
  assert.equal(saved.data.config.breaks.lunch.end, '13:15');
  assert.equal(saved.data.hooks.hint, true, JSON.stringify(saved.report));
  assert.equal(saved.data.codexHooks, true, JSON.stringify(saved.report));
  assert.equal((await getJson('/config')).breaks.coffee.start, '10:15');
  assert.equal((await getJson('/setup/data')).codexHooks, true);
  console.log('Setup flow OK: extension reconnect acknowledged; lunch and coffee schedule and hooks saved.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (server && server.exitCode === null) {
    try { await fetch(origin + '/shutdown', { method: 'POST', headers: { 'X-Office': 'stop' } }); } catch { server.kill(); }
  }
  fs.rmSync(temp, { recursive: true, force: true });
});
