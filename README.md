# Element / DOM workbench

A standalone IDE for inspecting and editing a real browser tab. Node.js, Express, Monaco Editor and the Chrome DevTools Protocol provide a source-like editing surface with no account or external service.

The recommended extension mode works in the Chrome, Edge, Brave, Vivaldi or Chromium profile you already use, including its signed-in tabs. The isolated-browser mode remains available for testing. Firefox and Safari use different debugging APIs and are not supported by this build.

## Signed-in browser mode

Requires Node.js 22+ and a current desktop Chromium-based browser.

```sh
npm install
npm start
```

Then install the local extension once:

1. Open `chrome://extensions` or the equivalent extensions page in your Chromium browser.
2. Enable Developer mode.
3. Choose **Load unpacked** and select this project’s `extension` folder.
4. Open the signed-in page you want to edit.
5. Click the Element toolbar button. The Elements workspace opens beside the page and connects automatically.
6. Click any page element while **Pick** is active, or choose a node in the tree.

Chrome shows a debugging banner while Element is attached. Use **Disconnect** in the IDE when finished. The extension requests `activeTab`, `debugger`, `sidePanel` and local storage access. It does not request browsing-history access or persistent access to every website. Use the compact **Port** control above the workspace when the server runs somewhere other than port 3000. Browser settings, browser extension pages and other restricted URLs cannot be inspected.

## Isolated browser mode

In a second terminal, launch a dedicated debugging browser:

```sh
npm run browser
```

This helper looks for Chrome, Edge, Brave, Vivaldi or Chromium, creates a separate profile in your OS temporary directory, enables debugging on port 9222, and opens the included practice page. Set `BROWSER_PATH` if the browser is installed elsewhere. `CHROME_PATH` remains supported for compatibility. The browser stays open after the helper exits; close its window to stop it. The reusable temporary profile remains on disk.

Open **http://localhost:3000** in another browser window. Click **Refresh tabs**, choose the page, then **Connect**. To inspect your own site, open it in the debugging browser window and select that tab in the IDE. Avoid selecting the IDE itself.

### Manual browser commands

Modern Chromium browsers require a non-default `--user-data-dir` for remote debugging. Do not use your everyday profile. [Chrome's explanation](https://developer.chrome.com/blog/remote-debugging-port).

Linux:

```sh
chromium --remote-debugging-port=9222 --user-data-dir=/tmp/element-ide-browser
```

macOS:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir=/tmp/element-ide-browser
```

Windows PowerShell:

```powershell
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:TEMP\element-ide-browser"
```

On Windows, use the matching Edge, Brave or Vivaldi executable when that is the browser you want to inspect.

## Use

- **Elements tree:** collapsible full DOM with tags, every attribute, text, comments and closing tags. Deep nesting is capped visually so selected code never disappears off-screen. Filter by tag, ID, class, attribute or text. Arrow keys navigate; Right/Left expand/collapse; Enter selects. `/` focuses search.
- **Highlight:** hover a tree element to highlight its box in the connected browser. Leaving the tree clears the overlay.
- **Pick element:** click the button, then click a real element in the debugging tab. The IDE selects and reveals it. Click the button again or press Escape in the IDE to cancel.
- **Markup and live text:** picked nodes open in Markup by default. Edit element `outerHTML` in Monaco and apply with Ctrl/Cmd+Enter. Double-click a text/comment row to preview changes in the browser while typing; Enter or blur commits one undo entry and Escape restores the original text.
- **Attributes:** change keys and values and save a row; add or remove attributes. Renaming to an existing attribute is rejected to avoid overwriting it.
- **Styles:** edit inline declarations, matched stylesheet declarations and author-rule selectors. Force `:hover`, `:active`, `:focus` and `:focus-visible` states. Read-only browser/user-agent rules remain visible but disabled.
- **Computed:** filter the browser's actual computed properties and values.
- **Layout:** inspect the live box model, size, position, display and box sizing.
- **Listeners and accessibility:** inspect event listener metadata and the selected node's accessibility role, name, description and properties.
- **DOM breakpoints:** pause on subtree, attribute or node-removal mutations, then resume from the visible paused banner.
- **Session changes:** inspect timestamped before/after values; undo the most recent edit. Undo refuses to overwrite intervening changes made by the page.
- **Split workspace:** drag the divider between the tree and editor, or focus it and use Arrow Up/Down. The side-panel ratio is remembered locally.

These are live DOM edits, **not source-file changes**. Reloading the inspected page restores its source. Frameworks may overwrite live edits on their next render.

## Reliability and scope

Each request carries the connection/document session token, node ID and backend node ID. The backend checks identity, serializes CDP work, resolves runtime objects from the selected node, and refreshes the document after every edit. User values are passed as CDP function arguments, never interpolated into executable JavaScript or guessed CSS selectors.

HTML replacement needs special handling: CDP can patch nodes in place. The IDE retains the original subtree, substitutes a clone, gets that clone's current node ID, then calls `DOM.setOuterHTML`. Undo restores the original subtree between its original sibling boundaries. This keeps previous undo references valid and restores original node identity and listeners. While replacement is active, cloned/replaced nodes do not retain JavaScript event listeners, selection or all live form state, just as ordinary markup replacement does. Custom elements can run lifecycle callbacks on detach/attach. Undo rejects a change when the relevant parent, boundaries or contents have changed independently.

The in-memory undo stack is capped at 100 entries and is cleared on navigation, target switch, disconnect or server restart. It does not persist files or retain a separate audit trail of undone changes. One backend has one shared selected target and undo stack; use one IDE window per server. Runtime objects are released on undo, failed edits and session teardown.

The full document request uses `depth: -1, pierce: true`; shadow roots and included frame documents are shown. Separate out-of-process iframe targets are not automatically attached, so cross-origin frame inspection is not guaranteed. Very large DOM trees can be expensive; rows for collapsed branches are not rendered, but fetching the document still transfers the full tree. External page mutations are refreshed manually; navigation, disconnect and reverse picking are pushed through Server-Sent Events.

## Local trust boundary

The server binds to `127.0.0.1` only. It rejects non-local Host headers, foreign origins, cross-site requests and writes without `X-Inspector-Request: 1`. The extension WebSocket accepts browser-extension origins only. The frontend keeps scripts restricted to local assets and allows inline styles only because Monaco positions editor internals with style attributes. Page content is rendered as text, never as IDE HTML. Keep the IDE and any browser debugging port off public networks. This is a local developer tool with code execution authority in its selected tab, not a remotely hosted multi-user service. It has no user authentication.

## Configuration

For release preflight, use the operator checklist in [`RELEASE.md`](./RELEASE.md). The local readiness endpoint is `GET /healthz`; it reports service and connection state without returning page content.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | IDE HTTP port |
| `CDP_PORT` | `9222` | Browser debugging port on 127.0.0.1 |
| `BROWSER_PATH` | Auto-detected | Chrome, Edge, Brave, Vivaldi or Chromium executable |
| `CHROME_PATH` | Unset | Backward-compatible browser executable override |

For example in PowerShell: `$env:PORT = '3100'; npm start`. Set matching variables when launching the browser. If a tab closes or navigates, refresh the tree or reconnect. If the browser is unavailable, confirm the separate profile launched, the debugging port matches, and another process has not reused that profile. A CDP timeout disconnects the session; check the page for a partial change before retrying.

## API

All write requests require JSON and `X-Inspector-Request: 1`. API errors return `{ "error": "human-readable explanation" }` with an appropriate HTTP status.

| Endpoint | Body / result |
| --- | --- |
| `GET /targets` | Page targets `{id,title,url}[]` |
| `GET /status` | Connection, target, session and history count |
| `GET /healthz` | Readiness state and request ID, without page content |
| `POST /connect` | `{targetId}` → state and document tree |
| `POST /disconnect` | `{}` → disconnected state |
| `GET /dom` | `{tree,session,...state}` |
| `POST /select/:nodeId` | `{backendNodeId,session}` → node, outerHTML, matched/computed styles, dimensions |
| `POST /details/:pane` | Lazy `layout`, `events`, `accessibility` or `breakpoints` details |
| `POST /highlight` | `{nodeId,backendNodeId,session}` |
| `POST /highlight/clear` | `{}` |
| `POST /inspect` | `{enabled,session}` |
| `POST /edit/html` | `{nodeId,backendNodeId,session,outerHTML}` |
| `POST /edit/attribute` | `{nodeId,backendNodeId,session,name,value,oldName?}`; null value removes |
| `POST /edit/style` | `{nodeId,backendNodeId,session,property,value,priority?}` |
| `POST /edit/text` | `{nodeId,backendNodeId,session,value}` |
| `POST /preview/text` | Begin or update a live text preview; returns `draftId` |
| `POST /preview/text/commit` | Commit one preview transaction into undo history |
| `POST /preview/text/cancel` | Restore the previewed text without an undo entry |
| `POST /edit/rule` | Edit matched rule declarations by stylesheet range |
| `POST /edit/selector` | Edit an author rule selector by stylesheet range |
| `POST /pseudo` | Force supported pseudo classes for the selected node |
| `POST /breakpoint` | Enable or disable a DOM breakpoint |
| `POST /debugger/resume` | Resume a page paused by a DOM breakpoint |
| `GET /history` | Current undo entries; no runtime object handles |
| `POST /undo` | `{session}` |
| `POST /api/v1/ai/plan` | `{consent,prompt,context,sessionNodeId}` → typed, reviewable DOM edit plan |
| `GET /events` | SSE connection, navigation, picker and history notifications |

Edits return `{changed,tree,backendNodeId,history,session}`. Use the fresh tree to find the returned backend node ID; do not reuse the previous node ID. Undo returns the same fields except `changed`.

## Verify

### OpenAI harness

The optional harness is server-side only. Set `OPENAI_API_KEY` and optionally `OPENAI_MODEL` before starting the service. It requires explicit page-context consent, treats page text as untrusted, caps context and prompt sizes, and returns typed edit proposals; it never executes model-generated JavaScript or sends the key to the browser.

If an API key is pasted into chat, a terminal, a screenshot, or a commit, revoke it immediately in the OpenAI dashboard and create a replacement. Store the replacement only in an ignored `.env` file or your deployment provider’s secret manager.

```sh
npm run check
npm test
npm run test:live
npm run test:ui
```

`npm test` checks the HTTP trust boundary, disconnected errors, malformed input, extension relay and operation queue recovery. `npm run test:live` launches its own headless Chrome and exercises the real DOM, CSS, layout, accessibility, listener, breakpoint, pseudo-state, text, HTML and undo paths. `npm run test:ui` renders the 480px side-panel layout, checks body-first selection, pane availability, overflow and browser console errors, then writes a temporary screenshot. These checks use disposable profiles and do not touch the regular browser profile or current IDE session.

Manual UI smoke: open the practice page in the debugging browser, connect, select `#sample-title`, apply an HTML edit, change an attribute and inline color, inspect computed color, then undo all three and check the original page. Test Pick element in the live tab, refresh the IDE, navigate the target, and close the target. At narrow widths the document tree stacks above the inspector. Check keyboard navigation, focus, dialog Escape and the draft-discard flow.

## Files

```text
server.js                 Express, local security boundary, API and SSE
cdp.js                    CDP connection, node identity, edits and undo
extension-bridge.js       Signed-in browser extension relay
extension/                Manifest V3 side panel and debugger transport
public/index.html         Semantic IDE shell and editors
public/app.js             Tree, forms, state and API calls
public/style.css          Responsive workbench styles
public/playground.*       A real practice page
scripts/launch-browser.js  Cross-platform Chromium browser launcher
scripts/launch-chrome.js   Compatibility entry point
scripts/verify-live.js     Isolated real-Chrome integration verification
scripts/verify-ui.js       Narrow side-panel render and console verification
test/server.test.js        HTTP and queue tests
```

Protocol references: [DOM](https://chromedevtools.github.io/devtools-protocol/tot/DOM/), [CSS](https://chromedevtools.github.io/devtools-protocol/tot/CSS/), [Overlay](https://chromedevtools.github.io/devtools-protocol/tot/Overlay/), [chrome-remote-interface](https://github.com/cyrus-and/chrome-remote-interface). Reverse picking uses `Overlay.setInspectMode`, the current protocol method.
