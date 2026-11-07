# Aperture 光影改造：Complementary Shaders - Reimagined 观感

> 结论先行：新增预设 `complementary_reimagined`，用本项目自己的 GLSL 后处理管线复刻 CS Reimagined 的观感；
> 旧的 `cinematic / realistic / vanilla / performance` 四个预设**参数与像素输出均未改变**（改前 baseline 对比 meanAbs = 0）。
> **这不是 Iris 兼容层**：不能加载 .zip shaderpack，也不是二进制复刻，见文末「与真实 CS 的差距」。

实测结论（GTX 1050 Ti，1280×720，`node tools/test-shader-presets.mjs` → **PASS，23/23**）：

- 四个旧预设：与改动前 baseline **逐像素一致**（meanAbs = 0），且同预设连拍 3 张 sha256 完全一致
- `complementary_reimagined`：同预设连拍 3 张 **逐像素一致**（meanAbs = 0）；与 cinematic 差异 **meanAbs = 58.73**（aerial）、48.10（nave）、31.25（sky-heavy）
- 性能：`mc_benchmark` **1100 FPS / 0.909 ms 每帧**（cinematic 约 1750–2150 FPS），实时 RAF 32 FPS（≥30 底线）
- `npm run acceptance`：**ALL CHECKS PASSED**（38/38，含 load_ms 7.2s、benchmark 1522 FPS）


---

## 1. 改了什么

| 文件 | 改动 |
|---|---|
| `public/shaders/complementary.js` | **新增**。CS 风格的 GLSL 源码 + 参数默认值/预设值/范围表（纯 ES module，无新依赖） |
| `public/app.js` | 接入：新增 CS 天空/水面/合成材质、深度预渲染、CS 参数状态、`applyShader` 扩展、MCP API 扩展、截图确定性处理 |
| `docs/shaders-before-after.md` | 本文件 |
| `tools/test-shader-presets.mjs` | **新增**：预设回归 + CS 观感/确定性/参数 API/性能断言 |

关键设计：**旧材质一行没动**。CS 的天空、水面、合成各自是独立材质，只在 `shaderState.cs === 1`（`complementary_reimagined` 预设）时替换/启用；
旧预设仍然走原来那套 `sceneRT → bright → blur H/V → god rays → finalMat` 链路，只是共享 pass 的 uniform 每帧显式复位成原值。
`shaderState` 里每个可调参数都有「预设切换时重置」的默认值，因此 CS 参数不会残留到旧预设。

### CS 模式的渲染链路（1280×720 下 8 个 pass）

1. **深度预渲染**：只画不透明/镂空/发光层（隐藏天空、水面、半透明），`MeshDepthMaterial` + `depthTexture`，关掉阴影重绘 —— 供 SSAO / 高度雾 / 水面深度使用
2. **主场景** → HalfFloat MSAA×4 `sceneRT`（天空最后画 + 深度测试，被建筑挡住的像素不做着色）
3. **亮度提取**（阈值/软膝可调）→ 半分辨率
4. **高斯模糊 H/V**（1–2 迭代，第二迭代用大半径）→ 宽而软的 Bloom
5. **径向 god rays**（太阳在屏内时淡入，密度/衰减可调）
6. **CS 合成**：SSAO → CAS-lite 锐化 → 距离雾+高度雾 → 曝光 → ACES/filmic/neutral tone mapping → 暖高光/冷阴影分离调色 → 色温 → 饱和度 → 对比度 → 暗角 → sRGB

旧预设仍是原来的 6 个 pass，链路不变。

### 新增观感要点

- **天空**：更饱和的天顶/地平线渐变、暖色日出日落、太阳盘+光晕、夜间的月亮与星点、会飘移的**伪体积云层**（解析平面求交 + 朝太阳方向 2 次自阴影采样，做出银边与暗部；`clouds:0` 可关）
- **水面**：4 波解析法线、菲涅尔天空反射、太阳高光带+闪烁、由深度预渲染得到的**真实水深**（深/浅水色分离）、岸边泡沫
- **阴影/接触阴影**：太阳 PCF soft shadow（three.js 内建）+ 8 采样深度重建 **SSAO**（半径/强度可调）
- **雾**：距离雾 + 高度雾解析积分，雾色向太阳方向偏暖
- **调色**：ACES/filmic/neutral 三种 tone mapping、暖高光冷阴影 split toning、色温、对比度、CAS 风格锐化、暗角
- **曝光**：`autoExposure` 为**确定性**函数（只依赖太阳高度角），不读帧缓冲、不做时间累积，因此截图可复现

### 截图确定性（同相机同参数逐像素稳定）

- 截图期间冻结所有时间相关输入：天空/水面 `uTime = 0`；`autoExposure` 为解析函数，不随时间变化
- 截图前 `gl.finish()` 并把同一帧渲染两次，保证半浮点/MSAA 解析、深度贴图等 pass 从已写完的状态开始
- `setViewport` 只在尺寸真正变化时才调 `renderer.setSize` —— 重复给 canvas.width/height 赋值会重建并清空 WebGL 绘制缓冲，Chromium 还会延迟这次重建，导致连拍截到上一帧（动画材质下肉眼可见）
- 实测：同一预设连拍 3 张 sha256 完全一致

---

## 2. 参数表（overrides 清单）

`applyShader('complementary_reimagined', overrides)` / `setShaderParams(partial)` 支持下列键。未知键被忽略；数值超出范围会被 clamp 到表内范围；
枚举传非法值会抛 `INVALID_ARGUMENT`（MCP 返回 `isError`）。

### 2.1 CS 专属参数

| 参数 | 默认 | CS 预设 | 范围 | 说明 |
|---|---|---|---|---|
| `cs` | 0 | **1** | 0–1 | CS 管线总开关；旧预设恒为 0 |
| `clouds` | 1 | 1 | 0–1 | 伪体积云层开关 |
| `cloudCoverage` | 0.5 | 0.5 | 0.02–0.98 | 云量（越低覆盖越大） |
| `cloudDensity` | 1.0 | 1.0 | 0–3 | 云密度/自阴影强度 |
| `cloudSpeed` | 0.35 | 0.35 | 0–20 | 云飘移速度（截图时冻结为 0） |
| `cloudHeight` | 120 | 120 | -200–2000 | 云层世界高度 |
| `cloudScale` | 1.0 | 1.0 | 0.05–20 | 云层尺度 |
| `sunWarmth` | 0.6 | 0.65 | 0–2 | 日出/日落暖色强度 |
| `skyIntensity` | 1.0 | 1.05 | 0–4 | 天空整体亮度 |
| `atmosphere` | 1.0 | 1.0 | 0–4 | 大气散射（霾/米氏散射）强度 |
| `waterWaves` | 1.0 | 1.0 | 0–4 | 波浪强度 |
| `waterFresnel` | 1.0 | 1.0 | 0–2 | 菲涅尔反射强度 |
| `waterReflection` | 1.0 | 1.0 | 0–2 | 环境反射混合 |
| `waterWaveHeight` | 0.55 | 0.55 | 0–3 | 法线扰动高度 |
| `waterFoam` | 1.0 | 1.0 | 0–2 | 岸边泡沫 |
| `bloomThreshold` | 0.72 | 0.68 | 0–4 | Bloom 亮度阈值 |
| `bloomKnee` | 0.4 | 0.35 | 0.001–2 | 阈值软膝 |
| `bloomRadius` | 2.0 | 2.1 | 0.2–12 | 第二迭代模糊半径（倍率） |
| `bloomIterations` | 1 | **2** | 1–2 | 模糊迭代次数（越多越宽） |
| `autoExposure` | 0 | **0.6** | 0–2 | 自动曝光幅度（确定性，见上） |
| `ssao` | 0 | **1** | 0–1 | 屏幕空间接触阴影开关 |
| `ssaoStrength` | 0.85 | 0.9 | 0–2 | SSAO 强度 |
| `ssaoRadius` | 1.5 | 1.6 | 0.1–12 | SSAO 世界半径（方块） |
| `heightFog` | 0 | **0.012** | 0–0.2 | 高度雾密度 |
| `heightFogFalloff` | 20 | 18 | 1–500 | 高度雾衰减高度 |
| `fogBase` | -64 | -64 | -512–512 | 高度雾基准 Y |
| `raysDensity` | 0.95 | 0.95 | 0.1–2 | god rays 采样长度 |
| `raysDecay` | 0.955 | 0.96 | 0.5–1 | god rays 衰减 |
| `toneMapping` | `aces` | `aces` | `aces` / `filmic` / `neutral` | 色调映射曲线（非法值报 INVALID_ARGUMENT） |
| `contrast` | 1.0 | 1.05 | 0.5–2 | 对比度 |
| `temperature` | 0 | 0.05 | -1–1 | 色温（正=暖） |
| `splitWarm` | 0 | 0.05 | 0–1 | 暖高光分离调色 |
| `splitCool` | 0 | 0.07 | 0–1 | 冷阴影分离调色 |
| `sharpen` | 0 | 0.45 | 0–2 | CAS 风格锐化强度 |

### 2.2 旧管线参数（四个旧预设原有，语义未变）

| 参数 | 说明 |
|---|---|
| `exposure` | 曝光 |
| `shadows` | 太阳阴影开关 |
| `shadowSize` | 阴影贴图分辨率，CS 预设 2048；别名 `shadowMapResolution`（推荐用别名） |
| `bloom` / `bloomStrength` | Bloom 开关 / 强度 |
| `rays` / `rayStrength` | god rays 开关 / 强度 |
| `fog` | 距离雾密度；别名 `fogDensity` |
| `saturation` | 饱和度 |
| `vignette` | 暗角 |

其它可传：`timeOfDay`（0–24，不随预设重置）、`preset`（切换预设名）。

### 2.3 旧预设值（与改造前完全一致）

| 预设 | exposure | shadowSize | bloom | bloomStrength | rays | rayStrength | fog | saturation | vignette |
|---|---|---|---|---|---|---|---|---|---|
| cinematic | 1.08 | 2048 | true | 0.62 | true | 0.55 | 0.00135 | 1.04 | 0.28 |
| realistic | 0.96 | 4096 | true | 0.35 | true | 0.42 | 0.0019 | 1.0 | 0.2 |
| vanilla | 1.0 | 1024 | false | 0.15 | false | 0.3 | 0.0017 | 1.0 | 0.1 |
| performance | 1.0 | 1024 | false | 0.1 | false | 0.2 | 0.0012 | 1.0 | 0.08 |

---

## 3. MCP / MCP_RENDER_API 用法

```js
// 切换预设 + 覆盖参数（overrides 见上表）
await MCP_RENDER_API.applyShader('complementary_reimagined', { clouds: 0, ssao: 0, bloomStrength: 0.6 });

// 只改参数，不动预设
await MCP_RENDER_API.setShaderParams({ cloudCoverage: 0.62, sunWarmth: 0.8, toneMapping: 'filmic' });

// 读当前全部参数（含 preset / 别名 / csEnabled）
MCP_RENDER_API.getShaderParams();
// => { preset: 'complementary_reimagined', cs: 1, clouds: 0, ..., shadowMapResolution: 2048, fogDensity: 0.0016, toneMapping: 'aces', ... }
```

- `applyShader(preset, overrides)` 返回 `{ preset, params }`；切换预设时先把所有可调参数重置为默认，再套预设值，再套 overrides。
- `setShaderParams({ preset, ... })` 若带已知 `preset` 会走预设切换（等价 `applyShader`），否则只覆盖参数。
- 非法枚举（如 `toneMapping:'agx'`）抛错，错误信息以 `INVALID_ARGUMENT:` 开头，不会静默回退。
- 可通过 MCP 工具 `mc_shader_preset` 的 `overrides` 字段传同一份参数（`mc_shader_preset` 的 `preset` 枚举尚未包含新预设，因为 `src/` 不在本次改动范围；用 `overrides` 即可调参）。

---

## 4. 性能（GTX 1050 Ti / ANGLE D3D11 / 1280×720）

| 指标 | complementary_reimagined | cinematic（旧） |
|---|---|---|
| `mc_benchmark` 合成吞吐（90 帧 glFinish） | **~1100 FPS / 0.91 ms/帧** | ~1750–2150 FPS / 0.5–0.6 ms/帧 |
| 实时 RAF（headless Chromium） | **32 FPS**（`measureFps` 实测） | 同一节流区间，RAF 计数在 headless 下不稳定，不能当 GPU 性能指标 |

- CS 每帧比旧预设多：1 个深度预渲染 + 1 次额外模糊迭代 + SSAO/雾/调色 ALU，实测合成吞吐约为 cinematic 的 60%，远高于 30 FPS 底线和 acceptance 的 `>60 FPS` 阈值。
- 1024/2048 阴影贴图、8 采样 SSAO、1–2 次半分辨率模糊，没有逐帧随机/回读/多 pass 爆炸。
- 截图模式会在 pass 之间 `gl.finish()` 并渲染两帧以保证可复现，这段开销只发生在截图，不影响实时 RAF。

---

## 5. 验证方式

```powershell
cd G:\Aperture_

# 可选：在“旧版 app.js”上先录一份旧预设基线（本仓库已内置判定逻辑，缺基线会自动跳过该对比）
node tools/test-shader-presets.mjs --baseline

# 完整检查（退出码 0 = 全过）
node tools/test-shader-presets.mjs

# MCP 端到端回归
npm run acceptance
```

`tools/test-shader-presets.mjs` 断言：

1. 每个预设连续 3 张截图（同相机/同时间/1280×720）**逐像素一致**（meanAbs = 0）
2. 四个旧预设与改动前 baseline **逐像素一致**（meanAbs = 0；无 baseline 时跳过并打印 NOTE）
3. `complementary_reimagined` 与 `cinematic` 差异 meanAbs > 5（sky-heavy 视角单独再断言一次，另测 aerial/nave 两个视角）
4. `setShaderParams`/`getShaderParams` 往返一致、别名 `shadowMapResolution` 生效、非法 `toneMapping` 报 `INVALID_ARGUMENT`、全参数快照可完整恢复
5. CS 预设实时 RAF FPS ≥ 30、`mc_benchmark` FPS ≥ 40；`shaderSelfTest` 覆盖不在屏幕上的 shader（CS 水面、CS 天空昼夜、CS 合成三种 tone mapping）编译与出图

产物：`renders/shader-test/*.png`（各预设/各视角/日夜展示）+ `report.json`。

---

## 6. 与真实 Complementary Shaders - Reimagined 的差距

**前提**：本项目 README 第 8 节已写明不能加载 Iris/OptiFine shaderpack —— 本改造是在这个前提下尽量接近观感，**不是兼容层**，也不追求逐像素复刻。

没做的 / 只能近似的：

| 项目 | 真实 CS | 本实现 |
|---|---|---|
| 云 | 真 3D 体积云 raymarch，多次散射、云层厚度、随高度变化的密度 | 解析平面 + 2D FBM 密度场 + 朝太阳 2 次自阴影采样（伪体积）；无多次散射 |
| 屏幕空间反射 SSR | 水面/湿润表面屏幕空间反射+折射 | **无法做**：没有上一帧颜色回读/延迟渲染 G-buffer；水面用解析天空反射近似，无折射 |
| 阴影 | 级联阴影贴图 + PCSS 软阴影、彩色阴影、方块光/手持光阴影 | 单张太阳 PCF soft（three.js 内建），无 PCSS/彩色阴影/局部光源阴影 |
| 环境光遮蔽 | GTAO/SSAO + 法线缓冲 | 8 采样深度重建近似（邻居深度差分求法线），无 G-buffer 法线 |
| Bloom | 多 mip 链、可调阈值/半径/强度、镜头污迹 | 单尺度 9 采样高斯 ×1–2 迭代 |
| 抗锯齿/时域 | TAA、动态清晰度、时间累积 | 无 TAA（MSAA×4 + CAS 风格锐化），因此**没有** CS 的运动分辨/时域去噪 |
| 曝光 | 基于帧缓冲亮度统计的自适应曝光 | 确定性解析近似（只跟太阳高度角相关），不读帧缓冲 |
| Tone mapping | 多个精确曲线（ACES/AgX 等）+ 色彩管理 | `aces` / `filmic` / `neutral` 三种简化近似，无 AgX 精确实现 |
| 水面 | 波浪网格、水下体积、泡沫、焦散、反射/折射 | 平面波浪 + 解析法线 + 深度着色 + 泡沫近似；无焦散/水下 |
| 天气/粒子/景深/运动模糊/实体阴影 | 有 | 无 |
| 兼容性 | 官方 shaderpack + Iris 注入 | 纯 WebGL2/three.js 后处理管线，仅对本项目加载的世界生效 |

因此：**观感方向（暖色天空/体积云/水面高光/软阴影/暖高冷低调色/宽 Bloom/大气雾）是接近的，物理与细节层次不是**。
如果后续要更接近，优先补：TAA + 时域去噪 → 真正的屏幕空间反射（需要颜色历史）→ 级联阴影 + PCSS。
