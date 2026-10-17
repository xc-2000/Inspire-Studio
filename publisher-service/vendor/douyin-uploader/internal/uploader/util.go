package uploader

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"math/big"

	"douyin-uploader/internal/crc32util"
)

// crcHex 返回 CRC32 的 8 位小写十六进制表示（与 SDK 的 re() 一致）。
func crcHex(b []byte) string {
	return crc32util.Format(crc32util.Sum(b))
}

// sha256Hex 返回 SHA256 的十六进制小写表示。
func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

const randAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789"

// randString 生成指定长度的随机小写字母数字串。
//
// 对应 SDK 里 Math.random().toString(36).substr(2) 的用途：给中间层去重用的随机标记。
func randString(n int) string {
	out := make([]byte, n)
	max := big.NewInt(int64(len(randAlphabet)))
	for i := range out {
		v, err := rand.Int(rand.Reader, max)
		if err != nil {
			// 极端情况下退化为固定值，只影响去重标记，不影响正确性。
			out[i] = randAlphabet[0]
			continue
		}
		out[i] = randAlphabet[v.Int64()]
	}
	return string(out)
}
