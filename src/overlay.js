const { ipcRenderer } = require('electron')

const root = document.getElementById('overlayRoot')
const input0 = document.getElementById('chatInput')
const openAppBtn = document.getElementById('openAppBtn')
const closeOverlayBtn = document.getElementById('closeOverlayBtn')
const clearBtn = document.getElementById('clearBtn')
// No speech bubble; notifications are rendered as system chat messages
const chatContainer = document.getElementById('chatContainer')

let messages = []
let chatVisible = false
let lastSentHeight = null

// No persistence in testing mode; keep everything in-memory

function computeDesiredHeight() {
  const inputH = input0.offsetHeight || 18
  const chrome = 16
  // Use scrollHeight to include all bubble content
  const chatH = chatContainer.scrollHeight
  return chatH + inputH + chrome
}

function applyScrollAndClamp(desired) {
  const inputH = input0.offsetHeight || 18
  const chrome = 16
  const MAX_H = 600
  // Because input is absolutely positioned, chat available height is full desired minus input row
  const maxChat = Math.max(0, Math.min(desired, MAX_H) - inputH - chrome)
  chatContainer.style.maxHeight = maxChat + 'px'
  chatContainer.style.overflowY = desired > MAX_H ? 'auto' : 'hidden'
  chatContainer.scrollTop = chatContainer.scrollHeight
}

function renderChat() {
  chatContainer.innerHTML = ''
  messages.forEach((m) => {
    const row = document.createElement('div')
    row.className = 'w-full flex ' + (m.role === 'user' ? 'justify-end' : 'justify-start')
    const bubble = document.createElement('div')
    bubble.className = 'bubble ' + (m.role === 'user' ? 'bubble-user' : 'bubble-system')
    bubble.textContent = m.text
    row.appendChild(bubble)
    chatContainer.appendChild(row)
  })
  // Always keep chat container rendered so layout is accurate; we control height via animation
  chatContainer.style.display = ''
  // Compute height on next frame to ensure DOM is laid out
  requestAnimationFrame(() => {
    const desired = computeDesiredHeight()
    applyScrollAndClamp(desired)
    lastSentHeight = desired
    ipcRenderer.send('overlay:resize', desired)
  })
}

function animateResize(toHeight, opts = {}) {
  const { duration = 180, overshoot = false, onDone } = opts
  const from = lastSentHeight ?? computeDesiredHeight()
  const target = Math.max(40, Math.min(600, toHeight))

  // Optional small overshoot for expansion
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
    // Ease in-out cubic
    const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
    const curFrom = phaseIdx === 0 ? startFrom : phases[phaseIdx - 1].to
    const current = Math.round(curFrom + (phase.to - curFrom) * ease)
    lastSentHeight = current
    ipcRenderer.send('overlay:resize', current)

    if (t < 1) {
      requestAnimationFrame(step)
    } else if (phaseIdx < phases.length - 1) {
      phaseIdx += 1
      start = performance.now()
      requestAnimationFrame(step)
    } else {
      if (typeof onDone === 'function') onDone()
    }
  }

  requestAnimationFrame(step)
}

function collapseChatAnimated() {
  if (!chatVisible) return
  // Immediately collapse without animation
  const inputH = input0.offsetHeight || 18
  const chrome = 16
  const targetH = inputH + chrome
  chatVisible = false
  chatContainer.style.display = 'none'
  chatContainer.style.overflowY = ''
  lastSentHeight = targetH
  ipcRenderer.send('overlay:resize', targetH)
}

function showOrGrowChat() {
  const wasCollapsed = !chatVisible
  if (!chatVisible) {
    chatVisible = true
    chatContainer.style.display = ''
  }
  renderChat()
  requestAnimationFrame(() => {
    const target = computeDesiredHeight()
    animateResize(target, { overshoot: wasCollapsed, duration: 200 })
  })
}

function showSystemMessage(text) {
  messages.push({ role: 'system', text, ts: Date.now() })
  renderChat()
}

function addMessageFromInput(el) {
  const v = (el.value || '').trim()
  if (!v) return
  el.value = ''
  // Append to chat as our own message
  messages.push({ role: 'user', text: v, ts: Date.now() })
  // Testing: add a random system response
  const canned = [
    'Got it. I\'ll keep an eye on that.',
    'Okay, noted.',
    'Sounds good. Let\'s do it.',
    'Acknowledged.',
    'Thanks, I\'ll remind you if needed.'
  ]
  const reply = canned[Math.floor(Math.random() * canned.length)]
  messages.push({ role: 'system', text: reply, ts: Date.now() })
  // Show chat and animate expansion (or grow if already visible)
  showOrGrowChat()
}

// Auto-resize textarea to 1-2 lines, notify main to resize window height
function autoresize() {
  input0.style.height = 'auto'
  const maxLines = 2
  const lineHeight = 14 // approx for 10px text
  const scrollH = input0.scrollHeight
  const target = Math.min(scrollH, maxLines * lineHeight + 6)
  input0.style.height = target + 'px'
  // Do not change overlay window height while typing
}

input0.addEventListener('input', autoresize)
input0.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    addMessageFromInput(input0)
  } else if (e.key === 'Escape') {
    // Hide overlay on Escape
    ipcRenderer.send('overlay:hide')
  }
})

openAppBtn.addEventListener('click', () => {
  ipcRenderer.send('overlay:open-main', 'dashboard')
  // Hide chat when interacting outside
  collapseChatAnimated()
})

// Handle click vs drag on overlay card
let isDragging = false
let dragStartTime = 0

document.addEventListener('pointerdown', (e) => {
  const within = e.target.closest('.overlay-card')
  if (!within) {
    collapseChatAnimated()
    return
  }
  
  // Start tracking for drag detection
  isDragging = false
  dragStartTime = Date.now()
  
  const handlePointerMove = () => {
    isDragging = true
  }
  
  const handlePointerUp = () => {
    // If it was a short click (not drag) and we have messages, expand
    if (!isDragging && Date.now() - dragStartTime < 200 && messages.length > 0) {
      showOrGrowChat()
    }
    
    document.removeEventListener('pointermove', handlePointerMove)
    document.removeEventListener('pointerup', handlePointerUp)
  }
  
  document.addEventListener('pointermove', handlePointerMove)
  document.addEventListener('pointerup', handlePointerUp)
}, true)

ipcRenderer.on('overlay:collapse', () => {
  collapseChatAnimated()
})

ipcRenderer.on('overlay:maybeExpand', () => {
  if (messages.length > 0) {
    showOrGrowChat()
  }
})

closeOverlayBtn.addEventListener('click', () => {
  ipcRenderer.send('overlay:hide')
})

clearBtn.addEventListener('click', () => {
  messages = []
  chatContainer.innerHTML = ''
  collapseChatAnimated()
})

// removed explicit minimize button logic (auto-collapse handles this)

ipcRenderer.on('overlay:notify', (event, { title, body }) => {
  showSystemMessage(body || title || 'Notification')
  // Expand to show the system message
  chatVisible = true
  chatContainer.style.display = ''
  requestAnimationFrame(() => {
    const target = computeDesiredHeight()
    animateResize(target)
  })
})

// Focus chat input when requested by main
ipcRenderer.on('overlay:focus-input', () => {
  try {
    input0.focus()
    // Place caret at end
    const len = (input0.value || '').length
    input0.setSelectionRange(len, len)
  } catch (e) {}
})

// No state updates needed here currently

function bootstrap() {
  // Start collapsed
  chatVisible = false
  chatContainer.style.display = 'none'
  const inputH = input0.offsetHeight || 18
  const chrome = 16
  lastSentHeight = inputH + chrome
  ipcRenderer.send('overlay:resize', lastSentHeight)
  autoresize()
  // Ensure focusing input when window gains focus (e.g., opened)
  window.addEventListener('focus', () => {
    try {
      input0.focus()
      const len = (input0.value || '').length
      input0.setSelectionRange(len, len)
    } catch (e) {}
  })
  // Try initial state from main for icon
  // no state button anymore
}

bootstrap()


