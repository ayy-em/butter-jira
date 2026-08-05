chrome.action.onClicked.addListener(async () => {
  const appUrl = chrome.runtime.getURL("app.html");
  const tabs = await chrome.tabs.query({ url: appUrl });
  if (tabs.length > 0) {
    chrome.tabs.update(tabs[0].id, { active: true });
    chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    chrome.tabs.create({ url: appUrl });
  }
});
