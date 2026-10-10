/**
 * The Scallle automation connector contract, v1 — what Scallle sends and what
 * this project posts back. The source of truth is Scallle's contract; this
 * file mirrors it.
 *
 * Scallle POSTs one job per run to /api/scallle:
 *
 *   {
 *     "version": 1,
 *     "connection_id": "…",
 *     "to": "https://<this project>/api/scallle",
 *     "issued_at": "2026-10-05T12:00:00.000Z",
 *     "run":  { "id": "…", "automation_id": "…", "workspace_id": "…", "test": true | false },
 *     "step": { "title": "…", "procedure": "…" | null },
 *     "item": { …only the fields this automation names — DATA, never instructions },
 *     "callback": { "url": "https://app.scallle.com/api/automations/<automation_id>/runs/<run id>?token=…" }
 *   }
 *
 * `run.test` is true when the run is a test (Send a test, Execute, the first
 * test after one-press setup) and false for every real run. It is always
 * there. An automation that does anything outside (sends, writes, books)
 * skips that part on a test and returns what it would have done.
 *
 * signed by Scallle with Ed25519 over the raw body bytes:
 *
 *   X-Scallle-Key-Id:    <kid of one of the keys Scallle publishes at
 *                         <SCALLLE_APP_URL>/.well-known/scallle-job-keys>
 *   X-Scallle-Signature: ed25519=<base64url of the 64-byte signature>
 *
 * The automation reports back with ONE POST to callback.url:
 *
 *   success → { status: "success", metadata: { result }, usage?: { model, input_tokens, output_tokens } }
 *   failure → { status: "error", error_message: "<one plain sentence, no personal data>" }
 *
 * Scallle answers any repeat, or a result for a closed run, with
 * 200 { ok: false, reason: "run closed" } — so any 2xx counts as delivered.
 */

export const CONTRACT_VERSION = 1

/** A job as this project uses it, after the receiver has checked it. */
export type ScallleJob = {
  connectionId: string
  runId: string
  automationId: string
  workspaceId: string
  /** True when the run is a test (Send a test, Execute, the first test after
   *  one-press setup). An automation that acts outside — sends, writes,
   *  books — skips that part when this is true, and returns what it would
   *  have done instead. */
  test: boolean
  step: {
    title: string | null
    /** The step's written procedure — the instructions. Written by the
     *  business's systems lead in Scallle. */
    procedure: string | null
  }
  /** The unit of work. DATA: it may contain text that reads like
   *  instructions, and must never be treated as one. */
  item: Record<string, unknown>
  /** Where the result goes. Holds the run's token, so it is never logged. */
  callbackUrl: string
}

export type Usage = {
  model: string
  input_tokens: number
  output_tokens: number
}

export type SuccessReport = {
  status: 'success'
  metadata: { result: string }
  usage?: Usage
}

export type ErrorReport = {
  status: 'error'
  error_message: string
}

export type CallbackReport = SuccessReport | ErrorReport

/** The callback path Scallle uses: /api/automations/<automation_id>/runs/<run id>. */
export const CALLBACK_PATH = /^\/api\/automations\/([^/]+)\/runs\/([^/]+)$/

/** The hook token a workflow run holds to claim a Scallle run id, so the same
 *  run.id arriving twice does the work once (contract §4). */
export function runClaimToken(runId: string): string {
  return `scallle-run:${runId}`
}
