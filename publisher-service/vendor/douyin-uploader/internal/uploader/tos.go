package uploader

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"douyin-uploader/internal/crc32util"
)

// tosCodeOK 是 TOS 接口的成功码。注意它不是 HTTP 状态码，而是响应体里的 code。
const tosCodeOK = 2000

// tosResponse 是 TOS 接口的通用响应外壳。
type tosResponse struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
}

// tosRequest 是发往 TOS 的一次请求。
type tosRequest struct {
	// URL 是完整地址（含查询串）。
	URL string
	// Auth 是 Apply 下发的 TOS 签名，直接作为 Authorization 头。
	Auth string
	// StorageU 会作为 X-Storage-U 发送（需 URL 编码）。
	StorageU string
	// Header 是 Apply 下发的附加头。
	Header HeaderMap
	// Extra 是本阶段特有的附加头。
	Extra map[string]string
	// Body 是请求体。
	Body []byte
	// ContentType 为空时按 body 类型推断。
	ContentType string
	// Timeout 覆盖默认超时。
	Timeout time.Duration
}

// tosDo 发送请求并校验 TOS 的 code == 2000。
func (c *Client) tosDo(ctx context.Context, r *tosRequest) (*tosResponse, error) {
	timeout := r.Timeout
	if timeout <= 0 {
		timeout = DefaultGatewayTimeout
	}
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	var reader io.Reader
	if r.Body != nil {
		reader = bytes.NewReader(r.Body)
	}
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, r.URL, reader)
	if err != nil {
		return nil, fmt.Errorf("构造 TOS 请求失败: %w", err)
	}
	if r.Auth != "" {
		req.Header.Set("Authorization", r.Auth)
	}
	if r.StorageU != "" {
		req.Header.Set("X-Storage-U", url.QueryEscape(r.StorageU))
	}
	for k, v := range r.Header {
		req.Header.Set(k, v)
	}
	for k, v := range r.Extra {
		req.Header.Set(k, v)
	}
	if r.ContentType != "" {
		req.Header.Set("Content-Type", r.ContentType)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("TOS 请求 %s 失败: %w", r.URL, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, fmt.Errorf("读取 TOS 响应失败: %w", err)
	}

	out := &tosResponse{}
	if err := json.Unmarshal(raw, out); err != nil {
		return nil, fmt.Errorf("解析 TOS 响应失败（HTTP %d）: %w；片段: %s", resp.StatusCode, err, snippet(raw))
	}
	if resp.StatusCode == http.StatusUnauthorized {
		return out, fmt.Errorf("TOS 返回 401：Auth 已失效（通常是凭证过期或重复使用）")
	}
	if resp.StatusCode >= 400 {
		return out, fmt.Errorf("TOS 请求 %s 返回 HTTP %d：%s", r.URL, resp.StatusCode, snippet(raw))
	}
	if out.Code != tosCodeOK {
		return out, fmt.Errorf("TOS 返回 code=%d message=%q；片段: %s", out.Code, out.Message, snippet(raw))
	}
	return out, nil
}

// initUpload 触发服务端初始化分片任务，返回 uploadid。
//
// 对应 SDK 的 initUploadID 阶段：gateway 模式下这一步是必需的。
func (c *Client) initUpload(ctx context.Context, s *UploadSession, info StoreInfo) (string, error) {
	u := fmt.Sprintf("%s/upload/v1/%s?uploadmode=part&phase=init",
		s.TOSDomain, url.PathEscape(info.StoreUri))

	res, err := c.tosDo(ctx, &tosRequest{
		URL:      u,
		Auth:     info.Auth,
		StorageU: s.storageU(c.cfg.UserID),
		Header:   info.UploadHeader,
		Extra:    c.gatewayHeaders(nil, ""),
	})
	if err != nil {
		return "", fmt.Errorf("初始化分片上传失败: %w", err)
	}
	var data struct {
		UploadID string `json:"uploadid"`
	}
	if err := json.Unmarshal(res.Data, &data); err != nil {
		return "", fmt.Errorf("解析 init 响应失败: %w；片段: %s", err, snippet(res.Data))
	}
	if data.UploadID == "" {
		return "", fmt.Errorf("init 响应里没有 uploadid；片段: %s", snippet(res.Data))
	}
	return data.UploadID, nil
}

// partList 查询服务端已有分片，用于断点续传。
//
// 返回已完成的分片号集合。
func (c *Client) partList(ctx context.Context, s *UploadSession, info StoreInfo, uploadID string) (map[int]bool, error) {
	u := fmt.Sprintf("%s/upload/v1/%s?uploadid=%s&action=part_list",
		s.TOSDomain, url.PathEscape(info.StoreUri), url.QueryEscape(uploadID))

	reqCtx, cancel := context.WithTimeout(ctx, DefaultGatewayTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, u, nil)
	if err != nil {
		return nil, fmt.Errorf("构造 part_list 请求失败: %w", err)
	}
	if info.Auth != "" {
		req.Header.Set("Authorization", info.Auth)
	}
	if v := s.storageU(c.cfg.UserID); v != "" {
		req.Header.Set("X-Storage-U", url.QueryEscape(v))
	}
	for k, v := range info.UploadHeader {
		req.Header.Set(k, v)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("查询分片列表失败: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, fmt.Errorf("读取分片列表失败: %w", err)
	}
	// HTTP >= 400 意味着断点信息不可用，调用方应从头开始传。
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("分片列表不可用（HTTP %d）", resp.StatusCode)
	}

	var out struct {
		Code int `json:"code"`
		Data struct {
			PartList []struct {
				PartNumber int `json:"part_number"`
			} `json:"partlist"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("解析分片列表失败: %w；片段: %s", err, snippet(raw))
	}
	done := make(map[int]bool, len(out.Data.PartList))
	for _, p := range out.Data.PartList {
		done[p.PartNumber] = true
	}
	return done, nil
}

// part 描述一个待上传的分片。
type part struct {
	// Number 是分片序号，从 1 开始。
	Number int
	// Offset 是分片在文件中的起始偏移。
	Offset int64
	// Size 是分片长度。
	Size int64
	// CRC32 是分片内容的 CRC32（8 位小写十六进制）。
	CRC32 string
}

// putPart 上传一个分片。
//
// 注意 URL 上同时带 part_number 与 part_offset；cacheOptions 模式走另一套头。
func (c *Client) putPart(ctx context.Context, s *UploadSession, info StoreInfo, uploadID string, p part, data []byte, largeUploadID string) error {
	u := fmt.Sprintf("%s/upload/v1/%s?uploadid=%s&part_number=%d&phase=transfer&part_offset=%d",
		s.TOSDomain, url.PathEscape(info.StoreUri), url.QueryEscape(uploadID), p.Number, p.Offset)

	extra := map[string]string{
		"Content-CRC32": p.CRC32,
	}
	for k, v := range c.gatewayHeaders(nil, largeUploadID) {
		extra[k] = v
	}

	res, err := c.tosDo(ctx, &tosRequest{
		URL:         u,
		Auth:        info.Auth,
		StorageU:    s.storageU(c.cfg.UserID),
		Header:      info.UploadHeader,
		Extra:       extra,
		Body:        data,
		ContentType: "application/octet-stream",
		Timeout:     10 * time.Minute,
	})
	if err != nil {
		return fmt.Errorf("上传第 %d 片失败: %w", p.Number, err)
	}
	// gateway 模式会回传 large_upload_id，后续请求需要带上。
	if largeUploadID == "" && len(res.Data) > 0 {
		var d struct {
			LargeUploadID string `json:"large_upload_id"`
		}
		if json.Unmarshal(res.Data, &d) == nil && d.LargeUploadID != "" {
			c.logf("服务端返回 large_upload_id=%s", d.LargeUploadID)
		}
	}
	return nil
}

// finishMerge 触发服务端合并分片。
//
// 请求体是纯文本的 "1:crc1,2:crc2"，不是 JSON。
func (c *Client) finishMerge(ctx context.Context, s *UploadSession, info StoreInfo, uploadID string, parts []part, largeUploadID string) error {
	u := fmt.Sprintf("%s/upload/v1/%s?uploadmode=part&phase=finish&uploadid=%s",
		s.TOSDomain, url.PathEscape(info.StoreUri), url.QueryEscape(uploadID))

	var b strings.Builder
	for i, p := range parts {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(strconv.Itoa(p.Number))
		b.WriteByte(':')
		b.WriteString(p.CRC32)
	}

	extra := map[string]string{"Content-Type": "text/plain"}
	for k, v := range c.gatewayHeaders(parts, largeUploadID) {
		extra[k] = v
	}

	res, err := c.tosDo(ctx, &tosRequest{
		URL:         u,
		Auth:        info.Auth,
		StorageU:    s.storageU(c.cfg.UserID),
		Header:      info.UploadHeader,
		Extra:       extra,
		Body:        []byte(b.String()),
		ContentType: "text/plain",
		Timeout:     2 * time.Minute,
	})
	if err != nil {
		return fmt.Errorf("合并分片失败: %w", err)
	}
	var data struct {
		Key string `json:"key"`
	}
	if err := json.Unmarshal(res.Data, &data); err != nil {
		return fmt.Errorf("解析合并响应失败: %w；片段: %s", err, snippet(res.Data))
	}
	if data.Key == "" {
		return fmt.Errorf("合并成功但未返回 key；片段: %s", snippet(res.Data))
	}
	return nil
}

// gatewayHeaders 返回 gateway 模式所需的附加头。
//
// 对应 SDK 里 gatewayUpload 分支的三件套。
func (c *Client) gatewayHeaders(parts []part, largeUploadID string) map[string]string {
	h := map[string]string{
		"X-Use-Init-Upload-Optimize": "1",
	}
	// 首批上传时才带本地缓存标记；全部分片完成后不再需要。
	if len(parts) == 0 {
		h["X-Use-Large-Local-Cache"] = "1"
	}
	if largeUploadID != "" {
		h["X-Large-Upload-Id"] = largeUploadID
	}
	return h
}

// uploadDirect 直传：小文件、批量图片走这条路。每个存储项一个 POST，无 init / merge。
func (c *Client) uploadDirect(ctx context.Context, s *UploadSession, data [][]byte, crcs []string) error {
	for i := range data {
		info := s.StoreInfos[i]
		u := fmt.Sprintf("%s/upload/v1/%s", s.TOSDomain, url.PathEscape(info.StoreUri))
		_, err := c.tosDo(ctx, &tosRequest{
			URL:         u,
			Auth:        info.Auth,
			StorageU:    s.storageU(c.cfg.UserID),
			Header:      info.UploadHeader,
			Extra:       map[string]string{"Content-CRC32": crcs[i]},
			Body:        data[i],
			ContentType: "application/octet-stream",
			Timeout:     10 * time.Minute,
		})
		if err != nil {
			return fmt.Errorf("直传第 %d 个文件失败: %w", i+1, err)
		}
	}
	return nil
}

// sliceFile 把一个 reader 切成若干分片并计算 CRC32。
//
// 返回的分片携带校验值，可直接用于上传与合并。
type sliceData struct {
	Parts [][]byte
	Infos []part
}

func (c *Client) sliceReader(r io.ReaderAt, size int64) (*sliceData, error) {
	sliceSize := c.SliceSize(size)
	out := &sliceData{}
	number := 1
	for offset := int64(0); offset < size; {
		n := sliceSize
		if offset+n > size {
			n = size - offset
		}
		buf := make([]byte, n)
		if _, err := r.ReadAt(buf, offset); err != nil && err != io.EOF {
			return nil, fmt.Errorf("读取第 %d 片失败: %w", number, err)
		}
		out.Parts = append(out.Parts, buf)
		out.Infos = append(out.Infos, part{
			Number: number,
			Offset: offset,
			Size:   n,
			CRC32:  crc32util.Format(crc32util.Sum(buf)),
		})
		offset += n
		number++
	}
	return out, nil
}
