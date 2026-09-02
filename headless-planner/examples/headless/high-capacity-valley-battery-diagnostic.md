# 高容谷地电池产线

## 当前可用方案

本方案以 **6 个/分钟** 为目标，从铁矿和源矿开始加工；仓库只外供 **50 个/分钟砂叶原料**，
所需 **150 个/分钟砂叶粉末在产线内部生产**。种植—采种闭环仍作为下一阶段独立问题，
不混入本次已经通过布线、吞吐和供电验证的正式结果。

物料拓扑为：

铁矿 → 4 台熔炉 → 4 台粉碎机 → 2 台增稠机 → 2 台熔炉 → 2 台配件机 → 1 台封装机

源矿 → 6 台粉碎机 → 3 台增稠机 → 1 台封装机

砂叶 → 5 台低负载粉碎机 → 2 台铁质增稠机和 3 台源石增稠机

封装机 → 1 个协议存储箱

因此共有 29 台生产设备、15 个取货口、1 个协议存储箱。15 个取货口分别承担 4 条铁矿、
6 条源矿和 5 条砂叶供料通道。砂叶粉碎的理论设备负载是 $5/3$ 台；请求通过通用
`minimumRecipeDeviceCounts` 将它分摊到 5 台设备，每台承担 $1/3$ 满载，即消耗 10/min 砂叶并
生产 30/min 粉末。这样每个取货口、粉碎机和下游增稠机形成一一连接，避免多条传送带在单输入口
合流，也避免一台粉碎机向多个下游端口扇出。

## 验证结果

| 指标 | 结果 |
|---|---:|
| 取货口有效前沿 | 45 格 |
| 有效布局外接矩形 | 45 × 47 |
| 外接矩形面积 | 2115 |
| 凸轮廓面积 | 1288 |
| 凸轮廓内空位面积 | 683 |
| 封闭空位 | 312 格 |
| 传送带 | 195 格 |
| 生产设备 | 29 台 |
| 供电桩最少值 / 实际值 | 5 / 5 |
| 成功连接 | 44 / 44 |
| 取货口宽度越界 | 0 格 |
| 拓扑错误 / 警告 | 0 / 0 |
| 生产连通验证 | 通过 |
| 吞吐验证 | 通过 |
| 供电覆盖验证 | 通过 |

这里的 45 格宽度只统计取货口有效前沿，不把横向延伸的存储基段计入产线宽度；64 × 112 是
求解搜索画布，也不作为结果尺寸。

## 查看文件

- [PNG 布局预览](high-capacity-valley-battery-layout.png)
- [SVG 布局图](high-capacity-valley-battery-layout.svg)
- [带箭头的设备物料有向图](high-capacity-valley-battery-material-graph.svg)
- [蓝图](high-capacity-valley-battery-blueprint.json)
- [完整优化报告](high-capacity-valley-battery-report.json)
- [生成请求](high-capacity-valley-battery-request.json)

包含种植—采种循环的完全自给版本仍保留为独立基线：
[请求](high-capacity-valley-battery-topology-baseline-request.json)、
[物料图](high-capacity-valley-battery-self-sufficient-material-graph.svg)。它包含种植—采种循环，
但在获得严格前沿内的完整路由证明前，不覆盖上面的正式可用结果。

## 重新生成

在项目根目录执行：

```bash
npm run headless -- optimize \
  examples/headless/high-capacity-valley-battery-request.json \
  --output examples/headless/high-capacity-valley-battery-blueprint.json \
  --report examples/headless/high-capacity-valley-battery-report.json \
  --svg examples/headless/high-capacity-valley-battery-layout.svg

npm run headless -- graph \
  examples/headless/high-capacity-valley-battery-request.json \
  --output examples/headless/high-capacity-valley-battery-material-graph.svg \
  --json examples/headless/high-capacity-valley-battery-material-graph.json
```
