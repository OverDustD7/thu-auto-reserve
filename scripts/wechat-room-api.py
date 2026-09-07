#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""学生清华活动室 API 客户端（Windows，Python 3.10+）。

登录：login --card 学工号（终端隐藏输入）；受信任集成可使用 --stdin。
检查/退登：check | logout。查询不扫描微信进程，不输出凭证。
查询：list | recommend | occupancy 房间 | avail --from YYYY-MM-DD --to YYYY-MM-DD
申请：apply --room 房间 --date YYYY-MM-DD --start HH:mm --end HH:mm
      --organizer 主办方 --participants 人数 --subject 主题 --usage 内容 --type 类型 [--yes]
撤销/删除：cancel --ticket ID [--yes] | remove --ticket ID [--yes]
列表：mine | drafts。主办方：config org 名称 | config org get。
所有写预约操作默认预演；显式 --yes 才执行；--dry-run 与 --yes 不可同时使用。
退出码：0 成功，1 失败，2 无有效会话。凭证通过 Windows DPAPI 保存，最长七天。
"""
import json
import os
import re
import sys
import time
import urllib.request
import urllib.parse
import urllib.error
import datetime as dt
import builtins
import getpass
import math

# Fail closed: encryption is part of the shipped runtime, never auto-installed.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib'))
from crypto import encrypt as _enc, decrypt as _dec, is_expired as _expired
BJ = dt.timezone(dt.timedelta(hours=8))
_SECRETS = set()

BASE = "https://student.tsinghua.edu.cn/v2/api"


def _scrub(s):
    if s is None:
        return s
    text = str(s)
    for secret in sorted(_SECRETS, key=len, reverse=True):
        text = text.replace(secret, '<redacted>')
    return re.sub(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '<redacted>', text)

def print(*args, **kwargs):
    builtins.print(*[_scrub(x) for x in args], **kwargs)

def _now():
    return dt.datetime.now(BJ)

def _confirmed():
    if '--yes' in sys.argv and '--dry-run' in sys.argv:
        raise ValueError('--yes 与 --dry-run 不能同时使用')
    return '--yes' in sys.argv

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, '拒绝携带凭证重定向', headers, fp)

_HTTP = urllib.request.build_opener(_NoRedirect)


try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


# ---------------- jwt 保存/兜底 ----------------
JWT_SAVE_DIR = os.path.join(os.path.expanduser("~"), ".thu-sports-venue")
JWT_SAVE = os.path.join(JWT_SAVE_DIR, "wechat-room-jwt.txt")
_JWT_SOURCE = None   # "saved"=显式导入后复用 / None=无


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
    exp = obj.get('exp') if isinstance(obj, dict) else None
    return isinstance(exp, (int, float)) and math.isfinite(exp) and exp > time.time()

def _target_payload(tok, expected_card):
    obj = _decode_jwt(tok)
    if not isinstance(obj, dict) or not expected_card or str(obj.get('card', '')) != str(expected_card):
        raise ValueError('登录态与指定学工号不匹配')
    if not isinstance(obj.get('openId'), str) or not obj['openId'] or not _jwt_not_expired(obj):
        raise ValueError('不是可用的学生清华登录态')
    issued = obj.get('iat')
    if not isinstance(issued, (int, float)) or not math.isfinite(issued) or issued > time.time() or obj['exp'] <= issued:
        raise ValueError('登录态签发时间无效')
    if obj.get('iss') and obj['iss'] not in ('student.tsinghua.edu.cn', BASE, 'https://student.tsinghua.edu.cn'):
        raise ValueError('登录态发行方不匹配')
    return obj

def _save_jwt(tok, card):
    encrypted = _enc(json.dumps({'jwt':tok,'card':str(card),'updatedAt':time.time()*1000}))
    os.makedirs(JWT_SAVE_DIR, exist_ok=True)
    temp = JWT_SAVE + '.' + str(os.getpid()) + '.tmp'
    try:
        with open(temp, 'x', encoding='utf-8') as f:
            f.write(encrypted)
        os.replace(temp, JWT_SAVE)
    finally:
        if os.path.exists(temp):
            os.remove(temp)

def _read_saved_jwt():
    if not os.path.exists(JWT_SAVE):
        return None
    try:
        with open(JWT_SAVE, encoding='utf-8') as f:
            saved = json.loads(_dec(f.read()))
        if _expired(saved.get('updatedAt')):
            raise ValueError('登录态到期')
        token = saved['jwt']
        _target_payload(token, saved['card'])
        _SECRETS.add(token)
        return token
    except RuntimeError:
        raise
    except Exception:
        os.remove(JWT_SAVE)
        return None

def _jwt_valid(tok):
    st, data = _api('GET', '/activity/rooms', tok)
    return st == 200 and isinstance(data, dict) and isinstance(data.get('value'), list)

def extract_jwt():
    # Queries never inspect WeChat process memory or guess candidate credentials.
    global _JWT_SOURCE
    token = _read_saved_jwt()
    if token and _jwt_valid(token):
        _JWT_SOURCE = 'saved'
        return token, _decode_jwt(token)
    _JWT_SOURCE = None
    return None

def cmd_login(args):
    kv = _parse_kv_args(args)
    card = kv.get('card')
    if not card or not re.fullmatch(r'[0-9A-Za-z]{4,32}', card):
        raise ValueError('登录需要 --card 指定本人学工号')
    token = sys.stdin.read().strip() if '--stdin' in args else getpass.getpass('请输入本人学生清华登录态（输入不显示）：').strip()
    _SECRETS.add(token)
    _target_payload(token, card)
    if not _jwt_valid(token):
        raise ValueError('学校接口未接受该登录态')
    _save_jwt(token, card)
    print(json.dumps({'ok':True,'card':card,'result':'登录态已保存'}, ensure_ascii=False))
    return 0

def cmd_logout():
    if os.path.exists(JWT_SAVE):
        os.remove(JWT_SAVE)
    print(json.dumps({'ok':True,'result':'已清除活动室登录态'}, ensure_ascii=False))
    return 0


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
        with _HTTP.open(req, timeout=20) as resp:
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
        with _HTTP.open(req, timeout=20) as resp:
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
    days_ahead = (d - _now().date()).days
    if days_ahead < 0:
        return False
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
def _epoch_ms(value):
    try:
        if isinstance(value, (int, float)) and math.isfinite(value):
            return int(value)
        parsed = dt.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            return None
        return int(parsed.timestamp() * 1000)
    except (ValueError, TypeError, OverflowError):
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
    today = _now().date()
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
            if purpose not in SPECIALIZED_PURPOSES and _all_tags_specialized(r):
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
        if st2 != 200 or not isinstance(rec, dict) or not isinstance(rec.get('value'), list):
            raise RuntimeError('未能查询房间占用，不能判断可约')
        recs = rec['value']
        day_map = {d: [] for d in allowed}
        for x in recs:
            s_ms = _epoch_ms(x.get("start", ""))
            e_ms = _epoch_ms(x.get("end", ""))
            if s_ms is None or e_ms is None or e_ms <= s_ms:
                raise ValueError('占用记录时间无效，不能判断可约')
            for day in day_map:
                midnight = int(dt.datetime.combine(day, dt.time(), BJ).timestamp() * 1000)
                if s_ms < midnight + 86400000 and e_ms > midnight:
                    day_map[day].append((max(s_ms, midnight), min(e_ms, midnight + 86400000), x.get('status', '')))
        free_by_day = {}
        booked_by_day = {}
        for day in sorted(day_map):
            rcs = sorted(day_map[day])
            now = _now()
            earliest = now + dt.timedelta(hours=rule.get('min_advance_h', 0))
            if day < earliest.date():
                free_by_day[day] = []
                booked_by_day[day] = []
                continue
            cur = max(oh * 60, earliest.hour * 60 + earliest.minute + bool(earliest.second or earliest.microsecond)) if day == earliest.date() else oh * 60
            segs = []
            blist = []
            for s_ms, e_ms, status in rcs:
                midnight = int(dt.datetime.combine(day, dt.time(), BJ).timestamp() * 1000)
                sm, em = (s_ms-midnight)//60000, (e_ms-midnight+59999)//60000
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
def cmd_check():
    r = extract_jwt()
    print(json.dumps({'ready_for_query':bool(r),'ready_for_apply':bool(r),'jwt_source':_JWT_SOURCE,
        'card':r[1].get('card') if r else None,
        'note':'查询不扫描微信进程；未登录时先使用 login --card 导入本人登录态'}, ensure_ascii=False))
    return 0 if r else 2


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
    yes = _confirmed()
    room = kv.get("room"); date = kv.get("date"); start = kv.get("start"); end = kv.get("end")
    organizer = kv.get("organizer") or _load_org(); participants = kv.get("participants")
    subject = kv.get("subject", "").strip(); usage = kv.get("usage", "").strip()
    atype = kv.get("type", "sports"); atype = TYPE_MAP.get(atype, atype)
    target = kv.get("target", "school")
    if not all([room, date, start, end, organizer, participants, subject, usage]):
        print(json.dumps({"ok": False, "error": "缺少必填：--room --date --start --end --organizer（或 config org 已存）--participants"}, ensure_ascii=False))
        return 1
    st, data = _api("GET", "/activity/rooms", jwt)
    if st != 200:
        print(_scrub(json.dumps({"ok": False, "error": data}, ensure_ascii=False))); return 1
    roomobj = next((r for r in data.get("value", []) if r.get("name") == room or r.get("id") == room), None)
    if not roomobj:
        print(json.dumps({"ok": False, "error": "未找到房间 " + room}, ensure_ascii=False)); return 1
    st_s, sem = _api("GET", "/account/semesters", jwt)
    if st_s != 200 or not isinstance(sem, (list, dict)):
        raise RuntimeError('学期查询失败，已停止预约')
    semesters = sem if isinstance(sem, list) else sem.get('value', [])
    def _in_sem(s):
        s0 = (s.get("start") or ""); s1 = (s.get("end") or "")
        return bool(s0 and s1 and s0[:10] <= date <= s1[:10])
    semester = next((s for s in semesters if _in_sem(s)), None)
    if not semester or not semester.get("id"):
        print(json.dumps({"ok": False, "error": "未取到学期"}, ensure_ascii=False)); return 1
    # 校验：参与人数为数字且 ≤ 房间容量；时长 ≤2h（软约束提示）
    cap = roomobj.get("capacity", 0) or 0
    try:
        pnum = int(participants)
    except Exception:
        print(json.dumps({"ok": False, "error": "参与人数必须是数字"}, ensure_ascii=False)); return 1
    if pnum <= 0:
        raise ValueError('参与人数必须为正整数')
    if cap and pnum > cap:
        print(json.dumps({"ok": False, "error": "参与人数(%d)超过房间容量(%d)" % (pnum, cap)}, ensure_ascii=False)); return 1
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', date) or not re.fullmatch(r'\d{2}:\d{2}', start) or not re.fullmatch(r'\d{2}:\d{2}', end):
        raise ValueError('日期/时间格式应为 YYYY-MM-DD 和 HH:mm')
    requested = dt.date.fromisoformat(date)
    rule = _rule_for(roomobj.get('location', ''))
    begin_ms, end_ms = _bj_ms(date, start), _bj_ms(date, end)
    now = _now()
    if not _date_allowed(roomobj.get('location', ''), requested):
        raise ValueError('日期不在该位置允许的预约范围内')
    if begin_ms <= now.timestamp()*1000 or begin_ms < (now + dt.timedelta(hours=rule.get('min_advance_h', 0))).timestamp()*1000:
        raise ValueError('预约时间已过或不满足最少提前时间')
    if start < '%02d:00' % rule['start_h'] or end > '%02d:00' % rule['end_h'] or end_ms <= begin_ms:
        raise ValueError('起止顺序或开放时间不符合规则')
    if atype not in set(TYPE_MAP.values()) or target != 'school':
        raise ValueError('活动类型或参与范围无效')
    if '--force' in sys.argv:
        raise ValueError('已移除绕过预约检查的 --force')
    dur_h = (end_ms - begin_ms) / 3600000.0
    if dur_h > 2:
        print(json.dumps({"ok": False, "error": "单次预约时长 %.1fh 超过 2h（规范单次≤2h，审批大概率不通过）" % dur_h}, ensure_ascii=False)); return 1
    body = {
        "organizer": organizer, "subject": subject, "participantCount": str(pnum),
        "coOrganizer": "", "activityType": atype, "activityTarget": target,
        "needMeal": "--need-meal" in sys.argv, "needFilm": "--need-film" in sys.argv,
        "isBigEvent": "--is-big-event" in sys.argv, "usage": usage,
        "records": [{"type": 0, "roomId": roomobj["id"], "semesterId": semester["id"],
                     "start": _bj_ms(date, start), "end": _bj_ms(date, end)}],
    }
    # The same preflight is required for preview and submission; errors stop both.
    mine = _fmt_rows(jwt, ['pending'])
    for ticket in mine:
        for rec in ticket['records']:
            stamp = _epoch_ms(rec.get('start'))
            if stamp is None:
                raise ValueError('已有申请的时间无效，不能判断每日限额')
            if str(_bjd(stamp)) == date:
                raise ValueError('该日期已有申请，每日最多一次')
    st_r, rdata = _api('GET', '/activity/rooms/%s/records' % roomobj['id'], jwt)
    if st_r != 200 or not isinstance(rdata, dict) or not isinstance(rdata.get('value'), list):
        raise RuntimeError('未能检查时段冲突，已停止预约')
    for rec in rdata['value']:
        rs, re_ = _epoch_ms(rec.get('start')), _epoch_ms(rec.get('end'))
        if rs is None or re_ is None or re_ <= rs:
            raise ValueError('占用记录无效，已停止预约')
        if rs < end_ms and re_ > begin_ms:
            raise ValueError('时段冲突，已停止预约')
    if not yes:
        print(json.dumps({'ok':True,'dry_run':True,'request':body}, ensure_ascii=False))
        return 0
    # 两步：创建 ticket（ticketId 在响应头 Location）-> apply
    st1, _r1, hdrs = _api_full("POST", "/activity/room-tickets", jwt, body=body)
    loc = hdrs.get("Location") or hdrs.get("location") or ""
    ticket_id = loc.rsplit("/", 1)[-1] if loc else None
    if st1 not in (200, 201) or not ticket_id:
        print(json.dumps({"ok": False, "code": st1, "response": _r1}, ensure_ascii=False)); return 1
    st2, resp2 = _api("POST", "/activity/room-tickets/%s/apply" % ticket_id, jwt, body={})
    ok = st2 in (200, 204)
    if not ok:
        # 不确定结果不得自动删除；保留 ticket_id 供只读核实
        print(json.dumps({'ok':False,'ticket_id':ticket_id,'result':'提交未确认，请先查询该申请状态再处理；未自动删除'}, ensure_ascii=False))
        return 1
    print(json.dumps({"ok": ok, "ticket_id": ticket_id, "create_code": st1, "apply_code": st2,
                      "result": "已提交" if ok else resp2}, ensure_ascii=False))
    return 0 if ok else 1


# ---------------- cancel/revoke：撤销申请（并删除撤销后回到草稿箱的草稿，固定步骤） ----------------
def cmd_cancel(jwt):
    kv = _parse_kv_args(sys.argv[2:])
    ticket = kv.get('ticket') or kv.get('id')
    if not ticket:
        raise ValueError('缺少 --ticket')
    if not _confirmed():
        print(json.dumps({'ok':True,'dry_run':True,'ticket_id':ticket,'remove_draft':True}, ensure_ascii=False))
        return 0
    st, _ = _api('POST', '/activity/room-tickets/%s/revoke' % ticket, jwt, body={'ticketId':ticket})
    revoked = st in (200, 204)
    if not revoked:
        print(json.dumps({'ok':False,'revoked':False,'removed':False,'revoke_code':st,'result':'撤销未确认，未执行删除'}, ensure_ascii=False))
        return 1
    st2, _ = _api('POST', '/activity/room-tickets/%s/remove' % ticket, jwt, body={})
    removed = st2 in (200, 204)
    print(json.dumps({'ok':removed,'ticket_id':ticket,'revoked':True,'removed':removed,
        'result':'已撤销并删除草稿' if removed else '已撤销，草稿删除未完成'}, ensure_ascii=False))
    return 0 if removed else 1


# ---------------- mine / drafts：我的申请（不含草稿）/ 草稿箱 ----------------
def _fmt_rows(jwt, states):
    rows = []
    for state in states:
        for skip in range(0, 10000, 50):
            st, data = _api('GET', '/activity/room-tickets?state=%s&skip=%d&top=50' % (state, skip), jwt)
            if st != 200 or not isinstance(data, dict) or not isinstance(data.get('value'), list):
                raise RuntimeError('申请列表查询失败，不能按无记录处理')
            page = data['value']
            for t in page:
                rows.append({'库':state,'id':t.get('id'),'state':t.get('state'),'target':t.get('activityTarget'),
                    'type':t.get('activityType'),'organizer':(t.get('organizer') or '')[:30],
                    'subject':(t.get('subject') or '')[:30],'created':str(t.get('created') or '')[:19].replace('T',' '),
                    'records':t.get('records') or []})
            if len(page) < 50:
                break
        else:
            raise RuntimeError('申请列表超出查询上限，未取得完整结果')
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
    if not _confirmed():
        print(json.dumps({'ok':True,'dry_run':True,'ticket_id':ticket}, ensure_ascii=False))
        return 0
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
    if cmd == 'login':
        return cmd_login(args[1:])
    if cmd == 'logout':
        return cmd_logout()
    if cmd == 'config':
        return cmd_config(args[1:])
    if cmd not in ('list','occupancy','recommend','avail','apply','cancel','revoke','mine','drafts','remove','delete'):
        print(__doc__)
        return 1
    r = extract_jwt()
    if not r:
        print(json.dumps({"ok": False, "error": "未获取到可用登录态。请先使用 login --card 导入本人学生清华登录态"}, ensure_ascii=False))
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


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as e:
        print(json.dumps({'ok':False,'error':str(e)}, ensure_ascii=False))
        sys.exit(1)
