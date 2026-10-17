"""异常类型与网关错误码消费逻辑。

对应 bundle 里的 ``errCodeConsume``（``index.31d9f171.js`` 模块 ``71948``）与
错误码枚举（``404.b0af01fb.js`` 模块 ``24484``，chunk-common 模块 ``44162``）。
"""

from __future__ import annotations

from .constants import ErrCode

#: 300330 ~ 300350 一律视为"登录态失效"，需要重新扫码
LOGIN_EXPIRED_MIN = 300330
LOGIN_EXPIRED_MAX = 300350

#: 各错误码的中文提示。``71948.errCodeConsume`` 只显式区分 300334，
#: 其余文案取自模块 ``44162`` 的映射表与页面 ``$b()`` 提示。
ERR_MSG: dict[int, str] = {
    0: "成功",
    ErrCode.NoUserFound: "未找到该用户",
    ErrCode.MinNeedLogin: "登录态失效，请重新登录",
    ErrCode.OtherDeviceLogin: "账号已在其他设备登录",
    ErrCode.MaxNeedLogin: "登录态失效，请重新登录",
    300501: "短信验证码错误",
    300504: "参数错误",
    300505: "文件大小不符合要求",
    300506: "文件数量超出限制",
    300101: "名称不符合规范",
    300102: "名称不符合规范",
    300103: "名称不符合规范",
    300104: "名称不符合规范",
    300105: "名称不符合规范",
    300106: "名称不符合规范",
    300118: "请求过于频繁，请稍后再试",
}


class ChannelsError(Exception):
    """本库所有异常的基类。"""


class NetworkError(ChannelsError):
    """HTTP 层失败（连接、超时、非 2xx）。"""


class LogicError(ChannelsError):
    """业务逻辑错误，对应 bundle 里的 ``LogicError``（模块 ``83f3``）。

    ``kind`` 与前端一致，便于按类别分支处理（``upload`` / ``post`` / ...）。
    """

    def __init__(self, message: str, kind: str = "") -> None:
        super().__init__(message)
        self.kind = kind


class ApiError(ChannelsError):
    """网关返回 ``errCode != 0``。"""

    def __init__(
        self,
        err_code: int,
        err_msg: str = "",
        *,
        path: str = "",
        payload: object = None,
    ) -> None:
        self.err_code = err_code
        self.err_msg = err_msg or ERR_MSG.get(err_code, "请求失败")
        self.path = path
        self.payload = payload
        super().__init__(f"[{err_code}] {self.err_msg}" + (f" ({path})" if path else ""))

    @property
    def need_login(self) -> bool:
        return is_login_expired(self.err_code)


class NotLoggedInError(ApiError):
    """缺少 ``sessionid`` cookie，网关会直接回 ``300330``。

    前端此时会跳 ``https://channels.weixin.qq.com/login.html``；本库不发请求，
    直接抛这个异常（消息里带上 ``sessionid`` 方便排查）。
    """

    def __init__(self, path: str = "", payload: object = None) -> None:
        super().__init__(
            ErrCode.MinNeedLogin, "登录态失效，请重新登录", path=path, payload=payload
        )
        self.args = (f"{self.args[0]}：缺少 sessionid cookie（请先扫码登录或更新 cookies.json）",)


class UploadError(ChannelsError):
    """CDN / DFS 上传失败。

    :param status_code: 触发失败的 HTTP 状态码（有的话）
    :param err_no: DFS 响应体里的 ``X-Errno``（有的话）

    这两个字段是给 :meth:`DfsUploader._is_single_upload_unsupported` 用的：
    靠 ``str(exc)`` 里搜子串判断"端点不可用"太脆（消息里永远带着 ``X-Errno=``，
    等于只在搜 ``404``），所以改成结构化传递。
    """

    def __init__(
        self,
        message: str = "",
        *,
        status_code: int | None = None,
        err_no: int | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.err_no = err_no


def is_login_expired(err_code: int) -> bool:
    """模块 ``71948`` 的 ``MV``：``e >= 300330 && e < 300350``。"""
    return LOGIN_EXPIRED_MIN <= err_code < LOGIN_EXPIRED_MAX


def message_for(err_code: int, err_msg: str = "") -> str:
    if err_msg:
        return err_msg
    return ERR_MSG.get(err_code, "请求失败")
