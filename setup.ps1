# setup.ps1 — Finger Pinch Symphony 本地依赖下载
# ===============================================
# 运行此脚本一次，自动下载 MediaPipe Tasks Vision WASM 文件到当前目录。
# 之后双击 index.html 即可离线运行。

$ErrorActionPreference = "Stop"
$outDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $outDir

$version = "0.10.18"
$pkg = "@mediapipe/tasks-vision"
$baseUrl = "https://registry.npmmirror.com/$pkg/$version/files/wasm"

$files = @(
    "vision_wasm_internal.js",
    "vision_wasm_internal.wasm",
    "vision_wasm_nosimd_internal.js",
    "vision_wasm_nosimd_internal.wasm"
)

Write-Host "Downloading MediaPipe Tasks Vision v$version from npmmirror.com..." -ForegroundColor Cyan

foreach ($f in $files) {
    $url = "$baseUrl/$f"
    $dest = Join-Path $outDir $f
    if (Test-Path $dest) {
        Write-Host "  SKIP $f (already exists)" -ForegroundColor Gray
        continue
    }
    Write-Host "  GET $f ..." -NoNewline
    try {
        Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
        $size = (Get-Item $dest).Length
        Write-Host " OK ($size bytes)" -ForegroundColor Green
    } catch {
        Write-Host " FAILED" -ForegroundColor Red
        Write-Host "  Error: $_" -ForegroundColor Red
        Write-Host "  Please download manually: $url" -ForegroundColor Yellow
    }
}

# Also try downloading model file
$modelUrl = "$baseUrl/hand_landmarker.task"
$modelDest = Join-Path $outDir "hand_landmarker.task"
if (-not (Test-Path $modelDest)) {
    Write-Host "  GET hand_landmarker.task ..." -NoNewline
    try {
        Invoke-WebRequest -Uri $modelUrl -OutFile $modelDest -UseBasicParsing
        Write-Host " OK" -ForegroundColor Green
    } catch {
        Write-Host " NOT FOUND (model file may be at different path)" -ForegroundColor Yellow
        Write-Host "  Trying Google CDN..." -NoNewline
        try {
            Invoke-WebRequest -Uri "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task" -OutFile $modelDest -UseBasicParsing
            Write-Host " OK (via Google)" -ForegroundColor Green
        } catch {
            Write-Host " FAILED" -ForegroundColor Red
            Write-Host "  Model file not downloaded. The game will show an error message."
            Write-Host "  You can manually download it and place in this directory."
        }
    }
}

Write-Host ""
Write-Host "Done! Now double-click index.html to play." -ForegroundColor Green
Write-Host "If starting still fails, ensure ALL files listed above are in this directory." -ForegroundColor Yellow
