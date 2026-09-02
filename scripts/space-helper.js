#!/usr/bin/env node
/**
 * 清华大学图书馆 IC 空间预约 —— 辅助脚本
 *
 * 用法（在 skill 根目录下执行）：
 *   node scripts/space-helper.js setup                          # 一键准备环境（建 package.json → 装 playwright → 按需装浏览器）
 *   node scripts/space-helper.js login [--force] [--email <邮箱>]     # 弹出浏览器完成统一身份认证(SSO)登录（--force 重新登录；--email 未绑定时自动绑定）
 *   node scripts/space-helper.js bind-email --email <邮箱>            # 绑定邮箱（预约前通常需要）
 *   node scripts/space-helper.js status                         # 检查登录状态
 *   node scripts/space-helper.js menu [--json]                  # 列出空间类型（研讨间/座位/考研座位/活动/外借设备）
 *   node scripts/space-helper.js rooms --type <类型|uuid> [--json]  # 列出某类型下的房间/区域
 *   node scripts/space-helper.js slots --room <名称|uuid> [--date <日期>] [--json]  # 列出可预约时段（--date 支持 明天/9月12日 等）
 *   node scripts/space-helper.js orders [--begin 日期] [--end 日期] [--json]  # 列出我的预约记录（默认近30天~未来30天；含 uuid 与预约号）
 *   node scripts/space-helper.js detail --uuid <uuid|预约号>    # 查看单条预约详情（成员/设备/备注）
 *   node scripts/space-helper.js cancel --uuid <uuid|预约号> [--yes]  # 取消预约（默认预演，加 --yes 才真正取消）
 *   node scripts/space-helper.js reserve --room <类型名> [--dev <房间名>] [--date <日期>] [--time HH:mm] [--end HH:mm] [--members 学号1,学号2] [--yes]  # 纯 API 预约（默认预演，--yes 才提交；--browser 回退浏览器 UI）
 *   node scripts/space-helper.js open [--url <hash路由>]        # 打开 IC 空间网站（有头浏览器）
 *
 * 通用选项：
 *   --json      输出机器可读的 JSON（单行），便于 agent 稳定解析
 *
 * 退出码：0=成功；1=失败；2=未登录/登录过期
 *
 * 依赖说明：数据查询命令（status/menu/rooms/slots/orders）与纯 API 预约（reserve）用 Node 内置 fetch，零依赖、不装 playwright；
 *           仅 login/open 需要 playwright（浏览器），按下面 setup 准备一次即可；reserve 加 --browser 才走浏览器 UI。
 *
 * 与体育场馆系统不同：本系统无请求签名、无 AES 响应加密，只需 token + lan 请求头 + Cookie，响应直接 JSON.parse。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const cryptoLib = require('./lib/crypto'); // 会话文件加密（最小改动，防文件被拷走；storage-state/browser-profile 暂不加密）

const SITE_URL = 'https://cab.lib.tsinghua.edu.cn/';
const HOME_HASH = '#/ic/home';
const API_BASE = 'https://cab.lib.tsinghua.edu.cn/ic-web';
const DEFAULT_MIRROR = 'https://npmmirror.com/mirrors/playwright/';

const PROFILE_DIR = process.env.THU_LIB_PROFILE || path.join(os.homedir(), '.thu-lib-space', 'browser-profile');
const TOKEN_FILE = process.env.THU_LIB_TOKEN || path.join(os.homedir(), '.thu-lib-space', 'token.json');
const STORAGE_STATE_FILE = process.env.THU_LIB_STORAGE || path.join(os.homedir(), '.thu-lib-space', 'storage-state.json');
const ROOM_MENU_CACHE_FILE = process.env.THU_LIB_MENU_CACHE || path.join(os.homedir(), '.thu-lib-space', 'room-menu-cache.json');
const ROOM_MENU_CACHE_TTL = 60 * 60 * 1000; // roomMenu 缓存 1 小时（房间类型基本不变）
const SKILL_ROOT = path.resolve(__dirname, '..');

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_UNAUTH = 2;

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
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
  // 输出脱敏：任何 token/cookie/jwt 都替换为 <redacted>，避免泄漏到 stdout/stderr/日志
  const scr = (s) => {
    const t = readTokenFile();
    return cryptoLib.scrub(s, [t && t.token, loadCookieHeader()]);
  };
  if (json) {
    const o = { ok: result.code === EXIT_OK, code: result.code };
    if (result.message !== undefined) o.message = result.message;
    if (result.data !== undefined) o.data = result.data;
    console.log(scr(JSON.stringify(o)));
  } else {
    if (result.code !== EXIT_OK) console.error(scr('[错误] ' + (result.message || '失败')));
    else if (result.text !== undefined) console.log(scr(result.text));
    else if (result.data !== undefined) console.log(scr(JSON.stringify(result.data, null, 2)));
  }
  process.exit(result.code);
}

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 解析用户指定的日期（自然语言/各种格式）→ "YYYY-MM-DD"；无法识别返回空串 */
function parseDateArg(input) {
  if (!input) return '';
  const s = String(input).trim();
  const today = new Date();
  const day = (n) => fmtDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + n));

  // 已含年份：YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD
  let m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})[日号]?$/);
  if (m) return `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`;
  // M月D日 / M-D / M.D / M/D（不带年份，默认今年；若已过去则顺延到明年，避免跨年踩坑）
  m = s.match(/^(\d{1,2})[-/.月](\d{1,2})[日号]?$/);
  if (m) {
    const mm = +m[1] - 1, dd = +m[2];
    const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    let d = new Date(today.getFullYear(), mm, dd);
    if (d < todayMid) d = new Date(today.getFullYear() + 1, mm, dd);
    return fmtDate(d);
  }
  // 今天/明天/后天/大后天
  if (/^(今天|今日|now|today)$/i.test(s)) return day(0);
  if (/^(明天|明日|tomorrow|tom)$/i.test(s)) return day(1);
  if (/^(后天|後天)$/i.test(s)) return day(2);
  if (/^大后天$/.test(s)) return day(3);
  // 周X（取本周/下一周最近的该天）
  m = s.match(/^周([一二三四五六日天])$/);
  if (m) {
    const wk = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
    const target = wk[m[1]];
    const cur = today.getDay() || 7;
    let diff = target - cur;
    if (diff <= 0) diff += 7;
    return day(diff);
  }
  return '';
}

/** 若日期已过去（如填错年份），返回警告串，否则空串 */
function pastDateWarn(dateArg) {
  const m = String(dateArg || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  const todayMid = new Date();
  todayMid.setHours(0, 0, 0, 0);
  return d < todayMid ? `⚠️ ${dateArg} 是过去日期（若年份填错请改正）` : '';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readTokenFile() {
  try {
    const o = JSON.parse(cryptoLib.decrypt(fs.readFileSync(TOKEN_FILE, 'utf8')));
    if (o && cryptoLib.isExpired(o.updatedAt)) { try { fs.unlinkSync(TOKEN_FILE); } catch {} return null; }
    return o;
  } catch { return null; }
}
function writeTokenFile(obj) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, cryptoLib.encrypt(JSON.stringify(obj, null, 2)));
}

/** roomMenu 缓存（房间类型基本不变，缓存 1 小时，省去重复请求） */
function readRoomMenuCache() {
  try {
    const c = JSON.parse(fs.readFileSync(ROOM_MENU_CACHE_FILE, 'utf8'));
    if (c && c.cachedAt && (Date.now() - c.cachedAt) < ROOM_MENU_CACHE_TTL && Array.isArray(c.data)) return c.data;
  } catch {}
  return null;
}
function writeRoomMenuCache(data) {
  try {
    fs.mkdirSync(path.dirname(ROOM_MENU_CACHE_FILE), { recursive: true });
    fs.writeFileSync(ROOM_MENU_CACHE_FILE, JSON.stringify({ data, cachedAt: Date.now() }));
  } catch {}
}

/** 获取 roomMenu（优先缓存，加 --refresh 强制刷新） */
async function getRoomMenu(context, token, refresh) {
  if (!refresh) {
    const cached = readRoomMenuCache();
    if (cached) return cached;
  }
  const r = await apiCall(context, token, 'GET', 'roomMenu');
  if (isOk(r) && Array.isArray(r.data)) {
    writeRoomMenuCache(r.data);
    return r.data;
  }
  return readRoomMenuCache() || [];
}

/** 最小化用户信息：只保留学号/账号、姓名；不存 token、手机号/邮箱/卡号/身份证等敏感字段（token 仅在 token.json 顶层单独存，用于会话复用，不出现在输出里） */
function minimalUserInfo(info) {
  if (!info || typeof info !== 'object') return null;
  return {
    logonName: info.logonName || info.account || '',
    accNo: info.accNo || '',
    trueName: info.trueName || info.nickName || info.name || '',
  };
}

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

// ---------------------------------------------------------------------------
// API 客户端（无浏览器，零 playwright 依赖，Node 内置 fetch）
// ---------------------------------------------------------------------------
/** 判断是否成功：code==0 */
function isOk(body) {
  return body && body.code === 0;
}

/** 判断是否「未登录/登录过期」：code==300 */
function isAuthError(body) {
  return body && body.code === 300;
}

/** 是否有效邮箱地址（用于判断「已绑定」；系统可能带入按学号生成的默认串，非有效邮箱则视为未绑定） */
function isValidEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());
}

/** 邮箱脱敏：保留首字符与域名，中间打码（用于 --json，避免日志泄露完整邮箱） */
function maskEmail(e) {
  const s = String(e || '').trim();
  if (!s) return '';
  const at = s.indexOf('@');
  if (at <= 0) return s[0] + '***';
  const name = s.slice(0, at);
  const domain = s.slice(at);
  return name[0] + '***' + domain;
}

/** 把接口返回的 data 归一化成数组（data 可能是数组，或 {list, records, ...}） */
function toArray(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.list)) return data.list;
  if (data && Array.isArray(data.records)) return data.records;
  if (data && Array.isArray(data.dataList)) return data.dataList;
  if (data && Array.isArray(data.rows)) return data.rows;
  return [];
}

/**
 * 创建「无浏览器、无 playwright 依赖」的 API 客户端。
 * 返回与浏览器 context 相同的 { request, close } 形态。
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

/** 发起带 token/lan 头的 API 调用，返回 JSON（本系统明文，无需解密） */
async function apiCall(context, token, method, pathname, params, data) {
  const headers = { 'lan': '1' };
  if (token) headers['token'] = token;
  if (data) headers['Content-Type'] = 'application/json';
  const resp = await context.request.fetch(API_BASE + '/' + pathname, {
    method,
    headers,
    params: params || {},
    data: data || undefined,
  });
  const text = await resp.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { code: -1, message: '响应非 JSON: ' + String(text).slice(0, 120), raw: text }; }
  return body;
}

/**
 * 读取账号已绑定的邮箱/手机。
 * 注意：个人中心「个人信息」页的邮箱/手机来自 GET /account/info（本函数），
 * 而 auth/userInfo 的 email 是 SSO 带入的默认值（可能非空但并非绑定记录），不可作为绑定依据。
 */
async function getAccountBinding(context, token) {
  const r = await apiCall(context, token, 'GET', 'account/info');
  if (!isOk(r)) return { ok: false, email: '', handPhone: '', emailBound: false, phoneBound: false, r };
  const d = r.data || {};
  const email = String(d.email || '').trim();
  const handPhone = String(d.handPhone || '').trim();
  return { ok: true, email, handPhone, emailBound: isValidEmail(email), phoneBound: handPhone.length >= 5, r };
}

// ---------------------------------------------------------------------------
// Playwright 封装
// ---------------------------------------------------------------------------
let _pw = null;
function playwright() {
  if (!_pw) {
    try { _pw = require('playwright'); }
    catch (e) {
      console.error('[错误] 未安装 playwright（仅 login/reserve/open 等浏览器命令需要，数据查询命令不依赖它）。');
      console.error('  请先执行： node scripts/space-helper.js setup');
      process.exit(1);
    }
  }
  return _pw;
}

const PROFILE_LOCK_FILE = PROFILE_DIR + '.lock';
function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

async function acquireProfileLock(timeoutMs = 180000) {
  fs.mkdirSync(path.dirname(PROFILE_LOCK_FILE), { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(PROFILE_LOCK_FILE, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      if (!process.__thuLibProfileLockRegistered) {
        process.__thuLibProfileLockRegistered = true;
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

async function launchContext(headless) {
  await acquireProfileLock();
  const { chromium } = playwright();
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const base = {
    headless: !!headless,
    viewport: { width: 1280, height: 800 },
    locale: 'zh-CN',
  };
  const channels = ['chrome', 'msedge'];
  let lastErr = null;
  for (const channel of channels) {
    try {
      return await chromium.launchPersistentContext(PROFILE_DIR, { ...base, channel });
    } catch (e) { lastErr = e; }
  }
  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, base);
  } catch (e) {
    if (/EPERM|permission|not permitted/i.test(String((e && e.message) || (lastErr && lastErr.message) || ''))) {
      console.error('[错误] 启动浏览器被沙箱拦截（spawn EPERM）：系统 Chrome/Edge 存在但无法启动。请下次运行前先以更宽权限（danger-full-access）提权再运行；不要安装 Chromium。');
      throw lastErr || e;
    }
    console.error('[错误] 未能启动浏览器。请确认已安装 Google Chrome 或 Microsoft Edge，');
    console.error('  或执行： node scripts/space-helper.js setup --with-chromium');
    throw lastErr || e;
  }
}

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

/** 从浏览器 sessionStorage 读取 userInfo.token（值为 JSON 字符串，需 parse） */
async function readTokenFromPage(page) {
  return page.evaluate(() => {
    try {
      const ui = sessionStorage.getItem('userInfo');
      if (!ui) return null;
      const u = JSON.parse(ui);
      return (u && u.token) || null;
    } catch { return null; }
  });
}

/** 打开首页并等待；返回 token（未登录返回 null） */
async function ensureToken(context, { waitMs = 5000 } = {}) {
  const page = await context.newPage();
  try {
    await page.goto(SITE_URL + HOME_HASH, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(waitMs);
    const token = await readTokenFromPage(page);
    if (token) {
      const info = await page.evaluate(() => {
        try { return JSON.parse(sessionStorage.getItem('userInfo') || 'null'); } catch { return null; }
      });
      writeTokenFile({ token, userInfo: minimalUserInfo(info), updatedAt: new Date().toISOString() });
    }
    return token;
  } finally {
    await page.close().catch(() => {});
  }
}

/** 依次检查 Chrome / Edge 是否已有登录会话，命中则保存并返回 { token, channel } */
async function checkExistingLogin() {
  const { chromium } = playwright();
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  for (const channel of ['chrome', 'msedge']) {
    let context = null;
    try {
      context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: true, channel });
      const page = await context.newPage();
      await page.goto(SITE_URL + HOME_HASH, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      // 等 sessionStorage.userInfo 出现（最多 4s），命中立即返回，不再固定等 3.5s
      await page.waitForFunction(() => {
        try { const v = sessionStorage.getItem('userInfo'); if (v) { const u = JSON.parse(v); return !!(u && u.token); } } catch {}
        return false;
      }, null, { timeout: 4000 }).catch(() => {});
      const token = await readTokenFromPage(page);
      if (token) {
        const info = await page.evaluate(() => {
          try { return JSON.parse(sessionStorage.getItem('userInfo') || 'null'); } catch { return null; }
        });
        writeTokenFile({ token, userInfo: minimalUserInfo(info), updatedAt: new Date().toISOString() });
        try { fs.writeFileSync(STORAGE_STATE_FILE, JSON.stringify(await context.storageState(), null, 2)); } catch {}
        return { token, channel };
      }
    } catch { /* 该浏览器不可用或无会话 */ }
    finally { if (context) await context.close().catch(() => {}); }
  }
  return null;
}

// ---------------------------------------------------------------------------
// setup：环境准备
// ---------------------------------------------------------------------------
function runShell(cmdline, { env = {} } = {}) {
  const e = { ...process.env };
  delete e.npm_config_allow_scripts;      // 移除 allow-scripts 白名单，否则 npm 11 抛 EALLOWSCRIPTS
  delete e.NPM_CONFIG_ALLOW_SCRIPTS;
  Object.assign(e, env);
  const r = spawnSync(cmdline, { stdio: 'inherit', shell: true, cwd: SKILL_ROOT, env: e });
  return r.status === 0;
}

function ensurePackageJson() {
  const pkgPath = path.join(SKILL_ROOT, 'package.json');
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { pkg = {}; }
  if (typeof pkg !== 'object' || Array.isArray(pkg)) pkg = {};
  if (!pkg.name) pkg.name = 'thu-lib-space-reserve';
  if (!pkg.version) pkg.version = '1.1.0';
  pkg.private = true;
  const prev = (pkg.allowScripts && typeof pkg.allowScripts === 'object' && !Array.isArray(pkg.allowScripts)) ? pkg.allowScripts : {};
  pkg.allowScripts = { ...prev, playwright: true };
  // 固定 playwright 版本（避免安装时拉到不同版本）
  if (!pkg.dependencies || typeof pkg.dependencies !== 'object' || Array.isArray(pkg.dependencies)) pkg.dependencies = {};
  pkg.dependencies.playwright = '1.62.1';
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
    if (!runShell('npm install')) {
      return output({ code: EXIT_FAIL, message: 'npm install 失败，请检查网络或手动执行' }, json);
    }
    steps.push('playwright');

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
  return output({ code: EXIT_OK, data: { ok: true, steps }, text: '✅ setup 完成。下一步： node scripts/space-helper.js login' }, json);
}

// ---------------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------------
/** 清除本地软会话（token/cookie/缓存/锁），不删除浏览器 profile（避免启动失败时丢失会话） */
function clearLocalSession() {
  try { fs.unlinkSync(TOKEN_FILE); } catch {}
  try { fs.unlinkSync(STORAGE_STATE_FILE); } catch {}
  try { fs.unlinkSync(ROOM_MENU_CACHE_FILE); } catch {}
  try { fs.unlinkSync(PROFILE_DIR + '.lock'); } catch {}
  // 不删 PROFILE_DIR：浏览器 profile 会话保留，改为登录成功后在浏览器内清 session（见 cmdLogin）
}

async function cmdLogin(argv) {
  const { args } = parseArgs(argv);
  const json = !!args.json;
  const force = !!args.force || !!args.relogin || !!args['re-login'] || !!args.fresh;

  // 强制重新登录：清空本地会话后直接打开浏览器（跳过 token 复用/浏览器会话检查）
  if (force) {
    if (!json) console.log('已清除本地会话，正在打开浏览器重新登录…');
    clearLocalSession();
  } else {
    // 1) 先用本地缓存的 token 快速校验（~200ms），有效则直接复用，不再弹浏览器
    const cachedToken = readCachedToken();
    if (cachedToken) {
      const c0 = await getApiClient();
      const me = await apiCall(c0, cachedToken, 'GET', 'auth/userInfo');
      await c0.close();
      if (isOk(me)) {
        const binding = await getAccountBinding(c0, cachedToken);
        const emailBound = binding.ok ? binding.emailBound : false;
        const boundEmail = binding.ok ? binding.email : '';
        if (!emailBound && !json) {
          console.log('⚠️ 该账号尚未绑定邮箱（以「个人中心 → 个人信息」为准；登录接口的 email 字段可能是系统默认值，不代表已绑定）。请运行 bind-email --email <邮箱> 绑定，或重新 login --email <邮箱> 自动绑定');
        }
        return output({ code: EXIT_OK, data: { loggedIn: true, reused: true, userInfo: minimalUserInfo(me.data), emailBound, boundEmail: maskEmail(boundEmail) }, text: '✅ 已登录（复用本地会话）：' + ((me.data && (me.data.trueName || me.data.logonName)) || '') + (emailBound ? '（邮箱已绑定：' + boundEmail + '）' : '（未绑定邮箱）') + '。如需换账号请加 --force 重新登录' }, json);
      }
    }

    // 2) 快速检查 Chrome / Edge 是否已有登录会话
    if (!json) console.log('检查浏览器现有会话…');
    const existing = await checkExistingLogin();
    if (existing) {
      if (!json) console.log(`✅ 检测到 ${existing.channel} 已有登录会话，已复用并保存。`);
      return output({ code: EXIT_OK, data: { loggedIn: true, reused: true, channel: existing.channel }, text: `已复用 ${existing.channel} 中的现有登录会话` }, json);
    }
  }

  // 3) 打开浏览器完成 SSO 登录
  if (!json) console.log(force ? '请完成「清华统一身份认证」重新登录…' : '未发现现有会话，正在打开浏览器。请完成「清华统一身份认证」登录…');
  const context = await launchContext(false);
  const page = await context.newPage();

  // 若 --force：浏览器启动成功后，再清浏览器内 session（cookie/localStorage/sessionStorage），强制重新登录
  if (force) {
    try {
      await context.clearCookies();
      await page.goto(SITE_URL + HOME_HASH, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await page.evaluate(() => { try { sessionStorage.clear(); localStorage.clear(); } catch {} });
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(1500);
    } catch { /* 清理失败则继续，用户可在浏览器里手动退出登录 */ }
  } else {
    await page.goto(SITE_URL + HOME_HASH, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  }
  if (!json) console.log('等待登录…（在浏览器中完成统一身份认证登录；如未自动跳转，请点击页面上的「登录」按钮）');

  let token = null;
  for (let i = 0; i < 240; i++) { // 最多 20 分钟
    await page.waitForTimeout(5000);
    if (page.url().includes('cab.lib.tsinghua.edu.cn')) {
      token = await readTokenFromPage(page);
      if (token) break;
    }
  }

  if (!token) {
    await context.close();
    return output({ code: EXIT_FAIL, message: '未检测到登录成功（超时），请重试 login' }, json);
  }

  const info = await page.evaluate(() => {
    try { return JSON.parse(sessionStorage.getItem('userInfo') || 'null'); } catch { return null; }
  });
  writeTokenFile({ token, userInfo: minimalUserInfo(info), updatedAt: new Date().toISOString() });
  try { fs.writeFileSync(STORAGE_STATE_FILE, JSON.stringify(await context.storageState(), null, 2)); } catch {}
  if (!json) {
    console.log('✅ 登录成功，会话已保存到 ' + PROFILE_DIR);
    console.log('   token 已缓存到 ' + TOKEN_FILE);
    if (info) console.log('   当前用户：' + (info.trueName || info.nickName || info.name || info.logonName || info.account || ''));
  }

  // 检测邮箱是否已绑定（以 account/info 为准；auth/userInfo 的 email 可能是系统默认值，不算绑定）
  let binding = { ok: false, email: '', handPhone: '', emailBound: false };
  try {
    const bc = await getApiClient();
    binding = await getAccountBinding(bc, token);
    await bc.close();
  } catch { /* 读取失败则视为未绑定，走下面的引导 */ }
  const emailBound = binding.ok ? binding.emailBound : false;
  if (!emailBound) {
    const emailArg = String(args.email || '').trim();
    if (isValidEmail(emailArg)) {
      if (!json) console.log('⚠️ 尚未绑定邮箱，正在用 --email 自动绑定…');
      const bc = await getApiClient();
      const br = await bindEmailByApi(bc, token, emailArg);
      await bc.close();
      if (!json) console.log(br.ok ? '✅ 已自动绑定邮箱：' + emailArg : '⚠️ 自动绑定失败：' + (br.r && br.r.message || '') + '，请手动到「个人中心 → 个人信息」绑定');
    } else if (!json) {
      console.log('⚠️ 该账号尚未绑定邮箱。请运行 bind-email --email <邮箱> 绑定，或重新 login --email <邮箱> 自动绑定');
    }
  }
  await context.close();
  return output({ code: EXIT_OK, data: { loggedIn: true, userInfo: minimalUserInfo(info), emailBound, boundEmail: maskEmail(binding.ok ? binding.email : '') }, text: '登录成功' }, json);
}

// ---------------------------------------------------------------------------
// 数据查询
// ---------------------------------------------------------------------------
async function cmdStatus(argv) {
  const { args } = parseArgs(argv);
  const json = !!args.json;
  const token = readCachedToken();
  if (!token) return output({ code: EXIT_UNAUTH, message: '未登录，请先运行 login' }, json);
  const context = await getApiClient();
  const me = await apiCall(context, token, 'GET', 'auth/userInfo');
  const binding = await getAccountBinding(context, token);
  await context.close();
  if (isOk(me)) {
    const u = minimalUserInfo(me.data);
    const emailBound = binding.ok ? binding.emailBound : false;
    const boundEmail = binding.ok ? binding.email : '';
    const data = { loggedIn: true, userInfo: u, emailBound, boundEmail: maskEmail(boundEmail) };
    const bindNote = binding.ok ? (emailBound ? '（邮箱已绑定：' + boundEmail + '）' : '（未绑定邮箱）') : '（邮箱绑定状态未知）';
    return output({ code: EXIT_OK, data, text: '✅ 已登录：' + (u ? (u.trueName || u.logonName || '') : '') + bindNote }, json);
  }
  if (isAuthError(me)) {
    return output({ code: EXIT_UNAUTH, message: '登录过期，请重新运行 login' }, json);
  }
  return output({ code: EXIT_FAIL, message: '查询登录态失败：' + JSON.stringify(me) }, json);
}

/** 通过 API 绑定邮箱：POST /account/update，body { email } */
async function bindEmailByApi(context, token, email) {
  const r = await apiCall(context, token, 'POST', 'account/update', {}, { email });
  return { ok: isOk(r), r };
}

/** 绑定邮箱：bind-email --email <邮箱>（预约前通常需要） */
async function cmdBindEmail(argv) {
  const { args } = parseArgs(argv);
  const json = !!args.json;
  const email = String(args.email || '').trim();
  const token = readCachedToken();
  if (!token) return output({ code: EXIT_UNAUTH, message: '未登录，请先运行 login' }, json);
  if (!isValidEmail(email)) {
    return output({ code: EXIT_FAIL, message: '邮箱格式不正确，请用 --email xxx@xxx' }, json);
  }
  const ctx = await getApiClient();
  const { ok, r } = await bindEmailByApi(ctx, token, email);
  if (isAuthError(r)) { await ctx.close(); return output({ code: EXIT_UNAUTH, message: '登录过期，请重新运行 login' }, json); }
  if (!ok) { await ctx.close(); return output({ code: EXIT_FAIL, message: '绑定邮箱失败：' + (r.message || JSON.stringify(r)) + '（如失败请到个人中心→个人信息手动绑定）' }, json); }
  // 绑定后回读 account/info 校验真实绑定结果（account/update 返回 code 0 未必代表已写入）
  const v = await getAccountBinding(ctx, token);
  await ctx.close();
  if (v.ok && v.emailBound) {
    return output({ code: EXIT_OK, data: { email: maskEmail(v.email), emailBound: true }, text: '✅ 已绑定邮箱：' + v.email }, json);
  }
  return output({ code: EXIT_FAIL, message: '已提交绑定，但回读未确认（当前邮箱：' + (v.ok ? (v.email || '空') : '读取失败') + '）。请到个人中心→个人信息核对' }, json);
}

/** 空间类型 → 菜单接口 映射 */
const MENU_ENDPOINTS = {
  room: 'roomMenu',           // 研讨间
  seat: 'seatMenu',           // 座位
  psg: 'psgSeatMenu',         // 考研座位
  activity: 'activityMenu',   // 活动
  borrow: 'borrowMenu',       // 外借设备
  digital: 'digitalReadingRoomMenu', // 电子阅览室
};

async function cmdMenu(argv) {
  const { args } = parseArgs(argv);
  const json = !!args.json;
  const token = readCachedToken();
  if (!token) return output({ code: EXIT_UNAUTH, message: '未登录，请先运行 login' }, json);
  const context = await getApiClient();
  const out = {};
  const errors = [];
  // 并行请求 6 个菜单接口，减少串行等待
  const entries = Object.entries(MENU_ENDPOINTS);
  const results = await Promise.all(entries.map(async ([key, ep]) => {
    const r = await apiCall(context, token, 'GET', ep);
    return { key, ep, r };
  }));
  await context.close();
  for (const { key, ep, r } of results) {
    if (isAuthError(r)) return output({ code: EXIT_UNAUTH, message: '登录过期，请重新运行 login' }, json);
    if (isOk(r)) out[key] = r.data;
    else errors.push({ endpoint: ep, code: r.code, message: r.message });
  }

  const TYPE_LABEL = { room: '研讨间/研读间', seat: '座位', psg: '论文写作间/考研座位', activity: '活动', borrow: '外借设备', digital: '电子阅览室' };
  const lines = [];
  for (const [k, v] of Object.entries(out)) {
    const arr = toArray(v);
    lines.push(`【${TYPE_LABEL[k] || k}】共 ${arr.length} 条`);
    for (const it of arr) {
      const nm = it.kindName || it.name || it.roomName || it.siteName || it.label || it.title || '';
      const id = it.uuid || it.kindId || it.id || '';
      lines.push(`  · ${nm}${id ? '（' + id + '）' : ''}${it.kindClass ? '  kindClass=' + it.kindClass : ''}`);
    }
  }
  const text = lines.join('\n') + (errors.length ? '\n⚠️ 部分类型获取失败：' + JSON.stringify(errors) : '');
  return output({ code: EXIT_OK, data: { menus: out, errors }, text }, json);
}

/** 全角→半角归一化（系统里部分房间名混用全角/半角括号，如「法律馆双人舱（五层)」） */
function normName(s) {
  return String(s || '')
    .replace(/[\uFF08]/g, '(').replace(/[\uFF09]/g, ')')   // 全角括号 → 半角
    .replace(/[\uFF0C]/g, ',').replace(/[\u3000]/g, ' ')   // 全角逗号/空格 → 半角
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** 在某菜单数据里按名称/uuid 匹配（先精确 ID/名称，再部分名称，兼容括号全角/半角与简称） */
function findItem(arr, arg) {
  if (!Array.isArray(arr)) return null;
  const a = String(arg == null ? '' : arg).trim();
  if (!a) return null;
  const na = normName(a);
  const names = (x) => [x.kindName, x.name, x.roomName, x.siteName, x.label, x.title];
  const byId = (x) => x.uuid === a || x.kindId === a || String(x.kindId) === a || String(x.id) === a || String(x.sysValue) === a;
  const byExact = (x) => names(x).some((n) => n != null && normName(n) === na);
  const byPartial = (x) => names(x).some((n) => { const nn = normName(n); return nn && (nn.includes(na) || na.includes(nn)); });
  return arr.find(byId) || arr.find(byExact) || arr.find(byPartial) || null;
}

/** "HH:mm" / "HH:mm:ss" → 当天分钟数 */
function toMin(hm) {
  const parts = String(hm || '').split(':').map(Number);
  return (parts[0] || 0) * 60 + (parts[1] || 0);
}

/** 当天分钟数 → "HH:mm" */
function toHM(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/** 把 /reserve 返回的单个房间解析为 空闲/已约 结构 */
function parseSlotRoom(room, kindName, kindId, nowMin, isToday, minUnit) {
  const devName = String(room.devName || '');
  const open = (Array.isArray(room.openTimes) && room.openTimes[0]) || null;
  const s = open ? toMin(open.openStartTime) : toMin(room.openStart || '08:00');
  const e = open ? toMin(open.openEndTime) : toMin(room.openEnd || '22:00');

  // 已约区间：resvInfo[].startTime/endTime 为毫秒时间戳 → 本地 HH:mm 分钟
  const blocks = (Array.isArray(room.resvInfo) ? room.resvInfo : [])
    .map((b) => {
      const st = new Date(b.startTime), en = new Date(b.endTime);
      if (isNaN(st.getTime()) || isNaN(en.getTime())) return null;
      return [st.getHours() * 60 + st.getMinutes(), en.getHours() * 60 + en.getMinutes()];
    })
    .filter(Boolean)
    .sort((a, b) => a[0] - b[0]);

  // 合并重叠区间
  const merged = [];
  for (const b of blocks) {
    if (merged.length && b[0] <= merged[merged.length - 1][1]) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], b[1]);
    else merged.push([...b]);
  }

  // 空闲 = 开放窗口 − 已约区间；查今天只保留未来（>= now）
  const avail = [];
  let cursor = isToday ? Math.max(s, nowMin) : s;
  for (const b of merged) {
    if (cursor < b[0] && b[0] - cursor >= minUnit) avail.push([cursor, b[0]]);
    cursor = Math.max(cursor, b[1]);
  }
  if (cursor < e && e - cursor >= minUnit) avail.push([cursor, e]);

  return {
    kindName, kindId, devName,
    devId: room.devId || '',
    minUser: room.minUser, maxUser: room.maxUser,
    openStart: toHM(s), openEnd: toHM(e),
    booked: blocks.map((b) => `${toHM(b[0])}–${toHM(b[1])}`),
    available: avail.map((a) => `${toHM(a[0])}–${toHM(a[1])}`),
  };
}

/**
 * 查询可预约时段（实时）。
 * 真实数据源是 GET /roomDevice/roomInfos（无需参数，返回各房间类型下每个房间的
 * 开放时段 openTimes 与已约记录 resvInfos）；空闲时段 = 开放窗口 − 已约区间。
 * 注意：/reserve/entrance 在本馆会返回 code 500「系统繁忙」，不可用。
 */
async function cmdSlots(argv) {
  const { args } = parseArgs(argv);
  const json = !!args.json;
  const roomArg = args.room || args.space;           // 可选：房间类型名（如「法律馆双人舱」）
  const dateArg = parseDateArg(args.date) || fmtDate(new Date()); // 支持「明天/9月12日」等，缺省今天
  const resvDates = String(dateArg).replace(/-/g, ''); // YYYYMMDD
  const minUnit = Math.max(5, parseInt(args.unit || '30', 10)); // 最小可约粒度（分钟）
  const token = readCachedToken();
  if (!token) return output({ code: EXIT_UNAUTH, message: '未登录，请先运行 login' }, json);

  const context = await getApiClient();

  // 解析 --room → 待查类型列表 [{kindId, kindName, sysKind}]（sysKind = kindClass）
  let kinds = [];
  const menuData = await getRoomMenu(context, token, !!args.refresh);
  if (roomArg) {
    const it = findItem(menuData, roomArg);
    if (it) kinds.push({ kindId: String(it.kindId || it.uuid), kindName: it.kindName || '', sysKind: Number(it.kindClass) || 1 });
  } else {
    // 未指定 --room → 查全部类型
    for (const it of menuData) {
      kinds.push({ kindId: String(it.kindId || it.uuid), kindName: it.kindName || '', sysKind: Number(it.kindClass) || 1 });
    }
  }
  if (!kinds.length) {
    await context.close();
    return output({ code: EXIT_FAIL, message: '未找到房间类型「' + roomArg + '」，请用 menu 查看可用类型' }, json);
  }

  // 权威时间网格：GET /reserve?kindIds=&resvDates=&sysKind=（resvInfo 为毫秒时间戳占用）
  const now = new Date();
  const isToday = dateArg === fmtDate(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();

  // 并行查询各类型，减少串行等待
  const results = await Promise.all(kinds.map(async (k) => {
    const r = await apiCall(context, token, 'GET', 'reserve', { kindIds: k.kindId, resvDates, sysKind: k.sysKind });
    return { k, r };
  }));
  await context.close();

  const rooms = [];
  for (const { k, r } of results) {
    if (isAuthError(r)) return output({ code: EXIT_UNAUTH, message: '登录过期，请重新运行 login' }, json);
    if (!isOk(r)) continue;
    for (const room of toArray(r.data)) rooms.push(parseSlotRoom(room, k.kindName, k.kindId, nowMin, isToday, minUnit));
  }

  const warn = pastDateWarn(dateArg);
  const multiType = kinds.length > 1;
  const rows = rooms.map((x) => {
    const room = multiType ? `${x.kindName} / ${x.devName}` : x.devName;
    const users = (x.minUser != null && x.maxUser != null) ? `${x.minUser}-${x.maxUser}人` : '-';
    const free = x.available.length ? x.available.join('、') : '（无）';
    const booked = x.booked.length ? x.booked.join('、') : '-';
    return `| ${room} | ${users} | ${x.openStart}-${x.openEnd} | ${free} | ${booked} |`;
  });
  const text = (warn ? warn + '\n' : '')
    + `可预约时段（date=${dateArg}，共 ${rooms.length} 个房间）\n\n`
    + `| 房间 | 人数 | 开放 | 空闲时段 | 已约时段 |\n`
    + `|------|------|------|---------|---------|\n`
    + rows.join('\n');
  return output({ code: EXIT_OK, data: { date: dateArg, unit: minUnit, rooms }, text }, json);
}

async function cmdRooms(argv) {
  const { args } = parseArgs(argv);
  const json = !!args.json;
  const typeArg = args.type || args.menu;
  const token = readCachedToken();
  if (!token) return output({ code: EXIT_UNAUTH, message: '未登录，请先运行 login' }, json);
  const context = await getApiClient();
  const ep = typeArg && MENU_ENDPOINTS[typeArg] ? MENU_ENDPOINTS[typeArg] : 'roomMenu';
  let data;
  if (ep === 'roomMenu') {
    data = await getRoomMenu(context, token, !!args.refresh);
  } else {
    const r = await apiCall(context, token, 'GET', ep);
    if (isAuthError(r)) { await context.close(); return output({ code: EXIT_UNAUTH, message: '登录过期，请重新运行 login' }, json); }
    if (!isOk(r)) { await context.close(); return output({ code: EXIT_FAIL, message: '查询失败：' + JSON.stringify(r) }, json); }
    data = r.data;
  }
  await context.close();
  const arr = toArray(data);
  return output({ code: EXIT_OK, data, text: '房间/区域列表（共 ' + arr.length + ' 条）：\n' + JSON.stringify(data, null, 2) }, json);
}

// 预约状态位掩码 → 中文标签
const RESV_STATUS_MAP = [
  [1, '预约成功'], [2, '未开始'], [4, '已开始'], [8, '未支付'], [16, '已违约'],
  [32, '已支付'], [64, '已签到'], [128, '已结束'], [256, '待审核'], [512, '审核未通过'],
  [1024, '审核通过'], [2048, '已暂离'], [8192, '待同意'], [16384, '举报'],
];
function resvStatusLabel(status) {
  const n = Number(status) || 0;
  const labels = RESV_STATUS_MAP.filter(([v]) => (n & v) > 0).map(([, l]) => l);
  return labels.length ? labels.join('、') : '未知(' + status + ')';
}

/** 从预约记录提取预约对象（页面显示「楼栋/房间」两行，如「北馆单人间(三层) / 北馆3F-01」） */
function roomLabelOf(x) {
  const dev = (Array.isArray(x.resvDevInfoList) && x.resvDevInfoList[0]) || {};
  const lab = dev.labName || x.labName || '';
  const room = dev.devName || dev.roomName || x.devName || x.roomName || x.kindName || '';
  if (lab && room && lab !== room) return `${lab} / ${room}`;
  return room || lab || '';
}

/** 时间戳（毫秒）→ "YYYY-MM-DD HH:mm" */
function fmtTs(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  if (isNaN(d.getTime())) return String(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function cmdOrders(argv) {
  const { args } = parseArgs(argv);
  const json = !!args.json;
  const token = readCachedToken();
  if (!token) return output({ code: EXIT_UNAUTH, message: '未登录，请先运行 login' }, json);

  // 个人预约列表：GET /reserve/resvInfo（参数 beginDate/endDate/needStatus/page/pageNum/orderKey/orderModel）
  // 默认范围：近 30 天 ~ 未来 30 天（预约多为未来日期，endDate 必须含未来，否则查不到 9 月等未来预约）
  const endDate = args.end || args.to || fmtDate(new Date(Date.now() + 30 * 24 * 3600 * 1000));
  const beginDate = args.begin || args.from || fmtDate(new Date(Date.now() - 30 * 24 * 3600 * 1000));
  const needStatus = args.status != null ? String(args.status) : ''; // 空=全部
  const page = parseInt(args.page || '1', 10);
  const pageNum = parseInt(args.pageNum || args.pagesize || '10', 10);

  const context = await getApiClient();
  const list = await apiCall(context, token, 'GET', 'reserve/resvInfo', {
    beginDate, endDate, needStatus, page, pageNum, orderKey: 'gmt_create', orderModel: 'desc',
  });
  await context.close();

  if (isAuthError(list)) return output({ code: EXIT_UNAUTH, message: '登录过期，请重新运行 login' }, json);
  if (!isOk(list)) return output({ code: EXIT_FAIL, message: '查询预约记录失败：' + JSON.stringify(list) }, json);

  const rows = toArray(list.data);
  const total = (list.count != null && Number(list.count) > 0) ? Number(list.count) : rows.length;
  const text = `我的预约（${beginDate} ~ ${endDate}，共 ${rows.length} 条${total !== rows.length ? '，总数 ' + total : ''}）\n\n`
    + `| 预约号 | 预约对象 | 时间 | 状态 |\n`
    + `|--------|---------|------|------|\n`
    + (rows.length ? rows.map((x) => {
        const name = roomLabelOf(x);
        const time = (x.resvBeginTime && x.resvEndTime) ? `${fmtTs(x.resvBeginTime)} ~ ${fmtTs(x.resvEndTime)}` : '-';
        const st = resvStatusLabel(x.resvStatus);
        return `| ${x.resvId} | ${name} | ${time} | ${st} |`;
      }).join('\n') : '| （暂无预约记录） | | | |');
  return output({ code: EXIT_OK, data: { beginDate, endDate, needStatus, total, orders: rows, raw: list.data }, text }, json);
}

/** 取消预约：POST /reserve/delete，body { uuid }；默认预演，须 --yes 才真正取消 */
async function cmdCancel(argv) {
  const { args } = parseArgs(argv);
  const json = !!args.json;
  const uuidArg = args.uuid || args.resv || args.id || '';
  const yes = !!args.yes;
  const token = readCachedToken();
  if (!token) return output({ code: EXIT_UNAUTH, message: '未登录，请先运行 login' }, json);
  if (!uuidArg) {
    return output({ code: EXIT_FAIL, message: '缺少 --uuid 参数。请先运行 orders 查看预约（记下 uuid），再执行 cancel --uuid <uuid> [--yes]' }, json);
  }

  // 先查列表，找到该预约以便展示；找不到也按原样提交
  const ctx1 = await getApiClient();
  const endDate = fmtDate(new Date(Date.now() + 30 * 24 * 3600 * 1000));
  const beginDate = fmtDate(new Date(Date.now() - 90 * 24 * 3600 * 1000));
  const list = await apiCall(ctx1, token, 'GET', 'reserve/resvInfo', {
    beginDate, endDate, needStatus: '', page: 1, pageNum: 100, orderKey: 'gmt_create', orderModel: 'desc',
  });
  await ctx1.close();

  const target = (isOk(list) ? toArray(list.data) : []).find((x) => x.uuid === uuidArg || String(x.resvId) === uuidArg);
  const realUuid = target ? target.uuid : uuidArg;

  // 真正取消时，若 uuidArg 既不像 uuid（hex）也不像预约号（纯数字），多半是房间名 → 明确报错，别让后端回一句模糊的「预约信息错误」
  if (yes && !target) {
    const looksLikeUuid = /^[0-9a-f]{20,40}$/i.test(uuidArg);
    const looksLikeResvId = /^\d{4,}$/.test(uuidArg);
    if (!looksLikeUuid && !looksLikeResvId) {
      return output({ code: EXIT_FAIL, message: `未找到预约「${uuidArg}」——这看起来是房间名，不是预约号/uuid。请先运行 orders 查预约号，再 cancel --uuid <预约号>` }, json);
    }
  }

  if (!yes) {
    const desc = target
      ? `：${roomLabelOf(target)}（${fmtTs(target.resvBeginTime)} ~ ${fmtTs(target.resvEndTime)}，状态 ${resvStatusLabel(target.resvStatus)}）`
      : '（未在近 90 天记录中找到该 uuid，将按原样提交）';
    return output({
      code: EXIT_OK,
      data: { dryRun: true, uuid: realUuid },
      text: `【预演，未取消】将取消预约 ${realUuid}${desc}。确认取消请加 --yes。`,
    }, json);
  }

  const ctx2 = await getApiClient();
  const r = await apiCall(ctx2, token, 'POST', 'reserve/delete', {}, { uuid: realUuid });
  await ctx2.close();
  if (isAuthError(r)) return output({ code: EXIT_UNAUTH, message: '登录过期，请重新运行 login' }, json);
  if (!isOk(r)) return output({ code: EXIT_FAIL, message: '取消失败：' + (r.message || JSON.stringify(r)) }, json);
  return output({ code: EXIT_OK, data: { success: true, uuid: realUuid }, text: '✅ 已取消预约 ' + realUuid }, json);
}

/** 查看单条预约详情（对应个人中心「详细」按钮）：成员/设备/主题/备注等 */
async function cmdDetail(argv) {
  const { args } = parseArgs(argv);
  const json = !!args.json;
  const uuidArg = args.uuid || args.resv || args.id || '';
  const token = readCachedToken();
  if (!token) return output({ code: EXIT_UNAUTH, message: '未登录，请先运行 login' }, json);
  if (!uuidArg) return output({ code: EXIT_FAIL, message: '缺少 --uuid 参数（或预约号）。请先运行 orders 查看' }, json);

  const ctx = await getApiClient();
  const endDate = fmtDate(new Date(Date.now() + 30 * 24 * 3600 * 1000));
  const beginDate = fmtDate(new Date(Date.now() - 90 * 24 * 3600 * 1000));
  const list = await apiCall(ctx, token, 'GET', 'reserve/resvInfo', {
    beginDate, endDate, needStatus: '', page: 1, pageNum: 100, orderKey: 'gmt_create', orderModel: 'desc',
  });
  await ctx.close();

  if (isAuthError(list)) return output({ code: EXIT_UNAUTH, message: '登录过期，请重新运行 login' }, json);
  if (!isOk(list)) return output({ code: EXIT_FAIL, message: '查询预约失败：' + JSON.stringify(list) }, json);

  const x = toArray(list.data).find((r) => r.uuid === uuidArg || String(r.resvId) === uuidArg);
  if (!x) return output({ code: EXIT_FAIL, message: '未找到该预约（uuid/预约号=' + uuidArg + '），请先运行 orders 查看' }, json);

  const devs = (Array.isArray(x.resvDevInfoList) ? x.resvDevInfoList : []).map((d) => `${d.labName || ''} / ${d.roomName || d.devName || ''}（${d.kindName || ''}）`);
  const members = (Array.isArray(x.resvMemberInfoList) ? x.resvMemberInfoList : []).map((m) => `${m.trueName || ''}（${m.logonName || ''}）`);
  const detail = {
    预约编号: x.resvId,
    uuid: x.uuid,
    预约对象: roomLabelOf(x),
    状态: resvStatusLabel(x.resvStatus),
    时间: `${fmtTs(x.resvBeginTime)} ~ ${fmtTs(x.resvEndTime)}`,
    设备: devs,
    成员: members,
    主题: x.testName || '',
    备注: x.memo || '',
    申请人: x.resvName || x.logonName || '',
    创建时间: fmtTs(x.gmtCreate),
  };
  const fmtVal = (v) => (Array.isArray(v) ? v.join('、') : (v || '（无）'));
  const text = `预约详情（uuid=${x.uuid}）\n`
    + Object.entries(detail).map(([k, v]) => `  ${k}: ${fmtVal(v)}`).join('\n');
  return output({ code: EXIT_OK, data: { ...detail, raw: x }, text }, json);
}

// ---------------------------------------------------------------------------
// 交互式浏览器命令（预约 / 打开）
// ---------------------------------------------------------------------------
async function cmdOpen(argv) {
  const { args } = parseArgs(argv);
  const json = !!args.json;
  const hash = args.url || 'ic/home';
  const context = await launchContext(false);
  const page = await context.newPage();
  const route = '#' + String(hash).replace(/^#?\/?/, '');
  await page.goto(SITE_URL + route, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  if (!json) console.log('浏览器已打开（' + route + '）。按 Ctrl+C 或关闭浏览器结束。');
  await page.waitForTimeout(30 * 60 * 1000).catch(() => {});
  await context.close();
  return output({ code: EXIT_OK, data: { opened: route }, text: '已结束' }, json);
}

/** 注入登录态（Cookie + sessionStorage.userInfo），确保预约页已登录 */
async function injectLoginState(context, page) {
  try {
    const state = JSON.parse(fs.readFileSync(STORAGE_STATE_FILE, 'utf8'));
    const cookies = (state.cookies || []).map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path || '/' }));
    if (cookies.length) await context.addCookies(cookies);
  } catch { /* 无 storageState 则跳过 */ }
  // 注入「完整」userInfo（含 email/handPhone 等）：实时从 auth/userInfo 拉取、只进浏览器内存、不落盘。
  // 不能用 minimalUserInfo（缺 email），否则前端会误判「系统需要绑定邮箱才能使用」。
  try {
    const tk = readTokenFile();
    if (tk && tk.token) {
      let ui = tk.userInfo || null;
      try {
        const ctx = getApiClient();
        const me = await apiCall(ctx, tk.token, 'GET', 'auth/userInfo');
        await ctx.close();
        if (isOk(me) && me.data) ui = me.data;
      } catch { /* API 拉取失败则退回本地 minimal（可能触发邮箱误判，但不崩溃） */ }
      if (ui) {
        await page.addInitScript((u) => {
          try { sessionStorage.setItem('userInfo', JSON.stringify(u)); sessionStorage.setItem('isLogin', 'true'); } catch {}
        }, ui);
      }
    }
  } catch { /* 无 token 则跳过 */ }
}

/** 检测「绑定邮箱」提示弹窗：若有则自动点确认并引导到个人中心，返回是否检测到 */
async function handleEmailBindPrompt(page) {
  // 1) 找含「邮箱」+「绑定」文案的可见弹窗/提示框
  const dlg = page.locator('.el-dialog, .el-message-box, .el-overlay, .el-notification', { hasText: '邮箱' }).filter({ hasText: /绑定|邮箱/ }).first();
  let found = false;
  try { await dlg.waitFor({ state: 'visible', timeout: 2000 }); found = (await dlg.count()) > 0; } catch { found = false; }
  if (!found) return false;

  // 2) 自动点「确认/知道了/确定/去绑定」按钮
  try {
    const btn = dlg.locator('button', { hasText: /确认|知道了|确定|去绑定|立即绑定/ }).last();
    if (await btn.count()) await btn.click();
    await page.waitForTimeout(500);
  } catch {}

  // 3) 引导到个人中心 → 个人信息（邮箱绑定所在 tab）
  try {
    await page.evaluate(() => {
      const els = document.querySelectorAll('.el-menu-item, a, li, span, div');
      for (const el of els) {
        const t = (el.textContent || '').trim();
        if (t === '个人中心') { el.click(); return; }
      }
    });
    await page.waitForTimeout(2000); // 等个人中心加载
    // 点「个人信息」tab
    await page.evaluate(() => {
      const tabs = document.querySelectorAll('.nav-item, .el-tabs__item, [role=tab], li, span, div');
      for (const el of tabs) {
        const t = (el.textContent || '').trim();
        if (t === '个人信息') { el.click(); return; }
      }
    });
    await page.waitForTimeout(1500);
  } catch {}
  return true;
}

/** 在首页点击房间类型菜单项（如「北馆单人研读间」），进入对应预约页；找不到返回 null（不猜菜单） */
async function clickMenuByName(page, kindName) {
  return page.evaluate((name) => {
    const n = (name || '').replace(/[\uFF08]/g, '(').replace(/[\uFF09]/g, ')').replace(/\s+/g, '');
    const els = document.querySelectorAll('.el-menu-item');
    for (const el of els) {
      const t = ((el.textContent || '').trim()).replace(/[\uFF08]/g, '(').replace(/[\uFF09]/g, ')').replace(/\s+/g, '');
      if (t && n && (t.includes(n) || n.includes(t))) { el.click(); return el.textContent.trim(); }
    }
    return null;
  }, kindName);
}

/** 用日期选择器（el-date-editor--date）跳转到任意日期 */
async function selectDateByPicker(page, dateArg) {
  try {
    const input = page.locator('.el-date-editor--date input.el-input__inner').first();
    await input.click();
    await page.waitForTimeout(300);
    await input.fill(String(dateArg));
    await page.waitForTimeout(200);
    await input.press('Enter');
    await page.waitForTimeout(1200);
    return true;
  } catch { return false; }
}

/** 选择日期：先找日期 tab，再退到日期选择器（可跳任意日期），最后点「下周」翻页 */
async function selectDateTab(page, dateArg) {
  const id = 'tab-' + String(dateArg).replace(/-/g, '/');
  const tryFind = () => page.evaluate((tabId) => {
    const el = document.getElementById(tabId);
    if (el) { el.click(); return true; }
    return false;
  }, id);

  if (await tryFind()) {
    await page.waitForTimeout(1500); // 等日期网格刷新，避免在旧日期网格上点击
    return true;
  }

  // 日期选择器（可跳转到任意日期，如 9月12日）
  if (await selectDateByPicker(page, dateArg)) return true;

  // 兜底：点「下周」（或「上周」）后重试 tab
  const clicked = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('span, div, button, a')];
    const next = btns.find((el) => (el.textContent || '').trim() === '下周');
    const prev = btns.find((el) => (el.textContent || '').trim() === '上周');
    const target = next || prev;
    if (target) { target.click(); return (target.textContent || '').trim(); }
    return null;
  });
  if (!clicked) return false;
  await page.waitForTimeout(1500);
  return tryFind();
}

/** 点击指定房间（devName，如「北馆3F-01」）的时间网格，打开「申请预约」弹窗 */
async function clickRoomGrid(page, devName, startHM) {
  // 1) 定位该房间的 .time-wrapp 并滚动到可见（避免网格在视口外导致点击落空）
  const found = await page.evaluate((name) => {
    if (!name) return false;
    const n = (name || '').replace(/[\uFF08]/g, '(').replace(/[\uFF09]/g, ')').replace(/\s+/g, '');
    const nm = [...document.querySelectorAll('p, span, div')].find((el) => {
      const t = ((el.textContent || '').trim()).replace(/[\uFF08]/g, '(').replace(/[\uFF09]/g, ')').replace(/\s+/g, '');
      return t === n;
    });
    if (!nm) return false;
    let node = nm;
    for (let i = 0; i < 12; i++) {
      node = node.parentElement;
      if (!node) break;
      if (node.classList && node.classList.contains('time-wrapp')) {
        node.scrollIntoView({ block: 'center' });
        return true;
      }
    }
    return false;
  }, devName);
  if (!found) return false;
  await page.waitForTimeout(500); // 等滚动稳定

  // 2) 重新读取 .time 网格位置（滚动后坐标已变）
  const box = await page.evaluate((name) => {
    const n = (name || '').replace(/[\uFF08]/g, '(').replace(/[\uFF09]/g, ')').replace(/\s+/g, '');
    const nm = [...document.querySelectorAll('p, span, div')].find((el) => {
      const t = ((el.textContent || '').trim()).replace(/[\uFF08]/g, '(').replace(/[\uFF09]/g, ')').replace(/\s+/g, '');
      return t === n;
    });
    if (!nm) return null;
    let node = nm;
    for (let i = 0; i < 12; i++) {
      node = node.parentElement;
      if (!node) break;
      if (node.classList && node.classList.contains('time-wrapp')) {
        const time = node.querySelector('.time') || node;
        const r = time.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      }
    }
    return null;
  }, devName);
  if (!box) return false;

  // 3) 时间 → 横向位置（网格覆盖 08:00–22:00 共 14 小时）
  let frac = 0.5;
  if (startHM) {
    const [h, m] = String(startHM).split(':').map(Number);
    const t = h * 60 + m;
    frac = Math.min(0.99, Math.max(0.01, (t - 8 * 60) / (22 * 60 - 8 * 60)));
  }
  const x = box.left + box.width * frac;
  const y = box.top + box.height * 0.5;
  await page.mouse.click(x, y);
  return true;
}

/** 在「申请预约」弹窗内选择开始/结束时间（[0]=组成员 [1]=开始 [2]=结束；结束时间不可用则取最近可用值） */
async function selectDialogTime(page, startHM, endHM) {
  if (!startHM) return false;
  try {
    const dlg = page.locator('.el-dialog[aria-label="申请预约"]');
    await dlg.waitFor({ state: 'visible', timeout: 8000 });
    const sels = dlg.locator('.el-select');
    const n = await sels.count();
    if (n < 3) return false; // 成员 + 开始 + 结束

    const pickOpt = async (optText) => {
      const opt = page.locator('.el-select-dropdown:visible .el-select-dropdown__item', { hasText: optText }).first();
      await opt.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
      if (await opt.count()) { await opt.click(); return true; }
      return false;
    };

    // 选开始时间
    await sels.nth(1).click();
    await page.waitForTimeout(500);
    if (!(await pickOpt(startHM))) return false;
    await page.waitForTimeout(800); // 等结束时间下拉更新

    // 选结束时间（若目标不可用，选最近可用项）
    if (endHM) {
      await sels.nth(2).click();
      await page.waitForTimeout(500);
      if (!(await pickOpt(endHM))) {
        const opts = await page.locator('.el-select-dropdown:visible .el-select-dropdown__item').allTextContents();
        if (!opts.length) return false;
        await page.locator('.el-select-dropdown:visible .el-select-dropdown__item').first().click();
        return false; // 标记：结束时间未被精确设为 endHM
      }
      await page.waitForTimeout(400);
    }
    return true;
  } catch { return false; }
}

/** 在「申请预约」弹窗内自动填写组成员学号（远程搜索多选下拉；已存在的学号自动跳过） */
async function fillMembers(page, members) {
  if (!Array.isArray(members) || !members.length) return true;
  try {
    const dlg = page.locator('.el-dialog[aria-label="申请预约"]');
    await dlg.waitFor({ state: 'visible', timeout: 8000 });
    const memberSel = dlg.locator('.el-select', { has: page.locator('.el-select__tags') }).first();
    if (!(await memberSel.count())) return false;
    const input = memberSel.locator('.el-select__input');

    for (const id of members) {
      const sid = String(id || '').trim();
      if (!sid) continue;
      // 已存在（含本人预填的）则跳过
      if (await memberSel.locator('.el-select__tags-text', { hasText: sid }).count()) continue;
      await input.click();
      await page.waitForTimeout(300);
      await input.fill(sid);
      await page.waitForTimeout(1200); // 等远程搜索结果
      const opt = page.locator('.el-select-dropdown:visible .el-select-dropdown__item').first();
      if (!(await opt.count())) return false; // 无匹配结果
      await opt.click();
      await page.waitForTimeout(400);
    }
    return true;
  } catch { return false; }
}

/** 由开始时间推算默认结束时间（+60 分钟） */
function plusMinutes(hm, mins) {
  const [h, m] = String(hm).split(':').map(Number);
  const t = h * 60 + m + mins;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

async function cmdReserveBrowser(argv) {
  const { args } = parseArgs(argv);
  const json = !!args.json;
  const roomArg = args.room || args.space;        // 房间类型名（如「北馆单人研读间」）
  const devArg = args.dev || '';                   // 具体房间名（如「北馆3F-01」），可选
  const dateArg = parseDateArg(args.date);          // 支持「明天/9月12日」等 → YYYY-MM-DD
  const timeArg = args.time || '';                 // 开始时间 HH:mm
  const endArg = args.end || '';                   // 结束时间 HH:mm
  const members = (args.members || args.member || '').split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean); // 成员学号列表

  if (!roomArg) return output({ code: EXIT_FAIL, message: '缺少 --room 参数（房间类型名，如「北馆单人研读间」）' }, json);
  if (!json) {
    const dw = pastDateWarn(dateArg);
    console.log(dw ? `⚠️ 解析日期：${dateArg}（过去日期，请核对年份）` : `📅 解析日期：${dateArg || '（未指定，使用页面默认日期）'}`);
  }

  // 1) 解析房间类型 → kindName（用于点击菜单项），并顺带读账号真实邮箱绑定状态
  let kindName = '';
  let emailBound = true; // 默认视为已绑定，避免 DOM 误报拦截
  const token = readCachedToken();
  if (token) {
    const ctx = await getApiClient();
    const menuData = await getRoomMenu(ctx, token, !!args.refresh);
    const it = findItem(menuData, roomArg);
    if (it) kindName = it.kindName || '';
    const binding = await getAccountBinding(ctx, token);
    if (binding.ok) emailBound = binding.emailBound;
    await ctx.close();
  }
  if (!kindName) kindName = roomArg;

  // 2) 打开浏览器并注入登录态
  const browser = await launchContext(false);
  const page = await browser.newPage();
  await injectLoginState(browser, page);

  // 3) 首页 → 点击菜单项进入预约页
  await page.goto(SITE_URL + HOME_HASH, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForSelector('.el-menu-item', { timeout: 10000 }).catch(() => {}); // 等菜单渲染，不再固定等 4s

  // 3.1) 仅在「API 判定未绑定邮箱」时才跑页面 DOM 检测；已绑定则完全跳过（DOM 启发式会误报，曾把首页误判为“要求绑定邮箱”）
  if (!emailBound && await handleEmailBindPrompt(page)) {
    if (!json) console.log('⚠️ 系统要求先绑定邮箱。已自动确认，并已进入「个人中心」，请到「个人信息」里绑定邮箱后再重新预约。');
    await page.waitForTimeout(30 * 60 * 1000).catch(() => {});
    await browser.close();
    return output({ code: EXIT_FAIL, data: { needBindEmail: true }, text: '需要绑定邮箱后才能预约，请在个人中心绑定邮箱后重试' }, json);
  }

  const menu = await clickMenuByName(page, kindName);
  if (!json) console.log(menu ? `✅ 已进入预约页：${menu}` : '⚠️ 未找到对应菜单项，请在页面上手动点击房间类型');
  // 等进入预约页（hash 变化 或 时间网格出现），不再固定等 6s
  await page.waitForFunction(() => location.hash.includes('researchSpace') || !!document.querySelector('.time-wrapp'), null, { timeout: 10000 }).catch(() => {});

  // 4) 选择日期
  if (dateArg) {
    const ok = await selectDateTab(page, dateArg);
    if (!json) console.log(ok ? `✅ 已选择日期 ${dateArg}` : `⚠️ 未找到日期 ${dateArg}（可能已过期/未开放），使用默认日期`);
  }

  // 5) 点击房间时间网格 → 打开「申请预约」弹窗
  if (devArg) {
    const ok = await clickRoomGrid(page, devArg, timeArg);
    if (!json) console.log(ok ? `✅ 已点击房间 ${devArg}，正在打开「申请预约」弹窗…` : `⚠️ 未找到房间 ${devArg}，请手动点击其时间网格`);
    // 等弹窗出现（不再固定等 3s）
    await page.waitForSelector('.el-dialog[aria-label="申请预约"]', { state: 'visible', timeout: 8000 }).catch(() => {});
  }

  // 6) 在弹窗内选择时间
  if (timeArg) {
    const end = endArg || plusMinutes(timeArg, 60);
    const ok = await selectDialogTime(page, timeArg, end);
    if (!json) console.log(ok ? `✅ 已在弹窗内选择时间 ${timeArg} ~ ${end}` : `⚠️ 未能在弹窗内自动选择时间，请手动选择（${timeArg} ~ ${end}）`);
  }

  // 7) 在弹窗内自动填写组成员学号
  if (members.length) {
    const ok = await fillMembers(page, members);
    if (!json) console.log(ok ? `✅ 已填写组成员：${members.join('、')}` : `⚠️ 未能自动填写部分成员，请手动在「组成员」里搜索添加：${members.join('、')}`);
  }

  if (!json) {
    if (members.length) console.log('请核对「组成员」与时间无误后点击「提交」。');
    else console.log('请确认「组成员」（多人研讨间需填所有成员学号）无误后点击「提交」完成预约。');
    console.log('按 Ctrl+C 或关闭浏览器结束。');
  }
  await page.waitForTimeout(30 * 60 * 1000).catch(() => {});
  await browser.close();
  return output({ code: EXIT_OK, data: { room: roomArg, dev: devArg, date: dateArg, time: timeArg, end: endArg || '', members }, text: '已结束' }, json);
}

// ---------------------------------------------------------------------------
// 纯 API 预约（默认）—— 走 /reserve 提交；--browser 才回退浏览器 UI
// ---------------------------------------------------------------------------

// 空间类型 → 提前天数 & 时长上限（分钟）
function typeRule(kindName) {
  const n = normName(kindName || '');
  if (n.includes('单人')) return { advance: 3, maxDur: 240 };
  if (n.includes('双人舱')) return { advance: 5, maxDur: 150 };
  return { advance: 5, maxDur: 240 };
}

async function cmdReserve(argv) {
  const { args } = parseArgs(argv);
  const json = !!args.json;
  const roomArg = args.room || args.space;
  const devArg = args.dev || '';
  const dateArg = parseDateArg(args.date);            // 明天/9月2日 → YYYY-MM-DD
  const timeArg = String(args.time || '').trim();
  const endArg = String(args.end || '').trim();
  const members = (args.members || args.member || '').split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
  const yes = !!args.yes;
  if (args.browser) return cmdReserveBrowser(argv);   // 显式 --browser：回退浏览器 UI

  if (!roomArg) return output({ code: EXIT_FAIL, message: '缺少 --room' }, json);
  if (!dateArg) return output({ code: EXIT_FAIL, message: '缺少 --date' }, json);
  if (!timeArg || !endArg) return output({ code: EXIT_FAIL, message: '缺少 --time/--end' }, json);
  const token = readCachedToken();
  if (!token) return output({ code: EXIT_UNAUTH, message: '未登录' }, json);

  const ctx = await getApiClient();

  // ① 类型 → kindId/kindClass
  const it = findItem(await getRoomMenu(ctx, token, !!args.refresh), roomArg);
  if (!it) { await ctx.close(); return output({ code: EXIT_FAIL, message: '未找到空间类型：' + roomArg }, json); }
  const kindId = it.kindId, kindClass = it.kindClass || 1, kindName = it.kindName || roomArg;

  // ② 房间 → devId/minUser/maxUser/openTimes
  const av = await apiCall(ctx, token, 'GET', 'reserve', { kindIds: kindId, resvDates: dateArg.replace(/-/g, ''), sysKind: kindClass });
  const rooms = toArray(av.data);
  if (!isOk(av) || !rooms.length) { await ctx.close(); return output({ code: EXIT_FAIL, message: '该日期该类型无可约房间' }, json); }
  // 房间匹配：先精确（normName 全等），再子串（双向包含）——兼容只传短名（如「法F5-研讨舱1」匹配「法F5-研讨舱1（4人间）」）
  let room = devArg ? rooms.find((r) => normName(r.devName) === normName(devArg)) : rooms[0];
  if (!room && devArg) {
    const d = normName(devArg);
    room = rooms.find((r) => { const n = normName(r.devName); return n && d && (n.includes(d) || d.includes(n)); });
  }
  if (!room) { await ctx.close(); return output({ code: EXIT_FAIL, message: '未找到房间：' + devArg }, json); }
  const devId = room.devId;
  const minUser = Number(room.minUser) || 1, maxUser = Number(room.maxUser) || 1;

  // ③ 规则校验
  const rule = typeRule(kindName);
  const open = (Array.isArray(room.openTimes) && room.openTimes[0]) || null;
  const os = open ? toMin(open.openStartTime) : toMin(room.openStart || '08:00');
  const oe = open ? toMin(open.openEndTime) : toMin(room.openEnd || '22:00');
  const startMin = toMin(timeArg), endMin = toMin(endArg), durMin = endMin - startMin;
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  const reqDate = new Date(dateArg + 'T00:00:00');
  const maxDate = new Date(today0.getTime() + (rule.advance - 1) * 86400000);
  const errs = [];
  if (reqDate < today0) errs.push('预约日期不能是过去');
  if (reqDate > maxDate) errs.push(`超出提前预约范围（最晚 ${fmtDate(maxDate)}）`);
  if (startMin < os || endMin > oe) errs.push(`时段超出开放时间 ${toHM(os)}–${toHM(oe)}`);
  if (durMin < 30) errs.push('时长不足 30 分钟');
  if (durMin > rule.maxDur) errs.push(`时长超过上限 ${rule.maxDur} 分钟`);
  if (errs.length) { await ctx.close(); return output({ code: EXIT_FAIL, message: '预约请求违反规则：' + errs.join('；') }, json); }

  // ④ 本人证号
  const tk = readTokenFile();
  let selfAccNo = (tk && tk.userInfo && tk.userInfo.accNo) || '';
  if (!selfAccNo) {
    const me = await apiCall(ctx, token, 'GET', 'auth/userInfo');
    if (isOk(me) && me.data) selfAccNo = me.data.accNo;
  }
  if (!selfAccNo) { await ctx.close(); return output({ code: EXIT_FAIL, message: '无法获取本人 accNo' }, json); }

  // ⑤ 成员学号 → 证号（logonName 被脱敏，取首个结果 + 后两位弱校验）
  const resvMember = [String(selfAccNo)];
  for (const id of members) {
    const r = await apiCall(ctx, token, 'GET', 'account/getMembers', { key: id, page: 1, pageNum: 10 });
    const list = toArray(r.data);
    const hit = list.find((x) => String(x.accNo) === String(id)) || list[0];
    if (!hit) { await ctx.close(); return output({ code: EXIT_FAIL, message: '未找到成员：' + id }, json); }
    if (String(hit.accNo) === String(selfAccNo)) continue;   // 本人已自动计入，跳过用户误填的本人学号（去重）
    const tail = String(id).slice(-2);
    if (tail && String(hit.logonName || '').indexOf(tail) < 0) {
      await ctx.close(); return output({ code: EXIT_FAIL, message: '成员 ' + id + ' 匹配不确定：' + hit.logonName }, json);
    }
    resvMember.push(String(hit.accNo));
  }
  // 去重后再校验人数（本人计 1；去重后 resvMember.length 为实际人数）
  if (resvMember.length < minUser || resvMember.length > maxUser) {
    await ctx.close(); return output({ code: EXIT_FAIL, message: `去重后人数 ${resvMember.length} 超出 ${minUser}–${maxUser} 人` }, json);
  }

  // ⑥ 提交 body（memberKind 固定 1：前端实际提交值，实测团体预约也接受；人数由 resvMember + minUser/maxUser 校验）
  const body = {
    sysKind: kindClass, appAccNo: String(selfAccNo), memberKind: 1, resvMember,
    resvBeginTime: `${dateArg} ${timeArg}:00`, resvEndTime: `${dateArg} ${endArg}:00`,
    testName: '', resvProperty: 0, resvDev: [devId], memo: '',
  };

  if (!yes) { await ctx.close(); return output({ code: EXIT_OK, data: { dryRun: true, room: kindName, dev: room.devName, date: dateArg, time: `${timeArg}~${endArg}`, memberCount: resvMember.length, members: resvMember.map(String) }, text: `【预演，未提交】${kindName} / ${room.devName} ${dateArg} ${timeArg}–${endArg}，成员 ${resvMember.length} 人。确认提交请加 --yes` }, json); }
  const submit = await apiCall(ctx, token, 'POST', 'reserve', {}, body);
  await ctx.close();
  if (isAuthError(submit)) return output({ code: EXIT_UNAUTH, message: '登录过期，请重新运行 login' }, json);
  if (!isOk(submit)) return output({ code: EXIT_FAIL, message: '预约失败：' + (submit.message || JSON.stringify(submit)) }, json);
  return output({ code: EXIT_OK, data: { success: true, resvId: submit.data, room: kindName, dev: room.devName, date: dateArg, time: `${timeArg}~${endArg}`, memberCount: resvMember.length }, text: `✅ 预约成功：${kindName} / ${room.devName} ${dateArg} ${timeArg}–${endArg}（成员 ${resvMember.length} 人）` }, json);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
const commands = {
  setup: cmdSetup,
  login: cmdLogin,
  'bind-email': cmdBindEmail,
  status: cmdStatus,
  menu: cmdMenu,
  rooms: cmdRooms,
  slots: cmdSlots,
  orders: cmdOrders,
  detail: cmdDetail,
  cancel: cmdCancel,
  reserve: cmdReserve,
  open: cmdOpen,
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
