# thu-auto-reserve

English | [简体中文](README.zh-CN.md)

[![Release](https://img.shields.io/badge/release-v1.1.0-blue?style=flat)](https://github.com/OverDustD7/thu-auto-reserve/releases/tag/v1.1.0)
[![Node](https://img.shields.io/badge/node-%3E%3D20-informational?style=flat)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-Windows-informational?style=flat)](#requirements)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat)](LICENSE)

Scripts that query, recommend, and book four kinds of Tsinghua reservations — sports venues, student activity rooms, library IC rooms, and library seats — and that list or cancel the reservations you already hold. You still sign in, solve the captcha, pay, and pick the seat yourself.

This is a skill for the DeepSeek Harness (DSH) agent runtime: `SKILL.md` tells the agent when to call which script. The same scripts run from a terminal without an agent.

## Status and support

- Status: maintained, fix-driven. New work stays inside the four branches below.
- Supported: Windows 10 and 11; Node.js 20 or newer; Python 3.10 or newer; Playwright 1.62.1 (pinned). System Chrome or Edge is preferred, a Playwright-downloaded Chromium is the fallback.
- Not supported: macOS and Linux (session storage calls Windows DPAPI through PowerShell); automating SSO, captchas, payment, or the seat-picking click.
- Current source version: `1.2.0` in `package.json` on `master`. It is not tagged and not released. The latest public release is [v1.1.0](https://github.com/OverDustD7/thu-auto-reserve/releases/tag/v1.1.0) (2026-09-02), and its zip is older than the current tree.

| Branch | Runs on its own | You do |
|---|---|---|
| Sports venues | query, recommend, date and slot selection on the page, lottery sign-up, list, cancel | SSO, captcha, payment |
| Student activity rooms | query, recommend, validation, submit, list, cancel, drafts | first explicit import of your own session; use the mini-program when no trusted import source exists |
| Library IC rooms | query, rule checks, submit when identities match exactly, list, cancel | SSO; page-side member check and submit when IDs come back masked |
| Library seats | seat availability, open the seat page, list, cancel | SSO, picking the seat on the map |

## Requirements

- Windows 10 or 11.
- Node.js 20 or newer. Data queries use the built-in `fetch` and need no package.
- Python 3.10 or newer for the activity-room branch. Core commands use the standard library only; `requirements-ui.txt` adds Pillow 12.3.0 for the optional UI helper (`scripts/wechat-room.py`).
- A Chromium-based browser: system Chrome or Edge, or let `setup` download Chromium.
- Network access to the campus hosts listed in `references/`.

## Installation

Recommended:

```powershell
git clone https://github.com/OverDustD7/thu-auto-reserve.git
cd thu-auto-reserve
node scripts/venue-helper.js setup
```

`setup` writes `allowScripts` into `package.json`, installs the pinned Playwright 1.62.1, and installs Chromium only when neither Chrome nor Edge is found. `npm ci` installs the locked Node dependencies but does not replace the helper's browser availability check. When no system Chrome or Edge is available, install Chromium separately with `npx playwright install chromium`. Installation was not run in this review.

Success signal: `node scripts/venue-helper.js status --json` prints a JSON object with a login state instead of failing, and `npm test` ends with `pass 32`.

## Quick start

Library seats, end to end:

```powershell
node scripts/seat-helper.js login
node scripts/seat-helper.js tree --json
$sectionId = Read-Host "Section ID from the tree output"
node scripts/seat-helper.js open --section $sectionId
```

`login` opens the campus SSO page; the sign-in happens in that window. `tree --json` lists halls, floors and reading areas with their IDs; select an area ID from the current result. `open` prints `已打开：https://seat.lib.tsinghua.edu.cn/web/seat3?...` and leaves the seat map in a browser window, where you pick the seat.

After booking, `node scripts/seat-helper.js bookings --json` lists your reservations with their IDs. Status words printed by the scripts are Chinese.

## Configuration, data and permissions

- Configuration: commands take flags; see `DEVELOPER.md` for the full list. `python scripts/wechat-room-api.py config org` stores an organizer profile as plain local data, not a credential.
- Data handled: session tokens, cookies, browser storage, reservation records, and the member IDs and organizer details you supply. Authenticated requests send the required data to the campus service.
- Stored at: `%USERPROFILE%\.thu-sports-venue\`, `%USERPROFILE%\.thu-lib-space\`, and `%USERPROFILE%\.thu-lib-seat\`. Authentication files are encrypted with Windows DPAPI for the current user and expire after seven days at most; organizer configuration is stored separately as plaintext and does not share that authentication expiry; the server may invalidate a session earlier, and an entry with a missing or unreadable timestamp is treated as expired.
- Permissions: launching a browser through Playwright (needs a normal desktop session), calling DPAPI through `powershell.exe`, and outbound HTTPS to the campus hosts. Dependencies and browsers can also write package caches, browser caches and temporary files outside those folders. The optional UI helper needs screenshots, window access and the clipboard.
- The project contains no telemetry feature. Dependency installation contacts package and browser download services; browser sign-in and payment can involve campus SSO and payment providers.

## Upgrade and uninstall

Upgrade: `git pull`, then rerun `node scripts/venue-helper.js setup` when `package.json` changed. Sessions written by releases before 1.2.0 are rejected; log in again after the upgrade.

Uninstall: delete the cloned folder, then delete the three session folders above. The project does not create a service or scheduled task. Shared runtimes and dependency/browser caches are retained; remove them separately only if other projects do not need them.

Data retention: sessions are deleted on the next access after they expire. Deleting the session folders removes the local credentials and organizer configuration in them; it does not cancel reservations or revoke server-side sessions.

## Limitations and troubleshooting

- Windows only.
- SSO, captchas, payment, and the seat-picking click stay with you. The tools stop at the page instead of clicking for you.
- Activity rooms need an explicit import of your own session. There is no trusted export source for everyone, so the mini-program is the fallback.
- Members must match the identities the server returns. Masked IDs stop API submission; rerun with `--browser` to check members on the page.
- Mutations preview by default; `--yes` writes. `--yes --dry-run` is rejected.
- A submission with an uncertain result is reported with its `ticket_id`, not retried.
- Rules, prices, and penalties in `references/` are historical snapshots. The live system decides.
- The helper includes a historical one-cancellation-per-day reminder; verify the current limit with the library system.

| Symptom | Cause | Fix |
|---|---|---|
| `未登录`, or exit code 2 | no local session, or it expired | run `login` for that branch again; `login --force` to replace it |
| `spawn ... EPERM` when a browser command starts | the sandbox blocks child-process pipes | run the command in an environment that allows spawning the browser; see `DEVELOPER.md` |
| `fetch failed` or an unexpected 302 while reading bookings | network, redirect, or session failure | check connectivity and sign-in state before retrying a read-only query |
| `取消失败：当日取消次数已达上限` | the service rejected cancellation under its current quota | check the current rule or ask the library desk |

## Development

```powershell
npm test                # 32 offline tests
npm run test:python     # 19 offline tests
```

Layout: `scripts/` holds the four command-line helpers, `scripts/lib/` the DPAPI crypto, session, and time helpers, `references/` the API notes and venue data, and `tests/` the offline suites with synthetic fixtures.

Docs: [`SKILL.md`](SKILL.md) for agent instructions, [`DEVELOPER.md`](DEVELOPER.md) for commands and session design, [`CHANGELOG.md`](CHANGELOG.md) for release history, [`MODIFICATION_REPORT.md`](MODIFICATION_REPORT.md) for the v1.2.0 change report, and [`references/`](references/) for the API notes.

## Feedback and security

- Issues: <https://github.com/OverDustD7/thu-auto-reserve/issues>
- Security: no private security channel is offered. Do not paste tokens, cookies, account names, or reservation IDs into a public issue; describe the class of problem instead.

## License and third-party notices

The project's own code and original documentation are licensed under the [MIT License](LICENSE), with copyright attributed to OverDustD7. That grant does not cover third-party material.

Third-party components:

| Component | License | Purpose |
|---|---|---|
| Playwright and Playwright Core 1.62.1 | Apache-2.0 | Browser automation dependencies |
| fsevents 2.3.2 | MIT | Optional macOS entry in the lockfile; not used on Windows |
| Pillow 12.3.0 (optional) | MIT-CMU | Screenshot handling in the optional UI helper |

These dependencies and browser binaries are not bundled in the source ZIP. Installed dependencies and browsers retain their own terms. University notices, quoted or adapted source material, service names and logos retain their respective rights and terms. The project MIT license does not grant permission to reuse them or to access campus services.
