<#
.SYNOPSIS
    Registers, repairs, or removes a GitHub Actions self-hosted runner for one
    repo, running as a Linux runner inside WSL2 (dev-pipeline-v2 spec section
    7.5, section 4.11 operator-CONFIRMED default; plan.md Chunk 14).

.DESCRIPTION
    Windows-side wrapper around the vendor `config.sh` / `svc.sh` runner
    tooling. The runner process itself lives INSIDE a WSL2 Linux distro
    (Docker via the WSL2 backend) so the existing bash-based CI suites and
    their Postgres service containers run unmodified: a Windows-native
    runner cannot execute a `services:` block (spec section 4.11).

    One runner process per repo (concurrency 1); same-repo jobs queue on
    GitHub's side. Registration is per-repo (spec section 4.7).

    Wrong-registration detection is a HARD ERROR, never detect-and-skip: if
    the work directory already holds a runner registered to a DIFFERENT
    repo than requested, this script refuses and names both repos. "A
    runner exists" is not "the right runner exists" (spec sections 7.5/13).

    This script never fetches, stores, or auto-installs WSL2 or Docker. If
    either precondition cannot be verified, it fails closed and names the
    missing precondition. If WSL2/Docker prove unusable at your site, the
    documented fallback is a Windows-native runner plus a workflow/suite
    rewrite (spec section 4.11), a re-estimated, operator-level decision
    this script does not make for you.

.PARAMETER Repo
    Target repo as `owner/name` (e.g. `michaelhazza/automation-v1`).

.PARAMETER Labels
    Runner labels. Defaults to the spec-pinned `self-hosted,linux`.

.PARAMETER WorkDir
    Linux-side path (inside the WSL distro) where the runner is installed
    and where its `_work` job folder lives. Everything this script deletes
    on -Repair/-Uninstall is scoped to exactly this directory, never
    anything outside it. Defaults to `~/actions-runner/<owner>-<repo>`.

.PARAMETER WslDistro
    Name of the WSL2 distro the runner installs into. Defaults to `Ubuntu`.

.PARAMETER RunnerName
    Name GitHub shows for this runner. Defaults to
    `<COMPUTERNAME>-<owner>-<repo>`.

.PARAMETER Token
    SecureString registration (or removal) token, short-lived and
    operator-entered at github.com. If omitted, the script prompts
    interactively at the point it is needed. Never stored, never
    committed, never echoed to the console or any log.

.PARAMETER Repair
    Clean remove + re-register against the SAME repo.

.PARAMETER Uninstall
    Deregister from GitHub, remove the auto-start task and service, and
    delete the work directory.

.EXAMPLE
    .\install-runner.ps1 -Repo michaelhazza/automation-v1 -WhatIf
    Preview what a fresh install would do without touching anything.

.EXAMPLE
    .\install-runner.ps1 -Repo michaelhazza/automation-v1
    Register (or re-verify, if already registered) the runner for real.

.EXAMPLE
    .\install-runner.ps1 -Repo michaelhazza/automation-v1 -Uninstall
    Deregister and remove everything this script created for that repo.
#>

#Requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$')]
    [string]$Repo,

    [string[]]$Labels = @('self-hosted', 'linux'),

    [string]$WorkDir,

    [string]$WslDistro = 'Ubuntu',

    [string]$RunnerName,

    [System.Security.SecureString]$Token,

    [switch]$Repair,

    [switch]$Uninstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($Repair -and $Uninstall) {
    Write-Error "-Repair and -Uninstall are mutually exclusive. Pick one."
    exit 1
}
if (@($Labels | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -gt 0) {
    Write-Error "-Labels contains an empty/whitespace entry. Every label must be a non-empty string."
    exit 1
}

$RepoSlug = ($Repo -replace '/', '-').ToLowerInvariant()
if (-not $WorkDir) { $WorkDir = "~/actions-runner/$RepoSlug" }
if (-not $RunnerName) { $RunnerName = "$env:COMPUTERNAME-$RepoSlug".ToLowerInvariant() }
$LabelsCsv = ($Labels -join ',')
$TaskName = "GHRunner-$RepoSlug"

# -- Small helpers -----------------------------------------------------------

function Write-Section {
    param([Parameter(Mandatory = $true)][string]$Title)
    Write-Host ""
    Write-Host "== $Title ==" -ForegroundColor Cyan
}

# Every value interpolated into a `bash -lc` command string is wrapped through
# this: single-quoted, with embedded single quotes escaped, so operator-
# controlled but non-statically-known values (repo, paths, labels) cannot
# break out of the intended shell argument (security-hardening: shell
# injection surfaces).
function ConvertTo-BashSingleQuoted {
    param([Parameter(Mandatory = $true)][string]$Value)
    # A double quote cannot be transported into the payload at all: Windows
    # PowerShell re-escapes embedded double quotes while marshalling arguments
    # to a native executable, so the string bash finally parses is NOT the
    # string built here. Demonstrated against the live distro -- the 15-char
    # payload  printf %s 'A"B'  arrived malformed enough that bash exited 2 with
    # "unexpected EOF while looking for matching `'". Silently shipping a
    # corrupted payload is the worst outcome for a function whose whole job is
    # to make operator-controlled values safe to interpolate, so refuse instead.
    # No legitimate input reaches here with one: -Repo is pattern-validated,
    # and a label, runner name or Linux path containing a double quote is
    # pathological rather than merely unusual.
    # The message deliberately does NOT echo $Value: one call site quotes the
    # registration token, and this file promises never to store, log or display
    # it. The caller knows which value it passed.
    if ($Value.Contains('"')) {
        throw "A value being interpolated into a bash command inside the distro contains a double quote (length $($Value.Length)), which cannot be transported safely: PowerShell re-escapes it while marshalling native arguments, so the payload bash receives is not the payload built here. Refusing rather than shipping a corrupted command. Re-run with a -WorkDir / -RunnerName / -Labels value that contains no double quote."
    }
    return "'" + ($Value -replace "'", "'\''") + "'"
}

# Every native command whose output this script CAPTURES goes through here.
#
# Windows PowerShell turns a native command's stderr into ErrorRecords the
# moment that stream is redirected into the pipeline (`2>&1`, `*>`), and with
# the script-level $ErrorActionPreference = 'Stop' above, those ErrorRecords
# are TERMINATING: the call throws instead of returning, so $LASTEXITCODE is
# never read and the crafted fail-closed message on the next line never runs.
# Verified on the reference machine -- `& gh api repos/<missing> 2>&1` threw a
# RemoteException rather than returning its "Not Found (HTTP 404)" text into
# Test-RepoTrustBoundary's message, and a command that writes to stderr while
# exiting 0 threw too, which is what `(sudo ./svc.sh stop || true)` does on a
# stopped unit: bash tolerated it deliberately, PowerShell aborted the
# uninstall anyway. Relaxing the preference for the duration of the capture
# restores exit-code-driven control flow without weakening it for cmdlets.
function Invoke-NativeCapture {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @()
    )
    # Function-scoped: the native call below runs under it, the caller's 'Stop'
    # is untouched.
    $ErrorActionPreference = 'Continue'
    $output = & $FilePath @ArgumentList 2>&1
    return [PSCustomObject]@{
        ExitCode = $LASTEXITCODE
        Output   = ($output -join [Environment]::NewLine)
    }
}

function ConvertFrom-SecureStringPlain {
    param([Parameter(Mandatory = $true)][System.Security.SecureString]$Secure)
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try {
        return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

# Runs a command inside the target WSL distro via `bash -lc`. The payload is
# passed as ONE argv element; the bash -lc payload is an inherently-shell
# string by the nature of the vendor tooling, hardened at each interpolation
# site via ConvertTo-BashSingleQuoted instead.
#
# CONSTRAINT on every payload built for this function: it must contain NO
# double-quote character. Windows PowerShell re-escapes embedded double quotes
# when it marshals arguments to a native executable, so a payload containing
# one does not survive the hop intact -- bash parses something other than what
# was built here, and does so silently. ConvertTo-BashSingleQuoted refuses
# double quotes in interpolated VALUES for this reason; payload text authored
# in this file must avoid them too (use `cd ~ && pwd` over `printf %s "$HOME"`,
# single-quoted bash literals over double-quoted ones).
function Invoke-WslBash {
    param(
        [Parameter(Mandatory = $true)][string]$Distro,
        [Parameter(Mandatory = $true)][string]$Command,
        [switch]$AsRoot
    )
    $wslArgs = @('-d', $Distro)
    if ($AsRoot) { $wslArgs += @('-u', 'root') }
    $wslArgs += @('--', 'bash', '-lc', $Command)
    return Invoke-NativeCapture -FilePath 'wsl.exe' -ArgumentList $wslArgs
}

# Reads the target distro's real home directory. Starts the WSL2 VM, so it is
# only ever called after the -WhatIf early-exit.
function Get-DistroHome {
    param([Parameter(Mandatory = $true)][string]$Distro)
    # `cd ~ && pwd -P` rather than `printf %s "$HOME"`: the payload must carry no
    # double quote (see Invoke-WslBash), and an UNQUOTED `$HOME` would word-split
    # a home directory containing a space. Tilde expansion is not subject to word
    # splitting, so this form is correct for any home path with no quoting at all.
    #
    # `-P` is load-bearing. Plain `pwd` prints the LOGICAL path, so on a distro
    # where `/home` is itself a symlink (`/home -> /srv/home`) it reports
    # `/home/alice` while the directory's real name is `/srv/home/alice`. The
    # work-dir floor refuses a path EQUAL to the home directory, and that
    # comparison is only sound if both sides are physical: with the logical form,
    # `-WorkDir /srv/home/alice` compared unequal, was accepted, and would have
    # been untarred over and later `rm -rf`'d -- the home directory itself.
    $result = Invoke-WslBash -Distro $Distro -Command 'cd ~ && pwd -P'
    if ($result.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($result.Output)) {
        throw "Could not read the home directory inside '$Distro' (exit $($result.ExitCode)): $($result.Output)"
    }
    return $result.Output.Trim()
}

# Bash does NOT expand `~` inside single quotes, and every path this script
# interpolates into a `bash -lc` payload is single-quoted as an injection
# defence (see ConvertTo-BashSingleQuoted). Left unresolved, a `~`-prefixed
# work dir therefore made `mkdir -p '~/actions-runner/...'` create a LITERAL
# directory named '~' relative to bash's CWD -- and for wsl.exe launched from
# a Windows directory that CWD is that directory under /mnt/c. The runner
# installed itself into the caller's repo working tree instead of the distro
# home (observed: 666 MB inside a pilot repo, breaking `git add -A` on the
# runner's own symlinks). Resolving up-front keeps the quoting defence intact
# while making every downstream site -- mkdir, cd, the .runner probe, and the
# `rm -rf` in uninstall/repair -- operate on an absolute, CWD-independent path.
function Resolve-DistroWorkDir {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$HomeDir
    )
    if (-not $HomeDir.StartsWith('/')) {
        throw "Resolved home directory '$HomeDir' is not absolute -- refusing to build a work-dir path from it."
    }
    # Deliberately not named $home -- that is a PowerShell automatic variable.
    # Normalised the same way $resolved is below, so the equality test between
    # them compares paths rather than spellings.
    $resolvedHome = '/' + (($HomeDir -split '/' | Where-Object { $_ -ne '' -and $_ -ne '.' }) -join '/')
    $resolved = $null
    if ($Path -eq '~') {
        $resolved = $resolvedHome
    } elseif ($Path.StartsWith('~/')) {
        $resolved = "$resolvedHome/" + $Path.Substring(2).TrimStart('/')
    } elseif ($Path.StartsWith('/')) {
        $resolved = $Path.TrimEnd('/')
    } else {
        # Anything else (a bare relative path, or a `~user` form this script does
        # not resolve) would land against bash's CWD -- the /mnt/c trap above.
        # Fail closed rather than guess.
        throw "-WorkDir '$Path' is neither absolute nor '~/'-relative. A relative path resolves against bash's working directory inside the distro, which for wsl.exe launched from a Windows directory is that directory under /mnt/c -- the runner would be installed into your repo working tree. Pass an absolute path (e.g. /home/<user>/actions-runner/<slug>) or a '~/'-prefixed one."
    }

    # Canonicalise BEFORE the floor below, because that floor is a set of string
    # comparisons and therefore only ever saw the spelling it was handed:
    #   -WorkDir '~//'  produced "$resolvedHome/", which compares UNEQUAL to
    #     $resolvedHome, so the home-directory refusal did not fire -- the
    #     installer would untar across $HOME and -Uninstall would `rm -rf` it.
    #   -WorkDir '~/./' produced "$resolvedHome/./", same escape.
    #   -WorkDir '/home/u/x/../../../mnt/c/runner' never matched the '/mnt/'
    #     prefix, so the Windows-filesystem refusal did not fire either.
    # Empty and '.' segments collapse; a '..' segment is refused outright rather
    # than resolved, because resolving it lexically would still be wrong across
    # a symlink and this value is both untarred over and deleted wholesale.
    $segments = @()
    foreach ($segment in ($resolved -split '/')) {
        if ($segment -eq '' -or $segment -eq '.') { continue }
        if ($segment -eq '..') {
            throw "-WorkDir '$Path' contains a '..' segment. Refusing: this directory is created, untarred over, and later deleted wholesale, and a '..' segment makes the refusals below (distro home, filesystem root, /mnt/*) unenforceable by string comparison. Pass a fully-resolved path, e.g. '$resolvedHome/actions-runner/<repo-slug>'."
        }
        $segments += $segment
    }
    $resolved = '/' + ($segments -join '/')

    # Floor on what the work dir is allowed to BE, not just how it is spelled.
    # -Uninstall and -Repair run `rm -rf` on this value, and the install step
    # untars over it, so a too-broad path is destructive in both directions.
    # `-WorkDir ~` previously resolved to the distro home and was accepted:
    # installing would have unpacked the runner tarball across $HOME, and a
    # later uninstall would have deleted the entire home directory.
    if ($resolved -eq '' -or $resolved -eq '/') {
        throw "-WorkDir resolves to the filesystem root. Refusing: this directory is created, untarred over, and later deleted wholesale."
    }
    if ($resolved -eq $resolvedHome) {
        throw "-WorkDir resolves to the distro home directory ('$resolved'). Refusing: the installer untars the runner over this directory and -Uninstall deletes it wholesale, which would destroy the home directory. Pass a dedicated subdirectory, e.g. '$resolvedHome/actions-runner/<repo-slug>'."
    }
    # /mnt/* is the Windows filesystem seen from inside WSL. Installing a Linux
    # runner there is the generalised form of the C22 defect (666 MB unpacked
    # into a Windows repo working tree), and `rm -rf` there reaches the
    # operator's real drive.
    if ($resolved -eq '/mnt' -or $resolved.StartsWith('/mnt/')) {
        throw "-WorkDir '$resolved' is on the Windows filesystem (/mnt/*) as seen from inside WSL. Refusing: the runner must live in the distro's own filesystem, and this script's `rm -rf` would otherwise reach the Windows drive. Pass a path under the distro home, e.g. '$resolvedHome/actions-runner/<repo-slug>'."
    }
    return $resolved
}

# Resolve-DistroWorkDir's floor is LEXICAL -- it can only judge the string it
# was handed. A symlink defeats it completely: with
# `/home/me/runner-root -> /mnt/c/Users/me/store`, the path
# `/home/me/runner-root/owner-repo` passes every refusal in that function, and
# then mkdir, the tarball extraction and `rm -rf` all follow the link onto the
# Windows drive -- the generalised C22 defect the floor exists to stop.
#
# So ask the distro what the path actually resolves to, and re-run the SAME
# floor against that answer rather than restating it here. `readlink -m`
# canonicalises without requiring the path to exist yet, which matters because
# this runs before a fresh install has created anything.
#
# SCOPE, precisely: `readlink` resolves SYMLINKS. It does not resolve mount
# identity, so this does NOT catch a bind mount of /mnt/c under a distro-local
# path, nor a WSL `[automount] root=` set to something other than /mnt -- both
# leave the path textually unchanged and therefore accepted. Detecting those
# needs the resolved path's filesystem type (findmnt/stat -f), which is a
# separate mechanism; it is recorded as a follow-up rather than half-built here.
# Do not read this function as covering them.
#
# The lexical path stays the one this script operates on; the canonical form is
# used only to REFUSE. Silently relocating an install to a symlink's target
# would be its own surprise.
function Assert-WorkDirCanonicalWithinFloor {
    param(
        [Parameter(Mandatory = $true)][string]$Distro,
        [Parameter(Mandatory = $true)][string]$WorkDir,
        [Parameter(Mandatory = $true)][string]$HomeDir
    )
    $quoted = ConvertTo-BashSingleQuoted $WorkDir
    $result = Invoke-WslBash -Distro $Distro -Command "readlink -m $quoted"
    if ($result.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($result.Output)) {
        throw "Could not canonicalise '$WorkDir' inside '$Distro' (readlink -m exited $($result.ExitCode)): $($result.Output). Fail-closed: without the canonical path this script cannot tell whether the work directory is really on the distro's own filesystem. Note that '-m' is GNU coreutils; a BusyBox-only distro provides 'readlink [-fnv]' and will fail here. This script targets a systemd-based distro (Ubuntu by default, see -WslDistro)."
    }
    $canonical = $result.Output.Trim()

    # The canonical path is ALWAYS rechecked -- there is deliberately no
    # "unchanged, skip it" short-circuit. The obvious one, `if ($canonical -eq
    # $WorkDir) { return }`, reopened the very bypass this function closes:
    # PowerShell's -eq is case-INSENSITIVE, while Linux paths and the lexical
    # `/mnt/` prefix test are case-SENSITIVE. With `/MNT -> /mnt`, the path
    # `/MNT/c/...` passes the lexical floor, canonicalises to `/mnt/c/...`, and
    # then compared EQUAL to its own pre-canonical spelling, so the recheck was
    # skipped and the install landed on the Windows drive anyway. Rechecking
    # unconditionally costs one pure-function call and removes the whole class.
    try {
        $null = Resolve-DistroWorkDir -Path $canonical -HomeDir $HomeDir
    } catch {
        $via = if ($canonical -ceq $WorkDir) { 'resolves to' } else { "resolves through a symlink to '$canonical', which" }
        throw "-WorkDir '$WorkDir' $via a location the work-directory floor refuses inside '$Distro': $($_.Exception.Message)"
    }
}

# Last line of defence before `rm -rf`. Resolve-DistroWorkDir bounds what the
# path may be; this asserts the target actually IS a runner install before it
# is deleted, so a mistyped-but-legal path deletes nothing.
#
# The markers are the two VENDOR-EXTRACT files, deliberately NOT `.runner`.
# `.runner` is written by `config.sh` at registration and DELETED by
# `config.sh remove` (Runner.Listener's unconfigure path deletes the settings
# file). Both callers below run `config.sh remove` immediately BEFORE calling
# this, so asserting on `.runner` refused every successful -Uninstall and
# -Repair: the runner was deregistered from GitHub, then this threw, the work
# directory survived, -Uninstall never removed the scheduled task, and -Repair
# never reached its reinstall. The configured-ness of the directory is already
# proven upstream: the main flow reached these modes only via
# Get-ExistingRunnerConfig + Assert-NoWrongRepoRegistration, which read a valid
# `.runner` naming exactly this repo, so all this assertion still owes is "is
# this a runner directory at all", which the extract files answer and which
# survives deregistration.
function Assert-RunnerWorkDirBeforeDelete {
    param(
        [Parameter(Mandatory = $true)][string]$Distro,
        [Parameter(Mandatory = $true)][string]$WorkDir
    )
    $quoted = ConvertTo-BashSingleQuoted $WorkDir
    $probe = Invoke-WslBash -Distro $Distro -Command "test -f $quoted/config.sh && test -f $quoted/run.sh && echo RUNNER_DIR_OK"
    if ($probe.Output -notmatch 'RUNNER_DIR_OK') {
        throw "Refusing to delete '$WorkDir' inside '$Distro': it does not look like a runner install (expected both 'config.sh' and 'run.sh' to exist there). Nothing was deleted. Verify -WorkDir, or remove the directory by hand if you are certain."
    }
}

# -- Host-level preconditions (safe: never starts the WSL2 VM) --------------

function Test-WslDistroPresent {
    param([Parameter(Mandatory = $true)][string]$Distro)
    $wslCmd = Get-Command wsl.exe -ErrorAction SilentlyContinue
    if (-not $wslCmd) {
        return [PSCustomObject]@{ Passed = $false; Detail = "wsl.exe not found on PATH. Install WSL2 manually: https://learn.microsoft.com/windows/wsl/install -- this script never auto-installs WSL2 (it changes the machine and may require a reboot)." }
    }
    $listing = Invoke-NativeCapture -FilePath 'wsl.exe' -ArgumentList @('-l', '-v')
    if ($listing.ExitCode -ne 0) {
        return [PSCustomObject]@{ Passed = $false; Detail = "wsl.exe -l -v exited $($listing.ExitCode) -- $($listing.Output)" }
    }
    # wsl.exe writes UTF-16 to stdout when its output is redirected/captured;
    # PowerShell's default capture yields one NUL char after every ASCII
    # byte. Strip it before matching (documented wsl.exe capture quirk).
    $text = $listing.Output -replace "`0", ''
    $pattern = '(?im)^\s*\*?\s*' + [regex]::Escape($Distro) + '\s+(\S+)\s+(\d+)\s*$'
    $match = [regex]::Match($text, $pattern)
    if (-not $match.Success) {
        return [PSCustomObject]@{ Passed = $false; Detail = "No distro named '$Distro' in 'wsl -l -v'. Register one first (operator decision, not automated here): wsl --install -d $Distro`nRaw listing:`n$text" }
    }
    $state = $match.Groups[1].Value
    $version = $match.Groups[2].Value
    if ($version -ne '2') {
        return [PSCustomObject]@{ Passed = $false; Detail = "Distro '$Distro' is WSL version $version, not 2 (spec section 4.11 pins WSL2). Convert: wsl --set-version $Distro 2" }
    }
    return [PSCustomObject]@{ Passed = $true; Detail = "state=$state version=$version" }
}

function Test-GhReady {
    $ghCmd = Get-Command gh -ErrorAction SilentlyContinue
    if (-not $ghCmd) {
        return [PSCustomObject]@{ Passed = $false; Detail = 'gh CLI not found on PATH. Install: https://cli.github.com/' }
    }
    $versionLine = ((Invoke-NativeCapture -FilePath 'gh' -ArgumentList @('--version')).Output -split "`r?`n" | Select-Object -First 1)
    $authStatus = Invoke-NativeCapture -FilePath 'gh' -ArgumentList @('auth', 'status')
    if ($authStatus.ExitCode -ne 0) {
        return [PSCustomObject]@{ Passed = $false; Detail = "gh is installed ($versionLine) but not authenticated (gh auth status exited $($authStatus.ExitCode)). Fix: gh auth login" }
    }
    return [PSCustomObject]@{ Passed = $true; Detail = "$versionLine, authenticated" }
}

# Spec section 7.5 pins the trust boundary as "private repos only". That was
# prose until now: nothing verified it, while the installer registers a
# PERSISTENT runner whose jobs run as a user that must be in the docker group
# (Test-DockerReachable makes that a hard precondition). Docker group is
# root-equivalent, and /mnt/* exposes the operator's whole Windows drive, so a
# runner on a PUBLIC repo turns any fork PR into arbitrary code execution with
# access to every .env and sibling repo on the machine. Checked here, against
# the already-authenticated gh, because a precondition is the only place it can
# be enforced rather than asserted.
function Test-RepoTrustBoundary {
    param([Parameter(Mandatory = $true)][string]$Repo)
    $probe = Invoke-NativeCapture -FilePath 'gh' -ArgumentList @('api', "repos/$Repo", '--jq', '.private')
    $visibility = $probe.Output
    if ($probe.ExitCode -ne 0) {
        return [PSCustomObject]@{ Passed = $false; Detail = "could not read repo visibility for '$Repo' via gh api (exit $($probe.ExitCode)): $visibility. Fail-closed -- refusing to register a persistent runner against a repo whose visibility is unknown." }
    }
    if ("$visibility".Trim() -ne 'true') {
        return [PSCustomObject]@{ Passed = $false; Detail = "'$Repo' is PUBLIC. Refusing: a persistent self-hosted runner on a public repo lets any fork PR execute attacker-authored workflow code on this machine, as a user in the docker group (root-equivalent) with /mnt/* access to the whole Windows drive. Spec section 7.5 pins this boundary to private repos only." }
    }
    return [PSCustomObject]@{ Passed = $true; Detail = "'$Repo' is private" }
}

function Show-HostPreconditions {
    param(
        [Parameter(Mandatory = $true)][string]$Distro,
        [Parameter(Mandatory = $true)][string]$Repo,
        # Removal mode (-Uninstall) only ever REMOVES a runner, so every
        # precondition that exists to protect a REGISTRATION has nothing left to
        # protect -- while enforcing them there blocks cleanup at exactly the
        # moment cleanup matters most.
        #   - private-repo trust boundary: a repo that was private at install
        #     time and has since been made public (or renamed, or deleted, all
        #     of which read as "visibility unknown" and fail closed) could not
        #     be cleaned up at all; the guard refused before mode dispatch,
        #     leaving the persistent runner registered and running.
        #   - gh readiness: nothing on the removal path calls gh. The removal
        #     token is operator-supplied or prompted for, `config.sh remove`
        #     and the scheduled-task cleanup are gh-free, and the only consumer
        #     is the closing Show-RunnerStatus, whose failure is already
        #     tolerated (it returns $false and its result is discarded). So gh
        #     is REPORTED here but not REQUIRED.
        # The WSL2 distro check stays required in both modes -- it is what runs
        # the removal.
        [switch]$RemovalMode
    )
    Write-Section "Host preconditions"
    $wslCheck = Test-WslDistroPresent -Distro $Distro
    $ghCheck = Test-GhReady
    $rows = @(
        [PSCustomObject]@{ Check = "WSL2 distro '$Distro' present (version 2)"; Passed = $wslCheck.Passed; Detail = $wslCheck.Detail }
    )
    if ($RemovalMode) {
        $ghMark = if ($ghCheck.Passed) { '[OK]  ' } else { '[warn]' }
        Write-Host "$ghMark gh CLI (informational on the removal path; not required)" -ForegroundColor DarkGray
        Write-Host "       $($ghCheck.Detail)" -ForegroundColor DarkGray
        Write-Host "[skip] '$Repo' private-repo trust boundary -- removal path, nothing is being registered." -ForegroundColor DarkGray
    } else {
        $rows += [PSCustomObject]@{ Check = 'gh CLI installed + authenticated'; Passed = $ghCheck.Passed; Detail = $ghCheck.Detail }
        # Only meaningful once gh is authenticated; otherwise it would report a
        # confusing auth error rather than the real precondition failure.
        if ($ghCheck.Passed) {
            $trustCheck = Test-RepoTrustBoundary -Repo $Repo
            $rows += [PSCustomObject]@{ Check = "'$Repo' is private (trust boundary, spec 7.5)"; Passed = $trustCheck.Passed; Detail = $trustCheck.Detail }
        }
    }
    foreach ($row in $rows) {
        $mark = if ($row.Passed) { '[OK]  ' } else { '[FAIL]' }
        $color = if ($row.Passed) { 'Green' } else { 'Red' }
        Write-Host "$mark $($row.Check)" -ForegroundColor $color
        Write-Host "       $($row.Detail)"
    }
    $allPassed = -not ($rows | Where-Object { -not $_.Passed })
    if (-not $allPassed) {
        Write-Host ""
        Write-Host "One or more host preconditions failed. Fail-closed: no further action taken." -ForegroundColor Red
        Write-Host "If WSL2/Docker cannot be made to work on this machine, spec section 4.11's documented" -ForegroundColor Yellow
        Write-Host "fallback is a Windows-native runner + workflow/suite rewrite -- a re-estimated," -ForegroundColor Yellow
        Write-Host "operator-level decision, not something this script does automatically." -ForegroundColor Yellow
    }
    return $allPassed
}

# -- Deep preconditions (require the WSL2 VM to be running) -----------------

function Test-DockerReachable {
    param([Parameter(Mandatory = $true)][string]$Distro)
    $result = Invoke-WslBash -Distro $Distro -Command 'docker info > /dev/null 2>&1; echo EXIT:$?'
    if ($result.ExitCode -ne 0 -or $result.Output -notmatch 'EXIT:0') {
        return [PSCustomObject]@{ Passed = $false; Detail = "Docker unreachable inside '$Distro'. Check the WSL2 Docker backend (Docker Desktop > Settings > Resources > WSL Integration, or dockerd status inside the distro). This script never installs or starts Docker for you.`n$($result.Output)" }
    }
    return [PSCustomObject]@{ Passed = $true; Detail = 'docker info succeeded' }
}

function Test-SystemdActive {
    param([Parameter(Mandatory = $true)][string]$Distro)
    # svc.sh (vendor tooling) only needs systemd to be PID 1 to install a
    # boot-managed unit -- it does not require every unit to be healthy.
    # `systemctl is-system-running` returns non-zero for "degraded" too,
    # which is common and harmless on WSL2, so test presence directly
    # instead of demanding a clean "running" state.
    $result = Invoke-WslBash -Distro $Distro -Command '[ -d /run/systemd/system ] && echo EXIT:0 || echo EXIT:1; systemctl is-system-running 2>&1'
    if ($result.Output -notmatch 'EXIT:0') {
        return [PSCustomObject]@{ Passed = $false; Detail = "systemd is not the active init inside '$Distro' (svc.sh needs it to install a boot-managed service). Add '[boot]`nsystemd=true' to /etc/wsl.conf inside the distro, then run 'wsl --shutdown' from Windows and retry -- this script does not edit wsl.conf or shut down WSL for you, since that disrupts any other running WSL work.`n$($result.Output)" }
    }
    return [PSCustomObject]@{ Passed = $true; Detail = "systemd active ($($result.Output.Trim()))" }
}

function Show-DeepPreconditions {
    param([Parameter(Mandatory = $true)][string]$Distro)
    Write-Section "Deep preconditions (starting '$Distro' if not already running)"
    $dockerCheck = Test-DockerReachable -Distro $Distro
    $systemdCheck = Test-SystemdActive -Distro $Distro
    $rows = @(
        [PSCustomObject]@{ Check = 'Docker reachable'; Passed = $dockerCheck.Passed; Detail = $dockerCheck.Detail }
        [PSCustomObject]@{ Check = 'systemd active (for boot-managed service)'; Passed = $systemdCheck.Passed; Detail = $systemdCheck.Detail }
    )
    foreach ($row in $rows) {
        $mark = if ($row.Passed) { '[OK]  ' } else { '[FAIL]' }
        $color = if ($row.Passed) { 'Green' } else { 'Red' }
        Write-Host "$mark $($row.Check)" -ForegroundColor $color
        Write-Host "       $($row.Detail)"
    }
    return -not ($rows | Where-Object { -not $_.Passed })
}

# -- Existing-registration inspection (wrong-repo detection) ----------------

function Get-ExistingRunnerConfig {
    param(
        [Parameter(Mandatory = $true)][string]$Distro,
        [Parameter(Mandatory = $true)][string]$WorkDir
    )
    $quotedPath = ConvertTo-BashSingleQuoted "$WorkDir/.runner"
    # ABSENT and UNREADABLE must be distinguishable. `cat ... 2>/dev/null`
    # collapsed "no registration here" (legitimate), "permission denied"
    # (plausible after a prior sudo-run install) and "wsl transient failure"
    # into one $null, and the main flow reads $null as "nothing registered"
    # and proceeds to install with `config.sh --replace` -- clobbering
    # whatever registration is actually there. That is exactly the
    # detect-and-skip behaviour this script's .DESCRIPTION forbids, and it is
    # the headline safety property of the whole file.
    # The status sentinels are OUT OF BAND with respect to the payload: the JSON
    # is fenced between BEGIN/END lines and read only from inside that fence.
    # Scanning the whole capture for a bare sentinel conflated the two channels
    # in both directions. `-RunnerName '__RUNNER_CFG_ABSENT__'` is persisted
    # verbatim as `agentName`, so a perfectly valid registration read back as
    # "absent" -- -Uninstall then exited 0 reporting nothing to remove while the
    # runner stayed live, and a plain install would have silently replaced it.
    # In the other direction, anything a `bash -lc` login profile prints (nvm,
    # direnv, conda banners) landed in the same capture and made valid JSON
    # unparseable, tripping the "not valid JSON" refusal on a healthy install.
    # The `echo ''` between the payload and the closing marker is load-bearing:
    # the vendor writes `.runner` with NO trailing newline, so `cat` leaves the
    # closing marker glued to the last JSON line and a line-anchored match for
    # it finds nothing. Verified against a real fixture inside the distro. A
    # blank line inside the fence is insignificant whitespace to ConvertFrom-Json.
    $probe = "if [ ! -e $quotedPath ]; then echo '__RUNNER_CFG_ABSENT__'; elif cat $quotedPath >/dev/null 2>&1; then echo '__RUNNER_CFG_BEGIN__'; cat $quotedPath; echo ''; echo '__RUNNER_CFG_END__'; else echo '__RUNNER_CFG_UNREADABLE__'; fi"
    $result = Invoke-WslBash -Distro $Distro -Command $probe
    if ($result.ExitCode -ne 0) {
        throw "Could not determine whether a runner is already registered at '$WorkDir/.runner' inside '$Distro' (wsl exited $($result.ExitCode)): $($result.Output). Fail-closed: refusing to continue, because treating this as 'nothing registered' would let an install replace an existing registration."
    }
    if ($result.Output -match '(?m)^__RUNNER_CFG_UNREADABLE__[ \t\r]*$') {
        throw "A '.runner' file exists at '$WorkDir/.runner' inside '$Distro' but could not be read (permission denied?). Refusing to continue: assuming 'nothing registered' here would clobber an existing registration via 'config.sh --replace'. Inspect it manually (e.g. 'wsl -d $Distro -u root -- cat $WorkDir/.runner') and resolve before re-running."
    }
    $payload = [regex]::Match($result.Output, '(?ms)^__RUNNER_CFG_BEGIN__[ \t\r]*$(.*)^__RUNNER_CFG_END__[ \t\r]*$')
    if ($payload.Success) {
        $json = $payload.Groups[1].Value
        if ([string]::IsNullOrWhiteSpace($json)) {
            # The file EXISTS and is readable but holds nothing -- an interrupted
            # or truncated `config.sh` run, not a clean "never registered here".
            # Reading it as absent would send the main flow into an install that
            # runs `config.sh --replace` over whatever state that half-written
            # directory is in.
            throw "A '.runner' file exists at '$WorkDir/.runner' inside '$Distro' but is empty. Refusing to continue: an empty registration file means an interrupted or truncated config.sh run, not 'nothing registered'. Inspect the work directory and remove the file by hand if it is genuinely stale, then re-run."
        }
        try {
            return $json | ConvertFrom-Json
        } catch {
            throw "Existing '.runner' file at '$WorkDir/.runner' inside '$Distro' is present but not valid JSON. Refusing to guess its target repo -- resolve manually (inspect/remove the file) before re-running."
        }
    }
    if ($result.Output -match '(?m)^__RUNNER_CFG_ABSENT__[ \t\r]*$') {
        return $null
    }
    # No recognised sentinel at all: the probe did not run as written (an
    # unexpected wsl/bash state). Fail closed rather than inferring "absent"
    # from unrecognised output -- that inference is the exact clobber this
    # function exists to prevent.
    throw "Probe for '$WorkDir/.runner' inside '$Distro' returned no recognised status marker, so it is unknown whether a runner is registered there. Fail-closed: refusing to continue. Raw output:`n$($result.Output)"
}

function Get-RepoFromGitHubUrl {
    param([Parameter(Mandatory = $true)][string]$GitHubUrl)
    return ($GitHubUrl -replace '^https?://github\.com/', '' -replace '/$', '')
}

function Assert-NoWrongRepoRegistration {
    param(
        [Parameter(Mandatory = $true)]$ExistingConfig,
        [Parameter(Mandatory = $true)][string]$ExpectedRepo
    )
    if ($null -eq $ExistingConfig) { return $false }
    $existingRepo = Get-RepoFromGitHubUrl -GitHubUrl $ExistingConfig.gitHubUrl
    if ($existingRepo -ne $ExpectedRepo) {
        Write-Host ""
        Write-Host "ERROR: wrong-repo registration detected." -ForegroundColor Red
        Write-Host "  Work directory holds a runner registered to : $existingRepo"
        Write-Host "  You requested                                 : $ExpectedRepo"
        Write-Host "Refusing to silently reconfigure or skip -- 'a runner exists' is not 'the" -ForegroundColor Red
        Write-Host "right runner exists' (spec sections 7.5/13). Point -WorkDir at a different directory" -ForegroundColor Red
        Write-Host "for a separate registration, or -Uninstall the existing one first if it is" -ForegroundColor Red
        Write-Host "genuinely stale." -ForegroundColor Red
        throw "Wrong-repo registration: '$existingRepo' present, '$ExpectedRepo' requested."
    }
    return $true
}

# -- Registration token (operator-entered, never stored/echoed) -------------

function Read-RegistrationToken {
    param(
        [Parameter(Mandatory = $true)][string]$Repo,
        [Parameter(Mandatory = $true)][ValidateSet('registration', 'removal')][string]$Purpose,
        [System.Security.SecureString]$Provided
    )
    if ($Provided) { return $Provided }

    Write-Host ""
    if ($Purpose -eq 'registration') {
        Write-Host "A short-lived REGISTRATION token is needed for '$Repo'. Get one via EITHER:"
        Write-Host "  (a) GitHub UI: https://github.com/$Repo/settings/actions/runners/new"
        Write-Host "  (b) In a separate authenticated shell: gh api -X POST repos/$Repo/actions/runners/registration-token --jq .token"
    } else {
        Write-Host "A short-lived REMOVAL token is needed for '$Repo' (different from a registration token). Get one via EITHER:"
        Write-Host "  (a) GitHub UI: repo Settings > Actions > Runners > select the runner > Remove"
        Write-Host "  (b) In a separate authenticated shell: gh api -X POST repos/$Repo/actions/runners/remove-token --jq .token"
    }
    Write-Host "This script never stores, logs, or displays the token."
    return Read-Host -Prompt "Paste the $Purpose token" -AsSecureString
}

# -- Post-install / status verification --------------------------------------

function Show-RunnerStatus {
    param(
        [Parameter(Mandatory = $true)][string]$Repo,
        [string]$ExpectedName
    )
    Write-Section "Runner status for $Repo (gh api repos/$Repo/actions/runners)"
    $query = Invoke-NativeCapture -FilePath 'gh' -ArgumentList @('api', "repos/$Repo/actions/runners")
    if ($query.ExitCode -ne 0) {
        Write-Host "Could not query runner status: $($query.Output)" -ForegroundColor Red
        return $false
    }
    $parsed = $query.Output | ConvertFrom-Json
    if (-not $parsed.runners -or @($parsed.runners).Count -eq 0) {
        Write-Host "No runners registered for $Repo." -ForegroundColor Yellow
        return $false
    }
    $found = $false
    foreach ($runner in $parsed.runners) {
        $labelNames = ($runner.labels | ForEach-Object { $_.name }) -join ','
        $marker = ''
        if ($ExpectedName -and $runner.name -eq $ExpectedName) {
            $marker = ' <-- this install'
            $found = $true
        }
        Write-Host "  id=$($runner.id) name=$($runner.name) status=$($runner.status) labels=$labelNames$marker"
    }
    if ($ExpectedName -and -not $found) {
        Write-Host "Expected runner name '$ExpectedName' was not in the list above." -ForegroundColor Yellow
    }
    return $true
}

# -- Auto-start at Windows boot ----------------------------------------------
# Mechanism: a Task Scheduler task triggered AtStartup, running as SYSTEM,
# that invokes `wsl.exe -d <Distro> -u root -- systemctl start <unit>`.
# svc.sh install (below) already `systemctl enable`s the unit, so systemd
# itself will normally bring the service up as soon as the distro's init
# starts -- but WSL2 does not launch the distro's VM on Windows boot by
# itself; something has to invoke wsl.exe first. This task is that trigger,
# and re-asserting `systemctl start` on an already-started unit is a no-op,
# so it is safe to run unconditionally on every boot.
# Chosen over a long-running Windows-side service piping into WSL (extra
# process, extra failure surface) and over NSSM/third-party service
# wrappers (extra dependency): Task Scheduler + wsl.exe is built in, and
# svc.sh's own service management is exactly the vendor's documented Linux
# service story, so this keeps the installer close to that contract rather
# than reinventing service supervision on the Windows side.
# CAVEAT (flag for the C22 operator spike): AtStartup tasks running as
# SYSTEM invoking wsl.exe are version-dependent on some WSL builds -- if
# the runner does not come up after a real reboot, switch the trigger to
# `-AtLogOn` for the operator's own account (higher reliability, but only
# fires once that account logs in, not at raw machine boot).
function Register-RunnerAutoStart {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true)][string]$TaskName,
        [Parameter(Mandatory = $true)][string]$Distro,
        [Parameter(Mandatory = $true)][string]$ServiceUnit
    )
    if (-not $PSCmdlet.ShouldProcess("Task Scheduler task '$TaskName'", "Register (AtStartup, SYSTEM) to auto-start '$ServiceUnit' in '$Distro'")) {
        return
    }
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    $action = New-ScheduledTaskAction -Execute 'wsl.exe' -Argument "-d $Distro -u root -- systemctl start $ServiceUnit"
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Auto-starts the GitHub Actions runner for $Repo inside WSL2 distro '$Distro' at Windows boot (dev-pipeline-v2 C14)." | Out-Null
    Write-Host "Registered Task Scheduler task '$TaskName' (AtStartup, SYSTEM)." -ForegroundColor Green
}

function Unregister-RunnerAutoStart {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param([Parameter(Mandatory = $true)][string]$TaskName)
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $existing) { return }
    if (-not $PSCmdlet.ShouldProcess("Task Scheduler task '$TaskName'", 'Remove')) { return }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed Task Scheduler task '$TaskName'." -ForegroundColor Green
}

# Resolves THIS repo's systemd unit, never a global first-match. Two sources,
# in order of trust:
#   1. `$WorkDir/.service` -- svc.sh writes the exact unit name there at install
#      time. Per-work-dir by construction; no pattern matching involved.
#   2. Slug-scoped enumeration -- filter every actions.runner.* unit file down
#      to those whose name starts with `actions.runner.<RepoSlug>.` (case-
#      insensitive: the vendor derives its unit name from the repo's original
#      casing while $RepoSlug is lowercased). Accept EXACTLY one. Zero or
#      several -> return nothing and let the caller refuse, because guessing
#      is how repo B's cleanup stops repo A's runner.
# Classifies a `systemctl is-active` value as terminally stopped or not.
#
# Extracted as its own function so the accepted set is stated in exactly one
# place and is directly testable. `deactivating` is deliberately NOT stopped --
# it means shutdown is in progress, and the caller deletes the work directory
# immediately afterwards. Keeping it inline is how it drifted into the accepted
# set in the first place.
#
# - inactive : stopped cleanly.
# - failed   : stopped, having failed. Still not running.
# - unknown / inactive-with-no-unit : systemd does not know it. Treated as
#   stopped only because the caller has already established the unit exists.
# Anything else (active, activating, reloading, deactivating, or an
# unrecognised value) is NOT stopped.
function Test-SystemdStateStopped {
    param([string]$State)
    if ([string]::IsNullOrWhiteSpace($State)) { return $false }
    return ($State.Trim() -match '^(inactive|failed|unknown)$')
}

# Extracts the executable path from an ExecStart value, honouring systemd's
# quoting. Returns an empty string when the value cannot be parsed
# unambiguously, which the caller treats as "refuse to claim ownership".
#
# Splitting on whitespace alone was wrong (external review round 4): the script
# permits spaces in the work directory, so a real unit could carry
#   ExecStart="/home/mike/runner installs/repo/runsvc.sh"
# which naive splitting reduces to '"/home/mike/runner' -- no directory ever
# matches that, so the installer refused to manage a runner it had itself
# installed. An availability bug, not a safety one, but it fires on exactly the
# paths a Windows-side operator is most likely to choose.
#
# Systemd allows the executable to be wrapped in single or double quotes, with
# backslash escapes processed inside double quotes. Unterminated quoting is
# ambiguous, so it returns empty rather than guessing.
function Get-SystemdExecPath {
    param([string]$ExecStart)

    if ([string]::IsNullOrWhiteSpace($ExecStart)) { return '' }
    $value = $ExecStart.Trim()
    $quote = $value[0]

    if ($quote -ne '"' -and $quote -ne "'") {
        # Unquoted: the path runs to the first UNESCAPED whitespace. systemd
        # processes backslash escapes in unquoted words too, so a plain split
        # on whitespace turned '/home/mike/runner\ installs/repo/runsvc.sh'
        # into '/home/mike/runner\'. That truncation is safe (a trailing
        # backslash matches no canonical directory, so the caller refuses) but
        # it is the same availability bug as the quoted case: the installer
        # declines to manage a runner it installed itself.
        $sbU = New-Object System.Text.StringBuilder
        $j = 0
        while ($j -lt $value.Length) {
            $c = $value[$j]
            if ($c -eq '\' -and ($j + 1) -lt $value.Length) {
                [void]$sbU.Append($value[$j + 1])
                $j += 2
                continue
            }
            if ([char]::IsWhiteSpace($c)) { break }
            [void]$sbU.Append($c)
            $j++
        }
        return $sbU.ToString()
    }

    $sb = New-Object System.Text.StringBuilder
    $i = 1
    while ($i -lt $value.Length) {
        $ch = $value[$i]
        # Backslash escapes are only processed inside double quotes.
        if ($ch -eq '\' -and $quote -eq '"' -and ($i + 1) -lt $value.Length) {
            [void]$sb.Append($value[$i + 1])
            $i += 2
            continue
        }
        if ($ch -eq $quote) { return $sb.ToString() }
        [void]$sb.Append($ch)
        $i++
    }
    # Ran off the end without a closing quote.
    return ''
}

# The single authority on "does this unit belong to THIS work dir".
#
# Reads the unit FILE rather than asking systemctl, deliberately: the uninstall
# path skips the systemd health precondition, so `systemctl show` may be
# unavailable exactly when this check matters most. The file is on disk either
# way.
#
# Verification is by PATH, not by name. A name prefix is a hint an operator can
# forge (or a stale file can carry); WorkingDirectory/ExecStart pointing inside
# the canonical work dir is what actually proves ownership. Both are realpath'd
# so a symlinked work dir still compares correctly.
function Test-UnitBelongsToWorkDir {
    param(
        [Parameter(Mandatory = $true)][string]$Distro,
        [Parameter(Mandatory = $true)][string]$Unit,
        [Parameter(Mandatory = $true)][string]$WorkDir
    )
    if ($Unit -notmatch '^actions\.runner\.[^/]+\.service$') { return $false }
    $quotedUnitPath = ConvertTo-BashSingleQuoted "/etc/systemd/system/$Unit"
    $quotedDir = ConvertTo-BashSingleQuoted $WorkDir

    # Two round trips rather than one clever payload: resolving the canonical
    # dir inline needs command substitution with quoting, and NO payload in this
    # file may contain a double quote (a quoted payload does not survive the
    # argv hop to bash -- source invariant, earned the hard way).
    $canon = Invoke-WslBash -Distro $Distro -Command "readlink -f $quotedDir 2>/dev/null || printf %s $quotedDir"
    $canonDir = ($canon.Output -split "`n" | Where-Object { $_ -match '\S' } | Select-Object -First 1)
    if ($null -ne $canonDir) { $canonDir = $canonDir.Trim().TrimEnd('/') }
    if ([string]::IsNullOrWhiteSpace($canonDir) -or $canonDir -eq '/') { return $false }

    $probe = "test -f $quotedUnitPath || { echo NO_UNIT_FILE; exit 0; }; " +
             "grep -E '^(WorkingDirectory|ExecStart)=' $quotedUnitPath 2>/dev/null"
    $result = Invoke-WslBash -Distro $Distro -Command $probe
    if ($result.ExitCode -ne 0 -or $result.Output -match 'NO_UNIT_FILE') { return $false }

    # BOTH directives must agree. This was an OR -- returning true on the first
    # matching line -- which proves only that SOME field mentions the target
    # directory, not that the service being stopped and deleted belongs to it.
    # A stale or crafted unit with
    #     WorkingDirectory=/home/u/actions-runner/repo-b
    #     ExecStart=/home/u/actions-runner/repo-a/runsvc.sh
    # passed on the WorkingDirectory line, so repo B's sweep would stop, disable
    # and delete repo A's service. Round 2 moved ownership from name-based to
    # path-based; the proof still had to become an AND, because the operation it
    # authorises is destructive. (External review round 3.)
    $workingDirs = @()
    $execStarts = @()
    foreach ($line in ($result.Output -split "`n")) {
        $trimmed = $line.Trim()
        if ($trimmed -match '^WorkingDirectory=(.*)$') { $workingDirs += $Matches[1] ; continue }
        if ($trimmed -match '^ExecStart=(.*)$') { $execStarts += $Matches[1] }
    }

    # Ambiguity is refusal, not a best guess. systemd allows repeated ExecStart
    # and a resetting empty assignment; a unit using those is outside the vendor
    # shape this script installs, so we decline rather than pick one.
    if ($workingDirs.Count -ne 1 -or $execStarts.Count -ne 1) {
        Write-Host "Unit '$Unit' has $($workingDirs.Count) WorkingDirectory and $($execStarts.Count) ExecStart directives (expected exactly one of each). Refusing to claim ownership." -ForegroundColor Yellow
        return $false
    }

    $wd = $workingDirs[0].Trim().Trim('"', "'").TrimEnd('/')
    # ExecStart may carry arguments and prefix characters (@ - : + ! ), none of
    # which this script's own units use. Their presence means a shape we did not
    # write, so refuse rather than parse around them.
    $execRaw = $execStarts[0].Trim()
    if ($execRaw -match '^[@\-:+!]') {
        Write-Host "Unit '$Unit' uses a prefixed ExecStart ('$execRaw'). Refusing to claim ownership." -ForegroundColor Yellow
        return $false
    }
    $execPath = Get-SystemdExecPath -ExecStart $execRaw
    if ([string]::IsNullOrEmpty($execPath)) {
        Write-Host "Unit '$Unit' has an ExecStart this script cannot parse unambiguously ('$execRaw'). Refusing to claim ownership." -ForegroundColor Yellow
        return $false
    }

    $wdMatches = ($wd -eq $canonDir)
    $execMatches = ($execPath -eq $canonDir -or $execPath.StartsWith("$canonDir/"))
    if (-not ($wdMatches -and $execMatches)) {
        Write-Host "Unit '$Unit' does not belong to '$canonDir' (WorkingDirectory='$wd', ExecStart='$execPath'). Refusing." -ForegroundColor Yellow
        return $false
    }
    return $true
}

function Get-RunnerServiceUnit {
    param(
        [Parameter(Mandatory = $true)][string]$Distro,
        [Parameter(Mandatory = $true)][string]$WorkDir,
        [Parameter(Mandatory = $true)][string]$RepoSlug
    )
    # PRIMARY: the work dir's own .service marker -- but as a CANDIDATE only.
    # It previously returned on any syntactically plausible unit name, so a
    # stale or hand-edited .service in repo B's dir naming repo A's unit sent
    # the residue sweep at repo A's service: it stopped, disabled and DELETED
    # it, and "verified" success. Scoping only the fallback left the
    # higher-priority path as an open door (external review round 2).
    $quotedDir = ConvertTo-BashSingleQuoted $WorkDir
    $fromFile = Invoke-WslBash -Distro $Distro -Command "cat $quotedDir/.service 2>/dev/null"
    $candidate = $fromFile.Output.Trim()
    if ($fromFile.ExitCode -eq 0 -and $candidate -match '^actions\.runner\.[^/]+\.service$') {
        if (Test-UnitBelongsToWorkDir -Distro $Distro -Unit $candidate -WorkDir $WorkDir) {
            return $candidate
        }
        Write-Host "Ignoring '$WorkDir/.service': it names '$candidate', whose unit file does not point at this work dir (stale or hand-edited). Falling back to scoped enumeration." -ForegroundColor Yellow
    }

    # FALLBACK: enumerate, filter by slug, and apply the SAME work-dir proof --
    # a name prefix alone is a hint, not ownership.
    $enumerate = Invoke-WslBash -Distro $Distro -Command "ls /etc/systemd/system/actions.runner.*.service 2>/dev/null"
    $slugPrefix = ("actions.runner.$RepoSlug.").ToLowerInvariant()
    $verified = @()
    foreach ($line in ($enumerate.Output -split "`n")) {
        $m = [regex]::Match($line.Trim(), '/etc/systemd/system/(actions\.runner\.[^/\s]+\.service)$')
        if (-not $m.Success) { continue }
        $unitName = $m.Groups[1].Value
        if (-not $unitName.ToLowerInvariant().StartsWith($slugPrefix)) { continue }
        if (Test-UnitBelongsToWorkDir -Distro $Distro -Unit $unitName -WorkDir $WorkDir) {
            $verified += $unitName
        }
    }
    if ($verified.Count -eq 1) { return $verified[0] }
    if ($verified.Count -gt 1) {
        Write-Host "Found $($verified.Count) units matching '$slugPrefix*' that resolve to this work dir -- ambiguous, refusing to pick one: $($verified -join ', ')" -ForegroundColor Yellow
    }
    return $null
}

# -- Partial-install residue (the C22 state) ---------------------------------
#
# A missing '.runner' means no REGISTRATION, not no residue. The C22 spike
# produced precisely this: the runner tarball extracted, config.sh timed out,
# so a large work dir existed with no '.runner'. -Uninstall used to report
# "nothing to uninstall" and exit 0 in that state, leaving the operator to
# clean up the one case the script most needs to handle.
#
# $WorkDir reaching here has already passed Resolve-DistroWorkDir AND
# Assert-WorkDirCanonicalWithinFloor in the main flow, so it is bounded to the
# distro's own filesystem and cannot be $HOME, '/' or /mnt/*.
function Get-PartialInstallResidue {
    param(
        [Parameter(Mandatory = $true)][string]$Distro,
        [Parameter(Mandatory = $true)][string]$WorkDir,
        [Parameter(Mandatory = $true)][string]$TaskName,
        [Parameter(Mandatory = $true)][string]$RepoSlug
    )
    $quoted = ConvertTo-BashSingleQuoted $WorkDir
    # Dir existence + extract check in one round trip. The unit is resolved
    # SCOPED (work-dir .service file, else exactly-one slug match) -- the
    # previous global `ls actions.runner.*.service | head -1` would, on a
    # two-runner machine, happily select the OTHER repository's unit and hand
    # it to the sweep for deletion.
    $probeCmd = "if [ -d $quoted ]; then echo DIR_YES; else echo DIR_NO; fi; " +
                "if [ -f $quoted/config.sh ]; then echo EXTRACT_YES; else echo EXTRACT_NO; fi"
    $probe = Invoke-WslBash -Distro $Distro -Command $probeCmd

    $items = @()
    $workDirExists = $probe.Output -match 'DIR_YES'
    $looksLikeExtract = $probe.Output -match 'EXTRACT_YES'
    $serviceUnit = Get-RunnerServiceUnit -Distro $Distro -WorkDir $WorkDir -RepoSlug $RepoSlug

    if ($workDirExists) {
        $sizeProbe = Invoke-WslBash -Distro $Distro -Command "du -sh $quoted 2>/dev/null | cut -f1"
        $size = ($sizeProbe.Output -split "`n" | Where-Object { $_ -match '\S' } | Select-Object -First 1)
        $descriptor = if ($looksLikeExtract) { 'runner extract, config.sh present' } else { 'present but NOT a recognisable runner extract' }
        $items += "work dir '$WorkDir' inside '$Distro' ($descriptor$(if ($size) { ", $($size.Trim())" }))"
    }
    if ($serviceUnit) { $items += "systemd unit '$serviceUnit' inside '$Distro'" }

    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) { $items += "Task Scheduler task '$TaskName' (Windows, AtStartup/SYSTEM)" }

    return [PSCustomObject]@{
        Found            = ($items.Count -gt 0)
        Items            = $items
        WorkDirExists    = $workDirExists
        LooksLikeExtract = $looksLikeExtract
        ServiceUnit      = $serviceUnit
        TaskExists       = [bool]$task
    }
}

function Remove-PartialInstallResidue {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true)][string]$Distro,
        [Parameter(Mandatory = $true)][string]$WorkDir,
        [Parameter(Mandatory = $true)][string]$TaskName,
        [Parameter(Mandatory = $true)][PSCustomObject]$Residue
    )
    if (-not $PSCmdlet.ShouldProcess("partial-install residue for '$WorkDir' in '$Distro'", 'Remove')) { return }

    if ($Residue.ServiceUnit) {
        # AS ROOT, never sudo, exit code CHECKED, absence VERIFIED. This block
        # previously did all three wrong at once: it kept `sudo` after the rest
        # of the file had moved to `wsl -u root` (a non-interactive shell cannot
        # answer sudo's password prompt, the exact condition that motivated the
        # move), piped the result to Out-Null, and then printed success --
        # so on a stock Ubuntu it would claim "Removed systemd unit" while the
        # unit stayed installed and could restart the runner. Reported by
        # external review, 2026-07-29.
        #
        # The service-removal verdict is established BEFORE the auto-start task
        # or the work dir are touched: throwing here leaves the rest of the
        # residue in place for inspection rather than half-cleaning around a
        # still-installed service.
        $quotedUnit = ConvertTo-BashSingleQuoted $Residue.ServiceUnit

        # STOP FIRST, and prove it stopped. The previous version swallowed both
        # stop and disable failures with `|| true` and then verified only that
        # the unit FILE was gone -- so on a degraded systemd (or a stuck unit,
        # or no connection to the manager) the stop silently failed, the file
        # was deleted, absence "verified", and the sweep went on to delete the
        # work directory out from under a STILL-RUNNING runner process while
        # reporting the residue cleared. Especially reachable here, because
        # uninstall deliberately skips the systemd health precondition.
        # (External review round 2.)
        #
        # `is-active` is the authority. Its exit code is non-zero for inactive,
        # failed AND unknown, so the OUTPUT is what distinguishes them: any of
        # inactive / failed / unknown means "not running", which is what the
        # sweep needs. "unit does not exist" is success; "exists and would not
        # stop" is a hard stop.
        # `deactivating` is shutdown IN PROGRESS, not shutdown complete. It was
        # previously in the accepted set, so a slow or stuck stop let the sweep
        # proceed to delete $WorkDir while the runner process was still
        # executing out of it. `systemctl stop` can return before the unit
        # reaches a terminal state, so the state must be POLLED to a terminal
        # one rather than sampled once. (External review round 3.)
        Invoke-WslBash -Distro $Distro -AsRoot -Command "systemctl stop $quotedUnit 2>&1" | Out-Null
        $activeState = $null
        for ($attempt = 1; $attempt -le 15; $attempt++) {
            $probeState = Invoke-WslBash -Distro $Distro -AsRoot -Command "systemctl is-active $quotedUnit 2>&1 | head -1"
            $activeState = ($probeState.Output -split "`n" | Where-Object { $_ -match '\S' } | Select-Object -Last 1)
            if ($null -ne $activeState) { $activeState = $activeState.Trim() }
            if (Test-SystemdStateStopped -State $activeState) { break }
            Start-Sleep -Seconds 2
        }
        if (-not (Test-SystemdStateStopped -State $activeState)) {
            throw "Refusing to continue the sweep: systemd unit '$($Residue.ServiceUnit)' is still '$activeState' after a stop attempt and 30s of polling. It may still be RUNNING, and deleting its work directory now would pull the filesystem out from under a live runner. Investigate with: wsl -d $Distro -u root -- systemctl status $($Residue.ServiceUnit)"
        }
        # Belt and braces: a terminal state should mean no process, but the work
        # dir is about to be deleted, so confirm no MainPID survives.
        $pidProbe = Invoke-WslBash -Distro $Distro -AsRoot -Command "systemctl show $quotedUnit -p MainPID --value 2>/dev/null | head -1"
        $mainPid = ($pidProbe.Output -split "`n" | Where-Object { $_ -match '\S' } | Select-Object -First 1)
        if ($null -ne $mainPid) { $mainPid = $mainPid.Trim() }
        if ($mainPid -match '^\d+$' -and $mainPid -ne '0') {
            throw "Refusing to continue the sweep: systemd reports MainPID $mainPid still alive for '$($Residue.ServiceUnit)' despite state '$activeState'. Deleting the work directory now would remove the filesystem beneath a live process."
        }

        $svcRemove = Invoke-WslBash -Distro $Distro -AsRoot -Command "(systemctl disable $quotedUnit || true) && rm -f /etc/systemd/system/$quotedUnit && systemctl daemon-reload"
        if ($svcRemove.ExitCode -ne 0) {
            throw "Removing systemd unit '$($Residue.ServiceUnit)' failed (exit $($svcRemove.ExitCode)) -- stopping before the auto-start task or work dir are touched:`n$($svcRemove.Output)"
        }
        # Both conditions, not just the file: absent from disk AND not active.
        $verify = Invoke-WslBash -Distro $Distro -AsRoot -Command "test ! -e /etc/systemd/system/$quotedUnit && echo UNIT_GONE; systemctl is-active $quotedUnit 2>&1 | head -1"
        if ($verify.Output -notmatch 'UNIT_GONE') {
            throw "Systemd unit '$($Residue.ServiceUnit)' still exists after removal -- refusing to report success or continue the sweep."
        }
        $finalState = ($verify.Output -split "`n" | Where-Object { $_ -match '\S' } | Select-Object -Last 1)
        if ($null -ne $finalState) { $finalState = $finalState.Trim() }
        # Same classifier as the stop gate above -- this previously rejected only
        # `^active`, so a unit still reporting `deactivating` passed the final
        # check too, which is the second half of the same defect.
        if (-not (Test-SystemdStateStopped -State $finalState)) {
            throw "Systemd unit '$($Residue.ServiceUnit)' reports non-terminal state '$finalState' after its unit file was removed -- the runner process may still be live. Refusing to delete the work directory beneath it."
        }
        Write-Host "Removed systemd unit '$($Residue.ServiceUnit)' (verified: file absent, service not active)." -ForegroundColor Green
    }

    if ($Residue.TaskExists) {
        Unregister-RunnerAutoStart -TaskName $TaskName
    }

    if ($Residue.WorkDirExists) {
        if (-not $Residue.LooksLikeExtract) {
            # Refuse rather than guess. Without '.runner' OR 'config.sh' there is
            # no evidence this directory belongs to a runner, and deleting an
            # operator directory that merely shares the configured path is worse
            # than leaving residue behind.
            Write-Host ""
            Write-Host "NOT deleting '$WorkDir': it exists but contains no 'config.sh', so nothing proves it is a runner install." -ForegroundColor Yellow
            Write-Host "Inspect and remove it by hand if you are certain:" -ForegroundColor Yellow
            Write-Host "  wsl -d $Distro -- ls -la '$WorkDir'" -ForegroundColor Yellow
        } else {
            $quotedDelete = ConvertTo-BashSingleQuoted $WorkDir
            $del = Invoke-WslBash -Distro $Distro -Command "rm -rf -- $quotedDelete"
            if ($del.ExitCode -ne 0) { throw "Deleting work dir '$WorkDir' failed:`n$($del.Output)" }
            Write-Host "Deleted work dir '$WorkDir'." -ForegroundColor Green
        }
    }

    Write-Host ""
    Write-Host "Partial-install residue cleared. No GitHub-side registration existed, so nothing was deregistered." -ForegroundColor Green
    Write-Host "Confirm the repo has no orphaned runner: gh api repos/$Repo/actions/runners --jq '.total_count'" -ForegroundColor Cyan
}

# -- Mode: fresh install -----------------------------------------------------

function Install-Runner {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true)][string]$Repo,
        [Parameter(Mandatory = $true)][string]$Distro,
        [Parameter(Mandatory = $true)][string]$WorkDir,
        [Parameter(Mandatory = $true)][string]$RunnerName,
        [Parameter(Mandatory = $true)][string]$LabelsCsv,
        [System.Security.SecureString]$Token
    )
    $secureToken = Read-RegistrationToken -Repo $Repo -Purpose 'registration' -Provided $Token
    $plainToken = ConvertFrom-SecureStringPlain -Secure $secureToken

    Write-Section "Install plan for $Repo"
    Write-Host "  1. Resolve latest actions/runner release version (gh api, Windows side)"
    Write-Host "  2. Inside '$Distro': create '$WorkDir', download + extract the runner tarball"
    Write-Host "  3. Inside '$Distro': ./config.sh --url https://github.com/$Repo --name $RunnerName --labels $LabelsCsv --work _work --unattended"
    Write-Host "  4. Inside '$Distro' AS ROOT (not sudo -- a non-interactive shell cannot answer a password prompt):"
    Write-Host "     ./svc.sh install <default-user> && ./svc.sh start"
    Write-Host "  5. Register a Task Scheduler auto-start task ('$TaskName')"
    Write-Host "  6. Verify via gh api repos/$Repo/actions/runners"

    if (-not $PSCmdlet.ShouldProcess("$Repo (work dir '$WorkDir' in '$Distro')", 'Install and register GitHub Actions runner')) {
        return
    }

    try {
        $release = Invoke-NativeCapture -FilePath 'gh' -ArgumentList @('api', 'repos/actions/runner/releases/latest', '--jq', '.tag_name')
        $versionTag = $release.Output
        if ($release.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($versionTag)) {
            throw "Could not resolve latest actions/runner release via gh api: $versionTag"
        }
        $versionTag = $versionTag.Trim()
        $version = $versionTag.TrimStart('v').Trim()
        $tarball = "actions-runner-linux-x64-$version.tar.gz"
        $downloadUrl = "https://github.com/actions/runner/releases/download/$versionTag/$tarball"

        $quotedWorkDir = ConvertTo-BashSingleQuoted $WorkDir
        $quotedUrl = ConvertTo-BashSingleQuoted "https://github.com/$Repo"
        $quotedName = ConvertTo-BashSingleQuoted $RunnerName
        $quotedLabels = ConvertTo-BashSingleQuoted $LabelsCsv
        $quotedDownload = ConvertTo-BashSingleQuoted $downloadUrl
        $quotedTarball = ConvertTo-BashSingleQuoted $tarball

        $setupCmd = "set -e && mkdir -p $quotedWorkDir && cd $quotedWorkDir && curl -fsSL -o $quotedTarball $quotedDownload && tar xzf $quotedTarball && rm -f $quotedTarball"
        $setupResult = Invoke-WslBash -Distro $Distro -Command $setupCmd
        if ($setupResult.ExitCode -ne 0) { throw "Runner download/extract failed:`n$($setupResult.Output)" }

        $quotedToken = ConvertTo-BashSingleQuoted $plainToken
        $configCmd = "cd $quotedWorkDir && ./config.sh --url $quotedUrl --token $quotedToken --name $quotedName --labels $quotedLabels --work _work --unattended --replace"
        $configResult = Invoke-WslBash -Distro $Distro -Command $configCmd
        if ($configResult.ExitCode -ne 0) { throw "config.sh registration failed:`n$($configResult.Output)" }

        # Run the service install AS ROOT, never via `sudo`.
        #
        # `sudo ./svc.sh install` is issued through a NON-INTERACTIVE `bash -lc`,
        # which cannot answer a password prompt. On any distro whose default user
        # lacks passwordless sudo -- the Ubuntu default -- this stalls or fails at
        # exactly this step, AFTER config.sh has already registered the runner with
        # GitHub. The result is the partial-install state: a registered runner with
        # no service, permanently `offline`, putting a never-satisfied check on
        # every gated PR. Observed on the reference machine, where `sudo -n true`
        # returns "a password is required".
        #
        # `wsl -u root` needs no password and is deterministic, so the elevation
        # cannot depend on the distro's sudoers policy. svc.sh needs the target
        # user explicitly here, because running as root makes it default to root
        # and the runner must not execute jobs as root.
        # `id -un` deliberately, not `printf %s "$USER"`: no payload in this file
        # may contain a double quote (a quoted payload does not survive the argv
        # hop to bash), and this form needs no quoting at all.
        $runAsUserProbe = Invoke-WslBash -Distro $Distro -Command 'id -un'
        $runAsUser = $runAsUserProbe.Output.Trim()
        if ([string]::IsNullOrWhiteSpace($runAsUser) -or $runAsUser -eq 'root') {
            throw "Could not determine the distro's non-root default user (got '$runAsUser'). Refusing to install the runner service, because it would run jobs as root."
        }
        $quotedRunAsUser = ConvertTo-BashSingleQuoted $runAsUser
        $serviceCmd = "cd $quotedWorkDir && ./svc.sh install $quotedRunAsUser && ./svc.sh start"
        $serviceResult = Invoke-WslBash -Distro $Distro -Command $serviceCmd -AsRoot
        if ($serviceResult.ExitCode -ne 0) { throw "svc.sh install/start failed:`n$($serviceResult.Output)" }

        # Scoped unit discovery -- NEVER a global first-match. `grep '^actions\.
        # runner\.' | head -n1` returned whichever runner unit sorted first, so
        # on a machine with runners for two repositories the auto-start task for
        # repo B could be wired to start repo A's service. Primary source of
        # truth: svc.sh writes the exact unit name into `$WorkDir/.service` at
        # install time -- per-work-dir by construction, no matching needed.
        # Fallback: filter all units by this repo's slug and require EXACTLY
        # one; zero or several means we do not guess.
        $serviceUnit = Get-RunnerServiceUnit -Distro $Distro -WorkDir $WorkDir -RepoSlug $RepoSlug
        if ([string]::IsNullOrWhiteSpace($serviceUnit)) {
            Write-Host "Could not determine THIS repo's systemd unit unambiguously; auto-start task will not be registered automatically. Inspect with: wsl -d $Distro -u root -- systemctl list-unit-files | grep actions.runner" -ForegroundColor Yellow
        } else {
            Write-Host "Service unit: $serviceUnit"
            Register-RunnerAutoStart -TaskName $TaskName -Distro $Distro -ServiceUnit $serviceUnit
        }
    } finally {
        $plainToken = $null
        [System.GC]::Collect()
    }

    Show-RunnerStatus -Repo $Repo -ExpectedName $RunnerName | Out-Null
}

# -- Mode: repair (remove + reinstall) ---------------------------------------

function Repair-Runner {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true)][string]$Repo,
        [Parameter(Mandatory = $true)][string]$Distro,
        [Parameter(Mandatory = $true)][string]$WorkDir,
        [Parameter(Mandatory = $true)][string]$RunnerName,
        [Parameter(Mandatory = $true)][string]$LabelsCsv,
        [System.Security.SecureString]$Token
    )
    Write-Section "Repair plan for $Repo"
    Write-Host "  1. Stop + uninstall the existing service inside '$Distro'"
    Write-Host "  2. Deregister the existing runner from GitHub (removal token)"
    Write-Host "  3. Delete '$WorkDir' (and nothing outside it)"
    Write-Host "  4. Run a fresh install (see Install plan)"

    if (-not $PSCmdlet.ShouldProcess("$Repo (work dir '$WorkDir' in '$Distro')", 'Repair (remove + re-register) GitHub Actions runner')) {
        return
    }

    $removalToken = Read-RegistrationToken -Repo $Repo -Purpose 'removal' -Provided $Token
    $plainRemovalToken = ConvertFrom-SecureStringPlain -Secure $removalToken
    try {
        $quotedWorkDir = ConvertTo-BashSingleQuoted $WorkDir
        $quotedRemovalToken = ConvertTo-BashSingleQuoted $plainRemovalToken
        # Split deliberately into two invocations with DIFFERENT privilege.
        #
        # svc.sh needs root (same reason as the install path: a non-interactive
        # `bash -lc` cannot answer a sudo password prompt, so `sudo` stalls on a
        # distro without passwordless sudo and leaves a half-removed service).
        # config.sh must NOT run as root -- it rewrites the runner's own config
        # and credential files, and doing that as root leaves them root-owned,
        # so a later re-install by the runner user fails on permissions.
        # Collapsing both into one root call would trade one silent breakage for
        # another.
        $svcStopCmd = "cd $quotedWorkDir && (./svc.sh stop || true) && (./svc.sh uninstall || true)"
        $svcStopResult = Invoke-WslBash -Distro $Distro -Command $svcStopCmd -AsRoot
        if ($svcStopResult.ExitCode -ne 0) {
            Write-Host "svc.sh stop/uninstall reported a non-zero exit; continuing to deregistration so the GitHub-side runner is not orphaned:`n$($svcStopResult.Output)" -ForegroundColor Yellow
        }

        $removeCmd = "cd $quotedWorkDir && ./config.sh remove --token $quotedRemovalToken"
        $removeResult = Invoke-WslBash -Distro $Distro -Command $removeCmd
        if ($removeResult.ExitCode -ne 0) { throw "Removal failed:`n$($removeResult.Output)" }
    } finally {
        $plainRemovalToken = $null
        [System.GC]::Collect()
    }

    Assert-RunnerWorkDirBeforeDelete -Distro $Distro -WorkDir $WorkDir
    $quotedWorkDirForDelete = ConvertTo-BashSingleQuoted $WorkDir
    $deleteResult = Invoke-WslBash -Distro $Distro -Command "rm -rf -- $quotedWorkDirForDelete"
    if ($deleteResult.ExitCode -ne 0) { throw "Deleting work dir failed:`n$($deleteResult.Output)" }
    Write-Host "Removed existing registration and deleted '$WorkDir'." -ForegroundColor Green

    Install-Runner -Repo $Repo -Distro $Distro -WorkDir $WorkDir -RunnerName $RunnerName -LabelsCsv $LabelsCsv -Token $null
}

# -- Mode: uninstall ----------------------------------------------------------

function Uninstall-Runner {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true)][string]$Repo,
        [Parameter(Mandatory = $true)][string]$Distro,
        [Parameter(Mandatory = $true)][string]$WorkDir,
        [System.Security.SecureString]$Token
    )
    Write-Section "Uninstall plan for $Repo"
    Write-Host "  1. Stop + uninstall the service inside '$Distro'"
    Write-Host "  2. Deregister the runner from GitHub (removal token)"
    Write-Host "  3. Delete '$WorkDir' (and nothing outside it)"
    Write-Host "  4. Remove the Task Scheduler auto-start task ('$TaskName')"
    Write-Host "  5. Confirm absence via gh api repos/$Repo/actions/runners"

    if (-not $PSCmdlet.ShouldProcess("$Repo (work dir '$WorkDir' in '$Distro')", 'Uninstall GitHub Actions runner')) {
        return
    }

    $removalToken = Read-RegistrationToken -Repo $Repo -Purpose 'removal' -Provided $Token
    $plainRemovalToken = ConvertFrom-SecureStringPlain -Secure $removalToken
    try {
        $quotedWorkDir = ConvertTo-BashSingleQuoted $WorkDir
        $quotedRemovalToken = ConvertTo-BashSingleQuoted $plainRemovalToken
        # Split deliberately into two invocations with DIFFERENT privilege.
        #
        # svc.sh needs root (same reason as the install path: a non-interactive
        # `bash -lc` cannot answer a sudo password prompt, so `sudo` stalls on a
        # distro without passwordless sudo and leaves a half-removed service).
        # config.sh must NOT run as root -- it rewrites the runner's own config
        # and credential files, and doing that as root leaves them root-owned,
        # so a later re-install by the runner user fails on permissions.
        # Collapsing both into one root call would trade one silent breakage for
        # another.
        $svcStopCmd = "cd $quotedWorkDir && (./svc.sh stop || true) && (./svc.sh uninstall || true)"
        $svcStopResult = Invoke-WslBash -Distro $Distro -Command $svcStopCmd -AsRoot
        if ($svcStopResult.ExitCode -ne 0) {
            Write-Host "svc.sh stop/uninstall reported a non-zero exit; continuing to deregistration so the GitHub-side runner is not orphaned:`n$($svcStopResult.Output)" -ForegroundColor Yellow
        }

        $removeCmd = "cd $quotedWorkDir && ./config.sh remove --token $quotedRemovalToken"
        $removeResult = Invoke-WslBash -Distro $Distro -Command $removeCmd
        if ($removeResult.ExitCode -ne 0) { throw "Removal failed:`n$($removeResult.Output)" }
    } finally {
        $plainRemovalToken = $null
        [System.GC]::Collect()
    }

    Assert-RunnerWorkDirBeforeDelete -Distro $Distro -WorkDir $WorkDir
    $quotedWorkDirForDelete = ConvertTo-BashSingleQuoted $WorkDir
    $deleteResult = Invoke-WslBash -Distro $Distro -Command "rm -rf -- $quotedWorkDirForDelete"
    if ($deleteResult.ExitCode -ne 0) { throw "Deleting work dir failed:`n$($deleteResult.Output)" }

    Unregister-RunnerAutoStart -TaskName $TaskName
    Write-Host "Uninstalled runner for $Repo and deleted '$WorkDir'." -ForegroundColor Green
    Show-RunnerStatus -Repo $Repo | Out-Null
}

# -- Main ---------------------------------------------------------------------

Write-Section "install-runner.ps1 -- $Repo"
Write-Host "  Distro:      $WslDistro"
Write-Host "  Work dir:    $WorkDir (inside the distro; any '~' is resolved against its `$HOME at run time)"
Write-Host "  Runner name: $RunnerName"
Write-Host "  Labels:      $LabelsCsv"
Write-Host "  Mode:        $(if ($Uninstall) { 'uninstall' } elseif ($Repair) { 'repair' } else { 'install (or verify if already registered)' })"

$hostReady = Show-HostPreconditions -Distro $WslDistro -Repo $Repo -RemovalMode:$Uninstall
if (-not $hostReady) {
    exit 1
}

if ($WhatIfPreference) {
    Write-Section "WhatIf: plan only, nothing executed"
    Write-Host "Deep checks (Docker reachability, systemd status inside '$WslDistro', reading any"
    Write-Host "existing '.runner' registration) are skipped under -WhatIf so this preview never"
    Write-Host "starts the WSL2 VM. They run for real on a non-WhatIf invocation."
    Write-Host "For the same reason the work dir below is shown UNRESOLVED: a leading '~' is"
    Write-Host "expanded against the distro's `$HOME only on a real run, so the paths printed"
    Write-Host "here are the requested form, not the final absolute one."
    Write-Host ""
    if ($Uninstall) {
        Write-Host "Would run the UNINSTALL plan: stop+uninstall the service, deregister from"
        Write-Host "GitHub (removal token), delete '$WorkDir', remove Task Scheduler task '$TaskName',"
        Write-Host "then confirm absence via gh api."
        Write-Host "If NO '.runner' registration is found, would instead sweep partial-install residue"
        Write-Host "(the C22 state: extracted work dir, systemd unit, auto-start task, no registration)."
        Write-Host "The work dir is deleted in that sweep only when it contains 'config.sh'; otherwise it"
        Write-Host "is reported and left alone rather than guessed at."
    } elseif ($Repair) {
        Write-Host "Would run the REPAIR plan: remove the existing registration at '$WorkDir', then"
        Write-Host "the full INSTALL plan (see below) against the same repo."
    } else {
        Write-Host "Would check '$WorkDir/.runner' inside '$WslDistro':"
        Write-Host "  - if it matches '$Repo' already: no-op, just re-verify + re-echo via gh api"
        Write-Host "  - if it matches a DIFFERENT repo: HARD ERROR, no changes"
        Write-Host "  - if absent: run the INSTALL plan -- download the runner, register via"
        Write-Host "    config.sh, install+start the systemd service via svc.sh, register a"
        Write-Host "    Task Scheduler auto-start task, then verify via gh api."
    }
    exit 0
}

# Deep preconditions guard the INSTALL. Removal needs none of them: Docker has
# no part in deregistering a runner, and the removal command already tolerates
# `svc.sh stop`/`svc.sh uninstall` failing (both are `|| true`), which is the
# only thing systemd is needed for. Requiring them on the removal path blocked
# cleanup in exactly the degraded states that make cleanup necessary -- a
# stopped Docker Desktop, or a distro that lost systemd, left the operator
# unable to remove a persistent self-hosted runner at all. This is the same
# class as the private-repo check skipped in Show-HostPreconditions above.
if ($Uninstall) {
    Write-Section "Deep preconditions skipped (removal path)"
    Write-Host "Docker reachability and systemd status are install-time requirements. Removal does not" -ForegroundColor DarkGray
    Write-Host "need them, and enforcing them here would block cleanup precisely when the machine is" -ForegroundColor DarkGray
    Write-Host "already degraded. The WSL2 distro check above still applies -- it is what runs the removal." -ForegroundColor DarkGray
} else {
    $deepReady = Show-DeepPreconditions -Distro $WslDistro
    if (-not $deepReady) {
        exit 1
    }
}

# Must happen before ANY use of $WorkDir in a bash payload -- see
# Resolve-DistroWorkDir for why a bare '~' would otherwise create a literal
# '~' directory under the Windows CWD. Deliberately after the -WhatIf
# early-exit above: reading $HOME starts the WSL2 VM.
$DistroHome = Get-DistroHome -Distro $WslDistro
$WorkDir = Resolve-DistroWorkDir -Path $WorkDir -HomeDir $DistroHome
# The floor above is lexical; this asks the distro what the path really points
# at and re-applies the same floor to that answer, so a symlink into /mnt (or
# at $HOME, or at /) cannot walk the install and its later `rm -rf` off the
# distro's own filesystem.
Assert-WorkDirCanonicalWithinFloor -Distro $WslDistro -WorkDir $WorkDir -HomeDir $DistroHome
Write-Host "  Work dir resolved to: $WorkDir" -ForegroundColor DarkGray

$existingConfig = Get-ExistingRunnerConfig -Distro $WslDistro -WorkDir $WorkDir

if ($Uninstall) {
    if ($null -eq $existingConfig) {
        # No '.runner' means no REGISTRATION -- it does not mean no residue.
        # The C22 spike produced exactly this state: the tarball extracted and
        # config.sh timed out, so a 666 MB work dir (and potentially an
        # auto-start task) existed with no '.runner' at all. The previous code
        # printed "nothing to uninstall" and exited 0, leaving the operator to
        # clean up by hand the one state this script most needs to handle.
        Write-Host "No runner registration ('.runner') at '$WorkDir' in '$WslDistro'." -ForegroundColor Yellow
        Write-Host "Checking for partial-install residue (interrupted install, or a prior failed config.sh)..." -ForegroundColor Yellow

        $residue = Get-PartialInstallResidue -Distro $WslDistro -WorkDir $WorkDir -TaskName $TaskName -RepoSlug $RepoSlug
        if (-not $residue.Found) {
            Write-Host "Nothing to uninstall: no registration, no work dir, no auto-start task, no service unit." -ForegroundColor Green
            exit 0
        }

        Write-Host ""
        Write-Host "Partial-install residue found:" -ForegroundColor Yellow
        foreach ($item in $residue.Items) { Write-Host "  - $item" }
        Remove-PartialInstallResidue -Distro $WslDistro -WorkDir $WorkDir -TaskName $TaskName -Residue $residue
        exit 0
    }
    Assert-NoWrongRepoRegistration -ExistingConfig $existingConfig -ExpectedRepo $Repo | Out-Null
    Uninstall-Runner -Repo $Repo -Distro $WslDistro -WorkDir $WorkDir -Token $Token
    exit 0
}

if ($Repair) {
    if ($null -eq $existingConfig) {
        Write-Error "Nothing registered at '$WorkDir' in '$WslDistro' -- there is nothing to repair. Drop -Repair to run a fresh install."
        exit 1
    }
    Assert-NoWrongRepoRegistration -ExistingConfig $existingConfig -ExpectedRepo $Repo | Out-Null
    Repair-Runner -Repo $Repo -Distro $WslDistro -WorkDir $WorkDir -RunnerName $RunnerName -LabelsCsv $LabelsCsv -Token $Token
    exit 0
}

# Default mode: install, or idempotent no-op-with-confirmation if already
# registered to this same repo.
if ($null -ne $existingConfig) {
    Assert-NoWrongRepoRegistration -ExistingConfig $existingConfig -ExpectedRepo $Repo | Out-Null
    Write-Host ""
    Write-Host "Already registered to $Repo at '$WorkDir' -- no changes made (idempotent)." -ForegroundColor Green
    Show-RunnerStatus -Repo $Repo -ExpectedName $existingConfig.agentName | Out-Null
    exit 0
}

Install-Runner -Repo $Repo -Distro $WslDistro -WorkDir $WorkDir -RunnerName $RunnerName -LabelsCsv $LabelsCsv -Token $Token
