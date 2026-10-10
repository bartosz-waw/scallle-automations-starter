#!/usr/bin/env node
/**
 * Send this project a signed test job, exactly as Scallle would — signed with
 * the TEST key that the mock Scallle publishes (test-signing-key.mjs), so it
 * is only accepted while SCALLLE_APP_URL points at the mock.
 *
 *   node scripts/send-test-job.mjs                        # a valid job (202)
 *   node scripts/send-test-job.mjs --test                 # a valid job for a test run (run.test: true)
 *   node scripts/send-test-job.mjs --bad-signature        # signed by another key under the same key id (401)
 *   node scripts/send-test-job.mjs --unknown-kid          # signed with a key Scallle doesn't publish (401)
 *   node scripts/send-test-job.mjs --old                  # issued 10 minutes ago (401)
 *   node scripts/send-test-job.mjs --other-workspace      # another business (403)
 *   node scripts/send-test-job.mjs --wrong-to             # addressed to another project (400)
 *   node scripts/send-test-job.mjs --foreign-callback     # callback not on Scallle (400)
 *   node scripts/send-test-job.mjs --mismatched-callback  # callback for another run (400)
 *
 * Reads SCALLLE_WORKSPACE_ID and SCALLLE_APP_URL from the environment (e.g.
 * `node --env-file=.env.local scripts/send-test-job.mjs`) and posts to
 * TARGET_URL (default http://localhost:3010/api/scallle).
 *
 * Use made-up item data only — never a real person's details.
 */
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import { signatureHeaders, TEST_KEY, TEST_STRAY_KEY } from './test-signing-key.mjs'

/** Test workspace ids (TEST ONLY): this business, and another one. */
export const TEST_WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'
export const OTHER_WORKSPACE_ID = '22222222-2222-4222-8222-222222222222'

/** A contract-v1 job, its keys in the order Scallle sends them. Pass overrides to change any part of it. */
export function buildJob({
  appUrl,
  to,
  workspaceId = TEST_WORKSPACE_ID,
  runId = `run_${randomUUID()}`,
  automationId = 'auto_test',
  test = false,
  issuedAt = new Date(),
  title = 'Acknowledge the referral',
  procedure = 'Write a short, warm acknowledgement to the referrer. Say we will be in touch within two working days.',
  item = { scenario: 'manual', referrer_name: 'Sam Example', referral_reason: 'Needs supported housing' },
  callbackUrl,
  version = 1,
} = {}) {
  return {
    version,
    connection_id: 'conn_test',
    to,
    issued_at: issuedAt.toISOString(),
    run: { id: runId, automation_id: automationId, workspace_id: workspaceId, test },
    step: { title, procedure },
    item,
    callback: {
      url:
        callbackUrl ??
        `${appUrl}/api/automations/${encodeURIComponent(automationId)}/runs/${encodeURIComponent(runId)}?token=test-token-${runId}`,
    },
  }
}

/**
 * POST a job; returns { status, body, ms }. Signed with `key` (the TEST key
 * by default) under `kid` (that key's own by default); `headers: null` sends
 * it unsigned, and `headers` replaces the signature headers outright.
 */
export async function postJob(targetUrl, job, { key = TEST_KEY, kid, headers } = {}) {
  const raw = JSON.stringify(job)
  const signed = headers === undefined ? signatureHeaders(raw, key, kid ?? key.kid) : (headers ?? {})
  const started = Date.now()
  const res = await fetch(targetUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...signed },
    body: raw,
  })
  const text = await res.text()
  let body = text
  try {
    body = JSON.parse(text)
  } catch {
    // leave as text
  }
  return { status: res.status, body, ms: Date.now() - started }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const flags = new Set(process.argv.slice(2))
  const workspaceId = process.env.SCALLLE_WORKSPACE_ID ?? ''
  const appUrl = new URL(process.env.SCALLLE_APP_URL ?? 'https://app.scallle.com').origin
  const target = process.env.TARGET_URL ?? 'http://localhost:3010/api/scallle'
  if (!workspaceId) {
    console.error('Set SCALLLE_WORKSPACE_ID first (see .env.example).')
    process.exit(1)
  }

  const job = buildJob({
    appUrl,
    to: flags.has('--wrong-to') ? 'https://another-project.example/api/scallle' : target,
    workspaceId: flags.has('--other-workspace') ? OTHER_WORKSPACE_ID : workspaceId,
    issuedAt: flags.has('--old') ? new Date(Date.now() - 10 * 60_000) : new Date(),
    test: flags.has('--test'),
  })
  if (flags.has('--foreign-callback')) job.callback.url = `https://example.com/api/automations/auto_test/runs/${job.run.id}`
  if (flags.has('--mismatched-callback')) job.callback.url = `${appUrl}/api/automations/auto_test/runs/run_other`

  const result = await postJob(target, job, {
    // Another key under the published key's id: the signature can't verify.
    ...(flags.has('--bad-signature') ? { key: TEST_STRAY_KEY, kid: TEST_KEY.kid } : {}),
    // A key the mock doesn't publish, under its own id.
    ...(flags.has('--unknown-kid') ? { key: TEST_STRAY_KEY } : {}),
  })
  console.log(`run ${job.run.id} → HTTP ${result.status} in ${result.ms} ms`, result.body)
}
