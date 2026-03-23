"""
check_account.py — Threads 自アカウント自動チェックスクリプト
================================================================

【概要】
Threads API（Meta Graph API）を使って以下の情報を自動取得・表示します。
  - フォロワー数（現在）
  - 前日投稿のインプレッション・いいね・リプライ数
  - 直近7日間の投稿パフォーマンス一覧

【実行方法】
  python scripts/check_account.py

【必要なもの】
  1. Threads / Meta のアクセストークン
     ① Meta for Developers (https://developers.facebook.com/) でアプリを作成
     ② 「Threads API」プロダクトを追加
     ③ 「Threads プロフィール」「Threads メディア」「Threads インサイト」スコープを許可
     ④ ユーザーアクセストークンを取得（有効期限：60日。長期トークンを推奨）
     ⑤ ユーザーIDは Graph API Explorer で「me?fields=id」を実行して確認

  2. 依存ライブラリのインストール
     pip install requests python-dotenv

  3. .env ファイルの作成
     .env.example をコピーして .env を作成し、各値を設定してください。
     cp .env.example .env

【Threads API の制限・注意事項（2024年時点）】
  - インサイト（インプレッション等）は「ビジネスアカウント」または
    「クリエイターアカウント」のみ取得可能
  - 個人アカウントではインサイトAPIが利用できない場合あり
  - フォロワー数の取得には followers_count フィールドが必要
  - アクセストークンの有効期限に注意（60日で失効）
  - レート制限: 200 calls/hour（ユーザーレベル）

【取得できない場合の代替手段】
  - インプレッション: Threads アプリの「インサイト」画面で手動確認
  - フォロワー増減: フォロワー数を daily-log.md に手動記録して差分を計算
  - 競合分析: 「② 競合チェック」は手動 or 別スクリプトで対応

"""

import os
import sys
from datetime import datetime, timedelta, timezone

import requests
from dotenv import load_dotenv

# ─────────────────────────────────────────
# 環境変数の読み込み
# ─────────────────────────────────────────

# .env を探す: kiban/.env → CC_project/.env の順でフォールバック
# ディレクトリ構造: CC_project/projects/kiban/scripts/check_account.py
script_dir = os.path.dirname(os.path.abspath(__file__))
env_path = os.path.normpath(os.path.join(script_dir, "..", ".env"))      # kiban/.env
if not os.path.exists(env_path):
    env_path = os.path.normpath(os.path.join(script_dir, "..", "..", "..", ".env"))  # CC_project/.env
load_dotenv(dotenv_path=env_path)

ACCESS_TOKEN = os.getenv("THREADS_ACCESS_TOKEN")
USER_ID = os.getenv("THREADS_USER_ID")

# Threads Graph API のベースURL
API_BASE = "https://graph.threads.net/v1.0"


# ─────────────────────────────────────────
# ユーティリティ
# ─────────────────────────────────────────

def check_env():
    """環境変数が設定されているか確認する"""
    missing = []
    if not ACCESS_TOKEN:
        missing.append("THREADS_ACCESS_TOKEN")
    if not USER_ID:
        missing.append("THREADS_USER_ID")
    if missing:
        print("[エラー] 以下の環境変数が設定されていません:")
        for key in missing:
            print(f"  - {key}")
        print("\n.env ファイルを確認してください。")
        print("（.env.example をコピーして .env を作成し、値を設定してください）")
        sys.exit(1)


def api_get(endpoint: str, params: dict) -> dict | None:
    """GET リクエストを送信してJSONを返す。エラー時は None を返す。"""
    params["access_token"] = ACCESS_TOKEN
    try:
        response = requests.get(f"{API_BASE}/{endpoint}", params=params, timeout=15)
        response.raise_for_status()
        return response.json()
    except requests.exceptions.HTTPError as e:
        data = {}
        try:
            data = e.response.json()
        except Exception:
            pass
        error_msg = data.get("error", {}).get("message", str(e))
        print(f"[APIエラー] {endpoint}: {error_msg}")
        return None
    except requests.exceptions.RequestException as e:
        print(f"[通信エラー] {endpoint}: {e}")
        return None


def separator(title: str = ""):
    """区切り線を表示する"""
    width = 54
    if title:
        print(f"\n{'─' * 3} {title} {'─' * (width - len(title) - 5)}")
    else:
        print("─" * width)


def fmt_num(n) -> str:
    """数値をカンマ区切りで整形する。None の場合は '取得不可' を返す。"""
    if n is None:
        return "取得不可"
    try:
        return f"{int(n):,}"
    except (ValueError, TypeError):
        return str(n)


# ─────────────────────────────────────────
# 取得関数
# ─────────────────────────────────────────

def get_profile() -> dict | None:
    """フォロワー数などのプロフィール情報を取得する"""
    return api_get(
        USER_ID,
        {"fields": "id,username,name,threads_profile_picture_url,followers_count,threads_biography"}
    )


def get_recent_posts(since_days: int = 7) -> list[dict]:
    """
    直近 since_days 日間の投稿一覧を取得する。
    返り値: 投稿dictのリスト（新しい順）
    """
    # 投稿一覧を取得（最大 25 件）
    result = api_get(
        f"{USER_ID}/threads",
        {
            "fields": "id,text,timestamp,media_type,like_count,replies_count",
            "limit": 25,
        }
    )
    if not result or "data" not in result:
        return []

    # since_days 日以内に絞り込む
    cutoff = datetime.now(timezone.utc) - timedelta(days=since_days)
    posts = []
    for post in result["data"]:
        ts_str = post.get("timestamp", "")
        if not ts_str:
            continue
        try:
            # ISO 8601形式 "2024-01-01T12:00:00+0000"
            ts = datetime.fromisoformat(ts_str.replace("+0000", "+00:00"))
        except ValueError:
            continue
        if ts >= cutoff:
            posts.append(post)

    return posts


def get_post_insights(post_id: str) -> dict | None:
    """
    指定投稿のインサイト（インプレッション・いいね・リプライ・リポスト・引用）を取得する。
    ビジネス/クリエイターアカウントのみ利用可能。
    """
    result = api_get(
        f"{post_id}/insights",
        {
            "metric": "views,likes,replies,reposts,quotes",
            "breakdown": "total_value",
        }
    )
    if not result or "data" not in result:
        return None

    # メトリクス名 → 値 の辞書に変換
    metrics = {}
    for item in result["data"]:
        name = item.get("name")
        value = item.get("total_value", {}).get("value")
        if name and value is not None:
            metrics[name] = value
    return metrics if metrics else None


# ─────────────────────────────────────────
# 表示関数
# ─────────────────────────────────────────

def display_profile(profile: dict):
    """プロフィール情報を表示する"""
    separator("アカウント情報")
    username = profile.get("username", "不明")
    name = profile.get("name", "")
    followers = profile.get("followers_count")
    bio = profile.get("threads_biography", "")

    print(f"  ユーザー名    : @{username}")
    if name:
        print(f"  表示名        : {name}")
    print(f"  フォロワー数  : {fmt_num(followers)} 人")
    if bio:
        # 長いbioは省略
        bio_display = bio[:60] + "…" if len(bio) > 60 else bio
        print(f"  プロフィール  : {bio_display}")


def display_yesterday_post(posts: list[dict]):
    """前日の投稿のパフォーマンスを表示する"""
    separator("前日の投稿パフォーマンス")

    # 前日（JST）の投稿を抽出
    jst = timezone(timedelta(hours=9))
    now_jst = datetime.now(jst)
    yesterday_jst = now_jst - timedelta(days=1)
    yesterday_date = yesterday_jst.date()

    yesterday_posts = []
    for post in posts:
        ts_str = post.get("timestamp", "")
        try:
            ts = datetime.fromisoformat(ts_str.replace("+0000", "+00:00")).astimezone(jst)
            if ts.date() == yesterday_date:
                yesterday_posts.append(post)
        except ValueError:
            continue

    if not yesterday_posts:
        print(f"  {yesterday_date} の投稿はありません。")
        return

    for post in yesterday_posts:
        post_id = post.get("id", "")
        text = post.get("text", "（テキストなし）")
        text_preview = text[:40] + "…" if len(text) > 40 else text
        like_count = post.get("like_count")
        replies_count = post.get("replies_count")

        print(f"\n  [{yesterday_date}] {text_preview}")
        print(f"    いいね数    : {fmt_num(like_count)}")
        print(f"    リプライ数  : {fmt_num(replies_count)}")

        # インサイト（ビジネスアカウントのみ）
        if post_id:
            insights = get_post_insights(post_id)
            if insights:
                print(f"    インプレッション: {fmt_num(insights.get('views'))}")
                print(f"    リポスト    : {fmt_num(insights.get('reposts'))}")
                print(f"    引用        : {fmt_num(insights.get('quotes'))}")
            else:
                print("    インサイト  : 取得不可（ビジネス/クリエイターアカウント限定）")


def display_weekly_posts(posts: list[dict]):
    """直近7日間の投稿パフォーマンス一覧を表示する"""
    separator("直近7日間の投稿パフォーマンス一覧")

    if not posts:
        print("  直近7日間の投稿はありません。")
        return

    jst = timezone(timedelta(hours=9))

    print(f"  {'日時':<18} {'いいね':>6} {'返信':>6}  投稿（先頭30文字）")
    print(f"  {'─'*18} {'─'*6} {'─'*6}  {'─'*30}")

    for post in posts:
        ts_str = post.get("timestamp", "")
        text = post.get("text", "（テキストなし）")
        text_preview = text[:30].replace("\n", " ")
        like_count = post.get("like_count", 0) or 0
        replies_count = post.get("replies_count", 0) or 0

        try:
            ts = datetime.fromisoformat(ts_str.replace("+0000", "+00:00")).astimezone(jst)
            ts_display = ts.strftime("%m/%d %H:%M")
        except ValueError:
            ts_display = "不明"

        print(f"  {ts_display:<18} {like_count:>6,} {replies_count:>6,}  {text_preview}")

    # インサイト詳細は件数が多いので代表して最新投稿のみ表示
    latest = posts[0] if posts else None
    if latest and latest.get("id"):
        print("\n  [最新投稿のインサイト詳細]")
        insights = get_post_insights(latest["id"])
        if insights:
            print(f"    インプレッション: {fmt_num(insights.get('views'))}")
            print(f"    いいね          : {fmt_num(insights.get('likes'))}")
            print(f"    リプライ        : {fmt_num(insights.get('replies'))}")
            print(f"    リポスト        : {fmt_num(insights.get('reposts'))}")
            print(f"    引用            : {fmt_num(insights.get('quotes'))}")
        else:
            print("    インサイト: 取得不可（ビジネス/クリエイターアカウント限定）")


# ─────────────────────────────────────────
# メイン処理
# ─────────────────────────────────────────

def main():
    now_jst = datetime.now(timezone(timedelta(hours=9)))
    print()
    print("=" * 54)
    print("  Threads 自アカウントチェック")
    print(f"  実行日時: {now_jst.strftime('%Y年%m月%d日 %H:%M')} (JST)")
    print("=" * 54)

    # 環境変数チェック
    check_env()

    # ── プロフィール取得
    profile = get_profile()
    if profile:
        display_profile(profile)
    else:
        print("[エラー] プロフィール情報を取得できませんでした。")
        print("  ACCESS_TOKEN や USER_ID が正しいか確認してください。")

    # ── 直近7日間の投稿取得
    posts = get_recent_posts(since_days=7)

    # ── 前日投稿のパフォーマンス
    display_yesterday_post(posts)

    # ── 直近7日間の投稿一覧
    display_weekly_posts(posts)

    separator()
    print("  チェック完了")
    print("=" * 54)
    print()


if __name__ == "__main__":
    main()
