package cookies

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// mustJar 解析 cookie 文本，失败即终止测试。
func mustJar(t *testing.T, text string) *Jar {
	t.Helper()
	jar, err := ParseCookieHeader(text)
	if err != nil {
		t.Fatalf("解析 %q 失败: %v", text, err)
	}
	return jar
}

func TestParseCookieHeader(t *testing.T) {
	jar := mustJar(t, "a=1; b=2; c=3")
	if jar.Len() != 3 {
		t.Fatalf("cookie 数量 = %d", jar.Len())
	}
	if v, ok := jar.Get("b"); !ok || v != "2" {
		t.Errorf("b = %q, %v", v, ok)
	}
	want := "a=1; b=2; c=3"
	if got := jar.Header(); got != want {
		t.Errorf("Header() = %q, 期望 %q", got, want)
	}
}

func TestParseCookieHeaderToleratesWhitespace(t *testing.T) {
	jar := mustJar(t, "  a=1 ;b=2;  ; c = 3 ")
	// 空格包裹的 key 与 value 应被规整；空片段应被忽略。
	if v, ok := jar.Get("a"); !ok || v != "1" {
		t.Errorf("a = %q, %v", v, ok)
	}
	if v, ok := jar.Get("c"); !ok || v != "3" {
		t.Errorf("c = %q, %v", v, ok)
	}
}

func TestParseCookieHeaderKeepsEqualsInValue(t *testing.T) {
	// value 内部的 = 不能被当作分隔符（base64 常见）。
	jar := mustJar(t, "token=abc=def==")
	if v, ok := jar.Get("token"); !ok || v != "abc=def==" {
		t.Errorf("token = %q, %v", v, ok)
	}
}

func TestInsertionOrderPreserved(t *testing.T) {
	jar := mustJar(t, "z=1; a=2; m=3")
	if got := jar.Header(); got != "z=1; a=2; m=3" {
		t.Errorf("Header() = %q，插入顺序未保持", got)
	}
}

func TestSetReplacesWithoutReorder(t *testing.T) {
	jar := mustJar(t, "a=1; b=2")
	jar.Set("a", "9")
	if got := jar.Header(); got != "a=9; b=2" {
		t.Errorf("Header() = %q", got)
	}
	jar.Set("c", "3")
	if got := jar.Header(); got != "a=9; b=2; c=3" {
		t.Errorf("Header() = %q", got)
	}
}

func TestParseNetscape(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "cookie.txt")
	content := strings.Join([]string{
		"# Netscape HTTP Cookie File",
		".douyin.com\tTRUE\t/\tTRUE\t1800000000\tsessionid\tsecret-value",
		"creator.douyin.com\tFALSE\t/\tFALSE\t1800000000\tttwid\ttwid-value",
		"#HttpOnly_.douyin.com\tTRUE\t/\tTRUE\t1800000000\tHttpOnlyOnly\thv",
		"",
	}, "\n")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	jar, err := LoadFile(path)
	if err != nil {
		t.Fatalf("加载失败: %v", err)
	}
	// 3 个 cookie（1 个带 #HttpOnly_ 前缀）。
	if jar.Len() != 3 {
		t.Fatalf("cookie 数量 = %d，名单: %v", jar.Len(), jar.SortedNames())
	}
	if v, ok := jar.Get("sessionid"); !ok || v != "secret-value" {
		t.Errorf("sessionid = %q, %v", v, ok)
	}
	// #HttpOnly_ 前缀必须被剥掉，否则字段名就错了。
	if v, ok := jar.Get("HttpOnlyOnly"); !ok || v != "hv" {
		t.Errorf("HttpOnlyOnly = %q, %v（名单: %v）", v, ok, jar.SortedNames())
	}
}

func TestParseNetscapeRejectsGarbage(t *testing.T) {
	if _, err := ParseNetscape("not a netscape file\njust text\n"); err == nil {
		t.Error("非 Netscape 文件应报错")
	}
}

func TestLoadFilePlainText(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "cookie.txt")
	// 纯文本形式（浏览器里 document.cookie 的复制粘贴结果）。
	if err := os.WriteFile(path, []byte("a=1; b=2\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	jar, err := LoadFile(path)
	if err != nil {
		t.Fatalf("加载失败: %v", err)
	}
	if jar.Len() != 2 {
		t.Fatalf("cookie 数量 = %d", jar.Len())
	}
}

func TestLoadFileMissing(t *testing.T) {
	if _, err := LoadFile(filepath.Join(t.TempDir(), "nope.txt")); err == nil {
		t.Error("文件不存在应报错")
	}
}

func TestLoadFileEmpty(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "empty.txt")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadFile(path); err == nil {
		t.Error("空文件应报错")
	}
}

// TestStringMasksSecrets 确保日志输出不会泄露会话凭据。
func TestStringMasksSecrets(t *testing.T) {
	jar := mustJar(t, "sessionid=SUPERSECRETVALUE; ttwid=anothersecret; normal=ok")
	out := jar.String()

	for _, secret := range []string{"SUPERSECRETVALUE", "anothersecret"} {
		if strings.Contains(out, secret) {
			t.Errorf("String() 泄露了敏感值 %q: %s", secret, out)
		}
	}
	if !strings.Contains(out, "normal=ok") {
		t.Errorf("普通 cookie 不应被屏蔽: %s", out)
	}
}

func TestCSRFPicksFirstAvailable(t *testing.T) {
	jar := mustJar(t, "csrf_token=ct; passport_csrf_token=pct")
	if tok, name, ok := jar.CSRF(nil); !ok || tok != "ct" || name != "csrf_token" {
		t.Errorf("默认优先级错误: %q %q %v", tok, name, ok)
	}
	// 显式指定时以指定项为准。
	if tok, _, ok := jar.CSRF([]string{"passport_csrf_token"}); !ok || tok != "pct" {
		t.Errorf("显式指定失败: %q", tok)
	}
	// 都不存在时返回 false。
	empty := mustJar(t, "a=1")
	if _, _, ok := empty.CSRF(nil); ok {
		t.Error("无 CSRF cookie 时应返回 false")
	}
}

func TestNamesAndSortedNames(t *testing.T) {
	jar := mustJar(t, "z=1; a=2")
	if got := jar.Names(); len(got) != 2 || got[0] != "z" {
		t.Errorf("Names() = %v", got)
	}
	if got := jar.SortedNames(); len(got) != 2 || got[0] != "a" || got[1] != "z" {
		t.Errorf("SortedNames() = %v", got)
	}
}
