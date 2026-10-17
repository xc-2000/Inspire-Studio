// Package app 把各层组装成可用的上传流程。
package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"time"

	"douyin-uploader/internal/browser"
	"douyin-uploader/internal/cookies"
	"douyin-uploader/internal/creator"
	"douyin-uploader/internal/publish"
	"douyin-uploader/internal/uploader"
)

// Options 是上传流程的配置。
type Options struct {
	// CookieFile 是 cookie 文件路径。
	CookieFile string
	// Transport 是 creator 站点请求的通道：direct 或 browser。
	Transport string
	// CDPPort 是浏览器远程调试端口（browser 通道使用）。
	CDPPort int
	// Debug 输出详细日志。
	Debug bool
	// DryRun 只做校验与凭证获取，不真正发布。
	DryRun bool
	// Logf 输出日志。
	Logf func(format string, args ...any)
}

// App 是一次运行的上下文。
type App struct {
	opts    Options
	cookies *cookies.Jar
	creator *creator.Client
	upload  *uploader.Client
	oracle  *browser.Oracle
	logf    func(format string, args ...any)
}

// 请求通道。
const (
	// TransportDirect 用 Go 直连。不带 a_bogus 签名。
	TransportDirect = "direct"
	// TransportBrowser 通过浏览器页面发起，复用其登录态与签名 SDK。
	TransportBrowser = "browser"
)

// New 创建运行上下文。调用方负责调用 Close。
func New(ctx context.Context, opts Options) (*App, error) {
	if opts.Logf == nil {
		opts.Logf = func(format string, args ...any) {}
	}
	a := &App{opts: opts, logf: opts.Logf}

	if opts.CookieFile == "" {
		return nil, fmt.Errorf("必须指定 --cookie 文件路径")
	}
	jar, err := cookies.LoadFile(opts.CookieFile)
	if err != nil {
		return nil, fmt.Errorf("加载 cookie 失败: %w", err)
	}
	a.cookies = jar
	a.logf("已加载 %d 个 cookie: %s", jar.Len(), jar.SortedNames())

	creatorCfg := creator.Config{
		Cookies: jar,
		Logf:    nil,
	}
	if opts.Debug {
		creatorCfg.Logf = a.logf
	}
	a.creator = creator.New(creatorCfg)

	if opts.Transport == TransportBrowser {
		oracle, err := a.attachOracle(ctx)
		if err != nil {
			return nil, err
		}
		a.oracle = oracle
		a.creator.SetOracleTransport(oracleTransport{o: oracle})
	}

	a.upload = uploader.New(uploader.Config{
		Logf: func(format string, args ...any) {
			if opts.Debug {
				a.logf(format, args...)
			}
		},
	})
	// 复用创作者中心的服务器时间，避免本机时钟偏差导致 SigV4 签名失败。
	a.upload.SetClock(func() time.Time { return a.creator.Clock().Now() })
	return a, nil
}

// Close 释放资源（不会关闭用户的浏览器）。
func (a *App) Close() error {
	if a.oracle != nil {
		return a.oracle.Close()
	}
	return nil
}

func (a *App) attachOracle(ctx context.Context) (*browser.Oracle, error) {
	port := a.opts.CDPPort
	if port <= 0 {
		port = 9401
	}
	var debugf func(string, ...any)
	if a.opts.Debug {
		debugf = a.logf
	}
	o, err := browser.Attach(ctx, browser.OracleOptions{Port: port, Debug: debugf})
	if err != nil {
		return nil, fmt.Errorf("%w\n提示：请先用 --cdp-port 指定的端口启动 Chrome 并登录抖音创作者中心，例如：\n"+
			`  chrome.exe --remote-debugging-port=%d --user-data-dir=<目录> %s`,
			err, port, browser.DefaultReadyURL)
	}
	a.logf("已连接浏览器签名通道（端口 %d）", port)
	return o, nil
}

// oracleTransport 把 browser.Oracle 适配成 creator.OracleTransport。
type oracleTransport struct {
	o *browser.Oracle
}

func (t oracleTransport) Do(ctx context.Context, method, rawURL string, body []byte, headers map[string]string) (*creator.OracleResponse, error) {
	res, err := t.o.Do(ctx, method, rawURL, body, headers)
	if err != nil {
		return nil, err
	}
	return &creator.OracleResponse{
		Status:  res.Status,
		Body:    res.Body,
		URL:     res.URL,
		Headers: res.Headers,
		Err:     res.Err,
	}, nil
}

// CheckLogin 校验登录态并返回账号信息。
func (a *App) CheckLogin(ctx context.Context) (*creator.UserInfo, error) {
	info, err := a.creator.CheckLogin(ctx)
	if err != nil {
		return nil, err
	}
	if off := a.creator.Clock().Offset(); off != 0 {
		a.logf("检测到本机时钟偏差 %s，已自动校准签名时间", off.Round(time.Second))
	}
	return info, nil
}

// Credentials 拉取上传凭证，并同步服务端时间。
func (a *App) Credentials(ctx context.Context) (*uploader.STSCredentials, error) {
	auth, err := a.creator.GetUploadAuth(ctx)
	if err != nil {
		return nil, err
	}
	creds, err := uploader.ParseSTSCredentials(auth.Auth)
	if err != nil {
		return nil, err
	}
	if !creds.CurrentTime.IsZero() {
		a.creator.Clock().Update(creds.CurrentTime.UnixMilli())
		a.logf("凭证有效期至 %s，服务端时间 %s", creds.ExpiredTime.Format(time.RFC3339), creds.CurrentTime.Format(time.RFC3339))
	}
	return creds, nil
}

// UploadVideoResult 是视频发布的完整结果。
type UploadVideoResult struct {
	// Video 是上传阶段的结果。
	Video *uploader.VideoResult
}

// PublishVideo 上传并发布一个视频。
func (a *App) PublishVideo(ctx context.Context, path string, popts publish.VideoOptions) (*UploadVideoResult, error) {
	creds, err := a.Credentials(ctx)
	if err != nil {
		return nil, err
	}

	a.logf("开始上传视频 %s", filepath.Base(path))
	video, err := a.upload.UploadVideo(ctx, path, creds.Credentials)
	if err != nil {
		return nil, fmt.Errorf("上传视频失败: %w", err)
	}
	a.logf("上传完成：vid=%s 时长=%d秒 分辨率=%dx%d 封面=%s",
		video.Vid, video.Meta.Duration, video.Meta.Width, video.Meta.Height, video.PosterURI)

	if a.opts.DryRun {
		a.logf("--dry-run：跳过发布")
		return &UploadVideoResult{Video: video}, nil
	}

	// 上传得到的 vid 才是发布时要用的 video_id。
	popts.Vid = video.Vid
	if popts.PosterURI == "" {
		popts.PosterURI = video.PosterURI
	}
	if popts.CreationID == "" {
		popts.CreationID = randomCreationID()
	}
	item, err := publish.Video(popts)
	if err != nil {
		return nil, err
	}

	res, err := a.creator.CreateVideo(ctx, item)
	if err != nil {
		return nil, err
	}
	a.logf("发布成功：item_id=%s", res.ItemID.String())
	return &UploadVideoResult{Video: video}, nil
}

// ImagePublishResult 是图文发布的完整结果。
type ImagePublishResult struct {
	// Images 是上传阶段的结果。
	Images []uploader.ImageResult
}

// PublishImages 上传并发布一组图片（图文作品）。
func (a *App) PublishImages(ctx context.Context, paths []string, popts publish.ImageOptions) (*ImagePublishResult, error) {
	creds, err := a.Credentials(ctx)
	if err != nil {
		return nil, err
	}

	a.logf("开始上传 %d 张图片", len(paths))
	images, err := a.upload.UploadImages(ctx, paths, creds.Credentials)
	if err != nil {
		return nil, fmt.Errorf("上传图片失败: %w", err)
	}
	for i, img := range images {
		a.logf("第 %d 张：uri=%s 尺寸=%dx%d", i+1, img.URI, img.Width, img.Height)
	}

	if popts.CreationID == "" {
		popts.CreationID = randomCreationID()
	}
	popts.Images = make([]publish.Image, 0, len(images))
	for _, img := range images {
		popts.Images = append(popts.Images, publish.Image{
			URI:    img.URI,
			Width:  img.Width,
			Height: img.Height,
		})
	}

	if a.opts.DryRun {
		a.logf("--dry-run：跳过发布")
		return &ImagePublishResult{Images: images}, nil
	}

	item, err := publish.Images(popts)
	if err != nil {
		return nil, err
	}
	res, err := a.creator.CreateImages(ctx, item)
	if err != nil {
		return nil, err
	}
	a.logf("发布成功：item_id=%s", res.ItemID.String())
	return &ImagePublishResult{Images: images}, nil
}

// randomCreationID 生成一个创建标识（时间戳 + 随机串）。
//
// 必须保证连续调用不重复：该值作为发布的幂等标识，重复会被服务端判为同一作品。
// 只用时间戳是不够的——Windows 上 time.Now 的粒度约 0.5–15ms，
// 同一 tick 内的两次调用会得到完全相同的值，因此必须掺入随机数。
func randomCreationID() string {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		// 随机源不可用时退化为纳秒 + 进程内自增计数，仍保证不重复。
		n := atomic.AddUint64(&creationSeq, 1)
		return strconv.FormatInt(time.Now().UnixNano(), 36) + "-" + strconv.FormatUint(n, 36)
	}
	return strconv.FormatInt(time.Now().UnixNano(), 36) + "-" + hex.EncodeToString(buf[:])
}

// creationSeq 是随机源不可用时的兜底计数器。
var creationSeq uint64
