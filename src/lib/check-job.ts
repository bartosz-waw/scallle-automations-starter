import type { Config } from './config'
import { CALLBACK_PATH, CONTRACT_VERSION, type ScallleJob } from './contract'

/**
 * The checks a signed job must pass before any work starts. The signature has
 * already been verified by then (route.ts), so everything here is about the
 * job being meant for THIS deployment, now:
 *
 *   - it speaks contract version 1, and says whether the run is a test,
 *   - it was issued within 5 minutes of now (a captured job can't be replayed later),
 *   - it belongs to the one business this deployment serves (403 otherwise).
 *     Scallle signs every business's jobs with the same key, so this is the
 *     wall between businesses,
 *   - it is addressed to this project: `to` names this request's host and
 *     /api/scallle (400 otherwise — a 403 would read as "another business"),
 *     so a job captured on its way to one of the business's projects can't
 *     be replayed at another,
 *   - its callback is on Scallle's own origin and names this same automation
 *     and run — so a result can never be posted anywhere else.
 *
 * Fields the contract doesn't name are ignored: the contract only grows.
 */

/** The path every job is addressed to. */
export const RECEIVER_PATH = '/api/scallle'

export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000

export type JobCheck =
  | { ok: true; job: ScallleJob }
  | { ok: false; status: 400 | 401 | 403; error: string }

function refuse(status: 400 | 401 | 403, error: string): JobCheck {
  return { ok: false, status, error }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * @param requestHost this request's own host (the `host` header, or the
 *   request URL's host) — never X-Forwarded-Host, which a caller can set.
 */
export function checkJob(
  body: unknown,
  config: Config,
  requestHost: string,
  now: number = Date.now()
): JobCheck {
  const job = record(body)
  if (!job) return refuse(400, 'The job is not a JSON object.')

  if (job.version !== CONTRACT_VERSION) {
    return refuse(400, `This project speaks contract version ${CONTRACT_VERSION} only.`)
  }

  const issuedAt = Date.parse(typeof job.issued_at === 'string' ? job.issued_at : '')
  if (Number.isNaN(issuedAt)) return refuse(400, 'The job has no valid issued_at time.')
  if (Math.abs(now - issuedAt) > MAX_CLOCK_SKEW_MS) {
    return refuse(401, 'The job was issued more than 5 minutes from now, so it was refused.')
  }

  const run = record(job.run)
  const runId = text(run?.id)
  const automationId = text(run?.automation_id)
  const workspaceId = text(run?.workspace_id)
  const connectionId = text(job.connection_id)
  if (!runId || !automationId || !workspaceId || !connectionId) {
    return refuse(400, "The job doesn't say which connection, run, automation and business it is for.")
  }
  // Always there (contract §1): an automation that acts outside reads it to
  // skip that part on a test, so a job that doesn't say is refused rather
  // than taken as a real run.
  const isTest = run?.test
  if (typeof isTest !== 'boolean') {
    return refuse(400, 'The job doesn’t say whether the run is a test.')
  }

  if (workspaceId !== config.workspaceId) {
    return refuse(403, 'This job belongs to another business, so it was refused.')
  }

  const to = text(job.to)
  if (!to) return refuse(400, "The job doesn't say which project it is for.")
  let toUrl: URL
  try {
    toUrl = new URL(to)
  } catch {
    return refuse(400, "The job's address is not a valid web address.")
  }
  // The scheme isn't compared: the platform in front may change it.
  if (toUrl.host.toLowerCase() !== requestHost.trim().toLowerCase() || toUrl.pathname !== RECEIVER_PATH) {
    return refuse(400, 'This job is addressed to another project, so it was refused.')
  }

  const callbackUrl = text(record(job.callback)?.url)
  if (!callbackUrl) return refuse(400, 'The job has no callback address.')
  let url: URL
  try {
    url = new URL(callbackUrl)
  } catch {
    return refuse(400, 'The callback address is not a valid web address.')
  }
  const path = CALLBACK_PATH.exec(url.pathname)
  if (url.origin !== config.appOrigin || url.username || url.password || !path) {
    return refuse(400, "The callback address isn't on Scallle, so the job was refused.")
  }
  let pathAutomation: string
  let pathRun: string
  try {
    pathAutomation = decodeURIComponent(path[1])
    pathRun = decodeURIComponent(path[2])
  } catch {
    return refuse(400, 'The callback address is not a valid web address.')
  }
  if (pathAutomation !== automationId || pathRun !== runId) {
    return refuse(400, "The callback address names a different automation or run, so the job was refused.")
  }

  const step = record(job.step)
  return {
    ok: true,
    job: {
      connectionId,
      runId,
      automationId,
      workspaceId,
      test: isTest,
      step: {
        title: text(step?.title),
        procedure: text(step?.procedure),
      },
      item: record(job.item) ?? {},
      callbackUrl,
    },
  }
}
