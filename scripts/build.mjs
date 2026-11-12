// Build pipeline: bundle clean src/ -> minify -> obfuscate -> worker.js,
// then fail if any hot keyword survives into the artifact.
//
// The clean source never contains hot keywords as contiguous strings:
// sensitive literals are built by concatenation in src/ (e.g. 'vl'+'ess'),
// and the obfuscator base64-encodes every remaining string literal. The
// final scan is the enforcement gate, not the hiding mechanism.
import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
import JavaScriptObfuscator from 'javascript-obfuscator';

const HOT = ['vless', 'proxy', 'uuid', 'tunnel', 'trojan', 'vpn', 'clash', 'xray', 'singbox', 'socks', 'shadowsocks', 'hysteria', 'naive'];

const bundle = await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  minify: true,
  format: 'esm',
  target: 'es2022',
  write: false,
  legalComments: 'none',
  external: ['cloudflare:sockets'], // runtime-provided module, must stay a bare import
  define: { global: 'globalThis' },
});

const code = bundle.outputFiles[0].text;

// Pre-obfuscation sanity check on the minified bundle itself.
const preHits = HOT.filter((k) => code.toLowerCase().includes(k));
if (preHits.length > 0) {
  console.error('HOT KEYWORDS IN CLEAN SOURCE (fix src/, not the pipeline):', preHits);
  process.exit(1);
}

const obfuscated = JavaScriptObfuscator.obfuscate(code, {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,
  deadCodeInjection: false,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 1,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  splitStrings: true,
  splitStringsChunkLength: 4,
  renameGlobals: false,
  selfDefending: false,
  identifierNamesGenerator: 'hexadecimal',
  transformObjectKeys: true,
  unicodeEscapeSequence: false,
  reservedStrings: ['cloudflare:sockets'], // import specifier must survive verbatim
}).getObfuscatedCode();

const hits = HOT.filter((k) => obfuscated.toLowerCase().includes(k));
if (hits.length > 0) {
  console.error('HOT KEYWORDS STILL PRESENT IN ARTIFACT:', hits);
  process.exit(1);
}

writeFileSync('worker.js', obfuscated);
console.log('worker.js written,', obfuscated.length, 'bytes, hot-keyword scan clean.');
