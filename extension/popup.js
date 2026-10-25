// Discord Video Saver — Popup Script
// All API calls go through background.js to avoid Firefox NetworkError
(function () {
    const $apiUrl = document.getElementById("apiUrl");
    const $apiKey = document.getElementById("apiKey");
    const $loadBtn = document.getElementById("loadChannelsBtn");
    const $select = document.getElementById("defaultChannelSelect");
    const $saveBtn = document.getElementById("saveBtn");
    const $status = document.getElementById("status");

    // Load saved config
    browser.runtime.sendMessage({ action: "getConfig" }).then((config) => {
        $apiUrl.value = config.apiUrl || "http://127.0.0.1:3541";
        $apiKey.value = config.apiKey || "";
    });

    // Load channels — through background.js (not direct fetch)
    $loadBtn.addEventListener("click", () => {
        $loadBtn.disabled = true;
        $loadBtn.textContent = "Yükleniyor…";
        $status.textContent = "";

        // First save current API settings before fetching
        browser.runtime.sendMessage({
            action: "saveConfig",
            config: {
                apiUrl: $apiUrl.value.replace(/\/+$/, ""),
                apiKey: $apiKey.value,
            }
        }).then(() => {
            // Now fetch channels through background
            return browser.runtime.sendMessage({ action: "fetchChannelsForPopup" });
        }).then((response) => {
            if (response?.error) {
                $status.className = "status err";
                $status.textContent = `❌ ${response.error}`;
                $loadBtn.disabled = false;
                $loadBtn.textContent = "Kanalları Yükle";
                return;
            }

            const channels = response.channels;
            $select.innerHTML = '<option value="">Kanal seçin…</option>';
            let currentCat = null;
            for (const ch of channels) {
                if (ch.category !== currentCat) {
                    currentCat = ch.category;
                }
                const opt = document.createElement("option");
                opt.value = ch.id;
                opt.textContent = `${currentCat ? `[${currentCat}] ` : ""}# ${ch.name}`;
                opt.dataset.name = ch.name;
                $select.appendChild(opt);
            }
            $select.style.display = "block";
            $status.className = "status ok";
            $status.textContent = `✅ ${channels.length} kanal yüklendi`;
            $loadBtn.disabled = false;
            $loadBtn.textContent = "Kanalları Yükle";
        }).catch((e) => {
            $status.className = "status err";
            $status.textContent = `❌ ${e.message}`;
            $loadBtn.disabled = false;
            $loadBtn.textContent = "Kanalları Yükle";
        });
    });

    // Save
    $saveBtn.addEventListener("click", () => {
        browser.runtime.sendMessage({
            action: "saveConfig",
            config: {
                apiUrl: $apiUrl.value.replace(/\/+$/, ""),
                apiKey: $apiKey.value,
            }
        }).then(() => {
            $status.className = "status ok";
            $status.textContent = "✅ Kaydedildi!";
            setTimeout(() => { $status.textContent = ""; }, 2000);
        });
    });
})();
