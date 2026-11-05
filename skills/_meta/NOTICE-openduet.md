# Third-party notice — OpenDuet (patterns only)

Sable's W2a proactive core adapts *ideas and structure* (not vendored code) from
OpenDuet by CopilotKit, reviewed read-only at `/workspace/openduet-research`:

- `openbot/server/src/openduet/triage.ts` — two-stage triage: narrow structural
  rules first (bulk + Promotions/Social, auto-reply, calendar answers), then a
  model asked for one JSON verdict with a reason; `decidedBy` recorded; item
  content fenced as data. Sable: `src/lib/agent/proactive/triage.ts` (four
  buckets, Sable-specific rules, offline heuristic fallback).
- `openbot/server/src/openduet/brief.ts` — morning brief composed from triaged
  items. Sable: `src/lib/agent/proactive/brief.ts` (deterministic, no LLM).
- `openbot/server/src/openduet/replies.ts`, `evals/reply-chips` — suggested
  reply chips that never send by themselves. Sable: `src/lib/agent/proactive/chips.ts`.
- `evals/triage` — labelled regression set + runner. Sable: `evals/triage`
  (new invented cases; none copied).

OpenBot is not vendored and Sable has no dependency on CopilotKit Intelligence.

Original license:

MIT License — Copyright (c) 2026 CopilotKit

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
