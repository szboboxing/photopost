# 一键发布到 Cloudflare Pages（项目 photopost）
# 用法：.\deploy.ps1              只发布静态站点 + Pages Functions
#       .\deploy.ps1 -WithWorker  顺带更新媒体 Worker（改了 media-worker 代码才需要）
# 说明：只上传 index.html、admin.html、assets/、functions/、styles.json（若有），
#       不会把本脚本或其他本地文件传上去。

param([switch]$WithWorker)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ('photopost-pages-' + [guid]::NewGuid().ToString('N'))

New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item (Join-Path $root 'index.html') $stage
Copy-Item (Join-Path $root 'admin.html') $stage
Copy-Item (Join-Path $root 'assets') $stage -Recurse
Copy-Item (Join-Path $root 'functions') $stage -Recurse
if (Test-Path (Join-Path $root 'styles.json')) { Copy-Item (Join-Path $root 'styles.json') $stage }

Write-Host ('发布目录：' + $stage) -ForegroundColor Cyan

# 调用 wrangler：没有 .git 时 wrangler 会打印 git 警告到 stderr，
# 在 $ErrorActionPreference='Stop' 下会被误判为失败，所以这里只按退出码判断
function Invoke-Wrangler {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$WArgs)
  $ErrorActionPreference = 'Continue'
  $lines = & wrangler @WArgs 2>&1
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  # 过滤掉没有 .git 时 wrangler 产生的 git 噪声（不影响发布结果）
  $noise = 'could not open directory|fatal: ambiguous argument|Use .{1,3}--.{1,3} to separate|git <command>|CategoryInfo|FullyQualifiedErrorId|所在位置|^\s*\+ '
  foreach ($l in $lines) {
    $s = [string]$l
    if ($s -match $noise) { continue }
    Write-Host $s
  }
  return $code
}

# 1) 媒体存储 Worker（R2 绑定）：只有改了 media-worker 代码时才加参数 -WithWorker
$workerDir = Join-Path $root 'media-worker'
if ($WithWorker -and (Test-Path $workerDir)) {
  Write-Host '更新媒体存储 Worker（photopost-media）…' -ForegroundColor Cyan
  Push-Location $workerDir
  $code = Invoke-Wrangler deploy
  Pop-Location
  if ($code -ne 0) { Write-Host 'Worker 更新失败（可忽略：不影响静态页面发布）' -ForegroundColor Yellow }
}

# 2) 静态站点 + Pages Functions
$code = Invoke-Wrangler pages deploy $stage --project-name photopost --branch main --commit-dirty=true
if ($code -ne 0) { throw ('Pages 发布失败（退出码 ' + $code + '）') }

Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
Write-Host '完成：https://photopost.pages.dev' -ForegroundColor Green
