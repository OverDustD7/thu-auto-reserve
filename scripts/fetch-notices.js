const fs = require('fs');
const os = require('os');
const path = require('path');
const HOME = os.homedir();
const TOKEN_FILE = path.join(HOME, '.thu-lib-space', 'token.json');
const STORAGE = path.join(HOME, '.thu-lib-space', 'storage-state.json');
const API_BASE = 'https://cab.lib.tsinghua.edu.cn/ic-web';
const OUT = path.join(__dirname, '..', 'references', 'notices.md');

const token = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')).token;
let cookie = '';
try { const s = JSON.parse(fs.readFileSync(STORAGE, 'utf8')); cookie = (s.cookies || []).map((c) => `${c.name}=${c.value}`).join('; '); } catch {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(pathname, params) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${API_BASE}/${pathname}${qs ? '?' + qs : ''}`, {
    headers: { token, lan: '1', Cookie: cookie, 'User-Agent': 'Mozilla/5.0' },
  });
  return r.json();
}

// 前端 T() 反转义：PA==→<  Pg==→>  Jg==→&  Ig==→"
function unescapeContent(s) {
  return String(s || '')
    .replace(/PA==/g, '<').replace(/Pg==/g, '>').replace(/Jg==/g, '&').replace(/Ig==/g, '"');
}
function htmlToText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

(async () => {
  const menu = await call('roomMenu', {});
  if (menu.code !== 0) { console.log('roomMenu 失败', JSON.stringify(menu)); return; }
  const kinds = menu.data;

  const results = [];
  for (const kind of kinds) {
    const r = await call('sysInfo', { sysType: 1, sysValue: String(kind.kindId), sysKind: 2, status: 2 });
    const content = (r.code === 0 && r.data && r.data.content) ? htmlToText(unescapeContent(r.data.content)) : '（无须知）';
    results.push({ kindId: kind.kindId, kindName: kind.kindName, kindClass: kind.kindClass, content });
    console.log(`✅ ${kind.kindName}（kindId=${kind.kindId}）`);
    console.log('----------------------------------------');
    console.log(content);
    console.log('');
    await sleep(400);
  }

  // 写 markdown
  const lines = [
    '# 清华图书馆 IC 空间 · 预约须知（实测）',
    '',
    '> 数据来源：`GET /ic-web/sysInfo?sysType=1&sysValue=<kindId>&sysKind=2&status=2`（各房间类型的「预约须知」tab）。',
    '> 抓取时间：' + new Date().toISOString().slice(0, 10) + '。内容为系统配置的原文（已去除 HTML 标签）。',
    '',
  ];
  for (const x of results) {
    lines.push(`## ${x.kindName}（kindId=${x.kindId}）`);
    lines.push('');
    lines.push(x.content);
    lines.push('');
  }
  fs.writeFileSync(OUT, lines.join('\n'));
  console.log('\n已写入 ' + OUT + '，共 ' + results.length + ' 条');
})();
