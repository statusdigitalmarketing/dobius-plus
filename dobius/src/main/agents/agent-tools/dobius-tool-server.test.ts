import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createDobiusToolHandlers } from './dobius-tool-handlers'

const mocks = vi.hoisted(() => ({
  appendDraft: vi.fn(),
  appendBriefingItem: vi.fn(),
  fetch: vi.fn(),
  getAsanaConfig: vi.fn()
}))

vi.stubGlobal('fetch', mocks.fetch)

vi.mock('../agent-draft-store', () => ({
  appendDraft: mocks.appendDraft
}))

vi.mock('../agent-briefing-store', () => ({
  appendBriefingItem: mocks.appendBriefingItem
}))

vi.mock('../../asana/asana-config', () => ({
  getAsanaConfig: mocks.getAsanaConfig
}))

vi.mock('../agents-store', () => ({
  listAgents: vi.fn(() => [
    {
      id: 'agent-1',
      name: 'Builder',
      description: 'Ships changes',
      model: 'claude-opus-4-8',
      heartbeat: { enabled: true },
      channels: { imessage: false },
      allowedTools: [],
      skills: [],
      cwd: '/secret/path',
      icon: 'bot',
      color: '#b9bcc2',
      systemPrompt: '',
      bypassPermissions: false,
      notify: 'digest + urgent',
      createdAt: 1,
      updatedAt: 1
    }
  ])
}))

vi.mock('../agent-runner', () => ({
  hasLiveAgentRun: vi.fn(() => false),
  listAgentRuns: vi.fn(() => [
    {
      id: 'run-1',
      agentId: 'agent-1',
      prompt: 'do work',
      startedAt: 2,
      status: 'success',
      summary: 'finished without token abc123'
    }
  ])
}))

vi.mock('../../ipc/knowledge-indexer', () => ({
  buildKnowledgeTree: vi.fn(() => ({
    hubLabel: 'Knowledge',
    hubSub: '',
    branches: [
      {
        id: 'projects',
        label: 'Projects',
        sub: '',
        groups: [],
        totalCount: 2,
        leaves: [
          {
            id: 'leaf-good',
            title: 'Runbook',
            summary: 'Deploy knowledge',
            filePath: '/repo/AGENTS.md',
            icon: 'book',
            addedAt: 1,
            links: []
          },
          {
            id: 'leaf-bad',
            title: 'Unsafe',
            summary: 'Outside root',
            filePath: '/tmp/private.md',
            icon: 'book',
            addedAt: 1,
            links: []
          }
        ]
      }
    ]
  })),
  isAllowedKnowledgePath: vi.fn((filePath: string) => filePath === '/repo/AGENTS.md'),
  safeReadFile: vi.fn((filePath: string) =>
    filePath === '/repo/AGENTS.md' ? 'Deploy by running the verified release checklist.' : null
  )
}))

const context = { agentId: 'agent-1', runId: 'run-1' }
const store = { getRepos: () => [{ path: '/repo' }] } as never

beforeEach(() => {
  mocks.appendDraft.mockReset()
  mocks.appendBriefingItem.mockReset()
  mocks.fetch.mockReset()
  mocks.getAsanaConfig.mockReset()
  mocks.appendDraft.mockReturnValue({ id: 'draft-1' })
  mocks.appendBriefingItem.mockReturnValue({ id: 'brief-1' })
  mocks.getAsanaConfig.mockReturnValue({
    autoMode: { enabled: true, intervalMinutes: 10, buildAgent: 'claude' }
  })
})

describe('Dobius tool handlers', () => {
  it('queues Asana comments as drafts without network calls', async () => {
    const handlers = createDobiusToolHandlers(context, store)
    const result = await handlers.asanaDraftComment({ gid: '120', body: 'Looks good' })
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('queued for human approval')
    expect(mocks.appendDraft).toHaveBeenCalledWith({
      agentId: 'agent-1',
      target: { kind: 'asana', gid: '120' },
      body: 'Looks good'
    })
    expect(mocks.appendBriefingItem).toHaveBeenCalledWith({
      agentId: 'agent-1',
      urgency: 'digest',
      summary: 'Draft Asana comment ready for 120'
    })
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('reads matching knowledge and blocks unsafe leaves through the allow gate', async () => {
    const handlers = createDobiusToolHandlers(context, store)
    const match = await handlers.readKnowledge({ query: 'deploy' })
    expect(match.content[0].text).toContain('Runbook')
    expect(match.content[0].text).toContain('verified release checklist')
    const unsafe = await handlers.readKnowledge({ query: '', leafId: 'leaf-bad' })
    expect(unsafe.isError).toBe(true)
    expect(unsafe.content[0].text).toContain('allowed knowledge path')
  })

  it('files briefing items through the existing store', async () => {
    const handlers = createDobiusToolHandlers(context, store)
    const result = await handlers.fileBriefingItem({ urgency: 'now', summary: 'Needs review' })
    expect(result.content[0].text).toContain('filed')
    expect(mocks.appendBriefingItem).toHaveBeenCalledWith({
      agentId: 'agent-1',
      urgency: 'now',
      summary: 'Needs review'
    })
  })

  it('dispatches build work by repo id and explicit branch name', async () => {
    const { setBuildDispatcher, setRepoLister } = await import('../agent-dispatch-registry')
    const dispatch = vi.fn(async () => ({ worktreeId: 'wt-1', ok: true }))
    setRepoLister(() => [
      { id: 'repo-1', name: 'DobiusPlus' },
      { id: 'repo-2', name: 'Other' }
    ])
    setBuildDispatcher(dispatch)

    const handlers = createDobiusToolHandlers(context, store)
    const result = await handlers.dispatchBuild({
      repo: 'repo-1',
      brief: 'Implement the build lane dispatch.',
      branchName: 'asana-build-lane'
    })

    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('wt-1')
    expect(dispatch).toHaveBeenCalledWith({
      repoId: 'repo-1',
      name: 'asana-build-lane',
      baseBranch: undefined,
      brief: 'Implement the build lane dispatch.',
      buildAgent: 'claude'
    })
    expect(mocks.appendBriefingItem).toHaveBeenCalledWith({
      agentId: 'agent-1',
      urgency: 'now',
      summary: 'Build dispatched: DobiusPlus / asana-build-lane'
    })
  })

  it('sanitizes a malicious branch name (no path traversal into the worktree name)', async () => {
    const { setBuildDispatcher, setRepoLister } = await import('../agent-dispatch-registry')
    const dispatch = vi.fn(async () => ({ worktreeId: 'wt-9', ok: true }))
    setRepoLister(() => [{ id: 'repo-1', name: 'DobiusPlus' }])
    setBuildDispatcher(dispatch)
    const handlers = createDobiusToolHandlers(context, store)
    await handlers.dispatchBuild({
      repo: 'repo-1',
      brief: 'do a thing',
      branchName: '../../evil; rm -rf /'
    })
    const passedName = (dispatch.mock.calls.at(0)?.at(0) as { name?: string } | undefined)?.name
    expect(passedName).toBeDefined()
    expect(passedName).not.toContain('/')
    expect(passedName).not.toContain('..')
    expect(passedName).toMatch(/^[a-z0-9-]+$/)
  })

  it('dispatches build work by case-insensitive repo name with a slugged name', async () => {
    const { setBuildDispatcher, setRepoLister } = await import('../agent-dispatch-registry')
    const dispatch = vi.fn(async () => ({ worktreeId: 'wt-2', ok: true }))
    setRepoLister(() => [{ id: 'repo-1', name: 'DobiusPlus' }])
    setBuildDispatcher(dispatch)

    const handlers = createDobiusToolHandlers(context, store)
    await handlers.dispatchBuild({
      repo: 'dobiusplus',
      brief: 'Fix flaky build dispatch from Asana lane quickly please'
    })

    expect(dispatch).toHaveBeenCalledWith({
      repoId: 'repo-1',
      name: 'fix-flaky-build-dispatch-from-asana',
      baseBranch: undefined,
      brief: 'Fix flaky build dispatch from Asana lane quickly please',
      buildAgent: 'claude'
    })
  })

  it('returns an error with available repos when dispatch repo cannot be resolved', async () => {
    const { setBuildDispatcher, setRepoLister } = await import('../agent-dispatch-registry')
    const dispatch = vi.fn(async () => ({ worktreeId: 'wt-3', ok: true }))
    setRepoLister(() => [{ id: 'repo-1', name: 'DobiusPlus' }])
    setBuildDispatcher(dispatch)

    const handlers = createDobiusToolHandlers(context, store)
    const result = await handlers.dispatchBuild({ repo: 'Unknown', brief: 'Do the work' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('DobiusPlus')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('lists crew without leaking cwd paths', async () => {
    const handlers = createDobiusToolHandlers(context, store)
    const result = await handlers.listCrew()
    expect(result.content[0].text).toContain('Builder')
    expect(result.content[0].text).toContain('heartbeat:on')
    expect(result.content[0].text).not.toContain('/secret/path')
  })

  it('returns compact crew status without leaking token-like summaries', async () => {
    const handlers = createDobiusToolHandlers(context, store)
    const result = await handlers.crewStatus()
    expect(result.content[0].text).toContain('Builder: idle - last success')
    expect(result.content[0].text).not.toContain('abc123')
    expect(result.content[0].text).not.toContain('/secret/path')
  })
})
