package browser

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"
)

// CreatorOrigin 是创作者中心的站点根地址。
const CreatorOrigin = "https://creator.douyin.com"

// 默认的创作者中心「上传页」。必须停在这个页面，SDK 才会完成对
// XMLHttpRequest 的 monkey-patch；一旦导航到别的域，补丁就失效。
const DefaultReadyURL = CreatorOrigin + "/creator-micro/content/upload"

// OracleOptions 是 Oracle 的配置。
type OracleOptions struct {
	// Port 是 Chrome 的远程调试端口。
	Port int
	// ReadyURL 用于让 SDK 完成初始化；留空取 DefaultReadyURL。
	ReadyURL string
	// ReadyTimeout 是等待 SDK 打补丁的最长时间。
	ReadyTimeout time.Duration
	// RequestTimeout 是单次页面内请求的超时。
	RequestTimeout time.Duration
	// Debug 打开后会把探测结果打印到日志回调。
	Debug func(format string, args ...any)
}

// Oracle 利用真实浏览器页面的签名 SDK 发起已签名请求。
//
// 设计要点（来自实测结论，勿轻易改动）：
//   - a_bogus 由 SDK 对 XMLHttpRequest 的 monkey-patch 在 send 时实时追加，
//     且每个请求都不同，无法缓存，也无法用纯 Go 复刻。
//   - 绝对不要覆盖页面里的 XMLHttpRequest.prototype.open/send 或 window.fetch，
//     否则签名会「静默消失」：请求仍返回 200，但不再带 a_bogus，且不报任何错。
//   - 因此本实现把真实请求交给页面执行，而不是去替换它的 XHR。
//
// 所有导出方法都是串行化的：Fetch 拦截与签名过程都不支持并发。
type Oracle struct {
	opts OracleOptions
	conn *Conn

	mu      sync.Mutex
	ready   bool
	lastURL string
}

// Attach 连接到一个已在运行的、带远程调试端口的 Chrome，并等待 SDK 就绪。
//
// 若页面不在创作者中心，会先导航过去。
func Attach(ctx context.Context, opts OracleOptions) (*Oracle, error) {
	if opts.Port <= 0 {
		return nil, fmt.Errorf("必须指定 Chrome 远程调试端口")
	}
	if opts.ReadyURL == "" {
		opts.ReadyURL = DefaultReadyURL
	}
	if opts.ReadyTimeout <= 0 {
		opts.ReadyTimeout = 90 * time.Second
	}
	if opts.RequestTimeout <= 0 {
		opts.RequestTimeout = 45 * time.Second
	}

	if _, err := WaitForPort(ctx, opts.Port, 30*time.Second); err != nil {
		return nil, err
	}
	target, err := FindPageTarget(ctx, opts.Port)
	if err != nil {
		return nil, err
	}
	conn, err := Dial(ctx, target.WebSocketDebuggerURL)
	if err != nil {
		return nil, err
	}

	o := &Oracle{opts: opts, conn: conn}
	if err := o.ensureReady(ctx); err != nil {
		conn.Close()
		return nil, err
	}
	return o, nil
}

// Close 断开与浏览器的连接（不会关闭浏览器）。
func (o *Oracle) Close() error {
	return o.conn.Close()
}

func (o *Oracle) debugf(format string, args ...any) {
	if o.opts.Debug != nil {
		o.opts.Debug(format, args...)
	}
}

// ensureReady 确保页面停在创作者中心，且 SDK 已完成 XHR 补丁。
func (o *Oracle) ensureReady(ctx context.Context) error {
	if _, err := o.conn.Send(ctx, "Runtime.enable", nil); err != nil {
		return err
	}
	if _, err := o.conn.Send(ctx, "Page.enable", nil); err != nil {
		return err
	}

	deadline := time.Now().Add(o.opts.ReadyTimeout)
	navigated := false
	for attempt := 0; time.Now().Before(deadline); attempt++ {
		st, err := o.probe(ctx)
		if err != nil {
			return err
		}
		o.debugf("oracle 探测 #%d: href=%s secsdk=%s glue=%s send=%s",
			attempt, st.Href, st.Secsdk, st.Glue, truncate(st.Send, 60))

		if st.OnCreator && st.Secsdk == "object" && !strings.Contains(st.Send, "[native code]") {
			o.ready = true
			o.lastURL = st.Href
			o.debugf("oracle 就绪：签名 SDK 已挂钩")
			return nil
		}

		if !st.OnCreator && !navigated {
			o.debugf("oracle 导航到 %s", o.opts.ReadyURL)
			if _, err := o.conn.Send(ctx, "Page.navigate", map[string]any{"url": o.opts.ReadyURL}); err != nil {
				return err
			}
			navigated = true
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-o.conn.Done():
			return fmt.Errorf("浏览器连接中断: %w", o.conn.Err())
		case <-time.After(2 * time.Second):
		}
	}
	return fmt.Errorf("等待签名 SDK 就绪超时（%s）。请确认：① Chrome 已打开 %s；② 已登录；③ 运行期间不要关闭该标签页",
		o.opts.ReadyTimeout, o.opts.ReadyURL)
}

type pageState struct {
	Href      string
	Secsdk    string
	Glue      string
	Send      string
	OnCreator bool
}

func (o *Oracle) probe(ctx context.Context) (*pageState, error) {
	const expr = `(() => {
	  let send = '';
	  try { send = String(XMLHttpRequest.prototype.send); } catch (e) { send = 'ERR:' + e; }
	  return {
	    href: location.href,
	    secsdk: typeof window.secsdk,
	    glue: typeof window._SdkGlueInit,
	    send: send
	  };
	})()`
	res, err := o.conn.Eval(ctx, expr, false)
	if err != nil {
		return nil, err
	}
	if res.ExceptionString != "" {
		return nil, fmt.Errorf("探测页面状态失败: %s", res.ExceptionString)
	}
	var v struct {
		Href   string `json:"href"`
		Secsdk string `json:"secsdk"`
		Glue   string `json:"glue"`
		Send   string `json:"send"`
	}
	if err := json.Unmarshal(res.Value, &v); err != nil {
		return nil, fmt.Errorf("解析页面状态失败: %w", err)
	}
	return &pageState{
		Href:      v.Href,
		Secsdk:    v.Secsdk,
		Glue:      v.Glue,
		Send:      v.Send,
		OnCreator: strings.HasPrefix(v.Href, CreatorOrigin),
	}, nil
}

// Response 是页面内发起的一次请求的结果。
type Response struct {
	// Status 是 HTTP 状态码。
	Status int
	// StatusText 是 HTTP 状态描述。
	StatusText string
	// Body 是响应正文。
	Body string
	// URL 是实际请求的 URL（含 SDK 追加的签名参数）。
	URL string
	// Headers 是响应头原文。
	Headers string
	// Err 是网络层错误（如超时、被拦截）。
	Err string
}

// Do 在页面里发起一次请求，从而复用页面的登录态与签名 SDK。
//
// path 可以是站点相对路径（如 /web/api/media/aweme/create_v2/），
// 也可以是绝对 URL。query 由调用方自行拼好；SDK 会在末尾追加 msToken 与 a_bogus。
func (o *Oracle) Do(ctx context.Context, method, rawURL string, body []byte, headers map[string]string) (*Response, error) {
	o.mu.Lock()
	defer o.mu.Unlock()

	if !o.ready {
		return nil, fmt.Errorf("签名 SDK 未就绪")
	}

	js, err := buildDoJS(method, rawURL, body, headers, o.opts.RequestTimeout)
	if err != nil {
		return nil, err
	}

	timeout := o.opts.RequestTimeout + 15*time.Second
	evalCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	res, err := o.conn.Eval(evalCtx, js, true)
	if err != nil {
		return nil, fmt.Errorf("页面内请求失败: %w", err)
	}
	if res.ExceptionString != "" {
		return nil, fmt.Errorf("页面内请求抛异常: %s", res.ExceptionString)
	}
	var out struct {
		Status     int    `json:"status"`
		StatusText string `json:"statusText"`
		Body       string `json:"body"`
		URL        string `json:"url"`
		Headers    string `json:"headers"`
		Err        string `json:"err"`
	}
	if err := json.Unmarshal(res.Value, &out); err != nil {
		return nil, fmt.Errorf("解析页面请求结果失败: %w（原始值: %s）", err, truncate(string(res.Value), 200))
	}
	return &Response{
		Status:     out.Status,
		StatusText: out.StatusText,
		Body:       out.Body,
		URL:        out.URL,
		Headers:    out.Headers,
		Err:        out.Err,
	}, nil
}

// buildDoJS 生成在页面里执行请求的表达式。
func buildDoJS(method, rawURL string, body []byte, headers map[string]string, timeout time.Duration) (string, error) {
	m, err := json.Marshal(method)
	if err != nil {
		return "", err
	}
	u, err := json.Marshal(rawURL)
	if err != nil {
		return "", err
	}
	// body 以 JSON 字符串形式嵌入，页面侧再原样 send。
	b, err := json.Marshal(string(body))
	if err != nil {
		return "", err
	}
	h, err := json.Marshal(headers)
	if err != nil {
		return "", err
	}
	ms := timeout.Milliseconds()

	return fmt.Sprintf(`new Promise((resolve) => {
	  var done = false;
	  function finish(o) { if (done) return; done = true; resolve(o); }
	  var timer = setTimeout(function () { finish({ status: 0, err: 'timeout' }); }, %d);
	  try {
	    var x = new XMLHttpRequest();
	    x.open(%s, %s, true);
	    var hs = %s;
	    for (var k in hs) { if (Object.prototype.hasOwnProperty.call(hs, k)) x.setRequestHeader(k, hs[k]); }
	    x.timeout = %d;
	    x.onload = function () {
	      clearTimeout(timer);
	      finish({ status: x.status, statusText: x.statusText, body: String(x.responseText),
	               url: x.responseURL || '', headers: String(x.getAllResponseHeaders() || '') });
	    };
	    x.onerror = function () { clearTimeout(timer); finish({ status: 0, err: 'network error' }); };
	    x.ontimeout = function () { clearTimeout(timer); finish({ status: 0, err: 'xhr timeout' }); };
	    x.send(%s);
	  } catch (e) { clearTimeout(timer); finish({ status: 0, err: String(e) }); }
	})`, ms, m, u, h, ms, b), nil
}

// Cookie 描述一个浏览器 cookie。
type Cookie struct {
	Name     string  `json:"name"`
	Value    string  `json:"value"`
	Domain   string  `json:"domain"`
	Path     string  `json:"path"`
	Expires  float64 `json:"expires"`
	HTTPOnly bool    `json:"httpOnly"`
	Secure   bool    `json:"secure"`
}

// Cookies 读取浏览器里创作者中心域的 cookie。
//
// 通过 CDP 的 Network.getAllCookies 获取，因此包含 HttpOnly 的会话 cookie——
// 这正是 document.cookie 拿不到、而接口调用又必需的部分。
func (o *Oracle) Cookies(ctx context.Context) ([]Cookie, error) {
	o.mu.Lock()
	defer o.mu.Unlock()

	if _, err := o.conn.Send(ctx, "Network.enable", nil); err != nil {
		return nil, err
	}
	raw, err := o.conn.Send(ctx, "Network.getAllCookies", nil)
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Cookies []Cookie `json:"cookies"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("解析 cookie 失败: %w", err)
	}
	out := make([]Cookie, 0, len(parsed.Cookies))
	for _, c := range parsed.Cookies {
		if !cookieMatchesDomain(c.Domain, "creator.douyin.com") {
			continue
		}
		out = append(out, c)
	}
	return out, nil
}

// cookieMatchesDomain 判断 cookie 的 domain 是否适用于目标域。
func cookieMatchesDomain(cookieDomain, host string) bool {
	d := strings.TrimPrefix(strings.ToLower(cookieDomain), ".")
	host = strings.ToLower(host)
	if d == "" {
		return false
	}
	return host == d || strings.HasSuffix(host, "."+d)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
