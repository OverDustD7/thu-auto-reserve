# 清华图书馆 IC 空间预约系统 —— API 逆向参考

本文档记录了从 `cab.lib.tsinghua.edu.cn` 前端代码中逆向出的接口与认证机制，供需要手工调用（纯 HTTP 方案）或排查问题时使用。**日常使用优先用 `scripts/space-helper.js`**。

## 1. 基本信息

| 项 | 值 |
|----|----|
| 前端入口 | `https://cab.lib.tsinghua.edu.cn/#/ic/home`（Vue 单页应用，`#/xxx` 为 hash 路由） |
| API 基础地址 | `https://cab.lib.tsinghua.edu.cn/ic-web`（来自 `config/config.js` 的 `window.g.ApiUrl = '/ic-web'`） |
| 登录方式 | 清华统一身份认证（CAS 单点登录，`config.js` 中 `loginMode: 2`） |
| 业务类型 | 研讨间 / 座位 / 考研座位 / 活动 / 外借设备 / 电子阅览室（`sortedNav: [1, 8, 32, 16]`，1=研讨间 8=座位 32=考研座位 16=活动） |

## 2. 认证与请求头

**没有** query 签名（不同于体育场馆的 appId/nonce/sign），**响应体也不做 AES 加密**（明文 JSON）。只需携带请求头：

| 头 | 值 | 说明 |
|----|----|----|
| `token` | 登录后从 `sessionStorage.userInfo.token` 读取（`userInfo` 是 JSON 字符串，需 `JSON.parse`） | 用户会话令牌 |
| `lan` | `1`（中文；可省略，前端默认 1） | 语言 |

axios 配置：`withCredentials = true`（Cookie 随请求发送）。

### 统一响应结构

```json
{ "code": 0, "message": "查询成功", "data": {...}, "count": 0, "vals": null }
```

- `code == 0` 成功；`code != 0` 失败。
- `code == 300` 表示「用户未登录 / 登录过期」，此时应重新走登录流程。
- `code == 1` 参数缺失；`code == 500` 服务器异常 / 系统繁忙。
- 部分列表接口的 `data` 为数组，其元素里的 `content` 字段是 **HTML 实体转义**（`<` → `&lt;` 等），前端用 `T()` 反转义，非加密。

## 3. 登录流程（CAS / 清华统一身份认证）

1. `GET /ic-web/auth/address?finalAddress=<origin>&manager=false&consoleType=16`
   返回 CAS 登录地址，形如：
   ```json
   { "code":0, "data":"https://cab.lib.tsinghua.edu.cn/authcenter/toLoginPage?redirectUrl=https%3A%2F%2Fcab.lib.tsinghua.edu.cn%2Fic-web%2F%2Fauth%2Ftoken%3Fuuid%3D<c91cd04e84a54977aae0a01545d26cae>&extInfo=" }
   ```
2. 浏览器跳转到该 CAS 地址（`/authcenter/toLoginPage`，清华统一身份认证），用户完成登录。
3. CAS 回调到 `/ic-web//auth/token?uuid=<uuid>`（注意路径中是双斜杠），由后端换取会话 Cookie。
4. 前端调用 `GET /ic-web/auth/userInfo` 拿到 `data`（含 `token`、`nickName`、`roleId` 等），写入 `sessionStorage.userInfo`，`sessionStorage.isLogin = true`。

> 说明：`/auth/token?uuid=...` 由后端 + 会话 Cookie 完成 ticket 校验，前端 JS 里**没有** ticket 处理逻辑。因此脚本采用「可见浏览器完成 SSO → 轮询 `sessionStorage.userInfo.token`」的方式登录，与体育场馆 skill 一致。

### 登录相关接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/auth/address` | 获取 CAS 登录地址（参数 `finalAddress`、`manager`、`consoleType`） |
| GET | `/auth/userInfo` | 获取当前用户信息（含 token；未登录返回 `code 300`） |
| GET | `/auth/webapp` | 认证配置 |
| GET | `/login/publicKey` | RSA 公钥（账号密码登录 `loginMode=1` 时用，清华走 CAS 一般不用） |
| POST | `/login/user` | 账号密码登录 |
| POST | `/login/signOut` | 登出 |

## 4. 业务接口

### 4.1 导航菜单（分类列表）

> **当前实测状态（2026-08-30，真实账号）**：六个菜单接口里**只有 `roomMenu`（研讨间）有数据（9 条）**；`seatMenu`（座位）、`psgSeatMenu`（考研座位）、`borrowMenu`（外借设备）、`digitalReadingRoomMenu`（电子阅览室）均返回**空数组**（对应模块当前未开放 / 不在预约期）。`activityMenu`（活动）返回的是研讨间数据（kindClass=1，7 条，无研讨舱/双人舱），疑似后端复用。`psgSeatMenu` 按登录身份过滤（教职工 ident=256 看不到「论文写作间」）。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/roomMenu` | 研讨间（空间）导航菜单（✅ 有数据） |
| GET | `/seatMenu` | 座位导航菜单（⚠️ 当前空） |
| GET | `/psgSeatMenu` | 考研座位导航菜单（⚠️ 当前空 / 按身份过滤） |
| GET | `/activityMenu` | 活动导航菜单（⚠️ 返回研讨间数据） |
| GET | `/borrowMenu` | 外借设备导航菜单（⚠️ 当前空） |
| GET | `/digitalReadingRoomMenu` | 电子阅览室导航菜单（⚠️ 当前空） |
| GET | `/sysConfig` | 系统配置（需登录） |
| GET | `/sysConfig/public` | 公开系统配置（无需登录） |
| GET | `/sysInfo` · `/sysInfo/help` | 系统说明/须知（参数 `sysType`、`sysKind`、`status`、`sysValue`） |
| GET | `/codingTable/getAll` | 编码字典表 |

### 4.2 研讨间（空间）预约

页面路由：`#/ic/researchSpace/:type/:kindId/:campusId`（清华 `spaceListType=1`，即 `type=1`，`kindId` 与 `campusId` 均取 `roomMenu` 返回的 `kindId`）。

| 方法 | 路径 | 参数 | 说明 |
|------|------|------|------|
| GET | `/reserve` | `kindIds` + `resvDates=YYYYMMDD` + `sysKind` | **实时空闲时段主数据源**（权威，与页面时间网格一致）：返回该类型下每个房间（`devName`）、开放时段（`openTimes[]`）与占用记录（`resvInfo[]`，`startTime`/`endTime` 为毫秒时间戳）。空闲 = 开放窗口 − 占用区间 |
| POST | `/reserve/entrance/save` | 见下 | 提交空间（研讨间）预约 |
| POST | `/reserve/quickResv` | 见 4.4 | 快速预约（研讨间） |
| GET | `/roomDevice/roomInfos` | — | 房间静态信息（`resvInfos` 常为 null，**不可作为占用依据**） |
| GET | `/room/openTimes` | `roomId` | 某房间的开放时段（辅助） |
| ~~GET~~ | ~~`/reserve/entrance`~~ | — | **已弃用**：本馆返回 `code 500`「系统繁忙」，勿用 |

`/reserve` 响应 `data` 结构（研讨间，`sysKind=kindClass`）：
```json
[
  {
    "devId": 11846031,
    "devName": "法F5-双人舱2",
    "kindId": 12149595,
    "kindName": "法律馆双人舱（五层)",
    "openStart": "08:00", "openEnd": "22:00",
    "openTimes": [ { "openStartTime": "08:00", "openEndTime": "22:00", "openLimit": 1 } ],
    "resvInfo": [
      { "resvId": 18514297, "startTime": 1788175800000, "endTime": 1788184800000, "trueName": "李*嵘", "resvStatus": 1027 }
    ]
  }
]
```

`POST /reserve/entrance/save` body（与 `quickResv` 同构，字段依房间表单而定）：
```json
{
  "roomId": "<房间 id>",
  "scopeBeginTime": "2026-08-30 10:00",
  "scopeEndTime": "2026-08-30 12:00",
  "duration": "<时长选择值>",
  "testName": "<主题>",
  "captcha": "<验证码>",
  "memo": "<备注>"
}
```

> ⚠️ 提交需要 `captcha`，纯 API 无法全自动；建议用浏览器 UI 完成最终提交。

### 4.3 座位预约（实测参数）

| 方法 | 路径 | 参数 | 说明 |
|------|------|------|------|
| GET | `/seatMenu` | —（无参） | 座位导航菜单 |
| GET | `/seatRoom/open` | `roomId` | 座位室开放状态（`spanDay` 跨天区域用） |
| GET | `/seatRoom/openScope` | `roomId` | 座位室开放范围 |
| GET | `/reserve` | `roomIds` + `resvDates=YYYYMMDD` + `sysKind=8` | **座位图/可约状态主数据源**（跨天用 `resvDates="起始,结束"`） |
| GET | `/reserve/seatArea` | `date=YYYYMMDD` | 座位区域级联树（快速预约页用） |
| GET | `/openApi/seat/reserveInfo` | `roomIds` + `resvDates=YYYYMMDD` + `sysKind=8` | 座位预约信息 |
| GET | `/seat/common/use` | `pastTime` + `sortEnum` + `page` + `pageNum` | 常用座位 |
| GET | `/psgSeatMenu` | —（无参） | 考研座位菜单 |
| GET | `/psgSeat/open` | `roomId` | 考研座位开放状态 |
| GET | `/reserve/areaInfo` | `roomIds` + `resvDates` + `sysKind` | 预约区域信息（编辑态） |
| POST | `/seatDevice/coordinate` | body 见下 | 保存座位坐标（管理端画座位图，普通用户一般不用） |
| POST | `/seatDevice/mcoordinate` | body `{coordinateList:[{devId,coordinate:"left%,top%"}]}` | 保存座位坐标（移动端） |
| POST | `/digitalReadingPcRoom/coordinate` | body 同 coordinate | 电子阅览室电脑位坐标 |

`POST /seatDevice/coordinate` body：
```json
{
  "seatPoints": [ { "roomId": "<roomIds>", "type": 1, "property": 1, "size": 12, "textSize": 12 } ],
  "coordinates": [ { "devId": "<seat device id>", "coordinate": "23.456789,41.234567,0", "devProp": 0 } ]
}
```

### 4.4 预约提交（实测参数）

| 方法 | 路径 | body | 说明 |
|------|------|------|------|
| POST | `/reserve` | 见下 | 提交**座位/考研座位**预约 |
| POST | `/reserve/entrance/save` | 见 4.2 | 提交**研讨间**预约 |
| POST | `/reserve/quickResv` | `{roomId, scopeBeginTime, scopeEndTime, duration, testName, captcha, memo}` | 快速预约（研讨间） |

### 4.5 我的预约记录（个人中心）

| 方法 | 路径 | 参数 | 说明 |
|------|------|------|------|
| GET | `/reserve/resvInfo` | `beginDate` + `endDate` + `needStatus` + `page` + `pageNum` + `orderKey` + `orderModel` | **我的预约列表**（个人中心「个人预约」tab） |
| POST | `/reserve/delete` | body `{ "uuid": "<预约 uuid>" }` | **取消预约**（uuid 取自 resvInfo 返回的 `uuid` 字段，非 resvId） |
| GET | `/reserve/count` | — | 预约计数（注意：不是「总数」，勿当列表总数用） |
| GET | `/reserve/punishInfo` | — | 我的违约/处罚记录 |
| GET | `/reserve/endList` | — | 可提前结束的预约列表 |
| GET | `/creditRec/getOwn` | — | 我的信用记录 |

`/reserve/resvInfo` 参数：
```json
{
  "beginDate": "2026-08-01",
  "endDate": "2026-08-30",
  "needStatus": "6",       // 状态位掩码求和；空=全部（2待生效 4已生效 16已违约 128已结束）
  "page": 1,
  "pageNum": 10,
  "orderKey": "gmt_create",
  "orderModel": "desc"
}
```
> ⚠️ 该接口**必须带 `beginDate`/`endDate`**，否则返回 404（用错参数 `pageNum/pageSize` 也会 404）。

`POST /reserve`（座位）body：
```json
{
  "sysKind": 8,
  "appAccNo": "<账号>",
  "memberKind": 1,
  "resvMember": ["<账号>"],
  "resvBeginTime": "2026-08-30 10:00:00",
  "resvEndTime": "2026-08-30 12:00:00",
  "testName": "<主题>",
  "captcha": "<验证码>",
  "resvProperty": 0,
  "resvDev": ["<座位 devId>"],
  "memo": "<备注>"
}
```
考研座位用 `sysKind:32`、`resvProperty:32`、`resvDev` 为考研座位 devId。

> ⚠️ 提交预约需要 `captcha`（验证码，`GET /captcha/get` 获取），纯 API 无法全自动通过；且字段（成员、主题、验证码）需用户确认。**建议最终提交用浏览器 UI 完成**，并在浏览器 DevTools → Network 核对真实报文。

### 4.6 活动 / 外借设备 / 其它

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/activity` · `/activity/resvInfo` | 活动列表 / 活动预约信息 |
| GET/POST | `/activity/custom/advance` · `/join` · `/exit` · `/save` · `/delete` · `/resvInfo` · `/review` | 活动报名/退订/审核 |
| GET | `/activityReview` · `/activityReview/all` · `/content` | 活动审核 |
| GET | `/borrow/reserve/kind` · `/roomInfo` · `/resvRules` · `/timeScope` · `/single` | 外借设备 |
| GET | `/borrow/reserve/own` · `/borrow/device/resvDevInfo` | 我的外借 |
| GET | `/captcha/get` · `/captcha/check` | 验证码 |
| GET | `/account/info` · `/account/getMembers` · `/account/update` | 账户/成员 |
| GET | `/creditRec/getOwn` · `/creditStarRec/own` · `/creditConversionRec` · `/creditPunishRec/surPlus` | 信用/违约记录 |
| GET | `/feedback/*` | 意见反馈 |
| GET | `/news` · `/news/questions` | 通知公告 |
| GET | `/photomanager/banner` | 首页轮播图 |

### 4.9 邮箱绑定（预约前置条件）

> **结论（2026-08-31 实测）**：`auth/userInfo` 与 `account/info` 都会返回 `email` 字段，二者一致；`mustact=1`（`/sysConfig/public`，memo「是否激活邮箱或者手机才能使用」）表示**邮箱必须激活才能预约**。判断「是否已绑定」**以 `GET /account/info` 的 `data.email` 是否为空/非有效邮箱为准**，不要用 `auth/userInfo.email` 非空来判断——该字段可能被 SSO 带入默认值。
>
> - 绑定：`POST /account/update`，body `{ email }`（前端 `patchInfo`），响应 `code 0` 即成功。
> - 校验：绑定后回读 `GET /account/info`，确认 `data.email` 为有效邮箱。
> - 手机同理：`data.handPhone`；`POST /account/update` body `{ handPhone }`。
> - 前端「个人中心 → 个人信息」页的 `mustact` 位掩码：`4`=邮箱必填、`8`=手机锁定、`16`=邮箱锁定（来自清华 SSO，不可编辑）。

## 5. 页面路由

- `#/ic/home`：首页（各类空间入口）
- 空间（研讨间）预约：选择房间 → 选日期/时段 → 提交
- 座位预约：选楼层/区域 → 座位图点选 → 提交
- 考研座位：独立模块（`examSeatReserveMode: 1`，走「研讨间跨天预约模式」）

## 6. Node 纯 HTTP 最小示例（无 Playwright）

```js
const API_BASE = 'https://cab.lib.tsinghua.edu.cn/ic-web';

async function api(token, method, path, params, data) {
  const url = new URL(API_BASE + '/' + path);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers = { 'lan': '1' };
  if (token) headers['token'] = token;
  if (data) headers['Content-Type'] = 'application/json';
  const resp = await fetch(url.toString(), {
    method,
    headers,
    body: data === undefined ? undefined : (typeof data === 'string' ? data : JSON.stringify(data)),
    credentials: 'include', // 带 Cookie（withCredentials）
  });
  return resp.json(); // 直接 JSON，无需解密
}

// 判断登录态：code==0 已登录；code==300 未登录
// GET /auth/userInfo  headers: { token }
```

> 与体育场馆系统不同：本系统**无签名、无 AES 响应加密**，只需 `token` + `lan` 头 + Cookie，响应直接 `JSON.parse`。
