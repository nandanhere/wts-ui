/**
 * Node.js --loader hook to resolve extensionless imports to .ts files
 * and @/ path aliases to the workspace src/ directory.
 *
 * Source files use extensionless imports (Next.js/Turbopack style) and @/
 * path aliases (configured in tsconfig.json).
 * Node.js --experimental-strip-types needs actual file extensions.
 * This hook maps:
 *   - @/ -> /absolute/path/to/src/
 *   - extensionless -> try .ts
 *   - .js -> try .ts
 *
 * Usage:
 *   node --experimental-strip-types --loader ./scripts/register-ts.mjs \
 *       --test src/lib/workspace/__tests__/*.test.ts
 */

import { resolve as pathResolve, extname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Resolve the project root (where package.json lives)
const projectRoot = pathResolve(new URL('.', import.meta.url).pathname, '..');
const srcDir = pathResolve(projectRoot, 'src');

/**
 * @param {string} specifier 
 * @param {{ parentURL?: string }} context 
 * @param {(specifier: string, context: any) => Promise<any>} nextResolve 
 */
export async function resolve(specifier, context, nextResolve) {
  // Resolve @/ path alias to absolute src/ path
  if (specifier.startsWith('@/')) {
    const relativePath = specifier.slice(2);
    // Try with .ts extension
    let tsPath = pathResolve(srcDir, relativePath + '.ts');
    if (existsSync(tsPath)) {
      return nextResolve(pathToFileURL(tsPath).href, context);
    }
    // Try with .tsx extension
    tsPath = pathResolve(srcDir, relativePath + '.tsx');
    if (existsSync(tsPath)) {
      return nextResolve(pathToFileURL(tsPath).href, context);
    }
    // Try without extension (for directories / index.ts)
    let indexPath = pathResolve(srcDir, relativePath, 'index.ts');
    if (existsSync(indexPath)) {
      return nextResolve(pathToFileURL(indexPath).href, context);
    }
    // Try index.tsx
    indexPath = pathResolve(srcDir, relativePath, 'index.tsx');
    if (existsSync(indexPath)) {
      return nextResolve(pathToFileURL(indexPath).href, context);
    }
    // Let nextResolve handle it (may fail)
    return nextResolve(pathToFileURL(pathResolve(srcDir, relativePath)).href, context);
  }

  // Only intercept relative imports
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    return nextResolve(specifier, context);
  }

  const parentURL = context.parentURL;
  if (!parentURL) {
    return nextResolve(specifier, context);
  }

  const parentPath = fileURLToPath(parentURL);
  const parentDir = parentPath.substring(0, parentPath.lastIndexOf('/'));
  const ext = extname(specifier);

  if (ext === '.js') {
    // .js import: try .ts first
    const tsPath = pathResolve(parentDir, specifier.replace(/\.js$/, '.ts'));
    if (existsSync(tsPath)) {
      return nextResolve(pathToFileURL(tsPath).href, context);
    }
  }

  if (ext === '') {
    // Extensionless: try .ts then .tsx
    let tsPath = pathResolve(parentDir, specifier + '.ts');
    if (existsSync(tsPath)) {
      return nextResolve(pathToFileURL(tsPath).href, context);
    }
    tsPath = pathResolve(parentDir, specifier + '.tsx');
    if (existsSync(tsPath)) {
      return nextResolve(pathToFileURL(tsPath).href, context);
    }
  }

  // Fall through to default resolution
  return nextResolve(specifier, context);
}
