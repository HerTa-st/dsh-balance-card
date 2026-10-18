# 验收清单第 5 条：卸载插件后无残留、无报错。
#
# ## 这个脚本踩过的三个坑（都修在这里了，别再改回去）
#
# 1. **lab 必须用后台作业起，不能用 `Start-Process`。**
#    后者起的子进程不随脚本退出 —— 脚本一挂，lab 变孤儿，下次再跑就看到端口被占、
#    拿不到 token，然后空转到超时。用 `Start-Job` 起，脚本一结束（或被杀）lab 跟着走。
# 2. **删配置行用 Node，不要用 PowerShell 内联脚本。**
#    在中文与全角破折号（`──`）上正则匹配不稳，实测改两次才对。
#    `strip-plugin-config.mjs` 读 UTF-8、按标记行定位、按行号切片，行为确定。
# 3. **每个等待都要有上限。** 先前对浏览器轮询没有上限，Edge 起不来就永久挂着。
#
# 用法：pwsh -NoProfile -File verify-uninstall.ps1 [-Port 3210]
param(
  [int]$Port = 3210,
  [string]$LabHome = 'E:\deepseek工作区\HerTa\herta-lab\.dsh',
  [string]$Node = 'E:\node\node.exe'
)

$ErrorActionPreference = 'Continue'
$repo = 'E:\deepseek工作区\HerTa\dsh-balance-card'
$profileDir = Join-Path $LabHome 'profiles\herta-lab'
$pkgPath = Join-Path $profileDir 'package.json'
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
$junction = Join-Path $profileDir 'node_modules\dsh-balance-card'
$cli = 'E:\deepseek Desktop\resources\runtime\cli\bin\dsh.cmd'
$workDir = Join-Path (Split-Path $LabHome -Parent) 'ws'

$failures = 0
function Check([string]$label, [bool]$ok, [string]$detail) {
  if ($ok) { Write-Host "  OK   $label" } else { Write-Host "  FAIL $label —— $detail"; $script:failures++ }
}

function Stop-Lab {
  Get-Job -Name 'lab' -ErrorAction SilentlyContinue | Stop-Job -ErrorAction SilentlyContinue
  Get-Job -Name 'lab' -ErrorAction SilentlyContinue | Remove-Job -Force -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 30; $i++) {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($c -eq $null) { return $true }
    $c | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500
  }
  return (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) -eq $null
}

function Start-Lab {
  if (-not (Stop-Lab)) { Write-Host "  端口 $Port 腾不出来" }
  $env:DSH_HOME = $LabHome
  $script:labLog = Join-Path $env:TEMP "lab-uninstall-$([guid]::NewGuid().ToString('N').Substring(0,8)).log"
  $logPath = $script:labLog
  Start-Job -Name 'lab' -ScriptBlock {
    param($cli, $LabHome, $Port, $workDir, $logPath)
    $env:DSH_HOME = $LabHome
    & $cli --profile herta-lab --port $Port --no-open *> $logPath
  } -ArgumentList $cli, $LabHome, $Port, $workDir, $logPath | Out-Null
  for ($i = 0; $i -lt 180; $i++) {
    Start-Sleep -Milliseconds 500
    if (-not (Test-Path $logPath)) { continue }
    $t = Select-String -Path $logPath -Pattern 'token=([A-Za-z0-9_\-]+)' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($t -ne $null) { return $t.Matches[0].Groups[1].Value }
  }
  if (Test-Path $logPath) { Write-Host '  lab 日志尾部：'; Get-Content $logPath -Tail 6 | ForEach-Object { Write-Host "    $_" } }
  return $null
}

function Get-RouteStatus([string]$token) {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/balance-card/health?token=$token" -UseBasicParsing -TimeoutSec 20
    return "OK"
  } catch {
    return "ERR:$($_.Exception.Response.StatusCode.value__)"
  }
}

# ── 0. 备份 ────────────────────────────────────────────────────
Write-Host "== 0. 备份 =="
$pkgBackup = "$pkgPath.uninstall-bak"
$patchBackup = "$patchPath.uninstall-bak"
Copy-Item $pkgPath $pkgBackup -Force
Copy-Item $patchPath $patchBackup -Force

# 还原做成函数：任何退出路径都要经过它，否则脚本中途挂掉会留下拆了一半的 profile
$script:restored = $false
function Restore-Profile {
  if ($script:restored) { return }
  $script:restored = $true
  Copy-Item $pkgBackup $pkgPath -Force -ErrorAction SilentlyContinue
  Copy-Item $patchBackup $patchPath -Force -ErrorAction SilentlyContinue
  Remove-Item $pkgBackup, $patchBackup -Force -ErrorAction SilentlyContinue
  if (-not (Test-Path $junction)) {
    New-Item -ItemType Junction -Path $junction -Target $repo | Out-Null
  }
}

$env:DSH_HOME = $LabHome
$token = Start-Lab
if ($token -eq $null) {
  Write-Host '  无法获取 lab token，中止（未做任何拆除）'
  Restore-Profile
  Stop-Lab
  exit 2
}
Write-Host "  lab 已起（端口 $Port）"
Start-Sleep -Seconds 2
Check '卸载前：插件路由可达' ((Get-RouteStatus $token) -eq 'OK') (Get-RouteStatus $token)

# ── 1. 拆除 ────────────────────────────────────────────────────
Write-Host "== 1. 从 profile 拆掉插件 =="
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$pkg.dependencies.PSObject.Properties.Remove('dsh-balance-card')
$pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles | Where-Object { $_ -ne 'dsh-balance-card' })
$pkg | ConvertTo-Json -Depth 10 | Set-Content $pkgPath -Encoding utf8
& $Node (Join-Path $repo 'scripts\strip-plugin-config.mjs') $patchPath remove | ForEach-Object { Write-Host "    $_" }
Remove-Item $junction -Force -Recurse -ErrorAction SilentlyContinue

Check 'package.json 里已无 dsh-balance-card' (-not (Get-Content $pkgPath -Raw).Contains('dsh-balance-card')) '仍存在'
Check 'cordis.patch.yml 里已无 balance-card' (-not (Get-Content $patchPath -Raw).Contains('balance-card')) '仍存在'
Check '目录联接已删除' (-not (Test-Path $junction)) '仍存在'

# ── 2. 重启并验证无残留 ────────────────────────────────────────
Write-Host "== 2. 重启 lab 并验证无残留 =="
$token2 = Start-Lab
if ($token2 -eq $null) {
  Check '卸载后能重启 lab' $false '起不来'
} else {
  Start-Sleep -Seconds 2
  $res = Get-RouteStatus $token2
  Check '卸载后：插件路由已消失（404）' ($res -eq 'ERR:404') $res
  $bootLog = Get-Content $script:labLog -Raw
  Check '宿主日志里不再有 balance-card 挂载记录' (-not $bootLog.Contains('[dsh-balance-card]')) '仍出现'

  # ── 3. 页面侧 ────────────────────────────────────────────────
  Write-Host "== 3. 页面侧确认（无头浏览器，硬超时 120s） =="
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  & $Node (Join-Path $repo 'scripts\verify-absent.mjs') "http://127.0.0.1:$Port/?token=$token2" 9371 2>&1 | ForEach-Object { Write-Host "    $_" }
  $sw.Stop()
  Check '页面侧断言通过（9 条）' ($LASTEXITCODE -eq 0) "exit=$LASTEXITCODE，耗时 $([Math]::Round($sw.Elapsed.TotalSeconds,1))s"
}

# ── 4. 还原 ────────────────────────────────────────────────────
Write-Host "== 4. 还原 =="
Stop-Lab
Restore-Profile
$token3 = Start-Lab
if ($token3 -eq $null) {
  Check '还原后 lab 起得来' $false '起不来'
} else {
  Start-Sleep -Seconds 2
  $res3 = Get-RouteStatus $token3
  Check '还原后：插件路由恢复' ($res3 -eq 'OK') $res3
  Set-Content -Path 'E:\deepseek工作区\HerTa\_lab-token.txt' -Value $token3 -NoNewline
  Write-Host "  还原后 token: $token3"
}
Stop-Lab

Write-Host ""
if ($failures -eq 0) { Write-Host '卸载验收：全部通过' } else { Write-Host "卸载验收：有 $failures 条失败" }
exit $failures
