import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { checkJob } from '../src/lib/check-job'
import { forgetScallleKeys, KEYS_PATH, parseKeyDocument } from '../src/lib/scallle-keys'
import { readSignatureHeaders, verifySignature } from '../src/lib/signature'
// @ts-expect-error — a plain .mjs test helper without types
import { signatureHeaders, TEST_STRAY_KEY } from '../scripts/test-signing-key.mjs'

/**
 * A job signed by SCALLLE'S OWN SENDER is accepted by this kit.
 *
 * tests/fixtures/app-signed-job.json is made by scallle-app's real signer
 * (src/lib/automation-send.ts, pinned there by tests/lib/automation-send-
 * contract.test.ts) and copied here unchanged. Test values only: a fixed
 * TEST ONLY Ed25519 key, a made-up n8n secret, business and run.
 *
 *   · the code project: Scallle's Ed25519 signature over the exact bytes,
 *     checked with the key the fixture's published key document (jwks) names
 *     by its kid; then the receiver itself, end to end, with the key fetch
 *     answered from that document and the request sent to the fixture's `to`
 *     (202), and the same job refused unsigned or with one byte changed (401),
 *     at a project for another business (403) or at another project (400);
 *   · the n8n template: what its Webhook node's JWT Auth does with a passphrase
 *     — n8n's own jsonwebtoken, `verify(token, secret, { algorithms: ['HS256'] })`
 *     (n8n-nodes-base Webhook/utils.js) — then the template's "Check the job"
 *     rules: iss, the 5-minute lifetime, the body's hash, aud = the connection,
 *     sub = the run.
 */

type Fixture = {
  secret: string
  workspace_id: string
  app_origin: string
  to: string
  now_ms: number
  kid: string
  jwks: { keys: Array<Record<string, unknown>> }
  body: string
  headers: { authorization: string; 'x-scallle-key-id': string; 'x-scallle-signature': string }
}

const job = JSON.parse(readFileSync(path.join(__dirname, 'fixtures/app-signed-job.json'), 'utf8')) as Fixture
const config = { workspaceId: job.workspace_id, appOrigin: job.app_origin }
const host = new URL(job.to).host
const signed = readSignatureHeaders(job.headers['x-scallle-key-id'], job.headers['x-scallle-signature'])
const published = parseKeyDocument(job.jwks)

const start = vi.fn()
vi.mock('workflow/api', () => ({
  start: (...args: unknown[]) => start(...args),
  getHookByToken: async () => {
    const { HookNotFoundError } = await import('workflow/errors')
    throw new HookNotFoundError('not seen')
  },
}))

describe('the code project accepts a job from Scallle’s real signer', () => {
  it('the headers are well formed and name a key the document publishes', () => {
    expect(signed?.kid).toBe(job.kid)
    expect(published?.has(job.kid)).toBe(true)
  })

  it('the signature verifies over the exact bytes', () => {
    expect(verifySignature(Buffer.from(job.body, 'utf8'), signed!.signature, published!.get(job.kid)!)).toBe(true)
  })

  it('…and not over changed bytes', () => {
    const changed = Buffer.from(job.body.replace('Sam', 'Sal'), 'utf8')
    expect(verifySignature(changed, signed!.signature, published!.get(job.kid)!)).toBe(false)
  })

  it('checkJob accepts it as sent, at its own address', () => {
    const r = checkJob(JSON.parse(job.body), config, host, job.now_ms)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.job.workspaceId).toBe(job.workspace_id)
    expect(r.job.test).toBe(true) // the fixture's run is a test (Send a test)
    expect(r.job.step.procedure).toMatch(/warm reply/)
    expect(r.job.item).toEqual({
      customer_name: 'Sam Carter',
      enquiry: 'A garden room at the back of the house — a price, please.',
    })
  })

  it('checkJob refuses it more than 5 minutes later, for another business, or at another project', () => {
    expect(checkJob(JSON.parse(job.body), config, host, job.now_ms + 6 * 60 * 1000).ok).toBe(false)
    const another = { ...config, workspaceId: '22222222-2222-4222-8222-222222222222' }
    expect(checkJob(JSON.parse(job.body), another, host, job.now_ms)).toMatchObject({ ok: false, status: 403 })
    expect(checkJob(JSON.parse(job.body), config, 'another-project.example', job.now_ms)).toMatchObject({ ok: false, status: 400 })
  })

  describe('the receiver, end to end', () => {
    const keyFetches: string[] = []
    let POST: (request: Request) => Promise<Response>

    beforeAll(async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(job.now_ms)
      vi.stubEnv('SCALLLE_WORKSPACE_ID', job.workspace_id)
      vi.stubEnv('SCALLLE_APP_URL', job.app_origin)
      vi.stubEnv('ANTHROPIC_API_KEY', '')
      vi.stubEnv('ANTHROPIC_BASE_URL', '')
      vi.stubEnv('VERCEL', '')
      vi.stubGlobal('fetch', async (url: string) => {
        keyFetches.push(url)
        return Response.json(job.jwks)
      })
      vi.spyOn(console, 'info').mockImplementation(() => {})
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      forgetScallleKeys()
      start.mockResolvedValue({ runId: 'wrun_fixture' })
      POST = (await import('../src/app/api/scallle/route')).POST
    })

    afterAll(() => {
      vi.useRealTimers()
      vi.unstubAllEnvs()
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    })

    const asSigned = {
      'x-scallle-key-id': job.headers['x-scallle-key-id'],
      'x-scallle-signature': job.headers['x-scallle-signature'],
    }

    const post = (headers: Record<string, string>, body: BodyInit = job.body, at: string = host) =>
      POST(
        new Request(`https://${at}/api/scallle`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', host: at, ...headers },
          body,
        })
      )

    async function refusal(res: Response): Promise<string> {
      const answer = (await res.json()) as { accepted: boolean; error: string }
      expect(answer.accepted).toBe(false)
      return answer.error
    }

    it('refuses it unsigned (401) without fetching anything', async () => {
      const res = await post({})
      expect(res.status).toBe(401)
      expect(await refusal(res)).toBe('This job isn’t signed by Scallle.')
      expect(keyFetches).toEqual([])
      expect(start).not.toHaveBeenCalled()
    })

    it('refuses it with one byte of the body changed (401)', async () => {
      const bytes = Buffer.from(job.body, 'utf8')
      const at = bytes.indexOf('Sam Carter')
      expect(at).toBeGreaterThan(0)
      bytes[at] ^= 0x01 // 'S' → 'R': still valid JSON, no longer what Scallle signed
      const res = await post(asSigned, new Uint8Array(bytes))
      expect(res.status).toBe(401)
      expect(await refusal(res)).toBe('This job isn’t signed by Scallle.')
      expect(start).not.toHaveBeenCalled()
    })

    it('refuses it at a project that serves another business (403)', async () => {
      vi.stubEnv('SCALLLE_WORKSPACE_ID', '22222222-2222-4222-8222-222222222222')
      try {
        const res = await post(asSigned)
        expect(res.status).toBe(403)
        expect(await refusal(res)).toBe('This job belongs to another business, so it was refused.')
      } finally {
        vi.stubEnv('SCALLLE_WORKSPACE_ID', job.workspace_id)
      }
      expect(start).not.toHaveBeenCalled()
    })

    it('refuses it at another project of the same business — `to` names another host (400)', async () => {
      const res = await post(asSigned, job.body, 'another-project.example')
      expect(res.status).toBe(400)
      expect(await refusal(res)).toBe('This job is addressed to another project, so it was refused.')
      expect(start).not.toHaveBeenCalled()
    })

    it('answers 202 and starts the work, having fetched Scallle’s keys from SCALLLE_APP_URL only', async () => {
      const res = await post(asSigned)
      expect(res.status).toBe(202)
      expect(await res.json()).toEqual({ accepted: true })
      expect(start).toHaveBeenCalledTimes(1)
      expect(start.mock.calls[0]![1]).toMatchObject([
        { runId: JSON.parse(job.body).run.id, workspaceId: job.workspace_id, test: true },
      ])
      expect(keyFetches).toEqual([`${job.app_origin}${KEYS_PATH}`])
    })

    it('refuses the same bytes signed by a key Scallle doesn’t publish (401)', async () => {
      const res = await post(
        Object.fromEntries(
          Object.entries(signatureHeaders(job.body, TEST_STRAY_KEY) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])
        )
      )
      expect(res.status).toBe(401)
    })
  })
})

/** n8n's own jsonwebtoken, from the local n8n runtime (n8n/test/setup.sh), or
 *  wherever N8N_JSONWEBTOKEN points. */
function n8nJsonwebtoken(): null | {
  verify: (token: string, secret: string, opts: Record<string, unknown>) => Record<string, unknown>
} {
  const candidates = [
    process.env.N8N_JSONWEBTOKEN,
    path.join(__dirname, '../n8n/test/.runtime/node_modules/jsonwebtoken'),
  ].filter((p): p is string => !!p)
  for (const p of candidates) {
    if (existsSync(p)) return createRequire(__filename)(p)
  }
  return null
}
const jwt = n8nJsonwebtoken()

describe('the n8n template accepts a job from Scallle’s real signer', () => {
  const token = job.headers.authorization.split(' ')[1]!
  const body = JSON.parse(job.body) as { connection_id: string; run: { id: string } }

  it.skipIf(!jwt)('the Webhook node’s JWT Auth (n8n’s own jsonwebtoken, passphrase, HS256) verifies it', () => {
    const payload = jwt!.verify(token, job.secret, { algorithms: ['HS256'], clockTimestamp: job.now_ms / 1000 })
    expect(payload.sub).toBe(body.run.id)
    expect(() => jwt!.verify(token, 'another-secret', { algorithms: ['HS256'], clockTimestamp: job.now_ms / 1000 })).toThrow()
    expect(() => jwt!.verify(token, job.secret, { algorithms: ['HS256'], clockTimestamp: job.now_ms / 1000 + 301 })).toThrow(/expired/)
  })

  it('the template’s “Check the job” rules pass', () => {
    const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, number | string>
    expect(claims.iss).toBe('scallle')
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(300)
    expect(Math.abs(job.now_ms / 1000 - (claims.iat as number))).toBeLessThanOrEqual(300)
    expect(String(claims.body_sha256).toLowerCase()).toBe(createHash('sha256').update(job.body, 'utf8').digest('hex'))
    expect(claims.aud).toBe(body.connection_id)
    expect(claims.sub).toBe(body.run.id)
    expect(/^[A-Za-z0-9_-]+$/.test(body.run.id)).toBe(true)
  })
})
