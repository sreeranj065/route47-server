@echo off
REM Tunnel local port 4700 to HTTPS for Driver app testing.
REM First-time only: sign up at https://dashboard.ngrok.com/signup then run:
REM   ngrok config add-authtoken YOUR_TOKEN
set NGROK=C:\Users\Sree\AppData\Local\Microsoft\WinGet\Packages\Ngrok.Ngrok_Microsoft.Winget.Source_8wekyb3d8bbwe\ngrok.exe
"%NGROK%" http 4700
