'use strict';
const DAY=86400000;
function date(now=Date.now()) {return new Date(now+8*3600000).toISOString().slice(0,10);}
function minute(now=Date.now()) {const d=new Date(now+8*3600000); return d.getUTCHours()*60+d.getUTCMinutes();}
function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  const d=new Date(s+'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10)===s;
}
function toMin(s) {
  const m=/^(\d{2}):(\d{2})(?::00)?$/.exec(String(s || ''));
  if (!m || +m[1]>23 || +m[2]>59) throw new Error('时间必须是有效的 HH:mm');
  return +m[1]*60 + +m[2];
}
function addDays(s,n) {return new Date(new Date(s+'T00:00:00Z').getTime()+n*DAY).toISOString().slice(0,10);}
function parse(input) {
  if (!input) return '';
  const s=String(input).trim(), today=date();
  let m=s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})[日号]?$/);
  if(m) {const r=`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`; if(!validDate(r)) throw new Error('日期不存在'); return r;}
  m=s.match(/^(\d{1,2})[-/.月](\d{1,2})[日号]?$/);
  if(m) {const part=`${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`; let r=`${today.slice(0,4)}-${part}`; if(!validDate(r)) throw new Error('日期不存在'); if(r<today) r=`${+today.slice(0,4)+1}-${part}`; if(!validDate(r)) throw new Error('日期不存在'); return r;}
  const offset=/^(今天|今日|now|today)$/i.test(s)?0:/^(明天|明日|tomorrow|tom)$/i.test(s)?1:/^(后天|後天)$/.test(s)?2:s==='大后天'?3:null;
  if(offset!=null) return addDays(today,offset);
  m=s.match(/^周([一二三四五六日天])$/);
  if(m) {const target={一:1,二:2,三:3,四:4,五:5,六:6,日:7,天:7}[m[1]],cur=new Date(today+'T00:00:00Z').getUTCDay() || 7; return addDays(today,(target-cur+7)%7 || 7);}
  throw new Error('无法识别日期，请使用 YYYY-MM-DD');
}
function merge(ranges) {
  const result=[];
  for(const [s,e] of ranges.filter(([s,e])=>Number.isFinite(s)&&e>s).sort((a,b)=>a[0]-b[0])) {
    if(result.length && s<=result.at(-1)[1]) result.at(-1)[1]=Math.max(e,result.at(-1)[1]);
    else result.push([s,e]);
  }
  return result;
}
function windows(room) {
  const input=room.openTimes?.length ? room.openTimes : [{openStartTime:room.openStart || '08:00',openEndTime:room.openEnd || '22:00'}];
  return merge(input.map(o=>[toMin(o.openStartTime),toMin(o.openEndTime)]));
}
function free(open,occupied,minimum=30,earliest=0) {
  const result=[];
  for(const [s,e] of merge(open)) {
    let cursor=Math.max(s,earliest);
    for(const [bs,be] of merge(occupied.map(([a,b])=>[Math.max(a,s),Math.min(b,e)]))) {
      if(bs-cursor>=minimum) result.push([cursor,bs]);
      cursor=Math.max(cursor,be);
    }
    if(e-cursor>=minimum) result.push([cursor,e]);
  }
  return result;
}
module.exports={DAY,date,minute,validDate,toMin,addDays,parse,windows,merge,free};
