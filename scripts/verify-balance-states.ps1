# 逐条验证余额的四种失败态：每次都改 lab 配置里的 balanceUrl，等 live reload，再打插件路由。
# 每次检查前都按 mtime 删掉备份（改前先备份，脚本结束再还原）。
$ErrorActionPreference = 'Continue'
$patch = 'E:\deepseek工作区\HerTa\herta-lab\.dsh\profiles\herta-lab\cordis.patch.yml'
$token = $args[0]
$snapshot = "http://127.0.0.1:3210/balance-card/snapshot?force=1&token=$token"

if ($token -eq $null -or $token -eq '') { throw '用法: verify-balance-states.ps1 <token>' }

$original = Get-Content $patch -Raw
$original | Set-Content "$patch.bak" -Encoding utf8

function Set-BalanceUrl([string]$url) {
  $content = Get-Content $patch -Raw
  $content = $content -replace 'balanceUrl: .*', "balanceUrl: $url"
  Set-Content -Path $patch -Value $content -Encoding utf8 -NoNewline
  Start-Sleep -Seconds 8
}

function Get-State([string]$label) {
  try {
    $r = Invoke-WebRequest -Uri $snapshot -UseBasicParsing -TimeoutSec 40
    $j = $r.Content | ConvertFrom-Json
    $b = $j.balance
    $extra = if ($b.status -eq 'ready') { " total=$($b.balance.total) granted=$($b.balance.granted) toppedUp=$($b.balance.toppedUp)" } else { " detail=$($b.detail) httpStatus=$($b.httpStatus)" }
    "  [$label] status=$($b.status)$extra"
  } catch {
    "  [$label] 请求失败：$($_.Exception.Message)"
  }
}

Write-Host '余额失败态逐条验证'
Set-BalanceUrl 'http://127.0.0.1:8791/401'
Get-State '密钥无效（401）'

Set-BalanceUrl 'http://127.0.0.1:8791/503'
Get-State '服务过载（503）'

Set-BalanceUrl 'http://127.0.0.1:8791/garbage'
Get-State '响应形状不符（200 但没 balance_infos）'

Set-BalanceUrl 'http://127.0.0.1:8791/hang'
Get-State '不回应（超时）'

# 指向一个**确实没有监听**的端口：这才是真的「连接被拒」。
# （早先指向假服务器的未知路径，而它对未知路径也回 404，测出来的是 404 不是拒绝 —— 测试自己退化了。）
Set-BalanceUrl 'http://127.0.0.1:8799/nothing-here'
Get-State '端口无人监听（连接被拒）'

# 还原
$original | Set-Content $patch -Encoding utf8 -NoNewline
Remove-Item "$patch.bak" -Force
Start-Sleep -Seconds 8
Write-Host '配置已还原为 /ok'
Get-State '还原后'
