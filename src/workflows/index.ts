import type { ScallleJob } from '../lib/contract'
import { draftWithClaude } from './draft-with-claude'

/**
 * This business's automations, and which Scallle automation runs which.
 *
 * While BY_AUTOMATION_ID is empty, every job runs DEFAULT_WORKFLOW. Once it
 * lists any automation, only the listed ones run: a job for an automation not
 * listed is refused (400, naming its id) — so a new automation in Scallle
 * pointed at this project never runs the default draft by mistake. To add one:
 *
 *   1. Write it in this folder as a "use workflow" function that takes the
 *      job and wraps its work in runForScallle (copy draft-with-claude.ts).
 *   2. List it below under the Scallle automation's id (the id in the
 *      automation's address in Scallle; it arrives as run.automation_id).
 *      List every automation that should run here, including the ones that
 *      should keep the default draft (`'<id>': draftWithClaude`).
 *   3. Push. Every automation in Scallle can point at the same
 *      https://<this project>/api/scallle address.
 *
 * Never rename or move a workflow file while runs of it may be in progress:
 * its name and path are its identity in Vercel Workflows.
 */

export type ScallleWorkflow = (job: ScallleJob) => Promise<unknown>

/** Runs every job while BY_AUTOMATION_ID is empty. */
export const DEFAULT_WORKFLOW: ScallleWorkflow = draftWithClaude

export const BY_AUTOMATION_ID: Record<string, ScallleWorkflow> = {
  // '<scallle automation id>': summariseReferral,
}

/** The workflow for a Scallle automation, or null when BY_AUTOMATION_ID
 *  lists automations and this one isn't among them. */
export function workflowFor(automationId: string): ScallleWorkflow | null {
  if (Object.hasOwn(BY_AUTOMATION_ID, automationId)) return BY_AUTOMATION_ID[automationId]
  return Object.keys(BY_AUTOMATION_ID).length === 0 ? DEFAULT_WORKFLOW : null
}

/** What the receiver answers (400) for an automation workflowFor has no workflow for. */
export function noWorkflowFor(automationId: string): string {
  return (
    `This project has no workflow for automation ${automationId}. Add it to BY_AUTOMATION_ID in ` +
    'src/workflows/index.ts, or remove every entry to run the default draft for all.'
  )
}
