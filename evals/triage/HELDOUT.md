# Triage held-out set (W2c)

`heldout.jsonl` — 60 new invented items (`build-heldout.py`), written **before**
reading the triage heuristics and **never used for tuning**. Harder than the
40-item tuning set: indirect asks without "?", mixed Vietnamese/English, owner on
CC but asked by name, noreply senders that still need action (clinic, DocuSign,
Drive access, GitHub review), look-alike phishing, gift-card scam, list digests,
bounces, "no reply needed" notes. Labels: needs_reply 22, fyi 17, ignore 17,
needs_approval 4 (+4 Sable records decided by rules).

```sh
node --experimental-strip-types evals/triage/run.mjs --heldout              # rules + heuristic (offline)
node --experimental-strip-types evals/triage/run.mjs --heldout --llm grok-4.5  # light-model tier (costs ~60 small calls)
```

## Honest results (2026-11-05, ICT)

| Tier | Accuracy | needs_approval recall | needs_reply recall / precision | ignore recall |
|---|---|---|---|---|
| rules + heuristic (what runs today: `SABLE_MODEL_LIGHT` unset) | **65.0%** (39/60) | 100% | 55% / 92% | 41% |
| rules + `grok-4.5` light model | **93.3%** (56/60) | 100% | 95% / 100% | 82% |

Tuning set (40) for comparison: 100% offline — the gap shows the heuristic is
over-fitted to its own set. Heuristic misses: indirect Vietnamese asks
("gửi lại em… nhé", "báo giờ nào"), noreply-but-actionable senders, and most
scams/digests/bounces land in fyi (never in needs_reply, so nothing unsafe is
surfaced as urgent; precision of needs_reply stays 92%). Model misses: list
digest, a bounce, and an empty calendar decline → fyi; one item fell back to the
heuristic (model call timed out).

Not tuned after measuring. Suggestion (owner's call): set `SABLE_MODEL_LIGHT`
so the light-model tier is used in production.
