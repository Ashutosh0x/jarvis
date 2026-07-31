; Uninstall hygiene for the `jarvis` terminal command.
;
; The app writes a launcher to %LOCALAPPDATA%\Jarvis\bin and adds that folder to
; the user's PATH (see setup/path.js). Uninstalling must not leave a `jarvis`
; command that runs a program which is no longer installed.
;
; SO THE LAUNCHER IS DELETED, AND THE PATH ENTRY IS DELIBERATELY LEFT ALONE.
;
; That asymmetry is the whole point of this file. Rewriting PATH from NSIS means
; string-surgery on a REG_EXPAND_SZ value that is often several kilobytes long,
; with no read-back and no backup — get it wrong and the user loses their PATH,
; which is a far worse outcome than the thing being cleaned up. A PATH entry
; pointing at an empty folder costs nothing: the command simply is not found.
;
; Anyone who wants it gone completely runs `jarvis unlink` before uninstalling,
; which does the removal with a backup and a verified read-back.

!macro customUnInstall
  ; Only the two things this app created. No recursive delete: the folder is
  ; removed by RMDir, which refuses when anything else is in it.
  Delete "$LOCALAPPDATA\Jarvis\bin\jarvis.cmd"
  Delete "$LOCALAPPDATA\Jarvis\bin\path-backup.txt"
  RMDir "$LOCALAPPDATA\Jarvis\bin"
  RMDir "$LOCALAPPDATA\Jarvis"
!macroend
