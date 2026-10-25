# Discord Media Relay

Discord Media Relay is a self-hosted Discord bot with a Firefox extension. It
downloads supported public media through `yt-dlp` and sends it to selected
channels in one configured Discord server.

The repository intentionally does **not** contain bot tokens, API keys,
downloaded media, browser profiles, archives, `node_modules`, or third-party
binaries.

## Requirements

- Node.js 18 or newer
- A Discord application and bot with the required server permissions
- `ffmpeg` and `ffprobe` available on `PATH`
- `yt-dlp` available on `PATH`, or a path set with `YTDLP_PATH`
- Firefox 109 or newer for the extension

## Bot setup

1. Create a Discord application and bot in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Enable the **Message Content Intent** and invite the bot to your server.
3. Copy `.env.example` to `.env` and fill in:
   - `DISCORD_TOKEN`
   - `DISCORD_GUILD_ID`
   - `API_KEY` (use a long random value)
4. Install dependencies and start the bot:

```powershell
npm install
npm start
```

The bot registers `/indir`. The prefix command `!indir <url>` is also
available when message content intent is enabled. The API listens only on
`http://127.0.0.1:3541` by default. Set `API_HOST` explicitly if the extension
needs to connect from another machine; use a firewall and a strong API key.

## Firefox extension

1. Open `about:debugging#/runtime/this-firefox`.
2. Select **Load Temporary Add-on** and choose
   `extension/manifest.json`.
3. Open the extension popup and enter the same local API address and `API_KEY`
   value used by the bot.

The extension can add media buttons to supported pages and send a selected
URL to one or more configured Discord channels.

## Supported media and limits

Supported hosts are defined in `index.js` and are subject to the availability,
terms, authentication, and rate limits of each service. Discord upload limits
apply; the bot attempts lower quality tiers and an ffmpeg re-encode when
necessary.

Use this project only for media that you are authorized to download and
redistribute. You are responsible for complying with copyright, privacy,
platform terms, and Discord rules. This project is not affiliated with
Discord, Mozilla, YouTube, or any listed platform.

## License

Original source code in this repository is released under the MIT License.
Dependencies and tools such as Discord.js, Express, `dotenv`, `yt-dlp`, and
FFmpeg retain their own licenses. They are installed or provided separately
and are not relicensed by this repository.
