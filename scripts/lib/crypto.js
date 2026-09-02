#!/usr/bin/env node
/**
 * crypto.js —— 本 skill 内共享的「会话文件加密」助手（最小改动）
 *
 * 用途：对落到用户目录（~/.thu-*）的 token/会话/配置文件做 AES-256-GCM 加密，
 * 降低「文件被拷走 / 备份 / 云同步 / 误提交」导致的泄露风险。
 *
 * 说明：
 *  - 密钥由「本机 hostname + 当前用户名」派生（sha256→32字节）。对同机同用户不设防（同身份进程可复算），
 *    但对「把文件拷到另一台机器 / 被备份 / 云同步」有效——跨机/跨用户解不开。
 *  - 只做「静止加密」，不保护使用中的明文（内存/请求头），也不覆盖浏览器 profile（Chromium 拥有）。
 *  - 兼容旧文件：解密失败时原样返回（旧明文仍可用），下次写入即变密文。
 */
'use strict';
const crypto = require('crypto');
const os = require('os');

/** 从机器身份派生固定密钥（32 字节） */
function machineKey() {
  const seed = (os.hostname() || 'thu') + '|' + (os.userInfo().username || '') + '|thu-auto-reserve';
  return crypto.createHash('sha256').update(seed).digest().slice(0, 32);
}

/** 加密字符串 → 返回 { v:1, alg, iv, tag, ct } 的 JSON 字符串 */
function encrypt(plain) {
  const key = machineKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({ v: 1, alg: 'aes-256-gcm', iv: iv.toString('base64'), tag: tag.toString('base64'), ct: ct.toString('base64') });
}

/** 解密；若输入不是自己的密文（旧明文/外部内容）则原样返回 */
function decrypt(blob) {
  if (typeof blob !== 'string') return blob;
  try {
    const o = JSON.parse(blob);
    if (o && o.v === 1 && o.alg === 'aes-256-gcm' && o.iv && o.tag && o.ct) {
      const key = machineKey();
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(o.iv, 'base64'));
      d.setAuthTag(Buffer.from(o.tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(o.ct, 'base64')), d.final()]).toString('utf8');
    }
  } catch { /* 非本模块密文 → 按旧明文处理 */ }
  return blob;
}

/** 到期时间：自最后使用/保存起保留 7 天（约等于后端 jwt 有效期），避免频繁重新登录 */
function expiredAt(ms) {
  return new Date(ms + 7 * 24 * 60 * 60 * 1000);
}
/** 是否已过期（按 updatedAt / 最后使用时间，保留约 7 天后过期） */
function isExpired(updatedAt, now = Date.now()) {
  if (!updatedAt) return false;
  const u = typeof updatedAt === 'number' ? updatedAt : Date.parse(updatedAt);
  if (!isFinite(u)) return false;
  return now > expiredAt(u).getTime();
}

/** 输出脱敏：把已知密钥（token/cookie/jwt）+ 疑似 JWT 替换为 <redacted>，防止 token 泄漏到日志/输出 */
function scrub(str, secrets) {
  if (str == null) return str;
  let out = String(str);
  const set = [...new Set((secrets || []).filter(Boolean).map(String))].sort((a, b) => b.length - a.length);
  for (const s of set) if (s.length >= 8) out = out.split(s).join('<redacted>');
  out = out.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<redacted>');
  return out;
}

module.exports = { encrypt, decrypt, machineKey, expiredAt, isExpired, scrub };
