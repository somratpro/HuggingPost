const fs = require('fs');

const files = [
  'apps/frontend/src/app/(app)/layout.tsx',
  'apps/frontend/src/app/(extension)/layout.tsx',
];

const importOld = "import { Plus_Jakarta_Sans } from 'next/font/google';";
const importNew = "import localFont from 'next/font/local';";
const callRegex = /const jakartaSans = Plus_Jakarta_Sans\(\{[\s\S]*?\}\);/;
const callNew = `const jakartaSans = localFont({
  src: [
    { path: '../../fonts/PlusJakartaSans-500-normal.woff2', weight: '500', style: 'normal' },
    { path: '../../fonts/PlusJakartaSans-500-italic.woff2', weight: '500', style: 'italic' },
    { path: '../../fonts/PlusJakartaSans-600-normal.woff2', weight: '600', style: 'normal' },
    { path: '../../fonts/PlusJakartaSans-600-italic.woff2', weight: '600', style: 'italic' },
  ],
  display: 'swap',
});`;

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  if (!src.includes(importOld) || !callRegex.test(src)) {
    console.error(`PATCH FAIL: ${f} — Plus_Jakarta_Sans pattern not found`);
    process.exit(1);
  }
  fs.writeFileSync(f, src.replace(importOld, importNew).replace(callRegex, callNew));
  console.log(`patched ${f}`);
}
