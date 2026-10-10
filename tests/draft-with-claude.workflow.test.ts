/**
 * The workflows themselves, run by the real Workflow runtime in-process
 * (@workflow/vitest, local world), against the mock Scallle and mock Claude.
 * Retries really wait (5 s, 10 s …), so a few of these take a while.
 *
 *   npm run test:workflows
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getRun, resumeHook, start } from 'workflow/api'
import { waitForHook } from '@workflow/vitest'

import type { ScallleJob } from '../src/lib/contract'
import { draftWithClaude } from '../src/workflows/draft-with-claude'
import { approvalToken, draftThenApprove } from '../src/workflows/examples/draft-then-approve'
import { UNEXPECTED_ERROR_MESSAGE } from '../src/lib/plain-errors'
import { carelessStep } from './fixtures/careless-step'
// @ts-expect-error — plain .mjs test helpers without types
import { MOCK_ANSWER, startMockClaude } from '../scripts/mock-claude.mjs'
// @ts-expect-error — plain .mjs test helpers without types
import { startMockScallle } from '../scripts/mock-scallle.mjs'

type Mock = { origin: string; close: () => Promise<void> } & Record<string, any>

let scallle: Mock
let claude: Mock
let n = 0

/** A made-up, unsigned JWT-shaped stand-in for the project's Vercel sign-in
 *  (TEST ONLY), valid for an hour so @vercel/oidc takes it as it is. */
const FAKE_VERCEL_TOKEN = [
  Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url'),
  Buffer.from(JSON.stringify({ sub: 'test-only', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'),
  'not-signed',
].join('.')

function job(scenario: string, extra: Partial<ScallleJob> = {}): ScallleJob {
  const runId = `run_${scenario}_${++n}`
  return {
    connectionId: 'conn_test',
    runId,
    automationId: 'auto_test',
    workspaceId: '11111111-1111-4111-8111-111111111111', // TEST ONLY
    test: false,
    step: { title: 'Acknowledge', procedure: 'Write a short acknowledgement.' },
    item: { scenario, name: 'Test Person' },
    callbackUrl: `${scallle.origin}/api/automations/auto_test/runs/${runId}?token=tok`,
    ...extra,
  }
}

beforeAll(async () => {
  scallle = await startMockScallle()
  claude = await startMockClaude({ gatewayToken: FAKE_VERCEL_TOKEN })
  process.env.SCALLLE_APP_URL = scallle.origin
  process.env.ANTHROPIC_BASE_URL = claude.origin
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-real'
})

afterAll(async () => {
  await scallle.close()
  await claude.close()
})

describe('draftWithClaude', () => {
  it('drafts with Claude and delivers a success with usage', async () => {
    const j = job('ok')
    const run = await start(draftWithClaude, [j])
    await expect(run.returnValue).resolves.toEqual({ outcome: 'delivered', status: 'success' })
    expect(scallle.forRun(j.runId).map((r: any) => r.body)).toEqual([
      {
        status: 'success',
        metadata: { result: MOCK_ANSWER },
        usage: { model: 'claude-opus-5-5', input_tokens: 150, output_tokens: 42 },
      },
    ])
  })

  it('through AI Gateway (no ANTHROPIC_API_KEY): the real @vercel/oidc inside the step, the gateway request as it must be', async () => {
    const key = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.VERCEL_OIDC_TOKEN_FILE
    process.env.VERCEL_OIDC_TOKEN = FAKE_VERCEL_TOKEN
    try {
      const j = job('gateway')
      const run = await start(draftWithClaude, [j])
      await expect(run.returnValue).resolves.toEqual({ outcome: 'delivered', status: 'success' })
      const [call] = claude.forScenario('gateway')
      expect(call.body.model).toBe('anthropic/claude-opus-5.5')
      expect(call.headers['x-api-key']).toBe(FAKE_VERCEL_TOKEN)
      expect(claude.gatewayProblems).toEqual([])
      expect(scallle.forRun(j.runId)[0].body.usage).toEqual({ model: 'claude-opus-5-5', input_tokens: 150, output_tokens: 42 })
    } finally {
      process.env.ANTHROPIC_API_KEY = key
      delete process.env.VERCEL_OIDC_TOKEN
    }
  })

  it('does the work once when the same Scallle run arrives twice', async () => {
    const j = job('twice')
    const first = await start(draftWithClaude, [j])
    await first.returnValue
    const second = await start(draftWithClaude, [j])
    await expect(second.returnValue).resolves.toEqual({ outcome: 'duplicate', handledBy: first.runId })
    expect(claude.forScenario('twice')).toHaveLength(1)
    expect(scallle.forRun(j.runId)).toHaveLength(1)
  })

  it('reports a refusal to Scallle plainly, and the run ends as failed', async () => {
    claude.planFor('refusal', ['refusal'])
    const j = job('refusal')
    const run = await start(draftWithClaude, [j])
    await expect(run.returnValue).rejects.toThrow()
    expect(await getRun(run.runId).status).toBe('failed')
    expect(scallle.forRun(j.runId).map((r: any) => r.body)).toEqual([
      { status: 'error', error_message: 'Claude declined to do this step (cyber).' },
    ])
  })

  it('retries Claude after a 529 and succeeds', async () => {
    claude.planFor('busy', ['overloaded', 'ok'])
    const j = job('busy')
    const run = await start(draftWithClaude, [j])
    await expect(run.returnValue).resolves.toEqual({ outcome: 'delivered', status: 'success' })
    expect(claude.forScenario('busy').map((c: any) => c.answer)).toEqual(['overloaded', 'ok'])
  })

  it('retries delivery after 503, 503 and stops at the 200, without calling Claude again', async () => {
    const j = job('callback-503')
    scallle.planFor(j.runId, [503, 503, 200])
    const run = await start(draftWithClaude, [j])
    await expect(run.returnValue).resolves.toEqual({ outcome: 'delivered', status: 'success' })
    expect(scallle.forRun(j.runId).map((r: any) => r.status)).toEqual([503, 503, 200])
    expect(claude.forScenario('callback-503')).toHaveLength(1)
  })

  it('drafts from the step title when the step has no written procedure yet', async () => {
    const j = job('no-procedure', { step: { title: 'Acknowledge', procedure: null } })
    const run = await start(draftWithClaude, [j])
    await expect(run.returnValue).resolves.toEqual({ outcome: 'delivered', status: 'success' })
    const [call] = claude.forScenario('no-procedure')
    expect(call.body.system).toContain('Step: Acknowledge')
    expect(call.body.system).toContain('There is no written procedure for this step. Do only what the step title says.')
    expect(scallle.forRun(j.runId)[0].body.status).toBe('success')
  })

  it('reports a step with neither title nor procedure without calling Claude', async () => {
    const j = job('no-instructions', { step: { title: null, procedure: null } })
    const run = await start(draftWithClaude, [j])
    await expect(run.returnValue).rejects.toThrow()
    expect(scallle.forRun(j.runId)[0].body).toEqual({
      status: 'error',
      error_message: 'This step has no title or written procedure for Claude to follow.',
    })
    expect(claude.forScenario('no-instructions')).toHaveLength(0)
  })
})

describe('what a step that ran out of retries tells Scallle', () => {
  // Made-up, but shaped like what a real item could hold.
  const SENSITIVE = 'Jane Doe, DOB 1 Feb 1990, 12 Acacia Avenue, history of self-harm'

  it('a plain error quoting the item → only the general sentence, in the callback and in the failed run', async () => {
    const j = job('careless', { item: { scenario: 'careless', notes: SENSITIVE } })
    const run = await start(carelessStep, [j])
    const failure = await run.returnValue.then(
      () => null,
      (err: unknown) => err
    )
    expect(scallle.forRun(j.runId).map((r: any) => r.body)).toEqual([
      { status: 'error', error_message: UNEXPECTED_ERROR_MESSAGE },
    ])
    expect(await getRun(run.runId).status).toBe('failed')
    // The run's own failure carries the same plain sentence, not the item.
    const stored = JSON.stringify(failure, Object.getOwnPropertyNames(failure ?? {})) + String(failure)
    expect(stored).not.toMatch(/Jane|Acacia|self-harm|1990/)
    expect(stored).toContain('unexpected error')
  })

  it('Claude busy until askClaude runs out of retries → the plain retryable message, not the runtime’s wrapper', async () => {
    claude.planFor('always-busy', Array(6).fill('busy'))
    const j = job('always-busy')
    const run = await start(draftWithClaude, [j])
    await expect(run.returnValue).rejects.toThrow()
    expect(claude.forScenario('always-busy')).toHaveLength(6) // the first try and 5 retries
    expect(scallle.forRun(j.runId).map((r: any) => r.body)).toEqual([
      { status: 'error', error_message: 'Claude was too busy or unwell to answer (HTTP 529).' },
    ])
  })
})

describe('draftThenApprove (example, not wired)', () => {
  it('acts only after approval', async () => {
    const j = job('approve')
    const run = await start(draftThenApprove, [j])
    await waitForHook(run, { token: approvalToken(j.runId) })
    expect(scallle.forRun(j.runId)[0].body.status).toBe('success') // the draft went to Scallle first
    await resumeHook(approvalToken(j.runId), { approved: true })
    await expect(run.returnValue).resolves.toEqual({ acted: true })
  })

  it('on a test run, sends the draft and stops: no waiting, nothing acts', async () => {
    const j = job('approve-test', { test: true })
    const run = await start(draftThenApprove, [j])
    await expect(run.returnValue).resolves.toEqual({ acted: false, reason: 'test' })
    expect(scallle.forRun(j.runId).map((r: any) => r.body.status)).toEqual(['success'])
  })

  it('does nothing when the draft is rejected', async () => {
    const j = job('reject')
    const run = await start(draftThenApprove, [j])
    await waitForHook(run, { token: approvalToken(j.runId) })
    await resumeHook(approvalToken(j.runId), { approved: false })
    await expect(run.returnValue).resolves.toEqual({ acted: false, reason: 'rejected' })
  })
})
