

const ipcRenderer = window.electronAPI;
// routeLink is now loaded globally via script tag in chat.html

const isMacPlatform = !!(window.electronAPI && window.electronAPI.platform === 'darwin')

function emitTelemetrySignal(name, fields = {}) {
  try {
    ipcRenderer.send('telemetry:signal', { name, fields })
  } catch (_) {}
}

function updateOverlayVisualMode() {
  const root = document.documentElement
  if (!root) return
  root.classList.toggle('non-mac', !isMacPlatform)
  const isLiquidGlass = root.classList.contains('liquid-glass-active')
  root.classList.toggle('fallback-overlay', !isMacPlatform && !isLiquidGlass)
}

ipcRenderer.on('liquid-glass-active', () => {
  document.documentElement.classList.add('liquid-glass-active')
  updateOverlayVisualMode()
})

updateOverlayVisualMode()

const input0 = document.getElementById('chatInput')
const includeScreenBtn = document.getElementById('includeScreenBtn')
const screenAttachmentChip = document.getElementById('screenAttachmentChip')
const openAppBtn = document.getElementById('openAppBtn')
const closeOverlayBtn = document.getElementById('closeOverlayBtn')
const clearBtn = document.getElementById('clearBtn')
const chatContainer = document.getElementById('chatContainer')
const recentChatsContainer = document.getElementById('recentChatsContainer')
const chatNotice = document.getElementById('chatNotice')
const reportIssueBtn = document.getElementById('reportIssueBtn')
const overlayRoot = document.getElementById('overlayRoot')
const overlayCard = document.querySelector('.overlay-card')
const inputRow = document.querySelector('.input-row')
const overlayTooltip = document.getElementById('overlayTooltip')
const mascotWrap = document.getElementById('mascotWrap')
const mascotCanvas = document.getElementById('mascotCanvas')
const mascotFallback = document.getElementById('mascotFallback')

// Event delegation for chat links - handle all link clicks at container level
if (chatContainer) {
  chatContainer.addEventListener('click', (e) => {
    if (e.target.classList.contains('chat-link')) {
      e.preventDefault()
      const url = e.target.getAttribute('data-url')
      if (url) {
        routeLink(url, { source: 'chat' })
      }
    }
  })
}

let messages = []
let chatVisible = false
let lastSentHeight = null
let lastOverlayRenderTelemetryAt = 0
let includeScreenOnNextMessage = false
const MIN_INPUT_HEIGHT = 32
let typingTimer = null
const TYPING_DELAY_MS = 300
const INACTIVITY_RESET_MS = 10 * 60 * 1000
const COLLAPSED_OVERLAY_HEIGHT = 52
const MAX_OVERLAY_HEIGHT = 720
const ASSISTANT_WRITING_HOLD_MS = 2500
const ASSISTANT_EMOTION_PLAYBACK_MS = 7000
const MASCOT_OPEN_RESET_MS = 120
const MASCOT_OPEN_IDLE_SETTLE_MS = 500
const MASCOT_SOURCE = '../resources/rive/donethat_mascot.riv'
const MASCOT_ARTBOARD_NAME = 'face'
const MASCOT_STATE_MACHINE_NAME = 'face'
const EMPTY_CHAT_PROMPTS = Object.freeze([
  'Please log an offline meeting for me',
  'Please send feedback to Christoph',
  'Please interrupt me less often',
  'Set my goal for today',
  'What did I work on yesterday?',
  'Generate my work report for today',
  'Record two hours of planning for yesterday',
  'Generate my daily summary',
  'Approve today\'s summary',
  'Edit my daily summary',
  'Set my weekly goal',
  'Set my monthly goal',
  'Review my quarterly goals',
  'Create a project for onboarding',
  'Rename my client project',
  'Merge two duplicate projects',
  'Move this task to another project',
  'List my active projects',
  'Who follows me?',
  'Show who I am following',
  'Search for Christoph',
  'Accept my pending follow requests',
  'Turn proactive chat off',
  'Update my workhours',
  'Search the DoneThat docs',
  'How do goals work in DoneThat?',
  'How does DoneThat work?',
  'Explain me how the calendar feature works.',
  'Schedule a meeting tomorrow',
  'Schedule a meeting with John for tomorrow at 3.',
  'Log a coffee chat',
  'Help me plan my afternoon',
  'What should I focus on next?',
  'Cheer me up',
  'Tell me a joke',
  'Give me a tiny pep talk',
  'Make my day sound productive',
  'Write a haiku about deep work',
  'Help me procrastinate less',
  'Nudge me back on track'
])
const FEEDBACK_HISTORY_MESSAGE_LIMIT = 20
const FEEDBACK_HISTORY_CHAR_LIMIT = 6000
const MASCOT_MOODS = Object.freeze({
  IDLE: 0,
  CHILLING: 1,
  CELEBRATING: 2,
  SLEEPING: 3,
  DEEPFOCUS: 4,
  PAUSED: 5,
  JUDGING: 6,
  PRODUCTIVE: 7,
  UNHAPPY: 8,
  THINKING: 9,
  ERROR: 10,
  WRITING: 11,
  GREETING: 12,
  QUESTIONING: 13,
  LOADING: 14,
  PRIVACY_MODE: 15,
  ENCOURAGING: 16
})

const EMOTION_TO_MOOD = Object.freeze({
  neutral:     [MASCOT_MOODS.IDLE],
  relaxed:     [MASCOT_MOODS.CHILLING],
  celebrating: [MASCOT_MOODS.CELEBRATING],
  focused:     [MASCOT_MOODS.DEEPFOCUS],
  judging:     [MASCOT_MOODS.JUDGING, MASCOT_MOODS.QUESTIONING],
  productive:  [MASCOT_MOODS.PRODUCTIVE, MASCOT_MOODS.ENCOURAGING],
  sad:         [MASCOT_MOODS.UNHAPPY],
})
const WAITING_MOODS = Object.freeze([
  MASCOT_MOODS.THINKING,
  MASCOT_MOODS.WRITING,
  MASCOT_MOODS.LOADING,
  MASCOT_MOODS.PRIVACY_MODE
])

// Simple UI state
let pendingMessages = []
// Keep a stable mapping from message keys to DOM rows to minimize reflows/flicker
const rowByKey = new Map()

// Recent chats state
let recentChats = []
let recentChatsPage = 0
const CHATS_PER_PAGE = 10
let isLoadingChat = false
let recordingPaused = false
let mascotRive = null
let mascotInputs = {
  focusLevel: null,
  lidsmove: null,
  shake: null
}
let mascotMoodOverride = null
let mascotMoodOverrideTimer = null
let assistantWritingTimer = null
let assistantWritingUntil = 0
let mascotOpenSequenceToken = 0
let mascotIdleOverrideUntil = 0
let activeWaitingMood = null
let promptAnimationTimer = null
let promptAnimationRunning = false
let emptyChatPromptIndex = 0
let tooltipHideTimer = null
let lastDocumentVisibilityState = document.visibilityState
/**
 * False while the overlay document is hidden (minimized, window hidden, etc.). Tracks on-screen
 * state so `markOverlayEngaged()` can re-sync the mascot when the overlay becomes visible again.
 */
let overlayWindowActive = true

function markOverlayEngaged() {
  const prev = overlayWindowActive
  overlayWindowActive = true
  if (!prev) syncMascotState()
}

function getMessageKey(message, index) {
  return message.id || message.ts || `idx-${index}`
}

function hasActiveChatMessages() {
  return messages.length > 0 || pendingMessages.length > 0
}

function updateInputPlaceholder() {
  if (!input0) return
  syncPromptAnimation()
}

function shufflePrompts(prompts) {
  const shuffled = prompts.slice()
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

const SHUFFLED_EMPTY_CHAT_PROMPTS = Object.freeze(shufflePrompts(EMPTY_CHAT_PROMPTS))

function getNextEmptyChatPrompt() {
  const prompt = SHUFFLED_EMPTY_CHAT_PROMPTS[emptyChatPromptIndex % SHUFFLED_EMPTY_CHAT_PROMPTS.length]
  emptyChatPromptIndex += 1
  return prompt
}

function shouldAnimatePrompt() {
  return !!input0 &&
    !hasActiveChatMessages() &&
    !input0.value &&
    document.visibilityState !== 'hidden'
}

function stopPromptAnimation(clearPlaceholder = true) {
  if (promptAnimationTimer) {
    try { clearTimeout(promptAnimationTimer) } catch (e) {}
    promptAnimationTimer = null
  }
  promptAnimationRunning = false
  if (clearPlaceholder && input0) input0.placeholder = ''
}

function startPromptAnimation() {
  if (promptAnimationRunning || !shouldAnimatePrompt()) return
  promptAnimationRunning = true
  let prompt = getNextEmptyChatPrompt()
  let charCount = 0
  let deleting = false

  function step() {
    if (!shouldAnimatePrompt()) {
      stopPromptAnimation()
      return
    }

    input0.placeholder = prompt.slice(0, charCount)

    let delay = deleting ? 28 : 42
    if (!deleting && charCount < prompt.length) {
      charCount += 1
    } else if (!deleting) {
      deleting = true
      delay = 1800
    } else if (charCount > 0) {
      charCount -= 1
    } else {
      deleting = false
      prompt = getNextEmptyChatPrompt()
      delay = 250
    }

    promptAnimationTimer = setTimeout(step, delay)
  }

  step()
}

function syncPromptAnimation() {
  if (shouldAnimatePrompt()) {
    startPromptAnimation()
  } else {
    stopPromptAnimation()
  }
}

function hasNewAssistantMessage(previousMessages, nextMessages) {
  const knownAssistantKeys = new Set()

  for (let i = 0; i < previousMessages.length; i++) {
    const message = previousMessages[i]
    if (message && message.role === 'assistant') {
      knownAssistantKeys.add(getMessageKey(message, i))
    }
  }

  for (let i = 0; i < nextMessages.length; i++) {
    const message = nextMessages[i]
    if (!message || message.role !== 'assistant') continue
    if (!knownAssistantKeys.has(getMessageKey(message, i))) {
      return true
    }
  }

  return false
}

function setMascotMoodOverride(mood, durationMs) {
  mascotMoodOverride = mood
  if (mascotMoodOverrideTimer) {
    try { clearTimeout(mascotMoodOverrideTimer) } catch (_) {}
    mascotMoodOverrideTimer = null
  }
  const ms = Number(durationMs)
  if (Number.isFinite(ms) && ms > 0) {
    mascotMoodOverrideTimer = setTimeout(() => {
      mascotMoodOverride = null
      mascotMoodOverrideTimer = null
      syncMascotState()
    }, ms)
  }
  syncMascotState()
}

function clearMascotMoodOverride() {
  if (mascotMoodOverrideTimer) {
    try { clearTimeout(mascotMoodOverrideTimer) } catch (_) {}
    mascotMoodOverrideTimer = null
  }
  mascotMoodOverride = null
}

function setMascotIdleOverride(durationMs) {
  mascotIdleOverrideUntil = Date.now() + Math.max(0, Number(durationMs) || 0)
  syncMascotState()
}

function clearMascotIdleOverride() {
  mascotIdleOverrideUntil = 0
}

function breakMascotIdleOverride() {
  if (!mascotIdleOverrideUntil) return
  mascotIdleOverrideUntil = 0
  syncMascotState()
}

function holdMascotMood(mood, durationMs) {
  if (durationMs > 0) {
    setMascotMoodOverride(mood, durationMs)
    return
  }
  clearMascotMoodOverride()
  setMascotMood(mood)
}

function resetAssistantAnimationState() {
  assistantWritingUntil = 0
  if (assistantWritingTimer) {
    try { clearTimeout(assistantWritingTimer) } catch (_) {}
    assistantWritingTimer = null
  }
  clearMascotMoodOverride()
  if (typingTimer) {
    try { clearTimeout(typingTimer) } catch (_) {}
    typingTimer = null
  }
}

function hasAssistantWritingState() {
  if (pendingMessages.some((message) => message && message.typing)) return true
  return Date.now() < assistantWritingUntil
}

function hasPendingUserMessage() {
  return pendingMessages.some((message) => message && message.role === 'user' && message.status === 'pending')
}

function hasWaitingForReplyState() {
  return hasPendingUserMessage() || isLoadingChat
}

function getWaitingMood() {
  if (WAITING_MOODS.length === 0) return MASCOT_MOODS.THINKING
  if (activeWaitingMood === null) {
    const nextIndex = Math.floor(Math.random() * WAITING_MOODS.length)
    activeWaitingMood = WAITING_MOODS[nextIndex]
  }
  return activeWaitingMood
}

/** One waiting mood from send until the assistant reply clears the override (see chat:receive-messages). */
function holdMascotWaitingUntilReply() {
  if (WAITING_MOODS.length === 0) return
  const nextIndex = Math.floor(Math.random() * WAITING_MOODS.length)
  activeWaitingMood = WAITING_MOODS[nextIndex]
  setMascotMoodOverride(activeWaitingMood, Infinity)
}

function getPausedMood() {
  return MASCOT_MOODS.PAUSED
}

function normalizeEmotionKey(emotion) {
  return String(emotion || '').trim().toLowerCase().replace(/[\s_-]+/g, '')
}

function setAssistantWritingState(durationMs = ASSISTANT_WRITING_HOLD_MS) {
  assistantWritingUntil = Date.now() + Math.max(0, Number(durationMs) || 0)
  if (assistantWritingTimer) {
    try { clearTimeout(assistantWritingTimer) } catch (_) {}
  }
  assistantWritingTimer = setTimeout(() => {
    assistantWritingTimer = null
    if (Date.now() >= assistantWritingUntil) {
      assistantWritingUntil = 0
      syncMascotState()
    }
  }, Math.max(0, assistantWritingUntil - Date.now()))
}

function getAssistantMoodForMessage(message) {
  if (!message || message.role !== 'assistant' || typeof message.emotion !== 'string') return null
  const emotion = normalizeEmotionKey(message.emotion)
  if (!emotion) return null
  if (emotion === 'greeting') return null
  const mappedMoods = EMOTION_TO_MOOD[emotion]
  if (!Array.isArray(mappedMoods) || mappedMoods.length === 0) return null
  const index = Math.floor(Math.random() * mappedMoods.length)
  return mappedMoods[index] ?? null
}

function playAssistantEmotion(message, durationMs = ASSISTANT_EMOTION_PLAYBACK_MS) {
  const mood = getAssistantMoodForMessage(message)
  if (mood === null) return false
  setMascotMoodOverride(mood, durationMs)
  return true
}

function setMascotFallbackVisible(isVisible) {
  if (mascotFallback) mascotFallback.hidden = !isVisible
  if (mascotCanvas) mascotCanvas.hidden = !!isVisible
}

function syncMascotPlacement() {
  if (!mascotWrap || !chatContainer || !overlayCard) return
  const rowCount = chatContainer.children.length
  const chatHidden = chatContainer.style.display === 'none'
  if (rowCount === 0 || chatHidden) {
    mascotWrap.hidden = true
    if (mascotWrap.parentElement !== overlayCard) {
      overlayCard.insertBefore(mascotWrap, overlayCard.firstChild)
    } else if (overlayCard.firstChild !== mascotWrap) {
      overlayCard.insertBefore(mascotWrap, overlayCard.firstChild)
    }
    return
  }
  const lastRow = chatContainer.lastElementChild
  if (!lastRow) return
  const lastBubble = lastRow.querySelector('.bubble')
  const isAssistantTail = lastBubble && lastBubble.classList.contains('bubble-system')
  if (!isAssistantTail) {
    mascotWrap.hidden = true
    if (mascotWrap.parentElement !== overlayCard) {
      overlayCard.insertBefore(mascotWrap, overlayCard.firstChild)
    } else if (overlayCard.firstChild !== mascotWrap) {
      overlayCard.insertBefore(mascotWrap, overlayCard.firstChild)
    }
    return
  }
  mascotWrap.hidden = false
  if (mascotWrap.parentElement !== lastRow || lastRow.firstElementChild !== mascotWrap) {
    lastRow.insertBefore(mascotWrap, lastRow.firstChild)
  }
  if (mascotRive) setMascotFallbackVisible(false)
  else setMascotFallbackVisible(true)
}

function getMascotInput(name) {
  if (!mascotRive) return null
  const inputs = mascotRive.stateMachineInputs(MASCOT_STATE_MACHINE_NAME)
  return inputs.find((input) => input.name === name) || null
}

function resizeMascotCanvas() {
  if (!mascotRive) return
  mascotRive.resizeDrawingSurfaceToCanvas()
  mascotRive.resizeToCanvas()
}

function setMascotMood(mood) {
  if (mascotInputs.focusLevel) {
    mascotInputs.focusLevel.value = mood
  }
}

function setMascotLidsMove(value) {
  if (!mascotInputs.lidsmove) return
  const clamped = Math.max(-1, Math.min(1, Number(value) || 0))
  mascotInputs.lidsmove.value = clamped
}

function triggerMascotShake() {
  if (mascotInputs.shake && typeof mascotInputs.shake.fire === 'function') {
    mascotInputs.shake.fire()
  }
}

function computeMascotMood() {
  // The chat mascot never sleeps: it stays awake (idle/active) whenever it is on screen.
  if (recordingPaused) return getPausedMood()
  if (hasWaitingForReplyState()) return getWaitingMood()
  activeWaitingMood = null
  return MASCOT_MOODS.IDLE
}

function syncMascotState() {
  const mood = mascotMoodOverride ?? computeMascotMood()
  setMascotMood(mood)
}

function showMascotErrorState() {
  breakMascotIdleOverride()
  triggerMascotShake()
  setMascotMoodOverride(MASCOT_MOODS.ERROR, 2200)
}

function getLatestAssistantMessage() {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message && message.role === 'assistant') return message
  }
  return null
}

function playMascotOpenSequence() {
  const sequenceToken = ++mascotOpenSequenceToken
  const latestAssistantMessage = getLatestAssistantMessage()
  const replayMood = latestAssistantMessage ? getAssistantMoodForMessage(latestAssistantMessage) : null

  clearMascotMoodOverride()
  clearMascotIdleOverride()
  setMascotLidsMove(0)
  setMascotMood(MASCOT_MOODS.IDLE)

  window.setTimeout(() => {
    if (sequenceToken !== mascotOpenSequenceToken) return

    if (replayMood === null) {
      setMascotIdleOverride(MASCOT_OPEN_IDLE_SETTLE_MS)
      window.setTimeout(() => {
        if (sequenceToken !== mascotOpenSequenceToken) return
        syncMascotState()
      }, MASCOT_OPEN_IDLE_SETTLE_MS)
      return
    }

    holdMascotMood(replayMood, ASSISTANT_EMOTION_PLAYBACK_MS)

    window.setTimeout(() => {
      if (sequenceToken !== mascotOpenSequenceToken) return
      clearMascotMoodOverride()
      setMascotIdleOverride(MASCOT_OPEN_IDLE_SETTLE_MS)
      syncMascotState()
    }, ASSISTANT_EMOTION_PLAYBACK_MS)

    window.setTimeout(() => {
      if (sequenceToken !== mascotOpenSequenceToken) return
      syncMascotState()
    }, ASSISTANT_EMOTION_PLAYBACK_MS + MASCOT_OPEN_IDLE_SETTLE_MS)
  }, MASCOT_OPEN_RESET_MS)
}

function initMascot() {
  const riveRuntime = window.rive
  if (!mascotCanvas || !riveRuntime || typeof riveRuntime.Rive !== 'function') {
    setMascotFallbackVisible(true)
    return
  }

  setMascotFallbackVisible(true)
  mascotRive = new riveRuntime.Rive({
    src: MASCOT_SOURCE,
    canvas: mascotCanvas,
    artboard: MASCOT_ARTBOARD_NAME,
    stateMachines: MASCOT_STATE_MACHINE_NAME,
    autoplay: true,
    layout: new riveRuntime.Layout({
      fit: riveRuntime.Fit.Contain,
      alignment: riveRuntime.Alignment.Center
    }),
    onLoad: () => {
      mascotInputs = {
        focusLevel: getMascotInput('focusLevel'),
        lidsmove: getMascotInput('lidsmove'),
        shake: getMascotInput('shake')
      }
      resizeMascotCanvas()
      setMascotFallbackVisible(false)
      syncMascotState()
    },
    onLoadError: () => {
      mascotRive = null
      mascotInputs = {
        focusLevel: null,
        lidsmove: null,
        shake: null
      }
      setMascotFallbackVisible(true)
    }
  })
}

function createRowForMessage(message) {
  const row = document.createElement('div')
  row.className = 'w-full flex items-end gap-2 ' + (message.role === 'user' ? 'justify-end' : 'justify-start')
  const bubble = document.createElement('div')
  bubble.className = 'bubble no-drag ' + (message.role === 'user' ? 'bubble-user' : 'bubble-system')
  if (message.typing) {
    bubble.replaceChildren(createTypingIndicator())
  } else {
    renderMarkdownIntoBubble(bubble, message.text)
  }
  row.appendChild(bubble)
  return row
}

function computeDesiredHeight() {
  const inputH = getInputRowHeight()
  const chrome = 16
  const chatH = chatContainer.scrollHeight
  const recentChatsH = getRecentChatsHeight()
  // Add fixed height for chat notice if visible (only when there are messages)
  const noticeH = (chatNotice && chatNotice.style.display !== 'none') ? (chatNotice.offsetHeight || 16) : 0
  return chatH + inputH + chrome + recentChatsH + noticeH
}

function getRecentChatsHeight() {
  if (!recentChatsContainer || recentChatsContainer.style.display === 'none') return 0
  const styles = window.getComputedStyle ? window.getComputedStyle(recentChatsContainer) : null
  const marginBottom = styles ? parseFloat(styles.marginBottom) || 0 : 0
  return (recentChatsContainer.offsetHeight || 28) + marginBottom
}

function getInputRowHeight() {
  return inputRow?.offsetHeight || input0?.offsetHeight || MIN_INPUT_HEIGHT
}

function clampOverlayHeight(height) {
  return Math.max(COLLAPSED_OVERLAY_HEIGHT, Math.min(MAX_OVERLAY_HEIGHT, Math.ceil(height)))
}

function applyScrollAndClamp(desired) {
  const inputH = getInputRowHeight()
  const chrome = 16
  const recentChatsH = getRecentChatsHeight()
  // Fixed height for chat notice if visible
  const noticeH = (chatNotice && chatNotice.style.display !== 'none') ? (chatNotice.offsetHeight || 16) : 0
  const clamped = clampOverlayHeight(desired)
  const maxChat = Math.max(0, clamped - inputH - chrome - recentChatsH - noticeH)
  chatContainer.style.maxHeight = maxChat + 'px'
  // Allow scrolling whenever content is taller than the allocated region — not only when
  // the full window hits MAX_OVERLAY_HEIGHT (otherwise overflow stayed hidden with clipped content).
  chatContainer.style.overflowY = 'auto'
  chatContainer.scrollTop = chatContainer.scrollHeight
}

function sendOverlayHeight(height, opts = {}) {
  const clamped = clampOverlayHeight(height)
  if (!opts.force && clamped === lastSentHeight) return
  lastSentHeight = clamped
  ipcRenderer.send('overlay:resize', clamped)
}

function restoreChatHeightIfNeeded() {
  if (!hasActiveChatMessages()) return
  chatVisible = true
  requestAnimationFrame(() => {
    const desired = clampOverlayHeight(computeDesiredHeight())
    applyScrollAndClamp(desired)
    sendOverlayHeight(desired, { force: true })
  })
}

function escapeHtmlAttribute(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function sanitizeChatUrl(url) {
  if (!url) return null
  const value = String(url).trim()
  if (!value) return null

  if (value.startsWith('donethat://')) {
    return value
  }

  try {
    const parsed = new URL(value)
    const protocol = parsed.protocol.toLowerCase()
    if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') {
      return parsed.toString()
    }
  } catch (_) {}

  if (value.toLowerCase().startsWith('mailto:')) {
    return value
  }

  return null
}

function buildSafeChatAnchor(displayText, url) {
  const safeUrl = sanitizeChatUrl(url)
  if (!safeUrl) return displayText
  const escapedUrl = escapeHtmlAttribute(safeUrl)
  return `<a href="${escapedUrl}" class="chat-link" data-url="${escapedUrl}">${displayText}</a>`
}

function createTypingIndicator() {
  const typing = document.createElement('div')
  typing.className = 'typing'
  for (let i = 0; i < 3; i++) {
    typing.appendChild(document.createElement('span'))
  }
  return typing
}

function sanitizeMarkdownElement(node, doc) {
  const allowedTags = new Set([
    'A', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'DIV', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'HR', 'INPUT', 'LI', 'OL', 'PRE', 'STRONG', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'UL'
  ])

  if (node.nodeType === 3) return doc.createTextNode(node.textContent || '')
  if (node.nodeType !== 1) return doc.createTextNode('')

  const tag = node.tagName.toUpperCase()
  if (!allowedTags.has(tag)) return doc.createTextNode(node.textContent || '')

  const clean = doc.createElement(tag.toLowerCase())

  if (tag === 'A') {
    const rawHref = node.getAttribute('href') || node.getAttribute('data-url') || ''
    const safeUrl = sanitizeChatUrl(rawHref)
    if (!safeUrl) return doc.createTextNode(node.textContent || '')
    clean.setAttribute('href', safeUrl)
    clean.setAttribute('data-url', safeUrl)
    clean.className = 'chat-link'
  } else if (tag === 'BLOCKQUOTE') {
    clean.className = 'border-l-4 border-gray-300 pl-4 my-2 text-gray-700'
  } else if (tag === 'OL') {
    const start = node.getAttribute('start')
    if (/^\d+$/.test(start || '')) clean.setAttribute('start', start)
  } else if (tag === 'TH' || tag === 'TD') {
    const rawStyle = node.getAttribute('style') || ''
    const alignMatch = rawStyle.match(/text-align\s*:\s*(left|right|center)/i)
    if (alignMatch) clean.setAttribute('style', `text-align:${alignMatch[1].toLowerCase()}`)
  } else if (tag === 'INPUT') {
    const type = (node.getAttribute('type') || '').toLowerCase()
    if (type !== 'checkbox') return doc.createTextNode('')
    clean.setAttribute('type', 'checkbox')
    if (node.hasAttribute('disabled')) clean.setAttribute('disabled', '')
    if (node.hasAttribute('checked')) clean.setAttribute('checked', '')
  }

  for (const child of node.childNodes) {
    clean.appendChild(sanitizeMarkdownElement(child, doc))
  }

  return clean
}

function renderMarkdownIntoBubble(bubble, text) {
  const rawHtml = parseMarkdown(text)
  const parsed = new DOMParser().parseFromString(`<div>${rawHtml}</div>`, 'text/html')
  const wrapper = parsed.body.firstElementChild
  if (!wrapper) {
    bubble.replaceChildren()
    return
  }

  const fragment = document.createDocumentFragment()
  for (const child of Array.from(wrapper.childNodes)) {
    fragment.appendChild(sanitizeMarkdownElement(child, document))
  }
  bubble.replaceChildren(fragment)
}

// Enhanced markdown parser for chat bubbles (supports bold, italic, code, lists, and links)
function parseMarkdown(text) {
  if (!text) return ''

  // Normalize newlines
  const normalized = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  const lines = normalized.split('\n')
  const htmlParts = []

  let currentList = null // { type: 'ul'|'ol', items: [] }
  let currentQuote = null // { items: [] }
  let currentCode = null // { lang: string|undefined, lines: [] }
  let currentSubListType = null // 'ul' | 'ol' | null
  
  function flushList() {
    if (currentList && currentList.items.length > 0) {
      // Close any open sublist appended to the last item
      if (currentSubListType && currentList.items.length > 0) {
        const lastIdx = currentList.items.length - 1
        currentList.items[lastIdx] += `</${currentSubListType}>`
        currentSubListType = null
      }
      // Items already have inline formatting applied; do not reformat here
      const items = currentList.items.map(it => `<li>${it}</li>`).join('')
      const startAttr = currentList.type === 'ol' && currentList.start && currentList.start !== 1 ? ` start=\"${currentList.start}\"` : ''
      htmlParts.push(`<${currentList.type}${startAttr}>${items}</${currentList.type}>`)
    }
    currentList = null
    currentSubListType = null
  }
  
  function flushQuote() {
    if (currentQuote && currentQuote.items.length > 0) {
      const items = currentQuote.items.map(it => `<div>${inlineFormat(it)}</div>`).join('')
      htmlParts.push(`<blockquote class="border-l-4 border-gray-300 pl-4 my-2 text-gray-700">${items}</blockquote>`)
    }
    currentQuote = null
  }

  function flushCode() {
    if (currentCode && currentCode.lines.length > 0) {
      const codeText = currentCode.lines.join('\n')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
      const langClass = currentCode.lang ? ` class="language-${currentCode.lang}"` : ''
      htmlParts.push(`<pre><code${langClass}>${codeText}</code></pre>`)
    }
    currentCode = null
  }

  function inlineFormat(s) {
    return String(s)
      // Backslash escapes for special markdown punctuation
      .replace(/\\([\\`*_{}\[\]()#+\-.!>~|])/g, '$1')
      // Images: ![alt](url) -> render alt text only
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')
      // Angle links: <https://...> or <mailto:...>
      .replace(/<((?:https?:\/\/|mailto:)[^\s>]+)>/g, (_m, url) => buildSafeChatAnchor(url, url))
      // Plain emails -> mailto links
      .replace(/\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, (_m, email) => buildSafeChatAnchor(email, `mailto:${email}`))
      // Markdown links: [text](url) FIRST
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, textValue, url) => buildSafeChatAnchor(textValue, url))
      // Plain URLs (including donethat://) AFTER markdown links, avoid matching inside attributes
      .replace(/(^|[^"'>=])((?:https?:\/\/|donethat:\/\/)[^\s]+)/g, (_m, p1, url) => `${p1}${buildSafeChatAnchor(url, url)}`)
      // Bold: **text** or __text__
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/__(.*?)__/g, '<strong>$1</strong>')
      // Italic: *text* or _text_
      .replace(/(^|[^*])\*(.*?)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/(^|[^_])_(.*?)_(?!_)/g, '$1<em>$2</em>')
      // Strikethrough: ~~text~~
      .replace(/~~(.*?)~~/g, '<del>$1</del>')
      // Code: `text`
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      // Escape basic HTML last to avoid escaping our generated tags
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      // Unescape only our generated safe tags
      .replace(/&lt;(strong)&gt;([\s\S]*?)&lt;\/\1&gt;/g, '<strong>$2</strong>')
      .replace(/&lt;(em)&gt;([\s\S]*?)&lt;\/\1&gt;/g, '<em>$2</em>')
      .replace(/&lt;(code)&gt;([\s\S]*?)&lt;\/\1&gt;/g, '<code>$2</code>')
      .replace(/&lt;a href=\"([^\"]+)\" class=\"chat-link\" data-url=\"([^\"]+)\"&gt;([\s\S]*?)&lt;\/a&gt;/g, '<a href="$1" class="chat-link" data-url="$2">$3</a>')
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]
    const line = rawLine.trimEnd()

    // Fenced code blocks: ```lang? ... ``` (allow leading spaces)
    const fenceMatch = line.match(/^\s*```\s*([\w-]+)?\s*$/)
    if (fenceMatch) {
      // Toggle code block state
      if (currentCode) {
        // Closing fence
        flushList(); flushQuote();
        flushCode();
      } else {
        // Opening fence
        flushList(); flushQuote();
        currentCode = { lang: fenceMatch[1], lines: [] }
      }
      continue
    }

    if (currentCode) {
      // Inside code block: preserve verbatim
      currentCode.lines.push(rawLine)
      continue
    }

    // Tables: header | header; separator line; rows (with alignment)
    const headerMatch = line.match(/^\s*\|(.+?)\|\s*$/)
    const sepMatch = i + 1 < lines.length ? lines[i + 1].match(/^\s*\|([\s:|-]+)\|\s*$/) : null
    if (headerMatch && sepMatch) {
      flushList(); flushQuote();
      const headers = headerMatch[1].split('|').map(h => inlineFormat(h.trim()))
      // Determine alignment per column from separator cells
      const alignParts = sepMatch[1].split('|').map(s => s.trim())
      const aligns = alignParts.map(s => {
        const left = s.startsWith(':')
        const right = s.endsWith(':')
        if (left && right) return 'center'
        if (right) return 'right'
        if (left) return 'left'
        return ''
      })
      i += 1 // consume separator
      const rows = []
      while (i + 1 < lines.length) {
        const rowLine = lines[i + 1]
        const rowMatch = rowLine.match(/^\s*\|(.+?)\|\s*$/)
        if (!rowMatch) break
        rows.push(rowMatch[1].split('|').map(c => inlineFormat(c.trim())))
        i += 1
      }
      const thead = `<thead><tr>${headers.map((h, idx) => `<th${aligns[idx] ? ` style=\"text-align:${aligns[idx]}\"` : ''}>${h}</th>`).join('')}</tr></thead>`
      const tbody = rows.length ? `<tbody>${rows.map(r => `<tr>${r.map((c, idx) => `<td${aligns[idx] ? ` style=\"text-align:${aligns[idx]}\"` : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody>` : ''
      htmlParts.push(`<table>${thead}${tbody}</table>`)
      continue
    }

    // Headings: # .. ###### (allow up to 3 leading spaces)
    const headingMatch = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/)
    if (headingMatch) {
      const level = Math.min(6, headingMatch[1].length)
      const content = headingMatch[2]
      flushList(); flushQuote();
      htmlParts.push(`<h${level}>${inlineFormat(content)}</h${level}>`)
      continue
    }

    // Horizontal rule: --- *** ___ (3 or more)
    const hrMatch = line.match(/^\s{0,3}((?:-{3,})|(?:\*{3,})|(?:_{3,}))\s*$/)
    if (hrMatch) {
      flushList(); flushQuote();
      htmlParts.push('<hr>')
      continue
    }

    // Quote: > text (allow up to 3 leading spaces)
    const quoteMatch = line.match(/^\s{0,3}>\s+(.*)$/)
    if (quoteMatch) {
      const content = quoteMatch[1]
      flushList() // Flush any current list before starting quote
      if (!currentQuote) currentQuote = { items: [] }
      currentQuote.items.push(content)
      continue
    }

    // Empty line within quote block (continue quote)
    if (line.trim() === '' && currentQuote) {
      currentQuote.items.push('')
      continue
    }

    // Unordered list item: - item or * item (allow up to 3 leading spaces), support task boxes
    const ulMatch = line.match(/^(\s*)([-*])\s+(.*)$/)
    if (ulMatch) {
      const leading = ulMatch[1].length
      let contentRaw = ulMatch[3]
      // Task box: [ ] or [x]
      const task = contentRaw.match(/^\[( |x|X)\]\s+(.*)$/)
      let content = task ? `<input type=\"checkbox\" disabled ${task[1].toLowerCase()==='x' ? 'checked' : ''}> ${inlineFormat(task[2])}` : inlineFormat(contentRaw)
      const isSub = leading >= 2
      flushQuote() // Flush any current quote before starting list
      if (!currentList) currentList = { type: 'ul', items: [] }
      if (currentList.type !== 'ul') { flushList(); currentList = { type: 'ul', items: [] } }
      if (isSub) {
        if (currentList.items.length === 0) { currentList.items.push('') }
        if (!currentSubListType) {
          currentSubListType = 'ul'
          const lastIdx = currentList.items.length - 1
          currentList.items[lastIdx] += '<ul>'
        } else if (currentSubListType !== 'ul') {
          const lastIdx = currentList.items.length - 1
          currentList.items[lastIdx] += '</ol><ul>'
          currentSubListType = 'ul'
        }
        const lastIdx = currentList.items.length - 1
        currentList.items[lastIdx] += `<li>${content}</li>`
      } else {
        // Closing any open sublist when returning to top-level
        if (currentSubListType && currentList.items.length > 0) {
          const lastIdx = currentList.items.length - 1
          currentList.items[lastIdx] += `</${currentSubListType}>`
          currentSubListType = null
        }
        currentList.items.push(content)
      }
      continue
    }

    // Ordered list item: 1. item (allow up to 3 leading spaces) with start value
    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.*)$/)
    if (olMatch) {
      const leading = olMatch[1].length
      const startVal = parseInt(olMatch[2], 10)
      let contentRaw = olMatch[3]
      // Task box in ordered list (rare but possible)
      const task = contentRaw.match(/^\[( |x|X)\]\s+(.*)$/)
      let content = task ? `<input type=\"checkbox\" disabled ${task[1].toLowerCase()==='x' ? 'checked' : ''}> ${inlineFormat(task[2])}` : inlineFormat(contentRaw)
      const isSub = leading >= 2
      flushQuote() // Flush any current quote before starting list
      if (!currentList) currentList = { type: 'ol', items: [], start: startVal }
      if (currentList.type !== 'ol') { flushList(); currentList = { type: 'ol', items: [], start: startVal } }
      if (currentList.items.length === 0 && Number.isInteger(startVal) && startVal !== 1) {
        currentList.start = startVal
      }
      if (isSub) {
        if (currentList.items.length === 0) { currentList.items.push('') }
        if (!currentSubListType) {
          currentSubListType = 'ol'
          const lastIdx = currentList.items.length - 1
          currentList.items[lastIdx] += '<ol>'
        } else if (currentSubListType !== 'ol') {
          const lastIdx = currentList.items.length - 1
          currentList.items[lastIdx] += '</ul><ol>'
          currentSubListType = 'ol'
        }
        const lastIdx = currentList.items.length - 1
        currentList.items[lastIdx] += `<li>${content}</li>`
      } else {
        if (currentSubListType && currentList.items.length > 0) {
          const lastIdx = currentList.items.length - 1
          currentList.items[lastIdx] += `</${currentSubListType}>`
          currentSubListType = null
        }
        currentList.items.push(content)
      }
      continue
    }

    // Blank line -> paragraph break
    if (line.trim() === '') {
      flushList()
      flushQuote()
      htmlParts.push('<br>')
      continue
    }

    // Normal paragraph line
    flushList()
    flushQuote()
    htmlParts.push(inlineFormat(line))
    
    // Add line break if this isn't the last line and the next line isn't blank
    if (i < lines.length - 1 && lines[i + 1].trim() !== '') {
      htmlParts.push('<br>')
    }
  }
  flushList()
  flushQuote()
  flushCode()

  return htmlParts.join('\n')
}

function renderChat() {
  const renderStartedAt = Date.now()
  // Dedupe: if a Firestore message matches a pending optimistic one, drop the pending
  const serverByTextRole = new Set(messages.map(m => `${m.role}|${m.text}`))
  const filteredPending = pendingMessages.filter(pm => {
    if (pm.status === 'error') return true
    const key = `${pm.role}|${pm.text}`
    return !serverByTextRole.has(key)
  })
  const toRender = [...messages, ...filteredPending]
  const desiredKeys = new Set()

  // Ensure rows exist and are updated, maintaining order without full reflow
  for (let i = 0; i < toRender.length; i++) {
    const msg = toRender[i]
    const key = getMessageKey(msg, i)
    desiredKeys.add(key)

    let row = rowByKey.get(key)
    if (!row) {
      row = createRowForMessage(msg)
      rowByKey.set(key, row)
    } else {
      // Update role class if necessary
      const desiredRowClass = 'w-full flex items-end gap-2 ' + (msg.role === 'user' ? 'justify-end' : 'justify-start')
      if (row.className !== desiredRowClass) row.className = desiredRowClass
      const bubble = row.querySelector('.bubble')
      const desiredBubbleClass = 'bubble no-drag ' + (msg.role === 'user' ? 'bubble-user' : 'bubble-system')
      if (bubble.className !== desiredBubbleClass) bubble.className = desiredBubbleClass
      if (msg.typing) {
        bubble.replaceChildren(createTypingIndicator())
      } else {
        renderMarkdownIntoBubble(bubble, msg.text)
      }
    }

    // Place row at correct position if needed
    const currentAtIndex = chatContainer.children[i]
    if (currentAtIndex !== row) {
      if (currentAtIndex) {
        chatContainer.insertBefore(row, currentAtIndex)
      } else {
        chatContainer.appendChild(row)
      }
    }
  }

  // Remove any rows that are no longer present
  for (const [key, row] of Array.from(rowByKey.entries())) {
    if (!desiredKeys.has(key)) {
      try { row.remove() } catch (e) {}
      rowByKey.delete(key)
    }
  }

  // Hide the message container when empty so the input is visually centered
  chatContainer.style.display = toRender.length > 0 ? '' : 'none'
  updateInputPlaceholder()

  // Show/hide chat notice based on whether there are messages
  if (chatNotice) {
    chatNotice.style.display = toRender.length > 0 ? 'block' : 'none'
  }

  // Update recent chats visibility based on active chat state
  updateRecentChatsVisibility()
  syncMascotPlacement()
  syncMascotState()

  // Event delegation for chat links - handled once at container level

  requestAnimationFrame(() => {
    resizeMascotCanvas()
    const desired = clampOverlayHeight(computeDesiredHeight())
    applyScrollAndClamp(desired)
    sendOverlayHeight(desired)
  })

  const now = Date.now()
  if (!lastOverlayRenderTelemetryAt || (now - lastOverlayRenderTelemetryAt) >= 2500) {
    lastOverlayRenderTelemetryAt = now
    emitTelemetrySignal('overlay_render_end', {
      durationMs: Math.max(0, now - renderStartedAt),
      messageCount: toRender.length,
      overlayVisible: chatVisible ? '1' : '0',
      mascotActive: mascotRive ? '1' : '0'
    })
  }
}

function animateResize(toHeight, opts = {}) {
  const { duration = 180, overshoot = false, onDone } = opts
  const from = lastSentHeight ?? computeDesiredHeight()
  const target = clampOverlayHeight(toHeight)

  const firstTarget = overshoot && target > from ? Math.min(MAX_OVERLAY_HEIGHT, target + 8) : target
  const phases = overshoot && target > from ? [
    { to: firstTarget, dur: Math.round(duration * 0.65) },
    { to: target, dur: Math.round(duration * 0.35) }
  ] : [ { to: target, dur: duration } ]

  let phaseIdx = 0
  let start = performance.now()
  const startFrom = from

  function step(now) {
    const phase = phases[phaseIdx]
    const elapsed = now - start
    const t = Math.min(1, phase.dur === 0 ? 1 : elapsed / phase.dur)
    const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
    const curFrom = phaseIdx === 0 ? startFrom : phases[phaseIdx - 1].to
    const current = Math.round(curFrom + (phase.to - curFrom) * ease)
    sendOverlayHeight(current)

    if (elapsed < phase.dur) {
      requestAnimationFrame(step)
    } else {
      phaseIdx++
      if (phaseIdx < phases.length) {
        start = now
        requestAnimationFrame(step)
      } else {
        if (onDone) onDone()
      }
    }
  }
  requestAnimationFrame(step)
}


function getLastMessageTimestamp() {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const t = m && typeof m.ts === 'number' ? m.ts : undefined
    if (Number.isFinite(t)) return t
  }
  return undefined
}

function resetChatForNewConversation() {
  const wasEmpty = !hasActiveChatMessages()
  if (wasEmpty) {
    return
  }
  resetAssistantAnimationState()
  messages = []
  pendingMessages = []
  includeScreenOnNextMessage = false
  updateIncludeScreenBtn()
  renderChat()
  ipcRenderer.invoke('chat:reset').catch(() => {})
}

function maybeResetChatOnOverlayShow() {
  const lastTs = getLastMessageTimestamp()
  if (!Number.isFinite(lastTs)) return
  if (Date.now() - lastTs >= INACTIVITY_RESET_MS) {
    resetChatForNewConversation()
  }
}


async function addMessageFromInput() {
  const text = input0.value.trim()
  if (!text) return
  breakMascotIdleOverride()
  holdMascotWaitingUntilReply()

  // Capture screenshot if enabled (check BEFORE disabling)
  let images = []
  if (includeScreenOnNextMessage) {
    try {
      const screenshotResult = await ipcRenderer.invoke('chat:capture-screenshot')
      if (screenshotResult.success) {
        images = screenshotResult.images
      } else {
        console.error('[CHAT] Screenshot capture failed:', screenshotResult.error)
        showMascotErrorState()
      }
    } catch (error) {
      console.error('[CHAT] Error capturing screenshot:', error)
      showMascotErrorState()
    }
  }

  // Disable includeScreen after first message
  includeScreenOnNextMessage = false
  updateIncludeScreenBtn()

  // Add optimistic message
  const pendingMessage = { 
    role: 'user', 
    text, 
    ts: Date.now(), 
    status: 'pending',
    id: 'pending-' + Date.now()
  }
  pendingMessages.push(pendingMessage)
  renderChat()

  // Clear input after rendering to ensure stable height calculation
  input0.value = ''
  input0.style.height = MIN_INPUT_HEIGHT + 'px'

  // Send to main window for processing
  ipcRenderer.invoke('chat:send-message', { 
    text, 
    images: images
  }).then((result) => {
    if (!result.success) {
      // Update pending message to show error
      const pendingIndex = pendingMessages.findIndex(m => m.id === pendingMessage.id)
      if (pendingIndex >= 0) {
        pendingMessages[pendingIndex].status = 'error'
        pendingMessages[pendingIndex].text = 'Failed to send: ' + (result.error || 'Unknown error')
        renderChat()
      }
      showMascotErrorState()
    }
  })

  // Auto-expand if collapsed (with stable height)
  if (!chatVisible) {
    chatVisible = true
    // Use requestAnimationFrame to ensure DOM is updated before calculating height
    requestAnimationFrame(() => {
      animateResize(computeDesiredHeight(), { overshoot: true })
    })
  }

  // Schedule typing indicator after a short delay to avoid flicker
  if (typingTimer) { try { clearTimeout(typingTimer) } catch (e) {} }
  typingTimer = setTimeout(() => {
    // Add typing indicator for the current pending reply if not already present
    const hasTyping = pendingMessages.some(m => m && m.typing)
    if (!hasTyping) {
      pendingMessages.push({ role: 'assistant', typing: true, id: 'typing' })
      renderChat()
    }
  }, TYPING_DELAY_MS)
}

// Event listeners
input0.addEventListener('keydown', (e) => {
  breakMascotIdleOverride()
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    addMessageFromInput()
  }
})

input0.addEventListener('input', () => {
  breakMascotIdleOverride()
  updateInputPlaceholder()
})

// Screenshot button functionality
if (includeScreenBtn) {
  includeScreenBtn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    
    // Don't toggle if button is disabled (no permission)
    if (includeScreenBtn.disabled) {
      return;
    }
    
    includeScreenOnNextMessage = !includeScreenOnNextMessage
    breakMascotIdleOverride()
    updateIncludeScreenBtn()
    try { input0.focus() } catch (err) {}
  })
}

function updateIncludeScreenBtn() {
  if (!includeScreenBtn) return
  const inputWrap = input0 ? input0.closest('.input-wrap') : null
  includeScreenBtn.classList.toggle('active', !!includeScreenOnNextMessage)
  includeScreenBtn.setAttribute('aria-pressed', includeScreenOnNextMessage ? 'true' : 'false')
  includeScreenBtn.title = 'Add screenshot'
  includeScreenBtn.setAttribute('aria-label', 'Add screenshot')
  includeScreenBtn.setAttribute('data-tooltip', 'Add screenshot')
  includeScreenBtn.style.display = includeScreenOnNextMessage ? 'none' : 'flex'
  if (screenAttachmentChip) {
    screenAttachmentChip.style.display = includeScreenOnNextMessage ? 'inline-flex' : 'none'
  }
  if (inputWrap) {
    inputWrap.classList.toggle('has-screen-attachment', !!includeScreenOnNextMessage)
  }
  // Update SVG stroke to brand orange when active
  const svg = includeScreenBtn.querySelector('svg')
  if (svg) {
    includeScreenBtn.style.color = includeScreenOnNextMessage
      ? 'var(--dt-color-brand-primary)'
      : 'var(--dt-color-text-subtle)'
    // Force reflow of color for some platforms
    svg.style.color = 'currentColor'
    svg.style.stroke = 'currentColor'
    ;[...svg.querySelectorAll('*')].forEach(n => { n.setAttribute('stroke', 'currentColor'); })
    // Ensure svg aligns center by resetting vertical align
    svg.style.verticalAlign = 'middle'
  }
}

if (screenAttachmentChip) {
  screenAttachmentChip.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    includeScreenOnNextMessage = false
    updateIncludeScreenBtn()
    try { input0.focus() } catch (err) {}
  })
}

input0.addEventListener('input', () => {
  // Do not auto-resize the input; keep fixed height and let it scroll
  // No overlay resize on typing to keep icons/overlay stable
  // Hide recent chats when user starts typing
  if (recentChatsContainer && recentChatsContainer.style.display !== 'none') {
    updateRecentChatsVisibility()
  }
  updateInputPlaceholder()
  syncMascotState()
})

// IPC handlers for communication with main window
ipcRenderer.on('chat:receive-messages', (newMessages) => {
  const previousMessages = messages
  const hasNewAssistant = hasNewAssistantMessage(previousMessages, newMessages)
  messages = newMessages

  const serverUserKeys = new Set(
    newMessages
      .filter((message) => message && message.role === 'user')
      .map((message) => `${message.role}|${message.text}`)
  )
  pendingMessages = pendingMessages.filter((message) => {
    if (!message || message.status === 'error' || message.typing) return true
    if (message.role !== 'user' || message.status !== 'pending') return true
    return !serverUserKeys.has(`${message.role}|${message.text}`)
  })
  
  // If we're receiving an empty array, also clear pending messages to fully clear the chat
  // BUT avoid doing this if we currently have an optimistic user message pending,
  // which can happen when the first message starts a new chat and the server briefly
  // emits an empty snapshot before the message arrives (causing a flicker).
  if (newMessages.length === 0) {
    const hasOptimisticUser = pendingMessages.some(m => m.status === 'pending' && m.role === 'user')
    if (!hasOptimisticUser) {
      pendingMessages = []
      // Clear input field when a new chat is opened from system-side
      input0.value = ''
      input0.style.height = MIN_INPUT_HEIGHT + 'px'
    }
  }

  // If this looks like a system-initiated chat (assistant messages present but no user messages),
  // clear any previous pending local state so we don't mix chats.
  if (newMessages.length > 0) {
    const hasAnyUser = newMessages.some(m => m && m.role === 'user')
    const hasAnyAssistant = newMessages.some(m => m && m.role === 'assistant')
    if (hasAnyAssistant && !hasAnyUser) {
      pendingMessages = []
      input0.value = ''
      input0.style.height = MIN_INPUT_HEIGHT + 'px'
    }
  }
  
  // Only honor assistant requestScreen if it is NEWER than the last user message.
  // This avoids stale assistant requests re-toggling after the user types.
  let lastUserIdx = -1
  for (let i = newMessages.length - 1; i >= 0; i--) {
    const m = newMessages[i]
    if (m && m.role === 'user') { lastUserIdx = i; break }
  }
  let requested = null
  let requestedIdx = -1
  for (let i = newMessages.length - 1; i >= 0; i--) {
    const m = newMessages[i]
    if (m && m.role === 'assistant' && typeof m.requestScreen === 'boolean') {
      requested = m.requestScreen
      requestedIdx = i
      break
    }
  }
  if (requested !== null && requestedIdx > lastUserIdx) {
    includeScreenOnNextMessage = !!requested
    updateIncludeScreenBtn()
  }
  
  // Remove typing indicator only when an assistant message newer than the last user message arrives
  const hasAssistantAfterLastUser = (() => {
    if (lastUserIdx === -1) return newMessages.some(m => m && m.role === 'assistant')
    for (let i = lastUserIdx + 1; i < newMessages.length; i++) {
      const m = newMessages[i]
      if (m && m.role === 'assistant') return true
    }
    return false
  })()
  if (hasAssistantAfterLastUser) {
    const idx = pendingMessages.findIndex(m => m && m.typing)
    if (idx >= 0) {
      pendingMessages.splice(idx, 1)
    }
    if (typingTimer) { try { clearTimeout(typingTimer) } catch (e) {} typingTimer = null }
  }

  renderChat()

  // Incoming assistant replies or proactive pushes are user-visible even if the overlay window
  // never received focus — wake engagement, and show emotion for new coach text.
  if (hasNewAssistant) {
    clearMascotMoodOverride()
    markOverlayEngaged()
    breakMascotIdleOverride()
    const lastMsg = newMessages[newMessages.length - 1]
    if (lastMsg && lastMsg.role === 'assistant') {
      setAssistantWritingState(ASSISTANT_WRITING_HOLD_MS)
      playAssistantEmotion(lastMsg, ASSISTANT_WRITING_HOLD_MS + ASSISTANT_EMOTION_PLAYBACK_MS)
    }
    syncMascotState()
  }

  // Auto-show and expand only when a new assistant message arrives.
  if (hasNewAssistant) {
    // Always ensure the overlay window is visible first, but don't steal focus
    ipcRenderer.send('overlay:show-if-hidden', { noFocus: true })

    // Then expand the chat if it's collapsed (with a small delay to ensure window is ready)
    if (!chatVisible) {
      setTimeout(() => {
        chatVisible = true
        animateResize(computeDesiredHeight(), { overshoot: true })
      }, 100)
    }
  }
})

ipcRenderer.on('chat:message-update', (result) => {
  if (!result.success) {
    // Mark any pending message as error, but do not remove optimistic UI yet
    const pendingMessage = pendingMessages.find(m => m.status === 'pending')
    if (pendingMessage) {
      pendingMessage.status = 'error'
      pendingMessage.text = 'Failed to send: ' + (result.error || 'Unknown error')
      renderChat()
    }
    showMascotErrorState()
  }
  // On success, keep optimistic message until Firestore snapshot includes the new message
})

// Handle recent chats list updates
ipcRenderer.on('chat:recent-chats-updated', (newRecentChats) => {
  recentChats = Array.isArray(newRecentChats) ? newRecentChats : []
  recentChatsPage = 0
  updateRecentChatsVisibility()
})

// Handle chat load result
ipcRenderer.on('chat:load-chat-result', (result) => {
  isLoadingChat = false
  breakMascotIdleOverride()
  syncMascotState()
  if (result.success) {
    // Chat loading is successful, messages will arrive via chat:receive-messages
  } else {
    console.error('[CHAT] Failed to load chat:', result.error)
    showMascotErrorState()
    updateRecentChatsVisibility()
  }
})

function formatChatHistoryForFeedback() {
  const history = messages
    .concat(pendingMessages)
    .filter((message) => message && !message.typing && typeof message.text === 'string' && message.text.trim())
    .slice(-FEEDBACK_HISTORY_MESSAGE_LIMIT)

  if (history.length === 0) {
    return 'Issue report from chat\n\nChat history:\nNo chat messages yet.'
  }

  const lines = history.map((message) => {
    const role = message.role === 'assistant' ? 'Don' : message.role === 'user' ? 'User' : 'Message'
    const status = message.status === 'pending' ? ' (pending)' : message.status === 'error' ? ' (error)' : ''
    return `${role}${status}: ${message.text.trim()}`
  })

  let feedbackText = `Issue report from chat\n\nChat history:\n${lines.join('\n\n')}`
  if (feedbackText.length > FEEDBACK_HISTORY_CHAR_LIMIT) {
    feedbackText = feedbackText.slice(0, FEEDBACK_HISTORY_CHAR_LIMIT).trimEnd() + '\n\n[Chat history truncated]'
  }
  return feedbackText
}

function hideOverlayTooltip() {
  if (tooltipHideTimer) {
    try { clearTimeout(tooltipHideTimer) } catch (e) {}
    tooltipHideTimer = null
  }
  if (overlayTooltip) overlayTooltip.classList.remove('visible')
}

function showOverlayTooltip(target) {
  if (!overlayTooltip || !target) return
  const text = target.getAttribute('data-tooltip') || target.getAttribute('aria-label') || target.getAttribute('title')
  if (!text) return
  if (tooltipHideTimer) {
    try { clearTimeout(tooltipHideTimer) } catch (e) {}
    tooltipHideTimer = null
  }
  overlayTooltip.textContent = text
  const rect = target.getBoundingClientRect()
  overlayTooltip.style.left = '0px'
  overlayTooltip.style.top = '0px'
  overlayTooltip.style.transform = 'translate(-50%, -100%)'
  overlayTooltip.classList.add('visible')

  const margin = 8
  const tooltipWidth = overlayTooltip.offsetWidth || 0
  const tooltipHeight = overlayTooltip.offsetHeight || 0
  const minLeft = margin + tooltipWidth / 2
  const maxLeft = Math.max(minLeft, window.innerWidth - margin - tooltipWidth / 2)
  const left = Math.min(Math.max(rect.left + rect.width / 2, minLeft), maxLeft)
  const canShowAbove = rect.top - margin - tooltipHeight >= margin
  let top
  if (canShowAbove) {
    top = rect.top - margin
    overlayTooltip.style.transform = 'translate(-50%, -100%)'
  } else {
    top = Math.min(rect.bottom + margin, Math.max(margin, window.innerHeight - margin - tooltipHeight))
    overlayTooltip.style.transform = 'translate(-50%, 0)'
  }
  overlayTooltip.style.left = `${left}px`
  overlayTooltip.style.top = `${top}px`
}

function setupOverlayTooltips() {
  if (!overlayTooltip || !overlayRoot) return
  const tooltipTargets = overlayRoot.querySelectorAll('[data-tooltip]')
  tooltipTargets.forEach((target) => {
    target.addEventListener('mouseenter', () => {
      tooltipHideTimer = setTimeout(() => showOverlayTooltip(target), 250)
    })
    target.addEventListener('mouseleave', hideOverlayTooltip)
    target.addEventListener('focus', () => showOverlayTooltip(target))
    target.addEventListener('blur', hideOverlayTooltip)
    target.addEventListener('click', hideOverlayTooltip)
  })
}

// UI event handlers
if (closeOverlayBtn) {
  closeOverlayBtn.addEventListener('click', () => {
    ipcRenderer.send('overlay:hide')
  })
}

if (openAppBtn) {
  openAppBtn.addEventListener('click', () => {
    ipcRenderer.send('overlay:open-main', 'dashboard')
  })
}

if (clearBtn) {
  clearBtn.addEventListener('click', () => {
    resetChatForNewConversation()
  })
}

if (reportIssueBtn) {
  reportIssueBtn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    ipcRenderer.send('feedback:open-with-chat-history', {
      text: formatChatHistoryForFeedback()
    })
  })
}

// Focus input when window gains focus
window.addEventListener('focus', () => {
  markOverlayEngaged()
  try {
    // Run inactivity reset and focus input on window focus
    maybeResetChatOnOverlayShow()
    input0.focus()
    const len = (input0.value || '').length
    input0.setSelectionRange(len, len)
    
    // When window gains focus, force the native overlay height back to the
    // rendered chat height. The BrowserWindow can be hidden/re-shown outside
    // this renderer, leaving lastSentHeight stale.
    restoreChatHeightIfNeeded()
    
    // Request recent chats list when overlay opens
    if (!hasActiveChatMessages()) {
      ipcRenderer.invoke('chat:get-recent-chats').catch(() => {})
    }
  } catch (e) {}
})

// Handle ESC key to close overlay
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault()
    ipcRenderer.send('overlay:hide')
  }
})

// Update close tooltip for platform
try {
  const closeBtn = document.getElementById('closeOverlayBtn')
  if (closeBtn) {
    closeBtn.title = 'Close Chat'
    closeBtn.setAttribute('aria-label', 'Close Chat')
    closeBtn.setAttribute('data-tooltip', 'Close Chat')
  }
} catch (e) {}



function renderRecentChatsList() {
  if (!recentChatsContainer) return

  const hasActiveChat = hasActiveChatMessages()
  if (hasActiveChat || isLoadingChat) {
    recentChatsContainer.style.display = 'none'
    // Trigger height recalculation after hiding
    requestAnimationFrame(() => {
      const desired = clampOverlayHeight(computeDesiredHeight())
      applyScrollAndClamp(desired)
      sendOverlayHeight(desired)
    })
    return
  }

  if (recentChats.length === 0) {
    recentChatsContainer.style.display = 'none'
    return
  }

  recentChatsContainer.style.display = 'block'

  const endIndex = Math.min((recentChatsPage + 1) * CHATS_PER_PAGE, recentChats.length)
  const chatsToShow = recentChats.slice(0, endIndex)
  const hasMore = endIndex < recentChats.length

  const rowEl = document.createElement('div')
  rowEl.className = 'recent-chats-row'

  const labelEl = document.createElement('span')
  labelEl.className = 'recent-chats-label'
  labelEl.textContent = 'Chats:'

  const listEl = document.createElement('div')
  listEl.className = 'recent-chats-list'

  chatsToShow.forEach((chat) => {
    let preview = chat.previewText || 'New conversation'
    // Truncate to max 30 characters and add ellipsis
    const MAX_PREVIEW_LENGTH = 30
    if (preview.length > MAX_PREVIEW_LENGTH) {
      preview = preview.substring(0, MAX_PREVIEW_LENGTH) + '...'
    }

    const chatItem = document.createElement('div')
    chatItem.className = 'recent-chat-item'
    if (chat && chat.id != null) {
      chatItem.dataset.chatId = String(chat.id)
    }

    const previewEl = document.createElement('span')
    previewEl.className = 'recent-chat-preview'
    previewEl.textContent = preview

    chatItem.appendChild(previewEl)
    listEl.appendChild(chatItem)
  })

  rowEl.appendChild(labelEl)
  rowEl.appendChild(listEl)
  recentChatsContainer.replaceChildren(rowEl)

  // Infinite scroll detection and drag scrolling - attach listener to the scrollable list (horizontal scroll)
  if (listEl) {
    // Add drag scrolling support (re-add each time since innerHTML replaces the element)
    let isDragging = false
    let startX = 0
    let scrollLeft = 0
    let dragDistance = 0

    listEl.addEventListener('mousedown', (e) => {
      isDragging = true
      dragDistance = 0
      startX = e.pageX - listEl.offsetLeft
      scrollLeft = listEl.scrollLeft
      listEl.style.cursor = 'grabbing'
    })

    listEl.addEventListener('mouseleave', () => {
      isDragging = false
      listEl.style.cursor = 'grab'
    })

    listEl.addEventListener('mouseup', (e) => {
      // Only trigger click if we didn't drag much (less than 5px movement)
      if (isDragging && Math.abs(dragDistance) < 5) {
        const chatItem = e.target.closest('.recent-chat-item')
        if (chatItem) {
          const chatId = chatItem.getAttribute('data-chat-id')
          if (chatId && !isLoadingChat) {
            loadChatById(chatId)
          }
        }
      }
      isDragging = false
      dragDistance = 0
      listEl.style.cursor = 'grab'
    })

    listEl.addEventListener('mousemove', (e) => {
      if (!isDragging) return
      e.preventDefault()
      const x = e.pageX - listEl.offsetLeft
      const walk = (x - startX) * 2
      dragDistance = walk
      listEl.scrollLeft = scrollLeft - walk
    })

    // Prevent text selection while dragging
    listEl.addEventListener('selectstart', (e) => {
      if (isDragging) {
        e.preventDefault()
      }
    })

    if (hasMore) {
      listEl.addEventListener('scroll', () => {
        if (listEl.scrollWidth - listEl.scrollLeft - listEl.clientWidth < 50) {
          loadMoreRecentChats()
        }
      })
    }
  }

  // Recalculate height after rendering to account for recent chats container
  requestAnimationFrame(() => {
    const desired = clampOverlayHeight(computeDesiredHeight())
    applyScrollAndClamp(desired)
    sendOverlayHeight(desired)
  })
}

function loadMoreRecentChats() {
  if ((recentChatsPage + 1) * CHATS_PER_PAGE < recentChats.length) {
    recentChatsPage++
    renderRecentChatsList()
  }
}

function updateRecentChatsVisibility() {
  const hasActiveChat = hasActiveChatMessages()
  if (hasActiveChat || isLoadingChat) {
    if (recentChatsContainer) {
      recentChatsContainer.style.display = 'none'
    }
  } else {
    renderRecentChatsList()
  }
}


async function loadChatById(chatId) {
  if (isLoadingChat || !chatId) return
  
  breakMascotIdleOverride()
  activeWaitingMood = null
  isLoadingChat = true
  updateRecentChatsVisibility()
  syncMascotState()
  
  try {
    const result = await ipcRenderer.invoke('chat:load-chat', chatId)
    if (!result.success) {
      console.error('[CHAT] Failed to load chat:', result.error)
      isLoadingChat = false
      updateRecentChatsVisibility()
    }
    // Success will be handled by chat:load-chat-result IPC
  } catch (error) {
    console.error('[CHAT] Error loading chat:', error)
    showMascotErrorState()
    isLoadingChat = false
    updateRecentChatsVisibility()
    syncMascotState()
  }
}

function setRecordingPausedState(isPaused) {
  recordingPaused = !!isPaused
  syncMascotState()
}

ipcRenderer.invoke('getInitialPauseState')
  .then((isPaused) => setRecordingPausedState(isPaused))
  .catch(() => {})

ipcRenderer.on('pauseStateChanged', (isPaused) => {
  setRecordingPausedState(isPaused)
})

function setupOverlayWindowDrag() {
  if (!overlayCard || !ipcRenderer?.send) return
  let drag = null

  function endDrag() {
    if (drag && drag.pointerId != null) {
      try {
        overlayCard.releasePointerCapture(drag.pointerId)
      } catch (_) {}
    }
    drag = null
  }

  overlayCard.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    if (e.target.closest('.no-drag')) return
    if (chatContainer && chatContainer.contains(e.target)) {
      const r = chatContainer.getBoundingClientRect()
      if (e.clientX >= r.right - 14) return
    }
    e.preventDefault()
    drag = { pointerId: e.pointerId, x: e.screenX, y: e.screenY }
    try {
      overlayCard.setPointerCapture(e.pointerId)
    } catch (_) {}
  })

  window.addEventListener(
    'pointermove',
    (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return
      const dx = e.screenX - drag.x
      const dy = e.screenY - drag.y
      drag.x = e.screenX
      drag.y = e.screenY
      if (dx || dy) ipcRenderer.send('overlay:move-by', { dx, dy })
    },
    true
  )

  window.addEventListener('pointerup', endDrag, true)
  window.addEventListener('pointercancel', endDrag, true)
}

// Initialize
if (overlayRoot) {
  overlayRoot.addEventListener(
    'pointerdown',
    () => {
      markOverlayEngaged()
      breakMascotIdleOverride()
      syncMascotState()
    },
    true
  )
  overlayRoot.addEventListener(
    'focusin',
    () => {
      markOverlayEngaged()
      breakMascotIdleOverride()
    },
    true
  )
  overlayRoot.addEventListener('pointermove', (event) => {
    const bounds = overlayRoot.getBoundingClientRect()
    if (!bounds.width) return
    const position = ((event.clientX - bounds.left) / bounds.width - 0.5) * 2
    setMascotLidsMove(position)
  })
  overlayRoot.addEventListener('pointerleave', () => {
    setMascotLidsMove(0)
  })
}

window.addEventListener('resize', () => {
  resizeMascotCanvas()
})

document.addEventListener('visibilitychange', () => {
  const wasVisible = lastDocumentVisibilityState === 'visible'
  const isVisible = document.visibilityState === 'visible'
  lastDocumentVisibilityState = document.visibilityState

  if (!isVisible) {
    overlayWindowActive = false
    syncPromptAnimation()
    syncMascotState()
    return
  }

  syncPromptAnimation()
  if (!wasVisible) {
    markOverlayEngaged()
    playMascotOpenSequence()
  }
})

initMascot()
updateIncludeScreenBtn()
renderChat()
setupOverlayTooltips()
setupOverlayWindowDrag()
