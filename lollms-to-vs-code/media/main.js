// @ts-check
(function () {
    // --- SETUP ---
    // @ts-ignore
    const vscode = acquireVsCodeApi();
    /** @type {import('marked').Marked} */
    // @ts-ignore
    const marked = window.marked;

    /** @param {string} id */
    const S = (id) => document.getElementById(id);

    // --- ELEMENTS ---
    const customPromptTextarea = /** @type {HTMLTextAreaElement | null} */ (S('custom-prompt-textarea'));
    const liveContextView = S('live-context-view');
    const chatForm = S('chat-form');
    const chatInput = /** @type {HTMLTextAreaElement | null} */ (S('chat-input'));
    const chatSendBtn = /** @type {HTMLButtonElement | null} */ (S('chat-send-btn'));
    const chatMessagesContainer = S('chat-messages-container');
    const refreshContextBtn = S('refresh-context-btn');
    const settingsBtn = S('settings-btn');

    // --- STATE ---
    /** @type {{role: string, content: string}[]} */
    let chatHistory = [];
    /** @type {HTMLElement | null} */
    let currentAiBubble = null;

    // --- MESSAGE HANDLING ---
    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.command) {
            case 'requestAndGenerateContext':
                vscode.postMessage({
                    command: 'generateContextRequest',
                    payload: { custom_prompt: customPromptTextarea?.value || '' }
                });
                break;
            case 'contextLoading':
                if (liveContextView) {
                    liveContextView.innerHTML = '<div class="loading-container"><vscode-progress-ring></vscode-progress-ring></div>';
                }
                break;
            case 'response:generateContext':
                renderLiveContext(message.error || message.markdown, message.files);
                if (chatInput) chatInput.disabled = !!message.error;
                if (chatSendBtn) chatSendBtn.disabled = !!message.error;
                chatHistory = [];
                if (!message.error && chatMessagesContainer) {
                    chatMessagesContainer.innerHTML = '<div class="welcome-message"><p>Context loaded. You can now start the discussion.</p></div>';
                }
                break;
            case 'chatChunk':
                appendAiMessageChunk(message.chunk);
                break;
            case 'chatError':
                appendErrorMessage(message.error);
                break;
            case 'chatEnd':
                finalizeAiMessage();
                break;
        }
    });

    /**
     * @param {string} markdown
     * @param {string[]} files
     */
    function renderLiveContext(markdown, files = []) {
        if (!liveContextView) return;
        liveContextView.innerHTML = '';
        if (!markdown) return;

        const renderedHtml = marked.parse(markdown, { breaks: true, gfm: true });
        if(typeof renderedHtml === 'string') {
            liveContextView.innerHTML = renderedHtml;
        }

        liveContextView.querySelectorAll('h3 > code').forEach(codeEl => {
            const h3 = /** @type {HTMLElement} */ (codeEl.parentElement);
            const relativePath = codeEl.textContent || '';
            const fullPath = files.find(f => f.replace(/\\/g, '/').endsWith(relativePath));
            
            if (fullPath) {
                const removeBtn = document.createElement('span');
                removeBtn.className = 'remove-btn codicon codicon-trash';
                removeBtn.title = 'Exclude this file from context';
                removeBtn.dataset.path = fullPath;
                removeBtn.addEventListener('click', (e) => {
                    const target = /** @type {HTMLElement} */ (e.currentTarget);
                    if (target.dataset.path) {
                        vscode.postMessage({ command: 'removeFile', path: target.dataset.path });
                    }
                });
                h3.prepend(removeBtn);
            }
        });
    }

    /**
     * @param {string} htmlContent
     * @param {'user' | 'ai'} type
     */
    const renderChatMessage = (htmlContent, type) => {
        if (!chatMessagesContainer) return null;
        const messageDiv = document.createElement('div');
        messageDiv.className = `chat-message ${type}`;
        const bubble = document.createElement('div');
        bubble.className = 'chat-bubble';
        bubble.innerHTML = htmlContent;
        if (type === 'ai') {
            const icon = document.createElement('span');
            icon.className = 'icon codicon codicon-hubot';
            messageDiv.appendChild(icon);
            bubble.querySelectorAll('pre').forEach(addCopyButton);
        }
        messageDiv.appendChild(bubble);
        chatMessagesContainer.appendChild(messageDiv);
        chatMessagesContainer.scrollTop = chatMessagesContainer.scrollHeight;
        return bubble;
    };

    /** @param {HTMLPreElement} pre */
    function addCopyButton(pre) {
        const button = document.createElement('button');
        button.className = 'copy-code-btn';
        button.innerHTML = '<span class="codicon codicon-copy"></span>';
        button.title = 'Copy Code';
        button.addEventListener('click', () => {
            const code = pre.querySelector('code');
            if (code) { navigator.clipboard.writeText(code.innerText); }
        });
        pre.appendChild(button);
    }
    
    /** @param {string} chunk */
    const appendAiMessageChunk = (chunk) => {
        if (!currentAiBubble) {
            if (chatMessagesContainer?.querySelector('.welcome-message')) {
                chatMessagesContainer.innerHTML = '';
            }
            currentAiBubble = renderChatMessage('', 'ai');
        }
        if (currentAiBubble) {
            currentAiBubble.textContent += chunk;
        }
    };
    
    /** @param {string} error */
    const appendErrorMessage = (error) => {
        finalizeAiMessage();
        const bubble = renderChatMessage(error, 'ai');
        if (bubble) { bubble.style.color = 'var(--vscode-errorForeground)'; }
    };

    const finalizeAiMessage = async () => {
        if (currentAiBubble) {
            const parsedHtml = await marked.parse(currentAiBubble.textContent || '', { breaks: true, gfm: true });
            currentAiBubble.innerHTML = parsedHtml;
            currentAiBubble.querySelectorAll('pre').forEach(addCopyButton);
        }
        if (chatSendBtn) { chatSendBtn.disabled = false; }
        if (chatInput) { chatInput.disabled = false; }
        currentAiBubble = null;
    };

    if (chatForm) {
        chatForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const userInput = chatInput?.value.trim();
            if (!userInput || chatSendBtn?.disabled) { return; }
            if (!liveContextView?.innerText.trim() || liveContextView?.querySelector('.loading-container')) {
                 vscode.postMessage({ command: 'showError', text: 'Please generate the context first.' });
                 return;
            }
            if(chatSendBtn) { chatSendBtn.disabled = true; }
            if(chatInput) { chatInput.value = ''; }
            if (chatMessagesContainer?.querySelector('.welcome-message')) { chatMessagesContainer.innerHTML = ''; }
            renderChatMessage(userInput, 'user');
            if (chatHistory.length === 0) {
                chatHistory.push({ role: 'system', content: `CONTEXT:\n${liveContextView?.innerText}` });
            }
            chatHistory.push({ role: 'user', content: userInput });
            currentAiBubble = null;
            vscode.postMessage({ command: 'chatRequest', payload: { messages: chatHistory } });
        });
    }

    if (refreshContextBtn) {
        refreshContextBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'refreshContext' });
        });
    }
    if (settingsBtn) {
        settingsBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'openSettings' });
        });
    }
})();