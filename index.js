// package.json dependencies:
// "discord.js": "^14.25.1"
// (ffmpeg & yt-dlp.exe must be available — ffmpeg on PATH, yt-dlp.exe in project root)

require("dotenv").config();

const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    AttachmentBuilder,
    EmbedBuilder,
    PermissionsBitField,
    ChannelType,
} = require("discord.js");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const https = require("https");
const http = require("http");
const express = require("express");

// ─── CONFIGURATION ──────────────────────────────────────────────────────────

const CONFIG = {
    token: process.env.DISCORD_TOKEN,
    prefix: "!",
    commandName: "indir",
    maxUploadBytes: 25 * 1024 * 1024,
    uploadSafetyMarginBytes: 2 * 1024 * 1024,
    downloadTimeoutMs: 180_000,
    ytDlpPath: process.env.YTDLP_PATH || "yt-dlp",
    tempDir: path.join(__dirname, "temp_videos"),
    embedColor: 0x5865f2,
    errorColor: 0xed4245,
    successColor: 0x57f287,
    // API config
    apiHost: process.env.API_HOST || "127.0.0.1",
    apiPort: Number.parseInt(process.env.API_PORT || "3541", 10),
    apiKey: process.env.API_KEY,
    guildId: process.env.DISCORD_GUILD_ID,
};

function validateConfiguration() {
    const missing = ["DISCORD_TOKEN", "API_KEY", "DISCORD_GUILD_ID"]
        .filter((name) => !process.env[name]);

    if (missing.length > 0) {
        throw new Error(`Eksik ortam değişkenleri: ${missing.join(", ")}. .env.example dosyasını kullanın.`);
    }

    if (CONFIG.apiKey.length < 16) {
        throw new Error("API_KEY en az 16 karakter olmalı.");
    }

    if (!Number.isInteger(CONFIG.apiPort) || CONFIG.apiPort < 1 || CONFIG.apiPort > 65535) {
        throw new Error("API_PORT 1-65535 arasında bir sayı olmalı.");
    }
}

// ─── SUPPORTED PLATFORMS ────────────────────────────────────────────────────

const SUPPORTED_HOSTS = new Set([
    "youtube.com", "www.youtube.com", "youtu.be", "m.youtube.com",
    "music.youtube.com", "youtube-nocookie.com",
    "instagram.com", "www.instagram.com",
    "twitter.com", "www.twitter.com", "x.com", "www.x.com",
    "tiktok.com", "www.tiktok.com", "vm.tiktok.com",
    "reddit.com", "www.reddit.com", "old.reddit.com",
    "twitch.tv", "www.twitch.tv", "clips.twitch.tv",
    "facebook.com", "www.facebook.com", "fb.watch",
    "vimeo.com", "www.vimeo.com",
    "dailymotion.com", "www.dailymotion.com",
    "streamable.com", "www.streamable.com",
    "medal.tv", "www.medal.tv",
    "kick.com", "www.kick.com",
    "bilibili.com", "www.bilibili.com",
]);

// ─── QUALITY TIERS (resolution-based — filesize filters don't work on most sites) ─

const QUALITY_TIERS = [
    {
        label: "🎬 En yüksek kalite deneniyor…",
        formatArgs: [
            "-f", "bestvideo+bestaudio/best",
            "--merge-output-format", "mp4",
        ],
    },
    {
        label: "📉 720p'ye düşürülüyor…",
        formatArgs: [
            "-f", "bestvideo[height<=720]+bestaudio/best[height<=720]/best",
            "--merge-output-format", "mp4",
        ],
    },
    {
        label: "📉 480p'ye düşürülüyor…",
        formatArgs: [
            "-f", "bestvideo[height<=480]+bestaudio/best[height<=480]/best",
            "--merge-output-format", "mp4",
        ],
    },
    {
        label: "📉 360p'ye düşürülüyor…",
        formatArgs: [
            "-f", "bestvideo[height<=360]+bestaudio/best[height<=360]/best",
            "--merge-output-format", "mp4",
        ],
    },
    {
        label: "⬇️ En düşük kaliteye geçiliyor…",
        formatArgs: [
            "-f", "worst",
            "--merge-output-format", "mp4",
        ],
    },
];

// ─── LOGGING ────────────────────────────────────────────────────────────────

function log(level, component, message, meta) {
    const ts = new Date().toISOString();
    const prefix = `[${ts}] [${level}] [${component}]`;
    if (meta) {
        console.log(`${prefix} ${message}`, meta);
    } else {
        console.log(`${prefix} ${message}`);
    }
}

// ─── ERROR CLASSIFICATION ───────────────────────────────────────────────────

const ERROR_PATTERNS = [
    { pattern: /Unsupported URL/i, msg: "❌ Bu URL desteklenmiyor. yt-dlp bu siteyi tanımıyor." },
    { pattern: /is not a valid URL/i, msg: "❌ Geçersiz URL formatı." },
    { pattern: /Video unavailable/i, msg: "❌ Video mevcut değil veya kaldırılmış." },
    { pattern: /Private video/i, msg: "❌ Bu video gizli (private), erişim izni yok." },
    { pattern: /Sign in to confirm your age/i, msg: "❌ Bu video yaş doğrulaması gerektiriyor, indirilemez." },
    { pattern: /This post may not be comfortable for some audiences|Log in for access/i, msg: "❌ TikTok bu gönderi için giriş veya yaş doğrulaması istiyor. Zen tarayıcısında TikTok hesabına giriş yapıp tekrar dene." },
    { pattern: /HTTP Error 403/i, msg: "❌ Erişim reddedildi (403). Video kısıtlı olabilir." },
    { pattern: /HTTP Error 404/i, msg: "❌ Sayfa bulunamadı (404). Link geçersiz olabilir." },
    { pattern: /HTTP Error 429/i, msg: "⏳ Çok fazla istek gönderildi (rate limit). Biraz bekleyip tekrar dene." },
    { pattern: /HTTP Error [45]\d{2}/i, msg: "❌ Sunucu hatası. Video indirilemedi." },
    { pattern: /too large|entity too large|413/i, msg: "❌ Video dosyası Discord limiti için çok büyük. Tüm kaliteler denendi." },
    { pattern: /ffmpeg.*not found/i, msg: "❌ ffmpeg bulunamadı. Sunucuda ffmpeg kurulu değil." },
    { pattern: /ffprobe.*not found/i, msg: "❌ ffprobe bulunamadı. Sunucuda ffmpeg kurulu değil." },
    { pattern: /Postprocessing/i, msg: "❌ Video işleme (postprocessing) hatası. ffmpeg sorunu olabilir." },
    { pattern: /EACCES|Permission denied/i, msg: "❌ Dosya yazma izni hatası. Sunucu izinlerini kontrol et." },
    { pattern: /ENOSPC|No space left/i, msg: "❌ Diskte yeterli alan yok." },
    { pattern: /ENOENT/i, msg: "❌ yt-dlp çalıştırılamadı: dosya bulunamadı." },
    {
        pattern: /getaddrinfo|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network/i,
        msg: "❌ Ağ bağlantı hatası. İnternet bağlantısını kontrol et."
    },
    { pattern: /Login required/i, msg: "❌ Bu içerik giriş yapılmasını gerektiriyor." },
    { pattern: /Geo-restricted/i, msg: "❌ Bu video bölge kısıtlamalı, erişilemiyor." },
    { pattern: /This live event has ended/i, msg: "❌ Bu canlı yayın sona ermiş." },
    { pattern: /Incomplete.*download/i, msg: "❌ İndirme yarım kaldı, tekrar dene." },
];

function classifyError(err) {
    const text = err?.message || err?.toString() || "";

    if (text === "TIMEOUT") {
        return "⏱️ İndirme zaman aşımına uğradı. Lütfen daha kısa bir video dene.";
    }
    if (text === "ALL_TIERS_FAILED") {
        return "❌ Tüm kalite seviyeleri denendi, hiçbiri başarılı olmadı. Link geçersiz, desteklenmiyor veya dosya çok büyük.";
    }
    if (text === "FFMPEG_REENCODE_FAILED") {
        return "❌ Video boyutu ffmpeg ile de düşürülemedi.";
    }
    if (text === "FILE_NOT_FOUND") {
        return "❌ İndirme tamamlandı ancak dosya oluşturulamadı.";
    }
    if (text === "EMPTY_FILE") {
        return "❌ İndirilen dosya boş (0 byte). Video indirilememiş olabilir.";
    }

    for (const { pattern, msg } of ERROR_PATTERNS) {
        if (pattern.test(text)) return msg;
    }

    const short = text.length > 200 ? text.substring(0, 200) + "…" : text;
    return `❌ yt-dlp hatası: ${short}`;
}

// ─── HELPERS ────────────────────────────────────────────────────────────────

function isValidUrl(str) {
    try {
        const parsed = new URL(str);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
        return false;
    }
}

function getHostname(urlStr) {
    try {
        return new URL(urlStr).hostname.replace(/^www\./, "");
    } catch {
        return null;
    }
}

function isPlatformSupported(urlStr) {
    const hostname = getHostname(urlStr);
    if (!hostname) return false;
    for (const host of SUPPORTED_HOSTS) {
        const clean = host.replace(/^www\./, "");
        if (hostname === clean || hostname.endsWith("." + clean)) return true;
    }
    return false;
}

function ensureTempDir() {
    if (!fs.existsSync(CONFIG.tempDir)) {
        fs.mkdirSync(CONFIG.tempDir, { recursive: true });
    }
}

function safeDelete(filePath) {
    try {
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {
        log("WARN", "CLEANUP", `Dosya silinemedi: ${filePath}`, e.message);
    }
}

function cleanupTempFiles(prefix) {
    try {
        if (!fs.existsSync(CONFIG.tempDir)) return;
        for (const file of fs.readdirSync(CONFIG.tempDir)) {
            if (file.startsWith(prefix)) {
                safeDelete(path.join(CONFIG.tempDir, file));
            }
        }
    } catch (e) {
        log("WARN", "CLEANUP", "Temp dosyalar temizlenemedi", e.message);
    }
}

function safeDeleteMessage(msg) {
    if (!msg) return Promise.resolve();
    return msg.delete().catch((e) => {
        log("WARN", "MSG_CLEANUP", `Mesaj silinemedi: ${e.message}`);
    });
}

function statusEmbed(description, color) {
    return new EmbedBuilder()
        .setDescription(description)
        .setColor(color || CONFIG.embedColor)
        .setTimestamp();
}

function errorEmbed(description) {
    return statusEmbed(description, CONFIG.errorColor);
}

function successEmbed(description) {
    return statusEmbed(description, CONFIG.successColor);
}

// ─── FFMPEG AVAILABILITY CHECK ──────────────────────────────────────────────

let ffmpegAvailable = false;

function checkFfmpeg() {
    return new Promise((resolve) => {
        execFile("ffmpeg", ["-version"], { timeout: 5000, windowsHide: true }, (err) => {
            ffmpegAvailable = !err;
            if (ffmpegAvailable) {
                log("INFO", "FFMPEG", "ffmpeg bulundu, re-encode fallback aktif.");
            } else {
                log("WARN", "FFMPEG", "ffmpeg bulunamadı, re-encode fallback devre dışı.");
            }
            resolve(ffmpegAvailable);
        });
    });
}

// ─── FFMPEG RE-ENCODE ───────────────────────────────────────────────────────

function ffmpegReencode(inputPath, outputPath, maxBytes) {
    return new Promise((resolve, reject) => {
        const args = [
            "-y", "-err_detect", "ignore_err", "-i", inputPath,
            "-fs", String(maxBytes - 512 * 1024),
            "-c:v", "libx264", "-preset", "fast", "-crf", "28",
            "-c:a", "aac", "-b:a", "96k",
            "-movflags", "+faststart",
            outputPath,
        ];
        execFile("ffmpeg", args, {
            timeout: CONFIG.downloadTimeoutMs,
            maxBuffer: 10 * 1024 * 1024,
            windowsHide: true,
        }, (error, _stdout, stderr) => {
            if (error) {
                if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
                    log("WARN", "FFMPEG", "Kaynak akışta bozuk kareler atlandı, kullanılabilir çıktı oluşturuldu.");
                    return resolve(outputPath);
                }
                log("ERROR", "FFMPEG", "Re-encode başarısız", stderr?.substring(0, 300));
                return reject(new Error("FFMPEG_REENCODE_FAILED"));
            }
            resolve(outputPath);
        });
    });
}

// ─── YT-DLP RUNNER ──────────────────────────────────────────────────────────

let browserCookieArgs;

function getBrowserCookieArgs() {
    if (browserCookieArgs) return browserCookieArgs;

    const profilesDir = process.env.APPDATA
        ? path.join(process.env.APPDATA, "zen", "Profiles")
        : null;

    if (!profilesDir || !fs.existsSync(profilesDir)) {
        browserCookieArgs = [];
        return browserCookieArgs;
    }

    let profiles;
    try {
        profiles = fs.readdirSync(profilesDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => path.join(profilesDir, entry.name))
            .filter((profilePath) => fs.existsSync(path.join(profilePath, "cookies.sqlite")));
    } catch (err) {
        log("WARN", "YTDLP", `Zen profilleri okunamadı: ${err.message}`);
        browserCookieArgs = [];
        return browserCookieArgs;
    }

    if (profiles.length === 0) {
        log("INFO", "YTDLP", "Kullanılabilir Zen cookie profili bulunamadı, cookiesiz devam edilecek.");
        browserCookieArgs = [];
        return browserCookieArgs;
    }

    browserCookieArgs = ["--cookies-from-browser", `firefox:${profiles[0]}`];
    log("INFO", "YTDLP", `Zen cookie profili kullanılıyor: ${path.basename(profiles[0])}`);
    return browserCookieArgs;
}

function runYtDlp(url, outputTemplate, formatArgs) {
    return new Promise((resolve, reject) => {
        const args = [
            "--no-playlist",
            "--no-warnings",
            "--no-check-certificates",
            ...getBrowserCookieArgs(),
            "--encoding", "utf-8",
            "-o", outputTemplate,
            ...formatArgs,
            url,
        ];

        log("INFO", "YTDLP", `Başlatılıyor: ${formatArgs.join(" ")}`);

        execFile(
            CONFIG.ytDlpPath,
            args,
            {
                timeout: CONFIG.downloadTimeoutMs,
                maxBuffer: 10 * 1024 * 1024,
                windowsHide: true,
            },
            (error, stdout, stderr) => {
                if (error) {
                    if (error.killed) return reject(new Error("TIMEOUT"));
                    const detail = stderr?.trim() || error.message || "yt-dlp bilinmeyen hata";
                    log("ERROR", "YTDLP", `Hata: ${detail.substring(0, 300)}`);
                    return reject(new Error(detail));
                }

                log("INFO", "YTDLP", "İndirme tamamlandı.");
                resolve();
            },
        );
    });
}

function isAccessRestrictedError(message) {
    return /This post may not be comfortable for some audiences|Log in for access|Sign in to confirm your age|Login required/i.test(message);
}

// ─── FILE FINDER ────────────────────────────────────────────────────────────

function findOutputFile(filePrefix) {
    if (!fs.existsSync(CONFIG.tempDir)) return null;
    const files = fs.readdirSync(CONFIG.tempDir);
    for (const f of files) {
        if (f === filePrefix + ".mp4") return path.join(CONFIG.tempDir, f);
    }
    for (const f of files) {
        if (f.startsWith(filePrefix) && !f.endsWith(".part") && !f.endsWith(".ytdl")) {
            return path.join(CONFIG.tempDir, f);
        }
    }
    return null;
}

// ─── CORE DOWNLOAD + UPLOAD PIPELINE ────────────────────────────────────────
// Upload is inside the tier loop: if Discord rejects the file ("Request entity
// too large"), we clean up and try the next lower quality tier automatically.

async function downloadAndUpload(channel, url, onStatus) {
    ensureTempDir();

    const uniqueId = crypto.randomUUID().replace(/-/g, "").substring(0, 16);
    const filePrefix = `dl_${uniqueId}`;
    const outputTemplate = path.join(CONFIG.tempDir, `${filePrefix}.%(ext)s`);

    for (let i = 0; i < QUALITY_TIERS.length; i++) {
        const tier = QUALITY_TIERS[i];
        let outputFile = null;

        try {
            await onStatus(tier.label);
            cleanupTempFiles(filePrefix);
            await runYtDlp(url, outputTemplate, tier.formatArgs);

            outputFile = findOutputFile(filePrefix);
            if (!outputFile) {
                log("WARN", "DOWNLOAD", `Tier ${i}: dosya bulunamadı, sonraki deneniyor.`);
                continue;
            }

            const stats = fs.statSync(outputFile);

            if (stats.size === 0) {
                log("WARN", "DOWNLOAD", `Tier ${i}: dosya boş.`);
                safeDelete(outputFile);
                continue;
            }

            const sizeMB = (stats.size / 1024 / 1024).toFixed(1);

            // Keep a margin for Discord's multipart request overhead.
            const safeUploadBytes = CONFIG.maxUploadBytes - CONFIG.uploadSafetyMarginBytes;
            if (stats.size > safeUploadBytes) {
                log("INFO", "DOWNLOAD", `Tier ${i}: ${sizeMB} MB — limit aşıldı.`);

                // ffmpeg re-encode attempt on any tier
                if (ffmpegAvailable) {
                    await onStatus("🔧 ffmpeg ile boyut küçültülüyor…");
                    const reencoded = path.join(CONFIG.tempDir, `${filePrefix}_re.mp4`);
                    try {
                        await ffmpegReencode(outputFile, reencoded, safeUploadBytes);
                        safeDelete(outputFile);
                        outputFile = reencoded;

                        const reStats = fs.statSync(reencoded);
                        if (reStats.size > 0 && reStats.size <= safeUploadBytes) {
                            log("INFO", "FFMPEG", `Re-encode başarılı: ${(reStats.size / 1024 / 1024).toFixed(1)} MB`);
                            // Fall through to upload attempt below
                        } else {
                            safeDelete(reencoded);
                            outputFile = null;
                            continue;
                        }
                    } catch {
                        safeDelete(reencoded);
                        safeDelete(outputFile);
                        outputFile = null;
                        log("WARN", "FFMPEG", "Re-encode başarısız, sonraki tier'a geçiliyor.");
                        continue;
                    }
                } else {
                    safeDelete(outputFile);
                    outputFile = null;
                    continue;
                }
            }

            // ── UPLOAD ATTEMPT (inside the tier loop) ──
            log("INFO", "DOWNLOAD", `Tier ${i}: ${sizeMB} MB, yükleniyor…`);
            await onStatus("📤 Discord'a yükleniyor…");

            try {
                const fileName = path.basename(outputFile);
                const attachment = new AttachmentBuilder(outputFile, { name: fileName });
                await channel.send({ files: [attachment] });
            } catch (uploadErr) {
                const errMsg = uploadErr?.message || "";
                const isTooLarge = /too large|entity too large|Request entity too large|413/i.test(errMsg);

                if (isTooLarge) {
                    log("WARN", "UPLOAD", `Tier ${i}: Discord yüklemeyi reddetti (dosya çok büyük), sonraki tier deneniyor.`);
                    safeDelete(outputFile);
                    outputFile = null;
                    continue; // ← next tier
                }
                // Not a size error — rethrow
                throw uploadErr;
            }

            // Upload succeeded — clean up file and return
            safeDelete(outputFile);
            log("INFO", "UPLOAD", `Video başarıyla yüklendi: Tier ${i}`);
            return;

        } catch (err) {
            if (outputFile) safeDelete(outputFile);
            cleanupTempFiles(filePrefix);
            if (err.message === "TIMEOUT") throw err;
            if (isAccessRestrictedError(err.message || "")) throw err;
            // "Request entity too large" already handled via continue above
            log("WARN", "DOWNLOAD", `Tier ${i} başarısız: ${(err.message || "").substring(0, 200)}`);
        }
    }

    cleanupTempFiles(filePrefix);
    throw new Error("ALL_TIERS_FAILED");
}

// ─── UNIFIED COMMAND HANDLER ────────────────────────────────────────────────

async function handleIndir({ channel, url, reply, editReply, cleanup }) {
    if (!url) {
        await reply({ embeds: [errorEmbed("❌ Kullanım: `!indir <link>` veya `/indir link:<url>`")] });
        return;
    }

    if (!isValidUrl(url)) {
        await reply({ embeds: [errorEmbed("❌ Geçersiz URL. Lütfen http:// veya https:// ile başlayan geçerli bir link gir.")] });
        return;
    }

    if (!isPlatformSupported(url)) {
        const host = getHostname(url);
        await reply({
            embeds: [errorEmbed(`⚠️ \`${host}\` desteklenen platformlar listesinde yok. Yine de denenecek…`)],
        });
        await new Promise((r) => setTimeout(r, 1500));
        await editReply({ embeds: [statusEmbed("⏳ Video indiriliyor…")] });
    } else {
        await reply({ embeds: [statusEmbed("⏳ Video indiriliyor…")] });
    }

    try {
        await downloadAndUpload(channel, url, async (tierLabel) => {
            try { await editReply({ embeds: [statusEmbed(tierLabel)] }); } catch { /* non-critical */ }
        });

        // Success — message cleanup
        if (cleanup) await cleanup();
        log("INFO", "HANDLER", `Video başarıyla yüklendi: ${url}`);

    } catch (err) {
        const userMessage = classifyError(err);
        log("ERROR", "HANDLER", `Hata: ${(err.message || "").substring(0, 300)}`);

        try {
            await editReply({ embeds: [errorEmbed(userMessage)] });
        } catch {
            try { await channel.send({ embeds: [errorEmbed(userMessage)] }); } catch { /* nothing left */ }
        }
    }
}

// ─── BOT CLIENT ─────────────────────────────────────────────────────────────

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// ─── SLASH COMMAND REGISTRATION ─────────────────────────────────────────────

client.once("clientReady", async () => {
    log("INFO", "BOT", `Giriş yapıldı: ${client.user.tag}`);

    ensureTempDir();
    await checkFfmpeg();

    const slashCommand = new SlashCommandBuilder()
        .setName(CONFIG.commandName)
        .setDescription("Bir videoyu indirir ve Discord'a yükler.")
        .addStringOption((opt) =>
            opt.setName("link").setDescription("İndirilecek videonun URL'si").setRequired(true)
        );

    const rest = new REST({ version: "10" }).setToken(CONFIG.token);

    try {
        await rest.put(Routes.applicationCommands(client.user.id), {
            body: [slashCommand.toJSON()],
        });
        log("INFO", "BOT", "Slash komutlar kaydedildi.");
    } catch (err) {
        log("ERROR", "BOT", "Slash komut kaydı başarısız", err.message);
    }
});

// ─── SLASH COMMAND HANDLER ──────────────────────────────────────────────────

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== CONFIG.commandName) return;

    const url = interaction.options.getString("link");
    log("INFO", "SLASH", `Komut alındı — URL: ${url}`);

    try {
        await handleIndir({
            channel: interaction.channel,
            url,
            reply: async (data) => {
                await interaction.reply(data);
            },
            editReply: async (data) => {
                await interaction.editReply(data);
            },
            cleanup: async () => {
                // Slash komutta: sadece durum mesajını sil, video kalsın
                try { await interaction.deleteReply(); } catch { /* non-critical */ }
            },
        });
    } catch (err) {
        log("ERROR", "SLASH", `Beklenmeyen hata: ${err.message}`);
        try {
            if (interaction.replied || interaction.deferred) {
                await interaction.editReply({ embeds: [errorEmbed(classifyError(err))] });
            } else {
                await interaction.reply({ embeds: [errorEmbed(classifyError(err))] });
            }
        } catch { /* nothing left */ }
    }
});

// ─── PREFIX COMMAND HANDLER ─────────────────────────────────────────────────

client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (!message.content.startsWith(CONFIG.prefix)) return;

    const args = message.content.slice(CONFIG.prefix.length).trim().split(/\s+/);
    const command = args.shift()?.toLowerCase();
    if (command !== CONFIG.commandName) return;

    const url = args[0];
    log("INFO", "PREFIX", `Komut alındı — Kullanıcı: ${message.author.tag}, URL: ${url}`);

    let statusMessage = null;

    try {
        await handleIndir({
            channel: message.channel,
            url,
            reply: async (data) => {
                statusMessage = await message.reply(data);
            },
            editReply: async (data) => {
                if (statusMessage) await statusMessage.edit(data);
            },
            cleanup: async () => {
                // Prefix komutta: kullanıcı mesajı + bot durum mesajı silinir, sadece video kalır
                const canManage = message.guild?.members?.me
                    ?.permissionsIn(message.channel)
                    ?.has(PermissionsBitField.Flags.ManageMessages);

                if (canManage) {
                    await safeDeleteMessage(message);
                }
                await safeDeleteMessage(statusMessage);
            },
        });
    } catch (err) {
        log("ERROR", "PREFIX", `Beklenmeyen hata: ${err.message}`);
        try {
            if (statusMessage) {
                await statusMessage.edit({ embeds: [errorEmbed(classifyError(err))] });
            } else {
                await message.channel.send({ embeds: [errorEmbed(classifyError(err))] });
            }
        } catch { /* nothing left */ }
    }
});

// ─── IMAGE DOWNLOAD HELPER ──────────────────────────────────────────────────

function downloadImage(imageUrl, destPath) {
    return new Promise((resolve, reject) => {
        const mod = imageUrl.startsWith("https") ? https : http;
        const req = mod.get(imageUrl, { timeout: 30000 }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return downloadImage(res.headers.location, destPath).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const ws = fs.createWriteStream(destPath);
            res.pipe(ws);
            ws.on("finish", () => { ws.close(); resolve(destPath); });
            ws.on("error", reject);
        });
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("TIMEOUT")); });
    });
}

// ─── HTTP API SERVER ────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
});

// Auth middleware
function apiAuth(req, res, next) {
    const key = req.headers["x-api-key"];
    if (key !== CONFIG.apiKey) {
        return res.status(401).json({ error: "Geçersiz API anahtarı" });
    }
    next();
}

// GET /api/channels
app.get("/api/channels", apiAuth, async (req, res) => {
    try {
        const guild = await client.guilds.fetch(CONFIG.guildId);
        const channels = await guild.channels.fetch();
        const textChannels = [];

        channels.forEach((ch) => {
            if (ch && (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement)) {
                textChannels.push({
                    id: ch.id,
                    name: ch.name,
                    category: ch.parent?.name || null,
                });
            }
        });

        textChannels.sort((a, b) => {
            if (a.category && b.category) return a.category.localeCompare(b.category) || a.name.localeCompare(b.name);
            if (a.category) return 1;
            if (b.category) return -1;
            return a.name.localeCompare(b.name);
        });

        res.json({ channels: textChannels });
    } catch (err) {
        log("ERROR", "API", `Kanal listesi alınamadı: ${err.message}`);
        res.status(500).json({ error: "Kanal listesi alınamadı" });
    }
});

// POST /api/download
app.post("/api/download", apiAuth, async (req, res) => {
    const { url: mediaUrl, channelIds, type } = req.body;

    if (!mediaUrl) return res.status(400).json({ error: "URL gerekli" });
    if (!channelIds || !Array.isArray(channelIds) || channelIds.length === 0) {
        return res.status(400).json({ error: "En az bir kanal seçilmeli" });
    }

    log("INFO", "API", `İstek alındı — Tür: ${type || "video"}, URL: ${mediaUrl}, Kanallar: ${channelIds.join(", ")}`);

    // Respond immediately, process in background
    res.json({ status: "started", message: "İndirme başlatıldı" });

    try {
        const guild = await client.guilds.fetch(CONFIG.guildId);

        if (type === "image") {
            // Image: download directly and upload to each channel
            ensureTempDir();
            const ext = path.extname(new URL(mediaUrl).pathname) || ".jpg";
            const imgFile = path.join(CONFIG.tempDir, `img_${crypto.randomUUID().replace(/-/g, "").substring(0, 12)}${ext}`);

            try {
                await downloadImage(mediaUrl, imgFile);
                const stats = fs.statSync(imgFile);
                log("INFO", "API", `Görsel indirildi: ${(stats.size / 1024).toFixed(0)} KB`);

                for (const chId of channelIds) {
                    try {
                        const channel = await guild.channels.fetch(chId);
                        const attachment = new AttachmentBuilder(imgFile, { name: path.basename(imgFile) });
                        await channel.send({ files: [attachment] });
                        log("INFO", "API", `Görsel yüklendi: #${channel.name}`);
                    } catch (e) {
                        log("ERROR", "API", `Görsel yükleme hatası (${chId}): ${e.message}`);
                    }
                }
            } finally {
                safeDelete(imgFile);
            }
        } else {
            // Video: use existing download+upload pipeline for each channel
            for (const chId of channelIds) {
                try {
                    const channel = await guild.channels.fetch(chId);
                    await downloadAndUpload(channel, mediaUrl, async () => { });
                    log("INFO", "API", `Video yüklendi: #${channel.name}`);
                } catch (e) {
                    log("ERROR", "API", `Video yükleme hatası (${chId}): ${e.message}`);
                }
            }
        }
    } catch (err) {
        log("ERROR", "API", `Genel hata: ${err.message}`);
    }
});

// Start API server after bot is ready
client.once("clientReady", () => {
    app.listen(CONFIG.apiPort, CONFIG.apiHost, () => {
        log("INFO", "API", `HTTP API sunucusu başlatıldı: http://${CONFIG.apiHost}:${CONFIG.apiPort}`);
    });
});

// ─── GLOBAL ERROR HANDLERS ─────────────────────────────────────────────────

process.on("unhandledRejection", (err) => {
    log("ERROR", "PROCESS", `Unhandled rejection: ${err?.message || err}`);
});

process.on("uncaughtException", (err) => {
    log("ERROR", "PROCESS", `Uncaught exception: ${err?.message || err}`);
});

// ─── LOGIN ──────────────────────────────────────────────────────────────────

try {
    validateConfiguration();
    client.login(CONFIG.token).catch((err) => {
        log("ERROR", "BOT", `Giriş başarısız: ${err.message}`);
        process.exit(1);
    });
} catch (err) {
    log("ERROR", "CONFIG", err.message);
    process.exitCode = 1;
}
