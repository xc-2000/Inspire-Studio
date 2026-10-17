// Package uploader 实现字节跳动 Web 上传协议（VOD / ImageX 双链路）。
//
// 协议来源：《抖音创作者中心上传协议逆向报告》，对应线上 SDK
// lib-byted-uploader sdkVersion 2.1.1-alpha.23。
//
// 关键设计约束（勿轻易改动）：
//   - TOS 的分片/合并请求【不重新做 SigV4 签名】，Authorization 直接复用
//     ApplyUpload 响应里 StoreInfos[i].Auth。签名凭据是 STS 下发的一次性凭证，
//     只能签 Apply / Commit 这类 OpenAPI 调用。
//   - 图片默认走 ImageX（ServiceId），不是 VOD 的 FileType=image。
//   - Commit 响应字段是 PascalCase，需经 camelCase 变换后再取 vid / uri 等。
package uploader

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"douyin-uploader/internal/signer"
)

// 服务类型。
const (
	// ServiceVOD 是点播服务（视频）。
	ServiceVOD = "vod"
	// ServiceImageX 是图片服务。
	ServiceImageX = "imagex"
)

// 上传对象的类型。
const (
	TypeVideo  = "video"
	TypeImage  = "image"
	TypeObject = "object"
)

// 默认配置，取自创作者中心前端的默认上传配置。
const (
	DefaultVideoHost         = "https://vod.bytedanceapi.com/"
	DefaultImageHost         = "https://imagex.bytedanceapi.com/"
	DefaultFallbackHost      = "https://open.bytedanceapi.com"
	DefaultRegion            = "cn-north-1"
	DefaultVideoSpaceName    = "aweme"
	DefaultImageServiceID    = "jm8ajry58r"
	DefaultSchema            = "https"
	DefaultSliceSize         = 3 * 1024 * 1024  // 3MB
	DefaultLargeSliceSize    = 5 * 1024 * 1024  // 5MB，>=100MB 文件
	DefaultHugeSliceSize     = 10 * 1024 * 1024 // 10MB，>=500MB 文件
	DefaultSliceThreshold    = 100 * 1024 * 1024
	DefaultHugeThreshold     = 500 * 1024 * 1024
	DefaultDirectSizeLimit   = 3 * 1024 * 1024 // 小于等于该值走直传
	DefaultUploadSliceCount  = 5
	DefaultMaxReadConcurrent = 3
	DefaultGatewayTimeout    = 30 * time.Second
	DefaultRetryUploadTime   = 3
)

// Config 是上传客户端配置。
type Config struct {
	// VideoHost 是 VOD 服务地址。
	VideoHost string
	// VideoFallbackHost 是 VOD 备用地址。
	VideoFallbackHost string
	// ImageHost 是 ImageX 服务地址。
	ImageHost string
	// ImageFallbackHost 是 ImageX 备用地址。
	ImageFallbackHost string
	// Region 参与 SigV4 签名，必须与 Apply 时一致。
	Region string
	// VideoSpaceName 是视频存储空间名。
	VideoSpaceName string
	// ImageServiceID 是图片服务 ID。
	ImageServiceID string
	// VideoProcessAction 是提交视频时的处理链（取元信息 + 抽帧）。
	VideoProcessAction []map[string]any
	// ImageProcessAction 是提交图片时的处理链。
	ImageProcessAction []map[string]any
	// UserID 会作为 X-Storage-U 发到 TOS；为空时不带该头。
	UserID string
	// ClientIP 用于选路，可为空。
	ClientIP string
	// SliceSize 可强制指定分片大小；0 表示按文件大小自适应。
	SliceSize int64
	// Timeout 是单次 HTTP 请求超时。
	Timeout time.Duration
	// Logf 输出调试日志；留空则丢弃。
	Logf func(format string, args ...any)
}

// Client 是上传客户端。
//
// 它不持有登录态：Apply / Commit 通过注入的 OpenAPI 凭据签名，
// 分片则使用 Apply 返回的 Auth。
type Client struct {
	cfg  Config
	http *http.Client
	// now 用于签名时间；由外部注入以复用创作者中心的时钟校准。
	now func() time.Time
}

// New 创建上传客户端。
func New(cfg Config) *Client {
	if cfg.VideoHost == "" {
		cfg.VideoHost = DefaultVideoHost
	}
	if cfg.VideoFallbackHost == "" {
		cfg.VideoFallbackHost = DefaultFallbackHost
	}
	if cfg.ImageHost == "" {
		cfg.ImageHost = DefaultImageHost
	}
	if cfg.ImageFallbackHost == "" {
		cfg.ImageFallbackHost = DefaultFallbackHost
	}
	if cfg.Region == "" {
		cfg.Region = DefaultRegion
	}
	if cfg.VideoSpaceName == "" {
		cfg.VideoSpaceName = DefaultVideoSpaceName
	}
	if cfg.ImageServiceID == "" {
		cfg.ImageServiceID = DefaultImageServiceID
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 5 * time.Minute
	}
	if cfg.VideoProcessAction == nil {
		cfg.VideoProcessAction = []map[string]any{
			{"name": "GetMeta"},
			{"name": "Snapshot", "input": map[string]any{"SnapshotTime": 0}},
		}
	}
	return &Client{
		cfg:  cfg,
		http: &http.Client{Timeout: cfg.Timeout},
		now:  time.Now,
	}
}

// SetClock 注入时钟函数，用于复用创作者中心的服务器时间校准。
func (c *Client) SetClock(now func() time.Time) {
	if now != nil {
		c.now = now
	}
}

// Config 返回当前配置。
func (c *Client) Config() Config { return c.cfg }

func (c *Client) logf(format string, args ...any) {
	if c.cfg.Logf != nil {
		c.cfg.Logf(format, args...)
	}
}

// SelectService 决定某个上传类型走哪条链路。
//
// 对应 SDK 的 he()：type=image 无条件走 ImageX；只有显式指定 serviceType 才覆盖。
func SelectService(uploadType, serviceType string) string {
	if serviceType == ServiceVOD || serviceType == ServiceImageX {
		return serviceType
	}
	if uploadType == TypeImage {
		return ServiceImageX
	}
	return ServiceVOD
}

// SliceSize 按文件大小返回分片大小。
//
// 对应 SDK 的 getFileSliceLength：>=500MB 用 10MB，>=100MB 用 5MB，否则 3MB。
func (c *Client) SliceSize(fileSize int64) int64 {
	if c.cfg.SliceSize > 0 {
		return c.cfg.SliceSize
	}
	switch {
	case fileSize >= DefaultHugeThreshold:
		return DefaultHugeSliceSize
	case fileSize >= DefaultSliceThreshold:
		return DefaultLargeSliceSize
	default:
		return DefaultSliceSize
	}
}

// IsDirect 判断是否走直传（不切片、不合并）。
//
// 对应 SDK 的 isDirect：
// useDirectUpload || (type==image 且批量) || size <= 3MB || size <= minSliceSize
func (c *Client) IsDirect(fileSize int64, isBatch bool) bool {
	if isBatch {
		return true
	}
	if fileSize <= DefaultDirectSizeLimit {
		return true
	}
	return false
}

// Credentials 是 SigV4 凭据。
type Credentials = signer.Credentials

// HeaderMap 是服务端下发的一段自由形式的请求头。
//
// 线上抓到的实际类型是【对象】（例如 {} 或 {"USER_ID":"748..."}），不是数组。
// 早期按 [{Key,Value}] 解析会导致整个 Apply 响应解析失败。
type HeaderMap map[string]string

// StoreInfo 是 Apply 响应里的单个存储项。
type StoreInfo struct {
	// Auth 是 TOS 一次性签名，直接用于分片/合并的 Authorization 头。
	Auth string `json:"Auth"`
	// StoreUri 即协议里的 oid。
	StoreUri string `json:"StoreUri"`
	// UploadID 用于 init / transfer / finish 的查询参数。
	UploadID string `json:"UploadID"`
	// UploadHeader 是该存储项附加的请求头。
	UploadHeader HeaderMap `json:"UploadHeader"`
	// StorageHeader 形如 {"USER_ID":"..."}，其中的 USER_ID 就是 X-Storage-U 应取的值。
	StorageHeader HeaderMap `json:"StorageHeader"`
}

// UploadNode 是 Apply 响应里的一个上传节点。
type UploadNode struct {
	StoreInfos   []StoreInfo `json:"StoreInfos"`
	SessionKey   string      `json:"SessionKey"`
	UploadHost   string      `json:"UploadHost"`
	UploadHosts  []string    `json:"UploadHosts"`
	UploadHeader HeaderMap   `json:"UploadHeader"`
}

// UploadSession 是一次上传的上下文，由 Apply 阶段产出。
type UploadSession struct {
	// Service 是 vod 或 imagex。
	Service string
	// Host 是 Apply / Commit 使用的 OpenAPI 地址。
	Host string
	// FallbackHost 是备用地址。
	FallbackHost string
	// TOSDomain 是分片上传的目标地址，形如 https://xxx。
	TOSDomain string
	// SessionKey 用于 Commit。
	SessionKey string
	// StoreInfos 与上传的文件一一对应（批量图片时会有多项）。
	StoreInfos []StoreInfo
	// UploadHeader 是 Apply 下发的附加请求头。
	UploadHeader HeaderMap
	// StorageU 是 X-Storage-U 应发送的值，取自 StorageHeader.USER_ID。
	StorageU string
	// Region 用于 Commit 签名。
	Region string
}

// tosDomain 由上传 host 拼出 TOS 域名。
func tosDomain(schema, host string) string {
	if host == "" {
		return ""
	}
	if strings.HasPrefix(host, "http://") || strings.HasPrefix(host, "https://") {
		return strings.TrimRight(host, "/")
	}
	return schema + "://" + strings.TrimRight(host, "/")
}

// RawApply 执行一次 Apply 请求并返回原始响应体，仅用于诊断与字段核对。
func (c *Client) RawApply(ctx context.Context, service, uploadType string, creds Credentials, opts ApplyOptions) ([]byte, error) {
	host, _ := c.hosts(service)
	params := c.applyParams(service, uploadType, opts)
	return c.signedRequest(ctx, http.MethodGet, host, params, nil, creds, service, nil)
}

// applyUpload 调用 Apply 阶段获取上传地址与凭证。
func (c *Client) applyUpload(ctx context.Context, service, uploadType string, creds Credentials, opts ApplyOptions) (*UploadSession, error) {
	host, fallback := c.hosts(service)

	session, err := c.applyOnce(ctx, service, uploadType, creds, opts, host)
	if err == nil {
		return session, nil
	}
	if fallback == "" || fallback == host {
		return nil, err
	}
	c.logf("Apply 失败，改用备用地址 %s 重试：%v", fallback, err)
	return c.applyOnce(ctx, service, uploadType, creds, opts, fallback)
}

func (c *Client) hosts(service string) (host, fallback string) {
	if service == ServiceImageX {
		return c.cfg.ImageHost, c.cfg.ImageFallbackHost
	}
	return c.cfg.VideoHost, c.cfg.VideoFallbackHost
}

// ApplyOptions 是 Apply 阶段的参数。
type ApplyOptions struct {
	// FileSize 是单文件大小。
	FileSize int64
	// FileSizes 是批量上传的各文件大小（图片批量时使用）。
	FileSizes []int64
	// FileName 用于带扩展名申请。
	FileName string
	// UseFileExtension 开启后会上送 FileExtension。
	UseFileExtension bool
	// Schema 覆盖默认协议头。
	Schema string
}

func (c *Client) applyOnce(ctx context.Context, service, uploadType string, creds Credentials, opts ApplyOptions, host string) (*UploadSession, error) {
	params := c.applyParams(service, uploadType, opts)

	body, err := c.signedRequest(ctx, http.MethodGet, host, params, nil, creds, service, nil)
	if err != nil {
		return nil, fmt.Errorf("Apply 请求失败: %w", err)
	}

	var env struct {
		ResponseMetadata struct {
			Error struct {
				Code    string `json:"Code"`
				Message string `json:"Message"`
			} `json:"Error"`
		} `json:"ResponseMetadata"`
		Result json.RawMessage `json:"Result"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		return nil, fmt.Errorf("解析 Apply 响应失败: %w；响应片段: %s", err, snippet(body))
	}
	if env.ResponseMetadata.Error.Code != "" {
		return nil, fmt.Errorf("Apply 返回错误: %s %s",
			env.ResponseMetadata.Error.Code, env.ResponseMetadata.Error.Message)
	}

	schema := opts.Schema
	if schema == "" {
		schema = DefaultSchema
	}
	if service == ServiceImageX {
		return parseImageXApply(env.Result, schema, host)
	}
	return parseVODApply(env.Result, schema, host)
}

// applyParams 构造 Apply 阶段的查询参数。
func (c *Client) applyParams(service, uploadType string, opts ApplyOptions) []signer.Param {
	params := make([]signer.Param, 0, 16)

	switch service {
	case ServiceImageX:
		params = append(params,
			signer.Param{Key: "Action", Value: "ApplyImageUpload"},
			signer.Param{Key: "Version", Value: "2018-08-01"},
			signer.Param{Key: "ServiceId", Value: c.cfg.ImageServiceID},
		)
		if len(opts.FileSizes) > 1 {
			params = append(params, signer.Param{Key: "UploadNum", Value: strconv.Itoa(len(opts.FileSizes))})
		}
	default:
		size := opts.FileSize
		if size <= 0 && len(opts.FileSizes) > 0 {
			size = opts.FileSizes[0]
		}
		params = append(params,
			signer.Param{Key: "Action", Value: "ApplyUploadInner"},
			signer.Param{Key: "Version", Value: "2020-11-19"},
			signer.Param{Key: "SpaceName", Value: c.cfg.VideoSpaceName},
			signer.Param{Key: "FileType", Value: uploadType},
			signer.Param{Key: "IsInner", Value: "1"},
		)
		if size > 0 {
			params = append(params, signer.Param{Key: "FileSize", Value: strconv.FormatInt(size, 10)})
		}
	}

	// FileExtension 只在类型为 image/object 时由 SDK 上送；视频不传。
	if opts.UseFileExtension && opts.FileName != "" && uploadType != TypeVideo {
		params = append(params, signer.Param{Key: "FileExtension", Value: fileExtension(opts.FileName)})
	}

	// SDK 会带一个随机串，避免中间层缓存。
	params = append(params, signer.Param{Key: "s", Value: randString(11)})
	params = append(params, signer.Param{Key: "app_id", Value: "2906"})
	return params
}

func parseVODApply(raw json.RawMessage, schema, host string) (*UploadSession, error) {
	var res struct {
		InnerUploadAddress struct {
			UploadNodes []UploadNode `json:"UploadNodes"`
		} `json:"InnerUploadAddress"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, fmt.Errorf("解析 VOD Apply 结果失败: %w；片段: %s", err, snippet(raw))
	}
	nodes := res.InnerUploadAddress.UploadNodes
	if len(nodes) == 0 {
		return nil, fmt.Errorf("VOD Apply 结果里没有 UploadNodes；片段: %s", snippet(raw))
	}
	node := nodes[0]
	s := &UploadSession{
		Service:      ServiceVOD,
		Host:         strings.TrimRight(host, "/"),
		StoreInfos:   node.StoreInfos,
		SessionKey:   node.SessionKey,
		UploadHeader: node.UploadHeader,
		Region:       DefaultRegion,
	}
	s.TOSDomain = tosDomain(schema, node.UploadHost)
	if s.TOSDomain == "" && len(node.UploadHosts) > 0 {
		s.TOSDomain = tosDomain(schema, node.UploadHosts[0])
	}
	if s.TOSDomain == "" {
		return nil, fmt.Errorf("VOD Apply 结果里没有 UploadHost；片段: %s", snippet(raw))
	}
	if len(s.StoreInfos) == 0 {
		return nil, fmt.Errorf("VOD Apply 结果里没有 StoreInfos；片段: %s", snippet(raw))
	}
	return s, nil
}

func parseImageXApply(raw json.RawMessage, schema, host string) (*UploadSession, error) {
	var res struct {
		UploadAddress struct {
			UploadHosts  []string    `json:"UploadHosts"`
			StoreInfos   []StoreInfo `json:"StoreInfos"`
			SessionKey   string      `json:"SessionKey"`
			UploadHeader HeaderMap   `json:"UploadHeader"`
		} `json:"UploadAddress"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, fmt.Errorf("解析 ImageX Apply 结果失败: %w；片段: %s", err, snippet(raw))
	}
	addr := res.UploadAddress
	s := &UploadSession{
		Service:      ServiceImageX,
		Host:         strings.TrimRight(host, "/"),
		StoreInfos:   addr.StoreInfos,
		SessionKey:   addr.SessionKey,
		UploadHeader: addr.UploadHeader,
		Region:       DefaultRegion,
	}
	if len(addr.UploadHosts) > 0 {
		s.TOSDomain = tosDomain(schema, addr.UploadHosts[0])
	}
	if s.TOSDomain == "" {
		return nil, fmt.Errorf("ImageX Apply 结果里没有 UploadHosts；片段: %s", snippet(raw))
	}
	if len(s.StoreInfos) == 0 {
		return nil, fmt.Errorf("ImageX Apply 结果里没有 StoreInfos；片段: %s", snippet(raw))
	}
	return s, nil
}

// storageU 计算 X-Storage-U 应发送的值。
//
// 服务端在 StorageHeader 里给了 USER_ID（例如 "7481252581086102585"），
// 这就是 SDK 里 X-Storage-U 的来源；它通常与创作者账号的 user_id 一致，
// 但以服务端下发的值为准更稳妥。取不到时回退到配置里的 UserID。
func (s *UploadSession) storageU(fallback string) string {
	for _, info := range s.StoreInfos {
		if v := info.StorageHeader["USER_ID"]; v != "" {
			return v
		}
	}
	return fallback
}

// signedRequest 用 SigV4 签名并发起一次 OpenAPI 请求。
//
// pathname 恒为 "/"：SDK 的 getPathByURL 对形如 https://host 的地址一律得到 "/"，
// 因此 canonical request 的第二行不能拼上 host 之后的实际路径。
func (c *Client) signedRequest(ctx context.Context, method, host string, params []signer.Param,
	body []byte, creds Credentials, service string, extraHeaders map[string]string) ([]byte, error) {

	headers := []signer.Header{
		{Key: "Host", Value: hostName(host)},
	}
	for k, v := range extraHeaders {
		headers = append(headers, signer.Header{Key: k, Value: v})
	}

	signed, err := signer.Sign(&signer.Request{
		Method:  method,
		Path:    "/",
		Params:  params,
		Headers: headers,
		Body:    body,
	}, creds, c.cfg.Region, service, c.now())
	if err != nil {
		return nil, fmt.Errorf("SigV4 签名失败: %w", err)
	}

	rawURL := strings.TrimRight(host, "/") + "/"
	if len(params) > 0 {
		rawURL += "?" + signer.QueryString(params)
	}

	var reader io.Reader
	if body != nil {
		reader = strings.NewReader(string(body))
	}
	req, err := http.NewRequestWithContext(ctx, method, rawURL, reader)
	if err != nil {
		return nil, fmt.Errorf("构造请求失败: %w", err)
	}
	for _, h := range headers {
		if strings.EqualFold(h.Key, "Host") {
			continue // Host 由 http 包根据 URL 设置
		}
		req.Header.Set(h.Key, h.Value)
	}
	req.Header.Set("Authorization", signed.Authorization)
	req.Header.Set("X-Amz-Date", signed.AmzDate)
	if creds.SessionToken != "" {
		req.Header.Set("x-amz-security-token", creds.SessionToken)
	}
	if body != nil {
		req.Header.Set("X-Amz-Content-Sha256", sha256Hex(body))
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("请求 %s 失败: %w", rawURL, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, fmt.Errorf("读取 %s 响应失败: %w", rawURL, err)
	}
	if resp.StatusCode >= 400 {
		return raw, fmt.Errorf("请求 %s 返回 HTTP %d: %s", rawURL, resp.StatusCode, snippet(raw))
	}
	return raw, nil
}

func hostName(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" {
		return strings.TrimPrefix(strings.TrimPrefix(rawURL, "https://"), "http://")
	}
	return u.Host
}

func fileExtension(name string) string {
	idx := strings.LastIndex(name, ".")
	if idx < 0 || idx == len(name)-1 {
		return ""
	}
	return name[idx+1:]
}

func snippet(b []byte) string {
	s := string(b)
	if len(s) > 400 {
		return s[:400] + "..."
	}
	return s
}
