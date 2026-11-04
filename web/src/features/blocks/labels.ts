import type { TFn } from '@/i18n'
import type { BlockCategory, BlockPlugin } from './types'

/** Name of a built-in block type in the UI language (the server only knows the type). */
export function builtinLabel(t: TFn, type: string): string {
  switch (type) {
    case 'chart': return t('blocks.type.chart')
    case 'table': return t('blocks.type.table')
    case 'stats': return t('blocks.type.stats')
    case 'list': return t('blocks.type.list')
    case 'timeline': return t('blocks.type.timeline')
    case 'progress': return t('blocks.type.progress')
    case 'terminal': return t('blocks.type.terminal')
    case 'diff': return t('blocks.type.diff')
    case 'file': return t('blocks.type.file')
    case 'link': return t('blocks.type.link')
    case 'form': return t('blocks.type.form')
    case 'checklist': return t('blocks.type.checklist')
    case 'app': return t('blocks.type.app')
    case 'created': return t('blocks.type.created')
    case 'proposal': return t('blocks.type.proposal')
    default: return type
  }
}

/** One line on what a built-in block does, in the UI language. */
export function builtinDesc(t: TFn, type: string): string {
  switch (type) {
    case 'chart': return t('blocks.desc.chart')
    case 'table': return t('blocks.desc.table')
    case 'stats': return t('blocks.desc.stats')
    case 'list': return t('blocks.desc.list')
    case 'timeline': return t('blocks.desc.timeline')
    case 'progress': return t('blocks.desc.progress')
    case 'terminal': return t('blocks.desc.terminal')
    case 'diff': return t('blocks.desc.diff')
    case 'file': return t('blocks.desc.file')
    case 'link': return t('blocks.desc.link')
    case 'form': return t('blocks.desc.form')
    case 'checklist': return t('blocks.desc.checklist')
    case 'app': return t('blocks.desc.app')
    case 'created': return t('blocks.desc.created')
    case 'proposal': return t('blocks.desc.proposal')
    default: return ''
  }
}

export function categoryLabel(t: TFn, c: BlockCategory): string {
  switch (c) {
    case 'data': return t('blocks.cat.data')
    case 'code': return t('blocks.cat.code')
    case 'media': return t('blocks.cat.media')
    case 'interactive': return t('blocks.cat.interactive')
    case 'organisation': return t('blocks.cat.organisation')
    default: return t('blocks.cat.other')
  }
}

/** Display name of any plugin. */
export function pluginLabel(t: TFn, p: BlockPlugin, lang: string): string {
  return p.kind === 'builtin' ? builtinLabel(t, p.id) : p.names[lang] || p.names.en || p.name || p.id
}
