const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const start = html.indexOf('function arrangeLabels(');
const context = vm.createContext({W:576});
vm.runInContext(html.slice(start, html.indexOf('function person(', start)), context);
// Eight long labels clustered in the lounge, at both desktop and small-screen sizes.
for (const width of [55, 100]) {
  context.labels = Array.from({length:8}, (_, i) => ({x:260 + i * 8, y:145 + i * 3, w:width, h:12}));
  const result = vm.runInContext('arrangeLabels(labels)', context);
  for (let i = 0; i < result.length; i++) {
    const a = result[i];
    assert(a.x - a.w / 2 >= 0 && a.x + a.w / 2 <= 576 && a.y - a.h >= 0);
    for (const b of result.slice(i + 1)) {
      const overlap = Math.abs(a.x - b.x) < (a.w + b.w) / 2 && a.y > b.y - b.h && a.y - a.h < b.y;
      assert(!overlap, 'lounge labels overlap');
    }
  }
}
console.log('Label layout OK: clustered lounge names remain separate and inside the scene.');
