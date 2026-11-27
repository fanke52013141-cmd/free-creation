param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][string]$WindowTitle,
  [Parameter(Mandatory = $true)][string]$ButtonName,
  [int]$TimeoutMs = 60000
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -Namespace CanvasAcceptance -Name NativeMethods -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetCursorPos(int x, int y);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, System.UIntPtr extraInfo);
"@

$automation = [System.Windows.Automation.AutomationElement]
$tree = [System.Windows.Automation.TreeScope]
$deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)

function Invoke-NativeTarget($target) {
  try {
    $invoke = $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    if ($null -ne $invoke) {
      $invoke.Invoke()
      return 'invoke-pattern'
    }
  } catch {
    # Chromium native views may expose the action only through legacy accessibility.
  }
  try {
    $legacy = $target.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
    if ($null -ne $legacy) {
      $legacy.DoDefaultAction()
      return 'legacy-default-action'
    }
  } catch {
    # Fall through to a real pointer click at the accessible element's center.
  }
  $bounds = $target.Current.BoundingRectangle
  if ($bounds.Width -le 0 -or $bounds.Height -le 0) {
    return $null
  }
  $x = [int]($bounds.X + $bounds.Width / 2)
  $y = [int]($bounds.Y + $bounds.Height / 2)
  [void][CanvasAcceptance.NativeMethods]::SetCursorPos($x, $y)
  [CanvasAcceptance.NativeMethods]::mouse_event(0x0002, 0, 0, 0, [System.UIntPtr]::Zero)
  [CanvasAcceptance.NativeMethods]::mouse_event(0x0004, 0, 0, 0, [System.UIntPtr]::Zero)
  return 'pointer-click'
}

while ([DateTime]::UtcNow -lt $deadline) {
  $windows = $automation::RootElement.FindAll(
    $tree::Children,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  foreach ($window in $windows) {
    try {
      # Windows may ignore Electron's MessageBox title and renders its buttons as
      # CCPushButton panes inside the BrowserWindow. Scope by the real main PID and
      # exact accessible name instead of assuming a standard Win32 button type.
      if ($window.Current.ProcessId -ne $ProcessId) {
        continue
      }
      $nameCondition = New-Object System.Windows.Automation.PropertyCondition(
        $automation::NameProperty,
        $ButtonName
      )
      $targets = $window.FindAll($tree::Descendants, $nameCondition)
      foreach ($target in $targets) {
        $mode = Invoke-NativeTarget $target
        if ($null -ne $mode) {
          Write-Output "NATIVE_CONFIRM_INVOKED:$mode"
          exit 0
        }
      }
    } catch [System.Windows.Automation.ElementNotAvailableException] {
      # The dialog or one of its descendants disappeared while being inspected.
    }
  }
  Start-Sleep -Milliseconds 200
}

Write-Error "NATIVE_CONFIRM_TIMEOUT: process=$ProcessId title=$WindowTitle button=$ButtonName"
exit 1
