require('node:worker_threads').parentPort.postMessage(
  '{"kind":"pdf","pageCount":10,"private":"unexpected"}',
);
