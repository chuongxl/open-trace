import * as client from '../src/api/client.js'

const expected = [
  'getHealth', 'getOverview', 'getProjects', 'getSessions', 'getSession',
  'getSessionMemory', 'getPrompt', 'postOptimization', 'getOptimization',
]

const missing = expected.filter((name) => typeof client[name] !== 'function')

if (missing.length > 0) {
  console.error(`Missing or non-function exports from api/client.js: ${missing.join(', ')}`)
  process.exit(1)
}

console.log(`OK: all ${expected.length} client exports present.`)
