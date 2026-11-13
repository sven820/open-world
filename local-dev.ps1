<#
  Local dev runner for open-world.
  Double-click start.bat / stop.bat for one-click start / stop.

  There are two processes covering three parts:
    admin/server.js  -> admin backend (/api) + admin UI (public/) on port 8787
    vite             -> walkstreet game on port 5173
  Admin UI is served by the backend, so it needs no separate process.
#>
param(
    [ValidateSet('start', 'stop', 'status')]
    [string]$Action = 'start',
    [switch]$NoBrowser,
    [switch]$Visible,
    [switch]$Install
)

$ErrorActionPreference = 'Stop'

$Root      = $PSScriptRoot
$AdminDir  = Join-Path $Root 'admin'
$GameDir   = Join-Path $Root 'walkstreet'
$AdminPort = 8787
$GamePort  = 5173
$AdminBase = "http://127.0.0.1:$AdminPort"
$GameBase  = "http://127.0.0.1:$GamePort"
$AdminUrl  = "$AdminBase/"
$GameUrl   = "$GameBase/?admin=" + [uri]::EscapeDataString($AdminBase)

$StateDir  = Join-Path $env:TEMP 'open-world-dev'
$StateFile = Join-Path $StateDir 'pids.json'
$Logs      = @{
    adminOut = Join-Path $StateDir 'admin.out.log'
    adminErr = Join-Path $StateDir 'admin.err.log'
    gameOut  = Join-Path $StateDir 'walkstreet.out.log'
    gameErr  = Join-Path $StateDir 'walkstreet.err.log'
}

function Ensure-StateDir {
    if (-not (Test-Path $StateDir)) {
        New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
    }
}

function Get-PortOwners([int]$Port) {
    $ids = @()
    try {
        $ids = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
                 Select-Object -ExpandProperty OwningProcess -Unique)
    } catch {
        $pattern = '[:.]' + $Port + '\s+.*LISTENING'
        foreach ($line in (netstat -ano -p tcp)) {
            if ($line -match $pattern) {
                $parts = @(($line -split '\s+') | Where-Object { $_ -ne '' })
                if ($parts.Length -ge 5) { $ids += [int]$parts[-1] }
            }
        }
    }
    return @($ids | Where-Object { $_ -gt 0 } | Select-Object -Unique)
}

function Get-ProcInfo([int]$ProcessId) {
    Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
}

# Only kill node.exe processes whose command line belongs to this project.
function Test-ServiceProc([int]$ProcessId, [string]$Kind) {
    $p = Get-ProcInfo $ProcessId
    if ($null -eq $p -or $p.Name -ine 'node.exe') { return $false }
    $cl = [string]$p.CommandLine
    if ($Kind -eq 'admin') { return ($cl -match 'server\.js') }
    return ($cl -match 'vite')
}

function Test-Http([string]$Url) {
    try {
        $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
        return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500)
    } catch {
        return $false
    }
}

function Read-State {
    if (Test-Path $StateFile) {
        try { return (Get-Content -Path $StateFile -Raw | ConvertFrom-Json) } catch { return $null }
    }
    return $null
}

function Save-State([int]$AdminPid, [int]$GamePid) {
    Ensure-StateDir
    $obj = [ordered]@{
        admin      = $AdminPid
        walkstreet = $GamePid
        time       = (Get-Date).ToString('o')
    }
    $obj | ConvertTo-Json | Set-Content -Path $StateFile -Encoding ASCII -Force
}

function Start-Node([string]$WorkDir, [string[]]$NodeArgs, [string]$OutLog, [string]$ErrLog) {
    Ensure-StateDir
    $nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
    $sp = @{
        FilePath         = $nodeExe
        WorkingDirectory = $WorkDir
        ArgumentList     = $NodeArgs
        PassThru         = $true
        ErrorAction      = 'Stop'
    }
    if ($Visible) {
        $sp['WindowStyle'] = 'Normal'
    } else {
        $sp['WindowStyle']             = 'Hidden'
        $sp['RedirectStandardOutput']  = $OutLog
        $sp['RedirectStandardError']   = $ErrLog
    }
    return (Start-Process @sp).Id
}

function Wait-Ready([string]$Url, [int]$ProcId, [int]$TimeoutSec) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-Http $Url) { return $true }
        if (-not (Get-Process -Id $ProcId -ErrorAction SilentlyContinue)) { return $false }
        Start-Sleep -Milliseconds 400
    }
    return $false
}

function Invoke-Start {
    Write-Host ''
    Write-Host '== open-world local dev / start ==' -ForegroundColor Cyan

    $adminEntry = Join-Path $AdminDir 'server.js'
    if (-not (Test-Path $adminEntry)) { throw "Not found: $adminEntry" }
    if (-not (Test-Path (Join-Path $GameDir 'package.json'))) { throw "Not found: $GameDir\package.json" }

    $nodeExe = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeExe) { throw 'Node.js not found in PATH. Install Node.js 18+ first.' }
    $ver = & $nodeExe.Source --version
    $major = [int](([string]$ver).TrimStart('v').Split('.')[0])
    if ($major -lt 18) { throw "Node.js 18+ required, found $ver." }

    $viteCli = Join-Path $GameDir 'node_modules\vite\bin\vite.js'
    if ($Install -or -not (Test-Path $viteCli)) {
        if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'npm.cmd not found in PATH.' }
        Write-Host '[setup] installing walkstreet dependencies (npm ci) ...'
        Push-Location $GameDir
        try {
            & cmd.exe /c 'npm ci'
            if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit $LASTEXITCODE)." }
        } finally {
            Pop-Location
        }
        if (-not (Test-Path $viteCli)) { throw "vite cli is still missing: $viteCli" }
    }

    Ensure-StateDir
    $adminPid = 0
    $gamePid  = 0

    # 1) admin backend + admin UI (one process, port 8787)
    $owners = @(Get-PortOwners $AdminPort)
    $mine   = @($owners | Where-Object { Test-ServiceProc $_ 'admin' })
    if ($mine.Count -gt 0) {
        $adminPid = [int]$mine[0]
        Write-Host "[1/2] admin backend + admin UI already running (PID $adminPid) -> $AdminUrl"
    } elseif ($owners.Count -gt 0) {
        throw "Port $AdminPort is held by another process (PID $($owners -join ', ')). Free it first."
    } else {
        Write-Host '[1/2] starting admin/server.js (backend + admin UI) ...'
        $adminPid = Start-Node $AdminDir @('server.js') $Logs.adminOut $Logs.adminErr
        if (-not (Wait-Ready "$AdminBase/api/health" $adminPid 40)) {
            throw "admin/server.js did not become ready on $AdminPort. Log: $($Logs.adminErr)"
        }
        Write-Host "      ready: $AdminUrl (PID $adminPid)"
    }

    # 2) walkstreet vite dev server (port 5173, fixed so admin "open game" works)
    $owners = @(Get-PortOwners $GamePort)
    $mine   = @($owners | Where-Object { Test-ServiceProc $_ 'game' })
    if ($mine.Count -gt 0) {
        $gamePid = [int]$mine[0]
        Write-Host "[2/2] walkstreet vite already running (PID $gamePid) -> $GameBase/"
    } elseif ($owners.Count -gt 0) {
        throw "Port $GamePort is held by another process (PID $($owners -join ', ')). Free it first."
    } else {
        Write-Host '[2/2] starting walkstreet vite ...'
        $quoted   = '"{0}"' -f $viteCli
        $viteArgs = @($quoted, '--host', '127.0.0.1', '--port', "$GamePort", '--strictPort')
        $gamePid  = Start-Node $GameDir $viteArgs $Logs.gameOut $Logs.gameErr
        if (-not (Wait-Ready "$GameBase/" $gamePid 60)) {
            throw "vite did not become ready on $GamePort. Log: $($Logs.gameErr)"
        }
        Write-Host "      ready: $GameBase/ (PID $gamePid)"
    }

    Save-State $adminPid $gamePid

    Write-Host ''
    Write-Host 'All services up:' -ForegroundColor Green
    Write-Host "  admin backend  : $AdminBase/api/health"
    Write-Host "  admin UI       : $AdminUrl   (served by admin/server.js)"
    Write-Host "  walkstreet     : $GameUrl"
    if (-not $Visible) { Write-Host "  logs           : $StateDir" }
    Write-Host '  stop           : stop.bat'
    Write-Host ''

    if (-not $NoBrowser) {
        Start-Process $AdminUrl
        Start-Process $GameUrl
    }
}

function Invoke-Stop {
    Write-Host ''
    Write-Host '== open-world local dev / stop ==' -ForegroundColor Cyan

    $ids = @()
    $state = Read-State
    if ($state) {
        foreach ($v in @($state.admin, $state.walkstreet)) {
            if ($v) { $ids += [int]$v }
        }
    }
    foreach ($port in @($AdminPort, $GamePort)) {
        $ids += @(Get-PortOwners $port)
    }
    $ids = @($ids | Where-Object { $_ -gt 0 } | Select-Object -Unique)

    if ($ids.Count -eq 0) {
        Write-Host 'Nothing to stop (ports 8787 / 5173 are free).'
    }

    foreach ($id in $ids) {
        $p = Get-ProcInfo $id
        if (-not $p) { continue }
        $isAdmin = Test-ServiceProc $id 'admin'
        $isGame  = Test-ServiceProc $id 'game'
        if (-not ($isAdmin -or $isGame)) {
            Write-Host "  skip PID $id ($($p.Name)) - not a walkstreet dev process" -ForegroundColor Yellow
            continue
        }
        $label = 'walkstreet vite'
        if ($isAdmin) { $label = 'admin/server.js' }
        try {
            Stop-Process -Id $id -Force -ErrorAction Stop
            Write-Host "  stopped $label (PID $id)"
        } catch {
            Write-Host "  failed to stop PID $id : $($_.Exception.Message)" -ForegroundColor Red
        }
    }

    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline) {
        $busy = @()
        foreach ($port in @($AdminPort, $GamePort)) { $busy += @(Get-PortOwners $port) }
        if ($busy.Count -eq 0) { break }
        Start-Sleep -Milliseconds 300
    }

    foreach ($port in @($AdminPort, $GamePort)) {
        $left = @(Get-PortOwners $port)
        if ($left.Count -gt 0) {
            Write-Host "  warning: port $port still held by PID $($left -join ', ')" -ForegroundColor Yellow
        } else {
            Write-Host "  port $port is free"
        }
    }

    Remove-Item $StateFile -Force -ErrorAction SilentlyContinue
    Write-Host 'Done.'
    Write-Host ''
}

function Invoke-Status {
    Write-Host ''
    Write-Host '== open-world local dev / status ==' -ForegroundColor Cyan
    $items = @(
        @{ Name = 'admin backend + UI'; Port = $AdminPort; Url = "$AdminBase/api/health" },
        @{ Name = 'walkstreet vite';    Port = $GamePort;  Url = "$GameBase/" }
    )
    foreach ($item in $items) {
        $up     = Test-Http $item.Url
        $owners = @(Get-PortOwners $item.Port)
        $flag   = 'DOWN'
        if ($up) { $flag = 'UP  ' }
        Write-Host ("  {0,-22} port {1}: {2}  pid {3}" -f $item.Name, $item.Port, $flag, ($owners -join ','))
    }
    Write-Host "  logs: $StateDir"
    Write-Host ''
}

try {
    switch ($Action) {
        'start'  { Invoke-Start }
        'stop'   { Invoke-Stop }
        'status' { Invoke-Status }
    }
} catch {
    Write-Host ''
    Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ''
    exit 1
}

exit 0
