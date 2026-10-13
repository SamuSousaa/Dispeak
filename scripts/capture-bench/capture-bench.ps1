# Measures what a native capture pipeline delivers while a game holds the graphics card:
# the screen is captured and encoded by the card itself (ffmpeg, no browser involved) and the
# spacing between the frames that come out is reported. Run it through capture-bench.bat.
#
# Windows PowerShell 5.1 reads a script without a BOM as ANSI, so every string here is ASCII.
param(
  [int]$Seconds = 20,
  [int]$Countdown = 12,
  [int]$Monitor = 0,
  [int]$Bitrate = 8000,
  # Folder holding ffmpeg.exe and ffprobe.exe; downloaded when empty.
  [string]$FfmpegDir = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$invariant = [cultureinfo]::InvariantCulture
$work = Join-Path $env:TEMP 'dispeaker-capture-bench'
New-Item -ItemType Directory -Force $work | Out-Null

function Get-Ffmpeg {
  if ($FfmpegDir) { return $FfmpegDir }
  $existing = Get-ChildItem -Path $work -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($existing) { return $existing.DirectoryName }
  Write-Host 'Baixando o ffmpeg (190 MB, so na primeira vez)...'
  $zip = Join-Path $work 'ffmpeg.zip'
  $url = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-win64-gpl-9.0.zip'
  & curl.exe -sSL --fail -o $zip $url
  if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel baixar o ffmpeg.' }
  Expand-Archive -Path $zip -DestinationPath $work -Force
  Remove-Item $zip
  return (Get-ChildItem -Path $work -Recurse -Filter ffmpeg.exe | Select-Object -First 1).DirectoryName
}

function Get-Gpu3dLoad {
  $engines = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like '*engtype_3D' }
  if (-not $engines) { return $null }
  return ($engines | Measure-Object -Property UtilizationPercentage -Sum).Sum
}

function Format-Number([double]$value) { return $value.ToString('0.0', $invariant) }

function Get-Percentile([double[]]$sorted, [double]$p) {
  if ($sorted.Count -eq 0) { return 0 }
  return $sorted[[Math]::Min($sorted.Count - 1, [int][Math]::Floor($sorted.Count * $p))]
}

# One recording: returns the lines of its report.
function Invoke-Run([string]$label, [string]$filter, [string]$encoder, [string]$extension) {
  $file = Join-Path $work "$label.$extension"
  $log = Join-Path $work "$label.log"
  $arguments = "-hide_banner -y -filter_complex $filter -fps_mode passthrough $encoder " +
    "-t $Seconds `"$file`""
  $process = Start-Process -FilePath (Join-Path $bin 'ffmpeg.exe') -ArgumentList $arguments `
    -NoNewWindow -PassThru -RedirectStandardError $log
  $loads = @()
  # A screen where nothing moves yields no frames and the recording would never reach its end.
  $deadline = (Get-Date).AddSeconds($Seconds + 20)
  while (-not $process.HasExited) {
    if ((Get-Date) -gt $deadline) { Stop-Process -Id $process.Id -Force -Confirm:$false; break }
    $load = Get-Gpu3dLoad
    if ($null -ne $load) { $loads += $load }
    Start-Sleep -Milliseconds 500
  }

  $lines = @("== $label")
  $times = @()
  if (Test-Path $file) {
    $times = & (Join-Path $bin 'ffprobe.exe') -v error -select_streams v:0 `
      -show_entries packet=pts_time -of csv=p=0 $file |
      Where-Object { $_ -match '^[0-9.]+' } |
      ForEach-Object { [double]::Parse(($_ -replace ',', ''), $invariant) } | Sort-Object
  }
  if ($times.Count -lt 2) {
    $lines += '  FALHOU: nenhum quadro gravado. Fim do registro do ffmpeg:'
    $lines += (Get-Content $log -Tail 4 | ForEach-Object { "    $_" })
    return $lines
  }

  $gaps = @()
  for ($i = 1; $i -lt $times.Count; $i++) { $gaps += ($times[$i] - $times[$i - 1]) * 1000 }
  $sorted = [double[]]($gaps | Sort-Object)
  $duration = $times[$times.Count - 1] - $times[0]
  $megabits = (Get-Item $file).Length * 8 / $duration / 1000000
  $lines += "  quadros por segundo: $(Format-Number ($times.Count / $duration))   " +
    "taxa: $(Format-Number $megabits) Mbps"
  $lines += "  intervalo entre quadros (ms): metade ate $(Format-Number (Get-Percentile $sorted 0.5))  " +
    "95% ate $(Format-Number (Get-Percentile $sorted 0.95))  " +
    "99% ate $(Format-Number (Get-Percentile $sorted 0.99))  " +
    "maior $(Format-Number $sorted[$sorted.Count - 1])"
  $lines += "  intervalos acima de 25 ms: $(@($gaps | Where-Object { $_ -gt 25 }).Count)   " +
    "acima de 50 ms: $(@($gaps | Where-Object { $_ -gt 50 }).Count)   " +
    "acima de 100 ms: $(@($gaps | Where-Object { $_ -gt 100 }).Count)   de $($gaps.Count)"
  if ($loads.Count -gt 0) {
    $stats = $loads | Measure-Object -Average -Maximum
    $lines += "  uso 3D da placa: media $(Format-Number $stats.Average)%  maximo $(Format-Number $stats.Maximum)%"
  }
  $lines += "  video: $file"
  return $lines
}

$bin = Get-Ffmpeg
$cards = @(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name })
$cardNames = $cards -join ' + '
$kbps = "${Bitrate}k"
# The screen changes or it does not: only fresh frames are emitted, so a count below 60 means
# the game (or the capture) did not deliver more.
$capture = "ddagrab=output_idx=${Monitor}:framerate=60:dup_frames=0"

$runs = @()
if ($cardNames -match 'NVIDIA') {
  $runs += , @('h264-direto', $capture,
    "-c:v h264_nvenc -preset p4 -tune ll -rc cbr -b:v $kbps -maxrate $kbps -g 120 -bf 0", 'mkv')
  $runs += , @('av1-direto', $capture,
    "-c:v av1_nvenc -preset p4 -tune ll -rc cbr -b:v $kbps -maxrate $kbps -g 120", 'mkv')
} elseif ($cardNames -match 'AMD|Radeon') {
  # AMD's H.264 encoder refuses the captured surface as it is and ffmpeg's converters do not
  # start on these cards, so H.264 goes through system memory here. AV1 takes it directly.
  $runs += , @('av1-direto', $capture,
    "-c:v av1_amf -usage lowlatency -quality speed -rc cbr -b:v $kbps -maxrate $kbps -g 120", 'mkv')
  $runs += , @('h264-com-copia', "$capture,hwdownload,format=bgra",
    "-c:v h264_amf -usage lowlatency -quality speed -rc cbr -b:v $kbps -maxrate $kbps -g 120 -bf 0", 'mkv')
} else {
  $runs += , @('h264-intel', "$capture,hwmap=derive_device=qsv,format=qsv",
    "-c:v h264_qsv -preset veryfast -b:v $kbps -maxrate $kbps -g 120 -bf 0", 'mkv')
}

Write-Host ''
Write-Host "Placa: $cardNames"
Write-Host "Abra o jogo no monitor principal e fique JOGANDO. Sao $($runs.Count) gravacoes de $Seconds s."
for ($i = $Countdown; $i -gt 0; $i--) {
  Write-Host "`rComeca em $i s... " -NoNewline
  Start-Sleep -Seconds 1
}
Write-Host "`rGravando. Volte para ca quando ouvir o bipe."

$report = @("Dispeaker capture-bench  $(Get-Date -Format 'yyyy-MM-dd HH:mm')", "placa: $cardNames")
$idle = Get-Gpu3dLoad
if ($null -ne $idle) { $report += "uso 3D da placa antes de gravar: $(Format-Number $idle)%" }
foreach ($run in $runs) { $report += Invoke-Run $run[0] $run[1] $run[2] $run[3] }

[console]::Beep(880, 400)
$resultFile = Join-Path $work 'resultado.txt'
$report | Set-Content -Path $resultFile -Encoding utf8
$report | Set-Clipboard
Write-Host ''
$report | ForEach-Object { Write-Host $_ }
Write-Host ''
Write-Host "Resultado copiado (Ctrl+V para colar) e salvo em $resultFile"
