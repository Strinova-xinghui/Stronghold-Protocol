@rem Stronghold Protocol FALLBACK tunnel launcher (ASCII only: cmd parses this file in ANSI codepage,
@rem any non-ASCII byte here corrupts line parsing. All friendly messages are printed by the ps1.)
@rem
@rem USE THIS WHEN SAKURA FRP TRAFFIC IS EXHAUSTED (monthly 5 GiB quota used up).
@rem It starts a free Cloudflare quick tunnel (no account, no traffic quota) and prints
@rem a temporary https://xxx.trycloudflare.com address to hand to friends.
@rem
@rem Notes:
@rem   - The address is TEMPORARY: it changes every time you run this. Re-send it after each restart.
@rem   - Your existing server (if already running on 24500) is reused; nothing is restarted.
@rem   - Verified working 2026-10-09 with Clash TUN + fake-ip active: the mihomo rule
@rem     PROCESS-NAME,cloudflared.exe,DIRECT keeps the tunnel off the fake-ip path.
@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-online.ps1" -Tunnel %*
echo.
echo [Temporary tunnel address copied to clipboard. Send it to friends now.]
echo [This address CHANGES every time you restart - re-send it after any restart.]
cmd /k
