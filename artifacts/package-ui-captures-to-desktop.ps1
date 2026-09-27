$ErrorActionPreference = 'Stop'

$sourceRoot = Join-Path $PSScriptRoot 'ui-optimization-capture'
$nodesRoot = Join-Path $sourceRoot 'nodes'
$scenarioRoot = Join-Path $sourceRoot 'scenarios'
$desktop = [Environment]::GetFolderPath('Desktop')
$baseName = 'Canvas Studio 节点 UI 截图'
$targetRoot = Join-Path $desktop $baseName
$packageAlreadyExists = Test-Path -LiteralPath $targetRoot -PathType Container
$suffix = 2
while ((Test-Path -LiteralPath $targetRoot) -and -not $packageAlreadyExists) {
    $targetRoot = Join-Path $desktop ("{0} ({1})" -f $baseName, $suffix)
    $suffix++
}

$nodes = @(
    @{ Source='ai-process-AI'; Name='AI 处理'; Summary='将上游文本或 JSON 交给文本模型处理，并将文本、Markdown 或 JSON 结果交给后续节点。'; Config='模型提供方/模型；输出模式（文本、Markdown、JSON）；JSON 模式的目标 Schema；系统提示词；温度；最大输出 Token 数。任务正文保存在节点正文，可插入连线文本/JSON 上下文。' },
    @{ Source='audio-'; Name='音频'; Summary='导入并保存一份本地音频资产，供预览和下游音频节点连接使用；不负责配音或生成。'; Config='选择或替换本地音频文件；查看文件名、时长等信息并预览。没有模型、音色或处理参数。输出为该音频资产。' },
    @{ Source='chat-AI'; Name='AI 对话'; Summary='与文本模型开展多轮对话，将最后一条助手回复作为文本输出；上游文本作为本轮输入。'; Config='系统提示词、温度、最大输出 Token 数；通过应用模型服务选择模型；维护对话历史，编辑本轮输入并发送。' },
    @{ Source='code-'; Name='代码'; Summary='执行离线确定性的代码转换：读取命名输入参数，将 return 值写入命名输出变量。'; Config='代码源码；可增删输入参数（名称、数据类型）及输出变量（名称、数据类型）；参数名称决定动态端口，端口数据来自连线。UI 应区分代码编辑区、变量/端口定义、运行错误和结果。' },
    @{ Source='director-3D'; Name='3D 预演台'; Summary='在 3D 白模场景中编排镜头、机位和预演画面；用户明确发布后，帧、视频和机位才供下游使用。'; Config='工作台中管理镜头/分镜同步、场景参考图、每镜头的机位与构图、焦距/画幅/时长等参数，可预览并手动发布当前帧或预演视频。' },
    @{ Source='file-'; Name='文件'; Summary='导入文档类文件并保存为文件资产，供预览或后续文件处理流程连接；不负责文档生成。'; Config='选择或替换本地文件；展示文件名、类型/大小等信息，并提供打开或预览入口。没有额外转换参数。' },
    @{ Source='image-'; Name='图片'; Summary='导入并保存一张图片资产，供预览和下游图像节点连接；不承担生图或图片修改。'; Config='选择/替换本地图片；展示缩略图和媒体信息并可预览。没有模型或图像处理参数。' },
    @{ Source='image-crop-'; Name='裁剪'; Summary='对上游图片做矩形裁剪或四角透视裁剪，运行后生成新的图片资产，原图不变。'; Config='裁剪方式（矩形/四角透视）；矩形模式下常用/自定义宽高比或自由比例；矩形归一化位置与尺寸，或四个归一化角点。' },
    @{ Source='image-edit-P'; Name='P图'; Summary='以一张上游图片为原图，叠加文字说明与标注/遮罩后调用图片模型生成新图，原图保持不变。'; Config='修改提示词；选择模型；箭头、矩形、画笔、文字标注及各自颜色/线宽/文字；可选遮罩开关、笔刷大小与反选。' },
    @{ Source='image-gen-'; Name='生图'; Summary='根据用户提示词与有序参考图片生成图片，并将生成结果作为资产交给下游。'; Config='模型提供方/模型；画幅比例；模型支持时的分辨率；生成张数；透明背景开关；提示词正文和多值参考图片输入。此次截图只展示配置与契约 UI，未执行生成。' },
    @{ Source='image-split-'; Name='拆分'; Summary='按网格把一张输入图片切成多张新图片，输出图片集合，并让用户选定其中一张作为当前图。'; Config='行数；列数；每格面积缩放百分比（以格子中心缩放）；结果集合中当前选中的图片。' },
    @{ Source='iterate-'; Name='批量处理'; Summary='逐项遍历 JSON 列表，把当前项注入循环体下游节点并汇总每项结果。'; Config='处理上限（0 表示不限）；运行策略（续跑/重跑失败等）；单项失败策略；若选择重试则设置重试次数。' },
    @{ Source='json-JSON'; Name='JSON'; Summary='编辑、格式化并查看 JSON 数据；合法结构以字段卡片/列表呈现，非法内容显示解析错误。'; Config='JSON 正文（可双击编辑）；格式化操作。没有额外业务参数或 Schema 选择，校验目标由结构数据节点承担。' },
    @{ Source='processor-'; Name='数据处理'; Summary='按选定规则把输入值原样传递、提取 JSON 字段或套入文本模板，不调用模型。'; Config='处理方式（原样传递/提取字段/字符串模板）；未连接输入时使用的固定值；固定值类型（文本、数字、布尔、对象、数组或任意）；提取字段路径；模板字符串（用 {{value}} 插入输入）。' },
    @{ Source='speech-'; Name='配音'; Summary='调用所选语音服务将文本转换成通用配音音频；不使用参考音频克隆音色。'; Config='后端/服务与模型；音色/Voice ID；语音格式；依后端显示语言或采样率、码率、声道；文本规范化/英文读法；部分后端支持音调、音色强度和音色特征；水印开关。参数随所选后端变化。' },
    @{ Source='storyboard-'; Name='分镜板'; Summary='把分镜 JSON 呈现为可编辑镜头卡片，并同时提供结构化分镜和文字摘要输出。'; Config='镜头列表及每镜头字段（如画面描述、时长、对白等）；新增、删除、调整镜头顺序；编辑结构数据。' },
    @{ Source='structured-'; Name='结构数据'; Summary='编辑并按所选业务 Schema 校验 JSON 正文；运行时可把已连接文本/JSON 上下文插入模板。'; Config='Schema 类型选择；JSON 正文/模板；使用 {{text}} 和 {{input[n]}} 占位符引用上游值。字段路径区可复制路径，实时显示合法、待注入或校验失败状态。' },
    @{ Source='text-'; Name='文本'; Summary='保存可编辑的原始文本；运行时把连接到文本输入端口的内容并入正文，再输出文本。'; Config='文本正文（多行编辑）；可连接上游文本上下文。没有模型参数；标题可单独重命名。' },
    @{ Source='tts-'; Name='语音克隆'; Summary='以参考语音作为音色条件，将文本合成为克隆音频；支持云端 MiniMax 或本地 IndexTTS 后端。'; Config='后端；MiniMax 时的服务提供方/模型、自定义 Voice ID、相似度、语言增强、降噪、音量归一化、水印；本地后端可设参考语音、参考语音对应文本、语言、语速、情绪；输出格式。参数随后端变化。' },
    @{ Source='video-asset-'; Name='视频素材'; Summary='导入并保存一份本地视频资产，供预览以及视频截取、抽帧等节点连接使用；不负责生成视频。'; Config='选择/替换本地视频文件；展示视频预览与媒体信息。时间点和处理方式属于下游节点，不属于素材节点。' },
    @{ Source='video-clip-'; Name='视频截取'; Summary='按保存的起止时间截取上游视频，并生成新的视频或音频资产；支持只保留画面、只保留音频或两者。'; Config='截取起点和终点（毫秒，可用时间轴编辑）；保留内容模式（视频与音频/仅视频/仅音频）；按模式显示视频或音频专属选项。' },
    @{ Source='video-frame-'; Name='抽帧'; Summary='从上游视频提取首帧、尾帧或指定时刻画面，并生成新的图片资产。'; Config='抽帧位置模式（首帧/尾帧/指定时间）；指定时刻以毫秒保存，可通过时间轴预览与选择。' },
    @{ Source='vocal-separate-'; Name='人声分离'; Summary='将输入音频分离出人声；质量模式可选择同时物化伴奏为独立音频资产。'; Config='处理模式（快速本地处理/高质量分离）；高质量模式下是否输出伴奏。' },
    @{ Source='voice-design-'; Name='音色设计'; Summary='根据文字描述设计新的语音音色，生成试听音频和可复用的音色 ID。'; Config='模型提供方/模型；音色描述正文；试听文本；可选自定义 Voice ID；生成内容的水印开关。' }
)

$projectBackground = @(
    '项目背景：Canvas Studio 是一个本地单用户的 Electron 桌面创作软件，前端使用 React 与 TypeScript。它以可视化画布组织创作工作流：用户放置节点、通过有类型的输入/输出端口连线，逐节点传递文本、JSON、图片、视频、音频或文件数据。节点承担单一明确职责；复杂设置和输入输出契约在节点详情/侧栏中查看，执行状态与结果显示回节点。',
    '项目包含素材输入、图像/视频/音频处理、文本与结构化数据、AI 处理、代码和循环等节点。媒体处理结果作为新的本地资产保存，工作流通过显式端口传递引用。该产品面向本机项目，不依赖登录、团队或云端项目服务。截图素材用于后续整体优化画布节点卡片、配置控件、说明侧栏、工作台弹窗、状态反馈与工作流操作。',
    '视觉设计提示：节点 UI 既要适配高密度画布，也要清楚呈现不同数据类型、必填/多值端口、可编辑配置、滚动内容、成功/失败状态和结果预览。具体功能边界与每个节点的参数以本文件下方说明为准。'
) -join "`r`n"

function Get-ScreenshotNotes($fileName, $nodeName) {
    switch -Regex ($fileName) {
        '^01-default\.png$' {
            return '节点刚加入画布后的默认卡片状态。用于检查节点标题、图标、默认内容/占位、端口位置、卡片尺寸以及运行或更多操作入口；结合本目录的节点说明判断它在工作流中的职责。'
        }
        '^02-card-scroll-top\.png$' {
            return '节点卡片内部滚动内容的顶部位置。用于观察初始可见字段、卡片内部滚动条和滚动容器边界；与 03-card-scroll-bottom.png 连续查看，确认长内容没有被截掉。'
        }
        '^03-card-scroll-bottom\.png$' {
            return '同一节点卡片滚动到内容下部后的画面。用于检查尾部字段、底部按钮/操作区是否被内容挤压，以及滚动后卡片边界和滚动条反馈。'
        }
        '^04-io-top\.png$' {
            return '打开节点的输入/输出说明侧栏并停留在顶部。用于检查侧栏入口、标题和关闭方式、输入与输出分区、端口名称/类型/必填性说明及信息层级。'
        }
        '^04-io-scroll-(\d+)\.png$' {
            $part = [int]$Matches[1]
            return "输入/输出说明侧栏向下滚动的第 $part 段。请按编号顺序与 04-io-top.png 连续浏览，核对顶部之后的端口、字段、约束和说明是否完整，并观察滚动位置提示及分区衔接。"
        }
        '^05-run-details\.png$' {
            return '节点运行详情/运行操作区域。用于检查运行按钮、运行状态或结果摘要、耗时/错误信息入口，以及运行相关信息与节点配置之间的层级关系。'
        }
        '^(06|07)-run-success\.png$' {
            return '节点执行成功后的真实状态画面。用于检查成功标识、输出/结果预览、运行后卡片高度变化，以及成功反馈是否足够明确。'
        }
        '^(06|07)-run-failed\.png$' {
            return '节点执行失败后的状态画面。用于检查错误标识、错误文本和上下文、失败结果的展开方式、重试入口及错误状态对卡片布局的影响。'
        }
        '^04-chat-panel\.png$' {
            return 'AI 对话节点的对话面板状态。用于检查消息历史区域、角色/消息层级、输入框、发送操作和面板关闭/返回方式；与 01-default.png 对照查看节点卡片与面板的视觉关系。'
        }
        '^07-workbench\.png$' {
            if ($nodeName -eq '视频截取') { return '视频截取工作台弹窗，使用本地样例视频展示。用于检查视频预览、时间轴/起止范围、截取参数、确认与取消操作，以及长内容弹窗的滚动和布局。' }
            if ($nodeName -eq '抽帧') { return '视频抽帧工作台弹窗，使用本地样例视频展示。用于检查视频预览、抽帧方式和参数、输出设置、确认与取消操作，以及弹窗信息分组。' }
            if ($nodeName -eq 'P图') { return '图片修改工作台弹窗，使用本地样例图片展示。用于检查原图预览、编辑说明/提示词、工具区、模型或处理配置、提交入口与弹窗的空间分配。' }
            return '节点专属工作台弹窗。用于检查弹窗内部的主要内容区域、配置控件、关闭和确认操作，以及其与底层画布的视觉关系。'
        }
        '^08-audio-only-settings\.png$' {
            return '视频截取设置切换为仅保留音频后的工作台状态。用于检查模式切换反馈、音频相关选项、与视频截取参数之间的显隐关系和设置面板布局。'
        }
        '^08-brush-tool\.png$' {
            return '图片修改工作台中画笔工具被选中的状态。用于检查工具栏选中反馈、画布上的笔刷/标注交互、工具切换状态和编辑提示是否清晰。'
        }
        '^09-run-result\.png$' {
            if ($nodeName -eq '视频截取') { return '使用本地样例完成视频截取后的结果状态。用于检查结果预览/素材信息、成功反馈、返回编辑或再次运行的路径，以及节点结果在卡片中的呈现。' }
            if ($nodeName -eq '抽帧') { return '使用本地样例完成抽帧后的结果状态。用于检查帧图片结果、输出数量/预览、成功反馈及结果回到工作流后的可见性。' }
            return '节点完成处理后的结果状态。用于检查成功反馈、结果预览和后续操作入口。'
        }
        default { return '节点相关的补充状态截图。用于对照本目录其他画面检查状态变化、内容可见性和交互反馈。' }
    }
}

if (-not $packageAlreadyExists) { New-Item -ItemType Directory -Path $targetRoot | Out-Null }
$totalScreenshots = 0
foreach ($node in $nodes) {
    $sourceDir = Join-Path $nodesRoot $node.Source
    if (-not (Test-Path -LiteralPath $sourceDir -PathType Container)) { throw "Missing node capture folder: $sourceDir" }
    $destDir = Join-Path $targetRoot $node.Name
    if (-not $packageAlreadyExists) { Copy-Item -LiteralPath $sourceDir -Destination $destDir -Recurse }
    if (-not (Test-Path -LiteralPath $destDir -PathType Container)) { throw "Missing desktop node folder: $destDir" }
    $imageFiles = @(Get-ChildItem -LiteralPath $destDir -File -Filter '*.png' | Sort-Object Name)
    if ($imageFiles.Count -eq 0) { throw "No screenshots found for node: $($node.Name)" }
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add("节点：$($node.Name)")
    $lines.Add('')
    $lines.Add($projectBackground)
    $lines.Add('')
    $lines.Add('节点用途与整体观察方向：')
    $lines.Add($node.Summary)
    $lines.Add('')
    $lines.Add('主要功能与配置项：')
    $lines.Add($node.Config)
    $lines.Add('')
    $lines.Add('逐张截图说明（按文件名顺序）：')
    $lines.Add('')
    foreach ($image in $imageFiles) {
        $lines.Add("截图名称：$($image.Name)")
        $lines.Add("截图介绍：$(Get-ScreenshotNotes $image.Name $node.Name)")
        $lines.Add('')
    }
    $lines.Add('建议整体优化时结合本目录全部截图，对照默认态、说明侧栏、滚动内容和运行/弹窗状态，统一标题、间距、控件层级、状态反馈与操作入口。')
    Set-Content -LiteralPath (Join-Path $destDir '介绍.txt') -Value $lines -Encoding UTF8
    $totalScreenshots += $imageFiles.Count
}

$scenarioDest = Join-Path $targetRoot '通用交互场景'
if (-not $packageAlreadyExists) { Copy-Item -LiteralPath $scenarioRoot -Destination $scenarioDest -Recurse }
$scenarioDescriptions = @{
    '01-connected-nodes.png' = '两个节点通过端口建立连线后的画面。用于检查端口命中区、连线走向、箭头/方向、选中反馈，以及连线与节点遮挡时的可读性。'
    '02-multi-select.png' = '画布上同时选中多个节点的画面。用于检查多选框/选中描边、多个节点的共同状态、画布空白处的操作反馈，以及多选后顶部工具栏是否出现。'
    '03-align-left.png' = '多选节点后从顶部工具栏触发左对齐操作的画面。用于检查工具栏中的对齐入口、点击后的对齐结果和节点位置变化是否容易辨认。'
    '04-grouped.png' = '多个节点完成打组后的画面。用于检查组容器边界、组名/折叠控制、组内节点保留情况，以及组和画布之间的层级关系。'
    '05-workflow-run.png' = '从工作流层级发起运行时的画面。用于检查整体运行入口、运行范围提示、运行前节点关系和工作流级操作反馈。'
    '06-workflow-running.png' = '工作流运行中的画面。用于检查运行中节点标识、进度/等待状态、画布上的状态传播和运行期间可用的操作。'
    '07-workflow-completed.png' = '工作流运行完成后的画面。用于检查完成状态、结果可见性、各节点状态收尾和再次运行/继续编辑的入口。'
}
$scenarioLines = [System.Collections.Generic.List[string]]::new()
$scenarioLines.Add('目录：通用交互场景')
$scenarioLines.Add('这些截图横跨多个节点，集中记录连线、画布多选、顶部对齐、打组和工作流运行过程。')
$scenarioLines.Add('')
foreach ($image in (Get-ChildItem -LiteralPath $scenarioDest -File -Filter '*.png' | Sort-Object Name)) {
    $description = $scenarioDescriptions[$image.Name]
    if (-not $description) { $description = '工作流通用交互画面，用于检查该场景的状态反馈和画布操作层级。' }
    $scenarioLines.Add("截图名称：$($image.Name)")
    $scenarioLines.Add("截图介绍：$description")
    $scenarioLines.Add('')
    $totalScreenshots++
}
Set-Content -LiteralPath (Join-Path $scenarioDest '介绍.txt') -Value $scenarioLines -Encoding UTF8

$readme = @(
    'Canvas Studio 节点 UI 截图素材包',
    '',
    "节点文件夹：$($nodes.Count) 个；截图：$totalScreenshots 张。",
    '每个节点文件夹的介绍.txt 顶部含项目背景，下方说明节点职责、主要功能和配置项，并逐张解释截图名称、状态/场景、用途及 UI 观察重点。',
    '通用交互场景目录收录连线、多选、顶部对齐、打组及工作流运行状态。',
    '按要求未收录视频生成节点。AI/模型生成类节点以配置和说明 UI 为主，没有执行尚未稳定的生成流程；视频截取和抽帧的结果来自本地样例素材。'
)
Set-Content -LiteralPath (Join-Path $targetRoot '说明.txt') -Value $readme -Encoding UTF8
if (Test-Path -LiteralPath (Join-Path $sourceRoot 'manifest.json')) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'manifest.json') -Destination $targetRoot
}

Write-Output "PACKAGE=$targetRoot"
Write-Output "NODE_FOLDERS=$($nodes.Count)"
Write-Output "SCREENSHOTS=$totalScreenshots"
