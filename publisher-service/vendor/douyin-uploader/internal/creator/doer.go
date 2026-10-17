package creator

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// Doer 抽象「如何发出一次站点请求」。
//
// 有两种实现：
//   - directDoer：纯 Go 直连。不带 a_bogus 签名，适合只读接口与自检。
//   - OracleDoer：交给真实浏览器页面执行，复用其登录态与签名 SDK。
//
// 之所以要做这层抽象：a_bogus 无法用 Go 复刻，而它是否需要由服务端校验，
// 在「已登录 + 写操作」场景下尚未验证。保留两条通道，可由命令行切换。
type Doer interface {
	// Do 发出请求。path 是站点相对路径，params 是已按插入顺序排好的查询参数，
	// body 是原始请求体（可为 nil）。返回状态码、响应头和响应体。
	Do(ctx context.Context, method, path string, params []Param, body []byte, contentType string) (*RawResponse, error)
}

// RawResponse 是一次传输层响应的结果。
type RawResponse struct {
	// HTTPStatus 是 HTTP 状态码。
	HTTPStatus int
	// Header 是响应头；用 http.Header 以便统一处理多值。
	Header http.Header
	// Body 是响应正文。
	Body []byte
	// URL 是实际请求的 URL（经签名后可能追加了参数）。
	URL string
}

// directDoer 用 Go 的 net/http 直接请求。
type directDoer struct {
	c *Client
}

func (d *directDoer) Do(ctx context.Context, method, path string, params []Param, body []byte, contentType string) (*RawResponse, error) {
	return d.c.doDirect(ctx, method, path, params, body, contentType)
}

// OracleTransport 是浏览器签名通道需要实现的最小接口。
//
// 定义在这里而不是引用 internal/browser，是为了避免 creator 反向依赖具体实现，
// 也便于测试时替换成假实现。
type OracleTransport interface {
	// Do 在页面里发起请求并返回结果。
	Do(ctx context.Context, method, rawURL string, body []byte, headers map[string]string) (*OracleResponse, error)
}

// OracleResponse 是页面内请求的结果。
type OracleResponse struct {
	Status  int
	Body    string
	URL     string
	Headers string
	Err     string
}

// oracleDoer 通过浏览器页面发起请求。
type oracleDoer struct {
	transport OracleTransport
	c         *Client
}

func (o *oracleDoer) Do(ctx context.Context, method, path string, params []Param, body []byte, contentType string) (*RawResponse, error) {
	rawURL := Origin + path
	if len(params) > 0 {
		rawURL += "?" + encodeQuery(params)
	}

	headers := map[string]string{
		"Accept":          "application/json, text/plain, */*",
		"Accept-Language": "zh-CN,zh;q=0.9",
	}
	if body != nil {
		ct := contentType
		if ct == "" {
			ct = "application/json"
		}
		headers["Content-Type"] = ct
	}

	// CSRF 由页面自己带（SDK 已挂钩 XHR），这里只在拿得到 token 时补一个，
	// 避免页面上下文里换 token 的额外往返。
	if token, err := o.c.CSRFToken(ctx, path); err == nil && token != "" {
		headers[HeaderSecsdkCSRF] = token
	}

	res, err := o.transport.Do(ctx, method, rawURL, body, headers)
	if err != nil {
		return nil, err
	}
	if res.Err != "" {
		return nil, fmt.Errorf("浏览器内请求 %s 失败: %s", path, res.Err)
	}

	return &RawResponse{
		HTTPStatus: res.Status,
		Header:     parseRawHeaders(res.Headers),
		Body:       []byte(res.Body),
		URL:        res.URL,
	}, nil
}

// parseRawHeaders 解析 CDP 拿回的原始响应头文本（CRLF 分隔的 "Key: Value"）。
func parseRawHeaders(raw string) http.Header {
	h := make(http.Header)
	for _, line := range splitLines(raw) {
		idx := indexByte(line, ':')
		if idx <= 0 {
			continue
		}
		key := trimSpace(line[:idx])
		val := trimSpace(line[idx+1:])
		if key == "" {
			continue
		}
		h.Add(key, val)
	}
	return h
}

func splitLines(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			out = append(out, trimSpace(s[start:i]))
			start = i + 1
		}
	}
	if start < len(s) {
		out = append(out, trimSpace(s[start:]))
	}
	return out
}

func indexByte(s string, b byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return -1
}

func trimSpace(s string) string {
	start, end := 0, len(s)
	for start < end && isSpace(s[start]) {
		start++
	}
	for end > start && isSpace(s[end-1]) {
		end--
	}
	return s[start:end]
}

func isSpace(b byte) bool {
	return b == ' ' || b == '\t' || b == '\r' || b == '\n'
}

// decodeJSON 解析响应体。
func decodeJSON(raw []byte, out any) error {
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		preview := string(raw)
		if len(preview) > 300 {
			preview = preview[:300] + "..."
		}
		return fmt.Errorf("解析响应失败: %w；响应片段: %s", err, preview)
	}
	return nil
}

var _ Doer = (*directDoer)(nil)
var _ Doer = (*oracleDoer)(nil)
var _ = time.Second
