# T12 - reproducible build for the process-loopback native helper.
#
# There is no CMake on this machine, only raw MSVC (Visual Studio 2022 Build Tools, C++ workload).
# This script locates the toolchain via vswhere (falling back to this machine's known-good fixed
# install path, since `vswhere -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64` returns
# nothing for this particular Build Tools SKU even though the compiler genuinely works - a probable
# component-ID quirk, not worth chasing), then drives cl.exe/link.exe directly through vcvars64.bat.
#
# Usage:  powershell -File build.ps1              (Release, the default)
#         powershell -File build.ps1 -Configuration Debug
#
# Output: build/process-loopback-helper.exe (plus .obj/.pdb) - gitignored, never committed.

param(
  [ValidateSet('Release', 'Debug')]
  [string]$Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcDir = Join-Path $scriptDir 'src'
$outDir = Join-Path $scriptDir 'build'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function Find-VcVars64 {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  $candidateRoots = @()

  if (Test-Path $vswhere) {
    $found = & $vswhere -all -products '*' -property installationPath 2>$null
    if ($found) {
      $candidateRoots += ($found -split "`r?`n" | Where-Object { $_ -and (Test-Path $_) })
    }
  }

  # Known-good fallback for this exact machine, confirmed working (see the T12 task brief): vswhere's
  # own `-requires` component filter returns nothing for this Build Tools SKU, but the compiler is
  # genuinely present at this fixed path.
  $candidateRoots += 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools'

  foreach ($root in $candidateRoots) {
    $vcvars = Join-Path $root 'VC\Auxiliary\Build\vcvars64.bat'
    if (Test-Path $vcvars) { return $vcvars }
  }

  throw 'Could not locate vcvars64.bat under any detected Visual Studio / Build Tools installation.'
}

$vcvars64 = Find-VcVars64
Write-Host "Using toolchain: $vcvars64"

$sources = Get-ChildItem -Path $srcDir -Filter '*.cpp' | ForEach-Object { '"{0}"' -f $_.FullName }
if ($sources.Count -eq 0) { throw "No .cpp sources found under $srcDir" }

$outExe = Join-Path $outDir 'process-loopback-helper.exe'
$outPdb = Join-Path $outDir 'process-loopback-helper.pdb'

# /MT(d): statically link the CRT so the shipped helper has no dependency on a system-installed VC++
# redistributable. /W4: real warnings on, treated as informative (not fatal) since MIDL-generated SDK
# headers themselves are not warning-clean at /W4 on every SDK version. /EHsc: standard C++ exception
# model (used for this helper's own ProtocolError handling - never across a COM ABI boundary).
$crtFlag = if ($Configuration -eq 'Debug') { '/MTd /Zi /Od' } else { '/MT /O2' }
$defines = '/DUNICODE /D_UNICODE /D_CRT_SECURE_NO_WARNINGS'
$libs = 'mmdevapi.lib ole32.lib oleaut32.lib shlwapi.lib user32.lib advapi32.lib'

$sourcesArg = $sources -join ' '
# /Fo takes a directory and MSVC requires it end with a backslash - but a single backslash
# immediately before the closing quote is parsed as an escaped literal quote (standard Windows
# command-line argument rules), corrupting everything after it. Doubling the trailing backslash
# yields one literal backslash and a real closing quote (even backslash-count-before-quote rule).
$compileCmd = "cl /nologo /std:c++17 $crtFlag $defines /EHsc /W4 $sourcesArg " +
  "/Fo`"$outDir\\`" /Fe`"$outExe`" /link /PDB:`"$outPdb`" $libs"

# Routed through a throwaway .bat file rather than `cmd /c "<one giant quoted string>"` - PowerShell's
# native-argument passing does not escape embedded double quotes, and cmd.exe's own /c parsing strips
# only the outermost pair of quotes from the whole argument, silently corrupting an already-quoted
# path that itself contains spaces (this repo's own working directory has one). A .bat file sidesteps
# that quoting interaction entirely.
$batFile = Join-Path $outDir '_build.bat'
@"
@echo off
call "$vcvars64" >nul 2>nul
if errorlevel 1 exit /b 1
$compileCmd
"@ | Set-Content -Path $batFile -Encoding ASCII

Write-Host "Building $outExe ..."
cmd /c $batFile
if ($LASTEXITCODE -ne 0) {
  throw "Build failed (cl/link exit code $LASTEXITCODE)"
}
Remove-Item -Force $batFile -ErrorAction SilentlyContinue

if (-not (Test-Path $outExe)) {
  throw "Build reported success but $outExe does not exist"
}

Write-Host "Built: $outExe"
