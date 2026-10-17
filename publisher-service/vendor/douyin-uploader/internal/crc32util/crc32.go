// Package crc32util 实现 TOS 分片上传所需的 CRC32 校验和。
//
// 算法与字节上传 SDK 内联的实现完全一致：IEEE 802.3 多项式 0xEDB88320（反射形式），
// 初值与终值均取反（即 zlib / hash/crc32.IEEE）。
//
// 之所以还要自己包一层：SDK 输出的形式是「小写十六进制、左侧补零到 8 位」，
// 例如 0x1a2b 输出为 "00001a2b"。Content-CRC32 头与分片合并请求体都必须用
// 这一形式，直接 strconv.FormatUint(v, 16) 会丢掉前导零导致服务端校验失败。
package crc32util

import (
	"hash/crc32"
	"strconv"
)

// table 是 IEEE 多项式的查找表。
var table = crc32.MakeTable(crc32.IEEE)

// Sum 计算 data 的 CRC32 值。
func Sum(data []byte) uint32 {
	return crc32.Checksum(data, table)
}

// Hex 返回 SDK 风格的小写十六进制串（定长 8 位，左侧补零）。
func Hex(data []byte) string {
	return Format(Sum(data))
}

// Format 把数值格式化为定长 8 位小写十六进制。
func Format(v uint32) string {
	s := strconv.FormatUint(uint64(v), 16)
	if len(s) >= 8 {
		return s
	}
	buf := make([]byte, 8)
	for i := 0; i < 8-len(s); i++ {
		buf[i] = '0'
	}
	copy(buf[8-len(s):], s)
	return string(buf)
}

// Checksummer 支持增量计算，用于边读分片边算校验和，避免大分片整体驻留内存。
type Checksummer struct {
	crc uint32
}

// NewChecksummer 返回一个增量计算器。
//
// 注意初值必须是 0 而不是 0xFFFFFFFF：Go 的 crc32.Update 内部已经对入参与返回值
// 各做一次取反（等价于 zlib 的 crc32()），传 0xFFFFFFFF 会多异或一次，
// 得到完全错误的校验和。
func NewChecksummer() *Checksummer {
	return &Checksummer{crc: 0}
}

// Write 追加数据，实现 io.Writer。
func (c *Checksummer) Write(p []byte) (int, error) {
	c.crc = crc32.Update(c.crc, table, p)
	return len(p), nil
}

// Sum32 返回当前 CRC32 值。
func (c *Checksummer) Sum32() uint32 {
	return c.crc
}

// Hex 返回定长 8 位十六进制形式。
func (c *Checksummer) Hex() string {
	return Format(c.Sum32())
}
