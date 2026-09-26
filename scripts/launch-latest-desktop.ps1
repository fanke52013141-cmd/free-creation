$ErrorActionPreference = 'Stop'

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$AppDirectory = Join-Path $ProjectRoot 'dist\current-source-release\win-unpacked'
$AppExecutable = Join-Path $AppDirectory 'canvas-studio.exe'
$PnpmCommand = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
$LocationPushed = $false
$LaunchFailed = $false

try {
  if (-not $PnpmCommand) {
    throw '找不到 pnpm.cmd。请先安装 pnpm，并确认它已加入 PATH。'
  }

  $RunningApp = Get-Process -Name 'canvas-studio' -ErrorAction SilentlyContinue
  if ($RunningApp) {
    throw '检测到 Canvas Studio 仍在运行。请先完全退出，再用桌面快捷方式重新打开。'
  }

  Push-Location -LiteralPath $ProjectRoot
  $LocationPushed = $true

  Write-Host '正在构建当前源码并更新桌面版本，请稍候……' -ForegroundColor Cyan
  & $PnpmCommand.Source run build:desktop-latest
  $BuildExitCode = $LASTEXITCODE
  if ($BuildExitCode -ne 0) {
    throw "构建失败，退出代码：$BuildExitCode。旧版本不会启动。"
  }

  if (-not (Test-Path -LiteralPath $AppExecutable -PathType Leaf)) {
    throw "构建结束，但没有找到程序：$AppExecutable"
  }

  Write-Host '构建完成，正在启动最新版本……' -ForegroundColor Green
  Start-Process -FilePath $AppExecutable -WorkingDirectory $AppDirectory | Out-Null
}
catch {
  $LaunchFailed = $true
  Write-Host "启动最新版本失败：$($_.Exception.Message)" -ForegroundColor Red
  Write-Host '应用没有启动；修复构建问题后再点桌面快捷方式即可。' -ForegroundColor Yellow
}
finally {
  if ($LocationPushed) {
    Pop-Location
  }
}

if ($LaunchFailed) {
  Read-Host '按 Enter 关闭此窗口'
  exit 1
}
