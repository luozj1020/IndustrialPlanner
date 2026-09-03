# Certified area benchmark

Representative v3a baseline measured on 2026-09-03 with OR-Tools 9.15.6755.
Each proof budget is an independent solve. `master gap` is the gap between the
placement-only incumbent and CP-SAT best bound; `full gap` uses the smaller of
the current routed UB and an instance-hash-matched best-known strict UB.

| case | current / best UB | mandatory rectangles | CP-SAT LB @ 0.5 / 2 / 10s | master gap @ 2s | full gap @ 2s | charged / origin / interior |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| iron-nugget | 66 / — | 37 | 39 / 39 / 39 | 0 | 27 (40.91%) | 39 / 12 / 15 |
| simple-chain | 42 / — | 34 | 36 / 36 / 36 | 0 | 6 (14.29%) | 37 / 0 / 5 |
| dense-scc-fanout | 484 / — | 241 | 241 / 241 / 242 | 5 | 243 (50.21%) | 318 / 0 / 166 |
| medium-battery-fan-in | 345 / 330 | 115 | 0 / 117 / 117 | 0 | 213 (64.55%) | 148 / 120 / 62 |

The medium best-known artifact is regenerated from the tracked 330-cell full
report by `certify-area-best-known`; it is not an unchecked handwritten UB.
The current 345-cell run therefore reports a 15-cell incumbent regression while
all gap calculations continue to use 330.

This data separates two effects:

- Medium closes its placement master at 117 within two seconds. More proof time
  cannot reduce its 213-cell full gap; stronger globally valid game-rule
  constraints are required. A 0.5-second solve can expire before CP-SAT emits a
  useful bound, in which case the 115-cell mandatory-area fallback remains valid.
- Dense still has a 5-cell master proof gap at two seconds and closes at 242 by
  ten seconds, but most of its full gap is also relaxation weakness.
- Simple-chain is already within six cells, making it a useful tiny case for
  screening a proposed strengthening before applying it to larger instances.

`charged / origin / interior` is incumbent attribution, not a lower-bound
decomposition. `origin` is `charged width × minimum charged y`; for the tracked
medium layout it exposes the 120 cells contributed by the eight-row warehouse
shell offset. `interior` is the remaining in-span area. Neither number by itself
proves that every game-valid layout must pay the same amount. The split also
shows that no single mechanism explains every case: the warehouse-origin offset
dominates medium and contributes to iron-nugget, while dense-scc-fanout's entire
166-cell remainder is inside the charged span. Any next certified constraint
therefore needs a game-rule-specific proof and per-case screening; this table is
not evidence for importing a generic facility-layout clearance rule.

Run the suite with:

```bash
INDUSTRIAL_PLANNER_PYTHON=.venv-headless/bin/python npm run benchmark:certified-area
```
