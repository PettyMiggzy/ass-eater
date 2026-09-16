// Uniswap V4 periphery's Solidity sources (and Permit2, which it bundles)
// import some dependencies as bare packages -- "permit2/src/..." and, inside
// Permit2 itself, "solmate/..." -- which are Foundry remappings. They only
// resolve today because v4-periphery bundles its own copies at
// node_modules/@uniswap/v4-periphery/lib/{permit2,permit2/lib/solmate}.
// Hardhat has no remapping mechanism, so each bare import only resolves if
// something with that exact name exists directly under node_modules/. This
// symlinks both there on every `npm install`, cross-platform (fs.symlink,
// not a shell `ln`).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LINKS = [
  { target: ['node_modules', '@uniswap', 'v4-periphery', 'lib', 'permit2'], link: ['node_modules', 'permit2'] },
  {
    target: ['node_modules', '@uniswap', 'v4-periphery', 'lib', 'permit2', 'lib', 'solmate'],
    link: ['node_modules', 'solmate'],
  },
];

for (const { target: targetParts, link: linkParts } of LINKS) {
  const target = path.join(ROOT, ...targetParts);
  const linkPath = path.join(ROOT, ...linkParts);
  if (!fs.existsSync(target)) continue; // dependency not installed (yet, or at all) -- nothing to link

  try {
    const relative = path.relative(path.dirname(linkPath), target);
    const stat = fs.lstatSync(linkPath, { throwIfNoEntry: false });
    if (stat && (!stat.isSymbolicLink() || fs.readlinkSync(linkPath) !== relative)) {
      fs.rmSync(linkPath, { recursive: true, force: true });
    }
    if (!fs.existsSync(linkPath)) {
      fs.symlinkSync(relative, linkPath, 'dir');
      console.log(`[postinstall] linked ${path.join(...linkParts)} -> ${path.join(...targetParts)}`);
    }
  } catch (err) {
    console.warn(`[postinstall] could not link ${path.join(...linkParts)} (V4 launchpad contracts will fail to compile):`, err.message);
  }
}
