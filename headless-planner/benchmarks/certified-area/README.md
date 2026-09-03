# Certified area benchmark

Representative v3a baseline measured on 2026-09-03 with OR-Tools 9.15.6755.
Each proof budget is an independent solve. `master gap` is the gap between the
placement-only incumbent and CP-SAT best bound; `full gap` uses the smaller of
the current routed UB and an instance-hash-matched best-known strict UB.

| case | current / best UB | mandatory rectangles | CP-SAT LB @ 0.5 / 2 / 10s | master gap @ 2s | full gap @ 2s | charged / origin / interior | envelope core+power+logistics | gap identity @ 2s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| iron-nugget | 66 / — | 37 | 39 / 39 / 39 | 0 | 27 (40.91%) | 39 / 12 / 15 | 66+0+0 | 2[B2]+12+15−2=27 |
| simple-chain | 42 / — | 34 | 36 / 36 / 36 | 0 | 6 (14.29%) | 37 / 0 / 5 | 42+0+0 | 3[B3]+0+5−2=6 |
| dense-scc-fanout | 484 / — | 241 | 241 / 242 / 242 | 0 | 242 (50.00%) | 318 / 0 / 166 | 441+0+43 | 77[B65/E12]+0+166−1=242 |
| medium-battery-fan-in | 345 / 330 | 115 | 117 / 117 / 117 | 0 | 213 (64.55%) | 148 / 120 / 62 | 330+0+0 | 33[B33]+120+62−2=213 |

The medium best-known artifact is regenerated from the tracked 330-cell full
report by `certify-area-best-known`; it is not an unchecked handwritten UB.
The current 345-cell run therefore reports a 15-cell incumbent regression while
all gap calculations continue to use 330.

This data separates two effects:

- Medium closes its placement master at 117 within two seconds. More proof time
  cannot reduce its 213-cell full gap; stronger globally valid game-rule
  constraints are required. A 0.5-second solve can expire before CP-SAT emits a
  useful bound, in which case the 115-cell mandatory-area fallback remains valid.
- Dense closes its 242-cell placement master within two seconds in this run.
  Earlier time-bounded runs left only a small internal master gap, while the
  roughly 50% full gap consistently remains relaxation weakness.
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

The final column is checked as an exact identity:

```text
full gap = additional charged footprint + origin + interior - packing lift
```

`B` denotes charged belt cells absent from v3a and `E` denotes additional power
diffuser area beyond the one globally mandatory diffuser already in v3a. This
makes the mechanism split more concrete: medium is dominated by the
warehouse-shell origin offset, while dense has 65 charged belt cells, 12 cells
of additional power equipment, and a still larger 166-cell in-span remainder.
The latter remains an interaction bucket until a narrower game-rule
counterfactual distinguishes routing capacity, port geometry, and power
coverage; it is not evidence that any one of those constraints is globally
necessary in the current form.

`envelope core+power+logistics` is a second incumbent-only counterfactual. It
deletes charged entity classes without moving anything and measures the
origin-anchored box after each addition. Iron-nugget, simple-chain, and medium
already have their full UB envelope using only production/storage/warehouse-port
entities; the placed power and logistics fit inside it. Dense is different:
its core envelope is 441, power adds zero, and charged logistics extend it by 43
to 484. This does not prove logistics caused the underlying core placement, but
it rules out treating every charged belt cell as direct bounding-box expansion.

Run the suite with:

```bash
INDUSTRIAL_PLANNER_PYTHON=.venv-headless/bin/python npm run benchmark:certified-area
```
