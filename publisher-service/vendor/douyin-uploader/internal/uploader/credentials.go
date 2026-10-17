package uploader

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"douyin-uploader/internal/signer"
)

// STSCredentials 是 /web/api/media/upload/auth/v5/ 下发的一次性上传凭证。
//
// 该接口把凭证放在 auth 字段里，而 auth 本身是一个 JSON 字符串，需要二次解析。
// 字段名大小写不稳定（AccessKeyId / AccessKeyID），因此解析时两种都认。
type STSCredentials struct {
	Credentials
	// CurrentTime 是服务端当前时间，用于校准签名时间。
	CurrentTime time.Time
	// ExpiredTime 是凭证过期时间。
	ExpiredTime time.Time
}

// ParseSTSCredentials 解析上传凭证。
func ParseSTSCredentials(authJSON string) (*STSCredentials, error) {
	raw := strings.TrimSpace(authJSON)
	if raw == "" {
		return nil, fmt.Errorf("上传凭证为空：可能是登录态失效，或该账号未开通上传权限")
	}

	var m map[string]any
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		return nil, fmt.Errorf("解析上传凭证失败（auth 不是合法 JSON）: %w；片段: %s", err, snippet([]byte(raw)))
	}

	creds := signer.Credentials{
		// SDK 优先取 AccessKeyId，回退 AccessKeyID。
		AccessKeyID:     firstString(m, "AccessKeyId", "AccessKeyID", "accessKeyId", "accessKeyID"),
		SecretAccessKey: firstString(m, "SecretAccessKey", "secretAccessKey", "SecretAccesskey"),
		SessionToken:    firstString(m, "SessionToken", "sessionToken"),
	}
	if !creds.Valid() {
		return nil, fmt.Errorf("上传凭证缺少 AccessKey 或 SecretAccessKey；已见字段: %s", keysOf(m))
	}

	out := &STSCredentials{Credentials: creds}
	out.CurrentTime = parseTimeField(m, "CurrentTime", "currentTime")
	out.ExpiredTime = parseTimeField(m, "ExpiredTime", "expiredTime")
	return out, nil
}

// parseTimeField 解析凭证里的时间字段。
//
// 服务端可能给 Unix 秒、Unix 毫秒，或 RFC3339 字符串。
func parseTimeField(m map[string]any, keys ...string) time.Time {
	for _, k := range keys {
		v, ok := m[k]
		if !ok {
			continue
		}
		switch t := v.(type) {
		case float64:
			return fromUnixNumber(t)
		case json.Number:
			if f, err := t.Float64(); err == nil {
				return fromUnixNumber(f)
			}
		case string:
			s := strings.TrimSpace(t)
			if s == "" {
				continue
			}
			// 纯数字字符串
			if f, err := json.Number(s).Float64(); err == nil {
				return fromUnixNumber(f)
			}
			for _, layout := range []string{time.RFC3339, "2006-01-02T15:04:05Z", "2006-01-02 15:04:05"} {
				if ts, err := time.Parse(layout, s); err == nil {
					return ts
				}
			}
		}
	}
	return time.Time{}
}

// fromUnixNumber 把数字时间戳归一成 time.Time。
//
// 小于 1e11 视为秒，否则视为毫秒（1e11 秒约合公元 5138 年，足够区分）。
func fromUnixNumber(f float64) time.Time {
	if f <= 0 {
		return time.Time{}
	}
	if f < 1e11 {
		return time.Unix(int64(f), 0)
	}
	return time.UnixMilli(int64(f))
}

func firstString(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			if s, ok := v.(string); ok && s != "" {
				return s
			}
		}
	}
	return ""
}

func keysOf(m map[string]any) string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return strings.Join(out, ", ")
}
