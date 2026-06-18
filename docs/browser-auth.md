# Browser authorization and Chrome extension

Authentication data is private. Never commit `deepseek-auth.json`, paste it into issues, or expose it through a public web server.

## Recommended: Chrome helper

```powershell
npm run auth -- --login
```

The helper launches an isolated Chrome/Chromium profile, waits for you to sign in to DeepSeek, reads the required session values through the local debugging port, and writes `deepseek-auth.json`. Use `CHROME_PATH` when Chrome cannot be auto-detected. Run `npm run doctor` afterward.

The profile is temporary by default. `DEEPSEEK_KEEP_CHROME_PROFILE=1` preserves it; `DEEPSEEK_REUSE_CHROME=1` connects to an already-running compatible instance; `DEEPSEEK_CHROME_PROFILE` and `DEEPSEEK_CHROME_PORT` override defaults.

## Extension export

1. Open `chrome://extensions` and enable Developer mode.
2. Choose **Load unpacked** and select this repository's `chrome-extension` folder.
3. Sign in at `https://chat.deepseek.com/` and keep that tab open.
4. Open **DeepSeek Auth Exporter**, click **Collect from Tab**, then **Download File** or **Copy JSON**.
5. Import the saved export:

```powershell
npm run auth:import -- --input C:\safe\path\deepseek-auth.json
npm run doctor
```

If a cookie export has no token, pass it through the environment, not a CLI argument:

```powershell
$env:DEEPSEEK_TOKEN = '<token>'
npm run auth:import -- --input C:\safe\path\cookies.json
Remove-Item Env:DEEPSEEK_TOKEN
```

The extension stores its latest export in `chrome.storage.local`. Remove the extension and its stored data when it is no longer needed.
