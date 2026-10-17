// Package signer 实现字节跳动 VOD/imagex 对象存储接口所需的 AWS SigV4 请求签名。
//
// 该算法逆向自创作者中心使用的字节上传 SDK（lib-byted-uploader）。
// 与原实现的对应关系逐条记录在注释中，便于后续校验与维护。
//
// 关键结论（均来自 SDK 源码，非猜测）：
//   - Authorization 头格式为 "AWS4-HMAC-SHA256 Credential=<ak>/<scope>, SignedHeaders=<...>, Signature=<...>"
//   - 作用域（scope）为 "<datestamp>/<region>/<service>/aws4_request"
//   - 签名密钥为 HMAC 链：HMAC(HMAC(HMAC(HMAC("AWS4"+sk, datestamp), region), service), "aws4_request")
//   - 规范请求（canonical request）的 6 个部分依次为：
//     METHOD、pathname、canonicalQueryString、canonicalHeaders+"\n"、signedHeaders、bodyHash
//   - 参与签名的头：所有 x-amz-* 一律参与；其余头除非在忽略列表中，否则参与。
//     忽略列表：authorization, content-type, content-length, user-agent,
//     presigned-expires, expect, x-amzn-trace-id
package signer

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"time"
)

// Algorithm 是 Authorization 头中的算法标识。
const Algorithm = "AWS4-HMAC-SHA256"

// Terminator 是作用域的最后一段。
const Terminator = "aws4_request"

// 不参与签名的头（对应 SDK 中的忽略列表 c）。
var unsignedHeaders = map[string]bool{
	"authorization":     true,
	"content-type":      true,
	"content-length":    true,
	"user-agent":        true,
	"presigned-expires": true,
	"expect":            true,
	"x-amzn-trace-id":   true,
}

// Credentials 是 STS 临时凭证（来自 /web/api/media/upload/auth/v5/）。
type Credentials struct {
	AccessKeyID     string
	SecretAccessKey string
	SessionToken    string
}

// Valid 判断凭证是否完整。
func (c Credentials) Valid() bool {
	return c.AccessKeyID != "" && c.SecretAccessKey != ""
}

// Param 是一个查询参数。顺序会保留，因为真实 URL 的查询串按插入顺序拼接。
type Param struct {
	Key   string
	Value string
}

// Request 描述一个待签名的请求。
type Request struct {
	Method  string
	Path    string // pathname，例如 "/" 或 "/upload/v1/xxx"
	Params  []Param
	Headers []Header
	Body    []byte // 无请求体时为 nil
}

// Header 是一个请求头。
type Header struct {
	Key   string
	Value string
}

// Signed 是签名结果，便于测试比对与日志输出。
type Signed struct {
	Authorization    string
	CanonicalRequest string
	StringToSign     string
	CredentialScope  string
	SignedHeaders    []string
	AmzDate          string
}

// Sign 按 SigV4 计算 Authorization，并把 SDK 会追加的头（X-Amz-Date、
// x-amz-security-token、X-Amz-Content-Sha256）写入 req.Headers。
//
// t 为签名时刻；调用方若已通过 STS 响应校准过服务器时间，应传入校准后的时间。
func Sign(req *Request, creds Credentials, region, service string, t time.Time) (*Signed, error) {
	if !creds.Valid() {
		return nil, fmt.Errorf("签名凭证不完整：AccessKeyID 或 SecretAccessKey 为空")
	}
	if region == "" {
		return nil, fmt.Errorf("签名缺少 region")
	}
	if service == "" {
		return nil, fmt.Errorf("签名缺少 service")
	}

	amzDate := AmzDate(t)
	// 与 SDK 的 addHeaders 一致：X-Amz-Date 必定写入；有会话令牌时写入 x-amz-security-token；
	// 有请求体时写入 X-Amz-Content-Sha256。
	setHeader(req, "X-Amz-Date", amzDate)
	if creds.SessionToken != "" {
		setHeader(req, "x-amz-security-token", creds.SessionToken)
	}
	if req.Body != nil {
		setHeader(req, "X-Amz-Content-Sha256", hexSHA256(req.Body))
	}

	datestamp := amzDate[:8]
	scope := strings.Join([]string{datestamp, region, service, Terminator}, "/")

	signedHeaderNames := signableHeaderNames(req.Headers)
	canonicalRequest := buildCanonicalRequest(req, signedHeaderNames)
	stringToSign := strings.Join([]string{
		Algorithm,
		amzDate,
		scope,
		hexSHA256([]byte(canonicalRequest)),
	}, "\n")

	signingKey := deriveSigningKey(creds.SecretAccessKey, datestamp, region, service)
	signature := hex.EncodeToString(hmacSHA256(signingKey, []byte(stringToSign)))

	auth := fmt.Sprintf("%s Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		Algorithm, creds.AccessKeyID, scope, strings.Join(signedHeaderNames, ";"), signature)

	return &Signed{
		Authorization:    auth,
		CanonicalRequest: canonicalRequest,
		StringToSign:     stringToSign,
		CredentialScope:  scope,
		SignedHeaders:    signedHeaderNames,
		AmzDate:          amzDate,
	}, nil
}

// buildCanonicalRequest 对应 SDK 的 canonicalString()。
func buildCanonicalRequest(req *Request, signedHeaders []string) string {
	path := req.Path
	if path == "" {
		path = "/"
	}
	canonicalHeaders := buildCanonicalHeaders(req.Headers)
	// 注意：SDK 在 canonicalHeaders 之后额外补了一个 "\n"，随后整体再用 "\n" 连接，
	// 因此规范请求里 canonicalHeaders 与 signedHeaders 之间是空行。
	parts := []string{
		strings.ToUpper(req.Method),
		path,
		CanonicalQueryString(req.Params),
		canonicalHeaders + "\n",
		strings.Join(signedHeaders, ";"),
		bodyHash(req),
	}
	return strings.Join(parts, "\n")
}

func bodyHash(req *Request) string {
	if v, ok := getHeader(req.Headers, "X-Amz-Content-Sha256"); ok && v != "" {
		return v
	}
	if req.Body != nil {
		return hexSHA256(req.Body)
	}
	return hexSHA256(nil)
}

// signableHeaderNames 返回参与签名的头名（小写），按字典序升序。
func signableHeaderNames(headers []Header) []string {
	seen := make(map[string]bool, len(headers))
	for _, h := range headers {
		name := strings.ToLower(h.Key)
		if isSignable(name) {
			seen[name] = true
		}
	}
	out := make([]string, 0, len(seen))
	for name := range seen {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// isSignable 对应 SDK 的 isSignableHeader。
func isSignable(lowerName string) bool {
	if strings.HasPrefix(lowerName, "x-amz-") {
		return true
	}
	return !unsignedHeaders[lowerName]
}

// buildCanonicalHeaders 输出 "name:value" 行，按头名升序，值做空白折叠。
func buildCanonicalHeaders(headers []Header) string {
	names := signableHeaderNames(headers)
	lines := make([]string, 0, len(names))
	for _, name := range names {
		v, _ := getHeader(headers, name)
		lines = append(lines, name+":"+collapseSpaces(v))
	}
	return strings.Join(lines, "\n")
}

// collapseSpaces 对应 SDK 的 canonicalHeaderValues：把连续空白折成一个空格并去掉首尾空白。
func collapseSpaces(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

// CanonicalQueryString 对应 SDK 中用于签名的规范查询串：
// 键按字典序升序；数组值先排序再展开；值为 nil 的参数被丢弃；键编码后为空则丢弃。
func CanonicalQueryString(params []Param) string {
	grouped := make(map[string][]string)
	// 同名的重复参数需要合并（Go 侧更常出现，SDK 侧用数组表达）。
	order := make([]string, 0, len(params))
	for _, p := range params {
		if _, ok := grouped[p.Key]; !ok {
			order = append(order, p.Key)
		}
		grouped[p.Key] = append(grouped[p.Key], p.Value)
	}
	sort.Strings(order)

	parts := make([]string, 0, len(order))
	for _, key := range order {
		encodedKey := encodeComponent(key)
		if encodedKey == "" {
			continue
		}
		values := grouped[key]
		encodedValues := make([]string, 0, len(values))
		for _, v := range values {
			encodedValues = append(encodedValues, encodeComponent(v))
		}
		sort.Strings(encodedValues)
		for _, ev := range encodedValues {
			parts = append(parts, encodedKey+"="+ev)
		}
	}
	return strings.Join(parts, "&")
}

// QueryString 对应 SDK 的 toQueryString：真实 URL 使用的查询串。
// 与签名版本的区别是：键保持插入顺序、值用较宽松的编码规则。
func QueryString(params []Param) string {
	grouped := make(map[string][]string)
	order := make([]string, 0, len(params))
	for _, p := range params {
		if _, ok := grouped[p.Key]; !ok {
			order = append(order, p.Key)
		}
		grouped[p.Key] = append(grouped[p.Key], p.Value)
	}
	parts := make([]string, 0, len(params))
	for _, key := range order {
		values := grouped[key]
		if len(values) > 1 {
			sorted := make([]string, len(values))
			copy(sorted, values)
			sort.Strings(sorted)
			for _, v := range sorted {
				parts = append(parts, key+"="+encodeComponentLoose(v))
			}
			continue
		}
		if len(values) == 1 {
			parts = append(parts, key+"="+encodeComponentLoose(values[0]))
		}
	}
	return strings.Join(parts, "&")
}

// encodeComponent 是签名用的严格百分号编码。
//
// 对应 SDK 的实现链：encodeURIComponent → 对 [^A-Za-z0-9_.~\-%] 逐个 escape → 再把 '*' 转成 %2A。
// 净效果等价于 RFC 3986 的 unreserved 集合 + 星号强制编码。
func encodeComponent(s string) string {
	return percentEncode(s, false)
}

// encodeComponentLoose 对应 encodeURIComponent 的行为，用于真实 URL。
// unreserved 集合为 A-Za-z0-9-_.!~*'()
func encodeComponentLoose(s string) string {
	return percentEncode(s, true)
}

func percentEncode(s string, loose bool) string {
	const upperhex = "0123456789ABCDEF"
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if isUnreserved(c, loose) {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(upperhex[c>>4])
		b.WriteByte(upperhex[c&0x0f])
	}
	return b.String()
}

func isUnreserved(c byte, loose bool) bool {
	switch {
	case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9':
		return true
	case c == '-' || c == '_' || c == '.' || c == '~':
		return true
	case loose && (c == '!' || c == '*' || c == '\'' || c == '(' || c == ')'):
		return true
	}
	return false
}

// AmzDate 对应 SDK 的 iso8601(date).replace(/[:\-]|\.\d{3}/g, "")，形如 20260920T093706Z。
func AmzDate(t time.Time) string {
	return t.UTC().Format("20060102T150405Z")
}

// Datestamp 返回作用域里的日期段（YYYYMMDD）。
func Datestamp(t time.Time) string { return t.UTC().Format("20060102") }

// deriveSigningKey 对应 SDK 的 getSigningKey。
func deriveSigningKey(secret, datestamp, region, service string) []byte {
	kDate := hmacSHA256([]byte("AWS4"+secret), []byte(datestamp))
	kRegion := hmacSHA256(kDate, []byte(region))
	kService := hmacSHA256(kRegion, []byte(service))
	return hmacSHA256(kService, []byte(Terminator))
}

func hmacSHA256(key, data []byte) []byte {
	m := hmac.New(sha256.New, key)
	m.Write(data)
	return m.Sum(nil)
}

func hexSHA256(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func setHeader(req *Request, key, value string) {
	for i := range req.Headers {
		if strings.EqualFold(req.Headers[i].Key, key) {
			req.Headers[i].Value = value
			return
		}
	}
	req.Headers = append(req.Headers, Header{Key: key, Value: value})
}

func getHeader(headers []Header, key string) (string, bool) {
	for _, h := range headers {
		if strings.EqualFold(h.Key, key) {
			return h.Value, true
		}
	}
	return "", false
}
