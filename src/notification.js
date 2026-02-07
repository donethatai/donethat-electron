const ipcRenderer = window.electronAPI;

const notificationCard = document.getElementById('notificationCard');
const notificationTitle = document.getElementById('notificationTitle');
const notificationMessage = document.getElementById('notificationMessage');
const notificationActionBtn = document.getElementById('notificationActionBtn');
const notificationCloseBtn = document.getElementById('notificationCloseBtn');

let dismissTimer = null;
let currentNotification = null;

function hideNotification() {
  if (dismissTimer) {
    clearTimeout(dismissTimer);
    dismissTimer = null;
  }
  if (notificationCard) {
    notificationCard.style.opacity = '0';
    notificationCard.style.transform = 'translateY(-10px)';
    setTimeout(() => {
      try {
        ipcRenderer.send('notification:close', currentNotification?.id || null);
      } catch (e) {}
      currentNotification = null;
    }, 200);
  }
}

function showNotification(payload) {
  if (!payload) return;
  
  currentNotification = payload;
  const { id, title, message, sticky, action } = payload || {};
  
  // Set title (without "DoneThat: " prefix since it's now on its own line)
  if (notificationTitle) {
    if (title) {
      notificationTitle.textContent = title;
      notificationTitle.style.display = 'block';
    } else {
      notificationTitle.textContent = '';
      notificationTitle.style.display = 'none';
    }
  }
  
  // Set message
  if (notificationMessage) {
    notificationMessage.textContent = message || '';
  }
  
  // Handle action button
  if (notificationActionBtn) {
    if (action && action.label && action.channel) {
      notificationActionBtn.textContent = action.label;
      notificationActionBtn.classList.remove('hidden');
      notificationActionBtn.onclick = () => {
        try {
          ipcRenderer.send('notification:action', {
            channel: action.channel,
            payload: action.payload || null,
            notificationId: id
          });
        } catch (e) {}
        hideNotification();
      };
    } else {
      notificationActionBtn.classList.add('hidden');
      notificationActionBtn.onclick = null;
    }
  }
  
  // Ensure all content is set before showing
  // Wait a frame to ensure DOM updates are applied
  requestAnimationFrame(() => {
    // Show notification with fade-in animation
    if (notificationCard) {
      // Ensure card is visible and reset any previous state
      notificationCard.style.display = 'flex';
      notificationCard.style.opacity = '0';
      notificationCard.style.transform = 'translateY(-10px)';
      notificationCard.style.transition = 'opacity 0.2s ease-out, transform 0.2s ease-out';
      // Force reflow to ensure initial state is applied
      void notificationCard.offsetHeight;
      
      // Notify main process of content height for window sizing
      try {
        const cardHeight = notificationCard.offsetHeight;
        ipcRenderer.send('notification:content-height', cardHeight);
      } catch (e) {}
      
      setTimeout(() => {
        notificationCard.style.opacity = '1';
        notificationCard.style.transform = 'translateY(0)';
      }, 10);
    }
  });
  
  // Auto-dismiss after 5 seconds unless sticky
  if (!sticky) {
    if (dismissTimer) clearTimeout(dismissTimer);
    dismissTimer = setTimeout(() => {
      hideNotification();
    }, 5000);
  } else {
    if (dismissTimer) {
      clearTimeout(dismissTimer);
      dismissTimer = null;
    }
  }
}

// Close button handler
if (notificationCloseBtn) {
  notificationCloseBtn.addEventListener('click', () => {
    hideNotification();
  });
}

// Listen for show notification IPC
ipcRenderer.on('background:notify', (_event, payload) => {
  // Ensure DOM is ready before showing
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      showNotification(payload);
    });
  } else {
    showNotification(payload);
  }
});

// Listen for hide notification IPC
ipcRenderer.on('background:hide', () => {
  hideNotification();
});

// Request initial size from main process
try {
  ipcRenderer.send('notification:ready');
} catch (e) {}

