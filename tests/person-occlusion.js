// Check the actual sprite pixels: hands held in front must not appear on a person's back.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const between = (start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));
const context = vm.createContext({});
vm.runInContext(`
  const SPW=42, SPH=76, SPM=3, WALK_FRAMES=8;
  const shade=(color)=>color;
  ${between('function pixelGrid()', '// Shade on the right-hand rim')}
  ${between('function paintPerson(', 'const spriteCache =')}
  const rim=()=>()=>false;
  function render(back, arms, act, look={}) {
    const grid=pixelGrid();
    paintPerson(grid,{id:'backend',hair:'#161616',skin:'#c48a5e',color:'#3f6fd8',gender:'woman',hairStyle:'classic',outfit:'shirt',accessory:'none',...look},
      {back,arms,act,seated:true,walk:-1,turn:0,sleep:false});
    return grid;
  }
  globalThis.render=render;
`, context);
for (const act of [null, 'eat', 'game', 'tv']) for (const arms of [-1, 0, 1, 2, 3]) {
  const rear = context.render(true, arms, act);
  const front = context.render(false, arms, act);
  const skinInBody = grid => grid.g.filter((color, i) => {
    const y = Math.floor(i / grid.w) - 3;
    return y >= 39 && y <= 53 && color === '#c48a5e';
  }).length;
  assert.equal(skinInBody(rear), 0, `rear pose ${arms} exposes hands`);
  assert(skinInBody(front) > 0, `front pose ${arms} lost its hands`);
}

// Exercise prop rendering in both directions, with the canvas replaced by a recorder.
const props = [];
Object.assign(context, {
  P:{shadow:'#000'}, ctx:{beginPath(){},ellipse(){},fill(){},drawImage(){}},
  pj:()=>[0,0], px:x=>x, atDesk:()=>false, reduce:true, T:0, SPS:3,
  sprite:()=>({height:60,width:48}), lead:{}, planning:false,
  r:(...args)=>props.push(args)
});
vm.runInContext(between('function drawPerson(', '// ---------- Presence'), context);
for (const face of ['up','down']) {
  props.length=0;
  context.person={face,seated:true,act:'game',x:0,y:0,z:0,sitZ:0,seatX:0,color:'#3f6fd8'};
  vm.runInContext('drawPerson(person)',context);
  assert.equal(props.length, face === 'up' ? 0 : 3, `controller visibility facing ${face}`);
}
console.log('Person occlusion OK: rear hands and controller hidden; front hands and controller visible.');

// A longer seated sprite must extend below its hips, not lift the character off the stool.
const tops = [];
context.ctx.drawImage = (image, x, y) => tops.push(y);
for (const height of [62, 75]) {
  context.sprite = () => ({height, width:48});
  vm.runInContext('drawPerson(person)', context);
}
assert.equal(tops[0], tops[1], 'seated hips moved when lower legs were drawn');
assert.notDeepEqual(context.render(false, 0, 'eat').g, context.render(false, 0, 'game').g, 'eating and gaming use distinct poses');
console.log('Seating OK: stable hip anchor and distinct eating/gaming poses.');

const baseLook = context.render(false, -1, null).g;
for (const look of [{gender:'man'}, {hairStyle:'short'}, {hairStyle:'long'}, {outfit:'jacket'}, {outfit:'hoodie'}, {accessory:'glasses'}]) {
  assert.notDeepEqual(context.render(false, -1, null, look).g, baseLook, `${Object.keys(look)[0]} did not change the sprite`);
}
assert.notDeepEqual(context.render(true, -1, null, {accessory:'beanie'}).g,
  context.render(true, -1, null, {accessory:'hood'}).g, 'chosen accessory is still tied to role');
console.log('Appearance OK: character, hair, wardrobe and accessory choices change the sprite.');

for (const back of [true, false]) {
  const seated = context.render(back, -1, 'eat');
  const bottom = seated.g.reduce((last, pixel, i) => pixel ? Math.max(last, Math.floor(i / seated.w) - 3) : last, 0);
  assert(bottom <= (back ? 57 : 63), 'counter pose has straight standing-length legs');
}
console.log('Counter seating OK: bent front legs; rear legs occluded by the seated body.');
