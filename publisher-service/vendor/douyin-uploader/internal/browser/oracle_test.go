package browser

import (
	"strings"
	"testing"
	"time"
)

// TestCookieMatchesDomain cookie 取错域会导致登录态残缺或把无关域的 cookie 混进来。
func TestCookieMatchesDomain(t *testing.T) {
	cases := []struct {
		domain, host string
		want         bool
	}{
		// 主域 cookie 必须覆盖子域（抖音的 sessionid 就挂在 .douyin.com）。
		{".douyin.com", "creator.douyin.com", true},
		{"douyin.com", "douyin.com", true},
		{".douyin.com", "douyin.com", true},
		// 大小写要容错；前导点只剥一个。
		{".DOUYIN.com", "Creator.DouYin.com", true},
		// 双点域是畸形输入：剥掉一个前导点后剩 ".douyin.com"，
		// 拼出的 "..douyin.com" 无法匹配——拒绝它是正确行为。
		{"..douyin.com", "creator.douyin.com", false},
		// 不相干的域必须排除。
		{"example.com", "creator.douyin.com", false},
		{"douyin.com", "creator.douyin.com", true},
		// 反向不成立：子域 cookie 不应覆盖父域。
		{"creator.douyin.com", "douyin.com", false},
		{"live.douyin.com", "creator.douyin.com", false},
		// 后缀必须落在「点」边界上，否则 evil-douyin.com 会被误判。
		{"douyin.com", "evil-douyin.com", false},
		{"douyin.com", "notdouyin.com", false},
		// 空域不可匹配。
		{"", "douyin.com", false},
		{".", "douyin.com", false},
	}
	for _, c := range cases {
		if got := cookieMatchesDomain(c.domain, c.host); got != c.want {
			t.Errorf("cookieMatchesDomain(%q, %q) = %v, 期望 %v", c.domain, c.host, got, c.want)
		}
	}
}

// TestBuildDoJS 生成的 JS 必须是合法 Promise 表达式，且把入参安全嵌入。
//
// 这里不执行 JS（无浏览器），只校验转义与结构：拼接错误会让签名通道静默失效。
func TestBuildDoJS(t *testing.T) {
	js, err := buildDoJS("POST", "https://creator.douyin.com/web/api/media/aweme/create_v2/?read_aid=2906",
		[]byte(`{"item":{"common":{"text":"你好"}}}`),
		map[string]string{"Content-Type": "application/json"},
		30*time.Second)
	if err != nil {
		t.Fatalf("构建失败: %v", err)
	}

	if !strings.HasPrefix(js, "new Promise(") {
		t.Errorf("应以 new Promise( 开头，实际前 40 字符: %.40s", js)
	}
	if !strings.HasSuffix(js, "})") {
		t.Errorf("应以 }) 结尾，实际后 20 字符: %s", js[len(js)-20:])
	}

	// 方法名与 URL 必须以 JSON 字面量形式出现（带引号），而不是裸拼接。
	if !strings.Contains(js, `"POST"`) {
		t.Error("method 应作为 JSON 字符串嵌入")
	}
	if !strings.Contains(js, `"https://creator.douyin.com/web/api/media/aweme/create_v2/?read_aid=2906"`) {
		t.Error("url 未正确嵌入")
	}
	// 中文必须保留（JSON 默认不转义非 ASCII），否则 body 会被改坏。
	if !strings.Contains(js, "你好") {
		t.Error("body 中的中文丢失")
	}
	// 超时同时用于 setTimeout 与 xhr.timeout。
	if strings.Count(js, "30000") < 2 {
		t.Errorf("超时毫秒数应出现至少两次，实际: %s", js)
	}
}

// TestBuildDoJSHandlesNilBody GET 类请求没有 body，应嵌入空串而非字面 null。
func TestBuildDoJSHandlesNilBody(t *testing.T) {
	js, err := buildDoJS("GET", "https://creator.douyin.com/x", nil, nil, 5*time.Second)
	if err != nil {
		t.Fatalf("构建失败: %v", err)
	}
	if !strings.Contains(js, `x.send("")`) {
		t.Errorf("nil body 应嵌入空字符串，实际: %s", js)
	}
}

// TestBuildDoJSEscapesTrickyValues 引号/反斜杠/换行必须被转义，否则会拼出语法错误或注入。
func TestBuildDoJSEscapesTrickyValues(t *testing.T) {
	js, err := buildDoJS("POST", "https://creator.douyin.com/x?a=\"q\"&b=\\",
		[]byte("line1\nline2\t\"end\""),
		map[string]string{"X-Odd": "a\"b\\c\nd"},
		5*time.Second)
	if err != nil {
		t.Fatalf("构建失败: %v", err)
	}
	// 原始换行若未经转义直接进入 JS 源码，字面量会被截断。
	if strings.Contains(js, "line1\nline2") {
		t.Error("body 中的换行未转义，会破坏 JS 字符串字面量")
	}
	if !strings.Contains(js, `\n`) || !strings.Contains(js, `\"`) {
		t.Errorf("应包含转义后的换行与引号，实际: %s", js)
	}
}
