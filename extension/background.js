// Forwards events from the claude.ai / chatgpt.com tab to the local Virtual Office server.
// Sent from here (not the page) so the browser allows the request to 127.0.0.1.
// The toolbar badge on that tab shows the state:
//   blue ON = watching this tab, green ✓ = the office got the last event, red ! = it couldn't reach the office.
function badge(tabId, text, color, title) {
  chrome.action.setBadgeText({ text, tabId });
  chrome.action.setBadgeBackgroundColor({ color, tabId });
  chrome.action.setTitle({ title: 'Virtual Office: ' + title, tabId });
}
const OFFICE = 'http://127.0.0.1:4321';
const CHECK_ALARM = 'office-connection';
async function hello(site = '', reconnectId = 0) {
  try {
    await fetch(OFFICE + '/hook', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hook_event_name: 'ExtensionHello', version: chrome.runtime.getManifest().version, site, reconnectId }) });
  } catch { /* The office may be closed. The next alarm will try again. */ }
}
async function reconnectTabs() {
  const tabs = await chrome.tabs.query({ url: chrome.runtime.getManifest().content_scripts[0].matches });
  await Promise.all(tabs.map(tab => chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {})));
}
let checking = null;
function checkOffice() {
  if (checking) return checking;
  checking = (async () => {
    let reconnectId = 0;
    try {
      const response = await fetch(OFFICE + '/extension/control');
      if (!response.ok) return;
      reconnectId = Number((await response.json()).reconnectId) || 0;
      if (reconnectId) await reconnectTabs();
      await hello('', reconnectId);
    } catch { /* The office may be closed. */ }
  })().finally(() => { checking = null; });
  return checking;
}
// MV3 workers sleep between events. A Chrome alarm reconnects after the office starts,
// even when no claude.ai or ChatGPT tab is open. Chrome limits the alarm to 30 seconds.
chrome.alarms.get(CHECK_ALARM).then(alarm => {
  if (!alarm) return chrome.alarms.create(CHECK_ALARM, { periodInMinutes: 0.5 });
}).catch(() => {});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === CHECK_ALARM) checkOffice(); });
chrome.runtime.onStartup.addListener(checkOffice);
// Reloading or updating the extension leaves open claude.ai / ChatGPT tabs with a dead copy of content.js.
// Put a fresh copy into them right away, so they keep working without reloading the tab.
chrome.runtime.onInstalled.addListener(async () => {
  await reconnectTabs();
  checkOffice();
});
chrome.runtime.onMessage.addListener((ev, sender, reply) => {
  const tabId = sender.tab ? sender.tab.id : undefined;
  // The skill hint for the message you are typing (empty when it is turned off in Setup, or no member matches)
  if (ev.hint) {
    fetch(OFFICE + '/hint', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: String(ev.prompt || '') }) })
      .then(r => r.status === 200 ? r.json() : {}).then(d => reply({ hint: d.hint || null })).catch(() => reply({ hint: null }));
    return true;
  }
  if (ev.hello) {
    badge(tabId, 'ON', '#2f6bff', 'watching this tab');
    reply({ ok: true });
    // Let the office know the extension is installed (its Setup page shows it), quietly if the office isn't running
    hello(sender.tab && sender.tab.url ? new URL(sender.tab.url).hostname : '');
    return;
  }
  fetch(OFFICE + '/hook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ev)
  }).then(r => {
    if (r.ok) badge(tabId, '✓', '#1f7a45', 'last ' + ev.hook_event_name + ' delivered at ' + new Date().toLocaleTimeString());
    else badge(tabId, '!', '#c4314b', 'office replied ' + r.status);
    reply({ ok: r.ok });
  }).catch(err => {
    badge(tabId, '!', '#c4314b', "can't reach the office at 127.0.0.1:4321. Is it running? (" + err.message + ')');
    reply({ ok: false, error: err.message });
  });
  return true; // reply is sent asynchronously
});
