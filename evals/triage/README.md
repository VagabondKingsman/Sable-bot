# Triage eval (W2a)

Regression set for `src/lib/agent/proactive/triage.ts`. Idea adapted from
OpenDuet `evals/triage` (MIT, CopilotKit); the 40 cases here are new and invented
(no real mail): approval asks, routine/job results, webhook events, Telegram
messages, and mail (needs reply, FYI, promotions, auto-replies, calendar
answers, phishing / prompt injection).

- `build-set.mjs` writes `items.jsonl` — edit it and re-run `node evals/triage/build-set.mjs`.
- `run.mjs` runs rules + offline heuristic and checks gates: rules 100% right,
  needs_approval recall 100%, needs_reply recall ≥ 90% / precision ≥ 80%,
  accuracy ≥ 85%, every verdict has a reason.

```sh
node --experimental-strip-types evals/triage/run.mjs
```

Small and invented: a regression check, not proof of accuracy on a real inbox.
