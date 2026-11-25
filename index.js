// ===========================================================================
// Agent Core — Skills & Self-Review
// ---------------------------------------------------------------------------
// Turns SillyTavern into an agent-like system:
//   1. SKILLS: persistent behavior rules injected into every generation.
//   2. SELF-REVIEW: the AI critiques its own response, you apply fixes,
//      and patterns can be extracted into permanent Skills.
// ===========================================================================

import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE_NAME = 'agent-core';
const EXTENSION_FOLDER = 'scripts/extensions/third-party/st-agent-core';

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    autoReview: false,           // auto-run review after every AI reply
    skills: [],                  // [{ id, name, content, category, enabled, auto }]
    reviewDepth: 'balanced',     // 'light' | 'balanced' | 'deep'
    showReviewButton: true,
    injectName: 'Agent Skills',
});

const CATEGORY_LABELS = {
    style: '🎨 Style',
    behavior: '🧠 Behavior',
    knowledge: '📚 Knowledge',
    format: '📐 Format',
    custom: '⚙️ Custom',
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function loadSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    const s = extension_settings[MODULE_NAME];
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(s, key)) {
            s[key] = DEFAULT_SETTINGS[key];
        }
    }
    if (!Array.isArray(s.skills)) s.skills = [];
    return s;
}

function uid() {
    return 'sk_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function escHtml(str) {
    const d = document.createElement('div');
    d.appendChild(document.createTextNode(String(str)));
    return d.innerHTML;
}

const getCtx = () => getContext();

// ---------------------------------------------------------------------------
// SKILL INJECTION  — the prompt interceptor
// ---------------------------------------------------------------------------

globalThis.agentCoreInterceptor = async function (chat, contextSize, abort, type) {
    const s = loadSettings();
    if (!s.enabled) return;
    if (type === 'quiet') return;

    const active = (s.skills || []).filter(sk => sk.enabled && sk.content && sk.content.trim());
    if (active.length === 0) return;

    const lines = active.map((sk, i) => `${i + 1}. [${sk.name}] ${sk.content.trim()}`);
    const text = [
        `[Active Agent Skills — apply these rules to your response:]`,
        ...lines,
    ].join('\n');

    const note = {
        is_user: false,
        is_system: true,
        name: s.injectName || 'Agent Skills',
        send_date: Date.now(),
        mes: text,
        extra: { agentCore: { injected: true, skillCount: active.length } },
    };

    // Insert before the last message so the AI sees it right before replying
    if (chat.length > 0) {
        chat.splice(chat.length - 1, 0, note);
    } else {
        chat.push(note);
    }

    console.debug(`[Agent Core] Injected ${active.length} skill(s)`);
};

// ---------------------------------------------------------------------------
// SELF-REVIEW SYSTEM
// ---------------------------------------------------------------------------

/**
 * Build the review prompt used by generateQuietPrompt.
 * Returns a JSON-shaped instruction so we can parse issues reliably.
 */
function buildReviewPrompt(messageText, depth) {
    const depths = {
        light: 'Be brief — identify 1-2 concrete issues only.',
        balanced: 'Identify 2-3 concrete issues with actionable fixes.',
        deep: 'Do a thorough critique — note 3-5 issues covering character voice, prose quality, coherence, and pacing.',
    };
    const guidance = depths[depth] || depths.balanced;

    return [
        'You are a meticulous editor reviewing a roleplay response.',
        'Review the response below against the recent conversation context.',
        guidance,
        '',
        'Return ONLY a JSON object with this exact shape (no markdown fences, no commentary):',
        '{"issues":[{"problem":"short description of the flaw","fix":"concrete actionable instruction","revised":"a rewritten sentence or short passage that demonstrates the fix"}],"verdict":"one-line overall assessment"}',
        '',
        '--- RESPONSE TO REVIEW ---',
        messageText,
    ].join('\n');
}

/**
 * Parse the model's review JSON, tolerating stray fences.
 */
function parseReview(raw) {
    if (!raw || !raw.trim()) return null;
    let text = raw.trim();
    // strip ```json fences if present
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) text = fence[1].trim();
    // grab first {...} block
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    try {
        const obj = JSON.parse(text.slice(start, end + 1));
        if (!obj || !Array.isArray(obj.issues)) return null;
        return obj;
    } catch {
        return null;
    }
}

async function runReview(messageId) {
    const ctx = getCtx();
    const chat = ctx.chat;
    const msg = chat?.[messageId];
    if (!msg || msg.is_user) {
        toastr.warning('Review is only available on AI messages.');
        return null;
    }

    const messageText = msg.mes || '';
    if (!messageText.trim()) {
        toastr.warning('This message is empty.');
        return null;
    }

    const s = loadSettings();
    const $loader = $('<div class="agent-core-reviewing"><span class="fa-solid fa-spinner fa-spin"></span> Reviewing response…</div>');
    $('body').append($loader);

    try {
        const { generateQuietPrompt, loader } = ctx;
        const handle = loader?.show({ message: 'Agent Core is reviewing…' });
        let raw;
        try {
            raw = await generateQuietPrompt({
                quietPrompt: buildReviewPrompt(messageText.slice(0, 4000), s.reviewDepth),
            });
        } finally {
            await handle?.hide();
        }

        const review = parseReview(raw);
        if (!review) {
            toastr.warning('Review returned an unexpected format.');
            console.warn('[Agent Core] Raw review output:', raw);
            return null;
        }

        // Store on the chat message for persistence
        msg.extra = msg.extra || {};
        msg.extra.agentCoreReview = { ...review, at: Date.now() };
        await ctx.saveMetadata?.();
        // also trigger a chat save so the review sticks
        ctx.saveChat?.();

        return { review, messageId };
    } catch (e) {
        console.error('[Agent Core] Review failed:', e);
        toastr.error('Review failed — see console for details.');
        return null;
    } finally {
        $loader.remove();
    }
}

function renderReviewPopup(result) {
    const { Popup, POPUP_RESULT, POPUP_TYPE } = getCtx();
    const { review } = result;

    const issuesHtml = (review.issues || []).map((it, i) => `
        <div class="agent-core-issue" data-issue-index="${i}">
            <div class="agent-core-issue-head">
                <span class="agent-core-issue-num">${i + 1}</span>
                <strong>${escHtml(it.problem || 'Issue')}</strong>
            </div>
            ${it.fix ? `<div class="agent-core-issue-fix"><b>Fix:</b> ${escHtml(it.fix)}</div>` : ''}
            ${it.revised ? `<div class="agent-core-issue-revised"><b>Revised:</b> <em>${escHtml(it.revised)}</em></div>` : ''}
            <button class="menu_button agent-core-make-skill" data-issue-index="${i}"
                    title="Turn this fix into a permanent Skill">
                ✨ Extract as Skill
            </button>
        </div>
    `).join('') || '<div class="agent-core-empty">No issues found — good response.</div>';

    const html = `
        <div class="agent-core-review-popup">
            <div class="agent-core-verdict"><b>Verdict:</b> ${escHtml(review.verdict || '—')}</div>
            <hr />
            ${issuesHtml}
        </div>
    `;

    const popup = new Popup(html, POPUP_TYPE?.TEXT || 'text', '', {
        wide: true,
        okButton: 'Close',
        allowVerticalScrolling: true,
    });
    popup.show();
}

/**
 * Apply a review: regenerate the message with the fixes injected as guidance.
 */
async function applyReview(result) {
    const ctx = getCtx();
    const { review, messageId } = result;
    const fixes = (review.issues || []).map(it => '-' + it.fix).join('\n');
    if (!fixes) {
        toastr.info('No actionable fixes in this review.');
        return;
    }

    // Inject the corrections as a system note, then regenerate the message
    const note = {
        is_user: false,
        is_system: true,
        name: 'Self-Review Fixes',
        send_date: Date.now(),
        mes: `[Self-Review Corrections — regenerate the previous response applying these fixes:\n${fixes}]`,
    };

    ctx.chat.splice(messageId + 1, 0, note);
    toastr.info('Applying fixes and regenerating…');

    try {
        // Use ST's regenerate mechanism for the message
        const { generate } = ctx;
        if (typeof generate === 'function') {
            // remove the message being regenerated, then generate
            await generate('regenerate', { force_chid: ctx.characterId });
        }
    } catch (e) {
        console.error('[Agent Core] Apply/regenerate failed:', e);
        toastr.error('Could not regenerate automatically — press the normal regenerate button.');
    }
}

/**
 * Turn a review issue "fix" into a persistent Skill.
 */
async function extractSkillFromIssue(review, index) {
    const it = (review.issues || [])[index];
    if (!it) return;
    const { Popup } = getCtx();
    const defaultName = (it.problem || 'Skill').slice(0, 40);
    const name = await Popup.show.input('New Skill', 'Name this skill:', defaultName);
    if (!name) return;

    const content = await Popup.show.input(
        'Skill Content',
        'Describe the rule the AI should follow:',
        it.fix || it.problem || ''
    );
    if (!content) return;

    const s = loadSettings();
    s.skills.push({
        id: uid(),
        name,
        content,
        category: 'style',
        enabled: true,
        auto: true,
        createdAt: Date.now(),
    });
    saveSettingsDebounced();
    renderSkillList();
    toastr.success(`Skill saved: ${name}`);
}

// ---------------------------------------------------------------------------
// SKILL UI
// ---------------------------------------------------------------------------

function renderSkillList() {
    const s = loadSettings();
    const $list = $('#agent-core-skill-list');
    if (!$list.length) return;
    $list.empty();

    if (!s.skills.length) {
        $list.append('<div class="agent-core-empty-skills">No skills yet. Create one below, or extract one from a self-review.</div>');
        return;
    }

    const sorted = [...s.skills];
    sorted.forEach((sk) => {
        const cat = CATEGORY_LABELS[sk.category] || CATEGORY_LABELS.custom;
        const $item = $(`
            <div class="agent-core-skill ${sk.enabled ? 'ac-on' : 'ac-off'}" data-skill-id="${sk.id}">
                <div class="agent-core-skill-row">
                    <span class="agent-core-skill-toggle fa-solid ${sk.enabled ? 'fa-toggle-on' : 'fa-toggle-off'}" title="Enable/disable"></span>
                    <span class="agent-core-skill-name">${escHtml(sk.name)}</span>
                    <span class="agent-core-skill-cat" title="${escHtml(cat)}">${cat.split(' ')[0]}</span>
                    <div class="agent-core-skill-actions">
                        ${sk.auto ? '<span class="agent-core-skill-auto" title="Extracted from review">✨</span>' : ''}
                        <span class="agent-core-skill-edit" title="Edit">✏️</span>
                        <span class="agent-core-skill-del" title="Delete">✕</span>
                    </div>
                </div>
                <div class="agent-core-skill-content">${escHtml(sk.content)}</div>
            </div>
        `);

        $item.find('.agent-core-skill-toggle').on('click', () => toggleSkill(sk.id));
        $item.find('.agent-core-skill-del').on('click', () => deleteSkill(sk.id));
        $item.find('.agent-core-skill-edit').on('click', () => editSkill(sk.id));
        $list.append($item);
    });
}

function toggleSkill(id) {
    const s = loadSettings();
    const sk = s.skills.find(x => x.id === id);
    if (!sk) return;
    sk.enabled = !sk.enabled;
    saveSettingsDebounced();
    renderSkillList();
}

function deleteSkill(id) {
    const s = loadSettings();
    s.skills = s.skills.filter(x => x.id !== id);
    saveSettingsDebounced();
    renderSkillList();
    toastr.info('Skill deleted.');
}

async function editSkill(id) {
    const s = loadSettings();
    const sk = s.skills.find(x => x.id === id);
    if (!sk) return;
    const { Popup } = getCtx();

    const name = await Popup.show.input('Edit Skill', 'Skill name:', sk.name);
    if (!name) return;
    const content = await Popup.show.input('Edit Skill', 'Skill content:', sk.content);
    if (!content) return;

    sk.name = name;
    sk.content = content;
    saveSettingsDebounced();
    renderSkillList();
}

// ---------------------------------------------------------------------------
// MESSAGE-LEVEL REVIEW BUTTON
// ---------------------------------------------------------------------------

function addReviewButtonToMessages() {
    const s = loadSettings();
    if (!s.showReviewButton) return;

    $('#chat .mes')
        .filter('.mes_assistant, .mes[is_user="false"]')
        .each(function () {
            const $mes = $(this);
            if ($mes.find('.agent-core-review-btn').length) return;
            const mesId = Number($mes.attr('mesid'));
            if (!Number.isFinite(mesId)) return;

            const $btn = $(`
                <div class="agent-core-review-btn mes_button" title="Self-review this response">
                    <i class="fa-solid fa-magnifying-glass-chart"></i>
                </div>
            `);
            $btn.on('click', async (e) => {
                e.stopPropagation();
                const result = await runReview(mesId);
                if (result) renderReviewPopup(result);
            });

            // Append to the message action buttons row if present, else the message
            const $target = $mes.find('.mes_buttons, .extraMesButtons').first();
            if ($target.length) {
                $target.append($btn);
            } else {
                $mes.append($btn);
            }
        });
}

// ---------------------------------------------------------------------------
// AUTO-REVIEW ON GENERATION END
// ---------------------------------------------------------------------------

async function onGenerationEnded() {
    const s = loadSettings();
    if (!s.enabled || !s.autoReview) return;

    const ctx = getCtx();
    const last = ctx.chat?.[ctx.chat.length - 1];
    if (!last || last.is_user) return;

    const result = await runReview(ctx.chat.length - 1);
    if (result) {
        toastr.info('Auto-review ready — open the message review button to see fixes.');
        addReviewButtonToMessages();
    }
}

// ---------------------------------------------------------------------------
// SETTINGS UI WIRING
// ---------------------------------------------------------------------------

function updateSettingsUI() {
    const s = loadSettings();
    $('#agent-core-enable').prop('checked', s.enabled);
    $('#agent-core-autoreview').prop('checked', s.autoReview);
    $('#agent-core-show-btn').prop('checked', s.showReviewButton);
    $('#agent-core-depth').val(s.reviewDepth);
    renderSkillList();
    $('#agent-core-skill-count').text(s.skills.filter(x => x.enabled).length);
}

async function initUI() {
    const settingsHtml = await $.get(`${EXTENSION_FOLDER}/settings.html`);
    const $all = $(settingsHtml);
    const $drawer = $all.filter('.agent-core-drawer').length
        ? $all.filter('.agent-core-drawer')
        : $all.find('.agent-core-drawer');
    if ($drawer.length) {
        $('#extensions_settings2').append($drawer);
    } else {
        $('#extensions_settings2').append($all);
    }

    // settings events
    $(document).on('input', '#agent-core-enable', function () {
        const s = loadSettings();
        s.enabled = Boolean($(this).prop('checked'));
        saveSettingsDebounced();
        updateSettingsUI();
    });
    $(document).on('input', '#agent-core-autoreview', function () {
        const s = loadSettings();
        s.autoReview = Boolean($(this).prop('checked'));
        saveSettingsDebounced();
    });
    $(document).on('input', '#agent-core-show-btn', function () {
        const s = loadSettings();
        s.showReviewButton = Boolean($(this).prop('checked'));
        saveSettingsDebounced();
        addReviewButtonToMessages();
    });
    $(document).on('change', '#agent-core-depth', function () {
        const s = loadSettings();
        s.reviewDepth = $(this).val();
        saveSettingsDebounced();
    });

    // "New skill" button
    $(document).on('click', '#agent-core-new-skill', async function () {
        const { Popup } = getCtx();
        const name = await Popup.show.input('New Skill', 'Skill name:', '');
        if (!name) return;
        const content = await Popup.show.input('New Skill', 'Content / rule:', '');
        if (!content) return;
        const s = loadSettings();
        s.skills.push({
            id: uid(), name, content, category: 'custom',
            enabled: true, auto: false, createdAt: Date.now(),
        });
        saveSettingsDebounced();
        renderSkillList();
        toastr.success(`Skill added: ${name}`);
    });

    updateSettingsUI();
}

// ---------------------------------------------------------------------------
// BOOT
// ---------------------------------------------------------------------------

jQuery(async () => {
    const ctx = getCtx();
    const { eventSource, event_types } = ctx;

    await initUI();

    // Re-add review buttons whenever messages render or chats switch
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => {
        setTimeout(addReviewButtonToMessages, 100);
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        setTimeout(addReviewButtonToMessages, 300);
    });
    eventSource.on(event_types.GENERATION_ENDED, () => {
        setTimeout(onGenerationEnded, 400);
        setTimeout(addReviewButtonToMessages, 500);
    });

    // Initial pass
    setTimeout(addReviewButtonToMessages, 800);
    console.debug('[Agent Core] Extension ready');
});

export async function onInstall() {
    extension_settings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    saveSettingsDebounced();
    console.log('[Agent Core] Installed with default settings');
}

export async function onActivate() {
    console.log('[Agent Core] Activated');
}