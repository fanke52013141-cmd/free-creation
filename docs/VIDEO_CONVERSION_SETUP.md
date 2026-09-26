# 本地视频转换：画质边界与换机安装说明

本文对应画布里的“深度视频”和“白模视频”节点。开发方案见 [VIDEO_CONVERSION_FINAL_PLAN.md](./VIDEO_CONVERSION_FINAL_PLAN.md)。

## 白模为什么看起来立体感有限

目前白模节点是**深度估计驱动的二维浮雕渲染**，不是三维重建。处理过程是：

1. Video Depth Anything Small 从每帧估计相对远近；它输出的是深度线索，不是物体真实的表面法线、材质或完整几何。
2. 程序对深度做轻微平滑，并用深度梯度近似表面朝向。
3. 用单盏方向光和环境光把结果渲染成灰白视频。

所以大块且平滑的深度区域会呈现成较平的面；细小的眼睛、皮肤褶皱、肌肉起伏、接触阴影和遮挡边缘不会凭空补出来。视角、遮挡、原片的暗部和模型深度误差都会影响效果。现在没有专用视频法线模型、真实法线、环境光遮蔽、投影阴影、人物抠像或可编辑三维网格。

这属于首版技术路线的能力边界，也和当前参数有关；不能只通过提高导出分辨率解决。模型内部推理输入尺寸目前固定为 518，节点的 512/768/1024 选项控制送入处理链的帧尺寸上限和输出尺寸，并不会把模型内部推理同步提高到 1024。

### 可先试的设置

在白模节点设置里逐项调整并重跑短片：

| 参数 | 当前默认 | 可以开始试的范围 | 作用 |
|---|---:|---:|---|
| 浮雕强度 | 1.5 | 3–5 | 增加深度变化带来的明暗起伏；过高会放大深度边缘噪点 |
| 环境光 | 0.42 | 0.10–0.25 | 降低整体填充亮度，让受光和背光更分明；过低会压黑阴影 |
| 光线高度 | 35° | 25–45° | 改变表面明暗方向；建议和光线方向一起预览 |
| 输出上限 | 512 px | 按源片选择 768/1024 | 减少输入缩小时的输出损失；不会增加模型推断出的真实细节 |

人物主体和背景会一起转成白模。若需要纯色棚拍背景、人物边缘更干净、面部和身体细节更像真正雕塑，需要单独增加视频分割/法线或更强的几何估计路线，并用目标样片评估后再作为能力加入。

## 换一台电脑需要什么

### 仓库已经包含什么

- 两个画布节点、转换服务和 Python 推理适配脚本。
- Video Depth Anything Small 所需的上游 Python 源码副本及其 Apache-2.0 许可文件。
- PyTorch、torchvision、NumPy、OpenCV、einops 等固定版本的自动安装清单。
- 固定版本的 Small 模型下载地址和 SHA-256 校验值。

### 不在 Git 仓库中的东西

**PyTorch 安装包、模型权重和隔离 Python 环境都不会提交到 Git。**每台电脑各自在首次安装时下载并安装一份，目录位于该用户的应用数据下：

```text
Windows: %APPDATA%\canvas-studio\data\video-conversion\
Linux:   <应用 userData>/data/video-conversion/
```

因此 `git clone` 或 `git pull` 只会拿到代码，不会把另一台电脑的 Python 环境、显卡驱动或模型文件复制过来。运行视频节点前，必须在新电脑上完成下面的本地环境准备。

## 首次运行清单

### Windows

1. 安装 64 位 NVIDIA 显卡驱动，并确认这台机器有支持 CUDA 的 NVIDIA GPU。当前节点使用 CUDA 12.8 版 PyTorch；是否可运行取决于显卡驱动兼容性。PyTorch 官方给出了对应的版本安装组合，NVIDIA 也维护 CUDA 与驱动兼容说明。
2. 安装 **64 位 Python 3.12**。应用尝试从 `py -3.12`、标准 Python 安装目录和 uv 的 Python 安装目录中查找它；不要求使用 uv，也不要求把本项目依赖装进全局 Python。
3. 安装 FFmpeg，并确保 `ffmpeg` 与同目录的 `ffprobe` 能从 `PATH` 启动。若不在 `PATH`，把 `CANVAS_STUDIO_FFMPEG_PATH` 指向 `ffmpeg.exe`。
4. 安装并打开桌面应用，选中任一视频转换节点，在设置里点击“安装本地推理环境”。首次安装需要访问 PyTorch 下载源与 Hugging Face 模型地址。
5. 等待状态显示“本地推理环境已就绪”及 GPU 名称，然后连接视频运行节点。

### Linux

代码中的推理服务支持 Linux NVIDIA + Python 3.12；仍需本机 NVIDIA 驱动、FFmpeg/FFprobe，并通过 `python3.12` 命令提供 Python。Linux 桌面发行安装流程尚未在本项目验证，不能把 Windows 的实测结果当成 Linux 发布验收。

### 需要单独安装 CUDA Toolkit 吗？

当前通过 PyTorch 的 `cu128` 二进制包安装 CUDA 运行时，通常**不需要另装 CUDA Toolkit 或编译器**；但 NVIDIA 显卡驱动仍是系统级要求。若驱动太旧，安装包和模型即使下载成功，CUDA 健康检查仍可能失败。换机前先更新显卡驱动，再安装应用推理环境。

### 下载量和磁盘空间

- PyTorch CUDA 主包：约 3.27 GB；torchvision 和辅助依赖另占少量空间。
- Video Depth Anything Small 权重：116,440,756 字节，约 111 MiB。应用下载后校验 SHA-256。
- 本机实际安装后的隔离运行环境与模型合计约 5.83 GB。安装期间还会暂存约 3.27 GB 的 PyTorch 安装包，建议目标磁盘至少预留 **10 GB**。
- 安装完成后模型与虚拟环境保存在该电脑的应用数据目录，不随项目源代码拉取。清理该目录会要求重新安装/下载。

首版安装按钮会在线安装固定版本依赖和模型；**离线安装包导入目前没有实现**。没有网络、PyTorch 源或模型源不可达时，另一台电脑暂时无法完成首次安装。

## 平台支持状态

| 环境 | 状态 |
|---|---|
| Windows x64 + NVIDIA CUDA + Python 3.12 + FFmpeg | RTX 5080 上已实测一段 854×480、24 fps、10 秒视频 |
| Linux x64 + NVIDIA CUDA + Python 3.12 + FFmpeg | 代码路径存在，尚未完成发行版与硬件组合验收 |
| macOS | 当前版本不支持本地 CUDA 推理 |
| 仅 CPU、AMD GPU 或无兼容 NVIDIA 驱动 | 当前版本不支持 |

Windows 测试证明的是本机和这类输入可以跑通，不代表所有显卡、长视频、码率或输入格式都已覆盖。首版单次最多处理 1800 帧；显存和临时磁盘占用会随尺寸、帧数和其他 GPU 任务改变。

## 依赖与模型版本位置

- Python 依赖版本与 CUDA wheel 下载源：[`src/main/media/video-conversion.ts`](../src/main/media/video-conversion.ts)。
- 推理参数、支持平台和 SHA-256：同一安装服务顶部常量。
- 视频深度推理、白模着色和模型内部输入尺寸：[`resources/video-conversion/runner.py`](../resources/video-conversion/runner.py)。
- 上游源码来源与许可证：[`resources/video-conversion/THIRD_PARTY_NOTICES.md`](../resources/video-conversion/THIRD_PARTY_NOTICES.md) 和 [`resources/video-conversion/VDA-LICENSE`](../resources/video-conversion/VDA-LICENSE)。
- [PyTorch 2.7.1 官方安装命令](https://pytorch.org/get-started/previous-versions/) · [NVIDIA CUDA/驱动兼容说明](https://docs.nvidia.com/deploy/cuda-compatibility/minor-version-compatibility.html) · [FFmpeg 官方下载页](https://www.ffmpeg.org/download.html)

更换 Python、CUDA wheel、推理源码提交或模型权重时，应同时更新版本清单、许可证/来源、模型哈希与本机健康检查记录；不要只升级其中一项后默认认定另一台电脑可用。
