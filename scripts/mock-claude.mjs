#!/usr/bin/env node
/**
 * A stand-in for the Anthropic Messages API — and for Vercel AI Gateway's
 * Anthropic-compatible one — for local testing: no real key, no real calls,
 * no cost. Point the project at it with ANTHROPIC_BASE_URL=http://127.0.0.1:<port>
 * (with SCALLLE_APP_URL local too).
 *
 * A request for an `anthropic/…` model is an AI Gateway request, and must be
 * exactly what the gateway is sent: x-api-key = the project's Vercel sign-in
 * (the `gatewayToken` given at start, if any), no Authorization header, no
 * anthropic-beta header, no `fallbacks`, output_config.effort set, and
 * providerOptions.gateway = { order: ['anthropic'], only: ['anthropic'],
 * zeroDataRetention: true }. Anything else is answered 400 and listed in
 * `gatewayProblems`, so a test fails loudly.
 *
 * Answers POST /v1/messages as a stream (server-sent events, like the real
 * API). What it answers is planned per scenario: the item's `scenario` field
 * picks the queue, and each request takes the next answer from it ('ok' when
 * the queue is empty):
 *
 *   'ok'          a normal answer
 *   'overloaded'  HTTP 529 overloaded_error, as when Anthropic is busy
 *   'busy'        the same, with Retry-After: 1 — so a test can run a step
 *                 out of retries in seconds rather than minutes
 *   'refusal'     stop_reason "refusal" (category "cyber"), no fallback could help
 *   'fallback'    Opus 5.5 declines part-way, the fallback model finishes;
 *                 usage.iterations carries both attempts
 *   'max_tokens'  the answer is cut off
 *   'unauthorized' HTTP 401
 *   'no_credit'   HTTP 402, as AI Gateway answers with no credit for Claude
 *   'no_zdr'      HTTP 400 no_providers_available, as AI Gateway answers when
 *                 no provider will take the request with zero data retention
 *   'limited'     HTTP 429 with Retry-After: 1
 *
 *   mock.planFor('claude-529', ['overloaded', 'ok'])                    // in code
 *   POST /__plan { "scenario": "claude-529", "answers": ["overloaded", "ok"] }  // over HTTP
 *
 * Run it on its own:  node scripts/mock-claude.mjs   (PORT, default 4020)
 */
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

export const MOCK_ANSWER = 'DRAFT: Dear Sam, thank you for your referral. [mock answer]'
export const MOCK_FALLBACK_ANSWER = 'DRAFT: finished by the fallback model. [mock answer]'

/** What every AI Gateway request must ask for. */
const GATEWAY_OPTIONS = JSON.stringify({ gateway: { order: ['anthropic'], only: ['anthropic'], zeroDataRetention: true } })

/** What is wrong with an AI Gateway request; empty when it is as it must be. */
function gatewayProblemsOf(headers, body, gatewayToken) {
  const problems = []
  if (gatewayToken !== undefined && headers['x-api-key'] !== gatewayToken) problems.push('x-api-key is not the Vercel sign-in')
  if (headers.authorization) problems.push('an Authorization header was sent')
  if (headers['anthropic-beta']) problems.push(`anthropic-beta was sent (${headers['anthropic-beta']})`)
  if ('fallbacks' in body) problems.push('fallbacks was sent')
  if (!body.output_config?.effort) problems.push('output_config.effort is missing')
  if (JSON.stringify(body.providerOptions) !== GATEWAY_OPTIONS) {
    problems.push(`providerOptions is ${JSON.stringify(body.providerOptions)}`)
  }
  return problems
}

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  res.end()
}

function messageStart(model, inputTokens) {
  return {
    type: 'message_start',
    message: {
      id: `msg_mock_${Math.random().toString(36).slice(2, 10)}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  }
}

function textBlock(index, text) {
  return [
    { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index },
  ]
}

export async function startMockClaude({ port = 0, quiet = true, gatewayToken } = {}) {
  /** @type {{ url: string, headers: Record<string, string | string[] | undefined>, body: any, scenario: string | null, answer: string }[]} */
  const requests = []
  /** @type {string[]} */
  const gatewayProblems = []
  /** @type {Map<string, string[]>} */
  const plans = new Map()

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    const json = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(JSON.stringify(body))
    }

    if (req.method === 'GET' && url.pathname === '/__requests') return json(200, requests)
    if (req.method === 'POST' && url.pathname === '/__plan') {
      const { scenario, answers } = JSON.parse(raw)
      plans.set(scenario, answers)
      return json(200, { ok: true })
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/messages') {
      return json(404, { type: 'error', error: { type: 'not_found_error', message: 'Not found' } })
    }

    const body = JSON.parse(raw)
    let scenario = null
    try {
      scenario = JSON.parse(body.messages?.[0]?.content ?? '{}').scenario ?? null
    } catch {
      scenario = null
    }
    const answer = (scenario && plans.get(scenario)?.shift()) || 'ok'
    requests.push({ url: req.url ?? '', headers: req.headers, body, scenario, answer })
    if (!quiet) console.log(`[mock claude] scenario ${scenario ?? '-'} → ${answer}`)

    const model = body.model
    if (typeof model === 'string' && model.startsWith('anthropic/')) {
      const problems = gatewayProblemsOf(req.headers, body, gatewayToken)
      if (problems.length > 0) {
        gatewayProblems.push(...problems)
        if (!quiet) console.log(`[mock claude] NOT a proper AI Gateway request: ${problems.join('; ')}`)
        return json(400, { type: 'error', error: { type: 'invalid_request_error', message: problems.join('; ') } })
      }
    }
    switch (answer) {
      case 'no_credit':
        return json(402, { type: 'error', error: { type: 'insufficient_funds', message: 'Insufficient funds' } })
      case 'no_zdr':
        return json(400, { type: 'error', error: { type: 'no_providers_available', message: 'No providers available' } })
      case 'limited':
        return json(429, { type: 'error', error: { type: 'rate_limit_exceeded', message: 'Rate limited' } }, { 'retry-after': '1' })
      case 'overloaded':
        return json(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })
      case 'busy':
        return json(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, { 'retry-after': '1' })
      case 'unauthorized':
        return json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })
      case 'refusal':
        return sse(res, [
          messageStart(model, 150),
          {
            type: 'message_delta',
            delta: {
              stop_reason: 'refusal',
              stop_sequence: null,
              stop_details: { type: 'refusal', category: 'cyber', explanation: null },
            },
            usage: { output_tokens: 0 },
          },
          { type: 'message_stop' },
        ])
      case 'max_tokens':
        return sse(res, [
          messageStart(model, 150),
          ...textBlock(0, 'DRAFT: Dear Sam, thank you for'),
          {
            type: 'message_delta',
            delta: { stop_reason: 'max_tokens', stop_sequence: null, stop_details: null },
            usage: { output_tokens: 16000 },
          },
          { type: 'message_stop' },
        ])
      case 'fallback':
        return sse(res, [
          messageStart('claude-opus-4-8', 150),
          ...textBlock(0, 'DRAFT: partial text from the declined model'),
          {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'fallback', from: { model }, to: { model: 'claude-opus-4-8' } },
          },
          { type: 'content_block_stop', index: 1 },
          ...textBlock(2, MOCK_FALLBACK_ANSWER),
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null, stop_details: null },
            usage: {
              input_tokens: 160,
              output_tokens: 30,
              iterations: [
                { type: 'message', model, input_tokens: 150, output_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null },
                { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 160, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null },
              ],
            },
          },
          { type: 'message_stop' },
        ])
      default:
        return sse(res, [
          messageStart(model, 150),
          ...textBlock(0, MOCK_ANSWER),
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null, stop_details: null },
            usage: { output_tokens: 42 },
          },
          { type: 'message_stop' },
        ])
    }
  })

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  const address = server.address()
  const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : port}`

  return {
    origin,
    requests,
    gatewayProblems,
    forScenario: (scenario) => requests.filter((r) => r.scenario === scenario),
    planFor: (scenario, answers) => plans.set(scenario, [...answers]),
    reset: () => {
      requests.length = 0
      gatewayProblems.length = 0
      plans.clear()
    },
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const mock = await startMockClaude({ port: Number(process.env.PORT ?? 4020), quiet: false })
  console.log(`Mock Claude listening on ${mock.origin} — set ANTHROPIC_BASE_URL=${mock.origin}`)
}
