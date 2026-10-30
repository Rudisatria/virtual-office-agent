// Your office's settings: its name, your name, the team members' names, colors and skills, and office hours.
// Saved per person in %LOCALAPPDATA%\ClaudeOffice\config.json (~/.claude-office on Mac and Linux), never in the repo.
// Also installs each member's skill (a SKILL.md) for Claude Code (~/.claude/skills) and Codex (~/.codex/skills),
// and packs it as a .zip for uploading to claude.ai or ChatGPT.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA = process.env.OFFICE_DATA || (process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ClaudeOffice')
  : path.join(os.homedir(), '.claude-office'));
const FILE = path.join(DATA, 'config.json');
const HOME = process.env.OFFICE_HOME || os.homedir();   // where ~/.claude and ~/.codex live (tests point this elsewhere)
const REPO_SKILLS = path.join(__dirname, 'skills');
const MY_SKILLS = path.join(DATA, 'skills');             // your edited copies of the skills

// The seven team roles are fixed (the office has a desk for each); names, colors and skills are yours to change
const ROLES = [
  { id: 'pm',       title: 'Product Manager', name: 'Product Manager', color: '#7c4fd6', skill: 'office-pm' },
  { id: 'designer', title: 'Designer',        name: 'Designer',        color: '#d8920f', skill: 'office-designer' },
  { id: 'frontend', title: 'Frontend',        name: 'Frontend',        color: '#e0507a', skill: 'office-frontend' },
  { id: 'backend',  title: 'Backend',         name: 'Backend',         color: '#3f6fd8', skill: 'office-backend' },
  { id: 'qa',       title: 'QA',              name: 'QA',              color: '#1fa3a3', skill: 'office-qa' },
  { id: 'security', title: 'IT Security',     name: 'IT Security',     color: '#c8423a', skill: 'office-security' },
  { id: 'devops',   title: 'DevOps',          name: 'DevOps',          color: '#2f9e74', skill: 'sre-devops' }
];
const DEFAULTS = {
  officeName: 'My Virtual Office',
  manager: 'Me',
  hours: { start: '09:00', end: '18:00' },
  breaks: { lunch: { start: '12:00', end: '13:00' }, coffee: { start: '15:30', end: '15:45' } },
  skillHint: true,       // tell Claude Code / Codex which member's skill fits each prompt
  webHint: false,        // add that hint to ChatGPT / claude.ai messages too, through the Chrome extension (opt-in)
  team: Object.fromEntries(ROLES.map(r => [r.id, { name: r.name, color: r.color, skill: r.skill }]))
};

const clean = (v, max, fallback) => { const s = String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max); return s || fallback; };
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// Fills in anything missing or invalid with the defaults, so the rest of the code can trust what it gets
function normalize(c = {}) {
  const team = {};
  for (const r of ROLES) {
    const m = (c.team && c.team[r.id]) || {};
    team[r.id] = {
      name: clean(m.name, 40, r.name),
      color: /^#[0-9a-f]{6}$/i.test(m.color || '') ? m.color.toLowerCase() : r.color,
      skill: SKILL_NAME.test(m.skill || '') ? m.skill : r.skill
    };
  }
  const h = c.hours || {}, b = (c.breaks && c.breaks.coffee) || {};
  const hours = { start: TIME.test(h.start) ? h.start : DEFAULTS.hours.start, end: TIME.test(h.end) ? h.end : DEFAULTS.hours.end };
  if (hours.start >= hours.end) Object.assign(hours, DEFAULTS.hours);
  const l = (c.breaks && c.breaks.lunch) || {};
  const lunch = TIME.test(l.start) && TIME.test(l.end) && l.start < l.end ? { start: l.start, end: l.end } : { ...DEFAULTS.breaks.lunch };
  const coffee = TIME.test(b.start) && TIME.test(b.end) && b.start < b.end && (b.end <= lunch.start || b.start >= lunch.end)
    ? { start: b.start, end: b.end } : { ...DEFAULTS.breaks.coffee };
  return {
    officeName: clean(c.officeName, 60, DEFAULTS.officeName),
    manager: clean(c.manager, 30, DEFAULTS.manager),
    hours,
    breaks: { lunch, coffee },
    skillHint: c.skillHint !== false,
    webHint: c.webHint === true,
    team
  };
}

function load() {
  try { return { ...normalize(JSON.parse(fs.readFileSync(FILE, 'utf8'))), firstRun: false }; }
  catch { return { ...normalize(), firstRun: true }; }
}
function save(c) {
  const n = normalize(c);
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(n, null, 2) + '\n');
  return n;
}

// ---------- Skills ----------
// A skill's text: your edited copy if you saved one, else the template that ships with the office (if any)
function skillText(name) {
  for (const f of [path.join(MY_SKILLS, name, 'SKILL.md'), path.join(REPO_SKILLS, name, 'SKILL.md')]) {
    try { return lf(fs.readFileSync(f, 'utf8')); } catch {}
  }
  return null;
}
// Line endings as \n everywhere, whatever git or an editor on Windows used
function lf(t){ return String(t).replace(/\r\n/g, '\n'); }
const templateText = name => { try { return lf(fs.readFileSync(path.join(REPO_SKILLS, name, 'SKILL.md'), 'utf8')); } catch { return null; } };
function saveSkillText(name, text) {
  if (!SKILL_NAME.test(name)) throw new Error('Invalid skill name: ' + name);
  const dir = path.join(MY_SKILLS, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), lf(text));
}
// The name in a SKILL.md's frontmatter has to match its folder, or Claude Code and Codex ignore it
function withName(text, name) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return `---\nname: ${name}\ndescription: ${name}\n---\n\n` + text;
  const head = /^name:/m.test(m[1]) ? m[1].replace(/^name:.*$/m, 'name: ' + name) : 'name: ' + name + '\n' + m[1];
  return '---\n' + head + '\n---' + text.slice(m[0].length);
}

// Where each tool keeps skills, and whether that tool is on this laptop
const TOOLS = {
  claude: { label: 'Claude Code', dir: () => path.join(HOME, '.claude', 'skills'), present: () => fs.existsSync(path.join(HOME, '.claude')) },
  codex:  { label: 'Codex',       dir: () => path.join(HOME, '.codex', 'skills'),  present: () => fs.existsSync(path.join(HOME, '.codex')) }
};
const MARK = '.virtual-office';   // marks skill folders the office wrote, so it never overwrites one you made yourself
const installedIn = (tool, name) => fs.existsSync(path.join(TOOLS[tool].dir(), name, 'SKILL.md'));

// Writes every member's skill into Claude Code and/or Codex. A folder with the same name that the office didn't
// create is left alone and reported, so your own skills are never overwritten.
function installSkills(cfg, tools) {
  const report = [];
  for (const tool of tools) {
    if (!TOOLS[tool].present()) { report.push({ tool, skipped: TOOLS[tool].label + ' is not on this laptop' }); continue; }
    for (const r of ROLES) {
      const name = cfg.team[r.id].skill, text = skillText(name);
      if (!text) { report.push({ tool, name, note: 'no text for this skill, so the existing one is used as is' }); continue; }
      const dir = path.join(TOOLS[tool].dir(), name), file = path.join(dir, 'SKILL.md');
      const ours = !fs.existsSync(file) || fs.existsSync(path.join(dir, MARK)) || lf(fs.readFileSync(file, 'utf8')) === templateText(name);
      if (!ours) { report.push({ tool, name, note: 'a skill with this name already exists and was not made by the office, so it was left alone' }); continue; }
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, withName(text, name));
      fs.writeFileSync(path.join(dir, MARK), 'Installed by the virtual office. Edit the skill in its Setup page.\n');
      report.push({ tool, name, installed: file });
    }
  }
  return report;
}

// ---------- .zip files (skills for claude.ai / ChatGPT, and the installer's payload); no dependencies ----------
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zip(files, compress = false) {   // files: [{name, data: Buffer}]; compress: deflate (smaller, slower)
  const parts = [], central = []; let offset = 0;
  // the files' date and time (now), in the zip format's DOS layout, so unpacked files show a real "Date modified"
  const d = new Date(), dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const name = Buffer.from(f.name), crc = crc32(f.data), size = f.data.length;
    const body = compress ? require('zlib').deflateRawSync(f.data, { level: 9 }) : f.data, method = compress ? 8 : 0;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8); local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(method, 10); cen.writeUInt16LE(dosTime, 12); cen.writeUInt16LE(dosDate, 14); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(body.length, 20); cen.writeUInt32LE(size, 24); cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42);
    parts.push(local, name, body); central.push(cen, name); offset += 30 + name.length + body.length;
  }
  const cenSize = central.reduce((n, b) => n + b.length, 0), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cenSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}
const skillZip = name => { const t = skillText(name); return t ? zip([{ name: name + '/SKILL.md', data: Buffer.from(withName(t, name)) }]) : null; };

module.exports = { ROLES, DEFAULTS, FILE, DATA, HOME, MARK, load, save, normalize, skillText, templateText, saveSkillText, installSkills, installedIn, skillZip, zip, TOOLS, SKILL_NAME };
