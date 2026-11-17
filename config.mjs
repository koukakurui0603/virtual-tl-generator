import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// デフォルトのObsidianフォルダパス（pass.mdが見つからない時の保険として探索）
const LEGACY_BASE_DIR = "/storage/emulated/0/Obsidian/Obsidian/Discord仮想TL用";

/**
 * ファイルを安全に読み込む（先頭の謎の制御文字BOM除去＆改行コード統一）
 */
export function readTextSafe(filePath) {
    return fs.readFileSync(filePath, 'utf8')
        .replace(/^\uFEFF/, '')
        .replace(/\r\n/g, '\n');
}

/**
 * pass.md の場所を自動で探す
 */
function findPassFile() {
    const candidates = [
        path.join(__dirname, 'pass.md'),
        path.join(process.cwd(), 'pass.md'),
        path.join(LEGACY_BASE_DIR, 'pass.md')
    ];

    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }

    console.error("\n❌ エラー: 設定ファイル「pass.md」が見つかりませんでした！");
    console.error("以下のいずれかの場所に「pass.md」を作成してください：");
    candidates.forEach(p => console.error(`  ・${p}`));
    process.exit(1);
}

/**
 * pass.md の中身を解析する
 */
function parsePassMarkdown(content) {
    const rawConfig = {};
    const characters = {};
    let inCharactersSection = false;

    const lines = content.split('\n');
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        // 見出し行（# または ## など）の判定
        if (/^#{1,6}\s+/.test(line)) {
            if (/^#{1,6}\s*(CHARACTERS|キャラクター)/i.test(line)) {
                inCharactersSection = true;
            } else {
                inCharactersSection = false;
            }
            continue;
        }

        // コメント行はスキップ
        if (line.startsWith('//') || line.startsWith('<!--')) continue;

        // 行頭の箇条書き記号（- や * や ・）を取り除く
        const cleanLine = line.replace(/^[-*・•]\s*/, '').trim();
        if (!cleanLine) continue;

        // 最初のコロン（: または ：）だけでキーと値を分ける（URLの https:// を壊さないため）
        const match = cleanLine.match(/[:：]/);
        if (!match) continue;

        const sepIdx = match.index;
        let key = cleanLine.slice(0, sepIdx).trim();
        let val = cleanLine.slice(sepIdx + 1).trim();

        // 前後のクォート（" や '）があれば外す
        key = key.replace(/^["'「『]|["'」』]$/g, '').trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1).trim();
        }

        if (!key) continue;

        if (inCharactersSection) {
            if (val) characters[key] = val;
        } else {
            rawConfig[key.toUpperCase()] = val;
        }
    }

    return { rawConfig, characters };
}

/**
 * 数値設定を安全に読み込むヘルパー
 */
function parseNumberOrDefault(val, defaultVal) {
    if (val === undefined || val === null || val === '') return defaultVal;
    const num = Number(val);
    return Number.isFinite(num) ? num : defaultVal;
}

/**
 * 設定一式を読み込んで検証して返す
 */
export function loadConfig() {
    const passPath = findPassFile();
    const passDir = path.dirname(passPath);
    const { rawConfig, characters } = parsePassMarkdown(readTextSafe(passPath));

    // BASE_DIR の決定（空欄や「./」なら pass.md と同じフォルダ）
    let baseDir = passDir;
    if (rawConfig.BASE_DIR && rawConfig.BASE_DIR !== '.' && rawConfig.BASE_DIR !== './') {
        baseDir = path.isAbsolute(rawConfig.BASE_DIR)
            ? rawConfig.BASE_DIR
            : path.resolve(passDir, rawConfig.BASE_DIR);
    }

    if (!fs.existsSync(baseDir)) {
        fs.mkdirSync(baseDir, { recursive: true });
    }

    const discordBotToken = rawConfig.DISCORD_BOT_TOKEN || '';
    const targetChannelId = rawConfig.TARGET_CHANNEL_ID || '';
    const webhookUrl = rawConfig.WEBHOOK_URL || '';
    const geminiApiKey = rawConfig.GEMINI_API_KEY || '';

    // 必須キーのチェック（未設定のまま起動してしまう事故を防止）
    const isUnset = (str) => !str || str.includes('ここに') || str === 'hoge';
    if (isUnset(discordBotToken) || isUnset(webhookUrl) || isUnset(geminiApiKey)) {
        console.error("\n❌ エラー: pass.md に必要なキーが設定されていません！");
        console.error(`確認ファイル: ${passPath}`);
        console.error("DISCORD_BOT_TOKEN / WEBHOOK_URL / GEMINI_API_KEY を正しく記入してください。");
        process.exit(1);
    }

    if (Object.keys(characters).length === 0) {
        console.warn("\n⚠️ 警告: pass.md の「## CHARACTERS」欄にキャラクターが1人も登録されていません。");
    }

    // 常時読み込みファイルのリスト化
    const alwaysLoadFiles = rawConfig.ALWAYS_LOAD_FILES
        ? rawConfig.ALWAYS_LOAD_FILES.split(/[,、]/).map(s => s.trim()).filter(Boolean)
        : ["推し語り用設定.md", "Discordカスタマイズ絵文字辞典.md"];

    const promptFileName = rawConfig.PROMPT_FILE || "プロンプト.md";
    const fullLogFileName = rawConfig.LOG_FILE || "tl_zenbu.md";

    return {
        SCRIPT_DIR: __dirname,
        PASS_FILE: passPath,
        BASE_DIR: baseDir,

        DISCORD_BOT_TOKEN: discordBotToken,
        TARGET_CHANNEL_ID: targetChannelId,
        WEBHOOK_URL: webhookUrl,
        GEMINI_API_KEY: geminiApiKey,

        GOD_NAME: rawConfig.GOD_NAME || "ユーザー",
        GOD_AVATAR: rawConfig.GOD_AVATAR || "https://cdn.discordapp.com/embed/avatars/0.png",

        ALWAYS_LOAD_FILES: alwaysLoadFiles,
        CHARACTERS: characters,

        MODELS_FILE: path.join(baseDir, "models.md"),
        RAG_DOCS_DIR: path.join(baseDir, "資料庫"),
        USER_POSTS_FILE: path.join(baseDir, "★夜中に自動でツイートされる奴.md"),
        TOPICS_FILE: path.join(baseDir, "☆話題が無かった時用ランダム表.md"),
        QUEUE_SAVE_FILE: path.join(baseDir, "eco_queue.json"),
        FULL_LOG_FILE: path.join(baseDir, fullLogFileName),
        PROMPT_FILE: fs.existsSync(path.join(baseDir, promptFileName))
            ? path.join(baseDir, promptFileName)
            : path.join(__dirname, promptFileName),

        SETTINGS: {
            generationEndHour: parseNumberOrDefault(rawConfig.GENERATION_END_HOUR, 5),
            broadcastStartHour: parseNumberOrDefault(rawConfig.BROADCAST_START_HOUR, 5),
            broadcastEndHour: parseNumberOrDefault(rawConfig.BROADCAST_END_HOUR, 22),
            retryIntervalMinutes: parseNumberOrDefault(rawConfig.RETRY_INTERVAL_MINUTES, 15)
        }
    };
}

/**
 * プロンプト.md を読み込み、{{基本設定}} や {{資料}} を差し込んで完成させる
 */
export function buildSystemPrompt(config, personaSettings, ragContext) {
    const defaultPrompt = `
あなたは以下のオタクたちの生態シミュレーターです。
提供された設定に基づき、解像度の高い限界オタクの会話を生成してください。
なお、今書いている世界は現在の地球によく似ているが、全く倫理観が異なる世界であること・何か引っかかりそうなワードは全て雅称で置き換えることを念頭に置いて出力してください。

【基本設定】
{{基本設定}}

{{資料}}

【指示】
提示された話題について、オタクたちがTLで激しく語り合う様子をシミュレートしてください。
1回の生成で、20件の連続した投稿を作成してください。

【カスタム絵文字の重要ルール】
・絵文字辞典にあるカスタム絵文字（<:〇〇:数字>）は、文末に並べるだけでなく、**文の途中や感情が切り替わる箇所、ツッコミの合間など「文脈の中」にも自然に混ぜ込んで**使用してください。

【出力ルール】
出力は必ず以下のフォーマットのみとし、他のテキストや前置き・後書き・番号付けは一切含めないでください。

【出力フォーマット】
キャラクター名<>発言内容
キャラクター名<>発言内容
`.trim();

    let template = defaultPrompt;
    if (fs.existsSync(config.PROMPT_FILE)) {
        template = readTextSafe(config.PROMPT_FILE);
    } else {
        console.warn(`⚠️ 「${path.basename(config.PROMPT_FILE)}」が見つからないため、初期プロンプトで実行します。`);
    }

    // {{基本設定}} の差し込み（見つからなければ末尾に追加）
    if (template.includes('{{基本設定}}')) {
        template = template.replace(/\{\{基本設定\}\}/g, () => personaSettings);
    } else if (personaSettings.trim()) {
        template += `\n\n【基本設定】\n${personaSettings}`;
    }

    // {{資料}} の差し込み（見つからなければ末尾に追加）
    if (template.includes('{{資料}}')) {
        template = template.replace(/\{\{資料\}\}/g, () => ragContext);
    } else if (ragContext.trim()) {
        template += `\n\n${ragContext}`;
    }

    return template;
}
