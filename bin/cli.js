#!/usr/bin/env node
/**
 * js-recover CLI
 */
import { createCommand } from '../src/cli.js';
const program = createCommand();
program.parse(process.argv);
