const { httpsCallable } = require("firebase/functions");
const { functions } = require('./firebase.js');
const ipcRenderer = window.electronAPI;
const { logAnalyticsEvent } = require('./analytics.js');
const { getIsPaused } = require('./app-state.js');
const { showBanner } = require('./notify.js');

// Callable SDK default timeout is 70s; Finish Day summarization often runs longer.
const FINISH_DAY_CALLABLE_TIMEOUT_MS = 15 * 60 * 1000;

// Create callable function references
const generateRawSummaryFunction = httpsCallable(functions, "generateRawSummary", {
  timeout: FINISH_DAY_CALLABLE_TIMEOUT_MS,
});
const saveFinalSummaryFunction = httpsCallable(functions, "saveFinalSummary", {
  timeout: FINISH_DAY_CALLABLE_TIMEOUT_MS,
});

// Reference to permission-related elements 
const generateSummaryBtn = document.getElementById("generateSummaryBtn");
let currentSummaryId = null;
const finishDayLoadingSpinner = document.getElementById("finishDayLoadingSpinner");

// Summary overlay elements
const summaryOverlay = document.getElementById("summaryOverlay");
const summaryHeadline = document.getElementById("summaryHeadline");
const summaryPeriod = document.getElementById("summaryPeriod");
const summaryBulletsContainer = document.getElementById("summaryBulletsContainer");
const summaryCustomBulletsContainer = document.getElementById("summaryCustomBulletsContainer");
const summaryCommentInput = document.getElementById("summaryCommentInput");
const summaryCloseBtn = document.getElementById("summaryCloseBtn");
const summaryCancelBtn = document.getElementById("summaryCancelBtn");
const summarySubmitBtn = document.getElementById("summarySubmitBtn");
const summaryCustomInput = document.getElementById("summaryCustomInput");
const summaryAddCustomBtn = document.getElementById("summaryAddCustomBtn");

let loadUserSettingsCallback;
let navigateToView;
let showSpinner;
let hideSpinner;
let currentPeriodEndTime = null;

// Task-based state management
let summaryTasks = [];       // {taskId, title, minutes, source, projectId, projectLabel}
let taskVisibility = {};     // key -> boolean (taskId for real tasks, index for synthetic)
let taskProjectEdits = {};   // taskId -> projectId (only real taskIds)
let projects = [];           // {id, name, color, status, description}
let customTasks = [];        // {title, durationMinutes?, projectId?}
let activePickerCleanups = [];

// Helper function to format date for headline
function formatHeadlineDate(timestamp) {
  if (!timestamp) return "Today";

  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  let dateString = "";
  const timeString = date.toLocaleTimeString('en-US', {
    hour: 'numeric', 
    minute: '2-digit',
    hour12: false
  });

  // Create a copy for date comparison without time
  const dateOnly = new Date(date);
  dateOnly.setHours(0, 0, 0, 0);

  // Reset time parts for today/yesterday comparison
  today.setHours(0, 0, 0, 0);
  yesterday.setHours(0, 0, 0, 0);

  if (dateOnly.getTime() === today.getTime()) {
    dateString = "Today";
  } else if (dateOnly.getTime() === yesterday.getTime()) {
    dateString = "Yesterday";
  } else {
    const day = date.getDate();
    const month = date.toLocaleString('en-US', { month: 'short' });
    let suffix = 'th';
    if (day % 10 === 1 && day !== 11) suffix = 'st';
    if (day % 10 === 2 && day !== 12) suffix = 'nd';
    if (day % 10 === 3 && day !== 13) suffix = 'rd';
    dateString = `${month} ${day}${suffix}`;
  }

  return `${dateString} ${timeString}`; // Combine date and time
}


// Helper function to format duration in minutes to readable format
function formatDuration(minutes) {
  if (!minutes || minutes === 0) return '';
  
  const rounded = Math.round(minutes);
  const hours = Math.floor(rounded / 60);
  const remainingMinutes = rounded % 60;
  
  if (hours > 0) {
    return `${hours}h ${remainingMinutes}m`;
  } else {
    return `${rounded}m`;
  }
}

// Show summary overlay
function showSummaryOverlay() {
  if (summaryOverlay) {
    summaryOverlay.classList.remove('hidden');
  }
}

// Hide summary overlay
function hideSummaryOverlay() {
  activePickerCleanups.forEach(fn => fn());
  activePickerCleanups = [];
  if (summaryOverlay) {
    summaryOverlay.classList.add('hidden');
  }
}
  
  

  // Reset to initial state
  function resetSummaryState() {
    if (finishDayLoadingSpinner) finishDayLoadingSpinner.classList.add('hidden');
    const finishDayMessage = document.getElementById('finishDayMessage');
    if (finishDayMessage) finishDayMessage.classList.add('hidden');
    currentSummaryId = null;
    summaryTasks = [];
    taskVisibility = {};
    taskProjectEdits = {};
    projects = [];
    customTasks = [];
    currentPeriodEndTime = null;
  
    // Reset headline
    const headlineElement = document.getElementById('dashboardHeadline');
    if (headlineElement) {
      headlineElement.textContent = "Today";
    }
    
    // Hide summary overlay
    hideSummaryOverlay();
  }

  // Initialize dashboard
  function initializeDashboard(onSettingsUpdate, showBlockingSpinner, hideBlockingSpinner, viewNavigator) {
    loadUserSettingsCallback = onSettingsUpdate;
    showSpinner = showBlockingSpinner;
    hideSpinner = hideBlockingSpinner;
    navigateToView = viewNavigator;
  }



// Add event listeners for summary overlay buttons
if (summaryCloseBtn) {
  summaryCloseBtn.addEventListener('click', () => {
    hideSummaryOverlay();
  });
}

if (summaryCancelBtn) {
  summaryCancelBtn.addEventListener('click', () => {
    hideSummaryOverlay();
  });
}

// Add event listener for custom task input
if (summaryCustomInput && summaryAddCustomBtn) {
  const addCustomTask = () => {
    const title = summaryCustomInput.value.trim();
    const timeInput = document.getElementById('summaryCustomTimeInput');
    const pickerWrapper = document.getElementById('summaryCustomProjectPicker');
    const timeHours = timeInput && timeInput.value ? parseFloat(timeInput.value) : null;
    const durationMinutes = (typeof timeHours === 'number' && !isNaN(timeHours)) ? Math.max(0, Math.round(timeHours * 60)) : undefined;
    const selectedPicker = pickerWrapper?.querySelector('.project-picker');
    const projectId = selectedPicker?.dataset.selectedProjectId || undefined;
    
    if (title) {
      customTasks.push({ title, durationMinutes, projectId });
      summaryCustomInput.value = '';
      if (timeInput) timeInput.value = '';
      if (pickerWrapper) resetCustomProjectPicker();
      summaryAddCustomBtn.disabled = true;
      renderCustomTasks();
      summaryCustomInput.focus();
    }
  };

  summaryAddCustomBtn.addEventListener('click', addCustomTask);

  summaryCustomInput.addEventListener('input', () => {
    summaryAddCustomBtn.disabled = !summaryCustomInput.value.trim();
  });
  
  summaryCustomInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addCustomTask();
    }
  });
  
  const timeInput = document.getElementById('summaryCustomTimeInput');
  if (timeInput) {
    timeInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addCustomTask();
      }
    });
  }
}

if (summarySubmitBtn) {
  summarySubmitBtn.addEventListener('click', () => {
    // Flush any pending custom task from the input
    const pendingTitle = summaryCustomInput?.value.trim();
    if (pendingTitle) {
      const timeInput = document.getElementById('summaryCustomTimeInput');
      const pickerWrapper = document.getElementById('summaryCustomProjectPicker');
      const timeHours = timeInput && timeInput.value ? parseFloat(timeInput.value) : null;
      const durationMinutes = (typeof timeHours === 'number' && !isNaN(timeHours)) ? Math.max(0, Math.round(timeHours * 60)) : undefined;
      const selectedPicker = pickerWrapper?.querySelector('.project-picker');
      const projectId = selectedPicker?.dataset.selectedProjectId || undefined;
      customTasks.push({ title: pendingTitle, durationMinutes, projectId });
    }

    summarySubmitBtn.disabled = true;
    summarySubmitBtn.innerHTML = '<div class="spinner-small"></div> Submitting...';

    const commentText = summaryCommentInput.value.trim();

    const removeTaskIds = [];
    const taskProjectAssignments = [];
    summaryTasks.forEach((task, index) => {
      const key = task.taskId || index;
      if (!task.taskId) return;
      if (!taskVisibility[key]) {
        removeTaskIds.push(task.taskId);
      }
      if (taskProjectEdits[task.taskId] !== undefined) {
        taskProjectAssignments.push({
          taskId: task.taskId,
          projectId: taskProjectEdits[task.taskId]
        });
      }
    });

    const payload = {
      summaryId: currentSummaryId,
      removeTaskIds: removeTaskIds.slice(0, 100),
      addCustomTasks: customTasks.slice(0, 100),
      taskProjectAssignments: taskProjectAssignments.slice(0, 100),
    };
    if (commentText) {
      payload.comment = commentText;
    } else {
      payload.clearComment = true;
    }

    saveFinalSummaryFunction(payload).then(() => {
      summarySubmitBtn.disabled = false;
      summarySubmitBtn.textContent = 'Submit';

      ipcRenderer.send("summarySubmitted", {
        timestamp: Date.now(),
        lastSummaryPeriodEnd: currentPeriodEndTime
      });

      logAnalyticsEvent('summary_submitted', {
          status: 'success',
          task_count: summaryTasks.length,
          custom_task_count: customTasks.length,
          has_comment: !!commentText
      });

      const webview = document.getElementById('portalView');
      if (webview) {
        webview.reload();
      }
      
      resetSummaryState();

    }).catch((error) => {
      summarySubmitBtn.disabled = false;
      summarySubmitBtn.textContent = 'Submit';
      console.error("Error submitting summary:", error);
      showBanner(`Error submitting summary: ${error.message}`, { title: 'Summary', sticky: true });
      
      logAnalyticsEvent('summary_submitted', {
        status: 'error',
        error_code: error.code,
        error_message: error.message
      });
    });
  });
}
  
  // Update the event listener for the generate summary button
  if (generateSummaryBtn) {
    generateSummaryBtn.addEventListener('click', async () => {
      if (finishDayLoadingSpinner) finishDayLoadingSpinner.classList.remove('hidden');
      const finishDayMessage = document.getElementById('finishDayMessage');
      if (finishDayMessage) finishDayMessage.classList.remove('hidden');
      // Immediately pause until tomorrow when finishing the day, if not already paused
      try {
        if (!getIsPaused()) {
          ipcRenderer.send("pauseUntilTomorrow");
        }
      } catch (e) {
        // No-op if IPC is unavailable
      }

      generateRawSummaryFunction()
        .then((result) => {
          if (finishDayLoadingSpinner) finishDayLoadingSpinner.classList.add('hidden');
          const finishDayMessage = document.getElementById('finishDayMessage');
          if (finishDayMessage) finishDayMessage.classList.add('hidden');

          currentSummaryId = result.data.summaryId;
          const period = result.data.period;
          currentPeriodEndTime = period?.end;

          summaryTasks = result.data.summaryTasks || [];
          projects = result.data.projects || [];
          taskVisibility = {};
          taskProjectEdits = {};
          customTasks = [];
          summaryTasks.forEach((task, index) => {
            taskVisibility[task.taskId || index] = true;
          });

          const headlineElement = document.getElementById('dashboardHeadline');
          if (headlineElement) {
            headlineElement.textContent = formatHeadlineDate(period?.end);
          }
          if (summaryHeadline) {
            summaryHeadline.textContent = formatHeadlineDate(period?.end);
          }

          if (summaryTasks.length === 0) {
             showBanner('No activities found for today. Check if DoneThat is paused and try again in an hour.', {
               title: 'Empty Summary',
               sticky: false
             });
            logAnalyticsEvent('summary_generated', {
              status: 'empty',
              task_count: 0
            });
            return;
          }
  
          const formatDateTime = (timestamp) => {
            if (!timestamp) return '';
            const date = new Date(timestamp);
            return date.toLocaleString('en-US', {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
              hour12: true
            });
          };
  
          if (summaryPeriod) {
            if (period) {
              summaryPeriod.textContent = `Activities from ${formatDateTime(period.start)} to ${formatDateTime(period.end)}`;
              summaryPeriod.classList.remove('hidden');
            } else {
              summaryPeriod.classList.add('hidden');
            }
          }
  
          renderSummaryTasks();
          renderCustomTasks();
          populateCustomProjectPicker();
  
          showSummaryOverlay();
          
          logAnalyticsEvent('summary_generated', {
            status: 'success',
            task_count: summaryTasks.length,
            has_period: !!period
          });
        })
        .catch((error) => {
          if (finishDayLoadingSpinner) finishDayLoadingSpinner.classList.add('hidden');
          const finishDayMessage = document.getElementById('finishDayMessage');
          if (finishDayMessage) finishDayMessage.classList.add('hidden');
          console.error("Error generating summary:", error);
          
          // Show error notification instead of just logging
          showBanner(error.message || 'Failed to generate summary', {
            title: 'Finish Day Error',
            sticky: false
          });
          
          // Log error in summary generation
          logAnalyticsEvent('summary_generated', {
            status: 'error',
            error_code: error.code,
            error_message: error.message
          });
        });
    });
  } else {
    console.error("Generate summary button not found");
  }

// Add resume function
function resumeRecording() {
  ipcRenderer.send('resumeRecording');
}

// Add pause state change listener
ipcRenderer.on('pauseStateChanged', (_event, isPaused, meta) => {
  // Pause state changed - no notification needed
  // The workday ended notification will handle informing the user when appropriate
});

const CHEVRON_SVG = '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd"/></svg>';

function getProjectColor(project) {
  return project.color || null;
}

function findProjectById(projectId) {
  return projects.find(p => p.id === projectId) || null;
}

function buildProjectPicker(selectedProjectId, onChange) {
  const wrapper = document.createElement('div');
  wrapper.className = 'project-picker';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'project-picker-trigger';

  const updateTrigger = (projectId) => {
    trigger.innerHTML = '';
    const project = findProjectById(projectId);
    if (project) {
      const color = getProjectColor(project);
      if (color) {
        const dot = document.createElement('span');
        dot.className = 'project-picker-dot';
        dot.style.backgroundColor = color;
        trigger.appendChild(dot);
      }
      const label = document.createElement('span');
      label.className = 'project-picker-label';
      label.textContent = project.name;
      trigger.appendChild(label);
    } else {
      const label = document.createElement('span');
      label.className = 'project-picker-label';
      label.textContent = 'No project';
      trigger.appendChild(label);
    }
    const chevron = document.createElement('span');
    chevron.className = 'project-picker-chevron';
    chevron.innerHTML = CHEVRON_SVG;
    trigger.appendChild(chevron);
  };

  updateTrigger(selectedProjectId);
  wrapper.appendChild(trigger);

  let panel = null;
  let closeListener = null;

  const closePanel = () => {
    if (panel) {
      panel.remove();
      panel = null;
    }
    if (closeListener) {
      document.removeEventListener('mousedown', closeListener);
      closeListener = null;
    }
    activePickerCleanups = activePickerCleanups.filter(fn => fn !== closePanel);
  };

  trigger.addEventListener('click', () => {
    if (panel) { closePanel(); return; }

    panel = document.createElement('div');
    panel.className = 'project-picker-panel';

    const currentId = wrapper.dataset.selectedProjectId || '';

    const addOption = (id, name, color) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'project-picker-option';
      if (id === currentId) btn.classList.add('project-picker-option-selected');
      if (color) {
        const dot = document.createElement('span');
        dot.className = 'project-picker-dot';
        dot.style.backgroundColor = color;
        btn.appendChild(dot);
      }
      const label = document.createElement('span');
      label.textContent = name;
      label.style.overflow = 'hidden';
      label.style.textOverflow = 'ellipsis';
      btn.appendChild(label);
      btn.addEventListener('click', () => {
        wrapper.dataset.selectedProjectId = id;
        updateTrigger(id);
        onChange(id || null);
        closePanel();
      });
      panel.appendChild(btn);
    };

    addOption('', 'No project', null);
    projects.forEach(p => addOption(p.id, p.name, getProjectColor(p)));

    wrapper.appendChild(panel);

    closeListener = (e) => {
      if (!wrapper.contains(e.target)) closePanel();
    };
    document.addEventListener('mousedown', closeListener);
    activePickerCleanups.push(closePanel);
  });

  wrapper.dataset.selectedProjectId = selectedProjectId || '';
  return wrapper;
}

function setRowCrossedState(elements, crossed) {
  const { title, durationChip, picker, chip } = elements;
  title.classList.toggle('task-title-crossed', crossed);
  if (durationChip) durationChip.classList.toggle('task-duration-chip-crossed', crossed);
  if (picker) picker.classList.toggle('project-picker-crossed', crossed);
  if (chip) chip.classList.toggle('task-title-crossed', crossed);
}

function renderSummaryTasks() {
  if (!summaryBulletsContainer) return;
  summaryBulletsContainer.textContent = '';
  const fragment = document.createDocumentFragment();

  summaryTasks.forEach((task, index) => {
    const key = task.taskId || index;
    const isVisible = taskVisibility[key] !== false;

    // Col 1: checkbox
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'bullet-checkbox';
    checkbox.id = `task-${index}`;
    checkbox.checked = isVisible;

    // Col 2: title
    const title = document.createElement('label');
    title.setAttribute('for', `task-${index}`);
    title.className = 'task-title';
    if (!isVisible) title.classList.add('task-title-crossed');
    title.textContent = task.title || '';

    // Col 3: project picker or chip
    let projectEl;
    if (projects.length > 0 && task.taskId) {
      const currentProjectId = taskProjectEdits[task.taskId] !== undefined
        ? taskProjectEdits[task.taskId]
        : (task.projectId || '');
      projectEl = buildProjectPicker(currentProjectId, (newId) => {
        taskProjectEdits[task.taskId] = newId;
      });
      if (!isVisible) projectEl.classList.add('project-picker-crossed');
    } else if (task.projectLabel) {
      projectEl = document.createElement('span');
      projectEl.className = 'task-project-chip';
      if (!isVisible) projectEl.classList.add('task-title-crossed');
      const project = findProjectById(task.projectId);
      if (project) {
        const dot = document.createElement('span');
        dot.className = 'project-picker-dot';
        dot.style.backgroundColor = getProjectColor(project);
        projectEl.appendChild(dot);
      }
      const chipLabel = document.createTextNode(task.projectLabel);
      projectEl.appendChild(chipLabel);
    } else {
      projectEl = document.createElement('span');
    }

    // Col 4: duration chip
    const durationChip = document.createElement('span');
    const durationText = formatDuration(task.minutes);
    if (durationText) {
      durationChip.className = 'task-duration-chip';
      if (!isVisible) durationChip.classList.add('task-duration-chip-crossed');
      durationChip.textContent = durationText;
    }

    fragment.appendChild(checkbox);
    fragment.appendChild(title);
    fragment.appendChild(projectEl);
    fragment.appendChild(durationChip);

    // Wire checkbox toggle
    checkbox.addEventListener('change', function () {
      taskVisibility[key] = this.checked;
      setRowCrossedState({
        title,
        durationChip: durationText ? durationChip : null,
        picker: projectEl.classList.contains('project-picker') ? projectEl : null,
        chip: projectEl.classList.contains('task-project-chip') ? projectEl : null,
      }, !this.checked);
    });
  });

  summaryBulletsContainer.appendChild(fragment);
}

function resetCustomProjectPicker() {
  const wrapper = document.getElementById('summaryCustomProjectPicker');
  if (!wrapper) return;
  wrapper.innerHTML = '';
  wrapper.appendChild(buildProjectPicker('', () => {}));
  wrapper.classList.toggle('hidden', projects.length === 0);
}

function populateCustomProjectPicker() {
  resetCustomProjectPicker();
}

function renderCustomTasks() {
  if (!summaryCustomBulletsContainer) return;
  summaryCustomBulletsContainer.innerHTML = '';
  
  customTasks.forEach((task, index) => {
    // Col 1: delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'custom-task-delete';
    deleteBtn.innerHTML = '&times;';
    deleteBtn.addEventListener('click', () => {
      customTasks.splice(index, 1);
      renderCustomTasks();
    });

    // Col 2: title
    const titleSpan = document.createElement('span');
    titleSpan.className = 'custom-task-title';
    titleSpan.textContent = task.title;

    // Col 3: project chip (read-only)
    const projectEl = document.createElement('span');
    if (task.projectId) {
      const project = findProjectById(task.projectId);
      if (project) {
        projectEl.className = 'task-project-chip';
        const dot = document.createElement('span');
        dot.className = 'project-picker-dot';
        dot.style.backgroundColor = getProjectColor(project);
        projectEl.appendChild(dot);
        projectEl.appendChild(document.createTextNode(project.name));
      }
    }

    // Col 4: duration chip
    const durationEl = document.createElement('span');
    if (task.durationMinutes) {
      durationEl.className = 'task-duration-chip';
      durationEl.textContent = formatDuration(task.durationMinutes);
    }
    
    summaryCustomBulletsContainer.appendChild(deleteBtn);
    summaryCustomBulletsContainer.appendChild(titleSpan);
    summaryCustomBulletsContainer.appendChild(projectEl);
    summaryCustomBulletsContainer.appendChild(durationEl);
  });
}

 module.exports = { initializeDashboard, resetSummaryState };
