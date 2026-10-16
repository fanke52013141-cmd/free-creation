/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { resolve, relative, isAbsolute, sep, dirname } = require('node:path')
const { mkdirSync } = require('node:fs')

// Preserve the old standalone paths, but isolate every output during full verification.
function qaOutputPath(output, root = process.env.CANVAS_QA_OUTPUT_ROOT) {
  if (!root) return resolve(output)
  const destination = resolve(root, output)
  const child = relative(resolve(root), destination)
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error('QA_OUTPUT_PATH_OUTSIDE_RUN')
  }
  mkdirSync(dirname(destination), { recursive: true })
  return destination
}

module.exports = { qaOutputPath }
