// Discord Video Saver — Content Script
// Detects <video> and <img> elements, injects overlay download buttons

(function () {
    "use strict";

    const PROCESSED = new WeakSet();
    const MIN_IMG_SIZE = 120;

    // Site-specific video player selectors
    const VIDEO_PLAYER_SELECTORS = [
        'video',                                    // Standard HTML5 video
        '[data-testid="videoPlayer"]',              // Twitter/X
        '[data-testid="videoComponent"]',           // Twitter/X alt
        '[data-testid="tweetPhoto"] video',         // Twitter/X inline
        'div[data-media-type="video"]',             // Twitter/X media
        'ytd-player',                               // YouTube
        '.html5-video-player',                      // YouTube alt
        '.video-player',                            // Generic
        '[class*="VideoPlayer"]',                   // React-based sites
        '[class*="video-player"]',                  // Generic
    ];

    // Check if current site is a known video platform
    const hostname = window.location.hostname.replace("www.", "");
    const isVideoSite = [
        "x.com", "twitter.com",
        "youtube.com", "youtu.be",
        "instagram.com",
        "tiktok.com",
        "twitch.tv",
        "kick.com",
        "dailymotion.com",
        "vimeo.com",
    ].includes(hostname);

    function injectButton(el, type) {
        if (PROCESSED.has(el)) return;
        PROCESSED.add(el);

        // Video için boyut kontrolü daha esnek
        if (type === "image") {
            const rect = el.getBoundingClientRect();
            if (rect.width < MIN_IMG_SIZE || rect.height < MIN_IMG_SIZE) return;
        }

        // Videonun görünür bir container'ını bul
        let target = el;
        if (type === "video" && el.tagName !== "VIDEO") {
            // Site-specific wrapper (e.g. Twitter videoPlayer div)
            // El zaten wrapper, onu kullan
        } else if (type === "video" && el.tagName === "VIDEO") {
            const rect = el.getBoundingClientRect();
            // Eğer video çok küçükse, daha büyük parent'ı bul
            if (rect.width < 50 || rect.height < 50) {
                let p = el.parentElement;
                for (let i = 0; i < 5 && p; i++) {
                    const pr = p.getBoundingClientRect();
                    if (pr.width >= 100 && pr.height >= 50) {
                        target = p;
                        break;
                    }
                    p = p.parentElement;
                }
            }
        }

        const parent = target.parentElement;
        if (!parent) return;
        const parentPos = getComputedStyle(parent).position;
        if (parentPos === "static") parent.style.position = "relative";

        const btn = document.createElement("div");
        btn.className = "dvs-overlay-btn";
        btn.textContent = type === "video" ? "🎬" : "🖼️";
        btn.title = type === "video" ? "Videoyu kaydet" : "Görseli kaydet";
        btn.dataset.dvsType = type;

        btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            const mediaUrl = getMediaUrl(el, type);
            if (!mediaUrl) {
                showToast("❌ Medya URL'si bulunamadı");
                return;
            }

            openChannelPicker(mediaUrl, type, btn);
        });

        parent.appendChild(btn);

        function updatePosition() {
            const elRect = target.getBoundingClientRect();
            const parentRect = parent.getBoundingClientRect();
            btn.style.top = (elRect.top - parentRect.top + 8) + "px";
            btn.style.left = (elRect.left - parentRect.left + 8) + "px";
        }
        updatePosition();

        const ro = new ResizeObserver(updatePosition);
        ro.observe(target);
    }

    function getMediaUrl(el, type) {
        if (type === "video") {
            return findPostUrl(el) || window.location.href;
        }
        // Görsel
        if (el.src) return el.src;
        if (el.currentSrc) return el.currentSrc;
        if (el.dataset.src) return el.dataset.src;
        const srcset = el.getAttribute("srcset");
        if (srcset) return srcset.split(",").pop().trim().split(" ")[0];
        return null;
    }

    // Video elementinden yukarı çıkarak gerçek post URL'sini bul
    function findPostUrl(el) {
        const host = window.location.hostname.replace("www.", "");

        // Twitter/X: /username/status/123456 formatında link bul
        if (host === "x.com" || host === "twitter.com") {
            return findClosestLink(el, /\/status\/\d+/);
        }

        // Instagram: /p/ABC123 veya /reel/ABC123 formatında link bul
        if (host === "instagram.com") {
            return findClosestLink(el, /\/(p|reel|reels)\/[A-Za-z0-9_-]+/);
        }

        // TikTok: /video/123456 formatında link bul
        if (host === "tiktok.com") {
            return findClosestLink(el, /\/video\/\d+/);
        }

        // Diğer siteler: sayfa URL'sini kullan
        return null;
    }

    // Elementten yukarı çıkarak post container'ını bul, sonra içinde link ara
    function findClosestLink(el, pattern) {
        let node = el;
        // Önce post/tweet container'ını bul (article elementi)
        for (let i = 0; i < 25 && node; i++) {
            if (node.matches && (
                node.matches('article[data-testid="tweet"]') ||  // Twitter/X
                node.matches('article[role="presentation"]') ||  // Instagram
                node.tagName === "ARTICLE"                       // Genel
            )) {
                // Container bulundu — sadece bu container içinde link ara
                const links = node.querySelectorAll("a[href]");
                for (const link of links) {
                    const href = link.getAttribute("href");
                    if (href && pattern.test(href)) {
                        if (href.startsWith("http")) return href;
                        return window.location.origin + href;
                    }
                }
                // Container içinde eşleşen link bulunamadı
                return null;
            }
            node = node.parentElement;
        }

        // Container bulunamadı — tek tweet/post sayfasında olabiliriz
        // Sayfa URL'si pattern'e uyuyorsa onu kullan
        if (pattern.test(window.location.pathname)) {
            return window.location.href;
        }
        return null;
    }

    // ── Kanal seçici panel ──
    let activePanel = null;

    function openChannelPicker(url, type, anchorBtn) {
        if (activePanel) { activePanel.remove(); activePanel = null; }

        const typeLabel = type === "video" ? "🎬 Video" : "🖼️ Görsel";
        const panel = document.createElement("div");
        panel.className = "dvs-panel";

        const header = document.createElement("div");
        header.className = "dvs-panel-header";
        const headerLabel = document.createElement("span");
        headerLabel.textContent = typeLabel + " — Kanal Seç";
        const closeSpan = document.createElement("span");
        closeSpan.className = "dvs-panel-close";
        closeSpan.textContent = "✕";
        header.appendChild(headerLabel);
        header.appendChild(closeSpan);

        const body = document.createElement("div");
        body.className = "dvs-panel-body";
        const loadingDiv = document.createElement("div");
        loadingDiv.className = "dvs-loading-text";
        loadingDiv.textContent = "Kanallar yükleniyor…";
        body.appendChild(loadingDiv);

        const footer = document.createElement("div");
        footer.className = "dvs-panel-footer";
        const sendBtnEl = document.createElement("button");
        sendBtnEl.className = "dvs-send-btn";
        sendBtnEl.disabled = true;
        sendBtnEl.textContent = "Gönder";
        footer.appendChild(sendBtnEl);

        panel.appendChild(header);
        panel.appendChild(body);
        panel.appendChild(footer);

        const btnRect = anchorBtn.getBoundingClientRect();
        panel.style.position = "fixed";
        panel.style.top = (btnRect.bottom + 5) + "px";
        panel.style.left = Math.max(5, btnRect.left - 100) + "px";
        panel.style.zIndex = "2147483647";

        document.body.appendChild(panel);
        activePanel = panel;

        panel.querySelector(".dvs-panel-close").addEventListener("click", () => {
            panel.remove();
            activePanel = null;
        });

        setTimeout(() => {
            document.addEventListener("click", function onOutside(e) {
                if (!panel.contains(e.target) && e.target !== anchorBtn) {
                    panel.remove();
                    activePanel = null;
                    document.removeEventListener("click", onOutside);
                }
            });
        }, 100);

        browser.runtime.sendMessage({ action: "getChannels" })
            .then((response) => {
                if (response?.error) {
                    const errBody = panel.querySelector(".dvs-panel-body");
                    errBody.textContent = "";
                    const errDiv = document.createElement("div");
                    errDiv.className = "dvs-error";
                    errDiv.textContent = "❌ " + response.error;
                    errBody.appendChild(errDiv);
                    return;
                }
                renderChannels(panel, response, url, type);
            })
            .catch((e) => {
                const errBody = panel.querySelector(".dvs-panel-body");
                errBody.textContent = "";
                const errDiv = document.createElement("div");
                errDiv.className = "dvs-error";
                errDiv.textContent = "❌ Bağlantı hatası: " + e.message;
                errBody.appendChild(errDiv);
            });
    }

    function renderChannels(panel, channels, url, type) {
        const body = panel.querySelector(".dvs-panel-body");
        const sendBtn = panel.querySelector(".dvs-send-btn");

        let currentCat = null;
        const fragment = document.createDocumentFragment();

        for (const ch of channels) {
            if (ch.category !== currentCat) {
                currentCat = ch.category;
                const catDiv = document.createElement("div");
                catDiv.className = "dvs-cat";
                catDiv.textContent = currentCat || "Kategorisiz";
                fragment.appendChild(catDiv);
            }
            const label = document.createElement("label");
            label.className = "dvs-channel";
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.value = ch.id;
            checkbox.dataset.name = ch.name;
            const span = document.createElement("span");
            span.textContent = "# " + ch.name;
            label.appendChild(checkbox);
            label.appendChild(span);
            fragment.appendChild(label);
        }

        body.textContent = "";
        body.appendChild(fragment);
        sendBtn.disabled = false;

        sendBtn.addEventListener("click", () => {
            const checked = body.querySelectorAll("input[type=checkbox]:checked");
            const channelIds = Array.from(checked).map((cb) => cb.value);

            if (channelIds.length === 0) {
                showToast("⚠️ En az bir kanal seç!");
                return;
            }

            sendBtn.disabled = true;
            sendBtn.textContent = "Gönderiliyor…";

            browser.runtime.sendMessage({ action: "download", url, channelIds, type })
                .then((res) => {
                    if (res?.error) {
                        showToast("❌ " + res.error);
                        sendBtn.textContent = "Gönder";
                        sendBtn.disabled = false;
                    } else {
                        showToast("✅ İndirme başlatıldı!");
                        setTimeout(() => {
                            panel.remove();
                            activePanel = null;
                        }, 1000);
                    }
                })
                .catch((e) => {
                    showToast("❌ Hata: " + e.message);
                    sendBtn.textContent = "Gönder";
                    sendBtn.disabled = false;
                });
        });
    }

    function showToast(msg) {
        const existing = document.querySelector(".dvs-toast");
        if (existing) existing.remove();

        const toast = document.createElement("div");
        toast.className = "dvs-toast";
        toast.textContent = msg;
        document.body.appendChild(toast);

        setTimeout(() => toast.classList.add("dvs-toast-show"), 10);
        setTimeout(() => {
            toast.classList.remove("dvs-toast-show");
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // ── Bir elementin video container'ında olup olmadığını kontrol et ──
    function isInsideVideoContainer(el) {
        let node = el.parentElement;
        for (let i = 0; i < 8 && node; i++) {
            // Gerçek <video> var mı?
            if (node.querySelector("video")) return true;
            // Site-specific video player wrapper mı?
            if (node.matches && (
                node.matches('[data-testid="videoPlayer"]') ||
                node.matches('[data-testid="videoComponent"]') ||
                node.matches('[data-media-type="video"]') ||
                node.matches('[class*="VideoPlayer"]') ||
                node.matches('[class*="video-player"]')
            )) return true;
            node = node.parentElement;
        }
        return false;
    }

    function tryInjectImage(img) {
        if (isInsideVideoContainer(img)) return;
        const rect = img.getBoundingClientRect();
        if (rect.width >= MIN_IMG_SIZE && rect.height >= MIN_IMG_SIZE) {
            injectButton(img, "image");
        }
    }

    function scanVideoPlayers() {
        // Standard <video> elements
        document.querySelectorAll("video").forEach((v) => injectButton(v, "video"));

        // Site-specific video player wrappers (Twitter, YouTube etc.)
        for (const sel of VIDEO_PLAYER_SELECTORS) {
            if (sel === "video") continue; // already handled above
            document.querySelectorAll(sel).forEach((el) => {
                // Sadece görünür olanları
                const rect = el.getBoundingClientRect();
                if (rect.width >= 50 && rect.height >= 50) {
                    injectButton(el, "video");
                }
            });
        }
    }

    function scanPage() {
        scanVideoPlayers();
        document.querySelectorAll("img").forEach(tryInjectImage);
    }

    const observer = new MutationObserver((mutations) => {
        for (const mut of mutations) {
            for (const node of mut.addedNodes) {
                if (node.nodeType !== 1) continue;
                if (node.tagName === "VIDEO") injectButton(node, "video");
                if (node.tagName === "IMG") tryInjectImage(node);
                if (node.querySelectorAll) {
                    node.querySelectorAll("video").forEach((v) => injectButton(v, "video"));
                    // Check for video player wrappers in added nodes
                    for (const sel of VIDEO_PLAYER_SELECTORS) {
                        if (sel === "video") continue;
                        node.querySelectorAll(sel).forEach((el) => {
                            const rect = el.getBoundingClientRect();
                            if (rect.width >= 50 && rect.height >= 50) {
                                injectButton(el, "video");
                            }
                        });
                    }
                    node.querySelectorAll("img").forEach(tryInjectImage);
                }
                // Check if added node itself is a video wrapper
                if (node.matches) {
                    for (const sel of VIDEO_PLAYER_SELECTORS) {
                        if (node.matches(sel)) {
                            injectButton(node, "video");
                            break;
                        }
                    }
                }
            }
        }
    });

    scanPage();
    observer.observe(document.body, { childList: true, subtree: true });
    setInterval(scanPage, 3000);
})();
