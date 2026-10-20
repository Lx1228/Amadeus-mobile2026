#!/usr/bin/env python3
"""Amadeus Mobile 本地开发服务器：强制 no-cache，避免浏览器缓存旧文件。
用法: python serve.py [端口]   (默认 8931，服务 www 目录)
带调试代理：POST /proxy 转发到 X-Target-Url（模拟原生无 CORS 环境，供浏览器预览调试 DashScope TTS）
           GET  /proxy/audio?url=... 下载音频转 base64（同目的）
v2 (2026-08-14)：禁用系统代理（防 urllib 走翻墙代理被 DashScope 识别为国际站 → FreeTierOnly）；
                 加完整请求/响应日志（URL、Authorization 掩码、错误体原样输出）；补 do_OPTIONS。
"""
import http.server
import socketserver
import sys
import os
import json
import base64
import urllib.request
import urllib.error
from urllib.parse import urlparse, parse_qs

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8931
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "www")
os.chdir(ROOT)

# 禁用系统代理：urllib 默认读 http_proxy/https_proxy/系统代理。
# 若电脑挂了翻墙工具，DashScope 请求会被路由到海外出口 IP →
# 百炼把调用识别为"国际站用户"，走独立配额池（该 Key 无额度）→ 报 AllocationQuota.FreeTierOnly。
# 桌面端 Node fetch 不走系统代理所以正常。这里强制直连国内站。
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _mask_key(auth: str) -> str:
    """Authorization 掩码：只显示 Bearer + 前3位 + 后4位，避免日志泄露完整 Key。"""
    if not auth:
        return "(无)"
    key = auth[7:] if auth.lower().startswith("bearer ") else auth
    if len(key) <= 8:
        return "(Key过短:{}字)".format(len(key))
    return "Bearer {}{}...{}".format(key[:3], "*" * (len(key) - 7), key[-4:])


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # 开发阶段：禁用缓存，保证每次刷新都是最新代码
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def _send_json(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/proxy":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            target = self.headers.get("X-Target-Url", "")
            if not target:
                self._send_json(400, {"error": "缺少 X-Target-Url"})
                return
            auth = self.headers.get("Authorization", "")
            print(f"[proxy] POST -> {target}")
            print(f"[proxy]   Authorization: {_mask_key(auth)}")
            try:
                j = json.loads(body)
                print(f"[proxy]   body 摘要: model={j.get('model')}, input keys={list((j.get('input') or {}).keys())}")
            except Exception:
                print(f"[proxy]   body 摘要: (非JSON, {len(body)} bytes)")
            req = urllib.request.Request(target, data=body, method="POST")
            req.add_header("Content-Type", "application/json")
            if auth:
                req.add_header("Authorization", auth)
            # 补全常见请求头，避免 DashScope 把代理转发识别成"非正常调用"（桌面端 Node fetch 会带完整头）
            req.add_header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
            req.add_header("Accept", "*/*")
            req.add_header("Accept-Language", "zh-CN,zh;q=0.9")
            # 关键：用禁用系统代理的 opener 直连目标，避免翻墙工具劫持 → 国际站配额判定
            resp = _OPENER.open(req, timeout=90)
            data = resp.read()
            print(f"[proxy] 响应 {resp.status}, {len(data)} bytes, Content-Type={resp.headers.get('Content-Type')}")
            self.send_response(resp.status)
            self.send_header("Content-Type", resp.headers.get("Content-Type", "application/json"))
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            if resp.status >= 400:
                try:
                    err = json.loads(data)
                    print(f"[proxy] 错误体原样: {json.dumps(err, ensure_ascii=False)[:1200]}")
                except Exception:
                    print(f"[proxy] 错误体(非JSON): {data[:800]}")
        except urllib.error.HTTPError as e:
            data = e.read()
            print(f"[proxy] HTTPError {e.code}（目标可能拒绝）: {data[:800]}")
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            print(f"[proxy] 异常: {e!r}")
            self._send_json(500, {"error": str(e)})

    def do_OPTIONS(self):
        # 浏览器 preflight：允许自定义头（Authorization / X-Target-Url / Content-Type）
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Target-Url")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/proxy/audio"):
            try:
                qs = parse_qs(urlparse(self.path).query)
                url = qs.get("url", [""])[0]
                if not url:
                    self._send_json(400, {"error": "缺少 url"})
                    return
                print(f"[proxy/audio] GET {url[:120]}")
                resp = _OPENER.open(url, timeout=90)
                data = resp.read()
                print(f"[proxy/audio] 下载成功 {len(data)} bytes")
                self._send_json(200, {"base64": base64.b64encode(data).decode("ascii")})
            except urllib.error.HTTPError as e:
                print(f"[proxy/audio] HTTPError {e.code}: {e.read()[:300]}")
                self._send_json(500, {"error": f"下载失败 HTTP {e.code}"})
            except Exception as e:
                print(f"[proxy/audio] 异常: {e!r}")
                self._send_json(500, {"error": str(e)})
            return
        super().do_GET()

    def log_message(self, fmt, *args):
        sys.stdout.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


if __name__ == "__main__":
    # 绑定 0.0.0.0：允许同一 WiFi 下的手机通过局域网 IP 访问（电脑本机 127.0.0.1 照常可用）
    print(f"Amadeus Mobile dev server: http://127.0.0.1:{PORT}  (no-cache, 含 /proxy 调试代理)")
    print(f"局域网访问: http://<本机IP>:{PORT}  (手机需与电脑同一 WiFi)")
    with ThreadingServer(("0.0.0.0", PORT), NoCacheHandler) as httpd:
        httpd.serve_forever()
