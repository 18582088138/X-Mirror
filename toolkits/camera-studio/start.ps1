$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    if (-not (Test-Path 'node_modules')) {
        & npm ci
        if ($LASTEXITCODE -ne 0) { throw '依赖安装失败' }
    }
    & node scripts/prepare-materials.mjs
    if ($LASTEXITCODE -ne 0) { throw '素材准备失败，请检查网络或补齐本地图片' }
    & node server.mjs
} finally { Pop-Location }
