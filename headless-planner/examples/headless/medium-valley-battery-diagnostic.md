# 中容谷地电池通用顺序布局与局部优化结果

本例用于验证通用框架能否从新的无环双支路工艺图直接生成布局。实现没有读取“中容谷地电池”、
配方名或设备 ID 来决定坐标。

## 原料边界和产量

目标为一台装配机满速产出：

$$
q_{\mathrm{battery}}=6/\mathrm{min}
$$

配方每 10 秒消耗 10 个蓝铁零件和 15 个源石粉末，因此：

$$
q_{\mathrm{iron\ component}}=60/\mathrm{min},\qquad
q_{\mathrm{originium\ powder}}=90/\mathrm{min}
$$

产线从自然资源蓝铁矿和源矿开始，不把蓝铁块或源石粉末视为外部供料。单条传送带吞吐为
$30/\mathrm{min}$，生产规划器由此自动得到 2 条蓝铁矿支路和 3 条源矿支路。

## 设备有向图

通用生产规划得到 14 个设备图节点和 13 条物流边：

$$
\begin{aligned}
2\times\text{蓝铁矿取货口}
&\rightarrow 2\times\text{熔炉}
\rightarrow 2\times\text{零件机}
\rightarrow \text{装配机},\\
3\times\text{源矿取货口}
&\rightarrow 3\times\text{源石粉碎机}
\rightarrow \text{装配机},\\
\text{装配机}
&\rightarrow \text{协议存储箱}.
\end{aligned}
$$

所有强连通分量都只包含一个节点，因此该实例没有循环块。五个取货口的严格前沿宽度为：

$$
W_{\mathrm{frontage}}=5\times3=15
$$

第一生产层恰好由 2 台熔炉和 3 台粉碎机组成，总宽度同样为 15 格。

## 基线、严格局部固定点与初步全局优化

| 指标 | 顺序基线 | 严格局部 | 层级交错全局 |
|---|---:|---:|---:|
| 外接矩形 | $15\times25$ | $15\times23$ | $15\times22$ |
| 外接面积 | $375$ | $345$ | $330$ |
| 凸轮廓面积 | $221.5$ | $192.5$ | $183$ |
| 传送带格 | $52$ | $31$ | $38$ |
| 转弯与交叉 | $9$ | $4$ | $9$ |
| 封闭空位 | $16$ | $7$ | $6$ |
| 前沿溢出 | $0$ | $0$ | $0$ |
| 物料连接 | $13/13$ | $13/13$ | $13/13$ |

严格局部阶段保持设备的拓扑层成员关系，只做切带折叠、同层设备移动/旋转、边缘存储箱移动、
重新选端口和重布线。它把装配机收敛到 $(5,18)$、协议存储箱收敛到 $(2,19)$，供电扩散器位于
$(7,13)$，以 `fixed-point` 得到 $15\times23$。这一结果不再包含“把装配机插入配件机层”的
跨层动作，因此可作为稳定的局部质量基准。

全局阶段首先对候选层族执行必要宽度证明：

$$
W_{\mathrm{need}}
=W_{\mathrm{terminal\ layer}}
+W_{\mathrm{inserted\ layer}}
+W_{\mathrm{routing}}
\le W_{\mathrm{frontage}}.
$$

本例中装配机宽 6 格，两台配件机共宽 6 格，两条同行输入连接至少保留 2 个路由列，因此：

$$
W_{\mathrm{need}}=6+3+3+2=14\le15,
\qquad W_{\mathrm{residual}}=1.
$$

通过证明后才枚举跨层姿态。获胜候选把第二台配件机移到 $(4,16)$，把装配机保持
$180^\circ$ 放到 $(8,14)$，协议存储箱移到 $(9,19)$，并在 $(6,14)$ 留出 $2\times2$
供电槽。它改变了终端与直接上游设备共享的层带，明确属于全局优化，而不是局部压缩。

`globalNeighborhoods: "layer-interlock"` 用于单独验证这条初步全局邻域；`"all"` 还会启用
全图 LNS、ejection chain 和可选 CP-SAT 重建。当前报告记录 197 个宽度可行姿态、2 个在坐标
生成前由宽度证明淘汰的层族、11 个完成全路由的候选和 1 次最终接受的跨层转移；第二轮无改善，
以 `globalLayerInterlockStoppedBy: "fixed-point"` 结束。

对于致密源石粉末，三台终端研磨机的层宽已经是：

$$
W_{\mathrm{terminal\ layer}}=3\times6=18
=W_{\mathrm{frontage}}.
$$

只要插入任何上游设备或保留至少一列跨层路由，就有 $W_{\mathrm{need}}>18$。因此该类层级交错会
在候选生成和 A* 之前被判定为 `terminal-layer-saturates-frontage`；这只证明当前“终端层插入”
邻域无解，不等价于整个产线不存在其他全局重排。

供电仍在物料布线完成后求解，且供电桩参与面积、凸轮廓和硬前沿验收。协议存储箱同样读取
`requiresPower` 并必须被覆盖。三个阶段的 13/13 连接、生产吞吐、供电和 15 格硬前沿均验证通过。

## 产物

- `medium-valley-battery-material-graph.svg`：带箭头的设备抽象有向图；
- `medium-valley-battery-topology-baseline-layout.svg`：零次启发式搜索的顺序基线；
- `medium-valley-battery-topology-local-layout.svg`：严格局部固定点；
- `medium-valley-battery-topology-global-layout.svg`：宽度证明后的初步全局层级交错结果；
- 各阶段对应的 PNG、请求、蓝图 JSON 和完整报告位于同一目录。
