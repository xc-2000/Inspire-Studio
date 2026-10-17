package app

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"douyin-uploader/internal/browser"
)

// ExportCookies 从已运行的 Chrome 里导出创作者中心的 cookie。
//
// 必须走 CDP 而不是 document.cookie：会话 cookie（如 sessionid）通常带 HttpOnly，
// JS 读不到，而接口调用恰恰需要它们。
//
// 返回 cookie 文本、数量与错误。
func ExportCookies(ctx context.Context, port int) (string, int, error) {
	if port <= 0 {
		port = 9401
	}
	if _, err := browser.WaitForPort(ctx, port, 30*time.Second); err != nil {
		return "", 0, fmt.Errorf("未检测到端口 %d 上的 Chrome：%w\n"+
			"请先用该端口启动 Chrome 并登录创作者中心：\n"+
			"  chrome.exe --remote-debugging-port=%d --user-data-dir=<目录> %s",
			port, err, port, browser.DefaultReadyURL)
	}
	target, err := browser.FindPageTarget(ctx, port)
	if err != nil {
		return "", 0, err
	}
	conn, err := browser.Dial(ctx, target.WebSocketDebuggerURL)
	if err != nil {
		return "", 0, err
	}
	defer conn.Close()

	raw, err := conn.Send(ctx, "Network.enable", nil)
	if err != nil {
		return "", 0, err
	}
	_ = raw

	raw, err = conn.Send(ctx, "Network.getAllCookies", nil)
	if err != nil {
		return "", 0, err
	}
	var parsed struct {
		Cookies []browser.Cookie `json:"cookies"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", 0, fmt.Errorf("解析 cookie 失败: %w", err)
	}

	var kept []browser.Cookie
	for _, c := range parsed.Cookies {
		if matchDomain(c.Domain, "creator.douyin.com") || matchDomain(c.Domain, "douyin.com") {
			kept = append(kept, c)
		}
	}
	if len(kept) == 0 {
		return "", 0, fmt.Errorf("没有找到 creator.douyin.com 的 cookie。请确认已在该浏览器里登录抖音创作者中心")
	}
	sort.Slice(kept, func(i, j int) bool { return kept[i].Name < kept[j].Name })

	var b strings.Builder
	b.WriteString("# 由 douyin-uploader cookie-export 从 Chrome 导出\n")
	b.WriteString("# 格式：Netscape HTTP Cookie File（每行 domain/flag/path/secure/expires/name/value）\n")
	for _, c := range kept {
		domain := c.Domain
		flag := "FALSE"
		if strings.HasPrefix(domain, ".") {
			flag = "TRUE"
		}
		secure := "FALSE"
		if c.Secure {
			secure = "TRUE"
		}
		expires := int64(c.Expires)
		if expires <= 0 {
			expires = 0
		}
		path := c.Path
		if path == "" {
			path = "/"
		}
		prefix := ""
		if c.HTTPOnly {
			prefix = "#HttpOnly_"
		}
		fmt.Fprintf(&b, "%s%s\t%s\t%s\t%s\t%d\t%s\t%s\n",
			prefix, domain, flag, path, secure, expires, c.Name, c.Value)
	}
	return b.String(), len(kept), nil
}

// matchDomain 判断 cookie 域是否适用于目标域。
func matchDomain(cookieDomain, host string) bool {
	d := strings.TrimPrefix(strings.ToLower(cookieDomain), ".")
	if d == "" {
		return false
	}
	return host == d || strings.HasSuffix(host, "."+d)
}
