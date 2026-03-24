@echo off
cd /d C:\Users\msts1\CC_project\projects\kiban
echo === AI副業実験室 朝のルーティン ===
echo.
echo [1/2] 今日の投稿素材を検知中...
node scripts/daily-routine.js
echo.
echo [2/2] アカウントデータを取得中...
python scripts/check_account.py
echo.
echo === 完了 ===
pause
