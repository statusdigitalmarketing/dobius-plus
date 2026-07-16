import { request } from 'node:https'
import { Notification } from 'electron'
import type { Destination, DestinationDeliveryMessage } from '../../shared/destinations'
import { sendImessage } from '../imessage-bridge/imessage-send'
import { postTaskComment } from '../asana/asana-client'
import { hasAsanaToken } from '../asana/asana-token-store'

// Why: each channel has its own hard payload ceiling; text is truncated per
// destination so one render works for all of them.
const BODY_LIMITS: Record<Destination['type'], number> = {
  telegram: 3900,
  imessage: 1300,
  system: 500,
  asana: 10_000,
  email: 100_000
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

function combinedText(message: DestinationDeliveryMessage, limit: number): string {
  const text = message.body ? `${message.title}\n\n${message.body}` : message.title
  return truncate(text, limit)
}

async function sendTelegram(botToken: string, chatId: string, text: string): Promise<void> {
  const payload = JSON.stringify({ chat_id: chatId, text })
  await new Promise<void>((resolve, reject) => {
    const req = request(
      {
        host: 'api.telegram.org',
        path: `/bot${botToken}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 15_000
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve()
            return
          }
          const body = Buffer.concat(chunks).toString('utf-8').slice(0, 300)
          reject(new Error(`Telegram API ${res.statusCode}: ${body}`))
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('Telegram API timeout')))
    req.on('error', reject)
    req.end(payload)
  })
}

async function sendEmail(
  config: Extract<Destination, { type: 'email' }>['config'],
  message: DestinationDeliveryMessage
): Promise<void> {
  const { createTransport } = await import('nodemailer')
  const transport = createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPassword } : undefined
  })
  await transport.sendMail({
    from: config.from,
    to: config.to,
    subject: truncate(message.title, 180),
    text: message.body || message.title
  })
}

function sendSystemNotification(message: DestinationDeliveryMessage): void {
  if (!Notification.isSupported()) {
    throw new Error('System notifications are not supported on this platform')
  }
  new Notification({
    title: truncate(message.title, 120),
    body: truncate(message.body, BODY_LIMITS.system)
  }).show()
}

export async function deliverToDestination(
  destination: Destination,
  message: DestinationDeliveryMessage
): Promise<void> {
  switch (destination.type) {
    case 'telegram':
      await sendTelegram(
        destination.config.botToken,
        destination.config.chatId,
        combinedText(message, BODY_LIMITS.telegram)
      )
      return
    case 'imessage':
      if (process.platform !== 'darwin') {
        throw new Error('iMessage destinations require macOS')
      }
      await sendImessage(destination.config.handle, combinedText(message, BODY_LIMITS.imessage))
      return
    case 'system':
      sendSystemNotification(message)
      return
    case 'asana':
      if (!hasAsanaToken()) {
        throw new Error('Asana is not connected — add a token in Settings first')
      }
      await postTaskComment(destination.config.taskGid, combinedText(message, BODY_LIMITS.asana))
      return
    case 'email':
      await sendEmail(destination.config, message)
  }
}
