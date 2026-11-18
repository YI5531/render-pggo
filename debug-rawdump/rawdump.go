package aistudio

// 调试补丁（render-pggo debug-rawdump）：A2A_RAWDUMP=1 时把每个 GenerateContent 原始帧的结构打到 stderr。
// 长字符串（>=80 字节）只记路径、长度和开头 100 字节；其余结构压成骨架，单帧最多 1500 字节。
import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync/atomic"
)

var rawDumpFrame atomic.Int64

func rawDumpWalk(v any, path string, longs *[]string) any {
	switch x := v.(type) {
	case string:
		if len(x) >= 80 {
			head := x
			if len(head) > 100 {
				head = head[:100]
			}
			*longs = append(*longs, fmt.Sprintf("%s len=%d head=%q", path, len(x), head))
			return fmt.Sprintf("<str %d>", len(x))
		}
		return x
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = rawDumpWalk(e, fmt.Sprintf("%s[%d]", path, i), longs)
		}
		return out
	case map[string]any:
		out := map[string]any{}
		for k, e := range x {
			out[k] = rawDumpWalk(e, path+"."+k, longs)
		}
		return out
	}
	return v
}

func dumpRawFrame(raw json.RawMessage) {
	if os.Getenv("A2A_RAWDUMP") != "1" {
		return
	}
	n := rawDumpFrame.Add(1)
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		head := string(raw)
		if len(head) > 300 {
			head = head[:300]
		}
		fmt.Fprintf(os.Stderr, "[rawdump] frame=%d bytes=%d unmarshal_err=%v head=%q\n", n, len(raw), err, head)
		return
	}
	var longs []string
	skel, _ := json.Marshal(rawDumpWalk(v, "$", &longs))
	s := string(skel)
	if len(s) > 1500 {
		s = s[:1500] + "…"
	}
	fmt.Fprintf(os.Stderr, "[rawdump] frame=%d bytes=%d skel=%s\n", n, len(raw), s)
	if len(longs) > 0 {
		fmt.Fprintf(os.Stderr, "[rawdump] frame=%d longs: %s\n", n, strings.Join(longs, " | "))
	}
}
