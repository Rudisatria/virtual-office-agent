// Visual check against the isolated test server. Never opens the installed office.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const port = 9500 + Math.floor(Math.random() * 300);
const profile = require('./chrome-profile')('one-floor');
const browser = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--disable-gpu',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  try {
    let target;
    for (let i = 0; i < 50 && !target; i++) {
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(x => x.type === 'page'); }
      catch { await sleep(100); }
    }
    if (!target) throw new Error('Chrome DevTools did not start');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(resolve => { ws.onopen = resolve; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = event => { const msg = JSON.parse(event.data); if (pending.has(msg.id)) { pending.get(msg.id).resolve(msg); pending.delete(msg.id); } };
    ws.onclose = () => { for (const p of pending.values()) p.reject(new Error('Chrome DevTools disconnected')); pending.clear(); };
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const next = ++id; pending.set(next, {resolve,reject}); ws.send(JSON.stringify({ id:next, method, params }));
    });
    const evaluate = async expression => (await call('Runtime.evaluate', { expression, returnByValue:true })).result.result.value;
    await call('Emulation.setDeviceMetricsOverride', { width:1588, height:874, deviceScaleFactor:1, mobile:false });
    await call('Page.navigate', { url:'http://127.0.0.1:4399/?full' });
    await sleep(1600);
    const state = await evaluate(`(() => {
      // the floor and walls are drawn on their own layer (#floor) under the office canvas
      const c=document.querySelector('#floor'), stage=document.querySelector('#stage').getBoundingClientRect();
      const tags=[...document.querySelectorAll('.tag')].map(x=>({name:x.textContent,x:x.getBoundingClientRect().left,y:x.getBoundingClientRect().top}));
      const pixel=[...c.getContext('2d').getImageData(280*c.width/576,160*c.height/350,1,1).data];
      return {title:document.querySelector('.fs-title').textContent,stage:{x:stage.x,y:stage.y,w:stage.width,h:stage.height},tags,pixel,sidebar:document.querySelector('.team').getBoundingClientRect().x};
    })()`);
    if (state.tags.length !== 8 || state.pixel[3] !== 255 || state.sidebar <= state.stage.x + state.stage.w) throw new Error('Office layout or characters missing: ' + JSON.stringify(state));
    const shot = await call('Page.captureScreenshot', { format:'png', captureBeyondViewport:false });
    fs.writeFileSync(path.join(profile, 'one-floor-restored-preview.png'), Buffer.from(shot.result.data, 'base64'));
    // The hall stands on the dark page: the frame's corners stay empty, the middle of the floor is drawn.
    const corners = await evaluate(`(() => {
      const c=document.querySelector('#floor'), g=c.getContext('2d'), at=(x,y)=>g.getImageData(x*c.width/576,y*c.height/350,1,1).data[3];
      return {corners:[[2,2],[573,2],[2,347],[573,347]].map(([x,y])=>at(x,y)), floor:at(288,250)};
    })()`);
    if (corners.corners.some(a => a !== 0) || corners.floor !== 255) throw new Error('Hall outline is wrong: ' + JSON.stringify(corners));
    const clip = await evaluate(`(() => {const r=document.querySelector('.viewport').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:2};})()`);
    const interior = await call('Page.captureScreenshot', {format:'png',clip});
    fs.writeFileSync(path.join(profile, 'interior-preview.png'), Buffer.from(interior.result.data, 'base64'));
    console.log('Screenshots: ' + profile);
    await call('Performance.enable');
    const metric = async () => Object.fromEntries((await call('Performance.getMetrics')).result.metrics.map(x => [x.name,x.value]));
    const a = await metric(); await sleep(10000); const b = await metric();
    await evaluate(`(() => { const s=document.querySelector('#breakmode'); s.value='night'; s.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
    await sleep(18000);
    const breakState = await evaluate(`(() => {
      const stage=document.querySelector('#stage').getBoundingClientRect();
      return [...document.querySelectorAll('.tag')].map(x=>({name:x.textContent,x:x.getBoundingClientRect().left,y:x.getBoundingClientRect().top,
        inside:x.getBoundingClientRect().left>=stage.left && x.getBoundingClientRect().right<=stage.right && x.getBoundingClientRect().top>=stage.top && x.getBoundingClientRect().bottom<=stage.bottom}));
    })()`);
    if (!breakState.every(x => x.inside) || !breakState.some(x => x.y < state.stage.y + state.stage.h * .45)) throw new Error('Break route did not reach the lounge upstairs: ' + JSON.stringify(breakState));
    const breakShot = await call('Page.captureScreenshot', { format:'png', captureBeyondViewport:false });
    fs.writeFileSync(path.join(profile, 'one-floor-restored-break-preview.png'), Buffer.from(breakShot.result.data, 'base64'));
    await call('Emulation.setEmulatedMedia', {features:[{name:'prefers-color-scheme',value:'dark'}]});
    await sleep(400);
    const dark = await call('Page.captureScreenshot', {format:'png',captureBeyondViewport:false});
    fs.writeFileSync(path.join(profile, 'interior-dark.png'), Buffer.from(dark.result.data, 'base64'));
    await evaluate(`document.querySelector('#fs').click()`);
    await call('Emulation.setDeviceMetricsOverride', {width:375,height:812,deviceScaleFactor:1,mobile:false});
    await sleep(400);
    const mobile = await evaluate(`(() => {const r=document.querySelector('#stage').getBoundingClientRect();return {left:r.left,right:r.right,overflow:document.documentElement.scrollWidth>innerWidth};})()`);
    if (mobile.left < 0 || mobile.right > 375 || mobile.overflow) throw new Error('Small-screen overflow: '+JSON.stringify(mobile));
    console.log(JSON.stringify({ state, scriptMsPerSecond:(b.ScriptDuration-a.ScriptDuration)*100, taskMsPerSecond:(b.TaskDuration-a.TaskDuration)*100,
      heapMB:b.JSHeapUsedSize/1048576, breakState }, null, 2));
    ws.close();
  } finally { browser.kill(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
