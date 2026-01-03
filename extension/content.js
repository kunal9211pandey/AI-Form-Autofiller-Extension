(() => {
  let isAutofilling = false;
  let options = {};
  let filledCount = 0;
  let totalFields = 0;

  const FORM_FIELD_SELECTORS = [
    'input[type="text"]',
    'input[type="email"]',
    'input[type="tel"]',
    'input[type="number"]',
    'input[type="url"]',
    'input[type="date"]',
    'input:not([type])',
    'textarea',
    'select'
  ].join(', ');

  const ADD_BUTTON_PATTERNS = [
    /add\s*(more|another|new|entry)?/i,
    /\+\s*(add|new)/i,
    /insert/i,
    /create\s*new/i
  ];

  const SKIP_FIELDS = [
    'password',
    'captcha',
    'file',
    'submit',
    'button',
    'hidden',
    'csrf',
    'token',
    'search'
  ];

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'startAutofill') {
      options = message.options;
      startAutofill();
      sendResponse({ started: true });
    } else if (message.action === 'stopAutofill') {
      isAutofilling = false;
      sendResponse({ stopped: true });
    }
    return true;
  });

  function log(text, level = 'info') {
    console.log(`[Autofiller] ${level}: ${text}`);
    chrome.runtime.sendMessage({ type: 'log', text, level });
  }

  function updateProgress() {
    chrome.runtime.sendMessage({ type: 'progress', current: filledCount, total: totalFields });
  }

  async function startAutofill() {
    isAutofilling = true;
    filledCount = 0;
    log('Starting autofill...', 'info');

    const fields = detectFormFields();
    totalFields = fields.length;
    updateProgress();

    if (fields.length === 0) {
      log('No form fields detected on this page', 'error');
      chrome.runtime.sendMessage({ type: 'completed' });
      return;
    }

    log(`Found ${fields.length} form fields`, 'info');

    for (const field of fields) {
      if (!isAutofilling) break;

      try {
        await fillField(field);
        filledCount++;
        updateProgress();
        await sleep(300);
      } catch (error) {
        log(`Error filling ${field.label}: ${error.message}`, 'error');
      }
    }

    if (options.clickAddButtons) {
      await handleMultiSections();
    }

    isAutofilling = false;
    chrome.runtime.sendMessage({ type: 'completed' });
    log('Autofill completed!', 'success');
  }

  function detectFormFields() {
    const fields = [];
    const elements = document.querySelectorAll(FORM_FIELD_SELECTORS);

    elements.forEach(element => {
      if (shouldSkipField(element)) return;

      const fieldInfo = {
        element,
        label: getFieldLabel(element),
        type: getFieldType(element),
        name: element.name || element.id || '',
        context: getFieldContext(element)
      };

      if (fieldInfo.label || fieldInfo.name) {
        fields.push(fieldInfo);
      }
    });

    return fields;
  }

  function shouldSkipField(element) {
    const type = (element.type || '').toLowerCase();
    const name = (element.name || '').toLowerCase();
    const id = (element.id || '').toLowerCase();

    if (SKIP_FIELDS.some(skip => type.includes(skip) || name.includes(skip) || id.includes(skip))) {
      return true;
    }

    if (element.disabled || element.readOnly) return true;
    if (element.offsetParent === null) return true;
    if (element.value && element.value.trim() !== '') return true;

    return false;
  }

  function getFieldLabel(element) {
    if (element.id) {
      const label = document.querySelector(`label[for="${element.id}"]`);
      if (label) return label.textContent.trim();
    }

    const parent = element.closest('label');
    if (parent) return parent.textContent.replace(element.value, '').trim();

    const labelLike = element.closest('.form-group, .field, .input-wrapper, .form-field');
    if (labelLike) {
      const labelEl = labelLike.querySelector('label, .label, span:first-child');
      if (labelEl) return labelEl.textContent.trim();
    }

    if (element.placeholder) return element.placeholder;
    if (element.getAttribute('aria-label')) return element.getAttribute('aria-label');
    if (element.name) return formatFieldName(element.name);
    if (element.id) return formatFieldName(element.id);

    return '';
  }

  function formatFieldName(name) {
    return name
      .replace(/[-_]/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\b\w/g, c => c.toUpperCase())
      .trim();
  }

  function getFieldType(element) {
    if (element.tagName === 'SELECT') return 'select';
    if (element.tagName === 'TEXTAREA') return 'textarea';
    return element.type || 'text';
  }

  function getFieldContext(element) {
    const context = [];

    const section = element.closest('section, fieldset, .section, .card, form');
    if (section) {
      const heading = section.querySelector('h1, h2, h3, h4, legend, .title, .heading');
      if (heading) context.push(heading.textContent.trim());
    }

    const sibling = element.previousElementSibling;
    if (sibling && sibling.textContent.length < 100) {
      context.push(sibling.textContent.trim());
    }

    return context.join(' | ');
  }

  async function fillField(field) {
    const { element, label, type, context } = field;

    if (options.autoScroll) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(200);
    }

    highlightField(element, 'pending');

    try {
      const response = await fetch(`${options.apiUrl}/api/autofill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          field_label: label,
          field_type: type,
          context: context,
          existing_value: element.value
        })
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json();

      if (data.needs_manual) {
        highlightField(element, 'manual');
        const result = await showManualInputOverlay(label, data.suggestion || 'AI could not determine the value');
        if (!result.skipped && result.value) {
          setFieldValue(element, result.value);
          highlightField(element, 'success');
          log(`Filled "${label}" (manual): ${result.value}`, 'success');
        } else {
          highlightField(element, 'skipped');
          log(`Skipped "${label}"`, 'info');
        }
      } else if (data.value) {
        if (options.confirmEach) {
          const confirmed = await showConfirmationOverlay(label, data.value);
          if (confirmed) {
            setFieldValue(element, data.value);
            highlightField(element, 'success');
            log(`Filled "${label}": ${data.value}`, 'success');
          } else {
            const result = await showManualInputOverlay(label, data.value);
            if (!result.skipped && result.value) {
              setFieldValue(element, result.value);
              highlightField(element, 'success');
            } else {
              highlightField(element, 'skipped');
            }
          }
        } else {
          setFieldValue(element, data.value);
          highlightField(element, 'success');
          log(`Filled "${label}": ${data.value}`, 'success');
        }
      } else {
        highlightField(element, 'skipped');
        log(`No value for "${label}"`, 'info');
      }
    } catch (error) {
      highlightField(element, 'error');
      throw new Error(`API call failed: ${error.message}`);
    }
  }

  function setFieldValue(element, value) {
    if (element.tagName === 'SELECT') {
      const option = Array.from(element.options).find(opt => 
        opt.text.toLowerCase().includes(value.toLowerCase()) ||
        opt.value.toLowerCase().includes(value.toLowerCase())
      );
      if (option) {
        element.value = option.value;
      }
    } else {
      element.value = value;
    }

    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function highlightField(element, status) {
    element.classList.remove('autofill-highlight', 'autofill-success', 'autofill-error', 'autofill-pending', 'autofill-skipped');
    
    const statusClasses = {
      'pending': 'autofill-pending',
      'success': 'autofill-success',
      'error': 'autofill-error',
      'manual': 'autofill-pending',
      'skipped': 'autofill-highlight'
    };
    
    if (statusClasses[status]) {
      element.classList.add(statusClasses[status]);
    }
    
    setTimeout(() => {
      element.classList.remove('autofill-success', 'autofill-error', 'autofill-pending', 'autofill-highlight', 'autofill-skipped');
    }, 3000);
  }

  function showManualInputOverlay(fieldLabel, suggestion) {
    return new Promise(resolve => {
      removeExistingOverlay();
      
      const overlay = document.createElement('div');
      overlay.id = 'autofill-overlay';
      overlay.className = 'autofill-overlay';
      overlay.innerHTML = `
        <div class="autofill-overlay-header">
          <span class="autofill-overlay-title">Manual Input Required</span>
          <button class="autofill-overlay-close">&times;</button>
        </div>
        <div class="autofill-overlay-content">
          <div class="autofill-overlay-field">${escapeHtml(fieldLabel)}</div>
          <input type="text" class="autofill-overlay-input" placeholder="${escapeHtml(suggestion)}" autofocus>
        </div>
        <div class="autofill-overlay-buttons">
          <button class="autofill-overlay-btn autofill-overlay-btn-primary">Submit</button>
          <button class="autofill-overlay-btn autofill-overlay-btn-secondary">Skip</button>
        </div>
      `;
      
      document.body.appendChild(overlay);
      
      const input = overlay.querySelector('.autofill-overlay-input');
      const submitBtn = overlay.querySelector('.autofill-overlay-btn-primary');
      const skipBtn = overlay.querySelector('.autofill-overlay-btn-secondary');
      const closeBtn = overlay.querySelector('.autofill-overlay-close');
      
      input.focus();
      
      const cleanup = (result) => {
        overlay.remove();
        resolve(result);
      };
      
      submitBtn.addEventListener('click', () => cleanup({ value: input.value, skipped: false }));
      skipBtn.addEventListener('click', () => cleanup({ value: '', skipped: true }));
      closeBtn.addEventListener('click', () => cleanup({ value: '', skipped: true }));
      
      input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') cleanup({ value: input.value, skipped: false });
        if (e.key === 'Escape') cleanup({ value: '', skipped: true });
      });
    });
  }

  function showConfirmationOverlay(fieldLabel, value) {
    return new Promise(resolve => {
      removeExistingOverlay();
      
      const overlay = document.createElement('div');
      overlay.id = 'autofill-overlay';
      overlay.className = 'autofill-overlay';
      overlay.innerHTML = `
        <div class="autofill-overlay-header">
          <span class="autofill-overlay-title">Confirm Value</span>
          <button class="autofill-overlay-close">&times;</button>
        </div>
        <div class="autofill-overlay-content">
          <div class="autofill-overlay-field">${escapeHtml(fieldLabel)}</div>
          <div class="autofill-overlay-value">${escapeHtml(value)}</div>
        </div>
        <div class="autofill-overlay-buttons">
          <button class="autofill-overlay-btn autofill-overlay-btn-primary">Accept</button>
          <button class="autofill-overlay-btn autofill-overlay-btn-secondary">Edit</button>
        </div>
      `;
      
      document.body.appendChild(overlay);
      
      const acceptBtn = overlay.querySelector('.autofill-overlay-btn-primary');
      const editBtn = overlay.querySelector('.autofill-overlay-btn-secondary');
      const closeBtn = overlay.querySelector('.autofill-overlay-close');
      
      const cleanup = (result) => {
        overlay.remove();
        resolve(result);
      };
      
      acceptBtn.addEventListener('click', () => cleanup(true));
      editBtn.addEventListener('click', () => cleanup(false));
      closeBtn.addEventListener('click', () => cleanup(false));
    });
  }

  function removeExistingOverlay() {
    const existing = document.getElementById('autofill-overlay');
    if (existing) existing.remove();
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  async function handleMultiSections() {
    const addButtons = findAddButtons();
    
    for (const button of addButtons) {
      if (!isAutofilling) break;

      const section = detectButtonSection(button);
      log(`Found "Add" button for ${section}`, 'info');

      const shouldClick = await showConfirmationOverlay(`Click "Add" button for ${section}?`, 'This will add another entry');
      if (shouldClick) {
        button.click();
        await sleep(500);

        const newFields = detectFormFields();
        for (const field of newFields) {
          if (!isAutofilling) break;
          if (!field.element.value) {
            await fillField(field);
          }
        }
      }
    }
  }

  function findAddButtons() {
    const buttons = document.querySelectorAll('button, input[type="button"], a.btn, .add-button');
    return Array.from(buttons).filter(btn => {
      const text = btn.textContent || btn.value || '';
      return ADD_BUTTON_PATTERNS.some(pattern => pattern.test(text));
    });
  }

  function detectButtonSection(button) {
    const container = button.closest('section, fieldset, .section, .card, form');
    if (container) {
      const heading = container.querySelector('h1, h2, h3, h4, legend');
      if (heading) return heading.textContent.trim();
    }
    return 'section';
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  injectStyles();

  function injectStyles() {
    if (document.getElementById('autofill-injected-styles')) return;
    
    const style = document.createElement('style');
    style.id = 'autofill-injected-styles';
    style.textContent = `
      .autofill-overlay {
        position: fixed;
        top: 20px;
        right: 20px;
        background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
        color: #e0e0e0;
        padding: 16px 20px;
        border-radius: 12px;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        min-width: 280px;
        max-width: 350px;
      }
      .autofill-overlay-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 12px;
        padding-bottom: 8px;
        border-bottom: 1px solid #333;
      }
      .autofill-overlay-title {
        color: #4fc3f7;
        font-weight: 600;
        font-size: 15px;
      }
      .autofill-overlay-close {
        background: none;
        border: none;
        color: #888;
        font-size: 20px;
        cursor: pointer;
        padding: 0;
        line-height: 1;
      }
      .autofill-overlay-close:hover { color: #fff; }
      .autofill-overlay-content { margin-bottom: 12px; }
      .autofill-overlay-field {
        color: #81d4fa;
        font-weight: 500;
        margin-bottom: 8px;
      }
      .autofill-overlay-value {
        background: rgba(255, 255, 255, 0.1);
        padding: 8px 12px;
        border-radius: 6px;
        word-break: break-word;
      }
      .autofill-overlay-input {
        width: 100%;
        padding: 10px;
        border: 1px solid #444;
        border-radius: 6px;
        background: #2a2a3e;
        color: #fff;
        font-size: 14px;
        box-sizing: border-box;
      }
      .autofill-overlay-input:focus {
        outline: none;
        border-color: #4fc3f7;
      }
      .autofill-overlay-buttons {
        display: flex;
        gap: 8px;
      }
      .autofill-overlay-btn {
        flex: 1;
        padding: 10px;
        border: none;
        border-radius: 6px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: background 0.2s;
      }
      .autofill-overlay-btn-primary {
        background: #4fc3f7;
        color: #1a1a2e;
      }
      .autofill-overlay-btn-primary:hover { background: #29b6f6; }
      .autofill-overlay-btn-secondary {
        background: #444;
        color: #fff;
      }
      .autofill-overlay-btn-secondary:hover { background: #555; }
      .autofill-pending {
        outline: 3px solid #ff9800 !important;
        outline-offset: 2px !important;
      }
      .autofill-success {
        outline: 3px solid #4caf50 !important;
        outline-offset: 2px !important;
      }
      .autofill-error {
        outline: 3px solid #f44336 !important;
        outline-offset: 2px !important;
      }
      .autofill-highlight {
        outline: 3px solid #4fc3f7 !important;
        outline-offset: 2px !important;
      }
    `;
    document.head.appendChild(style);
  }
})();
