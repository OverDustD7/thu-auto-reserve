# 清华大学图书馆座位管理系统 —— API 逆向参考

本文档记录了从 `seat.lib.tsinghua.edu.cn` 前端代码（HTML 内联脚本 + `common.js`）逆向出的接口与认证机制，供需要手工调用（无 Playwright 时的纯 HTTP 方案）或排查问题时使用。**日常使用优先用 `scripts/seat-helper.js`**。

> 注意：本系统与「图书馆 IC 空间预约系统」（`cab.lib.tsinghua.edu.cn`，见 **SKILL.md 第九节**）是**两个独立系统**。本系统只负责**普通自习座位**的当日/次日预约；研讨间、考研座位、活动、外借设备等在 IC 空间系统里。

## 1. 基本信息

| 项 | 值 |
|----|----|
| 前端入口 | `https://seat.lib.tsinghua.edu.cn/home/web/f_second`（座位预约）· `/home/web/index`（首页） |
| 后端框架 | **ThinkPHP**（响应头 `X-Powered-By: ThinkPHP`），服务端渲染 HTML + jQuery（**非 SPA**），座位图用 ZRender 画 |
| 会话机制 | **Cookie 会话**：`PHPSESSID` + `access_token` + `userid` + `user_name` + `expire` 等多个 Cookie 共同组成；**无请求签名、无响应加密** |
| 登录方式 | 清华统一身份认证（CAS 单点登录），`loginMode=4`；登录地址 `/cas/index.php?callback=<返回URL>` |
| 预约范围 | 当日 / 次日座位；系统开放时间每日 6:00–23:00 |
| 支付 | 无（免费预约，无支付环节） |

## 2. 认证与登录态

### 2.1 登录流程（SSO / CAS）

1. 前端「登录」按钮执行 `window.location.href = "/cas/index.php?callback=" + window.location.href`。
2. 浏览器跳转到清华统一身份认证，用户完成 SSO。
3. CAS 回调到 `callback` 指定的页面，服务端在返回的 HTML 里把登录信息注入到 `window.ska`：

   ```js
   window.ska = {
       'access_token': "xxxxx",   // 会话令牌
       'userid':       "12345",   // 用户 id
       'username':     "张三",    // 姓名
       ...
   };
   ```

   - 未登录时这三项为空串。
4. 后续鉴权依赖**完整 Cookie**：`PHPSESSID` + `access_token` + `userid` + `user_name` + `expire` 等必须一起带上；预约接口的 POST 表单体还需 `access_token` + `userid`。**只带 `PHPSESSID` 会导致服务端不注入 token、被误判为未登录**（实测踩坑）。

> 与体育场馆系统不同：**没有** `appId/nonce/sign` query 签名，**没有** AES 响应加密。判断登录态就是「携带**完整 Cookie** 拉取页面，看 HTML 里 `ska.access_token` 是否非空」。

### 2.2 登录态判断

`GET /home/web/f_second`（或任意页面），**必须携带完整 Cookie**，正则匹配 HTML 中 `'access_token':"([^"]*)"`：

- 值为空串 → 未登录 / 登录过期
- 值非空 → 已登录，同时可从 `'userid':"..."`、`'username':"..."` 取到对应字段

> ⚠️ 只带 `PHPSESSID`（漏掉 `access_token`/`userid` 等 Cookie）时，服务端**不会**在 HTML 注入 token，会被误判为「登录过期」——脚本早期存在此缺陷，已修复为携带完整 Cookie。

### 2.3 登录/登出接口（`loginMode=1` 的账号密码直登时才用，清华走 CAS 一般不用）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api.php/check` | 登录验证码图片（`loginDialog` 用） |
| POST | `/api.php/login` | 账号密码登录，body `{username, password, verify}` |
| POST | `/api.php/logout` | 登出，body `{access_token, userid}` |

## 3. 统一响应结构

```json
{ "status": 1, "msg": "获取区域信息", "data": { ... } }
```

- `status == 1` 成功；`status == 0` 或其它值失败（读 `msg`）。
- 中文以 `\uXXXX` 转义返回，`JSON.parse` 后即正常中文。
- 列表类接口的 `data.list` 为数组；树形接口的 `data.list` 为对象（含 `areaInfo` / `parentInfo` / `childArea` / `seatinfo`）。

## 4. 业务接口

> 所有接口均为**免登录**（数据查询无需 token，实测无需 Cookie 即可返回）；仅 `book` / `logout` / `profile/books` 需要鉴权。

### 4.1 馆舍 / 楼层 / 阅览区树

`GET /api.php/v3areas/<id>` —— 返回某区域的详情与子区域。

- `<id>` 为馆舍 id（如 `35`=北馆）时，`data.list.childArea` 为**楼层**（`type==0`），每层含 `TotalCount`（座位总数）、`UnavailableSpace`（已占用）、`isValid`（1=可预约）。
- `<id>` 为楼层 id（如 `37`=北馆二层）时，`data.list.childArea` 为**阅览区**（`type==1`，如 A/B/C/D 阅览区），含 `point_x/y`（画图坐标）、`TotalCount`、`UnavailableSpace`。
- `data.list.seatinfo` 是**全系统区域树**（含 `parentId` 父子关系，可据此把座位 `area` 归属到馆舍）。

```json
// GET /api.php/v3areas/35  （北馆）
{ "status": 1, "msg": "获取区域信息", "data": { "list": {
    "areaInfo": { "id": 35, "name": "北馆(李文正馆)", "parentId": 0, "isValid": 1, ... },
    "parentInfo": null,
    "childArea": [
      { "id": 37, "name": "二层", "parentId": 35, "isValid": 1,
        "TotalCount": 280, "UnavailableSpace": 139, "heat_open": 1,
        "point_x": 40.83, "point_y": 64.34, ... },
      { "id": 38, "name": "三层", "TotalCount": 258, "UnavailableSpace": 93, ... },
      ...
    ],
    "seatinfo": [ ... 全系统区域树，含 parentId 关系 ... ]
} } }
```

**馆舍（馆舍）静态表**（`f_second` 页面渲染，`/api.php/v3areas/<id>` 可取实时空闲）：

| id | 名称 | 英文名 |
|----|------|--------|
| 35 | 北馆(李文正馆) | Main Library North Section |
| 64 | 西馆(逸夫馆) | Main Library West Section |
| 89 | 文科图书馆 | Humanities and Social Sciences Library |
| 6 | 法律图书馆 | Law Library |
| 19 | 美术图书馆 | Arts Library |
| 29 | 金融图书馆 | Finance Library |

### 4.2 某区域某日的楼层/阅览区 + 可约时段

`GET /api.php/v3areas/<id>/date/<YYYY-MM-DD>` —— 同 4.1，但每个子区域（阅览区）额外带 `area_times`，其中 `area_times.data.list[0]` 是代表座位的时间段信息，用于拿到 `segment`（时段 id）与起止时间：

```json
// GET /api.php/v3areas/37/date/2026-08-30  （北馆二层，含阅览区）
{ "status": 1, "data": { "list": {
    "areaInfo": { "id": 37, "name": "二层", "parentId": 35, ... },
    "parentInfo": { "id": 35, "name": "北馆(李文正馆)", ... },
    "childArea": [
      { "id": 45, "name": "A阅览区", "parentId": 37, "type": 1, "isValid": 1,
        "TotalCount": 50, "UnavailableSpace": 25,
        "area_times": { "status": 1, "msg": "获取可预约时间段", "data": { "list": [
          { "spaceId": 4126, "spaceName": "NF2A001", "area": 45,
            "bookTimeId": 1682804,        // = 时段 id（segment）
            "beginTime": { "date": "2026-08-30 08:00:00" },
            "endTime": "22:00", "startTime": "17:30", "day": "2026-08-30",
            "status": 6, "id": 1682804 }
        ] } }
      },
      { "id": 46, "name": "B阅览区", "TotalCount": 120, "area_times": { ... }, ... }
    ]
} } }
```

> `area_times.data.list[0]` 的 `id`（=`bookTimeId`）即 `segment`；`startTime`/`endTime` 为可约窗口（当天 `startTime` 会被调整到当前时刻之后）。把这三者连同 `day` 传给 4.3 的 `spaces_old` 即可列座位。

### 4.3 可预约日期

`GET /api.php/v3areadays/<id>` —— 返回该区域可预约的日期（一般当天 + 次日两天）：

```json
{ "status": 1, "msg": "获取区域信息", "data": { "list": [
    { "day": { "date": "2026-08-30 00:00:00", "timezone_type": 3, "timezone": "PRC" } },
    { "day": { "date": "2026-08-31 00:00:00", "timezone_type": 3, "timezone": "PRC" } }
] } }
```

### 4.4 座位列表（真实查座位入口）

`GET /api.php/spaces_old?area=<阅览区id>&segment=<时段id>&day=<YYYY-MM-DD>&startTime=<HH:mm>&endTime=<HH:mm>`

返回该阅览区在指定时段下所有座位的状态（`seat3` 页 `load_seat` 用的就是这个接口）：

```json
{ "status": 1, "msg": "获取空间预约信息", "data": { "list": [
    { "id": 5991, "no": "F1B001", "name": "F1B001", "area": 94, "category": 18,
      "point_x": 65.52, "point_y": 35.47, "width": 1.98, "height": 3.78,
      "status": 1, "status_name": "空闲",
      "area_name": "信息空间", "area_levels": 1, "area_type": 1, "area_color": null },
    { "id": 5992, "no": "F1B002", "status": 1, "status_name": "空闲", ... },
    ...
] } }
```

**座位 `status` 含义**（来自 `getSpaceStatusClass`）：

| status | 含义 | 是否可约 |
|--------|------|---------|
| 1 | 空闲 | ✅ 可预约 |
| 2 | 已预约 | ❌ |
| 3 | 锁定 | ❌ |
| 4 | 维护 | ❌ |
| 5 | 清扫 | ❌ |
| 6 | 使用中 | ❌ |
| 7 | 临时离开 | ❌ |
| 8 | 使用到时提醒 | ❌ |
| 9 | 使用到时 | ❌ |

> 另外 `GET /api.php/space_time_buckets?day=<date>&area=<id>` 也返回座位（`data.list[]` 元素为 `{spaceId, spaceName, area, bookTimeId, endTime, status, day, startTime, id}`），但实测会返回**全馆**座位快照（~900KB、未按 `area` 过滤），脚本不使用，仅供排查参考。
>
> 旧版别名接口（thu-info-lib 使用）：`/api.php/areas/<id>`、`/api.php/areadays/<id>`、`/api.php/spaces`，功能等价于上述 v3 版本，本系统前端已改用 `v3*` 与 `spaces_old`。

### 4.5 预约提交

`POST /api.php/spaces/<seatId>/book` —— body（`application/x-www-form-urlencoded`）：

| 字段 | 值 | 说明 |
|------|----|------|
| `access_token` | 登录后页面注入 | 会话令牌 |
| `userid` | 登录后页面注入 | 用户 id |
| `segment` | 时段 id（=`bookTimeId`） | 预约时段 |
| `type` | `1` | 固定 |
| `operateChannel` | `2` | 网页端固定 |

成功响应（`status == 1`）：

```json
{ "status": 1, "data": { "list": {
    "booker": "卡号/学工号",
    "starttime": "2026-08-30 08:00",
    "endingtime": "2026-08-30 22:00",
    "spaceInfo": { "no": "F1B001", "areaInfo": { "name": "信息空间", "enname": "..." } }
} } }
```

失败时 `status != 1`，读 `msg`（如「座位已被预约」「预约时间已过期」「已达预约上限」等）。

### 4.6 我的预约 / 取消

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/user/index/book` | 我的预约记录（HTML 页，`tbody` 里含预约信息；需登录） |
| GET | `/user/index/index/from/index` | 我的中心（个人中心页） |
| POST | `/api.php/profile/books/<id>` | 取消预约，body `{_method:"delete", id, userid, access_token}`；`id` 为预约 id（非座位 id） |

### 4.7 用户查询（团队/同行人，一般不用）

`GET /api.php/users/<学工号>` → `{status:1, data:{list:{id, name, ...}}}`；`status==2` 表示该用户被加入黑名单。

## 5. 页面路由

| 路由 | 说明 |
|------|------|
| `/home/web/index` | 首页 |
| `/home/web/f_second` | 座位预约（馆舍列表，选馆舍） |
| `/home/web/seat/area/<馆舍id>` | 选楼层（ZRender 画楼层区域） |
| `/home/web/seat2/area/<楼层id>/day/<date>` | 选阅览区与日期 |
| `/web/seat3?area=<阅览区id>&segment=<时段id>&day=<date>&startTime=<HH:mm>&endTime=<HH:mm>` | 选座位并提交 |
| `/web/index` · `/web/area` | 旧版入口 |
| `/cas/index.php?callback=<url>` | SSO 登录 |

## 6. Node 纯 HTTP 最小示例（无 Playwright）

```js
const BASE = 'https://seat.lib.tsinghua.edu.cn';

// 数据查询：无需 token，直接 GET + JSON.parse
async function getJson(path) {
  const resp = await fetch(BASE + path);
  return resp.json();  // {status, msg, data}
}
await getJson('/api.php/v3areas/35');                 // 北馆楼层
await getJson('/api.php/v3areas/37/date/2026-08-30'); // 北馆二层阅览区+时段
await getJson('/api.php/v3areadays/35');              // 可约日期
await getJson('/api.php/spaces_old?area=45&segment=1682804&day=2026-08-30&startTime=08:00&endTime=22:00'); // 座位

// 预约：需要 access_token + userid（登录后从页面 HTML 的 window.ska 提取）+ PHPSESSID Cookie
async function book(seatId, segment, token, userid, phpsessid) {
  const body = new URLSearchParams({
    access_token: token, userid, segment, type: '1', operateChannel: '2',
  });
  const resp = await fetch(`${BASE}/api.php/spaces/${seatId}/book`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': `PHPSESSID=${phpsessid}` },
    body: body.toString(),
  });
  return resp.json();
}
```

> 与体育场馆系统（签名 + AES）和 IC 空间系统（`token` 请求头）都不同：本系统**无签名、无加密、无 token 请求头**，鉴权全靠「HTML 里注入的 access_token/userid + PHPSESSID Cookie + POST 表单体」。
