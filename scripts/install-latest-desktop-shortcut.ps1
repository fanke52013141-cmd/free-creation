[CmdletBinding()]
param(
  [ValidateNotNullOrEmpty()]
  [string]$Name = '启动 Canvas Studio',

  [ValidateNotNullOrEmpty()]
  [string]$DesktopPath = [Environment]::GetFolderPath([Environment+SpecialFolder]::Desktop)
)

$ErrorActionPreference = 'Stop'

function Get-ShortcutFileName {
  param([string]$RequestedName)

  if ([System.IO.Path]::GetFileName($RequestedName) -ne $RequestedName) {
    throw '快捷方式名称不能包含目录。请只传入名称，例如“自由画布”。'
  }

  if ($RequestedName.EndsWith('.lnk', [System.StringComparison]::OrdinalIgnoreCase)) {
    return $RequestedName
  }

  return "$RequestedName.lnk"
}

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$LauncherPath = Join-Path $ProjectRoot 'scripts\launch-latest-desktop.ps1'
if (-not (Test-Path -LiteralPath $LauncherPath -PathType Leaf)) {
  throw "未找到启动脚本：$LauncherPath"
}

$ResolvedDesktopPath = (Resolve-Path -LiteralPath $DesktopPath).Path
$ShortcutPath = Join-Path $ResolvedDesktopPath (Get-ShortcutFileName -RequestedName $Name)
$WindowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $WindowsPowerShell -PathType Leaf)) {
  throw "未找到 Windows PowerShell：$WindowsPowerShell"
}

$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $WindowsPowerShell
$Shortcut.Arguments = "-NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -File `"$LauncherPath`""
$Shortcut.WorkingDirectory = $ProjectRoot
$Shortcut.Description = '同步线上 main、全新构建并启动 Canvas Studio'
$AppIcon = Join-Path $ProjectRoot 'dist\current-source-release\win-unpacked\canvas-studio.exe'
if (Test-Path -LiteralPath $AppIcon -PathType Leaf) {
  $Shortcut.IconLocation = "$AppIcon,0"
} elseif (-not $Shortcut.IconLocation) {
  $Shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,208"
}
$Shortcut.Save()

Write-Host "已更新桌面快捷方式：$ShortcutPath" -ForegroundColor Green
Write-Host '以后点击它会先同步 origin/main、全新构建，再启动桌面应用。' -ForegroundColor Cyan
