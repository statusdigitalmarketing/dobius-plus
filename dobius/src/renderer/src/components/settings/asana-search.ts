import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getAsanaPaneSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.asana.search.title', 'Asana Automation'),
    description: translate(
      'auto.components.settings.asana.search.description',
      'Configure Asana lanes, Auto Mode polling, and the triage agent.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.asana.search.keywordAsana', 'asana'),
      ...translateSearchKeyword(
        'auto.components.settings.asana.search.keywordAutomation',
        'automation'
      ),
      ...translateSearchKeyword('auto.components.settings.asana.search.keywordPat', 'pat'),
      ...translateSearchKeyword('auto.components.settings.asana.search.keywordToken', 'token'),
      ...translateSearchKeyword('auto.components.settings.asana.search.keywordGid', 'gid')
    ]
  }
])
