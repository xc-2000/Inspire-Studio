package crc32util

import "testing"

func TestSumKnownValues(t *testing.T) {
	// 这些是与浏览器端 SDK 一致的 IEEE CRC32 结果。
	cases := []struct {
		in   string
		want uint32
	}{
		{"", 0},
		{"a", 0xe8b7be43},
		{"abc", 0x352441c2},
		{"123456789", 0xcbf43926},
		{"The quick brown fox jumps over the lazy dog", 0x414fa339},
	}
	for _, c := range cases {
		if got := Sum([]byte(c.in)); got != c.want {
			t.Errorf("Sum(%q) = %#08x, 期望 %#08x", c.in, got, c.want)
		}
	}
}

func TestFormatIsZeroPaddedLowerHex(t *testing.T) {
	// 服务端要求 8 位小写十六进制；少一位都会导致分片校验失败。
	cases := []struct {
		in   uint32
		want string
	}{
		{0, "00000000"},
		{0xe8b7be43, "e8b7be43"},
		{1, "00000001"},
		{0xabcdef, "00abcdef"},
	}
	for _, c := range cases {
		if got := Format(c.in); got != c.want {
			t.Errorf("Format(%#x) = %q, 期望 %q", c.in, got, c.want)
		}
	}
}

func TestHexMatchesFormat(t *testing.T) {
	data := []byte("hello world")
	if Hex(data) != Format(Sum(data)) {
		t.Errorf("Hex 与 Format(Sum) 不一致")
	}
}

func TestChecksummerMatchesSum(t *testing.T) {
	data := []byte("chunk data for upload")
	c := NewChecksummer()
	// 分两次写入，结果必须与一次性计算相同。
	if _, err := c.Write(data[:5]); err != nil {
		t.Fatalf("Write 失败: %v", err)
	}
	if _, err := c.Write(data[5:]); err != nil {
		t.Fatalf("Write 失败: %v", err)
	}
	if got, want := c.Sum32(), Sum(data); got != want {
		t.Errorf("流式 CRC = %#08x, 期望 %#08x", got, want)
	}
	if got, want := c.Hex(), Format(Sum(data)); got != want {
		t.Errorf("Hex = %q, 期望 %q", got, want)
	}
}
