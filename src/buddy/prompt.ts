import type { Message } from '../types/message.js'
import type { Attachment } from '../utils/attachments.js'
import { getGlobalConfig } from '../utils/config.js'
import { getCompanion } from './companion.js'
import { isBuddyEnabled } from './feature.js'
import { FORM_NAMES, type Form } from './types.js'

export function companionIntroText(name: string, species: string): string {
  // Attachments store the form id (kaio, strawhat); the model hears the name
  // users see (Nova, Inky).
  const form = FORM_NAMES[species as Form] ?? species
  return `# Companion

A tiny ${form} companion named ${name} sits beside the user's input box and occasionally comments in a speech bubble. You're not ${name} — it's a separate watcher.

When the user addresses ${name} directly (by name), its bubble will answer. Your job in that moment is to stay out of the way: respond in ONE line or less, or just answer any part of the message meant for you. Don't explain that you're not ${name} — they know. Don't narrate what ${name} might say — the bubble handles that.`
}

export function getCompanionIntroAttachment(
  messages: Message[] | undefined,
): Attachment[] {
  if (!isBuddyEnabled()) return []
  const companion = getCompanion()
  if (!companion || getGlobalConfig().companionMuted) return []

  // Skip if already announced for this companion IN ITS CURRENT FORM —
  // /buddy set changes the species without changing the name, and the model
  // should hear about the new form once.
  for (const msg of messages ?? []) {
    if (msg.type !== 'attachment') continue
    if (msg.attachment.type !== 'companion_intro') continue
    if (
      msg.attachment.name === companion.name &&
      msg.attachment.species === companion.species
    ) {
      return []
    }
  }

  return [
    {
      type: 'companion_intro',
      name: companion.name,
      species: companion.species,
    },
  ]
}
