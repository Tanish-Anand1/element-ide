import CDP from 'chrome-remote-interface';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export class InspectorError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const highlightConfig = {
  showInfo: true, showStyles: true,
  contentColor: { r: 74, g: 144, b: 226, a: 0.22 },
  paddingColor: { r: 93, g: 184, b: 120, a: 0.25 },
  borderColor: { r: 238, g: 180, b: 69, a: 0.4 },
  marginColor: { r: 234, g: 139, b: 65, a: 0.25 },
};
const breakpointTypes = new Set(['subtree-modified', 'attribute-modified', 'node-removed']);
const pseudoClasses = new Set(['active', 'focus', 'focus-visible', 'focus-within', 'hover', 'target']);

function normalizeRange(range) {
  const keys = ['startLine', 'startColumn', 'endLine', 'endColumn'];
  if (!range || keys.some(key => !Number.isInteger(range[key]) || range[key] < 0)) throw new InspectorError('A valid stylesheet range is required.');
  return Object.fromEntries(keys.map(key => [key, range[key]]));
}

function textAtRange(text, range) {
  const lines = text.split('\n');
  if (range.startLine >= lines.length || range.endLine >= lines.length) return null;
  const offsets = []; let offset = 0;
  for (const line of lines) { offsets.push(offset); offset += line.length + 1; }
  return text.slice(offsets[range.startLine] + range.startColumn, offsets[range.endLine] + range.endColumn);
}

export class Inspector extends EventEmitter {
  constructor({ port = 9222, extensionBridge = null } = {}) {
    super();
    this.port = port;
    this.client = null;
    this.target = null;
    this.session = randomUUID();
    this.history = [];
    this.textDrafts = new Map();
    this.breakpoints = new Map();
    this.pseudoStates = new Map();
    this.mainFrameId = null;
    this.reapplyTimer = null;
    this.paused = false;
    this.queue = Promise.resolve();
    this.extensionBridge = extensionBridge;
    this.extensionBridge?.on('update', () => this.emit('update', { type: 'targets', ...this.state() }));
  }
  // Serialize selection, writes and target switches. A failed command must not poison the queue.
  run(task) {
    const next = this.queue.then(async () => {
      let timer;
      try {
        return await Promise.race([task(), new Promise((_, reject) => {
          timer = setTimeout(() => {
            void this.disconnect();
            reject(new InspectorError('The inspected browser did not respond. Reconnect before retrying; check the page for a partial edit.', 504));
          }, 12000);
        })]);
      } finally { clearTimeout(timer); }
    });
    this.queue = next.catch(() => {});
    return next;
  }
  state() { return { connected: !!this.client, target: this.target, session: this.session, historyCount: this.history.length, cdpPort: this.port, paused: this.paused }; }
  invalidate(reason) {
    clearTimeout(this.reapplyTimer);
    this.reapplyTimer = null;
    this.session = randomUUID();
    this.history = [];
    this.textDrafts.clear();
    this.breakpoints.clear();
    this.pseudoStates.clear();
    this.paused = false;
    this.emit('update', { type: reason, ...this.state() });
  }
  async targets() {
    const extensionTargets = this.extensionBridge?.targets() || [];
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/json/list`, { signal: AbortSignal.timeout(3500) });
      if (!response.ok) throw new Error('Target listing failed');
      const cdpTargets = (await response.json()).filter(t => t.type === 'page').map(({ id, title, url }) => ({ id, title, url, transport: 'cdp' }));
      return [...extensionTargets, ...cdpTargets];
    } catch {
      if (extensionTargets.length) return extensionTargets;
      throw new InspectorError(`No Chromium browser is reachable on port ${this.port}. Launch a supported browser with remote debugging and a separate user data directory, then retry.`, 503);
    }
  }
  async connect(targetId) {
    const target = (await this.targets()).find(t => t.id === targetId);
    if (!target) throw new InspectorError('That tab is no longer available. Refresh the tab list.', 404);
    await this.disconnect();
    const client = target.transport === 'extension'
      ? await this.extensionBridge.connect(target.id)
      : await CDP({ host: '127.0.0.1', port: this.port, target: target.id, local: true });
    try {
      await client.DOM.enable();
      await client.CSS.enable();
      await client.Runtime.enable();
      await client.Overlay.enable();
      await client.Page.enable();
      if (target.transport !== 'extension') {
        try { ({ frameTree: { frame: { id: this.mainFrameId } } } = await client.Page.getFrameTree()); }
        catch { this.mainFrameId = null; }
      }
      await client.Accessibility.enable();
      await client.Debugger.enable();
      this.client = client;
      this.target = target;
      client.on('disconnect', () => {
        if (this.client !== client) return;
        this.client = null;
        this.target = null;
        this.invalidate('disconnected');
      });
      client.DOM.documentUpdated(() => {
        if (this.client !== client) return;
        this.scheduleReapply();
      });
      client.Page.frameNavigated(({ frame }) => {
        if (this.client !== client || frame.parentId) return;
        if (!this.mainFrameId) { this.mainFrameId = frame.id; this.target = { ...this.target, url: frame.url }; return; }
        if (frame.id !== this.mainFrameId) return;
        this.target = { ...this.target, url: frame.url };
        this.invalidate('document');
        void client.Runtime.releaseObjectGroup({ objectGroup: 'inspector-history' }).catch(() => {});
      });
      client.Debugger.paused(details => {
        if (this.client !== client) return;
        this.paused = true;
        this.emit('update', { type: 'paused', reason: details.reason || 'breakpoint', ...this.state() });
      });
      client.Debugger.resumed(() => {
        if (this.client !== client) return;
        this.paused = false;
        this.emit('update', { type: 'resumed', ...this.state() });
      });
      client.Overlay.inspectNodeRequested(({ backendNodeId }) => {
        if (this.client !== client) return;
        void this.run(async () => {
          await client.Overlay.setInspectMode({ mode: 'none', highlightConfig });
          const tree = await this.getDocument();
          const { nodeIds } = await client.DOM.pushNodesByBackendIdsToFrontend({ backendNodeIds: [backendNodeId] });
          this.emit('update', { type: 'picked', nodeId: nodeIds[0], backendNodeId, tree, session: this.session });
        }).catch(error => this.emit('update', { type: 'notice', message: error.message }));
      });
      this.invalidate('connected');
      return { ...this.state(), tree: await this.getDocument() };
    } catch (error) {
      if (this.client === client) this.client = null;
      this.target = null;
      await client.close().catch(() => {});
      throw error;
    }
  }
  async disconnect() {
    const client = this.client;
    this.client = null;
    this.target = null;
    this.mainFrameId = null;
    this.invalidate('disconnected');
    if (client) {
      await client.Overlay.setInspectMode({ mode: 'none', highlightConfig }).catch(() => {});
      await client.Runtime.releaseObjectGroup({ objectGroup: 'inspector-history' }).catch(() => {});
      await client.close().catch(() => {});
    }
  }
  requireClient() {
    if (!this.client) throw new InspectorError('Connect to a browser tab first.', 409);
    return this.client;
  }
  assertSession(session) {
    this.requireClient();
    if (session !== this.session) throw new InspectorError('The document or target changed. Refresh the tree and select the element again.', 409);
  }
  async getDocument() {
    const { root } = await this.requireClient().DOM.getDocument({ depth: -1, pierce: true });
    return root;
  }
  async node({ nodeId, backendNodeId, session }) {
    this.assertSession(session);
    if (!Number.isInteger(nodeId) || nodeId < 1 || !Number.isInteger(backendNodeId)) throw new InspectorError('A current node ID and backend node ID are required.');
    const { node } = await this.client.DOM.describeNode({ nodeId });
    if (node.backendNodeId !== backendNodeId) throw new InspectorError('This node is stale. Refresh the tree and select it again.', 409);
    return node;
  }
  async highlight(input) {
    const node = await this.node(input);
    if (node.nodeType === 1) await this.client.Overlay.highlightNode({ nodeId: node.nodeId, highlightConfig });
  }
  async hideHighlight() { if (this.client) await this.client.Overlay.hideHighlight(); }
  async inspectMode(enabled, session) {
    this.assertSession(session);
    await this.client.Overlay.setInspectMode({ mode: enabled ? 'searchForNode' : 'none', highlightConfig });
  }
  async call(objectId, functionDeclaration, args = [], returnByValue = true) {
    const result = await this.requireClient().Runtime.callFunctionOn({ objectId, functionDeclaration, arguments: args.map(value => ({ value })), returnByValue });
    if (result.exceptionDetails) throw new InspectorError(result.exceptionDetails.exception?.description?.split('\n')[0] || 'The page rejected this operation.', 409);
    return returnByValue ? result.result.value : result.result;
  }
  async captureLocator(objectId) {
    return this.call(objectId, `function() {
      const element = this.nodeType === 1 ? this : this.parentElement;
      if (!element) throw Error('This node has no element parent.');
      const escape = value => CSS.escape(value);
      const path = node => {
        if (node.id) return '#' + escape(node.id);
        const parts = [];
        for (let current = node; current && current.nodeType === 1; current = current.parentElement) {
          let part = current.localName;
          const siblings = [...(current.parentElement?.children || [])].filter(sibling => sibling.localName === current.localName);
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
          parts.unshift(part);
          if (current === document.documentElement) break;
        }
        return parts.join(' > ');
      };
      return { selector: path(element), childIndex: this.nodeType === 1 ? null : [...element.childNodes].indexOf(this), nodeType: this.nodeType };
    }`);
  }
  async patchRuntime(patches, mode = 'apply') {
    const global = await this.client.Runtime.evaluate({ expression: 'globalThis', objectGroup: 'inspector-patches' });
    try {
      return await this.call(global.result.objectId, `function(patches, mode) {
        const nodeFor = patch => {
          const element = document.querySelector(patch.locator.selector);
          return patch.locator.childIndex === null ? element : element?.childNodes[patch.locator.childIndex];
        };
        let applied = 0; const skipped = [];
        for (const patch of patches) {
          const node = nodeFor(patch);
          if (!node || (patch.locator.nodeType !== node.nodeType)) { skipped.push(patch.id); continue; }
          const value = mode === 'undo' ? patch.before : patch.after;
          if (patch.kind === 'text') {
            if (node.nodeValue !== value) { node.nodeValue = value; applied++; }
          } else if (node.nodeType === 1 && patch.kind === 'attribute') {
            const name = mode === 'undo' ? patch.beforeName : patch.name;
            const remove = mode === 'undo' ? patch.afterName : patch.oldName;
            if (remove && remove !== name) node.removeAttribute(remove);
            if (value === null) node.removeAttribute(name); else node.setAttribute(name, value);
            applied++;
          } else if (node.nodeType === 1 && patch.kind === 'style') {
            if (value.value) node.style.setProperty(patch.property, value.value, value.priority || ''); else node.style.removeProperty(patch.property);
            applied++;
          } else if (node.nodeType === 1 && patch.kind === 'html') {
            if (node.outerHTML !== value) { node.outerHTML = value; applied++; }
          } else skipped.push(patch.id);
        }
        return { applied, skipped };
      }`, [patches, mode]);
    } finally { await this.client.Runtime.releaseObject({ objectId: global.result.objectId }).catch(() => {}); }
  }
  scheduleReapply() {
    clearTimeout(this.reapplyTimer);
    this.reapplyTimer = setTimeout(() => {
      this.reapplyTimer = null;
      void this.run(async () => {
        const patches = this.history.map(entry => entry.patch).filter(Boolean);
        if (!patches.length || !this.client) return;
        const result = await this.patchRuntime(patches);
        if (result.applied || result.skipped.length) this.emit('update', { type: 'reapplied', applied: result.applied, skipped: result.skipped.length, ...this.state() });
      }).catch(error => this.emit('update', { type: 'notice', message: error.message }));
    }, 150);
  }
  async details(input) {
    const node = await this.node(input);
    const outerHTML = node.nodeType === 1 ? (await this.client.DOM.getOuterHTML({ nodeId: node.nodeId })).outerHTML : node.nodeValue;
    let matched = {}, computedStyle = [], metrics = null;
    if (node.nodeType === 1) {
      matched = await this.client.CSS.getMatchedStylesForNode({ nodeId: node.nodeId });
      ({ computedStyle } = await this.client.CSS.getComputedStyleForNode({ nodeId: node.nodeId }));
      const { object } = await this.client.DOM.resolveNode({ nodeId: node.nodeId });
      try {
        metrics = await this.call(object.objectId, `function() { const r = this.getBoundingClientRect(); return { width: r.width, height: r.height }; }`);
      } finally { await this.client.Runtime.releaseObject({ objectId: object.objectId }).catch(() => {}); }
      await this.highlight(input);
    }
    return { node, outerHTML, matched, computedStyle, metrics, session: this.session };
  }
  async pane(kind, input) {
    const node = await this.node(input);
    if (node.nodeType !== 1) return { kind, session: this.session, data: [] };
    if (kind === 'layout') {
      const { object } = await this.client.DOM.resolveNode({ nodeId: node.nodeId });
      try {
        const data = await this.call(object.objectId, `function() {
          const style = getComputedStyle(this); const rect = this.getBoundingClientRect();
          const value = name => style.getPropertyValue(name);
          return {
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            display: style.display, position: style.position, boxSizing: style.boxSizing,
            margin: [value('margin-top'), value('margin-right'), value('margin-bottom'), value('margin-left')],
            border: [value('border-top-width'), value('border-right-width'), value('border-bottom-width'), value('border-left-width')],
            padding: [value('padding-top'), value('padding-right'), value('padding-bottom'), value('padding-left')]
          };
        }`);
        return { kind, data, session: this.session };
      } finally { await this.client.Runtime.releaseObject({ objectId: object.objectId }).catch(() => {}); }
    }
    if (kind === 'events') {
      const { object } = await this.client.DOM.resolveNode({ nodeId: node.nodeId });
      try {
        const { listeners = [] } = await this.client.DOMDebugger.getEventListeners({ objectId: object.objectId, depth: 1, pierce: true });
        return { kind, data: listeners.map(({ type, useCapture, passive, once, scriptId, lineNumber, columnNumber }) => ({ type, useCapture, passive, once, scriptId, lineNumber, columnNumber })), session: this.session };
      } finally { await this.client.Runtime.releaseObject({ objectId: object.objectId }).catch(() => {}); }
    }
    if (kind === 'accessibility') {
      const { nodes = [] } = await this.client.Accessibility.getPartialAXTree({ backendNodeId: node.backendNodeId, fetchRelatives: false });
      const current = nodes[0] || {};
      return { kind, data: { ignored: !!current.ignored, ignoredReasons: current.ignoredReasons || [], role: current.role?.value || '', name: current.name?.value || '', description: current.description?.value || '', properties: (current.properties || []).map(property => ({ name: property.name, value: property.value?.value })) }, session: this.session };
    }
    if (kind === 'breakpoints') {
      return { kind, data: [...breakpointTypes].map(type => ({ type, enabled: this.breakpoints.has(`${node.backendNodeId}:${type}`) })), session: this.session };
    }
    throw new InspectorError('Unknown detail pane.', 404);
  }
  async forcePseudoState(input) {
    const node = await this.node(input);
    if (node.nodeType !== 1) throw new InspectorError('Choose an element before forcing a state.');
    const classes = Array.isArray(input.classes) ? [...new Set(input.classes)] : [];
    if (classes.some(name => !pseudoClasses.has(name))) throw new InspectorError('Unsupported pseudo state.');
    await this.client.CSS.forcePseudoState({ nodeId: node.nodeId, forcedPseudoClasses: classes });
    if (classes.length) this.pseudoStates.set(node.backendNodeId, classes); else this.pseudoStates.delete(node.backendNodeId);
    return { classes, session: this.session };
  }
  async setBreakpoint(input) {
    const node = await this.node(input);
    if (!breakpointTypes.has(input.type) || typeof input.enabled !== 'boolean') throw new InspectorError('Choose a valid DOM breakpoint and state.');
    const key = `${node.backendNodeId}:${input.type}`;
    if (input.enabled) {
      await this.client.DOMDebugger.setDOMBreakpoint({ nodeId: node.nodeId, type: input.type });
      this.breakpoints.set(key, true);
    } else {
      await this.client.DOMDebugger.removeDOMBreakpoint({ nodeId: node.nodeId, type: input.type });
      this.breakpoints.delete(key);
    }
    return { type: input.type, enabled: input.enabled, session: this.session };
  }
  async resume(session) {
    this.assertSession(session);
    if (this.paused) await this.client.Debugger.resume();
  }
  publicHistory() { return this.history.map(({ objectId, patch, ...entry }) => entry); }
  async edit(kind, input) {
    const node = await this.node(input);
    if (kind === 'text') return this.editText(node, input);
    if (node.nodeType !== 1) throw new InspectorError('Choose an element to edit.');
    if (this.history.length >= 100) throw new InspectorError('This session has reached 100 edits. Undo edits or reconnect to start a new log.', 409);
    if (kind === 'html' && typeof input.outerHTML !== 'string') throw new InspectorError('HTML must be a string.');
    if (kind === 'attribute' && (typeof input.name !== 'string' || !/^[^\s\u0000"'<>/=]+$/.test(input.name) || (input.value !== null && typeof input.value !== 'string'))) throw new InspectorError('Enter a valid attribute name and a string value (or null to remove).');
    if (input.oldName !== undefined && (kind !== 'attribute' || typeof input.oldName !== 'string' || !/^[^\s\u0000"'<>/=]+$/.test(input.oldName))) throw new InspectorError('The previous attribute name is invalid.');
    const renamed = kind === 'attribute' && input.oldName && input.oldName !== input.name;
    if (kind === 'style' && (typeof input.property !== 'string' || !/^(--[^\s:;{}]+|[a-zA-Z-]+)$/.test(input.property) || typeof input.value !== 'string' || !['', 'important', undefined].includes(input.priority))) throw new InspectorError('Enter a CSS property, string value and optional important priority.');
    const client = this.client;
    const session = this.session;
    const { object } = await client.DOM.resolveNode({ nodeId: node.nodeId, objectGroup: 'inspector-history' });
    let bookmark;
    try {
      const selector = await this.call(object.objectId, `function() { let s = this.localName; if (this.id) return s + '#' + this.id; if (this.classList.length) s += '.' + [...this.classList].join('.'); return s; }`);
      const locator = await this.captureLocator(object.objectId);
      const styleBefore = kind === 'style' ? await this.call(object.objectId, 'function(property) { return { value: this.style.getPropertyValue(property), priority: this.style.getPropertyPriority(property) }; }', [input.property]) : null;
      if (kind === 'html') {
        bookmark = await this.call(object.objectId, `function() {
          if (!this.parentNode || this === this.ownerDocument.documentElement) throw Error('The document root cannot be replaced. Choose a child element.');
          return { node: this, parent: this.parentNode, previous: this.previousSibling, next: this.nextSibling, before: this.outerHTML };
        }`, [], false);
      } else {
        bookmark = await this.call(object.objectId, `function(name, newName) {
          if (newName && this.hasAttribute(newName)) throw Error('An attribute with that name already exists.');
          return { node: this, name, newName, before: this.getAttribute(name) };
        }`, [kind === 'style' ? 'style' : (input.oldName || input.name), renamed ? input.name : null], false);
      }
      const before = await this.call(bookmark.objectId, 'function() { return this.before; }');
      if (kind === 'html' && before === input.outerHTML) {
        await client.Runtime.releaseObject({ objectId: bookmark.objectId });
        return { changed: false, session, tree: await this.getDocument(), backendNodeId: node.backendNodeId, history: this.publicHistory() };
      }
      if (kind === 'html') {
        // CDP patches nodes in place, unlike the JS outerHTML setter. Preserve the
        // original subtree (and earlier undo handles) and patch a live clone instead.
        const replacement = await this.call(bookmark.objectId, `function() {
          this.live = this.node.cloneNode(true);
          this.parent.replaceChild(this.live, this.node);
          return this.live;
        }`, [], false);
        try {
          const { nodeId } = await client.DOM.requestNode({ objectId: replacement.objectId });
          await client.DOM.setOuterHTML({ nodeId, outerHTML: input.outerHTML });
        } catch (error) {
          // A rejected CDP write should put back the untouched original if the clone remains.
          await this.call(bookmark.objectId, `function() {
            if (this.live.parentNode === this.parent && this.live.outerHTML === this.before) this.parent.replaceChild(this.node, this.live);
          }`).catch(() => {});
          throw error;
        } finally { await client.Runtime.releaseObject({ objectId: replacement.objectId }).catch(() => {}); }
        await this.call(bookmark.objectId, `function() {
          this.inserted = []; let n = this.previous ? this.previous.nextSibling : this.parent.firstChild;
          while (n && n !== this.next) { this.inserted.push(n); n = n.nextSibling; }
          this.after = this.inserted.map(n => n.outerHTML ?? n.textContent).join('');
        }`);
      } else if (kind === 'attribute') {
        if (input.value === null) await client.DOM.removeAttribute({ nodeId: node.nodeId, name: input.name });
        else await client.DOM.setAttributeValue({ nodeId: node.nodeId, name: input.name, value: input.value });
        if (renamed) await client.DOM.removeAttribute({ nodeId: node.nodeId, name: input.oldName });
      } else {
        await this.call(object.objectId, `function(property, value, priority) {
          if (!this.style) throw Error('This element does not support inline styles.');
          if (value && !property.startsWith('--') && !CSS.supports(property, value)) throw Error('Invalid CSS property or value.');
          if (value) this.style.setProperty(property, value, priority); else this.style.removeProperty(property);
        }`, [input.property, input.value, input.priority || '']);
      }
      this.assertSession(session);
      const after = await this.call(bookmark.objectId, `function() { if (this.name) this.after = this.node.getAttribute(this.newName || this.name); return this.after; }`);
      if (before === after && kind !== 'html' && !renamed) {
        await client.Runtime.releaseObject({ objectId: bookmark.objectId });
        return { changed: false, session, tree: await this.getDocument(), backendNodeId: node.backendNodeId, history: this.publicHistory() };
      }
      const id = randomUUID();
      const patch = kind === 'html'
        ? { id, kind, locator, before, after: input.outerHTML }
        : kind === 'style'
          ? { id, kind, locator, property: input.property, before: styleBefore, after: { value: input.value, priority: input.priority || '' } }
          : { id, kind, locator, name: input.name, oldName: input.oldName || null, beforeName: input.oldName || input.name, afterName: input.name, before, after };
      this.history.push({ id, timestamp: new Date().toISOString(), kind, selector, property: renamed ? `${input.oldName} → ${input.name}` : input.property || input.name || 'outerHTML', before, after, objectId: bookmark.objectId, patch });
      const selected = await this.call(bookmark.objectId, `function() { return this.inserted ? (this.inserted.find(n => n.nodeType === 1) || this.parent) : this.node; }`, [], false);
      let backendNodeId = null;
      try { ({ node: { backendNodeId } } = await client.DOM.describeNode({ objectId: selected.objectId })); }
      finally { await client.Runtime.releaseObject({ objectId: selected.objectId }).catch(() => {}); }
      const tree = await this.getDocument();
      this.emit('update', { type: 'history', historyCount: this.history.length, session });
      return { changed: true, tree, backendNodeId, history: this.publicHistory(), session };
    } catch (error) {
      if (bookmark?.objectId && !this.history.some(entry => entry.objectId === bookmark.objectId)) await client.Runtime.releaseObject({ objectId: bookmark.objectId }).catch(() => {});
      throw error;
    } finally { await client.Runtime.releaseObject({ objectId: object.objectId }).catch(() => {}); }
  }
  async editText(node, input) {
    if (![3, 8].includes(node.nodeType) || typeof input.value !== 'string') throw new InspectorError('Choose a text or comment node and enter a string value.');
    if (this.history.length >= 100) throw new InspectorError('This session has reached 100 edits. Undo edits or reconnect to start a new log.', 409);
    const client = this.client; const session = this.session;
    const { object } = await client.DOM.resolveNode({ nodeId: node.nodeId, objectGroup: 'inspector-history' });
    const locator = await this.captureLocator(object.objectId);
    const bookmark = await this.call(object.objectId, 'function() { return { node: this, before: this.nodeValue, after: null }; }', [], false);
    try {
      const before = await this.call(bookmark.objectId, 'function() { return this.before; }');
      if (before === input.value) { await client.Runtime.releaseObject({ objectId: bookmark.objectId }); return { changed: false, session, tree: await this.getDocument(), backendNodeId: node.backendNodeId, history: this.publicHistory() }; }
      await client.DOM.setNodeValue({ nodeId: node.nodeId, value: input.value });
      await this.call(bookmark.objectId, 'function() { this.after = this.node.nodeValue; }');
      const id = randomUUID();
      this.history.push({ id, timestamp: new Date().toISOString(), kind: 'text', selector: node.nodeName, property: 'nodeValue', before, after: input.value, objectId: bookmark.objectId, undoType: 'text', patch: { id, kind: 'text', locator, before, after: input.value } });
      this.emit('update', { type: 'history', historyCount: this.history.length, session });
      return { changed: true, session, tree: await this.getDocument(), backendNodeId: node.backendNodeId, history: this.publicHistory() };
    } catch (error) {
      if (!this.history.some(entry => entry.objectId === bookmark.objectId)) await client.Runtime.releaseObject({ objectId: bookmark.objectId }).catch(() => {});
      throw error;
    } finally { await client.Runtime.releaseObject({ objectId: object.objectId }).catch(() => {}); }
  }
  async previewText(input) {
    this.assertSession(input.session);
    if (typeof input.value !== 'string') throw new InspectorError('Text preview requires a string value.');
    const client = this.client;
    let draft = input.draftId ? this.textDrafts.get(input.draftId) : null;
    if (input.draftId && !draft) throw new InspectorError('This live text edit expired. Select the text again.', 409);
    if (!draft) {
      const node = await this.node(input);
      if (![3, 8].includes(node.nodeType)) throw new InspectorError('Choose a text or comment node for live editing.');
      const { object } = await client.DOM.resolveNode({ nodeId: node.nodeId, objectGroup: 'inspector-history' });
      let bookmark;
      try { bookmark = await this.call(object.objectId, 'function() { return { node: this, before: this.nodeValue, after: this.nodeValue }; }', [], false); }
      finally { await client.Runtime.releaseObject({ objectId: object.objectId }).catch(() => {}); }
      draft = { id: randomUUID(), objectId: bookmark.objectId, backendNodeId: node.backendNodeId, session: this.session };
      this.textDrafts.set(draft.id, draft);
    }
    const value = await this.call(draft.objectId, `function(value) {
      if (!this.node.isConnected || this.node.nodeValue !== this.after) throw Error('The page changed this text while you were editing it.');
      this.node.nodeValue = value; this.after = value; return this.after;
    }`, [input.value]);
    return { draftId: draft.id, value, backendNodeId: draft.backendNodeId, session: this.session };
  }
  async finishTextPreview(mode, input) {
    this.assertSession(input.session);
    const draft = this.textDrafts.get(input.draftId);
    if (!draft || draft.session !== this.session) throw new InspectorError('This live text edit expired. Select the text again.', 409);
    if (!['commit', 'cancel'].includes(mode)) throw new InspectorError('Unknown text preview action.');
    const values = await this.call(draft.objectId, `function(mode) {
      if (!this.node.isConnected || this.node.nodeValue !== this.after) throw Error('The page changed this text while you were editing it.');
      if (mode === 'cancel') this.node.nodeValue = this.before;
      return { before: this.before, after: this.after, value: this.node.nodeValue };
    }`, [mode]);
    this.textDrafts.delete(draft.id);
    if (mode === 'cancel' || values.before === values.after) {
      await this.client.Runtime.releaseObject({ objectId: draft.objectId }).catch(() => {});
      return { changed: mode === 'cancel' && values.before !== values.after, cancelled: mode === 'cancel', session: this.session, tree: await this.getDocument(), backendNodeId: draft.backendNodeId, history: this.publicHistory() };
    }
    if (this.history.length >= 100) {
      await this.call(draft.objectId, 'function() { this.node.nodeValue = this.before; }').catch(() => {});
      await this.client.Runtime.releaseObject({ objectId: draft.objectId }).catch(() => {});
      throw new InspectorError('This session has reached 100 edits. The text preview was reverted.', 409);
    }
    const { object } = await this.client.DOM.resolveNode({ backendNodeId: draft.backendNodeId, objectGroup: 'inspector-history' });
    let locator;
    try { locator = await this.captureLocator(object.objectId); }
    finally { await this.client.Runtime.releaseObject({ objectId: object.objectId }).catch(() => {}); }
    const id = randomUUID();
    this.history.push({ id, timestamp: new Date().toISOString(), kind: 'text', selector: '#text', property: 'nodeValue', before: values.before, after: values.after, objectId: draft.objectId, undoType: 'text', patch: { id, kind: 'text', locator, before: values.before, after: values.after } });
    this.emit('update', { type: 'history', historyCount: this.history.length, session: this.session });
    return { changed: true, session: this.session, tree: await this.getDocument(), backendNodeId: draft.backendNodeId, history: this.publicHistory() };
  }
  async editStyleSheet(kind, input) {
    this.assertSession(input.session);
    if (this.history.length >= 100) throw new InspectorError('This session has reached 100 edits. Undo edits or reconnect to start a new log.', 409);
    if (typeof input.styleSheetId !== 'string' || typeof input.text !== 'string' || !['rule', 'selector'].includes(kind)) throw new InspectorError('A stylesheet, range and replacement text are required.');
    const range = normalizeRange(input.range);
    const { text: source } = await this.client.CSS.getStyleSheetText({ styleSheetId: input.styleSheetId });
    const before = textAtRange(source, range);
    if (before === null || (typeof input.before === 'string' && before !== input.before)) throw new InspectorError('This stylesheet changed. Select the element again before editing the rule.', 409);
    if (before === input.text) return { changed: false, session: this.session, tree: await this.getDocument(), backendNodeId: input.backendNodeId, history: this.publicHistory() };
    let currentRange;
    if (kind === 'rule') {
      const result = await this.client.CSS.setStyleTexts({ edits: [{ styleSheetId: input.styleSheetId, range, text: input.text }] });
      currentRange = result.styles?.[0]?.range;
    } else {
      const result = await this.client.CSS.setRuleSelector({ styleSheetId: input.styleSheetId, range, selector: input.text });
      currentRange = result.rule?.selectorList?.range;
    }
    if (!currentRange) throw new InspectorError('Chrome changed the stylesheet but did not return an editable range.', 409);
    this.history.push({ id: randomUUID(), timestamp: new Date().toISOString(), kind: kind === 'rule' ? 'css-rule' : 'selector', selector: input.selector || 'stylesheet rule', property: kind === 'rule' ? 'declarations' : 'selector', before, after: input.text, styleSheetId: input.styleSheetId, currentRange, undoType: 'stylesheet' });
    this.emit('update', { type: 'history', historyCount: this.history.length, session: this.session });
    return { changed: true, session: this.session, tree: await this.getDocument(), backendNodeId: input.backendNodeId, history: this.publicHistory() };
  }
  async undo(session) {
    this.assertSession(session);
    const entry = this.history.at(-1);
    if (!entry) throw new InspectorError('There are no edits to undo.', 409);
    if (entry.undoType === 'stylesheet') {
      const { text } = await this.client.CSS.getStyleSheetText({ styleSheetId: entry.styleSheetId });
      if (textAtRange(text, entry.currentRange) !== entry.after) throw new InspectorError('Undo conflict: the page changed this stylesheet.', 409);
      if (entry.kind === 'css-rule') await this.client.CSS.setStyleTexts({ edits: [{ styleSheetId: entry.styleSheetId, range: entry.currentRange, text: entry.before }] });
      else await this.client.CSS.setRuleSelector({ styleSheetId: entry.styleSheetId, range: entry.currentRange, selector: entry.before });
      this.history.pop();
      this.emit('update', { type: 'history', historyCount: this.history.length, session });
      return { tree: await this.getDocument(), backendNodeId: null, history: this.publicHistory(), session };
    }
    if (entry.patch && entry.patch.kind !== 'html') {
      const connected = await this.call(entry.objectId, 'function() { return !!this.node?.isConnected; }').catch(() => false);
      if (!connected) {
        const result = await this.patchRuntime([entry.patch], 'undo');
        if (!result.applied) throw new InspectorError('Undo conflict: the page rebuilt this element and it could not be located safely.', 409);
        this.history.pop();
        await this.client.Runtime.releaseObject({ objectId: entry.objectId }).catch(() => {});
        this.emit('update', { type: 'history', historyCount: this.history.length, session });
        return { tree: await this.getDocument(), backendNodeId: null, history: this.publicHistory(), session };
      }
    }
    const selected = await this.call(entry.objectId, `function() {
      if (this.node && Object.prototype.hasOwnProperty.call(this, 'after') && !this.name && !this.inserted) {
        if (!this.node.isConnected || this.node.nodeValue !== this.after) throw Error('Undo conflict: the page changed this text node.');
        this.node.nodeValue = this.before;
      } else if (this.inserted) {
        if (!this.parent.isConnected || (this.previous && this.previous.parentNode !== this.parent) || (this.next && this.next.parentNode !== this.parent)) throw Error('Undo conflict: the page changed this element’s parent.');
        const current = []; let n = this.previous ? this.previous.nextSibling : this.parent.firstChild;
        while (n && n !== this.next) { current.push(n); n = n.nextSibling; }
        if (current.length !== this.inserted.length || current.some((n, i) => n !== this.inserted[i]) || current.map(n => n.outerHTML ?? n.textContent).join('') !== this.after || this.node.outerHTML !== this.before) throw Error('Undo conflict: the page changed this HTML.');
        for (const n of current) n.remove();
        this.parent.insertBefore(this.node, this.next);
      } else {
        if (!this.node.isConnected || this.node.getAttribute(this.newName || this.name) !== this.after || (this.newName && this.node.hasAttribute(this.name))) throw Error('Undo conflict: the page changed or removed this attribute.');
        if (this.newName) this.node.removeAttribute(this.newName);
        if (this.before === null) this.node.removeAttribute(this.name); else this.node.setAttribute(this.name, this.before);
      }
      return this.node;
    }`, [], false);
    this.assertSession(session);
    this.history.pop();
    let backendNodeId;
    try { ({ node: { backendNodeId } } = await this.client.DOM.describeNode({ objectId: selected.objectId })); }
    finally {
      await this.client.Runtime.releaseObject({ objectId: selected.objectId }).catch(() => {});
      await this.client.Runtime.releaseObject({ objectId: entry.objectId }).catch(() => {});
    }
    this.emit('update', { type: 'history', historyCount: this.history.length, session });
    return { tree: await this.getDocument(), backendNodeId, history: this.publicHistory(), session };
  }
}
