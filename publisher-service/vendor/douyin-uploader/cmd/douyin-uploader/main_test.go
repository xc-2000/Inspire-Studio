package main

import (
	"testing"

	"douyin-uploader/internal/publish"
)

// TestParseVisibility 可见性取值直接决定作品是否公开，映射错会把私密作品发成公开。
func TestParseVisibility(t *testing.T) {
	cases := []struct {
		in   string
		want int
	}{
		// 空值必须落到公开以外的「安全默认」需要显式决策，
		// 这里与官方 Web 端一致：默认公开。
		{"", publish.VisibilityPublic},
		{"public", publish.VisibilityPublic},
		{"PUBLIC", publish.VisibilityPublic},
		{"  public  ", publish.VisibilityPublic},
		{"公开", publish.VisibilityPublic},
		{"private", publish.VisibilityPrivate},
		{"self", publish.VisibilityPrivate},
		{"仅自己", publish.VisibilityPrivate},
		{"仅自己可见", publish.VisibilityPrivate},
		{"fans", publish.VisibilityFans},
		{"friend", publish.VisibilityFans},
		{"好友", publish.VisibilityFans},
		{"好友可见", publish.VisibilityFans},
	}
	for _, c := range cases {
		got, err := parseVisibility(c.in)
		if err != nil {
			t.Errorf("parseVisibility(%q) 报错: %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("parseVisibility(%q) = %d, 期望 %d", c.in, got, c.want)
		}
	}
}

func TestParseVisibilityRejectsUnknown(t *testing.T) {
	for _, s := range []string{"102", "140", "145", "secret", "公开全部"} {
		if _, err := parseVisibility(s); err == nil {
			t.Errorf("parseVisibility(%q) 应报错（旧的 102/140/145 枚举属于别的接口）", s)
		}
	}
}

func TestSplitList(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"", nil},
		{"a.jpg", []string{"a.jpg"}},
		{"a.jpg,b.jpg", []string{"a.jpg", "b.jpg"}},
		{" a.jpg , b.jpg ", []string{"a.jpg", "b.jpg"}},
		// 空段应被丢弃，否则会当成空路径去读文件。
		{"a.jpg,,b.jpg", []string{"a.jpg", "b.jpg"}},
		{"a.jpg,", []string{"a.jpg"}},
		{",,", nil},
	}
	for _, c := range cases {
		got := splitList(c.in)
		if len(got) != len(c.want) {
			t.Errorf("splitList(%q) = %v, 期望 %v", c.in, got, c.want)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("splitList(%q)[%d] = %q, 期望 %q", c.in, i, got[i], c.want[i])
			}
		}
	}
}

// TestMask 只保留头尾，用于日志里展示 AccessKeyId 而不泄漏完整值。
func TestMask(t *testing.T) {
	if got := mask("AKID1234567890"); got != "AKID...7890" {
		t.Errorf("mask = %q", got)
	}
	// 短串全部打码，避免泄漏。
	if got := mask("abc"); got != "***" {
		t.Errorf("mask(短串) = %q, 期望全打码", got)
	}
	if got := mask(""); got != "" {
		t.Errorf("mask(\"\") = %q", got)
	}
}
