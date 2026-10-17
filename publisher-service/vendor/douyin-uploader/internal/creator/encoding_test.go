package creator

import (
	"testing"
	"time"
)

func nowMillis() int64 { return time.Now().UnixMilli() }

func TestEncodeURIComponent(t *testing.T) {
	// 期望值与浏览器 encodeURIComponent 的输出一致。
	cases := []struct {
		in, want string
	}{
		{"", ""},
		{"abcXYZ019", "abcXYZ019"},
		{"-_.!~*'()", "-_.!~*'()"},
		{"a b", "a%20b"},                // 空格必须是 %20，不是 +
		{"a+b", "a%2Bb"},                // 加号必须转义
		{"a&b=c", "a%26b%3Dc"},          // 分隔符必须转义
		{"100%", "100%25"},              // 百分号必须转义
		{"#/?:@", "%23%2F%3F%3A%40"},    // 保留字符必须转义
		{"中文", "%E4%B8%AD%E6%96%87"},    // UTF-8 逐字节转义
		{"emoji😀", "emoji%F0%9F%98%80"}, // 四字节字符
		{"a[b]", "a%5Bb%5D"},            // 方括号转义
		{"it's", "it's"},                // 单引号不转义
		{`a\b`, `a%5Cb`},                // 反斜杠转义
	}
	for _, c := range cases {
		if got := encodeURIComponent(c.in); got != c.want {
			t.Errorf("encodeURIComponent(%q) = %q, 期望 %q", c.in, got, c.want)
		}
	}
}

func TestEncodeQueryOrderAndFormat(t *testing.T) {
	params := []Param{
		{"aid", "2906"},
		{"read_aid", "2906"},
		{"text", "hello world"},
	}
	got := encodeQuery(params)
	want := "aid=2906&read_aid=2906&text=hello%20world"
	if got != want {
		t.Errorf("encodeQuery = %q, 期望 %q", got, want)
	}
}

func TestEncodeQuerySkipsEmptyKey(t *testing.T) {
	got := encodeQuery([]Param{{"", "x"}, {"a", "1"}})
	if got != "a=1" {
		t.Errorf("encodeQuery = %q, 期望 \"a=1\"", got)
	}
}

func TestClockSyncIgnoresSmallDrift(t *testing.T) {
	c := &ClockSync{}
	base := nowMillis()
	c.Update(base + 5_000) // 5 秒偏差：应忽略
	if c.Offset() != 0 {
		t.Errorf("5 秒偏差不应触发校准，实际 offset=%s", c.Offset())
	}
}

func TestClockSyncAppliesLargeDrift(t *testing.T) {
	c := &ClockSync{}
	base := nowMillis()
	drift := int64(15 * 60 * 1000) // 15 分钟
	c.Update(base + drift)
	off := c.Offset()
	// 允许秒级误差（测量本身耗时）。
	if off < 14*60*1e9 || off > 16*60*1e9 {
		t.Errorf("15 分钟偏差应被记录，实际 offset=%v", off)
	}
	if c.Now().Sub(time.Now()) < 14*60*1e9 {
		t.Errorf("Now() 未应用校准")
	}
}

func TestClockSyncZeroIsNoop(t *testing.T) {
	c := &ClockSync{}
	c.Update(0)
	if c.Offset() != 0 {
		t.Errorf("0 不应触发校准")
	}
}
