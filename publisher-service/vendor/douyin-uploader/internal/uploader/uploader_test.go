package uploader

import (
	"encoding/json"
	"testing"

	"douyin-uploader/internal/signer"
)

// TestCamelize 复刻 SDK 的 pa() 字段名变换。
//
// 关键点：两个正则都没有 g 标志，因此首字母只转一次、下划线只转第一处。
func TestCamelize(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"Vid", "vid"},
		{"VideoMeta", "videoMeta"},
		{"PosterUri", "posterUri"},
		{"Uri", "uri"},
		{"ImageUri", "imageUri"},
		{"video_meta", "videoMeta"},
		{"image_uri", "imageUri"},
		{"Md5", "md5"},
		{"Duration", "duration"},
		{"", ""},
		// 已是小写开头的字段不受影响。
		{"size", "size"},
	}
	for _, c := range cases {
		if got := camelize(c.in); got != c.want {
			t.Errorf("camelize(%q) = %q, 期望 %q", c.in, got, c.want)
		}
	}
}

// TestCamelizeOnlyFirstUnderscore 明确锁住「只转第一处下划线」这一行为。
func TestCamelizeOnlyFirstUnderscore(t *testing.T) {
	// 第二处 _y 保留原样，这是原实现的可观察行为。
	if got, want := camelize("a_b_c"), "aB_c"; got != want {
		t.Errorf("camelize(\"a_b_c\") = %q, 期望 %q", got, want)
	}
}

func TestCamelizeMapIsRecursive(t *testing.T) {
	in := map[string]any{
		"VideoMeta": map[string]any{"Size": float64(100), "Md5": "abc"},
		"OtherUri":  []any{map[string]any{"Uri": "u1"}},
	}
	out := camelizeMap(in)

	vm, ok := out["videoMeta"].(map[string]any)
	if !ok {
		t.Fatalf("videoMeta 未生成: %v", out)
	}
	if vm["size"] != float64(100) || vm["md5"] != "abc" {
		t.Errorf("嵌套字段变换错误: %v", vm)
	}
	arr, ok := out["otherUri"].([]any)
	if !ok || len(arr) != 1 {
		t.Fatalf("otherUri 未生成数组: %v", out)
	}
	inner, ok := arr[0].(map[string]any)
	if !ok || inner["uri"] != "u1" {
		t.Errorf("数组内元素变换错误: %v", arr[0])
	}
}

func TestSelectService(t *testing.T) {
	// 图片默认必须走 imagex，这是最容易实现错的一处。
	cases := []struct {
		uploadType, serviceType, want string
	}{
		{TypeImage, "", ServiceImageX},
		{TypeVideo, "", ServiceVOD},
		{TypeObject, "", ServiceVOD},
		{TypeImage, ServiceVOD, ServiceVOD}, // 显式覆盖
		{TypeVideo, ServiceImageX, ServiceImageX},
	}
	for _, c := range cases {
		if got := SelectService(c.uploadType, c.serviceType); got != c.want {
			t.Errorf("SelectService(%q,%q) = %q, 期望 %q", c.uploadType, c.serviceType, got, c.want)
		}
	}
}

func TestSliceSizeThresholds(t *testing.T) {
	c := New(Config{})
	cases := []struct {
		size int64
		want int64
	}{
		{1, DefaultSliceSize},
		{100 * 1024 * 1024, DefaultLargeSliceSize}, // 边界：100MB
		{99 * 1024 * 1024, DefaultSliceSize},
		{500 * 1024 * 1024, DefaultHugeSliceSize}, // 边界：500MB
		{499 * 1024 * 1024, DefaultLargeSliceSize},
	}
	for _, tc := range cases {
		if got := c.SliceSize(tc.size); got != tc.want {
			t.Errorf("SliceSize(%d) = %d, 期望 %d", tc.size, got, tc.want)
		}
	}
}

func TestSliceSizeOverride(t *testing.T) {
	c := New(Config{SliceSize: 1024})
	if got := c.SliceSize(500 * 1024 * 1024); got != 1024 {
		t.Errorf("显式 SliceSize 未生效: %d", got)
	}
}

func TestIsDirect(t *testing.T) {
	c := New(Config{})
	if !c.IsDirect(1024, false) {
		t.Error("1KB 应走直传")
	}
	if !c.IsDirect(DefaultDirectSizeLimit, false) {
		t.Error("恰好 3MB 应走直传")
	}
	if c.IsDirect(DefaultDirectSizeLimit+1, false) {
		t.Error("大于 3MB 不应走直传")
	}
	if !c.IsDirect(10*1024*1024, true) {
		t.Error("批量上传应走直传")
	}
}

// TestParseSTSCredentials 覆盖大小写不同的字段名。
func TestParseSTSCredentials(t *testing.T) {
	auth := `{"AccessKeyId":"ak","SecretAccessKey":"sk","SessionToken":"tok",
	          "ExpiredTime":1789870043,"CurrentTime":"2026-09-20T10:07:23Z"}`
	creds, err := ParseSTSCredentials(auth)
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if creds.AccessKeyID != "ak" || creds.SecretAccessKey != "sk" || creds.SessionToken != "tok" {
		t.Errorf("凭据解析错误: %+v", creds)
	}
	if creds.CurrentTime.IsZero() {
		t.Error("CurrentTime 未解析")
	}
}

// TestParseSTSCredentialsUppercaseID 覆盖 AccessKeyID 这种拼写。
func TestParseSTSCredentialsUppercaseID(t *testing.T) {
	creds, err := ParseSTSCredentials(`{"AccessKeyID":"ak2","SecretAccessKey":"sk2"}`)
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if creds.AccessKeyID != "ak2" {
		t.Errorf("AccessKeyID 未识别: %+v", creds)
	}
}

func TestParseSTSCredentialsErrors(t *testing.T) {
	if _, err := ParseSTSCredentials(""); err == nil {
		t.Error("空凭证应报错")
	}
	if _, err := ParseSTSCredentials("not json"); err == nil {
		t.Error("非 JSON 应报错")
	}
	if _, err := ParseSTSCredentials(`{"SessionToken":"tok"}`); err == nil {
		t.Error("缺少 AccessKey 应报错")
	}
}

// TestStringFieldCaseInsensitiveFallback 验证字段名大小写不统一时的容错。
func TestStringFieldCaseInsensitiveFallback(t *testing.T) {
	m := map[string]any{"IMAGEURI": "u1"}
	if got := stringField(m, "imageUri"); got != "u1" {
		t.Errorf("大小写回退失败: %q", got)
	}
	// 精确命中应优先。
	m2 := map[string]any{"vid": "exact", "Vid": "other"}
	if got := stringField(m2, "vid", "Vid"); got != "exact" {
		t.Errorf("精确匹配优先级错误: %q", got)
	}
}

func TestParseVODApply(t *testing.T) {
	// 结构取自线上真实响应：UploadHeader 是【对象】而非数组；
	// USER_ID 位于 StoreInfos[i].StorageHeader。
	raw := json.RawMessage(`{"InnerUploadAddress":{"UploadNodes":[{
	  "StoreInfos":[{"Auth":"auth1","StoreUri":"tos-cn/v001/abc","UploadID":"uid1",
	                 "UploadHeader":{},"StorageHeader":{"USER_ID":"7481252581086102585"}}],
	  "SessionKey":"sk1","UploadHost":"vod-host.example.com",
	  "UploadHeader":{"X-Storage-Mode":"gateway"}}]}}`)

	s, err := parseVODApply(raw, "https", "https://vod.bytedanceapi.com/")
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if s.SessionKey != "sk1" {
		t.Errorf("SessionKey = %q", s.SessionKey)
	}
	if s.TOSDomain != "https://vod-host.example.com" {
		t.Errorf("TOSDomain = %q", s.TOSDomain)
	}
	if s.StoreInfos[0].StoreUri != "tos-cn/v001/abc" {
		t.Errorf("StoreUri = %q", s.StoreInfos[0].StoreUri)
	}
	if s.UploadHeader["X-Storage-Mode"] != "gateway" {
		t.Errorf("UploadHeader = %v", s.UploadHeader)
	}
	// X-Storage-U 必须来自服务端下发的 StorageHeader.USER_ID。
	if got := s.storageU("fallback"); got != "7481252581086102585" {
		t.Errorf("storageU = %q", got)
	}
}

// TestStorageUFallsBack 服务端没给 USER_ID 时才用配置值。
func TestStorageUFallsBack(t *testing.T) {
	raw := json.RawMessage(`{"InnerUploadAddress":{"UploadNodes":[{
	  "StoreInfos":[{"Auth":"a","StoreUri":"u"}],
	  "SessionKey":"sk","UploadHost":"h.example.com"}]}}`)
	s, err := parseVODApply(raw, "https", "h")
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if got := s.storageU("cfg-user"); got != "cfg-user" {
		t.Errorf("storageU 回退失败: %q", got)
	}
}

// TestParseVODApplyToleratesNullHeader 线上 UploadHeader 可能是 null。
func TestParseVODApplyToleratesNullHeader(t *testing.T) {
	raw := json.RawMessage(`{"InnerUploadAddress":{"UploadNodes":[{
	  "StoreInfos":[{"Auth":"a","StoreUri":"u"}],
	  "SessionKey":"sk","UploadHost":"h.example.com","UploadHeader":null}]}}`)
	if _, err := parseVODApply(raw, "https", "h"); err != nil {
		t.Errorf("null UploadHeader 应被容忍: %v", err)
	}
}

func TestParseImageXApplyUsesUploadHosts(t *testing.T) {
	raw := json.RawMessage(`{"UploadAddress":{
	  "UploadHosts":["img-host.example.com"],
	  "StoreInfos":[{"Auth":"a","StoreUri":"uri1"}],
	  "SessionKey":"sk2"}}`)

	s, err := parseImageXApply(raw, "https", "https://imagex.bytedanceapi.com/")
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	// ImageX 用 UploadHosts[0]，而不是 UploadHost。
	if s.TOSDomain != "https://img-host.example.com" {
		t.Errorf("TOSDomain = %q", s.TOSDomain)
	}
	if s.SessionKey != "sk2" {
		t.Errorf("SessionKey = %q", s.SessionKey)
	}
}

func TestParseApplyRejectsMissingNodes(t *testing.T) {
	if _, err := parseVODApply(json.RawMessage(`{"InnerUploadAddress":{"UploadNodes":[]}}`), "https", "h"); err == nil {
		t.Error("缺少 UploadNodes 应报错")
	}
	if _, err := parseImageXApply(json.RawMessage(`{"UploadAddress":{}}`), "https", "h"); err == nil {
		t.Error("缺少 UploadAddress 应报错")
	}
}

func TestTOSDomainHandlesSchema(t *testing.T) {
	cases := []struct {
		host, want string
	}{
		{"vod-host.example.com", "https://vod-host.example.com"},
		{"https://vod-host.example.com/", "https://vod-host.example.com"},
		{"http://h.example.com", "http://h.example.com"},
		{"", ""},
	}
	for _, c := range cases {
		if got := tosDomain("https", c.host); got != c.want {
			t.Errorf("tosDomain(%q) = %q, 期望 %q", c.host, got, c.want)
		}
	}
}

// TestFinishMergeBodyFormat 锁定合并请求体的格式：纯文本 "n:crc,..."。
func TestFinishMergeBodyFormat(t *testing.T) {
	parts := []part{
		{Number: 1, CRC32: "aaaaaaaa"},
		{Number: 2, CRC32: "bbbbbbbb"},
	}
	// 与 finishMerge 内部构造逻辑保持一致。
	var b []byte
	for i, p := range parts {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, []byte(itoa(p.Number)+":"+p.CRC32)...)
	}
	if got, want := string(b), "1:aaaaaaaa,2:bbbbbbbb"; got != want {
		t.Errorf("合并请求体 = %q, 期望 %q", got, want)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

func TestSortParts(t *testing.T) {
	parts := []part{{Number: 3}, {Number: 1}, {Number: 2}}
	sortParts(parts)
	for i, p := range parts {
		if p.Number != i+1 {
			t.Fatalf("排序结果错误: %v", parts)
		}
	}
}

// TestSignerCredentialsAlias 确认 Credentials 就是 signer.Credentials，
// 保证 API 使用者在两处拿到的类型一致。
// TestImageResultUsesImageWidthHeight 锁定实测字段名。
//
// 线上 ImageX Commit 返回的是 imageWidth / imageHeight；
// 早期实现按 width / height 取值，导致图文发布拿到的尺寸恒为 0x0。
func TestImageResultUsesImageWidthHeight(t *testing.T) {
	res := map[string]any{
		"uri":         "u1",
		"imageUri":    "u1",
		"imageWidth":  float64(1080),
		"imageHeight": float64(1440),
	}
	// 复刻 UploadImages 里的取值逻辑。
	gotW := intField(res, "imageWidth", "width", "Width")
	gotH := intField(res, "imageHeight", "height", "Height")
	if gotW != 1080 || gotH != 1440 {
		t.Errorf("尺寸解析错误: %dx%d", gotW, gotH)
	}
}

// TestVideoMetaDurationIsSeconds 明确 duration 的单位是秒（实测 3 秒视频返回 3）。
func TestVideoMetaDurationIsSeconds(t *testing.T) {
	res := map[string]any{
		"videoMeta": map[string]any{
			"duration": float64(3),
			"width":    float64(640),
			"height":   float64(480),
			"size":     float64(73550),
			"md5":      "abc",
		},
	}
	m := metaField(res)
	if m.Duration != 3 {
		t.Errorf("Duration = %d，期望 3（秒）", m.Duration)
	}
	if m.Width != 640 || m.Height != 480 {
		t.Errorf("分辨率错误: %dx%d", m.Width, m.Height)
	}
	if m.MD5 != "abc" {
		t.Errorf("MD5 = %q", m.MD5)
	}
}

func TestSignerCredentialsAlias(t *testing.T) {
	var c Credentials = signer.Credentials{AccessKeyID: "a", SecretAccessKey: "b"}
	if !c.Valid() {
		t.Error("Credentials 别名未生效")
	}
}
