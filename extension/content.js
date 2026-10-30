// Watches the claude.ai or chatgpt.com page and tells the office when you send a prompt ("UserPromptSubmit")
// and when the reply has finished ("Stop"). Same events Claude Code's hooks send, so server.js needs no changes.
// These sites have no official hooks, so this reads the page:
//  - start: you press Enter or click Send in the message box (or, as a backup, a Stop button appears)
//  - done:  no Stop button, and the page text has stopped changing for 3 seconds
//  - steps: the "Sharepoint search", "Ran a command", "Creating a file" list (and thinking summaries) in the reply
// Wrapped in a function: background.js may inject this file again into a tab that already ran it
(() => {
const SITES = {
  'claude.ai': {
    source: 'claude',
    busy: '[data-is-streaming="true"], button[aria-label="Stop response"], button[aria-label="Stop Response"]',
    userMessage: '[data-testid="user-message"]',
    steps: '[aria-expanded]'
  },
  'chatgpt.com': {
    source: 'chatgpt',
    busy: 'button[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label="Stop generating"], .result-streaming',
    userMessage: '[data-message-author-role="user"]',
    steps: '[aria-expanded]'
  }
};
SITES['chat.openai.com'] = SITES['chatgpt.com'];
const site = SITES[location.hostname];
const TAG = '[Virtual Office]';
const COMPOSER = '#prompt-textarea, fieldset [contenteditable="true"], form [contenteditable="true"], [contenteditable="true"][role="textbox"], .ProseMirror[contenteditable="true"], form textarea';
const QUIET_MS = 3000;      // page unchanged this long = reply finished
const GIVE_UP_MS = 90000;   // nothing happened after sending = stop waiting
const MAX_MS = 600000;      // never wait longer than 10 minutes

const sessionId = (site ? site.source : 'web') + '-' + Math.random().toString(36).slice(2, 10);

// When the extension is reloaded or updated, Chrome cuts this copy off from it. background.js then puts a fresh
// copy into the tab, and this one retires quietly instead of failing on every message.
let retired = false;
function alive() {
  try { if (chrome.runtime.id) return true; } catch {}
  if (!retired) { retired = true; clearInterval(ticker); console.log(TAG + ' an updated copy of the extension takes over in this tab'); }
  return false;
}

function post(ev) {
  if (!alive()) return;
  const what = ev.hook_event_name === 'Stop' ? 'reply finished' : ev.hook_event_name === 'Step' ? 'step "' + ev.step + '"' : 'prompt sent';
  try {
    chrome.runtime.sendMessage({ session_id: sessionId, source: site.source, ...ev }, res => {
      if (chrome.runtime.lastError) console.warn(TAG + ' ' + what + ', but the extension could not forward it:', chrome.runtime.lastError.message);
      else console.log(TAG + ' ' + what + (res && res.ok ? ', office got it' : ", office didn't get it: " + (res && res.error)));
    });
  } catch { alive(); }
}

function composer() { return document.querySelector(COMPOSER); }
function composerText() {
  const el = composer();
  return el ? (el.tagName === 'TEXTAREA' ? el.value : el.innerText).trim() : '';
}
// Size of the page text, not counting the message box (so your typing doesn't look like a reply)
function pageSize() {
  const el = composer();
  return document.body.innerText.length - (el ? el.innerText.length : 0);
}
const busyNow = () => !!document.querySelector(site.busy);

// waiting: after a prompt was sent, until the reply is finished
let waiting = false, sentAt = 0, lastSize = 0, changedAt = 0, sawReply = false, wasBusy = false;

// The steps the reply shows while it works are expandable rows ("Read resource ▸", "Creating a file 2m 4s").
// The newest row after your last message is the step happening now. Rows from earlier replies are ignored.
let oldRows = new WeakSet(), lastStep = '';
const NOT_STEP = /^(show (more|less)|copy|retry|edit|share|more|options)$|^thought for\b/i;
function stepRows() {
  return [...document.querySelectorAll(site.steps)].filter(el => !el.closest('nav, aside, header, form, [role="dialog"], [role="menu"], [role="listbox"]'));
}
// The text lines of an element, without icon-font characters and arrows
const linesOf = el => (el.innerText || '').split('\n').map(l => l.replace(/[-]/g, '').replace(/[▸▾›»>]+\s*$/, '').trim()).filter(Boolean);
const TIMER = /(^|\s)(\d+\s*h\s*)?(\d+\s*m\s*)?\d+\s*[ms]$/i;   // "2m 34s", "12s", "Read resource 2m 34s"
// The first line with words, without the timer
function wordsOf(lines) {
  for (const l of lines) {
    const t = l.replace(/(\s*\d+\s*[hms])+$/i, '').trim();
    if (/\p{L}/u.test(t) && t.length <= 160 && !NOT_STEP.test(t)) return t;
  }
  return '';
}
function currentStep() {
  const msgs = document.querySelectorAll(site.userMessage), last = msgs[msgs.length - 1];
  const rows = stepRows().filter(el => !oldRows.has(el) && (!last || last.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
  // 1. The header of the step list shows the step happening now, next to a running timer ("Read resource 2m 34s").
  //    The expand button may hold only an icon, so look at it and a few of its parents for the smallest block with a timer.
  let header = null;
  for (const row of rows) {
    for (let el = row, up = 0; el && up < 4; el = el.parentElement, up++) {
      const lines = linesOf(el);
      if (lines.length > 6) break;
      if (lines.some(l => TIMER.test(l)) && wordsOf(lines)) { if (!header || lines.length < header.length) header = lines; break; }
    }
  }
  if (header) return wordsOf(header);
  // 2. No header: the newest row with words, looking at its parents when the button is only an icon
  for (let i = rows.length - 1; i >= 0; i--)
    for (let el = rows[i], up = 0; el && up < 3; el = el.parentElement, up++) {
      const lines = linesOf(el);
      if (lines.length > 6) break;
      const text = wordsOf(lines);
      if (text) return text;
    }
  return '';
}
function stepTick() {
  const step = currentStep();
  if (step && step !== lastStep) { lastStep = step; post({ hook_event_name: 'Step', step }); }
}

function start(prompt) {
  if (waiting) post({ hook_event_name: 'Stop' }); // a new prompt replaces the unfinished one
  post({ hook_event_name: 'UserPromptSubmit', prompt: prompt || 'New chat message' });
  waiting = true; sentAt = changedAt = Date.now(); lastSize = pageSize(); sawReply = false;
  oldRows = new WeakSet(stepRows()); lastStep = '';
}

function tick() {
  if (!alive()) return;
  const now = Date.now(), busy = busyNow(), appeared = busy && !wasBusy;
  wasBusy = busy;
  if (!waiting) {
    // Backup: a reply started without us seeing you send (for example "Retry" or editing a message)
    if (appeared) {
      const msgs = document.querySelectorAll(site.userMessage), last = msgs[msgs.length - 1];
      start(last && last.innerText.trim());
      sawReply = true;
    }
    return;
  }
  stepTick();
  const size = pageSize();
  if (size !== lastSize) { lastSize = size; changedAt = now; if (now - sentAt > 800) sawReply = true; }
  if (busy) { sawReply = true; changedAt = now; }
  if ((sawReply && now - changedAt > QUIET_MS) || (!sawReply && now - sentAt > GIVE_UP_MS) || now - sentAt > MAX_MS) {
    waiting = false;
    post({ hook_event_name: 'Stop' });
  }
}

// The skill hint (turned on in the office's Setup): while you type, ask the office which team member's skill fits; when
// you send, add that one line to the end of the message, then send it. The office answers nothing when it is turned off.
let hint = null, hintFor = null, hintTimer = 0, hinting = false;
function askHint() {
  const text = composerText();
  if (text === hintFor) return;
  hintFor = text; hint = null;
  if (!text || !alive()) return;
  try {
    chrome.runtime.sendMessage({ hint: true, prompt: text }, res => {
      if (chrome.runtime.lastError) return;
      if (hintFor === text) hint = res && res.hint || null;
    });
  } catch { alive(); }
}
const SEND = 'button[data-testid="send-button"], button[aria-label*="Send"], button[data-testid*="send"]';
// Puts text at the end of the message box the way typing would, so the page's editor notices it
function appendToComposer(text) {
  const box = composer();
  if (!box) return false;
  box.focus();
  if (box.tagName === 'TEXTAREA') {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, box.value + text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    const range = document.createRange(); range.selectNodeContents(box); range.collapse(false);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    document.execCommand('insertText', false, text);
  }
  return true;
}
// On send: if a hint is ready for exactly this text, hold the send, add the hint, then send again a moment later
function sendWithHint(e) {
  const text = composerText();
  if (hinting || !hint || hintFor !== text || text.includes(hint)) return false;
  e.preventDefault(); e.stopImmediatePropagation();
  hinting = true;
  appendToComposer(' ' + hint);
  hintFor = composerText();
  setTimeout(() => {
    const button = document.querySelector(SEND);
    if (button && !button.disabled) button.click();
    else { const box = composer(); if (box) box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })); }
    hinting = false;
  }, 80);
  return true;
}

// You send a prompt: Enter (without Shift) in the message box, or a click on the Send button.
// Read in the capture phase, before the page clears the message box.
function onSend() {
  if (!alive()) return;
  const text = composerText();
  if (text) start(text);
}
let ticker;
const other = window.__virtualOffice; // another copy already watching this tab: run only if that one is cut off
if (site && !(other && other !== alive && other())) {
  window.__virtualOffice = alive;
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    const box = composer();
    if (box && (box === e.target || box.contains(e.target)) && !sendWithHint(e)) onSend();
  }, true);
  document.addEventListener('click', e => {
    if (e.target.closest && e.target.closest(SEND) && !sendWithHint(e)) onSend();
  }, true);
  document.addEventListener('input', e => {
    const box = composer();
    if (box && (box === e.target || box.contains(e.target))) { clearTimeout(hintTimer); hintTimer = setTimeout(askHint, 250); }
  }, true);
  ticker = setInterval(tick, 1000);
  try { chrome.runtime.sendMessage({ hello: true }, () => void chrome.runtime.lastError); } catch {}
  console.log(TAG + ' watching ' + location.hostname + ' (v' + chrome.runtime.getManifest().version + ')');
}
})();
