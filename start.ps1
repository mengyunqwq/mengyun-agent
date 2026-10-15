<#
  梦云 Agent —— 一键启动（Windows PowerShell）
  默认打开桌面程序（原生窗口）；也可以用它执行其他子命令。

  用法：
    .\start.ps1                    打开桌面程序（默认）
    .\start.ps1 web                在浏览器里打开界面
    .\start.ps1 doctor             环境体检
    .\start.ps1 tools              列出工具
    .\start.ps1 chat               在终端里对话
    .\start.ps1 -Task "帮我重构 xxx"  一次性执行任务

  如果提示「禁止运行脚本」，请改用 start.cmd，
  或执行：powershell -ExecutionPolicy Bypass -File .\start.ps1

  注意：桌面程序是独立进程，这个窗口跑完就会自己关掉，不影响程序运行。
#>

[CmdletBinding()]
param(
  [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
  [string[]]$Args,

  [string]$Task = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Write-Info($msg) { Write-Host "  $msg" }
function Write-Ok($msg) { Write-Host "  [√] $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "  [!] $msg" -ForegroundColor Yellow }
function Write-Err($msg) { Write-Host "  [X] $msg" -ForegroundColor Red }

Write-Host ''
Write-Host '  梦云 Agent 启动中...' -ForegroundColor Cyan
Write-Info '----------------------------------------'

# ---------- 1. 检查 Node ----------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Err '没有找到 Node.js'
  Write-Host ''
  Write-Info '请先安装 Node.js 18 或更高版本：https://nodejs.org'
  Write-Host ''
  exit 1
}
$nodeVersion = (& node -v).Trim()
$major = [int]($nodeVersion.TrimStart('v').Split('.')[0])
if ($major -lt 18) {
  Write-Err "Node.js 版本过低（$nodeVersion），需要 18 或更高"
  exit 1
}
Write-Ok "Node.js $nodeVersion"

# ---------- 2. 检查配置 ----------
if (-not (Test-Path 'config.json')) {
  Write-Err '缺少 config.json，请确认文件完整'
  exit 1
}

# ---------- 3. 首次运行：生成 .env，让用户填 Key，然后继续启动 ----------
if (-not (Test-Path '.env')) {
  if (Test-Path '.env.example') {
    Copy-Item '.env.example' '.env'
    Write-Warn2 '首次运行，已生成 .env'
    Write-Host ''
    Write-Info '正在打开记事本，请填上这一行（其他都可以不管）：'
    Write-Info '   MYA_API_KEY=sk-你的key'
    Write-Host ''
    Write-Info '保存并关闭记事本后，启动会自动继续。'
    Write-Info '（暂时不填也行，程序会打开，你在界面里也能填）'
    Write-Host ''
    if (Get-Command notepad -ErrorAction SilentlyContinue) {
      Start-Process notepad -ArgumentList (Join-Path $root '.env') -Wait
    }
  }
}

# ---------- 4. 没填 Key 时提醒一下（不阻止启动）----------
if (Test-Path '.env') {
  $envText = Get-Content '.env' -Raw -ErrorAction SilentlyContinue
  if ($envText -notmatch '(?m)^\s*MYA_API_KEY=\S') {
    Write-Warn2 '.env 里还没填 MYA_API_KEY，界面会引导你配置'
    Write-Info '（如果你用的是本地 Ollama 或免鉴权网关，可以忽略）'
    Write-Host ''
  }
}

# ---------- 5. 启动 ----------
# 默认启动桌面程序；没有桌面组件时会自动退回浏览器界面。
$cliArgs = @()
if ($Task) { $cliArgs = @('run', $Task) }
elseif ($Args) { $cliArgs = $Args }
else { $cliArgs = @('desktop') }

& node bin/mya.js @cliArgs
$code = $LASTEXITCODE

if ($code -ne 0) {
  Write-Host ''
  Write-Warn2 "启动失败，代码 $code"
  Write-Info '排查建议：.\start.ps1 doctor'
  Write-Host ''
}
exit $code
