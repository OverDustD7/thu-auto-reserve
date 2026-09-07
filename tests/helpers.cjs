const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
function load(file, overrides = {}) {
  let source = fs.readFileSync(path.join(root, 'scripts', file), 'utf8');
  const entry = file === 'seat-helper.js' ? '\n(async function main()' : '\n(async () => {';
  const i = source.lastIndexOf(entry);
  if (i >= 0) source = source.slice(0, i);
  const deny = () => { throw new Error('Unexpected external operation'); };
  const logs = [];
  const ctx = vm.createContext({
    require: id => {
      if (overrides[id]) return overrides[id];
      if (id === './lib/beijing') return require('../scripts/lib/beijing');
      if (id.startsWith('./lib/crypto')) return { installRedaction() {}, scrub: x => x, remember() {} };
      if (id === './lib/session' || id === 'fs' || id === 'child_process') return new Proxy({}, {get:()=>deny});
      if (id === 'os') return {homedir:()=>'/fake-home'};
      if (['path','crypto'].includes(id)) return require(id);
      throw new Error('Unexpected import: '+id);
    },
    __dirname:path.join(root,'scripts'), Buffer, URL, URLSearchParams, AbortSignal, Date,
    process:{env:{},argv:[],exit:code=>{throw new Error('EXIT '+code);}},
    console:{log:(...x)=>logs.push(x.join(' ')),error:(...x)=>logs.push(x.join(' '))},
    fetch:deny,setTimeout:deny,
  });
  vm.runInContext(source,ctx,{filename:file});
  return {run:code=>vm.runInContext(code,ctx),ctx,logs};
}
module.exports={load};
