document.addEventListener('DOMContentLoaded', () => {
  const apiUrl = document.getElementById('api-url');
  const testConnection = document.getElementById('test-connection');
  const connectionStatus = document.getElementById('connection-status');
  const statusIndicator = document.getElementById('status-indicator');
  const uploadArea = document.getElementById('upload-area');
  const resumeFile = document.getElementById('resume-file');
  const uploadStatus = document.getElementById('upload-status');
  const resumePreview = document.getElementById('resume-preview');
  const startAutofill = document.getElementById('start-autofill');
  const stopAutofill = document.getElementById('stop-autofill');
  const confirmEach = document.getElementById('confirm-each');
  const autoScroll = document.getElementById('auto-scroll');
  const clickAddButtons = document.getElementById('click-add-buttons');
  const manualSection = document.getElementById('manual-input-section');
  const progressSection = document.getElementById('progress-section');
  const progressFill = document.getElementById('progress-fill');
  const progressText = document.getElementById('progress-text');
  const activityLog = document.getElementById('activity-log');

  let isAutofilling = false;

  chrome.storage.local.get(['apiUrl', 'resumeUploaded', 'options'], (data) => {
    if (data.apiUrl) apiUrl.value = data.apiUrl;
    if (data.resumeUploaded) {
      startAutofill.disabled = false;
      uploadStatus.textContent = 'Resume loaded from previous session';
      uploadStatus.className = 'status-message success';
    }
    if (data.options) {
      confirmEach.checked = data.options.confirmEach ?? true;
      autoScroll.checked = data.options.autoScroll ?? true;
      clickAddButtons.checked = data.options.clickAddButtons ?? true;
    }
    testBackendConnection();
  });

  function saveOptions() {
    chrome.storage.local.set({
      options: {
        confirmEach: confirmEach.checked,
        autoScroll: autoScroll.checked,
        clickAddButtons: clickAddButtons.checked
      }
    });
  }

  confirmEach.addEventListener('change', saveOptions);
  autoScroll.addEventListener('change', saveOptions);
  clickAddButtons.addEventListener('change', saveOptions);

  async function testBackendConnection() {
    statusIndicator.className = 'status-dot loading';
    connectionStatus.textContent = 'Connecting...';
    connectionStatus.className = 'status-message info';

    try {
      const response = await fetch(`${apiUrl.value}/api/health`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });
      const data = await response.json();
      
      if (data.status === 'healthy') {
        statusIndicator.className = 'status-dot connected';
        connectionStatus.textContent = 'Connected! ' + (data.rag_initialized ? 'Resume loaded.' : 'Upload resume to start.');
        connectionStatus.className = 'status-message success';
        chrome.storage.local.set({ apiUrl: apiUrl.value });
        
        if (data.rag_initialized) {
          startAutofill.disabled = false;
          chrome.storage.local.set({ resumeUploaded: true });
        }
        return true;
      }
    } catch (error) {
      console.error('Connection error:', error);
      statusIndicator.className = 'status-dot';
      connectionStatus.textContent = 'Failed to connect. Make sure the backend is running on ' + apiUrl.value;
      connectionStatus.className = 'status-message error';
    }
    return false;
  }

  testConnection.addEventListener('click', testBackendConnection);
  apiUrl.addEventListener('change', () => {
    chrome.storage.local.set({ apiUrl: apiUrl.value });
  });

  uploadArea.addEventListener('click', () => resumeFile.click());
  
  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('dragover');
  });

  uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('dragover');
  });

  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFileUpload(files[0]);
    }
  });

  resumeFile.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFileUpload(e.target.files[0]);
    }
  });

  async function handleFileUpload(file) {
    uploadStatus.textContent = 'Uploading and processing...';
    uploadStatus.className = 'status-message info';

    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch(`${apiUrl.value}/api/upload`, {
        method: 'POST',
        body: formData
      });

      const data = await response.json();

      if (data.success) {
        uploadStatus.textContent = 'Resume uploaded successfully!';
        uploadStatus.className = 'status-message success';
        
        const sections = data.sections_found || [];
        resumePreview.innerHTML = `<strong>Sections found:</strong> ${sections.join(', ')}`;
        resumePreview.classList.remove('hidden');
        
        startAutofill.disabled = false;
        chrome.storage.local.set({ resumeUploaded: true });
        addLog('Resume uploaded and indexed', 'success');
      } else {
        throw new Error(data.error || 'Upload failed');
      }
    } catch (error) {
      uploadStatus.textContent = `Error: ${error.message}`;
      uploadStatus.className = 'status-message error';
      addLog(`Upload failed: ${error.message}`, 'error');
    }
  }

  startAutofill.addEventListener('click', async () => {
    const connected = await testBackendConnection();
    if (!connected) {
      addLog('Cannot start - backend not connected', 'error');
      return;
    }

    isAutofilling = true;
    startAutofill.classList.add('hidden');
    stopAutofill.classList.remove('hidden');
    progressSection.classList.remove('hidden');
    activityLog.innerHTML = '';
    addLog('Starting autofill...', 'info');

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (!tab || !tab.id) {
        addLog('No active tab found', 'error');
        resetAutofillState();
        return;
      }

      chrome.tabs.sendMessage(tab.id, {
        action: 'startAutofill',
        options: {
          apiUrl: apiUrl.value,
          confirmEach: confirmEach.checked,
          autoScroll: autoScroll.checked,
          clickAddButtons: clickAddButtons.checked
        }
      }, (response) => {
        if (chrome.runtime.lastError) {
          addLog('Content script not loaded. Refreshing page may help.', 'error');
          resetAutofillState();
        }
      });
    } catch (error) {
      addLog(`Error: ${error.message}`, 'error');
      resetAutofillState();
    }
  });

  stopAutofill.addEventListener('click', async () => {
    isAutofilling = false;
    resetAutofillState();

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id) {
        chrome.tabs.sendMessage(tab.id, { action: 'stopAutofill' });
      }
    } catch (error) {
      console.error('Error stopping:', error);
    }
    
    addLog('Autofill stopped by user', 'info');
  });

  function resetAutofillState() {
    isAutofilling = false;
    startAutofill.classList.remove('hidden');
    stopAutofill.classList.add('hidden');
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'progress':
        updateProgress(message.current, message.total);
        break;
      
      case 'log':
        addLog(message.text, message.level);
        break;
      
      case 'completed':
        resetAutofillState();
        addLog('Autofill completed!', 'success');
        break;
      
      case 'error':
        addLog(`Error: ${message.text}`, 'error');
        break;
    }
  });

  function updateProgress(current, total) {
    const percentage = total > 0 ? (current / total) * 100 : 0;
    progressFill.style.width = `${percentage}%`;
    progressText.textContent = `${current} / ${total} fields filled`;
  }

  function addLog(text, level = 'info') {
    const entry = document.createElement('div');
    entry.className = `log-entry ${level}`;
    entry.textContent = `${new Date().toLocaleTimeString()}: ${text}`;
    activityLog.insertBefore(entry, activityLog.firstChild);
    
    while (activityLog.children.length > 50) {
      activityLog.removeChild(activityLog.lastChild);
    }
  }
});
