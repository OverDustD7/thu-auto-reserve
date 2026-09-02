#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
wechat-room-api.py -- 学生清华·活动室申请 直连 API 客户端
从运行中的微信(WeChatAppEx)进程内存提取 jwt，直连 student.tsinghua.edu.cn/v2/api。

用法：
  python wechat-room-api.py check                    # 检查前置：有效登录态(jwt)/微信/小程序窗口
  python wechat-room-api.py jwt                      # 从微信进程内存提取当前 jwt
  python wechat-room-api.py list [--json]            # 一次列出全部活动室(51间)
  python wechat-room-api.py occupancy <房间名|id> [--json]  # 查某活动室的占用记录
  python wechat-room-api.py recommend --capacity N --type 关键词 [--json]  # 按容量/用途/位置推荐
  python wechat-room-api.py avail --capacity N --type 关键词 --from D --to D [--json]  # 指定区间可约时段
  python wechat-room-api.py apply --room 名 --date D --start T --end T --organizer 主办方 --participants N [--yes]  # 提交申请(默认dry-run)
  python wechat-room-api.py cancel --ticket <ticketId>   # 撤销申请（并自动删除撤销后回到草稿箱的草稿）
  python wechat-room-api.py remove --ticket <ticketId>   # 删除草稿（清草稿箱）
  python wechat-room-api.py mine [--json]            # 列出我的申请（申请中/被拒，不含草稿箱）
  python wechat-room-api.py drafts [--json]          # 列出草稿箱
  python wechat-room-api.py config org <主办方>       # 保存主办方（apply 未给 --organizer 时自动复用）
  python wechat-room-api.py config org [get]         # 读取已存主办方

说明：
  - 鉴权：Authorization: Bearer <jwt>；jwt 从微信进程(主/网络进程)内存按 ASCII 提取，失败回退本地保存(~7天过期)。
  - API 直连，无需小程序窗口常开；jwt 约 7 天过期，过期时在微信里打开「学生清华」小程序刷新一次。
  - 退出码：0 成功 / 1 失败 / 2 无有效登录态(jwt)。
"""
import ctypes
import json
import os
import re
import sys
import time
import urllib.request
import urllib.parse
from ctypes import wintypes

# 会话加密：从 scripts/lib/crypto.py 导入（AES-256-GCM；cryptography 缺失时自动 pip 安装，装不上则拒绝明文保存）
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
try:
    from crypto import encrypt as _enc, decrypt as _dec, is_expired as _expired
except Exception:
    def _enc(x):
        raise RuntimeError("会话加密模块加载失败，拒绝以明文保存登录态。")
    _dec = _enc
    _expired = lambda x: False

BASE = "https://student.tsinghua.edu.cn/v2/api"


def _scrub(s):
    """输出脱敏：把疑似 JWT（载荷/内容仍可从 payload 判断）替换为 <redacted>，避免 token 泄漏到输出/日志。"""
    if s is None:
        return s
    import re
    return re.sub(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", "<redacted>", str(s))

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


# ---------------- 进程内存读取（提取 jwt） ----------------
class MBI(ctypes.Structure):
    _fields_ = [("BaseAddress", ctypes.c_void_p), ("AllocationBase", ctypes.c_void_p),
                ("AllocationProtect", ctypes.c_ulong), ("RegionSize", ctypes.c_size_t),
                ("State", ctypes.c_ulong), ("Protect", ctypes.c_ulong), ("Type", ctypes.c_ulong)]


def _get_cmdline(pid):
    """用 NtQueryInformationProcess(ProcessCommandLine) 取进程命令行。纯 ctypes，无子进程。"""
    kernel32 = ctypes.windll.kernel32
    ntdll = ctypes.windll.ntdll
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return ""

    class UNICODE_STRING(ctypes.Structure):
        _fields_ = [("Length", ctypes.c_ushort), ("MaximumLength", ctypes.c_ushort),
                    ("Buffer", ctypes.c_void_p)]

    u = UNICODE_STRING()
    ntdll.NtQueryInformationProcess.restype = ctypes.c_long
    ntdll.NtQueryInformationProcess.argtypes = [wintypes.HANDLE, ctypes.c_int,
                                                ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p]
    st = ntdll.NtQueryInformationProcess(h, 60, ctypes.byref(u), ctypes.sizeof(u), None)
    kernel32.CloseHandle(h)
    if st != 0 or not u.Buffer:
        return ""
    try:
        return ctypes.wstring_at(u.Buffer)
    except Exception:
        return ""


def _wechatappex_pids():
    """Toolhelp32 进程快照：列出所有 WeChatAppEx.exe 的 [{pid, cmdline}]。无子进程，沙箱可用。"""
    kernel32 = ctypes.windll.kernel32
    TH32CS_SNAPPROCESS = 0x2
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel32.Process32FirstW.restype = wintypes.BOOL
    kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
    kernel32.Process32NextW.restype = wintypes.BOOL
    kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [("dwSize", ctypes.c_ulong), ("cntUsage", ctypes.c_ulong),
                    ("th32ProcessID", ctypes.c_ulong), ("th32DefaultHeapID", ctypes.c_size_t),
                    ("th32ModuleID", ctypes.c_ulong), ("cntThreads", ctypes.c_ulong),
                    ("th32ParentProcessID", ctypes.c_ulong), ("pcPriClassBase", ctypes.c_long),
                    ("dwFlags", ctypes.c_ulong), ("szExeFile", ctypes.c_wchar * 260)]

    h = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if not h:
        return []
    out = []
    entry = PROCESSENTRY32W()
    entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
    if kernel32.Process32FirstW(h, ctypes.byref(entry)):
        while True:
            if entry.szExeFile.lower() == "wechatappex.exe":
                out.append({"pid": entry.th32ProcessID, "cmdline": _get_cmdline(entry.th32ProcessID)})
            if not kernel32.Process32NextW(h, ctypes.byref(entry)):
                break
    kernel32.CloseHandle(h)
    return out


def _gather(pid):
    kernel32 = ctypes.windll.kernel32
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.VirtualQueryEx.restype = ctypes.c_size_t
    kernel32.VirtualQueryEx.argtypes = [wintypes.HANDLE, ctypes.c_void_p,
                                        ctypes.POINTER(MBI), ctypes.c_size_t]
    kernel32.ReadProcessMemory.restype = wintypes.BOOL
    kernel32.ReadProcessMemory.argtypes = [wintypes.HANDLE, ctypes.c_void_p,
                                           ctypes.c_void_p, ctypes.c_size_t,
                                           ctypes.POINTER(ctypes.c_size_t)]
    PROCESS_VM_READ = 0x0010
    PROCESS_QUERY_INFORMATION = 0x0400
    MEM_COMMIT = 0x1000
    h = kernel32.OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, False, pid)
    if not h:
        return None
    chunks = []
    addr = 0
    mbi = MBI()
    max_addr = 0x7FFFFFFFFFFF
    while addr < max_addr:
        if kernel32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi),
                                   ctypes.sizeof(mbi)) == 0:
            break
        base = mbi.BaseAddress or 0
        size = mbi.RegionSize or 0
        if (mbi.State == MEM_COMMIT and size > 0
                and not (mbi.Protect & 0x100) and mbi.Protect != 0x01
                and (mbi.Protect & 0x04) and size < 0x2000000):
            buf = ctypes.create_string_buffer(size)
            read = ctypes.c_size_t(0)
            if kernel32.ReadProcessMemory(h, ctypes.c_void_p(base), buf, size,
                                          ctypes.byref(read)):
                chunks.append(buf.raw[:read.value])
        addr = base + max(size, 1)
    kernel32.CloseHandle(h)
    return b"".join(chunks)


# ---------------- jwt 保存/兜底 ----------------
JWT_SAVE_DIR = os.path.join(os.path.expanduser("~"), ".thu-sports-venue")
JWT_SAVE = os.path.join(JWT_SAVE_DIR, "wechat-room-jwt.txt")
_JWT_SOURCE = None   # "live"=实时内存提取 / "saved"=兜底复用 / None=无


def _decode_jwt(tok):
    try:
        import base64
        parts = tok.split(".")
        if len(parts) != 3:
            return None
        pad = parts[1] + "=" * (-len(parts[1]) % 4)
        return json.loads(base64.urlsafe_b64decode(pad))
    except Exception:
        return None


def _jwt_not_expired(obj):
    exp = obj.get("exp")
    return bool(exp) and exp > time.time()


def _save_jwt(tok):
    try:
        os.makedirs(JWT_SAVE_DIR, exist_ok=True)
        with open(JWT_SAVE, "w", encoding="utf-8") as f:
            f.write(_enc(tok))
    except Exception as e:
        # 加密失败（如 cryptography 装不上）时拒绝落明文，仅提示、本次内存使用
        print("[提示] 登录态未保存（" + str(e) + "）；本次仅在内存中使用，不影响查询/申请。", file=sys.stderr)


def _read_saved_jwt():
    try:
        if os.path.exists(JWT_SAVE):
            # 保留约 7 天（与后端 jwt 有效期对齐）：文件修改时间距今超过该时长视为过期 → 删除并当未登录
            if _expired(os.path.getmtime(JWT_SAVE) * 1000):
                try: os.remove(JWT_SAVE)
                except Exception: pass
                return None
            with open(JWT_SAVE, "r", encoding="utf-8") as f:
                return _dec(f.read().strip()).strip()
    except Exception:
        pass
    return None


def _jwt_valid(tok):
    """用只读接口校验 token 当前是否仍被服务端接受（旧 token 会被吊销，返回非 200）。"""
    try:
        req = urllib.request.Request(BASE + "/activity/rooms", headers={"Authorization": "Bearer " + tok})
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status == 200
    except Exception:
        return False


def extract_jwt():
    """找当前有效的 JWT：先试已保存的（服务端校验），无效则扫内存候选并逐个用服务端过滤，取第一个有效。"""
    global _JWT_SOURCE
    # 0) 快路：已保存的 token 若服务端仍接受则直接复用
    saved = _read_saved_jwt()
    if saved:
        obj = _decode_jwt(saved)
        if obj and _jwt_not_expired(obj) and _jwt_valid(saved):
            _JWT_SOURCE = "saved"
            return saved, obj
    procs = _wechatappex_pids()
    if not procs:
        print("未找到 WeChatAppEx.exe 进程（微信小程序未运行）", file=sys.stderr)
        return None

    def priority(p):
        cmd = p["cmdline"]
        if "--type=" not in cmd:
            return 0                      # main
        if "network.mojom" in cmd:
            return 1                      # network service
        return 5                          # 其它

    procs.sort(key=lambda p: priority(p))
    import base64
    seen = set()
    tested = 0
    for p in procs[:25]:
        pid = p["pid"]
        if pid in seen:
            continue
        seen.add(pid)
        data = _gather(pid)
        if not data:
            continue
        for m in re.finditer(rb"eyJ[A-Za-z0-9_\-]{10,200}\.[A-Za-z0-9_\-]{10,300}\.[A-Za-z0-9_\-]{10,400}", data):
            tok = m.group(0).decode("ascii")
            if tok.count(".") != 2:
                continue
            obj = _decode_jwt(tok)
            if not (isinstance(obj, dict) and ("card" in obj or "openId" in obj or "exp" in obj)):
                continue
            tested += 1
            if tested > 40:               # 上限，避免过多校验请求
                break
            if _jwt_valid(tok):
                _save_jwt(tok)
                _JWT_SOURCE = "live"
                return tok, obj
        if tested > 40:
            break
    _JWT_SOURCE = None
    return None


def _api(method, path, jwt, params=None, body=None):
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    data = None
    headers = {"Authorization": "Bearer " + jwt}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read()
            if not raw:                       # 204 无内容：返回状态 + 空对象
                return resp.status, {}
            try:
                return resp.status, json.loads(raw.decode("utf-8"))
            except Exception:
                return resp.status, raw.decode("utf-8", "ignore")
    except Exception as e:
        return None, str(e)


def _api_full(method, path, jwt, params=None, body=None):
    """同 _api，但返回 (status, json_or_text, headers)，用于需读响应的 Location 等头的请求。"""
    import urllib.error
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    data = None
    headers = {"Authorization": "Bearer " + jwt}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read()
            parsed = json.loads(raw.decode("utf-8")) if raw else {}
            ho = {k: v for k, v in resp.headers.items()}
            return resp.status, parsed, ho
    except urllib.error.HTTPError as e:
        raw = e.read()
        parsed = None
        try:
            parsed = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            parsed = raw.decode("utf-8", "ignore")
        return e.code, parsed, dict(e.headers)
    except Exception as e:
        return None, str(e), {}


def cmd_jwt():
    r = extract_jwt()
    if not r:
        print(json.dumps({"found": False}, ensure_ascii=False))
        return 2
    tok, payload = r
    print(_scrub(json.dumps({"found": True, "jwt": tok, "payload": payload}, ensure_ascii=False)))
    return 0


def cmd_list(j):
    st, data = _api("GET", "/activity/rooms", j)
    if st != 200:
        print(_scrub(json.dumps({"ok": False, "error": data}, ensure_ascii=False)))
        return 1
    rooms = data.get("value", [])
    if "--json" in sys.argv:
        print(json.dumps(data, ensure_ascii=False))
        return 0
    print("活动室（共 %d 个）：" % data.get("count", len(rooms)))
    for r in rooms:
        tags = "、".join(r.get("tags", [])) or r.get("note", "") or ""
        avail = "" if r.get("available") else "  [不可约]"
        dept = (r.get("department") or {}).get("name", "")
        print("  · %s  %s  %s人  %s%s%s" % (
            r.get("name", ""), r.get("location", ""), r.get("capacity", "?"),
            tags, avail, ("  [" + dept + "]") if dept else ""))
    return 0


def cmd_occupancy(j):
    target = sys.argv[2] if len(sys.argv) > 2 else None
    if not target:
        print("用法: wechat-room-api.py occupancy <房间名|id> [--json]")
        return 1
    # 若给的是房间名，先查列表找 id
    room_id = target
    st, data = _api("GET", "/activity/rooms", j)
    if st == 200:
        for r in data.get("value", []):
            if r.get("id") == target or r.get("name") == target:
                room_id = r.get("id")
                break
    st2, rec = _api("GET", "/activity/rooms/%s/records" % room_id, j)
    if st2 != 200:
        print(json.dumps({"ok": False, "error": rec}, ensure_ascii=False))
        return 1
    if "--json" in sys.argv:
        print(json.dumps(rec, ensure_ascii=False))
        return 0
    print("占用记录（%s，共 %d 条）：" % (target, rec.get("count", len(rec.get("value", [])))))
    import datetime as _dt
    def _bj(iso):
        try:
            d = _dt.datetime.strptime(iso, "%Y-%m-%dT%H:%M:%S.%fZ")
            return (d + _dt.timedelta(hours=8)).strftime("%m-%d %H:%M")
        except Exception:
            return iso
    for r in rec.get("value", []):
        stx = "已通过/已借用" if r.get("status") == "verified" else ("申请中" if r.get("status") == "pending" else r.get("status"))
        print("  · %s ~ %s  [%s]（北京时间）" % (_bj(r.get("start", "")), _bj(r.get("end", "")), stx))
    return 0


# ---------------- 推荐（recommend：按容量/用途/位置筛活动室） ----------------
TYPE_ALIASES = {
    "会议": ["会议", "研讨", "讲座", "会谈", "工作坊", "远程会议", "讨论", "小组"],
    "研讨": ["研讨", "会议", "讨论", "小组", "会谈", "工作坊"],
    "讨论": ["研讨", "会议", "讨论", "小组", "会谈", "会客"],
    "排练": ["排练"],
    "舞蹈": ["舞蹈"],
    "投影": ["投影", "电视", "屏幕", "可投影"],
    "多媒体": ["投影", "电视", "屏幕", "智能电视"],
    "录音": ["录音", "麦克风", "声卡"],
    "拍摄": ["导播", "演播", "绿幕", "录像机", "监视器"],
    "沙龙": ["沙龙", "微沙龙"],
    "茶": ["茶室"],
    "咖啡": ["咖啡"],
    "会客": ["会客室", "接待"],
}
# 活动用途 -> 需要的房间功能关键词（用于 用途↔房间 匹配）
PURPOSE_FEATURES = {
    "会议": ["会议", "研讨", "讲座", "讨论", "答辩", "工作坊", "远程"],
    "讨论": ["研讨", "会议", "讨论", "会客", "小组"],
    "自习": ["研讨", "自习", "书", "阅读"],
    "讲座": ["会议", "讲座", "答辩", "报告", "工作坊"],
    "学术": ["会议", "讲座", "答辩", "报告", "学术"],
    "沙龙": ["沙龙", "茶", "咖啡", "会客", "小组"],
    "会客": ["会客", "接待", "茶", "咖啡"],
    "团建": ["班团", "多功能", "排练", "大客厅"],
    "排练": ["排练"],
    "舞蹈": ["舞蹈", "镜子"],
    "录音": ["录音", "麦克风", "声卡"],
    "拍摄": ["导播", "演播", "绿幕", "录像机", "监视器", "提词器"],
    "直播": ["导播", "演播", "绿幕", "摄像"],
}
# 用不到房间特殊功能的「一般用途」（这些用途不推荐专门的录音/导播/舞蹈/排练房，否则申请大概率不通过）
SPECIALIZED_PURPOSES = {"排练", "舞蹈", "录音", "拍摄", "直播"}
SPECIALIZED_TAGS = ("录音", "导播", "演播", "绿幕", "录像机", "监视器", "提词器",
                    "灯光控制台", "舞蹈", "镜子", "排练", "麦克风", "声卡")


def _all_tags_specialized(r):
    """房间的所有用途标签都是「专用功能」，无通用用途词（如 研讨/会议/多功能/大客厅）。"""
    tags = [t for t in r.get("tags", []) if t]
    if not tags:
        return False
    return all(any(s in t for s in SPECIALIZED_TAGS) for t in tags)


# ---------------- 各位置的预约规则（时段/提前天数/上限），用于按日期过滤推荐 ----------------
LOCATION_RULES = {
    "C楼二楼":   {"start_h": 7, "end_h": 23, "min_advance_days": 0, "min_advance_h": 4, "max_days": 14, "single_max_h": 2},
    "C楼三楼":   {"start_h": 7, "end_h": 23, "min_advance_days": 0, "min_advance_h": 4, "max_days": 14, "single_max_h": 2},
    "南区地下":   {"start_h": 7, "end_h": 23, "min_advance_days": 0, "min_advance_h": 4, "max_days": 14, "single_max_h": 2},
    "胜因院22号": {"start_h": 9, "end_h": 21, "min_advance_days": 3, "max_days": 14, "single_max_h": 2},
}


def _rule_for(loc):
    for k, v in LOCATION_RULES.items():
        if k in (loc or ""):
            return v
    return {"start_h": 7, "end_h": 23, "min_advance_days": 0, "min_advance_h": 4, "max_days": 14, "single_max_h": 2}


def _date_allowed(loc, d):
    """某位置在某天是否可约：超出最多提前天数 or 不满足最短提前天数（如胜因院≥3天）则不可约。"""
    import datetime as dt
    r = _rule_for(loc)
    days_ahead = (d - dt.date.today()).days
    if days_ahead > r.get("max_days", 14):
        return False
    if r.get("min_advance_days", 0) and days_ahead < r["min_advance_days"]:
        return False
    return True


def _parse_kv_args(args):
    d = {}
    i = 0
    while i < len(args):
        a = args[i]
        if a.startswith("--") and i + 1 < len(args) and not args[i + 1].startswith("--"):
            d[a[2:]] = args[i + 1]
            i += 2
        else:
            i += 1
    return d


def _room_text(r):
    return (r.get("name", "") + " " + " ".join(r.get("tags", [])) + " " + (r.get("note", "") or ""))


def cmd_recommend(jwt):
    kv = _parse_kv_args(sys.argv[2:])
    cap_min = int(kv["capacity"]) if kv.get("capacity") else None      # 最少容纳(>=)
    cap_max = int(kv["max"]) if kv.get("max") else None                 # 最多容纳(<=)
    cap_exact = int(kv["exact"]) if kv.get("exact") else None           # 精确
    type_kw = kv.get("type")
    purpose = kv.get("purpose")
    location = kv.get("location")
    st, data = _api("GET", "/activity/rooms", jwt)
    if st != 200:
        print(_scrub(json.dumps({"ok": False, "error": data}, ensure_ascii=False)))
        return 1
    rooms = data.get("value", [])
    matches = []
    excluded_specialized = 0
    for r in rooms:
        cap = r.get("capacity", 0)
        if cap_exact is not None and cap != cap_exact:
            continue
        if cap_min is not None and cap < cap_min:
            continue
        if cap_max is not None and cap > cap_max:
            continue
        txt = _room_text(r)
        if location and location not in r.get("location", ""):
            continue
        if purpose:
            feats = PURPOSE_FEATURES.get(purpose, [purpose])
            if not any(f in txt for f in feats):
                continue
            # 一般用途：排除「专属功能房」(录音/导播/舞蹈/排练等)，用不到其特殊功能大概率不通过
            if purpose not in SPECIALIZED_PURPOSES and _all_tags_specialized(r):
                excluded_specialized += 1
                continue
        elif type_kw:
            kws = TYPE_ALIASES.get(type_kw, [type_kw])
            if not any(k in txt for k in kws):
                continue
        matches.append(r)
    matches.sort(key=lambda r: (r.get("capacity", 0), r.get("seq", 0)))
    if "--json" in sys.argv:
        print(json.dumps({"count": len(matches), "value": matches, "excluded_specialized": excluded_specialized,
                          "hint": ("" if matches else "无匹配活动室——通常是容量/类型/用途/位置过滤太严，可放宽或去掉过滤重试；或用 `list` 看全部")},
                         ensure_ascii=False))
        return 0
    print("推荐结果（%d 个）：" % len(matches))
    if not matches:
        print("⚠️ 无匹配活动室——通常是容量/类型/用途/位置过滤太严，可放宽或去掉过滤重试；或用 `list` 看全部活动室。")
    for r in matches:
        tags = "、".join(r.get("tags", [])) or r.get("note", "") or ""
        dept = (r.get("department") or {}).get("name", "")
        rule = _rule_for(r.get("location", ""))
        rnote = ""
        if rule.get("min_advance_days"):
            rnote = "  [需提前≥%d天，%d:00-%d:00]" % (rule["min_advance_days"], rule["start_h"], rule["end_h"])
        else:
            rnote = "  [%d:00-%d:00]" % (rule["start_h"], rule["end_h"])
        print("  · %s  %s  %s人  %s%s%s" % (
            r.get("name", ""), r.get("location", ""), r.get("capacity", "?"),
            tags, ("  [" + dept + "]") if dept else "", rnote))
    if purpose:
        if purpose in SPECIALIZED_PURPOSES:
            print("说明：已按专用用途「%s」匹配对应的专门功能房（排练/舞蹈/录音/拍摄/直播）。" % purpose)
        else:
            print("说明：已按用途「%s」匹配；并已避免推荐录音/导播/舞蹈/排练等「专属功能房」"
                  "（其特殊功能与用途不符，申请大概率不通过）。" % purpose)
    return 0


# ---------------- avail：按需求 + 日期区间，返回匹配活动室的可约时段 ----------------
def _epoch_ms(iso):
    """ISO 字符串 -> UTC 毫秒时间戳"""
    try:
        import datetime as dt
        dt_ = dt.datetime.strptime(iso, "%Y-%m-%dT%H:%M:%S.%fZ")
        return int(dt_.replace(tzinfo=dt.timezone.utc).timestamp() * 1000)
    except Exception:
        return None


def _bjd(ms):
    """UTC ms -> 北京日期对象"""
    import datetime as dt
    return dt.datetime.fromtimestamp(ms / 1000 + 8 * 3600, dt.timezone.utc).date()


def _bjmin(ms):
    """UTC ms -> 北京 当日分钟数(0-1439)"""
    import datetime as dt
    d = dt.datetime.fromtimestamp(ms / 1000 + 8 * 3600, dt.timezone.utc)
    return d.hour * 60 + d.minute


def cmd_avail(jwt):
    kv = _parse_kv_args(sys.argv[2:])
    cap_min = int(kv["capacity"]) if kv.get("capacity") else None
    cap_max = int(kv["max"]) if kv.get("max") else None
    cap_exact = int(kv["exact"]) if kv.get("exact") else None
    type_kw = kv.get("type")
    purpose = kv.get("purpose")
    location = kv.get("location")
    import datetime as dt
    today = dt.date.today()
    start = dt.date.fromisoformat(kv["from"]) if kv.get("from") else today
    end = dt.date.fromisoformat(kv["to"]) if kv.get("to") else (start + dt.timedelta(days=6))
    if end < start:
        start, end = end, start

    st, data = _api("GET", "/activity/rooms", jwt)
    if st != 200:
        print(_scrub(json.dumps({"ok": False, "error": data}, ensure_ascii=False)))
        return 1
    rooms = data.get("value", [])
    matches = []
    for r in rooms:
        cap = r.get("capacity", 0)
        if cap_exact is not None and cap != cap_exact:
            continue
        if cap_min is not None and cap < cap_min:
            continue
        if cap_max is not None and cap > cap_max:
            continue
        txt = _room_text(r)
        if purpose:
            feats = PURPOSE_FEATURES.get(purpose, [purpose])
            if not any(f in txt for f in feats):
                continue
        elif type_kw:
            kws = TYPE_ALIASES.get(type_kw, [type_kw])
            if not any(k in txt for k in kws):
                continue
        if location and location not in r.get("location", ""):
            continue
        matches.append(r)
    matches.sort(key=lambda r: (r.get("capacity", 0), r.get("seq", 0)))

    DAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
    out = []
    for r in matches:
        rule = _rule_for(r.get("location", ""))
        oh, ch = rule["start_h"], rule["end_h"]
        day_range = [(start + dt.timedelta(days=i)) for i in range((end - start).days + 1)]
        allowed = [d for d in day_range if _date_allowed(r.get("location", ""), d)]
        if not allowed:
            continue    # 该位置规则不允许这段区间（如胜因院需提前≥3天、对明天不可约）→ 排除
        st2, rec = _api("GET", "/activity/rooms/%s/records" % r["id"], jwt)
        recs = rec.get("value", []) if st2 == 200 else []
        day_map = {d: [] for d in allowed}
        for x in recs:
            s_ms = _epoch_ms(x.get("start", ""))
            e_ms = _epoch_ms(x.get("end", ""))
            if s_ms is None or e_ms is None:
                continue
            bd = _bjd(s_ms)
            if bd in day_map:
                day_map[bd].append((s_ms, e_ms, x.get("status", "")))
        free_by_day = {}
        booked_by_day = {}
        for day in sorted(day_map):
            rcs = sorted(day_map[day])
            cur = oh * 60
            segs = []
            blist = []
            for s_ms, e_ms, status in rcs:
                sm, em = _bjmin(s_ms), _bjmin(e_ms)
                if sm > cur:
                    segs.append((cur, min(sm, ch * 60)))
                cur = max(cur, em)
                blist.append((sm, em, status))
                if cur >= ch * 60:
                    break
            if cur < ch * 60:
                segs.append((cur, ch * 60))
            segs = [(a, b) for (a, b) in segs if b - a >= 30]
            free_by_day[day] = [(a, b) for (a, b) in segs]
            booked_by_day[day] = blist
        out.append({"room": r, "free": free_by_day, "booked": booked_by_day})

    if "--json" in sys.argv:
        print(json.dumps({"from": str(start), "to": str(end), "rooms": [{
            "name": o["room"]["name"], "location": o["room"]["location"],
            "capacity": o["room"]["capacity"], "type": o["room"].get("tags", []),
            "free": {str(d): [["%02d:%02d" % (a // 60, a % 60), "%02d:%02d" % (b // 60, b % 60)] for (a, b) in v]
                     for d, v in o["free"].items()},
        } for o in out], "hint": ("" if out else "无匹配活动室——通常是容量/类型/用途/日期过滤太严，可放宽或去掉过滤重试；或用 `list` 看全部")}, ensure_ascii=False))
        return 0

    print("需求：%s ~ %s ｜ 容量%s ｜ 用途:%s ｜ 位置:%s" % (
        start, end,
        (">=" + str(cap_min)) if cap_min is not None else "不限",
        type_kw or "不限", location or "不限"))
    print("匹配 %d 个活动室：\n" % len(out))
    if not out:
        print("⚠️ 无匹配活动室——通常是容量/类型/用途/日期过滤太严，可放宽或去掉过滤重试；或用 `list` 看全部活动室。")
    for o in out:
        r = o["room"]
        tags = "、".join(r.get("tags", [])) or r.get("note", "") or ""
        print("【%s】%s｜%s人｜%s" % (r.get("name", ""), r.get("location", ""), r.get("capacity", "?"), tags))
        free = []
        for day in sorted(o["free"]):
            for (a, b) in o["free"][day]:
                free.append("%s %s %02d:%02d-%02d:%02d" % (
                    day.strftime("%m-%d"), DAYS[day.weekday()], a // 60, a % 60, b // 60, b % 60))
        if free:
            print("  可约：" + "、".join(free[:10]) + (" 等" if len(free) > 10 else ""))
        else:
            print("  可约：该区间内暂无空闲")
        print("")
    return 0


# ---------------- 前置检查：微信进程 / 学生清华小程序窗口 / jwt ----------------
def _mp_window_open():
    """是否可见「学生清华」小程序窗口。"""
    user32 = ctypes.windll.user32
    found = {"ok": False}
    WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, ctypes.c_void_p)

    def cb(h, l):
        if not user32.IsWindowVisible(h):
            return True
        b = ctypes.create_unicode_buffer(512)
        user32.GetWindowTextW(h, b, 512)
        if "学生清华" in b.value:
            found["ok"] = True
            return False
        return True

    user32.EnumWindows(WNDENUMPROC(cb), 0)
    return found["ok"]


def cmd_check():
    """检查前置：登录态(jwt) 是否可用。查询/推荐/占用/可约/申请/撤销均为 API 直连，只需有效 jwt。
    wechat_running / miniprogram_open 仅作为「是否需要重新登录刷新」的参考，不决定能否操作。"""
    procs = _wechatappex_pids()
    wechat = bool(procs)
    mp = _mp_window_open()
    jwt_res = extract_jwt()
    jwt_ok = jwt_res is not None
    jwt_src = _JWT_SOURCE
    card = (jwt_res[1].get("card") if jwt_res else None)
    status = {
        "wechat_running": wechat, "miniprogram_open": mp,
        "jwt_available": jwt_ok, "jwt_source": jwt_src, "card": card,
        "ready_for_query": bool(jwt_ok),   # 查询/推荐/占用/可约：只需有效 jwt（无需微信窗口）
        "ready_for_apply": bool(jwt_ok),   # 申请/撤销：也是 API，只需有效 jwt
        "note": "查询/申请/撤销均为 API 直连，只需有效登录态(jwt)；jwt 由 wx.login 产生、约 7 天过期，过期需在微信里打开「学生清华」小程序一次以刷新。",
    }
    print(json.dumps(status, ensure_ascii=False))
    if not jwt_ok:
        print("→ 无有效登录态：请打开并登录 PC 微信 → 打开「学生清华」小程序确认已登录（脚本会自动获取并保存 jwt）。", file=sys.stderr)
        return 2
    if not wechat or not mp:
        print("→ 登录态有效（%s）。微信/小程序当前未打开也没关系：查询/申请/撤销直接走 API 可用；"
              "仅当 jwt 过期(~7天)时才需重新在微信里打开小程序刷新。" %
              ("实时提取" if jwt_src == "live" else "复用已保存"), file=sys.stderr)
    else:
        print("✔ 已登录（%s），微信 + 学生清华小程序均在，可直接使用。" %
              ("实时提取" if jwt_src == "live" else "复用已保存"), file=sys.stderr)
    return 0


# ---------------- apply：直接 POST /activity/room-tickets 提交申请（高度自动化） ----------------
TYPE_MAP = {   # 活动类型下拉值 -> 后端 activityType（实测合法: party/art/sports/academy/culture/others/organization）
    "党团活动": "party", "社团活动": "organization", "体育赛事": "sports",
    "学术报告": "academy", "文化活动": "culture", "文艺活动": "art", "其它活动": "others",
}


def _bj_ms(d, t):
    """北京日期+时间 -> epoch 毫秒（UTC）"""
    import datetime as dt
    return int(dt.datetime.strptime(d + "T" + t + ":00+08:00", "%Y-%m-%dT%H:%M:%S%z").timestamp() * 1000)


def cmd_apply(jwt):
    kv = _parse_kv_args(sys.argv[2:])
    yes = "--yes" in sys.argv
    room = kv.get("room"); date = kv.get("date"); start = kv.get("start"); end = kv.get("end")
    organizer = kv.get("organizer") or _load_org(); participants = kv.get("participants")
    subject = kv.get("subject", "无"); usage = kv.get("usage", "无")
    atype = kv.get("type", "sports"); atype = TYPE_MAP.get(atype, atype)
    target = kv.get("target", "school")
    if not all([room, date, start, end, organizer, participants]):
        print(json.dumps({"ok": False, "error": "缺少必填：--room --date --start --end --organizer（或 config org 已存）--participants"}, ensure_ascii=False))
        return 1
    st, data = _api("GET", "/activity/rooms", jwt)
    if st != 200:
        print(_scrub(json.dumps({"ok": False, "error": data}, ensure_ascii=False))); return 1
    roomobj = next((r for r in data.get("value", []) if r.get("name") == room or r.get("id") == room), None)
    if not roomobj:
        print(json.dumps({"ok": False, "error": "未找到房间 " + room}, ensure_ascii=False)); return 1
    st_s, sem = _api("GET", "/account/semesters", jwt)
    semesters = sem if isinstance(sem, list) else (sem or {}).get("value", [])
    def _in_sem(s):
        s0 = (s.get("start") or ""); s1 = (s.get("end") or "")
        return (s0[:10] <= date <= s1[:10]) if (s0 and s1) else True
    semester = next((s for s in semesters if _in_sem(s)), semesters[0] if semesters else None)
    if not semester or not semester.get("id"):
        print(json.dumps({"ok": False, "error": "未取到学期"}, ensure_ascii=False)); return 1
    # 校验：参与人数为数字且 ≤ 房间容量；时长 ≤2h（软约束提示）
    cap = roomobj.get("capacity", 0) or 0
    try:
        pnum = int(participants)
    except Exception:
        print(json.dumps({"ok": False, "error": "参与人数必须是数字"}, ensure_ascii=False)); return 1
    if cap and pnum > cap:
        print(json.dumps({"ok": False, "error": "参与人数(%d)超过房间容量(%d)" % (pnum, cap)}, ensure_ascii=False)); return 1
    dur_h = (_bj_ms(date, end) - _bj_ms(date, start)) / 3600000.0
    if dur_h > 2:
        print(json.dumps({"ok": False, "error": "单次预约时长 %.1fh 超过 2h（规范单次≤2h，审批大概率不通过）" % dur_h}, ensure_ascii=False)); return 1
    body = {
        "organizer": organizer, "subject": subject, "participantCount": str(participants),
        "coOrganizer": "", "activityType": atype, "activityTarget": target,
        "needMeal": "--need-meal" in sys.argv, "needFilm": "--need-film" in sys.argv,
        "isBigEvent": "--is-big-event" in sys.argv, "usage": usage,
        "records": [{"type": 0, "roomId": roomobj["id"], "semesterId": semester["id"],
                     "start": _bj_ms(date, start), "end": _bj_ms(date, end)}],
    }
    if not yes:
        print(json.dumps({"ok": True, "dry_run": True, "endpoint": "POST /activity/room-tickets",
                          "request": body}, ensure_ascii=False))
        return 0
    # 提交前校验：①每日1次 ②该房间该时段是否已被占用/申请中
    if "--force" not in sys.argv:
        st_my, mydata = _api("GET", "/activity/room-tickets?state=pending&skip=0&top=50", jwt)
        if st_my == 200:
            for t in mydata.get("value", []):
                for rec in (t.get("records") or []):
                    s_ms = rec.get("start")
                    bd = _bjd(s_ms) if isinstance(s_ms, (int, float)) else None
                    if bd and str(bd) == date:
                        print(json.dumps({"ok": False, "error": "该日期(%s)已有一笔申请（每日最多 1 次），无法再约" % date}, ensure_ascii=False))
                        return 1
        st_r, rdata = _api("GET", "/activity/rooms/%s/records" % roomobj["id"], jwt)
        recs = rdata.get("value", []) if st_r == 200 else []
        ts, te = body["records"][0]["start"], body["records"][0]["end"]
        for rec in recs:
            rs = _epoch_ms(rec.get("start")); re_ = _epoch_ms(rec.get("end"))
            if rs is not None and re_ is not None and rs < te and re_ > ts:
                print(json.dumps({"ok": False, "error": "时段冲突：该房间此时间已被占用/申请中",
                                  "conflict": {"start": rec.get("start"), "end": rec.get("end"),
                                               "status": rec.get("status")}}, ensure_ascii=False))
                return 1
    # 两步：创建 ticket（ticketId 在响应头 Location）-> apply
    st1, _r1, hdrs = _api_full("POST", "/activity/room-tickets", jwt, body=body)
    loc = hdrs.get("Location") or hdrs.get("location") or ""
    ticket_id = loc.rsplit("/", 1)[-1] if loc else None
    if st1 != 200 or not ticket_id:
        print(json.dumps({"ok": False, "code": st1, "headers": hdrs, "response": _r1}, ensure_ascii=False)); return 1
    st2, resp2 = _api("POST", "/activity/room-tickets/%s/apply" % ticket_id, jwt, body={})
    ok = st2 in (200, 204)
    if not ok:
        # 提交失败：自动清理刚创建的草稿（避免残留废草稿）
        _api("POST", "/activity/room-tickets/%s/remove" % ticket_id, jwt, body={})
    print(json.dumps({"ok": ok, "ticket_id": ticket_id, "create_code": st1, "apply_code": st2,
                      "result": "已提交" if ok else resp2}, ensure_ascii=False))
    return 0 if ok else 1


# ---------------- cancel/revoke：撤销申请（并删除撤销后回到草稿箱的草稿，固定步骤） ----------------
def cmd_cancel(jwt):
    kv = _parse_kv_args(sys.argv[2:])
    ticket = kv.get("ticket") or kv.get("id")
    if not ticket:
        print(json.dumps({"ok": False, "error": "缺少 --ticket <ticketId>"}, ensure_ascii=False))
        return 1
    # 1) 撤销（已提交 → 204；若已是草稿则 412）
    st, resp = _api("POST", "/activity/room-tickets/%s/revoke" % ticket, jwt, body={"ticketId": ticket})
    # 2) 固定步骤：删除撤销后回到草稿箱的草稿
    st2, resp2 = _api("POST", "/activity/room-tickets/%s/remove" % ticket, jwt, body={})
    ok = (st in (200, 204)) or (st2 in (200, 204))
    print(json.dumps({"ok": ok, "ticket_id": ticket, "revoke_code": st, "remove_code": st2,
                      "result": "已撤销并删除草稿" if ok else (resp if not (st in (200, 204)) else resp2)},
                     ensure_ascii=False))
    return 0 if ok else 1


# ---------------- mine / drafts：我的申请（不含草稿）/ 草稿箱 ----------------
def _fmt_rows(jwt, states):
    rows = []
    for s in states:
        st, data = _api("GET", "/activity/room-tickets?state=%s&skip=0&top=50" % s, jwt)
        if st != 200:
            continue
        for t in (data.get("value", []) if isinstance(data, dict) else []):
            rows.append({
                "库": s, "id": t.get("id"), "state": t.get("state"),
                "target": t.get("activityTarget"), "type": t.get("activityType"),
                "organizer": (t.get("organizer") or "")[:30], "subject": (t.get("subject") or "")[:30],
                "created": (t.get("created") or "")[:19].replace("T", " "),
                "records": (t.get("records") or [])[:3],
            })
    return rows


def _print_rows(rows, label, tip):
    if "--json" in sys.argv:
        print(json.dumps({"count": len(rows), "items": rows}, ensure_ascii=False))
        return
    if not rows:
        print(label + "：暂无")
        return
    print(label + "（%d 条）：" % len(rows))
    for r in rows:
        rec = r["records"][0] if r["records"] else {}
        slot = ""
        if rec:
            import datetime as dt
            try:
                s = dt.datetime.fromtimestamp(rec["start"] / 1000 + 8 * 3600, dt.timezone.utc)
                e = dt.datetime.fromtimestamp(rec["end"] / 1000 + 8 * 3600, dt.timezone.utc)
                slot = " %s %s-%s" % (s.strftime("%m-%d"), s.strftime("%H:%M"), e.strftime("%H:%M"))
            except Exception:
                pass
        print("  [%s] %s " % (r["库"], r["id"]) + " | " + (r["type"] or "") + " | " + r["organizer"] + " | " + r["subject"] + slot)
    print(tip)


def cmd_mine(jwt):
    """列出我的申请（申请中/被拒；不含草稿箱）。"""
    rows = _fmt_rows(jwt, ["pending", "rejected"])
    _print_rows(rows, "我的申请", "提示：撤销用 `cancel --ticket <上面的 id>`（已自动删除草稿）。")
    return 0


def cmd_drafts(jwt):
    """列出草稿箱（未提交的草稿）。"""
    rows = _fmt_rows(jwt, ["draft"])
    _print_rows(rows, "草稿箱", "提示：删除草稿用 `remove --ticket <上面的 id>`。")
    return 0


# ---------------- remove：删除草稿（撤销/未提交的申请回到草稿箱后，用此彻底删除） ----------------
def cmd_remove(jwt):
    kv = _parse_kv_args(sys.argv[2:])
    ticket = kv.get("ticket") or kv.get("id")
    if not ticket:
        print(json.dumps({"ok": False, "error": "缺少 --ticket <ticketId>"}, ensure_ascii=False))
        return 1
    st, resp = _api("POST", "/activity/room-tickets/%s/remove" % ticket, jwt, body={})
    ok = st in (200, 204)
    print(json.dumps({"ok": ok, "code": st, "ticket_id": ticket, "result": "已删除" if ok else resp},
                     ensure_ascii=False))
    return 0 if ok else 1


# ---------------- config org：保存/读取主办方（与 wechat-room.py 共用同一配置文件） ----------------
CONFIG_DIR = os.path.join(os.path.expanduser("~"), ".thu-sports-venue")
CONFIG_FILE = os.path.join(CONFIG_DIR, "wechat-room-config.json")


def _load_org():
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            return (json.load(f) or {}).get("org", "")
    except Exception:
        return ""


def _save_org(org):
    os.makedirs(CONFIG_DIR, exist_ok=True)
    cfg = {}
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            cfg = json.load(f) or {}
    except Exception:
        pass
    cfg["org"] = org
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def cmd_config(args):
    """config org <主办方> 保存；config org [get] 读取。"""
    if len(args) >= 1 and args[0] == "org":
        if len(args) >= 2 and args[1] != "get":
            _save_org(args[1])
            print(json.dumps({"org": args[1], "saved": True}, ensure_ascii=False))
        else:
            print(json.dumps({"org": _load_org()}, ensure_ascii=False))
        return 0
    print("usage: wechat-room-api.py config org <主办方> | config org get")
    return 1


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 0
    cmd = args[0]
    if cmd == "check":
        return cmd_check()
    if cmd == "jwt":
        return cmd_jwt()
    # list / occupancy / recommend / avail 需要 jwt
    r = extract_jwt()
    if not r:
        print(json.dumps({"ok": False, "error": "未获取到可用登录态。请先打开并登录 PC 微信，再打开「学生清华」小程序（可运行 wechat-room-api.py check 查看前置）"}, ensure_ascii=False))
        return 2
    jwt, _ = r
    if cmd == "list":
        return cmd_list(jwt)
    if cmd == "occupancy":
        return cmd_occupancy(jwt)
    if cmd == "recommend":
        return cmd_recommend(jwt)
    if cmd == "avail":
        return cmd_avail(jwt)
    if cmd == "apply":
        return cmd_apply(jwt)
    if cmd in ("cancel", "revoke"):
        return cmd_cancel(jwt)
    if cmd == "mine":
        return cmd_mine(jwt)
    if cmd == "drafts":
        return cmd_drafts(jwt)
    if cmd in ("remove", "delete"):
        return cmd_remove(jwt)
    if cmd == "config":
        return cmd_config(args[1:])
    print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(main())
