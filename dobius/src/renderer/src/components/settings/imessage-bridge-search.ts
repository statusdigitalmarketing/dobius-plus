import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getImessageBridgeSearchEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    title: translate('auto.components.settings.imessage.bridge.search.title', 'iMessage Bridge'),
    description: translate(
      'auto.components.settings.imessage.bridge.search.description',
      'Text yourself in Messages to type commands into the active terminal.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.imessage.bridge.search.keyword.imessage',
        'imessage'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.imessage.bridge.search.keyword.messages',
        'messages'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.imessage.bridge.search.keyword.text',
        'text'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.imessage.bridge.search.keyword.sms',
        'sms'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.imessage.bridge.search.keyword.bridge',
        'bridge'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.imessage.bridge.search.keyword.phone',
        'phone'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.imessage.bridge.search.keyword.remote',
        'remote'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.imessage.bridge.search.keyword.trigger',
        'trigger prefix'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.imessage.bridge.search.keyword.fda',
        'full disk access'
      )
    ]
  })
)
