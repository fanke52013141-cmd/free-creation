# ============================================================
#  Canvas Studio 最新版启动器（快速直启方案）
#  每次启动自动：1) main 分支拉取最新代码（离线/失败时用本地代码照常启动）
#                2) pnpm-lock 有变才重装依赖（平时秒过）
#                3) src/ 或 packages/ 有新改动才增量构建（平时秒过）
#                4) 优雅关闭旧实例后，直接从源码启动最新构建
#  说明：应用同一时间只允许一个实例（数据库所有权锁），
#  因此启动前会像「点窗口 ×」一样优雅关闭旧实例，正常保存退出。
#  需要启动「严格校验的打包版本」时，请使用 launch-verified-desktop.ps1。
# ============================================================
$ErrorActionPreference = 'Stop'

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$StateDir    = Join-Path $env:LOCALAPPDATA 'canvas-studio-launcher'
$BuildMark   = Join-Path $StateDir 'last-build.time'
$DepMark     = Join-Path $StateDir 'last-install.time'
$ElectronExe = Join-Path $ProjectRoot 'node_modules\electron\dist\electron.exe'
$GitCommand = Get-Command git.exe -ErrorAction SilentlyContinue
$PnpmCommand = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
$PnpmCommandPath = if ($PnpmCommand) { $PnpmCommand.Source } else { $null }

if (-not $PnpmCommandPath -and $env:APPDATA) {
  $UserPnpmCommand = Join-Path $env:APPDATA 'npm\pnpm.cmd'
  if (Test-Path -LiteralPath $UserPnpmCommand -PathType Leaf) {
    $PnpmCommandPath = $UserPnpmCommand
  }
}

if (-not $PnpmCommandPath -and $env:LOCALAPPDATA) {
  $LocalPnpmCommand = Join-Path $env:LOCALAPPDATA 'pnpm\pnpm.cmd'
  if (Test-Path -LiteralPath $LocalPnpmCommand -PathType Leaf) {
    $PnpmCommandPath = $LocalPnpmCommand
  }
}

$LauncherMutex = New-Object System.Threading.Mutex($false, 'Local\CanvasStudioLatestDesktopLauncher')
$MutexAcquired = $false
$LocationPushed = $false
$LaunchFailed = $false

try {
  try {
    $MutexAcquired = $LauncherMutex.WaitOne(0)
  } catch [System.Threading.AbandonedMutexException] {
    $MutexAcquired = $true
  }
  if (-not $MutexAcquired) {
    throw '另一个 Canvas Studio 更新窗口正在运行，请等待它完成。'
  }

  # A Node-based host can pass this flag through to the shortcut and break Electron builds.
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  $env:GIT_TERMINAL_PROMPT = '0'
  $env:GCM_INTERACTIVE = 'Never'

  New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
  Push-Location -LiteralPath $ProjectRoot
  $LocationPushed = $true

  Write-Host ''
  Write-Host '  Canvas Studio - 检查更新...' -ForegroundColor Cyan

  # 1) 拉取最新代码：仅在 main 分支执行快进拉取；离线/失败时用本地代码照常启动，
  #    本地未提交的修改始终包含在本次构建中。
  $Branch = $null
  if ($GitCommand) {
    $BranchOutput = & $GitCommand.Source symbolic-ref --quiet --short HEAD
    if ($LASTEXITCODE -eq 0) { $Branch = $BranchOutput }
  }
  if (-not $GitCommand) {
    Write-Host '  ! 找不到 git.exe，跳过代码同步，使用本地现有代码' -ForegroundColor Yellow
  } elseif ($Branch -ne 'main') {
    Write-Host "  ! 当前分支不是 main，跳过代码同步，使用本地现有代码" -ForegroundColor Yellow
  } else {
    & $GitCommand.Source pull --ff-only origin main
    if ($LASTEXITCODE -ne 0) {
      Write-Host '  ! 无法连接仓库或历史已分叉，使用本地现有代码启动' -ForegroundColor Yellow
    }
  }

  if (-not $PnpmCommandPath) {
    throw '找不到 pnpm.cmd。已检查 PATH、用户 npm 目录和本地 pnpm 目录。'
  }

  # 2) 依赖：pnpm-lock.yaml 有更新才重装（平时秒过）
  $LockFile = Get-Item -LiteralPath (Join-Path $ProjectRoot 'pnpm-lock.yaml')
  $needInstall = (-not (Test-Path -LiteralPath $DepMark)) -or ($LockFile.LastWriteTime -gt (Get-Item -LiteralPath $DepMark).LastWriteTime)
  if ($needInstall) {
    Write-Host '  [1/4] 依赖有更新，安装中...' -ForegroundColor Cyan
    # confirmModulesPurge=false：modules 目录元数据不一致时自动确认，避免无人值守时卡在交互输入。
    & $PnpmCommandPath install --frozen-lockfile --prefer-offline --config.confirmModulesPurge=false
    if ($LASTEXITCODE -ne 0) { throw "依赖安装失败，退出代码：$LASTEXITCODE。" }
    Set-Content -LiteralPath $DepMark -Value (Get-Date).ToString('o')
  } else {
    Write-Host '  [1/4] 依赖无变化，跳过' -ForegroundColor DarkGray
  }

  # 3) 构建：src/ 或 packages/ 源码比上次构建新才重建（平时秒过；排除 node_modules）
  $WatchDirs = @('src', 'packages') | ForEach-Object { Join-Path $ProjectRoot $_ }
  $SourceNewest = (Get-ChildItem -LiteralPath $WatchDirs -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\\node_modules\\' } |
    Measure-Object LastWriteTime -Maximum).Maximum
  if (-not $SourceNewest) {
    $SourceNewest = (Get-Item -LiteralPath (Join-Path $ProjectRoot 'package.json')).LastWriteTime
  }
  $needBuild = (-not (Test-Path -LiteralPath $BuildMark)) -or ($SourceNewest -gt (Get-Item -LiteralPath $BuildMark).LastWriteTime)
  if ($needBuild) {
    Write-Host '  [2/4] 发现新代码，构建中（约 10-40 秒）...' -ForegroundColor Cyan
    & $PnpmCommandPath exec electron-vite build
    if ($LASTEXITCODE -ne 0) { throw "源码构建失败，退出代码：$LASTEXITCODE。" }
    New-Item -ItemType File -Path $BuildMark -Force | Out-Null
    Write-Host '  OK 构建完成' -ForegroundColor Green
  } else {
    Write-Host '  [2/4] 已是最新构建' -ForegroundColor DarkGray
  }

  if (-not (Test-Path -LiteralPath $ElectronExe -PathType Leaf)) {
    throw "未找到 Electron 可执行文件：$ElectronExe。请先完成依赖安装。"
  }
  $MainEntry = Join-Path $ProjectRoot 'out\main\index.js'
  if (-not (Test-Path -LiteralPath $MainEntry -PathType Leaf)) {
    throw "构建产物缺失：$MainEntry。"
  }

  # 4) 关闭正在运行的旧实例（等同点击窗口 ×，应用正常保存退出）
  function Get-CanvasMainProcesses {
    $projectArgument = '(?i)(?:^|\s)"?' + [regex]::Escape($ProjectRoot) + '"?(?:\s|$)'
    $packagedExe = Join-Path $ProjectRoot 'dist\current-source-release\win-unpacked\canvas-studio.exe'
    $ids = @(Get-CimInstance Win32_Process -Filter "Name='electron.exe' OR Name='canvas-studio.exe'" |
      Where-Object {
        ($_.ExecutablePath -ieq $ElectronExe -and $_.CommandLine -match $projectArgument) -or
        ($_.ExecutablePath -ieq $packagedExe)
      } | Select-Object -ExpandProperty ProcessId)
    if ($ids.Count -gt 0) { Get-Process -Id $ids -ErrorAction SilentlyContinue }
  }
  $mine = @(Get-CanvasMainProcesses)
  if ($mine) {
    Write-Host '  [3/4] 检测到 Canvas Studio 正在运行，正在优雅关闭（等同点窗口 ×）...' -ForegroundColor Cyan
    $mine | ForEach-Object { $_.CloseMainWindow() | Out-Null }
    $mine | Wait-Process -Timeout 15 -ErrorAction SilentlyContinue
    $left = @(Get-CanvasMainProcesses)
    if ($left) {
      throw '旧实例未能退出（可能有未保存内容），请手动关闭后重试。'
    }
    Write-Host '  OK 已关闭旧实例' -ForegroundColor Green
  } else {
    Write-Host '  [3/4] 无正在运行的实例' -ForegroundColor DarkGray
  }

  # 5) 启动最新版（不能加 -WindowStyle Hidden：Electron 会继承 STARTUPINFO 隐藏标记，导致主窗口不可见）
  Write-Host '  [4/4] 启动 Canvas Studio（最新版）...' -ForegroundColor Cyan
  Start-Process -FilePath $ElectronExe -ArgumentList ('"' + $ProjectRoot + '"') -WorkingDirectory $ProjectRoot | Out-Null
  Start-Sleep -Milliseconds 600
}
catch {
  $LaunchFailed = $true
  Write-Host "更新或启动失败：$($_.Exception.Message)" -ForegroundColor Red
}
finally {
  if ($LocationPushed) {
    Pop-Location
  }
  if ($MutexAcquired) {
    $LauncherMutex.ReleaseMutex()
  }
  $LauncherMutex.Dispose()
}

if ($LaunchFailed) {
  Read-Host '按 Enter 关闭此窗口' | Out-Null
  exit 1
}

exit 0
