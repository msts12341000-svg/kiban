"""
check_comments.py — 直近の投稿済み投稿へのコメント（返信）チェックスクリプト
================================================================

【概要】
posts-queue.md から最新の投稿済み投稿を特定し、
Threads API でその投稿へのコメント（replies）を取得・表示します。

【実行方法】
  python scripts/check_comments.py

【必要な環境変数（.env）】
  THREADS_ACCESS_TOKEN
  THREADS_USER_ID

【Threads API の制限】
  - replies エンドポイントは公開されている返信のみ取得可能
  - レート制限: 200 calls/hour
"""

import os
import sys
import time
from datetime import datetime, timezone, timedelta

import requests
from dotenv import load_dotenv

# ─────────────────────────────────────────
# 環境変数の読み込み
# ─────────────────────────────────────────

script_dir = os.path.dirname(os.path.abspath(__file__))
env_path = os.path.normpath(os.path.join(script_dir, "..", ".env"))
if not os.path.exists(env_path):
    env_path = os.path.normpath(os.path.join(script_dir, "..", "..", "..", ".env"))
load_dotenv(dotenv_path=env_path)

ACCESS_TOKEN = os.getenv("THREADS_ACCESS_TOKEN")
USER_ID = os.getenv("THREADS_USER_ID")
API_BASE = "https://graph.threads.net/v1.0"

# ─────────────────────────────────────────
# ユーティリティ
# ─────────────────────────────────────────

def check_env():
    missing = []
    if not ACCESS_TOKEN:
        missing.append("THREADS_ACCESS_TOKEN")
    if not USER_ID:
        missing.append("THREADS_USER_ID")
    if missing:
        print("[エラー] 以下の環境変数が設定されていません:")
        for key in missing:
            print(f"  - {key}")
        sys.exit(1)


def api_get(endpoint: str, params: dict) -> dict | None:
    params["access_token"] = ACCESS_TOKEN
    try:
        response = requests.get(f"{API_BASE}/{endpoint}", params=params, timeout=10)
        response.raise_for_status()
        return response.json()
    except requests.exceptions.HTTPError as e:
        data = {}
        try:
            data = e.response.json()
        except Exception:
            pass
        err = data.get("error", {})
        code = err.get("code", 0)
        msg = err.get("message", "")
        if code == 190:
            reason = "トークン期限切れ"
        elif code in (10, 4):
            reason = "レート制限超過（時間をおいて再実行してください）"
        else:
            reason = f"code:{code} - {msg}"
        print(f"[APIエラー] {endpoint}: {reason}")
        return None
    except requests.exceptions.RequestException as e:
        print(f"[通信エラー] {endpoint}: {e}")
        return None


def separator(title: str = ""):
    width = 54
    if title:
        print(f"\n{'─' * 3} {title} {'─' * (width - len(title) - 5)}")
    else:
        print("─" * width)


# ─────────────────────────────────────────
# 投稿済みの最新 Day を posts-queue.md から取得
# ─────────────────────────────────────────

def get_latest_posted_days(queue_path: str, limit: int = 3) -> list[int]:
    """posts-queue.md から投稿済みの Day 番号を新しい順に最大 limit 件返す"""
    try:
        with open(queue_path, encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return []

    import re
    # "## Day N ｜ ... ｜ 推奨: ..." に続く "**ステータス:** 投稿済み" を探す
    pattern = re.compile(
        r"^## Day\s*(\d+)\s*[｜|].*\n\*\*ステータス:\*\*\s*投稿済み",
        re.MULTILINE,
    )
    days = [int(m.group(1)) for m in pattern.finditer(text)]
    days.sort(reverse=True)
    return days[:limit]


# ─────────────────────────────────────────
# 直近投稿の ID を Threads API から取得
# ─────────────────────────────────────────

def get_recent_post_ids(count: int = 3) -> list[dict]:
    """直近 count 件の自分の投稿（id, text, timestamp）を返す"""
    result = api_get(
        f"{USER_ID}/threads",
        {"fields": "id,text,timestamp", "limit": count},
    )
    if not result or "data" not in result:
        return []
    return result["data"][:count]


# ─────────────────────────────────────────
# コメント（返信）取得
# ─────────────────────────────────────────

def get_replies(post_id: str) -> list[dict]:
    """指定投稿への返信一覧を取得する"""
    result = api_get(
        f"{post_id}/replies",
        {"fields": "id,text,timestamp,username"},
    )
    if not result or "data" not in result:
        return []
    return result["data"]


# ─────────────────────────────────────────
# 表示
# ─────────────────────────────────────────

def display_comments(post: dict, replies: list[dict]):
    jst = timezone(timedelta(hours=9))
    text_preview = post.get("text", "（テキストなし）")[:40].replace("\n", " ")
    ts_str = post.get("timestamp", "")
    try:
        ts = datetime.fromisoformat(ts_str.replace("+0000", "+00:00")).astimezone(jst)
        ts_display = ts.strftime("%m/%d %H:%M")
    except ValueError:
        ts_display = "不明"

    separator(f"投稿: {ts_display}")
    print(f"  {text_preview}…")
    print(f"  コメント数: {len(replies)} 件")

    if not replies:
        print("  （コメントなし）")
        return

    print()
    for reply in replies:
        username = reply.get("username", "不明")
        body = reply.get("text", "（テキストなし）").replace("\n", " ")
        r_ts_str = reply.get("timestamp", "")
        try:
            r_ts = datetime.fromisoformat(r_ts_str.replace("+0000", "+00:00")).astimezone(jst)
            r_ts_display = r_ts.strftime("%m/%d %H:%M")
        except ValueError:
            r_ts_display = "不明"
        print(f"  [{r_ts_display}] @{username}: {body[:60]}")


# ─────────────────────────────────────────
# メイン処理
# ─────────────────────────────────────────

def main():
    jst = timezone(timedelta(hours=9))
    now_jst = datetime.now(jst)
    print()
    print("=" * 54)
    print("  Threads コメントチェック")
    print(f"  実行日時: {now_jst.strftime('%Y年%m月%d日 %H:%M')} (JST)")
    print("=" * 54)

    check_env()

    # 直近3件の投稿を取得
    posts = get_recent_post_ids(count=3)
    if not posts:
        print("[情報] 投稿が見つかりませんでした。")
        return

    total_comments = 0
    for post in posts:
        post_id = post.get("id")
        if not post_id:
            continue
        replies = get_replies(post_id)
        total_comments += len(replies)
        display_comments(post, replies)
        time.sleep(0.5)  # レート制限対策

    separator()
    print(f"  合計コメント数（直近3投稿）: {total_comments} 件")
    if total_comments > 0:
        print("  ★ 30分以内に返信して reply-to-comment を狙ってください！")
    print("=" * 54)
    print()


if __name__ == "__main__":
    main()
