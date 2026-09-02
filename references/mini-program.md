# 学生清华小程序 · 活动室申请（逆向笔记）

> 目标：在微信客户端（PC 版 Weixin 4.x）的「学生清华」小程序里，实现**抓取活动室数据 + 自动申请活动室**。
> 本文档记录已确认的环境事实与界面流程，供后续实现与使用。

## 一、运行环境（实测）

| 项 | 值 |
|----|----|
| 微信客户端 | Weixin 4.1.12.26（新版，路径 `E:\Program Files\Tencent\Weixin\Weixin.exe`） |
| 小程序宿主 | WeChatAppEx.exe（RadiumWMPF / XWeb，Chromium 内核） |
| 小程序窗口类 | `Chrome_WidgetWin_0`（Chromium） |
| 当前用户 | （用户本人，见本地 `~/.thu-sports-venue/` 配置；不写入本技能） |
| 小程序窗口标题 | 学生清华 |
| 目录 | `C:\Users\Flash\AppData\Roaming\Tencent\xwechat\radium\users\<u>\applet\packages\` |

## 二、关键结论

1. **小程序包是加密的**：`.wxapkg` 魔数为 `V1MMWX`（微信 4.x 新加密格式），离线解包需运行时 key，**无法静态直接逆向**。
2. **名称映射库也是加密的**：`applet.db` 为 WCDB 加密（表头非标准 SQLite），读不出「AppID ↔ 名称」。
3. **UIAutomation 读不到小程序内部**：只暴露根窗口（`Chrome_WidgetWin_0`），Chromium 默认关闭无障碍树。
4. **最终实现 = 逆向出后端 API 直连**（`student.tsinghua.edu.cn/v2/api`，详见 `references/wechat-room-api.md`）：**读微信进程内存提取 jwt + 直连 HTTP**，完成查询/推荐/占用/可约/申请/撤销，**无需模拟点击**。
   - 鉴权：`Authorization: Bearer <jwt>`；jwt 从运行中的微信进程(WeChatAppEx)`内存按 ASCII` 提取（搜 `eyJ...`），失败回退本地保存（~7 天过期）。
   - **无需小程序窗口常开**：查询/申请/撤销都是 API，只需有效 jwt；仅 jwt 过期(~7天)时在微信里刷新一次。`activityTarget=school` 全校通用（C楼/南区/胜因院），`activityType` 映射：党团=party/社团=organization/体育赛事=sports/学术报告=academy/文化活动=culture/文艺活动=art/其它活动=others。
   - UI 截图+点击仅作**兜底**：`PrintWindow(PW_RENDERFULLCONTENT)` 抓窗口、**必须 DPI-aware**（1.5x 缩放）、`SetWindowPos(TOPMOST)` 防遮挡。

## 三、界面流程（实测）

**首页**（学生清华）：

```
学清主页 | 活动室申请 | 阳光体育查询 | 我的申请 | 个人信息 | 使用帮助 | 关于我们 | 意见反馈
```

**活动室申请 → 使用说明**（阅读后需**先滚动到底**再点「我知道了」）：

- 申请的是**校团委管理的学生活动室**，开放 7:00-23:00（不含寒暑假）。
- 【主办方】班级/社团/个人；【参与人数】≤活动室最大容量；【活动内容】不能太笼统。
- 填完 → 「选择时间」→ 日期/起止时间 → 「添加」（可「继续添加」多时段）→ 「检查占用并提交」。
- 提交后审核，通过后微信通知，可看密码锁。

**活动室列表**（当前都在 C楼二楼）：

| 房间 | 容量 | 类型 |
|------|------|------|
| C200 | 30 | 学生大客厅/开放式空间/非密闭活动室 |
| C207A | 2 | 小型研讨室/电视(可投影) |
| C207B | 2 | 小型研讨室/电视(可投影) |
| C207C | 2 | 小型研讨室 |
| C208A | 2 | 小型研讨室/电视(可投影) |
| C208B | 2 | 小型研讨室/电视(可投影) |
| C208C | 2 | 小型研讨室 |

（地点筛选项：C楼二楼 / C楼三楼 / 胜因院22号 / 南区地下）

**我的申请**：进入后是「消息通知」页，分类：**草稿箱 / 申请中 / 已通过 / 未通过**（当前暂无申请时显示「暂无此类申请」）。

## 四、关键规则（实测 from C200 使用须知）

- 仅限**学生、教职工、校友**使用。
- 预约须**活动开始前 4 小时**提交；距开始**超过 14 天**不予处理。
- **每人每日可预约 1 次**，**单次预约时长 ≤ 2 小时**。
- 开放 7:00-23:00（不含寒暑假）。
- 禁止长期占用/商业化活动等（详见使用须知）。
- 提交后审核；通过后按授权微信通知，可通过【我的申请/已通过】看密码锁。

## 五、占用查询视图（活动室信息页）

点某活动室 → 先弹「使用须知」→ 点「我知道了」（需先滚动到底）→ **活动室信息页**：

- 顶部：房间名/楼层/容量/类型标签。
- 状态图例：**未借用**(浅灰) / **申请中**(浅紫) / **已借用**(深紫)。
- 周/天/小时网格：`周次`(第N周) × `日`(周一..周日+日期) × `小时档`，单元格颜色即借用状态。
- 底部：「申请」按钮（自动申请入口）。

## 六、主脚本（已交付）

**主脚本 = `scripts/wechat-room-api.py`**（API 直连）：`check / jwt / list / occupancy / recommend / avail / apply / cancel / mine`，鉴权 `Bearer <jwt>`（微信进程内存自动提取，失败回退本地保存 ~7 天；提取时用服务端校验、避开已吊销旧 token）。`recommend --purpose 活动用途` 按用途匹配房间（一般用途避开录音/导播/舞蹈/排练等专属功能房）；`apply` 两步提交（ticketId 在 `Location` 头），`activityType` 7 类映射见 `references/wechat-room-api.md`。申请流程/字段规则见 `SKILL.md` 第八节。

**UI 兜底 = `scripts/wechat-room.py`**（个别走不了 API 的动作用截图+点击驱动）：

| 命令 | 作用 |
|------|------|
| `locate` | 定位「学生清华」窗口（PID/HWND/物理矩形），输出 JSON |
| `capture out.png` | 抓取小程序窗口为 PNG（物理分辨率，图像坐标 1:1） |
| `click x y` | 图像像素坐标点击（自动置顶防遮挡） |
| `scroll dir times` | 滚轮滚动（-1 下 / +1 上） |
| `type <text>` | 剪贴板 + Ctrl+V 粘贴（支持中文，填表单用） |
| `config org <v>/get` | 主办方持久化/读取（UTF-8，存 `~/.thu-sports-venue/`） |
| `apply [--yes]` | 导航到表单交接给用户/或 `--yes` 进时间步 |

> 说明：`wechat-room.py` 已 `SetProcessDPIAware()`（150% 缩放，1.5x），截图/点击均为物理像素；剪贴板用 `GlobalAlloc/GlobalLock`（已设 restype，避免 64 位句柄截断）。
