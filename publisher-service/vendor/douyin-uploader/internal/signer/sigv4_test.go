package signer

import (
	"testing"
	"time"
)

// getV4TestSuite 对应 AWS 官方的 SigV4 测试向量
// （aws-sig-v4-test-suite 的 get-vanilla 用例）。
//
// 这是验证实现正确性最关键的一组断言：如果 canonical request 或
// 密钥派生的任一环节有偏差，签名就对不上，TOS 会直接返回 403。
func TestSignV4GetVanilla(t *testing.T) {
	creds := Credentials{
		AccessKeyID:     "AKIDEXAMPLE",
		SecretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
	}
	req := &Request{
		Method:  "GET",
		Path:    "/",
		Headers: []Header{{Key: "Host", Value: "example.amazonaws.com"}},
	}
	// 官方用例时间：2015-08-30T12:36:00Z
	ts := time.Date(2015, 8, 30, 12, 36, 0, 0, time.UTC)

	signed, err := Sign(req, creds, "us-east-1", "service", ts)
	if err != nil {
		t.Fatalf("Sign 失败: %v", err)
	}

	wantAuth := "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
		"SignedHeaders=host;x-amz-date, " +
		"Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
	if signed.Authorization != wantAuth {
		t.Errorf("Authorization 不匹配\n实际: %s\n期望: %s", signed.Authorization, wantAuth)
	}

	if got, want := signed.AmzDate, "20150830T123600Z"; got != want {
		t.Errorf("AmzDate = %q, 期望 %q", got, want)
	}
	if got, want := signed.CredentialScope, "20150830/us-east-1/service/aws4_request"; got != want {
		t.Errorf("CredentialScope = %q, 期望 %q", got, want)
	}
}

// TestDeriveSigningKey 对照 AWS 文档给出的中间值。
func TestDeriveSigningKey(t *testing.T) {
	secret := "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"
	key := deriveSigningKey(secret, "20120215", "us-east-1", "iam")
	// AWS 文档《Task 3》给出的最终签名密钥。
	want := "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d"
	if got := toHex(key); got != want {
		t.Errorf("派生密钥 = %s, 期望 %s", got, want)
	}
}

// TestCanonicalQueryStringSorting 验证查询串按 key 再按 value 排序，
// 值也需要做 URI 编码。
func TestCanonicalQueryStringSorting(t *testing.T) {
	params := []Param{
		{"b", "2"},
		{"a", "1"},
		{"Action", "ApplyUploadInner"},
	}
	got := CanonicalQueryString(params)
	want := "Action=ApplyUploadInner&a=1&b=2"
	if got != want {
		t.Errorf("CanonicalQueryString = %q, 期望 %q", got, want)
	}
}

// TestCanonicalQueryStringEncodesValues 验证值里的特殊字符被编码。
func TestCanonicalQueryStringEncodesValues(t *testing.T) {
	got := CanonicalQueryString([]Param{{"SpaceName", "aweme"}, {"k", "a b"}})
	want := "SpaceName=aweme&k=a%20b"
	if got != want {
		t.Errorf("CanonicalQueryString = %q, 期望 %q", got, want)
	}
}

// TestUnsignedHeadersExcluded 验证 Content-Type / User-Agent 等不参与签名。
func TestUnsignedHeadersExcluded(t *testing.T) {
	headers := []Header{
		{Key: "Host", Value: "example.com"},
		{Key: "Content-Type", Value: "application/json"},
		{Key: "Content-Length", Value: "12"},
		{Key: "User-Agent", Value: "test/1.0"},
		{Key: "Authorization", Value: "should-be-ignored"},
	}
	got := signableHeaderNames(headers)
	want := []string{"host"}
	if len(got) != len(want) || got[0] != want[0] {
		t.Errorf("参与签名的头 = %v, 期望 %v", got, want)
	}
}

// TestXAmzHeadersAlwaysSigned 验证 x-amz-* 一律参与签名。
//
// 注意 x-amzn-trace-id 是例外：它并不以 "x-amz-" 开头（是 "x-amzn-"），
// 因此仍落在剔除清单里。原 SDK 的判断是 indexOf("x-amz-")===0，不是前缀包含。
func TestXAmzHeadersAlwaysSigned(t *testing.T) {
	headers := []Header{
		{Key: "X-Amz-Date", Value: "20150830T123600Z"},
		{Key: "x-amz-security-token", Value: "tok"},
		{Key: "X-Amz-Content-Sha256", Value: "hash"},
		{Key: "X-Amzn-Trace-Id", Value: "Root=1"},
	}
	got := signableHeaderNames(headers)
	want := map[string]bool{
		"x-amz-date":           true,
		"x-amz-security-token": true,
		"x-amz-content-sha256": true,
	}
	if len(got) != len(want) {
		t.Fatalf("参与签名的头 = %v, 期望 %d 个", got, len(want))
	}
	for _, h := range got {
		if !want[h] {
			t.Errorf("不应参与签名: %s", h)
		}
	}
}

// TestEmptyBodyHash 无请求体时必须是 SHA256("") 的十六进制值。
func TestEmptyBodyHash(t *testing.T) {
	got := hexSHA256(nil)
	want := "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	if got != want {
		t.Errorf("空 body 哈希 = %s, 期望 %s", got, want)
	}
}

// TestSignRequiresCredentials 缺少凭据时必须报错而不是发出无效签名。
func TestSignRequiresCredentials(t *testing.T) {
	_, err := Sign(&Request{Method: "GET", Path: "/"}, Credentials{}, "cn-north-1", "vod", time.Now())
	if err == nil {
		t.Error("缺少凭据时应返回错误")
	}
}

func toHex(b []byte) string {
	const hexdigits = "0123456789abcdef"
	out := make([]byte, 0, len(b)*2)
	for _, c := range b {
		out = append(out, hexdigits[c>>4], hexdigits[c&0x0f])
	}
	return string(out)
}
