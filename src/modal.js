/**
 * Modal notification system for DoneThat
 * Provides non-blocking modal notifications to replace alert()
 */

// Custom modal for notifications that doesn't block UI like alert()
function showModal(message, options = {}) {
  const {
    type = 'info',      // info, success, error, warning
    duration = 5000,    // auto-dismiss after 5 seconds by default, 0 for persistent
    title = null,       // optional title
    persistent = false  // Whether the modal should persist (not auto-dismiss)
  } = options;
  

  
  // Check if we already have a modal element
  let modalElement = document.getElementById('dt-modal');
  
  if (!modalElement) {
    // Create a modal element if it doesn't exist
    modalElement = document.createElement('div');
    modalElement.id = 'dt-modal';
    modalElement.style.position = 'fixed';
    modalElement.style.top = '0';
    modalElement.style.left = '0';
    modalElement.style.right = '0';
    modalElement.style.padding = '10px 15px';
    modalElement.style.zIndex = '9999';
    modalElement.style.boxShadow = '0 2px 10px rgba(0,0,0,0.2)';
    modalElement.style.fontSize = '12px';
    modalElement.style.textAlign = 'center';
    modalElement.style.width = '100%';
    modalElement.style.paddingRight = '40px';
    
    document.body.appendChild(modalElement);
  }
  
  // Brand orange color for all modals
  modalElement.style.backgroundColor = '#F59E0B';
  modalElement.style.color = 'white';
  
  // Clear any existing content
  modalElement.innerHTML = '';
  
  // Add title if provided
  if (title) {
    const titleEl = document.createElement('div');
    titleEl.textContent = title;
    titleEl.style.fontWeight = 'bold';
    titleEl.style.marginBottom = '5px';
    modalElement.appendChild(titleEl);
  }
  
  // Add message content
  const contentEl = document.createElement('div');
  contentEl.textContent = message;
  modalElement.appendChild(contentEl);
  
  // Add close button
  const closeBtn = document.createElement('span');
  closeBtn.innerHTML = '&times;';
  closeBtn.style.cursor = 'pointer';
  closeBtn.style.fontWeight = 'bold';
  closeBtn.style.fontSize = '18px';
  closeBtn.style.position = 'absolute';
  closeBtn.style.top = '50%';
  closeBtn.style.right = '15px';
  closeBtn.style.transform = 'translateY(-50%)';
  closeBtn.onclick = function() {
    hideModal();
  };
  modalElement.appendChild(closeBtn);
  
  // Make sure the modal is visible
  modalElement.style.display = 'block';
  
  // Auto-dismiss after specified duration if positive and not persistent
  const shouldAutoDismiss = duration > 0 && !persistent;
  if (shouldAutoDismiss) {
    setTimeout(() => {
      hideModal();
    }, duration);
  }
  
  return modalElement;
}

function hideModal() {
  const modalElement = document.getElementById('dt-modal');
  if (modalElement) {
    modalElement.style.display = 'none';
  }
}

// Convenience methods for different types of modals
function showErrorModal(message, options = {}) {
  return showModal(message, { ...options, type: 'error' });
}

function showSuccessModal(message, options = {}) {
  return showModal(message, { ...options, type: 'success' });
}

function showInfoModal(message, options = {}) {
  return showModal(message, { ...options, type: 'info' });
}

function showWarningModal(message, options = {}) {
  return showModal(message, { ...options, type: 'warning' });
}

// Special persistent error modal for connection/auth issues
function showPersistentErrorModal(message, options = {}) {
  return showModal(message, { ...options, type: 'error', persistent: true });
}

module.exports = {
  showModal,
  hideModal,
  showErrorModal,
  showSuccessModal,
  showInfoModal,
  showWarningModal,
  showPersistentErrorModal
}; 