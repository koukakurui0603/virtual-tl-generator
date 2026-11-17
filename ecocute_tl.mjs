import { Client, GatewayIntentBits } from 'discord.js';
import axios from 'axios';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { loadConfig, buildSystemPrompt, readTextSafe } from './config.mjs';

// ==========================================
// ⚙️ 設定の読み込み（pass.md & プロンプト.md）
// ==========================================
const CONFIG = loadConfig();
const RAG_CACHE_FILE = path.join(CONFIG.BASE_DIR, 'rag_cache.json');
const TL_BACKUP_DIR = path.join(CONFIG.BASE_DIR, 'TLBU');

const sleep = ms => new Promise(res => setTimeout(res, ms));
const genAI = new GoogleGenerativeAI(CONFIG.GEMINI_API_KEY);
const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

const embModel = genAI.getGenerativeModel({ model: "gemini-embedding-001" });
let knowledgeBase = [];
let postQueue = [];

// ==========================================
// 🕒 日本時間（JST）管理ヘルパー
// ==========================================
function getJstNow() {
    return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

function getJstHour() {
    return getJstNow().getUTCHours();
}

function getJstDateString() {
    const jst = getJstNow();
    const pad = n => String(n).padStart(2, '0');
    return `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth() + 1)}-${pad(jst.getUTCDate())}`;
}

function formatJstTimestamp() {
    const jst = getJstNow();
    const pad = n => String(n).padStart(2, '0');
    return `${getJstDateString()} ` +
           `${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}:${pad(jst.getUTCSeconds())} JST`;
}

function msUntilNextJstHour(targetHour) {
    const jstNow = getJstNow();
    const target = new Date(jstNow.getTime());
    target.setUTCHours(targetHour, 0, 0, 0);
    if (target.getTime() <= jstNow.getTime()) {
        target.setUTCDate(target.getUTCDate() + 1);
    }
    return target.getTime() - jstNow.getTime();
}

function isNightGenerationTime() {
    const hour = getJstHour();
    const { generationEndHour, broadcastEndHour } = CONFIG.SETTINGS;
    if (generationEndHour < broadcastEndHour) {
        return hour >= broadcastEndHour || hour < generationEndHour;
    }
    return hour >= broadcastEndHour && hour < generationEndHour;
}

// ==========================================
// 🧠 RAG（資料庫）自動小分け＆キャッシュ機能付き
// ==========================================
function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0, normA = 0, normB = 0;
    const len = Math.min(vecA.length, vecB.length);
    for (let i = 0; i < len; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dotProduct / denom;
}

function splitMarkdownIntoSafeChunks(text, fileName, maxChars = 850) {
    const normalized = text.replace(/\r\n/g, '\n');
    const lines = normalized.split('\n');
    const sections = [];

    let currentHeading = fileName.replace(/\.md$/i, '');
    let currentLines = [];

    for (const line of lines) {
        if (/^#{1,2}\s+/.test(line.trim())) {
            if (currentLines.join('\n').trim().length > 10) {
                sections.push({ heading: currentHeading, body: currentLines.join('\n').trim() });
            }
            currentHeading = line.trim().replace(/^#{1,2}\s+/, '').trim();
            currentLines = [];
        } else {
            currentLines.push(line);
        }
    }
    if (currentLines.join('\n').trim().length > 10) {
        sections.push({ heading: currentHeading, body: currentLines.join('\n').trim() });
    }

    const finalChunks = [];
    for (const sec of sections) {
        const fullSec = `# ${sec.heading}\n${sec.body}`;
        if (fullSec.length <= maxChars) {
            finalChunks.push(fullSec);
            continue;
        }

        const bodyLines = sec.body.split('\n');
        let buffer = `# ${sec.heading}\n`;
        let partNum = 1;

        for (const bLine of bodyLines) {
            if (bLine.length > maxChars - 80) {
                if (buffer.trim().length > (`# ${sec.heading}`).length + 5) {
                    finalChunks.push(buffer.trim());
                    partNum++;
                }
                let rem = bLine;
                while (rem.length > 0) {
                    const sliceLen = maxChars - 80;
                    finalChunks.push(`# ${sec.heading} (続き${partNum})\n${rem.slice(0, sliceLen)}`);
                    rem = rem.slice(sliceLen);
                    partNum++;
                }
                buffer = `# ${sec.heading} (続き${partNum})\n`;
                continue;
            }

            if ((buffer.length + bLine.length + 1) > maxChars) {
                if (buffer.trim().length > 10) {
                    finalChunks.push(buffer.trim());
                    partNum++;
                }
                buffer = `# ${sec.heading} (続き${partNum})\n${bLine}\n`;
            } else {
                buffer += `${bLine}\n`;
            }
        }
        if (buffer.trim().length > (`# ${sec.heading} (続き${partNum})`).length + 5) {
            finalChunks.push(buffer.trim());
        }
    }

    return finalChunks.filter(c => c.trim().length > 10);
}

async function embedWithRetry(text, maxRetries = 2) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await embModel.embedContent(text);
        } catch (err) {
            if (attempt < maxRetries) {
                await sleep(4000);
            } else {
                throw err;
            }
        }
    }
}

async function initRAG() {
    console.log("\n📚 資料庫（RAG）を読み込み中...");
    if (!fs.existsSync(CONFIG.RAG_DOCS_DIR)) {
        fs.mkdirSync(CONFIG.RAG_DOCS_DIR, { recursive: true });
    }
    const files = fs.readdirSync(CONFIG.RAG_DOCS_DIR).filter(f => f.endsWith('.md')).sort();
    if (files.length === 0) {
        console.log("ℹ️ 資料庫フォルダ内に .md ファイルが無いためスキップします。");
        return;
    }

    const signature = files.map(file => {
        const st = fs.statSync(path.join(CONFIG.RAG_DOCS_DIR, file));
        return { file, size: st.size, mtime: Math.floor(st.mtimeMs) };
    });

    if (fs.existsSync(RAG_CACHE_FILE)) {
        try {
            const cache = JSON.parse(readTextSafe(RAG_CACHE_FILE));
            if (JSON.stringify(cache.signature) === JSON.stringify(signature) && Array.isArray(cache.chunks) && cache.chunks.length > 0) {
                knowledgeBase = cache.chunks;
                console.log(`⚡ キャッシュから瞬時にRAG記憶を復元しました！ (${knowledgeBase.length} チャンク / API消費0回)`);
                return;
            }
        } catch (e) {}
    }

    console.log("🔄 資料の変更または初回起動を検知しました。全チャンクを記憶しています...");
    knowledgeBase = [];
    let totalFailed = 0;

    for (const file of files) {
        const text = readTextSafe(path.join(CONFIG.RAG_DOCS_DIR, file));
        const chunks = splitMarkdownIntoSafeChunks(text, file, 850);
        let fileSuccess = 0;
        let fileFailed = 0;

        for (let i = 0; i < chunks.length; i++) {
            try {
                const result = await embedWithRetry(chunks[i], 2);
                knowledgeBase.push({ text: chunks[i], vector: result.embedding.values, source: file });
                fileSuccess++;
                process.stdout.write(`\r   📄 ${file}: ${fileSuccess}/${chunks.length} チャンク記憶中...`);
                await sleep(1000);
            } catch (e) {
                fileFailed++;
                totalFailed++;
                console.error(`\n   ⚠️ [${file}] チャンク${i + 1} 記憶失敗: ${e.message}`);
            }
        }
        console.log(`\n   ✅ ${file} → ${fileSuccess}チャンク記憶完了 (失敗: ${fileFailed}件)`);
    }

    console.log(`✅ RAG記憶完了！(総記憶: ${knowledgeBase.length} チャンク / 失敗: ${totalFailed}件)`);

    if (totalFailed === 0 && knowledgeBase.length > 0) {
        try {
            fs.writeFileSync(RAG_CACHE_FILE, JSON.stringify({ signature, chunks: knowledgeBase }), 'utf8');
            console.log(`💾 記憶キャッシュ（rag_cache.json）を保存しました。次回からは瞬時に起動します！`);
        } catch (e) {
            console.warn("⚠️ キャッシュ保存に失敗:", e.message);
        }
    }
}

async function retrieveContext(query) {
    if (knowledgeBase.length === 0) return "";
    try {
        const queryResult = await embModel.embedContent(query);
        const scoredChunks = knowledgeBase.map(item => ({
            ...item,
            score: cosineSimilarity(queryResult.embedding.values, item.vector)
        })).sort((a, b) => b.score - a.score);
        const topChunks = scoredChunks.slice(0, 5).map(c => `[出典:${c.source}]\n${c.text}`);
        return `\n【公式資料・設定（RAG）】\n${topChunks.join('\n\n')}\n`;
    } catch (e) {
        return "";
    }
}

function getModelList() {
    if (fs.existsSync(CONFIG.MODELS_FILE)) {
        const list = readTextSafe(CONFIG.MODELS_FILE).split('\n').map(m => m.trim()).filter(m => m && !m.startsWith('#'));
        if (list.length > 0) return list;
    }
    return ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
}

// ==========================================
// 📦 キューの永続化管理＆対話式リカバリー
// ==========================================
function loadQueue() {
    if (fs.existsSync(CONFIG.QUEUE_SAVE_FILE)) {
        try {
            postQueue = JSON.parse(readTextSafe(CONFIG.QUEUE_SAVE_FILE));
            console.log(`📂 前回保存されたキューから ${postQueue.length} 件を検出しました。`);
        } catch (e) {
            postQueue = [];
        }
    }
}

function saveQueue() {
    fs.writeFileSync(CONFIG.QUEUE_SAVE_FILE, JSON.stringify(postQueue, null, 2), 'utf8');
}

async function promptUserForQueueAction() {
    if (postQueue.length === 0) return "generate";

    console.log("\n" + "=".repeat(60));
    console.log(`⚠️ 前回のキューが【${postQueue.length}件】残っています！`);
    console.log("どうしますか？（半角数字を入力してEnter）");
    console.log("  [1] 既存キューを残したまま、追加で生成を再開する（おすすめ）");
    console.log("  [2] 既存キューを破棄して、最初から作り直す");
    console.log("  [3] 生成はスキップして、このまま放流フェーズへ進む");
    console.log("👉 ※15秒間入力がない場合、寝落ち対策として自動で [1] を選択します。");
    console.log("=".repeat(60));

    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

        const timer = setTimeout(() => {
            console.log("\n⏳ 15秒経過：自動で【[1] キューを残して追加生成】を選択しました！");
            rl.close();
            resolve("append");
        }, 15000);

        rl.question("選択 [1/2/3] > ", (answer) => {
            clearTimeout(timer);
            rl.close();
            const choice = answer.trim();
            if (choice === "2") {
                console.log("🗑️ 既存キューを破棄して最初から作り直します。");
                postQueue = [];
                saveQueue();
                resolve("generate");
            } else if (choice === "3") {
                console.log("⏩ 生成をスキップして放流へ進みます。");
                resolve("skip");
            } else {
                console.log("✨ 既存キューを残したまま追加生成を開始します！");
                resolve("append");
            }
        });
    });
}

// ==========================================
// 📝 TLBU/日付_連番.txt へ5回ごとに自動分割保存＆パーサー
// ==========================================
function appendToFullLog(modelName, topic, rawText) {
    try {
        if (!fs.existsSync(TL_BACKUP_DIR)) {
            fs.mkdirSync(TL_BACKUP_DIR, { recursive: true });
        }

        const dateStr = getJstDateString();
        const prefix = `${dateStr}_`;
        const pad = n => String(n).padStart(2, '0');

        const existing = fs.readdirSync(TL_BACKUP_DIR)
            .filter(f => f.startsWith(prefix) && f.endsWith('.txt'))
            .map(f => {
                const m = f.match(/_(\d+)\.txt$/);
                return m ? { name: f, num: parseInt(m[1], 10) } : null;
            })
            .filter(Boolean)
            .sort((a, b) => a.num - b.num);

        let targetNum = 1;
        if (existing.length > 0) {
            const latest = existing[existing.length - 1];
            targetNum = latest.num;
            const latestContent = readTextSafe(path.join(TL_BACKUP_DIR, latest.name));
            const entryCount = (latestContent.match(/^▼=== \[/gm) || []).length;
            if (entryCount >= 5) {
                targetNum = latest.num + 1;
            }
        }

        const targetFileName = `${dateStr}_${pad(targetNum)}.txt`;
        const targetPath = path.join(TL_BACKUP_DIR, targetFileName);
        const header = `\n▼=== [${formatJstTimestamp()}] モデル: ${modelName} ===\n話題: ${topic}\n----------------------------------------\n`;
        fs.appendFileSync(targetPath, header + rawText.trim() + "\n", 'utf8');
        console.log(`   📝 生ログ保存: TLBU/${targetFileName}`);
    } catch (e) {
        console.error(`⚠️ 全文ログ(TLBU)への保存に失敗:`, e.message);
    }
}

function cleanCharacterName(rawName) {
    return rawName
        .trim()
        .replace(/^(?:[-*・•]|\d+[.)．、])\s*/, '')
        .replace(/^[@【\[\(\*_\s]+|[】\]\)\*_\s]+$/g, '')
        .trim();
}

function parseGeminiTweets(rawText) {
    const charNames = Object.keys(CONFIG.CHARACTERS);
    const posts = [];
    const lines = rawText.replace(/\r\n/g, '\n').split('\n');

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line.startsWith('```')) continue;

        let matchedName = "";
        let content = "";

        if (line.includes("<>")) {
            const sepIdx = line.indexOf("<>");
            const candidate = cleanCharacterName(line.slice(0, sepIdx));
            content = line.slice(sepIdx + 2).trim();

            if (CONFIG.CHARACTERS[candidate]) {
                matchedName = candidate;
            } else {
                const partial = charNames.find(c => candidate === c || candidate.startsWith(c));
                if (partial) matchedName = partial;
            }
        } else {
            const cleanedStart = line.replace(/^(?:[-*・•]|\d+[.)．、])\s*/, '').replace(/^[*_【\[@]+/, '');
            for (const cName of charNames) {
                const escaped = cName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const re = new RegExp(`^${escaped}[\\*\\]_】\\)@\\s]*[:：]\\s*(.+)$`);
                const m = cleanedStart.match(re);
                if (m) {
                    matchedName = cName;
                    content = m[1].trim();
                    break;
                }
            }
        }

        if (matchedName && content) {
            posts.push({ name: matchedName, content: content });
        } else if (posts.length > 0 && !line.startsWith('【')) {
            posts[posts.length - 1].content += `\n${line}`;
        }
    }

    return posts;
}

// ==========================================
// ⚡ 深夜エコキュート生成エンジン
// ==========================================
function isQuota429Error(err) {
    const msg = (err?.message || String(err)).toLowerCase();
    return msg.includes("429") || msg.includes("quota") || msg.includes("resource_exhausted") || msg.includes("too many requests");
}

async function generateSingleBlock(modelName, promptTopic, isGodPost = false) {
    let personaSettings = "";
    for (const fileName of CONFIG.ALWAYS_LOAD_FILES) {
        const filePath = `${CONFIG.BASE_DIR}/${fileName}`;
        if (fs.existsSync(filePath)) {
            personaSettings += `\n\n--- FILE: ${fileName} ---\n` + readTextSafe(filePath);
        }
    }

    const ragContext = await retrieveContext(promptTopic);
    const systemPrompt = buildSystemPrompt(CONFIG, personaSettings, ragContext);

    const requestParts = [systemPrompt, `【話題】\n${promptTopic}`];
    const model = genAI.getGenerativeModel({ model: modelName, safetySettings: safetySettings });
    const result = await model.generateContent(requestParts);
    const text = result.response.text();

    appendToFullLog(modelName, promptTopic, text);

    const otakuPosts = parseGeminiTweets(text);
    if (otakuPosts.length < 5) {
        throw new Error(`有効なツイート抽出数が不足しています (抽出数: ${otakuPosts.length}件 ※原文はTLBUフォルダに保存済)`);
    }

    const finalPosts = [];
    if (isGodPost) {
        finalPosts.push({ name: CONFIG.GOD_NAME, content: promptTopic, isGod: true });
    }
    finalPosts.push(...otakuPosts);

    return finalPosts;
}

async function runGenerationRound(allowDuringDaytime = false) {
    console.log("\n" + "=".repeat(60));
    console.log(`🌙 【仮想TL生成ラウンド開始】 [${formatJstTimestamp()}]`);
    console.log(`現在のキュー保持数: ${postQueue.length} 件`);
    console.log("=".repeat(60) + "\n");

    let godTopics = [];
    if (fs.existsSync(CONFIG.USER_POSTS_FILE)) {
        godTopics = readTextSafe(CONFIG.USER_POSTS_FILE)
            .split('\n')
            .map(t => t.trim())
            .filter(t => t && !t.startsWith('#'));
    }

    let poolTopics = [];
    if (fs.existsSync(CONFIG.TOPICS_FILE)) {
        poolTopics = readTextSafe(CONFIG.TOPICS_FILE)
            .split('\n')
            .map(t => t.replace(/^[・\-\*]\s*/, '').trim())
            .filter(t => t && !t.startsWith('#'));
    }

    const models = getModelList();
    let currentModelIdx = 0;
    const remainingGodTopics = [...godTopics];

    let generatedPostsCount = 0;
    const modelsHit429 = new Set();

    const shouldStopForMorning = () => !allowDuringDaytime && !isNightGenerationTime();

    while (remainingGodTopics.length > 0 && currentModelIdx < models.length) {
        if (shouldStopForMorning()) {
            console.log(`⏰ 朝${CONFIG.SETTINGS.generationEndHour}時を過ぎたため生成を終了します。`);
            return { generatedPostsCount, allModels429: false, morningArrived: true };
        }

        const godTopic = remainingGodTopics[0];
        const targetModel = models[currentModelIdx];
        console.log(`👑 神の仕込み生成中 [モデル: ${targetModel}]：「${godTopic.substring(0, 20)}...」`);

        try {
            const posts = await generateSingleBlock(targetModel, godTopic, true);
            postQueue.push(...posts);
            generatedPostsCount += posts.length;
            saveQueue();
            console.log(`   ✨ 成功！ (+${posts.length}ツイート / 総計: ${postQueue.length}件)`);

            remainingGodTopics.shift();
            fs.writeFileSync(CONFIG.USER_POSTS_FILE, remainingGodTopics.join('\n'), 'utf8');
            await sleep(4000);
        } catch (err) {
            console.error(`   ⚠️ 生成失敗 (${err.message})`);
            if (isQuota429Error(err)) {
                console.log(`   🛑 モデル【${targetModel}】上限検知(429)！次のモデルへ移行します。`);
                modelsHit429.add(targetModel);
                currentModelIdx++;
            } else {
                console.log(`   ⚠️ 一時エラーまたは形式崩れ。次のモデルへ移行します...`);
                currentModelIdx++;
                await sleep(4000);
            }
        }
    }

    if (remainingGodTopics.length === 0 && currentModelIdx < models.length) {
        console.log("\n🎰 余剰枠をネタ帳から限界まで使い切ります...");
        while (currentModelIdx < models.length) {
            if (shouldStopForMorning()) {
                console.log(`⏰ 朝${CONFIG.SETTINGS.generationEndHour}時を過ぎたため生成を終了します。`);
                return { generatedPostsCount, allModels429: false, morningArrived: true };
            }

            const targetModel = models[currentModelIdx];
            const randomTopic = poolTopics.length > 0
                ? poolTopics[Math.floor(Math.random() * poolTopics.length)]
                : "推しCPの最高に狂った性癖や日常の幻覚";

            console.log(`🎲 ネタ帳から生成中 [モデル: ${targetModel}]：「${randomTopic.substring(0, 20)}...」`);
            try {
                const posts = await generateSingleBlock(targetModel, randomTopic, false);
                postQueue.push(...posts);
                generatedPostsCount += posts.length;
                saveQueue();
                console.log(`   ✨ 成功！ (+${posts.length}ツイート / 総計: ${postQueue.length}件)`);
                await sleep(4000);
            } catch (err) {
                console.error(`   ⚠️ ネタ帳生成失敗 (${err.message})`);
                if (isQuota429Error(err)) {
                    console.log(`   🛑 モデル【${targetModel}】上限検知(429)！次のモデルへ移行します。`);
                    modelsHit429.add(targetModel);
                    currentModelIdx++;
                } else {
                    console.log(`   ⚠️ 一時エラーまたは形式崩れ。次のモデルへ移行します...`);
                    currentModelIdx++;
                    await sleep(4000);
                }
            }
        }
    }

    const allModels429 = models.length > 0 && modelsHit429.size >= models.length;
    console.log("\n" + "=".repeat(60));
    console.log(`🏁 ラウンド終了！ 今回増加: +${generatedPostsCount}件 / 現在のストック総数: ${postQueue.length}件`);
    console.log("=".repeat(60) + "\n");

    return { generatedPostsCount, allModels429, morningArrived: false };
}

async function runEcoCuteNightLoop() {
    const endHour = CONFIG.SETTINGS.generationEndHour;
    const retryMs = CONFIG.SETTINGS.retryIntervalMinutes * 60 * 1000;

    if (!isNightGenerationTime()) {
        if (postQueue.length === 0) {
            console.log(`ℹ️ 現在は昼間時間帯（${getJstHour()}時台 JST）ですが、キューが空のため1回だけ生成テストを行います。`);
            await runGenerationRound(true);
        } else {
            console.log(`ℹ️ 現在は昼間時間帯（${getJstHour()}時台 JST）のため、そのまま放流フェーズへ進みます。`);
        }
        return;
    }

    let consecutiveFull429ZeroRounds = 0;

    while (isNightGenerationTime()) {
        const res = await runGenerationRound(false);

        if (res.morningArrived || !isNightGenerationTime()) {
            console.log(`🌅 朝${endHour}:00になったため、夜間生成フェーズを完了します。`);
            break;
        }

        if (res.generatedPostsCount === 0 && res.allModels429) {
            consecutiveFull429ZeroRounds++;
        } else {
            consecutiveFull429ZeroRounds = 0;
        }

        if (consecutiveFull429ZeroRounds >= 2) {
            console.log("🛑 すべてのモデルが連続して429上限となり本日の枠を使い切ったため、朝5時の放流開始まで待機に入ります。");
            break;
        }

        const msLeftToMorning = msUntilNextJstHour(endHour);
        const waitMs = Math.min(retryMs, msLeftToMorning);

        if (waitMs <= 10000) {
            console.log(`🌅 まもなく朝${endHour}:00のため、待機して放流フェーズへ移ります。`);
            if (waitMs > 0) await sleep(waitMs);
            break;
        }

        const waitMinutes = Math.ceil(waitMs / 60000);
        console.log("\n" + "=".repeat(60));
        console.log(`⏳ [${formatJstTimestamp()}] 現在のストック: ${postQueue.length}件`);
        console.log(`🔄 朝${endHour}:00まで粘り強く生成を続けます。約${waitMinutes}分後に全モデルへ再アタックします...`);
        console.log("=".repeat(60) + "\n");

        await sleep(waitMs);
    }
}

// ==========================================
// ☀️ 昼間（5:00〜22:00）の順次放流エンジン
// ==========================================
function splitTextForDiscord(text, maxLen = 1950) {
    if (text.length <= maxLen) return [text];
    const parts = [];
    let remaining = text;
    while (remaining.length > 0) {
        parts.push(remaining.slice(0, maxLen));
        remaining = remaining.slice(maxLen);
    }
    return parts;
}

async function sendWebhookPost(post) {
    const avatarUrl = post.isGod
        ? CONFIG.GOD_AVATAR
        : (CONFIG.CHARACTERS[post.name] || "https://cdn.discordapp.com/embed/avatars/0.png");

    const chunks = splitTextForDiscord(post.content, 1950);
    for (const chunk of chunks) {
        try {
            await axios.post(CONFIG.WEBHOOK_URL, {
                username: post.name,
                avatar_url: avatarUrl,
                content: chunk
            });
            if (chunks.length > 1) await sleep(1000);
        } catch (e) {
            console.error(`❌ 送信エラー (${post.name}):`, e.message);
        }
    }
    console.log(`[放流済 ${formatJstTimestamp()}] ${post.name}: ${post.content.substring(0, 30).replace(/\n/g, ' ')}... (残り: ${postQueue.length}件)`);
}

async function runDaytimeBroadcasting() {
    const { broadcastStartHour, broadcastEndHour } = CONFIG.SETTINGS;
    console.log("⏰ 投稿スケジュール待機フェーズへ移行します。");

    while (true) {
        const currentHour = getJstHour();
        if (currentHour < broadcastStartHour || currentHour >= broadcastEndHour) {
            const waitMs = msUntilNextJstHour(broadcastStartHour);
            console.log(`💤 現在は放流時間外（${currentHour}時台 JST）です。朝${broadcastStartHour}:00まで待機中... (あと約 ${Math.ceil(waitMs / 60000)}分)`);
            await sleep(waitMs);
        } else {
            break;
        }
    }

    console.log(`\n☀️ 【日中放流フェーズ開始】 ${broadcastStartHour}:00〜${broadcastEndHour}:00(JST)にかけて順次ツイートを流します！ (総数: ${postQueue.length}件)`);

    while (postQueue.length > 0) {
        const currentHour = getJstHour();
        if (currentHour >= broadcastEndHour || currentHour < broadcastStartHour) {
            console.log(`🌙 ${broadcastEndHour}:00(JST)を回りました。本日のTL放流を終了します。残り ${postQueue.length}件はキューに保持されます。`);
            break;
        }

        const remainingTimeMs = Math.max(msUntilNextJstHour(broadcastEndHour), 60 * 1000);
        const avgIntervalMs = remainingTimeMs / postQueue.length;
        const randomFactor = (Math.random() * 0.8) + 0.6;
        let waitMs = Math.floor(avgIntervalMs * randomFactor);

        waitMs = Math.max(waitMs, 60 * 1000);
        waitMs = Math.min(waitMs, 12 * 60 * 1000);

        console.log(`⏳ 次の投稿まで約 ${Math.floor(waitMs / 1000)}秒 待機... (キュー残り: ${postQueue.length}件)`);
        await sleep(waitMs);

        const afterWaitHour = getJstHour();
        if (afterWaitHour >= broadcastEndHour || afterWaitHour < broadcastStartHour) {
            console.log(`🌙 ${broadcastEndHour}:00(JST)を回ったため、送信せずに本日の放流を終了します。`);
            break;
        }

        const post = postQueue.shift();
        saveQueue();
        await sendWebhookPost(post);
    }

    if (postQueue.length === 0) {
        console.log("\n🎊 【任務完了】 本日のすべての仮想TL投稿が終了しました！プログラムを終了します。");
        if (fs.existsSync(CONFIG.QUEUE_SAVE_FILE)) fs.unlinkSync(CONFIG.QUEUE_SAVE_FILE);
    } else {
        console.log(`\n💤 本日の稼働を終了します（未放流 ${postQueue.length}件は明日に持ち越し）。`);
    }
}

// ==========================================
// 🚀 起動処理
// ==========================================
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', async () => {
    console.log(`\n✨ 仮想TL生成システム起動！ [接続先: ${client.user.tag}] [${formatJstTimestamp()}]`);
    await initRAG();
    loadQueue();

    const action = await promptUserForQueueAction();
    if (action === "generate" || action === "append") {
        await runEcoCuteNightLoop();
    }

    await runDaytimeBroadcasting();
    client.destroy();
    process.exit(0);
});

client.login(CONFIG.DISCORD_BOT_TOKEN);
