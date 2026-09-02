# Headless Planner

独立的生产线自动布局优化器与 CLI 工具，从 IndustrialPlanner 提取而来。
提供完整的无头（Headless）产线规划、设备打包、物流路由、拓扑验证与蓝图渲染能力。

## 目录

- [安装](#安装)
- [快速开始](#快速开始)
- [命令参考](#命令参考)
  - [items](#items)
  - [recipes](#recipes)
  - [optimize](#optimize)
  - [render](#render)
- [请求格式 (Optimization Request)](#请求格式-optimization-request)
- [输出说明](#输出说明)
  - [Blueprint Document](#blueprint-document)
  - [Optimization Report](#optimization-report)
  - [Layout SVG](#layout-svg)
- [优化算法](#优化算法)
- [后续全局优化数学模型与实施规划](GLOBAL_OPTIMIZATION_PLAN.md)
- [评分体系 (Scoring)](#评分体系-scoring)
- [验证语义 (Validation Semantics)](#验证语义-validation-semantics)
- [CP-SAT 加速](#cp-sat-加速)
- [运行测试](#运行测试)
- [限制与已知问题](#限制与已知问题)
- [示例](#示例)

## 安装

```bash
cd headless-planner
npm install
```

可选 CP-SAT 加速（需要 Python ≥ 3.10 和 OR-Tools）：

```bash
python -m venv .venv-headless
.venv-headless/bin/python -m pip install -r requirements-headless.txt
INDUSTRIAL_PLANNER_PYTHON=.venv-headless/bin/python npm run headless -- items
```

Windows 的解释器路径通常为 `.venv-headless/Scripts/python.exe`。

> CP-SAT 不可用时，优化器自动回退到确定性 LNS + A* 布局算法。

## 快速开始

```bash
# 查询所有物品
npm run headless -- items

# 查询特定物品的输出配方
npm run headless -- recipes item_iron_nugget

# 在铺设前查看设备实例有向图
npm run headless -- graph examples/headless/dense-originium-powder-topology-baseline-request.json \
  --output /tmp/material-graph.svg \
  --json /tmp/material-graph.json

# 优化生产线布局（输出蓝图、报告和 SVG 可视化）
npm run headless -- optimize examples/headless/iron-nugget.json \
  --output /tmp/blueprint.json \
  --report /tmp/report.json \
  --svg /tmp/layout.svg

# 渲染已有蓝图
npm run headless -- render /tmp/blueprint.json --output /tmp/layout2.svg
```

## 命令参考

### items

```
npm run headless -- items [query]
```

列出注册表中所有物品。可选 `query` 参数用于按 ID 或名称过滤。

输出格式：JSON 数组，每项包含 `id`、`nameKey`、`tags`。

### recipes

```
npm run headless -- recipes <output-item-id>
```

查找产出指定物品的所有配方。

### graph

```
npm run headless -- graph <request.json> [--output material-graph.svg] [--json material-graph.json]
```

在引入坐标和路由前导出设备实例物料图。SVG 按 SCC 压缩 DAG 的层排列节点，箭头表示已经分配的
物料 lane，橙色节点边框表示循环 SCC。该命令不执行 A*，所以布局失败时仍可独立核对上下游顺序。

输出格式：JSON 数组，每项包含 `id`、`machineId`、`durationSeconds`、`inputs`、`outputs`。

### optimize

```
npm run headless -- optimize <request.json> [--output blueprint.json] [--report report.json] [--svg layout.svg]
```

执行完整的五阶段产线优化：

1. 根据目标产物计算配方树与设备需求
2. 将生产设备、仓储设备密集打包到矩形区域
3. 为所有物料连接搜索传输带/管道路由（A* 寻路）
4. 通过词典序目标向量比较所有候选布局
5. 编译仿真拓扑并验证连通性、吞吐量和电力覆盖

选项：

| 选项 | 说明 | 默认值 |
|---|---|---|
| `--output` | 蓝图输出路径 | `optimized-blueprint.json` |
| `--report` | 优化报告路径 | 不生成 |
| `--svg` | 布局 SVG 路径 | 不生成 |

### render

```
npm run headless -- render <blueprint.json> [--output layout.svg]
```

将已有的 BlueprintDocument JSON 渲染为 SVG 可视化。

## 请求格式 (Optimization Request)

优化请求文件为 JSON 格式，结构如下：

```jsonc
{
  "width": 20,                    // 可用区域宽度（格）
  "height": 20,                   // 可用区域高度（格）
  "targets": [                    // 目标产物列表
    { "itemId": "item_iron_nugget", "perMinute": 60 }
  ],
  "supplies": [                   // 可选：外部供应
    { "itemId": "item_liquid_water", "perMinute": 120, "infinite": true }
  ],
  "infiniteItemIds": ["item_liquid_sewage"],  // 无限供应的物品
  "recipeChoices": {},            // 可选：指定多配方物品的配方
  "baseId": "wuling_protocol_core",  // 基地 ID
  "name": "My Blueprint",         // 蓝图名称
  "allowRotate": true,            // 是否允许设备旋转
  "routingClearance": 1,          // 路由避让间距
  "frontageConstraint": "soft",   // 卸货口跨度约束：soft / hard
  "search": {                     // 搜索参数
    "initialLayout": "auto",      // auto / topology-sequential
    "scope": "global",            // global / local
    "globalNeighborhoods": "all", // all / layer-interlock
    "iterations": 16,             // 大邻域搜索迭代次数
    "seed": 42,                   // 随机种子（可复现）
    "routingVariants": 3,         // 正常快速路径的路由变体数
    "refinementCandidates": 12,   // 正常快速束及每个改进阶段的候选上限
    "cpSat": {                    // CP-SAT 加速配置
      "enabled": true,
      "maxSeconds": 30,            // 整批候选共享的总求解预算（秒）
      "candidates": 5              // 总预算内最多尝试的候选数
    }
  },
  "sourceConfig": {               // 资源策略
    "waterPolicy": "use-byproduct",
    "acidPolicy": "use-byproduct",
    "sewagePolicy": "external-supply"
  }
}
```

## 输出说明

### Blueprint Document

`--output` 生成的蓝图文档符合 IndustrialPlanner 的 BlueprintDocument 格式：

```jsonc
{
  "schemaVersion": 1,
  "blueprintId": "uuid",
  "version": "v1.3.0",
  "name": "...",
  "baseId": "wuling_protocol_core",
  "entities": { /* 设备映射 */ },
  "entityOrder": ["..."],
  "slotLinks": [ /* 槽位链接 */ ]
}
```

### Optimization Report

`--report` 生成的报告包含：

| 字段 | 说明 |
|---|---|
| `layout.usedWidth` / `usedHeight` | 实际使用的矩形区域 |
| `layout.boundingArea` | 矩形包围面积 |
| `layout.equipmentArea` | 设备占地面积 |
| `layout.utilization` | 空间利用率 |
| `production.deviceCount` | 生产设备数量 |
| `validation.routedConnectionCount` | 已路由连接数 |
| `validation.errorCount` | 拓扑编译错误数 |
| `validation.productionConnectivityVerified` | 产线连通性验证 |
| `validation.productionThroughputVerified` | 产线吞吐量验证 |
| `validation.powerCoverageVerified` | 电力覆盖验证 |
| `search.initialLayout` / `scope` | 实际使用的初始构造模式 / 优化作用域 |
| `search.initialCandidatesGenerated` / `initialCandidatesSelected` | 廉价初始候选数 / 进入完整 A* 的候选数 |
| `search.warehouseCandidatesGenerated` / `warehouseCandidatesSelected` | 仓库专项候选漏斗统计 |
| `search.adaptiveCandidatesEvaluated` / `adaptiveRoutingAttempts` | 初始束无解后追加的候选数 / 路由顺序尝试数 |
| `search.routingVariants` / `effectiveRoutingVariants` | 请求的路由变体数 / 有界恢复实际达到的上限 |
| `search.eliteStatesRetained` / `eliteArchiveMaxDistance` | 最终可行精英档案大小 / 档案内最大设备布局距离 |
| `search.alternativeRefinementBasesUsed` | 第二轮后用过的非获胜基线数 |
| `search.globalRebuildCandidatesGenerated` / `globalRebuildCandidatesRouted` | 全局重建原始候选数 / 完整 A* 成功数 |
| `search.globalRebuildCandidatesImproved` / `globalRebuildCpSatElapsedMs` | 全局重建改进数 / 额外 CP-SAT 时间 |
| `search.partialRebuildCandidatesGenerated` / `partialRebuildCandidatesRouted` | 归因式部分重建原始候选数 / 完整 A* 成功数 |
| `search.partialRebuildCandidatesImproved` / `objectiveHotspotDeviceIds` | 部分重建改进数 / 热点种子及直接流邻居 |
| `search.localConvergencePasses` / `localConvergenceTransitions` | 局部闭包完整轮数 / 接受的严格目标改善数 |
| `search.localConvergenceStoppedBy` | `fixed-point` 表示完整一轮无改善；`safety-bound` 表示只达到安全上界 |
| `search.cpSatBudgetSeconds` / `cpSatElapsedMs` | CP-SAT 整批候选的配置预算 / 实际耗时 |
| `search.cpSatAttemptedCandidates` / `cpSatStoppedBy` | 实际启动的候选变体数 / 停止原因 |
| `search.objective` | 获胜词典序目标向量 |

### Layout SVG

`--svg` 生成的 SVG 包含：

- 设备色块（按分类着色）
- 传输带（橙色）与管道（蓝色）路线
- 设备标签（可选）
- 图例

## 优化算法

自动优化不是“先随意摆设备、最后补传送带”，而是生产规划、设备布局、端口分配、物流路由和
物理验收相互约束的分阶段搜索。

### 阶段一：请求校验

优化器首先校验区域宽高、目标产量、物流余量和搜索预算。`width`、`height` 必须为正整数，
目标产量必须大于零；LNS 迭代、路由变体、精炼候选数和 CP-SAT 时间/候选数都有限制。
无效请求在生产展开前直接失败，避免把配置错误表现成布局无解。

### 阶段二：反向展开生产需求

从每个目标物品开始，系统先扣除有限供给、副产物余量和无限来源，再使用 `recipeChoices` 或默认
配方反推循环次数、设备数量和上游输入。自然资源优先使用无输入采集配方；水、酸和污水按照
`sourceConfig` 选择复用、倾倒、自生产或外部供给。若最终仍存在没有配方也没有来源的输入，
优化会列出每种物品的每分钟缺口并停止。

### 阶段三：实例化生产设备

浮点设备需求向上取整为实际设备实例。每台实例保存配方、满速输入输出、默认配置和通道配置。
没有实体端口的自然资源伪设备不占地图格，其输出在路由阶段转为边界供料。任意配方循环都会先由
配方—物料图的强连通分量识别，再根据匿名净流量矩阵求满足内部回流与外部需求的最小整数设备
组合；该过程不读取配方名、物品名或设备 ID。

### 阶段四：补全仓储结构

生产设备的内部输出先分配给下游。固体原料仍有缺口时，系统按传送带容量拆成多条 lane，为每条
lane 创建仓库取货口并建立仓库 slot link。固体目标产品创建协议存储箱，同时生成仓库总线源和
所需总线段。液体缺口目前使用地图边界管道来源。

### 阶段五：构造逐 lane 物料流图

每项输入和输出按真实物流容量拆分：

```text
lane 数量 = ceil(每分钟流量 / 单 lane 每分钟容量)
```

传送带每 2 秒运输 1 个物品，即单 lane 为 30/min。需要 60/min 固体输入的设备必须获得两条
独立连接和两个实际输入端口。端口数量不足不会被逻辑合并，而会使候选明确失败。

### 阶段六：生成初始布局候选

初始候选来自流簇布局、上下游分层、依赖紧密度排序、面积/长边/短边排序，以及交换、插入和区间
反转形成的确定性排列扰动。每种排列尝试面积优先、方正优先、横向/纵向生长和端口朝向/物流距离
优先等 bottom-left 放置评分，并遍历允许的 `0/90/180/270°` 旋转。设备允许直接相邻，最终可行性
由真实端口和完整路由决定。

需要独立验证“先按产线顺序构造，再做局部压缩”时，使用
`search.initialLayout: "topology-sequential"` 和 `search.scope: "local"`。前者只保留生产流图
派生的仓库顺序基线；顺序来自 SCC 压缩图和最长前驱层级，与横排、纵排以及具体配方名称无关。
后者只允许生产设备或协议存储箱在三格内平移/旋转，并禁用全图 fan-out
搬迁、ejection chain、CP-SAT 和全局重建。报告中的 `search.initialLayout`、`search.scope` 以及
全局候选计数可用于审计两个阶段是否发生混用。

设备矩形是传送带不可穿越的硬障碍。顺序基线会统计源设备在当前层之前、目标设备在当前层之后的
跳层 lane，并要求当前层每个设备占用行留下不少于该 lane 总数的前沿空格。所以下游尚未落位时，
铺满整个前沿的“设备墙”也会被提前淘汰，而不会等到最终布线才暴露阻断。真实端口和已有物流线
冲突仍由每次落块后的增量路由验证。

循环 SCC 不按固定节点数量套用坐标。构造器用兼容性有向图识别反馈角色，再用冻结的实际分配边
计算外送和旁路 lane，避免等价生产者满足需求后省略一条回边而漏掉循环。它根据强连通图、环内
扇出度和实际外送 lane 枚举枢纽—出口角色，把任意数量的回流成员放入前沿宽度内的可换行设备架，
并同时保留边缘偏置与均衡走廊两种货架。旁路 lane 约束横向通道容量，不再错误换算成额外高度。
每个 SCC 最多保留八种
折叠角色；多个循环采用基础方案加单 SCC 替换的线性候选谱系，不生成笛卡尔积。设备 ID 只稳定
候选顺序，通用 SCC 装箱始终保留为回退。因此该流程不依赖配方名、物料名、设备定义或某条示例
产线的设备数量。

顺序构造采用“设备落位—增量路由”的快速分支，同时为反馈 SCC 和尚有未落位下游的扇出源保留
少量相同几何的冷布线分支。最终交错验证两类状态，允许完整图重新分配全部端口与线路，不让一次
局部前缀成功锁死后续支路。同一结构谱系内按实际端口外侧格、逃逸方向和多输入接近空间选择候选。

若同层多个非取货口设备的总宽度占满前沿，它们作为一个同步路由货架整体落位，并在此前所有层
的最低边界后统一留出走廊。对于多个上游汇入且没有后继的终端，构造器比较真实旋转端口；侧向
进货口可行时把终端放到对应前沿边界，让输入先形成水平汇流干线。判断只使用图入度、出度、层宽
和端口方向，不读取配方、物料或设备 ID。

顺序模式默认要求所有非总线设备和物流位于取货口前沿内。需要查看尚未满足前沿约束的完整诊断
铺设时，可以显式设置 `frontageConstraint: "soft"`；报告中的 `frontageOverflowCellCount`
必须同时展示，软诊断图不能作为正式可行布局。

### 阶段七：可选 CP-SAT 候选

启用 CP-SAT 时，OR-Tools 约束设备位于区域内且矩形不重叠，正确处理旋转宽高，并要求保留足够
的实际输入输出端口。目标函数近似压缩包围盒、最长边、物料流距离和错误端口朝向，同时让共同
终端和共享上游保持接近。CP-SAT 只产生设备布局候选，不能代替后续 A* 物流验证；解释器、依赖
缺失、超时或无解时自动回退到确定性 LNS。`maxSeconds` 是所有候选变体共享的总预算，而不是
单个变体预算；每次启动变体前都会扣除已用时间，达到预算后停止继续生成候选。

#### CP-SAT 路由感知数学模型

模型求解的是设备矩形位置和旋转，不直接为每条传送带建立逐格流变量。定义：

| 符号 | 含义 |
|---|---|
| $D$ | 参与布局的生产设备和协议存储箱集合 |
| $F$ | 保持当前位置的设备集合，通常是部分重建销毁集之外的设备 |
| $O$ | 仓库卸货口、仓库总线等固定障碍集合 |
| $E$ | 生产规划产生的有向物料边集合 |
| $P_i^{\mathrm{in}}, P_i^{\mathrm{out}}$ | 设备 $i$ 在不同旋转下可用的实际输入/输出端口 |
| $L_e$ | 物料边 $e$ 按真实吞吐拆分后的 lane 数 |
| $c_e$ | 物料边 $e$ 的流量权重 |
| $W,H$ | 用户请求的布局区域宽度和高度 |

主要决策变量如下：

$$
\begin{aligned}
x_i,y_i &\in \mathbb{Z}_{\ge 0}
&& \text{设备 }i\text{ 的左上角坐标},\\
r_i &\in \{0^\circ,90^\circ,180^\circ,270^\circ\}
&& \text{设备旋转},\\
w_i,h_i &\in \mathbb{Z}_{>0}
&& \text{旋转后的宽高},\\
X_i &= x_i+w_i,\qquad Y_i=y_i+h_i
&& \text{设备右边界与下边界},\\
a_{i,p,r} &\in \{0,1\}
&& \text{端口 }p\text{ 在旋转 }r\text{ 下是否具有完整逃逸走廊},\\
B_x,B_y &\in \mathbb{Z}_{>0}
&& \text{整体使用宽度和高度},\\
A &= B_xB_y
&& \text{包围面积},\\
s_e &\in \mathbb{Z}_{\ge 0}
&& \text{物料边 }e\text{ 的走廊间距缺口},\\
z_{i,k} &\in \{0,1\}
&& \text{设备 }i\text{ 是否保持失败布局 }k\text{ 中的姿态}.
\end{aligned}
$$

设备旋转与尺寸通过允许表关联：

$$
(r_i,w_i,h_i)\in
\left\{
\begin{aligned}
&(0^\circ,\bar w_i,\bar h_i),\\
&(90^\circ,\bar h_i,\bar w_i),\\
&(180^\circ,\bar w_i,\bar h_i),\\
&(270^\circ,\bar h_i,\bar w_i)
\end{aligned}
\right\},
$$

其中 $\bar w_i,\bar h_i$ 是设备未旋转时的尺寸。

模型包含以下硬约束。

1. 区域边界：

$$
0\le x_i,\qquad
0\le y_i,\qquad
X_i=x_i+w_i\le W,\qquad
Y_i=y_i+h_i\le H,
\qquad \forall i\in D.
$$

2. 设备与固定障碍不重叠：

$$
\operatorname{NoOverlap2D}
\left(
\left\{[x_i,X_i)\times[y_i,Y_i)\mid i\in D\right\}\cup O
\right).
$$

3. 部分重建锚定。未进入销毁集的设备保持原姿态：

$$
x_i=x_i^{\mathrm{inc}},\qquad
y_i=y_i^{\mathrm{inc}},\qquad
r_i=r_i^{\mathrm{inc}},
\qquad \forall i\in F.
$$

4. 端口逃逸走廊。端口外侧第一格不能只是在设备外，还必须沿端口法向连续保留若干格。单 lane
使用两格，多 lane 使用三格：

$$
\delta_{i,d}=
\begin{cases}
2,&q_{i,d}=1,\\
3,&q_{i,d}>1,
\end{cases}
\qquad d\in\{\mathrm{in},\mathrm{out}\},
$$

其中 $q_{i,d}$ 是方向 $d$ 所需的 lane 数，$\delta_{i,d}$ 是逃逸深度。设
$\mathbf{o}_{i,p,r}$ 为端口外侧第一格，$\mathbf{n}_{i,p,r}$ 为端口朝外的单位法向量，则：

$$
a_{i,p,r}=1
\Longrightarrow
\begin{cases}
r_i=r,\\
\mathbf{q}_{i,p,r,t}
  =\mathbf{o}_{i,p,r}+t\mathbf{n}_{i,p,r},\\
0\le q^x_{i,p,r,t}<W,\\
0\le q^y_{i,p,r,t}<H,\\
\mathbf{q}_{i,p,r,t}\notin R_j,
  &\forall j\in D\setminus\{i\},\\
\mathbf{q}_{i,p,r,t}\notin O,
\end{cases}
\quad
\forall t\in\{0,\ldots,\delta_{i,d}-1\}.
$$

每个方向必须提供足够数量的独立端口：

$$
\sum_{p\in P_i^d}\sum_r a_{i,p,r}\ge q_{i,d},
\qquad
\forall i\in D,\quad
d\in\{\mathrm{in},\mathrm{out}\}.
$$

这条约束同时禁止端口朝向地图外侧，解决了旧模型可能生成 $x=-1$ 或 $y=-1$ 路由端点的问题。

5. 流边走廊缺口。先计算两个设备矩形在水平和垂直方向上的非负间距：

对于物料边 $e=(u,v)$：

$$
g_e^x=
\max\left\{
x_v-X_u,\;
x_u-X_v,\;
0
\right\},
$$

$$
g_e^y=
\max\left\{
y_v-Y_u,\;
y_u-Y_v,\;
0
\right\},
$$

$$
g_e=g_e^x+g_e^y,\qquad
\hat g_e=\min\{2,\max\{1,L_e\}\},\qquad
s_e=\max\{0,\hat g_e-g_e\}.
$$

$s_e$ 是软缺口而非硬不可行条件：复杂线路仍可绕行，但求解器会优先为多 lane 连接保留两格接近
空间。fan-in/fan-out 流簇允许最近设备间距不超过两格，以免与该走廊目标互相矛盾。

6. 候选多样性 no-good 割。若布局 $k$ 已经生成，则下一变体不能完全重复它：

$$
z_{i,k}=1
\Longleftrightarrow
\left(
x_i=x_{i,k}\land
y_i=y_{i,k}\land
r_i=r_{i,k}
\right),
$$

$$
\sum_{i\in D_k}z_{i,k}\le |D_k|-1.
$$

目标函数是最终词典序目标的可求解代理。实际实现使用下列有界整数权重：

$$
\begin{aligned}
\min\quad
&1{,}000{,}000A
+20{,}000\max\{B_x,B_y\}\\
&+100{,}000\lambda
  \sum_{e\in E}c_es_e\\
&+5{,}000\lambda
  \sum_{c\in C}g_c\\
&+w_d\lambda
  \sum_{e\in E}c_ed_e\\
&+4w_d\lambda
  \sum_{e\in E}\rho_e\\
&+2{,}000d_{\mathrm{div}}
+w_xB_x+w_yB_y.
\end{aligned}
$$

其中 $\lambda$ 是物流目标缩放系数，$g_c$ 是流簇间距，$d_e$ 是设备中心曼哈顿距离，
$\rho_e$ 是端口朝向惩罚，$d_{\mathrm{div}}$ 是候选多样性距离。距离权重 $w_d$ 按候选变体在
$80/240/480/160$ 间轮换，宽高偏置 $w_x,w_y$ 也随变体变化，用来生成
不同形状的候选。该加权式只是 CP-SAT 的廉价代理，不宣称与最终词典序目标完全等价；候选仍由
完整 A* 和物理拓扑验收后，按照正式词典序目标决定胜负。

A* 失败首先形成普通诊断证据，其中已铺物流前沿只用于拆线顺序、失败边优先级和 LNS 热点，不能
直接成为 Master 的硬约束。只有 producer/consumer lane 分配已冻结时，Router 才在忽略已铺物流、
端口预留、转弯代价和路由顺序的设备障碍网格上生成两类完备证书：第一类枚举失败 lane 的全部
合法端口，证明它们仍被静态自由空间割集分离（或当前姿态没有合法端口）；第二类先扫描每条完整
横向或纵向割面 $\Gamma$，仅把全部合法起点与终点确定落在割面两侧的 lane 计入 $D_\Gamma$，并以
割面两侧均无设备/前沿障碍的网格边数作为上界 $C_\Gamma$。若

$$
D_\Gamma>C_\Gamma,
$$

即生成 static cut-capacity certificate。若所有直线割都不能证明失败，Router 再以失败 lane 优先、
最多 8 组不同端点集合为种子，在至多 4096 个格子的静态自由空间上运行单位边容量 max-flow/min-cut。
残量源侧集合 $S$ 的完整边界

$$
\delta(S)=\{(u,v)\mid u\in S,\ v\notin S,\ \{u,v\}\in A\}
$$

可以是 L 形、U 形或包围局部端口的任意形状。只有全部合法源端点位于同一侧、全部合法目标端点
位于另一侧的 lane 才计入该割需求；再次满足 $D_{\delta(S)}>C_{\delta(S)}$ 时，生成
static-general-cut-capacity certificate。种子枚举是有界且不完备的，但每个实际生成的证书都记录
完整网格划分边界，因此证明本身是完备且可复核的。边界端点或跨越两侧的可选端口不会计入需求，
所以该判断宁可漏报，也不会把端口选择或路由顺序造成的拥堵误报成布局不可行；使用裁剪搜索高度
的临时 Router 也无权生成硬证书。

容量证书除生成精确姿态 no-good 外，还以最多 8 条广义约束进入后续 CP-SAT。直线割也先展开成
显式相邻网格边，使轴向割与任意 min-cut 共用同一个模型。若所有必经 lane 的可移动端点仍保持
证书姿态，则 Master 必须满足：

$$
\sum_{g\in\Gamma} free_g(P)\ge D_\Gamma.
$$

其中 $free_g$ 为 Boolean，取 1 时割边两侧的格子必须同时位于所有可移动矩形和固定障碍之外。
所以只移动一个阻挡设备但仍未释放足够通道不会通过 Master；任一端点改变姿态后，该条件约束自动
解除，由新端口位置重新证明需求。

姿态 no-good 不再无条件包含割边上的所有阻挡设备。设割边总数为 $M$、需求为 $D$，固定障碍已经
保证阻断 $F$ 条边；只需选择一组可移动阻挡设备 $B'$，使其覆盖的不同割边满足

$$
F+\left|\bigcup_{i\in B'} blockedEdges_i\right|\ge M-D+1,
$$

就足以继续证明剩余容量至多为 $D-1$。阻挡候选不超过 16 台时用迭代加深求最小基数集合，更大
冲突用确定性删除得到 inclusion-minimal 集合；lane 端点姿态仍全部保留。这样 conflict cut 只要求
真正维持容量不足的设备之一改变，而不会因同一割上的冗余阻挡扩大销毁邻域。

证书记录所有必经 lane 的可移动端点以及收缩后仍足以维持容量不足的割边阻挡设备，保存它们在失败候选中的
$(x_i,y_i,r_i)$。下一轮优先把这些设备加入部分销毁集，并增加：

$$
\sum_{i\in D_{\mathrm{cert}}}
z_{i,\mathrm{cert}}
\le
|D_{\mathrm{cert}}|-1.
$$

因此至少一台经证明相关的设备必须离开失败姿态。失败修复 CP-SAT 会立即带着该 cut 重求解，
证书也会保留给后续全局重建；精确姿态证书最多保留 64 个。若 lane 分配可变，或静态松弛仍连通且
有界轴向/通用割搜索都没有容量证明，则失败可能来自物流占用、贪心端口分配或路由顺序，此时不会
生成硬 cut，而只继续启发式回溯。

因此整体是有界分解求解：

目标归因与部分销毁 → CP-SAT 设备布局 → 端口漏斗 → 完整 A* 路由。成功候选进入精英档案并按
词典序比较；只有携带 connectivity/capacity certificate 的失败候选才生成姿态 no-good 割并反馈
下一轮。

没有直接采用逐格多商品流模型，是因为它需要为每条物料边、每个地图格和每个方向建立近似
$O(4|E|WH)$ 个流变量，再叠加端口、转弯、交叉与不同物流类型互斥约束。当前分解模型
把 CP-SAT 保持在秒级预算内，并让 A* 继续作为真实可铺设性的权威判定。

固定种子 $12345$ 的本地铁制零件产线对照结果：

| 指标 | 原模型 | 路由感知模型 |
|---|---:|---:|
| 包围面积 | $240$ | $168$ |
| 轮廓空洞 | $72$ | $33.5$ |
| 包围盒空格 | $141$ | $77$ |
| 物流格 | $18$ | $10$ |
| 转弯/交叉 | $3$ | $2$ |
| 部分重建改进数 | $0$ | $1$ |

新布局通过生产连通、吞吐和供电三项验收。

### 阶段八：端口感知物流路由

每个候选附加仓储设施后建立障碍网格。同一布局会尝试端口受限优先、长线优先、短线优先、
内部连接优先、仓库供料优先、产品入库优先、fan-out 和 fan-in 骨架优先等连接顺序。
每条连接枚举尚未使用的真实端口对并执行多目标 A*：

```text
移动一格 +1
转弯一次 +2
合法垂直交叉 +6
```

固体只能与固体、液体只能与液体合法垂直交叉，成功交叉会升级为原生跨线连接器。失败时记录
物品、起终设备、尝试端口、可达区域和前沿阻挡设备，供后续回溯使用。

### 阶段九：放置供电扩散器

物流完成后枚举不与现有实体重叠、且能覆盖需电设备的位置。设需电设备为 $D$、候选位置为 $P$，
$a_{ip}$ 表示候选 $p$ 的 12 格供电范围是否覆盖设备 $i$，则首先精确求解：

$$
N_{\mathrm{power}}^{\min}=\min\sum_{p\in P}x_p,
\qquad
\sum_{p\in P}a_{ip}x_p\ge1,
\qquad
x_p+x_q\le1\quad(p,q\text{ 占地重叠}).
$$

按供电桩数量递增的分支定界证明最小值后，几何 beam 只负责在该数量内优化前沿、面积、轮廓、
空洞与贴边；若 beam 漏解则回退到精确见证。该过程不再受旧的 8 个供电桩上限约束。无法覆盖
全部 `requiresPower` 设备（包括协议存储箱）的候选会被淘汰；报告要求
`minimumPowerDeviceCount === powerDeviceCount`。

最小值针对已完成设备摆放和物流布线的固定布局求解。供电桩后置插入且目标优先级最低，不参与
此前的传送带寻路，也不会为了少一根而主动牺牲更紧凑的物料布局；补入后仍计入总面积并遵守
取货口宽度。某个已布线候选没有完整覆盖位置时只淘汰该候选并继续尝试下一种几何，全部物料
可行候选都无法供电时才报告供电可行性失败。

### 阶段十：词典序评分

完整候选按下列顺序逐项比较，而不是将指标加权相加：

1. `hardViolations`
2. `frontageOverflow`
3. `boundingArea`
4. `contourArea`
5. `turnsAndCrossings`
6. `logisticsCells`
7. `contourVoid`
8. `enclosedVoid`
9. `boundingVoid`
10. `maxSide`
11. `powerDevices`

只要高优先级指标分出优劣，低优先级指标就不能反超。生产设备、仓储设施、协议存储箱及入库带
计入占地；仓库取货口到生产设备的外部供料带完整生成和验证，但可从计费面积中排除。仓库基段
不会把六个取货口形成的 $18$ 格前沿宽度扩张到 $24$ 格；高度仍以布局原点计量，仓库外壳占用的
纵向空间不会被静默扣除。报告同时提供计费占地和完整物理占地。

### 阶段十一：LNS 破坏与修复

得到可路由基准后，优化器尝试设备平移/旋转、fan-out 生产者搬迁、生产者与存储箱联合搬迁、
流簇整体平移、边界回溯、插槽检测、ejection chain、设备交换和局部 CP-SAT 修复。便宜的几何
和端口指标先过滤候选，再按操作族保留多样性；`refinementCandidates` 控制初始布局及每个改进
阶段真正进入完整 A* 的候选数。初始阶段始终保留确定性基线，并在仓库扇出、设备交换、临街
移动、CP-SAT 和普通启发式候选之间轮转取样。`routingVariants` 和
`refinementCandidates` 限制正常快速路径；当 `iterations=0` 且已有可行基线时，不再额外展开
失败回溯候选。只有初始束全部不可路由时，优化器才最多追加 8 个候选；仍失败时选择已完成连接数
最多的 4 个布局，各追加最多 2 种路由顺序，且总路由变体上限仍为 9。

`scope=local` 还会在普通邻域之前执行“已证明直带切面规范化”，该步骤不受 `iterations` 限制：
不含设备、端点、转弯或交叉且只被垂直直带穿过的行可以删除并整体上移下游设备，垂直切面按同样
规则左移右侧设备。后缀内线路随设备平移，跨切面线路只删除一个直带格；端口和连接顺序保持不变。
若收缩产生碰撞或非法重叠，只拆除失效线路进行有界修复，最后仍完整验证硬前沿、连通、吞吐与
供电。因而 `iterations=0` 关闭的是启发式布局搜索，不会保留这种已有几何证明的冗余行列。

当 `scope=local` 且 `iterations>0` 时，普通候选束之后执行统一的局部收敛闭包。每轮依次尝试
已证明直带压缩、保留旧路径的推测性切带、同一设备几何的冷启动端口/路由变体、一次上游设备移动和一次
固定设备端口/路由精修；设备移动或路由改变后，下一轮重新从切带开始。候选必须严格改善完整
词典序目标，同面积下轮廓空洞、带长、转弯或交叉的改善也可继续搜索。完整一轮无改善才报告
`localConvergenceStoppedBy: "fixed-point"`。整数搜索框宽高之和提供确定性的安全轮数上界；若命中
上界则报告 `safety-bound`，不能视为已经收敛。保路由状态在拆除全部旧线路后与同几何、同路由
变体、同优先级的冷启动状态等价，这类确定性失败跨闭包复用，不重复执行 A*。
接收其他生产设备物料且直接向协议存储箱输出的单设备终端行，还会逐轮尝试一格纵向移动；连续
多格压缩必须经过多次完整路由和供电验收，存储箱不随终端生产设备移动。

完整路由且满足硬约束的布局会进入最多 8 个状态的可行精英档案。一半容量保留目标最好的状态，
另一半使用最远点采样保留设备位置与旋转差异最大的状态；`eliteArchiveMaxDistance` 可观测其覆盖
跨度。第一轮精炼仍只使用当前最优解；第二轮起最多选择 3 个差异较大的精英状态。软约束搜索需将
`iterations` 设为大于 16 才会进入第二轮。可行解精炼的
每轮完整 A* 总预算上限不增加：当前最优解获得向上取整的一半 `refinementCandidates`，其他精英平分
剩余预算。`eliteStatesRetained` 和 `alternativeRefinementBasesUsed` 可用于确认档案是否形成，
以及多盆地搜索是否实际发生。

启用 CP-SAT 后，每个额外精炼轮次会从当前最优基线执行一次归因式全局重建。优化器按仓库前沿
溢出、移除设备后的包围面积下降、封闭空洞邻接数和已路由路径代价依次定位热点，选择约 40%
（最多 8 台）的生产设备/协议存储箱；热点的下游消费者或存储终端优先成组加入，避免固定终端
割裂待重建物流。CP-SAT 只销毁这组设备，其他生产设备、仓库卸货口和总线保持固定。

当总预算至少 0.2 秒且候选数至少为 2 时，同一批次把约 80% 时间和 75% 候选分给部分重建，
其余留给销毁全部可移动设备的兜底；两者合计仍不超过 1 秒、6 个变体，并共同占用原有完整 A*
候选配额。所有重建候选清空旧线路，并尝试请求的全部 `routingVariants` 后才参与词典序比较。
整批统计使用 `globalRebuildCandidatesGenerated/Routed/Improved`，部分重建使用
`partialRebuildCandidatesGenerated/Routed/Improved`；`objectiveHotspotDeviceIds` 列出热点种子
及随其加入的直接流邻居，`globalRebuildCpSatElapsedMs` 报告额外求解时间。
全局候选被 A* 拒绝时，普通前沿证据继续驱动回溯与 LNS；只有冻结 lane 图上的设备障碍静态
连通性证明或显式网格边割容量证明失败时，其端点和经收缩仍必要的割边阻挡设备才生成姿态 no-good 割。
若还有后续精炼轮次，这些设备先进入销毁集，且 CP-SAT 必须改变至少一个证书姿态。
`certifiedRouteFailureCutsLearned` 报告实际学到的不同姿态 cut 数量，
`certifiedRouteCapacityCutsLearned` 报告保留的广义容量不等式数量。

设备局部移动时，系统只拆除起终点受影响、穿过新旧占地或与其共享冲突格的线路，优先保留其他
旧线路。局部 rip-up & reroute 失败后才完整重布。若候选只在最后几条线路失败，失败连接会在
下一轮获得更高优先级，实现有限深度回溯；小冲突组还可使用有界 CBS 选择不冲突的路径组合。

`scope: "local"` 是严格诊断模式：只保留三格内单设备平移/旋转，并严格遵守请求的
`refinementCandidates` 和轮数预算。它不会进入下面的硬前沿全局修复。因此局部模式失败时，
应把结果理解为当前局部邻域不完备，而不是全局不可行。

### 阶段十二：宽度证明与初步全局层级交错

严格局部闭包保持拓扑层成员关系；把终端设备插入直接上游设备行属于全局动作，只在
`scope: "global"` 中运行。若只验证这条邻域，可设置
`globalNeighborhoods: "layer-interlock"`；默认 `"all"` 还会启用全图 LNS 和 CP-SAT 重建。

坐标枚举和 A* 之前先检查必要宽度条件：

$$
W_{\mathrm{need}}
=\sum_{i\in T}W_i
+\sum_{j\in U}W_j
+N_{U\rightarrow T}
\le W_{\mathrm{frontage}}.
$$

$T$ 是向同一目标存储输出的终端层设备，$U$ 是准备插入的直接上游物理行，
$N_{U\rightarrow T}$ 是两组间必须保留的物流连接数。中容谷地电池满足
$6+3+3+2=14\le15$；致密源石粉末的三台研磨机已经占满 $3\times6=18$ 格前沿，因此当前层级
交错邻域会在路由前被证明无解。通过下界的候选仍须完整重布线、放置供电并再次执行局部闭包。

报告使用 `globalLayerInterlockCandidatesGenerated`、`globalLayerInterlockWidthRejected`、
`globalLayerInterlockCandidatesRouted`、`globalLayerInterlockCandidatesImproved`、
`globalLayerInterlockPasses`、`globalLayerInterlockTransitions` 和
`globalLayerInterlockStoppedBy` 记录该阶段。

### 阶段十三：仓库前沿硬约束修复

`frontageConstraint: "hard"` 要求任何物理设备和传送带都不能超出卸货口前沿跨度，免计费供料
带也不能绕开该约束。初始候选失败时，优化器保留
最接近可行的状态，根据路由失败前沿移动阻挡设备，执行有限层定向回溯，再尝试全局 LNS 或局部
CP-SAT 跳跃。仍不可行时，错误会报告溢出格、相关设备和最接近成功的失败连接。

### 阶段十四：蓝图生成与物理验收

获胜布局转换为标准 `BlueprintDocument`，包含生产设备、配方、传送带、管道、跨线连接器、仓储、
slot link 和供电扩散器。随后交给拓扑编译器检查物理连接和诊断，并分别计算：

- `productionConnectivityVerified`：线路形成物理拓扑、编译无错误且必需输入已连接；
- `productionThroughputVerified`：输入及需要送往下游/目标存储的输出具有足够 lane 额定流量；
- `powerCoverageVerified`：所有声明 `requiresPower` 的设备（包括协议存储箱）均被自动放置的供电扩散器覆盖。

吞吐验收证明规划 lane 的额定容量足够，不等于完整时间轴仿真已经证明永不堵塞。

## 评分体系 (Scoring)

优化器使用词典序目标向量进行比较。比较规则：

- 按优先级列表逐项比较
- 对于每一项指标，**数值越小越好**
- 一旦某项指标分出优劣（差值 ≥ 1），立即停止比较
- 仅当所有可比较指标完全相等时，视为平局

`hardViolations` 为最高优先级——任何存在硬约束违反的布局都会被无违反的布局淘汰。

## 验证语义 (Validation Semantics)

| 验证项 | 意义 |
|---|---|
| `productionConnectivityVerified` | 所有生产配方输入输出端口可通过传输带/管道到达 |
| `productionThroughputVerified` | 传输带/管道通道数满足配方吞吐量需求（含分流） |
| `powerCoverageVerified` | 所有声明 `requiresPower` 的设备（包括协议存储箱）均处于供电扩散器覆盖范围内 |

验证通过并不意味着仿真运行时 100% 无阻塞——复杂的副产物循环、仓库容量限制等需在实际仿真中进一步验证。

## CP-SAT 加速

优化器集成了 Google OR-Tools CP-SAT 求解器，用于设备打包的初始排列和额外精炼轮次中的有界
全局重建。

- **脚本**：`src/headless/cp-sat-layout.py`
- **桥接**：`src/headless/cp-sat-layout.ts`（通过 `child_process.spawnSync` 调用 Python）
- **输入**：设备列表、约束（不重叠、端口方向等）、目标权重
- **输出**：确定性的设备布局候选（用于 LNS 初始种子或跨盆地全局重建）
- **预算**：`maxSeconds` 约束整批候选；`candidates` 仅设置预算内的尝试上限
- **回退**：Python 不可用或 OR-Tools 未安装时，自动回退到纯 TypeScript 的确定性 LNS 算法

CP-SAT 状态会在优化报告的 `search.cpSatStatus` 字段中报告：

- `disabled` — 配置禁用
- `executable-missing` — Python 脚本未找到
- `dependency-missing` — OR-Tools 未安装
- `success` — 成功生成候选
- `timeout` — 超时
- `solver-failed` — 求解失败

同时可通过 `search.cpSatBudgetSeconds`、`cpSatAttemptedCandidates`、`cpSatStoppedBy`
（`completed` / `total-budget`）和 `cpSatElapsedMs` 判断候选批次是否真正受预算约束。

## 运行测试

```bash
npm test
```

测试覆盖：

- 产线规划模型（配方树计算、副产物、多配方选择）
- 布局优化器（打包、A* 路由、目标比较）
- CP-SAT 桥接（Python 调用、正常化）
- 路由可观测性（失败诊断收集）
- 目标与受影响连接

## 限制与已知问题

1. **CP-SAT 可选**：Python 环境不可用时不报错，仅回退到 LNS
2. **确定性依赖随机种子**：相同请求 + 相同种子保证可复现输出
3. **产线规划的线性近似**：当前规划假设配方以恒定速率运行，不考虑产线动态阻塞
4. **单基地支持**：当前仅支持单基地（协议核心）场景
5. **设备注册表只读**：注册表数据内嵌于源码，不支持外部动态加载
6. **无 GUI**：此包仅提供 CLI；如需可视化编辑器，请使用完整的 IndustrialPlanner
7. **不自动插入通用分流器/汇流器**：高吞吐连接通过设备真实端口和独立 lane 实现，端口不足会明确失败
8. **完整测试可能较慢**：致密布局测试会执行真实 LNS 与 A* 搜索，运行时间明显长于普通单元测试

## 示例

`examples/headless/` 目录包含以下预制请求文件：

| 文件 | 目标产物 | 复杂度 |
|---|---|---|
| `iron-nugget.json` | 铁粒 60/min | 简单 |
| `iron-component.json` | 铁构件 | 中等 |
| `liquid-xiranite.json` | 息壤晶体 | 中等（含液体） |
| `dense-originium-powder.json` | 源石粉末 480/min | 复杂（高吞吐量） |
| `dense-originium-powder-topology-baseline-request.json` | 致密源石粉末 90/min | 顺序构造基线 |
| `dense-originium-powder-topology-local-request.json` | 致密源石粉末 90/min | 严格局部硬约束诊断 |
| `medium-valley-battery-topology-baseline-request.json` | 中容谷地电池 6/min | 从蓝铁矿、源矿开始的双支路顺序基线 |
| `medium-valley-battery-topology-local-request.json` | 中容谷地电池 6/min | 15 格硬前沿严格局部固定点 |
| `medium-valley-battery-topology-global-request.json` | 中容谷地电池 6/min | 宽度证明后的初步全局层级交错 |
| `high-capacity-valley-battery-request.json` | 高容谷地电池 6/min | 从铁矿、源矿和外供砂叶开始，砂叶粉末内置生产 |

当前顺序构造基线使用 $26\times36$ 搜索边界和 $18$ 格硬取货口前沿，生成结果为
$18\times35$、$22/22$ 条物料连接、前沿溢出 $0$，生产连通、吞吐和供电验证全部通过。顺序
构造先产生 $18\times36$ 可行路由，随后由已证明直带切面规范化安全删除一行：
[SVG 布局图](examples/headless/dense-originium-powder-topology-baseline-layout.svg)、
[PNG 预览](examples/headless/dense-originium-powder-topology-baseline-layout.png)、
[蓝图](examples/headless/dense-originium-powder-topology-baseline-blueprint.json) 和
[完整报告](examples/headless/dense-originium-powder-topology-baseline-report.json)。

中容谷地电池回归由 2 条蓝铁矿支路和 3 条源矿支路汇入一台装配机。顺序基线为 $15\times25$；
严格局部固定点保持层次不变，得到 $15\times23$、凸轮廓 $192.5$、传送带 31 格、转弯与交叉
4 次。初步全局阶段证明 $6+3+3+2=14\le15$ 后，把装配机交错进配件机层，在 $(6,14)$ 留出
$2\times2$ 供电槽，进一步得到 $15\times22$、凸轮廓 $183$。单个供电桩覆盖全部生产设备及
协议存储箱，并参与面积和硬前沿验收；精确模型证明最少/实际供电桩数为 $1/1$。查看
[有向图](examples/headless/medium-valley-battery-material-graph.svg)、
[严格局部布局](examples/headless/medium-valley-battery-topology-local-layout.svg)、
[初步全局布局](examples/headless/medium-valley-battery-topology-global-layout.svg)、
[全局报告](examples/headless/medium-valley-battery-topology-global-report.json)和
[诊断说明](examples/headless/medium-valley-battery-diagnostic.md)。

高容谷地电池的正式可用版本按 $6/\mathrm{min}$ 构造，从铁矿和源矿开始，外供
$50/\mathrm{min}$ 砂叶，并由 5 台低负载粉碎机在产线内部生产 $150/\mathrm{min}$ 砂叶粉末。
结果包含 29 台生产设备、15 个取货口和 1 个协议存储箱；取货口有效前沿为 45 格，布局为
$45\times47$，44/44 条连接、拓扑、吞吐和供电全部验证通过，前沿越界为 0，最少/实际供电桩数
为 $5/5$。查看
[PNG 布局](examples/headless/high-capacity-valley-battery-layout.png)、
[物料有向图](examples/headless/high-capacity-valley-battery-material-graph.svg)、
[蓝图](examples/headless/high-capacity-valley-battery-blueprint.json)、
[报告](examples/headless/high-capacity-valley-battery-report.json)和
[诊断说明](examples/headless/high-capacity-valley-battery-diagnostic.md)。

运行示例：

```bash
npm run headless -- optimize examples/headless/iron-nugget.json --svg /tmp/layout.svg
```

## 许可证

与 IndustrialPlanner 主项目一致。
