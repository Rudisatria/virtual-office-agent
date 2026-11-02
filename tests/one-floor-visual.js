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
    const evaluate = async expression => {
      const result = (await call('Runtime.evaluate', { expression, returnByValue:true })).result;
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    await call('Emulation.setDeviceMetricsOverride', { width:1588, height:874, deviceScaleFactor:1, mobile:false });
    await call('Page.navigate', { url:'http://127.0.0.1:4399/?full' });
    await sleep(1600);
    const state = await evaluate(`(() => {
      // the floor and walls are drawn on their own layer (#floor) under the office canvas
      const c=document.querySelector('#floor'), stage=document.querySelector('#stage').getBoundingClientRect();
      const tags=[...document.querySelectorAll('.tag')].filter(x=>getComputedStyle(x).visibility!=='hidden').map(x=>({name:x.textContent,x:x.getBoundingClientRect().left,y:x.getBoundingClientRect().top}));
      const pixel=[...c.getContext('2d').getImageData(280*c.width/576,160*c.height/350,1,1).data];
      return {title:document.querySelector('.fs-title').textContent,stage:{x:stage.x,y:stage.y,w:stage.width,h:stage.height},tags,pixel,sidebar:document.querySelector('.team').getBoundingClientRect().x};
    })()`);
    if (state.tags.length !== 8 || state.pixel[3] !== 255 || state.sidebar <= state.stage.x + state.stage.w) throw new Error('Office layout or characters missing: ' + JSON.stringify(state));
    const audit = await evaluate('window.__officeRouteAudit()');
    const seats = audit.seats, rows = [seats.pm[1], seats.qa[1], seats.security[1]];
    const rugGap = (a, b) => (b - 1.7) - (a + .7);
    const errors = [];
    if ([rugGap(rows[0], rows[1]), rugGap(rows[1], rows[2])].some(gap => gap < 1 || gap > 1.7))
      errors.push('tiled aisle is outside the one-tile clearance');
    if ([seats.qa, seats.devops, seats.backend].some((s, i) => s[0] !== [seats.pm, seats.designer, seats.frontend][i][0]))
      errors.push('middle desks do not align');
    const blocked = (x, y) => audit.desks.find(d => x > d.gx+.03 && x < d.gx+d.dw-.03 && y > d.dy+.03 && y < d.dy+1.07)?.id
      || (x > audit.station.x+.03 && x < audit.station.x+audit.station.w-.03
        && y > audit.station.y+.03 && y < audit.station.y+audit.station.d-.03 ? 'coffee' : null);
    const check = (who, points) => {
      for (let i = 1; i < points.length; i++) {
        const a = points[i-1], b = points[i], n = Math.max(1, Math.ceil(Math.hypot(b.x-a.x, b.y-a.y)*12));
        for (let j = 1; j <= n; j++) {
          const x = a.x+(b.x-a.x)*j/n, y = a.y+(b.y-a.y)*j/n, hit = blocked(x, y);
          if (hit || x < 0 || y < 0 || x > audit.cols || y > audit.rows || x+y > audit.cut)
            return who+' crosses '+(hit || 'floor edge')+' at '+x.toFixed(2)+','+y.toFixed(2);
        }
      }
      return null;
    };
    for (const p of audit.exits) {
      const error = check(p.id, [{x:p.seatX,y:p.seatY}, ...p.exit]);
      if (error) errors.push(error);
    }
    for (const brief of audit.briefs) {
      const targetIndex = brief.path.findIndex(p => p.x === brief.approach.x && p.y === brief.approach.y);
      if (targetIndex < 0) errors.push('manager misses '+brief.id);
      if (brief.id === 'qa') {
        const doorIndex = brief.path.findIndex(p => p.x === 5 && p.y === 13.8);
        if (targetIndex !== doorIndex + 1) errors.push('manager does not approach QA directly from the door');
      }
      const error = check('manager to '+brief.id, [{x:audit.manager.seatX,y:audit.manager.seatY}, ...brief.path]);
      if (error) errors.push(error);
      if (targetIndex >= 0) {
        const distance = points => points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x-points[i].x, p.y-points[i].y), 0);
        const direct = distance([{x:audit.manager.seatX,y:audit.manager.seatY}, ...brief.path.slice(0,targetIndex+1)]);
        const managerExit = audit.exits.find(p => p.id === 'manager');
        const teammateExit = audit.exits.find(p => p.id === brief.id);
        const oldDetour = distance([{x:audit.manager.seatX,y:audit.manager.seatY}, ...managerExit.exit])
          + distance(teammateExit.exit.slice().reverse());
        if (direct >= oldDetour * .75) errors.push('manager detours to '+brief.id);
      }
    }
    const coffeeError = check('coffee route', audit.coffee);
    if (coffeeError) errors.push(coffeeError);
    const stairError = check('stair approach', audit.stairEntry);
    if (stairError) errors.push(stairError);
    const catGround = audit.cat.slice(0, audit.cat.findIndex(p => p.z > 0));
    const catError = check('cat route', catGround);
    if (catError) errors.push(catError);
    if (!audit.cat.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))) errors.push('cat route contains an undefined coordinate');
    if (!audit.cat.some(p => p.z >= 48) || !audit.cat.some(p => p.z === 0) || !audit.cat.some(p => p.z > 0 && p.z < 48)) errors.push('cat does not visit both floors by the stairs');
    const catCycle = await evaluate('window.__officeCatCycleAudit()');
    if (!catCycle.finite || !catCycle.upstairs || !catCycle.returned) errors.push('cat vanishes during a full route: ' + JSON.stringify(catCycle));
    if (Math.abs(audit.station.x - 15.4) > .01 || audit.station.x+audit.station.w > audit.stairs.xm-.5
      || audit.station.y < audit.stairs.y1 || audit.station.y+audit.station.d > 3.4)
      errors.push('coffee cabinet must touch the left landing wall and stay clear of the stairs');
    const coffeeStop = audit.coffee[audit.coffee.length - 1];
    if (coffeeStop.x < audit.station.x || coffeeStop.x > audit.station.x+audit.station.w
      || coffeeStop.y < audit.station.y+audit.station.d+.7)
      errors.push('coffee visitor overlaps the cabinet');
    if (errors.length || audit.desks.length !== 10) throw new Error('Desk spacing or walking route failed: ' + JSON.stringify(errors));
    const extraConfig = await (await fetch('http://127.0.0.1:4399/config')).json();
    for (const id of ['extra1', 'extra2']) { extraConfig.team[id].added = true; extraConfig.team[id].active = true; }
    await evaluate(`window.__officeApplyConfig(${JSON.stringify(extraConfig)})`);
    const expanded = await evaluate('window.__officeRouteAudit()');
    for (const id of ['extra1', 'extra2']) {
      const brief = expanded.briefs.find(b => b.id === id);
      if (!brief) errors.push('manager has no path to ' + id);
      else {
        const error = check('manager to ' + id, [{x:expanded.manager.seatX,y:expanded.manager.seatY}, ...brief.path]);
        if (error) errors.push(error);
      }
    }
    if (expanded.exits.length !== 10 || errors.length) throw new Error('Added member route failed: ' + JSON.stringify(errors));
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
    const windowPixel = () => evaluate(`(() => { const c=document.querySelector('#floor'); return [...c.getContext('2d').getImageData(95*c.width/576,178*c.height/350,1,1).data]; })()`);
    const preview = async value => evaluate(`(() => { const s=document.querySelector('#breakmode'); s.value='${value}'; s.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
    await preview('night'); await sleep(1400);
    const nightWindow = await windowPixel();
    await preview('lunch'); await sleep(1400);
    const dayWindow = await windowPixel();
    if (dayWindow.slice(0, 3).reduce((a, b) => a + b, 0) <= nightWindow.slice(0, 3).reduce((a, b) => a + b, 0) + 80)
      throw new Error('The window did not brighten for daytime: ' + JSON.stringify({nightWindow, dayWindow}));
    const dayShot = await call('Page.captureScreenshot', {format:'png',clip});
    fs.writeFileSync(path.join(profile, 'interior-day.png'), Buffer.from(dayShot.result.data, 'base64'));
    console.log('Screenshots: ' + profile);
    await call('Performance.enable');
    const metric = async () => Object.fromEntries((await call('Performance.getMetrics')).result.metrics.map(x => [x.name,x.value]));
    const a = await metric(); await sleep(10000); const b = await metric();
    await preview('night');
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
