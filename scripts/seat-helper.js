#!/usr/bin/env node
/**
 * seat-helper.js —— 清华大学图书馆座位管理系统（seat.lib.tsinghua.edu.cn）辅助脚本
 *
 * 数据命令（零 playwright 依赖，用 Node 内置 fetch，纯 HTTP）：
 *   areas                         列 6 个馆舍（含实时「今日剩余/总量」）
 *   tree   [--lib <馆舍id>] [--date]  一次遍历全部馆舍：馆舍→楼层→阅览区+可约时段（供直达选座）
 *   floors  --lib <馆舍id>         列某馆舍的可预约楼层
 *   days    --area <区域id>        列某区域可预约日期（当天/次日）
 *   sections --floor <楼层id> [--date YYYY-MM-DD]   列某楼层的阅览区 + 可约时段(segment)
 *   slots   --floor <楼层id> [--date YYYY-MM-DD] [--section <阅览区id>]  汇总空闲座位数（--json 含座位明细）
 *   status                        检查登录态（退出码 0=已登录 / 2=未登录）
 *
 * 浏览器命令（需要 playwright）：
 *   setup                         首次准备（建 package.json → npm install（固定 1.62.1）→ 按需装浏览器）
 *   login                         登录（SSO，弹出可见浏览器；已登录则复用）
 *   open   --lib <id>              打开「选楼层」页
 *   open   --floor <id> [--date]   打开「选阅览区/日期」页
 *   open   --section <阅览区id> [--date]  直接打开「选择座位」页（自动解析楼层+时段，推荐；6:00–23:00 外会拒绝）
 *   orders                        打开「我的预约」页（网页版）
 *   bookings                      列出我的预约（纯 HTTP，自动解析预约列表，含取消用 id）
 *
 * 预约/取消（真实动作，默认只预演，须显式 --yes 才真正提交；系统仅每日 6:00–23:00 开放，时段外会被拒绝）：
 *   reserve --seat <座位id> --segment <时段id> [--yes]     调试兜底，正常流程不调用
 *   cancel  [--id <预约id>] [--yes]    取消；不指定 --id 时自动取消第一条
 *
 * 退出码：0=成功  1=失败  2=未登录/登录过期
 * 数据命令支持 --json，输出单行机器可读 JSON。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cryptoLib = require('./lib/crypto'); // 会话文件加密（最小改动，防文件被拷走；storage-state/browser-profile 暂不加密）

const BASE = 'https://seat.lib.tsinghua.edu.cn';
const HOME_DIR = path.join(os.homedir(), '.thu-lib-seat');
const SESSION_FILE = path.join(HOME_DIR, 'session.json');
const PROFILE_DIR = path.join(HOME_DIR, 'browser-profile');
const STORAGE_FILE = path.join(HOME_DIR, 'storage-state.json');

// 馆舍静态表（运行时空闲用 areas 拉取）
const LIBRARIES = [
  { id: 35, name: '北馆(李文正馆)', enname: 'Main Library North Section' },
  { id: 64, name: '西馆(逸夫馆)', enname: 'Main Library West Section' },
  { id: 89, name: '文科图书馆', enname: 'Humanities and Social Sciences Library' },
  { id: 6,  name: '法律图书馆', enname: 'Law Library' },
  { id: 19, name: '美术图书馆', enname: 'Arts Library' },
  { id: 29, name: '金融图书馆', enname: 'Finance Library' },
];

const SEAT_STATUS = {
  1: '空闲', 2: '已预约', 3: '锁定', 4: '维护', 5: '清扫',
  6: '使用中', 7: '临时离开', 8: '使用到时提醒', 9: '使用到时',
};

// 预约成功后的精简提醒（签到时限 + 取消限额）
const BOOK_REMIND = '预约成功后 30 分钟内刷门禁签到，否则记违规；取消预约每日限 1 次';

// 馆舍简介（体现特色功能，与 references/lib-seat-seats.md 二 对齐，来源为各馆官网）
const LIB_INTRO = {
  35: '总馆北馆（李文正馆）：15000㎡、藏书 60 余万册、900 余坐席，一至五层开架；G 层古籍阅览室 + 邺架轩书店',
  64: '总馆西馆（逸夫馆）：理工/科技/医药/建筑/计算机专业图书主藏，另有现刊报纸阅览区',
  89: '人文社科图书馆（文图）：一层信息空间（50 余台电脑、扩展屏、文印扫描）；另设研读间/研讨间 50 间（走 IC 空间系统）',
  6: '胡宝星法律图书馆（法学院内）：法律文献；中文/西文/日文图书分区，静音舱、单人研读间、坡道阅览区',
  19: '美术图书馆：2026-08-04 起因施工改造闭馆暂停开放（故无座位）',
  29: '金融图书馆（五道口金融学院内）：1200㎡、约 100 坐席、11 万藏书；开架区 + 地下书库，经济金融类为主',
};

// 楼层设施简介（体现各楼层功能分区，与 references/lib-seat-seats.md 二 对齐；未列出的楼层以接口返回的阅览区为准）
const FLOOR_FACILITIES = {
  36: '总服务台、自助借还/文印、图书杀菌等服务区',
  37: '开架图书阅览区：A/B/C/D/E 区 + 连廊（普通自习座）',
  38: '开架图书阅览区：A/B/C/D 区 + 连廊（普通自习座）',
  39: '开架图书阅览区：A/B/C/D 区（普通自习座）',
  40: '开架图书阅览区：A/B/C 区（普通自习座）',
  103: '古籍阅览室（北G07）、邺架轩书店（馆外下沉广场进入）',
  112: '科技图书借阅区（西119/125/129/131，书架间自习座）',
  113: '医药卫生(西206)、科技(西216/222/224)、建筑(西225)、计算机(西227/231/233)、A 区（书架间自习座）',
  114: '科技图书借阅区（西311/313/320/322）、A 区（书架间自习座）',
  90: '信息空间：学习创作区电脑座(50 余台/2 台 iMac)、吧桌区高桌椅、南侧扩展屏座(投屏)、自助文印',
  91: 'A 区扩展屏座、C 区普通座',
  92: 'A/B/C 区（普通自习座）',
  93: 'C 区（普通自习座）',
  7: '服务台、自助借还/选座/文印、新书现刊、东侧坡道阅览座',
  8: '中文图书区 A-D913、计算法学/教学参考书专架、坡道阅览座、休闲区、静音舱',
  9: '中文图书区 D924-G、西文图书区、单人研读间、坡道阅览座、静音舱',
  10: '日文图书区、法学学位论文、《明清档案》、静音舱',
  20: 'C/E/N/S/W 阅览区（闭馆暂停开放）',
  21: 'C/E 阅览区（闭馆暂停开放）',
  30: '开架借阅区：图书(经济金融)、五道口硕博论文、期刊报纸、国际金融机构资料(IMF/ADB/WB)、校友专架、自助借书、检索机（书架间自习座）',
};

// ---------------- 工具函数 ----------------

function nowBeijing() {
  // 北京时间（UTC+8），避免本地时区导致的“今天”偏差
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function nowBeijingTimeHM() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}

// 预约系统仅在每日 6:00–23:00 开放（含 6:00，不含 23:00）
function isReservationOpen() {
  const hm = nowBeijingTimeHM();
  return hm >= '06:00' && hm < '23:00';
}

// 预约范围仅「当日/次日」；判断某日期（YYYY-MM-DD）是否可约
function isReservableDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return false;
  const [y, m, d] = date.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d);
  const bj = new Date(Date.now() + 8 * 3600 * 1000);
  const today = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate());
  const diff = Math.round((target - today) / 86400000);
  return diff === 0 || diff === 1;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadSession() {
  try {
    const s = JSON.parse(cryptoLib.decrypt(fs.readFileSync(SESSION_FILE, 'utf8')));
    if (s && cryptoLib.isExpired(s.updatedAt)) { try { fs.unlinkSync(SESSION_FILE); } catch {} return null; }
    return s;
  } catch {
    return null;
  }
}

function saveSession(s) {
  ensureDir(HOME_DIR);
  fs.writeFileSync(SESSION_FILE, cryptoLib.encrypt(JSON.stringify({ ...s, updatedAt: new Date().toISOString() }, null, 2)));
}

// 组装完整 cookie 串：新格式 session.cookie 已含 access_token=；旧格式只有 PHPSESSID，则合并 storage-state.json 补齐
function fullCookie(session) {
  const c = (session && session.cookie) || '';
  if (c && c.includes('access_token=')) return c;
  const parts = [];
  if (c) parts.push(`PHPSESSID=${c}`);
  try {
    const st = JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf8'));
    for (const k of (st.cookies || [])) parts.push(`${k.name}=${k.value}`);
  } catch { /* 无 storage-state 则忽略 */ }
  return parts.join('; ');
}

// 从 storage-state.json / session.json 取出结构化 cookie，用于注入到浏览器上下文（修复 open/orders 打开后未登录）
function cookiePairsFromStorage() {
  const pairs = [];
  // 1) 优先 storage-state.json（login 时由 context.storageState 保存，含 domain/path/expires）
  try {
    const st = JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf8'));
    for (const c of (st.cookies || [])) {
      pairs.push({
        name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
        expires: c.expires, httpOnly: !!c.httpOnly, secure: !!c.secure, sameSite: c.sameSite || 'Lax',
      });
    }
  } catch { /* 忽略 */ }
  if (pairs.length) return pairs;
  // 2) 兜底：解析 session.json 的完整 cookie 串，绑定到本站域
  const s = loadSession();
  const cstr = (s && s.cookie) || '';
  if (!cstr) return [];
  for (const part of cstr.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    pairs.push({
      name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim(),
      domain: '.tsinghua.edu.cn', path: '/', secure: true, httpOnly: false, sameSite: 'Lax',
    });
  }
  return pairs;
}

async function restoreContextCookies(context) {
  const cookies = cookiePairsFromStorage();
  if (cookies.length) {
    try { await context.addCookies(cookies); } catch { /* 注入失败则忽略，仍按未登录处理 */ }
  }
}

function out(obj, json) {
  // 输出脱敏：token/cookie 替换为 <redacted>，避免泄漏到 stdout
  const scr = (s) => { const r = loadSession(); return cryptoLib.scrub(s, [r && r.access_token, r && r.cookie]); };
  if (json) console.log(scr(JSON.stringify(obj)));
  else console.log(scr(obj));
}

function err(msg, code = 1) {
  const r = loadSession();
  console.error(cryptoLib.scrub(msg, [r && r.access_token, r && r.cookie]));
  process.exit(code);
}

async function httpGet(url, cookie) {
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) seat-helper' };
  if (cookie) headers['Cookie'] = cookie; // 完整 cookie 串（PHPSESSID/access_token/userid 缺一不可）
  const resp = await fetch(url, { headers, redirect: 'follow' });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON（HTML 页） */ }
  return { status: resp.status, raw: text, json };
}

async function httpPost(url, form, cookie) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) body.append(k, String(v));
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) seat-helper',
  };
  if (cookie) headers['Cookie'] = cookie; // 完整 cookie 串
  const resp = await fetch(url, { method: 'POST', headers, body: body.toString(), redirect: 'follow' });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: resp.status, raw: text, json };
}

// 从页面 HTML 提取 window.ska 的 access_token / userid / username
function parseSka(html) {
  const pick = (key) => {
    const re = new RegExp("'" + key + "':\\s*\"([^\"]*)\"");
    const m = re.exec(html || '');
    return m ? m[1] : '';
  };
  return { access_token: pick('access_token'), userid: pick('userid'), username: pick('username') };
}

// ---------------- 数据命令 ----------------

async function cmdAreas(json) {
  const list = [];
  for (const lib of LIBRARIES) {
    let total = 0, used = 0, floors = [];
    try {
      const r = await httpGet(`${BASE}/api.php/v3areas/${lib.id}`);
      const child = (r.json && r.json.data && r.json.data.list && r.json.data.list.childArea) || [];
      floors = child.filter((c) => c.type === 0 && c.isValid === 1).map((c) => ({
        id: c.id, name: c.name, total: c.TotalCount, available: c.TotalCount - c.UnavailableSpace,
      }));
      for (const f of floors) { total += f.total; used += f.total - f.available; }
    } catch { /* 网络失败则保留静态名 */ }
    list.push({ id: lib.id, name: lib.name, enname: lib.enname, intro: LIB_INTRO[lib.id] || '', total, used, available: total - used, floors });
  }
  if (json) { out({ ok: true, libraries: list }, true); return; }
  const lines = ['各馆舍座位（今日剩余 / 总量）：'];
  for (const l of list) {
    lines.push(`· ${l.name}（id=${l.id}）—— ${l.intro}；剩余 ${l.available} / ${l.total}`);
  }
  out(lines.join('\n'));
}

async function cmdFloors(libId, json) {
  if (!libId) err('缺少 --lib <馆舍id>');
  const r = await httpGet(`${BASE}/api.php/v3areas/${libId}`);
  if (!r.json || r.json.status !== 1) err('获取楼层失败：' + (r.json && r.json.msg));
  const lib = (r.json.data.list.areaInfo || {});
  const child = (r.json.data.list.childArea || []).filter((c) => c.type === 0);
  const rows = child.map((c) => ({
    id: c.id, name: c.name, enname: c.enname, valid: c.isValid === 1,
    facilities: FLOOR_FACILITIES[c.id] || '',
    total: c.TotalCount, available: c.TotalCount - c.UnavailableSpace,
  }));
  if (json) { out({ ok: true, library: { id: lib.id, name: lib.name, intro: LIB_INTRO[libId] || '' }, floors: rows }, true); return; }
  const lines = [`${lib.name}（id=${libId}）的楼层${LIB_INTRO[libId] ? '（' + LIB_INTRO[libId] + '）' : ''}：`];
  for (const f of rows) {
    const fac = f.facilities ? `【${f.facilities}】` : '';
    lines.push(`· ${f.name}（id=${f.id}）${fac}${f.valid ? '' : ' [不可在线预约]'} —— 剩余 ${f.available} / ${f.total}`);
  }
  out(lines.join('\n'));
}

async function cmdDays(areaId, json) {
  if (!areaId) err('缺少 --area <区域id>');
  const r = await httpGet(`${BASE}/api.php/v3areadays/${areaId}`);
  if (!r.json || r.json.status !== 1) err('获取可约日期失败：' + (r.json && r.json.msg));
  const days = (r.json.data.list || []).map((d) => (d.day && d.day.date ? d.day.date.slice(0, 10) : null)).filter(Boolean);
  if (json) { out({ ok: true, area: areaId, days }, true); return; }
  out(`区域 ${areaId} 可预约日期：${days.join('、') || '（无）'}`);
}

async function cmdSections(floorId, date, json) {
  if (!floorId) err('缺少 --floor <楼层id>');
  const day = date || nowBeijing();
  const r = await httpGet(`${BASE}/api.php/v3areas/${floorId}/date/${day}`);
  if (!r.json || r.json.status !== 1) err('获取阅览区失败：' + (r.json && r.json.msg));
  const info = r.json.data.list;
  const child = (info.childArea || []).filter((c) => c.type === 1);
  const rows = child.map((c) => {
    const t = c.area_times && c.area_times.data && c.area_times.data.list;
    const seg = (t && t[0]) || null;
    return {
      id: c.id, name: c.name, valid: c.isValid === 1,
      total: c.TotalCount, available: c.TotalCount - c.UnavailableSpace,
      segment: seg ? seg.id : null, startTime: seg ? seg.startTime : null, endTime: seg ? seg.endTime : null,
    };
  });
  if (json) {
    out({ ok: true, floor: { id: info.areaInfo.id, name: info.areaInfo.name }, date: day, sections: rows }, true);
    return;
  }
  const lines = [`${info.areaInfo.name}（id=${floorId}）${day} 的阅览区：`];
  for (const s of rows) {
    const seg = s.segment ? `时段 ${s.startTime}-${s.endTime}（segment=${s.segment}）` : '无可约时段';
    lines.push(`· ${s.name}（id=${s.id}）${s.valid ? '' : ' [不可在线预约]'} —— 剩余 ${s.available}，总量 ${s.total}；${seg}`);
  }
  out(lines.join('\n'));
}

// 一次遍历全部馆舍：馆舍 → 楼层 → 阅览区（含可约时段 segment），供「直接跳到选座页」
async function cmdTree(libId, date, json) {
  const day = date || nowBeijing();
  const libs = libId ? LIBRARIES.filter((l) => String(l.id) === String(libId)) : LIBRARIES;
  if (libs.length === 0) err('未找到馆舍：' + libId);
  const result = [];
  for (const lib of libs) {
    const libNode = { id: lib.id, name: lib.name, intro: LIB_INTRO[lib.id] || '', floors: [] };
    let floors = [];
    try {
      const r = await httpGet(`${BASE}/api.php/v3areas/${lib.id}`);
      floors = (r.json && r.json.data && r.json.data.list && r.json.data.list.childArea || [])
        .filter((c) => c.type === 0 && c.isValid === 1);
    } catch { /* 跳过网络失败的馆舍 */ }
    for (const f of floors) {
      const floorNode = { id: f.id, name: f.name, facilities: FLOOR_FACILITIES[f.id] || '', total: f.TotalCount, available: f.TotalCount - f.UnavailableSpace, sections: [] };
      try {
        const fr = await httpGet(`${BASE}/api.php/v3areas/${f.id}/date/${day}`);
        const areas = (fr.json && fr.json.data && fr.json.data.list && fr.json.data.list.childArea || [])
          .filter((c) => c.type === 1);
        for (const a of areas) {
          const t = a.area_times && a.area_times.data && a.area_times.data.list;
          const seg = (t && t[0]) || null;
          floorNode.sections.push({
            id: a.id, name: a.name, valid: a.isValid === 1,
            total: a.TotalCount, available: a.TotalCount - a.UnavailableSpace,
            segment: seg ? seg.id : null, startTime: seg ? seg.startTime : null, endTime: seg ? seg.endTime : null,
          });
        }
      } catch { /* 跳过该楼层 */ }
      libNode.floors.push(floorNode);
      await new Promise((r) => setTimeout(r, 80)); // 轻微限流
    }
    result.push(libNode);
  }

  if (json) { out({ ok: true, date: day, libraries: result }, true); return; }
  const lines = [];
  for (const lib of result) {
    const libTotal = lib.floors.reduce((s, f) => s + f.total, 0);
    const libAvail = lib.floors.reduce((s, f) => s + f.available, 0);
    lines.push(`【${lib.name}（id=${lib.id}）】${lib.intro}；剩余 ${libAvail} / ${libTotal}`);
    for (const f of lib.floors) {
      const fac = f.facilities ? `（${f.facilities}）` : '';
      lines.push(`  ${f.name}（id=${f.id}）${fac}：剩余 ${f.available} / ${f.total}`);
      for (const s of f.sections) {
        if (s.valid && s.segment) {
          lines.push(`    · ${s.name}（id=${s.id}）：空闲 ${s.available}/${s.total}，${s.startTime}-${s.endTime} → open --section ${s.id} --date ${day}`);
        } else if (!s.valid) {
          lines.push(`    · ${s.name}（id=${s.id}）：不可在线预约`);
        } else {
          lines.push(`    · ${s.name}（id=${s.id}）：当日无可约时段`);
        }
      }
    }
  }
  out(lines.join('\n'));
}

async function cmdSlots(floorId, date, sectionId, json) {
  if (!floorId) err('缺少 --floor <楼层id>');
  const day = date || nowBeijing();
  const r = await httpGet(`${BASE}/api.php/v3areas/${floorId}/date/${day}`);
  if (!r.json || r.json.status !== 1) err('获取楼层信息失败：' + (r.json && r.json.msg));
  const info = r.json.data.list;
  // 只保留可在线预约的阅览区（isValid===1）；E阅览区/连廊等 isValid=0 的需现场选位
  let areas = (info.childArea || []).filter((c) => c.type === 1 && c.isValid === 1);
  if (sectionId) areas = areas.filter((c) => String(c.id) === String(sectionId));
  if (areas.length === 0) err('该楼层没有可在线预约的阅览区（或 --section 指定的阅览区不存在/不可在线预约）');

  const seats = [];
  for (const a of areas) {
    const t = a.area_times && a.area_times.data && a.area_times.data.list;
    const seg = (t && t[0]) || null;
    if (!seg) continue; // 该阅览区无可约时段
    const q = new URLSearchParams({
      area: a.id, segment: seg.id, day, startTime: seg.startTime || '08:00', endTime: seg.endTime || '22:00',
    });
    const sr = await httpGet(`${BASE}/api.php/spaces_old?${q.toString()}`);
    const list = (sr.json && sr.json.data && sr.json.data.list) || [];
    for (const s of list) {
      seats.push({
        areaId: a.id, areaName: a.name,
        seatId: s.id, no: s.no, status: s.status,
        statusName: s.status_name || SEAT_STATUS[s.status] || '未知',
        available: s.status === 1,
      });
    }
  }
  const available = seats.filter((s) => s.available);
  if (json) {
    out({ ok: true, floor: { id: info.areaInfo.id, name: info.areaInfo.name }, date: day, total: seats.length, available: available.length, seats }, true);
    return;
  }
  // 人类可读：只汇总空闲数，不逐条罗列座位号（选座在浏览器平面图里点选更直观）
  const byArea = {};
  for (const s of seats) {
    byArea[s.areaName] = byArea[s.areaName] || { total: 0, available: 0 };
    byArea[s.areaName].total++;
    if (s.available) byArea[s.areaName].available++;
  }
  const lines = [`${info.areaInfo.name}（id=${floorId}）${day}：共 ${seats.length} 座，空闲 ${available.length} 座`];
  for (const [name, v] of Object.entries(byArea)) {
    lines.push(`· ${name}：空闲 ${v.available} / ${v.total}`);
  }
  if (isReservationOpen()) {
    lines.push(`（选定阅览区后，用 \`open --section <阅览区id> --date ${day}\` 打开选座页点选座位）`);
  } else {
    lines.push(`（当前北京时间 ${nowBeijingTimeHM()} 不在预约开放时段 6:00–23:00，暂不能选座/预约；可先查看空座）`);
  }
  out(lines.join('\n'));
}

async function cmdStatus(json) {
  const s = loadSession();
  if (!s || !s.access_token) {
    if (json) out({ ok: false, loggedIn: false, reason: '未登录' }, true);
    else out('未登录');
    process.exit(2);
  }
  // 用完整 cookie 拉取首页，检查服务端是否仍在 HTML 注入 access_token（只带 PHPSESSID 会误判过期）
  let loggedIn = true;
  try {
    const r = await httpGet(`${BASE}/home/web/f_second`, fullCookie(s));
    const ska = parseSka(r.raw);
    loggedIn = !!ska.access_token;
  } catch { /* 网络失败时信任本地会话 */ }
  if (json) out({ ok: true, loggedIn, username: s.username, userid: s.userid, updatedAt: s.updatedAt }, true);
  else out(loggedIn ? `已登录：${s.username}（userid=${s.userid}）` : '登录已过期，请重新 login');
  process.exit(loggedIn ? 0 : 2);
}

// ---------------- 浏览器命令 ----------------

function launchPersistent() {
  const { chromium } = require('playwright');
  const base = { headless: false, viewport: { width: 1400, height: 950 }, locale: 'zh-CN' };
  return (async () => {
    // 优先系统 Edge → Chrome；两者都找不到才回退 Chromium
    for (const channel of ['msedge', 'chrome']) {
      try {
        return await chromium.launchPersistentContext(PROFILE_DIR, { ...base, channel });
      } catch (e) {
        // 浏览器存在但被沙箱拦截（spawn EPERM）→ 立即提示升级权限，不继续回退、不装 Chromium
        if (/EPERM|permission|not permitted/i.test(String((e && e.message) || e))) {
          err('启动系统浏览器被沙箱拦截（spawn EPERM）：系统 Edge/Chrome 存在但无法启动。请下次运行前先以更宽权限（danger-full-access）提权再运行本命令；不要安装 Chromium。');
        }
        // 其它原因（如未安装该浏览器）→ 尝试下一个
      }
    }
    try {
      return await chromium.launchPersistentContext(PROFILE_DIR, base);
    } catch (e) {
      if (/EPERM|permission|not permitted/i.test(String((e && e.message) || e))) {
        err('启动浏览器被沙箱拦截（spawn EPERM）。请下次运行前先以更宽权限（danger-full-access）提权再运行本命令；不要安装 Chromium。');
      }
      err('启动浏览器失败：' + ((e && e.message) || String(e)) + '（优先用系统 Edge/Chrome；若为沙箱拦截 spawn EPERM，请下次运行前先以 danger-full-access 提权再运行，不要安装 Chromium）');
    }
  })();
}

async function extractSessionFromPage(page) {
  try {
    const ska = await page.evaluate(() => ({
      access_token: (window.ska && window.ska.access_token) || '',
      userid: (window.ska && window.ska.userid) || '',
      username: (window.ska && window.ska.username) || '',
    }));
    return ska;
  } catch { return { access_token: '', userid: '', username: '' }; }
}

async function cmdLogin() {
  ensureDir(HOME_DIR);
  const context = await launchPersistent();
  await restoreContextCookies(context); // 恢复已保存的登录 Cookie
  const page = context.pages()[0] || await context.newPage();

  // 1) 先看是否已有登录会话（复用）
  await page.goto(`${BASE}/home/web/f_second`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);
  let ska = await extractSessionFromPage(page);
  if (ska.access_token) {
    const cookies = await context.cookies();
    const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    saveSession({ ...ska, cookie: cookieStr });
    await context.storageState({ path: STORAGE_FILE }).catch(() => {});
    console.log(`已复用现有登录会话：${ska.username}（userid=${ska.userid}）`);
    await context.close();
    return;
  }

  // 2) 未登录 → SSO（清华统一身份认证）
  const callback = `${BASE}/home/web/f_second`;
  await page.goto(`${BASE}/cas/index.php?callback=${encodeURIComponent(callback)}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  console.log('请在浏览器中完成「清华大学统一身份认证」登录（学工号 + 密码）…');
  const deadline = Date.now() + 180 * 1000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    ska = await extractSessionFromPage(page);
    if (ska.access_token) {
      const cookies = await context.cookies();
      const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      saveSession({ ...ska, cookie: cookieStr });
      await context.storageState({ path: STORAGE_FILE }).catch(() => {});
      console.log(`登录成功：${ska.username}（userid=${ska.userid}）`);
      await context.close();
      return;
    }
  }
  await context.close();
  err('登录超时（180 秒内未检测到登录态），请重试 login');
}

async function cmdOpen(opt) {
  const day = opt.date || nowBeijing();
  if (opt.date && !isReservableDate(day)) {
    err(`只能预约当日或次日（今天/明天），${day} 超出可预约范围；请重新选择日期`);
  }
  let url;
  if (opt.lib) {
    // 选楼层页
    url = `${BASE}/home/web/seat/area/${opt.lib}`;
  } else if (opt.floor && !opt.section) {
    // 选阅览区/日期页
    url = `${BASE}/home/web/seat2/area/${opt.floor}/day/${day}`;
  } else if (opt.section) {
    if (!isReservationOpen()) err(`预约系统仅在每日 6:00–23:00 开放，当前北京时间 ${nowBeijingTimeHM()}，暂不能进入选座预约；请在开放时段内再试`);
    // 直接跳到「选择座位」页（/web/seat3）：自动解析楼层与可约时段
    const sr = await httpGet(`${BASE}/api.php/v3areas/${opt.section}`);
    if (!sr.json || sr.json.status !== 1) err('解析阅览区失败：' + (sr.json && sr.json.msg));
    const floorId = sr.json.data.list.areaInfo.parentId;
    const fr = await httpGet(`${BASE}/api.php/v3areas/${floorId}/date/${day}`);
    if (!fr.json || fr.json.status !== 1) err('解析楼层时段失败：' + (fr.json && fr.json.msg));
    const area = (fr.json.data.list.childArea || []).find((c) => String(c.id) === String(opt.section));
    const t = area && area.area_times && area.area_times.data && area.area_times.data.list;
    const seg = (t && t[0]) || null;
    if (!area || area.isValid !== 1) err('该阅览区当前不可在线预约（可能现场选位或闭馆）');
    if (!seg) err('该阅览区当日无可约时段');
    url = `${BASE}/web/seat3?area=${opt.section}&segment=${seg.id}&day=${day}&startTime=${seg.startTime || '08:00'}&endTime=${seg.endTime || '22:00'}`;
  } else {
    err('open 需要 --lib <馆舍id>，或 --floor <楼层id>，或 --section <阅览区id> [--date YYYY-MM-DD]');
  }
  const context = await launchPersistent();
  await restoreContextCookies(context); // 恢复已保存的登录 Cookie
  const page = context.pages()[0] || await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const tip = opt.section ? `\n提醒：${BOOK_REMIND}` : '';
  console.log(`已打开：${url}（请在浏览器中选座；本窗口关闭后进程退出）${tip}`);
  // 保持打开，直到用户关闭浏览器
  await context.waitForEvent('close').catch(() => {});
  await context.close();
}

async function cmdOrders() {
  const context = await launchPersistent();
  await restoreContextCookies(context); // 恢复已保存的登录 Cookie
  const page = context.pages()[0] || await context.newPage();
  await page.goto(`${BASE}/user/index/book`, { waitUntil: 'domcontentloaded' });
  console.log('已打开「我的预约」页（未登录会先跳转 SSO，登录后请重新访问）');
  await context.waitForEvent('close').catch(() => {});
  await context.close();
}

// ---------------- 预约/取消 ----------------

function requireLogin() {
  const s = loadSession();
  if (!s || !s.access_token) err('未登录或登录过期，请先运行 login', 2);
  return s;
}

async function cmdReserve(opt) {
  if (!isReservationOpen()) err(`预约系统仅在每日 6:00–23:00 开放，当前北京时间 ${nowBeijingTimeHM()}，已拒绝本次预约；请在开放时段内再试（查询空座不受影响）`);
  if (!opt.seat || !opt.segment) err('reserve 需要 --seat <座位id> 和 --segment <时段id>');
  const s = requireLogin();
  const body = { access_token: s.access_token, userid: s.userid, segment: opt.segment, type: 1, operateChannel: 2 };
  if (!opt.yes) {
    out(`[预演] 将提交预约：座位id=${opt.seat}，时段id=${opt.segment}（type=1, operateChannel=2）\n确认后加 --yes 真正提交；预约成功后 30 分钟内需签到。`);
    return;
  }
  const r = await httpPost(`${BASE}/api.php/spaces/${opt.seat}/book`, body, fullCookie(s));
  if (r.json && r.json.status === 1) {
    const d = r.json.data && r.json.data.list;
    const no = d && d.spaceInfo && d.spaceInfo.no;
    out(`预约成功：座位 ${no || opt.seat}，${d && d.starttime} ~ ${d && d.endingtime}\n提醒：${BOOK_REMIND}`);
  } else {
    err('预约失败：' + (r.json ? (r.json.msg || JSON.stringify(r.json)) : r.raw.slice(0, 300)));
  }
}

// 解析「我的预约」页（/user/index/book）的 <tr id="list_<id>"> 行，提取取消用的数字 id
function parseBookings(html) {
  const clean = (html || '').replace(/<!--[\s\S]*?-->/g, '');
  const out = [];
  const trRe = /<tr[^>]*id="list_(\d+)"[\s\S]*?<\/tr>/g;
  let m;
  while ((m = trRe.exec(clean))) {
    const id = m[1];                      // 取消用的预约 id（如 7223795）
    const cells = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let c;
    while ((c = tdRe.exec(m[0]))) {
      cells.push(c[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
    }
    out.push({
      id,                                  // 取消 id（如 7223795）
      no: cells[0] || '',                  // 预约号（如 202609012639）
      space: cells[1] || '',               // 预约空间
      start: cells[2] || '',               // 开始时间
      end: cells[3] || '',                 // 结束时间
      status: cells[4] || '',              // 当前状态
    });
  }
  return out;
}

// 列出我的预约（纯 HTTP，免浏览器）：自动解析预约列表，含取消用 id
async function cmdBookings(json) {
  const s = requireLogin();
  const r = await httpGet(`${BASE}/user/index/book`, fullCookie(s));
  const bookings = parseBookings(r.raw);
  if (bookings.length === 0) {
    if (json) { out({ ok: true, bookings: [] }, true); return; }
    out('暂无预约记录（或会话过期，请重新 login）。');
    return;
  }
  if (json) { out({ ok: true, bookings }, true); return; }
  const lines = [`我的预约（共 ${bookings.length} 条）：`];
  for (const b of bookings) {
    lines.push(`· id=${b.id}｜${b.space}｜${b.start} ~ ${b.end}｜${b.status}（取消：cancel --id ${b.id} --yes）`);
  }
  out(lines.join('\n'));
}

// 取消核心 API：POST /api.php/profile/books/<id>，body 含 operateChannel:2
async function doCancelAPI(s, id) {
  const body = { _method: 'delete', id, userid: s.userid, access_token: s.access_token, operateChannel: 2 };
  const r = await httpPost(`${BASE}/api.php/profile/books/${id}`, body, fullCookie(s));
  if (r.json && (r.json.status === 1 || (r.json.msg && !/失败|错误|异常/.test(r.json.msg)))) {
    out(`取消成功：${r.json.msg || '已取消预约'}`);
  } else {
    err('取消失败：' + (r.json ? (r.json.msg || JSON.stringify(r.json)) : r.raw.slice(0, 300)));
  }
}

async function cmdCancel(opt) {
  const s = requireLogin();

  // 未指定 --id：自动获取预约列表，取消第一条（须 --yes）
  if (!opt.id) {
    const r = await httpGet(`${BASE}/user/index/book`, fullCookie(s));
    const bookings = parseBookings(r.raw);
    if (bookings.length === 0) { out('暂无预约记录（或会话过期，请重新 login）。'); return; }
    const target = bookings[0];
    if (!opt.yes) {
      out(`检测到 ${bookings.length} 条预约，将取消第一条：id=${target.id}（${target.space}，${target.start}~${target.end}）。\n确认后加 --yes 真正取消。全部预约：`);
      for (const b of bookings) out(`  id=${b.id}｜${b.space}｜${b.start}~${b.end}｜${b.status}`);
      return;
    }
    return await doCancelAPI(s, target.id);
  }

  // 指定 --id：直接 API 取消
  if (!opt.yes) { out(`[预演] 将取消预约 id=${opt.id}。确认后加 --yes 真正提交。`); return; }
  return await doCancelAPI(s, opt.id);
}

// ---------------- setup ----------------

async function cmdSetup(opt) {
  const skillRoot = path.resolve(__dirname, '..');
  const pkgPath = path.join(skillRoot, 'package.json');
  const pkg = {
    name: 'thu-lib-seat-reserve',
    version: '1.1.0',
    private: true,
    allowScripts: { playwright: true },
    dependencies: { playwright: '1.62.1' },
  };
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`已写入 ${pkgPath}（allowScripts 为对象格式）`);

  const { execSync } = require('child_process');
  const env = { ...process.env };
  delete env.npm_config_allow_scripts; // 避免 npm 11 抛 EALLOWSCRIPTS
  // 将 npm 缓存重定向到技能目录内，避免受限沙箱下写全局缓存目录报 EPERM
  env.npm_config_cache = path.join(skillRoot, '.npm-cache');
  const run = (cmd) => {
    console.log('$ ' + cmd);
    execSync(cmd, { stdio: 'inherit', cwd: skillRoot, env });
  };
  run('npm install');
  if (opt['with-chromium']) {
    // 默认不装 Chromium（优先用系统 Edge/Chrome）；仅当显式 --with-chromium 且环境允许时才装
    run('npx playwright install chromium');
  }
  console.log('setup 完成。接下来运行：node scripts/seat-helper.js login（浏览器命令优先用系统 Edge/Chrome，无需 Chromium）');
}

// ---------------- 参数解析与分发 ----------------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { args.json = true; continue; }
    if (a === '--yes') { args.yes = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++; }
      else args[key] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

(async function main() {
  const raw = process.argv.slice(2);
  const a = parseArgs(raw);
  const cmd = a._[0];

  try {
    switch (cmd) {
      case 'areas': return await cmdAreas(a.json);
      case 'floors': return await cmdFloors(a.lib, a.json);
      case 'tree': return await cmdTree(a.lib, a.date, a.json);
      case 'days': return await cmdDays(a.area, a.json);
      case 'sections': return await cmdSections(a.floor, a.date, a.json);
      case 'slots': return await cmdSlots(a.floor, a.date, a.section, a.json);
      case 'status': return await cmdStatus(a.json);
      case 'login': return await cmdLogin();
      case 'open': return await cmdOpen(a);
      case 'orders': return await cmdOrders();
      case 'bookings': return await cmdBookings(a.json);
      case 'reserve': return await cmdReserve(a);
      case 'cancel': return await cmdCancel(a);
      case 'setup': return await cmdSetup(a);
      default:
        err('用法：\n' +
          '  数据：areas | tree [--lib <id>] [--date] | floors --lib <id> | days --area <id> | sections --floor <id> [--date] | slots --floor <id> [--date] [--section <id>] | status | bookings  （均可加 --json）\n' +
          '  浏览器：setup | login | open --lib <id> | open --floor <id> [--date] | open --section <阅览区id> [--date] | orders\n' +
          '  预约/取消：reserve --seat <座位id> --segment <时段id> [--yes]（调试兜底） | cancel [--id <预约id>] [--yes]（不指定 --id 自动取消第一条）');
    }
  } catch (e) {
    err('执行出错：' + (e && e.message ? e.message : String(e)));
  }
})();
