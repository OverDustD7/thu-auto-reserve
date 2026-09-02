#!/usr/bin/env python3
"""本 skill 共用的「会话文件加密」助手（AES-256-GCM）。

- 密钥由 hostname+用户名 派生（sha256→32字节）。跨机/跨用户解不开，防「拷走文件/备份/云同步」。
- 依赖：cryptography 必装；缺失时首次使用自动 `pip install cryptography`，装不上则 encrypt/decrypt 抛错（拒绝明文保存登录态）。
- 只做「静止加密」，不保护使用中明文，也不覆盖浏览器 profile。
"""
import os
import json
import hashlib
import base64
import socket
import getpass
import sys
import subprocess

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except Exception:
    AESGCM = None


def _ensure_crypto():
    """确保 cryptography 可用：缺失时自动 pip 安装一次；成功 True、失败 False。"""
    global AESGCM
    if AESGCM is not None:
        return True
    try:
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "cryptography"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM as _A
        AESGCM = _A
        return True
    except Exception:
        return False


def _key():
    seed = (socket.gethostname() or 'thu') + '|' + (getpass.getuser() or '') + '|thu-auto-reserve'
    return hashlib.sha256(seed.encode('utf-8')).digest()  # 32 bytes


def encrypt(plain):
    """加密字符串 → JSON 密文串；cryptography 缺失且自动安装失败则抛错（拒绝明文保存）。"""
    if not _ensure_crypto():
        raise RuntimeError("会话加密依赖 cryptography 未安装且自动安装失败；请手动 `pip install cryptography` 后重试（拒绝以明文保存登录态）。")
    key = _key()
    nonce = os.urandom(12)
    ct = AESGCM(key).encrypt(nonce, str(plain).encode('utf-8'), None)
    return json.dumps({
        "v": 1, "alg": "aes-256-gcm",
        "iv": base64.b64encode(nonce).decode('ascii'),
        "ct": base64.b64encode(ct).decode('ascii'),
    })


def decrypt(blob):
    """解密；非本模块密文（旧明文）原样返回；密文但 cryptography 缺失时返回 None（按无登录态处理）。"""
    if isinstance(blob, str) and blob.startswith("{"):
        try:
            o = json.loads(blob)
            if isinstance(o, dict) and o.get("v") == 1 and o.get("ct"):
                if not _ensure_crypto():
                    return None
                key = _key()
                nonce = base64.b64decode(o["iv"])
                ct = base64.b64decode(o["ct"])
                return AESGCM(key).decrypt(nonce, ct, None).decode('utf-8')
        except Exception:
            pass
    return blob


def expired_at(ms):
    """自最后使用/保存起保留 7 天（约等于后端 jwt 有效期），避免频繁重新登录。"""
    import datetime as dt
    d = dt.datetime.fromtimestamp(ms / 1000.0)
    return d + dt.timedelta(days=7)


def is_expired(ts, now=None):
    """ts：最后使用/保存时间（秒或毫秒）；是否已过期（保留约 7 天后）。"""
    if not ts:
        return False
    import time
    ms = ts * 1000 if ts < 1e12 else ts   # 兼容秒/毫秒
    if now is None:
        now = time.time() * 1000
    return now > expired_at(ms).timestamp() * 1000
