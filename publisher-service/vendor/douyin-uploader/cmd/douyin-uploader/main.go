// Command douyin-uploader 通过模拟创作者中心 Web 端，把视频与图文作品发布到抖音。
//
// 用法见 docs/protocol.md 与 README.md。
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"douyin-uploader/internal/app"
	"douyin-uploader/internal/publish"
)

const usage = `douyin-uploader —— 抖音创作者中心自动发布工具

子命令：
  login-check                             校验 cookie 登录态是否有效
  publish-video  --file <路径> [选项]      上传并发布视频
  publish-images --file <路径,...> [选项]  上传并发布图文作品
  cookie-export  --port <端口> [--out <文件>]
                                          从浏览器导出 cookie（含 HttpOnly）

通用选项：
  --cookie <文件>      cookie 文件（Netscape 格式或 "k=v; k=v" 文本）
  --transport <值>     请求通道：direct（默认，Go 直连）或 browser（浏览器签名）
  --cdp-port <端口>    browser 通道使用的 Chrome 远程调试端口（默认 9401）
  --debug              输出详细日志
  --dry-run            只上传、不发布

发布选项：
  --text <文案>        作品文案
  --title <标题>       作品标题（仅视频）
  --visibility <值>    可见性：public（默认）/ private / fans
  --allow-download     允许他人下载（默认不允许）

示例：
  douyin-uploader login-check --cookie cookie.txt
  douyin-uploader publish-video --cookie cookie.txt --file a.mp4 --text "你好"
  douyin-uploader publish-images --cookie cookie.txt --file 1.jpg,2.jpg --text "图文"
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}

	cmd := os.Args[1]
	args := os.Args[2:]

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var err error
	switch cmd {
	case "login-check":
		err = runLoginCheck(ctx, args)
	case "publish-video":
		err = runPublishVideo(ctx, args)
	case "publish-images":
		err = runPublishImages(ctx, args)
	case "cookie-export":
		err = runCookieExport(ctx, args)
	case "-h", "--help", "help":
		fmt.Print(usage)
		return
	default:
		fmt.Fprintf(os.Stderr, "未知子命令: %s\n\n%s", cmd, usage)
		os.Exit(2)
	}

	if err != nil {
		fmt.Fprintf(os.Stderr, "错误: %v\n", err)
		os.Exit(1)
	}
}

// commonFlags 是各子命令共享的选项。
type commonFlags struct {
	cookie    string
	transport string
	cdpPort   int
	debug     bool
	dryRun    bool
}

func (c *commonFlags) register(fs *flag.FlagSet) {
	fs.StringVar(&c.cookie, "cookie", "", "cookie 文件路径")
	fs.StringVar(&c.transport, "transport", app.TransportDirect, "请求通道：direct 或 browser")
	fs.IntVar(&c.cdpPort, "cdp-port", 9401, "browser 通道使用的 Chrome 远程调试端口")
	fs.BoolVar(&c.debug, "debug", false, "输出详细日志")
	fs.BoolVar(&c.dryRun, "dry-run", false, "只上传、不发布")
}

func (c *commonFlags) options() app.Options {
	return app.Options{
		CookieFile: c.cookie,
		Transport:  c.transport,
		CDPPort:    c.cdpPort,
		Debug:      c.debug,
		DryRun:     c.dryRun,
		Logf:       logger(c.debug),
	}
}

// logger 返回一个带时间戳的日志函数。
func logger(debug bool) func(string, ...any) {
	return func(format string, args ...any) {
		ts := time.Now().Format("15:04:05")
		fmt.Printf("[%s] %s\n", ts, fmt.Sprintf(format, args...))
	}
}

func newFlagSet(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ExitOnError)
	fs.Usage = func() {
		fmt.Fprintf(os.Stderr, "用法: douyin-uploader %s [选项]\n\n选项:\n", name)
		fs.PrintDefaults()
	}
	return fs
}

func runLoginCheck(ctx context.Context, args []string) error {
	var cf commonFlags
	fs := newFlagSet("login-check")
	cf.register(fs)
	if err := fs.Parse(args); err != nil {
		return err
	}

	a, err := app.New(ctx, cf.options())
	if err != nil {
		return err
	}
	defer a.Close()

	info, err := a.CheckLogin(ctx)
	if err != nil {
		return err
	}
	fmt.Printf("登录态有效\n")
	if info.Nickname != "" {
		fmt.Printf("  昵称: %s\n", info.Nickname)
	}
	if info.UID != "" {
		fmt.Printf("  uid:  %s\n", info.UID)
	}
	if info.UserID.String() != "" {
		fmt.Printf("  user_id: %s\n", info.UserID.String())
	}

	// 顺带验证上传凭证可用性，这是真正会阻塞发布的一步。
	creds, err := a.Credentials(ctx)
	if err != nil {
		return fmt.Errorf("登录态有效，但获取上传凭证失败: %w", err)
	}
	fmt.Printf("上传凭证可用（AccessKeyId=%s）\n", mask(creds.AccessKeyID))
	return nil
}

func runPublishVideo(ctx context.Context, args []string) error {
	var cf commonFlags
	var file, text, title, visibility string
	var allowDownload bool

	fs := newFlagSet("publish-video")
	cf.register(fs)
	fs.StringVar(&file, "file", "", "视频文件路径")
	fs.StringVar(&text, "text", "", "作品文案")
	fs.StringVar(&title, "title", "", "作品标题")
	fs.StringVar(&visibility, "visibility", "public", "可见性：public / private / fans")
	fs.BoolVar(&allowDownload, "allow-download", false, "允许他人下载")
	if err := fs.Parse(args); err != nil {
		return err
	}

	if strings.TrimSpace(file) == "" {
		fs.Usage()
		return fmt.Errorf("必须指定 --file")
	}
	vis, err := parseVisibility(visibility)
	if err != nil {
		return err
	}

	a, err := app.New(ctx, cf.options())
	if err != nil {
		return err
	}
	defer a.Close()

	if _, err := a.CheckLogin(ctx); err != nil {
		return err
	}

	res, err := a.PublishVideo(ctx, file, publish.VideoOptions{
		Text:          text,
		ItemTitle:     title,
		Visibility:    vis,
		HashtagSource: "challenge",
		AllowDownload: allowDownload,
	})
	if err != nil {
		return err
	}
	printJSON(map[string]any{
		"vid":        res.Video.Vid,
		"poster_uri": res.Video.PosterURI,
		"duration":   res.Video.Meta.Duration,
		"width":      res.Video.Meta.Width,
		"height":     res.Video.Meta.Height,
		"size":       res.Video.Meta.Size,
	})
	return nil
}

func runPublishImages(ctx context.Context, args []string) error {
	var cf commonFlags
	var files, text, visibility string

	fs := newFlagSet("publish-images")
	cf.register(fs)
	fs.StringVar(&files, "file", "", "图片路径，多个用逗号分隔")
	fs.StringVar(&text, "text", "", "作品文案")
	fs.StringVar(&visibility, "visibility", "public", "可见性：public / private / fans")
	if err := fs.Parse(args); err != nil {
		return err
	}

	paths := splitList(files)
	if len(paths) == 0 {
		fs.Usage()
		return fmt.Errorf("必须指定 --file")
	}
	vis, err := parseVisibility(visibility)
	if err != nil {
		return err
	}

	a, err := app.New(ctx, cf.options())
	if err != nil {
		return err
	}
	defer a.Close()

	if _, err := a.CheckLogin(ctx); err != nil {
		return err
	}

	res, err := a.PublishImages(ctx, paths, publish.ImageOptions{
		Text:       text,
		Visibility: vis,
	})
	if err != nil {
		return err
	}

	uris := make([]string, 0, len(res.Images))
	for _, img := range res.Images {
		uris = append(uris, img.URI)
	}
	printJSON(map[string]any{"count": len(res.Images), "uris": uris})
	return nil
}

func runCookieExport(ctx context.Context, args []string) error {
	var port int
	var out string
	fs := newFlagSet("cookie-export")
	fs.IntVar(&port, "port", 9401, "Chrome 远程调试端口")
	fs.StringVar(&out, "out", "cookie.txt", "输出文件路径")
	if err := fs.Parse(args); err != nil {
		return err
	}

	text, n, err := app.ExportCookies(ctx, port)
	if err != nil {
		return err
	}
	if err := os.WriteFile(out, []byte(text), 0o600); err != nil {
		return fmt.Errorf("写入 %s 失败: %w", out, err)
	}
	fmt.Printf("已从浏览器导出 %d 个 cookie 到 %s\n", n, out)
	return nil
}

// parseVisibility 把命令行取值转成接口枚举。
func parseVisibility(s string) (int, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "", "public", "公开":
		return publish.VisibilityPublic, nil
	case "private", "self", "仅自己", "仅自己可见":
		return publish.VisibilityPrivate, nil
	case "fans", "friend", "好友", "好友可见":
		return publish.VisibilityFans, nil
	default:
		return 0, fmt.Errorf("无法识别的可见性 %q（可用：public / private / fans）", s)
	}
}

func splitList(s string) []string {
	var out []string
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func printJSON(v any) {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return
	}
	fmt.Println(string(b))
}

// mask 只保留字符串的头尾若干字符。
func mask(s string) string {
	if len(s) <= 8 {
		return strings.Repeat("*", len(s))
	}
	return s[:4] + "..." + s[len(s)-4:]
}
