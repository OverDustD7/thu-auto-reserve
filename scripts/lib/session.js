'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('./crypto');
function read(file) {
  if (!fs.existsSync(file)) return null;
  try {
    const o = JSON.parse(crypto.decrypt(fs.readFileSync(file,'utf8')));
    if (crypto.isExpired(o.updatedAt)) throw new Error('Expired');
    crypto.remember(o);
    for (const c of o.cookies || []) crypto.remember(c.value);
    return o;
  } catch (e) {
    if (e.code === 'DPAPI_UNAVAILABLE') throw e;
    fs.unlinkSync(file);
    return null;
  }
}
function write(file,data) {
  const value = {...data,updatedAt:data.updatedAt || new Date().toISOString()};
  if (crypto.isExpired(value.updatedAt)) throw new Error('不能保存已过期会话');
  const encrypted = crypto.encrypt(JSON.stringify(value));
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp = file + '.' + process.pid + '.tmp';
  try { fs.writeFileSync(temp,encrypted,{mode:0o600,flag:'wx'}); fs.renameSync(temp,file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  crypto.remember(value);
}
function cookieHeader(state,target,now=Date.now()) {
  const u = new URL(target);
  return (state?.cookies || []).filter(c=>{
    const domain = String(c.domain || '').toLowerCase(), host = u.hostname.toLowerCase();
    const domainOK = domain.startsWith('.') ? host===domain.slice(1) || host.endsWith(domain) : host===domain;
    const p = c.path || '/';
    const pathOK = u.pathname===p || (u.pathname.startsWith(p) && (p.endsWith('/') || u.pathname[p.length]==='/'));
    return domainOK && pathOK && (!c.secure || u.protocol==='https:') && (c.expires===-1 || c.expires==null || c.expires*1000>now);
  }).sort((a,b)=>(b.path || '/').length-(a.path || '/').length)
    .map(c=>{crypto.remember(c.value); return `${c.name}=${c.value}`;}).join('; ');
}
function removeLegacyProfile(profile) {
  const resolved = path.resolve(profile);
  if (path.basename(resolved)!=='browser-profile' || !['.thu-sports-venue','.thu-lib-space','.thu-lib-seat'].includes(path.basename(path.dirname(resolved)))) {
    if (fs.existsSync(resolved)) throw new Error('自定义旧浏览器目录需先手动清理；新版本不再使用持久化 profile');
    return;
  }
  if (!fs.existsSync(resolved)) return;
  let cursor = resolved;
  while (true) {
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('拒绝清理符号链接目录');
    const parent = path.dirname(cursor); if (parent===cursor) break; cursor=parent;
  }
  fs.rmSync(resolved,{recursive:true,force:true});
}
function clear(files,profile) {
  for (const file of files) if (fs.existsSync(file)) fs.unlinkSync(file);
  if (profile) removeLegacyProfile(profile);
}
async function launch(chromium,options,storageFile,profile) {
  removeLegacyProfile(profile);
  const state = read(storageFile);
  const {headless,channel,...contextOptions} = options;
  const browser = await chromium.launch({headless,...(channel ? {channel} : {})});
  try {
    const context = await browser.newContext({...contextOptions,...(state ? {storageState:{cookies:state.cookies || [],origins:state.origins || []}} : {})});
    const close = context.close.bind(context);
    context.close = async()=>{try {await close();} finally {await browser.close();}};
    return context;
  } catch(e) {await browser.close(); throw e;}
}
module.exports = {read,write,cookieHeader,removeLegacyProfile,clear,launch};
