import React, { useEffect, useMemo, useCallback, useState, useRef } from 'react';
import {
    MessageThread,
    TypingIndicator,
    FluentThemeProvider,
    useAzureCommunicationChatAdapter,
} from '@azure/communication-react';
import type { ChatAdapter } from '@azure/communication-react';
import { AzureCommunicationTokenCredential } from '@azure/communication-common';
import { registerIcons } from '@fluentui/react';
import { CSharpMessageId, postToCSharp, logMessage, notifyAppError } from './bridge';
import type { ChatParticipant } from './useMentions';
import { CustomSendBox } from './CustomSendBox';
import { InlineEditBox } from './InlineEditBox';
registerIcons({
    icons: {
        EditBoxCancel: (
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M3.22 3.22a.75.75 0 0 1 1.06 0L10 8.94l5.72-5.72a.75.75 0 1 1 1.06 1.06L11.06 10l5.72 5.72a.75.75 0 1 1-1.06 1.06L10 11.06l-5.72 5.72a.75.75 0 0 1-1.06-1.06L8.94 10 3.22 4.28a.75.75 0 0 1 0-1.06z" fill="currentColor" />
            </svg>
        ),
        EditBoxSubmit: (
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M16.78 4.97a.75.75 0 0 1 0 1.06l-9.5 9.5a.75.75 0 0 1-1.06 0l-4-4a.75.75 0 1 1 1.06-1.06l3.47 3.47 8.97-8.97a.75.75 0 0 1 1.06 0z" fill="currentColor" />
            </svg>
        ),
    },
});

//==>  I will refactor the code in small component parts to make it more readable and maintainable. The main ChatComponent will be responsible for rendering the chat interface,
//while helper functions will handle specific tasks like parsing mentions and formatting dates.I will also ensure that the component is well
//- documented with comments explaining each section and its purpose.    <==\\

/* ========================= */
/* ===== Props ============= */
/* ========================= */

interface ChatProps {
    displayName: string;
    threadId: string;
    endpoint: string;
    userId: string;
    token: string;
    participants: ChatParticipant[];
    onAdapterCreated?: (adapter: ChatAdapter) => void;
}

/* ========================= */
/* ===== Theme ============= */
/* ========================= */

const bhiveTheme = {
    palette: {
        themePrimary: "#52BCCC",
        themeLighterAlt: "#010e10",
        themeLighter: "#042a30",
        themeLight: "#52BCCC",
        themeTertiary: "#109eb2",
        themeSecondary: "#17a0b8",
        themeDarkAlt: "#2db5cb",
        themeDark: "#4ac2d5",
        themeDarker: "#7cd4e1",
        neutralLighterAlt: "#0d0e12",
        neutralLighter: "#2a3042",
        neutralLight: "#1a1d24",
        neutralQuaternaryAlt: "#1e2229",
        neutralQuaternary: "#242830",
        neutralTertiaryAlt: "#60677e",
        neutralTertiary: "#c8c8c8",
        neutralSecondary: "#d0d0d0",
        neutralPrimaryAlt: "#dadada",
        neutralPrimary: "#ffffff",
        neutralDark: "#f4f4f4",
        black: "#f8f8f8",
        white: "#000000",
    }
};

/* ========================= */
/* ===== Helpers =========== */
/* ========================= */

/**
 * Parse mention tags from ACS HTML message format.
 * ACS formats mentions as: <msft-mention id="userId">DisplayName</msft-mention>
 */
function parseMentionsFromHtml(html: string): Array<{ userId: string; displayName: string }> {
    const mentions: Array<{ userId: string; displayName: string }> = [];
    const regex = /<msft-mention id="([^"]+)">([^<]+)<\/msft-mention>/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(html)) !== null) {
        mentions.push({ userId: match[1], displayName: match[2] });
    }
    return mentions;
}

/**
 * Convert ACS HTML message to plain text.
 * Replaces <msft-mention id="...">Name</msft-mention> with @Name
 * and strips any remaining HTML tags.
 */
function stripHtmlToPlainText(html: string): string {
    return html
        .replace(/<msft-mention[^>]*>([^<]+)<\/msft-mention>/g, '@$1')
        .replace(/<[^>]+>/g, '')
        .trim();
}

/**
 * Detect @mentions in plain text by checking each participant's
 * display name directly. Handles multi-word names at any position.
 */
function detectMentionsInText(
    text: string,
    participants: ChatParticipant[],
    currentUserId: string,
): Array<{ userId: string; displayName: string }> {
    if (!text || !participants.length) return [];
    const mentions: Array<{ userId: string; displayName: string }> = [];
    const seen = new Set<string>();

    for (const p of participants) {
        if (p.id === currentUserId || !p.displayName || seen.has(p.id)) continue;
        const tag = `@${p.displayName}`;
        const idx = text.indexOf(tag);
        if (idx === -1) continue;
        // Make sure it's a proper word boundary (start of string or preceded by whitespace)
        const charBefore = idx > 0 ? text[idx - 1] : ' ';
        if (charBefore === ' ' || charBefore === '\n' || idx === 0) {
            mentions.push({ userId: p.id, displayName: p.displayName });
            seen.add(p.id);
        }
    }
    return mentions;
}


/* ========================= */
/* ===== Component ========= */
/* ========================= */

export const ChatComponent: React.FC<ChatProps> = ({
    displayName,
    threadId,
    endpoint,
    userId,
    token,
    participants,
    onAdapterCreated,
}) => {
    // Stable credential — only recreates when token actually changes
    const credential = useMemo(
        () => new AzureCommunicationTokenCredential(token),
        [token]
    );

    // Stable args object — prevents adapter from tearing down on unrelated re-renders
    const adapterArgs = useMemo(() => ({
        endpoint,
        userId: { communicationUserId: userId },
        displayName,
        credential,
        threadId,
    }), [endpoint, userId, displayName, credential, threadId]);

    const adapter = useAzureCommunicationChatAdapter(adapterArgs);

    const [adapterState, setAdapterState] = useState<any>(null);

    // Guards — prevent duplicate init / interception across re-renders
    const initializedRef = useRef(false);
    const mentionInterceptSetup = useRef(false);
    const prevAdapterRef = useRef<typeof adapter | null>(null);
    const processedMessagesRef = useRef<Set<string>>(new Set());

    // Keep mutable refs so callbacks never go stale without triggering re-effects
    const participantsRef = useRef<ChatParticipant[]>(participants);
    const onAdapterCreatedRef = useRef(onAdapterCreated);

    useEffect(() => { participantsRef.current = participants; }, [participants]);
    useEffect(() => { onAdapterCreatedRef.current = onAdapterCreated; }, [onAdapterCreated]);

    // ─── Editing state (managed in React, not via ACS contextual menu) ───────
    const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
    const [editDraft, setEditDraft] = useState('');
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    // Keep a ref so the pill click handler always has the latest values
    const editingMessageIdRef = useRef<string | null>(null);
    const adapterRef = useRef(adapter);
    useEffect(() => { adapterRef.current = adapter; }, [adapter]);

    // ─── Unread boundary: snapshot message IDs when thread first loads ────────
    const initialMessageIdsRef = useRef<Set<string>>(new Set());
    useEffect(() => {
        // Wait until the adapter has populated chatMessages for this thread
        const snapshot = () => {
            const state = (adapterRef.current as any)?.getState?.();
            const raw: any[] = state?.thread?.chatMessages
                ? Object.values(state.thread.chatMessages)
                : [];
            initialMessageIdsRef.current = new Set(
                raw.map((m: any) => m.id || m.messageId)
            );
        };
        // Give adapter a tick to populate state
        const t = setTimeout(snapshot, 600);
        return () => clearTimeout(t);
    }, [threadId]);

    // ─── Date label helper (Teams-style) ─────────────────────────────────────
    const getDateLabel = (date: Date): string => {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const msgDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        const diffDays = Math.round((today.getTime() - msgDay.getTime()) / 86400000);
        if (diffDays === 0) return 'Today';
        if (diffDays === 1) return 'Yesterday';
        if (diffDays < 7) return date.toLocaleDateString('en-US', { weekday: 'long' });
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    };




    /* ---- Custom floating Edit/Delete pill on message hover ---- */
    useEffect(() => {
        const styleId = 'bhive-chat-overrides';
        if (!document.getElementById(styleId)) {
            const s = document.createElement('style');
            s.id = styleId;
            s.textContent = `
                /* ── Hide ACS 3-dot — replaced by our pill ──────────── */
                .ChatMyMessage__actions { visibility: hidden !important; pointer-events: none !important; }

                /* ════ Complete black background ════ */
                html, body, #root { background: #000 !important; }
                [class*="Chat_"], [class*="chat_"],
                [class*="MessageThread"], [class*="messageThread"],
                [data-testid="message-thread"],
                [data-ui-id="chat-composite"],
                .fui-Chat, .fui-ChatMyMessage, .fui-ChatMessage { background: transparent !important; }

                /* ════ "Edited" label ════ */
                [class*="editedTag"], [class*="EditedTag"],
                [class*="edited"] span, [data-ui-id="message-edited-label"] {
                    font-style: italic !important;
                    color: #8a93a6 !important;
                    font-size: 11px !important;
                }

                /* ════ Status icons (sent/seen) ════ */
                /* Sent checkmark — gray */
                [class*="messageStatusContainer"] svg, [class*="MessageStatus"] svg { color: #8a93a6 !important; }
                /* Seen eye/avatar — teal */
                [class*="readReceiptContainer"] svg,
                [class*="readReceipt"] img,
                [class*="readReceipt"] [class*="Avatar"] { color: #52BCCC !important; border-color: #52BCCC !important; }

                /* ════ Sent bubble text — black via v9 CSS token override ════ */
                .fui-ChatMyMessage {
                    --colorNeutralForegroundOnBrand: #000000 !important;
                    --colorNeutralForeground1: #000000 !important;
                }
                .fui-ChatMyMessage .fui-ChatMessageBody,
                .fui-ChatMyMessage .fui-ChatMessageBody * { color: #000000 !important; }

                .ms-Fabric, .ms-Layer-content,
                .ms-FocusZone, .ms-ScrollablePane,
                .ms-ScrollablePane--contentContainer { background-color: transparent !important; }
                [class*="MessageThread_"] [class*="systemMessage"],
                [class*="systemMessage"] { background: transparent !important; }

                /* ════ Edit box styles ════ */
                [data-ui-id="edit-box"] .ms-TextField-fieldGroup {
                    background: #111318 !important;
                    border: 1px solid #e8ae00 !important;
                    border-radius: 8px !important;
                    box-shadow: none !important;
                }
                [data-ui-id="edit-box"] .ms-TextField-field,
                [data-ui-id="edit-box"] textarea,
                [data-ui-id="edit-box"] input {
                    background: transparent !important;
                    color: #ffffff !important;
                    caret-color: #e8ae00 !important;
                    font-size: 14px !important;
                    font-family: system-ui, -apple-system, sans-serif !important;
                }

                /* ════ Action pill ════ */
                #bhive-action-pill {
                    position: fixed;
                    display: none;
                    align-items: center;
                    gap: 2px;
                    background: #1e2433;
                    border: 1px solid #3a4155;
                    border-radius: 8px;
                    padding: 3px 5px;
                    box-shadow: 0 4px 16px rgba(0,0,0,0.55);
                    z-index: 99999;
                    pointer-events: auto;
                }
                #bhive-action-pill.visible { display: flex; }
                .bhive-act-btn {
                    display: flex; align-items: center; justify-content: center;
                    width: 30px; height: 30px;
                    border: none; background: transparent;
                    border-radius: 6px; cursor: pointer;
                    color: #c8cdd8; transition: background 0.12s;
                }
                .bhive-act-btn:hover { background: #2c3a5c; }
                #bhive-del-btn { color: #e05a5a; }
                #bhive-del-btn:hover { background: rgba(224,90,90,0.18); }

                /* ════ Hide ACS contextual menu callout entirely ════ */
                .ms-ContextualMenu-Callout { display: none !important; }

                /* ════ Bhive inline edit box ════ */
                .bhive-edit-container {
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                    width: 100%;
                    max-width: 480px;
                    margin-left: auto;
                }
                .bhive-edit-textarea {
                    width: 100%;
                    min-height: 60px;
                    background: #111318;
                    border: 1.5px solid #e8ae00;
                    border-radius: 8px;
                    color: #fff;
                    font-size: 14px;
                    font-family: system-ui, -apple-system, sans-serif;
                    padding: 8px 12px;
                    resize: vertical;
                    caret-color: #e8ae00;
                    outline: none;
                    box-sizing: border-box;
                }
                .bhive-edit-actions {
                    display: flex;
                    justify-content: flex-end;
                    gap: 6px;
                }
                .bhive-edit-cancel {
                    background: transparent;
                    border: 1px solid #3a4155;
                    border-radius: 6px;
                    color: #8a93a6;
                    padding: 4px 12px;
                    cursor: pointer;
                    font-size: 12px;
                    transition: background 0.12s, color 0.12s;
                }
                .bhive-edit-cancel:hover { background: rgba(224,90,90,0.15); color: #e05a5a; border-color: #e05a5a; }
                .bhive-edit-submit {
                    background: #e8ae00;
                    border: none;
                    border-radius: 6px;
                    color: #000;
                    padding: 4px 14px;
                    cursor: pointer;
                    font-size: 12px;
                    font-weight: 600;
                    transition: background 0.12s;
                }
                .bhive-edit-submit:hover { background: #f0c030; }
            `;
            document.head.appendChild(s);
        }

        // ── Create the floating pill ─────────────────────────────────────────
        const pill = document.createElement('div');
        pill.id = 'bhive-action-pill';
        pill.innerHTML = `
            <button class="bhive-act-btn" id="bhive-edit-btn" title="Edit">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm1.414 1.06a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354l-1.086-1.086ZM11.19 5.25 9.75 3.81 3.786 9.774a.25.25 0 0 0-.064.108l-.612 2.141 2.141-.612a.25.25 0 0 0 .108-.064L11.19 5.25Z" fill="currentColor"/>
                </svg>
            </button>
            <button class="bhive-act-btn" id="bhive-del-btn" title="Delete">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M6.5 1.75a.25.25 0 0 1 .25-.25h2.5a.25.25 0 0 1 .25.25V3h-3V1.75Zm4.5 0V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.15l-.66 6.6A1.748 1.748 0 0 1 10.595 15H5.405a1.748 1.748 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15Z" fill="currentColor"/>
                </svg>
            </button>
        `;
        document.body.appendChild(pill);

        // ── Pill visibility ──────────────────────────────────────────────────
        let currentMessageId: string | null = null;
        let hideTimer: ReturnType<typeof setTimeout> | null = null;

        function showPill(msgEl: HTMLElement, messageId: string) {
            if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
            const r = msgEl.getBoundingClientRect();
            pill.style.top = `${r.top - 40}px`;
            pill.style.right = `${window.innerWidth - r.right}px`;
            pill.classList.add('visible');
            currentMessageId = messageId;
        }

        function hidePill(delay = 160) {
            if (hideTimer) clearTimeout(hideTimer);
            hideTimer = setTimeout(() => {
                pill.classList.remove('visible');
                currentMessageId = null;
            }, delay);
        }

        pill.addEventListener('mouseenter', () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } });
        pill.addEventListener('mouseleave', () => hidePill());

        // ── Edit: set React state → triggers re-render with inline edit box ──
        document.getElementById('bhive-edit-btn')?.addEventListener('click', () => {
            if (currentMessageId) {
                // Read content from adapter state (reliable, not DOM text)
                const thread = (adapterRef.current as any)?.getState?.()?.thread;
                const rawMsgs: any[] = thread?.chatMessages
                    ? Object.values(thread.chatMessages)
                    : [];
                const found = rawMsgs.find((m: any) =>
                    (m.id || m.messageId) === currentMessageId
                );
                const content: string =
                    found?.content?.message   // ACS ChatMessageContent.message
                    ?? (typeof found?.content === 'string' ? found.content : '')
                    ?? '';
                document.dispatchEvent(new CustomEvent('bhive-edit-message', {
                    detail: { messageId: currentMessageId, content }
                }));
            }
            hidePill(0);
        });

        // ── Delete: show confirmation dialog first ───────────────────────────
        document.getElementById('bhive-del-btn')?.addEventListener('click', () => {
            if (currentMessageId) {
                document.dispatchEvent(new CustomEvent('bhive-confirm-delete', {
                    detail: { messageId: currentMessageId }
                }));
            }
            hidePill(0);
        });

        // ── Attach hover to ACS outer wrapper; message ID is on inner child ──
        const attached = new WeakSet<HTMLElement>();

        function attachMessageHover(msgEl: HTMLElement) {
            if (attached.has(msgEl)) return;
            attached.add(msgEl);
            msgEl.addEventListener('mouseenter', () => {
                // data-message-id is on the outer display:contents wrapper (ancestor of ACS elements)
                const wrapper = msgEl.closest<HTMLElement>('[data-message-id]');
                const messageId = wrapper?.dataset.messageId;
                if (!messageId) return; // received message or not ours
                showPill(msgEl, messageId);
            });
            msgEl.addEventListener('mouseleave', (e) => {
                if ((e as MouseEvent).relatedTarget instanceof HTMLElement &&
                    ((e as MouseEvent).relatedTarget as HTMLElement).closest('#bhive-action-pill')) return;
                hidePill();
            });
        }

        // ── MutationObserver: attach hover + apply icon colours ──────────────
        const observer = new MutationObserver(() => {
            // Attach hover to the ACS outer message wrapper; read message ID from
            // the inner [data-message-id] child injected by onRenderMessage
            document.querySelectorAll<HTMLElement>('[data-testid="chat-composite-message"]')
                .forEach(attachMessageHover);

            // Force edit-box icon colours via inline style
            const applyIconColor = (wrapperId: string, defaultColor: string, hoverColor: string) => {
                const wrapper = document.getElementById(wrapperId);
                if (!wrapper) return;
                const icon = wrapper.querySelector<HTMLElement>('i, .ms-Icon');
                if (!icon) return;
                icon.style.setProperty('color', defaultColor, 'important');
                const btn = wrapper.querySelector<HTMLElement>('button');
                if (btn && !btn.dataset.bhiveColored) {
                    btn.dataset.bhiveColored = '1';
                    btn.addEventListener('mouseenter', () => icon.style.setProperty('color', hoverColor, 'important'));
                    btn.addEventListener('mouseleave', () => icon.style.setProperty('color', defaultColor, 'important'));
                }
            };
            applyIconColor('dismissIconWrapper', '#8a93a6', '#e05a5a');
            applyIconColor('submitIconWrapper', '#e8ae00', '#e8ae00');
        });
        observer.observe(document.body, { childList: true, subtree: true });
        document.querySelectorAll<HTMLElement>('[data-testid="chat-composite-message"]').forEach(attachMessageHover);

        return () => {
            observer.disconnect();
            pill.remove();
            document.getElementById(styleId)?.remove();
        };
    }, []);

    // ── Listen for bhive-edit-message custom event from pill ─────────────────
    useEffect(() => {
        const handler = (e: Event) => {
            const { messageId, content } = (e as CustomEvent).detail;
            setEditingMessageId(messageId);
            setEditDraft(content);
            editingMessageIdRef.current = messageId;
        };
        document.addEventListener('bhive-edit-message', handler);
        return () => document.removeEventListener('bhive-edit-message', handler);
    }, []);

    // ── Listen for bhive-confirm-delete: show confirmation dialog ────────────
    useEffect(() => {
        const handler = (e: Event) => {
            const { messageId } = (e as CustomEvent).detail;
            setConfirmDeleteId(messageId);
        };
        document.addEventListener('bhive-confirm-delete', handler);
        return () => document.removeEventListener('bhive-confirm-delete', handler);
    }, []);

    // ── Callbacks wired to the inline edit box ───────────────────────────────
    const handleInlineEditSubmit = useCallback(async (messageId: string, newContent: string) => {
        if (adapter) {
            try { await adapter.updateMessage(messageId, newContent); } catch (e) { console.error(e); }
        }
        setEditingMessageId(null);
        setEditDraft('');
    }, [adapter]);

    const handleInlineEditCancel = useCallback(() => {
        setEditingMessageId(null);
        setEditDraft('');
    }, []);

    // \u2500\u2500 onRenderMessage: custom bubbles + date/unread dividers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n    const onRenderMessage = useCallback((messageProps: any, _def?: (p: any) => JSX.Element) => {\n        const msg = messageProps.message;\n        if (!msg || msg.messageType !== 'chat') return <></>;\n\n        const msgId: string    = msg.messageId || '';\n        const isMine: boolean  = !!msg.mine;\n        const content: string  = msg.content || '';\n        const senderName       = msg.senderDisplayName || '';\n        const createdOn        = msg.createdOn instanceof Date ? msg.createdOn : new Date(msg.createdOn);\n        const time             = formatTime(createdOn);\n        const dateLabel: string | null = (msg as any)._dateLabel ?? null;\n        const isUnreadStart: boolean   = !!(msg as any)._unreadStart;\n\n        // Editing mode (mine only)\n        if (isMine && editingMessageId === msgId) {\n            return (\n                <div data-message-id={msgId}>\n                    <InlineEditBox\n                        key={msgId}\n                        initialContent={editDraft}\n                        participants={participantsRef.current}\n                        currentUserId={userId}\n                        onSubmit={c => handleInlineEditSubmit(msgId, c)}\n                        onCancel={handleInlineEditCancel}\n                    />\n                </div>\n            );\n        }\n\n        const SENT_BG    = '#1AA8C0';\n        const RECV_BG    = '#2a3042';\n        const NAME_COLOR = '#1AA8C0';\n        const TIME_COLOR = '#717d96';\n\n        return (\n            <div style={{ width: '100%' }}>\n                {/* Date divider */}\n                {dateLabel && (\n                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px 6px', userSelect: 'none' }}>\n                        <div style={{ flex: 1, height: 1, background: '#2a3042' }} />\n                        <span style={{ fontSize: 11, color: '#717d96', fontWeight: 500, whiteSpace: 'nowrap', fontFamily: 'system-ui,-apple-system,sans-serif' }}>{dateLabel}</span>\n                        <div style={{ flex: 1, height: 1, background: '#2a3042' }} />\n                    </div>\n                )}\n\n                {/* Unread divider */}\n                {isUnreadStart && (\n                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px 8px', userSelect: 'none' }}>\n                        <div style={{ flex: 1, height: 1, background: '#1AA8C0', opacity: 0.5 }} />\n                        <span style={{ fontSize: 11, color: '#1AA8C0', fontWeight: 600, whiteSpace: 'nowrap', fontFamily: 'system-ui,-apple-system,sans-serif', letterSpacing: '0.03em' }}>Unread messages</span>\n                        <div style={{ flex: 1, height: 1, background: '#1AA8C0', opacity: 0.5 }} />\n                    </div>\n                )}\n\n                {/* Bubble */}\n                <div data-message-id={isMine ? msgId : undefined}\n                    style={{ display: 'flex', flexDirection: 'column', alignItems: isMine ? 'flex-end' : 'flex-start', padding: '2px 16px' }}>\n                    {!isMine && senderName && (\n                        <span style={{ fontSize: 11, color: NAME_COLOR, fontWeight: 600, marginBottom: 2, marginLeft: 2, fontFamily: 'system-ui,-apple-system,sans-serif' }}>{senderName}</span>\n                    )}\n                    <div style={{\n                        background: isMine ? SENT_BG : RECV_BG,\n                        color: '#fff',\n                        padding: '8px 12px',\n                        borderRadius: isMine ? '14px 14px 2px 14px' : '14px 14px 14px 2px',\n                        maxWidth: '65%',\n                        fontSize: 14,\n                        lineHeight: '1.45',\n                        fontFamily: 'system-ui,-apple-system,sans-serif',\n                        wordBreak: 'break-word',\n                        boxShadow: '0 1px 4px rgba(0,0,0,0.25)',\n                    }}>\n                        {msg.contentType === 'html'\n                            ? <span dangerouslySetInnerHTML={{ __html: content }} />\n                            : content}\n                    </div>\n                    <span style={{ fontSize: 10, color: TIME_COLOR, marginTop: 3, fontFamily: 'system-ui,-apple-system,sans-serif' }}>{time}</span>\n                </div>\n            </div>\n        );\n    // eslint-disable-next-line react-hooks/exhaustive-deps\n    }, [editingMessageId, editDraft, handleInlineEditSubmit, handleInlineEditCancel]);
    // onRenderMessage: dividers + defaultRenderer (hover pill preserved)
    const onRenderMessage = (messageProps: any, defaultRenderer?: (p: any) => JSX.Element): JSX.Element => {
        const msg = messageProps?.message;
        if (!msg || msg.messageType !== 'chat') {
            return defaultRenderer ? defaultRenderer(messageProps) : <></>;
        }

        const msgId: string = msg.messageId || '';
        const isMine: boolean = !!msg.mine;
        const dateLabel: string | null = (msg as any)._dateLabel ?? null;
        const isUnreadStart: boolean = !!(msg as any)._unreadStart;

        // Editing mode
        if (isMine && editingMessageId === msgId) {
            return (
                <div data-message-id={msgId}>
                    <InlineEditBox
                        key={msgId}
                        initialContent={editDraft}
                        participants={participantsRef.current}
                        currentUserId={userId}
                        currentDisplayName={displayName}
                        onSubmit={c => handleInlineEditSubmit(msgId, c)}
                        onCancel={handleInlineEditCancel}
                    />
                </div>
            );
        }

        const rendered = defaultRenderer ? defaultRenderer(messageProps) : <></>;

        return (
            // data-message-id on outermost wrapper so closest() from ACS inner elements finds it
            <div data-message-id={isMine ? msgId : undefined} style={{ display: 'contents' }}>
                {dateLabel && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px 6px', userSelect: 'none' }}>
                        <div style={{ flex: 1, height: 1, background: '#2e3347' }} />
                        <span style={{ fontSize: 11, color: '#717d96', fontWeight: 500, whiteSpace: 'nowrap', fontFamily: 'system-ui,-apple-system,sans-serif' }}>{dateLabel}</span>
                        <div style={{ flex: 1, height: 1, background: '#2e3347' }} />
                    </div>
                )}
                {isUnreadStart && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px 8px', userSelect: 'none' }}>
                        <div style={{ flex: 1, height: 1, background: '#52BCCC', opacity: 0.5 }} />
                        <span style={{ fontSize: 11, color: '#52BCCC', fontWeight: 600, whiteSpace: 'nowrap', fontFamily: 'system-ui,-apple-system,sans-serif', letterSpacing: '0.03em' }}>Unread messages</span>
                        <div style={{ flex: 1, height: 1, background: '#52BCCC', opacity: 0.5 }} />
                    </div>
                )}
                {rendered}
            </div>
        );
    };




    // When the adapter instance changes, reset guards so the new instance
    // goes through init and interception properly
    useEffect(() => {
        if (adapter && adapter !== prevAdapterRef.current) {
            initializedRef.current = false;
            mentionInterceptSetup.current = false;
            prevAdapterRef.current = adapter;
        }
    }, [adapter]);

    /* ===== Initial Load (once per adapter instance) ===== */

    useEffect(() => {
        if (!adapter || initializedRef.current) return;
        initializedRef.current = true;

        const init = async () => {
            try {
                await adapter.fetchInitialData();
                await adapter.loadPreviousChatMessages(50);
                const state = adapter.getState();
                const msgCount = state?.thread?.chatMessages
                    ? Object.keys(state.thread.chatMessages).length
                    : 0;
                logMessage(`Initial chat data fetched. Messages: ${msgCount}`);
            } catch (err) {
                logMessage(`[CHAT] Failed to fetch initial data: ${JSON.stringify(err)}`);
            }
        };

        init();
    }, [adapter]);

    /* ===== State Subscription ===== */

    useEffect(() => {
        if (!adapter) return;

        const update = (state: any) => setAdapterState((s: any) => ({ ...s, ...state }));

        setAdapterState(adapter.getState());
        adapter.onStateChange(update);

        return () => {
            adapter.offStateChange(update);
        };
    }, [adapter]);
    useEffect(() => {
        if (!adapter) return;

        const unsubscribe = adapter.onStateChange((state) => {
            const messages = state.thread?.chatMessages;
            logMessage(`[onStateChange] Checking messages - count: ${Object.keys(messages || {}).length}`);
            
            if (!messages) return;

            const threadParticipants: Record<string, any> = state.thread?.participants ?? {};

            // Only process new messages, not all messages on every state change
            Object.entries(messages).forEach(([_, msg]: [string, any]) => {
                logMessage(`[onStateChange] Processing msg ${msg.id}, sender: ${msg.sender}, userId: ${userId}`);
                
                // Skip if already processed
                if (processedMessagesRef.current.has(msg.id)) {
                    logMessage(`[onStateChange] Already processed: ${msg.id}`);
                    return;
                }

                processedMessagesRef.current.add(msg.id);

                // Ignore own messages
                if (msg.sender === userId) {
                    logMessage(`[onStateChange] Skipping own message: ${msg.id}`);
                    return;
                }

                // Skip non-text messages
                if (msg.type !== 'text' && msg.type !== 'html' && msg.type !== 'richtext/html') {
                    logMessage(`[onStateChange] Skipping non-text message type: ${msg.type}`);
                    return;
                }

                const text = stripHtmlToPlainText(msg.content?.message ?? "");

                // Get sender display name from message or from thread participants
                let senderDisplayName = msg.senderDisplayName || '';
                if (!senderDisplayName && msg.sender && threadParticipants[msg.sender]) {
                    senderDisplayName = threadParticipants[msg.sender].displayName || '';
                }

                logMessage(`[onStateChange] Sending notification for msg ${msg.id}, sender: ${senderDisplayName}`);

                postToCSharp({
                    id: CSharpMessageId.ChatMessageReceived,
                    data: {
                        message: {
                            id: msg.id,
                            type: "text",
                            createdOn: msg.createdOn,
                            sender: {
                                communicationUserId: msg.sender
                            },
                            senderDisplayName: senderDisplayName,
                            content: {
                                message: text
                            }
                        },
                        chat: {
                            threadId
                        }
                    }
                });
            });
        });

        return unsubscribe;

    }, [adapter, userId, threadId]);

    /* ===== Adapter Events + Lifecycle ===== */

    useEffect(() => {
        if (!adapter) return;

        logMessage('ChatAdapter created');

        const onMessageReceived = (event: any) => {
            logMessage(`[messageReceived event] Message received from ${event.message?.sender}`);
            
            // Skip own messages
            if (event.message?.sender === userId) {
                logMessage(`[messageReceived event] Skipping own message`);
                return;
            }

            // Get sender display name from message or from current adapter state
            let senderDisplayName = event.message?.senderDisplayName || '';
            if (!senderDisplayName && event.message?.sender) {
                const state = adapter?.getState();
                const threadParticipants = state?.thread?.participants ?? {};
                if (threadParticipants[event.message.sender]) {
                    senderDisplayName = threadParticipants[event.message.sender].displayName || '';
                }
            }

            logMessage(`[messageReceived event] Sending to C#, displayName: ${senderDisplayName}`);

            postToCSharp({
                id: CSharpMessageId.ChatMessageReceived,
                data: { 
                    message: {
                        ...event.message,
                        senderDisplayName: senderDisplayName
                    }, 
                    chat: { threadId } 
                },
            });
        };

        const onMessageRead = (event: any) => {
            postToCSharp({
                id: CSharpMessageId.MyChatMessageReadByAnotherUser,
                data: { message: event.message, chat: { threadId } },
            });
        };

        const onError = (e: any) => {
            const msg = JSON.stringify(e);
            logMessage(`ERROR: ${msg}`);
            notifyAppError(msg);
        };

        adapter.on('messageReceived', onMessageReceived);
        adapter.on('messageRead', onMessageRead);
        adapter.on('error', onError);

        postToCSharp({ id: CSharpMessageId.ChatThreadConnected, data: threadId });

        if (onAdapterCreatedRef.current) {
            onAdapterCreatedRef.current(adapter);
        }

        // Dispose on unmount / adapter change to stop background polling (fixes 429s)
        return () => {
            adapter.off('messageReceived', onMessageReceived);
            adapter.off('messageRead', onMessageRead);
            adapter.off('error', onError);
            try { adapter.dispose(); } catch { /* already disposed — safe to ignore */ }
        };
    }, [adapter, threadId]);

    /* ===== Mention Interception (once per adapter instance) ===== */

    useEffect(() => {
        if (!adapter || mentionInterceptSetup.current) return;
        mentionInterceptSetup.current = true;

        const originalSendMessage = adapter.sendMessage.bind(adapter);

        adapter.sendMessage = async function (content: string, options?: any) {
            try {
                // HTML-based mention detection first (ACS native format)
                let mentions = parseMentionsFromHtml(content);

                // Fallback to plain-text regex detection
                if (mentions.length === 0) {
                    mentions = detectMentionsInText(content, participantsRef.current, userId);
                }

                if (mentions.length > 0) {
                    const plainTextContent = stripHtmlToPlainText(content);
                    const now = new Date();
                    const timestamp =
                        `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()} ` +
                        `${now.getHours().toString().padStart(2, '0')}:` +
                        `${now.getMinutes().toString().padStart(2, '0')}:` +
                        `${now.getSeconds().toString().padStart(2, '0')}`;

                    postToCSharp({
                        id: CSharpMessageId.ChatMentionDetected,
                        data: {
                            messageContent: plainTextContent,
                            mentions: mentions.map(m => ({
                                userId: m.userId,
                                displayName: m.displayName,
                                mentionText: `@${m.displayName}`,
                                position: plainTextContent.indexOf(`@${m.displayName}`),
                                rawName: m.displayName,
                            })),
                            chatThreadId: threadId,
                            timestamp,
                            participantCount: participantsRef.current.length,
                        },
                    });

                    logMessage(`Processed ${mentions.length} mention(s) in outgoing message`);
                }

                // Strip HTML before sending to ACS so all clients see plain text
                return originalSendMessage(stripHtmlToPlainText(content), options);
            } catch (error: any) {
                logMessage(`Error in mention interception: ${error?.message}`);
                return originalSendMessage(stripHtmlToPlainText(content), options);
            }
        };

        logMessage('@-mention interception setup complete');
    }, [adapter, threadId, userId]);

    /* ===== Handlers ===== */

    const handleSendMessage = useCallback(async (content: string) => {
        if (!adapter) return;
        await adapter.sendMessage(content);
    }, [adapter]);

    const handleTyping = useCallback(async () => {
        if (adapter) await adapter.sendTypingIndicator();
    }, [adapter]);

    const handleLoadPreviousMessages = useCallback(async (messagesToLoad: number) => {
        if (adapter) return adapter.loadPreviousChatMessages(messagesToLoad);
        return true;
    }, [adapter]);

    const handleMessageSeen = useCallback(async (messageId: string) => {
        if (adapter) await adapter.sendReadReceipt(messageId);
        initialMessageIdsRef.current.add(messageId);
        setAdapterState((s: any) => ({ ...s }));
    }, [adapter]);

    // v1.31: updateMessage signature is (messageId, content) — no MessageOptions param
    const handleUpdateMessage = useCallback(async (messageId: string, content: string) => {
        if (adapter) await adapter.updateMessage(messageId, content);
    }, [adapter]);

    const handleDeleteMessage = useCallback(async (messageId: string) => {
        if (adapter) await adapter.deleteMessage(messageId);
    }, [adapter]);

    /* ===== Render ===== */

    if (!adapter || !adapterState) {
        return (
            <div style={{
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: bhiveTheme.palette.white,
                color: bhiveTheme.palette.neutralPrimary,
            }}>
                Loading Chat...
            </div>
        );
    }

    const thread = adapterState.thread;
    const rawMessages: any[] = thread?.chatMessages
        ? Object.values(thread.chatMessages)
        : [];

    // latestReadTime: latest time any OTHER participant read a message (used for 'seen' status)
    const latestReadTime: Date = thread?.latestReadTime ? new Date(thread.latestReadTime) : new Date(0);

    const sorted = rawMessages
        .filter((m: any) => (m.type === 'text' || m.type === 'html' || m.type === 'richtext/html') && !m.deletedOn)
        .map((m: any) => ({
            messageType: 'chat' as const,
            messageId: m.id || m.messageId || '',
            senderId: m.sender?.communicationUserId || m.sender?.id || m.senderId || '',
            senderDisplayName: m.senderDisplayName || '',
            content: (typeof m.content === 'string' ? m.content : m.content?.message) || '',
            createdOn: m.createdOn ? new Date(m.createdOn) : new Date(),
            mine: (m.sender?.communicationUserId || m.sender?.id || m.senderId) === userId,
            contentType: (m.type === 'html' || m.type === 'richtext/html') ? 'html' : 'text',
            // Compute 'seen' status matching ACS's own selector logic
            status: (() => {
                if (m.status === 'delivered' && m.createdOn && new Date(m.createdOn) <= latestReadTime) return 'seen';
                return m.status;
            })(),
            editedOn: m.editedOn ? new Date(m.editedOn) : undefined,
            attached: false,
        }))
        .sort((a: any, b: any) => a.createdOn.getTime() - b.createdOn.getTime());

    // Inject _dateLabel on day-boundary messages and _unreadStart on first unread
    let lastDayKey = '';
    let unreadMarked = false;
    const messages = sorted.map((msg: any) => {
        const dayKey = `${msg.createdOn.getFullYear()}-${msg.createdOn.getMonth()}-${msg.createdOn.getDate()}`;
        const isNewDay = dayKey !== lastDayKey;
        if (isNewDay) lastDayKey = dayKey;

        const isUnread = !initialMessageIdsRef.current.has(msg.messageId) && !msg.mine;
        const isFirstUnread = isUnread && !unreadMarked;
        if (isFirstUnread) unreadMarked = true;

        return {
            ...msg,
            _dateLabel: isNewDay ? getDateLabel(msg.createdOn) : null,
            _unreadStart: isFirstUnread,
        };
    });

    const typingUsers = ((thread?.typingIndicators ?? []) as any[])
        .filter((t: any) => {
            const senderId = t.sender?.communicationUserId || t.sender?.id;
            return senderId !== userId;
        })
        .map((t: any) => {
            const currentSenderId = t.sender?.communicationUserId || t.sender?.id || '';
            let currentDisplayName = t.senderDisplayName || '';
            const threadParticipants: Record<string, any> = thread?.participants ?? {};
            if (!currentDisplayName && currentSenderId && threadParticipants[currentSenderId]) {
                currentDisplayName = threadParticipants[currentSenderId].displayName || '';
            }
            return {
                userId: currentSenderId,
                displayName: currentDisplayName || 'Someone',
            };
        });

    // Build readReceiptsBySenderId (ACS source requires { lastReadMessage, displayName })
    // Filter out own user's receipts — ACS only stores OTHER participants' read receipts
    const readReceiptsBySenderId: Record<string, { lastReadMessage: string; displayName: string }> = {};
    const rawReceipts: any[] = thread?.readReceipts ?? [];
    const threadParticipants: Record<string, any> = thread?.participants ?? {};
    const participantCount = Object.values(threadParticipants).filter((p: any) => p.displayName && p.displayName !== '').length;
    rawReceipts
        .filter((r: any) => {
            const sid = r.sender?.communicationUserId || r.sender?.id;
            return sid && sid !== userId;   // exclude own receipts
        })
        .forEach((r: any) => {
            const sid = r.sender?.communicationUserId || r.sender?.id;
            if (sid && r.chatMessageId) {
                const participant = threadParticipants[sid];
                readReceiptsBySenderId[sid] = {
                    lastReadMessage: r.chatMessageId,
                    displayName: participant?.displayName ?? '',
                };
            }
        });



    // Custom status icons using SVG — bypasses Fluent icon font which may not load in WebView2
    const onRenderMessageStatus = (statusProps: any): JSX.Element => {
        const status: string = statusProps?.status ?? '';
        const gray = '#8a93a6';
        const teal = '#52BCCC';

        // Single tick = sending
        const SingleTick = ({ color }: { color: string }) => (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ display: 'block' }}>
                <polyline points="2,9 6,13 14,4" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
        );
        // Double tick = delivered
        const DoubleTick = ({ color }: { color: string }) => (
            <svg width="18" height="14" viewBox="0 0 20 16" fill="none" style={{ display: 'block' }}>
                <polyline points="1,9 5,13 13,4" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <polyline points="7,9 11,13 19,4" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
        );
        // Eye = seen
        const EyeIcon = ({ color }: { color: string }) => (
            <svg width="13" height="8" viewBox="0 0 13 8" fill="none" style={{ display: 'block' }}>
                <path d="M6.48333 2.33641C7.95606 2.33641 9.15 3.53033 9.15 5.00307C9.15 6.47587 7.95606 7.66973 6.48333 7.66973C5.01055 7.66973 3.81664 6.47587 3.81664 5.00307C3.81664 3.53033 5.01055 2.33641 6.48333 2.33641ZM6.48333 0C9.559 0 12.2141 2.10001 12.9507 5.04293C13.0178 5.3108 12.855 5.58233 12.5871 5.6494C12.3192 5.7164 12.0477 5.55367 11.9807 5.28573C11.3547 2.78531 9.09753 1 6.48333 1C3.86794 1 1.61004 2.78684 0.985216 5.2888C0.91831 5.55667 0.646883 5.7196 0.37897 5.65273C0.111056 5.5858 -0.0518902 5.3144 0.0150165 5.04647C0.75041 2.10181 3.4063 0 6.48333 0Z" fill={color} />
            </svg>
        );

        if (status === 'sending') return <span title="Sending" style={{ lineHeight: 1 }}><SingleTick color={gray} /></span>;
        if (status === 'delivered') return <span title="Delivered" style={{ lineHeight: 1 }}><DoubleTick color={gray} /></span>;
        if (status === 'seen') return <span title="Seen" style={{ lineHeight: 1 }}><EyeIcon color={teal} /></span>;
        if (status === 'failed') return <span title="Failed" style={{ color: '#e05a5a', fontSize: 14, lineHeight: 1 }}>✕</span>;
        return <></>;
    };

    return (
        <>
            <FluentThemeProvider fluentTheme={bhiveTheme}>
                <div style={{
                    height: '100%',
                    width: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    backgroundColor: '#000000',
                    color: bhiveTheme.palette.neutralPrimary,
                    overflow: 'hidden',
                }}>
                    {/* Message Thread */}
                    <div style={{ flex: 1, overflow: 'auto', position: 'relative', backgroundColor: '#000000' }}>
                        <MessageThread
                            userId={userId}
                            messages={messages as any}
                            showMessageStatus={true}
                            showMessageDate={true}
                            participantCount={participantCount}
                            readReceiptsBySenderId={readReceiptsBySenderId as any}
                            onRenderMessageStatus={onRenderMessageStatus as any}
                            onLoadPreviousChatMessages={handleLoadPreviousMessages}
                            onMessageSeen={handleMessageSeen}
                            onUpdateMessage={handleUpdateMessage as any}
                            onDeleteMessage={handleDeleteMessage}
                            onSendMessage={handleSendMessage}
                            onRenderMessage={onRenderMessage as any}
                        />
                    </div>

                    {/* Typing Indicator */}
                    {typingUsers.length > 0 && (
                        <div style={{ padding: '2px 12px', backgroundColor: '#0d0e12' }}>
                            <TypingIndicator typingUsers={typingUsers} />
                        </div>
                    )}

                    {/* Send Box — owns its own border & padding */}
                    <CustomSendBox
                        participants={participants}
                        currentUserId={userId}
                        currentDisplayName={displayName}
                        threadId={threadId}
                        onSendMessage={handleSendMessage}
                        onTyping={handleTyping}
                        theme={{
                            borderColor: '#2a3041',
                            backgroundColor: '#0d0e12',
                            textColor: bhiveTheme.palette.neutralPrimary,
                            placeholderColor: bhiveTheme.palette.neutralTertiary,
                        }}
                    />
                </div>
            </FluentThemeProvider>

            {/* ── Delete confirmation dialog ── */}
            {confirmDeleteId && (
                <div style={{
                    position: 'fixed', inset: 0, zIndex: 99999,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    backgroundColor: 'rgba(0,0,0,0.55)',
                    backdropFilter: 'blur(3px)',
                }}
                    onMouseDown={e => { if (e.target === e.currentTarget) setConfirmDeleteId(null); }}
                >
                    <div style={{
                        background: '#1e2028',
                        borderRadius: 14,
                        padding: '28px 28px 24px',
                        width: 320,
                        boxShadow: '0 20px 60px rgba(0,0,0,0.7)',
                        position: 'relative',
                        fontFamily: 'system-ui, -apple-system, sans-serif',
                    }}>
                        {/* X close */}
                        <button
                            onClick={() => setConfirmDeleteId(null)}
                            style={{ position: 'absolute', top: 14, right: 14, background: 'transparent', border: 'none', cursor: 'pointer', color: '#8a93a6', fontSize: 18, lineHeight: 1, padding: 4 }}
                            onMouseEnter={e => (e.currentTarget.style.color = '#fff')}
                            onMouseLeave={e => (e.currentTarget.style.color = '#8a93a6')}
                        >✕</button>

                        {/* Message */}
                        <p style={{ margin: '0 0 24px', fontSize: 16, fontWeight: 600, color: '#fff', lineHeight: 1.4, paddingRight: 24 }}>
                            Are you sure you want to<br />delete this chat?
                        </p>

                        {/* Buttons */}
                        <div style={{ display: 'flex', gap: 10 }}>
                            <button
                                onClick={async () => {
                                    if (adapterRef.current) {
                                        try { await adapterRef.current.deleteMessage(confirmDeleteId!); }
                                        catch (e) { console.error('[bhive] deleteMessage failed', e); }
                                    }
                                    setConfirmDeleteId(null);
                                }}
                                style={{ flex: 1, padding: '10px 0', borderRadius: 8, border: 'none', background: '#e05a5a', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer', transition: 'background 0.15s' }}
                                onMouseEnter={e => (e.currentTarget.style.background = '#c94848')}
                                onMouseLeave={e => (e.currentTarget.style.background = '#e05a5a')}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={() => setConfirmDeleteId(null)}
                                style={{ flex: 1, padding: '10px 0', borderRadius: 8, border: 'none', background: '#3abcb8', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer', transition: 'background 0.15s' }}
                                onMouseEnter={e => (e.currentTarget.style.background = '#2ea09c')}
                                onMouseLeave={e => (e.currentTarget.style.background = '#3abcb8')}
                            >
                                Delete chat
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
};