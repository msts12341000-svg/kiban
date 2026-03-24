#!/usr/bin/env node
// auto-reply.js
// Threadsの投稿へのコメント（返信）を検出して自動返信するスクリプト

'use strict';

// ローカル実行時のみ .env を読み込む（GitHub Actions では不要）
if (process.env.NODE_ENV !== 'production' && !process.env.THREADS_ACCESS_TOKEN) {
  try {
    require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
  } catch (e) {
    // dotenv が未インストールでも続行
  }
}

const https = require('https');
const fs = require('fs');
const path = require('path');

// -------------------------------------------------------
// 設定
// -------------------------------------------------------
const ACCESS_TOKEN = process.env.THREADS_ACCESS_TOKEN;
const USER_ID = process.env.THREADS_USER_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// 返信済みコメントIDを保存するJSONファイル
const DATA_DIR = path.join(__dirname, '..', 'data');
const REPLIED_IDS_FILE = path.join(DATA_DIR, 'replied-comments.json');

// 取得する最近の投稿数（多すぎるとAPI制限に引っかかるので絞る）
const RECENT_POSTS_LIMIT = 10;

// DRY RUNモード（--dry-run オプション）
const DRY_RUN = process.argv.includes('--dry-run');

// -------------------------------------------------------
// ユーティリティ
// -------------------------------------------------------

// 返信済みIDの読み込み
function loadRepliedIds() {
  if (!fs.existsSync(REPLIED_IDS_FILE)) {
    return new Set();
  }
  try {
    const raw = fs.readFileSync(REPLIED_IDS_FILE, 'utf8');
    const arr = JSON.parse(raw);
    return new Set(arr);
  } catch (e) {
    console.warn('replied-comments.json の読み込みに失敗しました。空で初期化します:', e.message);
    return new Set();
  }
}

// 返信済みIDの保存
function saveRepliedIds(repliedSet) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const arr = Array.from(repliedSet);
  fs.writeFileSync(REPLIED_IDS_FILE, JSON.stringify(arr, null, 2), 'utf8');
}

// -------------------------------------------------------
// Threads API（GET）
// -------------------------------------------------------
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSONパースエラー: ${data.substring(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

// Threads API（POST）
function httpsPost(hostname, urlPath, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const options = {
      hostname,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error(`JSONパースエラー: ${d.substring(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Anthropic Messages API（POST）
function httpsPostAnthropicRaw(data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      }
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error(`JSONパースエラー: ${d.substring(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// -------------------------------------------------------
// Threads API 操作
// -------------------------------------------------------

// 直近の自分の投稿を取得（ルートスレッドのみ）
async function getRecentPosts() {
  const url = `https://graph.threads.net/v1.0/${USER_ID}/threads` +
    `?fields=id,text,timestamp,permalink` +
    `&limit=${RECENT_POSTS_LIMIT}` +
    `&access_token=${ACCESS_TOKEN}`;
  const result = await httpsGet(url);
  if (result.error) {
    throw new Error(`投稿取得エラー: ${result.error.message}`);
  }
  return result.data || [];
}

// 指定投稿のコメント（返信）一覧を取得
async function getRepliesForPost(postId) {
  const url = `https://graph.threads.net/v1.0/${postId}/replies` +
    `?fields=id,text,timestamp,username,replied_to` +
    `&access_token=${ACCESS_TOKEN}`;
  const result = await httpsGet(url);
  if (result.error) {
    if (result.error.code === 100) {
      return [];
    }
    throw new Error(`コメント取得エラー (postId: ${postId}): ${result.error.message}`);
  }
  return result.data || [];
}

// Threadsに返信を投稿する
async function postReply(commentId, replyText) {
  // Step 1: メディアコンテナ作成
  const container = await httpsPost(
    'graph.threads.net',
    `/v1.0/${USER_ID}/threads?access_token=${ACCESS_TOKEN}`,
    {
      media_type: 'TEXT',
      text: replyText,
      reply_to_id: commentId
    }
  );

  if (container.error) {
    throw new Error(`返信コンテナ作成エラー: ${container.error.message}`);
  }

  // Step 2: 公開
  const publish = await httpsPost(
    'graph.threads.net',
    `/v1.0/${USER_ID}/threads_publish?access_token=${ACCESS_TOKEN}`,
    { creation_id: container.id }
  );

  if (publish.error) {
    throw new Error(`返信公開エラー: ${publish.error.message}`);
  }

  return publish.id;
}

// -------------------------------------------------------
// コメント分類
// -------------------------------------------------------
function classifyComment(commentText) {
  const text = commentText;
  if (/怪しい|胡散臭|無理|嘘|信じられない|騙|詐欺|本当に[？?]|本当ですか/.test(text)) return 'skeptic';
  if (/[？?]|どう|なに|何|いくら|教えて|どこ|どんな|いつ|方法|やり方/.test(text)) return 'question';
  if (/私も|俺も|自分も|同じ|わかる|わかります|借金|共感/.test(text)) return 'empathy';
  if (/頑張って|頑張れ|応援|すごい|素晴らしい|期待|ファイト/.test(text)) return 'cheer';
  return 'general';
}

// -------------------------------------------------------
// Claude API で返信文を生成
// -------------------------------------------------------
async function generateReply(originalPostText, commentText, commenterUsername) {
  if (!ANTHROPIC_API_KEY) {
    return generateFallbackReply(commentText);
  }

  const category = classifyComment(commentText);

  const basePrompt = `あなたはThreadsアカウント「AI副業実験室（@ai_fukugyolab）」の中の人です。
26歳・借金200万・AI副業で月5万を目指すリアルな実験記録を発信しています。
「成功者が教える型」ではなく「過程を見せる実験者」として発信しています。

共通ルール:
- 50文字以内の短い返信にする
- 返信文のみを出力する
- 絵文字は1〜2個まで
- 馴れ馴れしくなりすぎない`;

  const categoryInstructions = {
    cheer:   `\n\n応援・共感コメントへの返信:\n- 素直な感謝 + 継続宣言（「見ててください」「続けます」）\n- 前向きで力強いトーン`,
    empathy: `\n\n同じ境遇コメントへの返信:\n- 強い共感（「わかります」「同じですね」）\n- 連帯感（「一緒に記録しましょう」「仲間ですね」）`,
    question:`\n\n質問コメントへの返信:\n- 答えられる範囲で簡潔に1文\n- 詳細は「詳しくは後日投稿します」と添える`,
    skeptic: `\n\n懐疑的・批判コメントへの返信:\n- 否定せず受け止める（「そう感じますよね」）\n- 実験者の姿勢（「実験で数字を見せます」「結果で証明します」）\n- 防衛的・煽り返しは絶対にしない`,
    general: `\n\n汎用返信:\n- 温かみがあり等身大のトーン\n- 「実験中です」「一緒に試しましょう」を自然に使う`
  };

  const systemPrompt = basePrompt + (categoryInstructions[category] || categoryInstructions.general);

  const userMessage = `元の投稿:
「${originalPostText ? originalPostText.substring(0, 100) : '（投稿本文なし）'}」

${commenterUsername} さんからのコメント:
「${commentText}」

このコメントへの返信を1つ書いてください。`;

  try {
    const response = await httpsPostAnthropicRaw({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userMessage }
      ]
    });

    if (response.error) {
      console.warn('Claude APIエラー:', response.error.message, '→ フォールバック返信を使用');
      return generateFallbackReply(commentText);
    }

    const replyText = response.content?.[0]?.text?.trim();
    if (!replyText) {
      console.warn('Claude APIからのレスポンスが空 → フォールバック返信を使用');
      return generateFallbackReply(commentText);
    }

    return replyText;
  } catch (err) {
    console.warn('Claude API呼び出し失敗:', err.message, '→ フォールバック返信を使用');
    return generateFallbackReply(commentText);
  }
}

// ANTHROPIC_API_KEY 未設定時のフォールバック返信
function generateFallbackReply(commentText) {
  const category = classifyComment(commentText);
  const templates = {
    cheer: [
      'ありがとうございます！見ててください、必ず続けます🔥',
      '応援嬉しいです！記録頑張ります',
      'ありがとうございます！この調子で実験続けます💪',
      '励みになります！最後まで記録していきます'
    ],
    empathy: [
      '同じですね！一緒に記録していきましょう🤝',
      'わかります…一緒に実験しましょう',
      '仲間ですね！お互い記録続けましょう',
      '共感してくれてありがとうございます！一緒に前進しましょう'
    ],
    question: [
      '良い質問ありがとうございます！詳しくは後日投稿します📝',
      'まだ実験中です！続報をお待ちください',
      '実験で確かめ中です！結果は記録していきます',
      'ありがとうございます！後日まとめて投稿しますね'
    ],
    skeptic: [
      'そう思いますよね。実験で数字を見せていきます📊',
      'ご指摘ありがとうございます！結果で証明します',
      '懐疑的なのは当然です。実験で確かめます',
      'そう感じますよね。続けて記録で答えます'
    ],
    general: [
      'ありがとうございます！一緒に実験していきましょう',
      'コメントありがとうございます！参考になれば嬉しいです',
      '読んでくれてありがとうございます！実験中です',
      'ありがとうございます！引き続き記録していきます',
      'コメント嬉しいです！一緒に試しましょう'
    ]
  };
  const pool = templates[category] || templates.general;
  return pool[Math.floor(Math.random() * pool.length)];
}

// -------------------------------------------------------
// メイン
// -------------------------------------------------------
async function main() {
  if (!ACCESS_TOKEN || ACCESS_TOKEN === 'your_access_token_here') {
    console.error('エラー: THREADS_ACCESS_TOKEN が設定されていません。');
    process.exit(1);
  }
  if (!USER_ID || USER_ID === 'your_threads_user_id_here') {
    console.error('エラー: THREADS_USER_ID が設定されていません。');
    process.exit(1);
  }

  if (!ANTHROPIC_API_KEY) {
    console.warn('警告: ANTHROPIC_API_KEY が未設定です。フォールバック返信テンプレートを使用します。\n');
  }

  if (DRY_RUN) {
    console.log('[DRY-RUN MODE] 実際には返信を投稿しません\n');
  }

  const repliedIds = loadRepliedIds();
  console.log(`返信済みコメント数: ${repliedIds.size} 件\n`);

  console.log(`直近 ${RECENT_POSTS_LIMIT} 件の投稿を取得中...`);
  let posts;
  try {
    posts = await getRecentPosts();
  } catch (err) {
    console.error('投稿取得に失敗しました:', err.message);
    process.exit(1);
  }

  if (posts.length === 0) {
    console.log('投稿が見つかりませんでした。');
    process.exit(0);
  }
  console.log(`${posts.length} 件の投稿を取得しました。\n`);

  let totalNewComments = 0;
  let totalReplied = 0;
  let totalSkipped = 0;

  for (const post of posts) {
    const postPreview = post.text ? post.text.substring(0, 40).replace(/\n/g, ' ') : '（テキストなし）';
    console.log(`投稿確認中: 「${postPreview}...」 (ID: ${post.id})`);

    let comments;
    try {
      comments = await getRepliesForPost(post.id);
    } catch (err) {
      console.warn(`  コメント取得スキップ: ${err.message}`);
      continue;
    }

    const externalComments = comments.filter(c => c.username !== 'ai_fukugyolab');

    if (externalComments.length === 0) {
      console.log(`  コメントなし\n`);
      continue;
    }

    console.log(`  ${externalComments.length} 件のコメントを検出`);

    for (const comment of externalComments) {
      totalNewComments++;

      if (repliedIds.has(comment.id)) {
        totalSkipped++;
        console.log(`  スキップ（返信済み）: ${comment.id}`);
        continue;
      }

      const commentPreview = comment.text ? comment.text.substring(0, 50) : '（テキストなし）';
      console.log(`  未返信コメント: @${comment.username || '不明'} 「${commentPreview}」`);

      if (!comment.text) {
        console.log(`  スキップ（テキストなし）`);
        repliedIds.add(comment.id);
        continue;
      }

      console.log(`  返信文を生成中...`);
      let replyText;
      try {
        replyText = await generateReply(post.text, comment.text, comment.username || '');
      } catch (err) {
        console.warn(`  返信文生成エラー: ${err.message}`);
        replyText = generateFallbackReply(comment.text);
      }

      console.log(`  生成した返信: 「${replyText}」`);

      if (DRY_RUN) {
        console.log(`  [DRY-RUN] 上記の返信は投稿されません`);
      } else {
        try {
          const replyId = await postReply(comment.id, replyText);
          console.log(`  返信投稿完了！ 返信ID: ${replyId}`);
          repliedIds.add(comment.id);
          totalReplied++;
          saveRepliedIds(repliedIds);
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (err) {
          console.error(`  返信投稿エラー: ${err.message}`);
        }
      }
    }
    console.log('');
  }

  console.log('='.repeat(50));
  console.log('実行結果サマリー');
  console.log('='.repeat(50));
  console.log(`検出したコメント数: ${totalNewComments} 件`);
  if (DRY_RUN) {
    console.log(`[DRY-RUN] 返信対象: ${totalNewComments - totalSkipped} 件`);
    console.log(`スキップ（返信済み）: ${totalSkipped} 件`);
  } else {
    console.log(`返信完了: ${totalReplied} 件`);
    console.log(`スキップ（返信済み）: ${totalSkipped} 件`);
  }
}

main().catch(err => {
  console.error('予期しないエラー:', err.message);
  process.exit(1);
});
