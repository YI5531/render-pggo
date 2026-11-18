# debug-rawdump（临时调试，验证完即删）
给 AIStudio2API v0.3.11 打日志补丁：`A2A_RAWDUMP=1` 时打印 Google GenerateContent 原始帧结构，
用来确认合成工具写满 32768 时，Google 发回的 ~126KB 里有没有半截函数调用。
由 `.github/workflows/rawdump.yml` 在 GitHub Actions 编译并发布到 Release `rawdump-v0.3.11`。
