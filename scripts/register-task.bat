@echo off
set KIBAN=C:\Users\msts1\CC_project\projects\kiban

echo [1/2] Registering morning routine task...
schtasks /delete /tn "AI_kiban_routine" /f 2>nul
schtasks /create /tn "AI_kiban_routine" /tr "cmd.exe /k \"%KIBAN%\scripts\morning-routine.bat\"" /sc ONLOGON /rl LIMITED /f
if %errorlevel%==0 (echo   OK: AI_kiban_routine) else (echo   FAILED: AI_kiban_routine)

echo [2/2] Registering comment check task...
schtasks /delete /tn "AI_kiban_comments" /f 2>nul
schtasks /create /tn "AI_kiban_comments" /tr "cmd.exe /c \"%KIBAN%\scripts\check-comments.bat\"" /sc MINUTE /mo 30 /st 12:00 /et 23:30 /rl LIMITED /f
if %errorlevel%==0 (echo   OK: AI_kiban_comments) else (echo   FAILED: AI_kiban_comments)

echo.
echo Done. Run as Administrator if FAILED.
pause
