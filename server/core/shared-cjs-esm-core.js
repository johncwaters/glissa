'use strict';

function requiredSpecifiers(source) {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  return [...new Set([...withoutComments.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((match) => match[1]))];
}

function renderSharedCjsEsm(source, resolveSpecifier) {
  const dependencies = requiredSpecifiers(source).map((specifier, index) => ({
    index,
    specifier,
    resolved: resolveSpecifier(specifier),
  }));
  const imports = dependencies
    .map(({ index, resolved }) => `import * as __namespace${index} from ${JSON.stringify(resolved)};`)
    .join('\n');
  const table = dependencies
    .map(({ index, specifier }) => `  ${JSON.stringify(specifier)}: __interop(__namespace${index}),`)
    .join('\n');
  return `${imports}
const __interop = (namespace) => (namespace?.default && typeof namespace.default === 'object' ? { ...namespace, ...namespace.default } : namespace);
const __required = {
${table}
};
const require = (specifier) => __required[specifier];
const module = { exports: {} };
const exports = module.exports;
${source}
export default module.exports;
`;
}

module.exports = { renderSharedCjsEsm };
