param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$AppDirectory = Join-Path $ProjectRoot 'dist\current-source-release\win-unpacked'
$Executable = Join-Path $AppDirectory 'canvas-studio.exe'
$Manifest = Join-Path $AppDirectory 'build-source.json'
if (-not (Test-Path -LiteralPath $Executable -PathType Leaf) -or
    -not (Test-Path -LiteralPath $Manifest -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $AppDirectory 'resources\app\out\renderer\index.html') -PathType Leaf)) {
  throw '已装工作包或版本清单缺失；请先完成桌面构建。此入口不会拉代码或重建。'
}
$Build = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
if ($Build.sourceCommit -notmatch '^[0-9a-f]{40}$' -or -not $Build.builtAtUtc) { throw '版本清单无效' }
Write-Host "源码提交：$($Build.sourceCommit)；构建时间：$($Build.builtAtUtc)"
if ($Build.includesUncommittedChanges) { Write-Host '该包包含构建时的本地修改。' }
if (-not $CheckOnly) {
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  # 不能用 -WindowStyle Hidden：Electron 会继承 STARTUPINFO 的隐藏标记，
  # 导致主窗口一直不可见（应用在运行却看不到窗口）。
  Start-Process -FilePath $Executable -WorkingDirectory $AppDirectory | Out-Null
}
