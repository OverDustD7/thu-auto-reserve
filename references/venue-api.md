# 清华体育场馆预约系统 —— API 逆向参考

本文档记录了从 `www.sports.tsinghua.edu.cn/venue` 前端代码中逆向出的接口与认证机制，供需要手工调用（无 Playwright 时的纯 HTTP 方案）或排查问题时使用。**日常使用优先用 `scripts/venue-helper.js`**。

## 1. 基本信息

| 项 | 值 |
|----|----|
| 前端入口 | `https://www.sports.tsinghua.edu.cn/venue/#/home` |
| API 基础地址 | `https://www.sports.tsinghua.edu.cn/venue/site` |
| 前端路由 | hash 路由：`#/home`、`#/appointment`、`#/gymnasium`、`#/time`、`#/timeform`、`#/reservationlist`、`#/crossdaytable`、`#/crossdayform`、`#/personal`、`#/login`、`#/blank` |
| 登录方式 | 单点登录（SSO / 清华统一身份认证），登录页选「校内登录 → 统一身份认证登录」 |
| 预约类型 | 时段预约 `PERIOD_RESERVE`（另有跨天预约、座位预约等） |
| 支付 | 微信支付 / 支付宝 |

## 2. 认证与签名

### 2.1 请求头

| 头 | 值 | 说明 |
|----|----|----|
| `token` | 登录后从 `localStorage.token` 读取（JSON 字符串需 parse） | 用户会话令牌 |
| `Language-Set` | `0` | 语言（0=中文） |
| `x-api-version` | `2.0.0` | 仅 `/api/*` 接口需要 |

### 2.2 签名（每个请求的 query 参数）

前端用 `getSign(appId, secret)` 生成，但 secret 被忽略，实际 key 由 `getKeys()` 计算：

```
appId    = 1497016617475903488
timeStamp = 当前毫秒时间戳（字符串）
nonce    = 32 位随机字符串（字母数字）
sign     = md5("appId=1497016617475903488&nonce=" + nonce + "&timeStamp=" + timeStamp + "&key=57325972627c40bd8c77296d39293705")
```

把 `appId`、`timeStamp`、`nonce`、`sign` 四个参数追加到每个请求的 query string。

### 2.3 响应解密

- 若响应体是 JSON **对象**：直接使用。
- 若响应体是**字符串**（加密）：用 AES-256-CBC 解密后再 `JSON.parse`：

```
算法   AES-256-CBC
密钥   57325972627c40bd8c77296d39293705  (32 字节)
IV     0000000000000000                 (16 字节)
Padding Iso10126（CryptoJS）—— 解密后去掉末尾“最后 1 字节”数量的填充即可
密文   base64
```

### 2.4 统一响应结构

```json
{ "code": 0, "message": "请求成功", "success": true, "data": { ... } }
```

- `code == 0` 成功；`code != 0` 失败。
- 未登录 / 登录过期：`errorCode == 1130002`，`code == 500`，message「登录过期，请重新登录」。
- 其它鉴权错误码：`300/301/401/1030002/1130001/1130008/1130009/11300011/11300012/11300013` 等，遇到时应重新登录。

## 3. 登录流程（SSO）

1. `GET /cas/address` → 获取 CAS 登录地址（可带 `redirectUrl`）。
2. 浏览器跳转到 CAS 地址，用户完成统一身份认证。
3. CAS 回调到站点（携带 ticket），前端调 `POST /cas/token` 用 ticket 换取业务 `token`。
4. `token` / `refreshToken` / `userInfo` 写入 `localStorage`。

接口：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/cas/address` | 获取 CAS 登录地址 |
| GET | `/cas/address/list` | CAS 地址列表 |
| POST | `/cas/token` | CAS ticket 换 token |
| POST | `/cas/logout` | CAS 登出 |
| POST | `/system/login/accessToken` | 账号密码登录（清华用 SSO，一般不用） |
| GET | `/system/login/getLoginUser` | 获取当前登录用户（用于判断登录态） |
| POST | `/system/login/refreshToken` | 刷新 token |
| GET | `/system/login/enableValidCode` | 是否启用登录验证码（当前 `USE_VALID_CODE=0`，无验证码） |
| POST | `/system/login/logout` | 登出 |

## 4. 业务接口

### 4.1 运动项目 / 场地

| 方法 | 路径 | 参数 | 说明 |
|------|------|------|------|
| GET | `/api/site/scene/list` | — | 运动项目（场景）列表，元素含 `uuid`、`sceneName`（中文名）、`sceneEnName`、`relatedType`（本场馆恒为 `DEV`） |
| GET | `/api/site/scene/detail` | `uuid` | 场景详情（含 `relatedType`、`sceneUseType` 等） |
| GET | `/api/site/devKind/list` | `uuid=<sceneUuid>` | 设备类型列表，取 `data[0].uuid` 作为 `devKindUuid`（如「羽毛球」） |
| GET | `/api/site/chooseByType` | `sceneUuid` + `siteType=BUILDING` | 场馆/楼栋，取 `data[0].uuid` 作为 `buildingUuid`（如「综合体育馆」）；再用 `siteUuid=<buildingUuid>&siteType=ROOM` 可取房间 |
| ~~GET~~ | ~~`/api/site/choose`~~ | `sceneUuid` | **已弃用**：本场馆返回 `500` 服务器异常 |
| ~~GET~~ | ~~`/api/site/siteType`~~ | `sceneUuid` | 返回 `{label,value}`（value 为 `kindId`），非查时段所需，仅作参考 |
| GET | `/site/room/dict/list` | — | 场地/房间字典（本场馆返回 1810003 数据不存在） |

### 4.2 可预约时段（真实流程：`CURRENT_RESERVE` + `current/page`）

> ⚠️ 本场馆查时段**不是** `PERIOD_RESERVE` + `current/period`（`current/period` 会报 `RESERVE_SITE_TYPE_NOT_EMPTY`）。真实前端走的是 **`CURRENT_RESERVE` + `/api/reserve/current/page`**。

完整查时段流程（脚本 `venue-helper.js` 已实现）：

1. `GET /api/site/devKind/list?uuid=<sceneUuid>` → 取 `data[0].uuid` 作为 `devKindUuid`
2. `GET /api/site/chooseByType?sceneUuid=<sceneUuid>&siteType=BUILDING` → 取 `data[0].uuid` 作为 `buildingUuid`（`classTypeUuid`）
3. `POST /api/reserve/current/page`，请求体：

```json
{
  "sceneUuid": "<场景uuid>",
  "resvKind": "CURRENT_RESERVE",
  "devKindUuid": "<步骤1的devKindUuid>",
  "siteType": "DEV",                      // = 场景 relatedType（本场馆恒为 DEV）
  "searchValue": "",
  "siteKindId": "",
  "classTypeEnum": "BUILDING",
  "classTypeUuid": "<步骤2的buildingUuid>",
  "reserveDate": "2026-08-30",
  "sceneUseType": "SPORT_GROUP",
  "pageSize": 999,
  "pageNum": 1
}
```

响应 `data` 为场地数组（羽1/羽2/…），每个元素含：

- `siteName` / `uuid`（场地名与 uuid）、`kindName`（如「羽毛球」）
- `sessionVo[]`：当日场次数组，每个场次含：
  - `beginDate`（如 `20260830`）、`beginTime`、`endTime`（如 `08:00`/`10:00`）
  - `reserveStatus.reserveStatus`：**`"Y"`=可约，`"N"`=不可约**
  - `reserveStatus.code` / `reserveStatusReason`：不可约原因（`401000138`=场次已结束，`401000136`=预约人数已满）
  - `userFeeDetails.chargingUnitPrice`：单价（分，如 `4000` = ¥40）

**可约判定**：`sessionVo[].reserveStatus.reserveStatus === "Y"`。

其余接口（`current/detail`、`cross/page`、`cross/detail`、`quick/*`）见下方速查，字段类似。

<details>
<summary>旧文档（已弃用）`current/period` + `PERIOD_RESERVE`</summary>

```json
{
  "sceneUuid": "<运动项目uuid>",
  "siteUuid": "<场地uuid>",
  "siteType": "<场地类型>",
  "resvKind": "PERIOD_RESERVE",
  "reserveStartDate": "2026-08-29",
  "reserveEndDate": "2026-09-04"
}
```

在本场馆该接口始终返回 `errorCode 2210007 RESERVE_SITE_TYPE_NOT_EMPTY`，不要使用。

</details>

### 4.3 预约提交

提交前通常先「锁场」（防止冲突），再提交。

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/reserve/lockSite` | 锁场，返回 lock 值（用于 addReserve 的 `lockKey`） |
| POST | `/api/reserve/unLockSite` | 解锁 |
| POST | `/api/reserve/addReserve` | 提交预约 |
| GET | `/api/reserve/getLockConfig` | 锁场配置 |

`lockSite` 请求体：

```json
{
  "sceneUuid": "<...>",
  "resvKind": "PERIOD_RESERVE",
  "siteUuid": "<...>",
  "siteType": "<...>",
  "resvMember": [ { "memberType": "...", "ident": "...", "name": "..." } ],
  "reserveTime": [ { "startTime": "2026-08-29 19:00:00", "endTime": "2026-08-29 20:00:00" } ],
  "formParam": { "formId": "<动态表单uuid>" },
  "lockTime": 1800
}
```

`addReserve` 请求体（**已按 F12 实测报文校准**，综体羽毛球当日预约）：

```json
{
  "sceneUuid": "<运动项目uuid>",
  "sceneUseType": "SPORT_GROUP",
  "siteUuid": "<场地uuid>",
  "siteType": "DEV",
  "reserveTime": [ { "startTime": "2026-09-02 08:00:00", "endTime": "2026-09-02 10:00:00" } ],
  "siteSessionReserve": [ { "sessionDetailUuid": "<场次uuid>", "reserveTime": { "startTime": "...", "endTime": "..." } } ],
  "resvMember": [ "<userId>" ],
  "resvKind": "CURRENT_RESERVE",
  "payType": "PAY_ONLINE",
  "purchaseUuid": "",
  "formParam": {
    "formId": "<formRuleVo.formUuid>",
    "deployUuid": "<从 /workflow/process/brief/<formId> 取>",
    "variables": {},
    "chooseCandidates": {}
  },
  "captcha": "<滑块验证码 token>"
}
```

> 关键点（实测确认）：
> - **`captcha` 必填**：前端有 blockPuzzle 滑块人机验证，流程 `POST /system/captcha/drag/get`（拿拼图）→ 用户拖滑块 → `POST /system/captcha/drag/check`（校验，返回 token）→ token 放进 `addReserve.captcha`。**纯 API 无法生成该 token**，必须人工拖一次滑块。
> - `resvMember` 是**纯 userId 字符串数组**（不是对象）。
> - `siteSessionReserve[].sessionDetailUuid` = `current/page` 返回的 `sessionVo[].uuid`。
> - `deployUuid` 来自 `GET /workflow/process/brief/<formId>`；简单场景（羽毛球等）=「通用数据表单」`fields:[]`，故 `variables`/`chooseCandidates` 为空对象 `{}`。
> - `sceneUseType`：羽毛球=`SPORT_GROUP`、游泳=`SPORT_PERSON`；`payType` 恒为 `PAY_ONLINE`。

### 4.4 订单与支付

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/reserve/reserveRecord` | 我的预约记录（订单列表，含支付状态）；body `{pageNum,pageSize}`，记录含 `resvUuid`/`sceneName`/`resvTime`/`resvStatus` |
| GET | `/api/reserve/historyRecord` | 历史记录 |
| GET | `/api/reserve/details` | 预约详情 |
| POST | `/api/reserve/details/update` | 修改预约 |
| POST | `/api/reserve/cancelReserve` · `/cancelReserve/period` | 取消预约 |
| POST | `/api/reserve/cancelReserveBatch` | 批量取消 |
| POST | `/api/reserve/endEarly` | 提前结束 |
| GET | `/api/reserve/recommend` | 推荐 |
| GET | `/api/reserve/record/quota` | 预约额度记录 |

> 支付由站内收银台/二维码完成（微信/支付宝），无独立公开的「下单支付」接口暴露在前端主包中；实际支付在预约提交后跳转或在 `#/reservationlist` 的「去支付」触发。**支付必须由用户本人在可见浏览器扫码完成。**

取消预约（`POST /api/reserve/cancelReserve`）：body `{ "resvUuid": "<订单 resvUuid>" }`（**已实测成功取消未支付订单**）。限制：订单字段 `cancelBeforeStartTime = 1440`（分钟）= **必须提前 24 小时取消**，否则返回 `401000103 当前时间不支持取消`（此限制与是否支付无关）。

**滑块人机验证**（预约提交前）：`POST /system/captcha/drag/get`（body `{captchaType:"blockPuzzle", clientUuid, ts}`）→ 用户拖滑块 → `POST /system/captcha/drag/check`（body `{captchaType, pointJson, token}`）→ 返回 captcha token 供 `addReserve.captcha` 使用。`pointJson` 由前端滑块组件加密生成，**纯 API 无法绕过**。

**退款（已支付订单）**：已支付订单的取消走退款流程（前端有 `/refundRecord` 退款记录页），与 `cancelReserve` 是两回事；退款接口尚未逆向，需用浏览器在预约记录页操作。

### 4.5 用户信息

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/user/updateUserInfo` | 更新用户信息 |
| GET | `/api/user/getUserCredit` | 用户信用 |
| GET | `/api/user/getSceneCredit` | 场景信用 |
| GET | `/api/reserve/person` | 预约人信息 |
| GET | `/api/reserve/commonlyUsed` | 常用小组 |

### 4.6 其它

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/ms/banner/list` · `/news/list` · `/notice/list` | 首页内容 |
| GET | `/api/app/list` | 应用列表 |
| GET | `/api/reserve/system/config` | 系统配置（注意：走不同 base 的实例，路径可能不在此 base 下） |
| GET | `/resv/instr/getBySiteIdAndType` | 场地须知 |
| GET | `/api/reserve/custom/*` | 座位/自定义预约变体（`/custom/current/page`、`/custom/addReserve` 等） |

### 4.7 抽签报名（lottery）

热门场地（目前仅「综体羽毛球」晚场）采用**抽签报名**：报名 → 到点出签 → 中签后缴费。**无滑块验证码，纯 API 即可报名**。

| 方法 | 路径 | 参数 | 说明 |
|------|------|------|------|
| GET | `/api/lottery/scene` | `sceneUuid` | 该场景是否支持抽签：`data:true/false` |
| GET | `/api/lottery/scene/dev` | `sceneUuid` | 抽签页的场地筛选 tabs（`[{label,value}]`） |
| GET | `/api/lottery/scene/notice` | `sceneUuid` | 场景抽签须知 |
| POST | `/api/lottery/plans` | body `{pageSize,pageNum,sceneUuid,siteIds:[],orderItems:"lotterySort",orderRule:"asc"}` | 抽签场次列表；`data` 每项含 `lotteryUuid/lotteryTitle/registrantNum/identLimit/reserveSiteName/buildingId`，`count` 为总数 |
| GET | `/api/lottery/plan/detail` | `lotteryUuid` | 某场次详情；`data.instanceDetailVos[]` 为可报名日期，每项 `instanceUuid/lotteryDevDate/applyStartTime/applyEndTime/lotteryTime/paymentTime/unAvailableStatus` |
| GET | `/api/lottery/plan/notice` | `lotteryUuid` | 场次报名须知（`data.noticeContent`，HTML） |
| POST | `/api/lottery/plan/instance` | body `{instanceUuids:[uuid]}` | **报名**（两步里的第二步；无验证码） |
| GET | `/api/lottery/instance/list` | `pageNum`+`pageSize` | 我的抽签报名（含 `winLottery/lotteryDraw/paymentTime/cancelRegistration` 等） |
| GET | `/api/lottery/instance/detail` | `instanceUuid` | 单条报名详情 |

字段约定：

- `unAvailableStatus` 位掩码：`1`(0b1)=已报名、`14`(0b1110)=未开放报名、`0`=可报名。
- `identLimit` 身份编码：`512`=学生、`256`=教职工（空=无限制）。
- 综体羽毛球规则：晚场 18:00–20:00、20:00–22:00；提前 7 天 8:00 开报、提前 6 天 22:00 截止、提前 6 天 22:30 出签、中签后提前 3 天 7:00 前缴费。

## 5. 页面路由与预约 UI 流程

1. `#/home`：首页（运动项目入口）
2. `#/appointment`（子路由 `#/gymnasium`）：选择运动项目 / 场馆
3. 场景详情 `#/gymnasium?uuid=<sceneUuid>`：点「预约」进入预约
4. `#/time?uuid=<sceneUuid>&siteUuid=<siteUuid>&siteType=<siteType>`：选择日期与时段
5. `#/timeform`：预约表单（预约人、须知、动态字段），提交
6. `#/reservationlist`：预约记录，含「去支付 / 取消」等操作

## 6. Node 纯 HTTP 最小示例（无 Playwright）

```js
const crypto = require('crypto');
const https = require('https');
const APP_ID = '1497016617475903488';
const KEY = '57325972627c40bd8c77296d39293705';

function signParams() {
  const timeStamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex'); // 32 位
  const raw = `appId=${APP_ID}&nonce=${nonce}&timeStamp=${timeStamp}&key=${KEY}`;
  return { appId: APP_ID, timeStamp, nonce, sign: crypto.createHash('md5').update(raw).digest('hex') };
}

function decryptAes(b64) {
  const d = crypto.createDecipheriv('aes-256-cbc', Buffer.from(KEY), Buffer.from('0000000000000000'));
  d.setAutoPadding(false);
  const dec = Buffer.concat([d.update(Buffer.from(b64, 'base64')), d.final()]);
  const pad = dec[dec.length - 1];
  return dec.slice(0, dec.length - pad).toString('utf8');
}

// GET /venue/site/api/site/scene/list?appId=...&timeStamp=...&nonce=...&sign=...
// headers: { token: '<token>', 'Language-Set': '0', 'x-api-version': '2.0.0' }
```
