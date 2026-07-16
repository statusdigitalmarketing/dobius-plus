import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  httpsRequest: vi.fn(),
  getAsanaToken: vi.fn(() => 'asana-token')
}))

vi.mock('node:https', () => ({
  default: { request: mocks.httpsRequest },
  request: mocks.httpsRequest
}))

vi.mock('./asana-token-store', () => ({
  getAsanaToken: mocks.getAsanaToken
}))

class FakeRequest extends EventEmitter {
  destroy = vi.fn()
  end = vi.fn()
}

class FakeResponse extends EventEmitter {
  statusCode = 201
}

async function postCommentWithResponse(text: string) {
  const request = new FakeRequest()
  const response = new FakeResponse()
  mocks.httpsRequest.mockImplementationOnce((_options, callback) => {
    callback(response)
    return request
  })
  const { postTaskComment } = await import('./asana-client')
  const promise = postTaskComment('123456', text)
  response.emit('data', Buffer.from('{"data":{"gid":"story-1"}}'))
  response.emit('end')
  await promise
  return { request }
}

beforeEach(() => {
  vi.resetModules()
  mocks.httpsRequest.mockReset()
  mocks.getAsanaToken.mockReset()
  mocks.getAsanaToken.mockReturnValue('asana-token')
})

describe('asana client comments', () => {
  it('posts task comments to the Asana stories endpoint', async () => {
    const { request } = await postCommentWithResponse('Ready for review')
    expect(mocks.httpsRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: 'app.asana.com',
        path: '/api/1.0/tasks/123456/stories',
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer asana-token',
          'Content-Type': 'application/json'
        })
      }),
      expect.any(Function)
    )
    expect(request.end).toHaveBeenCalledWith(JSON.stringify({ data: { text: 'Ready for review' } }))
  })

  it('truncates comments that exceed Asana story limits', async () => {
    const { request } = await postCommentWithResponse('x'.repeat(65_010))
    const payload = JSON.parse(request.end.mock.calls[0][0]) as { data: { text: string } }
    expect(payload.data.text).toHaveLength(65_000)
    expect(payload.data.text).toContain('Comment truncated by Dobius+')
  })
})
