// Run outside Jest's VM: MongoDB 7's async handshake metadata requires Node's
// native module realm. Reuse the TypeScript scenarios and Jest assertions/mocks.
// Build first, then: node --test test/payment-reservations.cjs
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const core = require.resolve('@jest/core', { paths: [require.resolve('jest')] });
const runtime = require.resolve('jest-runtime', { paths: [core] });
const expectPath = require.resolve('expect', { paths: [runtime] });
const mockPath = require.resolve('jest-mock', { paths: [runtime] });
let source = fs.readFileSync(path.join(__dirname, 'payment-reservations.scenarios.ts'), 'utf8');
source = source.replace(/^jest\.mock\([^\n]+\);\r?\n/gm, '');
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
} }).outputText.replace(/require\("\.\.\/src\/pos\//g, 'require("../dist/pos/');
const setup = `const {describe,it,before:beforeAll,after:afterAll,beforeEach}=require('node:test');
const {expect}=require(${JSON.stringify(expectPath)});
const jest={...require(${JSON.stringify(mockPath)}),setTimeout(){}};\n`;
const child = new Module(path.join(__dirname, 'compiled-payment-scenarios.cjs'), module);
child.filename = path.join(__dirname, 'compiled-payment-scenarios.cjs');
child.paths = module.paths;
child._compile(setup + compiled, child.filename);
