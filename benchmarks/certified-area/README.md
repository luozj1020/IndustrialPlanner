# Certified area benchmark

Representative v3a packing plus certified logistics-footprint v1 baseline,
measured on 2026-09-04 with OR-Tools 9.15.6755.
Each proof budget is an independent solve. `master gap` is the gap between the
placement-only incumbent and CP-SAT best bound; `full gap` uses the smaller of
the current routed UB and an instance-hash-matched best-known strict UB.

| case | current / best UB | mandatory rectangles | device + logistics LB | CP-SAT LB @ 0.5 / 2 / 10s | combined LB @ 2s | full gap @ 2s | charged / origin / interior | envelope core+power+logistics | incumbent lanes charged/excluded→floor/actual;cross |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| iron-nugget | 66 / — | 37 | 38 (B3−2→1 lane→1 cell) | 39 / 39 / 39 | 39 | 27 (40.91%) | 39 / 12 / 15 | 66+0+0 | B2/2→1/2;X0 |
| simple-chain | 42 / — | 34 | 35 (B3−1→2 lanes→1 cell) | 36 / 36 / 36 | 36 | 6 (14.29%) | 37 / 0 / 5 | 42+0+0 | B2/1→1/3;X0 |
| dense-scc-fanout | 484 / — | 241 | 247 (B17−6→11 lanes→6 cells) | 241 / 241 / 242 | 247 | 237 (48.97%) | 318 / 0 / 166 | 441+0+43 | B16/6→8/65;X9 |
| medium-battery-fan-in | 345 / 330 | 115 | 118 (B10−5→5 lanes→3 cells) | 117 / 117 / 117 | 118 | 212 (64.24%) | 148 / 120 / 62 | 330+0+0 | B8/5→4/33;X3 |

The medium best-known artifact is regenerated from the tracked 330-cell full
report by `certify-area-best-known`; it is not an unchecked handwritten UB.
The current 345-cell run therefore reports a 15-cell incumbent regression while
all gap calculations continue to use 330.

This data separates two effects:

- Medium closes its placement master at 117 within two seconds. More proof time
  cannot reduce its 213-cell full gap; stronger globally valid game-rule
  constraints are required. A 0.5-second solve can expire before CP-SAT emits a
  useful bound, in which case the 115-cell mandatory-area fallback remains valid.
- Dense reaches a 241-cell proof bound with a 243-cell master incumbent at two
  seconds, then closes its 242-cell placement master at ten seconds. The tiny
  internal master gap contrasts with the roughly 50% full gap, which remains
  relaxation weakness.
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

The JSON/CLI report also checks the exact identity:

```text
full gap = additional charged footprint + origin + interior - certified LB lift
```

The certified lift is reported together with its CP-SAT packing (`P`) and
static logistics-footprint (`L`) components; the effective lift is their
maximum rather than their sum. `B` denotes charged belt cells absent from v3a and `E` denotes additional power
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

The incumbent lane screen still classifies the selected routed paths as charged
or warehouse-supply excluded. It remains diagnostic. The new certified source
is deliberately weaker and uses only the geometry-free material graph. For
each consumer/item pair it takes the maximum edge lane count, not the sum, so a
different producer allocation cannot invalidate the proof. It then subtracts
one potentially free solid lane for every generated warehouse unloader. If the
remaining charged lane floors are `D_belt` and `D_pipe`, the static occupied-cell
floor is

```text
ceil(D_belt / 2) + ceil(D_pipe / 2).
```

The two terms are separate because belt and pipe cannot share a cell; division
by two allows every possible same-kind orthogonal crossing and is therefore a
relaxation. The benchmark hard-fails if this graph-side lane or cell floor
exceeds a strict incumbent. A tiny exact placement+routing oracle also closes
the chain `rectangle LB=2 <= device+logistics LB=3 = full optimum=3`.

The measured gain is intentionally modest: it does not beat CP-SAT on
iron-nugget or simple-chain, raises dense's two-second combined LB from 242 to
247, and raises medium from 117 to 118. This confirms a valid game-specific
mechanism without pretending it explains the remaining 237/212 cells. Port
accessibility is still only a candidate for later screening, not an assumed v3
constraint.

The strict routed-UB profile is now v5. It independently rechecks the editor's
warehouse-hub geometry: every bus segment must be edge-connected to the source,
and every unloader must touch that connected component on the side opposite its
rotated item port. This rule is intentionally not promoted into the certified
LB yet. A unit-test counterexample places the same five unloaders and three bus
segments as the medium case in a valid vertical side hub with the first charged
unloader at `y=0`. Consequently, the incumbent's eight-row horizontal shell is
a search construction, not a globally necessary game-rule depth.

Run the suite with:

```bash
INDUSTRIAL_PLANNER_PYTHON=.venv-headless/bin/python npm run benchmark:certified-area
```
