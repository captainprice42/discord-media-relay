// Discord Video Saver — Background Script
// Handles API communication between content script/popup and bot HTTP API

const DEFAULT_CONFIG = {
    apiUrl: "http://127.0.0.1:3541",
    apiKey: "",
};

// Migrate old localhost to 127.0.0.1
browser.storage.local.get("apiUrl").then((data) => {
    if (data.apiUrl && data.apiUrl.includes("localhost")) {
        browser.storage.local.set({ apiUrl: data.apiUrl.replace("localhost", "127.0.0.1") });
    }
});

async function getConfig() {
    return browser.storage.local.get(DEFAULT_CONFIG);
}

async function fetchChannels() {
    const config = await getConfig();
    const res = await fetch(`${config.apiUrl}/api/channels`, {
        headers: { "X-API-Key": config.apiKey },
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${text}`);
    }
    const data = await res.json();
    return data.channels;
}

async function sendDownload(url, channelIds, type) {
    const config = await getConfig();
    const res = await fetch(`${config.apiUrl}/api/download`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-API-Key": config.apiKey,
        },
        body: JSON.stringify({ url, channelIds, type }),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return res.json();
}

// Message handler for content script AND popup
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "getChannels") {
        fetchChannels()
            .then((channels) => sendResponse(channels))
            .catch((e) => sendResponse({ error: e.message }));
        return true;
    }

    if (msg.action === "download") {
        sendDownload(msg.url, msg.channelIds, msg.type)
            .then((result) => sendResponse(result))
            .catch((e) => sendResponse({ error: e.message }));
        return true;
    }

    if (msg.action === "getConfig") {
        getConfig().then(sendResponse);
        return true;
    }

    if (msg.action === "saveConfig") {
        browser.storage.local.set(msg.config).then(() => {
            sendResponse({ ok: true });
        });
        return true;
    }

    if (msg.action === "fetchChannelsForPopup") {
        fetchChannels()
            .then((channels) => sendResponse({ channels }))
            .catch((e) => sendResponse({ error: e.message }));
        return true;
    }
});
