/**
 * post-from-queue.js
 * posts-queue.md から未投稿の最小 Day を選び、Threads API で投稿する。
 *
 * 使い方:
 *   node scripts/post-from-queue.js
 *
 * 必要な環境変数（.env に記載）:
 *   THREADS_ACCESS_TOKEN — Threads API アクセストークン
 *   THREADS_USER_ID      — Threads ユーザー ID
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// ---- dotenv を読み込む ----
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch {
  // dotenv がなくても process.env を直接参照できれば動作する
}

// ---- 設定 ----
const ACCESS_TOKEN = process.env.THREADS_ACCESS_TOKEN;
const USER_ID = process.env.THREADS_USER_ID;
const THREADS_API_BASE = 'https://graph.threads.net/v1.0';
const BASE_DIR = path.join(__dirname, '..');
const QUEUE_PATH = path.join(BASE_DIR, 'docs', 'posts-queue.md');

// ---- 起動チェック ----
if (!ACCESS_TOKEN || !USER_ID) {
  console.error('エラー: .env に THREADS_ACCESS_TOKEN と THREADS_USER_ID を設定してください。');
  console.error(`  .env のパス: ${path.join(BASE_DIR, '.env')}`);
  process.exit(1);
}

// ---- posts-queue.md を読み込む ----
let queueText;
try {
  queueText = fs.readFileSync(QUEUE_PATH, 'utf8');
} catch (err) {
  console.error('エラー: posts-queue.md を読み込めませんでした。');
  console.error(err.message);
  process.exit(1);
}

// ---- セクションをパースする ----
function parseSections(text) {
  const lines = text.split('\n');
  const sections = [];
  let current = null;

  for (const line of lines) {
    const match = line.match(/^## (Day\s*(\d+)\s*[｜|]\s*(.+?)\s*[｜|]\s*推奨[:：]\s*(.+?)\s*)$/);
    if (match) {
      if (current) sections.push(current);
      current = {
        header: match[1].trim(),
        dayNum: parseInt(match[2], 10),
        category: match[3].trim(),
        recommendedTime: match[4].trim(),
        rawLines: [line],
        status: null,
        body: null,
      };
    } else if (current) {
      current.rawLines.push(line);
    }
  }
  if (current) sections.push(current);

  // 各セクションからステータスと本文を抽出する
  for (const sec of sections) {
    const raw = sec.rawLines.join('\n');

    const statusMatch = raw.match(/\*\*ステータス:\*\*\s*(.+)/);
    if (statusMatch) {
      sec.status = statusMatch[1].trim();
    }

    // コードブロック内の本文を抽出する
    const bodyMatch = raw.match(/```\n([\s\S]*?)\n```/);
    if (bodyMatch) {
      sec.body = bodyMatch[1].trim();
    }
  }

  return sections;
}

// ---- エラー原因を分類する ----
function classifyError(body) {
  const err = (body && body.error) || {};
  const code = err.code;
  if (code === 190) return 'トークン期限切れ（refresh-token.jsで更新してください）';
  if (code === 200) return 'APIアクセスブロック（Meta側の一時制限。しばらく待つか制限解除を確認）';
  if (code === 10 || code === 4) return 'レート制限超過（時間をおいて再実行してください）';
  return `エラー code:${code} - ${err.message}`;
}

// ---- 指定ミリ秒待機する（Promise 版）----
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- HTTP POST リクエストを送る（Promise 版）----
function httpPost(url, params) {
  return new Promise((resolve, reject) => {
    const queryString = new URLSearchParams(params).toString();
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + '?' + queryString,
      method: 'POST',
      headers: {
        'Content-Length': 0,
      },
      timeout: 10000,  // 10秒タイムアウト
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('リクエストがタイムアウトしました（10秒）'));
    });
    req.on('error', reject);
    req.end();
  });
}

// ---- ステータスを「投稿済み」に更新する ----
function markAsPosted(text, dayNum) {
  // 対象 Day のセクション内の「**ステータス:** 未投稿...」を「投稿済み」に置換する
  // Day ヘッダーの直後にある最初の ステータス行を対象にする
  const sectionRegex = new RegExp(
    `(## Day\\s*${dayNum}\\s*[｜|][\\s\\S]*?)(\\*\\*ステータス:\\*\\*\\s*)未投稿[^\\n]*`,
  );
  return text.replace(sectionRegex, '$1$2投稿済み');
}

// ---- メイン処理 ----
async function main() {
  const sections = parseSections(queueText);

  if (sections.length === 0) {
    console.error('エラー: posts-queue.md にセクションが見つかりませんでした。');
    process.exit(1);
  }

  // 未投稿の最小 Day を選択する
  const unpublished = sections.filter(s => s.status && s.status.startsWith('未投稿'));
  unpublished.sort((a, b) => a.dayNum - b.dayNum);

  if (unpublished.length === 0) {
    console.log('すべての投稿が投稿済みです。新しい素材を追加してください。');
    process.exit(0);
  }

  const target = unpublished[0];

  if (!target.body) {
    console.error(`エラー: Day ${target.dayNum} に本文が見つかりませんでした。`);
    process.exit(1);
  }

  console.log('');
  console.log('投稿対象');
  console.log('─────────────────');
  console.log(`Day ${target.dayNum} | ${target.category}`);
  console.log(`推奨投稿時間: ${target.recommendedTime}`);
  console.log('');
  console.log('本文:');
  console.log(target.body);
  console.log('');

  // ---- Step 1: メディアコンテナを作成する ----
  console.log('Step 1: メディアコンテナを作成中...');
  const containerUrl = `${THREADS_API_BASE}/${USER_ID}/threads`;
  const containerParams = {
    media_type: 'TEXT',
    text: target.body,
    access_token: ACCESS_TOKEN,
  };

  let containerResult;
  try {
    containerResult = await httpPost(containerUrl, containerParams);
  } catch (err) {
    console.error('エラー: メディアコンテナの作成に失敗しました。');
    console.error(err.message);
    process.exit(1);
  }

  if (containerResult.status !== 200 || !containerResult.body.id) {
    console.error('エラー: メディアコンテナの作成でAPIエラーが返りました。');
    console.error(`HTTPステータス: ${containerResult.status}`);
    console.error(`原因: ${classifyError(containerResult.body)}`);
    console.error('レスポンス:', JSON.stringify(containerResult.body, null, 2));
    process.exit(1);
  }

  const creationId = containerResult.body.id;
  console.log(`コンテナID: ${creationId}`);

  // Meta推奨: コンテナ作成から公開までの待機（2秒）
  console.log('Meta推奨の公開前待機中（2秒）...');
  await sleep(2000);

  // ---- Step 2: 公開する ----
  console.log('Step 2: 投稿を公開中...');
  const publishUrl = `${THREADS_API_BASE}/${USER_ID}/threads_publish`;
  const publishParams = {
    creation_id: creationId,
    access_token: ACCESS_TOKEN,
  };

  let publishResult;
  try {
    publishResult = await httpPost(publishUrl, publishParams);
  } catch (err) {
    console.error('エラー: 投稿の公開に失敗しました。');
    console.error(err.message);
    process.exit(1);
  }

  if (publishResult.status !== 200 || !publishResult.body.id) {
    console.error('エラー: 投稿の公開でAPIエラーが返りました。');
    console.error(`HTTPステータス: ${publishResult.status}`);
    console.error(`原因: ${classifyError(publishResult.body)}`);
    console.error('レスポンス:', JSON.stringify(publishResult.body, null, 2));
    process.exit(1);
  }

  const postId = publishResult.body.id;
  const postUrl = `https://www.threads.net/@${USER_ID}/post/${postId}`;

  console.log('');
  console.log('投稿成功');
  console.log('─────────────────');
  console.log(`投稿ID: ${postId}`);
  console.log(`投稿URL: ${postUrl}`);
  console.log('');

  // ---- ステータスを「投稿済み」に更新する ----
  const updatedText = markAsPosted(queueText, target.dayNum);
  try {
    fs.writeFileSync(QUEUE_PATH, updatedText, 'utf8');
    console.log(`posts-queue.md の Day ${target.dayNum} を「投稿済み」に更新しました。`);
  } catch (err) {
    console.error('警告: posts-queue.md の更新に失敗しました（投稿自体は成功しています）。');
    console.error(err.message);
  }
}

main().catch((err) => {
  console.error('予期しないエラーが発生しました:', err.message);
  process.exit(1);
});
