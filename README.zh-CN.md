# 清华大学预约助手

[English](README.md) | 简体中文

[![Release](https://img.shields.io/badge/release-v1.1.0-blue?style=flat)](https://github.com/OverDustD7/thu-auto-reserve/releases/tag/v1.1.0)
[![Node](https://img.shields.io/badge/node-%3E%3D20-informational?style=flat)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-Windows-informational?style=flat)](#环境要求)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat)](LICENSE)

查询、推荐及预约体育场馆、学生活动室、图书馆 IC 空间和自习座位，支持查看与取消已有预约。登录、验证码、支付和选座仍然由你本人完成。

本仓库是 DeepSeek Harness（DSH）智能运行时的一个技能：`SKILL.md` 说明代理何时调用哪个脚本。同一批脚本也可以直接在终端运行，不需要代理。

## 发布与维护状态

- 状态：维护中，以修复为主。新功能只限于下面四个分支。
- 支持：Windows 10 与 11；Node.js 20 及以上；Python 3.10 及以上；Playwright 固定 1.62.1。浏览器优先用系统已装的 Chrome 或 Edge，都没有时由 Playwright 下载 Chromium。
- 不支持：macOS 与 Linux（会话加密要走 PowerShell 调用 Windows DPAPI）；SSO、验证码、支付、选座点击的自动化。
- 当前源码版本：`master` 上 `package.json` 为 `1.2.0`，没有打 tag、没有发布。最近一次公开发布是 [v1.1.0](https://github.com/OverDustD7/thu-auto-reserve/releases/tag/v1.1.0)（2026-09-02），它的 zip 比当前代码旧。

| 分支 | 自动完成 | 本人完成 |
|---|---|---|
| 体育场馆 | 查询、推荐、页面选日期/时段、抽签、查/取消 | SSO、验证码、扫码支付 |
| 学生活动室 | 查询、推荐、校验、提交申请、查/撤销/清草稿 | 首次显式导入本人登录态；无受信任导入来源时在小程序办理 |
| 图书馆 IC 空间 | 查询、规则校验、身份可精确核实时提交、查/取消 | SSO；脱敏成员无法精确核实时在页面核对并提交 |
| 图书馆自习座位 | 空座查询、打开选座页、查/取消 | SSO、座位图点选 |

### v1.2.0 使用须知

- 需要 Windows、Node.js >=20、Python >=3.10；浏览器操作使用 Playwright 与系统 Chrome/Edge。
- 会话与 Cookie 使用当前 Windows 用户的 DPAPI 保护，最长保存七天，服务端可能更早失效。升级后旧会话不复用，需要重新登录。
- 新版使用临时浏览器上下文；会清理 skill 默认目录中的旧持久化 profile。自定义旧目录须自行处理。
- 活动室查询不再扫描微信进程。登录态只通过终端隐藏输入或受信任集成的标准输入导入，不发送到聊天、不放入命令行。
- 预约、撤销、删除默认预演；确认具体对象后才执行。查询失败不视为无记录，提交结果不确定时先核实。
- 人数和成员须真实；时段、价格、罚则与开放信息以学校当前系统为准。

## 环境要求

- Windows 10 或 11。
- Node.js 20 及以上。数据查询用内置 `fetch`，不装依赖也能用。
- Python 3.10 及以上，只给活动室分支用。核心命令只依赖标准库；`requirements-ui.txt` 里的 Pillow 12.3.0 供可选的界面工具 `scripts/wechat-room.py` 使用。
- 一个 Chromium 内核浏览器：系统 Chrome 或 Edge，或者让 `setup` 下载 Chromium。
- 能访问 `references/` 里列出的校内站点。

## 安装

推荐方式：

```powershell
git clone https://github.com/OverDustD7/thu-auto-reserve.git
cd thu-auto-reserve
node scripts/venue-helper.js setup
```

`setup` 会写入 `package.json` 的 `allowScripts`、安装固定版本 Playwright 1.62.1，并在既没有 Chrome 也没有 Edge 时安装 Chromium。`npm ci` 仅安装锁定的 Node 依赖，不代替助手的浏览器可用性检查。没有系统 Chrome 或 Edge 时，需另行运行 `npx playwright install chromium`。本轮未实际执行安装。

成功信号：`node scripts/venue-helper.js status --json` 返回带登录状态的 JSON 而不是报错，`npm test` 末尾显示 `pass 32`。

## 快速使用

图书馆自习座位，最小一条链路：

```powershell
node scripts/seat-helper.js login
node scripts/seat-helper.js tree --json
$sectionId = Read-Host "输入 tree 返回的阅览区 ID"
node scripts/seat-helper.js open --section $sectionId
```

`login` 打开学校统一身份认证页面，登录在窗口里完成。`tree --json` 列出馆舍、楼层和阅览区及其 ID，使用当前结果中的阅览区 ID。`open` 打印 `已打开：https://seat.lib.tsinghua.edu.cn/web/seat3?...`，把选座页留在浏览器窗口里，座位由你在图上点。

约好之后，`node scripts/seat-helper.js bookings --json` 列出你名下的预约及其 ID。脚本打印的状态词是中文。

## 配置、数据与权限

- 配置：各命令用参数控制，完整参数见 `DEVELOPER.md`。`python scripts/wechat-room-api.py config org` 保存一份主办方资料，属普通本地数据，不是凭证。
- 处理什么：会话 token、Cookie、浏览器 storage、预约记录，以及你提供的成员学号和主办方资料。认证请求会把所需数据发送给对应学校服务。
- 存在哪里：`%USERPROFILE%\.thu-sports-venue\`、`%USERPROFILE%\.thu-lib-space\`、`%USERPROFILE%\.thu-lib-seat\`。认证文件用当前 Windows 用户的 DPAPI 加密，最长七天到期；主办方配置单独明文保存，不适用认证文件的七天期限；服务端可能更早让会话失效，时间戳缺失或读不出的条目按过期处理。
- 需要什么权限：通过 Playwright 启动浏览器（要有正常的桌面会话）、通过 `powershell.exe` 调用 DPAPI、向校内站点发起 HTTPS 请求。依赖和浏览器还可能在这些目录之外写入包缓存、浏览器缓存和临时文件。可选 UI 助手另需截图、窗口和剪贴板权限。
- 项目未实现遥测功能。安装依赖时会访问包源和浏览器下载服务；浏览器登录与支付还会涉及学校 SSO 和支付服务。

## 升级与卸载

升级：`git pull`；`package.json` 有变化时再跑一次 `node scripts/venue-helper.js setup`。1.2.0 之前的版本写入的会话不予复用，升级后重新登录。

卸载：删掉克隆下来的目录，再删上面三个会话目录。项目不安装服务或计划任务。共享运行时及依赖、浏览器缓存会保留；只有确认其他项目不依赖时才单独清理。

数据保留：会话到期后在下一次访问时删除。删除这些目录会清除其中的本地凭证和主办方配置，不会取消预约或撤销服务端会话。

## 已知限制与排错

- 只支持 Windows。
- SSO、验证码、支付、选座点击都留给你，工具到页面为止，不替你点。
- 活动室要显式导入本人会话。不是人人都有受信任的导出来源，没有时在小程序里办理。
- 成员必须和服务端返回的身份完全对上。返回脱敏时 API 提交停止；可自行用 `--browser` 重新运行并在页面核对。
- 写操作默认预演，加 `--yes` 才执行；`--yes --dry-run` 会被拒绝。
- 提交结果不确定时保留 `ticket_id` 报告出来，不自动重试。
- `references/` 里的规则、价格、罚则是历史快照，以当前系统为准。
- 脚本带有每日仅能取消一次的历史提示，当前限额仍须在图书馆系统核实。

| 现象 | 原因 | 处理 |
|---|---|---|
| 输出 `未登录` 或退出码 2 | 本地没有会话，或已过期 | 重跑该分支的 `login`；要换会话用 `login --force` |
| 浏览器类命令报 `spawn ... EPERM` | 沙箱阻止子进程管道 | 换到允许启动浏览器的环境运行，见 `DEVELOPER.md` |
| 读预约时报 `fetch failed` 或遇到意外的 302 | 网络、跳转或会话异常 | 先核对网络与登录状态，再重试只读查询 |
| 输出 `取消失败：当日取消次数已达上限` | 服务端按当前限额拒绝取消 | 核对当前规则或联系图书馆服务台 |

## 开发与详细文档

```powershell
npm test                # 32 个离线测试
npm run test:python     # 19 个离线测试
```

目录：`scripts/` 是四个命令行助手，`scripts/lib/` 是 DPAPI 加密、会话与时间处理，`references/` 是接口笔记与场馆资料，`tests/` 是使用虚构夹具的离线用例。

文档：[`SKILL.md`](SKILL.md) 给代理的指令，[`DEVELOPER.md`](DEVELOPER.md) 命令与会话设计，[`CHANGELOG.md`](CHANGELOG.md) 版本记录，[`references/`](references/) 是接口笔记。

[完整 skill](SKILL.md) · [开发与命令说明](DEVELOPER.md) · [修改报告](MODIFICATION_REPORT.md)

## 反馈与安全报告

- 问题反馈：<https://github.com/OverDustD7/thu-auto-reserve/issues>
- 安全：暂不提供私密渠道。不要把 token、Cookie、账号名、预约 ID 贴进公开 issue，描述问题类别即可。

## 许可证与第三方说明

项目自有代码和原创文档采用 [MIT 许可证](LICENSE)，版权署名为 OverDustD7。该许可不涵盖第三方材料。

第三方组件：

| 组件 | 许可证 | 用途 |
|---|---|---|
| Playwright 与 Playwright Core 1.62.1 | Apache-2.0 | 浏览器自动化依赖 |
| fsevents 2.3.2 | MIT | 锁文件中的可选 macOS 依赖，Windows 不使用 |
| Pillow 12.3.0（可选） | MIT-CMU | 可选界面工具的截图处理 |

源码 ZIP 不包含这些依赖或浏览器二进制文件。安装后的依赖和浏览器各自沿用原有条款。学校公告、引用或改编的资料、服务名称及标识仍受各自权利和条款约束；项目的 MIT 许可不授权复用这些内容，也不授予校内服务访问权限。
