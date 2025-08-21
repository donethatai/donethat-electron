

const { ipcRenderer } = require('electron')

const input0 = document.getElementById('chatInput')
const includeScreenBtn = document.getElementById('includeScreenBtn')
const openAppBtn = document.getElementById('openAppBtn')
const closeOverlayBtn = document.getElementById('closeOverlayBtn')
const clearBtn = document.getElementById('clearBtn')
const chatContainer = document.getElementById('chatContainer')

let messages = []
let chatVisible = false
let lastSentHeight = null
let includeScreenOnNextMessage = true
const MIN_INPUT_HEIGHT = 28

// Simple UI state
let pendingMessages = []
// Keep a stable mapping from message keys to DOM rows to minimize reflows/flicker
const rowByKey = new Map()

function getMessageKey(message, index) {
  return message.id || message.ts || `idx-${index}`
}

function createRowForMessage(message) {
  const row = document.createElement('div')
  row.className = 'w-full flex ' + (message.role === 'user' ? 'justify-end' : 'justify-start')
  const bubble = document.createElement('div')
  bubble.className = 'bubble no-drag ' + (message.role === 'user' ? 'bubble-user' : 'bubble-system')
  bubble.innerHTML = parseMarkdown(message.text)
  row.appendChild(bubble)
  return row
}

function computeDesiredHeight() {
  // Use a stable input height to prevent flicker during typing
  const inputH = Math.max(MIN_INPUT_HEIGHT, input0.scrollHeight || MIN_INPUT_HEIGHT)
  const chrome = 16
  const chatH = chatContainer.scrollHeight
  return chatH + inputH + chrome
}

function applyScrollAndClamp(desired) {
  const inputH = input0.offsetHeight || 18
  const chrome = 16
  const MAX_H = 600
  const maxChat = Math.max(0, Math.min(desired, MAX_H) - inputH - chrome)
  chatContainer.style.maxHeight = maxChat + 'px'
  chatContainer.style.overflowY = desired > MAX_H ? 'auto' : 'hidden'
  chatContainer.scrollTop = chatContainer.scrollHeight
}

// Simple markdown parser for chat bubbles (supports bold, italic, code, lists)
function parseMarkdown(text) {
  if (!text) return ''

  // Normalize newlines
  const normalized = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  const lines = normalized.split('\n')
  const htmlParts = []

  let currentList = null // { type: 'ul'|'ol', items: [] }
  function flushList() {
    if (currentList && currentList.items.length > 0) {
      const items = currentList.items.map(it => `<li>${inlineFormat(it)}</li>`).join('')
      htmlParts.push(`<${currentList.type}>${items}</${currentList.type}>`)
    }
    currentList = null
  }

  function inlineFormat(s) {
    return String(s)
      // Escape basic HTML first to avoid injection; allow simple markup to be reintroduced below
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      // Bold: **text** or __text__
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/__(.*?)__/g, '<strong>$1</strong>')
      // Italic: *text* or _text_
      .replace(/(^|[^*])\*(.*?)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/(^|[^_])_(.*?)_(?!_)/g, '$1<em>$2</em>')
      // Code: `text`
      .replace(/`([^`]+)`/g, '<code>$1</code>')
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()

    // Unordered list item: - item or * item
    const ulMatch = line.match(/^[-*]\s+(.*)$/)
    if (ulMatch) {
      const content = ulMatch[1]
      if (!currentList) currentList = { type: 'ul', items: [] }
      if (currentList.type !== 'ul') { flushList(); currentList = { type: 'ul', items: [] } }
      currentList.items.push(content)
      continue
    }

    // Ordered list item: 1. item
    const olMatch = line.match(/^\d+\.\s+(.*)$/)
    if (olMatch) {
      const content = olMatch[1]
      if (!currentList) currentList = { type: 'ol', items: [] }
      if (currentList.type !== 'ol') { flushList(); currentList = { type: 'ol', items: [] } }
      currentList.items.push(content)
      continue
    }

    // Blank line -> paragraph break
    if (line.trim() === '') {
      flushList()
      htmlParts.push('<br>')
      continue
    }

    // Normal paragraph line
    flushList()
    htmlParts.push(inlineFormat(line))
  }
  flushList()

  return htmlParts.join('\n')
}

function renderChat() {
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
      const desiredRowClass = 'w-full flex ' + (msg.role === 'user' ? 'justify-end' : 'justify-start')
      if (row.className !== desiredRowClass) row.className = desiredRowClass
      const bubble = row.querySelector('.bubble')
      const desiredBubbleClass = 'bubble no-drag ' + (msg.role === 'user' ? 'bubble-user' : 'bubble-system')
      if (bubble.className !== desiredBubbleClass) bubble.className = desiredBubbleClass
      const newHtml = parseMarkdown(msg.text)
      if (bubble.innerHTML !== newHtml) bubble.innerHTML = newHtml
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

  requestAnimationFrame(() => {
    const desired = computeDesiredHeight()
    applyScrollAndClamp(desired)
    if (desired !== lastSentHeight) {
      lastSentHeight = desired
      ipcRenderer.send('overlay:resize', desired)
    }
  })
}

function animateResize(toHeight, opts = {}) {
  const { duration = 180, overshoot = false, onDone } = opts
  const from = lastSentHeight ?? computeDesiredHeight()
  const target = Math.max(40, Math.min(600, toHeight))

  const firstTarget = overshoot && target > from ? Math.min(600, target + 8) : target
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
    lastSentHeight = current
    ipcRenderer.send('overlay:resize', current)

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


async function addMessageFromInput() {
  const text = input0.value.trim()
  if (!text) return

  // Capture screenshot if enabled (check BEFORE disabling)
  let images = []
  if (includeScreenOnNextMessage) {
    try {
      const screenshotResult = await ipcRenderer.invoke('chat:capture-screenshot')
      if (screenshotResult.success) {
        images = screenshotResult.images
      } else {
        console.error('[CHAT] Screenshot capture failed:', screenshotResult.error)
      }
    } catch (error) {
      console.error('[CHAT] Error capturing screenshot:', error)
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
}

// Event listeners
input0.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    addMessageFromInput()
  }
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
    updateIncludeScreenBtn()
    try { input0.focus() } catch (err) {}
  })
}

function updateIncludeScreenBtn() {
  if (!includeScreenBtn) return
  includeScreenBtn.classList.toggle('active', !!includeScreenOnNextMessage)
  includeScreenBtn.setAttribute('aria-pressed', includeScreenOnNextMessage ? 'true' : 'false')
  includeScreenBtn.title = includeScreenOnNextMessage ? 'Including screen' : 'Not including screen'
  // Update SVG stroke to brand orange when active
  const svg = includeScreenBtn.querySelector('svg')
  if (svg) {
    includeScreenBtn.style.color = includeScreenOnNextMessage ? 'var(--color-primary)' : '#111'
    // Force reflow of color for some platforms
    svg.style.color = 'currentColor'
    svg.style.stroke = 'currentColor'
    ;[...svg.querySelectorAll('*')].forEach(n => { n.setAttribute('stroke', 'currentColor'); })
    // Ensure svg aligns center by resetting vertical align
    svg.style.verticalAlign = 'middle'
  }
}

input0.addEventListener('input', () => {
  // Update input height without triggering layout recalculations
  const newHeight = Math.max(MIN_INPUT_HEIGHT, input0.scrollHeight)
  if (Math.abs(parseInt(input0.style.height) - newHeight) > 1) {
    input0.style.height = newHeight + 'px'
    // Only resize if the height actually changed significantly
    if (chatVisible) {
      const desired = computeDesiredHeight()
      if (Math.abs(desired - (lastSentHeight || 0)) > 5) {
        animateResize(desired, { duration: 120 })
      }
    }
  }
})

// IPC handlers for communication with main window
ipcRenderer.on('chat:receive-messages', (event, newMessages) => {
  messages = newMessages
  renderChat()
  
  // Auto-show and expand if new messages arrive
  if (newMessages.length > 0) {
    // Always ensure the overlay window is visible first
    ipcRenderer.send('overlay:show-if-hidden')
    
    // Then expand the chat if it's collapsed (with a small delay to ensure window is ready)
    if (!chatVisible) {
      setTimeout(() => {
        chatVisible = true
        animateResize(computeDesiredHeight(), { overshoot: true })
      }, 100)
    }
  }
})

ipcRenderer.on('chat:message-update', (event, result) => {
  if (!result.success) {
    // Mark any pending message as error, but do not remove optimistic UI yet
    const pendingMessage = pendingMessages.find(m => m.status === 'pending')
    if (pendingMessage) {
      pendingMessage.status = 'error'
      pendingMessage.text = 'Failed to send: ' + (result.error || 'Unknown error')
      renderChat()
    }
  }
  // On success, keep optimistic message until Firestore snapshot includes the new message
})

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
    messages = []
    pendingMessages = []
    // Reset screenshot state for new chat
    includeScreenOnNextMessage = true
    updateIncludeScreenBtn()
    renderChat()
    ipcRenderer.send('overlay:resize', 40)
    chatVisible = false
    
    // Reset chat state in main process so next message creates a new chat
    ipcRenderer.invoke('chat:reset').catch(error => {
      console.error('[CHAT] Error resetting chat state:', error)
    })
  })
}

// Focus input when window gains focus
window.addEventListener('focus', () => {
  try {
    input0.focus()
    const len = (input0.value || '').length
    input0.setSelectionRange(len, len)
    
    // When window gains focus, ensure chat is visible if there are messages
    if (messages.length > 0 && !chatVisible) {
      chatVisible = true
      animateResize(computeDesiredHeight(), { overshoot: true })
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
  const isMac = navigator.platform.toUpperCase().includes('MAC')
  const closeBtn = document.getElementById('closeOverlayBtn')
  if (closeBtn) {
    closeBtn.title = `Close chat (Esc, ${isMac ? 'Cmd' : 'Ctrl'}+Shift+D)`
  }
} catch (e) {}



// Initialize
updateIncludeScreenBtn()
renderChat()














