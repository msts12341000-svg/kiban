#!/usr/bin/env node
/**
 * night-routine.js
 * 夜のルーティン自動化スクリプト
 *
 * 処理フロー:
 *   1. 内部データ分析（daily-log.md / posts-queue.md）
 *   2. 素材チェック → ブラッシュアップ or 新規作成（Claude API）
 *   3. レビュー（バイラルスコア算出）
 *   4. スコア2以上なら自動投稿（post-from-queue.js）
 *   5. git commit & push
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

// ローカル実行時のみ .env を読み込む
if (!process.env.ANTHROPIC_API_KEY) {
  try {
    require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  } catch (e) { /* dotenv 未インストールでも続行 */ }
}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const THREADS_ACCESS_TOKEN = process.env.THREADS_ACCESS_TOKEN;
const THREADS_USER_ID = process.env.THREADS_USER_ID;

const BASE_DIR = path.join(__dirname, '..');
const QUEUE_PATH = path.join(BASE_DIR, 'docs', 'posts-queue.md');
const DAILY_LOG_PATH = path.join(BASE_DIR, 'docs', 'daily-log.md');
const PLATFORM_RESEARCH_PATH = path.join(BASE_DIR, 'docs', 'platform-research.md');

// DRY RUNモード（--dry-run で投稿をスキップ）
const DRY_RUN = process.argv.includes('--dry-run');

// -------------------------------------------------------
// ユーティリティ
// -------------------------------------------------------

function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return null;
  }
}

function writeFile(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8');
}

function log(msg) {
  const ts = new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' });
  console.log(`[${ts}] ${msg}`);
}

function separator(title = '') {
  const line = '─'.repeat(50);
  console.log(title ? `\n${line}\n  ${title}\n${line}` : line);
}

// -------------------------------------------------------
// Anthropic API
// -------------------------------------------------------

function callClaude(systemPrompt, userMessage, maxTokens = 2000) {
  return new Promise((resolve, reject) => {
    if (!ANTHROPIC_API_KEY) {
      reject(new Error('ANTHROPIC_API_KEY が設定されていません'));
      return;
    }

    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    });

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
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) reject(new Error(json.error.message));
          else resolve(json.content?.[0]?.text?.trim() || '');
        } catch (e) {
          reject(new Error(`JSONパースエラー: ${data.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// -------------------------------------------------------
// posts-queue.md パーサー
// -------------------------------------------------------

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

  for (const sec of sections) {
    const raw = sec.rawLines.join('\n');
    const statusMatch = raw.match(/\*\*ステータス:\*\*\s*(.+)/);
    if (statusMatch) sec.status = statusMatch[1].trim();
    const bodyMatch = raw.match(/```\n([\s\S]*?)\n```/);
    if (bodyMatch) sec.body = bodyMatch[1].trim();
  }

  return sections;
}

// -------------------------------------------------------
// Step 1: 内部データ分析
// -------------------------------------------------------

async function analyzeData() {
  separator('Step 1: 内部データ分析');

  const queueText = readFile(QUEUE_PATH) || '';
  const dailyLog = readFile(DAILY_LOG_PATH) || '（記録なし）';
  const platformResearch = readFile(PLATFORM_RESEARCH_PATH) || '（データなし）';

  const sections = parseSections(queueText);
  const unpublished = sections.filter(s => s.status && s.status.startsWith('未投稿'));
  const posted = sections.filter(s => s.status && s.status.startsWith('投稿済み'));

  log(`投稿済み: ${posted.length}件 / 未投稿: ${unpublished.length}件`);

  return {
    queueText,
    sections,
    unpublished,
    posted,
    dailyLog: dailyLog.slice(-2000), // 直近のみ
    platformResearch: platformResearch.slice(0, 3000),
    nextDay: sections.length > 0 ? Math.max(...sections.map(s => s.dayNum)) + 1 : 1,
  };
}

// -------------------------------------------------------
// Step 2-B-1: ブラッシュアップ
// -------------------------------------------------------

async function polishContent(target) {
  separator(`Step 2: ブラッシュアップ（Day ${target.dayNum}）`);
  log(`テーマ: ${target.category}`);
  log('現在の本文:');
  console.log(target.body);

  const system = `あなたはThreadsアカウント「AI副業実験室（@ai_fukugyolab）」の投稿担当です。
26歳・借金200万・AI副業で月5万を目指すリアルな実験記録を発信しています。

投稿ルール:
- フォーマット: Long-form（500〜800字）
- Statement禁止（フォロワー1,000人未満）
- 最初280字で好奇心・共感・問いを生む
- 「続きを見る」直後に最重要情報を配置
- 末尾はreply（コメント）を引き出す問いかけで終わる
- 具体的な数字・体験を含める
- 改善後の投稿本文のみを出力する（説明不要）`;

  const userMsg = `以下の投稿をバイラル最適化してください。文字数は500〜800字を維持してください。

【現在の本文】
${target.body}`;

  const polished = await callClaude(system, userMsg, 1500);
  log('ブラッシュアップ完了');
  return polished;
}

// -------------------------------------------------------
// Step 2-B-2: 新規素材作成
// -------------------------------------------------------

async function createNewContent(data) {
  separator('Step 2: 新規素材作成');
  log('未投稿素材なし → 新規作成します');

  const postedThemes = data.posted.map(s => `Day${s.dayNum}: ${s.category}`).join('\n');

  const system = `あなたはThreadsアカウント「AI副業実験室（@ai_fukugyolab）」の投稿担当です。
26歳・借金200万・AI副業で月5万を目指すリアルな実験記録を発信しています。

投稿ルール:
- フォーマット: Long-form（500〜800字）
- Statement禁止（フォロワー1,000人未満）
- 最初280字で好奇心・共感・問いを生む
- 「続きを見る」直後に最重要情報を配置
- 末尾はreply（コメント）を引き出す問いかけで終わる
- 具体的な数字・体験・実験結果を含める
- 投稿本文のみを出力する（説明・タイトル不要）`;

  const userMsg = `新しいThreads投稿を1本作成してください。

【これまでに扱ったテーマ】
${postedThemes || '（まだなし）'}

【プラットフォーム戦略】
${data.platformResearch}

【直近のパフォーマンスメモ】
${data.dailyLog}

上記を踏まえ、まだ扱っていないテーマまたは反応が良かったテーマの派生で作成してください。`;

  const content = await callClaude(system, userMsg, 1500);
  log('新規素材作成完了');
  return content;
}

// -------------------------------------------------------
// Step 3: バイラルスコア評価
// -------------------------------------------------------

async function reviewContent(content) {
  separator('Step 3: レビュー（バイラルスコア算出）');

  const system = `あなたはThreadsバイラル投稿の審査官です。以下のチェックリストで採点してください。

チェックリスト:
【VIRAL-ERROR（1つでも該当 → 修正が必要）】
- E1: 最初280字で好奇心・共感・問いが生まれていない
- E2: 「続きを見る」直後に重要情報がない
- E3: Statementフォーマット（280字以内の短い主張のみ）を使っている

【VIRAL-WARNING（改善推奨）】
- W1: 狙うエンゲージメントが不明確（reply/bookmarkのどちらを狙うか）
- W2: 末尾にコメントを引き出す問いかけがない

【スコア算出】
- 3点: ERRORなし + WARNING 1件以下
- 2点: ERRORなし + WARNING 複数
- 1点: ERROR 1件
- 0点: ERROR 複数

以下のJSON形式のみで回答してください:
{"score": 数字, "errors": ["E1"など], "warnings": ["W1"など], "reason": "一言コメント"}`;

  const result = await callClaude(system, `採点してください:\n\n${content}`, 500);

  try {
    const json = JSON.parse(result);
    log(`バイラルスコア: ${json.score}点`);
    if (json.errors.length > 0) log(`  ERROR: ${json.errors.join(', ')}`);
    if (json.warnings.length > 0) log(`  WARNING: ${json.warnings.join(', ')}`);
    log(`  コメント: ${json.reason}`);
    return json;
  } catch (e) {
    log('スコア解析に失敗。デフォルト: 2点として続行');
    return { score: 2, errors: [], warnings: [], reason: '解析エラー' };
  }
}

// -------------------------------------------------------
// posts-queue.md 更新
// -------------------------------------------------------

function updateQueueWithNewContent(queueText, dayNum, category, content) {
  const today = new Date().toISOString().slice(0, 10);
  const newSection = `\n## Day ${dayNum} ｜ ${category} ｜ 推奨: 21〜23時\n\n**ステータス:** 未投稿（作成日: ${today}）\n\n\`\`\`\n${content}\n\`\`\`\n`;
  return queueText + newSection;
}

function updateQueueWithPolished(queueText, dayNum, polishedContent) {
  // コードブロック内の本文を置き換える
  const sectionRegex = new RegExp(
    `(## Day\\s*${dayNum}\\s*[｜|][\\s\\S]*?\`\`\`\\n)([\\s\\S]*?)(\\n\`\`\`)`,
    'g'
  );
  return queueText.replace(sectionRegex, `$1${polishedContent}$3`);
}

// -------------------------------------------------------
// Step 4: 投稿実行
// -------------------------------------------------------

function runPostScript() {
  separator('Step 4: 自動投稿');
  try {
    const output = execSync(`node ${path.join(__dirname, 'post-from-queue.js')}`, {
      cwd: BASE_DIR,
      env: { ...process.env },
      encoding: 'utf8',
      timeout: 30000,
    });
    console.log(output);
    return true;
  } catch (err) {
    log(`投稿エラー: ${err.message}`);
    return false;
  }
}

// -------------------------------------------------------
// daily-log.md に記録を追記
// -------------------------------------------------------

function appendDailyLog(dayNum, category, action) {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const dateStr = jst.toISOString().slice(0, 16).replace('T', ' ');
  const entry = `\n- ${dateStr} JST | Day${dayNum} | ${category} | ${action}`;

  const current = readFile(DAILY_LOG_PATH) || '# Daily Log\n';
  writeFile(DAILY_LOG_PATH, current + entry);
}

// -------------------------------------------------------
// git commit & push
// -------------------------------------------------------

function gitPush(message) {
  try {
    execSync('git config user.name "github-actions[bot]"', { cwd: BASE_DIR });
    execSync('git config user.email "github-actions[bot]@users.noreply.github.com"', { cwd: BASE_DIR });
    execSync('git add docs/posts-queue.md docs/daily-log.md', { cwd: BASE_DIR });
    execSync(`git diff --staged --quiet || git commit -m "${message}"`, { cwd: BASE_DIR });
    execSync('git push', { cwd: BASE_DIR });
    log('git push 完了');
  } catch (err) {
    log(`git push エラー（続行）: ${err.message}`);
  }
}

// -------------------------------------------------------
// メイン
// -------------------------------------------------------

async function main() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  console.log('\n' + '='.repeat(54));
  console.log('  AI副業実験室 夜のルーティン');
  console.log(`  ${jst.toISOString().slice(0, 16).replace('T', ' ')} JST`);
  if (DRY_RUN) console.log('  [DRY-RUN MODE]');
  console.log('='.repeat(54));

  if (!ANTHROPIC_API_KEY) {
    log('エラー: ANTHROPIC_API_KEY が設定されていません');
    process.exit(1);
  }

  // Step 1: データ分析
  const data = await analyzeData();

  let targetDay = null;
  let finalContent = null;
  let action = '';

  if (data.unpublished.length > 0) {
    // Step 2-B-1: 素材あり → ブラッシュアップ
    const target = data.unpublished[0];
    targetDay = target.dayNum;

    if (target.body) {
      finalContent = await polishContent(target);
      // posts-queue.md を更新
      const updated = updateQueueWithPolished(data.queueText, target.dayNum, finalContent);
      writeFile(QUEUE_PATH, updated);
      action = 'ブラッシュアップ';
    } else {
      log(`Day ${target.dayNum} に本文がないため新規作成にフォールバック`);
      finalContent = await createNewContent(data);
      targetDay = data.nextDay;
      const updated = updateQueueWithNewContent(data.queueText, targetDay, target.category, finalContent);
      writeFile(QUEUE_PATH, updated);
      action = '新規作成（本文なしフォールバック）';
    }
  } else {
    // Step 2-B-2: 素材なし → 新規作成
    finalContent = await createNewContent(data);
    targetDay = data.nextDay;
    const category = 'AI副業実験';
    const updated = updateQueueWithNewContent(data.queueText, targetDay, category, finalContent);
    writeFile(QUEUE_PATH, updated);
    action = '新規作成';
  }

  // Step 3: レビュー
  const review = await reviewContent(finalContent);

  // Step 4: 投稿
  let posted = false;
  if (review.score >= 2) {
    if (DRY_RUN) {
      log('[DRY-RUN] スコア2点以上 → 投稿をスキップ（DRY-RUNモード）');
    } else {
      if (!THREADS_ACCESS_TOKEN || !THREADS_USER_ID) {
        log('警告: THREADS_ACCESS_TOKEN / THREADS_USER_ID 未設定 → 投稿スキップ');
      } else {
        posted = runPostScript();
      }
    }
  } else {
    log(`スコア${review.score}点 → 投稿スキップ（基準: 2点以上）`);
    log('手動でブラッシュアップ後に再実行してください');
  }

  // daily-log.md に記録
  appendDailyLog(targetDay, action, posted ? '投稿済み' : `スコア${review.score}点・保留`);

  // git push（GitHub Actions環境のみ）
  if (process.env.GITHUB_ACTIONS === 'true') {
    const today = new Date().toISOString().slice(0, 10);
    gitPush(`chore: 夜のルーティン自動実行 ${today} (Day${targetDay} ${action})`);
  }

  separator('完了');
  console.log(`  Day${targetDay} | ${action} | バイラルスコア: ${review.score}点 | ${posted ? '投稿済み' : '保留'}`);
  console.log('='.repeat(54) + '\n');
}

main().catch(err => {
  console.error('予期しないエラー:', err.message);
  process.exit(1);
});
