// node --test tests/
import { test } from 'node:test';
import { cases } from './metrics.cases.mjs';

for (const [name, fn] of cases) test(name, fn);
