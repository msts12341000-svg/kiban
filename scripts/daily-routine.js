/**
 * daily-routine.js
 * posts-queue.md から未投稿の最小 Day を選び、
 * 標準出力と daily-briefing.md に投稿素材を表示・書き込む。
 */

const fs = require('fs');
const path = require('path');

// ---- パス定義 ----
const BASE_DIR = path.join(__dirname, '..');
const QUEUE_PATH = path.join(BASE_DIR, 'docs', 'posts-queue.md');
const BRIEFING_PATH = path.join(BASE_DIR, 'docs', 'daily-briefing.md');

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
// 見出し例: "## Day 3 ｜ 借金ドキュメント ｜ 推奨: 21〜23時"
// パイプは全角（｜）と半角（|）の両方に対応する
const SECTION_REGEX = /^## (Day\s*(\d+)\s*[｜|].+)$/m;

// セクションごとに分割する（"## Day" で始まる行を区切りとして使用）
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

    // ステータス抽出
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

const sections = parseSections(queueText);

if (sections.length === 0) {
  console.error('エラー: posts-queue.md にセクションが見つかりませんでした。');
  process.exit(1);
}

// ---- 未投稿の最小 Day を選択する ----
const unpublished = sections.filter(s => s.status && s.status.startsWith('未投稿'));
unpublished.sort((a, b) => a.dayNum - b.dayNum);

if (unpublished.length === 0) {
  console.log('すべての投稿が投稿済みです。新しい素材を追加してください。');
  process.exit(0);
}

const today = unpublished[0];

// ---- 今日の日付を取得する ----
const now = new Date();
const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD

// ---- 標準出力に表示する ----
const preview = today.body ? today.body.slice(0, 100) : '（本文なし）';

console.log('');
console.log('今日の投稿素材（自動検知）');
console.log('─────────────────');
console.log(`Day ${today.dayNum} | ${today.category}`);
console.log(`推奨投稿時間: ${today.recommendedTime}`);
console.log(`テーマ: ${today.header}`);
console.log('─────────────────');
console.log(preview);
console.log('');

// ---- daily-briefing.md を上書きする ----
const briefingContent = `# Daily Briefing
> daily-routine.js によって自動更新されます。

## 今日の日付
${dateStr}

## 今日の投稿候補
**セクション:** Day ${today.dayNum} | ${today.category}
**推奨投稿時間:** ${today.recommendedTime}

**本文:**
${today.body ? today.body : '（本文なし）'}

投稿する場合は \`node scripts/post-from-queue.js\` を実行してください。
`;

try {
  fs.writeFileSync(BRIEFING_PATH, briefingContent, 'utf8');
  console.log(`daily-briefing.md を更新しました: ${BRIEFING_PATH}`);
} catch (err) {
  console.error('エラー: daily-briefing.md への書き込みに失敗しました。');
  console.error(err.message);
  process.exit(1);
}
