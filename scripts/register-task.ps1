# タスクスケジューラ登録スクリプト
# 登録するタスク:
#   1. AI副業実験室_朝のルーティン  — ログオン時に実行
#   2. AI副業実験室_コメントチェック — 毎日 12:00〜23:30 を 30分ごとに実行

$currentUser = $env:USERNAME
$kibanDir = "C:\Users\msts1\CC_project\projects\kiban"

# ─── タスク1: 朝のルーティン ───────────────────────────────
$routineTaskName = "AI副業実験室_朝のルーティン"
$routineBat = "$kibanDir\scripts\morning-routine.bat"

$existing = Get-ScheduledTask -TaskName $routineTaskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $routineTaskName -Confirm:$false
    Write-Host "既存タスクを削除しました: $routineTaskName"
}

$routineAction = New-ScheduledTaskAction `
    -Execute "cmd.exe" `
    -Argument "/k `"$routineBat`""

$routineTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser

$routineSettings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

$routinePrincipal = New-ScheduledTaskPrincipal `
    -UserId $currentUser `
    -LogonType Interactive `
    -RunLevel Limited

$routineTask = Register-ScheduledTask `
    -TaskName $routineTaskName `
    -Action $routineAction `
    -Trigger $routineTrigger `
    -Settings $routineSettings `
    -Principal $routinePrincipal `
    -Description "ログオン時にAI副業実験室の朝のルーティンを実行する" `
    -Force

if ($routineTask) {
    Write-Host "タスク登録成功: $routineTaskName（ログオン時に実行）"
} else {
    Write-Host "タスク登録に失敗しました: $routineTaskName"
}

# ─── タスク2: コメントチェック ────────────────────────────
$commentTaskName = "AI副業実験室_コメントチェック"
$commentBat = "$kibanDir\scripts\check-comments.bat"

$existing2 = Get-ScheduledTask -TaskName $commentTaskName -ErrorAction SilentlyContinue
if ($existing2) {
    Unregister-ScheduledTask -TaskName $commentTaskName -Confirm:$false
    Write-Host "既存タスクを削除しました: $commentTaskName"
}

$commentAction = New-ScheduledTaskAction `
    -Execute "cmd.exe" `
    -Argument "/c `"$commentBat`""

# 毎日 12:00 開始、30分ごと、23:30 まで繰り返す
$commentTrigger = New-ScheduledTaskTrigger `
    -Daily `
    -At "12:00"

# RepetitionInterval / RepetitionDuration は CIM を使って設定
$repetition = (New-ScheduledTaskTrigger -Once -At "12:00" -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Hours 11 -Minutes 30)).Repetition
$commentTrigger.Repetition = $repetition

$commentSettings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable

$commentPrincipal = New-ScheduledTaskPrincipal `
    -UserId $currentUser `
    -LogonType Interactive `
    -RunLevel Limited

$commentTask = Register-ScheduledTask `
    -TaskName $commentTaskName `
    -Action $commentAction `
    -Trigger $commentTrigger `
    -Settings $commentSettings `
    -Principal $commentPrincipal `
    -Description "毎日12:00〜23:30に30分ごとThreadsコメントをチェックする" `
    -Force

if ($commentTask) {
    Write-Host "タスク登録成功: $commentTaskName（毎日 12:00〜23:30 / 30分ごと）"
} else {
    Write-Host "タスク登録に失敗しました: $commentTaskName"
}

Write-Host ""
Write-Host "=== 登録完了 ==="
Write-Host "  $routineTaskName : ログオン時"
Write-Host "  $commentTaskName : 毎日 12:00〜23:30 (30分ごと)"
