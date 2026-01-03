chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'log') {
    console.log(`[Autofiller] ${message.level}: ${message.text}`);
  }

  if (message.type === 'progress' || message.type === 'completed' || message.type === 'log') {
    chrome.runtime.sendMessage(message).catch(() => {});
  }

  return false;
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });
  }
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('AI Resume Autofiller installed');
  
  chrome.storage.local.set({
    apiUrl: 'http://localhost:5000',
    options: {
      confirmEach: true,
      autoScroll: true,
      clickAddButtons: true
    }
  });
});
