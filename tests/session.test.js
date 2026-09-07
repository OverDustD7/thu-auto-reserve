const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const os=require('os');
const session=require('../scripts/lib/session');
const crypto=require('../scripts/lib/crypto');
function temporary(fn) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'thu-session-test-'));
  try {return fn(root);} finally {
    assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('thu-session-test-'));
    fs.rmSync(root,{recursive:true,force:true});
  }
}
test('DPAPI encrypts and reads only current envelope', {skip:process.platform!=='win32'},()=>temporary(root=>{
  const file=path.join(root,'session.json');
  session.write(file,{token:'SYNTHETIC-SESSION'});
  assert.ok(!fs.readFileSync(file,'utf8').includes('SYNTHETIC-SESSION'));
  assert.equal(session.read(file).token,'SYNTHETIC-SESSION');
  assert.throws(()=>crypto.decrypt('{"token":"old"}'));
}));
test('missing invalid future and boundary timestamps expire',()=>{
  const now=Date.now();
  for(const ts of [undefined,'invalid',now+1,now-crypto.TTL]) assert.equal(crypto.isExpired(ts,now),true);
  assert.equal(crypto.isExpired(now-1000,now),false);
});
test('legacy plaintext is discarded instead of migrated silently',()=>temporary(root=>{
  const file=path.join(root,'session.json'); fs.writeFileSync(file,'{"token":"SYNTHETIC"}');
  assert.equal(session.read(file),null); assert.equal(fs.existsSync(file),false);
}));
test('cookies obey domain path expiry and secure restrictions',()=>{
  const cookies=[
    {name:'SSO',value:'fake',domain:'id.tsinghua.edu.cn',path:'/',expires:-1},
    {name:'EXPIRED',value:'fake',domain:'cab.lib.tsinghua.edu.cn',path:'/',expires:1},
    {name:'WRONGPATH',value:'fake',domain:'cab.lib.tsinghua.edu.cn',path:'/ic-we',expires:-1},
    {name:'OK',value:'fake',domain:'cab.lib.tsinghua.edu.cn',path:'/ic-web',secure:true,expires:-1},
  ];
  assert.equal(session.cookieHeader({cookies},'https://cab.lib.tsinghua.edu.cn/ic-web/reserve'),'OK=fake');
  assert.equal(session.cookieHeader({cookies},'http://cab.lib.tsinghua.edu.cn/ic-web/reserve'),'');
});
test('profile cleanup rejects arbitrary or linked paths',()=>temporary(root=>{
  const unrelated=path.join(root,'unrelated');fs.mkdirSync(unrelated);
  assert.throws(()=>session.removeLegacyProfile(unrelated),/手动清理/);assert.ok(fs.existsSync(unrelated));
  const parent=path.join(root,'.thu-lib-seat');fs.mkdirSync(parent);
  const profile=path.join(parent,'browser-profile');fs.mkdirSync(profile);fs.writeFileSync(path.join(profile,'fake'),'x');
  session.removeLegacyProfile(profile);assert.equal(fs.existsSync(profile),false);
  fs.symlinkSync(unrelated,profile,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>session.removeLegacyProfile(profile),/符号链接/);
  assert.ok(fs.existsSync(unrelated));
  fs.unlinkSync(profile);
}));
test('redaction covers refresh tokens cookies and JWTs',()=>{
  crypto.remember({refreshToken:'SYNTHETIC-REFRESH'});
  assert.ok(!crypto.scrub('oops SYNTHETIC-REFRESH').includes('SYNTHETIC-REFRESH'));
  assert.ok(!crypto.scrub('{"token":"SYNTHETIC-OTHER"}').includes('SYNTHETIC-OTHER'));
  assert.ok(!crypto.scrub('eyJsynthetic.payload.signature').includes('eyJsynthetic'));
});
test('expired encrypted browser state is deleted', {skip:process.platform!=='win32'},()=>temporary(root=>{
  const file=path.join(root,'storage-state.json');
  fs.writeFileSync(file,crypto.encrypt(JSON.stringify({updatedAt:Date.now()-crypto.TTL,cookies:[]})));
  assert.equal(session.read(file),null);assert.equal(fs.existsSync(file),false);
}));
test('browser uses a new context with encrypted state and closes its process', {skip:process.platform!=='win32'},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'thu-session-test-'));
  try {
    const stateFile=path.join(root,'storage.json');
    session.write(stateFile,{cookies:[{name:'TEST',value:'FAKE',domain:'example.com',path:'/',expires:-1}],origins:[]});
    let options, contextClosed=0, browserClosed=0;
    const context={close:async()=>{contextClosed++;}};
    const browser={newContext:async o=>{options=o;return context;},close:async()=>{browserClosed++;}};
    const chromium={launch:async()=>browser,launchPersistentContext:()=>{throw Error('persistent browser forbidden');}};
    const result=await session.launch(chromium,{headless:true},stateFile,path.join(root,'.thu-lib-seat','browser-profile'));
    assert.equal(options.storageState.cookies[0].name,'TEST');
    await result.close();assert.equal(contextClosed,1);assert.equal(browserClosed,1);
  } finally {
    assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('thu-session-test-'));
    fs.rmSync(root,{recursive:true,force:true});
  }
});
