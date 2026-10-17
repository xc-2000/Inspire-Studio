// Package publish 构建发布作品所需的 item 请求体。
//
// 结构取自线上真实抓包（驱动真实 UI 发布并记录 create_v2 请求体），
// 而不是仅凭 bundle 推断。关键结论：
//
//  1. 所有业务字段都嵌在 item.common 之下，另有 item.cover / item.anchor
//     等并列子对象；把字段平铺在 item 下会得到 status_code=5「参数不合法」。
//  2. visibility_type：0=公开，1=仅自己可见，2=好友可见
//     （micro/douyin_content_index_micro_new.77afa8ad.js 的映射表
//     {0:公开, 2:好友可见, 1:仅自己可见}）。
//  3. 图文（media_type=2）的 images 是【原生数组】，且必须有 cover.poster，
//     否则服务端返回 status_code=4。
package publish

import (
	"encoding/json"
	"fmt"
	"strings"
)

// 可见性枚举。
//
// 来源：micro/douyin_content_index_micro_new.77afa8ad.js 中
// A=0, f=1, d=2 与映射表 {0:"公开", 2:"好友可见", 1:"仅自己可见"}，
// 并由真实抓包中「公开」对应 visibility_type=0 佐证。
const (
	// VisibilityPublic 公开可见。
	VisibilityPublic = 0
	// VisibilityPrivate 仅自己可见。
	VisibilityPrivate = 1
	// VisibilityFans 好友可见。
	VisibilityFans = 2
)

// 媒体类型枚举。
//
// 来源：micro-async/1060.abf5c0f7.js 模块 51947 的映射表
// {video:4, image:2, panoramic_video:12, long_article:43}。
const (
	MediaTypeVideo          = 4
	MediaTypeImage          = 2
	MediaTypePanoramicVideo = 12
	MediaTypeLongArticle    = 43
)

// TextExtra 是被 @ 的用户或话题在正文中的位置信息。
type TextExtra struct {
	Start  int    `json:"start"`
	End    int    `json:"end"`
	Type   int    `json:"type"`
	UserID string `json:"user_id,omitempty"`
	// HashtagID 与 HashtagName 用于话题（type=1）。
	HashtagID   string `json:"hashtag_id,omitempty"`
	HashtagName string `json:"hashtag_name,omitempty"`
	// AwemeID 用于视频内引用。
	AwemeID string `json:"aweme_id,omitempty"`
	// SubType 用于区分话题来源。
	SubType int `json:"sub_type,omitempty"`
}

// VideoOptions 是构建视频 item 的输入。
type VideoOptions struct {
	// Vid 是上传阶段拿到的视频 ID，必填。
	Vid string
	// Text 是作品文案。
	Text string
	// Caption 是字幕文字。
	Caption string
	// ItemTitle 是作品标题。
	ItemTitle string
	// Visibility 是可见性，取 Visibility* 之一；始终发送，0 即公开。
	Visibility int
	// Timing 是定时发布时间，0 表示立即发布，-1 表示未设置定时。
	Timing int
	// CreationID 是前端生成的创建标识，用于幂等。
	CreationID string
	// TextExtra 是正文中的 @/话题标记。
	TextExtra []TextExtra
	// Challenges 是参与的话题。
	Challenges []string
	// Mentions 是 @ 的用户。
	Mentions []string
	// HashtagSource 是话题来源（由前端标记，通常为 "challenge"）。
	HashtagSource string
	// Activity 是活动信息，nil 时发 "[]"。
	Activity any
	// IsPreview 表示是否为预览态，预览态不真正发布。
	IsPreview bool
	// IsPostAssistant 表示是否通过发布助手提交。
	IsPostAssistant bool
	// PosterURI 是封面 URI；为空时不发送封面字段。
	PosterURI string
	// PosterDelay 是封面生效的时间点（秒）。
	PosterDelay int
	// CoverTextURI / CoverText 用于封面文字。
	CoverTextURI string
	CoverText    string
	// CustomCoverWidth / CustomCoverHeight 用于自定义封面裁剪尺寸。
	CustomCoverWidth  int
	CustomCoverHeight int
	// PoID 是关联的地点 ID。
	PoID    string
	PoIName string
	// Anchor 是关联的锚点（如小程序、商品）。
	Anchor map[string]any
	// MusicID / MusicSource 用于指定配乐；MusicSource 为 0 表示未选配乐。
	MusicID     string
	MusicSource int
	// AllowDownload 为 true 时允许他人下载。
	AllowDownload bool
	// UserDeclareInfo 是内容声明信息（如 AI 生成）。
	UserDeclareInfo any
}

// Video 构建视频发布请求体（对应 create_v2 的 body.item）。
//
// 结构对照真实抓包：业务字段在 item.common，封面在 item.cover。
func Video(o VideoOptions) (map[string]any, error) {
	if strings.TrimSpace(o.Vid) == "" {
		return nil, fmt.Errorf("vid 为空，无法构建视频发布请求")
	}

	// 字段名与顺序对照抓包；服务端按 JSON 解析，顺序不影响正确性。
	common := map[string]any{
		"text":                 o.Text,
		"caption":              o.Caption,
		"item_title":           o.ItemTitle,
		"activity":             mustJSON(o.Activity),
		"text_extra":           mustJSON(o.TextExtra),
		"challenges":           mustJSON(o.Challenges),
		"mentions":             mustJSON(o.Mentions),
		"hashtag_source":       mustJSONOrString(o.HashtagSource),
		"hot_sentence":         "",
		"interaction_stickers": "[]",
		"visibility_type":      o.Visibility,
		"download":             downloadFlag(o.AllowDownload),
		"timing":               o.Timing,
		"creation_id":          o.CreationID,
		"media_type":           MediaTypeVideo,
		"video_id":             o.Vid,
		"upload_source":        1,
		"title_permission":     1,
		// 抓包里未选配乐时为 music_source=0 / music_id=null。
		"music_source": 0,
		"music_id":     nil,
	}
	if o.UserDeclareInfo != nil {
		common["user_declare_info"] = o.UserDeclareInfo
	}

	// 地点锚点。
	if o.PoID != "" {
		common["poi_id"] = o.PoID
		common["poi_name"] = o.PoIName
	}
	if o.MusicID != "" {
		common["music_id"] = o.MusicID
	}
	if o.MusicSource != 0 {
		common["music_source"] = o.MusicSource
	}

	item := map[string]any{
		"common": common,
		// 这三个子对象在抓包里恒存在（可为空对象）。
		"mix":    map[string]any{},
		"anchor": map[string]any{},
		"assistant": map[string]any{
			"is_preview":        boolToInt(o.IsPreview),
			"is_post_assistant": boolToInt(o.IsPostAssistant),
		},
	}
	if len(o.Anchor) > 0 {
		item["anchor"] = o.Anchor
	}

	// 封面：有 poster 时走服务端抽帧封面，否则用自定义封面。
	if o.PosterURI != "" || o.CoverTextURI != "" || o.CustomCoverWidth > 0 {
		cover := map[string]any{}
		if o.CoverTextURI != "" {
			cover["cover_text_uri"] = o.CoverTextURI
		}
		if o.CoverText != "" {
			cover["cover_text"] = o.CoverText
		}
		if o.PosterURI != "" {
			cover["poster"] = o.PosterURI
			cover["poster_delay"] = o.PosterDelay
		}
		if o.CustomCoverWidth > 0 {
			cover["custom_cover_image_width"] = o.CustomCoverWidth
			cover["custom_cover_image_height"] = o.CustomCoverHeight
		}
		item["cover"] = cover
	}
	return item, nil
}

// downloadFlag 把「是否允许下载」转成服务端字段。
//
// 注意：该字段的确切语义【未经证实】，bundle 中的证据互相矛盾：
//   - 231.7f770582.js 的下载开关 onChange 写 download:Number(e)，
//     且 action_type 为 Number(e) ? "permit_save" : "not_permit_save"，
//     按此推断「真值 = 允许下载」；
//   - 但状态原子为 {key:"download",default:1}，而 1541.a06216b7.js 中
//     又有 f=function(t){t.download=0} 这样的「置 0」操作，按此推断相反。
//
// 因此这里不臆断语义，只保证「默认行为与官方 Web 端一致」：
// 线上真实抓包（驱动真实 UI 发布）与实测发布成功的请求体发送的都是
// download=1，故 AllowDownload=false 时发 1，显式传 --allow-download 时发 0。
// 若需要精确控制该开关，请用 --allow-download 实测确认。
func downloadFlag(allow bool) int {
	if allow {
		return 0
	}
	return 1
}

// ImageOptions 是构建图文 item 的输入。
type ImageOptions struct {
	// Images 是已上传图片的 URI 与尺寸，至少一张。
	Images []Image
	// Text 是作品文案。
	Text string
	// ItemTitle 是作品标题，可选。
	ItemTitle string
	// TextExtra 是正文中的 @/话题标记。
	TextExtra []TextExtra
	// Challenges 是参与的话题。
	Challenges []string
	// Mentions 是 @ 的用户。
	Mentions []string
	// CreationID 是前端生成的创建标识，用于幂等。
	CreationID string
	// MusicID / MusicDuration 用于配乐，MusicDuration 单位为秒。
	MusicID       string
	MusicDuration float64
	// PosterURI 是封面图 uri；为空时取首图 uri。
	PosterURI string
	// Anchor 是关联锚点。
	Anchor map[string]any
	// Visibility 是可见性，取 Visibility* 之一。
	Visibility int
	// AllowDownload 为 true 时允许他人下载。
	AllowDownload bool
	// UserDeclareInfo 是内容声明信息。
	UserDeclareInfo any
}

// Image 是一张已上传图片。
type Image struct {
	// URI 是上传阶段拿到的图片标识。
	URI string
	// Width / Height 是图片尺寸。
	Width  int64
	Height int64
}

// Images 构建图文发布请求体（对应 create_v2 的 body.item）。
//
// 结构对照真实抓包：
//
//	{"item":{"common":{"text","text_extra","activity","visibility_type",
//	   "download","timing":-1,"media_type":2,"images":[...数组...],
//	   "creation_id"},"cover":{"poster":"<首图 uri>"},"anchor":{}}}
//
// 两个必须点：images 是原生数组；cover.poster 缺失时服务端返回 status_code=4。
func Images(o ImageOptions) (map[string]any, error) {
	if len(o.Images) == 0 {
		return nil, fmt.Errorf("至少需要一张图片")
	}
	for i, img := range o.Images {
		if strings.TrimSpace(img.URI) == "" {
			return nil, fmt.Errorf("第 %d 张图片没有 uri", i+1)
		}
	}

	images := make([]map[string]any, 0, len(o.Images))
	for _, img := range o.Images {
		images = append(images, map[string]any{
			"uri":    img.URI,
			"width":  img.Width,
			"height": img.Height,
		})
	}

	common := map[string]any{
		"text":            o.Text,
		"text_extra":      mustJSON(o.TextExtra),
		"activity":        "[]",
		"challenges":      mustJSON(o.Challenges),
		"mentions":        mustJSON(o.Mentions),
		"hashtag_source":  "",
		"visibility_type": o.Visibility,
		"download":        downloadFlag(o.AllowDownload),
		// 图文抓包里 timing 为 -1（视频为 0）。
		"timing":      -1,
		"media_type":  MediaTypeImage,
		"images":      images,
		"creation_id": o.CreationID,
	}
	if o.ItemTitle != "" {
		common["item_title"] = o.ItemTitle
	}
	if o.UserDeclareInfo != nil {
		common["user_declare_info"] = o.UserDeclareInfo
	}
	if o.MusicID != "" {
		common["music_id"] = o.MusicID
		if o.MusicDuration > 0 {
			// 前端用的是毫秒。
			common["music_end_time"] = int64(o.MusicDuration * 1000)
		}
	}

	// 封面：抓包里 poster 取首图 uri。
	poster := o.PosterURI
	if poster == "" {
		poster = o.Images[0].URI
	}

	item := map[string]any{
		"common": common,
		"cover":  map[string]any{"poster": poster},
		"anchor": map[string]any{},
	}
	if len(o.Anchor) > 0 {
		item["anchor"] = o.Anchor
	}
	return item, nil
}

// mustJSON 序列化为 JSON 字符串；nil 或空切片尽量产出 "[]" 以匹配前端行为。
func mustJSON(v any) string {
	if v == nil {
		return "[]"
	}
	b, err := json.Marshal(v)
	if err != nil {
		return "[]"
	}
	s := string(b)
	if s == "null" {
		return "[]"
	}
	return s
}

// mustJSONOrString 已是非空字符串时原样返回，否则序列化。
func mustJSONOrString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return mustJSON(v)
}

// boolToInt 把布尔转成接口使用的 0/1。
func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
