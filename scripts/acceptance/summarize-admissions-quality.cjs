// Validate and summarize recorded admissions evaluation runs without contacting a model.
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const suite = require('./admissions-quality-cases.json')

function summarize(runs) {
  if (!Array.isArray(runs)) throw new Error('Expected an array of evaluation records')
  const cases = new Map(suite.cases.map((entry) => [entry.id, entry]))
  const seen = new Set()
  const result = { missing: [], technicalCompleted: 0, reviewed: 0, qualityPassed: 0 }
  for (const run of runs) {
    if (!cases.has(run.caseId) || !Number.isInteger(run.repeat) || run.repeat < 1 || run.repeat > 3)
      throw new Error('Invalid case or repeat')
    const key = run.caseId + '/' + run.repeat
    if (seen.has(key)) throw new Error('Duplicate record: ' + key)
    seen.add(key)
    if (typeof run.completed !== 'boolean' || !run.modelVersion || !run.methodVersion || !run.runId)
      throw new Error('Missing run provenance: ' + key)
    if (run.completed) result.technicalCompleted++
    if (run.review == null) continue
    const { scores, requiredChecksPassed, accepted } = run.review
    if (!scores || !suite.review.dimensions.every((dimension) => [0, 1, 2].includes(scores[dimension])) ||
        typeof requiredChecksPassed !== 'boolean' || typeof accepted !== 'boolean')
      throw new Error('Invalid human review: ' + key)
    const expected = cases.get(run.caseId).expectedOutcome
    const verifiedOutcome = expected === 'human-wait'
      ? !run.completed && run.outcome === 'human-wait' && Boolean(run.waitRequestId)
      : run.completed && Boolean(run.deliveryVersion)
    if (accepted && (!requiredChecksPassed || !verifiedOutcome))
      throw new Error('Accepted review lacks evidence of the expected outcome: ' + key)
    result.reviewed++
    if (accepted) result.qualityPassed++
  }
  for (const id of cases.keys())
    for (let repeat = 1; repeat <= 3; repeat++)
      if (!seen.has(id + '/' + repeat)) result.missing.push(id + '/' + repeat)
  return result
}

module.exports = { summarize }
if (require.main === module) {
  const path = process.argv[2]
  if (!path) throw new Error('Provide the JSON evaluation records path')
  process.stdout.write(JSON.stringify(summarize(JSON.parse(readFileSync(resolve(path), 'utf8'))), null, 2) + '\n')
}
