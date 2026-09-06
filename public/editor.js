(function setupHtmlEditor() {
  const host = document.querySelector('#html-editor');
  const fallback = document.querySelector('#html-editor-fallback');
  const listeners = new Set();
  let editor = null;
  let readOnly = false;
  let suppressChange = false;

  const notify = () => {
    if (!suppressChange) listeners.forEach(listener => listener());
  };

  fallback.addEventListener('input', notify);
  window.elementHtmlEditor = {
    getValue: () => editor?.getValue() ?? fallback.value,
    setValue(value) {
      fallback.value = value;
      if (editor && editor.getValue() !== value) {
        suppressChange = true;
        editor.setValue(value);
        suppressChange = false;
      }
    },
    setReadOnly(value) {
      readOnly = value;
      fallback.readOnly = value;
      editor?.updateOptions({ readOnly: value });
    },
    hasTextFocus: () => editor?.hasTextFocus() ?? document.activeElement === fallback,
    focus: () => (editor ? editor.focus() : fallback.focus()),
    onDidChange(listener) { listeners.add(listener); },
  };

  if (!window.require?.config) return;
  window.MonacoEnvironment = { getWorkerUrl: () => '/monaco-worker.js' };
  window.require.config({ paths: { vs: '/vendor/monaco/vs' } });
  window.require(['vs/editor/editor.main'], () => {
    editor = window.monaco.editor.create(host, {
      value: fallback.value,
      language: 'html',
      theme: 'vs',
      ariaLabel: 'outerHTML editor',
      automaticLayout: true,
      minimap: { enabled: false },
      fontFamily: "'Cascadia Code', 'SFMono-Regular', Consolas, monospace",
      fontSize: 12,
      lineHeight: 21,
      padding: { top: 14, bottom: 14 },
      renderLineHighlight: 'line',
      scrollBeyondLastLine: false,
      wordWrap: 'off',
      readOnly,
    });
    editor.onDidChangeModelContent(() => {
      fallback.value = editor.getValue();
      notify();
    });
    fallback.hidden = true;
    host.hidden = false;
  });
}());
