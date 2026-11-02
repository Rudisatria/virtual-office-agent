// Run the Setup flow against an isolated office, never the user's settings.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');
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
  const normalizedLook = require('../config').normalize({ team: { qa: { gender: 'robot', hairStyle: '../long', outfit: 'cape', accessory: '<script>' } } }).team.qa;
  assert.equal(normalizedLook.gender, 'woman');
  assert.equal(normalizedLook.hairStyle, 'classic');
  assert.equal(normalizedLook.outfit, 'shirt');
  assert.equal(normalizedLook.accessory, 'cap');
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

  const setupPage = await fetch(origin + '/setup');
  assert.equal(setupPage.headers.get('x-frame-options'), 'DENY', 'other sites cannot frame Setup');
  assert.equal(setupPage.headers.get('x-content-type-options'), 'nosniff', 'browser will not guess file types');
  const skillArchive = await fetch(origin + '/skills/office-qa.zip');
  assert.equal(skillArchive.status, 200);
  assert.equal(skillArchive.headers.get('cache-control'), 'no-store', 'edited skill archives are not cached');

  const wrongHost = await new Promise((resolve, reject) => {
    http.get(origin + '/config', { headers: { Host: 'untrusted.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(wrongHost, 403, 'DNS rebinding host is rejected');
  const nonJsonHook = await fetch(origin + '/hook', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(nonJsonHook.status, 415, 'hook accepts JSON only');
  const nonJsonSetup = await fetch(origin + '/setup', { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Office': 'setup' }, body: '{}' });
  assert.equal(nonJsonSetup.status, 415, 'settings accept JSON only');
  const noSetupHeader = await fetch(origin + '/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noSetupHeader.status, 404, 'settings changes require the setup header');

  const appAction = await fetch(origin + '/setup/app/uninstall', { method: 'POST', headers: { 'X-Office': 'setup' } });
  assert.equal(appAction.status, 409, 'uninstall is unavailable outside an installed office');
  const noHeader = await fetch(origin + '/setup/app/uninstall', { method: 'POST' });
  assert.equal(noHeader.status, 404, 'management actions require the setup header');

  const before = await getJson('/setup/data');
  assert.equal(before.version, require('../package.json').version);
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

  const config = { ...before.config, hours: { start: '08:00', end: '17:00' }, breaks: { lunch: { start: '12:30', end: '13:15' }, coffee: { start: '10:15', end: '10:35' } },
    team: { ...before.config.team, qa: { ...before.config.team.qa, gender: 'man', hairStyle: 'short', outfit: 'hoodie', accessory: 'glasses' } } };
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
  assert.equal(saved.data.config.team.qa.gender, 'man');
  assert.equal(saved.data.config.team.qa.hairStyle, 'short');
  assert.equal(saved.data.config.team.qa.outfit, 'hoodie');
  assert.equal(saved.data.config.team.qa.accessory, 'glasses');
  assert.equal(saved.data.hooks.hint, true, JSON.stringify(saved.report));
  assert.equal(saved.data.codexHooks, true, JSON.stringify(saved.report));
  assert.equal((await getJson('/config')).breaks.coffee.start, '10:15');
  assert.equal((await getJson('/config')).team.qa.accessory, 'glasses');
  assert.equal((await getJson('/setup/data')).codexHooks, true);
  console.log('Setup flow OK: extension reconnect acknowledged; lunch and coffee schedule and hooks saved.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (server && server.exitCode === null) {
    try { await fetch(origin + '/shutdown', { method: 'POST', headers: { 'X-Office': 'stop' } }); } catch { server.kill(); }
  }
  fs.rmSync(temp, { recursive: true, force: true });
});
