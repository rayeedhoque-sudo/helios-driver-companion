# Generates the Helios Driver Companion app icon: an amber sun disc with short
# rays on a near-black rounded-square background (theme: Helios = sun; accent
# #ffb020 on #0a0e15 — matches the app's dark UI). Kept simple/bold so it still
# reads at 16px. Pure System.Drawing (Windows PowerShell 5.1) — no downloads.
#
# System.Drawing's Icon class can only READ multi-size .ico files, not write
# them, so this hand-assembles the ICO container: a 6-byte ICONDIR header + one
# 16-byte ICONDIRENTRY per size, followed by the concatenated image bytes.
# Vista+ ico readers accept PNG-compressed entries directly (no BMP/AND-mask
# needed), so each size is just a rendered PNG dropped in as-is.
#
# Usage: powershell -ExecutionPolicy Bypass -File tools\make-icon.ps1
# Regenerate any time the design needs a tweak.

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$assetsDir = Join-Path $root 'assets'
New-Item -ItemType Directory -Force -Path $assetsDir | Out-Null

$bgColor = [System.Drawing.Color]::FromArgb(255, 0x0a, 0x0e, 0x15)
$sunColor = [System.Drawing.Color]::FromArgb(255, 0xff, 0xb0, 0x20)

function New-IconPng {
    param([int]$Size)

    $bmp = New-Object System.Drawing.Bitmap $Size, $Size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    # Rounded-square background.
    $r = [Math]::Max(2, [int]($Size * 0.22))
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc($Size - $d, 0, $d, $d, 270, 90)
    $path.AddArc($Size - $d, $Size - $d, $d, $d, 0, 90)
    $path.AddArc(0, $Size - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    $bgBrush = New-Object System.Drawing.SolidBrush $bgColor
    $g.FillPath($bgBrush, $path)

    $cx = $Size / 2.0
    $cy = $Size / 2.0
    $sunBrush = New-Object System.Drawing.SolidBrush $sunColor

    # Short triangular rays (8, 45 deg apart) — drawn under the disc so the
    # disc's clean circular edge reads first at small sizes.
    $rayInner = $Size * 0.30
    $rayOuter = $Size * 0.46
    $rayHalfWidth = [Math]::Max(0.8, $Size * 0.045)
    for ($i = 0; $i -lt 8; $i++) {
        $ang = $i * 45.0 * [Math]::PI / 180.0
        $dx = [Math]::Cos($ang)
        $dy = [Math]::Sin($ang)
        # perpendicular unit vector for ray width
        $px = -$dy
        $py = $dx
        $baseX = $cx + $dx * $rayInner
        $baseY = $cy + $dy * $rayInner
        $tipX = $cx + $dx * $rayOuter
        $tipY = $cy + $dy * $rayOuter
        $pts = @(
            New-Object System.Drawing.PointF ($baseX + $px * $rayHalfWidth), ($baseY + $py * $rayHalfWidth)
            New-Object System.Drawing.PointF ($baseX - $px * $rayHalfWidth), ($baseY - $py * $rayHalfWidth)
            New-Object System.Drawing.PointF $tipX, $tipY
        )
        $g.FillPolygon($sunBrush, $pts)
    }

    # Sun disc.
    $discR = $Size * 0.28
    $g.FillEllipse($sunBrush, $cx - $discR, $cy - $discR, $discR * 2, $discR * 2)

    $g.Dispose()

    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $ms.ToArray()
    $ms.Dispose()
    $bmp.Dispose()
    # The leading comma keeps this a single Byte[] output — PowerShell
    # otherwise unrolls arrays element-by-element across the pipeline/return.
    return ,$bytes
}

$sizes = 256, 64, 48, 32, 16
$pngs = @{}
foreach ($s in $sizes) { $pngs[$s] = New-IconPng -Size $s }

# Save the 256px PNG separately (spec'd asset, also handy for docs/README use).
[System.IO.File]::WriteAllBytes((Join-Path $assetsDir 'icon-256.png'), $pngs[256])

# --- hand-assemble the multi-size .ico container ---------------------------
$entryCount = $sizes.Count
$headerSize = 6
$entrySize = 16
$offset = $headerSize + $entrySize * $entryCount

$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $ms

# ICONDIR: reserved(u16)=0, type(u16)=1 (icon), count(u16)
$bw.Write([UInt16]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]$entryCount)

foreach ($s in $sizes) {
    $png = $pngs[$s]
    $wByte = if ($s -ge 256) { 0 } else { $s }   # 0 means 256 in ICONDIRENTRY
    $hByte = $wByte
    $bw.Write([byte]$wByte)      # width
    $bw.Write([byte]$hByte)      # height
    $bw.Write([byte]0)           # color count (0 = no palette)
    $bw.Write([byte]0)           # reserved
    $bw.Write([UInt16]1)         # color planes
    $bw.Write([UInt16]32)        # bits per pixel
    $bw.Write([UInt32]$png.Length)
    $bw.Write([UInt32]$offset)
    $offset += $png.Length
}
foreach ($s in $sizes) {
    $bw.Write($pngs[$s])
}

$bw.Flush()
$icoBytes = $ms.ToArray()
$bw.Dispose()
$ms.Dispose()

$icoPath = Join-Path $assetsDir 'icon.ico'
[System.IO.File]::WriteAllBytes($icoPath, $icoBytes)

# Validate: load it back with System.Drawing.Icon.
$check = [System.Drawing.Icon]::new($icoPath)
Write-Output "icon.ico written: $icoPath ($($icoBytes.Length) bytes, sizes: $($sizes -join ', ')); System.Drawing.Icon reload OK, reported size=$($check.Width)x$($check.Height)"
$check.Dispose()
