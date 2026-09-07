# 学生清华活动室客户端与接口

> v1.2.0 操作说明。接口字段来自原项目历史抓包资料，本次修改只做离线验证，没有重新验证线上接口。

## 认证与边界

业务地址：`https://student.tsinghua.edu.cn/v2/api`；请求头 `Authorization: Bearer <jwt>`。小程序原有登录接口为 `/activity/wechat/login`，使用 wx.login code 换取 jwt，不能凭空构造 code。

新版删除了所有微信进程内存读取代码。`login --card 本人学工号` 接受终端隐藏输入；受信任、已授权且限定目标小程序的集成可以通过 `--stdin` 直接传递登录态，不能经聊天或命令行文字传递。客户端核对 card、openId、iat/exp 和可识别的发行方，再由学校接口验证有效性。不会通过批量试验其他应用 token 寻找可用身份。

仓库没有新的自动导出器，不能保证官方小程序 UI 提供导出功能。没有受信任导入来源时，用户应在小程序完成申请，不能重启内存扫描作为兜底。

JWT 用当前 Windows 用户 DPAPI 加密，保存在 `~/.thu-sports-venue/wechat-room-jwt.txt`，包含身份和保存时间，最长七天，exp 到期更早则先失效。查询优先使用这份显式导入的凭证；`logout` 删除本地凭证；切换账户先 logout 再 login。

## 接口与字段

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/activity/rooms` | 房间列表，value 数组包含 id/name/location/capacity/tags/available |
| GET | `/activity/rooms/:id/records` | 占用记录，start/end 为带时区 ISO 时间或毫秒时间戳 |
| GET | `/account/semesters` | 学期 id/start/end |
| GET | `/activity/room-tickets?state=...&skip=...&top=50` | 申请或草稿列表，按页查询 |
| POST | `/activity/room-tickets` | 创建草稿，响应 Location 取得 ticketId |
| POST | `/activity/room-tickets/:id/apply` | 提交申请 |
| POST | `/activity/room-tickets/:id/revoke` | 撤销已提交申请 |
| POST | `/activity/room-tickets/:id/remove` | 删除草稿 |

创建请求示意（时间戳需根据真实日期计算）：

```json
{
  "organizer": "主办方", "subject": "活动主题", "participantCount": "3",
  "coOrganizer": "", "activityType": "culture", "activityTarget": "school",
  "needMeal": false, "needFilm": false, "isBigEvent": false,
  "usage": "具体活动内容",
  "records": [{"type": 0, "roomId": "房间UUID", "semesterId": "学期UUID", "start": 0, "end": 0}]
}
```

`activityType` 映射：党团活动 party、社团活动 organization、体育赛事 sports、学术报告 academy、文化活动 culture、文艺活动 art、其它活动 others。人数为正整数字符串；主题和内容必填。当前仅支持 school 范围。

## 查询与写入

- `list`、`recommend --purpose ... --capacity N`、`occupancy 房间`、`avail --from D --to D` 用于查询。
- `apply` 必填 room/date/start/end/organizer/participants/subject/usage，可指定 type。
- `apply`、`cancel --ticket ID`、`remove --ticket ID` 默认预演，`--yes` 才写入；冲突开关报错，`--force` 已移除。
- 预演和提交都检查实际人数、容量、日期、起止顺序、开放时间、最少提前量、最长提前天数、两小时上限、当天已有申请和房间冲突。任何必要查询失败都停止。
- 原资料规则：C楼/南区 07:00–23:00、提前至少四小时；胜因院22号 09:00–21:00、至少三天；最长提前十四天。以学校当前通知为准，变更时同步校验器。
- 创建草稿接受 200/201 并要求 Location；提交成功接受 200/204。提交未确认时保留 ticketId，先只读核实，不自动删除或重试。
- 撤销成功后才尝试删除草稿，分别报告 revoked/removed；两步全成功才报告全部完成。
- `mine` 查询 pending/rejected，`drafts` 查询 draft；列表错误不能视为暂无记录。审批通过后的实时状态以学校系统为准。
- `config org 名称` / `config org get` 是本地配置，不触发认证。

字段与用户工作流见 [SKILL.md](../SKILL.md)，房间说明见 [activity-rooms.md](activity-rooms.md)。
