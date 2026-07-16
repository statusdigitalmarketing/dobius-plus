import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { CheckCircle2, Plus, Send, Trash2, XCircle } from 'lucide-react'
import type { Destination, DestinationType } from '../../../../shared/destinations'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { translate } from '@/i18n/i18n'

type TestState = { state: 'ok' } | { state: 'error'; error: string }

type DestinationFormState = {
  id: string | null
  name: string
  type: DestinationType
  config: Record<string, string>
}

const EMPTY_FORM: DestinationFormState = { id: null, name: '', type: 'telegram', config: {} }

const TYPE_LABELS: Record<DestinationType, string> = {
  telegram: 'Telegram',
  imessage: 'iMessage',
  system: 'System notification',
  asana: 'Asana comment',
  email: 'Email'
}

type ConfigFieldSpec = { key: string; label: string; secret?: boolean }

const CONFIG_FIELDS: Record<DestinationType, ConfigFieldSpec[]> = {
  telegram: [
    {
      key: 'botToken',
      label: translate('auto.components.settings.DestinationsSection.77ecc46d5f', 'Bot token'),
      secret: true
    },
    {
      key: 'chatId',
      label: translate('auto.components.settings.DestinationsSection.b6b8927b39', 'Chat ID')
    }
  ],
  imessage: [
    {
      key: 'handle',
      label: translate(
        'auto.components.settings.DestinationsSection.201eb54270',
        'Phone or email handle'
      )
    }
  ],
  system: [],
  asana: [
    {
      key: 'taskGid',
      label: translate('auto.components.settings.DestinationsSection.856965c026', 'Task GID')
    }
  ],
  email: [
    {
      key: 'smtpHost',
      label: translate('auto.components.settings.DestinationsSection.8c39091fb4', 'SMTP host')
    },
    {
      key: 'smtpPort',
      label: translate('auto.components.settings.DestinationsSection.20793cc416', 'SMTP port')
    },
    {
      key: 'smtpUser',
      label: translate('auto.components.settings.DestinationsSection.9a03bbde63', 'SMTP username')
    },
    {
      key: 'smtpPassword',
      label: translate('auto.components.settings.DestinationsSection.fdf36395f8', 'SMTP password'),
      secret: true
    },
    {
      key: 'from',
      label: translate('auto.components.settings.DestinationsSection.15a207a536', 'From address')
    },
    {
      key: 'to',
      label: translate('auto.components.settings.DestinationsSection.599cbf91ce', 'To address')
    }
  ]
}

function formConfigFromDestination(destination: Destination): Record<string, string> {
  return Object.fromEntries(
    Object.entries(destination.config).map(([key, value]) => [key, String(value)])
  )
}

function savePayloadConfig(form: DestinationFormState): Record<string, unknown> {
  if (form.type !== 'email') {
    return form.config
  }
  return {
    ...form.config,
    smtpPort: Number(form.config.smtpPort ?? '587') || 587,
    smtpSecure: (Number(form.config.smtpPort ?? '587') || 587) === 465
  }
}

export function DestinationsSection(): React.JSX.Element {
  const [destinations, setDestinations] = useState<Destination[]>([])
  const [form, setForm] = useState<DestinationFormState | null>(null)
  const [saving, setSaving] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, TestState>>({})

  useEffect(() => {
    void window.api.destinations
      .list()
      .then(setDestinations)
      .catch(() => setDestinations([]))
  }, [])

  const handleSave = async (): Promise<void> => {
    if (!form || !form.name.trim()) {
      return
    }
    setSaving(true)
    try {
      await window.api.destinations.save({
        id: form.id ?? undefined,
        name: form.name.trim(),
        type: form.type,
        config: savePayloadConfig(form)
      })
      setDestinations(await window.api.destinations.list())
      setForm(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string): Promise<void> => {
    await window.api.destinations.delete(id)
    setDestinations(await window.api.destinations.list())
  }

  const handleTest = async (id: string): Promise<void> => {
    setTestingId(id)
    setTestResults((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
    try {
      const result = await window.api.destinations.test(id)
      setTestResults((current) => ({
        ...current,
        [id]: result.ok ? { state: 'ok' } : { state: 'error', error: result.error ?? 'Test failed' }
      }))
    } finally {
      setTestingId(null)
    }
  }

  return (
    <div className="space-y-3 pt-3">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label>
            {translate(
              'auto.components.settings.DestinationsSection.8c795e3a31',
              'Automation Destinations'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.DestinationsSection.766929478d',
              'Where automations deliver their run results. Pick one per automation in its editor.'
            )}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          onClick={() => setForm({ ...EMPTY_FORM })}
        >
          <Plus className="size-3.5" />
          {translate('auto.components.settings.DestinationsSection.9fe3a94aa4', 'Add destination')}
        </Button>
      </div>

      {destinations.length === 0 && !form ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.DestinationsSection.8e823eaa43',
            'No destinations configured yet.'
          )}
        </p>
      ) : null}

      <div className="space-y-2">
        {destinations.map((destination) => {
          const testResult = testResults[destination.id]
          return (
            <div
              key={destination.id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2"
            >
              <span className="text-sm font-medium">{destination.name}</span>
              <Badge variant="secondary">{TYPE_LABELS[destination.type]}</Badge>
              {testResult?.state === 'ok' ? (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <CheckCircle2 className="size-3.5" />
                  {translate(
                    'auto.components.settings.DestinationsSection.bf9539a5e3',
                    'Delivered'
                  )}
                </span>
              ) : null}
              {testResult?.state === 'error' ? (
                <span className="inline-flex items-center gap-1 text-xs text-destructive">
                  <XCircle className="size-3.5" />
                  {testResult.error}
                </span>
              ) : null}
              <div className="ml-auto flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5"
                  disabled={testingId === destination.id}
                  onClick={() => void handleTest(destination.id)}
                >
                  <Send className="size-3.5" />
                  {testingId === destination.id
                    ? translate(
                        'auto.components.settings.DestinationsSection.57124f2266',
                        'Sending…'
                      )
                    : translate('auto.components.settings.DestinationsSection.2ca6af2301', 'Test')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setForm({
                      id: destination.id,
                      name: destination.name,
                      type: destination.type,
                      config: formConfigFromDestination(destination)
                    })
                  }
                >
                  {translate('auto.components.settings.DestinationsSection.b9c4dd25da', 'Edit')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void handleDelete(destination.id)}>
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>
          )
        })}
      </div>

      {form ? (
        <div className="space-y-3 rounded-md border border-border p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>
                {translate('auto.components.settings.DestinationsSection.a419dd48e1', 'Name')}
              </Label>
              <Input
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>
                {translate('auto.components.settings.DestinationsSection.6aaefc1cce', 'Type')}
              </Label>
              <Select
                value={form.type}
                onValueChange={(value) =>
                  setForm({ ...form, type: value as DestinationType, config: {} })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(TYPE_LABELS) as DestinationType[]).map((type) => (
                    <SelectItem key={type} value={type}>
                      {TYPE_LABELS[type]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {CONFIG_FIELDS[form.type].map((field) => (
              <div key={field.key} className="space-y-1.5">
                <Label>{field.label}</Label>
                <Input
                  type={field.secret ? 'password' : 'text'}
                  value={form.config[field.key] ?? ''}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      config: { ...form.config, [field.key]: event.target.value }
                    })
                  }
                />
              </div>
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setForm(null)}>
              {translate('auto.components.settings.DestinationsSection.3bb310d336', 'Cancel')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={saving || !form.name.trim()}
              onClick={() => void handleSave()}
            >
              {form.id
                ? translate(
                    'auto.components.settings.DestinationsSection.c9d02bbdc6',
                    'Save destination'
                  )
                : translate(
                    'auto.components.settings.DestinationsSection.9fe3a94aa4',
                    'Add destination'
                  )}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
