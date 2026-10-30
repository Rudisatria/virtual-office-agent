// Exercise the shared Claude/Codex activity UI in an isolated Chrome office window.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'office-activity-ui-'));
const home = path.join(temp, 'home'), data = path.join(temp, 'data');
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
for (const dir of [path.join(home, '.claude'), path.join(home, '.codex'), data]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(data, 'activity-history.json'), JSON.stringify([
  {t:Date.now()-3000,msg:{type:'prompt',source:'Claude Code',label:'OLD PRIVATE REQUEST'}},
  {t:Date.now()-2000,msg:{type:'start',role:'frontend',label:'Request: OLD PRIVATE REQUEST',key:'prompt:old'}},
  {t:Date.now()-1000,msg:{type:'end',key:'prompt:old'}},
  {t:Date.now(),msg:{type:'stop',source:'Claude Code'}}
]));
const server = spawn(process.execPath, ['server.js'], {
  cwd: root, env: { ...process.env, PORT: '4399', OFFICE_HOME: home, OFFICE_DATA: data },
  windowsHide: true, stdio: 'ignore'
});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  let browser, ws;
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch('http://127.0.0.1:4399/health')).ok) break; } catch {}
      await wait(100);
    }
    const port = 9500 + Math.floor(Math.random() * 300);
    browser = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-crash-reporter',
      '--no-sandbox', '--disable-gpu', `--user-data-dir=${require('./chrome-profile')('activity-ui')}`,
      `--remote-debugging-port=${port}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    let target;
    for (let i = 0; i < 50 && !target; i++) {
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(item => item.type === 'page'); }
      catch { await wait(100); }
    }
    assert(target, 'Chrome DevTools started');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(resolve => ws.onopen = resolve);
    let id = 0;
    const pending = new Map();
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    };
    const call = (method, params = {}) => new Promise(resolve => {
      const next = ++id; pending.set(next, resolve); ws.send(JSON.stringify({ id: next, method, params }));
    });
    const evaluate = async expression => {
      const response = await call('Runtime.evaluate', { expression, returnByValue: true });
      if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.exception?.description || response.result.exceptionDetails.text);
      return response.result.result.value;
    };
    const hook = async event => {
      const response = await fetch('http://127.0.0.1:4399/hook', {method:'POST',
        headers:{'Content-Type':'application/json'}, body:JSON.stringify(event)});
      assert([200, 204].includes(response.status));
    };
    await call('Page.navigate', { url: 'http://127.0.0.1:4399/?full' });
    let ready = false;
    for (let i = 0; i < 50; i++) {
      if (await evaluate('document.querySelector("#log")?.children.length > 0')) { ready = true; break; }
      await wait(100);
    }
    assert(ready, 'office did not load activity history');
    const replay = await evaluate('document.querySelector("#log").innerText');
    assert(!replay.includes('OLD PRIVATE REQUEST'), 'saved Claude request stays out of replayed activity');
    assert(replay.includes('finished: the task'), 'a request-only task has a generic completion');
    for (const [source, role] of [['Claude Code', 'frontend'], ['Codex', 'backend']]) {
      const key = source === 'Codex' ? 'codex' : 'claude';
      const base = {session_id:key, ...(source === 'Codex' ? {source:'codex',vscodeFallback:true} : {})};
      await hook({...base,hook_event_name:'UserPromptSubmit',prompt:role + ' PRIVATE USER REQUEST'});
      await wait(300);
      const before = await evaluate(`({activity:document.querySelector('#log').innerText,
        team:document.querySelector('#teamfeed').innerText,
        bubbles:[...document.querySelectorAll('.bubble .txt')].map(x=>x.textContent)})`);
      assert(!before.activity.includes('PRIVATE USER REQUEST') && !before.team.includes('PRIVATE USER REQUEST'),
        `${source}: request text stays out of activity`);
      assert(before.bubbles.some(x=>x.startsWith('Briefing to ')), `${source}: manager briefs the assigned team`);
      await hook({...base,hook_event_name:source === 'Codex' ? 'Step' : 'PreToolUse',
        ...(source === 'Codex' ? {step:'Running npm test',tool_name:'Bash',tool_input:{command:'npm test'}}
          : {tool_name:'Bash',tool_input:{command:'npm test'},tool_use_id:'t1'})});
      await wait(300);
      const after = await evaluate('document.querySelector("#log").innerText');
      assert(after.includes('Running npm test'), `${source}: actual work appears in activity`);
      await hook({...base,hook_event_name:'Stop'});
      await wait(1100);
      const done = await evaluate(`({activity:document.querySelector('#log').innerText,
        team:document.querySelector('#teamfeed').innerText})`);
      assert(done.activity.includes('finished: Running npm test'), `${source}: task finishes in activity`);
      assert(done.team.includes('finished: Running npm test'), `${source}: team activity shows completion`);
    }
    console.log('Claude and Codex activity UI: OK');
  } finally {
    if (ws) ws.close();
    if (browser) { browser.kill(); if (browser.exitCode === null) await Promise.race([
      new Promise(resolve => browser.once('exit', resolve)), wait(2500)]); }
    try { await fetch('http://127.0.0.1:4399/shutdown', { method: 'POST', headers: { 'X-Office': 'stop' } }); }
    catch { server.kill(); }
    if (path.dirname(path.resolve(temp)).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() ||
        !path.basename(temp).startsWith('office-activity-ui-')) throw new Error('Unsafe test cleanup path');
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
