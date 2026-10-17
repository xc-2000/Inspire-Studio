package creator

import (
	"net/http"
	"strings"
	"testing"
)

// TestHintForEmptyBody 403+空体是发布频率风控的特征，提示必须给出可操作步骤，
// 否则使用者会误判成签名/cookie 问题并反复重试，反而延长封禁。
func TestHintForEmptyBody(t *testing.T) {
	got := hintForEmptyBody(http.StatusForbidden)
	if got == "" {
		t.Fatal("403 应给出风控提示")
	}
	for _, want := range []string{"风控", "停止重试", "--dry-run"} {
		if !strings.Contains(got, want) {
			t.Errorf("403 提示应包含 %q，实际: %s", want, got)
		}
	}

	if got := hintForEmptyBody(http.StatusTooManyRequests); !strings.Contains(got, "限流") {
		t.Errorf("429 提示应提到限流，实际: %s", got)
	}

	// 无关状态码不应乱提示，避免误导。
	for _, s := range []int{http.StatusOK, http.StatusUnauthorized, http.StatusInternalServerError} {
		if got := hintForEmptyBody(s); got != "" {
			t.Errorf("状态码 %d 不应有提示，实际: %s", s, got)
		}
	}
}

// TestDescribeHeader 只摘取定位问题需要的头，且不泄漏无关信息。
func TestDescribeHeader(t *testing.T) {
	h := http.Header{}
	h.Set("Content-Type", "application/json")
	h.Set("Content-Length", "0")
	h.Set("Server", "Tengine")
	h.Set("X-Tt-Logid", "abc123")
	h.Set("Set-Cookie", "sessionid=SECRET")

	got := describeHeader(h)
	for _, want := range []string{"Content-Type=application/json", "Content-Length=0", "Server=Tengine", "X-Tt-Logid=abc123"} {
		if !strings.Contains(got, want) {
			t.Errorf("缺少 %q，实际: %s", want, got)
		}
	}
	// 绝不能把 Set-Cookie 带进错误信息。
	if strings.Contains(got, "SECRET") || strings.Contains(got, "Set-Cookie") {
		t.Errorf("错误信息泄漏了 cookie: %s", got)
	}

	if got := describeHeader(nil); got != "" {
		t.Errorf("nil header 应返回空串，实际: %q", got)
	}
	if got := describeHeader(http.Header{}); got != "" {
		t.Errorf("空 header 应返回空串，实际: %q", got)
	}
}
