# Verification

Checked locally on Windows with installed desktop Chrome, 6 September 2026.

- `npm run check`: JavaScript syntax checks passed, including the Monaco adapter and cross-browser launcher.
- `npm test`: all 7 tests passed, including host/origin/request-header rejection, disconnected errors, malformed JSON, queue recovery, signed-in target discovery, extension attach, DOM enablement, document retrieval and detach.
- `npm run test:live`: passed against an isolated real Chrome process. Covers target selection, document and style reads, overlays, **actual mouse-driven reverse picking**, Monaco loading under the production CSP with no console errors, attribute key/value edits, invalid CSS, HTML replacement with multiple nodes, deletion, original sibling/node identity on undo, chained undo, conflicts, navigation, stale IDs, target switching and closed tabs.
- `npm audit --omit=dev`: zero known vulnerabilities reported.
- Previous browser UI check on `http://localhost:3000`: connected to the practice tab on Chrome port 9222; searched and selected a heading; applied HTML, CSS and attribute edits; checked the real computed color; undid all three edits successfully.
- Inspected desktop, 768 px tablet and 390 px phone layouts. The phone view stacks tree and inspector; long DOM rows and markup scroll inside their own panels.
- Checked draft-discard dialog, Keep editing, Revert draft, setup dialog Escape, and visible keyboard focus. Final browser console check reported no warnings or errors.

No fresh screenshot-based UI pass was available after the Monaco and extension changes because the browser automation surface reported no available browser. The real headless route check, live CDP suite and simulated Manifest V3 relay passed. Installing an unpacked extension requires a user-controlled browser confirmation, so the extension was not installed or exercised inside the user’s signed-in profile during automated verification. No formal screen-reader audit or performance benchmark was performed. Edge, Brave, Vivaldi and Chromium compatibility uses the shared Chrome extension and CDP contracts but was not executed on each browser in this environment. Firefox, Safari, cross-origin out-of-process iframes and custom-element lifecycle behavior are documented limitations, not verified guarantees. The tool edits the live page only; it does not persist source files.
