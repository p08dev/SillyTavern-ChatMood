// ChatMood - persistent per-chat emotional state for SillyTavern's main chat.
// Ports EchoText's Plutchik emotion engine (see lib/emotion-engine.js) to run
// against the main chat window instead of EchoText's own side panel: state is
// stored per-chat (chat_metadata), not per-character, and has no time-based
// decay — mood only changes when a message is actually processed.

(function () {
    'use strict';

    // ── Module loading (same synchronous-XHR pattern as SillyTavern-EchoText) ──

    const scripts = document.querySelectorAll('script[src*="index.js"]');
    let BASE_URL = '';
    for (const script of scripts) {
        if (script.src.includes('ChatMood')) {
            try {
                const urlObj = new URL(script.src, window.location.href);
                BASE_URL = urlObj.origin + urlObj.pathname.split('/').slice(0, -1).join('/');
            } catch (e) {
                BASE_URL = script.src.split('?')[0].split('/').slice(0, -1).join('/');
            }
            break;
        }
    }
    if (!BASE_URL) {
        BASE_URL = '/scripts/extensions/third-party/ChatMood';
    }

    function loadChatMoodModule(relativePath, globalKey) {
        if (window[globalKey]) return;
        const xhr = new XMLHttpRequest();
        xhr.open('GET', `${BASE_URL}/${relativePath}`, false);
        xhr.send();
        if (xhr.status < 200 || xhr.status >= 300) {
            console.error(`[ChatMood] Failed to load module ${relativePath}: HTTP ${xhr.status}`);
            throw new Error(`Failed to load module ${relativePath}: HTTP ${xhr.status}`);
        }
        // eslint-disable-next-line no-new-func
        new Function(xhr.responseText)();
        if (!window[globalKey]) {
            throw new Error(`Module loaded but global '${globalKey}' is missing (${relativePath})`);
        }
    }

    loadChatMoodModule('lib/emotion-engine.js', 'ChatMoodEmotionEngine');

    // ── ST context helpers ──────────────────────────────────────────────────
    // Re-fetch getContext() on every access rather than caching it once: ST
    // reassigns chat_metadata to a new object on every chat switch, so a
    // cached reference would go stale after CHAT_CHANGED.

    function ctx() {
        return SillyTavern.getContext();
    }

    // UI chrome strings only — Plutchik emotion/intensity names (Love, Joy,
    // Fondness, Ecstasy, ...) stay in English: they double as the text sent
    // to the LLM in buildEmotionContext(), which shouldn't follow the UI
    // language. Uses the English text itself as the translation-file key,
    // matching ST's own translate() default (see i18n/de-de.json).
    function tr(text) {
        return ctx().translate(text);
    }

    // extension_prompt_types.IN_PROMPT = 0, extension_prompt_roles.SYSTEM = 0
    // (not exposed via getContext(); values per public/script.js).
    const EXTENSION_PROMPT_TYPE_IN_PROMPT = 0;
    const EXTENSION_PROMPT_ROLE_SYSTEM = 0;
    const PROMPT_KEY = 'ChatMood';
    const DISABLED_COLOR = '#888888';

    // ── Group chat support ───────────────────────────────────────────────────
    // Members are identified by avatar filename (ST's own convention —
    // mes.original_avatar, group.members — since display names aren't
    // guaranteed unique). State per member lives under a *new*
    // chat_metadata.chatMoodGroup key, keeping the existing single-character
    // chat_metadata.chatMood path (and its data) completely untouched for 1:1
    // chats.
    //
    // currentProcessingKey lets the three places that must target one
    // specific member explicitly (processMessageEmotion for a broadcast user
    // message or a single character's own reply; buildEmotionContext for a
    // specific member's prompt block) override which member api.getState()/
    // saveState()/getCurrentCharacter() resolve to. Everywhere else (badge,
    // popup, reset button) falls through to getActiveGroupMemberAvatar() —
    // "whichever member the UI is currently showing".
    let currentProcessingKey = null;
    function withGroupMember(avatar, fn) {
        const prev = currentProcessingKey;
        currentProcessingKey = avatar;
        try {
            return fn();
        } finally {
            currentProcessingKey = prev;
        }
    }

    function getCurrentGroup() {
        const context = ctx();
        if (!context.groupId) return null;
        return context.groups?.find(g => g.id === context.groupId) || null;
    }

    function getGroupMembers() {
        return getCurrentGroup()?.members || [];
    }

    function getActiveGroupMembers() {
        const group = getCurrentGroup();
        if (!group) return [];
        const disabled = new Set(group.disabled_members || []);
        return (group.members || []).filter(avatar => !disabled.has(avatar));
    }

    function getLastSpeakingMember() {
        const chat = ctx().chat || [];
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i]?.original_avatar) return chat[i].original_avatar;
        }
        return null;
    }

    // Ephemeral (not persisted) — the member the popup switcher is currently
    // pinned to, if any. Reset on chat change.
    let selectedGroupMember = null;

    // "Whose mood is the UI currently showing" — the popup switcher's choice
    // if still valid, else whoever spoke most recently, else the first active
    // member, else null (empty/fully-muted group — badge/popup hide).
    function getActiveGroupMemberAvatar() {
        const members = getGroupMembers();
        if (selectedGroupMember && members.includes(selectedGroupMember)) return selectedGroupMember;
        const last = getLastSpeakingMember();
        if (last && members.includes(last)) return last;
        return getActiveGroupMembers()[0] || members[0] || null;
    }

    function getGroupMemberCharacter(avatar) {
        if (!avatar) return null;
        return ctx().characters?.find(c => c.avatar === avatar) || null;
    }

    const api = {
        baseUrl: BASE_URL,
        getState() {
            const context = ctx();
            if (!context.groupId) return context.chatMetadata?.chatMood || null;
            const key = currentProcessingKey || getActiveGroupMemberAvatar();
            return key ? (context.chatMetadata?.chatMoodGroup?.[key] || null) : null;
        },
        saveState(state) {
            const context = ctx();
            if (!context.groupId) {
                context.chatMetadata.chatMood = state;
            } else {
                const key = currentProcessingKey || getActiveGroupMemberAvatar();
                if (!key) return;
                if (!context.chatMetadata.chatMoodGroup) context.chatMetadata.chatMoodGroup = {};
                context.chatMetadata.chatMoodGroup[key] = state;
            }
            context.saveMetadataDebounced();
        },
        getCurrentCharacter() {
            const context = ctx();
            if (!context.groupId) return context.characters?.[context.characterId] || null;
            return getGroupMemberCharacter(currentProcessingKey || getActiveGroupMemberAvatar());
        },
        getChatHistory() {
            return ctx().chat || [];
        },
        getKeywordLanguage() {
            return getKeywordLanguage();
        },
        getMbtiInferenceLanguage() {
            return getMbtiInferenceLanguage();
        },
        getTokenSaverMode() {
            return getTokenSaverMode();
        },
        getTimeDecayEnabled() {
            return getTimeDecayEnabled();
        },
    };

    const engine = window.ChatMoodEmotionEngine.createEmotionEngine(api);

    function hasOpenChat() {
        return !!ctx().getCurrentChatId();
    }

    // ── Global default + per-chat disable toggle ────────────────────────────
    // Per-chat state lives in chat_metadata, same as the mood state itself —
    // an explicit toggle applies to just that chat. Chats that have never
    // been explicitly toggled (chatMoodDisabled === undefined) fall back to
    // the global "enabled by default" setting below.

    function getEnabledByDefault() {
        return ctx().extensionSettings.ChatMood?.enabledByDefault !== false;
    }

    // ── Static position mode ─────────────────────────────────────────────────
    // Pins the badge + popup above the chat box (#send_form) instead of the
    // free-floating draggable position. Off by default — the badge/popup
    // clamp against their real measured size now (see applyDraggableBadgePosition),
    // so they can't end up off-screen; this is an opt-in alternative for
    // anyone who'd rather not deal with dragging at all.
    function isStaticPositionEnabled() {
        return !!ctx().extensionSettings.ChatMood?.staticPosition;
    }

    function setStaticPositionEnabled(value) {
        const context = ctx();
        if (!context.extensionSettings.ChatMood) context.extensionSettings.ChatMood = {};
        context.extensionSettings.ChatMood.staticPosition = !!value;
        context.saveSettingsDebounced();
    }

    function setEnabledByDefault(value) {
        const context = ctx();
        if (!context.extensionSettings.ChatMood) context.extensionSettings.ChatMood = {};
        context.extensionSettings.ChatMood.enabledByDefault = value;
        context.saveSettingsDebounced();
    }

    // ── Keyword matching language ───────────────────────────────────────────
    // Read once by the engine when it's created (module load) — the keyword
    // dictionary is fetched synchronously at that point, so changing this
    // setting only takes effect after a reload (same as ST's own UI-language
    // switch).
    function getKeywordLanguage() {
        return ctx().extensionSettings.ChatMood?.keywordLanguage === 'de' ? 'de' : 'en';
    }

    function setKeywordLanguage(value) {
        const context = ctx();
        if (!context.extensionSettings.ChatMood) context.extensionSettings.ChatMood = {};
        context.extensionSettings.ChatMood.keywordLanguage = value === 'de' ? 'de' : 'en';
        context.saveSettingsDebounced();
    }

    // ── MBTI/archetype inference language ───────────────────────────────────
    // Governs inferMBTIFromCharacter/applyPersonaArchetypeBias, which run once
    // per chat directly against the character card's free text — independent
    // of keywordLanguage above (that's for scoring chat messages, not cards).
    // Read live by the engine (no reload needed), but state.mbtiType is only
    // computed once per chat and then persisted, so changing this only affects
    // *new* baselines (a fresh chat, or an existing one after "Reset mood to
    // baseline") — not chats that already have a stored mbtiType.
    function getMbtiInferenceLanguage() {
        const value = ctx().extensionSettings.ChatMood?.mbtiInferenceLanguage;
        return (value === 'de' || value === 'both') ? value : 'en';
    }

    function setMbtiInferenceLanguage(value) {
        const context = ctx();
        if (!context.extensionSettings.ChatMood) context.extensionSettings.ChatMood = {};
        context.extensionSettings.ChatMood.mbtiInferenceLanguage = (value === 'de' || value === 'both') ? value : 'en';
        context.saveSettingsDebounced();
    }

    // ── Token saver mode ─────────────────────────────────────────────────────
    // Read live by buildEmotionContext() (rebuilt every turn already), so this
    // takes effect on the very next message — no reload needed.
    function getTokenSaverMode() {
        return !!ctx().extensionSettings.ChatMood?.tokenSaverMode;
    }

    function setTokenSaverMode(value) {
        const context = ctx();
        if (!context.extensionSettings.ChatMood) context.extensionSettings.ChatMood = {};
        context.extensionSettings.ChatMood.tokenSaverMode = !!value;
        context.saveSettingsDebounced();
    }

    // ── Time-based mood decay ────────────────────────────────────────────────
    // Read live by engine.processMessageEmotion() via api.getTimeDecayEnabled(),
    // so this takes effect on the very next message — no reload needed.
    // Default off: the always-on per-message regression (see
    // lib/emotion-engine.js's header comment) already prevents mood from
    // sticking at 0/100 forever; this adds real-time drift on top for anyone
    // who wants it, opt-in rather than opt-out.
    function getTimeDecayEnabled() {
        const v = ctx().extensionSettings.ChatMood?.timeDecayEnabled;
        return v === undefined ? false : !!v;
    }

    function setTimeDecayEnabled(value) {
        const context = ctx();
        if (!context.extensionSettings.ChatMood) context.extensionSettings.ChatMood = {};
        context.extensionSettings.ChatMood.timeDecayEnabled = !!value;
        context.saveSettingsDebounced();
    }

    // ── Track only mood (no prompt injection) ───────────────────────────────
    // Read live by refreshPrompt() (called via refreshAll(), rebuilt every
    // turn already), so this takes effect immediately — no reload needed.
    // Default off: mood is tracked and shown in the badge/popup either way;
    // this only stops the <emotional_state> block from being sent to the
    // LLM, for anyone who wants the tracker without it influencing replies.
    function getPromptInjectionDisabled() {
        return !!ctx().extensionSettings.ChatMood?.promptInjectionDisabled;
    }

    function setPromptInjectionDisabled(value) {
        const context = ctx();
        if (!context.extensionSettings.ChatMood) context.extensionSettings.ChatMood = {};
        context.extensionSettings.ChatMood.promptInjectionDisabled = !!value;
        context.saveSettingsDebounced();
    }

    // ── Message-weighting settings ──────────────────────────────────────────
    // How strongly the user's message vs. the character's own reply moves the
    // needle in engine.analyzeTextEmotion — defaults match the reasoning
    // already baked into the engine (character's reply is the more direct
    // signal of felt emotion), but configurable per the settings panel.
    const DEFAULT_USER_WEIGHT = 0.6;
    const DEFAULT_CHAR_WEIGHT = 1.0;

    function getMessageWeight(isUser) {
        const settings = ctx().extensionSettings.ChatMood;
        const raw = isUser ? settings?.userMessageWeight : settings?.charMessageWeight;
        const fallback = isUser ? DEFAULT_USER_WEIGHT : DEFAULT_CHAR_WEIGHT;
        return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
    }

    function setMessageWeight(isUser, value) {
        const context = ctx();
        if (!context.extensionSettings.ChatMood) context.extensionSettings.ChatMood = {};
        context.extensionSettings.ChatMood[isUser ? 'userMessageWeight' : 'charMessageWeight'] = value;
        context.saveSettingsDebounced();
    }

    function isMoodDisabledForChat() {
        const explicit = ctx().chatMetadata?.chatMoodDisabled;
        if (typeof explicit === 'boolean') return explicit;
        return !getEnabledByDefault();
    }

    function toggleMoodDisabledForChat() {
        const context = ctx();
        // Flip the *effective* state, not the raw (possibly-undefined) field —
        // otherwise the first toggle on a chat relying on the global default
        // would compute against `undefined` instead of what's actually in effect.
        context.chatMetadata.chatMoodDisabled = !isMoodDisabledForChat();
        context.saveMetadataDebounced();
    }

    // ── Portal — escape SillyTavern's body { position: fixed; overflow: hidden; }
    // (set in its mobile-styles.css), which breaks position:fixed for any
    // descendant nested inside body — including anything inside app containers
    // like #leftSendForm. Mount a dedicated fixed, fullscreen div as a direct
    // child of <html> instead (same fix SillyTavern-EchoText uses for #et-fab/
    // its panel — see its "iOS PORTAL" comment) and put the badge/popup/burst
    // there so they always position correctly relative to the viewport.

    function ensurePortal() {
        let portal = document.getElementById('cm-portal');
        if (!portal) {
            portal = document.createElement('div');
            portal.id = 'cm-portal';
            portal.style.cssText = 'position:fixed; top:0; left:0; width:100dvw; height:100dvh; z-index:999997; pointer-events:none;';
            try {
                document.documentElement.appendChild(portal);
            } catch (e) {
                document.body.appendChild(portal);
            }
        }
        return portal;
    }

    // ── Prompt injection ────────────────────────────────────────────────────

    function setPromptKey(key, text) {
        ctx().setExtensionPrompt(
            key,
            text,
            EXTENSION_PROMPT_TYPE_IN_PROMPT,
            0,
            false,
            EXTENSION_PROMPT_ROLE_SYSTEM,
        );
    }

    function groupPromptKey(avatar) {
        return `${PROMPT_KEY}_${avatar}`;
    }

    // Keys set by the previous group-mode refreshPrompt() call — needed to
    // explicitly clear a departed/muted member's block. extension_prompts
    // entries are never auto-cleared, so a stale key would otherwise linger
    // in the injected prompt forever.
    let lastGroupPromptKeys = [];

    function clearGroupPromptKeys() {
        for (const key of lastGroupPromptKeys) setPromptKey(key, '');
        lastGroupPromptKeys = [];
    }

    function refreshPrompt() {
        const context = ctx();
        const active = hasOpenChat() && !isMoodDisabledForChat() && !getPromptInjectionDisabled();

        if (!active || !context.groupId) {
            clearGroupPromptKeys();
        }

        if (!active) {
            setPromptKey(PROMPT_KEY, '');
            return;
        }

        if (!context.groupId) {
            setPromptKey(PROMPT_KEY, engine.buildEmotionContext());
            return;
        }

        // Group chat: one labeled block per active member, own key each so
        // they don't overwrite each other (setExtensionPrompt joins every
        // key's value together at generation time).
        setPromptKey(PROMPT_KEY, '');
        const newKeys = [];
        for (const avatar of getActiveGroupMembers()) {
            const block = withGroupMember(avatar, () => engine.buildEmotionContext());
            if (!block) continue;
            const name = getGroupMemberCharacter(avatar)?.name || avatar;
            const labeled = block.replace('<emotional_state>', `<emotional_state character="${name}">`);
            const key = groupPromptKey(avatar);
            setPromptKey(key, labeled);
            newKeys.push(key);
        }
        for (const oldKey of lastGroupPromptKeys) {
            if (!newKeys.includes(oldKey)) setPromptKey(oldKey, '');
        }
        lastGroupPromptKeys = newKeys;
    }

    // ── UI: draggable floating badge + click-to-expand breakdown popup ─────
    // Placing the badge inside existing ST containers (send form, top bar,
    // etc.) kept running into the position:fixed containing-block bug above,
    // plus disagreement about where it should live — so instead it's a free-
    // floating button (like EchoText's #et-fab) the user can drag anywhere,
    // with its position remembered across reloads.

    const BADGE_POS_KEY = 'chatmood-badge-pos';
    let badgeDragging = false;

    function loadBadgePosition() {
        try {
            const raw = localStorage.getItem(BADGE_POS_KEY);
            if (!raw) return null;
            const pos = JSON.parse(raw);
            if (Number.isFinite(pos.left) && Number.isFinite(pos.top)) return pos;
        } catch (e) { /* ignore */ }
        return null;
    }

    function saveBadgePosition(left, top) {
        try {
            localStorage.setItem(BADGE_POS_KEY, JSON.stringify({ left, top }));
        } catch (e) { /* ignore */ }
    }

    function applyStaticBadgePosition(badgeEl) {
        const sendForm = document.getElementById('send_form');
        if (!sendForm) return applyDraggableBadgePosition(badgeEl);
        const rect = sendForm.getBoundingClientRect();
        const height = badgeEl.offsetHeight || 38;
        badgeEl.style.left = `${Math.max(0, rect.left)}px`;
        badgeEl.style.top = `${Math.max(0, rect.top - height - 8)}px`;
    }

    function applyDraggableBadgePosition(badgeEl) {
        // Measured *after* the element is in the DOM (see ensureBadge) so
        // this reflects the real pill size — which varies with the label's
        // text length (e.g. German "Nachdenklichkeit" vs. English "Sadness")
        // — rather than a guessed constant that could under-clamp and leave
        // part of the badge past the actual edge of the screen.
        const width = badgeEl.offsetWidth || 120;
        const height = badgeEl.offsetHeight || 38;
        const saved = loadBadgePosition();
        let left, top;
        if (saved) {
            left = Math.max(0, Math.min(window.innerWidth - width, saved.left));
            top = Math.max(0, Math.min(window.innerHeight - height, saved.top));
        } else {
            left = 20;
            top = window.innerHeight - height - 72;
        }
        badgeEl.style.left = `${left}px`;
        badgeEl.style.top = `${top}px`;
    }

    function applyBadgePosition(badgeEl) {
        if (isStaticPositionEnabled()) applyStaticBadgePosition(badgeEl);
        else applyDraggableBadgePosition(badgeEl);
    }

    function makeBadgeDraggable(badgeEl) {
        let isDragging = false;
        let hasMoved = false;
        let startX, startY, startLeft, startTop;

        function onStart(clientX, clientY) {
            isDragging = true;
            hasMoved = false;
            const rect = badgeEl.getBoundingClientRect();
            startX = clientX;
            startY = clientY;
            startLeft = rect.left;
            startTop = rect.top;
        }

        function onMove(clientX, clientY) {
            if (!isDragging) return;
            const dx = clientX - startX;
            const dy = clientY - startY;
            if (Math.abs(dx) > 5 || Math.abs(dy) > 5) hasMoved = true;
            if (!hasMoved) return;
            badgeDragging = true;
            badgeEl.classList.add('cm-badge-dragging');
            const size = badgeEl.offsetWidth;
            const newLeft = Math.max(0, Math.min(window.innerWidth - size, startLeft + dx));
            const newTop = Math.max(0, Math.min(window.innerHeight - size, startTop + dy));
            badgeEl.style.left = `${newLeft}px`;
            badgeEl.style.top = `${newTop}px`;
            positionPopup();
        }

        function onEnd() {
            if (!isDragging) return;
            isDragging = false;
            badgeEl.classList.remove('cm-badge-dragging');
            if (hasMoved) {
                const rect = badgeEl.getBoundingClientRect();
                saveBadgePosition(rect.left, rect.top);
            }
            // Swallow the click event that follows a real drag.
            setTimeout(() => { badgeDragging = false; }, 50);
        }

        badgeEl.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            onStart(e.clientX, e.clientY);
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            e.preventDefault();
        });
        function onMouseMove(e) { onMove(e.clientX, e.clientY); }
        function onMouseUp() {
            onEnd();
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        }

        badgeEl.addEventListener('touchstart', (e) => {
            const t = e.touches[0];
            onStart(t.clientX, t.clientY);
        }, { passive: true });
        badgeEl.addEventListener('touchmove', (e) => {
            if (!isDragging) return;
            e.preventDefault();
            const t = e.touches[0];
            onMove(t.clientX, t.clientY);
        }, { passive: false });
        badgeEl.addEventListener('touchend', () => onEnd());
    }

    function ensureBadge() {
        if (jQuery('#cm-badge').length) return;
        const portal = ensurePortal();
        const badge = jQuery(`
            <div id="cm-badge" class="cm-badge${isStaticPositionEnabled() ? ' cm-badge-static' : ''}" title="${tr('Mood')}">
                <span class="cm-badge-icon"><i class="fa-solid fa-face-smile"></i></span>
                <span class="cm-badge-label">${tr('Neutral')}</span>
            </div>`);
        badge.on('click', (e) => {
            e.stopPropagation();
            if (badgeDragging) return;
            togglePopup();
        });
        badge.addClass('cm-badge-hidden');
        portal.appendChild(badge[0]);
        applyBadgePosition(badge[0]);
        if (!isStaticPositionEnabled()) makeBadgeDraggable(badge[0]);
        // Fade in on first appearance too, not just when reappearing after
        // the popup closes.
        requestAnimationFrame(() => badge.removeClass('cm-badge-hidden'));
    }

    // In a group chat, prefix the given title text with the active member's
    // name so it's never ambiguous whose mood the badge/popup is showing.
    function withMemberNamePrefix(text) {
        if (!ctx().groupId) return text;
        const name = getGroupMemberCharacter(getActiveGroupMemberAvatar())?.name;
        return name ? `${name} — ${text}` : text;
    }

    function updateBadge() {
        // Empty/fully-muted group: nothing to show, same as no chat open.
        if (!hasOpenChat() || (ctx().groupId && !getActiveGroupMemberAvatar())) {
            jQuery('#cm-badge').remove();
            jQuery('#cm-popup').remove();
            return;
        }

        ensureBadge();
        const badge = jQuery('#cm-badge');
        if (!badge.length) return;

        if (isMoodDisabledForChat()) {
            badge.css('--badge-color', DISABLED_COLOR);
            badge.attr('title', withMemberNamePrefix(tr('Mood disabled for this chat — click to re-enable')));
            badge.find('.cm-badge-icon i').removeAttr('class').addClass('fa-solid fa-power-off');
            badge.find('.cm-badge-label').text(tr('Disabled'));
            return;
        }

        const state = engine.getEmotionState();
        const dominant = engine.getDominantEmotion(state);
        if (!dominant) return;
        // tr()'d for display only — engine.getIntensityLabel()'s raw English
        // result is what still goes into the LLM-facing buildEmotionContext().
        const intensityLabel = tr(engine.getIntensityLabel(dominant, state[dominant.id]));
        badge.css('--badge-color', dominant.color);
        badge.attr('title', withMemberNamePrefix(ctx().t`Mood: ${tr(dominant.label)} (${Math.round(state[dominant.id])}%)`));
        badge.find('.cm-badge-icon i').removeAttr('class').addClass(dominant.icon);
        badge.find('.cm-badge-label').text(intensityLabel);
    }

    function getImpactDisplay(delta) {
        if (delta > 0.05) return { className: 'cm-emo-delta-up', icon: 'fa-arrow-right', label: `+${Math.abs(delta).toFixed(1)}` };
        if (delta < -0.05) return { className: 'cm-emo-delta-down', icon: 'fa-arrow-left', label: `-${Math.abs(delta).toFixed(1)}` };
        return { className: 'cm-emo-delta-neutral', icon: 'fa-minus', label: '0.0' };
    }

    // Resets whenever the popup closes (see closePopup()) so it never
    // reopens already in edit mode.
    let popupEditMode = false;

    function buildPopupHtml() {
        const disabled = isMoodDisabledForChat();
        const editing = popupEditMode && !disabled;
        const state = engine.getEmotionState();
        const dominant = !disabled && engine.getDominantEmotion(state);

        const rows = engine.PLUTCHIK_EMOTIONS.map(e => {
            const val = Math.round(state[e.id]);
            // tr()'d for display only — same note as updateBadge() above.
            const label = tr(engine.getIntensityLabel(e, val));
            const isDominant = dominant && dominant.id === e.id;
            const impact = getImpactDisplay(Number(state.lastImpact?.[e.id] || 0));
            const color = disabled ? DISABLED_COLOR : e.color;
            const valueDisplay = editing
                ? `<input type="number" class="cm-emo-input" data-emotion="${e.id}" min="0" max="100" value="${val}">`
                : `
                            <span class="cm-emo-delta ${impact.className}" title="${tr('Last change')}"><i class="fa-solid ${impact.icon}"></i>${impact.label}</span>
                            <span class="cm-emo-pct">${val}%</span>`;
            return `
                <div class="cm-emo-row${isDominant ? ' cm-emo-dominant' : ''}">
                    <div class="cm-emo-icon" style="color:${color}"><i class="${e.icon}"></i></div>
                    <div class="cm-emo-info">
                        <div class="cm-emo-header">
                            <span class="cm-emo-label">${tr(e.label)}</span>
                            <span class="cm-emo-intensity">${label}</span>${valueDisplay}
                        </div>
                        <div class="cm-emo-bar-track${editing ? ' cm-emo-bar-editable' : ''}" data-emotion="${e.id}">
                            <div class="cm-emo-bar-fill" style="width:${val}%; background:${color};"></div>
                            ${editing ? `<div class="cm-emo-bar-thumb" style="left:${val}%;"></div>` : ''}
                        </div>
                    </div>
                </div>`;
        }).join('');

        const dominantLabel = dominant ? tr(engine.getIntensityLabel(dominant, state[dominant.id])) : tr('Neutral');
        const dominantName = dominant ? tr(dominant.label) : tr('Neutral');
        const toggleTitle = disabled ? tr('Enable mood for this chat') : tr('Disable mood for this chat');
        const editTitle = editing ? tr('Exit edit mode') : tr('Edit mood values');

        const groupId = ctx().groupId;
        const activeAvatar = groupId ? getActiveGroupMemberAvatar() : null;
        const group = groupId ? getCurrentGroup() : null;
        const memberSwitcherHtml = groupId ? `
                <select id="cm-popup-member-select" class="text_pole">
                    ${getGroupMembers().map(avatar => {
                        const name = getGroupMemberCharacter(avatar)?.name || avatar;
                        const muted = group?.disabled_members?.includes(avatar);
                        const label = muted ? `${name} (${tr('muted')})` : name;
                        return `<option value="${avatar}"${avatar === activeAvatar ? ' selected' : ''}>${label}</option>`;
                    }).join('')}
                </select>` : '';

        return `
            <div id="cm-popup" class="cm-popup${isStaticPositionEnabled() ? ' cm-popup-static' : ''}">
                <div class="cm-popup-header">
                    <i class="fa-solid fa-heart-pulse"></i>
                    <span>${tr('Mood')}</span>
                    ${disabled ? '' : `<button id="cm-popup-edit" class="cm-popup-toggle${editing ? ' cm-popup-toggle-active' : ''}" title="${editTitle}"><i class="fa-solid fa-pen"></i></button>`}
                    <button id="cm-popup-toggle" class="cm-popup-toggle${disabled ? ' cm-popup-toggle-active' : ''}" title="${toggleTitle}"><i class="fa-solid fa-power-off"></i></button>
                    <button id="cm-popup-close" class="cm-popup-close"><i class="fa-solid fa-xmark"></i></button>
                </div>
                ${memberSwitcherHtml}
                <div class="cm-popup-dominant" style="color:${disabled ? DISABLED_COLOR : (dominant ? dominant.color : 'inherit')}">
                    ${disabled ? `<i class="fa-solid fa-power-off"></i> <span>${tr('Disabled')}</span>` : (dominant ? `<i class="${dominant.icon}"></i> <span>${dominantName}</span> <span class="cm-popup-dominant-sub">${dominantLabel} · ${Math.round(state[dominant.id])}%</span>` : `<span>${tr('Neutral')}</span>`)}
                </div>
                <div class="cm-popup-rows">${rows}</div>
            </div>`;
    }

    const POPUP_POS_KEY = 'chatmood-popup-pos';

    function loadPopupPosition() {
        try {
            const raw = localStorage.getItem(POPUP_POS_KEY);
            if (!raw) return null;
            const pos = JSON.parse(raw);
            if (Number.isFinite(pos.left) && Number.isFinite(pos.top)) return pos;
        } catch (e) { /* ignore */ }
        return null;
    }

    function savePopupPosition(left, top) {
        try {
            localStorage.setItem(POPUP_POS_KEY, JSON.stringify({ left, top }));
        } catch (e) { /* ignore */ }
    }

    function applyStaticPopupPosition() {
        const popup = jQuery('#cm-popup');
        if (!popup.length) return;
        const sendForm = document.getElementById('send_form');
        if (!sendForm) return applyDraggablePopupPosition();

        const popupWidth = popup.outerWidth() || 280;
        const popupHeight = popup.outerHeight() || 300;
        const gap = 8;
        const rect = sendForm.getBoundingClientRect();
        const left = Math.max(gap, Math.min(rect.left, window.innerWidth - popupWidth - gap));
        const top = Math.max(gap, rect.top - popupHeight - gap);
        popup.css({ left: `${left}px`, top: `${top}px`, bottom: 'auto', right: 'auto' });
    }

    function applyDraggablePopupPosition() {
        const popup = jQuery('#cm-popup');
        if (!popup.length) return;

        const popupWidth = popup.outerWidth() || 280;
        const popupHeight = popup.outerHeight() || 300;
        const gap = 8;

        const saved = loadPopupPosition();
        let left, top;
        if (saved) {
            // Once moved, the popup remembers its own spot — independent of
            // wherever the (now-hidden) badge happens to be.
            left = Math.max(gap, Math.min(saved.left, window.innerWidth - popupWidth - gap));
            top = Math.max(gap, Math.min(saved.top, window.innerHeight - popupHeight - gap));
        } else {
            // First-ever open: appear above the badge, like before.
            const badgeEl = document.getElementById('cm-badge');
            const badgeRect = badgeEl ? badgeEl.getBoundingClientRect() : { left: 20, top: window.innerHeight - 100 };
            left = Math.max(gap, Math.min(badgeRect.left, window.innerWidth - popupWidth - gap));
            top = Math.max(gap, Math.min(badgeRect.top - popupHeight - gap, window.innerHeight - popupHeight - gap));
        }

        popup.css({ left: `${left}px`, top: `${top}px`, bottom: 'auto', right: 'auto' });
    }

    function positionPopup() {
        if (isStaticPositionEnabled()) applyStaticPopupPosition();
        else applyDraggablePopupPosition();
    }

    function makePopupDraggable(popupEl) {
        const handle = popupEl.querySelector('.cm-popup-header');
        if (!handle) return;

        let isDragging = false;
        let hasMoved = false;
        let startX, startY, startLeft, startTop;

        function onStart(clientX, clientY) {
            isDragging = true;
            hasMoved = false;
            const rect = popupEl.getBoundingClientRect();
            startX = clientX;
            startY = clientY;
            startLeft = rect.left;
            startTop = rect.top;
        }

        function onMove(clientX, clientY) {
            if (!isDragging) return;
            const dx = clientX - startX;
            const dy = clientY - startY;
            if (Math.abs(dx) > 5 || Math.abs(dy) > 5) hasMoved = true;
            if (!hasMoved) return;
            popupEl.classList.add('cm-popup-dragging');
            const w = popupEl.offsetWidth;
            const h = popupEl.offsetHeight;
            const newLeft = Math.max(0, Math.min(window.innerWidth - w, startLeft + dx));
            const newTop = Math.max(0, Math.min(window.innerHeight - h, startTop + dy));
            popupEl.style.left = `${newLeft}px`;
            popupEl.style.top = `${newTop}px`;
            popupEl.style.bottom = 'auto';
            popupEl.style.right = 'auto';
        }

        function onEnd() {
            if (!isDragging) return;
            isDragging = false;
            popupEl.classList.remove('cm-popup-dragging');
            if (hasMoved) {
                const rect = popupEl.getBoundingClientRect();
                savePopupPosition(rect.left, rect.top);
            }
        }

        handle.addEventListener('mousedown', (e) => {
            if (e.target.closest('.cm-popup-close, .cm-popup-toggle')) return;
            if (e.button !== 0) return;
            onStart(e.clientX, e.clientY);
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            e.preventDefault();
        });
        function onMouseMove(e) { onMove(e.clientX, e.clientY); }
        function onMouseUp() {
            onEnd();
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        }

        handle.addEventListener('touchstart', (e) => {
            if (e.target.closest('.cm-popup-close, .cm-popup-toggle')) return;
            const t = e.touches[0];
            onStart(t.clientX, t.clientY);
        }, { passive: true });
        handle.addEventListener('touchmove', (e) => {
            if (!isDragging) return;
            e.preventDefault();
            const t = e.touches[0];
            onMove(t.clientX, t.clientY);
        }, { passive: false });
        handle.addEventListener('touchend', () => onEnd());
    }

    const POPUP_CLOSE_MS = 150;

    function closePopup() {
        const popup = jQuery('#cm-popup');
        if (!popup.length) return;
        popup.removeClass('cm-popup-open').addClass('cm-popup-closing');
        setTimeout(() => jQuery('#cm-popup').remove(), POPUP_CLOSE_MS);
        jQuery('#cm-badge').removeClass('cm-badge-hidden');
        popupEditMode = false;
    }

    // Delegated so they survive refreshPopupIfOpen()'s replaceWith (which
    // swaps in a brand new #cm-popup element every refresh) without needing
    // to be re-bound each time.
    jQuery(document).on('click', '#cm-popup-close', (e) => {
        e.stopPropagation();
        closePopup();
    });
    jQuery(document).on('click', '#cm-popup-toggle', (e) => {
        e.stopPropagation();
        toggleMoodDisabledForChat();
        refreshAll();
    });
    jQuery(document).on('click', '#cm-popup-edit', (e) => {
        e.stopPropagation();
        popupEditMode = !popupEditMode;
        refreshPopupIfOpen();
    });
    jQuery(document).on('change', '#cm-popup-member-select', (e) => {
        selectedGroupMember = e.target.value;
        popupEditMode = false;
        refreshAll();
    });
    // Applies one edited value in-place (bar fill/thumb, paired number input,
    // badge) without rebuilding the popup — rebuilding via
    // refreshPopupIfOpen()'s replaceWith would steal focus out of an active
    // input, or a mid-drag pointer capture off the bar being dragged.
    function applyEmotionEdit(emotionId, rawValue, opts = {}) {
        const value = Math.max(0, Math.min(100, Number(rawValue) || 0));
        engine.setEmotionValue(emotionId, value);
        updateBadge();

        const track = document.querySelector(`.cm-emo-bar-track[data-emotion="${emotionId}"]`);
        const row = track?.closest('.cm-emo-row');
        if (!row) return value;
        const fill = row.querySelector('.cm-emo-bar-fill');
        if (fill) fill.style.width = `${value}%`;
        const thumb = row.querySelector('.cm-emo-bar-thumb');
        if (thumb) thumb.style.left = `${value}%`;
        if (opts.source !== 'input') {
            const input = row.querySelector('.cm-emo-input');
            if (input) input.value = Math.round(value);
        }
        return value;
    }

    jQuery(document).on('input', '.cm-emo-input', (e) => {
        applyEmotionEdit(e.target.dataset.emotion, e.target.value, { source: 'input' });
    });

    // Draggable bars in edit mode — click/drag anywhere along the track sets
    // the value proportionally (0 at the left edge, 100 at the right).
    jQuery(document).on('mousedown', '.cm-emo-bar-editable', (e) => {
        const track = e.currentTarget;
        const id = track.dataset.emotion;
        const setFromClientX = (clientX) => {
            const rect = track.getBoundingClientRect();
            applyEmotionEdit(id, ((clientX - rect.left) / rect.width) * 100);
        };
        setFromClientX(e.clientX);
        const onMove = (moveEvent) => setFromClientX(moveEvent.clientX);
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        e.preventDefault();
    });
    jQuery(document).on('touchstart', '.cm-emo-bar-editable', (e) => {
        const track = e.currentTarget;
        const id = track.dataset.emotion;
        const rect = track.getBoundingClientRect();
        const t = e.touches[0];
        applyEmotionEdit(id, ((t.clientX - rect.left) / rect.width) * 100);
    }, { passive: true });
    jQuery(document).on('touchmove', '.cm-emo-bar-editable', (e) => {
        // Touch capturing keeps this bound to the track the gesture started
        // on, so no document-level fallback listener is needed (unlike mouse).
        const track = e.currentTarget;
        const id = track.dataset.emotion;
        const rect = track.getBoundingClientRect();
        const t = e.touches[0];
        applyEmotionEdit(id, ((t.clientX - rect.left) / rect.width) * 100);
        e.preventDefault();
    }, { passive: false });

    function togglePopup() {
        if (jQuery('#cm-popup').length) {
            closePopup();
            return;
        }

        jQuery('#cm-badge').after(buildPopupHtml());
        positionPopup();
        requestAnimationFrame(() => jQuery('#cm-popup').addClass('cm-popup-open'));
        if (!isStaticPositionEnabled()) {
            const popupEl = document.getElementById('cm-popup');
            if (popupEl) makePopupDraggable(popupEl);
        }

        // Echoes EchoText's own FAB/panel relationship: the button hides while
        // its window is open, and reappears once it's closed. Unlike the
        // popup's earlier incarnation, clicking outside no longer closes it —
        // now that it's a movable window, only the × button (or the badge
        // toggle) should dismiss it.
        jQuery('#cm-badge').addClass('cm-badge-hidden');
    }

    function refreshPopupIfOpen() {
        if (!jQuery('#cm-popup').length) return;
        jQuery('#cm-popup').replaceWith(buildPopupHtml());
        // Not a fresh open — skip the fade-in, just keep it visibly open.
        jQuery('#cm-popup').addClass('cm-popup-open');
        positionPopup();
        if (!isStaticPositionEnabled()) {
            const popupEl = document.getElementById('cm-popup');
            if (popupEl) makePopupDraggable(popupEl);
        }
    }

    // ── Delta burst: brief floating chips above the send form ──────────────
    // Ported from EchoText's showEmotionDeltaBurst.

    let burstTimer = null;

    function positionBurst() {
        const sendForm = document.getElementById('send_form');
        const burst = jQuery('#cm-burst');
        if (!sendForm || !burst.length) return;
        const rect = sendForm.getBoundingClientRect();
        const burstHeight = burst.outerHeight() || 30;
        burst.css({
            left: `${rect.left + rect.width / 2}px`,
            top: `${rect.top - burstHeight - 8}px`,
            transform: 'translateX(-50%)',
        });
    }

    function showEmotionBurst(impactMap) {
        if (!impactMap || typeof impactMap !== 'object') return;

        // Top 3 emotions by absolute delta, filtering noise.
        const entries = Object.entries(impactMap)
            .filter(([, d]) => Math.abs(d) > 0.5)
            .sort(([, a], [, b]) => Math.abs(b) - Math.abs(a))
            .slice(0, 3);
        if (!entries.length) return;

        if (burstTimer) { clearTimeout(burstTimer); burstTimer = null; }
        jQuery('#cm-burst').remove();

        const chipsHtml = entries.map(([id, delta], i) => {
            const def = engine.PLUTCHIK_EMOTIONS.find(e => e.id === id);
            if (!def) return '';
            const isUp = delta > 0;
            const arrowClass = isUp ? 'cm-burst-up' : 'cm-burst-down';
            const arrowIcon = isUp ? 'fa-arrow-right' : 'fa-arrow-left';
            const sign = isUp ? '+' : '';
            return `<span class="cm-burst-chip" style="--burst-color:${def.color};animation-delay:${i * 60}ms" title="${tr(def.label)}: ${sign}${delta.toFixed(1)}"><i class="${def.icon}" style="color:${def.color}"></i><i class="fa-solid ${arrowIcon} cm-burst-arrow ${arrowClass}"></i></span>`;
        }).join('');

        ensurePortal().insertAdjacentHTML('beforeend', `<div id="cm-burst" class="cm-burst">${chipsHtml}</div>`);
        positionBurst();

        burstTimer = setTimeout(() => {
            const el = jQuery('#cm-burst');
            if (el.length) {
                el.addClass('cm-burst-hiding');
                setTimeout(() => el.remove(), 480);
            }
            burstTimer = null;
        }, 3200);
    }

    function refreshAll() {
        updateBadge();
        refreshPopupIfOpen();
        refreshPrompt();
        updateSettingsPanel();
    }

    // ── Event wiring ─────────────────────────────────────────────────────────
    // Mood is driven entirely by engine.processMessageEmotion — EchoText's
    // original keyword-matching analysis (see lib/emotion-engine.js). LLM-judged
    // scoring (both a separate quiet-call version and a piggyback-on-the-reply
    // version) was tried and reverted: neither proved reliable enough on the
    // user's local reasoning model, so this reverts to the simple, synchronous,
    // always-available keyword path.

    // Snapshot of the mood state taken right before the user's message is
    // processed, so the character's reply can report its "last change" delta
    // against the state as it was at the start of the exchange, instead of
    // resetting to ~0 the moment the user hits send — see processMessageEmotion
    // in lib/emotion-engine.js.
    let turnImpactBaseline = null;
    // Same idea, per group member (keyed by avatar) — see the group-chat
    // USER_MESSAGE_RENDERED/CHARACTER_MESSAGE_RENDERED handlers in init().
    let turnImpactBaselineByMember = {};

    // ── Extensions settings drawer entry ────────────────────────────────────
    // Built-in extensions (regex, caption, ...) fill a pre-reserved
    // "..._container" div hardcoded into public/index.html — that's not
    // available to a third-party extension. Instead, append our own block
    // directly into #extensions_settings2 using the same generic
    // .inline-drawer markup every built-in settings block uses; the
    // collapse/expand behavior is already wired globally in script.js
    // (delegated click handler on .inline-drawer-toggle), no extra JS needed
    // for that part.
    function renderSettingsPanel() {
        if (document.getElementById('chatmood_container')) return;
        const container = jQuery('#extensions_settings2');
        if (!container.length) return;

        const userWeight = getMessageWeight(true);
        const charWeight = getMessageWeight(false);

        const html = jQuery(`
            <div id="chatmood_container" class="extension_container">
                <div class="inline-drawer">
                    <div class="inline-drawer-toggle inline-drawer-header">
                        <b>ChatMood</b>
                        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                    </div>
                    <div class="inline-drawer-content">
                        <label class="checkbox_label" for="chatmood_enabled_by_default">
                            <input type="checkbox" id="chatmood_enabled_by_default"${getEnabledByDefault() ? ' checked' : ''}>
                            ${tr('Enabled by default')}
                        </label>
                        <label class="checkbox_label" for="chatmood_token_saver_mode">
                            <input type="checkbox" id="chatmood_token_saver_mode"${getTokenSaverMode() ? ' checked' : ''}>
                            ${tr('Token saver mode')}
                        </label>
                        <small>${tr('Skips the temperament line in the prompt to save tokens — the character\'s core personality is static, so the model picks it up from the conversation itself.')}</small>
                        <label class="checkbox_label" for="chatmood_static_position">
                            <input type="checkbox" id="chatmood_static_position"${isStaticPositionEnabled() ? ' checked' : ''}>
                            ${tr('Static position (above chat box)')}
                        </label>
                        <small>${tr('Pins the mood button and popup in a fixed spot above the chat box instead of letting you drag them around.')}</small>
                        <label class="checkbox_label" for="chatmood_time_decay">
                            <input type="checkbox" id="chatmood_time_decay"${getTimeDecayEnabled() ? ' checked' : ''}>
                            ${tr('Time-based mood decay')}
                        </label>
                        <small>${tr('Off by default. Lets mood also drift back toward baseline as real days pass between messages (love lingers, fear/anger fade faster), on top of the small per-exchange drift that already happens either way.')}</small>
                        <label class="checkbox_label" for="chatmood_no_prompt_injection">
                            <input type="checkbox" id="chatmood_no_prompt_injection"${getPromptInjectionDisabled() ? ' checked' : ''}>
                            ${tr('Track only mood (no prompt injection)')}
                        </label>
                        <small>${tr('Off by default. Keeps mood tracking, the badge, and the popup working as normal, but stops the emotional_state block from being sent to the model at all.')}</small>
                        <label for="chatmood_keyword_language">${tr('Keyword matching language')}</label>
                        <select id="chatmood_keyword_language">
                            <option value="en"${getKeywordLanguage() === 'en' ? ' selected' : ''}>${tr('English')}</option>
                            <option value="de"${getKeywordLanguage() === 'de' ? ' selected' : ''}>${tr('German')}</option>
                        </select>
                        <small>${tr('Which language the mood-scoring keyword list is matched against. Requires reloading SillyTavern to take effect.')}</small>
                        <label for="chatmood_mbti_inference_language">${tr('Personality inference language')}</label>
                        <select id="chatmood_mbti_inference_language">
                            <option value="en"${getMbtiInferenceLanguage() === 'en' ? ' selected' : ''}>${tr('English')}</option>
                            <option value="de"${getMbtiInferenceLanguage() === 'de' ? ' selected' : ''}>${tr('German')}</option>
                            <option value="both"${getMbtiInferenceLanguage() === 'both' ? ' selected' : ''}>${tr('English + German')}</option>
                        </select>
                        <small>${tr('Which language(s) are used to detect a character\'s MBTI temperament and archetype from their character card. Takes effect on the next new chat, or after "Reset mood to baseline" for an existing one — no reload needed.')}</small>
                        <label for="chatmood_user_weight">
                            ${tr('User message influence')}: <span id="chatmood_user_weight_val">${userWeight.toFixed(1)}</span>
                        </label>
                        <input type="range" id="chatmood_user_weight" min="0" max="2" step="0.1" value="${userWeight}">
                        <label for="chatmood_char_weight">
                            ${tr('Character reply influence')}: <span id="chatmood_char_weight_val">${charWeight.toFixed(1)}</span>
                        </label>
                        <input type="range" id="chatmood_char_weight" min="0" max="2" step="0.1" value="${charWeight}">
                        <small>${tr('How strongly each side of the exchange moves the mood needle. 0 ignores it entirely; 1 is normal; higher amplifies it.')}</small>
                        <button id="chatmood_reset_chat" class="menu_button" type="button">${tr('Reset mood to baseline (current chat)')}</button>
                    </div>
                </div>
            </div>`);

        container.append(html);

        jQuery('#chatmood_enabled_by_default').on('change', (e) => {
            setEnabledByDefault(e.target.checked);
            // The current chat's badge/rows may themselves be relying on
            // this default (no explicit per-chat override yet).
            refreshAll();
        });

        jQuery('#chatmood_token_saver_mode').on('change', (e) => {
            setTokenSaverMode(e.target.checked);
            refreshAll();
        });

        jQuery('#chatmood_static_position').on('change', (e) => {
            setStaticPositionEnabled(e.target.checked);
            // ensureBadge() no-ops if #cm-badge already exists, so it won't
            // pick up the new mode (static anchor vs. draggable position, and
            // whether drag handlers get attached) on its own — force a
            // rebuild. refreshPopupIfOpen() (called via refreshAll() below)
            // already rebuilds the popup unconditionally, so it needs no
            // equivalent nudge here.
            jQuery('#cm-badge').remove();
            refreshAll();
        });

        jQuery('#chatmood_time_decay').on('change', (e) => {
            setTimeDecayEnabled(e.target.checked);
            refreshAll();
        });

        jQuery('#chatmood_no_prompt_injection').on('change', (e) => {
            setPromptInjectionDisabled(e.target.checked);
            refreshAll();
        });

        jQuery('#chatmood_mbti_inference_language').on('change', (e) => {
            setMbtiInferenceLanguage(e.target.value);
        });

        jQuery('#chatmood_keyword_language').on('change', async (e) => {
            setKeywordLanguage(e.target.value);
            // Keyword dictionary is loaded once when the engine is created
            // (module init) — nothing short of a reload picks up the change.
            const context = ctx();
            const confirmed = await context.callGenericPopup(
                tr('ChatMood needs to reload SillyTavern for the new keyword language to take effect. Reload now?'),
                context.POPUP_TYPE.CONFIRM,
            );
            if (confirmed === context.POPUP_RESULT.AFFIRMATIVE) location.reload();
        });

        jQuery('#chatmood_user_weight').on('input', (e) => {
            const value = Number(e.target.value);
            jQuery('#chatmood_user_weight_val').text(value.toFixed(1));
            setMessageWeight(true, value);
        });
        jQuery('#chatmood_char_weight').on('input', (e) => {
            const value = Number(e.target.value);
            jQuery('#chatmood_char_weight_val').text(value.toFixed(1));
            setMessageWeight(false, value);
        });

        jQuery('#chatmood_reset_chat').on('click', async () => {
            if (!canResetMood()) return;
            const context = ctx();
            const confirmed = await context.callGenericPopup(
                tr('Reset this chat\'s mood back to its starting baseline? This cannot be undone.'),
                context.POPUP_TYPE.CONFIRM,
            );
            if (confirmed !== context.POPUP_RESULT.AFFIRMATIVE) return;
            // Re-check — the chat/selection could have changed while the confirm was open.
            if (!canResetMood()) return;
            engine.clearEmotionState();
            refreshAll();
        });

        updateSettingsPanel();
    }

    // In a group chat, resetting only ever touches whichever member the
    // popup switcher currently has selected (same member api.getState()/
    // saveState() would resolve to) — never every member at once.
    function canResetMood() {
        return hasOpenChat() && !(ctx().groupId && !getActiveGroupMemberAvatar());
    }

    // Keeps the reset button's enabled/disabled state and label in sync with
    // whether a chat is actually open (and, in a group chat, which member is
    // currently selected) — the settings panel itself is only built once,
    // but which chat/member is active changes constantly.
    function updateSettingsPanel() {
        const resetButton = document.getElementById('chatmood_reset_chat');
        if (!resetButton) return;
        resetButton.disabled = !canResetMood();
        const memberName = ctx().groupId ? getGroupMemberCharacter(getActiveGroupMemberAvatar())?.name : null;
        resetButton.textContent = memberName
            ? ctx().t`Reset ${memberName}'s mood to baseline`
            : tr('Reset mood to baseline (current chat)');
    }

    function init() {
        const context = ctx();
        const { eventSource, event_types } = context;

        renderSettingsPanel();

        // The clamp in applyBadgePosition/positionPopup only runs when the
        // element is (re)created — without this, a badge/popup already
        // positioned near an edge would stay stranded off-screen after a
        // later window resize/orientation change instead of re-clamping.
        window.addEventListener('resize', () => {
            const badgeEl = document.getElementById('cm-badge');
            if (badgeEl) applyBadgePosition(badgeEl);
            if (jQuery('#cm-popup').length) positionPopup();
        });

        eventSource.on(event_types.CHAT_CHANGED, () => {
            turnImpactBaseline = null;
            turnImpactBaselineByMember = {};
            selectedGroupMember = null;
            refreshAll();
        });

        eventSource.on(event_types.USER_MESSAGE_RENDERED, (mesId) => {
            if (!hasOpenChat() || isMoodDisabledForChat()) return;
            const msg = ctx().chat?.[mesId];
            if (!msg) return;

            if (ctx().groupId) {
                // Broadcast: the user's message is the shared stimulus every
                // active (non-muted) member just heard — a member might go
                // several turns without replying, so their popup row needs to
                // reflect what this message just did to them rather than sit
                // on a stale delta from whenever they last spoke. The baseline
                // captured here (their state right before the broadcast) is
                // reused if they go on to reply this turn (see below),
                // correctly extending their delta to cover the full exchange
                // instead of just the broadcast's share of it.
                for (const avatar of getActiveGroupMembers()) {
                    withGroupMember(avatar, () => {
                        turnImpactBaselineByMember[avatar] = { ...engine.getEmotionState() };
                        engine.processMessageEmotion(msg.mes, true, { weight: getMessageWeight(true) });
                    });
                }
            } else {
                // Mirrors the group branch above: don't suppress the impact
                // update for the user's own message — the popup's delta chips
                // should reflect what it just did immediately, not sit frozen
                // on the previous character reply's delta until the character
                // responds again. turnImpactBaseline (state right before this)
                // is still reused if the character goes on to reply this turn
                // (below), so that reply's displayed delta correctly extends
                // to cover the whole exchange instead of just its own share.
                turnImpactBaseline = { ...engine.getEmotionState() };
                const state = engine.processMessageEmotion(msg.mes, true, { weight: getMessageWeight(true) });
                showEmotionBurst(state.lastImpact);
            }
            refreshAll();
        });

        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (mesId) => {
            if (!hasOpenChat() || isMoodDisabledForChat()) return;
            const msg = ctx().chat?.[mesId];
            if (!msg) return;

            if (ctx().groupId) {
                // original_avatar is the only thing that decides whose state
                // this touches — a character's reply must never move another
                // member's mood.
                const avatar = msg.original_avatar;
                if (!avatar) return; // narrator/system message — not attributable to a member
                withGroupMember(avatar, () => {
                    const state = engine.processMessageEmotion(msg.mes, false, { impactBaseline: turnImpactBaselineByMember[avatar], weight: getMessageWeight(false) });
                    showEmotionBurst(state.lastImpact);
                });
                // A manual switcher pick (selectedGroupMember) should only
                // last until someone actually speaks next — otherwise the
                // badge/popup stay stuck on whoever you last picked forever,
                // even though every member's own mood keeps updating
                // correctly underneath. Whoever just replied becomes the new
                // "whoever spoke last" anyway, so this is a no-op display-
                // wise unless a *different* member was pinned.
                selectedGroupMember = null;
            } else {
                const state = engine.processMessageEmotion(msg.mes, false, { impactBaseline: turnImpactBaseline || undefined, weight: getMessageWeight(false) });
                showEmotionBurst(state.lastImpact);
                turnImpactBaseline = null;
            }
            refreshAll();
        });

        refreshAll();
        console.log('[ChatMood] Initialized.');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
