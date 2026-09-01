// Stays plain .js: npm runs this inside node_modules on a git install, where Node refuses type stripping.
//
// npm runs postinstall BEFORE prepare, so on a git install dist/ does not exist yet and the notice is
// printed by scripts/prepare-build.js instead. Every failure here is swallowed: an install must not
// break over a PATH hint.

try {
  await import('../dist/scripts/postinstall-path-check.js');
} catch {
  // No build yet, or the notice threw. Either way the install is fine.
}
