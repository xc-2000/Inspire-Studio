// Package creator 封装抖音创作者中心（creator.douyin.com）的站点接口调用。
//
// 所有接口路径均从线上前端 bundle 中提取，详见 docs/protocol.md。
package creator

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"douyin-uploader/internal/cookies"
)

const (
	// Origin 是创作者中心的站点根地址。
	Origin = "https://creator.douyin.com"
	// Aid 是创作者中心 Web 端使用的应用 ID。
	Aid = 2906

	// 站点接口路径。
	PathUploadAuthV5  = "/web/api/media/upload/auth/v5/"
	PathUploadConfig  = "/web/api/media/upload/config"
	PathAwemeCreateV2 = "/web/api/media/aweme/create_v2/"
	PathAwemeUpdateV2 = "/web/api/media/aweme/update_v2/"
	PathAwemeDraft    = "/web/api/media/aweme/draft/"
	PathAwemeDelete   = "/web/api/media/aweme/delete"
	PathUserInfoPC    = "/aweme/v1/creator/pc/user/info/"
	PathUserInfo      = "/aweme/v1/creator/user/info/"
	PathMediaUserInfo = "/web/api/media/user/info/"
	PathHashtagCreate = "/web/api/media/hashtag/create/"
	PathVideoTransend = "/web/api/media/video/transend/"
	PathVideoEnable   = "/web/api/media/video/enable/"
	PathCreatorTask   = "/web/api/v2/creator/task/list"
)

// StatusOK 是业务成功的 status_code。
const StatusOK = 0

// StatusNotLoggedIn 是「用户未登录」的 status_code。
const StatusNotLoggedIn = 8

// Config 是客户端配置。
type Config struct {
	// Cookies 为登录态，必填。
	Cookies *cookies.Jar
	// UserAgent 可覆盖默认 UA。
	UserAgent string
	// Timeout 为单次请求超时。
	Timeout time.Duration
	// Doer 决定请求走哪条通道；留空则使用纯 Go 直连。
	Doer Doer
	// Logf 用于输出调试日志；留空则丢弃。
	Logf func(format string, args ...any)
}

// Param 是一个查询参数。
type Param struct {
	Key   string
	Value string
}

// Client 是创作者中心接口客户端。
type Client struct {
	cfg   Config
	http  *http.Client
	rnd   *rand.Rand
	doer  Doer
	csrf  *csrfProvider
	clock *ClockSync
}

// New 创建客户端。
func New(cfg Config) *Client {
	if cfg.UserAgent == "" {
		cfg.UserAgent = defaultUserAgent
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 60 * time.Second
	}
	c := &Client{
		cfg:   cfg,
		http:  &http.Client{Timeout: cfg.Timeout},
		rnd:   rand.New(rand.NewSource(time.Now().UnixNano())),
		clock: &ClockSync{},
	}
	c.csrf = newCSRFProvider(c.fetchSecsdkCSRF)
	if cfg.Doer != nil {
		if cfg.Doer == DoerOracle {
			c.doer = &oracleDoer{c: c}
		} else {
			c.doer = cfg.Doer
		}
	} else {
		c.doer = &directDoer{c: c}
	}
	return c
}

// SetOracleTransport 切换到浏览器签名通道。
//
// 必须在任何请求之前调用。
func (c *Client) SetOracleTransport(t OracleTransport) {
	c.doer = &oracleDoer{transport: t, c: c}
}

// UseDirectTransport 切回纯 Go 直连通道。
func (c *Client) UseDirectTransport() {
	c.doer = &directDoer{c: c}
}

// DoerOracle 是一个哨兵值，用于在 Config 中声明想使用签名通道。
var DoerOracle Doer = oracleDoerMarker{}

type oracleDoerMarker struct{}

func (oracleDoerMarker) Do(context.Context, string, string, []Param, []byte, string) (*RawResponse, error) {
	return nil, fmt.Errorf("签名通道需要先通过 SetOracleTransport 注入浏览器传输层")
}

// ClockSync 用服务端返回的 extra.now 修正本地时钟。
//
// 上传凭证是 STS 签发的，SigV4 签名对时间敏感；本机时钟偏差超过 15 分钟
// 就会签名失败（服务端返回 100006）。
type ClockSync struct {
	gap time.Duration
	set bool
}

// Now 返回校准后的当前时间。
func (c *ClockSync) Now() time.Time {
	if c.set {
		return time.Now().Add(c.gap)
	}
	return time.Now()
}

// Update 用服务端时间（毫秒）校准。偏差小于 60 秒时忽略，与前端逻辑一致。
func (c *ClockSync) Update(serverMillis int64) {
	if serverMillis <= 0 {
		return
	}
	server := time.UnixMilli(serverMillis)
	gap := server.Sub(time.Now())
	if gap < 0 {
		gap = -gap
	}
	if gap <= 60*time.Second {
		return
	}
	c.gap = time.UnixMilli(serverMillis).Sub(time.Now())
	c.set = true
}

// Offset 返回当前记录的时钟偏差。
func (c *ClockSync) Offset() time.Duration { return c.gap }

// Clock 返回时钟校准器。
func (c *Client) Clock() *ClockSync { return c.clock }

const defaultUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

func (c *Client) logf(format string, args ...any) {
	if c.cfg.Logf != nil {
		c.cfg.Logf(format, args...)
	}
}

// Meta 是抖音接口统一的响应外壳。
type Meta struct {
	StatusCode int    `json:"status_code"`
	StatusMsg  string `json:"status_msg"`
}

// Extra 是响应里的 extra 字段，含 logid 与服务端时间。
type Extra struct {
	LogID string `json:"logid"`
	Now   int64  `json:"now"`
}

// Response 是一次原始调用的结果。
type Response struct {
	// HTTPStatus 是 HTTP 状态码。
	HTTPStatus int
	// Body 是响应原文。
	Body []byte
	// Meta 是解析出的业务状态。
	Meta Meta
	// Extra 是解析出的 extra 字段。
	Extra Extra
	// URL 是实际请求的 URL。
	URL string
}

// Get 发起 GET 请求，path 必须是站点相对路径。
func (c *Client) Get(ctx context.Context, path string, params []Param, out any) (*Response, error) {
	return c.do(ctx, http.MethodGet, path, params, nil, out)
}

// PostJSON 发起 JSON POST 请求。
func (c *Client) PostJSON(ctx context.Context, path string, params []Param, body any, out any) (*Response, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("序列化请求体失败: %w", err)
	}
	return c.do(ctx, http.MethodPost, path, params, raw, out)
}

// do 是统一的请求实现：拼参数、取 CSRF、发请求、解析响应。
func (c *Client) do(ctx context.Context, method, path string, params []Param, body []byte, out any) (*Response, error) {
	all := make([]Param, 0, len(params)+16)
	all = append(all, params...)
	all = append(all, c.commonParams()...)

	res, err := c.doer.Do(ctx, method, path, all, body, "")
	if err != nil {
		return nil, err
	}
	return c.finish(res, path, out)
}

// doDirect 是 directDoer 使用的底层实现。
func (c *Client) doDirect(ctx context.Context, method, path string, params []Param, body []byte, contentType string) (*RawResponse, error) {
	u, err := url.Parse(Origin + path)
	if err != nil {
		return nil, fmt.Errorf("构造 URL 失败: %w", err)
	}
	u.RawQuery = encodeQuery(params)

	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), reader)
	if err != nil {
		return nil, fmt.Errorf("构造请求失败: %w", err)
	}

	// 头部顺序与浏览器一致：先固定头，再 Cookie，最后 CSRF。
	req.Header.Set("User-Agent", c.cfg.UserAgent)
	req.Header.Set("Referer", Origin+"/creator-micro/content/upload")
	req.Header.Set("Origin", Origin)
	req.Header.Set("Accept", "application/json, text/plain, */*")
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9")
	if body != nil {
		ct := contentType
		if ct == "" {
			ct = "application/json"
		}
		req.Header.Set("Content-Type", ct)
	}
	req.Header.Set("Cookie", c.cfg.Cookies.Header())

	if token, err := c.CSRFToken(ctx, path); err == nil && token != "" {
		req.Header.Set(HeaderSecsdkCSRF, token)
	} else if err != nil {
		c.logf("获取 CSRF token 失败（继续请求）：%v", err)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("请求 %s 失败: %w", path, err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("读取 %s 响应失败: %w", path, err)
	}
	return &RawResponse{HTTPStatus: resp.StatusCode, Header: resp.Header, Body: raw, URL: u.String()}, nil
}

// finish 解析传输层结果并做统一后处理。
func (c *Client) finish(res *RawResponse, path string, out any) (*Response, error) {
	r := &Response{HTTPStatus: res.HTTPStatus, Body: res.Body, URL: res.URL}
	var envelope struct {
		Meta
		Extra Extra `json:"extra"`
	}
	// 抖音在部分接口上仍返回文本/HTML，这里容忍解析失败。
	if err := json.Unmarshal(res.Body, &envelope); err == nil {
		r.Meta = envelope.Meta
		r.Extra = envelope.Extra
		c.clock.Update(envelope.Extra.Now)
	}
	if out != nil {
		if err := decodeJSON(res.Body, out); err != nil {
			// 空响应体往往意味着被边缘节点拦截或重定向，
			// 只报 "unexpected end of JSON input" 无法定位，这里带上状态码与关键响应头。
			if len(bytes.TrimSpace(res.Body)) == 0 {
				return r, fmt.Errorf("%s: HTTP %d，响应体为空%s%s",
					path, res.HTTPStatus, describeHeader(res.Header), hintForEmptyBody(res.HTTPStatus))
			}
			return r, fmt.Errorf("%s: %w", path, err)
		}
	}
	return r, nil
}

// hintForEmptyBody 对「成功状态码 + 空响应体」这一特征给出可操作提示。
//
// 实测：短时间连续发布会让服务端返回 HTTP 403 + 空体，并随即踢下线整个会话。
// 若不提示，使用者容易误判为签名或 cookie 问题而反复重试，反而延长封禁。
func hintForEmptyBody(status int) string {
	switch status {
	case http.StatusForbidden:
		return "\n提示：403 且响应体为空通常是**发布频率触发的风控**，不是签名或 cookie 问题。" +
			"会话可能已被踢下线，请：\n" +
			"  1. 立即停止重试，稍等数分钟；\n" +
			"  2. 重新导出 cookie（或重新登录）后再试；\n" +
			"  3. 后续发布之间留足间隔，调试时优先用 --dry-run。"
	case http.StatusTooManyRequests:
		return "\n提示：已被限流，请等待后再试。"
	}
	return ""
}

// describeHeader 摘出定位问题时最有用的响应头。
func describeHeader(h http.Header) string {
	if h == nil {
		return ""
	}
	var parts []string
	for _, k := range []string{"Content-Type", "Content-Length", "Location", "Server", "X-Tt-Logid", "X-Tt-Errmsg"} {
		if v := h.Get(k); v != "" {
			parts = append(parts, k+"="+v)
		}
	}
	if len(parts) == 0 {
		return ""
	}
	return "（" + strings.Join(parts, " ") + "）"
}

// CSRFToken 返回指定路径可用的 secsdk CSRF token。
func (c *Client) CSRFToken(ctx context.Context, path string) (string, error) {
	return c.csrf.Token(ctx, path)
}

// commonParams 对应前端请求拦截器注入的浏览器与设备参数。
func (c *Client) commonParams() []Param {
	return []Param{
		{"aid", strconv.Itoa(Aid)},
		{"cookie_enabled", "true"},
		{"screen_width", "1920"},
		{"screen_height", "1080"},
		{"browser_language", "zh-CN"},
		{"browser_platform", "Win32"},
		{"browser_name", "Mozilla"},
		{"browser_version", c.cfg.UserAgent},
		{"browser_online", "true"},
		{"timezone_name", "Asia/Shanghai"},
		{"support_h265", "1"},
	}
}

// encodeQuery 按插入顺序拼接查询串。
//
// 编码规则对齐 JS 的 encodeURIComponent：空格编码为 %20（而非 url.QueryEscape 的 +），
// 且不转义 ! ' ( ) * 。抖音会对查询串参与校验，用 + 表示空格会导致与浏览器不一致。
func encodeQuery(params []Param) string {
	var b strings.Builder
	for _, p := range params {
		if p.Key == "" {
			continue
		}
		if b.Len() > 0 {
			b.WriteByte('&')
		}
		b.WriteString(encodeURIComponent(p.Key))
		b.WriteByte('=')
		b.WriteString(encodeURIComponent(p.Value))
	}
	return b.String()
}

// encodeURIComponent 等价实现 JS 的 encodeURIComponent。
func encodeURIComponent(s string) string {
	const upperhex = "0123456789ABCDEF"
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); {
		ch := s[i]
		if isUnreservedURI(ch) {
			b.WriteByte(ch)
			i++
			continue
		}
		// 多字节字符按 UTF-8 逐字节转义。
		b.WriteByte('%')
		b.WriteByte(upperhex[ch>>4])
		b.WriteByte(upperhex[ch&0x0f])
		i++
	}
	return b.String()
}

// isUnreservedURI 判断一个字节在 encodeURIComponent 下是否需要转义。
func isUnreservedURI(b byte) bool {
	switch {
	case b >= 'A' && b <= 'Z', b >= 'a' && b <= 'z', b >= '0' && b <= '9':
		return true
	}
	switch b {
	case '-', '_', '.', '!', '~', '*', '\'', '(', ')':
		return true
	}
	return false
}

var _ = utf8.RuneLen

// UploadAuth 是上传凭证接口的响应。
type UploadAuth struct {
	Meta
	// Auth 是一段 JSON 字符串，需二次解析成 Credentials。
	Auth     string `json:"auth"`
	ClientIP string `json:"client_ip"`
}

// UploadRegionVideo 是 upload/config 中视频相关的配置。
type UploadRegionVideo struct {
	Host         string `json:"host"`
	FallbackHost string `json:"fallback_host"`
	Region       string `json:"region"`
}

// UploadConfig 是 upload/config 的响应。
type UploadConfig struct {
	Meta
	VideoConfig *UploadRegionVideo `json:"video_config"`
}

// GetUploadAuth 拉取 STS 临时凭证。
//
// 该接口返回的 auth 是一个「JSON 字符串」，需要二次解析成凭证对象。
func (c *Client) GetUploadAuth(ctx context.Context) (*UploadAuth, error) {
	var out UploadAuth
	res, err := c.Get(ctx, PathUploadAuthV5, nil, &out)
	if err != nil {
		return nil, err
	}
	if err := checkStatus(res, out.Meta, "获取上传凭证"); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetUploadConfig 拉取上传区域配置（host 可能按需切换）。
//
// 该接口受远程开关 enable_creator_upload_regional_host_config 控制；
// 失败不致命，调用方应回退到内置默认 host。
func (c *Client) GetUploadConfig(ctx context.Context) (*UploadConfig, error) {
	var out UploadConfig
	res, err := c.Get(ctx, PathUploadConfig, nil, &out)
	if err != nil {
		return nil, err
	}
	if err := checkStatus(res, out.Meta, "获取上传区域配置"); err != nil {
		return nil, err
	}
	return &out, nil
}

// UserInfo 是账号信息（用于登录态自检）。
type UserInfo struct {
	Meta
	UserID   json.Number `json:"user_id"`
	Nickname string      `json:"nickname"`
	UID      string      `json:"uid"`
}

// CheckLogin 校验登录态是否有效。
//
// 这里刻意调用 /aweme/v1/creator/user/info/：它在未登录时稳定返回 status_code=8。
func (c *Client) CheckLogin(ctx context.Context) (*UserInfo, error) {
	var out UserInfo
	res, err := c.Get(ctx, PathUserInfo, nil, &out)
	if err != nil {
		return nil, err
	}
	if out.StatusCode == StatusNotLoggedIn {
		return nil, fmt.Errorf("登录态无效：%s（请重新导出 cookie）", msgOr(out.StatusMsg, "用户未登录"))
	}
	if err := checkStatus(res, out.Meta, "校验登录态"); err != nil {
		return nil, err
	}
	return &out, nil
}

// CreateItemResult 是发布接口的响应。
type CreateItemResult struct {
	Meta
	ItemID  json.Number `json:"item_id"`
	AwemeID json.Number `json:"aweme_id"`
}

// CreateVideo 提交视频作品。item 为构建好的 item 对象。
func (c *Client) CreateVideo(ctx context.Context, item map[string]any) (*CreateItemResult, error) {
	return c.createItem(ctx, PathAwemeCreateV2, item, "发布视频")
}

// CreateImages 提交图文作品。
func (c *Client) CreateImages(ctx context.Context, item map[string]any) (*CreateItemResult, error) {
	return c.createItem(ctx, PathAwemeCreateV2, item, "发布图文")
}

func (c *Client) createItem(ctx context.Context, path string, item map[string]any, action string) (*CreateItemResult, error) {
	var out CreateItemResult
	body := map[string]any{"item": item}
	// 前端在 create_v2 上带了 read_aid 查询参数。
	res, err := c.PostJSON(ctx, path, []Param{{"read_aid", strconv.Itoa(Aid)}}, body, &out)
	if err != nil {
		return nil, err
	}
	if err := checkStatus(res, out.Meta, action); err != nil {
		return nil, err
	}
	if out.ItemID.String() == "" && out.AwemeID.String() == "" {
		return &out, fmt.Errorf("%s 返回成功但未包含 item_id；响应: %s", action, truncate(res.Body, 400))
	}
	return &out, nil
}

// checkStatus 把非零 status_code 转成带上下文的错误。
func checkStatus(res *Response, meta Meta, action string) error {
	if meta.StatusCode == StatusOK {
		return nil
	}
	hint := ""
	switch meta.StatusCode {
	case StatusNotLoggedIn:
		hint = "（登录态可能已过期，请重新导出 cookie）"
	case 2154:
		hint = "（内容可能触发风控或校验，详见 status_msg）"
	case 100006:
		hint = "（签名时间与服务器偏差过大，请检查本机时钟）"
	}
	if res != nil && res.Extra.LogID != "" {
		hint += " logid=" + res.Extra.LogID
	}
	return fmt.Errorf("%s 失败: status_code=%d status_msg=%q%s；响应: %s",
		action, meta.StatusCode, meta.StatusMsg, hint, truncate(res.Body, 400))
}

func msgOr(s, fallback string) string {
	if strings.TrimSpace(s) == "" {
		return fallback
	}
	return s
}

func truncate(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + "..."
}
