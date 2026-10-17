// Package cookies 负责加载并维护抖音创作者中心（creator.douyin.com）的登录态。
//
// 支持三种输入格式：
//  1. 从浏览器 DevTools 复制的一整行 Cookie 头，例如 "sessionid=abc; ttwid=xyz; ..."
//  2. Netscape 格式的 cookies.txt（浏览器插件导出的通用格式）
//  3. 名为 key=value 的纯文本（每行一个，方便手工维护）
//
// 加载后的 Cookie 以「保持原始顺序」的方式保存：抖音的服务端会校验 Cookie 顺序，
// 重排后可能出现登录态异常，因此这里刻意不对 Cookie 排序。
package cookies

import (
	"bufio"
	"fmt"
	"os"
	"sort"
	"strings"
)

// Jar 保存一组 cookie，并保持首次出现的顺序。
type Jar struct {
	order []string
	value map[string]string
}

// New 返回一个空的 Jar。
func New() *Jar {
	return &Jar{value: make(map[string]string)}
}

// Set 写入或覆盖一个 cookie。首次写入的键决定其在 Cookie 头中的位置。
func (j *Jar) Set(name, value string) {
	if _, ok := j.value[name]; !ok {
		j.order = append(j.order, name)
	}
	j.value[name] = value
}

// Get 返回 cookie 值，第二个返回值表示是否存在。
func (j *Jar) Get(name string) (string, bool) {
	v, ok := j.value[name]
	return v, ok
}

// Names 返回全部 cookie 名（按 Cookie 头中的顺序）。
func (j *Jar) Names() []string {
	out := make([]string, len(j.order))
	copy(out, j.order)
	return out
}

// Len 返回 cookie 数量。
func (j *Jar) Len() int { return len(j.order) }

// Header 渲染成可直接放进 HTTP 请求的 Cookie 头值。
func (j *Jar) Header() string {
	parts := make([]string, 0, len(j.order))
	for _, name := range j.order {
		parts = append(parts, name+"="+j.value[name])
	}
	return strings.Join(parts, "; ")
}

// String 实现 fmt.Stringer，但会隐藏凭据类字段，避免日志泄漏登录态。
//
// 屏蔽范围是「能被用来冒充身份」的字段：会话凭据、设备标识与 passport token。
// 其余 cookie（如 gd_random、browser 偏好）保留原值，方便排查问题。
func (j *Jar) String() string {
	const mask = "****"
	sensitive := []string{
		// 会话凭据
		"sessionid", "sessionid_ss", "sid_tt", "sid_guard", "uid_tt", "uid_tt_ss",
		"sso_uid_tt", "sso_uid_tt_ss",
		// 设备指纹，服务端会用于校验请求来源
		"ttwid", "odin_tt", "tt_webid", "tt_webid_v2", "msToken",
		// passport 侧 token
		"passport_csrf_token", "passport_csrf_token_default", "passport_auth_status",
	}
	isSensitive := func(name string) bool {
		lower := strings.ToLower(name)
		for _, s := range sensitive {
			if lower == strings.ToLower(s) || strings.HasPrefix(lower, strings.ToLower(s)+"_") {
				return true
			}
		}
		return false
	}
	parts := make([]string, 0, len(j.order))
	for _, name := range j.order {
		v := j.value[name]
		if isSensitive(name) {
			v = mask
		}
		parts = append(parts, name+"="+v)
	}
	return strings.Join(parts, "; ")
}

// LoadFile 从磁盘加载 cookie。自动识别 Netscape cookies.txt 与简易 key=value 文本。
func LoadFile(path string) (*Jar, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读取 cookie 文件失败: %w", err)
	}
	text := string(raw)
	if strings.Contains(text, "Netscape HTTP Cookie File") || strings.Contains(text, "\tTRUE\t") || strings.Contains(text, "\tFALSE\t") {
		return ParseNetscape(text)
	}
	return ParseCookieHeader(text)
}

// ParseCookieHeader 解析 "k=v; k2=v2" 形式（也可以是多行，每行一条 k=v）。
//
// 浏览器 DevTools 的 "Copy as cURL" 或 Application → Cookies 面板复制出来的内容都能直接用。
func ParseCookieHeader(text string) (*Jar, error) {
	jar := New()
	// 统一分隔符：分号、换行都视为 cookie 之间的分隔。
	text = strings.ReplaceAll(text, "\r\n", "\n")
	fields := strings.FieldsFunc(text, func(r rune) bool {
		return r == ';' || r == '\n'
	})
	skipped := 0
	for _, f := range fields {
		f = strings.TrimSpace(f)
		if f == "" {
			continue
		}
		// 允许整行带上 "Cookie: " 前缀。
		f = strings.TrimPrefix(f, "Cookie:")
		f = strings.TrimSpace(f)
		name, value, ok := strings.Cut(f, "=")
		if !ok {
			skipped++
			continue
		}
		name = strings.TrimSpace(name)
		if name == "" {
			skipped++
			continue
		}
		jar.Set(name, strings.TrimSpace(value))
	}
	if jar.Len() == 0 {
		return nil, fmt.Errorf("未从 cookie 文本中解析出任何 cookie（跳过了 %d 行）", skipped)
	}
	return jar, nil
}

// ParseNetscape 解析 Netscape cookies.txt 格式。
//
// 每行格式：domain  flag  path  secure  expiry  name  value
// 以 # 开头的行是注释；#HttpOnly_ 前缀需要保留域名解析。
func ParseNetscape(text string) (*Jar, error) {
	jar := New()
	sc := bufio.NewScanner(strings.NewReader(text))
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "#") && !strings.HasPrefix(line, "#HttpOnly_") {
			continue
		}
		line = strings.TrimPrefix(line, "#HttpOnly_")
		fields := strings.Split(line, "\t")
		if len(fields) < 7 {
			continue
		}
		name := strings.TrimSpace(fields[5])
		value := fields[6]
		if name == "" {
			continue
		}
		jar.Set(name, value)
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("扫描 cookie 文件失败: %w", err)
	}
	if jar.Len() == 0 {
		return nil, fmt.Errorf("未从 Netscape cookie 文件中解析出任何 cookie")
	}
	return jar, nil
}

// CSRF 用于返回可放进请求头的 CSRF token。
//
// 说明（务必阅读）：
//
//	创作者中心的 axios 实例配置为 xsrfCookieName="csrf_token"、xsrfHeaderName="X-CSRF-Token"，
//	即它从名为 csrf_token 的 cookie 取值并放到 X-CSRF-Token 头里。
//	抖音历史上也使用过 passport_csrf_token，因此这里按优先级依次探测，
//	并把「实际命中的 cookie 名」一并返回，便于排查问题。
//
// 该行为在未登录状态下无法验证，因此工具提供了 --csrf-cookie / --csrf-header 参数用于覆盖。
func (j *Jar) CSRF(candidates []string) (token, cookieName string, ok bool) {
	if len(candidates) == 0 {
		candidates = []string{"csrf_token", "passport_csrf_token", "passport_csrf_token_default"}
	}
	for _, name := range candidates {
		if v, found := j.Get(name); found && v != "" {
			return v, name, true
		}
	}
	return "", "", false
}

// SortedNames 返回排序后的 cookie 名，仅用于日志与调试输出。
func (j *Jar) SortedNames() []string {
	out := j.Names()
	sort.Strings(out)
	return out
}
