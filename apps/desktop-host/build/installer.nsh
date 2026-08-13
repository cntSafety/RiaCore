; Custom NSIS hooks for RiaCore installer
;
; CONTEXT
; -------
; electron-builder's built-in _CHECK_APP_RUNNING macro shows
; "App cannot be closed. Please close it manually and click Retry to continue."
; instead of force-killing the process tree. Electron apps also spawn helper
; processes (GPU, renderer, crashpad, and in our case a bundled Node.js sidecar
; at <install>\resources\node-sidecar\node.exe — see utility-process-manager.ts,
; plus a bundled git.exe at <install>\resources\git\cmd\git.exe spawned BY that
; sidecar — see git-binary-path.ts) whose open file handles cause the same error
; after the main exe is gone.
;
; THE FAILURE WE ARE FIXING
; -------------------------
; The "RiaCore cannot be closed" dialog users hit is NOT the built-in
; _CHECK_APP_RUNNING check (customCheckAppRunning below fully replaces it).
; It comes from electron-builder's uninstallOldVersion routine: on an in-place
; upgrade (or reinstall of the same version) the new installer runs the OLD
; uninstaller, which does `RMDir /r $INSTDIR`. If ANY file in the install dir is
; still locked, the delete fails, it retries 5x, then shows $(appCannotBeClosed)
; and the whole install aborts. The same lock makes a plain Settings -> Apps
; uninstall fail too.
;
; WHAT LOCKS FILES (asar: false → everything is a loose file)
;   * RiaCore.exe + Electron helper processes (main/GPU/renderer/utility)
;   * resources\node-sidecar\node.exe   (forked sidecar; may be orphaned)
;   * resources\git\cmd\git.exe         (child of the sidecar; orphaned more easily)
;   * native .node DB bindings loaded into the sidecar node.exe
;
; STRATEGY
; --------
; Kill EVERYTHING whose executable path is inside a RiaCore install directory,
; not just by image name. taskkill /T only walks an intact parent→child tree;
; a reparented (orphaned) node.exe or git.exe escapes it. Get-CimInstance reads
; ExecutablePath for every process (Get-Process .Path silently skips some) and
; works on Windows 11 24H2+ where WMIC was removed. Then VERIFY the main exe is
; actually gone before letting the uninstall/copy phase touch the files.
;
;   * customInit            — Warn the user, then force-kill the whole RiaCore
;                             footprint BEFORE the silent uninstall of the old
;                             version runs.
;   * customCheckAppRunning — Replace the broken built-in check in THIS installer
;                             and re-kill as a safety net before files are copied.
;   * customUnInit          — Same kill logic at the START of THIS version's
;                             uninstaller, so future silent upgrades and manual
;                             uninstalls release handles before deleting files.

; ── _RiaCoreKillAll ───────────────────────────────────────────────────────────
; Shared helper. Kills every process whose executable lives under a RiaCore
; install dir (covers RiaCore.exe, the sidecar node.exe, bundled git.exe, and any
; future helper), then waits and verifies the main process is gone so file
; handles are released before the installer/uninstaller deletes the directory.
;
; NSIS treats $ as a variable prefix — `$$` emits a literal `$` so PowerShell
; pipeline variables like `$_` survive into the rendered .nsi script.

!macro _RiaCoreKillAll
  ; 1. Fast first pass: force-kill the main process tree by image name.
  ;    /T also takes child node.exe / git.exe when the tree is still intact.
  nsExec::Exec `taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
  Pop $0   ; discard exit code — non-zero just means it was not running

  ; 2. Thorough pass: kill ANY process whose executable path is inside a RiaCore
  ;    install directory. Catches orphaned/reparented node.exe and git.exe that
  ;    step 1 missed. Path filter spares unrelated node/git from other apps.
  ;    Per-user installs live in %LocalAppData%\Programs\RiaCore; per-machine in
  ;    Program Files\RiaCore — both match '*\RiaCore\*'.
  nsExec::Exec `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $$_.ExecutablePath -and ($$_.ExecutablePath -like '*\RiaCore\*' -or $$_.ExecutablePath -like '*\node-sidecar\*') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  Pop $0

  ; 3. Verify the main exe is actually gone (up to ~6s) so handles are released
  ;    before the uninstall/copy phase runs. PowerShell exit code = process count.
  StrCpy $1 0
  riacore_wait_loop:
    Sleep 600
    nsExec::Exec `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "exit (@(Get-Process -Name 'RiaCore' -ErrorAction SilentlyContinue).Count)"`
    Pop $0
    StrCmp $0 "0" riacore_killed 0
    IntOp $1 $1 + 1
    IntCmp $1 10 riacore_killed riacore_wait_loop riacore_killed

  riacore_killed:
  ; 4. Final settle so the OS finishes releasing file handles on the dead procs.
  Sleep 1500
!macroend

; ── customInit ────────────────────────────────────────────────────────────────
; Fires at the very top of the NSIS .onInit function — before any file
; operations or upgrade-detection / silent-uninstall logic.

!macro customInit
  MessageBox MB_OKCANCEL|MB_ICONINFORMATION \
    "All running instances of RiaCore (if any) will be stopped automatically before installation continues.$\r$\n$\r$\nIf a previous version is installed it will be upgraded in place — no manual uninstall is required.$\r$\n$\r$\nIf installation fails, please uninstall RiaCore via Settings → Apps and run this installer again.$\r$\n$\r$\nClick OK to proceed or Cancel to abort." \
    IDOK kill_app IDCANCEL abort_install

  abort_install:
    Quit

  kill_app:
    !insertmacro _RiaCoreKillAll
!macroend

; ── customCheckAppRunning ─────────────────────────────────────────────────────
; Replaces the broken _CHECK_APP_RUNNING built-in. Called later in the install
; sequence (and from the uninstaller's un.checkAppRunning) when electron-builder
; checks whether the app is still running before overwriting/deleting its files.

!macro customCheckAppRunning
  ; Re-run the kill in case anything respawned between .onInit and the actual
  ; file-copy phase, or the old version's silent uninstall left helpers behind.
  !insertmacro _RiaCoreKillAll
  ; By NOT calling _CHECK_APP_RUNNING we bypass the broken built-in dialog.
!macroend

; ── customUnInit ──────────────────────────────────────────────────────────────
; Fires at the top of the uninstaller's .onInit — before un.install deletes
; files. Releases handles so both manual uninstalls and silent upgrade-time
; uninstalls succeed even if an orphan sidecar/git process is holding a lock.

!macro customUnInit
  !insertmacro _RiaCoreKillAll
!macroend

; ── customInstall / customUnInstall ──────────────────────────────────────────
; Required stubs — electron-builder's template guards against missing macros
; with !ifmacrodef, but declaring them explicitly avoids any edge-case warnings.

!macro customInstall
!macroend

!macro customUnInstall
!macroend
