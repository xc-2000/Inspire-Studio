package creator

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// secsdk 的 CSRF 机制（版本 1.2.22）：
//
// 站点并不使用 cookie 里的 csrf_token，而是由 secsdk 向服务端「换取」一次性 token：
//
//	HEAD <同源路径>
//	x-secsdk-csrf-request: 1
//	x-secsdk-csrf-version: 1.2.22
//
// 服务端在响应头 x-ware-csrf-token 返回 "statusCode,token,maxAge,message,sessionId"，
// 取其中的第 2 段（下标 1）作为 x-secsdk-csrf-token 发到后续请求上。
//
// 这一段完全可以用纯 Go 实现——它只是普通的 HEAD 请求，不涉及 a_bogus 签名。
const (
	// SecsdkVersion 是 secsdk 的版本号，必须与服务端期望的一致。
	SecsdkVersion = "1.2.22"
	// HeaderSecsdkCSRF 是携带 token 的请求头名。
	HeaderSecsdkCSRF = "x-secsdk-csrf-token"
	// headerSecsdkCSRFRequest 是换取 token 时使用的请求头名。
	headerSecsdkCSRFRequest = "x-secsdk-csrf-request"
	// headerSecsdkCSRFVersion 是换取 token 时声明版本的请求头名。
	headerSecsdkCSRFVersion = "x-secsdk-csrf-version"
	// headerWareCSRFToken 是服务端返回 token 的响应头名。
	headerWareCSRFToken = "x-ware-csrf-token"
)

// csrfExchangePath 是换取 CSRF token 时使用的路径。
//
// token 是「按 host 维度」下发并缓存的（secsdk 内部用 tokenMap[host] 存一份），
// 因此换哪个路径并不会影响 token 的适用性——它对本 host 的所有受保护接口都有效。
//
// 这里刻意固定用一个「确定支持 HEAD 且不校验登录态」的路径：
// 不是所有接口都接受 HEAD 方法（例如 /aweme/v1/creator/user/info/ 会对 HEAD 返回 403），
// 若照搬请求自身的路径，会在那些接口上误判成「换取失败」。
const csrfExchangePath = "/web/api/media/upload/auth/v5/"

// csrfToken 是一个带过期时间的 CSRF token。
type csrfToken struct {
	value     string
	expiredAt time.Time
}

// csrfProvider 负责换取并缓存 secsdk CSRF token。
//
// 缓存是必要的：token 有效期默认 24 小时，且按 host 复用。
type csrfProvider struct {
	mu    sync.Mutex
	token csrfToken
	valid bool

	fetch func(ctx context.Context, tokenPath string) (string, time.Duration, error)
}

func newCSRFProvider(fetch func(ctx context.Context, tokenPath string) (string, time.Duration, error)) *csrfProvider {
	return &csrfProvider{fetch: fetch}
}

// Token 返回可用的 token，必要时会发起换取请求。
//
// tokenPath 仅用于日志与诊断，实际换取路径固定为 csrfExchangePath。
func (p *csrfProvider) Token(ctx context.Context, tokenPath string) (string, error) {
	p.mu.Lock()
	if p.valid && time.Now().Before(p.token.expiredAt) {
		v := p.token.value
		p.mu.Unlock()
		return v, nil
	}
	p.mu.Unlock()

	// 不在锁内发起网络请求，避免把并发调用串成一条串行队列。
	value, maxAge, err := p.fetch(ctx, csrfExchangePath)
	if err != nil {
		return "", err
	}
	if maxAge <= 0 {
		maxAge = 24 * time.Hour
	}
	// 留 5 分钟余量，避免边界过期。
	ttl := maxAge - 5*time.Minute
	if ttl <= 0 {
		ttl = maxAge / 2
	}

	p.mu.Lock()
	p.token = csrfToken{value: value, expiredAt: time.Now().Add(ttl)}
	p.valid = true
	p.mu.Unlock()
	return value, nil
}

// Invalidate 丢弃当前缓存的 token，下次调用会重新换取。
func (p *csrfProvider) Invalidate() {
	p.mu.Lock()
	p.valid = false
	p.mu.Unlock()
}

// fetchSecsdkCSRF 向服务端换取一个新的 CSRF token。
//
// 实现严格对齐 secsdk 的 fetchTokenFromServer：HEAD 请求、原生方法、
// withCredentials（等价于带上 Cookie）、超时 10 秒。
func (c *Client) fetchSecsdkCSRF(ctx context.Context, tokenPath string) (string, time.Duration, error) {
	timeout := 10 * time.Second
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodHead, Origin+tokenPath, nil)
	if err != nil {
		return "", 0, fmt.Errorf("构造 CSRF 换取请求失败: %w", err)
	}
	req.Header.Set("User-Agent", c.cfg.UserAgent)
	req.Header.Set("Referer", Origin+"/creator-micro/content/upload")
	req.Header.Set("Origin", Origin)
	req.Header.Set("Accept", "*/*")
	req.Header.Set("Cookie", c.cfg.Cookies.Header())
	req.Header.Set(headerSecsdkCSRFRequest, "1")
	req.Header.Set(headerSecsdkCSRFVersion, SecsdkVersion)

	resp, err := c.http.Do(req)
	if err != nil {
		return "", 0, fmt.Errorf("换取 CSRF token 失败: %w", err)
	}
	defer resp.Body.Close()

	raw := resp.Header.Get(headerWareCSRFToken)
	if raw == "" {
		return "", 0, fmt.Errorf("换取 CSRF token 失败：响应头 %s 为空（HTTP %d）", headerWareCSRFToken, resp.StatusCode)
	}

	// 形如 statusCode,token,maxAge,message,sessionId
	parts := strings.Split(raw, ",")
	if len(parts) < 2 {
		return "", 0, fmt.Errorf("换取 CSRF token 失败：%s 格式异常: %q", headerWareCSRFToken, raw)
	}
	if strings.TrimSpace(parts[0]) != "0" {
		msg := ""
		if len(parts) > 3 {
			msg = parts[3]
		}
		return "", 0, fmt.Errorf("换取 CSRF token 失败：status_code=%s message=%q", parts[0], msg)
	}
	token := strings.TrimSpace(parts[1])
	if token == "" {
		return "", 0, fmt.Errorf("换取 CSRF token 失败：token 为空（%q）", raw)
	}

	var maxAge time.Duration
	if len(parts) > 2 {
		if secs, err := strconv.ParseInt(strings.TrimSpace(parts[2]), 10, 64); err == nil && secs > 0 {
			maxAge = time.Duration(secs) * time.Second
		}
	}
	return token, maxAge, nil
}
