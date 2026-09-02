# 学生清华小程序 · 活动室申请 API（已逆向，内存取证 + 实测）

> 通过读取运行中的小程序渲染/主/网络进程内存，完整逆向出后端 API + 鉴权，并已用真实 JWT 实测通过。
> 这解决了「打开 51 个活动室窗口逐个查」的问题——一次 API 调用即可批量拿到全部活动室。

## 一、后端与鉴权（关键）

- **API 基线**：`https://student.tsinghua.edu.cn/v2/api`
- **鉴权**：请求头 `Authorization: Bearer <jwt>`
- **jwt 来源**：
  - 微信小程序登录：`POST /v2/api/activity/wechat/login`，body `{code: <wx.login的code>}` → 返回 jwt。
  - jwt 存于 `getApp().globalData.jwt`；也出现在 **主进程(WeChatAppEx main)** 与 **网络进程(WeChatAppEx network)** 的内存里（ASCII/拉丁1 单字节存储）。
- **jwt payload 示例**：`{"card":"<学号>","openId":"<openId>","iat":...,"exp":...}`（`card`=学号；**有效期约 7 天**）。
- **无需小程序窗口常开**：查询/推荐/占用/可约/申请/撤销都是 API 直连，只需一个有效 jwt（微信进程开着即实时提取；或已保存的 jwt）。**仅当 jwt 过期(~7天)时**，才需在微信里打开「学生清华」小程序刷新一次。
- 另见 THU 统一身份认证（SSO）：`https://student.tsinghua.edu.cn/do/off/ui/auth/login/form/<uuid>/0?/login/token?redirectURL=...`。

> 提取 jwt 的方式：读 WeChatAppEx(main/network) 进程内存，搜 `eyJ...`（JWT 头）格式串即可（**要按 ASCII/Latin-1 解码，不是 UTF-16**，否则被夹空字节漏掉）。**提取时会用服务端校验（`GET /activity/rooms`）避开已吊销的旧 token**——内存里常有上次会话的旧 token，取第一个解得出 payload 的会拿到被吊销的，须逐个校验取有效者。

## 二、接口清单（全部经 `/v2/api` 前缀）

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/activity/rooms` | **活动室列表（全部，实测 count=51）** |
| GET | `/activity/rooms/filters` | 筛选项（楼栋/容量/地点等） |
| GET | `/activity/rooms/:roomId/records` | **某活动室的借用记录（占用情况）** |
| GET | `/activity/rooms/:roomId/records?` | （可带分页/等参数） |
| GET | `/activity/rooms/invalid` | 失效/异常活动室 |
| POST | `/activity/wechat/login` | 微信登录（body `{code}`）换 jwt |
| POST | `/activity/wechat/bind` | 绑定 |
| POST | `/activity/wechat/unbind` | 解绑 |
| GET | `/activity/wechat/checkOAuthAppId` | 校验 OAuth AppID |
| GET | `/activity/wechat/mobile` / `/required` | 手机号 / 必填项 |
| GET | `/account/departments` | 部门列表 |
| GET | `/account/semesters` | 学期列表 |
| GET | `/activity/room-tickets` | 活动室票据 |
| GET | `/activity/records/check` | 申请记录校验 |
| GET | `/sports/check` | 体育校验 |
| GET | `/admin/lock/keyboards/{daily,period,recurrent}` | 门锁密码键盘 |
| GET | `/admin/activity/room-tickets` | 管理端票据 |
| GET | `/alert` | 提醒 |
| — | `/utils/files/` | 文件上传入口 |

## 三、活动室列表响应字段（/activity/rooms）

```json
{"count":51,"value":[
  {"available":true,"capacity":30,"id":"de98ebb8-...","image":"...","location":"C楼二楼",
   "name":"C200","needJunior":false,"note":"学生大客厅","seq":200,
   "tags":["学生大客厅","开放式空间","非密闭活动室","投影幕布"],"lock":null,
   "department":{"name":"办公室"}},
  ...
]}
```

普通研讨室：`roomId`、`roomName/name`、`buildingId`、`buildingName`、`floorName`、`capacity`、`location`、`note`、`tags`、`available`、`department`。

## 四、活动室占用响应字段（/activity/rooms/:id/records）

```json
{"count":3,"skip":0,"top":10,"value":[
  {"end":"2026-08-30T08:00:00.000Z","id":"7fac293d-...","start":"2026-08-30T07:00:00.000Z","status":"pending","ticketId":"..."},
  {"end":"...","id":"...","start":"...","status":"verified","ticketId":"..."}]}
```

- `start`/`end`：借用起止时间（ISO UTC）。
- `status`：`pending`(申请中) / `verified`(已通过/已借用)。
- 结合 `available`(rooms) 即可判断某活动室某时段是否可约。

## 五、一个关键认知

- 之前误判 `https://open.fdep.cn` 为业务后端——实际它只是**埋点/监控上报**（`financial_applet_events`，applet_start/data_disclosure/applet_crash 等）。
- 真正的业务 API 是 **`student.tsinghua.edu.cn/v2/api`**（内存里出现 26 处）。
- 鉴权 token 不在 renderer(页面渲染进程) 里，而在 **main(30256)/network(30976)** 进程，且是 **ASCII 单字节**存储。

## 六、验证结果

- `GET /activity/rooms`：HTTP 200，`count:51`，一次拿到全部 51 个活动室（C200 30人，C207/C208/C209/C210 各2人，C211 30人，C212-C215 11人，C217 20人，C218 4人，C219 2人，C221 11人，C309 43人，C310 11人，C319 25人，C320 33人，C321/C322 2人，C323 9/10人，C324 11人，C325 25人，B206/B210/B211/B231 10-15人，Arena 15人，Lounge 6人，Reception Hall 10人，Tea House 10人，Outer Space 8人）。**个别位置可能偶尔临时下架/消失（不必惊慌）**，实际以 `list` 实时返回为准。
- `GET /activity/rooms/de98ebb8-.../records`（C200）：HTTP 200，返回 3 条占用记录。

> 注意：jwt 会过期（约 7 天），与当前微信/学号登录会话绑定。脚本需在调用前从运行中的 WeChat 进程内存重新提取 jwt，或走 `/activity/wechat/login` 刷新。

## 六、封装命令（scripts/wechat-room-api.py）

| 命令 | 作用 |
|------|------|
| `jwt` | 提取当前 jwt（先扫微信进程内存；失败则回退本地已保存且未过期的 jwt） |
| `list [--json]` | 一次列出全部活动室（51 个，名称/位置/容量/标签/部门/可约） |
| `occupancy <房间名\|id> [--json]` | 查某活动室占用记录（start/end/status） |
| `recommend --capacity N --type 关键词 --location 位置 --max M [--exact N] [--json]` | 按容量/用途/位置推荐；`--type` 支持别名（会议/研讨/排练/舞蹈/投影/录音/拍摄/沙龙/茶/咖啡/会客） |
| `recommend --purpose 活动用途 --capacity N [--json]` | **按活动用途匹配房间用途**；一般用途（会议/讨论/讲座/沙龙/会客/自习等）自动避免 录音/导播/舞蹈/排练 等「专属功能房」（用不到其特殊功能、申请大概率不通过）；专用用途（排练/舞蹈/录音/拍摄/直播）则匹配专门房。支持用途：会议/讨论/自习/讲座/学术/沙龙/会客/团建/排练/舞蹈/录音/拍摄/直播 |
| `avail --capacity N --type 关键词 --location 位置 --from YYYY-MM-DD --to YYYY-MM-DD [--json]` | **高自动化**：按需求+日期区间，一次返回各匹配活动室的**可约时段**；**按各位置规则自动过滤**（胜因院22号 需提前≥3天、9:00-21:00；C楼/南区 7:00-23:00；均 ≤14天） |
| `apply --room 名 --date YYYY-MM-DD --start HH:MM --end HH:MM --organizer 主办方 --participants N [--subject 主题 --usage 内容 --type 类型 --target school --need-meal --need-film --is-big-event] [--yes]` | **直接 API 提交申请**（默认 dry-run 只构建请求，`--yes` 才提交；提交前校验时段冲突；`--need-meal/--need-film/--is-big-event` 勾选用餐/观影/重要会议，默认否） |
| `cancel --ticket <ticketId>` | **撤销申请**（`POST /activity/room-tickets/<id>/revoke` 204 + 自动 `remove` 删除草稿；**固定步骤，无需再手动 remove**） |
| `remove --ticket <ticketId>` | **删除草稿**（`POST /activity/room-tickets/<id>/remove`，204 成功，清草稿箱） |
| `mine [--json]` | **列出我的申请**（**申请中/被拒，不含草稿箱**，含 ticketId、类型、时间段） |
| `drafts [--json]` | **列出草稿箱**（未提交的草稿，含 ticketId，便于 remove 删除） |

> **改申请没有「修改」接口**：`cancel --ticket <原ticketId>`（已自动撤销+删草稿）后重新 `apply`。改时先 `mine` 定位，再复核房间容量/用途匹配、时间段可约等（复核清单见 SKILL.md 第八节）。

## 七、提交申请（apply）真实 schema（已抓包确认）

**后端是两步提交：**
1. `POST /v2/api/activity/room-tickets`，body：
   ```json
   {"organizer":"主办方","subject":"活动主题","participantCount":"N","coOrganizer":"",
    "activityType":"culture","activityTarget":"school","needMeal":false,"needFilm":false,"isBigEvent":false,
    "usage":"活动内容","records":[{"type":0,"roomId":"<房间UUID>","semesterId":"<学期UUID>","start":毫秒,"end":毫秒}]}
   ```
   → 200，返回 `{id: ticketId, ...}`。
2. `POST /v2/api/activity/room-tickets/<ticketId>/apply`，body `{}` → 204，提交成功。

> **`records` 是数组，接口允许提交多时段/单条>2h**（表单「继续添加」多时段；`/records/check` 对 4h、同天多条都返回 available）。但 **C楼/南区「单次≤2h、每人每日1次」是使用/审核规范**（接口不硬拦，审批大概率不通过）——同一天连续两时段违规、单场>2h 审不过；跨天才可以。`/revoke`（204）只对已提交的申请有效，**对「只创建未 apply」的草稿返回 412**。

**关键点（抓包才确认的）：**
- `records[].type = 0`；`roomId` 是**房间 UUID 字符串**（不是对象）；`semesterId` 是当前学期 UUID（`GET /account/semesters` 取）；`start`/`end` 是 **epoch 毫秒**（北京+8 转 UTC）。
- `participantCount` 是**字符串**（如 `"2"`）。
- `activityTarget`：**app 内唯一值为 `school`**（从内存搜索确认），**对所有活动室（C楼/南区/胜因院22号）通用**——`/activity/room-tickets` 是统一接口，`--target school` 即可。
- **`activityType` 合法值**（已全部确认 + 映射，7 个）：`party`(党团活动) / `organization`(社团活动) / `sports`(体育赛事) / `academy`(学术报告) / `culture`(文化活动) / `art`(文艺活动) / `others`(其它活动)。
- 撤销：`POST /activity/room-tickets/<ticketId>/revoke`，body `{ticketId}` → 204。

## 七·补、apply 表单字段 ↔ 参数（API 侧）
- **字段格式（灰字提示 = 每项该填什么）**：主办方「请输入主办方（单位+姓名）」→ 单位+姓名；活动主题「请输入活动主题」→ 具体题目（留空报「该项不能留空」）；参与人数「请输入活动人数」→ 数字 ≤ 容量；活动类型「选择活动类型」→ 下拉可往下滚共 7 类（党团/社团/体育赛事/学术报告/文化活动/文艺活动/其它活动）；涉及用餐/涉及观影/重要会议→勾选，默认否；活动内容「请描述活动具体内容，否则将无法通过申请」。
- **对应 `apply` 参数**：`--organizer/--subject/--participants/--type/--usage` + `--need-meal/--need-film/--is-big-event`（勾选用餐/观影/会议，默认否）。
- 字段收集的**交互流程/顺序/确认规则**（逐项问答、类型推荐须确认、内容初稿→润色→确认、不重复已填）见 **SKILL.md 第八节**。

## 八、apply 提交前校验（已实现）
- `apply --yes` 真正提交前，会先查 `/activity/rooms/:id/records` 判断该时段是否已被占用/申请中；**冲突则拒绝**（报「时段冲突」），`--force` 可绕过。
- 默认 `--dry-run` 只构建请求；`--yes` 才走两步提交。

> jwt 保存于 `~/.thu-sports-venue/wechat-room-jwt.txt`（成功提取时自动保存；提取失败时回退读取，未过期即复用）。
