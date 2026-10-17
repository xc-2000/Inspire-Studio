package uploader

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"douyin-uploader/internal/signer"
)

// VideoMeta 是视频元信息，来自 Commit 响应的 videoMeta 字段。
type VideoMeta struct {
	// Size 是文件字节数。
	Size int64 `json:"size"`
	// Duration 是时长，单位【秒】（实测 3 秒视频返回 3）。
	Duration int64 `json:"duration"`
	// Height / Width 是转码后的分辨率。
	Height int64 `json:"height"`
	Width  int64 `json:"width"`
	// MD5 是文件摘要。
	MD5 string `json:"md5"`
	// URI 是存储对象标识。
	URI string `json:"uri"`
}

// VideoResult 是视频上传的最终结果。
type VideoResult struct {
	// Vid 是视频 ID，发布作品时作为 video_id。
	Vid string
	// PosterURI 是服务端抽帧得到的封面 URI。
	PosterURI string
	// Meta 是视频元信息。
	Meta VideoMeta
	// Raw 是 Commit 响应的原始结果对象，便于排查字段差异。
	Raw map[string]any
}

// ImageResult 是单张图片上传的最终结果。
type ImageResult struct {
	// URI 是图片在服务端的标识，图文发布时使用。
	URI string
	// ImageURI 是部分接口返回的图片标识，可能为空。
	ImageURI string
	// Width/Height 是图片尺寸。
	Width  int64
	Height int64
	// Raw 是原始结果对象。
	Raw map[string]any
}

// commit 调用 Commit 阶段，返回结果对象。
//
// VOD 与 ImageX 的 Action 与响应结构不同：
//   - VOD: Result.Results[0]
//   - ImageX 单张: Result.Results[0] 与 Result.PluginResult[0] 逐字段合并
//   - ImageX 批量: Results[i] 与 PluginResult[i] 逐项合并
func (c *Client) commit(ctx context.Context, s *UploadSession, service string, creds Credentials) ([]map[string]any, error) {
	var params []signer.Param
	var body map[string]any

	switch service {
	case ServiceImageX:
		params = []signer.Param{
			{Key: "Action", Value: "CommitImageUpload"},
			{Key: "Version", Value: "2018-08-01"},
			{Key: "ServiceId", Value: c.cfg.ImageServiceID},
		}
		body = map[string]any{"SessionKey": s.SessionKey}
		if len(c.cfg.ImageProcessAction) > 0 {
			body["Functions"] = c.cfg.ImageProcessAction
		}
	default:
		params = []signer.Param{
			{Key: "Action", Value: "CommitUploadInner"},
			{Key: "Version", Value: "2020-11-19"},
			{Key: "SpaceName", Value: c.cfg.VideoSpaceName},
		}
		body = map[string]any{
			"SessionKey": s.SessionKey,
			"Functions":  c.cfg.VideoProcessAction,
		}
	}

	raw, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("序列化 Commit 请求体失败: %w", err)
	}

	headers := map[string]string{}
	if service == ServiceImageX {
		// SDK 只对 ImageX 显式设置 Content-Type。
		headers["Content-Type"] = "application/json"
	}

	respBody, err := c.signedRequest(ctx, http.MethodPost, s.Host, params, raw, creds, service, headers)
	if err != nil {
		return nil, fmt.Errorf("Commit 请求失败: %w", err)
	}

	var env struct {
		ResponseMetadata struct {
			Error struct {
				Code    string `json:"Code"`
				Message string `json:"Message"`
			} `json:"Error"`
		} `json:"ResponseMetadata"`
		Result struct {
			Results      []map[string]any `json:"Results"`
			PluginResult []map[string]any `json:"PluginResult"`
		} `json:"Result"`
	}
	if err := json.Unmarshal(respBody, &env); err != nil {
		return nil, fmt.Errorf("解析 Commit 响应失败: %w；片段: %s", err, snippet(respBody))
	}
	if env.ResponseMetadata.Error.Code != "" {
		return nil, fmt.Errorf("Commit 返回错误: %s %s",
			env.ResponseMetadata.Error.Code, env.ResponseMetadata.Error.Message)
	}
	results := env.Result.Results
	if len(results) == 0 {
		return nil, fmt.Errorf("Commit 响应里没有 Results；片段: %s", snippet(respBody))
	}

	// 与 PluginResult 逐项合并（原 SDK 用对象展开）。
	plugins := env.Result.PluginResult
	for i := range results {
		if i < len(plugins) && plugins[i] != nil {
			for k, v := range plugins[i] {
				if _, exists := results[i][k]; !exists {
					results[i][k] = v
				}
			}
		}
		results[i] = camelizeMap(results[i])
	}
	return results, nil
}

// camelize 复刻原 SDK 的字段名变换：
//
//	key.replace(/^[A-Z]/, c => c.toLowerCase()).replace(/_([a-z])/, (_, c) => c.toUpperCase())
//
// 注意两个正则都【没有 g 标志】：首字母只转一次，下划线只转第一处。
func camelize(key string) string {
	if key == "" {
		return key
	}
	// 首字母大写 → 小写
	if key[0] >= 'A' && key[0] <= 'Z' {
		key = string(key[0]+32) + key[1:]
	}
	// 第一个 _x → X
	for i := 0; i+1 < len(key); i++ {
		if key[i] == '_' && key[i+1] >= 'a' && key[i+1] <= 'z' {
			key = key[:i] + string(key[i+1]-32) + key[i+2:]
			break
		}
	}
	return key
}

// camelizeMap 递归变换 map 的键名。
func camelizeMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[camelize(k)] = camelizeValue(v)
	}
	return out
}

func camelizeValue(v any) any {
	switch t := v.(type) {
	case map[string]any:
		return camelizeMap(t)
	case []any:
		out := make([]any, len(t))
		for i, e := range t {
			out[i] = camelizeValue(e)
		}
		return out
	default:
		return v
	}
}

// stringField 从结果对象里按多个候选键取字符串。
//
// 大小写不统一是常态：服务端可能返回 Vid / vid，也可能是 Uri / ImageUri / ImageURI。
func stringField(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			if s, ok := v.(string); ok && s != "" {
				return s
			}
		}
	}
	// 再退化为不区分大小写的匹配。
	for _, k := range keys {
		for mk, mv := range m {
			if strings.EqualFold(mk, k) {
				if s, ok := mv.(string); ok && s != "" {
					return s
				}
			}
		}
	}
	return ""
}

// intField 从结果对象里按候选键取整数。
func intField(m map[string]any, keys ...string) int64 {
	for _, k := range keys {
		v, ok := m[k]
		if !ok {
			continue
		}
		switch t := v.(type) {
		case float64:
			return int64(t)
		case int64:
			return t
		case int:
			return int64(t)
		case json.Number:
			if n, err := t.Int64(); err == nil {
				return n
			}
		case string:
			if n, err := strconv.ParseInt(t, 10, 64); err == nil {
				return n
			}
		}
	}
	return 0
}

// metaField 从结果对象里取出 videoMeta 子对象。
func metaField(m map[string]any) VideoMeta {
	raw, ok := m["videoMeta"]
	if !ok {
		raw, ok = m["VideoMeta"]
	}
	if !ok {
		return VideoMeta{}
	}
	sub, ok := raw.(map[string]any)
	if !ok {
		return VideoMeta{}
	}
	return VideoMeta{
		Size:     intField(sub, "size", "Size"),
		Duration: intField(sub, "duration", "Duration"),
		Height:   intField(sub, "height", "Height"),
		Width:    intField(sub, "width", "Width"),
		MD5:      stringField(sub, "md5", "Md5", "MD5"),
		URI:      stringField(sub, "uri", "Uri", "URI"),
	}
}
