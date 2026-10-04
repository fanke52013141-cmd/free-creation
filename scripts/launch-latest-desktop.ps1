$ErrorActionPreference = 'Stop'

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$DistRoot = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot 'dist'))
$ReleaseRoot = [System.IO.Path]::GetFullPath((Join-Path $DistRoot 'current-source-release'))
$AppDirectory = Join-Path $ReleaseRoot 'win-unpacked'
$AppExecutable = Join-Path $AppDirectory 'canvas-studio.exe'
$RendererIndex = Join-Path $AppDirectory 'resources\app\out\renderer\index.html'
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

  if (-not $GitCommand) {
    throw '找不到 git.exe，无法确认线上代码是否为最新。'
  }
  if (-not $PnpmCommandPath) {
    throw '找不到 pnpm.cmd。已检查 PATH、用户 npm 目录和本地 pnpm 目录。'
  }

  if (Get-Process -Name 'canvas-studio' -ErrorAction SilentlyContinue) {
    Write-Host 'Canvas Studio 正在运行。请先保存工作并完全退出应用。' -ForegroundColor Yellow
    Read-Host '退出后按 Enter 继续更新' | Out-Null
    $ExitDeadline = [DateTime]::UtcNow.AddSeconds(15)
    while ((Get-Process -Name 'canvas-studio' -ErrorAction SilentlyContinue) -and
           [DateTime]::UtcNow -lt $ExitDeadline) {
      Start-Sleep -Milliseconds 500
    }
    if (Get-Process -Name 'canvas-studio' -ErrorAction SilentlyContinue) {
      throw 'Canvas Studio 仍在运行，无法安全替换打包文件。'
    }
  }

  Push-Location -LiteralPath $ProjectRoot
  $LocationPushed = $true

  $RepoRoot = (& $GitCommand.Source rev-parse --show-toplevel).Trim()
  if ($LASTEXITCODE -ne 0 -or
      -not [string]::Equals([System.IO.Path]::GetFullPath($RepoRoot), $ProjectRoot,
        [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "快捷方式指向的目录不是预期 Git 仓库：$ProjectRoot"
  }

  $Branch = (& $GitCommand.Source symbolic-ref --quiet --short HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $Branch -ne 'main') {
    throw "当前分支为 '$Branch'；桌面版本要求使用 main 分支。"
  }

  Write-Host "源码目录：$ProjectRoot" -ForegroundColor DarkGray
  Write-Host '正在检查 origin/main 的最新提交……' -ForegroundColor Cyan
  & $GitCommand.Source -c credential.interactive=never fetch --no-tags origin main
  if ($LASTEXITCODE -ne 0) {
    throw '无法获取 origin/main。请检查网络或 Git 凭据；本次不会启动旧版本。'
  }

  $LocalCommit = (& $GitCommand.Source rev-parse HEAD).Trim()
  $RemoteCommit = (& $GitCommand.Source rev-parse refs/remotes/origin/main).Trim()
  if ($LASTEXITCODE -ne 0) {
    throw '无法读取 origin/main 的提交。'
  }

  & $GitCommand.Source merge-base --is-ancestor HEAD refs/remotes/origin/main
  if ($LASTEXITCODE -ne 0) {
    throw '本地 main 与 origin/main 已分叉，或包含尚未推送的提交。请先处理 Git 历史。'
  }

  if ($LocalCommit -ne $RemoteCommit) {
    Write-Host "正在快进 main：$($LocalCommit.Substring(0, 7)) → $($RemoteCommit.Substring(0, 7))" -ForegroundColor Cyan
    & $GitCommand.Source merge --ff-only refs/remotes/origin/main
    if ($LASTEXITCODE -ne 0) {
      throw '快进更新失败。Git 已保护与远端冲突的本地文件；请检查仓库状态。'
    }
  }

  $SourceCommit = (& $GitCommand.Source rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $SourceCommit -ne $RemoteCommit) {
    throw '本地 main 未与 origin/main 对齐，停止构建。'
  }
  $TrackedChanges = @(& $GitCommand.Source status --porcelain --untracked-files=no)
  if ($LASTEXITCODE -ne 0) {
    throw '无法检查构建前的本地文件状态。'
  }

  Write-Host "将构建提交：$($SourceCommit.Substring(0, 7))" -ForegroundColor Green
  if ($TrackedChanges.Count -gt 0) {
    Write-Host '检测到本地未提交的已跟踪文件改动；构建会包含这些改动。' -ForegroundColor Yellow
  }

  Write-Host '正在同步依赖……' -ForegroundColor Cyan
  & $PnpmCommandPath install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) {
    throw "依赖同步失败，退出代码：$LASTEXITCODE。"
  }

  # Build beside the working package. Only promote after executable and renderer validation.
  $StageRoot = [System.IO.Path]::GetFullPath((Join-Path $DistRoot ('staged-release-' + [Guid]::NewGuid().ToString('N'))))
  $DistPrefix = $DistRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  if (-not $StageRoot.StartsWith($DistPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
      -not $ReleaseRoot.StartsWith($DistPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw '发布目录不在预期 dist 目录内'
  }
  foreach ($Path in @($DistRoot, $ReleaseRoot)) {
    if ((Test-Path -LiteralPath $Path) -and ((Get-Item -LiteralPath $Path).Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
      throw '发布目录含重解析点，无法切换'
    }
  }
  Write-Host '正在从当前源码构建全新桌面版本……' -ForegroundColor Cyan
  & $PnpmCommandPath run build
  if ($LASTEXITCODE -ne 0) { throw '源码构建失败，保留原桌面版本' }
  & $PnpmCommandPath exec electron-builder --dir "--config.directories.output=$StageRoot" --config.electronDist=node_modules/electron/dist
  if ($LASTEXITCODE -ne 0) {
    throw "构建失败，退出代码：$LASTEXITCODE。"
  }
  $StageApp = Join-Path $StageRoot 'win-unpacked'
  $StageExecutable = Join-Path $StageApp 'canvas-studio.exe'
  $StageRenderer = Join-Path $StageApp 'resources\app\out\renderer\index.html'
  if (-not (Test-Path -LiteralPath $StageExecutable -PathType Leaf) -or
      -not (Test-Path -LiteralPath $StageRenderer -PathType Leaf)) {
    throw '构建结束，但新应用或渲染页面缺失。'
  }

  [pscustomobject]@{
    sourceCommit = $SourceCommit
    builtAtUtc = [DateTime]::UtcNow.ToString('o')
    includesUncommittedChanges = ($TrackedChanges.Count -gt 0)
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $StageApp 'build-source.json') -Encoding UTF8

  $PreviousRoot = Join-Path $DistRoot ('previous-release-' + [Guid]::NewGuid().ToString('N'))
  $MovedPrevious = $false
  try {
    if (Test-Path -LiteralPath $ReleaseRoot) {
      [System.IO.Directory]::Move($ReleaseRoot, $PreviousRoot)
      $MovedPrevious = $true
    }
    [System.IO.Directory]::Move($StageRoot, $ReleaseRoot)
  } catch {
    if ($MovedPrevious -and -not (Test-Path -LiteralPath $ReleaseRoot)) {
      [System.IO.Directory]::Move($PreviousRoot, $ReleaseRoot)
    }
    throw
  }
  Write-Host "构建完成，正在启动版本 $($SourceCommit.Substring(0, 7))……" -ForegroundColor Green
  Start-Process -FilePath $AppExecutable -WorkingDirectory $AppDirectory -WindowStyle Hidden | Out-Null
}
catch {
  $LaunchFailed = $true
  Write-Host "更新或启动失败：$($_.Exception.Message)" -ForegroundColor Red
  Write-Host '原工作包已保留，可用 launch-verified-desktop.ps1 启动。' -ForegroundColor Yellow
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
