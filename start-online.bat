@rem Stronghold Protocol one-click launcher (ASCII only: cmd parses this file in ANSI codepage,
@rem any non-ASCII byte here corrupts line parsing. All friendly messages are printed by the ps1.)
@rem
@rem Opens a 6-seat room by default. 4 players or fewer play the official game byte-for-byte:
@rem the match reads the JOINED player count, never the room capacity (docs/DESIGN.md section 25).
@rem To host a strict 4-seat server instead:  start-online.bat -MaxSeats 4
@rem By default this ALSO starts the Cloudflare fallback tunnel (zero Sakura traffic quota).
@rem To skip the tunnel and only use the Sakura fixed URLs:  start-online.bat -NoTunnel
@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-online.ps1" %*
echo.
echo [Invite links (tunnel + fixed URLs) copied to clipboard. Server runs independently, this window can be closed.]
echo [Tunnel address changes every restart - re-send it after each restart.]
cmd /k
