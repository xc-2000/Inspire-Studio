package app

import (
	"strings"
	"testing"
)

// TestMatchDomainApp 与 browser 包内的同名函数职责相同，
// 但这里额外接受 douyin.com 主域（部分 cookie 挂在主域上）。
func TestMatchDomainApp(t *testing.T) {
	cases := []struct {
		domain, host string
		want         bool
	}{
		{".douyin.com", "creator.douyin.com", true},
		{".douyin.com", "douyin.com", true},
		{"douyin.com", "creator.douyin.com", true},
		{".DOUYIN.com", "creator.douyin.com", true},
		{"example.com", "creator.douyin.com", false},
		// 反向不成立。
		{"creator.douyin.com", "douyin.com", false},
		// 点边界：evil-douyin.com 不是 douyin.com 的子域。
		{"douyin.com", "evil-douyin.com", false},
		{"", "douyin.com", false},
		{".", "douyin.com", false},
	}
	for _, c := range cases {
		if got := matchDomain(c.domain, c.host); got != c.want {
			t.Errorf("matchDomain(%q, %q) = %v, 期望 %v", c.domain, c.host, got, c.want)
		}
	}
}

// TestRandomCreationID 是发布请求的幂等标识，必须每次都不同且非空。
func TestRandomCreationID(t *testing.T) {
	seen := make(map[string]bool)
	for i := 0; i < 200; i++ {
		id := randomCreationID()
		if id == "" {
			t.Fatal("creation_id 不应为空")
		}
		if strings.ContainsAny(id, " \t\n") {
			t.Errorf("creation_id 不应含空白字符: %q", id)
		}
		if seen[id] {
			t.Fatalf("creation_id 重复: %q（连续调用必须唯一，否则发布会被判重）", id)
		}
		seen[id] = true
	}
}
