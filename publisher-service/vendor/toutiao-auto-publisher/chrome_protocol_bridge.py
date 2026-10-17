#!/usr/bin/env python3
"""Submit Toutiao protocol requests through a normal Chrome security runtime."""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Mapping

import websocket


class ChromeProtocolError(RuntimeError):
    pass


class _CdpConnection:
    def __init__(self, websocket_url: str, timeout: float) -> None:
        self.socket = websocket.create_connection(
            websocket_url,
            timeout=timeout,
            suppress_origin=True,
        )
        self.next_id = 1

    def close(self) -> None:
        try:
            self.socket.close()
        except Exception:
            pass

    def call(self, method: str, params: Mapping[str, Any] | None = None) -> dict[str, Any]:
        request_id = self.next_id
        self.next_id += 1
        self.socket.send(
            json.dumps(
                {"id": request_id, "method": method, "params": dict(params or {})},
                ensure_ascii=False,
            )
        )
        while True:
            message = json.loads(self.socket.recv())
            if message.get("id") != request_id:
                continue
            if "error" in message:
                raise ChromeProtocolError(f"CDP {method}: {message['error']}")
            result = message.get("result", {})
            return result if isinstance(result, dict) else {}

    def evaluate(self, expression: str) -> Any:
        result = self.call(
            "Runtime.evaluate",
            {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": True,
            },
        )
        if result.get("exceptionDetails"):
            details = result["exceptionDetails"]
            exception = details.get("exception", {}) if isinstance(details, dict) else {}
            description = exception.get("description") if isinstance(exception, dict) else ""
            raise ChromeProtocolError(str(description or "Chrome Runtime.evaluate 执行失败"))
        value = result.get("result", {})
        if isinstance(value, dict) and value.get("subtype") == "error":
            raise ChromeProtocolError(str(value.get("description") or "Chrome 页面脚本执行失败"))
        return value.get("value") if isinstance(value, dict) else None


class ChromeProtocolBridge:
    """Use page fetch so Toutiao's loaded SDK can attach dynamic request security data."""

    _publish_lock = threading.Lock()

    def __init__(self, config: dict[str, Any], config_dir: Path) -> None:
        self.config_dir = config_dir
        self.toutiao = config.get("toutiao", {})
        self.base_url = str(self.toutiao.get("base_url", "https://mp.toutiao.com")).rstrip("/")
        self.editor_url = str(
            self.toutiao.get(
                "chrome_editor_url",
                f"{self.base_url}/profile_v4/graphic/publish",
            )
        )
        self.debug_url = str(
            self.toutiao.get("chrome_debug_url")
            or os.getenv("TOUTIAO_CHROME_DEBUG_URL", "")
        ).rstrip("/")
        self.startup_timeout = float(self.toutiao.get("chrome_startup_timeout_seconds", 20))
        self.page_timeout = float(self.toutiao.get("chrome_page_timeout_seconds", 45))
        self.security_wait = float(self.toutiao.get("chrome_security_wait_seconds", 12))
        self.request_timeout = float(self.toutiao.get("chrome_request_timeout_seconds", 60))
        profile_value = str(
            self.toutiao.get("chrome_profile_root", "./state/chrome-protocol-profiles")
        )
        profile_root = Path(profile_value).expanduser()
        self.profile_root = (
            profile_root if profile_root.is_absolute() else (config_dir / profile_root).resolve()
        )

    def publish(
        self,
        path: str,
        params: Mapping[str, Any],
        body: str,
        cookies: Mapping[str, str],
    ) -> dict[str, Any]:
        with self._publish_lock:
            return self._publish_locked(
                path,
                params,
                body,
                cookies,
                content_type="application/x-www-form-urlencoded;charset=UTF-8",
            )

    def post_json(
        self,
        path: str,
        payload: Mapping[str, Any],
        cookies: Mapping[str, str],
        *,
        editor_url: str | None = None,
    ) -> dict[str, Any]:
        """POST JSON after the Creator Center runtime has attached dynamic security headers."""
        with self._publish_lock:
            return self._publish_locked(
                path,
                {},
                json.dumps(dict(payload), ensure_ascii=False, separators=(",", ":")),
                cookies,
                content_type="application/json;charset=UTF-8",
                editor_url=editor_url,
            )

    def _publish_locked(
        self,
        path: str,
        params: Mapping[str, Any],
        body: str,
        cookies: Mapping[str, str],
        *,
        content_type: str,
        editor_url: str | None = None,
    ) -> dict[str, Any]:
        process: subprocess.Popen[bytes] | None = None
        profile_dir: Path | None = None
        owns_browser = not bool(self.debug_url)
        debug_url = self.debug_url
        target_id = ""
        cdp: _CdpConnection | None = None
        try:
            if owns_browser:
                process, profile_dir, debug_url = self._launch_browser()
            target_id, websocket_url = self._create_target(debug_url)
            cdp = _CdpConnection(websocket_url, max(self.page_timeout, self.request_timeout) + 10)
            cdp.call("Network.enable")
            cdp.call("Page.enable")
            cdp.call("Network.clearBrowserCookies")
            cookie_params = [
                {
                    "name": str(name),
                    "value": str(value),
                    "url": f"{self.base_url}/",
                    "secure": True,
                }
                for name, value in cookies.items()
                if str(name)
            ]
            if not cookie_params:
                raise ChromeProtocolError("Chrome 协议桥接缺少登录 Cookie")
            cdp.call("Network.setCookies", {"cookies": cookie_params})
            navigation = cdp.call("Page.navigate", {"url": editor_url or self.editor_url})
            if navigation.get("errorText"):
                raise ChromeProtocolError(f"Chrome 打开发布页失败：{navigation['errorText']}")
            self._wait_for_editor(cdp)

            query = urllib.parse.urlencode(
                {str(key): str(value) for key, value in params.items()}
            )
            request_url = f"{path}?{query}" if query else path
            timeout_ms = max(1, int(self.request_timeout * 1000))
            use_platform_network = content_type.startswith("application/json")
            script = f"""
            (async () => {{
              const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), {timeout_ms});
              try {{
                if ({json.dumps(use_platform_network)}) {{
                  await fetch('/xigua/api/upload/GetPublishAuth', {{
                    method: 'GET', credentials: 'include'
                  }});
                  const csrfPair = document.cookie.split(';').map(v => v.trim())
                    .find(v => v.startsWith('xigua_csrf_token='));
                  const csrf = csrfPair ? csrfPair.slice(csrfPair.indexOf('=') + 1) : '';
                  if (!csrf) throw new Error('xigua_csrf_token is not ready');
                  const response = await fetch({json.dumps(request_url, ensure_ascii=False)}, {{
                    method: 'POST',
                    credentials: 'include',
                    headers: {{
                      'Accept': 'application/json, text/plain, */*',
                      'Content-Type': 'application/json',
                      'x-csrf-token': csrf
                    }},
                    body: {json.dumps(body, ensure_ascii=False)},
                    signal: controller.signal
                  }});
                  return {{ok: response.ok, status: response.status, body: await response.text()}};
                }}
                const response = await fetch({json.dumps(request_url, ensure_ascii=False)}, {{
                  method: 'POST',
                  credentials: 'include',
                  headers: {{
                    'Accept': 'application/json, text/plain, */*',
                    'Content-Type': {json.dumps(content_type)}
                  }},
                  body: {json.dumps(body, ensure_ascii=False)},
                  signal: controller.signal
                }});
                return {{ok: response.ok, status: response.status, body: await response.text()}};
              }} catch (error) {{
                return {{
                  ok: false,
                  status: Number(error?.response?.status || 0),
                  error: String(error),
                  body: JSON.stringify(error?.response?.data || null)
                }};
              }} finally {{
                clearTimeout(timeoutId);
              }}
            }})()
            """
            result = cdp.evaluate(script)
            if not isinstance(result, dict):
                raise ChromeProtocolError("Chrome 发布请求未返回结果")
            if result.get("error") and result.get("body"):
                raise ChromeProtocolError(
                    f"Chrome JSON request failed: {result['error']} {str(result['body'])[:500]}"
                )
            if result.get("error"):
                raise ChromeProtocolError(f"Chrome 发布请求失败：{result['error']}")
            status = int(result.get("status") or 0)
            response_text = str(result.get("body") or "")
            if status >= 400 or status == 0:
                raise ChromeProtocolError(
                    f"Chrome 发布请求返回 HTTP {status}：{response_text[:300]}"
                )
            try:
                payload = json.loads(response_text)
            except json.JSONDecodeError as exc:
                raise ChromeProtocolError(
                    f"Chrome 发布响应不是 JSON：{response_text[:300]}"
                ) from exc
            if not isinstance(payload, dict):
                raise ChromeProtocolError("Chrome 发布响应 JSON 不是对象")
            return payload
        except ChromeProtocolError:
            raise
        except Exception as exc:
            raise ChromeProtocolError(
                f"Chrome 协议桥接失败：{type(exc).__name__}: {exc}"
            ) from exc
        finally:
            if cdp is not None:
                cdp.close()
            if target_id:
                self._close_target(debug_url, target_id)
            if owns_browser:
                self._close_browser(debug_url, process)
                self._remove_profile(profile_dir)

    def _wait_for_editor(self, cdp: _CdpConnection) -> None:
        deadline = time.monotonic() + self.page_timeout
        page_state: dict[str, Any] = {}
        while time.monotonic() < deadline:
            value = cdp.evaluate(
                "({ready: document.readyState, url: location.href, host: location.host})"
            )
            if isinstance(value, dict):
                page_state = value
                if value.get("ready") == "complete" and value.get("host") == "mp.toutiao.com":
                    break
            time.sleep(0.4)
        else:
            raise ChromeProtocolError(f"Chrome 发布页加载超时：{page_state}")
        if "/auth/page/login" in str(page_state.get("url") or ""):
            raise ChromeProtocolError("Chrome 发布页登录状态失效")
        time.sleep(max(0, self.security_wait))

    def _launch_browser(self) -> tuple[subprocess.Popen[bytes], Path, str]:
        executable = self._find_chrome()
        self.profile_root.mkdir(parents=True, exist_ok=True)
        profile_dir = Path(tempfile.mkdtemp(prefix="run-", dir=self.profile_root))
        port = self._free_port()
        command = [
            str(executable),
            f"--remote-debugging-port={port}",
            f"--user-data-dir={profile_dir}",
            "--window-position=-32000,-32000",
            "--window-size=1280,900",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "about:blank",
        ]
        if os.name != "nt":
            command.insert(-1, "--headless=new")
        try:
            process = subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except Exception:
            self._remove_profile(profile_dir)
            raise
        debug_url = f"http://127.0.0.1:{port}"
        try:
            self._wait_for_debug_endpoint(debug_url, process)
        except Exception:
            self._close_browser(debug_url, process)
            self._remove_profile(profile_dir)
            raise
        return process, profile_dir, debug_url

    def _find_chrome(self) -> Path:
        configured = str(
            self.toutiao.get("chrome_executable") or os.getenv("CHROME_PATH", "")
        ).strip()
        candidates: list[Path] = []
        if configured:
            lowered = configured.lower()
            is_windows_path = (
                ":\\" in configured
                or configured.startswith("C:/")
                or configured.startswith("C:\\")
                or lowered.endswith(".exe")
            )
            if not (os.name != "nt" and is_windows_path):
                path = Path(configured).expanduser()
                candidates.append(path if path.is_absolute() else (self.config_dir / path).resolve())
        if os.name == "nt":
            for variable in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
                base = os.getenv(variable)
                if base:
                    candidates.append(Path(base) / "Google" / "Chrome" / "Application" / "chrome.exe")
        else:
            candidates.extend(
                [
                    Path("/usr/bin/google-chrome-stable"),
                    Path("/usr/bin/google-chrome"),
                    Path("/opt/google/chrome/chrome"),
                    Path("/opt/google/chrome/google-chrome"),
                    Path("/usr/bin/chromium-browser"),
                    Path("/usr/bin/chromium"),
                    Path("/snap/bin/chromium"),
                ]
            )
        for candidate in candidates:
            try:
                if candidate.is_file():
                    return candidate
            except OSError:
                continue
        for name in (
            "google-chrome-stable",
            "google-chrome",
            "chromium-browser",
            "chromium",
            "chrome.exe",
        ):
            resolved = shutil.which(name)
            if resolved:
                return Path(resolved)
        raise ChromeProtocolError("未找到 Google Chrome，请配置 toutiao.chrome_executable")

    @staticmethod
    def _free_port() -> int:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            return int(sock.getsockname()[1])

    def _wait_for_debug_endpoint(
        self,
        debug_url: str,
        process: subprocess.Popen[bytes],
    ) -> None:
        deadline = time.monotonic() + self.startup_timeout
        last_error = ""
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise ChromeProtocolError(f"Chrome 启动后提前退出：{process.returncode}")
            try:
                self._read_json(f"{debug_url}/json/version", timeout=1)
                return
            except Exception as exc:
                last_error = f"{type(exc).__name__}: {exc}"
                time.sleep(0.2)
        raise ChromeProtocolError(f"Chrome 调试端口启动超时：{last_error}")

    def _create_target(self, debug_url: str) -> tuple[str, str]:
        encoded = urllib.parse.quote("about:blank", safe="")
        request = urllib.request.Request(f"{debug_url}/json/new?{encoded}", method="PUT")
        with urllib.request.urlopen(request, timeout=10) as response:
            payload = json.load(response)
        target_id = str(payload.get("id") or "")
        websocket_url = str(payload.get("webSocketDebuggerUrl") or "")
        if not target_id or not websocket_url:
            raise ChromeProtocolError("Chrome 创建调试页面失败")
        return target_id, websocket_url

    @staticmethod
    def _read_json(url: str, timeout: float) -> dict[str, Any]:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            payload = json.load(response)
        return payload if isinstance(payload, dict) else {}

    @staticmethod
    def _close_target(debug_url: str, target_id: str) -> None:
        try:
            urllib.request.urlopen(f"{debug_url}/json/close/{target_id}", timeout=2).close()
        except Exception:
            pass

    def _close_browser(
        self,
        debug_url: str,
        process: subprocess.Popen[bytes] | None,
    ) -> None:
        if process is None:
            return
        if process.poll() is None:
            try:
                version = self._read_json(f"{debug_url}/json/version", timeout=2)
                websocket_url = str(version.get("webSocketDebuggerUrl") or "")
                if websocket_url:
                    browser = _CdpConnection(websocket_url, 3)
                    try:
                        browser.call("Browser.close")
                    finally:
                        browser.close()
            except Exception:
                pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)

    @staticmethod
    def _remove_profile(profile_dir: Path | None) -> None:
        if profile_dir is None or not profile_dir.exists():
            return
        for _ in range(5):
            try:
                shutil.rmtree(profile_dir)
                return
            except OSError:
                time.sleep(0.3)
