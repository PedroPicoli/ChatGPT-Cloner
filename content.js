/**
 * ChatGPT Cloner
 * Content Script - Injects clone button and handles conversation extraction
 */

(function () {
  'use strict';

  // ============================================
  // Constants
  // ============================================

  const SELECTORS = {
    // Header area where we'll inject the button
    header: 'main header, [class*="sticky"][class*="top-0"]',
    modelSelector: 'button[aria-label*="Model"], button[data-testid="model-selector"]',

    // Conversation messages
    conversationTurn: '[data-testid^="conversation-turn-"]',
    messageAuthor: '[data-message-author-role]',
    messageContent: '.markdown, .prose, [class*="markdown"]',

    // Input area
    promptTextarea: '#prompt-textarea',
    fileInput: 'input[type="file"]',
    sendButton: 'button[data-testid="send-button"], button[aria-label*="Send"]'
  };

  const CLONE_PROMPT = `I'm attaching a conversation I had previously with you. Please read it carefully and continue from where we left off, keeping all the context and knowledge from that conversation. You can refer back to it as needed.

This is a cloned conversation - please acknowledge that you've received the context and are ready to continue.`;

  // ============================================
  // Utility Functions
  // ============================================

  function waitForElement(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const element = document.querySelector(selector);
      if (element) {
        resolve(element);
        return;
      }

      const observer = new MutationObserver((mutations, obs) => {
        const element = document.querySelector(selector);
        if (element) {
          obs.disconnect();
          resolve(element);
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });

      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timeout waiting for element: ${selector}`));
      }, timeout);
    });
  }

  function showToast(message, type = 'info', duration = 3000) {
    const existing = document.querySelector('.clone-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `clone-toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => {
      toast.classList.add('visible');
    });

    setTimeout(() => {
      toast.classList.remove('visible');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  function createCloneIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.innerHTML = `
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    `;
    return svg;
  }

  function createSpinnerIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.innerHTML = `
      <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
    `;
    return svg;
  }

  // ============================================
  // Conversation Extraction
  // ============================================

  /**
   * Extract all messages by intelligently finding the scroll container and traversing it.
   */
  async function extractConversation() {
    showToast('Initializing extraction...', 'info', 2000);
    await new Promise(resolve => setTimeout(resolve, 800));

    const allMessages = new Map();

    // Find the scroll container relative to the messages (ancestor traversal)
    const findScrollContainer = () => {
      const turn = document.querySelector(SELECTORS.conversationTurn);
      if (!turn) {
        // Fallback for empty states
        return document.querySelector('main');
      }

      let parent = turn.parentElement;
      while (parent) {
        const style = window.getComputedStyle(parent);
        const isScrollable = parent.scrollHeight > parent.clientHeight;
        const hasOverflow = style.overflowY === 'auto' || style.overflowY === 'scroll';

        if (isScrollable && hasOverflow) {
          return parent;
        }

        if (parent === document.body) break;
        parent = parent.parentElement;
      }

      // Fallback candidates
      return document.querySelector('main div[class*="react-scroll-to-bottom"]') ||
        document.querySelector('[class*="ConversationPanel"] > div') ||
        document.querySelector('div[class*="overflow-y-auto"]');
    };

    const scrollContainer = findScrollContainer();

    if (!scrollContainer) {
      console.error('[ChatGPT Cloner] Scroll container not found');
      showToast('Error: structure detection failed', 'error');
      return [];
    }

    showToast(`Reading conversation...`, 'info', 2000);

    // Collection logic
    const collectVisible = () => {
      const turns = document.querySelectorAll(SELECTORS.conversationTurn);
      turns.forEach((turn) => {
        const testId = turn.getAttribute('data-testid');
        const match = testId?.match(/conversation-turn-(\d+)/);
        if (!match) return;

        const turnIndex = parseInt(match[1], 10);
        if (allMessages.has(turnIndex)) return;

        const authorElement = turn.querySelector(SELECTORS.messageAuthor);
        const contentElements = turn.querySelectorAll(SELECTORS.messageContent);

        // Determine role
        let role = 'User';
        if (authorElement) {
          const attr = authorElement.getAttribute('data-message-author-role');
          if (attr === 'assistant') role = 'Assistant';
        } else {
          if (turn.querySelector('.text-token-text-secondary') || turn.querySelector('svg[data-is-assistant="true"]')) {
            role = 'Assistant';
          }
        }

        // Collect content
        let fullContent = '';
        if (contentElements.length === 0 && role === 'User') {
          const userContent = turn.querySelector('[data-message-author-role="user"] > div');
          if (userContent) fullContent = userContent.innerText.trim();
          else fullContent = turn.innerText.trim();
        } else {
          contentElements.forEach((el) => {
            const text = el.innerText.trim();
            if (text) fullContent += (fullContent ? '\n\n' : '') + text;
          });
        }

        if (fullContent) {
          allMessages.set(turnIndex, {
            role: role,
            content: fullContent,
            index: turnIndex
          });
        }
      });
    };

    // 1. Reset to Top
    scrollContainer.scrollTop = 0;
    await new Promise(resolve => setTimeout(resolve, 500));
    collectVisible();

    // 2. Double check first message
    if (allMessages.size === 0 || !allMessages.has(1)) {
      scrollContainer.scrollTop = 10;
      await new Promise(resolve => setTimeout(resolve, 200));
      collectVisible();
    }

    // 3. Scroll Loop
    let scrollCount = 0;
    const maxScrolls = 3000;
    const scrollStep = scrollContainer.clientHeight * 0.85;
    let noMovementCount = 0;

    while (scrollCount < maxScrolls) {
      const beforeScroll = scrollContainer.scrollTop;
      scrollContainer.scrollTop += scrollStep;

      await new Promise(resolve => setTimeout(resolve, 150)); // Optimized delay
      collectVisible();

      const afterScroll = scrollContainer.scrollTop;
      scrollCount++;

      if (Math.abs(afterScroll - beforeScroll) < 5) {
        noMovementCount++;

        // Anti-stuck mechanisms
        if (noMovementCount >= 2) {
          scrollContainer.scrollTop += 5000;
          await new Promise(resolve => setTimeout(resolve, 300));
          collectVisible();
        }

        if (noMovementCount >= 5) {
          // Bottom check
          const prevPos = scrollContainer.scrollTop;
          scrollContainer.scrollTop = scrollContainer.scrollHeight;
          await new Promise(resolve => setTimeout(resolve, 300));
          collectVisible();

          if (scrollContainer.scrollTop === prevPos) break;
        }
      } else {
        noMovementCount = 0;
      }

      if (scrollCount % 20 === 0) {
        const progress = Math.round((scrollContainer.scrollTop / scrollContainer.scrollHeight) * 100);
        showToast(`Reading... ${progress}%`, 'info', 800);
      }
    }

    collectVisible();
    scrollContainer.scrollTop = 0;

    const messages = Array.from(allMessages.values()).sort((a, b) => a.index - b.index);
    return messages;
  }

  function messagesToMarkdown(messages) {
    const timestamp = new Date().toISOString().split('T')[0];
    let markdown = `# Clone\n\n`;
    markdown += `> This conversation was cloned on ${timestamp}\n\n`;
    markdown += `---\n\n`;
    markdown += `**SYSTEM PROMPT / CONTEXT:**\n`;
    markdown += `${CLONE_PROMPT}\n\n`;
    markdown += `---\n\n`;

    messages.forEach((msg, idx) => {
      markdown += `### ${msg.role}:\n\n`;
      markdown += `${msg.content}\n\n`;
      if (idx < messages.length - 1) {
        markdown += `---\n\n`;
      }
    });
    return markdown;
  }

  function createMarkdownFile(markdown) {
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const timestamp = Date.now();
    return new File([blob], `conversation_${timestamp}.md`, { type: 'text/markdown' });
  }

  // ============================================
  // Clone Action
  // ============================================

  async function handleClone(button) {
    try {
      button.classList.add('loading');
      button.innerHTML = '';
      button.appendChild(createSpinnerIcon());
      showToast('Starting cloning process...', 'info');

      const messages = await extractConversation();

      if (messages.length === 0) {
        throw new Error('No messages found');
      }

      const markdown = messagesToMarkdown(messages);
      showToast(`Extracted ${messages.length} messages. Opening new chat...`, 'success');

      sessionStorage.setItem('cloneData', JSON.stringify({
        markdown: markdown,
        messageCount: messages.length,
        timestamp: Date.now()
      }));

      window.location.href = 'https://chatgpt.com/';

    } catch (error) {
      console.error(error);
      button.classList.remove('loading');
      button.classList.add('error');
      button.innerHTML = '';
      button.appendChild(createCloneIcon());
      showToast('Error extracting conversation', 'error');

      setTimeout(() => {
        button.classList.remove('error');
      }, 2000);
    }
  }

  async function waitForFileProcessing() {
    return new Promise((resolve) => {
      let checkInterval = null;
      let timeout = null;

      const checkAndSend = () => {
        const sendButton = document.querySelector(SELECTORS.sendButton);
        const isButtonReady = sendButton && !sendButton.disabled;

        const loadingElements = document.querySelectorAll('[class*="loading"], [class*="spinner"], [class*="animate-spin"]');
        const hasActiveLoading = Array.from(loadingElements).some(el => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 &&
            style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        });

        if (isButtonReady && !hasActiveLoading) {
          if (checkInterval) clearInterval(checkInterval);
          if (timeout) clearTimeout(timeout);
          resolve(true);
        }
      };

      checkInterval = setInterval(checkAndSend, 300);
      setTimeout(checkAndSend, 800);

      timeout = setTimeout(() => {
        if (checkInterval) clearInterval(checkInterval);
        resolve(false);
      }, 15000);
    });
  }

  async function handleClonedConversation() {
    const data = sessionStorage.getItem('cloneData');
    if (!data) return;

    try {
      const { markdown, messageCount, timestamp } = JSON.parse(data);

      if (Date.now() - timestamp > 30000) {
        sessionStorage.removeItem('cloneData');
        return;
      }

      sessionStorage.removeItem('cloneData');
      showToast('Preparing cloned conversation...', 'info');

      await waitForElement(SELECTORS.promptTextarea);
      await new Promise(resolve => setTimeout(resolve, 1000));

      const fileInput = document.querySelector(SELECTORS.fileInput);
      const file = createMarkdownFile(markdown);

      if (fileInput) {
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        fileInput.files = dataTransfer.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));

        showToast('Attaching context file...', 'info');
        await new Promise(resolve => setTimeout(resolve, 1500));
      }

      const textarea = document.querySelector(SELECTORS.promptTextarea);
      if (textarea) {
        textarea.focus();

        // Robust text insertion that handles both textarea and contenteditable
        if (textarea.tagName === 'TEXTAREA' || textarea.tagName === 'INPUT') {
          textarea.value = CLONE_PROMPT;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          textarea.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          // For contenteditable div (modern ChatGPT)
          // Try execCommand first as it mimics user typing (preserving newlines and updating state)
          textarea.focus();
          const pasted = document.execCommand('insertText', false, CLONE_PROMPT);

          if (!pasted) {
            // Fallback: manually set HTML with proper line breaks
            textarea.innerHTML = `<p>${CLONE_PROMPT.replace(/\n/g, '<br>')}</p>`;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }

        showToast(`Processing context...`, 'info');
        const processed = await waitForFileProcessing();

        if (processed) {
          const sendButton = document.querySelector(SELECTORS.sendButton);
          if (sendButton && !sendButton.disabled) {
            sendButton.click();
            showToast('Conversation cloned successfully!', 'success', 3000);
          }
        } else {
          showToast('Ready to send. Please click send.', 'info', 4000);
        }
      }

    } catch (error) {
      console.error(error);
      sessionStorage.removeItem('cloneData');
    }
  }

  // ============================================
  // Initialization
  // ============================================

  function injectCloneButton() {
    if (document.querySelector('.clone-btn')) return;

    const isInConversation = window.location.pathname.includes('/c/') ||
      window.location.pathname.includes('/g/');

    if (!isInConversation) return;

    const header = document.querySelector(SELECTORS.header);
    if (!header) return;

    let targetButton = header.querySelector(SELECTORS.modelSelector);
    if (!targetButton) targetButton = header.querySelector('button');
    if (!targetButton) return;

    const button = document.createElement('button');
    button.className = 'clone-btn';
    button.setAttribute('aria-label', 'Clone');
    button.setAttribute('data-tooltip', 'Clone');
    button.appendChild(createCloneIcon());

    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleClone(button);
    });

    targetButton.parentNode.insertBefore(button, targetButton.nextSibling);
  }

  function init() {
    handleClonedConversation();
    setTimeout(injectCloneButton, 1000);

    const observer = new MutationObserver(() => {
      clearTimeout(observer.timeout);
      observer.timeout = setTimeout(injectCloneButton, 500);
    });

    observer.observe(document.body, { childList: true, subtree: true });

    let lastUrl = location.href;
    new MutationObserver(() => {
      const url = location.href;
      if (url !== lastUrl) {
        lastUrl = url;
        setTimeout(injectCloneButton, 500);
        handleClonedConversation();
      }
    }).observe(document, { subtree: true, childList: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
