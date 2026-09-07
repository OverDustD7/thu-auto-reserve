'use strict';
// Current-user Windows DPAPI. Never derive keys from public machine identity.
const path = require('path');
const { spawnSync } = require('child_process');
const secrets = new Set();
const TTL = 7 * 86400000;
function protect(data, mode) {
  if (process.platform !== 'win32') throw new Error('本版本会话持久化需要 Windows DPAPI');
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const r = spawnSync(executable, ['-NoProfile','-NonInteractive','-File',path.join(__dirname,'dpapi.ps1'),mode], {
    input:data, encoding:'utf8', windowsHide:true, timeout:15000, maxBuffer:16*1024*1024,
  });
  if (r.error || r.status !== 0) {
    const error = new Error('系统会话保护失败，请检查当前用户权限');
    error.code = 'DPAPI_UNAVAILABLE';
    throw error;
  }
  return r.stdout.trim();
}
function encrypt(plain) { return JSON.stringify({v:2,alg:'windows-dpapi',ct:protect(Buffer.from(String(plain)).toString('base64'),'protect')}); }
function decrypt(blob) {
  const o = JSON.parse(blob);
  if (!o || o.v !== 2 || o.alg !== 'windows-dpapi' || typeof o.ct !== 'string') throw new Error('旧格式会话已停用，请重新登录');
  return Buffer.from(protect(o.ct,'unprotect'),'base64').toString('utf8');
}
function expiredAt(ms) { return new Date(ms + TTL); }
function isExpired(ts, now = Date.now()) {
  const u = typeof ts === 'number' ? ts : Date.parse(ts);
  return !ts || !Number.isFinite(u) || u > now || now >= u + TTL;
}
function remember(value) {
  if (!value) return;
  if (Array.isArray(value)) { value.forEach(remember); return; }
  if (typeof value === 'object') {
    for (const [k,v] of Object.entries(value)) {
      if (/token|cookie|authorization|password|captcha|secret/i.test(k) && typeof v === 'string') remember(v);
      else if (typeof v === 'object') remember(v);
    }
    return;
  }
  if (String(value).length >= 8) secrets.add(String(value));
}
function scrub(str, additional = []) {
  if (str == null) return str;
  additional.filter(Boolean).forEach(remember);
  let out = String(str);
  for (const s of [...secrets].sort((a,b)=>b.length-a.length)) {
    for (const repr of [s,JSON.stringify(s).slice(1,-1),encodeURIComponent(s)]) out = out.split(repr).join('<redacted>');
  }
  return out.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'<redacted>')
    .replace(/((?:"?(?:access_token|refreshToken|token|cookie|set-cookie|authorization|password|captcha)"?)\s*[:=]\s*)("(?:[^"\\]|\\.)*"|[^\r\n,;}]+)/gi,'$1"<redacted>"');
}
function installRedaction() {
  for (const name of ['log','warn','error']) {
    const original = console[name].bind(console);
    console[name] = (...args) => original(...args.map(x=>scrub(typeof x === 'object' ? JSON.stringify(x) : x)));
  }
}
module.exports = {encrypt,decrypt,expiredAt,isExpired,scrub,remember,installRedaction,TTL};
