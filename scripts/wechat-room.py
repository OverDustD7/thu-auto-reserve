#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
wechat-room.py -- 学生清华小程序·活动室申请 **UI 兜底**工具
> 查询/推荐/占用/可约/申请/撤销的**主脚本是 `wechat-room-api.py`（API 直连）**；本脚本仅在个别走不了 API 的动作（如实名/验证/特殊流程）用「截图 + 点击」驱动窗口时使用。
在 PC 版微信(Weixin 4.x)的「学生清华」小程序窗口上做：
  截图 / DPI-aware 精确点击 / 滚轮滚动 / 文本输入(剪贴板+Ctrl+V) / 定位窗口 / 配置持久化

用法：
  python wechat-room.py locate
  python wechat-room.py capture [out.png]
  python wechat-room.py click <img_x> <img_y>      # 图像坐标(物理像素)，自动置顶窗口
  python wechat-room.py scroll <dir> <times>       # dir: -1 下 / +1 上
  python wechat-room.py type <text>                # 写入剪贴板并 Ctrl+V 粘贴(支持中文)
  python wechat-room.py config org <value>         # 保存主办方
  python wechat-room.py config org                 # 读取主办方

说明：
  1. 必须 DPI-aware(设备缩放 1.5x)，否则坐标偏移。
  2. 截图用 Pillow ImageGrab 抓屏幕(先置顶窗口)，得到物理分辨率的窗口图像。
  3. 图像坐标 = 物理屏幕坐标 - 窗口物理原点(rect.Left/Top)，即 1:1 对应。
"""
import ctypes
import os
import sys
import time
import json

from ctypes import wintypes
from PIL import ImageGrab

# 强制 UTF-8 输出，避免 Windows 控制台(GBK)导致中文显示乱码
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

TITLE = "学生清华"
CONFIG_DIR = os.path.join(os.path.expanduser("~"), ".thu-sports-venue")
CONFIG_FILE = os.path.join(CONFIG_DIR, "wechat-room-config.json")

REF_W = 642    # 参考窗口物理宽度（DPI-aware 实测，190% 缩放时为本值）
REF_H = 1181   # 参考窗口物理高度


def _abs(rect, x, y):
    """把「相对参考尺寸(REF_W×REF_H)的图像坐标」换算成当前窗口的绝对屏幕坐标。
    每次都读实时 rect（位置+大小），再按当前尺寸/参考尺寸缩放 → 窗口在屏幕任何位置、
    大小任意变化、DPI 不同都能适配（假定小程序内容随窗口等比缩放）。"""
    w = (rect.Right - rect.Left) or REF_W
    h = (rect.Bottom - rect.Top) or REF_H
    sx = rect.Left + x * (w / REF_W)
    sy = rect.Top + y * (h / REF_H)
    return int(round(sx)), int(round(sy))


class RECT(ctypes.Structure):
    _fields_ = [("Left", ctypes.c_long), ("Top", ctypes.c_long),
                ("Right", ctypes.c_long), ("Bottom", ctypes.c_long)]


def set_dpi_aware():
    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass


def get_proc_name(pid):
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return ""
    buf = ctypes.create_unicode_buffer(1024)
    size = wintypes.DWORD(1024)
    ok = kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size))
    name = os.path.basename(buf.value) if ok else ""
    kernel32.CloseHandle(h)
    return name


def find_window():
    """返回第一个顶层可见窗口，标题==学生清华。返回 dict(hwnd, rect, pid)。"""
    found = {"hwnd": None, "rect": None, "pid": None}
    WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, ctypes.c_void_p)

    def cb(h, l):
        if not user32.IsWindowVisible(h):
            return True
        b = ctypes.create_unicode_buffer(256)
        user32.GetWindowTextW(h, b, 256)
        t = b.value
        if not t:
            return True
        p = wintypes.DWORD()
        user32.GetWindowThreadProcessId(h, ctypes.byref(p))
        # 标题匹配为第一优先；再放宽为 WeChatAppEx 进程 + 非空标题
        if t == TITLE:
            r = RECT()
            user32.GetWindowRect(h, ctypes.byref(r))
            found["hwnd"] = h
            found["rect"] = r
            found["pid"] = p.value
            return False
        return True

    user32.EnumWindows(WNDENUMPROC(cb), 0)
    return found


def bring_top(hwnd):
    HWND_TOPMOST = -1
    SWP_NOMOVE = 0x0002
    SWP_NOSIZE = 0x0001
    SWP_SHOWWINDOW = 0x0040
    user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)
    user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.4)


# ---------------- 输入事件 ----------------
class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", ctypes.c_long), ("dy", ctypes.c_long),
                ("mouseData", ctypes.c_ulong), ("dwFlags", ctypes.c_ulong),
                ("time", ctypes.c_ulong), ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", ctypes.c_ushort), ("wScan", ctypes.c_ushort),
                ("dwFlags", ctypes.c_ulong), ("time", ctypes.c_ulong),
                ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]


class INPUTUNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", ctypes.c_ulong), ("u", INPUTUNION)]


def _send_input(events):
    """events: list of (type, flags, extra)"""
    arr = (INPUT * len(events))()
    for i, (typ, flags, data) in enumerate(events):
        arr[i].type = typ
        if typ == 0:  # mouse
            arr[i].u.mi.dwFlags = flags
            arr[i].u.mi.mouseData = data & 0xFFFFFFFF
        else:  # keyboard
            arr[i].u.ki.dwFlags = flags
            arr[i].u.ki.wScan = data
    user32.SendInput(len(arr), arr, ctypes.sizeof(INPUT))


def mouse_click(x, y):
    user32.SetCursorPos(int(x), int(y))
    time.sleep(0.06)
    MOUSEEVENTF_LEFTDOWN = 0x0002
    MOUSEEVENTF_LEFTUP = 0x0004
    _send_input([(0, MOUSEEVENTF_LEFTDOWN, 0), (0, MOUSEEVENTF_LEFTUP, 0)])


def scroll_wheel(direction, times):
    delta = -120 if direction < 0 else 120
    MOUSEEVENTF_WHEEL = 0x0800
    for _ in range(times):
        _send_input([(0, MOUSEEVENTF_WHEEL, delta)])
        time.sleep(0.08)


def set_clipboard(text):
    CF_UNICODETEXT = 13
    GMEM_MOVEABLE = 0x0002
    # 修复：64 位下 HGLOBAL 是指针大小，必须设 restype，否则句柄被截断导致访问违例
    kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
    kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    kernel32.GlobalLock.restype = wintypes.LPVOID
    kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    user32.OpenClipboard.argtypes = [wintypes.HWND]
    user32.EmptyClipboard.argtypes = []
    user32.CloseClipboard.argtypes = []
    user32.OpenClipboard(0)
    user32.EmptyClipboard()
    data = (text + "\x00").encode("utf-16-le")
    hglb = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
    if not hglb:
        user32.CloseClipboard()
        raise OSError("GlobalAlloc failed")
    ptr = kernel32.GlobalLock(hglb)
    if not ptr:
        user32.CloseClipboard()
        raise OSError("GlobalLock failed")
    ctypes.memmove(ptr, data, len(data))
    kernel32.GlobalUnlock(hglb)
    user32.SetClipboardData(CF_UNICODETEXT, hglb)
    user32.CloseClipboard()


def paste_ctrl_v():
    VK_CONTROL = 0x11
    VK_V = 0x56
    KEYEVENTF_KEYUP = 0x0002
    # ctrl down, v down, v up, ctrl up
    _send_input([(1, 0, VK_CONTROL),
                 (1, 0, VK_V),
                 (1, KEYEVENTF_KEYUP, VK_V),
                 (1, KEYEVENTF_KEYUP, VK_CONTROL)])


def type_text(text):
    set_clipboard(text)
    time.sleep(0.1)
    paste_ctrl_v()


# ---------------- 配置 ----------------
def load_config():
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def save_config(cfg):
    os.makedirs(CONFIG_DIR, exist_ok=True)
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


# ---------------- 命令 ----------------
def cmd_locate():
    w = find_window()
    if not w["hwnd"]:
        print(json.dumps({"found": False, "error": "学生清华 窗口未找到（请先在微信打开小程序）"}))
        return 2
    r = w["rect"]
    print(json.dumps({
        "found": True, "pid": w["pid"], "hwnd": int(w["hwnd"]),
        "rect": [r.Left, r.Top, r.Right, r.Bottom],
        "size": [r.Right - r.Left, r.Bottom - r.Top],
    }, ensure_ascii=False))
    return 0


def cmd_capture(out):
    w = find_window()
    if not w["hwnd"]:
        print("学生清华 窗口未找到")
        return 2
    bring_top(w["hwnd"])
    time.sleep(0.2)
    r = w["rect"]
    bbox = (r.Left, r.Top, r.Right, r.Bottom)
    img = ImageGrab.grab(bbox=bbox)
    img.save(out)
    print(json.dumps({"saved": os.path.abspath(out), "size": list(img.size)},
                     ensure_ascii=False))
    return 0


def cmd_click(imgx, imgy):
    w = find_window()
    if not w["hwnd"]:
        print("学生清华 窗口未找到")
        return 2
    bring_top(w["hwnd"])
    r = w["rect"]
    sx, sy = _abs(r, imgx, imgy)   # 相对参考尺寸缩放，窗口移动/缩放/DPI 变化都适配
    mouse_click(sx, sy)
    print(json.dumps({"clicked": [sx, sy]}, ensure_ascii=False))
    return 0


def cmd_scroll(direction, times):
    w = find_window()
    if not w["hwnd"]:
        print("学生清华 窗口未找到")
        return 2
    bring_top(w["hwnd"])
    r = w["rect"]
    cx = r.Left + (r.Right - r.Left) // 2
    cy = r.Top + (r.Bottom - r.Top) // 2
    user32.SetCursorPos(cx, cy)
    time.sleep(0.1)
    scroll_wheel(direction, times)
    print(json.dumps({"scrolled": [direction, times]}, ensure_ascii=False))
    return 0


def cmd_type(text):
    w = find_window()
    if not w["hwnd"]:
        print("学生清华 窗口未找到")
        return 2
    bring_top(w["hwnd"])
    time.sleep(0.2)
    type_text(text)
    print(json.dumps({"typed": text}, ensure_ascii=False))
    return 0


def cmd_config(args):
    if len(args) >= 2 and args[0] == "org":
        cfg = load_config()
        if args[1] == "get":
            print(json.dumps({"org": cfg.get("org")}, ensure_ascii=False))
            return 0
        else:
            cfg["org"] = args[1]
            save_config(cfg)
            print(json.dumps({"org": cfg["org"], "saved": True}, ensure_ascii=False))
            return 0
    print("usage: wechat-room.py config org <value> | config org get")
    return 1


# ---------------- 快速 apply（活动室申请：导航到表单，交给用户填写） ----------------
# 目标：把窗口带到「活动室申请」表单(第①步 基本信息)，然后停下来让用户填。
# 查询(可约/占用)用 wechat-room-api.py（API 直连，快）；这里只负责「到表单」。
# 说明：agent 用视觉驱动导航到目标活动室的申请表单后，调用本命令确认并交接给用户。
APPLY_GOTO = (323, 1109)   # 「选择时间」按钮（第①步底部）


def _parse_kv(args):
    d = {}
    yes = False
    i = 0
    while i < len(args):
        a = args[i]
        if a.startswith("--") and i + 1 < len(args) and not args[i + 1].startswith("--"):
            d[a[2:]] = args[i + 1]
            i += 2
        elif a == "--yes":
            yes = True
            i += 1
        else:
            i += 1
    return d, yes


def cmd_fix_size():
    """把「学生清华」小程序窗口强制设为参考尺寸(REF_W×REF_H)，保证固定坐标稳定可用。"""
    w = find_window()
    if not w["hwnd"]:
        print(json.dumps({"ok": False, "error": "学生清华 窗口未找到"}, ensure_ascii=False))
        return 2
    bring_top(w["hwnd"])
    SWP_NOZORDER = 0x0004
    SWP_NOMOVE = 0x0002
    SWP_SHOWWINDOW = 0x0040
    r = w["rect"]
    user32.SetWindowPos(w["hwnd"], 0, 0, 0, REF_W, REF_H, SWP_NOZORDER | SWP_NOMOVE | SWP_SHOWWINDOW)
    time.sleep(0.4)
    w2 = find_window()
    r2 = w2["rect"]
    print(json.dumps({"ok": True, "old": [r.Right - r.Left, r.Bottom - r.Top],
                      "new": [r2.Right - r2.Left, r2.Bottom - r2.Top]}, ensure_ascii=False))
    return 0


def cmd_apply(args):
    kv, yes = _parse_kv(args)
    w = find_window()
    if not w["hwnd"]:
        print(json.dumps({"ok": False, "error": "学生清华 窗口未找到"}, ensure_ascii=False))
        return 2
    bring_top(w["hwnd"])
    time.sleep(0.3)
    # 只置顶 + 交接给用户，不做任何可能误触的点击（避免点到字段/按钮）。
    if yes:
        # 若确要往下走：点「选择时间」进第②步（需已填基本信息；由用户确认）。
        r = w["rect"]
        sx, sy = _abs(r, APPLY_GOTO[0], APPLY_GOTO[1])
        mouse_click(sx, sy)
        time.sleep(0.3)
    print(json.dumps({
        "ok": True,
        "step": "已到达活动室申请表单（第①步 基本信息）",
        "handoff": "请用户填写：【主办方】【活动主题】【参与人数】【活动类型】【活动内容】，再点「选择时间」选日期/起止，最后提交。",
        "query_hint": "可先 wechat-room-api.py list 查房间，recommend 推荐，avail 查可约时段，occupancy <房间> 查占用。",
        "submitted": bool(yes),
    }, ensure_ascii=False))
    return 0


def main():
    set_dpi_aware()
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 0
    cmd = args[0]
    if cmd == "locate":
        return cmd_locate()
    if cmd == "fix-size":
        return cmd_fix_size()
    if cmd == "capture":
        out = args[1] if len(args) > 1 else "mini.png"
        return cmd_capture(out)
    if cmd == "click":
        return cmd_click(float(args[1]), float(args[2]))
    if cmd == "scroll":
        return cmd_scroll(int(args[1]), int(args[2]))
    if cmd == "type":
        return cmd_type(args[1])
    if cmd == "apply":
        return cmd_apply(args[1:])
    if cmd == "config":
        return cmd_config(args[1:])
    print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(main())
