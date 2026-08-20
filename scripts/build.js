#!/usr/bin/env node
/**
 * Builds dist/ from src/supercomment.js.
 *
 *   node scripts/build.js          write dist/
 *   node scripts/build.js --check  fail if dist/ is stale (used by CI)
 *
 * dist/ is committed so the library is usable straight from jsDelivr/unpkg
 * without an npm install; --check keeps it from drifting out of sync.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const SRC = path.join(root, 'src', 'supercomment.js');
const DIST = path.join(root, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const source = fs.readFileSync(SRC, 'utf8');

// The client carries its own VERSION for the payload and the X-Supercomment
// header. If it drifts from package.json, every report is mislabelled.
const declared = /var VERSION = '([^']+)'/.exec(source);
if (!declared) {
  console.error('build: could not find VERSION in src/supercomment.js');
  process.exit(1);
}
if (declared[1] !== pkg.version) {
  console.error(
    `build: version mismatch — package.json is ${pkg.version}, src/supercomment.js says ${declared[1]}.\n` +
      '       Update the VERSION constant so reports are labelled correctly.'
  );
  process.exit(1);
}

const banner = `/*! supercomment v${pkg.version} | ${pkg.license} | ${pkg.homepage} */`;

async function build() {
  const min = await esbuild.transform(source, {
    minify: true,
    target: ['es2017'],
    legalComments: 'none'
  });

  return {
    'supercomment.js': banner + '\n' + source,
    'supercomment.min.js': banner + '\n' + min.code
  };
}

build().then((files) => {
  const check = process.argv.includes('--check');
  let stale = false;

  if (!check) fs.mkdirSync(DIST, { recursive: true });

  for (const [name, content] of Object.entries(files)) {
    const target = path.join(DIST, name);
    if (check) {
      const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
      if (current !== content) {
        console.error(`build --check: dist/${name} is stale. Run \`npm run build\` and commit the result.`);
        stale = true;
      }
    } else {
      fs.writeFileSync(target, content);
      const kb = (Buffer.byteLength(content) / 1024).toFixed(1);
      console.log(`  dist/${name.padEnd(24)} ${kb} kB`);
    }
  }

  if (stale) process.exit(1);
  if (check) console.log('build --check: dist/ is up to date');
});
