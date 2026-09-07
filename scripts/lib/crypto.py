"""Current-user Windows DPAPI; no auto-install or legacy plaintext fallback."""
import base64
import ctypes
import json
import math
import os
import time
from ctypes import wintypes
TTL = 7 * 86400000

def _dpapi(data, decrypting=False):
    if os.name != 'nt':
        raise RuntimeError('本版本会话持久化需要 Windows DPAPI')
    class Blob(ctypes.Structure):
        _fields_ = [('size',wintypes.DWORD),('data',ctypes.POINTER(ctypes.c_ubyte))]
    buf = ctypes.create_string_buffer(data)
    source = Blob(len(data),ctypes.cast(buf,ctypes.POINTER(ctypes.c_ubyte)))
    target = Blob()
    api = ctypes.WinDLL('crypt32',use_last_error=True)
    kernel = ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    fn = api.CryptUnprotectData if decrypting else api.CryptProtectData
    fn.argtypes = [ctypes.POINTER(Blob),ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,wintypes.DWORD,ctypes.POINTER(Blob)]
    fn.restype = wintypes.BOOL
    if not fn(ctypes.byref(source),None,None,None,None,1,ctypes.byref(target)):
        raise RuntimeError('系统会话保护失败，请重新登录或检查当前用户权限')
    try:
        return ctypes.string_at(target.data,target.size)
    finally:
        kernel.LocalFree(target.data)

def encrypt(plain):
    return json.dumps({'v':2,'alg':'windows-dpapi','ct':base64.b64encode(_dpapi(str(plain).encode())).decode()})

def decrypt(blob):
    o = json.loads(blob)
    if not isinstance(o,dict) or o.get('v') != 2 or o.get('alg') != 'windows-dpapi':
        raise ValueError('旧格式会话已停用，请重新登录')
    return _dpapi(base64.b64decode(o['ct'],validate=True),True).decode()

def expired_at(ms):
    import datetime as dt
    return dt.datetime.fromtimestamp((ms+TTL)/1000,dt.timezone.utc)

def is_expired(ts,now=None):
    if not isinstance(ts,(int,float)) or not math.isfinite(ts) or ts <= 0:
        return True
    ms = ts*1000 if ts < 1e12 else ts
    now = time.time()*1000 if now is None else now
    return ms > now or now >= ms+TTL
