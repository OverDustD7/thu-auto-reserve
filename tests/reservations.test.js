const test = require('node:test');
const assert = require('node:assert/strict');
const {load} = require('./helpers.cjs');
const bj = require('../scripts/lib/beijing');

function space(min=3) {
  const s=load('space-helper.js');
  s.run(`
    globalThis.posts=[];
    readCachedToken=()=> 'FAKE'; readTokenFile=()=>({userInfo:{accNo:'SELF'}});
    getApiClient=()=>({close:async()=>{}});
    getRoomMenu=async()=>[{kindId:1,kindName:'团体研讨间',kindClass:1}];
    output=r=>r;
    apiCall=async(ctx,token,method,endpoint,params,body)=>{
      if(method==='POST'){posts.push(body);return {code:0,data:'ORDER'};}
      if(endpoint==='reserve')return {code:0,data:[{devName:'ROOM',devId:1,minUser:${min},maxUser:10,openTimes:[{openStartTime:'08:00',openEndTime:'22:00'}]}]};
      if(endpoint==='account/getMembers')return {code:0,data:[{accNo:'ACC-'+params.key,logonName:params.key}]};
      throw Error('Unexpected API');
    };
  `);
  return s;
}
const args=['--room','团体研讨间','--dev','ROOM','--date','明天','--time','10:00','--end','11:00'];
test('repeated member cannot satisfy minimum headcount',async()=>{
  const s=space(); const r=await s.run(`cmdReserve(${JSON.stringify([...args,'--members','1234,1234','--yes'])})`);
  assert.equal(r.code,1); assert.equal(s.run('posts.length'),0);
});
test('valid unique members preview without a mutation',async()=>{
  const s=space(); const r=await s.run(`cmdReserve(${JSON.stringify([...args,'--members','1234,5678'])})`);
  assert.equal(r.data.memberCount,3); assert.equal(s.run('posts.length'),0);
});
test('valid unique members submit exactly once',async()=>{
  const s=space(); const r=await s.run(`cmdReserve(${JSON.stringify([...args,'--members','1234,5678','--yes'])})`);
  assert.equal(r.code,0); assert.equal(s.run('posts.length'),1);
  assert.equal(new Set(s.run('posts[0].resvMember')).size,3);
});
test('masked candidates never fall back to matching two digits',async()=>{
  const s=space(2);
  s.run(`const original=apiCall; apiCall=async(...x)=> x[3]==='account/getMembers' ? {code:0,data:[{accNo:'OTHER',logonName:'******34'}]} : original(...x);`);
  await assert.rejects(s.run(`cmdReserve(${JSON.stringify([...args,'--members','1234','--yes'])})`),/精确核实/);
  assert.equal(s.run('posts.length'),0);
});
test('ambiguous room names stop before submission',async()=>{
  const s=space(); await assert.rejects(s.run(`cmdReserve(${JSON.stringify([...args.slice(0,3),'RO',...args.slice(4),'--yes'])})`),/精确匹配/);
});
test('opening windows are preserved and bookings clipped',()=>{
  const s=space(); const day=bj.addDays(bj.date(),1);
  const r=s.run(`parseSlotRoom({devName:'R',openTimes:[{openStartTime:'08:00',openEndTime:'12:00'},{openStartTime:'14:00',openEndTime:'22:00'}],resvInfo:[{startTime:'${day}T23:00:00+08:00',endTime:'${day}T23:30:00+08:00'}]},'k',1,0,false,30,'${day}')`);
  assert.deepEqual(Array.from(r.available),['08:00–12:00','14:00–22:00']);
});
test('past, invalid calendar dates and malformed times rejected',()=>{
  assert.throws(()=>bj.parse('2026-02-31'));
  assert.throws(()=>bj.toMin('08:99')); assert.throws(()=>bj.toMin('25:00'));
  assert.equal(bj.parse('2028-02-29'),'2028-02-29');
  assert.equal(bj.date(Date.parse('2026-09-06T20:00:00Z')),'2026-09-07');
});
test('free intervals respect current-time and overlapping reservations',()=>{
  assert.deepEqual(bj.free([[480,1320]],[[540,600],[570,660]],30,510),[[510,540],[660,1320]]);
});
for(const msg of ['请先登录','取消次数已达上限','无权操作']) test('cancellation rejected: '+msg,async()=>{
  const s=load('seat-helper.js'); s.run(`httpPost=async()=>({json:{status:0,msg:${JSON.stringify(msg)}}}); fullCookie=()=>''; out=x=>console.log(x); err=x=>{throw Error(x);};`);
  await assert.rejects(s.run("doCancelAPI({userid:'U',access_token:'FAKE'},'1')"),/取消失败/);
  assert.equal(s.logs.length,0);
});
test('successful cancellation remains successful',async()=>{
  const s=load('seat-helper.js'); s.run("httpPost=async()=>({json:{status:1,msg:'已取消'}});fullCookie=()=>'';out=x=>console.log(x)");
  await s.run("doCancelAPI({userid:'U'},'1')"); assert.match(s.logs[0],/取消成功/);
});
test('seat list failure never returns an empty success',async()=>{
  const s=load('seat-helper.js'); s.run("requireLogin=()=>({});fullCookie=()=>'';httpGet=async()=>({status:500,raw:'<html>Error</html>'})");
  await assert.rejects(s.run('cmdBookings(true)'),/不能按无记录/);
});
test('cancellation requires the selected id',async()=>{
  const s=load('seat-helper.js'); s.run('requireLogin=()=>({})');
  await assert.rejects(s.run('cmdCancel({yes:true})'),/指定 --id/);
});
test('setup preserves unrelated package fields',async()=>{
  let written;
  const pkg={name:'thu-auto-reserve',version:'1.2.0',scripts:{custom:'keep'},dependencies:{other:'1.0.0'}};
  const s=load('seat-helper.js',{fs:{existsSync:()=>true,readFileSync:()=>JSON.stringify(pkg),writeFileSync:(p,v)=>{written=JSON.parse(v);}},child_process:{execSync(){}}});
  await s.run('cmdSetup({})'); assert.equal(written.name,pkg.name); assert.equal(written.scripts.custom,'keep'); assert.equal(written.dependencies.other,'1.0.0');
});
test('contradictory mutation flags are rejected',()=>{
  const s=space(); assert.throws(()=>s.run("parseArgs(['--yes','--dry-run'])")); assert.throws(()=>s.run("parseArgs(['--yes=false'])"));
});
test('failed library availability is not a successful empty result',async()=>{
  const s=space();s.run("apiCall=async()=>({code:500,message:'unavailable'})");
  await assert.rejects(s.run("cmdSlots(['--room','团体研讨间','--date','明天','--json'])"),/查询失败/);
});
test('sports browser stops before time selection when date selection fails',async()=>{
  const s=load('venue-helper.js');
  s.run(`
    globalThis.closed=0;globalThis.selectedTime=false;
    readCachedToken=()=> 'FAKE';getApiClient=()=>({close:async()=>{}});findFutureOrders=async()=>[];
    resolveScenes=async()=>[{uuid:'S',sceneName:'SPORT'}];
    launchContext=async()=>({close:async()=>{closed++;},newPage:async()=>({
      goto:async()=>{},waitForFunction:async()=>{throw Error('date unavailable');},
      evaluate:async()=>{selectedTime=true;},waitForTimeout:async()=>{},
    })});
  `);
  await assert.rejects(s.run("cmdReserve(['--scene','SPORT','--date','明天','--time','10:00'])"),/指定日期/);
  assert.equal(s.run('closed'),1);assert.equal(s.run('selectedTime'),false);
});
test('seat availability errors stop instead of showing zero seats',async()=>{
  const s=load('seat-helper.js');s.run("httpGet=async()=>({status:200,json:{status:0}})");
  await assert.rejects(s.run('cmdAreas(true)'),/不能按零空座/);
});
test('library date picker confirms selected state, not just editable text',async()=>{
  const s=space();
  let active=false;
  const input={click:async()=>{},fill:async()=>{},press:async()=>{}};
  s.ctx.document={getElementById:()=>({getAttribute:()=>null,classList:{contains:name=>active && name==='is-active'}})};
  s.ctx.page={locator:()=>({first:()=>input}),waitForTimeout:async()=>{},waitForFunction:async(fn,arg)=>{if(!fn(arg)) throw Error('not selected');}};
  assert.equal(await s.run("selectDateByPicker(page,'2026-09-08')"),false);
  active=true;
  assert.equal(await s.run("selectDateByPicker(page,'2026-09-08')"),true);
});
test('library browser rejects invalid time or past date before opening',async()=>{
  const s=space();
  await assert.rejects(s.run("cmdReserveBrowser(['--room','团体研讨间','--date','2020-01-01'])"),/过去/);
  await assert.rejects(s.run("cmdReserveBrowser(['--room','团体研讨间','--time','25:00'])"),/HH:mm/);
  await assert.rejects(s.run("cmdReserveBrowser(['--room','团体研讨间','--time','11:00','--end','10:00'])"),/晚于/);
});
test('sports displayed dates use Beijing time across UTC midnight',()=>{
  const s=load('venue-helper.js');
  assert.equal(s.run("fmtDate(new Date('2026-09-06T20:00:00Z'))"),'2026-09-07');
});
