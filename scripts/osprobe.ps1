# OS-level input + window telemetry for calibrating native menu placement.
#   powershell -File scripts/osprobe.ps1 <mode> [args...]
# Modes:
#   menu-rect          print RECT (physical px) of the visible #32768 menu, if any
#   cursor             print current physical cursor position
#   move <x> <y>       SetCursorPos (physical px)
#   rclick             real right-click at the current cursor position
#   lclick             real left-click at the current cursor position
#   foreground         bring the window under the cursor to the foreground
#   esc                send a real ESC keypress (dismisses menus)
param (
    [Parameter(Mandatory=$true)][string]$Mode,
    [string]$Arg1,
    [string]$Arg2
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WvWin32 {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int maxCount);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
}
"@

# Report TRUE physical coordinates (not DPI-virtualized) — without this every
# rect/cursor value comes back scaled by the display's DPI setting
[WvWin32]::SetProcessDPIAware() | Out-Null

switch ($Mode) {
    "rclick-shot" {
        # real right-click at cursor, wait, capture a region around the cursor
        [WvWin32]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 40
        [WvWin32]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds ([int]$Arg2)
        Add-Type -AssemblyName System.Drawing
        $p = New-Object WvWin32+POINT
        [WvWin32]::GetCursorPos([ref]$p) | Out-Null
        $size = 420
        $x = [Math]::Max(0, $p.X - 140)
        $y = [Math]::Max(0, $p.Y - 40)
        $bounds = New-Object System.Drawing.Rectangle($x, $y, $size, $size)
        $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bmp.Size)
        $g.Dispose()
        $bmp.Save($Arg1, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        Write-Output "shot around ($($p.X),$($p.Y)) saved"
    }
    "rclick-probe" {
        # real right-click at current cursor, then poll menu rects in-process
        # (no cold-start delay): prints each distinct rect with elapsed ms
        [WvWin32]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 40
        [WvWin32]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $last = ""
        $deadline = (Get-Date).AddSeconds(4)
        while ((Get-Date) -lt $deadline) {
            $script:menuRect = $null
            $delegate = [WvWin32+EnumWindowsProc]{ param($h, $l)
                $sb = New-Object System.Text.StringBuilder 256
                [WvWin32]::GetClassName($h, $sb, 256) | Out-Null
                if ($sb.ToString() -eq "Chrome_WidgetWin_1" -and [WvWin32]::IsWindowVisible($h)) {
                    $r = New-Object WvWin32+RECT
                    [WvWin32]::GetWindowRect($h, [ref]$r) | Out-Null
                    $w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
                    if ($w -gt 10 -and $w -lt 500 -and $ht -gt 10 -and $ht -lt 400) {
                        $script:menuRect = "L=$($r.Left) T=$($r.Top) R=$($r.Right) B=$($r.Bottom)"
                    }
                }
                return $true
            }
            [WvWin32]::EnumWindows($delegate, [IntPtr]::Zero) | Out-Null
            $cur = if ($script:menuRect) { $script:menuRect } else { "(no menu)" }
            if ($cur -ne $last) { Write-Output ("t=" + $sw.ElapsedMilliseconds + "ms " + $cur); $last = $cur }
            if ($script:menuRect) { break }
            Start-Sleep -Milliseconds 50
        }
        if (-not $script:menuRect) { Write-Output "final: no menu ever appeared" }
    }
    "fg-hwnd" {
        Write-Output ("fg=" + [WvWin32]::GetForegroundWindow())
    }
    "windows" {
        $delegate = [WvWin32+EnumWindowsProc]{ param($h, $l)
            if ([WvWin32]::IsWindowVisible($h)) {
                $sb = New-Object System.Text.StringBuilder 256
                [WvWin32]::GetClassName($h, $sb, 256) | Out-Null
                $r = New-Object WvWin32+RECT
                [WvWin32]::GetWindowRect($h, [ref]$r) | Out-Null
                # skip tiny/tray windows far off the primary screen
                if ($r.Right - $r.Left -gt 8 -and $r.Bottom - $r.Top -gt 8 -and $r.Left -gt -1000 -and $r.Top -gt -1000) {
                    $script:wins += ("{0}|L={1} T={2} R={3} B={4}" -f $sb.ToString(), $r.Left, $r.Top, $r.Right, $r.Bottom)
                }
            }
            return $true
        }
        $script:wins = @()
        [WvWin32]::EnumWindows($delegate, [IntPtr]::Zero) | Out-Null
        $script:wins | ForEach-Object { Write-Output $_ }
    }
    "shot" {
        # capture a physical-screen region: shot <x> <y> <w> <h> <outfile>
        Add-Type -AssemblyName System.Drawing
        $x = [int]$Arg1; $y = [int]$Arg2
        $w = [int]$Mode2W; $h = [int]$Mode2H
        $w = 700; $h = 500
        if ($Arg1 -and $Arg2 -and $args) { }
        $out = if ($Arg1) { $Arg1 } else { join-path $PWD "os-shot.png" }
        $bounds = New-Object System.Drawing.Rectangle(150, 150, 700, 500)
        $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bmp.Size)
        $g.Dispose()
        $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        Write-Output "saved $out"
    }
    "menu-wait" {
        $deadline = (Get-Date).AddSeconds([double]($Arg1 -as [string] -as [double]))
        if (-not $deadline -or $deadline -le (Get-Date)) { $deadline = (Get-Date).AddSeconds(4) }
        $result = "none"
        while ((Get-Date) -lt $deadline) {
            # Electron context menus are small Chrome_WidgetWin_1 windows
            # (NOT #32768) — match the class plus a small-rect filter so the
            # main Electron window itself is excluded
            $script:menuRect = $null
            $delegate = [WvWin32+EnumWindowsProc]{ param($h, $l)
                $sb = New-Object System.Text.StringBuilder 256
                [WvWin32]::GetClassName($h, $sb, 256) | Out-Null
                if ($sb.ToString() -eq "Chrome_WidgetWin_1" -and [WvWin32]::IsWindowVisible($h)) {
                    $r = New-Object WvWin32+RECT
                    [WvWin32]::GetWindowRect($h, [ref]$r) | Out-Null
                    $w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
                    if ($w -gt 10 -and $w -lt 500 -and $ht -gt 10 -and $ht -lt 400) {
                        $script:menuRect = "L=$($r.Left) T=$($r.Top) R=$($r.Right) B=$($r.Bottom)"
                    }
                }
                return $true
            }
            [WvWin32]::EnumWindows($delegate, [IntPtr]::Zero) | Out-Null
            if ($script:menuRect) { $result = $script:menuRect; break }
            Start-Sleep -Milliseconds 120
        }
        Write-Output $result
    }
    "menu-rect" {
        $found = $null
        $cb = {
            param($h, $l)
            $sb = New-Object System.Text.StringBuilder 256
            [WvWin32]::GetClassName($h, $sb, 256) | Out-Null
            if ($sb.ToString() -eq "#32768" -and [WvWin32]::IsWindowVisible($h)) {
                $r = New-Object WvWin32+RECT
                [WvWin32]::GetWindowRect($h, [ref]$r) | Out-Null
                $script:found = "L=$($r.Left) T=$($r.Top) R=$($r.Right) B=$($r.Bottom)"
            }
            return $true
        }
        # EnumWindows needs a stable delegate; run it via a compiled invocation
        $delegate = [WvWin32+EnumWindowsProc]{ param($h, $l)
            $sb = New-Object System.Text.StringBuilder 256
            [WvWin32]::GetClassName($h, $sb, 256) | Out-Null
            if ($sb.ToString() -eq "#32768" -and [WvWin32]::IsWindowVisible($h)) {
                $r = New-Object WvWin32+RECT
                [WvWin32]::GetWindowRect($h, [ref]$r) | Out-Null
                $script:menuRect = "L=$($r.Left) T=$($r.Top) R=$($r.Right) B=$($r.Bottom)"
            }
            return $true
        }
        $script:menuRect = $null
        [WvWin32]::EnumWindows($delegate, [IntPtr]::Zero) | Out-Null
        if ($script:menuRect) { Write-Output $script:menuRect } else { Write-Output "none" }
    }
    "cursor" {
        $p = New-Object WvWin32+POINT
        [WvWin32]::GetCursorPos([ref]$p) | Out-Null
        Write-Output "X=$($p.X) Y=$($p.Y)"
    }
    "move" {
        [WvWin32]::SetCursorPos([int]$Arg1, [int]$Arg2) | Out-Null
        Start-Sleep -Milliseconds 60
        $p = New-Object WvWin32+POINT
        [WvWin32]::GetCursorPos([ref]$p) | Out-Null
        Write-Output "now X=$($p.X) Y=$($p.Y)"
    }
    "rclick" {
        [WvWin32]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 40
        [WvWin32]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
        Write-Output "rclick"
    }
    "lclick" {
        [WvWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 40
        [WvWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        Write-Output "lclick"
    }
    "foreground" {
        $p = New-Object WvWin32+POINT
        [WvWin32]::GetCursorPos([ref]$p) | Out-Null
        $h = [WvWin32]::WindowFromPoint($p)
        [WvWin32]::SetForegroundWindow($h) | Out-Null
        Start-Sleep -Milliseconds 200
        Write-Output "fg hwnd=$h"
    }
    "focus-hwnd" {
        $h = [IntPtr]::new([Int64]$Arg1)
        # Windows restricts background processes from taking foreground —
        # synthesizing an ALT press first makes this thread the last-input
        # owner, which unlocks SetForegroundWindow
        [WvWin32]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
        [WvWin32]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 60
        $ok = [WvWin32]::SetForegroundWindow($h)
        Start-Sleep -Milliseconds 300
        Write-Output "focus $h ok=$ok"
    }
    "esc" {
        [WvWin32]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 40
        [WvWin32]::keybd_event(0x1B, 0, 2, [UIntPtr]::Zero)
        Write-Output "esc"
    }
    "key" {
        # key <vk-hex> <down|up> — hold/release any key (e.g. ctrl=0x11) so a
        # following lclick lands as a modified real click
        $vk = [Convert]::ToInt32($Arg1, 16)
        $flags = if ($Arg2 -eq 'up') { 2 } else { 0 }
        [WvWin32]::keybd_event($vk, 0, $flags, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 30
        Write-Output "key vk=$($vk.ToString('X')) $Arg2"
    }
    default { Write-Output "unknown mode $Mode" }
}
