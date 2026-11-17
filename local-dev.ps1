<#
  Local dev runner for open-world.
  Double-click start.bat / stop.bat for one-click start / stop.

  There are three processes covering four parts:
    admin/server.js   -> admin backend (/api) + admin UI (public/) on port 8787
    vite              -> walkstreet game on port 5173
    ai-gateway        -> AI ability gateway (Mastra) on port 8788 (optional:
                         start failures only warn, frontend falls back)
  Admin UI is served by the backend, so it needs no separate process.
#>
param(
    [ValidateSet('start', 'stop', 'status')]
    [string]$Action = 'start',
    [switch]$NoBrowser,
    [switch]$Visible,
    [switch]$Install,
    # -Follow: keep tailing the service logs in this terminal after start
    [switch]$Follow
)

$ErrorActionPreference = 'Stop'

$Root        = $PSScriptRoot
$AdminDir    = Join-Path $Root 'admin'
$GameDir     = Join-Path $Root 'walkstreet'
$GatewayDir  = Join-Path $Root 'ai-gateway'
$AdminPort   = 8787
$GamePort    = 5173
$GatewayPort = 8788
$AdminBase   = "http://127.0.0.1:$AdminPort"
$GameBase    = "http://127.0.0.1:$GamePort"
$GatewayBase = "http://127.0.0.1:$GatewayPort"
$AdminUrl    = "$AdminBase/"
$GameUrl     = "$GameBase/?admin=" + [uri]::EscapeDataString($AdminBase)

$StateDir  = Join-Path $env:TEMP 'open-world-dev'
$StateFile = Join-Path $StateDir 'pids.json'
$Logs      = @{
    adminOut    = Join-Path $StateDir 'admin.out.log'
    adminErr    = Join-Path $StateDir 'admin.err.log'
    gameOut     = Join-Path $StateDir 'walkstreet.out.log'
    gameErr     = Join-Path $StateDir 'walkstreet.err.log'
    gatewayOut  = Join-Path $StateDir 'ai-gateway.out.log'
    gatewayErr  = Join-Path $StateDir 'ai-gateway.err.log'
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
    if ($Kind -eq 'gateway') { return ($cl -match 'tsx' -and $cl -match 'src[/\\]index\.ts') }
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

function Save-State([int]$AdminPid, [int]$GamePid, [int]$GatewayPid) {
    Ensure-StateDir
    $obj = [ordered]@{
        admin      = $AdminPid
        walkstreet = $GamePid
        gateway    = $GatewayPid
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

# --- live log tailing -------------------------------------------------------
# The services are started detached with stdout/stderr redirected to files.
# These helpers stream new bytes from those files into this console, so the
# start window shows runtime logs (vite requests, errors, server output).

function New-LogTail([string]$Path, [string]$Label, [string]$Color, [switch]$SkipExisting) {
    $offset = [long]0
    if ($SkipExisting -and (Test-Path -LiteralPath $Path)) {
        # service was already running before this start -> skip its old history
        $offset = [long](Get-Item -LiteralPath $Path).Length
    }
    [pscustomobject]@{
        Path    = $Path
        Label   = $Label
        Color   = $Color
        Offset  = $offset
        Partial = (New-Object byte[] 0)
    }
}

function Read-LogTail($Tail) {
    if (-not (Test-Path -LiteralPath $Tail.Path)) { return }

    $len = [long](Get-Item -LiteralPath $Tail.Path).Length
    if ($len -lt $Tail.Offset) {          # file was truncated (service restarted)
        $Tail.Offset  = 0
        $Tail.Partial = (New-Object byte[] 0)
    }
    if ($len -eq $Tail.Offset) { return }

    $fs  = $null
    $buf = $null
    try {
        $fs = [System.IO.File]::Open($Tail.Path,
                [System.IO.FileMode]::Open,
                [System.IO.FileAccess]::Read,
                [System.IO.FileShare]::ReadWrite)
        [void]$fs.Seek($Tail.Offset, [System.IO.SeekOrigin]::Begin)
        $count = [int]($len - $Tail.Offset)
        $buf   = New-Object byte[] $count
        $read  = $fs.Read($buf, 0, $count)
        if ($read -le 0) { return }
        $Tail.Offset += $read
    } catch {
        return
    } finally {
        if ($fs) { $fs.Dispose() }
    }

    # prepend the never-emitted tail of the previous read (partial line / split
    # multi-byte char), then emit only up to the last newline seen
    $total = $Tail.Partial.Length + $read
    $all   = New-Object byte[] $total
    [Array]::Copy($Tail.Partial, 0, $all, 0, $Tail.Partial.Length)
    [Array]::Copy($buf, 0, $all, $Tail.Partial.Length, $read)

    $lastNl = -1
    for ($i = $total - 1; $i -ge 0; $i--) {
        if ($all[$i] -eq 10) { $lastNl = $i; break }
    }
    if ($lastNl -lt 0) {
        $Tail.Partial = $all
        return
    }

    $Tail.Partial = (New-Object byte[] 0)
    if ($lastNl + 1 -lt $total) {
        $rest = New-Object byte[] ($total - $lastNl - 1)
        [Array]::Copy($all, $lastNl + 1, $rest, 0, $rest.Length)
        $Tail.Partial = $rest
    }

    $text  = [System.Text.Encoding]::UTF8.GetString($all, 0, $lastNl + 1)
    $stamp = (Get-Date).ToString('HH:mm:ss')
    foreach ($line in ($text -split "`r?`n")) {
        if ($line.Length -eq 0) { continue }
        # drop ANSI colour codes (vite writes them; the legacy console shows them raw)
        if ($line.IndexOf([char]27) -ge 0) {
            $line = [regex]::Replace($line, "$([char]27)\[[0-9;?]*[ -/]*[@-~]", '')
            if ($line.Length -eq 0) { continue }
        }
        Write-Host ("{0} [{1}] {2}" -f $stamp, $Tail.Label, $line) -ForegroundColor $Tail.Color
    }
}

function Invoke-FollowLogs([int]$AdminPid, [int]$GamePid, [int]$GatewayPid, [bool]$AdminFresh, [bool]$GameFresh, [bool]$GatewayFresh) {
    $adminSkip   = -not $AdminFresh
    $gameSkip    = -not $GameFresh
    $gatewaySkip = -not $GatewayFresh
    $tails = @(
        (New-LogTail $Logs.adminOut    'admin'   'Cyan'       -SkipExisting:$adminSkip),
        (New-LogTail $Logs.adminErr    'admin'   'DarkYellow' -SkipExisting:$adminSkip),
        (New-LogTail $Logs.gameOut     'game'    'Green'      -SkipExisting:$gameSkip),
        (New-LogTail $Logs.gameErr     'game'    'DarkYellow' -SkipExisting:$gameSkip),
        (New-LogTail $Logs.gatewayOut  'gateway' 'Magenta'    -SkipExisting:$gatewaySkip),
        (New-LogTail $Logs.gatewayErr  'gateway' 'DarkYellow' -SkipExisting:$gatewaySkip)
    )

    Write-Host ''
    Write-Host '---- live logs ----' -ForegroundColor DarkCyan
    Write-Host '  Ctrl+C or Q : stop watching logs (services keep running)' -ForegroundColor DarkGray
    Write-Host ''

    # Swallow Ctrl+C as a normal key so the watcher exits cleanly and the
    # underlying services are not affected by the console interrupt.
    $keyboard = $false
    try {
        [Console]::TreatControlCAsInput = $true
        $keyboard = $true
    } catch {
        $keyboard = $false
    }

    try {
        while ($true) {
            foreach ($t in $tails) { Read-LogTail $t }

            if ($keyboard) {
                try {
                    while ([Console]::KeyAvailable) {
                        $key = [Console]::ReadKey($true)
                        $isCtrlC = (($key.Modifiers -band [ConsoleModifiers]::Control) -and ($key.Key -eq 'C'))
                        if ($isCtrlC -or $key.Key -eq 'Q') {
                            Write-Host ''
                            Write-Host '  stopped watching logs - services are still running.' -ForegroundColor DarkGray
                            return
                        }
                    }
                } catch {
                    $keyboard = $false
                }
            }

            $alive = $false
            foreach ($procId in @($AdminPid, $GamePid, $GatewayPid)) {
                if ($procId -gt 0 -and (Get-Process -Id $procId -ErrorAction SilentlyContinue)) { $alive = $true }
            }
            if (-not $alive) {
                foreach ($t in $tails) { Read-LogTail $t }
                Write-Host ''
                Write-Host '  services exited - log watching stopped.' -ForegroundColor Yellow
                return
            }

            Start-Sleep -Milliseconds 250
        }
    } finally {
        if ($keyboard) {
            try { [Console]::TreatControlCAsInput = $false } catch { }
        }
    }
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

    # ai-gateway dependencies (optional service: missing deps get installed, but
    # a broken gateway must not block admin/walkstreet startup)
    $gatewayEntry = Join-Path $GatewayDir 'src\index.ts'
    $gatewayPkg   = Join-Path $GatewayDir 'package.json'
    $gatewayTsx   = Join-Path $GatewayDir 'node_modules\tsx'
    $gatewayAvailableDir = (Test-Path $gatewayEntry) -and (Test-Path $gatewayPkg)
    if ($gatewayAvailableDir -and ($Install -or -not (Test-Path $gatewayTsx))) {
        if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'npm.cmd not found in PATH.' }
        Write-Host '[setup] installing ai-gateway dependencies (npm) ...'
        Push-Location $GatewayDir
        try {
            if (Test-Path (Join-Path $GatewayDir 'package-lock.json')) {
                & cmd.exe /c 'npm ci --no-audit --no-fund'
            } else {
                & cmd.exe /c 'npm install --no-audit --no-fund'
            }
            if ($LASTEXITCODE -ne 0) { throw "ai-gateway npm install failed (exit $LASTEXITCODE)." }
        } finally {
            Pop-Location
        }
        if (-not (Test-Path $gatewayTsx)) { throw "ai-gateway deps are still missing: $gatewayTsx" }
    }

    Ensure-StateDir
    $adminPid     = 0
    $gamePid      = 0
    $gatewayPid   = 0
    $adminFresh   = $false   # true = log files were (re)created by this start
    $gameFresh    = $false
    $gatewayFresh = $false

    # 1) admin backend + admin UI (one process, port 8787)
    $owners = @(Get-PortOwners $AdminPort)
    $mine   = @($owners | Where-Object { Test-ServiceProc $_ 'admin' })
    if ($mine.Count -gt 0) {
        $adminPid = [int]$mine[0]
        Write-Host "[1/3] admin backend + admin UI already running (PID $adminPid) -> $AdminUrl"
    } elseif ($owners.Count -gt 0) {
        throw "Port $AdminPort is held by another process (PID $($owners -join ', ')). Free it first."
    } else {
        Write-Host '[1/3] starting admin/server.js (backend + admin UI) ...'
        $adminFresh = $true
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
        Write-Host "[2/3] walkstreet vite already running (PID $gamePid) -> $GameBase/"
    } elseif ($owners.Count -gt 0) {
        throw "Port $GamePort is held by another process (PID $($owners -join ', ')). Free it first."
    } else {
        Write-Host '[2/3] starting walkstreet vite ...'
        $gameFresh = $true
        $quoted   = '"{0}"' -f $viteCli
        $viteArgs = @($quoted, '--host', '127.0.0.1', '--port', "$GamePort", '--strictPort')
        $gamePid  = Start-Node $GameDir $viteArgs $Logs.gameOut $Logs.gameErr
        if (-not (Wait-Ready "$GameBase/" $gamePid 60)) {
            throw "vite did not become ready on $GamePort. Log: $($Logs.gameErr)"
        }
        Write-Host "      ready: $GameBase/ (PID $gamePid)"
    }

    # 3) ai-gateway (Mastra AI ability gateway, port 8788)
    # Non-fatal by design: the frontend falls back to legacy/local AI paths when
    # the gateway is down, so a gateway failure only warns here.
    if ($gatewayAvailableDir -and -not (Test-Path $gatewayTsx)) {
        Write-Host '[3/3] ai-gateway skipped - dependencies missing (run: cd ai-gateway; npm install)' -ForegroundColor Yellow
    } elseif ($gatewayAvailableDir) {
        $owners = @(Get-PortOwners $GatewayPort)
        $mine   = @($owners | Where-Object { Test-ServiceProc $_ 'gateway' })
        if ($mine.Count -gt 0) {
            $gatewayPid = [int]$mine[0]
            Write-Host "[3/3] ai-gateway already running (PID $gatewayPid) -> $GatewayBase/health"
        } elseif ($owners.Count -gt 0) {
            Write-Host "[3/3] warning: port $GatewayPort held by another process (PID $($owners -join ', ')) - ai-gateway not started" -ForegroundColor Yellow
        } else {
            Write-Host '[3/3] starting ai-gateway (Mastra) ...'
            try {
                $gatewayFresh = $true
                $gatewayPid = Start-Node $GatewayDir @('--import', 'tsx', 'src/index.ts') $Logs.gatewayOut $Logs.gatewayErr
                if (-not (Wait-Ready "$GatewayBase/health" $gatewayPid 40)) {
                    throw "ai-gateway did not become ready on $GatewayPort"
                }
                Write-Host "      ready: $GatewayBase/health (PID $gatewayPid)"
                $health = ''
                try { $health = (Invoke-WebRequest -Uri "$GatewayBase/health" -UseBasicParsing -TimeoutSec 3).Content } catch { }
                if ($health -match '"configured":false') {
                    Write-Host '      note: model key not configured - edit ai-gateway/.env (abilities will return 503 until then)' -ForegroundColor DarkYellow
                }
            } catch {
                $gatewayPid = 0
                Write-Host "[3/3] warning: ai-gateway failed to start ($($_.Exception.Message))" -ForegroundColor Yellow
                Write-Host "      frontend will fall back to legacy AI paths. Log: $($Logs.gatewayErr)" -ForegroundColor Yellow
            }
        }
    } else {
        Write-Host '[3/3] ai-gateway skipped - folder not found (ai-gateway/)' -ForegroundColor DarkGray
    }

    Save-State $adminPid $gamePid $gatewayPid

    Write-Host ''
    Write-Host 'All services up:' -ForegroundColor Green
    Write-Host "  admin backend  : $AdminBase/api/health"
    Write-Host "  admin UI       : $AdminUrl   (served by admin/server.js)"
    Write-Host "  walkstreet     : $GameUrl"
    if ($gatewayPid -gt 0) { Write-Host "  ai-gateway     : $GatewayBase/health" }
    else { Write-Host '  ai-gateway     : NOT RUNNING (AI abilities fall back to legacy paths)' -ForegroundColor Yellow }
    if (-not $Visible) { Write-Host "  logs           : $StateDir" }
    Write-Host '  stop           : stop.bat'
    Write-Host ''

    if (-not $NoBrowser) {
        Start-Process $AdminUrl
        Start-Process $GameUrl
    }

    if ($Follow -and -not $Visible) {
        Invoke-FollowLogs $adminPid $gamePid $gatewayPid $adminFresh $gameFresh $gatewayFresh
    } elseif ($Follow -and $Visible) {
        Write-Host '  note: -Visible already opens a console per service; log watching is skipped.' -ForegroundColor DarkGray
        Write-Host ''
    }
}

function Invoke-Stop {
    Write-Host ''
    Write-Host '== open-world local dev / stop ==' -ForegroundColor Cyan

    $ids = @()
    $state = Read-State
    if ($state) {
        foreach ($v in @($state.admin, $state.walkstreet, $state.gateway)) {
            if ($v) { $ids += [int]$v }
        }
    }
    foreach ($port in @($AdminPort, $GamePort, $GatewayPort)) {
        $ids += @(Get-PortOwners $port)
    }
    $ids = @($ids | Where-Object { $_ -gt 0 } | Select-Object -Unique)

    if ($ids.Count -eq 0) {
        Write-Host 'Nothing to stop (ports 8787 / 5173 / 8788 are free).'
    }

    foreach ($id in $ids) {
        $p = Get-ProcInfo $id
        if (-not $p) { continue }
        $isAdmin   = Test-ServiceProc $id 'admin'
        $isGame    = Test-ServiceProc $id 'game'
        $isGateway = Test-ServiceProc $id 'gateway'
        if (-not ($isAdmin -or $isGame -or $isGateway)) {
            Write-Host "  skip PID $id ($($p.Name)) - not a walkstreet dev process" -ForegroundColor Yellow
            continue
        }
        $label = 'walkstreet vite'
        if ($isAdmin) { $label = 'admin/server.js' }
        if ($isGateway) { $label = 'ai-gateway' }
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
        foreach ($port in @($AdminPort, $GamePort, $GatewayPort)) { $busy += @(Get-PortOwners $port) }
        if ($busy.Count -eq 0) { break }
        Start-Sleep -Milliseconds 300
    }

    foreach ($port in @($AdminPort, $GamePort, $GatewayPort)) {
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
        @{ Name = 'admin backend + UI'; Port = $AdminPort;   Url = "$AdminBase/api/health" },
        @{ Name = 'walkstreet vite';    Port = $GamePort;    Url = "$GameBase/" },
        @{ Name = 'ai-gateway';         Port = $GatewayPort; Url = "$GatewayBase/health" }
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
