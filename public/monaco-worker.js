const base = `${self.location.origin}/vendor/monaco/`;
self.MonacoEnvironment = { baseUrl: base };
importScripts(`${base}vs/base/worker/workerMain.js`);
