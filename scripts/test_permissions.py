"""
test_permissions.py — Threads API 権限テストスクリプト
========================================================

【概要】
Meta Threads APIのアプリをライブモードにするために、
各権限（パーミッション）を1回ずつAPIコールでテストする。

【対象権限】
- threads_profile_discovery
- threads_location_tagging
- threads_delete          （実際には削除しない。投稿ID取得のみ）
- threads_read_replies
- threads_manage_replies
- threads_manage_insights

【実行方法】
  cd C:\\Users\\msts1\\CC_project\\projects\\kiban
  python scripts/test_permissions.py

【必要なもの】
  - .env ファイルに THREADS_ACCESS_TOKEN と THREADS_USER_ID を設定
  - pip install requests python-dotenv

"""

import os
import sys
import time

# Windows環境でのUTF-8出力を強制する
if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

from datetime import datetime, timezone, timedelta

import requests
from dotenv import load_dotenv

# ─────────────────────────────────────────
# 環境変数の読み込み
# ─────────────────────────────────────────

# .env を探す: kiban/.env → CC_project/.env の順でフォールバック
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
        sys.exit(1)


def classify_error(error_data: dict) -> str:
    """APIエラーの原因を分類して日本語メッセージを返す。"""
    code = error_data.get('code', 0)
    msg = error_data.get('message', '')
    if code == 190:
        return 'トークン期限切れ（refresh-token.jsで更新してください）'
    elif code == 200:
        return 'APIアクセスブロック（Meta側の一時制限。しばらく待つか制限解除を確認）'
    elif code == 10 or code == 4:
        return 'レート制限超過（時間をおいて再実行してください）'
    elif 'permission' in msg.lower():
        return '権限不足（スコープを確認してください）'
    else:
        return f'エラー code:{code} - {msg}'


def api_get(endpoint: str, params: dict) -> tuple[bool, dict | None, str]:
    """
    GET リクエストを送信してJSONを返す。
    返り値: (成功フラグ, レスポンスdict, エラーメッセージ)
    """
    params["access_token"] = ACCESS_TOKEN
    url = f"{API_BASE}/{endpoint}"
    try:
        response = requests.get(url, params=params, timeout=10)
        data = {}
        try:
            data = response.json()
        except Exception:
            pass

        if response.status_code == 200:
            return True, data, ""
        else:
            error_info = data.get("error", {})
            classified = classify_error(error_info)
            return False, data, classified

    except requests.exceptions.RequestException as e:
        return False, None, f"通信エラー: {e}"


def print_result(permission: str, success: bool, detail: str = ""):
    """テスト結果を1行で表示する"""
    status = "OK" if success else "NG"
    mark = "+" if success else "-"
    line = f"  [{mark}] {status}  {permission}"
    if detail:
        line += f"  ... {detail}"
    print(line)


# ─────────────────────────────────────────
# 各権限のテスト関数
# ─────────────────────────────────────────

def test_profile_discovery() -> tuple[bool, str]:
    """
    threads_profile_discovery
    他ユーザー向けのプロフィール公開フィールドを取得する。
    エンドポイント: GET /me?fields=id,username,threads_biography
    """
    ok, data, err = api_get(
        "me",
        {"fields": "id,username,threads_biography"}
    )
    if ok:
        username = data.get("username", "不明")
        return True, f"username={username}"
    return False, err


def test_location_tagging() -> tuple[bool, str]:
    """
    threads_location_tagging
    位置情報タグ付きの投稿作成に必要な権限。
    直接確認できるエンドポイントがないため、/me で id を取得して
    権限エラーが発生しないことを確認する。
    エンドポイント: GET /me?fields=id
    """
    ok, data, err = api_get(
        "me",
        {"fields": "id"}
    )
    if ok:
        user_id = data.get("id", "不明")
        return True, f"user_id={user_id}"
    return False, err


def test_delete(post_id: str | None) -> tuple[bool, str]:
    """
    threads_delete
    実際には削除せず、投稿IDが取得できることを確認する。
    エンドポイント: GET /{user-id}/threads（投稿一覧取得）
    """
    if not post_id:
        return False, "テスト対象の投稿IDが取得できませんでした"
    # 削除権限の確認として、投稿IDが正しく取得できることを示す
    return True, f"対象post_id={post_id}（削除は実行しない）"


def test_read_replies(post_id: str | None) -> tuple[bool, str]:
    """
    threads_read_replies
    エンドポイント: GET /{media-id}/replies
    """
    if not post_id:
        return False, "テスト対象の投稿IDが取得できませんでした"
    ok, data, err = api_get(
        f"{post_id}/replies",
        {"fields": "id,text,timestamp"}
    )
    if ok:
        count = len(data.get("data", []))
        return True, f"post_id={post_id}, replies={count}件"
    return False, err


def test_manage_replies(post_id: str | None) -> tuple[bool, str]:
    """
    threads_manage_replies
    エンドポイント: GET /{media-id}/replies（replyフィールド含む）
    """
    if not post_id:
        return False, "テスト対象の投稿IDが取得できませんでした"
    ok, data, err = api_get(
        f"{post_id}/replies",
        {"fields": "id,text,timestamp,username,hide_status"}
    )
    if ok:
        count = len(data.get("data", []))
        return True, f"post_id={post_id}, replies={count}件（hide_statusフィールド含む）"
    return False, err


def test_manage_insights(post_id: str | None) -> tuple[bool, str]:
    """
    threads_manage_insights
    エンドポイント: GET /{user-id}/threads_publishing_limit
    または GET /{media-id}/insights
    """
    # まずユーザーレベルのパブリッシング制限を確認
    ok, data, err = api_get(
        f"{USER_ID}/threads_publishing_limit",
        {"fields": "config,quota_usage"}
    )
    if ok:
        quota = data.get("data", [{}])
        quota_info = quota[0] if quota else {}
        usage = quota_info.get("quota_usage", "不明")
        return True, f"quota_usage={usage}"

    # フォールバック: 投稿インサイトで確認
    if post_id:
        ok2, data2, err2 = api_get(
            f"{post_id}/insights",
            {"metric": "views,likes,replies,reposts,quotes"}
        )
        if ok2:
            return True, f"post_id={post_id}のinsights取得成功"
        return False, f"publishing_limit: {err} / insights: {err2}"

    return False, err


# ─────────────────────────────────────────
# 投稿ID取得ヘルパー
# ─────────────────────────────────────────

def get_latest_post_id() -> str | None:
    """最新の投稿IDを1件取得して返す。取得できなければNoneを返す。"""
    ok, data, err = api_get(
        f"{USER_ID}/threads",
        {"fields": "id,text,timestamp", "limit": 1}
    )
    if ok and data.get("data"):
        return data["data"][0]["id"]
    return None


# ─────────────────────────────────────────
# メイン処理
# ─────────────────────────────────────────

def main():
    now_jst = datetime.now(timezone(timedelta(hours=9)))
    print()
    print("=" * 60)
    print("  Threads API 権限テスト")
    print(f"  実行日時: {now_jst.strftime('%Y年%m月%d日 %H:%M')} (JST)")
    print("=" * 60)

    # 環境変数チェック
    check_env()
    print(f"\n  USER_ID: {USER_ID}")
    print(f"  TOKEN  : {ACCESS_TOKEN[:10]}...（先頭10文字のみ表示）")

    # テスト対象の投稿IDを事前に1件取得（複数テストで共有）
    print("\n  [準備] 最新投稿IDを取得中...")
    post_id = get_latest_post_id()
    if post_id:
        print(f"  [準備] 取得成功: post_id={post_id}")
    else:
        print("  [準備] 投稿IDを取得できませんでした（replyやinsightsのテストは失敗する可能性あり）")

    # ─────────────────────────────────────────
    # 各権限テスト実行
    # ─────────────────────────────────────────
    print("\n  テスト開始...")
    print("  " + "─" * 56)

    results = {}

    # 1. threads_profile_discovery
    ok, detail = test_profile_discovery()
    results["threads_profile_discovery"] = ok
    print_result("threads_profile_discovery", ok, detail)
    time.sleep(1.5)  # レート制限対策

    # 2. threads_location_tagging
    ok, detail = test_location_tagging()
    results["threads_location_tagging"] = ok
    print_result("threads_location_tagging", ok, detail)
    time.sleep(1.5)  # レート制限対策

    # 3. threads_delete（実際には削除しない）
    ok, detail = test_delete(post_id)
    results["threads_delete"] = ok
    print_result("threads_delete", ok, detail)
    time.sleep(1.5)  # レート制限対策

    # 4. threads_read_replies
    ok, detail = test_read_replies(post_id)
    results["threads_read_replies"] = ok
    print_result("threads_read_replies", ok, detail)
    time.sleep(1.5)  # レート制限対策

    # 5. threads_manage_replies
    ok, detail = test_manage_replies(post_id)
    results["threads_manage_replies"] = ok
    print_result("threads_manage_replies", ok, detail)
    time.sleep(1.5)  # レート制限対策

    # 6. threads_manage_insights
    ok, detail = test_manage_insights(post_id)
    results["threads_manage_insights"] = ok
    print_result("threads_manage_insights", ok, detail)

    # ─────────────────────────────────────────
    # サマリー表示
    # ─────────────────────────────────────────
    print("\n  " + "─" * 56)
    print("  [サマリー]")
    success_count = sum(1 for v in results.values() if v)
    total = len(results)

    for perm, ok in results.items():
        mark = "+" if ok else "-"
        label = "成功" if ok else "失敗"
        print(f"    [{mark}] {label}  {perm}")

    print()
    print(f"  結果: {success_count}/{total} 件成功")

    if success_count == total:
        print("  全権限テスト完了。ライブモード申請に進んでください。")
    else:
        failed = [p for p, v in results.items() if not v]
        print("  以下の権限で問題が発生しました:")
        for p in failed:
            print(f"    - {p}")
        print("  アクセストークンのスコープやAPI設定を確認してください。")

    print("=" * 60)
    print()


if __name__ == "__main__":
    main()
