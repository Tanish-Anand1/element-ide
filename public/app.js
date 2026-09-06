const $ = selector => document.querySelector(selector);
const htmlEditor = window.elementHtmlEditor;
const extensionMode = new URLSearchParams(location.search).get('extension') === '1';
document.documentElement.classList.toggle('extension-mode', extensionMode);

const state = {
  session: null, connected: false, tree: null, nodes: new Map(), parents: new Map(), expanded: new Set(),
  selected: null, details: null, busy: false, dirty: false, htmlOriginal: '', history: [], picking: false,
  paused: false, autoConnecting: false, paneData: new Map(), pseudoByNode: new Map(), textEdit: null, monacoTextEdit: null,
};
let hoverTimer;
const el = (tag, className, content) => { const node = document.createElement(tag); if (className) node.className = className; if (content !== undefined) node.textContent = content; return node; };

async function api(path, body) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Inspector-Request': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
function notice(message, kind = '') { $('#notice').textContent = message; $('#notice').className = `notice ${kind}`; }
function syncControls() {
  $('#connect-button').disabled = state.busy || !$('#target-select').value;
  $('#refresh-targets').disabled = state.busy;
  $('#target-select').disabled = state.busy;
  $('#disconnect-button').hidden = !state.connected;
  $('#disconnect-button').disabled = state.busy;
  for (const id of ['refresh-dom', 'pick-button', 'tree-search']) $(`#${id}`).disabled = !state.connected || state.busy;
  $('#undo-button').disabled = state.busy || !state.connected || !state.history.length;
  const editableNode = state.selected && [1, 3, 8].includes(state.selected.nodeType);
  $('#save-html').disabled = state.busy || !editableNode || htmlEditor.getValue() === state.htmlOriginal;
  $('#reset-html').disabled = state.busy || (!state.dirty && !state.monacoTextEdit);
  $('#selected-content').inert = state.busy;
  $('#inspector').setAttribute('aria-busy', String(state.busy));
  $('#pick-button').setAttribute('aria-pressed', String(state.picking));
  $('#connection-state').textContent = state.connected ? 'Connected to browser' : 'Not connected';
  $('#status-dot').classList.toggle('connected', state.connected);
  $('#paused-banner').hidden = !state.paused;
  $('#resume-button').disabled = state.busy || !state.paused;
}
async function action(task) {
  if (state.busy) return;
  state.busy = true; syncControls();
  try { await task(); } catch (error) { notice(error.message, 'error'); }
  finally { state.busy = false; syncControls(); }
}
function token(node = state.selected) { return { nodeId: node.nodeId, backendNodeId: node.backendNodeId, session: state.session }; }
function children(node) { return [...(node.children || []), ...(node.shadowRoots || []), ...(node.contentDocument ? [node.contentDocument] : []), ...(node.templateContent ? [node.templateContent] : [])]; }
function attributes(node) { const list = []; for (let index = 0; index < (node.attributes || []).length; index += 2) list.push([node.attributes[index], node.attributes[index + 1]]); return list; }
function label(node) {
  const attrs = Object.fromEntries(attributes(node));
  return node.nodeType === 1 ? node.localName + (attrs.id ? `#${attrs.id}` : '') + (attrs.class ? '.' + attrs.class.trim().split(/\s+/).join('.') : '') : node.nodeName;
}
function setTree(tree, { reset = false } = {}) {
  state.tree = tree; state.nodes.clear(); state.parents.clear();
  const walk = (node, parent, depth) => {
    state.nodes.set(node.nodeId, node); if (parent) state.parents.set(node.nodeId, parent.nodeId);
    if (reset && depth < 2) state.expanded.add(node.backendNodeId);
    children(node).forEach(child => walk(child, node, depth + 1));
  };
  if (reset) state.expanded.clear();
  walk(tree, null, 0);
  $('#tree-empty').hidden = true; $('#tree').hidden = false;
  $('#node-count').textContent = `${state.nodes.size.toLocaleString()} nodes`;
  renderTree();
}
function renderTree() {
  const tree = $('#tree'); const focusId = document.activeElement?.dataset.nodeId;
  const query = $('#tree-search').value.trim().toLowerCase(); const visible = new Set();
  if (query) for (const node of state.nodes.values()) {
    if (`${label(node)} ${node.nodeValue || ''} ${attributes(node).flat().join(' ')}`.toLowerCase().includes(query)) {
      let id = node.nodeId; while (id) { visible.add(id); id = state.parents.get(id); }
    }
  }
  const fragment = document.createDocumentFragment(); let count = 0;
  function walk(node, depth) {
    if (query && !visible.has(node.nodeId)) return;
    if (node.nodeType === 3 && !node.nodeValue.trim()) return;
    const childNodes = children(node).filter(child => child.nodeType !== 3 || child.nodeValue.trim());
    const expanded = !!query || state.expanded.has(node.backendNodeId);
    const row = el('div', 'tree-row'); row.style.setProperty('--tree-indent', `${Math.min(depth, 12) * 12}px`); row.dataset.depth = String(depth);
    row.setAttribute('role', 'treeitem'); row.setAttribute('aria-level', String(depth + 1)); row.setAttribute('aria-selected', String(state.selected?.backendNodeId === node.backendNodeId));
    row.setAttribute('aria-label', label(node) + (node.nodeValue ? ` ${node.nodeValue.slice(0, 120)}` : '')); row.dataset.nodeId = node.nodeId; row.tabIndex = -1;
    if (childNodes.length) row.setAttribute('aria-expanded', String(expanded));
    if (depth > 12) { const depthBadge = el('span', 'tree-depth', `+${depth - 12}`); depthBadge.title = `${depth} levels deep`; row.append(depthBadge); }
    const caret = el('span', 'tree-caret', childNodes.length ? (expanded ? '▾' : '▸') : ''); caret.setAttribute('aria-hidden', 'true'); row.append(caret);
    const code = el('span', 'tree-code');
    if (node.nodeType === 1) {
      code.append(el('span', 'node-tag', `<${node.localName}`));
      for (const [name, value] of attributes(node)) {
        const attribute = el('span', name === 'id' ? 'node-id' : name === 'class' ? 'node-class' : 'node-attribute'); attribute.textContent = ` ${name}="${value}"`; code.append(attribute);
      }
      code.append(el('span', 'node-tag', '>'));
    } else if (node.nodeType === 3) code.append(el('span', 'node-text', `"${node.nodeValue.slice(0, 240)}"`));
    else if (node.nodeType === 8) code.append(el('span', 'node-comment', `<!--${node.nodeValue.slice(0, 220)}-->`));
    else code.append(el('span', 'node-text', node.nodeName));
    row.append(code);
    row.addEventListener('click', event => { if (state.busy) return; row.focus(); if (event.target === caret && childNodes.length) toggle(node); else void choose(node); });
    row.addEventListener('dblclick', event => { if ([3, 8].includes(node.nodeType)) { event.preventDefault(); void openTextEditor(node); } });
    row.addEventListener('pointerenter', () => { clearTimeout(hoverTimer); if (node.nodeType !== 1 || state.busy) return; hoverTimer = setTimeout(() => { if (!state.busy && state.connected) void api('/highlight', token(node)).catch(() => {}); }, 100); });
    fragment.append(row); count++;
    if (expanded) {
      childNodes.forEach(child => walk(child, depth + 1));
      if (node.nodeType === 1 && childNodes.length) {
        const closing = el('div', 'tree-closing'); closing.style.setProperty('--tree-indent', `${Math.min(depth, 12) * 12}px`); closing.append(el('span', 'node-tag', `</${node.localName}>`)); fragment.append(closing);
      }
    }
  }
  if (state.tree) walk(state.tree, 0);
  tree.replaceChildren(fragment);
  if (!count) tree.append(el('p', 'no-results', 'No matching nodes. Try another tag, ID, class or text.'));
  const rows = [...tree.querySelectorAll('.tree-row')];
  const active = rows.find(row => row.dataset.nodeId === focusId) || rows.find(row => row.getAttribute('aria-selected') === 'true') || rows[0];
  tree.tabIndex = rows.length ? -1 : 0;
  if (active) { active.tabIndex = 0; if (focusId) active.focus({ preventScroll: true }); }
}
function toggle(node) { state.expanded.has(node.backendNodeId) ? state.expanded.delete(node.backendNodeId) : state.expanded.add(node.backendNodeId); renderTree(); }
$('#tree').addEventListener('keydown', event => {
  const row = event.target.closest('.tree-row'); if (!row || state.busy) return;
  const node = state.nodes.get(Number(row.dataset.nodeId)); const rows = [...$('#tree').querySelectorAll('.tree-row')]; const index = rows.indexOf(row); let next;
  if (event.key === 'ArrowDown') next = rows[Math.min(index + 1, rows.length - 1)];
  else if (event.key === 'ArrowUp') next = rows[Math.max(0, index - 1)];
  else if (event.key === 'Home') next = rows[0];
  else if (event.key === 'End') next = rows.at(-1);
  else if (event.key === 'ArrowRight') { if (children(node).length && !state.expanded.has(node.backendNodeId)) toggle(node); else next = rows[index + 1]; }
  else if (event.key === 'ArrowLeft') { if (state.expanded.has(node.backendNodeId)) toggle(node); else next = rows.find(candidate => Number(candidate.dataset.nodeId) === state.parents.get(node.nodeId)); }
  else if (event.key === 'Enter' && [3, 8].includes(node.nodeType) && state.selected?.backendNodeId === node.backendNodeId) void openTextEditor(node);
  else if (event.key === 'Enter' || event.key === ' ') void choose(node);
  else return;
  event.preventDefault(); if (next) { rows.forEach(candidate => { candidate.tabIndex = -1; }); next.tabIndex = 0; next.focus(); }
});
$('#tree').addEventListener('pointerleave', () => { clearTimeout(hoverTimer); if (state.connected) void api('/highlight/clear', {}).catch(() => {}); });
$('#tree-search').addEventListener('input', renderTree);

function abandonTextEditor() {
  const edit = state.textEdit; if (!edit) return;
  clearTimeout(edit.timer); edit.input?.removeEventListener('blur', edit.onBlur); state.textEdit = null;
}
function abandonMonacoTextEdit() {
  const edit = state.monacoTextEdit; if (!edit) return;
  clearTimeout(edit.timer); state.monacoTextEdit = null;
}
function queueMonacoTextPreview(edit, immediate = false) {
  clearTimeout(edit.timer);
  const send = () => {
    const value = htmlEditor.getValue(); if (value === edit.lastQueued) return edit.queue;
    edit.lastQueued = value;
    edit.queue = edit.queue.then(async () => {
      const result = await api('/preview/text', { ...token(edit.node), draftId: edit.draftId, value });
      edit.draftId = result.draftId; edit.node.nodeValue = result.value;
      notice('Live preview in the browser. Press Enter to keep it or Escape to cancel.', 'success');
    });
    return edit.queue;
  };
  if (immediate) return send();
  edit.timer = setTimeout(() => { void send().catch(error => failMonacoTextEdit(edit, error)); }, 120);
  return edit.queue;
}
function failMonacoTextEdit(edit, error) {
  if (state.monacoTextEdit !== edit) return;
  abandonMonacoTextEdit(); notice(error.message, 'error'); renderSelection();
}
async function finishMonacoTextEdit(mode) {
  const edit = state.monacoTextEdit; if (!edit || edit.finishing) return edit?.finishPromise;
  edit.finishing = true;
  edit.finishPromise = (async () => {
    try {
      await queueMonacoTextPreview(edit, true); await edit.queue;
      if (!edit.draftId) { abandonMonacoTextEdit(); return; }
      const result = await api(`/preview/text/${mode}`, { draftId: edit.draftId, session: state.session });
      abandonMonacoTextEdit(); await applyResult(result);
      notice(mode === 'commit' ? 'Text saved in the live page. Reload restores the original.' : 'Live text edit cancelled and restored.', 'success');
    } catch (error) { failMonacoTextEdit(edit, error); }
  })();
  return edit.finishPromise;
}
function queueTextPreview(edit, immediate = false) {
  clearTimeout(edit.timer);
  const send = () => {
    const value = edit.input.value; if (value === edit.lastQueued) return edit.queue;
    edit.lastQueued = value;
    edit.queue = edit.queue.then(async () => {
      const result = await api('/preview/text', { ...token(edit.node), draftId: edit.draftId, value });
      edit.draftId = result.draftId; edit.node.nodeValue = result.value;
      notice('Live preview in the browser. Press Enter to keep it or Escape to cancel.', 'success');
    });
    return edit.queue;
  };
  if (immediate) return send();
  edit.timer = setTimeout(() => { void send().catch(error => failTextEditor(edit, error)); }, 120);
  return edit.queue;
}
function failTextEditor(edit, error) {
  if (state.textEdit !== edit) return;
  abandonTextEditor(); notice(error.message, 'error'); renderTree();
}
async function finishTextEditor(mode) {
  const edit = state.textEdit; if (!edit || edit.finishing) return edit?.finishPromise;
  edit.finishing = true;
  edit.finishPromise = (async () => {
    try {
      await queueTextPreview(edit, true); await edit.queue;
      if (!edit.draftId) { abandonTextEditor(); renderTree(); return; }
      const result = await api(`/preview/text/${mode}`, { draftId: edit.draftId, session: state.session });
      abandonTextEditor(); await applyResult(result);
      notice(mode === 'commit' ? 'Text saved in the live page. Reload restores the original.' : 'Live text edit cancelled and restored.', 'success');
    } catch (error) { failTextEditor(edit, error); }
  })();
  return edit.finishPromise;
}
async function openTextEditor(node) {
  if (state.textEdit?.node.backendNodeId === node.backendNodeId) return;
  if (state.textEdit) await finishTextEditor('commit');
  if (state.selected?.backendNodeId !== node.backendNodeId) await choose(node);
  const row = $(`#tree .tree-row[data-node-id="${node.nodeId}"]`); if (!row) return;
  const code = row.querySelector('.tree-code'); const input = el('input', 'tree-text-editor'); input.value = node.nodeValue; input.setAttribute('aria-label', `Edit ${node.nodeName} live`);
  code.replaceChildren(input); row.classList.add('is-editing');
  const edit = { node, input, draftId: null, lastQueued: node.nodeValue, queue: Promise.resolve(), timer: null, finishing: false, finishPromise: null };
  edit.onBlur = () => { void finishTextEditor('commit'); }; state.textEdit = edit;
  input.addEventListener('input', () => queueTextPreview(edit));
  input.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Enter') { event.preventDefault(); void finishTextEditor('commit'); }
    else if (event.key === 'Escape') { event.preventDefault(); void finishTextEditor('cancel'); }
  });
  input.addEventListener('blur', edit.onBlur); input.focus(); input.select();
  notice('Editing text live. Browser content updates while you type.', 'success');
}

function discardDraft() {
  if (!state.dirty) return Promise.resolve(true);
  const dialog = $('#discard-dialog'); dialog.returnValue = ''; dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'discard'), { once: true }));
}
$('#keep-draft').onclick = () => $('#discard-dialog').close('keep');
$('#discard-draft').onclick = () => $('#discard-dialog').close('discard');
async function choose(node) {
  if (state.busy) return;
  if (state.textEdit && state.textEdit.node.backendNodeId !== node.backendNodeId) await finishTextEditor('commit');
  if (state.monacoTextEdit && state.monacoTextEdit.node.backendNodeId !== node.backendNodeId) await finishMonacoTextEdit('commit');
  if (!(await discardDraft())) return;
  await action(() => selectNode(node));
}
async function selectNode(node) {
  const session = state.session; notice(`Inspecting ${label(node)}…`);
  const details = await api(`/select/${node.nodeId}`, token(node));
  if (session !== state.session) return;
  state.selected = details.node; state.details = details; state.dirty = false; state.paneData.clear(); abandonMonacoTextEdit();
  expandAncestors(details.node); renderSelection(); renderTree(); await showTab('html');
  notice(`Selected ${label(details.node)}. Edits apply directly to the connected tab.`);
}
function renderBreadcrumbs() {
  const chain = []; let id = state.selected?.nodeId;
  while (id) { const node = state.nodes.get(id); if (node) chain.unshift(node); id = state.parents.get(id); }
  $('#breadcrumbs').replaceChildren(...chain.filter(node => node.nodeType === 1).map((node, index, nodes) => {
    const button = el('button', '', label(node)); button.type = 'button'; button.title = `Select ${label(node)}`; button.onclick = () => void choose(node);
    const fragment = document.createDocumentFragment(); fragment.append(button); if (index < nodes.length - 1) fragment.append(el('span', '', '›')); return fragment;
  }));
}
function editableRule(rule, selector) {
  const entry = el('form', 'matched-rule');
  const source = rule.sourceURL ? `${rule.sourceURL.split('/').at(-1)}:${(rule.style?.range?.startLine || 0) + 1}` : `${rule.origin || 'author'} stylesheet`;
  const selectorInput = el('input', 'rule-selector'); selectorInput.value = selector; selectorInput.setAttribute('aria-label', `Selector ${selector}`);
  const declarations = el('textarea', 'rule-declarations'); declarations.value = rule.style?.cssText || (rule.style?.cssProperties || []).filter(property => !property.implicit && property.name).map(property => `${property.name}: ${property.value};`).join('\n'); declarations.spellcheck = false; declarations.setAttribute('aria-label', `Declarations for ${selector}`);
  const actions = el('div', 'rule-actions'); actions.append(el('span', 'rule-source', source));
  const selectorButton = el('button', '', 'Save selector'); selectorButton.type = 'submit'; selectorButton.dataset.kind = 'selector';
  const declarationsButton = el('button', '', 'Apply rule'); declarationsButton.type = 'submit'; declarationsButton.dataset.kind = 'rule'; actions.append(selectorButton, declarationsButton);
  const selectorEditable = !!(rule.styleSheetId && rule.selectorList?.range); const styleEditable = !!(rule.styleSheetId && rule.style?.range);
  selectorInput.disabled = !selectorEditable; declarations.readOnly = !styleEditable; selectorButton.disabled = !selectorEditable; declarationsButton.disabled = !styleEditable;
  entry.append(selectorInput, declarations, actions);
  entry.onsubmit = event => {
    event.preventDefault(); const kind = event.submitter?.dataset.kind; if (!kind) return;
    const range = kind === 'selector' ? rule.selectorList.range : rule.style.range;
    const before = kind === 'selector' ? selector : declarations.defaultValue;
    const text = kind === 'selector' ? selectorInput.value.trim() : declarations.value;
    void editStyleSheet(kind, { styleSheetId: rule.styleSheetId, range, before, text, selector });
  };
  return entry;
}
function renderSelection() {
  const { node, outerHTML, matched, metrics } = state.details;
  $('#inspector-empty').hidden = true; $('#selected-content').hidden = false; renderBreadcrumbs();
  $('#selected-label').textContent = label(node);
  $('#selected-meta').textContent = `node ${node.nodeId} / backend ${node.backendNodeId}` + (node.nodeType !== 1 ? ` / ${node.nodeName.toLowerCase()} node` : '');
  $('#dimensions').textContent = metrics ? `${Math.round(metrics.width * 10) / 10} × ${Math.round(metrics.height * 10) / 10}` : '';
  const isText = [3, 8].includes(node.nodeType); state.htmlOriginal = isText ? node.nodeValue : outerHTML; htmlEditor.setValue(state.htmlOriginal || ''); htmlEditor.setReadOnly(![1, 3, 8].includes(node.nodeType));
  $('#html-editor-label').textContent = isText ? 'nodeValue' : 'outerHTML'; $('#html-help').textContent = isText ? 'Updates this text directly in the live page.' : 'Replaces this element and its children.'; $('#save-html').firstChild.textContent = isText ? 'Apply text ' : 'Apply HTML ';
  $('#html-dirty').textContent = 'Saved in page';
  const attrs = attributes(node); $('#attribute-count').textContent = attrs.length;
  $('#attributes').replaceChildren(...attrs.map(([name, value]) => {
    const form = el('form', 'attribute-row'); const key = el('input'); key.value = name; key.setAttribute('aria-label', `Name of ${name} attribute`); key.required = true;
    const valueInput = el('input'); valueInput.value = value; valueInput.setAttribute('aria-label', `Value of ${name} attribute`);
    const save = el('button', '', 'Save'); save.type = 'submit'; const remove = el('button', 'remove', 'Remove'); remove.type = 'button';
    form.append(key, valueInput, save, remove); form.onsubmit = event => { event.preventDefault(); void edit('attribute', { oldName: name, name: key.value.trim(), value: valueInput.value }); }; remove.onclick = () => void edit('attribute', { name, value: null }); return form;
  }));
  if (!attrs.length) $('#attributes').append(el('p', 'field-help', node.nodeType === 1 ? 'This element has no attributes.' : 'Only element nodes have attributes.'));
  $('#add-attribute').hidden = $('#add-style').hidden = $('#pseudo-toolbar').hidden = node.nodeType !== 1; $('#add-attribute').reset(); $('#add-style').reset();
  const pseudo = new Set(state.pseudoByNode.get(node.backendNodeId) || []); for (const input of $('#pseudo-toolbar').querySelectorAll('input')) input.checked = pseudo.has(input.value);
  const properties = (matched.inlineStyle?.cssProperties || []).filter(property => property.name && !property.disabled && property.parsedOk !== false && !property.implicit);
  $('#inline-styles').replaceChildren(...properties.map(property => {
    const row = el('div', 'style-row'); const code = el('code'); code.append(el('span', 'style-name', `${property.name}: `), document.createTextNode(`${property.value}${property.important && !property.value.includes('!important') ? ' !important' : ''};`));
    const editButton = el('button', '', 'Edit'); editButton.onclick = () => { const form = $('#add-style'); form.elements.property.value = property.name; form.elements.value.value = property.value.replace(/\s*!important\s*$/, ''); form.elements.important.checked = !!property.important; form.elements.value.focus(); }; row.append(code, editButton); return row;
  }));
  if (!properties.length) $('#inline-styles').append(el('p', 'field-help', node.nodeType === 1 ? 'No inline styles. Add a declaration below.' : 'Styles apply to element nodes.'));
  const rules = matched.matchedCSSRules || []; $('#matched-count').textContent = `(${rules.length})`; $('#matched-rules').replaceChildren(...rules.map(({ rule }) => editableRule(rule, rule.selectorList?.text || '(rule)')));
  if (!rules.length) $('#matched-rules').append(el('p', 'field-help', 'No matched author rules for this node.'));
  renderComputed(); syncControls();
}
function renderComputed() {
  const query = $('#computed-filter').value.toLowerCase(); const values = (state.details?.computedStyle || []).filter(property => `${property.name} ${property.value}`.toLowerCase().includes(query));
  $('#computed-styles').replaceChildren(...values.map(property => { const row = el('div', 'computed-row'); row.append(el('span', '', property.name), el('span', '', property.value)); return row; }));
  if (!values.length) $('#computed-styles').append(el('p', 'field-help', 'No matching computed styles.'));
}
$('#computed-filter').oninput = renderComputed;
async function applyResult(result) {
  if (result.session !== state.session) return;
  const selectedBackend = result.backendNodeId || state.selected?.backendNodeId; state.dirty = false; state.history = result.history; setTree(result.tree); renderHistory();
  const node = [...state.nodes.values()].find(candidate => candidate.backendNodeId === selectedBackend);
  if (node) { expandAncestors(node); await selectNode(node); revealSelected(); } else clearSelection();
}
async function edit(kind, values) {
  await action(async () => { if (!state.selected) return; notice('Applying change to the live page…'); const result = await api(`/edit/${kind}`, { ...token(), ...values }); await applyResult(result); notice(result.changed ? 'Change applied. Undo is available for this session.' : 'The page already has this value.', 'success'); });
}
async function editStyleSheet(kind, values) {
  await action(async () => { notice('Updating the matched stylesheet rule…'); const result = await api(`/edit/${kind}`, { ...token(), ...values }); await applyResult(result); notice(result.changed ? 'Stylesheet rule updated in the live page.' : 'The stylesheet already has this value.', 'success'); });
}
$('#save-html').onclick = () => {
  if ([3, 8].includes(state.selected?.nodeType)) void finishMonacoTextEdit('commit');
  else void edit('html', { outerHTML: htmlEditor.getValue() });
};
$('#ai-form').onsubmit = event => { event.preventDefault(); void action(async () => {
  if (!state.connected || !state.selected || !state.details) throw new Error('Connect to a signed-in tab first. Click the Element extension on that tab, then select a node.');
  const prompt = $('#ai-prompt').value.trim(); const consent = $('#ai-consent').checked; const output = $('#ai-result'); output.hidden = false; output.textContent = 'Thinking through a safe edit plan…';
  const result = await api('/api/v1/ai/plan', { consent, prompt, context: state.details.outerHTML || '', sessionNodeId: state.selected.nodeId });
  output.textContent = `${result.summary}\n\n${(result.actions || []).map((item, index) => `${index + 1}. ${item.type} on node ${item.nodeId}: ${item.reason}`).join('\n') || 'No changes suggested.'}`;
  notice('AI plan ready for review. No browser change was applied.', 'success');
}); };
$('#reset-html').onclick = () => {
  if (state.monacoTextEdit) void finishMonacoTextEdit('cancel');
  else { state.dirty = false; renderSelection(); }
};
htmlEditor.onDidChange(() => {
  const isText = [3, 8].includes(state.selected?.nodeType);
  if (isText && state.connected && !state.busy) {
    if (!state.monacoTextEdit) state.monacoTextEdit = { node: state.selected, draftId: null, lastQueued: state.htmlOriginal, queue: Promise.resolve(), timer: null, finishing: false, finishPromise: null };
    queueMonacoTextPreview(state.monacoTextEdit);
    $('#html-dirty').textContent = 'Preview live';
    state.dirty = false;
  } else {
    state.dirty = htmlEditor.getValue() !== state.htmlOriginal;
    $('#html-dirty').textContent = state.dirty ? 'Unsaved draft' : 'Saved in page';
  }
  syncControls();
});
$('#add-attribute').onsubmit = event => { event.preventDefault(); const form = event.currentTarget; void edit('attribute', { name: form.elements.name.value.trim(), value: form.elements.value.value }); };
$('#add-style').onsubmit = event => { event.preventDefault(); const form = event.currentTarget; void edit('style', { property: form.elements.property.value.trim(), value: form.elements.value.value.trim(), priority: form.elements.important.checked ? 'important' : '' }); };
$('#pseudo-toolbar').addEventListener('change', event => {
  if (event.target.type !== 'checkbox' || !state.selected) return;
  const classes = [...$('#pseudo-toolbar').querySelectorAll('input:checked')].map(input => input.value);
  void action(async () => { const result = await api('/pseudo', { ...token(), classes }); state.pseudoByNode.set(state.selected.backendNodeId, result.classes); notice(result.classes.length ? `Forced ${result.classes.map(name => `:${name}`).join(', ')}.` : 'Forced element states cleared.', 'success'); });
});

function propertyList(entries) {
  const list = el('dl', 'property-list'); for (const [name, value] of entries) { list.append(el('dt', '', name), el('dd', '', value || '—')); } return list;
}
function renderLayout(data) {
  const host = $('#layout-details'); const box = el('div', 'box-model');
  box.innerHTML = `<div class="box-margin"><span>margin</span><b>${data.margin.join(' · ')}</b><div class="box-border"><span>border</span><b>${data.border.join(' · ')}</b><div class="box-padding"><span>padding</span><b>${data.padding.join(' · ')}</b><div class="box-content"><strong>${Math.round(data.rect.width * 10) / 10} × ${Math.round(data.rect.height * 10) / 10}</strong></div></div></div></div>`;
  host.replaceChildren(box, propertyList([['display', data.display], ['position', data.position], ['box-sizing', data.boxSizing], ['x / y', `${Math.round(data.rect.x)}, ${Math.round(data.rect.y)}`]]));
}
function renderEvents(listeners) {
  const host = $('#event-listeners'); host.replaceChildren(...listeners.map(listener => {
    const item = el('details', 'listener-entry'); const summary = el('summary', '', listener.type); const body = propertyList([['capture', String(listener.useCapture)], ['passive', String(listener.passive)], ['once', String(listener.once)], ['source', `${listener.scriptId || 'inline'}:${(listener.lineNumber || 0) + 1}:${(listener.columnNumber || 0) + 1}`]]); item.append(summary, body); return item;
  }));
  if (!listeners.length) host.append(el('p', 'field-help', 'No listeners were found on this element or its immediate prototype chain.'));
}
function renderAccessibility(data) {
  const host = $('#accessibility-details'); const entries = [['role', data.role], ['name', data.name], ['description', data.description], ['included', data.ignored ? 'No' : 'Yes'], ...data.properties.map(property => [property.name, String(property.value ?? '')])]; host.replaceChildren(propertyList(entries));
  if (data.ignoredReasons.length) host.append(el('p', 'field-help', `Ignored because: ${data.ignoredReasons.map(reason => reason.name).join(', ')}`));
}
function renderBreakpoints(items) {
  const host = $('#dom-breakpoints'); host.replaceChildren(...items.map(item => {
    const labelNode = el('label', 'breakpoint-row'); const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = item.enabled; const text = item.type === 'subtree-modified' ? 'Subtree modifications' : item.type === 'attribute-modified' ? 'Attribute modifications' : 'Node removal';
    checkbox.onchange = () => void action(async () => { await api('/breakpoint', { ...token(), type: item.type, enabled: checkbox.checked }); notice(`${text} breakpoint ${checkbox.checked ? 'enabled' : 'disabled'}.`, 'success'); }); labelNode.append(checkbox, document.createTextNode(text)); return labelNode;
  }));
}
async function loadPane(name) {
  const paneMap = { layout: ['#layout-details', renderLayout], events: ['#event-listeners', renderEvents], accessibility: ['#accessibility-details', renderAccessibility], breakpoints: ['#dom-breakpoints', renderBreakpoints] };
  if (!paneMap[name] || !state.selected || state.selected.nodeType !== 1) return;
  const [selector, render] = paneMap[name]; const key = `${state.selected.backendNodeId}:${name}`; if (state.paneData.has(key)) { render(state.paneData.get(key)); return; }
  $(selector).replaceChildren(el('p', 'field-help', 'Loading live details…'));
  try { const result = await api(`/details/${name}`, token()); if (result.session !== state.session) return; state.paneData.set(key, result.data); render(result.data); } catch (error) { $(selector).replaceChildren(el('p', 'panel-error', error.message)); }
}
async function showTab(name) {
  for (const tab of document.querySelectorAll('[role="tab"]')) { const active = tab.dataset.tab === name; tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1; $(`#panel-${tab.dataset.tab}`).hidden = !active; }
  await loadPane(name);
}
for (const tab of document.querySelectorAll('[role="tab"]')) {
  tab.onclick = async () => { if (state.monacoTextEdit && tab.getAttribute('aria-selected') !== 'true') await finishMonacoTextEdit('commit'); if (state.dirty && tab.getAttribute('aria-selected') !== 'true') { if (!(await discardDraft())) return; state.dirty = false; renderSelection(); } await showTab(tab.dataset.tab); };
  tab.onkeydown = event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const tabs = [...document.querySelectorAll('[role="tab"]')]; const index = tabs.indexOf(tab); const next = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]; next.click(); if (!$('#discard-dialog').open) next.focus(); };
}
function renderHistory() {
  $('#history-count').textContent = state.history.length;
  $('#history').replaceChildren(...state.history.slice().reverse().map(entry => {
    const details = el('details', 'history-entry'); const summary = el('summary'); const time = el('time', '', new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })); time.dateTime = entry.timestamp;
    summary.append(el('span', '', entry.kind === 'html' ? 'HTML' : ['style', 'css-rule', 'selector'].includes(entry.kind) ? 'CSS' : entry.kind === 'text' ? 'TEXT' : 'ATTR'), el('span', 'history-selector', `${entry.selector} · ${entry.property}`), time);
    const diff = el('div', 'history-diff'); diff.append(el('div', 'before', `− ${entry.before ?? '(not set)'}`), el('div', 'after', `+ ${entry.after ?? '(removed)'}`)); details.append(summary, diff); return details;
  }));
  if (!state.history.length) $('#history').append(el('p', 'history-empty', 'No edits yet. Your changes will appear here.'));
  syncControls();
}
$('#undo-button').onclick = async () => { if (!(await discardDraft())) return; await action(async () => { await applyResult(await api('/undo', { session: state.session })); notice('Last edit undone in the live page.', 'success'); }); };
$('#resume-button').onclick = () => action(async () => { await api('/debugger/resume', { session: state.session }); state.paused = false; notice('Page resumed.', 'success'); });
function clearSelection() { abandonMonacoTextEdit(); state.selected = null; state.details = null; state.dirty = false; state.paneData.clear(); $('#selected-content').hidden = true; $('#inspector-empty').hidden = false; syncControls(); }
function resetDocument(data) {
  abandonTextEditor();
  if (data.cdpPort) $('#port-label').textContent = `:${data.cdpPort}`;
  state.session = data.session; state.connected = data.connected; state.paused = !!data.paused; state.tree = null; state.nodes.clear(); state.parents.clear(); state.history = []; state.picking = false; state.paneData.clear(); state.pseudoByNode.clear();
  $('#tree').replaceChildren(); $('#tree').hidden = true; $('#tree-empty').hidden = false; $('#node-count').textContent = 'No document loaded'; clearSelection(); renderHistory();
  $('#footer-status').textContent = data.connected ? (data.target?.url || 'Connected to browser') : 'Waiting for browser';
}
async function connectSelected({ autoPick = false } = {}) {
  if (!(await discardDraft())) return;
  notice('Connecting to the signed-in browser tab…');
  const result = await api('/connect', { targetId: $('#target-select').value }); resetDocument(result); setTree(result.tree, { reset: true });
  const body = [...state.nodes.values()].find(node => node.nodeType === 1 && node.localName === 'body') || [...state.nodes.values()].find(node => node.nodeType === 1 && node.localName === 'html');
  if (body) { state.expanded.add(body.backendNodeId); await selectNode(body); revealSelected(); }
  if (autoPick) { await api('/inspect', { enabled: true, session: state.session }); state.picking = true; }
  notice(autoPick ? 'Connected. Click any element in the page to inspect it.' : 'Connected. Choose an element in the tree or use Pick.', 'success');
}
async function refreshTargets({ connectExtension = false } = {}) {
  const previous = $('#target-select').value; const targets = await api('/targets');
  $('#target-select').replaceChildren(new Option(targets.length ? 'Choose a browser tab' : 'No tabs available. Open a page in the debugging browser.', ''), ...targets.map(target => new Option(`${target.title || 'Untitled'} · ${target.url}`, target.id)));
  const extensionTarget = targets.find(target => target.transport === 'extension');
  if (extensionMode && extensionTarget) $('#target-select').value = extensionTarget.id;
  else if (targets.some(target => target.id === previous)) $('#target-select').value = previous;
  else if (targets.length === 1) $('#target-select').value = targets[0].id;
  syncControls();
  if (connectExtension && extensionMode && extensionTarget && !state.connected && !state.autoConnecting) { state.autoConnecting = true; try { await connectSelected({ autoPick: true }); } finally { state.autoConnecting = false; } }
  else if (!state.connected) notice(`${targets.length} browser tab${targets.length === 1 ? '' : 's'} available. Choose a tab to inspect.`);
}
$('#refresh-targets').onclick = () => action(() => refreshTargets());
$('#target-select').onchange = syncControls;
$('#connect-button').onclick = () => action(() => connectSelected());
$('#disconnect-button').onclick = async () => { if (!(await discardDraft())) return; await action(async () => { resetDocument(await api('/disconnect', {})); notice('Disconnected. Live edits remain until the page reloads.'); }); };
$('#refresh-dom').onclick = async () => { if (!(await discardDraft())) return; await action(async () => { const selected = state.selected?.backendNodeId; const result = await api('/dom'); state.session = result.session; setTree(result.tree); const node = [...state.nodes.values()].find(candidate => candidate.backendNodeId === selected); if (node) await selectNode(node); else clearSelection(); notice('Document refreshed.'); }); };
$('#pick-button').onclick = () => action(async () => { state.picking = !state.picking; try { await api('/inspect', { enabled: state.picking, session: state.session }); } catch (error) { state.picking = false; throw error; } notice(state.picking ? 'Click an element in the page. Press Escape here to cancel.' : 'Element picker stopped.'); });
function expandAncestors(node) { let id = state.parents.get(node.nodeId); while (id) { const parent = state.nodes.get(id); if (parent) state.expanded.add(parent.backendNodeId); id = state.parents.get(id); } }
function revealSelected() {
  renderTree();
  if (state.selected && !$('#tree [aria-selected="true"]') && $('#tree-search').value) { $('#tree-search').value = ''; renderTree(); }
  const tree = $('#tree'); const row = tree.querySelector('[aria-selected="true"]');
  if (row) { tree.scrollTop = Math.max(0, row.offsetTop - tree.clientHeight / 2 + row.offsetHeight / 2); tree.scrollLeft = 0; }
}
function setSplit(percent) {
  const value = Math.max(25, Math.min(70, Math.round(percent)));
  document.documentElement.style.setProperty('--tree-percent', `${value}%`); $('#splitter').setAttribute('aria-valuenow', String(value));
  try { localStorage.setItem('element-tree-percent', String(value)); } catch { /* storage unavailable */ }
}
if (extensionMode) {
  setSplit(Number(localStorage.getItem('element-tree-percent')) || 36);
  const splitter = $('#splitter'); let dragging = false;
  splitter.addEventListener('pointerdown', event => { dragging = true; splitter.setPointerCapture(event.pointerId); document.body.classList.add('is-resizing'); });
  splitter.addEventListener('pointermove', event => { if (!dragging) return; const bounds = $('.workbench').getBoundingClientRect(); setSplit(((event.clientY - bounds.top) / bounds.height) * 100); });
  splitter.addEventListener('pointerup', event => { dragging = false; splitter.releasePointerCapture(event.pointerId); document.body.classList.remove('is-resizing'); });
  splitter.addEventListener('keydown', event => { if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const current = Number(splitter.getAttribute('aria-valuenow')); setSplit(event.key === 'Home' ? 25 : event.key === 'End' ? 70 : current + (event.key === 'ArrowDown' ? 3 : -3)); });
}
$('#port-settings').onclick = () => {
  if (extensionMode && window.parent !== window) window.parent.postMessage({ type: 'element-settings' }, '*');
  else $('#setup-dialog').showModal();
};
for (const id of ['help-button', 'empty-setup']) $(`#${id}`).onclick = () => $('#setup-dialog').showModal();
$('#close-setup').onclick = () => $('#setup-dialog').close();
document.addEventListener('keydown', event => {
  if (event.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(event.target.tagName) && state.connected && !document.querySelector('dialog[open]')) { event.preventDefault(); $('#tree-search').focus(); }
  if (event.key === 'Escape' && state.monacoTextEdit) { event.preventDefault(); void finishMonacoTextEdit('cancel'); return; }
  if (event.key === 'Escape' && state.picking) $('#pick-button').click();
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && htmlEditor.hasTextFocus()) { event.preventDefault(); if (!$('#save-html').disabled) $('#save-html').click(); }
});
window.addEventListener('beforeunload', event => { if (state.dirty) { event.preventDefault(); event.returnValue = ''; } });

const events = new EventSource('/events');
events.onmessage = async event => {
  const data = JSON.parse(event.data);
  if (['disconnected', 'document', 'connected', 'status'].includes(data.type)) {
    if (state.session === data.session) return; const hadDraft = state.dirty; resetDocument(data);
    if (data.type === 'document') notice(`The page navigated. Waiting for the new document.${hadDraft ? ' The previous unsaved draft was cleared.' : ''}`);
    else if (data.type === 'disconnected') notice('Browser disconnected. Click the extension on the tab to reconnect.');
    if (data.connected) await action(async () => { const result = await api('/dom'); setTree(result.tree, { reset: true }); state.history = await api('/history'); renderHistory(); const body = [...state.nodes.values()].find(node => node.localName === 'body'); if (body) { state.expanded.add(body.backendNodeId); await selectNode(body); revealSelected(); } });
  } else if (data.type === 'picked') {
    state.picking = false; syncControls(); if (data.session !== state.session || !(await discardDraft())) return;
    await action(async () => { setTree(data.tree); const node = state.nodes.get(data.nodeId); if (node) { expandAncestors(node); await selectNode(node); revealSelected(); } });
  } else if (data.type === 'paused' || data.type === 'resumed') { state.paused = data.type === 'paused'; syncControls(); notice(state.paused ? `Page paused on ${data.reason || 'a DOM breakpoint'}.` : 'Page resumed.', state.paused ? '' : 'success'); }
  else if (data.type === 'notice') notice(data.message, 'error');
  else if (data.type === 'history' && !state.busy) { try { state.history = await api('/history'); renderHistory(); } catch (error) { notice(error.message, 'error'); } }
  else if (data.type === 'targets' && !state.busy) void action(() => refreshTargets({ connectExtension: true }));
};
events.onerror = () => notice('Connection to the IDE server lost. Reconnecting automatically…', 'error');
events.onopen = () => { if ($('#notice').textContent.includes('Connection to the IDE server lost')) notice('Connected to the IDE server. Waiting for the browser extension.'); };

void action(async () => {
  const status = await api('/status'); resetDocument(status);
  if (status.connected) {
    const result = await api('/dom'); setTree(result.tree, { reset: true }); state.history = await api('/history'); renderHistory();
    const body = [...state.nodes.values()].find(node => node.localName === 'body'); if (body) { state.expanded.add(body.backendNodeId); await selectNode(body); revealSelected(); }
  }
  await refreshTargets({ connectExtension: true });
});
