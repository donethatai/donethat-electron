

const ipcRenderer = window.electronAPI;
// routeLink is now loaded globally via script tag in chat.html

ipcRenderer.on('liquid-glass-active', () => {
  document.documentElement.classList.add('liquid-glass-active')
})

const input0 = document.getElementById('chatInput')
const includeScreenBtn = document.getElementById('includeScreenBtn')
const openAppBtn = document.getElementById('openAppBtn')
const closeOverlayBtn = document.getElementById('closeOverlayBtn')
const clearBtn = document.getElementById('clearBtn')
const chatContainer = document.getElementById('chatContainer')
const recentChatsContainer = document.getElementById('recentChatsContainer')
const chatNotice = document.getElementById('chatNotice')

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
let includeScreenOnNextMessage = true
const MIN_INPUT_HEIGHT = 28
let typingTimer = null
const TYPING_DELAY_MS = 300
const INACTIVITY_RESET_MS = 10 * 60 * 1000

// Simple UI state
let pendingMessages = []
// Keep a stable mapping from message keys to DOM rows to minimize reflows/flicker
const rowByKey = new Map()

// Recent chats state
let recentChats = []
let recentChatsPage = 0
const CHATS_PER_PAGE = 3
let isLoadingChat = false

function getMessageKey(message, index) {
  return message.id || message.ts || `idx-${index}`
}

function createRowForMessage(message) {
  const row = document.createElement('div')
  row.className = 'w-full flex ' + (message.role === 'user' ? 'justify-end' : 'justify-start')
  const bubble = document.createElement('div')
  bubble.className = 'bubble no-drag ' + (message.role === 'user' ? 'bubble-user' : 'bubble-system')
  if (message.typing) {
    bubble.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>'
  } else {
    bubble.innerHTML = parseMarkdown(message.text)
  }
  row.appendChild(bubble)
  return row
}

function computeDesiredHeight() {
  // Input box is COMPLETELY FIXED - always the same height
  const inputH = MIN_INPUT_HEIGHT
  const chrome = 16
  const chatH = chatContainer.scrollHeight
  // Add fixed height for recent chats container if visible (super short, 24px + 4px margin)
  const recentChatsH = (recentChatsContainer && recentChatsContainer.style.display !== 'none') ? 28 : 0
  // Add fixed height for chat notice if visible (only when there are messages)
  const noticeH = (chatNotice && chatNotice.style.display !== 'none') ? (chatNotice.offsetHeight || 16) : 0
  return chatH + inputH + chrome + recentChatsH + noticeH
}

function applyScrollAndClamp(desired) {
  // Input box is COMPLETELY FIXED - always the same height
  const inputH = MIN_INPUT_HEIGHT
  const chrome = 16
  const MAX_H = 600
  // Fixed height for recent chats container if visible (super short, 24px + 4px margin)
  const recentChatsH = (recentChatsContainer && recentChatsContainer.style.display !== 'none') ? 28 : 0
  // Fixed height for chat notice if visible
  const noticeH = (chatNotice && chatNotice.style.display !== 'none') ? (chatNotice.offsetHeight || 16) : 0
  const maxChat = Math.max(0, Math.min(desired, MAX_H) - inputH - chrome - recentChatsH - noticeH)
  chatContainer.style.maxHeight = maxChat + 'px'
  chatContainer.style.overflowY = desired > MAX_H ? 'auto' : 'hidden'
  chatContainer.scrollTop = chatContainer.scrollHeight
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
      .replace(/<((?:https?:\/\/|mailto:)[^\s>]+)>/g, '<a href="$1" class="chat-link" data-url="$1">$1</a>')
      // Plain emails -> mailto links
      .replace(/\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, '<a href="mailto:$1" class="chat-link" data-url="mailto:$1">$1</a>')
      // Markdown links: [text](url) FIRST
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="chat-link" data-url="$2">$1</a>')
      // Plain URLs (including donethat://) AFTER markdown links, avoid matching inside attributes
      .replace(/(^|[^"'>=])((?:https?:\/\/|donethat:\/\/)[^\s]+)/g, (m, p1, url) => `${p1}<a href="${url}" class="chat-link" data-url="${url}">${url}</a>`)
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
      const newHtml = msg.typing ? '<div class="typing"><span></span><span></span><span></span></div>' : parseMarkdown(msg.text)
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

  // Show/hide chat notice based on whether there are messages
  if (chatNotice) {
    chatNotice.style.display = toRender.length > 0 ? 'block' : 'none'
  }

  // Update recent chats visibility based on active chat state
  updateRecentChatsVisibility()

  // Event delegation for chat links - handled once at container level

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


function getLastMessageTimestamp() {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const t = m && typeof m.ts === 'number' ? m.ts : undefined
    if (Number.isFinite(t)) return t
  }
  return undefined
}

function resetChatForNewConversation() {
  const wasEmpty = (messages.length === 0) && (pendingMessages.length === 0)
  if (wasEmpty) {
    return
  }
  messages = []
  pendingMessages = []
  includeScreenOnNextMessage = true
  updateIncludeScreenBtn()
  recentChatsPage = 0

  renderChat()
  lastSentHeight = 40
  ipcRenderer.send('overlay:resize', 40)
  chatVisible = false
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
  // Do not auto-resize the input; keep fixed height and let it scroll
  // No overlay resize on typing to keep icons/overlay stable
  // Hide recent chats when user starts typing
  if (recentChatsContainer && recentChatsContainer.style.display !== 'none') {
    updateRecentChatsVisibility()
  }
})

// IPC handlers for communication with main window
ipcRenderer.on('chat:receive-messages', (event, newMessages) => {
  messages = newMessages
  
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
  
  // Auto-show and expand if new messages arrive
  if (newMessages.length > 0) {
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

// Handle recent chats list updates
ipcRenderer.on('chat:recent-chats-updated', (event, newRecentChats) => {
  recentChats = Array.isArray(newRecentChats) ? newRecentChats : []
  recentChatsPage = 0
  updateRecentChatsVisibility()
})

// Handle chat load result
ipcRenderer.on('chat:load-chat-result', (event, result) => {
  isLoadingChat = false
  if (result.success) {
    // Chat loading is successful, messages will arrive via chat:receive-messages
    // Reset recent chats page
    recentChatsPage = 0
  } else {
    console.error('[CHAT] Failed to load chat:', result.error)
    updateRecentChatsVisibility()
  }
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
    resetChatForNewConversation()
  })
}

// Focus input when window gains focus
window.addEventListener('focus', () => {
  try {
    // Run inactivity reset and focus input on window focus
    maybeResetChatOnOverlayShow()
    input0.focus()
    const len = (input0.value || '').length
    input0.setSelectionRange(len, len)
    
    // When window gains focus, ensure chat is visible if there are messages
    if (messages.length > 0 && !chatVisible) {
      chatVisible = true
      animateResize(computeDesiredHeight(), { overshoot: true })
    }
    
    // Request recent chats list when overlay opens
    if (messages.length === 0 && pendingMessages.length === 0) {
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
  const isMac = window.electronAPI && window.electronAPI.platform === 'darwin'
  const closeBtn = document.getElementById('closeOverlayBtn')
  if (closeBtn) {
    closeBtn.title = `Close chat (Esc, ${isMac ? 'Cmd' : 'Ctrl'}+Shift+D)`
  }
} catch (e) {}



function renderRecentChatsList() {
  if (!recentChatsContainer) return

  const hasActiveChat = messages.length > 0 || pendingMessages.length > 0
  if (hasActiveChat || isLoadingChat) {
    recentChatsContainer.style.display = 'none'
    // Trigger height recalculation after hiding
    requestAnimationFrame(() => {
      const desired = computeDesiredHeight()
      applyScrollAndClamp(desired)
      if (desired !== lastSentHeight) {
        lastSentHeight = desired
        ipcRenderer.send('overlay:resize', desired)
      }
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

  let html = '<div class="recent-chats-list">'
  
  chatsToShow.forEach((chat, index) => {
    let preview = chat.previewText || 'New conversation'
    // Truncate to max 30 characters and add ellipsis
    const MAX_PREVIEW_LENGTH = 30
    if (preview.length > MAX_PREVIEW_LENGTH) {
      preview = preview.substring(0, MAX_PREVIEW_LENGTH) + '...'
    }
    html += `
      <div class="recent-chat-item" data-chat-id="${chat.id}">
        <span class="recent-chat-preview">${escapeHtml(preview)}</span>
      </div>
    `
  })

  if (hasMore) {
    html += '<div class="recent-chats-load-more">→</div>'
  }

  html += '</div>'
  recentChatsContainer.innerHTML = html

  // Infinite scroll detection and drag scrolling - attach listener to the scrollable list (horizontal scroll)
  const listEl = recentChatsContainer.querySelector('.recent-chats-list')
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

    // Infinite scroll for loading more chats
    if (hasMore) {
      listEl.addEventListener('scroll', () => {
        const scrollLeft = listEl.scrollLeft
        const scrollWidth = listEl.scrollWidth
        const clientWidth = listEl.clientWidth
        
        // Load more when scrolled near right edge (within 50px)
        if (scrollWidth - scrollLeft - clientWidth < 50) {
          loadMoreRecentChats()
        }
      })
    }
  }

  // Recalculate height after rendering to account for recent chats container
  requestAnimationFrame(() => {
    const desired = computeDesiredHeight()
    applyScrollAndClamp(desired)
    if (desired !== lastSentHeight) {
      lastSentHeight = desired
      ipcRenderer.send('overlay:resize', desired)
    }
  })
}

function escapeHtml(text) {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

function updateRecentChatsVisibility() {
  const hasActiveChat = messages.length > 0 || pendingMessages.length > 0
  if (hasActiveChat || isLoadingChat) {
    if (recentChatsContainer) {
      recentChatsContainer.style.display = 'none'
    }
  } else {
    renderRecentChatsList()
  }
}

function loadMoreRecentChats() {
  const currentEnd = (recentChatsPage + 1) * CHATS_PER_PAGE
  if (currentEnd < recentChats.length) {
    recentChatsPage++
    renderRecentChatsList()
  }
}

async function loadChatById(chatId) {
  if (isLoadingChat || !chatId) return
  
  isLoadingChat = true
  updateRecentChatsVisibility()
  
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
    isLoadingChat = false
    updateRecentChatsVisibility()
  }
}

// Initialize
updateIncludeScreenBtn()
renderChat()














