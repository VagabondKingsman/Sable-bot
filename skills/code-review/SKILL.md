---
name: code-review
description: Review code in the workspace (or pasted) for bugs, security issues and clarity, with concrete fixes.
tools: [fs_list, fs_read]
---

1. Find the files (fs_list, fs_read) or use the pasted code. Do not write files unless the user asks; writes need approval.
2. Check in this order: correctness bugs → security (injection, path traversal, secrets in code, SSRF) → error handling → performance → readability.
3. Report findings as a table: Mức độ (cao/trung bình/thấp) · Vị trí (file:line) · Vấn đề · Cách sửa.
4. Give a minimal patch for each high-severity item.
5. End with one line: what is good about the code. Do not pad with style nits.
