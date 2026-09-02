# thu-auto-reserve · 开发者 / 维护说明

本文档面向**开发与维护**；普通用户请看 **`README.md`**。

## 目录结构

```
thu-auto-reserve/
├── SKILL.md                    # 主文件（Agent Skills 规范，必读；含「判断用户意图」分流）
├── README.md                   # 用户向说明（功能总览 / 特点 / 使用须知）
├── DEVELOPER.md                # 本文件（开发者 / 维护）
├── CHANGELOG.md                # 版本更新日志（v1.0.0 首个正式版，最新 v1.1.0）
├── requirements.txt            # Python 依赖（cryptography；wechat-room-api.py 缺失时也会自动 pip 安装）
├── references/
│   ├── venue-api.md             # 体育场馆 API 逆向参考（认证/签名/解密/接口/路由）【本人】
│   ├── venues.md               # 清华各体育场馆信息【本人】
│   ├── mini-program.md         # 学生清华小程序·活动室申请（逆向笔记/数据）【本人】
│   ├── activity-rooms.md       # 全部 51 个活动室目录【本人】
│   ├── wechat-room-api.md      # 学生清华活动室 API 规范【本人】
│   ├── lessons.md              # 开发迭代可复用经验清单【本人】
│   ├── room-compare.md         # 研讨间/房间对比（活动室 vs 图书馆研讨间）+ 推荐规则【本人】
│   ├── venue-resource-handbook.md  # 学生课外活动场地资源手册速查（超出四类的场地全景）【本人】
│   ├── lib-space-api.md        # 图书馆 IC 空间 API 逆向参考【伙伴1】
│   ├── lib-space-spaces.md     # 图书馆 IC 空间目录 + 预约规则要点【伙伴1】
│   ├── lib-space-notices.md    # 图书馆通知/须知【伙伴1】
│   ├── lib-seat-api.md         # 图书馆自习座位 API 逆向参考【伙伴2】
│   └── lib-seat-seats.md       # 图书馆自习座位馆舍/阅览区资料【伙伴2】
└── scripts/
    ├── venue-helper.js         # 体育场馆（Playwright + 签名/解密）【本人】
    ├── wechat-room-api.py      # 学生活动室 API 客户端【本人】
    ├── wechat-room.py          # 学生活动室 UI 兜底【本人】
    ├── space-helper.js         # 图书馆 IC 空间【伙伴1】
    ├── fetch-notices.js        # 图书馆通知抓取【伙伴1】
    ├── seat-helper.js          # 图书馆自习座位【伙伴2】
    └── lib/
        ├── crypto.js           # 会话文件加密（Node，AES-256-GCM）【本人】
        └── crypto.py           # 会话文件加密（Python，cryptography 必装/缺失自动装）【本人】
```

## 快速使用（命令参考）

在 skill 根目录下：

### 体育场馆（`venue-helper.js`）

```bash
# 0) 首次准备环境（建 package.json → 装 playwright → 按需装浏览器，自动处理 allow-scripts 坑与镜像）
node scripts/venue-helper.js setup

# 1) 登录（弹出浏览器，选「校内登录 → 统一身份认证登录」）
node scripts/venue-helper.js login

# 2) 检查登录（--json 输出机器可读结果；退出码 0=成功/1=失败/2=未登录）
node scripts/venue-helper.js status --json

# 3) 列运动项目
node scripts/venue-helper.js sports --json

# 4) 列某运动下的设备类型/场馆/场地
node scripts/venue-helper.js sites --scene 综体羽毛球 --json

# 5) 列可预约时段 + 抽签场次（同时查；默认从明天起 3 天，--date 只查 1 天；同名多场景自动合并、按日期时段聚合）
node scripts/venue-helper.js slots --scene 综体羽毛球 --json
node scripts/venue-helper.js slots --scene 综体羽毛球 --date 2026-09-02 --json

# 6) 推荐运动（按热度加权随机抽几个，附场馆信息，默认 5 个；--need 按需求打分推荐）
node scripts/venue-helper.js recommend --json
node scripts/venue-helper.js recommend --need "膝盖不好，想减肥，便宜点，室内" --json

# 7) 打开浏览器完成预约 / 支付（默认路径；你只需拖一次滑块）
node scripts/venue-helper.js reserve --scene 综体羽毛球 --date 2026-09-01 --time 08:00
node scripts/venue-helper.js pay

# 7.5) 查看 / 取消预约（cancel 已实测；--yes 才真正提交）
node scripts/venue-helper.js orders --json
node scripts/venue-helper.js cancel --uuid <resvUuid> --yes

# 7.6) 纯 API 预约（仅参考/验证码下线后用；当前滑块 token 难单独取出，不可用）
node scripts/venue-helper.js reserve-api --scene 综体羽毛球 --date 2026-09-02 --time 08:00 --json

# 8) 抽签报名（无滑块验证码，纯 API；报名默认预演，须 --yes 才真正提交）
node scripts/venue-helper.js lottery --scene 综体羽毛球 --json                 # 列出抽签场次
node scripts/venue-helper.js lottery dates --scene 综体羽毛球 --plan "综体羽1（18:00-20:00）" --json
node scripts/venue-helper.js lottery signup --scene 综体羽毛球 --plan "综体羽1（18:00-20:00）" --date 2026-09-05 --yes
node scripts/venue-helper.js lottery mine --json                              # 我的抽签报名（含中签状态）
node scripts/venue-helper.js lottery-open --scene 综体羽毛球                    # 打开抽签报名页手动操作
```

### 学生活动室（`wechat-room-api.py`，API 直连）

需 PC 微信（Weixin 4.x）**登录过一次**「学生清华」小程序（用于产生/刷新 jwt，jwt 从微信进程内存自动提取）；之后查询/申请/撤销都无需小程序常开——只需一个有效 jwt（约 7 天过期），Python3：

```bash
cd <skill根目录>
# 0) 前置检查
python scripts/wechat-room-api.py check

# 1) 一次列出全部活动室
python scripts/wechat-room-api.py list

# 2) 按需求推荐（--purpose 按用途匹配；--type 关键词匹配）
python scripts/wechat-room-api.py recommend --purpose 会议 --capacity 10
python scripts/wechat-room-api.py recommend --purpose 排练 --location 胜因院 --max 12 --json

# 3) 查某活动室占用 / 指定区间可约时段
python scripts/wechat-room-api.py occupancy C200
python scripts/wechat-room-api.py avail --capacity 10 --type 会议 --from 2026-08-31 --to 2026-09-06

# 4) 我的申请 / 草稿箱 / 提交申请 / 撤销 / 删草稿
python scripts/wechat-room-api.py mine
python scripts/wechat-room-api.py drafts
python scripts/wechat-room-api.py apply --room C200 --date 2026-09-08 --start 10:00 --end 12:00 \
    --organizer "主办方（单位+姓名）" --participants 3 --subject 主题 --usage 内容 --type 文化活动 --yes
python scripts/wechat-room-api.py cancel --ticket <ticketId>
python scripts/wechat-room-api.py remove --ticket <ticketId>

# 5) 保存/读取主办方（apply 未给 --organizer 时自动复用）
python scripts/wechat-room-api.py config org "主办方（单位+姓名）"
python scripts/wechat-room-api.py config org get
```

> 「学生清华」活动室的查询/推荐/占用/可约/申请/撤销全走 API（`student.tsinghua.edu.cn/v2/api`）。`activityTarget=school` 全校通用；`activityType` 映射：党团=party/社团=organization/体育赛事=sports/学术报告=academy/文化活动=culture/文艺活动=art/其它活动=others。申请走「标准流程」（确认需求→查房→查可约→选房→收集字段→汇总→提交）。完整规范见 `references/wechat-room-api.md`、`references/activity-rooms.md`。

会话持久化在 `~/.thu-sports-venue/`（浏览器 profile + token 缓存 + 活动室 config），二次使用免登录。

### 图书馆 IC 空间（`space-helper.js`，来源：伙伴 thu-auto-reserve-1）

```bash
# 0) 环境准备 / 登录 / 检查
node scripts/space-helper.js setup
node scripts/space-helper.js login            # SSO；--force 换号；--email 绑邮箱
node scripts/space-helper.js status --json

# 1) 空间类型 / 可约时段
node scripts/space-helper.js menu --json
node scripts/space-helper.js slots --room 研讨间 --date 2026-09-02 --json

# 2) 预约（纯 API；默认预演，--yes 提交；--browser 回退浏览器 UI）
node scripts/space-helper.js reserve --room 研讨间 --dev <房间名> --date 明天 --time 18:00 --end 19:00 --members 学号1,学号2 [--yes]

# 3) 查/详情/取消
node scripts/space-helper.js orders --json
node scripts/space-helper.js detail --uuid <uuid|预约号>
node scripts/space-helper.js cancel --uuid <uuid|预约号> --yes
```

> 登录态持久化在 `~/.thu-lib-space/`；无签名、无 AES，明文 JSON；`code==300` 未登录。预约规则要点（提前天数/开放时间/单次时长/人数/每日上限）见 `references/lib-space-spaces.md`；接口/错误码见 `references/lib-space-api.md`。

### 图书馆自习座位（`seat-helper.js`，来源：伙伴 thu-auto-reserve-2）

```bash
# 0) 环境准备 / 登录 / 检查
node scripts/seat-helper.js setup
node scripts/seat-helper.js login
node scripts/seat-helper.js status --json

# 1) 馆舍剩余 / 楼层→阅览区→可约时段
node scripts/seat-helper.js areas --json
node scripts/seat-helper.js tree --lib 35 --json

# 2) 选座（打开选座页，用户点选）
node scripts/seat-helper.js open --section <阅览区id> [--date 2026-09-01]

# 3) 查/取消（默认预演，--yes 才提交）
node scripts/seat-helper.js bookings --json       # 列出我的预约（含取消用 id）
node scripts/seat-helper.js cancel --yes          # 自动取消第一条
node scripts/seat-helper.js cancel --id <取消id> --yes
```

> 登录态持久化在 `~/.thu-lib-seat/`；Cookie 会话（PHPSESSID+access_token…），无签名/AES/token 头。只约普通自习座位；研讨间/考研座位用 `space-helper.js`。接口/错误码见 `references/lib-seat-api.md`、馆舍资料见 `references/lib-seat-seats.md`。

## 来源与归属（分流标注）

| 来源 | 文件 | 功能 |
|------|------|------|
| 本人（thu-auto-reserve） | `scripts/venue-helper.js`、`references/venue-api.md` / `references/venues.md` | 体育场馆 |
| 本人（thu-auto-reserve） | `scripts/wechat-room-api.py` / `scripts/wechat-room.py`、`references/wechat-room-api.md` / `references/activity-rooms.md` / `references/mini-program.md` | 学生活动室 |
| 合作伙伴（thu-auto-reserve-1 = thu-lib-space-reserve） | `scripts/space-helper.js` / `scripts/fetch-notices.js`、`references/lib-space-*.md` | 图书馆 IC 空间 |
| 合作伙伴（thu-auto-reserve-2 = thu-lib-seat-reserve） | `scripts/seat-helper.js`、`references/lib-seat-*.md` | 图书馆自习座位 |
| 本人 | `references/lessons.md` / `references/room-compare.md` / `references/venue-resource-handbook.md` | 合并经验 / 研讨间对比 / 场地资源手册 |

> 三个 Node 脚本共用同一 `package.json`（playwright）；各自的配置目录互不冲突（`~/.thu-sports-venue/`、`~/.thu-lib-space/`、`~/.thu-lib-seat/`）。

## 可复用逻辑与重叠（功能合并说明）

四个分支共识别出以下重叠/可复用逻辑，本次做**基础合并**（确认不冲突、文档化；深度抽取留待后续）：

| 重叠点 | 涉及脚本 | 现状 / 基础合并处理 |
|--------|---------|---------------------|
| **SSO 登录**（CAS 统一认证） | venue-helper.js / space-helper.js / seat-helper.js | 三者各自实现「先查浏览器会话 → 弹窗 SSO → 保存 token/Cookie」。基础合并：保留各自实现、确认不冲突（各自配置目录隔离）；后续可抽成共享 `lib/cas-login.js` |
| **Playwright 环境准备**（allowScripts 对象、Chrome/Edge 优先、profile 互斥锁） | 三个 Node 脚本 | 三者 `setup` 都写同一个 `package.json`（playwright）+ 装浏览器。基础合并：确认幂等、不冲突（dep 相同）；只需跑任意一个 setup 即可 |
| **「数据查询零浏览器、仅 login/reserve/open 用浏览器」** | venue-helper.js / space-helper.js / seat-helper.js | 三者都遵循此模式（数据命令用 token/Cookie 直连 fetch，避免沙箱 EPERM）。基础合并：文档化该约定为三脚本通用规范 |
| **配置目录隔离** | 三脚本 | `~/.thu-sports-venue/`（体育）、`~/.thu-lib-space/`（空间）、`~/.thu-lib-seat/`（座位）各自独立，无冲突 |
| **查时段/预约/取消** | 四个分支 | 各自接口/UI 不同，逻辑相似但不直接复用；保留各自实现，靠「意图分流」路由 |
| **「研讨间/房间」用户旅程合并** | 第八节(活动室) / 第九节(图书馆研讨间) | 两分支「预约房间」的用户旅程相似。新增「零·甲 研讨间/房间 通用流程」+ `references/room-compare.md`：需求未指明系统时，先了解需求→两边都介绍+差异→推荐→**用户最终确定**（不代选） |

> 学生活动室（`wechat-room-api.py`）是 Python + WeChat jwt，与三个 Node 脚本体系不同，不参与 Node 侧的 SSO/Playwright 复用。

## 打包提交

本目录即一个标准 Agent Skill（`SKILL.md` 为必需）。提交到技能广场时，把**本目录的内容**（`SKILL.md`、`scripts/`、`references/` 等）整体打包成 `thu-auto-reserve.zip`：**zip 根目录直接就是技能内容**（`SKILL.md` 位于 zip 根，不要再套一层 `thu-auto-reserve/` 文件夹）；路径一律用**正斜杠**，并**显式写入目录条目**；排除 `.git/`、`node_modules/`、`submission/`。

## 说明与限制

- 登录走清华统一身份认证（SSO），必须由用户本人在浏览器完成。
- 支付为微信/支付宝扫码，必须由用户本人在可见浏览器完成。
- 可预约时段实时变化，预约前建议重新查询。
- 接口/签名/解密细节见 `references/venue-api.md`；脚本已实现签名与 AES 解密，日常无需手工调用。
- 体育场馆「取消预约」有提前 24 小时硬限制（`cancelBeforeStartTime=1440` 分钟）；`cancel` 命令已实测。
- 活动室「单次≤2h、每日1次」是使用/审核规范（非接口硬约束）；申请字段规则、位置规则（胜因院 9-21/≥3天）等见 `references/wechat-room-api.md`。
- 开发迭代中的可复用经验（认证/字段语义/预约逻辑/错误处理/UX 等 62 条）见 `references/lessons.md`。
- **安全设计考量（有意做成这样，详见 `SKILL.md`「安全设计考量」）**：
  - **会话/令牌加密 + 留存约 7 天（与后端 jwt 有效期对齐）**：保存到 `~/.thu-*` 的 token/会话/JWT 用 `scripts/lib/crypto`（AES-256-GCM，密钥按本机 hostname+用户名派生）加密；本地保留约 7 天，到期按未登录处理并清理（`storage-state.json` 与 `browser-profile/` 不在加密范围）。
  - **token 不外泄**：输出/日志/错误经 `scrub` 脱敏（已知密钥 + 疑似 JWT → `<redacted>`）；token 只在 HTTP 头、不走命令行。
  - **如实申报、不作弊**；**每次真实动作前明确确认**；**依赖固定** playwright `1.62.1`。

## lessons.md 逐条核对（对图书馆两分支的适用性）

> 合并时逐条检查了 `references/lessons.md` 的 50 条合作伙伴经验（#1-50）；绝大部分已应用，仅补了 #41「每步告知/提交后告知」与全局「沟通原则」覆盖。核对结论如下（按 lessons.md 主题分组；**#51-62 为本 skill 迭代后新增**，非合作伙伴经验）：

| lessons.md 主题 | 适用性（图书馆两分支） | 状态 |
|---|---|---|
| 一 认证与会话（#1-5） | ✅ 全适用（SSO、复用会话、Cookie/token 持久化、profile 锁、内存解码） | 已应用 |
| 二 接口签名与加解密（#6-7） | ❌ 不适用（图书馆两系统无签名、无 AES） | 已正确标注「无签名」 |
| 三 API 逆向与调试（#8-11） | ✅ 适用（抓报文、区分实测/未实测、多步提交、空响应） | 已应用 |
| 四 数据结构与字段语义（#12-16） | ✅ 适用（字段实测、枚举映射、规则数据表、北京时间/周几） | 已应用 |
| 五 预约核心逻辑（#17-22） | ✅ 大部分适用（先笼统→精确、提交前校验、优先最匹配、验证码 token 单次使用、空表单） | 已应用 |
| 六 规则与校验（#23-25） | ✅ 适用（硬约束 vs 软约束、规则核对、取消 24h） | 已应用 |
| 七 错误处理与状态（#26-28） | ✅ 适用（具体原因、状态区分、输入校验） | 已应用 |
| 八 并发/限流/性能（#29-32） | ✅ 适用（串行、当天跳过、缓存、聚合） | 已应用 |
| 九 配置与隐私（#33-35） | ✅ 适用（配置用户目录、个人信息不写、多脚本对齐） | 已应用 |
| 十 沟通与交互 UX（#36-43） | ⚠️ 部分适用（#37 提问框→**图书馆研讨间已采用、自习座位不用**；#39 依赖顺序/#40 文案→图书馆无此表单字段，不适用） | **#41 每步告知/提交后告知已补充**；#36 沟通原则由全局覆盖 |
| 十一 脚本健壮性（#44-47） | ✅ 适用（npm 对象格式、Chrome/Edge 优先） | 已应用 |
| 十二 流程标准化（#48-50） | ✅ 适用（固定流程、软提示、开场告知） | 已应用 |

> 结论：合作伙伴 skill 质量较高，50 条经验中仅 #41 需显式补充、#39/#40 不适用于图书馆场景；#37 提问框已在图书馆研讨间采用。其余均已落实。**#51-62（数字与选项区分 / 排查不暴露命令·函数名 / 时间可行性先校验 / 提示按真实规则 / 0 结果提示 / 成员去重 / 口径改变后同步文档 / 房间名简称匹配 / 静态凭证加密+留存合理 / 如实申报不作弊 / 具体日期用--date单日查 / 沙箱先预检先提权）为本 skill 迭代新增，已在 SKILL 与脚本落实。**
