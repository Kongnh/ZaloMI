// Node prints "ExperimentalWarning: SQLite is an experimental feature" on stderr the first time node:sqlite is
// loaded, which would clutter every zmi command. Importing this module drops that one warning; every other warning
// still reaches Node's own handler. node:sqlite must be loaded AFTER this module has run, so it has to be imported
// dynamically: a static `import ... from 'node:sqlite'` is loaded before any module body executes.

const nodeHandlers = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', warning => {
  if (warning.name === 'ExperimentalWarning' && /sqlite/i.test(warning.message)) return;
  for (const handler of nodeHandlers) handler.call(process, warning);
});
