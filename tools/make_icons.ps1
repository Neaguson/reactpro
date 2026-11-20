# Gera os ícones PNG do app a partir de assets/logo-mk.svg usando o Edge em modo headless.
# O Edge não aceita janelas muito pequenas, então tudo é renderizado em 512px e reduzido depois.
# Uso: pwsh tools/make_icons.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge não encontrado.' }
$page = ([Uri](Join-Path $PSScriptRoot 'icon.html')).AbsoluteUri
$userDir = Join-Path $env:TEMP 'reactpro-icon-edge'

function Render([string]$out, [int]$h) {
  if (Test-Path $out) { Remove-Item $out }
  & $edge --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$userDir" `
    --force-device-scale-factor=1 --virtual-time-budget=3000 --window-size="512,512" `
    --screenshot="$out" "$page`?h=$h" 2>$null | Out-Null
  if (-not (Test-Path $out)) { throw "Falhou: $out" }
}

function Resize([string]$src, [string]$dst, [int]$size) {
  $img = [System.Drawing.Image]::FromFile($src)
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($img, 0, 0, $size, $size)
  $bmp.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose(); $img.Dispose()
}

$icons = Join-Path $root 'icons'
Render (Join-Path $icons 'icon-512.png') 58
Render (Join-Path $icons 'maskable-512.png') 46   # área segura para ícones recortados (Android)
Resize (Join-Path $icons 'icon-512.png') (Join-Path $icons 'icon-192.png') 192
Resize (Join-Path $icons 'icon-512.png') (Join-Path $icons 'icon-180.png') 180
Get-ChildItem $icons -Filter *.png | ForEach-Object { "ok $($_.Name) ($($_.Length) bytes)" }
