/**
 * Stands in for `python -m agent_eval_rpc.dspy_rlm_bridge`, the child process
 * `traces ask` runs for each question: the one faked process boundary.
 *
 * Usage: node stub-bridge.mjs <plan.json> [bridge argv…]. The bridge argv is
 * whatever the engine passed (`-m <module> --max-input-bytes N --input I
 * --output O`, after uv's own `--from … python` when it runs as uvx); only
 * `--input` and `--output` are read, and the whole argv is logged.
 *
 * The plan picks a script by a substring of the question:
 *   { "log": "<file>", "questions": [{ "match": "…", "modelCalls": 1, "answer": "…", "fail": "…" }] }
 * `fail` with no model calls dies at startup with that stderr, as a missing or
 * mismatched bridge does. Otherwise the stub makes `modelCalls` calls through
 * the engine's model proxy, exactly as the real bridge does (a refused call
 * ends it with litellm's BadGatewayError text and exit 1), then writes `answer`.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const [planPath, ...argv] = process.argv.slice(2)
const plan = JSON.parse(readFileSync(planPath, 'utf8'))
const valueOf = (flag) => argv[argv.indexOf(flag) + 1]
const input = JSON.parse(readFileSync(valueOf('--input'), 'utf8'))
if (plan.log) appendFileSync(plan.log, `${JSON.stringify({ argv, question: input.question })}\n`)

const script = plan.questions.find((entry) => input.question.includes(entry.match)) ?? plan.questions.at(-1)
const modelCalls = script.modelCalls ?? 1
if (script.fail && modelCalls === 0) {
  process.stderr.write(`${script.fail}\n`)
  process.exit(1)
}

const proxy = input.modelProxy
for (let call = 0; call < modelCalls; call += 1) {
  const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${proxy.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: proxy.model,
      messages: [{ role: 'user', content: `stub step ${call + 1}` }],
      max_tokens: proxy.maxOutputTokens,
    }),
  })
  const body = await response.text()
  if (!response.ok) {
    process.stderr.write(`DSPY-BRIDGE-FAILURE: BadGatewayError: litellm.BadGatewayError: OpenAIException - Error code: ${response.status} - ${body}\n`)
    process.exit(1)
  }
}

writeFileSync(valueOf('--output'), JSON.stringify({
  answer: script.answer,
  findings: [],
  trajectory: [],
  modelCalls,
  runtime: {},
}))
