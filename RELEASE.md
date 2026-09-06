# Element release runbook

Element is a local-first developer tool. The release artifact is the repository plus the unpacked `extension` directory; no page content or credentials are uploaded.

## Preflight

```powershell
npm ci
npm run check
npm test
npm run test:live
npm run test:ui
npm audit --omit=dev
```

The expected local service is `http://127.0.0.1:3000`. Check readiness with:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3000/healthz
```

## Browser install

1. Start the service with `npm start`.
2. Open `chrome://extensions` (or the equivalent Chromium page).
3. Enable Developer mode and choose **Load unpacked**.
4. Select this project’s `extension` folder.
5. Pin **Element**, open the signed-in tab, and click the extension icon.
6. Confirm the side panel reports the target tab and `Connected to browser`.

## Safety checks

- Keep the server bound to `127.0.0.1`; do not expose the CDP or IDE port publicly.
- Confirm the Chrome debugging banner appears only while attached.
- Verify text previews cancel with Escape, commits create one history entry, and reload restores the original page.
- Browser settings, extension pages, and other restricted URLs should remain unavailable.

## Troubleshooting

- **No tabs available:** restart Chrome with `npm run browser` for an isolated profile, or reload the extension and click it again on the signed-in tab.
- **Connection refused:** confirm port `3000` is listening and open the Port control if using `PORT`.
- **Stale tree:** use Refresh tree after navigation; the session intentionally invalidates node IDs on reload.
- **Extension changed:** press Reload on the extension card, close the old side panel, then reopen it.

## Rollback

Stop `npm start`, restore the previous repository and extension folder, then reload the unpacked extension. Because edits are session-only, reloading the inspected page removes live changes.
