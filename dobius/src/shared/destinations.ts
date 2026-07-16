export type DestinationType = 'telegram' | 'imessage' | 'system' | 'asana' | 'email'

export type TelegramDestinationConfig = {
  botToken: string
  chatId: string
}

export type ImessageDestinationConfig = {
  handle: string
}

export type AsanaDestinationConfig = {
  taskGid: string
}

export type EmailDestinationConfig = {
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  smtpUser: string
  smtpPassword: string
  from: string
  to: string
}

export type DestinationConfigByType = {
  telegram: TelegramDestinationConfig
  imessage: ImessageDestinationConfig
  system: Record<string, never>
  asana: AsanaDestinationConfig
  email: EmailDestinationConfig
}

type DestinationOfType<T extends DestinationType> = {
  id: string
  name: string
  type: T
  config: DestinationConfigByType[T]
  createdAt: number
  updatedAt: number
}

export type Destination =
  | DestinationOfType<'telegram'>
  | DestinationOfType<'imessage'>
  | DestinationOfType<'system'>
  | DestinationOfType<'asana'>
  | DestinationOfType<'email'>

export type DestinationSaveInput = {
  id?: string
  name: string
  type: DestinationType
  config: Record<string, unknown>
}

export type DestinationDeliveryMessage = {
  title: string
  body: string
}

export type DestinationTestResult = {
  ok: boolean
  error: string | null
}
