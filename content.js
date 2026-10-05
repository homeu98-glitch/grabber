// Listen for messages from the popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "grabData") {
    // Find potential "amounts" on the page using a simple regex
    const bodyText = document.body.innerText;
    const priceMatches = bodyText.match(/\$\d+(?:\.\d{2})?/g) || [];

    const pageData = {
      title: document.title,
      url: window.location.href,
      potentialAmounts: priceMatches.slice(0, 5) // Grab first 5 found prices
    };
    sendResponse(pageData);
  }
  return true;
});