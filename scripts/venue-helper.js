#!/usr/bin/env node
/**
 * 清华大学体育场馆预约 —— 辅助脚本
 *
 * 用法（在 skill 根目录下执行）：
 *   node scripts/venue-helper.js setup                 # 一键准备环境（建 package.json → 装 playwright → 按需装浏览器）
 *   node scripts/venue-helper.js login                 # 弹出统一身份认证登录页(id.tsinghua.edu.cn/f/login)，登录后自动换场馆 token 并持久化
 *   node scripts/venue-helper.js status                # 检查登录状态
 *   node scripts/venue-helper.js sports                # 列出可预约的运动项目（scene）
 *   node scripts/venue-helper.js sites --scene <名称|uuid>   # 列出某运动下的设备类型/场馆/场地
 *   node scripts/venue-helper.js slots --scene <名称|uuid> [--days N] [--date YYYY-MM-DD]   # 列普通可预约时段 + 抽签场次（同时查；默认从明天起3天，多场景合并、按日期时段聚合）
 *   node scripts/venue-helper.js recommend [--count N] [--scene 名称1,名称2]  # 按热度加权随机推荐几个运动（附场馆信息，默认 5 个）
 *   node scripts/venue-helper.js recommend --need "<需求描述>"       # 按用户需求（身体状况/目标/预算/人数/室内外/强度）打分推荐，附匹配理由
 *   node scripts/venue-helper.js orders [--uuid <resvUuid>]   # 列出我的预约记录（--uuid 只查某一条）
 *   node scripts/venue-helper.js cancel --uuid <resvUuid> [--yes]   # 取消预约（已实测成功；--yes 才真正提交）
 *   node scripts/venue-helper.js reserve --scene <名称|uuid> [--date YYYY-MM-DD] [--time HH:mm]  # 打开预约页并自动选日期/时段，人机验证及后续由用户完成
 *   node scripts/venue-helper.js reserve-api --scene <名称|uuid> --date YYYY-MM-DD --time HH:mm [--yes --captcha <token>]  # 纯 API 预约；提交需滑块验证码 token（前端有 blockPuzzle 人机验证），成功后自动开付款窗口
 *   node scripts/venue-helper.js pay                   # 打开浏览器到预约记录页，让用户完成支付
 *   node scripts/venue-helper.js open [--url <hash路由>]     # 打开场馆网站（有头浏览器）
 *   node scripts/venue-helper.js lottery --scene <名称|uuid>             # 列出该场景的抽签报名场次
 *   node scripts/venue-helper.js lottery dates --scene <名称|uuid> --plan <场次名|uuid>  # 列出某场次可报名日期
 *   node scripts/venue-helper.js lottery signup --scene <名称|uuid> --plan <场次名|uuid> --date YYYY-MM-DD [--yes]  # 抽签报名（加 --yes 才真正提交）
 *   node scripts/venue-helper.js lottery mine          # 查看我的抽签报名记录（含中签状态）
 *   node scripts/venue-helper.js lottery-open --scene <名称|uuid>       # 打开抽签报名页（有头浏览器）
 *
 * 通用选项：
 *   --json      输出机器可读的 JSON（单行），便于 agent 稳定解析
 *
 * 退出码：0=成功；1=失败；2=未登录/登录过期
 *
 * 依赖说明：数据查询命令（status/sports/sites/slots/recommend/orders/lottery 数据操作）用 Node 内置 fetch，零依赖、不装 playwright；
 *           仅 login/reserve/pay/open/lottery-open 需要 playwright（浏览器），按下面 setup 准备一次即可。
 *
 * 环境准备（setup 自动完成，也可手动；仅浏览器命令需要）：
 *   1) 在 skill 根目录建 package.json，且 allowScripts 必须是对象格式 {"playwright": true}
 *      （写成数组 ["playwright"] 会被 npm 解析成 {"0":"playwright"} 这类错键，不生效）
 *   2) 安装前移除环境变量 npm_config_allow_scripts（DSH harness 注入的 allow-scripts 白名单会干扰 npm 11）
 *   3) npm install playwright
 *   4) 浏览器优先用系统已装的 Chrome/Edge（无需下载）；都没有时才 npx playwright install chromium，
 *      并可用 PLAYWRIGHT_DOWNLOAD_HOST / --mirror 指定镜像加速
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const VENUE_URL = 'https://www.sports.tsinghua.edu.cn/venue/';
const API_BASE = 'https://www.sports.tsinghua.edu.cn/venue/site';
const APP_ID = '1497016617475903488';
const AES_KEY = '57325972627c40bd8c77296d39293705'; // getKeys().join("")
const AES_IV = '0000000000000000';
const DEFAULT_MIRROR = 'https://npmmirror.com/mirrors/playwright/';

const PROFILE_DIR = process.env.THU_SPORTS_PROFILE || path.join(os.homedir(), '.thu-sports-venue', 'browser-profile');
const TOKEN_FILE = process.env.THU_SPORTS_TOKEN || path.join(os.homedir(), '.thu-sports-venue', 'token.json');
const STORAGE_STATE_FILE = process.env.THU_SPORTS_STORAGE || path.join(os.homedir(), '.thu-sports-venue', 'storage-state.json');
const CONTEXT_CACHE_FILE = process.env.THU_SPORTS_CTX_CACHE || path.join(os.homedir(), '.thu-sports-venue', 'scene-context.json');
const SKILL_ROOT = path.resolve(__dirname, '..');

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_UNAUTH = 2;

// 限流与并发保护参数
const RATE_LIMIT_ERROR_CODE = 1610001;     // "over limit" 限流错误码
const RATE_LIMIT_RETRY_MAX = 3;            // 遇限流最多重试次数
const RATE_LIMIT_BASE_DELAY_MS = 5000;     // 首次退避 5s，之后指数递增（5/10/20s），缩短单次查询等待
const REQUEST_INTERVAL_MS = 150;           // 遍历查询的请求间固定间隔（recommend 已不遍历，可缩短）

// slots 查询策略
const SLOT_INITIAL_DAYS = 3;   // 默认查未来 3 天（从明天起，跳过响应大且慢的「当天」）
const SLOT_MAX_DAYS = 7;       // --days 上限
const SLOT_MIN_AVAILABLE = 3;  // 可约过少时触发「跨天回退」的阈值
const PROFILE_LOCK_FILE = PROFILE_DIR + '.lock';

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
function randomString(len) {
  const s = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz0123456789';
  let r = '';
  for (let i = 0; i < len; i++) r += s[Math.floor(Math.random() * s.length)];
  return r;
}

/** 生成每个请求都要追加的签名 query 参数 */
function signParams() {
  const timeStamp = String(Date.now());
  const nonce = randomString(32);
  const raw = `appId=${APP_ID}&nonce=${nonce}&timeStamp=${timeStamp}&key=${AES_KEY}`;
  const sign = crypto.createHash('md5').update(raw).digest('hex');
  return { appId: APP_ID, timeStamp, nonce, sign };
}

/** AES-256-CBC 解密（CryptoJS Iso10126 padding，去尾填充） */
function decryptAes(cipherB64) {
  const key = Buffer.from(AES_KEY, 'utf8');
  const iv = Buffer.from(AES_IV, 'utf8');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false); // 手动去填充
  const enc = Buffer.from(cipherB64, 'base64');
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  if (dec.length === 0) return '';
  const pad = dec[dec.length - 1];
  return dec.slice(0, dec.length - pad).toString('utf8');
}

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function readTokenFile() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch { return null; }
}
function writeTokenFile(obj) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(obj, null, 2));
}

/** 读取场景上下文缓存（devKind/building/sceneUseType，按 sceneUuid 键） */
function readContextCache() {
  try { return JSON.parse(fs.readFileSync(CONTEXT_CACHE_FILE, 'utf8')); } catch { return {}; }
}
function writeContextCache(obj) {
  try {
    fs.mkdirSync(path.dirname(CONTEXT_CACHE_FILE), { recursive: true });
    fs.writeFileSync(CONTEXT_CACHE_FILE, JSON.stringify(obj, null, 2));
  } catch { /* 写失败忽略，下次仍走接口 */ }
}

/** 解析命令行参数：--key value 或 --key=value；返回 {args, flags} */
function parseArgs(argv) {
  const args = {};
  const flags = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) { args[a.slice(2, eq)] = a.slice(eq + 1); }
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { args[a.slice(2)] = argv[++i]; }
      else { flags.add(a.slice(2)); args[a.slice(2)] = true; }
    } else if (a.startsWith('-')) {
      flags.add(a.slice(1));
    }
  }
  return { args, flags };
}

/** 统一输出：--json 时输出单行 JSON，否则输出人类可读文本；随后按退出码退出 */
function output(result, json) {
  if (json) {
    const o = { ok: result.code === EXIT_OK, code: result.code };
    if (result.message !== undefined) o.message = result.message;
    if (result.data !== undefined) o.data = result.data;
    console.log(JSON.stringify(o));
  } else {
    if (result.code !== EXIT_OK) console.error('[错误] ' + (result.message || '失败'));
    else if (result.text !== undefined) console.log(result.text);
    else if (result.data !== undefined) console.log(JSON.stringify(result.data, null, 2));
  }
  process.exit(result.code);
}

// ---------------------------------------------------------------------------
// Playwright 封装
// ---------------------------------------------------------------------------
let _pw = null;
function playwright() {
  if (!_pw) {
    try { _pw = require('playwright'); }
    catch (e) {
      console.error('[错误] 未安装 playwright（仅 login/reserve/pay/open 等浏览器命令需要，数据查询命令不依赖它）。');
      console.error('  请先执行： node scripts/venue-helper.js setup');
      process.exit(1);
    }
  }
  return _pw;
}

async function launchContext(headless) {
  await acquireProfileLock(); // 互斥锁：并行调用排队等待，而非直接启动失败
  const { chromium } = playwright();
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const base = {
    headless: !!headless,
    viewport: { width: 1280, height: 800 },
    locale: 'zh-CN',
  };
  // 优先使用系统已安装的浏览器（无需下载 Chromium）：Chrome → Edge
  const channels = ['chrome', 'msedge'];
  let lastErr = null;
  for (const channel of channels) {
    try {
      return await chromium.launchPersistentContext(PROFILE_DIR, { ...base, channel });
    } catch (e) { lastErr = e; }
  }
  // 都不可用再退回 Playwright 自带 Chromium（需要 npx playwright install chromium）
  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, base);
  } catch (e) {
    console.error('[错误] 未能启动浏览器。请确认已安装 Google Chrome 或 Microsoft Edge，');
    console.error('  或执行： node scripts/venue-helper.js setup --with-chromium');
    throw lastErr || e;
  }
}

/** 检测系统是否装了可用的 Chrome/Edge（返回 channel 名或 null） */
async function detectSystemChannel() {
  const { chromium } = playwright();
  for (const channel of ['chrome', 'msedge']) {
    try {
      const b = await chromium.launch({ channel, headless: true });
      await b.close();
      return channel;
    } catch { /* 继续尝试下一个 */ }
  }
  return null;
}

/** 从浏览器 localStorage 读取 token（值为 JSON 字符串，需 parse） */
async function readTokenFromPage(page) {
  return page.evaluate(() => {
    const v = localStorage.getItem('token');
    if (!v) return null;
    try { return JSON.parse(v); } catch { return v; }
  });
}

/** 打开场馆首页并等待；返回 token（未登录返回 null） */
async function ensureToken(context, { waitMs = 4000 } = {}) {
  const page = await context.newPage();
  try {
    await page.goto(VENUE_URL + '#/home', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(waitMs);
    const token = await readTokenFromPage(page);
    const refreshToken = await page.evaluate(() => localStorage.getItem('refreshToken'));
    if (token) {
      writeTokenFile({ token, refreshToken: refreshToken ? JSON.parse(refreshToken) : null, updatedAt: new Date().toISOString() });
    }
    return token;
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * 依次检查 Chrome / Edge 两个浏览器是否已有登录会话（localStorage 里有 token）。
 * 命中则保存 token + storageState 并返回 { token, channel }；都没有返回 null。
 */
async function checkExistingLogin() {
  const { chromium } = playwright();
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  for (const channel of ['chrome', 'msedge']) {
    let context = null;
    try {
      context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: true, channel });
      const page = await context.newPage();
      await page.goto(VENUE_URL + '#/home', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(2500);
      const token = await readTokenFromPage(page);
      if (token) {
        const refreshToken = await page.evaluate(() => localStorage.getItem('refreshToken'));
        writeTokenFile({ token, refreshToken: refreshToken ? JSON.parse(refreshToken) : null, updatedAt: new Date().toISOString() });
        try { fs.writeFileSync(STORAGE_STATE_FILE, JSON.stringify(await context.storageState(), null, 2)); } catch {}
        return { token, channel };
      }
    } catch { /* 该浏览器不可用或无会话，尝试下一个 */ }
    finally { if (context) await context.close().catch(() => {}); }
  }
  return null;
}

/** 用 context.request 发起带签名 + 自动解密的 API 调用 */
async function apiCall(context, token, method, path, params, data) {
  const query = { ...signParams(), ...(params || {}) };
  const headers = { 'Language-Set': 'CN' };
  if (token) headers['token'] = token;
  if (path.startsWith('/api/')) headers['x-api-version'] = '2.0.0';
  if (data) headers['Content-Type'] = 'application/json';
  const resp = await context.request.fetch(API_BASE + path, {
    method,
    headers,
    params: query,
    data: data || undefined,
  });
  const text = await resp.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  // 若 body 是字符串，则说明响应被 AES 加密，解密后再 parse
  if (typeof body === 'string') {
    try { body = JSON.parse(decryptAes(body)); } catch { /* 保留原样 */ }
  }
  return body;
}

/** 判断是否成功：code==0 且无 errorCode */
function isOk(body) {
  return body && body.code === 0 && !body.errorCode;
}

/** 判断是否“未登录/登录过期”错误 */
function isAuthError(body) {
  return body && body.errorCode === 1130002;
}

/** 把接口返回的 data 归一化成数组 */
function toArray(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.list)) return data.list;
  if (data && Array.isArray(data.dataList)) return data.dataList;
  return [];
}

/** 在场地列表中按 uuid/名称/id 匹配 */
function findSite(arr, siteArg) {
  return arr.find(s => s.uuid === siteArg || s.siteName === siteArg || s.name === siteArg || String(s.id) === String(siteArg));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 带限流重试的 API 调用：遇 1610001 over limit 时指数退避重试 */
async function apiCallWithRetry(context, token, method, path, params, data) {
  for (let attempt = 0; ; attempt++) {
    const r = await apiCall(context, token, method, path, params, data);
    if (r && r.errorCode === RATE_LIMIT_ERROR_CODE && attempt < RATE_LIMIT_RETRY_MAX) {
      const delay = RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, attempt);
      await sleep(delay);
      continue;
    }
    return r;
  }
}

function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * 浏览器 profile 互斥锁：并行执行命令时排队等待，而不是直接启动失败。
 * 锁在进程退出时释放；若持有进程已死（残留锁），自动接管。
 */
async function acquireProfileLock(timeoutMs = 180000) {
  fs.mkdirSync(path.dirname(PROFILE_LOCK_FILE), { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(PROFILE_LOCK_FILE, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      if (!process.__thuProfileLockRegistered) {
        process.__thuProfileLockRegistered = true;
        process.on('exit', () => { try { fs.unlinkSync(PROFILE_LOCK_FILE); } catch {} });
      }
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let pid = 0;
      try { pid = parseInt(fs.readFileSync(PROFILE_LOCK_FILE, 'utf8'), 10); } catch { pid = 0; }
      if (pid && !isPidAlive(pid)) { try { fs.unlinkSync(PROFILE_LOCK_FILE); } catch {} continue; }
      if (Date.now() - start >= timeoutMs) throw new Error('等待浏览器 profile 锁超时（可能有其它命令正在运行），请稍后再试');
      await sleep(1000);
    }
  }
}

/**
 * 获取某场景「时段预约」所需的上下文（清华场馆走 CURRENT_RESERVE 流程，而非 PERIOD_RESERVE）。
 * - devKindUuid：来自 /api/site/devKind/list?uuid=<sceneUuid>，取 data[0].uuid（设备类型，如「羽毛球」）
 * - buildingUuid：来自 /api/site/chooseByType?sceneUuid=<sceneUuid>&siteType=BUILDING，取 data[0].uuid（场馆/楼栋）
 */
/**
 * 数字 sceneUseType（位掩码）→ 预约类型字符串。
 * 前端 useListEnum：1=NORMAL(普通) 2=SPORT_GROUP(包场) 4=SPORT_PERSON(散客)
 */
function sceneUseTypeOf(numeric) {
  const n = Number(numeric) || 0;
  for (const [key, value] of [[1, 'NORMAL'], [2, 'SPORT_GROUP'], [4, 'SPORT_PERSON']]) {
    if (n & key) return value;
  }
  return 'SPORT_GROUP'; // 兜底
}

async function getReserveContext(context, token, sceneUuid) {
  // 命中本地缓存直接返回（devKind/building/sceneUseType 相对稳定，缓存可省 3 次接口调用）
  const cache = readContextCache();
  if (cache[sceneUuid] && cache[sceneUuid].devKindUuid) return cache[sceneUuid];

  const devKind = await apiCallWithRetry(context, token, 'GET', '/api/site/devKind/list', { uuid: sceneUuid });
  const devKindUuid = (devKind.data && devKind.data[0] && devKind.data[0].uuid) || '';
  const devKindName = (devKind.data && devKind.data[0] && devKind.data[0].devKindName) || '';
  const building = await apiCallWithRetry(context, token, 'GET', '/api/site/chooseByType', { sceneUuid, siteType: 'BUILDING' });
  const buildingUuid = (building.data && building.data[0] && building.data[0].uuid) || '';
  const buildingName = (building.data && building.data[0] && building.data[0].siteName) || '';
  // 场景详情：取 sceneUseType（数字位掩码）→ 映射为预约类型字符串（游泳=SPORT_PERSON，羽毛球=SPORT_GROUP）
  let sceneUseType = 'SPORT_GROUP';
  try {
    const detail = await apiCallWithRetry(context, token, 'GET', '/api/site/scene/detail', { uuid: sceneUuid });
    if (isOk(detail) && detail.data) sceneUseType = sceneUseTypeOf(detail.data.sceneUseType);
  } catch { /* 详情失败则用兜底 */ }
  const result = {
    devKindUuid, devKindName, buildingUuid, buildingName, sceneUseType,
    devKindOk: isOk(devKind), buildingOk: isOk(building),
  };
  cache[sceneUuid] = result;
  writeContextCache(cache);
  return result;
}

/**
 * 查询某场景某日的可约时段网格（真实前端使用 /api/reserve/current/page + resvKind=CURRENT_RESERVE）。
 * siteType = 场景的 relatedType（本场馆恒为 "DEV"）；sceneUseType 由场景详情位掩码映射（SPORT_GROUP/SPORT_PERSON）。
 */
async function queryDaySlots(context, token, scene, ctx, dateStr) {
  const body = {
    sceneUuid: scene.uuid,
    resvKind: 'CURRENT_RESERVE',
    devKindUuid: ctx.devKindUuid,
    siteType: scene.relatedType || 'DEV',
    searchValue: '',
    siteKindId: '',
    classTypeEnum: 'BUILDING',
    classTypeUuid: ctx.buildingUuid,
    reserveDate: dateStr,
    sceneUseType: ctx.sceneUseType || 'SPORT_GROUP',
    pageSize: 999,
    pageNum: 1,
  };
  return apiCallWithRetry(context, token, 'POST', '/api/reserve/current/page', {}, body);
}

/** 从 current/page 的 data 中提取全部场次（含可约/不可约状态），返回扁平化数组 */
function extractSlots(data) {
  const slots = [];
  if (Array.isArray(data)) {
    for (const site of data) {
      const siteName = site.siteName || '';
      const siteUuid = site.uuid || site.id || '';
      const siteType = site.siteType || '';
      const formUuid = site.formUuid || '';
      for (const sess of (site.sessionVo || [])) {
        const st = sess.reserveStatus || {};
        const bd = String(sess.beginDate == null ? '' : sess.beginDate);
        const date = bd.length === 8 ? `${bd.slice(0, 4)}-${bd.slice(4, 6)}-${bd.slice(6, 8)}` : bd;
        const price = (sess.userFeeDetails && sess.userFeeDetails.chargingUnitPrice) || null;
        slots.push({
          siteName, siteUuid, siteType, formUuid, date,
          beginTime: sess.beginTime, endTime: sess.endTime,
          sessionUuid: sess.uuid || '',
          sessionSceneUseType: sess.sceneUseType || '',
          reserveStatus: st.reserveStatus || '', code: st.code, reason: st.reserveStatusReason || '',
          price,
        });
      }
    }
  }
  return slots;
}

/** 仅保留可约场次（reserveStatus.reserveStatus === 'Y'） */
function extractAvailableSlots(data) {
  return extractSlots(data).filter((s) => s.reserveStatus === 'Y');
}

/**
 * 跨天预约查询（游泳等场景走 CROSS_RESERVE，用 /api/reserve/cross/detail，一次返回整个日期区间）。
 * 参数参考前端 getDaysReserve：reserveStartDate / reserveEndDate / siteUuid / siteType。
 */
async function queryCrossSlots(context, token, scene, startDate, endDate) {
  const body = {
    reserveStartDate: fmtDate(startDate),
    reserveEndDate: fmtDate(endDate),
    siteUuid: scene.uuid,
    siteType: scene.siteType || scene.relatedType || 'DEV',
  };
  return apiCallWithRetry(context, token, 'POST', '/api/reserve/cross/detail', {}, body);
}

/** 从 cross/detail 的 data.groupReserveVos 中提取可约场次（reserveStatus.reserveStatus === 'Y'） */
function extractCrossSlots(data) {
  const slots = [];
  const vos = (data && Array.isArray(data.groupReserveVos)) ? data.groupReserveVos : [];
  for (const vo of vos) {
    const st = vo.reserveStatus || {};
    if (st.reserveStatus !== 'Y') continue;
    const bd = String(vo.currentDate == null ? '' : vo.currentDate);
    const date = /^\d{8}$/.test(bd) ? `${bd.slice(0, 4)}-${bd.slice(4, 6)}-${bd.slice(6, 8)}` : bd;
    const openTimes = (vo.openRule && Array.isArray(vo.openRule.openTime)) ? vo.openRule.openTime : [];
    if (openTimes.length) {
      for (const ot of openTimes) {
        slots.push({ siteName: vo.siteName || '', siteUuid: vo.uuid || '', date, beginTime: ot.startTime, endTime: ot.endTime, reserveStatus: 'Y', source: 'cross' });
      }
    } else {
      slots.push({ siteName: vo.siteName || '', siteUuid: vo.uuid || '', date, beginTime: vo.beginTime || '', endTime: vo.endTime || '', reserveStatus: 'Y', source: 'cross' });
    }
  }
  return slots;
}

/** 按权重不放回随机抽取 n 个元素（权重越大越易被抽中，但仍保留随机性） */
function weightedSample(arr, n, weightFn) {
  const pool = arr.slice();
  const picked = [];
  while (picked.length < n && pool.length > 0) {
    const weights = pool.map(weightFn);
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    let idx = 0;
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i];
      if (r <= 0) { idx = i; break; }
    }
    picked.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return picked;
}

/**
 * 热门等级（用于推荐加权，可自行增删/改档）：
 *   3 = 最热门；2 = 较热门；1 = 一般；未命中 = 0
 */
const POPULARITY_MAP = {
  羽毛球: 3, 游泳: 3, 乒乓球: 3, 篮球: 3, 足球: 3, 健身: 3, 台球: 3,
  网球: 2, 壁球: 2, 攀岩: 2, 瑜伽: 2, 舞蹈: 2, 排球: 2,
  击剑: 1, 射箭: 1, 保龄球: 1,
};

/** 取运动名称对应的热门等级（0~3） */
function popularityOf(name) {
  const s = String(name || '');
  let level = 0;
  for (const k of Object.keys(POPULARITY_MAP)) {
    if (s.includes(k) && POPULARITY_MAP[k] > level) level = POPULARITY_MAP[k];
  }
  return level;
}

/**
 * 运动 → 场馆速查（摘自 references/venues.md 的「运动 → 场馆速查」表，供 recommend 附带场馆信息）。
 * 完整场馆详情见 references/venues.md。
 */
const VENUE_BY_SPORT = {
  羽毛球: '气膜馆(12片)/综合体育馆(10片)/西体育馆(8片)，均20元/小时',
  乒乓球: '气膜馆 / 北体育馆(15元/小时)',
  游泳: '陈明游泳馆(室内恒温，学生7元/次) / 西湖游泳池(露天，秋冬闭馆)',
  网球: '北体育馆(120元/小时) / 紫荆网球场(15元/小时) / 东操网球场(工作日免费)',
  篮球: '北体育馆(半场175，可预约) / 西体育馆(300，可预约)；紫荆篮球场免费露天(无需预约)',
  排球: '综合体育馆(200元/小时) / 北体育馆',
  台球: '西体育馆(15元/小时)',
  壁球: '北体育馆(60元/小时)',
  击剑: '北体育馆',
  攀岩: '北体育馆',
  滑冰: '北体育馆冰上运动中心(30元/1.5小时，含护具冰鞋)',
  匹克球: '北体育馆',
  轮滑: '北体轮滑场 / 北体陆地轮滑球场',
  健身: '综体健身房 / 北体健身中心 / 宿舍区学生活动中心(免费凭卡)',
  足球: '紫荆操场 / 东大操场 / 西大操场(免费露天)',
  射击: '维学馆(仅校队训练/射击选修课，不对外预约)',
};

/** 取运动名称对应的场馆信息（无则返回空串） */
function venueInfoOf(name) {
  const s = String(name || '');
  for (const k of Object.keys(VENUE_BY_SPORT)) {
    if (s.includes(k)) return VENUE_BY_SPORT[k];
  }
  return '';
}

// ---------------------------------------------------------------------------
// 运动属性库（供「按需求推荐」打分）
//   intensity: 1=低强度 2=中 3=中高 4=高强度
//   joint: 1=低冲击(对膝盖/关节友好) 2=中 3=高冲击
//   goals: 目标关键词
//   indoor: 是否有室内场地
//   team: 1=单人 2=双人 3+=多人
//   cost: 0=免费 1=平价 2=较贵
// ---------------------------------------------------------------------------
const SPORT_ATTRS = {
  游泳:   { intensity: 2, joint: 1, goals: ['减脂', '心肺', '康复', '放松'], indoor: true,  team: 1, cost: 1, note: '低冲击、关节友好，室内恒温' },
  羽毛球: { intensity: 3, joint: 2, goals: ['减脂', '社交', '心肺'], indoor: true,  team: 2, cost: 1, note: '室内、可双打社交' },
  乒乓球: { intensity: 2, joint: 1, goals: ['社交', '放松', '反应'], indoor: true,  team: 2, cost: 1, note: '低冲击、室内' },
  网球:   { intensity: 3, joint: 2, goals: ['减脂', '社交'], indoor: false, team: 2, cost: 2, note: '紫荆网球场平价' },
  篮球:   { intensity: 4, joint: 3, goals: ['减脂', '团队', '社交'], indoor: false, team: 5, cost: 2, note: '团队对抗、强度高' },
  足球:   { intensity: 4, joint: 3, goals: ['减脂', '团队'], indoor: false, team: 11, cost: 0, note: '紫荆/东操免费露天' },
  健身:   { intensity: 3, joint: 2, goals: ['增肌', '减脂', '塑形'], indoor: true,  team: 1, cost: 1, note: '宿舍活动中心免费凭卡' },
  台球:   { intensity: 1, joint: 1, goals: ['放松', '社交'], indoor: true,  team: 2, cost: 1, note: '低强度、室内' },
  壁球:   { intensity: 3, joint: 2, goals: ['减脂', '反应'], indoor: true,  team: 1, cost: 2, note: '北体60元/小时' },
  攀岩:   { intensity: 4, joint: 2, goals: ['增肌', '挑战'], indoor: true,  team: 1, cost: 2, note: '北体' },
  瑜伽:   { intensity: 1, joint: 1, goals: ['柔韧', '放松', '康复'], indoor: true,  team: 1, cost: 1, note: '柔韧拉伸、低冲击' },
  舞蹈:   { intensity: 2, joint: 1, goals: ['减脂', '柔韧', '社交'], indoor: true,  team: 3, cost: 2, note: '室内' },
  排球:   { intensity: 3, joint: 2, goals: ['团队', '社交'], indoor: false, team: 6, cost: 2, note: '综体200元/小时' },
  击剑:   { intensity: 2, joint: 1, goals: ['反应', '挑战'], indoor: true,  team: 2, cost: 2, note: '北体' },
  滑冰:   { intensity: 2, joint: 1, goals: ['平衡', '趣味', '放松'], indoor: true,  team: 1, cost: 1, note: '北体30元/1.5小时' },
  匹克球: { intensity: 2, joint: 1, goals: ['减脂', '社交', '反应'], indoor: true,  team: 2, cost: 1, note: '北体、上手快' },
  轮滑:   { intensity: 2, joint: 1, goals: ['平衡', '趣味', '心肺'], indoor: false, team: 1, cost: 1, note: '北体轮滑场' },
};

/** 非运动类的辅助场景（深水证/荣誉室/操房/会议室等），推荐时排除 */
const AUX_SCENE_RE = /深水证|荣誉室|操房|会议室|研讨间|教工之家|训练|辅导|康复|体能/;

function isAuxiliaryScene(name) {
  return AUX_SCENE_RE.test(String(name || ''));
}

/** 修正站点里的别名/错别字，便于匹配属性库（如「兵乓球」→「乒乓球」、「冰雪中心」→「滑冰」） */
function normalizeSportName(name) {
  return String(name || '')
    .replace(/兵乓球/g, '乒乓球')
    .replace(/冰雪中心/g, '滑冰');
}

/** 按场景名匹配运动属性（辅助场景或未收录运动返回 null） */
function sportAttrsOf(name) {
  const s = normalizeSportName(name);
  if (isAuxiliaryScene(s)) return null;
  for (const k of Object.keys(SPORT_ATTRS)) {
    if (s.includes(k)) return SPORT_ATTRS[k];
  }
  return null;
}

/** 从用户需求文本解析约束（关键词匹配，返回 {lowImpact,gentle,intense,goals,indoor,outdoor,solo,team,cheap,beginner,raw}） */
function parseNeeds(text) {
  const t = String(text || '');
  const has = (kw) => t.includes(kw);
  const need = {
    lowImpact: false, gentle: false, intense: false,
    goals: new Set(), indoor: null, outdoor: null,
    solo: null, team: null, cheap: false, beginner: false,
    raw: t,
  };
  if (has('膝盖') || has('腰') || has('关节') || has('受伤') || has('康复') || has('低冲击') || has('不能剧烈') || has('术后') || has('旧伤') || has('崴脚')) need.lowImpact = true;
  if (has('低强度') || has('轻松') || has('不累') || has('温和') || has('舒缓')) need.gentle = true;
  if (has('高强度') || has('出汗') || has('挑战') || has('剧烈') || has('累一点')) need.intense = true;
  if (has('减肥') || has('减脂') || has('瘦') || has('燃脂') || has('有氧')) need.goals.add('减脂');
  if (has('增肌') || has('力量') || has('肌肉') || has('塑形') || has('练大') || has('撸铁')) need.goals.add('增肌');
  if (has('放松') || has('减压') || has('缓解') || has('疲劳') || has('解压')) need.goals.add('放松');
  if (has('柔韧') || has('拉伸')) need.goals.add('柔韧');
  if (has('心肺') || has('耐力') || has('体能')) need.goals.add('心肺');
  if (has('社交') || has('组队') || has('多人') || has('朋友') || has('一起') || has('集体') || has('约人') || has('双打')) need.team = true;
  if (has('单人') || has('自己') || has('一个人') || has('独处') || has('自个')) need.solo = true;
  if (has('室内') || has('恒温') || has('不怕天气') || has('冬天') || has('下雨')) need.indoor = true;
  if (has('室外') || has('户外') || has('露天') || has('晒太阳') || has('操场')) need.outdoor = true;
  if (has('便宜') || has('免费') || has('省钱') || has('预算') || has('平价') || has('不贵')) need.cheap = true;
  if (has('新手') || has('不会') || has('零基础') || has('没练过') || has('入门') || has('第一次')) need.beginner = true;
  return need;
}

/** 按需求给运动打分，返回 {score, reasons[]} */
function scoreSport(attrs, need) {
  let score = 0;
  const reasons = [];
  if (need.lowImpact) {
    if (attrs.joint === 1) { score += 3; reasons.push('低冲击/关节友好'); }
    else if (attrs.joint >= 3) score -= 3;
  }
  if (need.gentle) {
    if (attrs.intensity <= 1) { score += 2; reasons.push('低强度'); }
    else if (attrs.intensity >= 4) score -= 2;
  }
  if (need.intense && attrs.intensity >= 3) { score += 2; reasons.push('强度高'); }
  for (const g of need.goals) {
    if (attrs.goals.includes(g)) { score += 3; reasons.push(g); }
  }
  if (need.team === true && attrs.team >= 2) { score += 2; reasons.push('可多人/社交'); }
  if (need.solo === true && attrs.team === 1) { score += 1; reasons.push('适合单人'); }
  if (need.indoor === true && attrs.indoor) { score += 2; reasons.push('室内'); }
  if (need.outdoor === true && !attrs.indoor) { score += 2; reasons.push('室外'); }
  if (need.cheap) {
    if (attrs.cost <= 1) { score += 2; reasons.push('价格友好'); }
    else if (attrs.cost >= 2) score -= 1;
  }
  if (need.beginner && attrs.intensity <= 2) { score += 1; reasons.push('上手友好'); }
  return { score, reasons };
}

/** 场景名 → 归一化运动名（综体羽毛球/气膜馆羽毛球 → 羽毛球），辅助场景/无映射的按自身名 */
function sportKeyOf(name) {
  const s = normalizeSportName(name);
  if (isAuxiliaryScene(s)) return s;
  for (const k of Object.keys(SPORT_ATTRS)) {
    if (s.includes(k)) return k;
  }
  return s;
}

/** 把解析出的需求约束还原成一句中文摘要（供推荐文案） */
function summarizeNeeds(need) {
  const parts = [];
  if (need.lowImpact) parts.push('低冲击/关节友好');
  if (need.gentle) parts.push('低强度');
  if (need.intense) parts.push('高强度');
  for (const g of ['减脂', '增肌', '放松', '柔韧', '心肺']) {
    if (need.goals.has(g)) parts.push(g);
  }
  if (need.indoor === true) parts.push('室内');
  if (need.outdoor === true) parts.push('室外');
  if (need.team === true) parts.push('可多人');
  if (need.solo === true) parts.push('单人');
  if (need.cheap) parts.push('价格友好');
  if (need.beginner) parts.push('新手友好');
  return parts.length ? parts.join('、') : '未识别到具体需求';
}

// ---------------------------------------------------------------------------
// 抽签报名（lottery）
// ---------------------------------------------------------------------------
/** 报名身份编码 → 名称（综体羽毛球抽签实测：512=学生，256=教职工） */
const IDENT_LIMIT_MAP = { 512: '学生', 256: '教职工' };

function identLimitLabel(codes) {
  if (!Array.isArray(codes) || !codes.length) return '无限制';
  return codes.map((c) => IDENT_LIMIT_MAP[c] || String(c)).join('、');
}

/**
 * unAvailableStatus 位掩码（前端 onClickDate 逻辑）：
 *   1(0b1)   = 当前已报名；14(0b1110)= 当前未开放报名；0 = 可报名。
 */
function lotteryStatusOf(unAvailableStatus) {
  const n = Number(unAvailableStatus) || 0;
  const flags = [];
  if (n & 1) flags.push('已报名');
  if (n & 14) flags.push('未开放报名');
  return flags.length ? flags.join('、') : '可报名';
}

/** 查询某场景的抽签报名场次（POST /api/lottery/plans，body 参考前端 getData） */
async function queryLotteryPlans(context, token, sceneUuid) {
  return apiCallWithRetry(context, token, 'POST', '/api/lottery/plans', {}, {
    pageSize: 50,
    pageNum: 1,
    sceneUuid,
    siteIds: [],
    orderItems: 'lotterySort',
    orderRule: 'asc',
  });
}

/** 查询某场次的报名详情（日期 + 可报名状态），GET /api/lottery/plan/detail */
async function queryLotteryPlanDetail(context, token, lotteryUuid) {
  return apiCallWithRetry(context, token, 'GET', '/api/lottery/plan/detail', { lotteryUuid });
}

/** 在场次列表中按 uuid / 标题 / 时间匹配（羽1、18:00-20:00 等均可） */
function findPlan(plans, planArg) {
  if (!Array.isArray(plans) || !plans.length) return null;
  const a = String(planArg || '').trim();
  if (!a) return null;
  let p = plans.find((x) => x.lotteryUuid === a);
  if (p) return p;
  p = plans.find((x) => {
    const t = x.lotteryTitle || '';
    return t.includes(a) || a.includes(t);
  });
  if (p) return p;
  const tm = a.match(/\d{2}:\d{2}/);
  if (tm) p = plans.find((x) => (x.lotteryTitle || '').includes(tm[0]));
  return p || null;
}

/** lottery 主命令：plans（默认） / dates / signup / mine */
async function cmdLottery(argv) {
  const { args } = parseArgs(argv);
  const json = !!args.json;
  const sub = (argv.find((a) => !a.startsWith('-')) || 'plans');
  const token = readCachedToken();
  if (!token) return output({ code: EXIT_UNAUTH, message: '未登录，请先运行 login' }, json);
  const context = await getApiClient();
  try {
    if (sub === 'mine') return await lotteryMine(context, token, json);
    if (sub === 'signup') return await lotterySignup(context, token, args, json);
    if (sub === 'dates') return await lotteryDates(context, token, args, json);
    return await lotteryPlans(context, token, args, json);
  } finally {
    await context.close();
  }
}

/** 取某场次的报名日期列表（含可报名状态），供「一键概览」复用 */
async function planDates(context, token, lotteryUuid) {
  const d = await queryLotteryPlanDetail(context, token, lotteryUuid);
  if (!isOk(d) || !d.data) return [];
  return (d.data.instanceDetailVos || []).map((v) => ({
    date: v.lotteryDevDate,
    instanceUuid: v.instanceUuid,
    applyStart: v.applyStartTime,
    applyEnd: v.applyEndTime,
    lotteryTime: v.lotteryTime,
    paymentTime: v.paymentTime,
    status: lotteryStatusOf(v.unAvailableStatus),
    unAvailableStatus: v.unAvailableStatus,
  }));
}

/** 查询某场景的抽签概览（场次 + 可报名日期）；该场景不支持抽签时返回 null */
async function queryLotteryOverview(context, token, sceneUuid) {
  const flag = await apiCall(context, token, 'GET', '/api/lottery/scene', { sceneUuid });
  if (!isOk(flag) || flag.data !== true) return null;
  const pr = await queryLotteryPlans(context, token, sceneUuid);
  if (!isOk(pr)) return null;
  const plans = toArray(pr.data).map((p) => ({
    lotteryUuid: p.lotteryUuid,
    title: p.lotteryTitle,
    venue: p.reserveSiteName,
    ident: identLimitLabel(p.identLimit),
    registrants: p.registrantNum,
  }));
  for (let i = 0; i < plans.length; i++) {
    plans[i].dates = await planDates(context, token, plans[i].lotteryUuid);
    if (i < plans.length - 1) await sleep(REQUEST_INTERVAL_MS);
  }
  return plans;
}

async function lotteryPlans(context, token, args, json) {
  const sceneArg = args.scene;
  if (!sceneArg) return output({ code: EXIT_FAIL, message: '缺少 --scene 参数（场景名称或 uuid）' }, json);
  const scene = await resolveScene(context, token, sceneArg);
  const r = await queryLotteryPlans(context, token, scene.uuid);
  if (!isOk(r)) {
    if (isAuthError(r)) return output({ code: EXIT_UNAUTH, message: '登录过期，请重新运行 login' }, json);
    return output({ code: EXIT_FAIL, message: '查询抽签报名场次失败：' + JSON.stringify(r) }, json);
  }
  const plans = toArray(r.data);
  const withDates = !!args.dates || !!args['with-dates'];
  const rows = plans.map((p) => ({
    lotteryUuid: p.lotteryUuid,
    title: p.lotteryTitle,
    venue: p.reserveSiteName,
    ident: identLimitLabel(p.identLimit),
    registrants: p.registrantNum,
  }));
  // --dates：逐场次拉取报名日期（供「羽毛球」一键呈现普通时段 + 抽签时段）
  if (withDates && rows.length) {
    for (let i = 0; i < rows.length; i++) {
      const dates = await planDates(context, token, rows[i].lotteryUuid);
      rows[i].dates = dates;
      rows[i].openCount = dates.filter((x) => x.unAvailableStatus === 0).length;
      if (i < rows.length - 1) await sleep(REQUEST_INTERVAL_MS);
    }
  }
  const text = `${scene.sceneName || scene.uuid} 抽签报名场次（共 ${rows.length} 个）\n`
    + (rows.length
      ? rows.map((x, i) => {
          let line = `  ${i + 1}. ${x.title} —— ${x.venue}｜报名身份：${x.ident}${x.registrants >= 0 ? '｜已报名人数：' + x.registrants : ''}`;
          if (withDates && x.dates) {
            const open = x.dates.filter((d) => d.status === '可报名');
            line += open.length
              ? `｜可报名：${open.map((d) => d.date).join('、')}`
              : '｜当前无可报名日期';
          }
          return line;
        }).join('\n')
        + (withDates
          ? '\n（报名：lottery signup --scene <场景> --plan <场次名|uuid> --date YYYY-MM-DD --yes）'
          : '\n（查可报名日期：lottery dates --scene <场景> --plan <场次名|uuid>；报名：lottery signup）')
      : '（当前无开放的抽签报名场次）');
  return output({ code: EXIT_OK, data: { sceneUuid: scene.uuid, sceneName: scene.sceneName, plans: rows }, text }, json);
}

async function lotteryDates(context, token, args, json) {
  const planArg = args.plan;
  if (!planArg) return output({ code: EXIT_FAIL, message: '缺少 --plan 参数（场次名或 lotteryUuid）' }, json);
  let lotteryUuid = planArg;
  let title = planArg;
  let venue = '';
  let ident = '';
  if (args.scene) {
    const scene = await resolveScene(context, token, args.scene);
    const pr = await queryLotteryPlans(context, token, scene.uuid);
    if (isOk(pr)) {
      const plan = findPlan(toArray(pr.data), planArg);
      if (plan) {
        lotteryUuid = plan.lotteryUuid;
        title = plan.lotteryTitle;
        venue = plan.reserveSiteName || '';
        ident = identLimitLabel(plan.identLimit);
      }
    }
  }
  const d = await queryLotteryPlanDetail(context, token, lotteryUuid);
  if (!isOk(d) || !d.data) return output({ code: EXIT_FAIL, message: '查询抽签详情失败：' + JSON.stringify(d) }, json);
  const info = d.data;
  title = title === planArg ? (info.lotteryTitle || title) : title;
  const dates = (info.instanceDetailVos || []).map((v) => ({
    instanceUuid: v.instanceUuid,
    date: v.lotteryDevDate,
    applyStart: v.applyStartTime,
    applyEnd: v.applyEndTime,
    lotteryTime: v.lotteryTime,
    paymentTime: v.paymentTime,
    status: lotteryStatusOf(v.unAvailableStatus),
    unAvailableStatus: v.unAvailableStatus,
  }));
  const text = `【${title}】${info.reserveSiteName || ''}｜报名身份：${identLimitLabel(info.identLimit)}\n可报名日期：\n`
    + (dates.length ? dates.map((v) => `  · ${v.date}  ${v.status}（报名 ${v.applyStart}~${v.applyEnd}，${v.lotteryTime} 出签，${v.paymentTime} 前缴费）`).join('\n') : '（无）');
  return output({ code: EXIT_OK, data: { lotteryUuid, title, venue: info.reserveSiteName, ident: identLimitLabel(info.identLimit), dates }, text }, json);
}

async function lotterySignup(context, token, args, json) {
  const planArg = args.plan;
  const dateArg = args.date;
  if (!planArg) return output({ code: EXIT_FAIL, message: '缺少 --plan 参数（场次名或 lotteryUuid）' }, json);
  if (!dateArg) return output({ code: EXIT_FAIL, message: '缺少 --date 参数（YYYY-MM-DD，用 lottery dates 查看可报名日期）' }, json);
  let lotteryUuid = planArg;
  let title = planArg;
  if (args.scene) {
    const scene = await resolveScene(context, token, args.scene);
    const pr = await queryLotteryPlans(context, token, scene.uuid);
    if (isOk(pr)) {
      const plan = findPlan(toArray(pr.data), planArg);
      if (plan) { lotteryUuid = plan.lotteryUuid; title = plan.lotteryTitle; }
    }
  }
  const d = await queryLotteryPlanDetail(context, token, lotteryUuid);
  if (!isOk(d) || !d.data) return output({ code: EXIT_FAIL, message: '查询抽签详情失败：' + JSON.stringify(d) }, json);
  const info = d.data;
  const v = (info.instanceDetailVos || []).find((x) => x.lotteryDevDate === dateArg);
  if (!v) {
    const avail = (info.instanceDetailVos || []).map((x) => x.lotteryDevDate).join('、');
    return output({ code: EXIT_FAIL, message: `该场次无 ${dateArg} 这一日期，可选日期：${avail || '（无）'}` }, json);
  }
  if (v.unAvailableStatus !== 0) {
    return output({
      code: EXIT_FAIL,
      message: `${info.lotteryTitle}｜${dateArg} 当前状态为「${lotteryStatusOf(v.unAvailableStatus)}」，无法报名。`,
      data: { title: info.lotteryTitle, date: dateArg, status: lotteryStatusOf(v.unAvailableStatus), unAvailableStatus: v.unAvailableStatus },
    }, json);
  }
  const summary = {
    title: info.lotteryTitle,
    venue: info.reserveSiteName,
    date: dateArg,
    instanceUuid: v.instanceUuid,
    applyEnd: v.applyEndTime,
    lotteryTime: v.lotteryTime,
    paymentTime: v.paymentTime,
  };
  if (!args.yes) {
    return output({
      code: EXIT_OK,
      data: { ...summary, dryRun: true, note: '确认报名请加 --yes 参数' },
      text: `【预演，未提交】将报名：${info.lotteryTitle}｜${dateArg}｜${info.reserveSiteName}（${v.applyEndTime} 截止，${v.lotteryTime} 出签，中签后 ${v.paymentTime} 前缴费）。确认报名请加 --yes。`,
    }, json);
  }
  const s = await apiCallWithRetry(context, token, 'POST', '/api/lottery/plan/instance', {}, { instanceUuids: [v.instanceUuid] });
  if (!isOk(s)) return output({ code: EXIT_FAIL, message: '抽签报名失败：' + JSON.stringify(s) }, json);
  return output({
    code: EXIT_OK,
    data: { ...summary, success: true },
    text: `✅ 抽签报名成功：${info.lotteryTitle}｜${dateArg}｜${info.reserveSiteName}（${v.lotteryTime} 出签，中签后 ${v.paymentTime} 前缴费）`,
  }, json);
}

async function lotteryMine(context, token, json) {
  const r = await apiCallWithRetry(context, token, 'GET', '/api/lottery/instance/list', { pageNum: 1, pageSize: 50 });
  if (!isOk(r)) {
    if (isAuthError(r)) return output({ code: EXIT_UNAUTH, message: '登录过期，请重新运行 login' }, json);
    return output({ code: EXIT_FAIL, message: '查询我的抽签报名失败：' + JSON.stringify(r) }, json);
  }
  const rows = toArray(r.data).map((x) => ({
    instanceUuid: x.instanceUuid,
    title: x.lotteryTitle,
    venue: x.reserveSiteName,
    registratTime: x.registratTime,
    applyEndTime: x.applyEndTime,
    lotteryTime: x.lotteryTime,
    paymentTime: x.paymentTime,
    winLottery: x.winLottery,
    lotteryDraw: x.lotteryDraw,
    cancelRegistration: x.cancelRegistration,
  }));
  if (!rows.length) return output({ code: EXIT_OK, data: { mine: [] }, text: '你还没有抽签报名记录。' }, json);
  const text = `我的抽签报名（共 ${rows.length} 条）\n` + rows.map((m, i) => {
    const win = m.lotteryDraw ? (m.winLottery ? '✅ 已中签' : '❌ 未中签') : '⏳ 待出签';
    return `  ${i + 1}. ${m.title}（${m.venue}）报名于 ${m.registratTime}｜${win}｜${m.lotteryTime} 出签${m.winLottery ? '｜' + m.paymentTime + ' 前缴费' : ''}`;
  }).join('\n');
  return output({ code: EXIT_OK, data: { mine: rows }, text }, json);
}

/** 打开抽签报名页（有头浏览器），供用户手动操作 */
async function cmdLotteryOpen(argv) {
  const { args } = parseArgs(argv);
  const json = !!args.json;
  const sceneArg = args.scene;
  let sceneUuid = sceneArg || '';
  if (sceneArg) {
    const token = readCachedToken();
    if (token) {
      const ctx = await getApiClient();
      try { sceneUuid = (await resolveScene(ctx, token, sceneArg)).uuid; } catch { /* 保留原始参数 */ }
      await ctx.close();
    }
  }
  const hash = sceneUuid ? `#/lottery?uuid=${encodeURIComponent(sceneUuid)}` : '#/lottery';
  const context = await launchContext(false);
  const page = await context.newPage();
  await page.goto(VENUE_URL + hash, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  if (!json) console.log('已打开抽签报名页（' + hash + '）。按 Ctrl+C 或关闭浏览器结束。');
  await page.waitForTimeout(30 * 60 * 1000).catch(() => {});
  await context.close();
  return output({ code: EXIT_OK, data: { opened: hash }, text: '已结束' }, json);
}

// ---------------------------------------------------------------------------
// setup：环境准备
// ---------------------------------------------------------------------------
/** 运行 shell 命令（继承 stdio，去掉 DSH 注入的 allow-scripts 环境变量） */
function runShell(cmdline, { env = {} } = {}) {
  const e = { ...process.env };
  delete e.npm_config_allow_scripts;      // 关键：移除 allow-scripts 白名单，否则 npm 11 抛 EALLOWSCRIPTS
  delete e.NPM_CONFIG_ALLOW_SCRIPTS;
  Object.assign(e, env);
  const r = spawnSync(cmdline, { stdio: 'inherit', shell: true, cwd: SKILL_ROOT, env: e });
  return r.status === 0;
}

/** 在 skill 根目录写 package.json（allowScripts 必须是对象格式） */
function ensurePackageJson() {
  const pkgPath = path.join(SKILL_ROOT, 'package.json');
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { pkg = {}; }
  if (typeof pkg !== 'object' || Array.isArray(pkg)) pkg = {};
  if (!pkg.name) pkg.name = 'thu-auto-reserve';
  if (!pkg.version) pkg.version = '1.0.0';
  pkg.private = true;
  const prev = (pkg.allowScripts && typeof pkg.allowScripts === 'object' && !Array.isArray(pkg.allowScripts)) ? pkg.allowScripts : {};
  pkg.allowScripts = { ...prev, playwright: true }; // 对象格式：{"playwright": true}
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  return pkgPath;
}

async function cmdSetup(argv) {
  const { args } = parseArgs(argv);
  const json = !!args.json;
  const withChromium = !!args['with-chromium'];
  const noChromium = !!args['no-chromium'];
  const mirror = args.mirror || process.env.PLAYWRIGHT_DOWNLOAD_HOST || DEFAULT_MIRROR;

  const steps = [];
  try {
    const pkgPath = ensurePackageJson();
    if (!json) console.log('① 已写入 ' + pkgPath + '（allowScripts 为对象 {"playwright": true}）');
    steps.push('package.json');

    if (!json) console.log('② 安装 playwright 库（已移除 npm_config_allow_scripts）…');
    if (!runShell('npm install playwright')) {
      return output({ code: EXIT_FAIL, message: 'npm install playwright 失败，请检查网络或手动执行' }, json);
    }
    steps.push('playwright');

    // ③ 浏览器：优先系统 Chrome/Edge；都没有（或显式 --with-chromium）才下载 Chromium
    let channel = null;
    try { channel = await detectSystemChannel(); } catch { channel = null; }
    if (channel && !withChromium) {
      if (!json) console.log(`③ 检测到系统浏览器 ${channel}，无需下载 Chromium。`);
      steps.push('browser=system:' + channel);
    } else if (!noChromium || withChromium) {
      if (!json) console.log('③ 下载 Chromium（镜像 ' + mirror + '，可用 --mirror 覆盖）…');
      if (!runShell('npx playwright install chromium', { env: { PLAYWRIGHT_DOWNLOAD_HOST: mirror } })) {
        return output({ code: EXIT_FAIL, message: 'npx playwright install chromium 失败，可加 --mirror 换镜像重试' }, json);
      }
      steps.push('browser=chromium');
    } else {
      steps.push('browser=skip');
    }
  } catch (e) {
    return output({ code: EXIT_FAIL, message: 'setup 失败：' + (e && e.message ? e.message : e) }, json);
  }
  return output({ code: EXIT_OK, data: { ok: true, steps }, text: '✅ setup 完成。下一步： node scripts/venue-helper.js login' }, json);
}

// ---------------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------------
async function cmdLogin(argv) {
  const { args } = parseArgs(argv);
  const json = !!args.json;

  // 1) 先检查 Chrome / Edge 两个浏览器是否已有登录会话，避免重复登录
  if (!json) console.log('正在检查 Chrome / Edge 是否已有登录会话…');
  const existing = await checkExistingLogin();
  if (existing) {
    if (!json) console.log(`✅ 检测到 ${existing.channel} 已有登录会话，已复用并保存。`);
    return output({ code: EXIT_OK, data: { loggedIn: true, reused: true, channel: existing.channel }, text: `已复用 ${existing.channel} 中的现有登录会话` }, json);
  }

  // 2) 都没有 → 通过 /cas/address 拿「带 service 的统一登录 URL」：用户只在前台登录一次，
  //    登录后 CAS 会自动跳回场馆并换取 token（其余全在后台自动完成，无需再点「登录」）
  const context = await launchContext(false);
  const page = await context.newPage();
  const redirectUrl = VENUE_URL + '#/home';
  let loginUrl = process.env.THU_SPORTS_CAS || 'https://id.tsinghua.edu.cn/f/login';
  try {
    const casResp = await apiCall(context, '', 'GET', '/cas/address', { redirectUrl });
    if (casResp && typeof casResp.data === 'string' && casResp.data) loginUrl = casResp.data;
  } catch { /* 拿不到就用默认 CAS 地址兜底 */ }
  if (!json) console.log('正在打开统一身份认证登录页（只需登录一次，其余后台自动完成）…');
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  if (!json) console.log('等待登录…（完成后会自动跳回场馆并获取会话）');

  let token = null;
  for (let i = 0; i < 240; i++) { // 最多 20 分钟
    await page.waitForTimeout(3000);
    if (page.url().includes('sports.tsinghua.edu.cn')) {
      token = await readTokenFromPage(page);
      if (token) break;
    }
    // 仍在 CAS 登录页 / 跳转中 → 继续等
  }

  if (!token) {
    await context.close();
    return output({ code: EXIT_FAIL, message: '未检测到登录成功（超时），请重试 login' }, json);
  }

  const refreshToken = await page.evaluate(() => localStorage.getItem('refreshToken'));
  writeTokenFile({ token, refreshToken: refreshToken ? JSON.parse(refreshToken) : null, updatedAt: new Date().toISOString() });
  // 额外保存完整 storageState（含 Cookie），供「无浏览器」查询路径复用
  try { fs.writeFileSync(STORAGE_STATE_FILE, JSON.stringify(await context.storageState(), null, 2)); } catch {}
  if (!json) {
    console.log('✅ 登录成功，会话已保存到 ' + PROFILE_DIR);
    console.log('   token 已缓存到 ' + TOKEN_FILE);
  }
  const me = await apiCall(context, token, 'GET', '/system/login/getLoginUser');
  const user = isOk(me) ? (me.data || {}) : null;
  if (!json && user) console.log('   当前用户：' + (user.nickName || user.name || user.account || JSON.stringify(user).slice(0, 80)));
  await context.close();
  return output({ code: EXIT_OK, data: { loggedIn: true, user }, text: '登录成功' }, json);
}

// ---------------------------------------------------------------------------
// 数据查询
// ---------------------------------------------------------------------------
/** 读取本地缓存的登录 token（不启动浏览器） */
function readCachedToken() {
  const c = readTokenFile();
  return (c && c.token) || null;
}

/** 从 storageState 提取 Cookie 头（供纯 HTTP 请求复用登录会话） */
function loadCookieHeader() {
  try {
    const state = JSON.parse(fs.readFileSync(STORAGE_STATE_FILE, 'utf8'));
    return (state.cookies || []).map((c) => `${c.name}=${c.value}`).join('; ');
  } catch { return ''; }
}

/**
 * 创建「无浏览器、无 playwright 依赖」的 API 客户端：直接用 Node 内置 fetch 发请求，
 * Cookie 从 storageState 读取，token 头由 apiCall 传入。
 * 返回与浏览器 context 相同的 { request, close } 形态，apiCall 无需改动。
 */
function getApiClient() {
  const request = {
    async fetch(url, options = {}) {
      const { method = 'GET', headers = {}, params = {}, data } = options;
      const qs = new URLSearchParams(params).toString();
      const full = qs ? `${url}${url.includes('?') ? '&' : '?'}${qs}` : url;
      const h = { ...headers };
      h['Cookie'] = loadCookieHeader();
      h['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
      const body = data === undefined || data === null ? undefined : (typeof data === 'string' ? data : JSON.stringify(data));
      const resp = await globalThis.fetch(full, { method, headers: h, body });
      const text = await resp.text();
      return { text: async () => text };
    },
  };
  return { request, close: async () => {} };
}

async function cmdStatus(argv) {
  const { args } = parseArgs(argv);
  const json = !!args.json;
  const token = readCachedToken();
  if (!token) return output({ code: EXIT_UNAUTH, message: '未登录，请先运行 login' }, json);
  const context = await getApiClient();
  const me = await apiCall(context, token, 'GET', '/system/login/getLoginUser');
  await context.close();
  if (isOk(me)) {
    const user = me.data || {};
    return output({ code: EXIT_OK, data: { loggedIn: true, user }, text: '✅ 已登录：\n' + JSON.stringify(user, null, 2) }, json);
  }
  if (isAuthError(me)) {
    return output({ code: EXIT_UNAUTH, message: '登录过期，请重新运行 login' }, json);
  }
  return output({ code: EXIT_FAIL, message: '查询登录态失败：' + JSON.stringify(me) }, json);
}

/** 解析 --scene：可能是 uuid 或名称，返回 scene 对象 */
// ---------------------------------------------------------------------------
// 场景解析（支持模糊匹配 + 多场景，修复「西体羽毛球」→ 前馆/后馆 歧义）
// ---------------------------------------------------------------------------
const SCENE_LIST_CACHE_FILE = path.join(os.homedir(), '.thu-sports-venue', 'scene-list.json');
const SCENE_LIST_CACHE_TTL = 10 * 60 * 1000; // 场景名单缓存 10 分钟（变化极慢，省掉每次拉全量）

/** 获取场景列表（带本地缓存） */
async function fetchSceneList(context, token) {
  try {
    const c = JSON.parse(fs.readFileSync(SCENE_LIST_CACHE_FILE, 'utf8'));
    if (c && Array.isArray(c.list) && (Date.now() - c.ts) < SCENE_LIST_CACHE_TTL) return c.list;
  } catch { /* 缓存失效则重新拉取 */ }
  const r = await apiCall(context, token, 'GET', '/api/site/scene/list');
  if (!isOk(r)) throw new Error('场景列表获取失败：' + JSON.stringify(r));
  const list = toArray(r.data);
  try { fs.writeFileSync(SCENE_LIST_CACHE_FILE, JSON.stringify({ ts: Date.now(), list })); } catch {}
  return list;
}

/** 场景名/uuid → 匹配到的场景数组（先精确、后名称包含模糊；可能 0/1/多个） */
async function resolveScenes(context, token, sceneArg) {
  const arr = await fetchSceneList(context, token);
  // 1) 精确匹配（uuid / 名称 / 英文名 / id）
  let found = arr.filter((s) => s.uuid === sceneArg || s.sceneName === sceneArg || s.sceneEnName === sceneArg || String(s.id) === String(sceneArg));
  // 2) 模糊匹配（名称包含关键词，如「西体羽毛球」→ 前馆/后馆）
  if (!found.length) {
    found = arr.filter((s) => (s.sceneName || '').includes(sceneArg) || (s.sceneEnName || '').includes(sceneArg));
  }
  return found;
}

/** 单场景解析（reserve 等只需一个 uuid 的命令用）；歧义时报错列出候选项 */
async function resolveScene(context, token, sceneArg) {
  const found = await resolveScenes(context, token, sceneArg);
  if (!found.length) throw new Error(`找不到场景「${sceneArg}」，请用 sports 查看可用场景名`);
  if (found.length > 1) {
    throw new Error(`「${sceneArg}」匹配到多个场景（${found.map((s) => s.sceneName).join('、')}），请用更精确的场景名`);
  }
  return found[0];
}

// 注意：本场馆接口对「并发」限流（实测同一时刻只允许 ~1 个请求，并发请求会立刻 1610001），
// 因此 slots/sites 的时段查询必须**串行**，不要用并发请求来加速。

/** 把逐片场次聚合成「日期 时段 —— N 片(场地…/场馆…)」摘要，避免逐片罗列（羽1/羽2/…） */
function summarizeSlots(slots) {
  const map = new Map();
  for (const s of slots) {
    const key = `${s.sceneName || ''}|${s.date}|${s.beginTime}|${s.endTime}`;
    if (!map.has(key)) {
      map.set(key, { sceneName: s.sceneName || '', date: s.date, beginTime: s.beginTime, endTime: s.endTime, price: s.price, source: s.source, sites: [] });
    }
    map.get(key).sites.push(s.siteName);
  }
  const rows = [...map.values()];
  rows.sort((a, b) => (a.sceneName + a.date + a.beginTime).localeCompare(b.sceneName + b.date + b.beginTime));
  return rows.map((g) => {
    const uniq = [...new Set(g.sites)];
    const siteStr = uniq.length === 1 ? uniq[0] : (uniq.length <= 3 ? uniq.join('、') : `${uniq.length} 片`);
    const priceStr = g.price != null ? `  ¥${(g.price / 100).toFixed(0)}` : '';
    const scenePrefix = g.sceneName ? `${g.sceneName} ` : '';
    const src = g.source === 'cross' ? '（跨天）' : '';
    return `${scenePrefix}${g.date} ${g.beginTime}~${g.endTime}（${siteStr}）${priceStr}${src}`;
  });
}

async function cmdSports(argv) {
  const { args } = parseArgs(argv);
  const json = !!args.json;
  const token = readCachedToken();
  if (!token) return output({ code: EXIT_UNAUTH, message: '未登录，请先运行 login' }, json);
  const context = await getApiClient();
  const r = await apiCall(context, token, 'GET', '/api/site/scene/list');
  await context.close();
  if (!isOk(r)) {
    if (isAuthError(r)) return output({ code: EXIT_UNAUTH, message: '登录过期，请重新运行 login' }, json);
    return output({ code: EXIT_FAIL, message: '查询失败：' + JSON.stringify(r) }, json);
  }
  return output({ code: EXIT_OK, data: r.data }, json);
}

async function cmdSites(argv) {
  const { args } = parseArgs(argv);
  const json = !!args.json;
  const sceneArg = args.scene;
  if (!sceneArg) return output({ code: EXIT_FAIL, message: '缺少 --scene 参数' }, json);
  const token = readCachedToken();
  if (!token) return output({ code: EXIT_UNAUTH, message: '未登录，请先运行 login' }, json);
  const context = await getApiClient();

  let scenes;
  try {
    scenes = await resolveScenes(context, token, sceneArg);
  } catch (e) {
    await context.close();
    return output({ code: EXIT_FAIL, message: e.message }, json);
  }
  if (!scenes.length) {
    await context.close();
    return output({ code: EXIT_FAIL, message: `找不到场景「${sceneArg}」，请用 sports 查看可用场景名` }, json);
  }

  const today = fmtDate(new Date());
  const infos = [];
  for (const scene of scenes) {
    const ctx = await getReserveContext(context, token, scene.uuid);
    let courts = [];
    let todayAvailable = 0;
    const page = await queryDaySlots(context, token, scene, ctx, today);
    if (isOk(page) && Array.isArray(page.data)) {
      courts = page.data.map((s) => ({
        siteName: s.siteName,
        siteUuid: s.uuid || s.id,
        kindName: s.kindName || '',
        kindId: s.kindId || '',
        openState: s.openState,
      }));
      todayAvailable = extractAvailableSlots(page.data).length;
    }
    infos.push({
      scene: { uuid: scene.uuid, name: scene.sceneName, relatedType: scene.relatedType },
      devKind: { uuid: ctx.devKindUuid, name: ctx.devKindName },
      building: { uuid: ctx.buildingUuid, name: ctx.buildingName },
      courts,
      todayAvailable,
    });
  }
  await context.close();

  const text = infos.map((info) =>
    '场景：' + (info.scene.name || info.scene.uuid)
    + '\n设备类型：' + (info.devKind.name || info.devKind.uuid || '（无）')
    + '\n场馆/楼栋：' + (info.building.name || info.building.uuid || '（无）')
    + '\n场地（今日）：\n' + info.courts.map((c) => '  ' + c.siteName + '（' + c.siteUuid + '）').join('\n')
    + '\n今日可约场次：' + info.todayAvailable
  ).join('\n\n');

  return output({
    code: EXIT_OK,
    data: infos.length === 1 ? infos[0] : { matched: infos.length, scenes: infos },
    text,
  }, json);
}

async function cmdSlots(argv) {
  const { args } = parseArgs(argv);
  const json = !!args.json;
  const sceneArg = args.scene;
  if (!sceneArg) return output({ code: EXIT_FAIL, message: '缺少 --scene 参数' }, json);
  const siteFilter = args.site; // 可选：只保留匹配的场地名
  const token = readCachedToken();
  if (!token) return output({ code: EXIT_UNAUTH, message: '未登录，请先运行 login' }, json);
  const context = await getApiClient();

  // 解析场景（可能是多个：西体羽毛球 → 前馆/后馆，合并查询）
  let scenes;
  try {
    scenes = await resolveScenes(context, token, sceneArg);
  } catch (e) {
    await context.close();
    return output({ code: EXIT_FAIL, message: e.message }, json);
  }
  if (!scenes.length) {
    await context.close();
    return output({ code: EXIT_FAIL, message: `找不到场景「${sceneArg}」，请用 sports 查看可用场景名` }, json);
  }

  // 默认从「明天」起查：当天数据含实时占用，响应大且慢（游泳馆当天 ~6s/50KB），预约场景一般关心未来
  const startDate = args.date ? new Date(args.date) : new Date(Date.now() + 24 * 3600 * 1000);
  // 天数：--date 且未给 --days 时只查 1 天；否则 --days 或默认未来 3 天（接口限 1 并发）
  const maxDays = (args.date && args.days == null)
    ? 1
    : Math.min(Math.max(1, parseInt(args.days || String(SLOT_INITIAL_DAYS), 10)), SLOT_MAX_DAYS);
  const dates = [];
  for (let i = 0; i < maxDays; i++) dates.push(fmtDate(new Date(startDate.getTime() + i * 24 * 3600 * 1000)));
  const endDate = new Date(startDate.getTime() + (dates.length - 1) * 24 * 3600 * 1000);

  // 顺序查询（服务端限 1 并发，并行会触发 1610001 限流）：每个场景 = 上下文(缓存) + 各天可约时段
  const perScene = [];
  for (const scene of scenes) {
    const ctx = await getReserveContext(context, token, scene.uuid);
    let slots = [];
    const errs = [];
    for (const ds of dates) {
      const r = await queryDaySlots(context, token, scene, ctx, ds);
      if (isAuthError(r)) { errs.push({ date: ds, errorCode: 1130002, message: '登录过期' }); continue; }
      if (!isOk(r)) { errs.push({ date: ds, errorCode: r.errorCode, message: r.message }); continue; }
      let s = extractAvailableSlots(r.data);
      s.forEach((x) => { x.sceneName = scene.sceneName; x.sceneUuid = scene.uuid; });
      if (siteFilter) s = s.filter((x) => x.siteName === siteFilter || x.siteUuid === siteFilter);
      slots = slots.concat(s);
    }
    perScene.push({ scene, ctx, slots, errs });
  }

  let available = [];
  const errors = [];
  let devKind = '';
  let building = '';
  for (const p of perScene) {
    available = available.concat(p.slots);
    errors.push(...p.errs);
    if (!devKind && p.ctx) { devKind = p.ctx.devKindName; building = p.ctx.buildingName; }
  }

  // 登录过期：整体判失败
  if (errors.some((e) => e.errorCode === 1130002 || (e.message && e.message.includes('登录过期')))) {
    await context.close();
    return output({ code: EXIT_UNAUTH, message: '登录过期，请重新运行 login' }, json);
  }

  // 跨天回退：可约过少时再查跨天（游泳等场景走 CROSS_RESERVE）
  let crossUsed = false;
  if (available.length < SLOT_MIN_AVAILABLE) {
    for (const scene of scenes) {
      const cr = await queryCrossSlots(context, token, scene, startDate, endDate);
      if (isOk(cr)) {
        let cross = extractCrossSlots(cr.data);
        cross.forEach((x) => { x.sceneName = scene.sceneName; x.sceneUuid = scene.uuid; });
        if (siteFilter) cross = cross.filter((x) => x.siteName === siteFilter || x.siteUuid === siteFilter);
        if (cross.length) { crossUsed = true; available = available.concat(cross); }
      }
    }
  }
  // 抽签概览：与普通时段**同时查询**（综体羽毛球晚场等支持抽签的场景；不支持则跳过）
  const lottery = [];
  for (const scene of scenes) {
    const plans = await queryLotteryOverview(context, token, scene.uuid);
    if (plans && plans.length) lottery.push({ sceneUuid: scene.uuid, sceneName: scene.sceneName, plans });
  }
  await context.close();

  const data = {
    sceneArg,
    matchedScenes: scenes.map((s) => ({ uuid: s.uuid, name: s.sceneName })),
    devKind, building,
    range: { start: fmtDate(startDate), end: fmtDate(endDate) },
    queriedDays: dates.length, crossUsed, available, errors,
    lottery,
  };
  let lines = summarizeSlots(available);
  // 单场景时去掉每行的场景名前缀（避免「综体羽毛球 综体羽毛球…」冗余）
  if (scenes.length === 1) {
    const pfx = scenes[0].sceneName + ' ';
    lines = lines.map((l) => (l.startsWith(pfx) ? l.slice(pfx.length) : l));
  }
  const label = scenes.length === 1 ? scenes[0].sceneName : `${scenes.length} 个场景（${scenes.map((s) => s.sceneName).join('、')}）`;
  const lotteryText = lottery.map((L) =>
    `\n【抽签报名 · ${L.sceneName}】\n`
    + L.plans.map((p) => {
        const open = (p.dates || []).filter((d) => d.unAvailableStatus === 0).map((d) => d.date);
        return `  · ${p.title}${p.venue ? `（${p.venue}）` : ''}｜报名身份：${p.ident}${open.length ? `｜可报名：${open.join('、')}` : '｜当前无可报名日期'}`;
      }).join('\n')
    + '\n  规则：提前 7 天 8:00 开报、提前 6 天 22:00 截止，提前 6 天 22:30 出签，中签后提前 3 天 7:00 前缴费'
  ).join('');
  const text = `${label} 可预约时段（${fmtDate(startDate)} ~ ${fmtDate(endDate)}，共 ${available.length} 个场次${crossUsed ? '，含跨天' : ''}）\n`
    + (lines.length ? lines.join('\n') : '（暂无可约时段）')
    + lotteryText
    + (errors.length ? '\n⚠️ 部分查询失败：' + JSON.stringify(errors.slice(0, 5)) : '');
  return output({ code: EXIT_OK, data, text }, json);
}

async function cmdRecommend(argv) {
  const { args } = parseArgs(argv);
  const json = !!args.json;
  const count = Math.max(1, parseInt(args.count || '5', 10)); // 展示几个（默认 5）
  const needText = args.need || args.needs || '';
  const token = readCachedToken();
  if (!token) return output({ code: EXIT_UNAUTH, message: '未登录，请先运行 login' }, json);
  const context = await getApiClient();

  const r = await apiCall(context, token, 'GET', '/api/site/scene/list');
  await context.close();
  if (!isOk(r)) {
    if (isAuthError(r)) return output({ code: EXIT_UNAUTH, message: '登录过期，请重新运行 login' }, json);
    return output({ code: EXIT_FAIL, message: '场景列表失败：' + JSON.stringify(r) }, json);
  }
  let scenes = toArray(r.data);
  // 排除非运动类的辅助场景（深水证/荣誉室/操房/会议室/研讨间/教工之家/训练辅导/体能康复等）
  scenes = scenes.filter((s) => !isAuxiliaryScene(s.sceneName || s.sceneEnName || s.name || ''));
  // --scene 白名单：只从指定运动中抽取
  const sceneFilter = args.scene ? String(args.scene).split(/[,，]/).map((s) => s.trim()).filter(Boolean) : null;
  if (sceneFilter && sceneFilter.length) {
    scenes = scenes.filter((s) => {
      const nm = s.sceneName || s.sceneEnName || s.name || '';
      return sceneFilter.some((k) => nm.includes(k) || s.uuid === k || String(s.id) === k);
    });
  }

  const hotLabel = (lvl) => (lvl >= 3 ? '🔥🔥🔥' : lvl === 2 ? '🔥🔥' : lvl === 1 ? '🔥' : '');

  // 同一运动可能对应多个场景（综体羽毛球/气膜馆羽毛球…），按「运动」聚合后推荐
  const groups = new Map();
  for (const s of scenes) {
    const rawName = s.sceneName || s.sceneEnName || s.name || String(s.uuid || s.id);
    const sport = sportKeyOf(rawName);
    if (!groups.has(sport)) groups.set(sport, []);
    groups.get(sport).push({ name: rawName, uuid: s.uuid || s.id });
  }

  let rows;
  let mode;
  if (needText) {
    // 按需求打分排序
    mode = 'needs-match';
    const need = parseNeeds(needText);
    const scored = [...groups.entries()].map(([sport, scs]) => {
      const attrs = sportAttrsOf(sport);
      const sc = attrs ? scoreSport(attrs, need) : { score: 0, reasons: [] };
      const rep = scs[0] || {};
      return {
        name: sport,
        sceneUuid: rep.uuid,
        scenes: scs.map((x) => x.name),
        score: sc.score,
        reasons: sc.reasons,
        intensity: attrs ? attrs.intensity : null,
        joint: attrs ? attrs.joint : null,
        note: attrs ? attrs.note : '',
        venues: venueInfoOf(sport),
      };
    }).sort((a, b) => b.score - a.score);
    const positive = scored.filter((x) => x.score > 0);
    rows = (positive.length >= count ? positive : scored).slice(0, count);
  } else {
    // 热度加权随机抽取（不放回），以运动为单位
    mode = 'weighted-random';
    const sports = [...groups.keys()];
    const sampled = weightedSample(sports, count, (sport) => popularityOf(sport) + 1);
    rows = sampled.map((sport) => {
      const scs = groups.get(sport) || [];
      const rep = scs[0] || {};
      return {
        name: sport,
        sceneUuid: rep.uuid,
        scenes: scs.map((x) => x.name),
        popularity: popularityOf(sport),
        venues: venueInfoOf(sport),
      };
    });
    rows.sort((a, b) => b.popularity - a.popularity);
  }

  let text;
  if (mode === 'needs-match') {
    const summary = summarizeNeeds(parseNeeds(needText));
    const matched = rows.filter((r) => r.score > 0).length;
    text = `根据你的需求（${summary}）推荐 ${rows.length} 个运动：\n`
      + rows.map((row) => {
          const why = row.reasons.length ? row.reasons.join('、') : '';
          const tag = row.score > 0 ? (why ? `（匹配：${why}）` : '') : '（备选）';
          const info = [row.note, row.venues].filter(Boolean).join('｜');
          return `  · ${row.name}${tag}${info ? ` —— ${info}` : ''}`;
        }).join('\n')
      + (matched < rows.length ? `\n（其中 ${matched} 个完全匹配你的需求，其余为当前可预约的其它运动，作备选）` : '')
      + '\n（告诉我具体运动，我帮你查可预约时段；想调整可重新描述需求）';
  } else {
    text = `为你随机推荐 ${rows.length} 个运动（按热度加权随机抽取，非实时可约量；告诉我具体运动，我帮你查可预约时段）：\n`
      + rows.map((row) => `  · ${row.name}${row.popularity ? `（热度L${row.popularity}${hotLabel(row.popularity)}）` : ''}${row.venues ? ` —— ${row.venues}` : ''}`).join('\n');
  }

  return output({
    code: EXIT_OK,
    data: {
      count: rows.length,
      mode,
      need: needText || undefined,
      note: needText ? '按需求关键词打分排序（运动属性库：强度/关节冲击/目标/室内外/人数/价格）' : '按热度加权随机抽取（非实时可约量），预约前请用 slots 确认',
      recommendations: rows,
    },
    text,
  }, json);
}

async function cmdOrders(argv) {
  const { args } = parseArgs(argv);
  const json = !!args.json;
  const uuid = args.uuid || '';
  const token = readCachedToken();
  if (!token) return output({ code: EXIT_UNAUTH, message: '未登录，请先运行 login' }, json);
  const context = await getApiClient();
  const r = await apiCall(context, token, 'POST', '/api/reserve/reserveRecord', {}, { pageNum: 1, pageSize: 50 });
  await context.close();
  if (!isOk(r)) {
    if (isAuthError(r)) return output({ code: EXIT_UNAUTH, message: '登录过期，请重新运行 login' }, json);
    return output({ code: EXIT_FAIL, message: '查询预约记录失败：' + JSON.stringify(r) }, json);
  }
  const arr = toArray(r.data);
  if (uuid) {
    const found = arr.find((o) => o.resvUuid === uuid);
    if (!found) return output({ code: EXIT_FAIL, message: `未找到 resvUuid=${uuid} 的订单` }, json);
    return output({ code: EXIT_OK, data: found }, json);
  }
  return output({ code: EXIT_OK, data: arr }, json);
}

/** 取消预约：封装 /api/reserve/cancelReserve（body 传 resvUuid；已实测成功取消） */
async function cmdCancel(argv) {
  const { args } = parseArgs(argv);
  const json = !!args.json;
  const uuid = args.uuid || args['resv-uuid'] || args.id || '';
  if (!uuid) return output({ code: EXIT_FAIL, message: '缺少 --uuid 参数（预约记录的 resvUuid，用 orders 查看）' }, json);
  const token = readCachedToken();
  if (!token) return output({ code: EXIT_UNAUTH, message: '未登录，请先运行 login' }, json);
  const context = await getApiClient();
  const body = { resvUuid: uuid };
  if (!args.yes) {
    await context.close();
    return output({
      code: EXIT_OK,
      data: { dryRun: true, body, note: '确认取消请加 --yes（已实测成功取消）' },
      text: `【预演，未提交】将取消预约 resvUuid=${uuid}（POST /api/reserve/cancelReserve）。确认请加 --yes。`,
    }, json);
  }
  const r = await apiCallWithRetry(context, token, 'POST', '/api/reserve/cancelReserve', {}, body);
  await context.close();
  if (!isOk(r)) return output({ code: EXIT_FAIL, message: '取消失败：' + JSON.stringify(r) }, json);
  return output({ code: EXIT_OK, data: { success: true }, text: '✅ 取消预约成功' }, json);
}

/**
 * 查询「未生效（未来）」订单（resvStatus=RESV_UNEFFECT）。预约前调用：
 * 实测发现 reserveRecord 里没有明确的「已支付」标志（paidAmount 是「应付金额」，恒非 0），
 * 而「待支付」订单必然处于「未生效（未来）」状态，故用 RESV_UNEFFECT 作为提醒信号。
 */
async function findFutureOrders(context, token) {
  const r = await apiCall(context, token, 'POST', '/api/reserve/reserveRecord', {}, { pageNum: 1, pageSize: 50 });
  if (!isOk(r)) return [];
  return toArray(r.data).filter((o) => o.resvStatus === 'RESV_UNEFFECT');
}

/**
 * 纯 API 预约（无浏览器、无人机验证）：查时段 → 取表单 → 构建 addReserve body。
 * 前端实测（timeform 页）addReserve 无 captcha 字段；羽毛球等简单场景表单为「通用数据表单」（fields 为空）。
 * --yes 才真正提交；提交成功后自动打开预约记录页（付款窗口）。
 */
async function cmdReserveApi(argv) {
  const { args } = parseArgs(argv);
  const json = !!args.json;
  const sceneArg = args.scene;
  const dateStr = args.date || '';
  const timeStr = args.time || '';
  if (!sceneArg || !dateStr || !timeStr) {
    return output({ code: EXIT_FAIL, message: '缺少参数：reserve-api --scene <名称|uuid> --date YYYY-MM-DD --time HH:mm [--yes --captcha <token>]' }, json);
  }
  const token = readCachedToken();
  if (!token) return output({ code: EXIT_UNAUTH, message: '未登录，请先运行 login' }, json);

  const context = await getApiClient();
  // 0) 预约前检查：存在「未生效（未来）」订单时，若有未支付会拒绝新预约（提醒，不硬拦）
  const future = await findFutureOrders(context, token);
  if (future.length) {
    const list = future.map((o) => `${o.sceneName} ${o.resvTime && o.resvTime.startTime}`).join('、');
    if (!json) console.log(`⚠️ 你有未生效的未来订单（${list}）。若其中存在未支付订单，系统会拒绝新预约；请先支付（pay）或取消（cancel --uuid <resvUuid> --yes）。`);
  }
  // 1) 解析场景 + 当前用户（resvMember 用）
  let scenes;
  try { scenes = await resolveScenes(context, token, sceneArg); }
  catch (e) { await context.close(); return output({ code: EXIT_FAIL, message: e.message }, json); }
  if (!scenes.length) { await context.close(); return output({ code: EXIT_FAIL, message: `找不到场景「${sceneArg}」` }, json); }
  const me = await apiCall(context, token, 'GET', '/system/login/getLoginUser');
  const user = isOk(me) ? me.data : null;

  // 2) 找目标日期 + 开始时间的可约场次
  let picked = null;
  for (const scene of scenes) {
    const ctx = await getReserveContext(context, token, scene.uuid);
    const page = await queryDaySlots(context, token, scene, ctx, dateStr);
    if (!isOk(page) || !Array.isArray(page.data)) continue;
    for (const site of page.data) {
      for (const sess of (site.sessionVo || [])) {
        const st = sess.reserveStatus || {};
        if (st.reserveStatus !== 'Y') continue;
        if (sess.beginTime !== timeStr) continue;
        picked = {
          scene, ctx, site, sess,
          reserveTime: [{ startTime: `${dateStr} ${sess.beginTime}:00`, endTime: `${dateStr} ${sess.endTime}:00` }],
        };
        break;
      }
      if (picked) break;
    }
    if (picked) break;
  }
  if (!picked) {
    await context.close();
    return output({ code: EXIT_FAIL, message: `${dateStr} ${timeStr} 无可约场次（可能已满或不在放票时间）` }, json);
  }

  // 3) 取表单 deployUuid（羽毛球等简单场景 = 通用数据表单，fields 为空）
  const formUuid = (picked.site.formRuleVo && picked.site.formRuleVo.formUuid) || '';
  let deployUuid = '';
  if (formUuid) {
    const brief = await apiCall(context, token, 'GET', `/workflow/process/brief/${formUuid}`);
    if (isOk(brief) && brief.data) deployUuid = brief.data.deployUuid || '';
  }

  // 4) 构建 addReserve body（已按 F12 实测报文校准；含滑块验证码 captcha 字段）
  const rt = picked.reserveTime[0];
  const body = {
    sceneUuid: picked.scene.uuid,
    sceneUseType: picked.ctx.sceneUseType || 'SPORT_GROUP',
    siteUuid: picked.site.uuid,
    siteType: picked.site.siteType || 'DEV',
    reserveTime: picked.reserveTime,
    siteSessionReserve: [{ sessionDetailUuid: picked.sess.uuid, reserveTime: { startTime: rt.startTime, endTime: rt.endTime } }],
    resvMember: user ? [user.id] : [],
    resvKind: 'CURRENT_RESERVE',
    payType: 'PAY_ONLINE',
    purchaseUuid: '',
    formParam: { formId: formUuid, deployUuid, variables: {}, chooseCandidates: {} },
    captcha: args.captcha || '',
  };
  await context.close();

  if (!args.yes) {
    return output({
      code: EXIT_OK,
      data: { dryRun: true, sceneName: picked.scene.sceneName, reserveTime: picked.reserveTime, body },
      text: `【预演，未提交】将预约：${picked.scene.sceneName} ${dateStr} ${timeStr}~${picked.sess.endTime}\n${JSON.stringify(body, null, 2)}\n（真正提交需 --yes 且带 --captcha <滑块验证码token>，token 由完成人机验证后取得）`,
    }, json);
  }

  // 5) 真正提交（必须有滑块验证码 token）
  if (!args.captcha) {
    return output({ code: EXIT_FAIL, message: '提交预约需要 --captcha <滑块验证码token>（前端有 blockPuzzle 人机验证，无法纯 API 绕过）' }, json);
  }
  const c2 = await getApiClient();
  const r = await apiCallWithRetry(c2, token, 'POST', '/api/reserve/addReserve', {}, body);
  await c2.close();
  if (!isOk(r)) return output({ code: EXIT_FAIL, message: '预约提交失败：' + JSON.stringify(r) }, json);

  // 6) 打开付款窗口（预约记录页）
  if (!json) console.log('✅ 预约已提交成功，正在打开预约记录页完成支付…');
  const browser = await launchContext(false);
  const page = await browser.newPage();
  await page.goto(VENUE_URL + '#/reservationlist', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  if (!json) console.log('请找到刚提交的订单，点「去支付」完成扫码支付。按 Ctrl+C 或关闭浏览器结束。');
  await page.waitForTimeout(30 * 60 * 1000).catch(() => {});
  await browser.close();
  return output({ code: EXIT_OK, data: { success: true, reserve: r.data }, text: '已提交并打开付款页' }, json);
}

// ---------------------------------------------------------------------------
// 交互式浏览器命令（预约 / 支付 / 打开）
// ---------------------------------------------------------------------------
async function cmdReserve(argv) {
  const { args } = parseArgs(argv);
  const json = !!args.json;
  const sceneArg = args.scene;
  const dateStr = args.date || '';   // 可选，如 2026-08-30
  const timeStr = args.time || '';   // 可选，开始时间，如 20:00
  if (!sceneArg) return output({ code: EXIT_FAIL, message: '缺少 --scene 参数' }, json);

  const token = readCachedToken();
  if (!token) return output({ code: EXIT_UNAUTH, message: '未登录，请先运行 login' }, json);

  // 0) 预约前提醒：存在「未生效（未来）」订单时，若未支付会拒绝新预约
  const ctx = await getApiClient();
  try {
    const future = await findFutureOrders(ctx, token);
    if (future.length) {
      const list = future.map((o) => `${o.sceneName} ${o.resvTime && o.resvTime.startTime}`).join('、');
      if (!json) console.log(`⚠️ 你有未生效的未来订单（${list}）。若其中有未支付订单，系统会拒绝新预约；请先支付或取消。`);
    }
  } catch { /* 检查失败不影响预约 */ }

  // 1) 解析场景 uuid（纯 API，无浏览器）；多场景时按目标日期+时段定位到有可约时段的那个
  let sceneUuid = sceneArg;
  let sceneName = sceneArg;
  try {
    const scenes = await resolveScenes(ctx, token, sceneArg);
    if (!scenes.length) {
      throw new Error(`找不到场景「${sceneArg}」，请用 sports 查看可用场景名`);
    }
    if (scenes.length === 1) {
      sceneUuid = scenes[0].uuid;
      sceneName = scenes[0].sceneName;
    } else if (dateStr && timeStr) {
      // 多个场景（如「西体羽毛球」→ 前馆/后馆）：查哪个场景该日期时段可约
      let picked = null;
      for (const s of scenes) {
        const c = await getReserveContext(ctx, token, s.uuid);
        const page = await queryDaySlots(ctx, token, s, c, dateStr);
        if (isOk(page)) {
          if (extractAvailableSlots(page.data).some((x) => x.beginTime === timeStr)) { picked = s; break; }
        }
      }
      if (picked) { sceneUuid = picked.uuid; sceneName = picked.sceneName; }
      else {
        throw new Error(`「${sceneArg}」匹配多个场景，但 ${dateStr} ${timeStr} 均无可约时段，请用 slots 确认后再试`);
      }
    } else {
      throw new Error(`「${sceneArg}」匹配到多个场景（${scenes.map((s) => s.sceneName).join('、')}），请指定具体场景名（如「西体羽毛球(后馆)」）`);
    }
  } catch (e) {
    await ctx.close();
    return output({ code: EXIT_FAIL, message: e.message }, json);
  }
  await ctx.close();
  if (!json) console.log(`已定位到场景：${sceneName}`);

  // 2) 打开浏览器到预约页（模拟网页操作）
  const browser = await launchContext(false);
  const page = await browser.newPage();
  await page.goto(`${VENUE_URL}#/reserveList?uuid=${encodeURIComponent(sceneUuid)}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

  // 3) 自动点选日期：轮询等到目标日期文本真正出现（页面异步加载较慢）
  if (dateStr) {
    const mmdd = dateStr.slice(5).replace(/-/g, '.');
    let ok = false;
    try {
      // 等日期变为「可用」（非 disabled）且文本匹配
      await page.waitForFunction((mmdd) => {
        const items = document.querySelectorAll('.date-item');
        for (const it of items) {
          if (it.classList.contains('disabled')) continue;
          const span = it.querySelector('span');
          const t = ((span ? span.textContent : '') || '').trim();
          if (t.includes(mmdd)) return true;
        }
        return false;
      }, mmdd, { timeout: 30000, polling: 500 });
      ok = await page.evaluate((mmdd) => {
        const items = document.querySelectorAll('.date-item');
        for (const it of items) {
          if (it.classList.contains('disabled')) continue;
          const span = it.querySelector('span');
          const t = ((span ? span.textContent : '') || '').trim();
          if (t.includes(mmdd)) { it.click(); return true; }
        }
        return false;
      }, mmdd);
    } catch { /* 超时 */ }
    if (!json) console.log(ok ? `✅ 已点选日期 ${mmdd}` : `⚠️ 未找到可用日期 ${mmdd}（已等 30s），请手动点选`);
    await page.waitForTimeout(1000);
  }

  // 4) 自动点选时段：点完日期后，等时段渲染出来再点（游泳用 .siteList，羽毛球用 .time）
  if (timeStr) {
    let ok = false;
    try {
      await page.waitForFunction((time) => {
        const els = document.querySelectorAll('.siteList, .time');
        for (const el of els) {
          if (el.classList.contains('time-disabled') || el.classList.contains('disabled')) continue;
          const t = (el.textContent || '').trim();
          if (t.startsWith(time)) return true;
        }
        return false;
      }, timeStr, { timeout: 20000, polling: 500 });
      ok = await page.evaluate((time) => {
        const els = document.querySelectorAll('.siteList, .time');
        for (const el of els) {
          if (el.classList.contains('time-disabled') || el.classList.contains('disabled')) continue;
          const t = (el.textContent || '').trim();
          if (t.startsWith(time)) { el.click(); return true; }
        }
        return false;
      }, timeStr);
    } catch { /* 超时 */ }
    if (!json) console.log(ok ? `✅ 已点选时段 ${timeStr}` : `⚠️ 未找到可约时段 ${timeStr}，请手动点选`);
    await page.waitForTimeout(1000);
  }

  // 5) 点击「预约」按钮触发人机验证（选完场次后按钮变为可用）
  {
    let ok = false;
    try {
      await page.waitForFunction(() => {
        const btn = document.querySelector('.btn:not(.btn-disabled)');
        return !!btn;
      }, null, { timeout: 10000, polling: 500 });
      await page.evaluate(() => {
        const btn = document.querySelector('.btn:not(.btn-disabled)');
        if (btn) btn.click();
        return !!btn;
      });
      ok = true;
    } catch { /* 未找到可用按钮 */ }
    if (!json) console.log(ok ? '✅ 已点击「预约」按钮' : '⚠️ 未找到可用的「预约」按钮，请手动点击');
  }

  // 6) 后续（人机验证 → 提交 → 支付）交给用户完成
  if (!json) {
    console.log('请继续自行完成：人机验证 → 提交预约 → 支付。');
    console.log('按 Ctrl+C 或关闭浏览器结束。');
  }
  await page.waitForTimeout(30 * 60 * 1000).catch(() => {});
  await browser.close();
  return output({ code: EXIT_OK, data: { opened: `#/reserveList?uuid=${sceneUuid}`, date: dateStr, time: timeStr }, text: '已结束' }, json);
}

async function cmdOpen(argv) {
  const { args } = parseArgs(argv);
  const json = !!args.json;
  const context = await launchContext(false);
  const page = await context.newPage();
  // 统一成 #/xxx 形式（去掉开头 #，确保以 / 开头）
  let h = String(args.url || '/home').replace(/^#/, '');
  if (!h.startsWith('/')) h = '/' + h;
  const route = '#' + h;
  await page.goto(VENUE_URL + route, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  if (!json) {
    console.log('浏览器已打开（' + route + '）。按 Ctrl+C 或关闭浏览器结束。');
  }
  await page.waitForTimeout(30 * 60 * 1000).catch(() => {});
  await context.close();
  return output({ code: EXIT_OK, data: { opened: route }, text: '已结束' }, json);
}

async function cmdPay(argv) {
  const { args } = parseArgs(argv);
  const json = !!args.json;
  const context = await launchContext(false);
  const page = await context.newPage();
  await page.goto(VENUE_URL + '#/reservationlist', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  if (!json) console.log('已打开“预约记录”页。请找到待支付订单，点击“去支付”完成微信/支付宝扫码支付。');
  await page.waitForTimeout(30 * 60 * 1000).catch(() => {});
  await context.close();
  return output({ code: EXIT_OK, data: { opened: '#/reservationlist' }, text: '已结束' }, json);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
const commands = {
  setup: cmdSetup,
  login: cmdLogin,
  status: cmdStatus,
  sports: cmdSports,
  sites: cmdSites,
  slots: cmdSlots,
  recommend: cmdRecommend,
  orders: cmdOrders,
  cancel: cmdCancel,
  'reserve-api': cmdReserveApi,
  reserve: cmdReserve,
  pay: cmdPay,
  open: cmdOpen,
  lottery: cmdLottery,
  'lottery-open': cmdLotteryOpen,
};

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || !commands[cmd]) {
    console.log('可用命令：' + Object.keys(commands).join(', '));
    console.log('退出码：0=成功；1=失败；2=未登录。详见脚本头部注释或 SKILL.md。');
    process.exit(cmd ? 1 : 0);
  }
  try {
    await commands[cmd](rest);
  } catch (e) {
    console.error('[错误] ' + (e && e.message ? e.message : e));
    process.exit(1);
  }
})();
