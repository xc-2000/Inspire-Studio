// Package browser 提供一个最小可用的 Chrome DevTools Protocol 客户端。
//
// 之所以自己实现而不用 chromedp：本机 Go 模块代理不可用，只能使用已缓存的
// gorilla/websocket。CDP 的命令/事件模型很简单，够用即可。
package browser

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Event 是一个 CDP 事件。
type Event struct {
	Method string
	Params json.RawMessage
}

// result 是一次命令调用的结果。
type result struct {
	Raw json.RawMessage
	Err error
}

// Conn 是单个 CDP 目标（page）的连接。
type Conn struct {
	conn *websocket.Conn

	writeMu sync.Mutex
	mu      sync.Mutex
	nextID  int64
	waits   map[int64]chan result

	evMu sync.Mutex
	evs  []chan Event

	closeOnce sync.Once
	closed    chan struct{}
	readErr   error
}

// Dial 连接到一个 CDP 目标。
func Dial(ctx context.Context, wsURL string) (*Conn, error) {
	d := websocket.Dialer{HandshakeTimeout: 15 * time.Second}
	conn, resp, err := d.DialContext(ctx, wsURL, nil)
	if err != nil {
		if resp != nil {
			return nil, fmt.Errorf("连接 CDP 失败（HTTP %d）: %w", resp.StatusCode, err)
		}
		return nil, fmt.Errorf("连接 CDP 失败: %w", err)
	}
	// CDP 的消息可能很大（截图、DOM 等），放宽读取上限。
	conn.SetReadLimit(64 << 20)

	c := &Conn{
		conn:   conn,
		waits:  make(map[int64]chan result),
		closed: make(chan struct{}),
	}
	go c.readLoop()
	return c, nil
}

// Close 关闭连接。
func (c *Conn) Close() error {
	var err error
	c.closeOnce.Do(func() {
		close(c.closed)
		err = c.conn.Close()
	})
	return err
}

// Done 在连接关闭时关闭。
func (c *Conn) Done() <-chan struct{} { return c.closed }

// Err 返回读循环终止的原因。
func (c *Conn) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.readErr
}

func (c *Conn) readLoop() {
	defer func() {
		c.closeOnce.Do(func() { close(c.closed) })
		// 唤醒所有等待者，避免调用方永久阻塞。
		c.mu.Lock()
		for id, ch := range c.waits {
			close(ch)
			delete(c.waits, id)
		}
		c.mu.Unlock()
	}()

	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			c.mu.Lock()
			c.readErr = err
			c.mu.Unlock()
			return
		}
		var head struct {
			ID     *int64          `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(data, &head); err != nil {
			continue
		}
		switch {
		case head.ID != nil && head.Method == "":
			c.mu.Lock()
			ch := c.waits[*head.ID]
			delete(c.waits, *head.ID)
			c.mu.Unlock()
			if ch == nil {
				continue
			}
			if head.Error != nil {
				ch <- result{Err: fmt.Errorf("CDP 错误 %d: %s", head.Error.Code, head.Error.Message)}
			} else {
				ch <- result{Raw: head.Result}
			}
		case head.Method != "":
			c.evMu.Lock()
			subs := append([]chan Event(nil), c.evs...)
			c.evMu.Unlock()
			for _, s := range subs {
				select {
				case s <- Event{Method: head.Method, Params: head.Params}:
				default: // 订阅者落后就丢弃，避免阻塞读循环
				}
			}
		}
	}
}

// Send 发送一条命令并等待结果。
func (c *Conn) Send(ctx context.Context, method string, params any) (json.RawMessage, error) {
	c.mu.Lock()
	c.nextID++
	id := c.nextID
	ch := make(chan result, 1)
	c.waits[id] = ch
	c.mu.Unlock()

	payload, err := json.Marshal(map[string]any{"id": id, "method": method, "params": params})
	if err != nil {
		c.mu.Lock()
		delete(c.waits, id)
		c.mu.Unlock()
		return nil, fmt.Errorf("序列化 CDP 命令失败: %w", err)
	}

	c.writeMu.Lock()
	err = c.conn.WriteMessage(websocket.TextMessage, payload)
	c.writeMu.Unlock()
	if err != nil {
		c.mu.Lock()
		delete(c.waits, id)
		c.mu.Unlock()
		return nil, fmt.Errorf("写入 CDP 命令失败: %w", err)
	}

	select {
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.waits, id)
		c.mu.Unlock()
		return nil, ctx.Err()
	case <-c.closed:
		return nil, fmt.Errorf("CDP 连接已关闭: %w", c.Err())
	case r, ok := <-ch:
		if !ok {
			return nil, fmt.Errorf("CDP 连接已关闭: %w", c.Err())
		}
		return r.Raw, r.Err
	}
}

// Subscribe 注册一个事件订阅。返回的 cancel 用于注销。
func (c *Conn) Subscribe() (<-chan Event, func()) {
	ch := make(chan Event, 512)
	c.evMu.Lock()
	c.evs = append(c.evs, ch)
	c.evMu.Unlock()
	return ch, func() {
		c.evMu.Lock()
		defer c.evMu.Unlock()
		for i, s := range c.evs {
			if s == ch {
				c.evs = append(c.evs[:i], c.evs[i+1:]...)
				return
			}
		}
	}
}

// EvalResult 是 Runtime.evaluate 的结果。
type EvalResult struct {
	Value           json.RawMessage
	ExceptionString string
}

// Eval 在页面里求值一个表达式。
//
// awaitPromise 为 true 时，若表达式返回 Promise，会等待其 resolve。
func (c *Conn) Eval(ctx context.Context, expr string, awaitPromise bool) (*EvalResult, error) {
	raw, err := c.Send(ctx, "Runtime.evaluate", map[string]any{
		"expression":    expr,
		"returnByValue": true,
		"awaitPromise":  awaitPromise,
	})
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Result struct {
			Value json.RawMessage `json:"value"`
		} `json:"result"`
		ExceptionDetails *struct {
			Text      string `json:"text"`
			Exception *struct {
				Description string `json:"description"`
			} `json:"exception"`
		} `json:"exceptionDetails"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("解析 evaluate 结果失败: %w", err)
	}
	out := &EvalResult{Value: parsed.Result.Value}
	if parsed.ExceptionDetails != nil {
		out.ExceptionString = parsed.ExceptionDetails.Text
		if parsed.ExceptionDetails.Exception != nil && parsed.ExceptionDetails.Exception.Description != "" {
			out.ExceptionString = parsed.ExceptionDetails.Exception.Description
		}
	}
	return out, nil
}

// ListTargets 列出浏览器里的所有目标。
func ListTargets(ctx context.Context, port int) ([]Target, error) {
	var out []Target
	if err := httpGetJSON(ctx, fmt.Sprintf("http://127.0.0.1:%d/json/list", port), &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Target 是一个 CDP 目标。
type Target struct {
	ID                   string `json:"id"`
	Type                 string `json:"type"`
	Title                string `json:"title"`
	URL                  string `json:"url"`
	WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
}
