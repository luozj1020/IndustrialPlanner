# Bounded-box global layout search — M1

本目录测量完整游戏规则下的 routed UB 改进，不改变生产认证模型
`certified-area-relaxation-v3a`。不是通用 facility-layout 通道模型。

## 运行

```bash
INDUSTRIAL_PLANNER_PYTHON=.venv-headless/bin/python npm run benchmark:global-layout -- \
  --output /tmp/global-benchmark.json --artifacts /tmp/global-artifacts
INDUSTRIAL_PLANNER_PYTHON=.venv-headless/bin/python npm run benchmark:global-layout:long -- \
  --output /tmp/global-long.json --artifacts /tmp/global-long-artifacts
```

独立包内使用自己的虚拟环境或 `../.venv-headless/bin/python`。每次运行生成完整 report、
blueprint、SVG 与 strict-v5 attestation。`sourceArtifact` 绑定报告；历史 UB 必须匹配同一
instance hash。Master placement、超时或 A* 失败都不能替代 strict routed 验收。

单次请求可用 `optimize <request.json> --bounded-box`，或显式配置：

```json
{
  "search": {
    "initialLayout": "topology-sequential",
    "scope": "global",
    "boundedBox": {
      "enabled": true,
      "maxBoxes": 8,
      "maxSecondsPerBox": 1,
      "candidatesPerBox": 4
    }
  }
}
```

默认关闭。默认预算为 8 个 box、每个 Master 1 秒、最多 4 个不同 pose；上限分别为
64、30 秒、64。Python 启动与完整路由/供电耗时不包含在 `maxSecondsPerBox`，不是整个优化的
wall-clock 上限。启用后保留现有可行 warm start 与 local closure，后续全局阶段使用 box search，
不再运行旧 layer-interlock 扩展。首次改善即返回；M1 尚不自动重建下一轮 frontier。

## 搜索与证明边界

- 用 `U-1` 枚举 Pareto-maximal `(w,h)` staircase，按接近 incumbent 尺寸的顺序限额尝试。
- 独立 CP-SAT satisfaction Master：设备级坐标、所有允许旋转、非重叠与 required-port
  one-cell access；不用 weighted objective、宏、层顺序、escape-depth 或 learned cuts。
- 保留所有设备身份。即使尺寸相同也不施加跨 ID 几何排序；旋转同尺寸也不丢弃端口方向。
- 仓库 source/segments/ports 全部可移动、旋转；segments 通过边邻接连通到 source，ports
  按实际旋转贴在正确 bus 侧。沿用本次 production planning 的搜索 inventory，**不证明这个
  segment 数量全局必要**，不固定水平壳或每段两个 port。
- charged rectangles、计费物流及供电须装入 charged box；免计费 bus/合资格 supply belts
  只受物理地图约束。one-cell access 允许不同端口共享外侧格，未用端口允许遮挡。
- Master 仅给软 warm-start hints。若整个物理 incumbent 上方有空白，可向上平移这些 hints；
  不固定任何相对姿态，也不把平移视为全局游戏约束。
- 每个 placement 从头分配 producer/consumer 并调用既有 full Router；只经完整 topology、
  throughput、power、geometry、warehouse、frontage 与 charged-area 验收的 witness 才记 SAT。
- `master-infeasible`、所有候选 A* 失败和预算用尽都只记 UNKNOWN。pose no-good 只服务有界
  枚举，不是不可行 certificate；**M1 没有 full-box UNSAT 或最优性证明**。

`search.boundedBox` 记录 frontier 总数/尝试数、各 Master 状态、SAT/UNKNOWN、已评估 placements、
完整路由成功数、首次改善时间。`optimality.boundingArea` 仍只使用原有 certified LB 与严格 UB。

## 首轮实测（OR-Tools 9.15.6755）

结果见 [m1-first-run.json](m1-first-run.json)。时间为单次实测，受机器负载影响，不是 CI 性能断言。

| case | warm UB | current UB | validated benchmark UB | SAT / UNKNOWN | placements |
| --- | ---: | ---: | ---: | ---: | ---: |
| iron-nugget | 66 | 54 | 54 | 1 / 0 | 1 |
| simple-chain | 42 | 42 | 42 | 0 / 4 | 12 |
| medium-battery | 345 | 345 | 330 | 0 / 4 | 14 |

铁块首次改善约 4.17 秒，主要收益来自上移 warm-start hint 后消除可避免的 origin offset；
不能据此声称已解决复杂跨层重排。完整 [54 报告](iron-nugget-m1-report.json) 与
[strict-v5 attestation](iron-nugget-m1-best-known.json) 已留档，集成测试会重新路由这个 placement。
medium 尚未在这一阶段恢复 330，历史 strict artifact 单独用于 benchmark，不能把 330 冒充当前输出。

高容 suite 明确区分同一 supplied-moss 实例的 sequential baseline 与 global 实验；历史
`45×47=2115` 已重新 strict-v5 验收，见 [基准](high-capacity-sequential-best-known.json)，
instance hash `fnv1a32:702f82ef`。它不是另一个 self-sufficient topology-baseline request。

最终复测见 [m1-verified-run.json](m1-verified-run.json)：铁块再次 66→54，simple-chain 42，
medium current 345 / historical 330；Master 有界采样受时间影响，medium 本次得到 16 个 placement。

高容实跑还暴露并修复了 warm-start 串扰：把 `scope` 改成 global 曾扩大旧 Tetris 构造族，
进入 box 前就退化为 3240。现在仅让顺序构造/局部闭包沿用 local 策略，完整 box 搜索仍为 global。
[修复后记录](high-capacity-m1-verification.json) 保留 2115 strict incumbent；4 个 box
`45×46 / 44×48 / 46×45 / 43×49` 均 UNKNOWN，10 秒 Master 预算内没有 placement，
box 阶段实测约 66 秒（含 Python 启动）。**高容尚未改善，也没有 UNSAT 结论。**
该记录是诊断快照，不是新 best-known attestation；基准仍使用上面的 strict-v5 历史 artifact。

## 后续里程碑

M2：具有正确 placement/flow/warehouse scope 的 routing separation 与 valid cuts。
M3：仅在 sound model 与 cuts 完整关闭后返回 certified box UNSAT。
M4：并行关闭 `U-1` 的全部 maximal boxes，才可提升全局面积证明。
当前 certified axis screening 仍是诊断；没有接入本 Master 或生产 LB。
