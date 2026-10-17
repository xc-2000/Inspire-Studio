package publish

import (
	"encoding/json"
	"reflect"
	"testing"
)

// common 取出 item.common，测试中几乎都要用。
func common(t *testing.T, item map[string]any) map[string]any {
	t.Helper()
	c, ok := item["common"].(map[string]any)
	if !ok {
		t.Fatalf("item.common 不存在或类型错误: %T", item["common"])
	}
	return c
}

// 结构与字段名全部对照线上真实抓包（驱动真实 UI 发布的 create_v2 请求体）。

func TestVideoNestsFieldsUnderCommon(t *testing.T) {
	item, err := Video(VideoOptions{
		Vid:           "v123",
		Text:          "文案",
		Visibility:    VisibilityPublic,
		TextExtra:     []TextExtra{{Start: 0, End: 2, Type: 1, HashtagName: "话题"}},
		Challenges:    []string{"话题"},
		Mentions:      []string{"user1"},
		HashtagSource: "challenge",
	})
	if err != nil {
		t.Fatalf("构建失败: %v", err)
	}

	// 关键回归点：字段必须嵌在 common 之下，平铺会得到 status_code=5。
	if _, flat := item["video_id"]; flat {
		t.Error("video_id 不应平铺在 item 下，必须在 item.common 下")
	}
	c := common(t, item)
	if c["video_id"] != "v123" {
		t.Errorf("common.video_id = %v", c["video_id"])
	}
	if c["visibility_type"] != VisibilityPublic {
		t.Errorf("common.visibility_type = %v", c["visibility_type"])
	}
	if c["media_type"] != MediaTypeVideo {
		t.Errorf("common.media_type = %v, 期望 %d", c["media_type"], MediaTypeVideo)
	}

	// 这些字段必须是「JSON 字符串」而不是数组。
	for _, key := range []string{"text_extra", "challenges", "mentions"} {
		v, ok := c[key].(string)
		if !ok {
			t.Fatalf("common.%s 应是字符串，实际 %T", key, c[key])
		}
		if !json.Valid([]byte(v)) {
			t.Errorf("common.%s 不是合法 JSON: %q", key, v)
		}
	}
	if c["challenges"] != `["话题"]` {
		t.Errorf("common.challenges = %q", c["challenges"])
	}
	if c["hashtag_source"] != "challenge" {
		t.Errorf("common.hashtag_source = %q", c["hashtag_source"])
	}

	// 抓包里恒存在的并列子对象。
	for _, key := range []string{"mix", "anchor", "assistant"} {
		if _, ok := item[key]; !ok {
			t.Errorf("item.%s 缺失（抓包中恒存在）", key)
		}
	}
}

func TestVideoRequiresVid(t *testing.T) {
	if _, err := Video(VideoOptions{Text: "x"}); err == nil {
		t.Error("缺少 vid 应报错")
	}
}

// TestVideoAlwaysSendsVisibility 0 是「公开」，不是「未设置」。
func TestVideoAlwaysSendsVisibility(t *testing.T) {
	c := common(t, mustVideo(t, VideoOptions{Vid: "v1"}))
	v, ok := c["visibility_type"]
	if !ok {
		t.Fatal("visibility_type 必须始终发送：0 表示公开")
	}
	if v != VisibilityPublic {
		t.Errorf("默认 visibility_type = %v, 期望 %d(公开)", v, VisibilityPublic)
	}
}

func TestVideoEmptyCollectionsBecomeEmptyArrays(t *testing.T) {
	c := common(t, mustVideo(t, VideoOptions{Vid: "v1"}))
	// 与前端 JSON.stringify([]) 一致，避免服务端拿到 null。
	for _, key := range []string{"text_extra", "challenges", "mentions"} {
		if c[key] != "[]" {
			t.Errorf("common.%s = %v, 期望 \"[]\"", key, c[key])
		}
	}
}

func TestVideoCoverFields(t *testing.T) {
	item, err := Video(VideoOptions{
		Vid:               "v1",
		PosterURI:         "cover-uri",
		PosterDelay:       2,
		CustomCoverWidth:  720,
		CustomCoverHeight: 1280,
	})
	if err != nil {
		t.Fatalf("构建失败: %v", err)
	}
	// 封面是独立的 item.cover 对象，不是在 common 下。
	cover, ok := item["cover"].(map[string]any)
	if !ok {
		t.Fatalf("item.cover 缺失或类型错误: %T", item["cover"])
	}
	if cover["poster"] != "cover-uri" {
		t.Errorf("cover.poster = %v", cover["poster"])
	}
	if cover["poster_delay"] != 2 {
		t.Errorf("cover.poster_delay = %v", cover["poster_delay"])
	}
	if cover["custom_cover_image_width"] != 720 || cover["custom_cover_image_height"] != 1280 {
		t.Errorf("自定义封面尺寸未设置: %v", cover)
	}
}

// TestVideoNoCoverWhenUnset 无封面信息时不应凭空造出 cover 对象。
func TestVideoNoCoverWhenUnset(t *testing.T) {
	item := mustVideo(t, VideoOptions{Vid: "v1"})
	if _, ok := item["cover"]; ok {
		t.Error("未提供封面时不应发送 item.cover")
	}
}

func TestVideoAnchorIsObject(t *testing.T) {
	item, err := Video(VideoOptions{
		Vid:    "v1",
		Anchor: map[string]any{"id": "a1", "type": 13001},
	})
	if err != nil {
		t.Fatalf("构建失败: %v", err)
	}
	// 抓包里 anchor 是对象，不是 JSON 字符串。
	a, ok := item["anchor"].(map[string]any)
	if !ok {
		t.Fatalf("anchor 应是对象，实际 %T", item["anchor"])
	}
	if a["id"] != "a1" {
		t.Errorf("anchor.id = %v", a["id"])
	}
}

// TestVideoDownloadFlag 默认值与线上 Web 端一致（发 1）。
//
// 该字段的确切语义未经证实（bundle 证据互相矛盾，见 downloadFlag 注释），
// 这里只锁定「默认行为对齐官方前端」这一可验证事实。
func TestVideoDownloadFlag(t *testing.T) {
	if got := common(t, mustVideo(t, VideoOptions{Vid: "v1"}))["download"]; got != 1 {
		t.Errorf("默认 download = %v, 期望 1（与官方 Web 端一致）", got)
	}
	if got := common(t, mustVideo(t, VideoOptions{Vid: "v1", AllowDownload: true}))["download"]; got != 0 {
		t.Errorf("AllowDownload=true 时 download = %v, 期望 0", got)
	}
}

func TestImagesRequiresImages(t *testing.T) {
	if _, err := Images(ImageOptions{Text: "x"}); err == nil {
		t.Error("无图片应报错")
	}
	if _, err := Images(ImageOptions{Images: []Image{{URI: ""}}}); err == nil {
		t.Error("图片 uri 为空应报错")
	}
}

// TestImagesUsesNativeArray 关键回归点：images 是原生数组而非 JSON 字符串。
//
// 实测：传字符串会得到 status_code=5「参数不合法」，传数组才会进入业务校验。
func TestImagesUsesNativeArray(t *testing.T) {
	item, err := Images(ImageOptions{
		Images: []Image{
			{URI: "u1", Width: 1080, Height: 1440},
			{URI: "u2", Width: 1920, Height: 1080},
		},
		Text:       "图文文案",
		CreationID: "cid-1",
		Visibility: VisibilityPublic,
	})
	if err != nil {
		t.Fatalf("构建失败: %v", err)
	}

	arr, ok := common(t, item)["images"].([]map[string]any)
	if !ok {
		t.Fatalf("common.images 应是数组，实际 %T", common(t, item)["images"])
	}
	if len(arr) != 2 {
		t.Fatalf("图片数量 = %d", len(arr))
	}
	if arr[0]["uri"] != "u1" || arr[0]["width"] != int64(1080) || arr[0]["height"] != int64(1440) {
		t.Errorf("第一张图片字段错误: %v", arr[0])
	}
	c := common(t, item)
	if c["creation_id"] != "cid-1" {
		t.Errorf("common.creation_id = %v", c["creation_id"])
	}
	if c["media_type"] != MediaTypeImage {
		t.Errorf("common.media_type = %v, 期望 %d", c["media_type"], MediaTypeImage)
	}
	// 图文 timing 为 -1（视频为 0）。
	if c["timing"] != -1 {
		t.Errorf("common.timing = %v, 期望 -1", c["timing"])
	}
}

// TestImagesCoverDefaultsToFirstImage 封面缺失会导致 status_code=4。
func TestImagesCoverDefaultsToFirstImage(t *testing.T) {
	item, err := Images(ImageOptions{
		Images: []Image{{URI: "u1"}, {URI: "u2"}},
		Text:   "x",
	})
	if err != nil {
		t.Fatalf("构建失败: %v", err)
	}
	cover, ok := item["cover"].(map[string]any)
	if !ok {
		t.Fatalf("item.cover 缺失: %T", item["cover"])
	}
	if cover["poster"] != "u1" {
		t.Errorf("cover.poster = %v, 期望首图 u1", cover["poster"])
	}
}

// TestImagesExplicitCoverWins 显式封面应优先于首图。
func TestImagesExplicitCoverWins(t *testing.T) {
	item, err := Images(ImageOptions{
		Images:    []Image{{URI: "u1"}},
		PosterURI: "custom-cover",
		Text:      "x",
	})
	if err != nil {
		t.Fatalf("构建失败: %v", err)
	}
	if got := item["cover"].(map[string]any)["poster"]; got != "custom-cover" {
		t.Errorf("cover.poster = %v, 期望 custom-cover", got)
	}
}

func TestImagesMusicDurationToMillis(t *testing.T) {
	item, err := Images(ImageOptions{
		Images:        []Image{{URI: "u1"}},
		MusicID:       "m1",
		MusicDuration: 15.5,
	})
	if err != nil {
		t.Fatalf("构建失败: %v", err)
	}
	// 前端发送的是毫秒。
	if got := common(t, item)["music_end_time"]; got != int64(15500) {
		t.Errorf("music_end_time = %v, 期望 15500", got)
	}
}

// TestImagesGoldenMatchesCapturedBody 用线上真实抓包逐字段锁定图文请求体。
//
// 下面是驱动真实 UI 发布时捕获的 create_v2 请求体（去除外层 {"item":...}）。
// 这是本仓库最重要的回归用例：结构一旦偏离，服务端就从成功(field-level)
// 退化为 status_code=5（形状不合法）或 status_code=4（缺必需字段）。
func TestImagesGoldenMatchesCapturedBody(t *testing.T) {
	item, err := Images(ImageOptions{
		Images: []Image{
			{URI: "tos-cn-i-jm8ajry58r/14fcc3b9f3644f8583ddf600b376bb98", Width: 1080, Height: 1440},
			{URI: "tos-cn-i-jm8ajry58r/2362dafb423f41339ead91cf2d931abe", Width: 1080, Height: 1440},
		},
		Text:       "图文接口测试",
		Visibility: VisibilityPublic,
		CreationID: "uglc5fjh1789872427314",
	})
	if err != nil {
		t.Fatalf("构建失败: %v", err)
	}

	// 用 JSON 往返做比较，避免受 map 无序与数值类型影响。
	got, err := json.Marshal(item)
	if err != nil {
		t.Fatalf("序列化失败: %v", err)
	}
	var gotMap map[string]any
	if err := json.Unmarshal(got, &gotMap); err != nil {
		t.Fatalf("反序列化失败: %v", err)
	}

	const captured = `{
	  "common": {
	    "text": "图文接口测试",
	    "text_extra": "[]",
	    "activity": "[]",
	    "challenges": "[]",
	    "hashtag_source": "",
	    "mentions": "[]",
	    "visibility_type": 0,
	    "download": 1,
	    "timing": -1,
	    "media_type": 2,
	    "images": [
	      {"uri": "tos-cn-i-jm8ajry58r/14fcc3b9f3644f8583ddf600b376bb98", "width": 1080, "height": 1440},
	      {"uri": "tos-cn-i-jm8ajry58r/2362dafb423f41339ead91cf2d931abe", "width": 1080, "height": 1440}
	    ],
	    "creation_id": "uglc5fjh1789872427314"
	  },
	  "cover": {"poster": "tos-cn-i-jm8ajry58r/14fcc3b9f3644f8583ddf600b376bb98"},
	  "anchor": {}
	}`
	var want map[string]any
	if err := json.Unmarshal([]byte(captured), &want); err != nil {
		t.Fatalf("抓包样例不合法: %v", err)
	}

	if !reflect.DeepEqual(gotMap, want) {
		gb, _ := json.MarshalIndent(gotMap, "", "  ")
		wb, _ := json.MarshalIndent(want, "", "  ")
		t.Errorf("请求体与抓包不一致\n实际:\n%s\n期望:\n%s", gb, wb)
	}
}

// TestVideoCommonKeySetMatchesProbe 锁定视频 common 的键集合。
//
// 参照物是实测发布成功的那次探测请求（item.common + mix + anchor + assistant，
// 返回 status_code=0 并产出真实 item_id），而非推测。缺键可能退化为
// status_code=4，多键无害但不必要。
func TestVideoCommonKeySetMatchesProbe(t *testing.T) {
	c := common(t, mustVideo(t, VideoOptions{
		Vid:           "v1",
		Text:          "probe",
		Caption:       "probe",
		HashtagSource: "challenge",
	}))

	// 探测请求中出现的键，必须全部存在。
	required := []string{
		"text", "caption", "item_title", "activity", "text_extra", "challenges",
		"mentions", "hashtag_source", "hot_sentence", "interaction_stickers",
		"visibility_type", "download", "timing", "media_type", "video_id",
		"music_source", "music_id",
	}
	for _, k := range required {
		if _, ok := c[k]; !ok {
			t.Errorf("common 缺少必需键 %q", k)
		}
	}

	// 与探测请求一致的具体取值。
	if c["music_source"] != 0 {
		t.Errorf("common.music_source = %v, 期望 0", c["music_source"])
	}
	if v, ok := c["music_id"]; !ok || v != nil {
		t.Errorf("common.music_id = %v, 期望显式的 null", v)
	}
	if c["timing"] != 0 {
		t.Errorf("common.timing = %v, 期望 0", c["timing"])
	}
	if c["upload_source"] != 1 {
		t.Errorf("common.upload_source = %v, 期望 1", c["upload_source"])
	}
}

// TestVideoCreationIDIsSent 抓包中带 creation_id，用于幂等。
func TestVideoCreationIDIsSent(t *testing.T) {
	c := common(t, mustVideo(t, VideoOptions{Vid: "v1", CreationID: "cid-x"}))
	if c["creation_id"] != "cid-x" {
		t.Errorf("common.creation_id = %v, 期望 cid-x", c["creation_id"])
	}
}

func TestMustJSONHandlesNil(t *testing.T) {
	if got := mustJSON(nil); got != "[]" {
		t.Errorf("mustJSON(nil) = %q", got)
	}
	// 类型化 nil 切片也不能变成 null。
	var s []string
	if got := mustJSON(s); got != "[]" {
		t.Errorf("mustJSON(nil slice) = %q", got)
	}
}

func mustVideo(t *testing.T, o VideoOptions) map[string]any {
	t.Helper()
	item, err := Video(o)
	if err != nil {
		t.Fatalf("构建失败: %v", err)
	}
	return item
}
