import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { MemosAddRequest, MemosSearchData, MemosSearchRequest } from '@memtensor/memos-cloud-plugin-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inject, installMemosLifecycle, type MemosLifecycleController } from '../src/index.ts'

interface Projection {
  stateOf(session: Session, key: string): unknown
}

const projectionOf = (value: unknown): Projection => ({
  stateOf: (_session, key) => key === 'agentPreset' ? value : undefined,
})

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

const mount = async (options: {
  projection?: Projection
  agentId?: string
  multiAgentMode?: boolean
} = {}) => {
  const root = new Context()
  root.provide('agents', {})
  root.provide('sessions', {})
  const projection = options.projection
  const provider = projection === undefined ? undefined : await root.plugin({
    name: 'fixture-preset-projections',
    apply(ctx: Context) { ctx.provide('sessionProjections', projection) },
  })
  const search = vi.fn(async (_request: MemosSearchRequest, _signal?: AbortSignal): Promise<MemosSearchData> => ({
    memory_detail_list: [],
  }))
  const add = vi.fn(async (_request: MemosAddRequest, _signal?: AbortSignal) => ({ success: true }))
  let controller: MemosLifecycleController | undefined
  const consumer = await root.plugin({
    name: 'fixture-memos-preset-consumer',
    // Match the actual plugin mount: sessionProjections is optional and is not
    // declared in inject. Direct ctx.sessionProjections access fails here.
    inject,
    apply(ctx: Context) {
      controller = installMemosLifecycle(ctx, {
        multiAgentMode: options.multiAgentMode ?? true,
        ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
      }, { clientFactory: () => ({ search, add }) })
    },
  })
  cleanups.push(async () => {
    await controller?.dispose()
    await consumer.dispose()
    await provider?.dispose()
  })
  if (controller === undefined) throw new Error('MemOS consumer did not activate')
  return { root, controller, search, add }
}

const createSession = (preset?: string): Session => {
  const id = SessionId('preset-isolation')
  return Session.create(id, undefined, {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1000,
    isSeeded: false,
    ...(preset === undefined ? {} : { agentPreset: preset }),
  })
}

const completeTurn = async (
  harness: Awaited<ReturnType<typeof mount>>,
  session: Session,
  turn = 1,
) => {
  const message = createUserMessage({
    source: { kind: 'user' }, content: [{ type: 'text', text: 'remember this' }],
  })
  await harness.root.waterfall('agent/pre-step', {
    agent: { id: session.id, session, options: {} } as unknown as Agent,
    messages: [message], turn, step: 1, signal: new AbortController().signal,
  }, async () => ({ kind: 'enter' as const, messages: [message] }))
  session.append('turn/start', { turn })
  session.append('user/message', message, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn, step: 1,
    message: createAssistantMessage({
      source: { provider: 'fixture', model: 'model' },
      content: [{ type: 'text', text: 'answer' }],
    }),
  }, { surfaceOp: 'append' })
  const end = session.append('turn/end', { turn, reason: { kind: 'completed' } })
  harness.root.emit('session/event', session, end)
  await harness.controller.drain()
}

describe('preset memory isolation in a mounted plugin', () => {
  it('follows coding and standard switches in the same session for search and add', async () => {
    let current = 'coding'
    const harness = await mount({ projection: { stateOf: () => current } })
    const session = createSession('minimal')
    await completeTurn(harness, session)
    current = 'standard'
    await completeTurn(harness, session, 2)

    expect(session.header.agentPreset).toBe('minimal')
    expect(harness.search.mock.calls.map(([request]) => request.filter)).toEqual([
      { user: { agent_id: 'coding' } },
      { user: { agent_id: 'standard' } },
    ])
    expect(harness.add.mock.calls.map(([request]) => request.agent_id)).toEqual(['coding', 'standard'])
    expect(harness.add.mock.calls.map(([request]) => request.info?.dsh_agent_preset)).toEqual(['coding', 'standard'])
  })

  it.each([
    { name: 'no projection service', projection: undefined, expected: 'minimal' },
    { name: 'an unregistered projection', projection: projectionOf(undefined), expected: 'minimal' },
    {
      name: 'a failing projection',
      projection: { stateOf() { throw new Error('projection unavailable') } },
      expected: 'minimal',
    },
    { name: 'an explicitly cleared preset', projection: projectionOf(null), expected: 'fallback' },
  ])('uses the same fallback for search and add with $name', async ({ projection, expected }) => {
    const harness = await mount({ ...(projection === undefined ? {} : { projection }), agentId: 'fallback' })
    await completeTurn(harness, createSession('minimal'))
    expect(harness.search).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      filter: { user: { agent_id: expected } },
    }), expect.any(AbortSignal))
    expect(harness.add).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ agent_id: expected }), expect.any(AbortSignal))
  })

  it.each([
    { name: 'a cleared preset', projection: projectionOf(null), header: 'minimal' },
    { name: 'a session without a preset', projection: undefined, header: undefined },
  ])('omits agent_id when $name has no configured fallback', async ({ projection, header }) => {
    const harness = await mount(projection === undefined ? {} : { projection })
    await completeTurn(harness, createSession(header))
    expect(harness.search).toHaveBeenCalledOnce()
    expect(harness.search.mock.calls[0]?.[0].filter).toBeUndefined()
    expect(harness.add).toHaveBeenCalledOnce()
    expect(harness.add.mock.calls[0]?.[0]).not.toHaveProperty('agent_id')
    expect(harness.add.mock.calls[0]?.[0].info).not.toHaveProperty('dsh_agent_preset')
  })

  it('keeps the configured agent_id when multiAgentMode is disabled', async () => {
    const harness = await mount({ projection: projectionOf('coding'), agentId: 'fixed', multiAgentMode: false })
    await completeTurn(harness, createSession('minimal'))
    expect(harness.search).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      filter: { user: { agent_id: 'fixed' } },
    }), expect.any(AbortSignal))
    expect(harness.add).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      agent_id: 'fixed', info: expect.objectContaining({ dsh_agent_preset: 'coding' }),
    }), expect.any(AbortSignal))
  })
})
