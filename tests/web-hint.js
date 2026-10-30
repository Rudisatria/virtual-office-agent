// The ChatGPT / claude.ai skill hint: the office's /hint answer (off by default, on after Setup), and the extension adding it
// to a message as it is sent. Runs its own isolated server on port 4399 and a mock ChatGPT message box in headless Chrome.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const OFFICE = 'http://127.0.0.1:4399';

function startServer(config){
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'office-web-hint-'));
  const home = path.join(temp, 'home'), data = path.join(temp, 'data');
  for (const dir of [path.join(home, '.claude'), path.join(home, '.codex'), data]) fs.mkdirSync(dir, { recursive: true });
  if (config) fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(config));
  return spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: '4399', OFFICE_HOME: home, OFFICE_DATA: data }, windowsHide: true, stdio: 'ignore' });
}
async function ready(){
  for (let i = 0; i < 50; i++) { try { if ((await fetch(OFFICE + '/health')).ok) return; } catch {} await wait(100); }
  throw new Error('isolated server did not start');
}
const askHint = prompt => fetch(OFFICE + '/hint', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }) });
async function stop(server){ try { await fetch(OFFICE + '/shutdown', { method: 'POST', headers: { 'X-Office': 'stop' } }); } catch {} server.kill(); await wait(400); }

(async () => {
  let server, browser, ws;
  try {
    // 1. Off unless turned on: no hint at all
    server = startServer(null); await ready();
    assert.equal((await askHint('please check the security of the login')).status, 204, 'hint must be off by default');
    await stop(server);

    // 2. Turned on: a matching message gets its member's skill, an unmatched one gets nothing, only JSON is accepted
    server = startServer({ officeName: 'Test Office', webHint: true }); await ready();
    let r = await askHint('please check the security of the login');
    assert.equal(r.status, 200);
    const { hint } = await r.json();
    assert.match(hint, /office-security/); assert.match(hint, /Test Office/);
    assert.equal((await askHint('hello there')).status, 204, 'no member matches: no hint');
    r = await fetch(OFFICE + '/hint', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"prompt":"security"}' });
    assert.equal(r.status, 415, '/hint accepts JSON only');
    assert.equal((await fetch(OFFICE + '/config').then(x => x.json())).webHint, true);

    // 3. The extension on a mock ChatGPT message box: the hint is added as the message is sent, unmatched text is left alone
    const port = 9500 + Math.floor(Math.random() * 300);
    const profile = require('./chrome-profile')('web-hint');
    browser = spawn(chrome, ['--headless=new', '--no-first-run', '--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    let target;
    for (let i = 0; i < 50 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(x => x.type === 'page'); } catch { await wait(100); } }
    ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise(res => ws.onopen = res);
    let id = 0; const pending = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
    const call = (method, params = {}) => new Promise(res => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
    const evaluate = async expression => { const m = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (m.result.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails)); return m.result.result.value; };
    await call('Page.navigate', { url: OFFICE + '/health' }); await wait(500);
    // A message box and Send button like ChatGPT's; the page itself sends on Enter or on the button, recording what it sent.
    // chrome.runtime is stubbed: hint requests go to the isolated office, other events are recorded.
    const source = fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8').replace('SITES[location.hostname]', "SITES['chatgpt.com']");
    await evaluate(`(() => {
      document.body.innerHTML = '<form><div id="prompt-textarea" contenteditable="true" style="min-height:40px"></div><button type="button" data-testid="send-button">Send</button></form>';
      window.sent = []; window.events = [];
      const box = document.getElementById('prompt-textarea');
      const send = () => { window.sent.push(box.innerText.trim()); box.innerHTML = ''; };
      document.querySelector('[data-testid="send-button"]').addEventListener('click', send);
      box.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.defaultPrevented) { e.preventDefault(); send(); } });
      window.chrome = { runtime: { id: 'test', getManifest: () => ({ version: 'test' }),
        sendMessage(msg, cb) {
          if (msg.hint) fetch('/hint', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: msg.prompt }) })
            .then(r => r.status === 200 ? r.json() : {}).then(d => cb && cb({ hint: d.hint || null }));
          else { window.events.push(msg); cb && cb({ ok: true }); }
        } } };
      return true;
    })()`);
    await evaluate(source + ';true');
    const type = text => evaluate(`(() => { const box = document.getElementById('prompt-textarea'); box.focus(); document.execCommand('insertText', false, ${JSON.stringify(text)}); return true; })()`);
    const enter = () => evaluate(`(() => { document.getElementById('prompt-textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })); return true; })()`);

    await type('please check the security of the login'); await wait(700); await enter(); await wait(500);
    let sent = await evaluate('window.sent');
    assert.equal(sent.length, 1, 'the message is sent once: ' + JSON.stringify(sent));
    assert.ok(sent[0].startsWith('please check the security of the login') && sent[0].includes(hint), 'the hint is added to the end: ' + sent[0]);
    const prompts = (await evaluate('window.events')).filter(e => e.hook_event_name === 'UserPromptSubmit');
    assert.equal(prompts.length, 1, 'the office hears about the message once');

    await type('hello there'); await wait(700); await enter(); await wait(500);
    sent = await evaluate('window.sent');
    assert.equal(sent[1], 'hello there', 'no member matches: the message is sent as typed');

    // Sending with the Send button works the same way
    await type('write the user stories for the login'); await wait(700);
    await evaluate(`(() => { document.querySelector('[data-testid="send-button"]').click(); return true; })()`); await wait(500);
    sent = await evaluate('window.sent');
    assert.equal(sent.length, 3, 'sent once with the button: ' + JSON.stringify(sent));
    assert.match(sent[2], /^write the user stories for the login .*office-pm/, 'button send gets the hint: ' + sent[2]);

    console.log('Web skill hint: OK');
  } catch (err) {
    console.error(err); process.exitCode = 1;
  } finally {
    try { ws && ws.close(); } catch {}
    if (browser) browser.kill();
    if (server) await stop(server);
  }
})();
