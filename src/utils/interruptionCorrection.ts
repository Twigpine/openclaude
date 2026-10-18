import type { Message, UserMessage } from '../types/message.js'
import { createUserMessage } from './messages/factories.js'
import { isCompactBoundaryMessage } from './messages/systemFactories.js'

export const INTERRUPTION_CORRECTION_REMINDER = `<system-reminder>
The previous assistant turn was interrupted by the user. Treat the user's latest message as a correction and do not continue the interrupted plan unless explicitly asked.
</system-reminder>`

export function shouldMarkInterruptionCorrection({
  isUserInitiated,
  activeQueryId,
  modelBoundQueryId,
  isRemoteMode,
  hasQueuedNormalPrompt = false,
}: {
  isUserInitiated: boolean
  activeQueryId: string | null
  modelBoundQueryId: string | null
  isRemoteMode: boolean
  hasQueuedNormalPrompt?: boolean
}): boolean {
  return (
    isUserInitiated &&
    !isRemoteMode &&
    !hasQueuedNormalPrompt &&
    activeQueryId !== null &&
    activeQueryId === modelBoundQueryId
  )
}

export function consumeInterruptionCorrectionReminder(
  pendingSessionId: string | null,
  currentSessionId: string,
): { pendingSessionId: null; reminder: UserMessage | null } {
  return {
    pendingSessionId: null,
    reminder: pendingSessionId === currentSessionId
      ? createUserMessage({
          content: INTERRUPTION_CORRECTION_REMINDER,
          isMeta: true,
        })
      : null,
  }
}

function isInterruptionCorrectionReminder(message: Message): boolean {
  return (
    message.type === 'user' &&
    message.isMeta === true &&
    message.message.content === INTERRUPTION_CORRECTION_REMINDER
  )
}

export function buildInterruptionCorrectionMessageViews(
  history: readonly Message[],
  newMessages: readonly Message[],
): {
  persistentMessages: Message[]
  persistentNewMessages: Message[]
  requestOnlyMessages: Message[]
} {
  const persistentNewMessages = newMessages.filter(
    message => !isInterruptionCorrectionReminder(message),
  )
  const requestOnlyMessages = newMessages.filter(
    isInterruptionCorrectionReminder,
  )
  return {
    persistentMessages: [...history, ...persistentNewMessages],
    persistentNewMessages,
    requestOnlyMessages,
  }
}

export function applyInterruptionCorrectionAutoRestore(
  previousMessages: readonly Message[],
  rewindMessage: UserMessage,
  setMessages: (messages: Message[]) => void,
  tracker: {
    handleConversationRewrite(options?: { preserveReminder?: boolean }): void
    prepareForAutoRestore(): void
  },
  preserveReminder = false,
): number | null {
  const messageIndex = previousMessages.lastIndexOf(rewindMessage)
  if (messageIndex === -1) return null

  if (preserveReminder) {
    tracker.prepareForAutoRestore()
  }
  setMessages(previousMessages.slice(0, messageIndex))
  tracker.handleConversationRewrite({
    // This finalizes the one-rewrite preservation window. It does not create
    // a reminder when none was pending.
    preserveReminder,
  })
  return messageIndex
}

function handleInterruptionCorrectionMessageUpdate(
  previousMessages: readonly Message[],
  nextMessages: readonly Message[],
  tracker: { handleConversationRewrite(): void },
): void {
  const previousBoundary = previousMessages.findLast(isCompactBoundaryMessage)
  const nextBoundary = nextMessages.findLast(isCompactBoundaryMessage)
  if (
    nextBoundary?.uuid !== previousBoundary?.uuid ||
    (previousMessages.length > 0 && nextMessages.length === 0)
  ) {
    tracker.handleConversationRewrite()
  }
}

export function applyInterruptionCorrectionAwareMessageUpdate(
  messagesRef: { current: Message[] },
  action: Message[] | ((messages: Message[]) => Message[]),
  tracker: { handleConversationRewrite(): void },
): { previousMessages: Message[]; nextMessages: Message[] } {
  const previousMessages = messagesRef.current
  const nextMessages = typeof action === 'function'
    ? action(previousMessages)
    : action
  handleInterruptionCorrectionMessageUpdate(
    previousMessages,
    nextMessages,
    tracker,
  )
  messagesRef.current = nextMessages
  return { previousMessages, nextMessages }
}

export class InterruptionCorrectionTracker {
  private pendingSessionId: string | null = null
  private modelBoundQueryId: string | null = null
  private preservePendingReminderForRewrite = false

  constructor(
    private readonly queryGuard: {
      readonly activeContext: { queryId: string } | null
    },
    private readonly getSessionId: () => string,
  ) {}

  bindModelTurn({
    shouldQuery,
    isInterruptionCorrectionEligible,
    queryId,
  }: {
    shouldQuery: boolean
    isInterruptionCorrectionEligible: boolean
    queryId: string
  }): void {
    const activeQueryId = this.queryGuard.activeContext?.queryId ?? null
    if (
      shouldQuery &&
      isInterruptionCorrectionEligible &&
      activeQueryId === queryId
    ) {
      this.modelBoundQueryId = queryId
    }
  }

  async runModelTurn({
    shouldQuery,
    isInterruptionCorrectionEligible,
    queryId,
    run,
  }: {
    shouldQuery: boolean
    isInterruptionCorrectionEligible: boolean
    queryId: string
    run: () => Promise<void>
  }): Promise<void> {
    this.bindModelTurn({
      shouldQuery,
      isInterruptionCorrectionEligible,
      queryId,
    })
    try {
      await run()
    } finally {
      this.finishModelTurn(queryId)
    }
  }

  handleCancellation({
    isUserInitiated,
    isRemoteMode,
    hasQueuedNormalPrompt = false,
  }: {
    isUserInitiated: boolean
    isRemoteMode: boolean
    hasQueuedNormalPrompt?: boolean
  }): void {
    const activeQueryId = this.queryGuard.activeContext?.queryId ?? null
    if (
      shouldMarkInterruptionCorrection({
        isUserInitiated,
        activeQueryId,
        modelBoundQueryId: this.modelBoundQueryId,
        isRemoteMode,
        hasQueuedNormalPrompt,
      })
    ) {
      this.pendingSessionId = this.getSessionId()
    }
    if (
      activeQueryId !== null &&
      activeQueryId === this.modelBoundQueryId
    ) {
      this.modelBoundQueryId = null
    }
  }

  finishModelTurn(queryId: string): void {
    if (this.modelBoundQueryId === queryId) {
      this.modelBoundQueryId = null
    }
  }

  handleConversationRewrite({
    preserveReminder = false,
  }: {
    preserveReminder?: boolean
  } = {}): void {
    if (!preserveReminder && !this.preservePendingReminderForRewrite) {
      this.pendingSessionId = null
    }
    this.preservePendingReminderForRewrite = false
  }

  prepareForAutoRestore(): void {
    this.preservePendingReminderForRewrite =
      this.pendingSessionId === this.getSessionId()
  }

  restoreReminder(): void {
    this.pendingSessionId = this.getSessionId()
  }

  handleSessionChange(): void {
    this.pendingSessionId = null
    this.modelBoundQueryId = null
    this.preservePendingReminderForRewrite = false
  }

  takeReminder(): UserMessage | null {
    const result = consumeInterruptionCorrectionReminder(
      this.pendingSessionId,
      this.getSessionId(),
    )
    this.pendingSessionId = result.pendingSessionId
    return result.reminder
  }
}
