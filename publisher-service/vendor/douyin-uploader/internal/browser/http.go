package browser

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// httpClient 用于访问 CDP 的 HTTP 端点（/json/list、/json/version）。
//
// 刻意不使用环境里的 HTTP 代理：CDP 是本机回环地址，经代理会连不上。
var httpClient = &http.Client{
	Timeout: 10 * time.Second,
	Transport: &http.Transport{
		Proxy: nil,
	},
}

func httpGetJSON(ctx context.Context, url string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fmt.Errorf("构造请求失败: %w", err)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("请求 %s 失败: %w", url, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return fmt.Errorf("读取 %s 响应失败: %w", url, err)
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("请求 %s 返回 HTTP %d", url, resp.StatusCode)
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("解析 %s 响应失败: %w", url, err)
	}
	return nil
}

// Version 是 /json/version 的响应。
type Version struct {
	Browser              string `json:"Browser"`
	ProtocolVersion      string `json:"Protocol-Version"`
	WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
}

// GetVersion 读取 CDP 版本信息，可用于探测端口上是否真的有 Chrome。
func GetVersion(ctx context.Context, port int) (*Version, error) {
	var v Version
	if err := httpGetJSON(ctx, fmt.Sprintf("http://127.0.0.1:%d/json/version", port), &v); err != nil {
		return nil, err
	}
	return &v, nil
}

// WaitForPort 轮询等待 Chrome 的 CDP 端口就绪。
func WaitForPort(ctx context.Context, port int, timeout time.Duration) (*Version, error) {
	deadline := time.Now().Add(timeout)
	var lastErr error
	for time.Now().Before(deadline) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		v, err := GetVersion(ctx, port)
		if err == nil {
			return v, nil
		}
		lastErr = err
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
	return nil, fmt.Errorf("等待 CDP 端口 %d 超时（%s）: %w", port, timeout, lastErr)
}

// FindPageTarget 找到第一个 page 类型的目标。
func FindPageTarget(ctx context.Context, port int) (*Target, error) {
	targets, err := ListTargets(ctx, port)
	if err != nil {
		return nil, err
	}
	for i := range targets {
		if targets[i].Type == "page" && targets[i].WebSocketDebuggerURL != "" {
			return &targets[i], nil
		}
	}
	return nil, fmt.Errorf("CDP 端口 %d 上没有可用的 page 目标", port)
}
