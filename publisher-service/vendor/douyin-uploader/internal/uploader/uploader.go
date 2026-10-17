package uploader

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// RawCommitImages 完成一次图片上传并返回 Commit 的原始结果，仅用于诊断。
func (c *Client) RawCommitImages(ctx context.Context, paths []string, creds Credentials) ([]map[string]any, *UploadSession, error) {
	type fd struct {
		data []byte
		crc  string
	}
	files := make([]fd, 0, len(paths))
	sizes := make([]int64, 0, len(paths))
	for _, p := range paths {
		data, err := os.ReadFile(p)
		if err != nil {
			return nil, nil, err
		}
		files = append(files, fd{data: data, crc: crcHex(data)})
		sizes = append(sizes, int64(len(data)))
	}
	session, err := c.applyUpload(ctx, ServiceImageX, TypeImage, creds, ApplyOptions{FileSizes: sizes})
	if err != nil {
		return nil, nil, err
	}
	for i, f := range files {
		info := session.StoreInfos[i]
		if err := c.uploadDirect(ctx, &UploadSession{
			Service:      session.Service,
			TOSDomain:    session.TOSDomain,
			UploadHeader: session.UploadHeader,
			StoreInfos:   []StoreInfo{info},
		}, [][]byte{f.data}, []string{f.crc}); err != nil {
			return nil, session, err
		}
	}
	results, err := c.commit(ctx, session, ServiceImageX, creds)
	return results, session, err
}

// UploadVideo 上传一个视频文件，返回 vid 与封面等信息。
//
// 完整链路：Apply → init → 分片(并发) → 合并 → Commit。
// 小文件（<=3MB）会退化为直传。
func (c *Client) UploadVideo(ctx context.Context, path string, creds Credentials) (*VideoResult, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("打开视频失败: %w", err)
	}
	defer f.Close()

	stat, err := f.Stat()
	if err != nil {
		return nil, fmt.Errorf("读取视频信息失败: %w", err)
	}
	if stat.Size() == 0 {
		return nil, fmt.Errorf("视频文件为空: %s", path)
	}

	name := filepath.Base(path)
	session, err := c.applyUpload(ctx, ServiceVOD, TypeVideo, creds, ApplyOptions{
		FileSize:         stat.Size(),
		FileName:         name,
		UseFileExtension: true,
	})
	if err != nil {
		return nil, err
	}
	c.logf("Apply 成功：host=%s tos=%s sessionKey 长度=%d", session.Host, session.TOSDomain, len(session.SessionKey))

	info := session.StoreInfos[0]

	if c.IsDirect(stat.Size(), false) {
		c.logf("文件 %d 字节，走直传", stat.Size())
		data := make([]byte, stat.Size())
		if _, err := f.ReadAt(data, 0); err != nil && err.Error() != "EOF" {
			return nil, fmt.Errorf("读取视频内容失败: %w", err)
		}
		crc := crcHex(data)
		if err := c.uploadDirect(ctx, session, [][]byte{data}, []string{crc}); err != nil {
			return nil, err
		}
	} else {
		if err := c.uploadSliced(ctx, session, info, f, stat.Size()); err != nil {
			return nil, err
		}
	}

	results, err := c.commit(ctx, session, ServiceVOD, creds)
	if err != nil {
		return nil, err
	}
	res := results[0]

	vid := stringField(res, "vid", "Vid")
	if vid == "" {
		return nil, fmt.Errorf("Commit 响应里没有 vid；结果: %v", res)
	}
	return &VideoResult{
		Vid:       vid,
		PosterURI: stringField(res, "posterUri", "PosterUri", "poster_uri"),
		Meta:      metaField(res),
		Raw:       res,
	}, nil
}

// uploadSliced 完成分片上传的全过程：init → 并发传片 → 合并。
func (c *Client) uploadSliced(ctx context.Context, session *UploadSession, info StoreInfo, f *os.File, size int64) error {
	uploadID, err := c.initUpload(ctx, session, info)
	if err != nil {
		return err
	}
	c.logf("init 得到 uploadid=%s", uploadID)

	// 尝试断点续传：若服务端已有分片则跳过它们。
	done := map[int]bool{}
	if parts, err := c.partList(ctx, session, info, uploadID); err == nil && len(parts) > 0 {
		done = parts
		c.logf("服务端已有 %d 个分片，将跳过", len(parts))
	}

	sd, err := c.sliceReader(f, size)
	if err != nil {
		return err
	}

	success := make([]part, 0, len(sd.Infos))
	for _, p := range sd.Infos {
		if done[p.Number] {
			success = append(success, p)
		}
	}

	// 并发上传，并发度沿用 SDK 的 uploadSliceCount。
	concurrency := DefaultUploadSliceCount
	var mu sync.Mutex
	var firstErr error
	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup

	for i := range sd.Infos {
		p := sd.Infos[i]
		if done[p.Number] {
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()

			mu.Lock()
			failed := firstErr != nil
			mu.Unlock()
			if failed {
				return
			}

			data := sd.Parts[p.Number-1]
			var lastErr error
			// SDK 默认重试 2 次；创作者中心配置为 5 次。
			for attempt := 0; attempt < DefaultRetryUploadTime; attempt++ {
				if err := c.putPart(ctx, session, info, uploadID, p, data, ""); err != nil {
					lastErr = err
					continue
				}
				lastErr = nil
				break
			}
			if lastErr != nil {
				mu.Lock()
				if firstErr == nil {
					firstErr = lastErr
				}
				mu.Unlock()
				return
			}
			mu.Lock()
			success = append(success, p)
			mu.Unlock()
		}()
	}
	wg.Wait()
	if firstErr != nil {
		return firstErr
	}

	// 合并列表必须按分片号升序，且覆盖全部分片。
	sortParts(success)
	if len(success) != len(sd.Infos) {
		return fmt.Errorf("分片数量不一致：应有 %d 片，实际成功 %d 片", len(sd.Infos), len(success))
	}
	return c.finishMerge(ctx, session, info, uploadID, success, "")
}

// UploadImages 上传一批图片，返回每张图片的 uri。
//
// 图片默认走 ImageX；文件较小时走直传，否则分片。
func (c *Client) UploadImages(ctx context.Context, paths []string, creds Credentials) ([]ImageResult, error) {
	if len(paths) == 0 {
		return nil, fmt.Errorf("至少需要一张图片")
	}

	type fileData struct {
		path string
		data []byte
		crc  string
	}
	files := make([]fileData, 0, len(paths))
	sizes := make([]int64, 0, len(paths))

	for _, p := range paths {
		data, err := os.ReadFile(p)
		if err != nil {
			return nil, fmt.Errorf("读取图片 %s 失败: %w", p, err)
		}
		if len(data) == 0 {
			return nil, fmt.Errorf("图片文件为空: %s", p)
		}
		files = append(files, fileData{path: p, data: data, crc: crcHex(data)})
		sizes = append(sizes, int64(len(data)))
	}

	session, err := c.applyUpload(ctx, ServiceImageX, TypeImage, creds, ApplyOptions{
		FileSizes: sizes,
		FileName:  filepath.Base(paths[0]),
	})
	if err != nil {
		return nil, err
	}
	c.logf("Apply 成功：host=%s tos=%s sessionKey 长度=%d 存储项=%d",
		session.Host, session.TOSDomain, len(session.SessionKey), len(session.StoreInfos))

	if len(session.StoreInfos) < len(files) {
		return nil, fmt.Errorf("Apply 只返回 %d 个存储项，但有 %d 个文件",
			len(session.StoreInfos), len(files))
	}

	// 批量图片按直传处理：SDK 对 type=image 且为数组时走 direct。
	for i, f := range files {
		info := session.StoreInfos[i]
		if err := c.uploadDirect(ctx, &UploadSession{
			Service:      session.Service,
			TOSDomain:    session.TOSDomain,
			UploadHeader: session.UploadHeader,
			StoreInfos:   []StoreInfo{info},
		}, [][]byte{f.data}, []string{f.crc}); err != nil {
			return nil, fmt.Errorf("上传第 %d 张图片失败: %w", i+1, err)
		}
	}

	results, err := c.commit(ctx, session, ServiceImageX, creds)
	if err != nil {
		return nil, err
	}

	out := make([]ImageResult, 0, len(results))
	for i, res := range results {
		uri := stringField(res, "uri", "Uri", "URI")
		if uri == "" {
			return nil, fmt.Errorf("第 %d 张图片的 Commit 结果里没有 uri；结果: %v", i+1, res)
		}
		out = append(out, ImageResult{
			URI:      uri,
			ImageURI: stringField(res, "imageUri", "ImageUri", "image_uri", "ImageURI"),
			// 实测字段为 imageWidth / imageHeight（不是 width / height）。
			Width:  intField(res, "imageWidth", "width", "Width"),
			Height: intField(res, "imageHeight", "height", "Height"),
			Raw:    res,
		})
	}
	return out, nil
}

func sortParts(parts []part) {
	for i := 1; i < len(parts); i++ {
		for j := i; j > 0 && parts[j-1].Number > parts[j].Number; j-- {
			parts[j-1], parts[j] = parts[j], parts[j-1]
		}
	}
}
