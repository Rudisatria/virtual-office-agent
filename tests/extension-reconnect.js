// Exercise the MV3 worker without touching the user's Chrome profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const listeners = {};
const calls = [];
const chrome = {
  action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
  alarms: {
    get: async () => null,
    create: async (name, info) => { calls.push(['alarm', name, info.periodInMinutes]); },
    onAlarm: { addListener(fn) { listeners.alarm = fn; } }
  },
  runtime: {
    getManifest: () => ({ version: '1.9.0', content_scripts: [{ matches: ['https://claude.ai/*'] }] }),
    onInstalled: { addListener(fn) { listeners.installed = fn; } },
    onStartup: { addListener(fn) { listeners.startup = fn; } },
    onMessage: { addListener(fn) { listeners.message = fn; } }
  },
  tabs: { query: async () => [{ id: 7 }] },
  scripting: { executeScript: async options => { calls.push(['inject', options.target.tabId]); } }
};
const fetch = async (url, options) => {
  if (url.endsWith('/extension/control')) return { ok: true, json: async () => ({ reconnectId: 12 }) };
  if (url.endsWith('/hook')) { calls.push(['hello', JSON.parse(options.body)]); return { ok: true }; }
  throw new Error(url);
};
const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8');
vm.runInNewContext(source, { chrome, fetch, URL, Date, Promise, console });

async function main() {
  await Promise.resolve();
  assert.deepEqual(calls[0], ['alarm', 'office-connection', 0.5]);
  listeners.alarm({ name: 'office-connection' });
  for (let i = 0; i < 20 && !calls.some(call => call[0] === 'hello'); i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(calls.some(call => call[0] === 'inject' && call[1] === 7), 'open chat tab reconnected');
  assert.ok(calls.some(call => call[0] === 'hello' && call[1].reconnectId === 12), 'worker acknowledged request');
  console.log('Extension reconnect OK: Chrome alarm, tab reinjection, and acknowledgment.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
