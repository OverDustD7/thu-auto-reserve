# 开发与运行说明

## 运行环境与依赖

Windows，Node.js >=20，Python >=3.10。核心 Python 客户端只用标准库；系统 DPAPI 不需要 pip 依赖。可选 UI 工具 `wechat-room.py` 需要 `pip install -r requirements-ui.txt`。Playwright 固定 1.62.1，三个 Node setup 均保留共享 package.json 的其他字段；也可直接使用 `npm ci`。

```powershell
node scripts/venue-helper.js setup
npm test
npm run test:python
```

测试使用虚构凭证和模拟接口；DPAPI 测试使用当前用户的系统服务，沙箱限制下可能需宿主允许相应权限。不要因测试系统权限不足而禁用加密。

## 会话架构与迁移

- `scripts/lib/crypto.js` 通过固定 PowerShell 脚本和 stdin 调用 CurrentUser DPAPI；`crypto.py` 使用 ctypes 调用相同系统服务。统一密文格式 `{v:2,alg:"windows-dpapi",ct:base64}`。
- 不再用机器名/用户名派生密钥，不兼容旧格式明文或 v1 密文。旧数据拒绝复用并清理，需要重新登录。
- `session.js` 保护 token/session/storage-state，检查七天到期时间，按目标 URL 过滤 Cookie。未知时间戳按过期处理。系统加密服务暂时不可用时返回错误，不降级明文。
- 浏览器改为临时进程和非持久化 context，通过解密后的 storage-state 在内存恢复。默认旧 `browser-profile` 会在使用时清理；路径经过范围和符号链接检查，自定义非标准目录不会自动删除。
- 会话目录仍为 `~/.thu-sports-venue`、`~/.thu-lib-space`、`~/.thu-lib-seat`。到期清理发生在下次访问，不是后台定时清理。主办方配置是普通本地资料，不属于认证令牌。
- DPAPI 不防当前用户身份下的恶意进程/管理员，且 Windows 漫游场景可能允许凭证迁移。不能宣传绝对“跨机不可解”。依据：[Microsoft DPAPI](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)。
- `logout` 清理对应分支的本地登录态；Node `login --force` 先清理再登录，不影响其他分支。删除本地会话不表示吊销服务器上的所有会话。

## 命令速查

### 体育

```powershell
node scripts/venue-helper.js status --json
node scripts/venue-helper.js login
node scripts/venue-helper.js sports
node scripts/venue-helper.js slots --scene 羽毛球 --date 2026-09-08
node scripts/venue-helper.js reserve --scene 场景名 --date 2026-09-08 --time 18:00
node scripts/venue-helper.js lottery signup --scene 场景名 --plan 场次名 --date 2026-09-08
node scripts/venue-helper.js orders
node scripts/venue-helper.js cancel --uuid 预约ID
node scripts/venue-helper.js logout
```

抽签报名/取消先预演，`--yes` 才写入。体育页面选择失败停止自动流程。支付由本人完成后用 orders 核实。诊断用 reserve-api 若需验证码，只支持 `--captcha-stdin`，不接受命令行验证码。

### 活动室

```powershell
python scripts/wechat-room-api.py login --card 本人学工号
python scripts/wechat-room-api.py check
python scripts/wechat-room-api.py recommend --purpose 讨论 --capacity 3
python scripts/wechat-room-api.py avail --from 2026-09-08 --to 2026-09-08
python scripts/wechat-room-api.py apply --room C200 --date 2026-09-08 --start 10:00 --end 11:00 --organizer 主办方 --participants 3 --subject 主题 --usage 内容 --type 文化活动
python scripts/wechat-room-api.py mine --json
python scripts/wechat-room-api.py cancel --ticket 申请ID
python scripts/wechat-room-api.py remove --ticket 草稿ID
python scripts/wechat-room-api.py config org get
python scripts/wechat-room-api.py logout
```

登录命令通过终端隐藏输入接受本人会话；集成可加 `--stdin`，将来自已授权、限定目标小程序的本地来源直接写入标准输入，不能把凭证字符串拼接进 shell 命令。仓库不再提供自动读取微信内存的获取器，也不保证普通用户能从官方 UI 导出登录态；没有受信任来源时由本人在小程序办理。格式校验不是本地验签，最终凭证有效性由学校接口确认。学工号必须与 payload.card 一致。

apply/cancel/remove 均默认预演；`--yes` 才写入，`--yes --dry-run` 报错，移除绕过校验的 `--force`。提交未确认时保留 ticket_id，不自动删除或重试。详细 schema 见 [活动室接口](references/wechat-room-api.md)。

### 图书馆 IC 空间

```powershell
node scripts/space-helper.js login
node scripts/space-helper.js menu --json
node scripts/space-helper.js slots --room 类型名 --date 2026-09-08 --json
node scripts/space-helper.js reserve --room 类型名 --dev 完整房间名 --date 2026-09-08 --time 10:00 --end 11:00 --members 学号1,学号2
node scripts/space-helper.js orders
node scripts/space-helper.js cancel --uuid 预约号
node scripts/space-helper.js logout
```

预演后按授权加 `--yes`。学号必须与返回的完整身份字段精确匹配；无法核实的脱敏成员不取首项，改用 `--browser`，本人在页面选择并核对。已由用户核实的内部证号可使用 `--member-accnos`，仍须与返回 accNo 精确一致。空间须明确房间名/编号，不使用歧义简称提交。

### 自习座位

```powershell
node scripts/seat-helper.js login
node scripts/seat-helper.js areas --json
node scripts/seat-helper.js open --section 阅览区ID --date 2026-09-08
node scripts/seat-helper.js bookings --json
node scripts/seat-helper.js cancel --id 预约ID
node scripts/seat-helper.js logout
```

取消必须指定 ID，授权后加 `--yes`，不再自动取消第一条。选座由本人在网页完成。`fetch-notices.js` 仅使用有效加密会话，所有须知查询成功后才更新文件。

## 输出及维护约定

退出码通常为 0 成功/预演、1 失败、2 未登录。已提交、已支付、审批中和取消部分成功必须区分；不能仅凭错误文案不含“失败”推断成功。凭证脱敏集中处理，新增敏感字段要加入登记；不要保留真实请求或凭证作为测试夹具。

静态资料为原项目历史快照，不能代表本次线上核实结果。规则变动时更新对应 reference、校验器和行为回归。打包时保留 LICENSE、SKILL.md、scripts、references、依赖清单；排除 .git、node_modules、.npm-cache、测试临时文件及任何真实会话。
