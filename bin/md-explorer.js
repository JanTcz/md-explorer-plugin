#!/usr/bin/env node
import { main } from '../src/cli.js';

const done = new Promise(resolve => {
  process.once('SIGINT', resolve);
  process.once('SIGTERM', resolve);
});
process.exitCode = await main(process.argv.slice(2), { waitForExit: () => done });
