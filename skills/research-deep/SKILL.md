---
name: research-deep
description: When the owner wants a deep, cited research report — point them to the Research panel (multi-step plan, parallel search/fetch, verified claim-level citations, Canvas report).
tools: []
---
# Deep research (W4)

Deep research runs as its own owner-started agent, not inside chat:

1. Open **Background → Research**, type the question, press **Start**.
2. The run plans sub-questions and queries, searches in parallel, fetches each source through
   the SSRF-guarded fetcher, dedupes sources and writes credibility notes.
3. The brief is written from numbered source passages only. Every cited claim must quote the
   fetched page verbatim; the verifier drops any citation whose quote is not in the fetched text
   (or is an instruction embedded in the page) and flags unsupported/weak claims.
4. The report is published as a Canvas page. Runs are capped by `SABLE_RESEARCH_RUN_USD`
   and a step cap, count as a heavy agent (max 2), and resume from checkpoints after a restart.

In chat: never invent citations. If you did not fetch a page this turn, do not cite it.
