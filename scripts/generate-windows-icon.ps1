Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$iconOutput = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\assets\icon.ico'))
$assetRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\assets')).TrimEnd('\')
if (-not $iconOutput.StartsWith($assetRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'UNSAFE_ICON_OUTPUT'
}

function New-StudyIconPng {
  param([Parameter(Mandatory = $true)][int]$Size)

  $bitmap = [System.Drawing.Bitmap]::new(
    $Size,
    $Size,
    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
  )
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $backgroundPath = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $bookPath = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $outlinePath = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $backgroundBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 23, 36, 59))
  $pageBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 247, 249, 252))
  $accentPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 96, 165, 250), 14)
  $textPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 23, 36, 59), 10)

  try {
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.ScaleTransform($Size / 256.0, $Size / 256.0)

    $backgroundPath.AddArc(0, 0, 104, 104, 180, 90)
    $backgroundPath.AddArc(152, 0, 104, 104, 270, 90)
    $backgroundPath.AddArc(152, 152, 104, 104, 0, 90)
    $backgroundPath.AddArc(0, 152, 104, 104, 90, 90)
    $backgroundPath.CloseFigure()
    $graphics.FillPath($backgroundBrush, $backgroundPath)

    $bookPath.StartFigure()
    $bookPath.AddLine(64, 55, 160, 55)
    $bookPath.AddBezier(160, 55, 178, 55, 192, 69, 192, 87)
    $bookPath.AddLine(192, 87, 192, 201)
    $bookPath.AddLine(192, 201, 96, 201)
    $bookPath.AddBezier(96, 201, 78, 201, 64, 187, 64, 169)
    $bookPath.CloseFigure()
    $graphics.FillPath($pageBrush, $bookPath)

    $accentPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $accentPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $accentPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $outlinePath.StartFigure()
    $outlinePath.AddLine(96, 55, 192, 55)
    $outlinePath.AddLine(192, 55, 192, 201)
    $outlinePath.AddLine(192, 201, 96, 201)
    $outlinePath.AddBezier(96, 201, 78, 201, 64, 187, 64, 169)
    $outlinePath.AddBezier(64, 169, 64, 151, 78, 137, 96, 137)
    $outlinePath.AddLine(96, 137, 168, 137)
    $graphics.DrawPath($accentPen, $outlinePath)

    $textPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $textPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $graphics.DrawLine($textPen, 112, 92, 160, 92)
    $graphics.DrawLine($textPen, 112, 119, 160, 119)

    $stream = [System.IO.MemoryStream]::new()
    try {
      $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
      return $stream.ToArray()
    }
    finally {
      $stream.Dispose()
    }
  }
  finally {
    $textPen.Dispose()
    $accentPen.Dispose()
    $pageBrush.Dispose()
    $backgroundBrush.Dispose()
    $outlinePath.Dispose()
    $bookPath.Dispose()
    $backgroundPath.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

$iconFrames = @(16, 24, 32, 48, 64, 128, 256) | ForEach-Object {
  [PSCustomObject]@{
    Size = $_
    Bytes = New-StudyIconPng -Size $_
  }
}

$iconStream = [System.IO.MemoryStream]::new()
$iconWriter = [System.IO.BinaryWriter]::new($iconStream)
try {
  $iconWriter.Write([uint16]0)
  $iconWriter.Write([uint16]1)
  $iconWriter.Write([uint16]$iconFrames.Count)
  $iconOffset = 6 + (16 * $iconFrames.Count)
  foreach ($iconFrame in $iconFrames) {
    $iconWriter.Write([byte]$(if ($iconFrame.Size -eq 256) { 0 } else { $iconFrame.Size }))
    $iconWriter.Write([byte]$(if ($iconFrame.Size -eq 256) { 0 } else { $iconFrame.Size }))
    $iconWriter.Write([byte]0)
    $iconWriter.Write([byte]0)
    $iconWriter.Write([uint16]1)
    $iconWriter.Write([uint16]32)
    $iconWriter.Write([uint32]$iconFrame.Bytes.Length)
    $iconWriter.Write([uint32]$iconOffset)
    $iconOffset += $iconFrame.Bytes.Length
  }
  foreach ($iconFrame in $iconFrames) {
    $iconWriter.Write([byte[]]$iconFrame.Bytes)
  }
  $iconWriter.Flush()
  [System.IO.File]::WriteAllBytes($iconOutput, $iconStream.ToArray())
}
finally {
  $iconWriter.Dispose()
  $iconStream.Dispose()
}

Write-Output $iconOutput
