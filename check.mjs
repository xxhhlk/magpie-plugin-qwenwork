// Integration check of the QwenWork provider, with a fake account and upstream.
// Covered:
// - Defaults and configuration validation fail before any request.
// - Device login, model listing and refresh target the configured hosts.
// - Chat is rewritten as QwenWork's agent_chat_generation request: the host's
//   tools ride along, and tool calls come back structured — both the native
//   delta.tool_calls kind and the inline <tool_call> text kind.
// - A lapsed sign-in fails before another chat request.
// - Client-facing errors carry no token-shaped text.
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { QwenWorkAuthPlugin } from './index.mjs'
import { _internal } from './vendor/qoder.mjs'

const names = ['CLIENT_ID', 'WEB', 'OPENAPI', 'API', 'RSA_PUBLIC_KEY', 'COSY_VERSION']
const savedEnv = Object.fromEntries(names.map(k => [k, process.env['QWENWORK_' + k]]))
const originalFetch = globalThis.fetch
const checks = []
let requests = 0
// the agent_chat requests the mock saw, decoded
let agentChats = []
try {
  for (const k of names) delete process.env['QWENWORK_' + k]
  globalThis.fetch = () => { requests++; throw new Error('Unexpected network request') }
  const defaults = await QwenWorkAuthPlugin({ client: {} })
  const defaultLogin = new URL((await defaults.auth.methods[0].authorize()).url)
  assert.equal(defaultLogin.origin, 'https://gateway.qwenwork.cn')
  assert.equal(defaultLogin.searchParams.get('client_id'), 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb')
  assert.equal(defaultLogin.searchParams.get('redirect_uri'), 'qwenwork-cn://')
  assert.equal(requests, 0)
  checks.push('Verified desktop defaults produce login URL without network access')

  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 })
  const values = {
    CLIENT_ID: 'integration-fixture-client', WEB: 'https://web.example.invalid',
    OPENAPI: 'https://account.example.invalid', API: 'https://model.example.invalid',
    RSA_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }), COSY_VERSION: 'fixture-version',
  }
  for (const [k, v] of Object.entries(values)) process.env['QWENWORK_' + k] = v
  for (const bad of ['http://web.example.invalid', 'https://user:pass@web.example.invalid', 'https://web.example.invalid/path', 'https://web.example.invalid?x=1']) {
    process.env.QWENWORK_WEB = bad
    await assert.rejects(QwenWorkAuthPlugin({ client: {} }), /QWENWORK_WEB/)
  }
  process.env.QWENWORK_WEB = values.WEB
  process.env.QWENWORK_RSA_PUBLIC_KEY = 'invalid'
  await assert.rejects(QwenWorkAuthPlugin({ client: {} }), /QWENWORK_RSA_PUBLIC_KEY/)
  process.env.QWENWORK_RSA_PUBLIC_KEY = values.RSA_PUBLIC_KEY
  checks.push('Endpoint and RSA key validation reject invalid inputs')

  let auth
  let rejectRefresh = false
  // how the mock's agent_chat answers: a list of SSE bodies, one per call
  const agentReplies = []
  const sse = (delta, finish = null) => `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify({ choices: [{ delta, finish_reason: finish }] }) })}\n\n`
  globalThis.fetch = async (input, init = {}) => {
    requests++
    const url = new URL(input)
    if (url.hostname === 'account.example.invalid') {
      const body = init.body ? JSON.parse(init.body) : undefined
      switch (url.pathname) {
        case '/api/v1/deviceToken/poll':
          assert.ok(url.searchParams.get('verifier'))
          return Response.json({ token: 'fake-device', refresh_token: 'fake-device-refresh', user_id: 'fixture-user', expires_in: 3600 })
        case '/api/v1/adapter/user/account-context':
          return Response.json({ data: {
            user: { id: 'fixture-user', name: 'Fixture', email: '' },
            plan: { name: 'Fixture Plan', next_refresh_date: '2026-11-01T00:00:00Z' },
            quota: { total: 2000, used: 17.8348, remaining: 1982.1652, exceeded: false },
          } })
        case '/api/v1/deviceToken/refresh':
          assert.equal(body.target, 'c')
          if (rejectRefresh) return Response.json({ error: 'expired' }, { status: 401 })
          assert.equal(body.refresh_token, 'fake-device-refresh')
          return Response.json({ token: 'fake-device-next', refresh_token: 'fake-device-refresh-next', expires_in: 3600 })
        default: throw new Error('Unexpected account path: ' + url.pathname)
      }
    }
    assert.equal(url.hostname, 'model.example.invalid')
    assert.match(init.headers.Authorization, /^Bearer COSY\./)
    assert.equal(init.headers['Cosy-Version'], values.COSY_VERSION)
    assert.equal(init.headers['Cosy-ClientType'], '6')
    assert.equal(init.headers['Cosy-Business-Product'], 'qoder_work')
    const payload = JSON.parse(Buffer.from(init.headers.Authorization.split('.')[1], 'base64'))
    assert.equal(payload.cosyVersion, values.COSY_VERSION)
    if (url.pathname === '/algo/api/v2/model/list') {
      return Response.json({ chat: [], qwork: [{ key: 'fixture-model', enable: false, display_name: 'Fixture model', max_input_tokens: 200000 }] })
    }
    if (url.pathname === '/algo/api/v2/service/pro/sse/agent_chat_generation') {
      agentChats.push(JSON.parse(_internal.decodeBody(init.body)))
      const reply = agentReplies.shift()
      if (reply instanceof Response) return reply
      if (typeof reply === 'string') return new Response(reply, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      return new Response([sse({ role: 'assistant', content: 'hello fixture reply' }), sse({}, 'stop'), 'data: {"body":"[DONE]"}\n\n'].join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }
    throw new Error('Unexpected model path: ' + url.pathname)
  }
  const plugin = await QwenWorkAuthPlugin({ client: { auth: { set: async ({ path, body }) => { assert.equal(path.id, 'qwenwork'); auth = body } } } })
  const config = {}
  await plugin.config(config)
  assert.deepEqual(Object.keys(config.provider), ['qwenwork'])
  assert.deepEqual(config.provider.qwenwork.models, {})
  assert.equal(plugin.auth.provider, 'qwenwork')
  assert.equal(typeof plugin.auth.usage, 'function', 'the provider reports usage')
  assert.match(plugin.auth.icon, /^data:image\/png;base64,/, 'the provider carries its own icon')
  assert.equal(plugin.auth.methods.length, 1)
  const login = await plugin.auth.methods[0].authorize()
  const loginURL = new URL(login.url)
  assert.equal(loginURL.origin, values.WEB)
  assert.equal(loginURL.searchParams.get('client_id'), values.CLIENT_ID)
  auth = { ...(await login.callback()), type: 'oauth' }
  assert.equal(auth.accountId, 'Fixture')
  checks.push('QwenWork registration and device login use configured identity')

  const catalog = await plugin.provider.models({ models: {} }, { auth })
  assert.equal(catalog['fixture-model'].providerID, 'qwenwork')
  assert.equal(catalog['fixture-model'].capabilities.toolcall, true)

  const usage = await plugin.auth.usage(async () => auth)
  assert.equal(usage.signIn, 'kept')
  assert.equal(usage.plan, 'Fixture Plan')
  assert.equal(usage.until, '2026-11-01T00:00:00.000Z')
  assert.deepEqual(usage.windows, [{ name: 'Credits', used: (100 * 17.8348) / 2000, display: '17.83 / 2000 credits' }])
  const usageGone = await plugin.auth.usage(async () => ({ ...auth, expires: Date.now() - 1 }))
  assert.equal(usageGone.signIn, 'expired')
  checks.push('Usage reports the account\'s credits and plan')

  const loader = await plugin.auth.loader(async () => auth)
  const chat = (over = {}) => ({ model: 'fixture-model', messages: [{ role: 'user', content: 'fixture prompt' }], ...over })

  // A plain prompt: the host's system message rides along, the provider's own
  // words sit above it, and the answer comes back as one completion.
  const plain = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat({ messages: [{ role: 'system', content: 'host rules' }, { role: 'user', content: 'fixture prompt' }] })) })
  assert.equal(plain.status, 200)
  const plainBody = await plain.json()
  assert.equal(plainBody.choices[0].message.content, 'hello fixture reply')
  assert.equal(plainBody.choices[0].finish_reason, 'stop')
  assert.equal(agentChats[0].model_config.key, 'fixture-model')
  assert.match(agentChats[0].system[0].text, /^You are QwenWork/)
  assert.match(agentChats[0].system[0].text, /host rules/)
  checks.push('Chat is rewritten as QwenWork\'s agent request with the host\'s system message')

  // The host's tools ride along; a native tool_calls answer comes back structured.
  const tools = [{ type: 'function', function: { name: 'lookup', description: 'find it', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }]
  agentReplies.push([
    sse({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] }),
    sse({}, 'tool_calls'),
    'data: {"body":"[DONE]"}\n\n',
  ].join(''))
  const called = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat({ tools, tool_choice: 'auto' })) })
  assert.equal(called.status, 200)
  const calledBody = await called.json()
  assert.deepEqual(calledBody.choices[0].message.tool_calls, [{ id: 'call_fixture', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }])
  assert.equal(calledBody.choices[0].finish_reason, 'tool_calls')
  assert.deepEqual(agentChats[1].tools, [{ type: 'function', function: { name: 'lookup', description: 'find it', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }])
  checks.push('The host\'s tools ride along and a tool call comes back structured')

  // A model that emits its call as inline <tool_call> text has it lifted out,
  // and no markup reaches the caller: the leak this replaces never shows.
  agentReplies.push([
    sse({ role: 'assistant', content: 'Let me look.<tool_call>{"name":"read","arguments":{"path":"/tmp/x"}}</tool_call>' }),
    sse({}, 'tool_calls'),
    'data: {"body":"[DONE]"}\n\n',
  ].join(''))
  const inline = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat({ tools })) })
  assert.equal(inline.status, 200)
  const inlineBody = await inline.json()
  assert.ok(!inlineBody.choices[0].message.content.includes('<tool_call>'), 'no markup in the text')
  assert.deepEqual(inlineBody.choices[0].message.tool_calls, [{ id: inlineBody.choices[0].message.tool_calls[0].id, type: 'function', function: { name: 'read', arguments: '{"path":"/tmp/x"}' } }])
  assert.equal(inlineBody.choices[0].finish_reason, 'tool_calls')
  checks.push('Inline <tool_call> text is lifted into structured tool calls')

  // A tool result turn maps back as Qoder's tool message.
  agentReplies.push([sse({ role: 'assistant', content: 'done' }), sse({}, 'stop'), 'data: {"body":"[DONE]"}\n\n'].join(''))
  const withResult = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat({ tools, messages: [
    { role: 'user', content: 'fixture prompt' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_fixture', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
    { role: 'tool', tool_call_id: 'call_fixture', content: 'the result' },
  ] })) })
  assert.equal(withResult.status, 200)
  assert.ok(agentChats[3].messages.some(m => m.role === 'tool' && m.tool_call_id === 'call_fixture' && m.content === 'the result'))
  checks.push('Tool results ride back as tool messages')
  // Streaming keeps the SSE shape magpie's client expects.
  const streamed = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat({ stream: true })) })
  assert.equal(streamed.status, 200)
  const streamText = await streamed.text()
  assert.match(streamText, /chat.completion.chunk/)
  assert.match(streamText, /data: \[DONE\]/)
  checks.push('Stream requests return one SSE completion')

  // A lapsed sign-in fails before another chat request.
  rejectRefresh = true
  auth = { ...auth, expires: Date.now() - 1 }
  const denied = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat()) })
  assert.equal(denied.status, 401)
  assert.equal(denied.headers.get('X-Magpie-Sign-In'), 'expired')
  checks.push('Invalid Magpie access token fails before another chat request')

  // An upstream failure carries no token-shaped text.
  rejectRefresh = false
  auth.expires = Date.now() + 3_600_000
  agentReplies.push(new Response(JSON.stringify({ message: 'boom: Authorization: Bearer COSY.abc.def and eyJhbGciOiJIUzI1NiJ9.payload.sig' }), { status: 500 }))
  const leaked = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat()) })
  const bodyText = await leaked.text()
  assert.equal(leaked.status, 500)
  assert.ok(!/Bearer\s+(?!\[redacted\])\S/.test(bodyText) && !bodyText.includes('COSY.') && !/ey[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+\./.test(bodyText), 'no bearer, COSY or jwt leaks in the client-facing error')
  checks.push('Client-facing errors carry no token-shaped text')

  // ---- stream integrity ------------------------------------------------------
  // A reply is whole only when the upstream said so. A stream that stops
  // without [DONE] or a finish_reason must not be reported as a normal stop:
  // the client would take half a tool_call's arguments for a whole one.

  // Stopped mid-frame: the last line has no newline after it.
  agentReplies.push([
    sse({ role: 'assistant', content: 'partial' }),
    'data: {"body":"{\\"choices\\":',
  ].join(''))
  const halfFrame = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat({ stream: true })) })
  const halfText = await halfFrame.text()
  assert.ok(!halfText.includes('[DONE]'), 'a stream that stopped mid-frame must not end with [DONE]')
  assert.match(halfText, /"error"/, 'a stream that stopped mid-frame ends with an error frame')
  assert.match(halfText, /mid-frame/, 'the error says why it ended')

  // The transport itself broke after some content had arrived.
  let sent = false
  agentReplies.push(new Response(new ReadableStream({
    pull(c) {
      if (!sent) {
        sent = true
        c.enqueue(new TextEncoder().encode(sse({ role: 'assistant', content: 'partial' })))
        return
      }
      c.error(new Error('simulated: connection reset'))
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
  const broke = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat({ stream: true })) })
  const brokeText = await broke.text()
  assert.ok(!brokeText.includes('[DONE]'), 'a broken transport must not end with [DONE]')
  assert.match(brokeText, /connection reset/, 'the cause is kept for the operator')
  checks.push('A truncated stream is an error frame, never a silent [DONE]')

  // Nothing at all came back: an empty answer is a failure, not an empty reply.
  agentReplies.push('')
  const empty = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat()) })
  assert.equal(empty.status, 502, 'an empty upstream is a 502, not a 200 with no content')
  checks.push('An upstream that ends without an answer is a 502')

  // A reply the upstream finished but left empty -- max_tokens cut off before
  // the first content token, which a reasoning model does readily -- is a valid
  // zero-content completion, not a failure: it carries a finish_reason and
  // [DONE], so it must reach the caller as a 200.
  agentReplies.push([
    sse({ role: 'assistant', content: '' }),
    sse({}, 'length'),
    'data: {"body":"[DONE]"}\n\n',
  ].join(''))
  const truncatedBudget = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat()) })
  assert.equal(truncatedBudget.status, 200, 'a finished-but-empty reply is a 200')
  const tbBody = await truncatedBudget.json()
  assert.equal(tbBody.choices[0].finish_reason, 'length', 'the length finish survives')
  checks.push('A finished empty reply is a 200, not a spurious 502')

  // Two tool calls interleaved (0, 1, 0, 1): each keeps its own slot, so the
  // second fragment of 0 lands on 0 and no call is opened twice.
  agentReplies.push([
    sse({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'lookup', arguments: '{"q":' } }] }),
    sse({ role: 'assistant', tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'read', arguments: '{"p":' } }] }),
    sse({ role: 'assistant', tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }),
    sse({ role: 'assistant', tool_calls: [{ index: 1, function: { arguments: '"b"}' } }] }),
    sse({}, 'tool_calls'),
    'data: {"body":"[DONE]"}\n\n',
  ].join(''))
  const parallel = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat({ tools })) })
  const parallelBody = await parallel.json()
  assert.deepEqual(
    parallelBody.choices[0].message.tool_calls.map(c => [c.id, c.function.name, c.function.arguments]),
    [['call_a', 'lookup', '{"q":"a"}'], ['call_b', 'read', '{"p":"b"}']],
    'interleaved calls keep their own identity and arguments',
  )
  checks.push('Interleaved tool calls are assembled per upstream index')

  // A model that is merely unavailable is not a lapsed sign-in: answering 401
  // would send the user to re-authorize for nothing.
  agentReplies.push(new Response(JSON.stringify({ code: 403, message: 'Model is not available for this user' }), { status: 403 }))
  const forbidden = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat()) })
  assert.equal(forbidden.status, 403, 'an unavailable model keeps its 403')
  assert.notEqual(forbidden.headers.get('X-Magpie-Sign-In'), 'expired', 'the account is still signed in')
  checks.push('A 403 that is not about the sign-in keeps its own status')

  // An exhausted quota is a 429 even when the gateway answers HTTP 200 with a
  // JSON body instead of a stream, so the gateway can move on to the next
  // account instead of failing the turn.
  agentReplies.push(Response.json({ code: 402, message: '积分不足，请充值' }))
  const outOfCredit = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat()) })
  assert.equal(outOfCredit.status, 429, 'an exhausted quota is a 429')
  assert.equal(outOfCredit.headers.get('retry-after'), '60')
  checks.push('An exhausted quota becomes a 429 for the next account')

  // An error raised after the stream started is redacted as well: that path
  // does not go through errorResponse and used to echo the upstream verbatim.
  agentReplies.push([
    sse({ role: 'assistant', content: 'started' }),
    `data: ${JSON.stringify({ statusCodeValue: 500, body: JSON.stringify({ message: 'boom: Authorization: Bearer COSY.abc.def' }) })}\n\n`,
  ].join(''))
  const midFail = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat({ stream: true })) })
  const midText = await midFail.text()
  assert.ok(!midText.includes('COSY.abc.def'), 'the mid-stream error frame is redacted')
  assert.ok(!midText.includes('[DONE]'), 'an error frame is not followed by [DONE]')
  checks.push('A mid-stream error is redacted and ends without [DONE]')

  // A request the agent abandons is a cancellation, not a truncated reply:
  // it must not be reported to the host as an upstream failure.
  const live = _internal.streamGuard(undefined, 10_000, 20_000)
  assert.equal(live.cancelled(), false, 'a stream nobody cancelled is not cancelled')
  live.done()
  const gone = _internal.streamGuard(AbortSignal.abort(new Error('caller went away')), 10_000, 20_000)
  assert.equal(gone.cancelled(), true, 'the caller\'s own abort is recognised')
  gone.done()
  checks.push('A cancelled request is not reported as a truncation')

  const dir = new URL('./', import.meta.url)
  const report = {
    status: 'passed', kind: 'mocked provider integration; no live QwenWork requests', checks,
    sourceSha256: createHash('sha256').update(await readFile(new URL('./vendor/qoder.mjs', dir))).digest('hex'),
    adapterSha256: createHash('sha256').update(await readFile(new URL('./index.mjs', dir))).digest('hex'),
  }
  await writeFile(new URL('./verification.json', dir), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  globalThis.fetch = originalFetch
  for (const k of names) {
    if (savedEnv[k] === undefined) delete process.env['QWENWORK_' + k]
    else process.env['QWENWORK_' + k] = savedEnv[k]
  }
}
