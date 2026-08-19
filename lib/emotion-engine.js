// ChatMood - Emotion Engine
// Ported from SillyTavern-EchoText's lib/emotion-system.js, adapted for a single
// per-chat mood (not per-character-key), stored via api.getState()/api.saveState()
// instead of extensionSettings. Time-based decay (applyEmotionDecay /
// EMOTION_DECAY_PROFILE) is intentionally NOT ported: the main chat is a story,
// not a texting thread, so mood must only change when a message is processed —
// never drain just because real-world time passed between messages.

(function () {
    'use strict';

    function createEmotionEngine(api) {
        const PLUTCHIK_EMOTIONS = [
            { id: 'love', label: 'Love', icon: 'fa-solid fa-heart', color: '#fb7bb8', opposite: 'disgust', intensity: ['Fondness', 'Love', 'Adoration'] },
            { id: 'joy', label: 'Joy', icon: 'fa-solid fa-sun', color: '#facc15', opposite: 'sadness', intensity: ['Serenity', 'Joy', 'Ecstasy'] },
            { id: 'trust', label: 'Trust', icon: 'fa-solid fa-handshake', color: '#4ade80', opposite: 'disgust', intensity: ['Acceptance', 'Trust', 'Admiration'] },
            { id: 'fear', label: 'Fear', icon: 'fa-solid fa-ghost', color: '#a78bfa', opposite: 'anger', intensity: ['Apprehension', 'Fear', 'Terror'] },
            { id: 'surprise', label: 'Surprise', icon: 'fa-solid fa-bolt', color: '#38bdf8', opposite: 'anticipation', intensity: ['Distraction', 'Surprise', 'Amazement'] },
            { id: 'sadness', label: 'Sadness', icon: 'fa-solid fa-cloud-rain', color: '#60a5fa', opposite: 'joy', intensity: ['Pensiveness', 'Sadness', 'Grief'] },
            { id: 'disgust', label: 'Disgust', icon: 'fa-solid fa-face-grimace', color: '#a3e635', opposite: 'trust', intensity: ['Boredom', 'Disgust', 'Loathing'] },
            { id: 'anger', label: 'Anger', icon: 'fa-solid fa-fire-flame-curved', color: '#f87171', opposite: 'fear', intensity: ['Annoyance', 'Anger', 'Rage'] },
            { id: 'anticipation', label: 'Anticipation', icon: 'fa-solid fa-forward', color: '#fb923c', opposite: 'surprise', intensity: ['Interest', 'Anticipation', 'Vigilance'] },
        ];

        // Baseline resting values — calibrated to a neutral "first meeting" level.
        const EMOTION_BASELINE = Object.freeze({ love: 10, joy: 25, trust: 20, fear: 12, surprise: 15, sadness: 12, disgust: 8, anger: 8, anticipation: 25 });
        const MBTI_TRAIT_BASELINE_DELTA = Object.freeze({
            E: { joy: +8, trust: +5, anticipation: +6, sadness: -3, fear: -2, love: +4 },
            I: { joy: -4, trust: +2, anticipation: -3, sadness: +3, fear: +2, surprise: -1 },
            N: { anticipation: +6, surprise: +4, fear: +1, trust: -1 },
            S: { trust: +3, anticipation: -2, surprise: -2 },
            T: { trust: -2, disgust: +2, anger: +2, sadness: -1, love: -4 },
            F: { trust: +5, joy: +3, sadness: +2, anger: -1, disgust: -1, love: +8 },
            J: { anticipation: +2, trust: +2, surprise: -2 },
            P: { surprise: +4, anticipation: +2, trust: -1 }
        });
        const EMOTION_PROGRESS_MINUTES = 30;
        const EMOTION_MESSAGE_INTERVAL_SECONDS = 15;
        const EMOTION_MESSAGES_TO_FULL = Math.max(1, Math.round((EMOTION_PROGRESS_MINUTES * 60) / EMOTION_MESSAGE_INTERVAL_SECONDS));
        const EMOTION_BASE_STEP = 100 / EMOTION_MESSAGES_TO_FULL;

        // Selected once at engine-creation time — see loadEmotionKeywords() below
        // for why changing this setting requires a reload.
        const KEYWORD_LANG = typeof api.getKeywordLanguage === 'function' ? api.getKeywordLanguage() : 'en';

        const NEGATION_WORDS = {
            en: ['not', 'never', 'no', 'un', "don't", 'dont', 'cant', "can't", "won't", 'wont', "isn't", 'isnt', "wasn't", 'wasnt'],
            de: ['nicht', 'nie', 'niemals', 'kein', 'keine', 'keinen', 'keinem', 'keiner', 'nichts'],
        };
        const INTENSE_WORDS = {
            en: ['always', 'never', 'absolutely', 'completely', 'totally', 'despise', 'adore', 'furious', 'terrified', 'heartbroken', 'ecstatic'],
            de: ['immer', 'nie', 'niemals', 'absolut', 'komplett', 'völlig', 'total', 'hasse', 'liebe', 'wütend', 'verängstigt', 'untröstlich', 'ekstatisch'],
        };

        // ── Keyword loading from emotions.json ──────────────────────────────────
        function loadEmotionKeywords() {
            const fallback = {
                love: ['love', 'adore', 'affection', 'longing', 'lust', 'desire', 'passion', 'tender', 'cherish', 'beloved'],
                joy: ['happy', 'joy', 'wonderful', 'amazing', 'excited', 'laugh', 'smile', 'celebrate'],
                trust: ['trust', 'honest', 'reliable', 'safe', 'secure', 'promise', 'loyal', 'support'],
                fear: ['scared', 'afraid', 'fear', 'terrified', 'panic', 'dread', 'anxious', 'horror'],
                surprise: ['wow', 'surprised', 'unexpected', 'shocking', 'unbelievable', 'omg'],
                sadness: ['sad', 'unhappy', 'cry', 'tears', 'lonely', 'hurt', 'grief', 'depressed'],
                disgust: ['disgusting', 'repulsive', 'revolting', 'hate', 'horrible', 'awful'],
                anger: ['angry', 'furious', 'rage', 'annoyed', 'frustrated', 'outraged'],
                anticipation: ['excited', 'looking forward', 'curious', 'eager', 'hope', 'anticipate'],
            };

            const filename = KEYWORD_LANG === 'de' ? 'emotions-de.json' : 'emotions.json';

            try {
                const url = `${api.baseUrl}/lib/${filename}`;
                const xhr = new XMLHttpRequest();
                xhr.open('GET', url, false); // synchronous — same pattern as the module loader
                xhr.send();
                if (xhr.status < 200 || xhr.status >= 300) {
                    console.warn(`[ChatMood] ${filename} not found, using fallback (English) keywords.`);
                    return fallback;
                }
                const raw = JSON.parse(xhr.responseText);
                const result = {};
                for (const [emotionId, value] of Object.entries(raw)) {
                    if (Array.isArray(value)) {
                        result[emotionId] = value.map(k => k.toLowerCase());
                    } else if (typeof value === 'object' && value !== null) {
                        const combined = [];
                        for (const sub of Object.values(value)) {
                            if (Array.isArray(sub)) combined.push(...sub);
                        }
                        result[emotionId] = [...new Set(combined.map(k => k.toLowerCase()))];
                    }
                }
                return result;
            } catch (e) {
                console.warn(`[ChatMood] Failed to load ${filename}:`, e);
                return fallback;
            }
        }

        const TEXT_EMOTION_KEYWORDS = loadEmotionKeywords();

        function clampBaseline(v) { return Math.max(5, Math.min(95, v)); }
        function clampEmotion(v) { return Math.max(0, Math.min(100, v)); }
        function createZeroImpactMap() { return Object.fromEntries(PLUTCHIK_EMOTIONS.map(e => [e.id, 0])); }

        // Word-boundary matching instead of plain substring search — avoids
        // false positives like "safe" matching inside "safety", or "down"
        // matching inside "download". Uses \p{L}/\p{N} lookarounds (with the
        // 'u' flag) rather than plain \b: JS's \b is defined in terms of \w,
        // which is ASCII-only and does NOT include ä/ö/ü/ß — a plain \b would
        // see a false boundary in the middle of most German words (e.g.
        // between 'm' and 'ö' in "möchte"). This works identically for
        // English (ASCII letters are a subset of \p{L}), so it's a pure
        // correctness fix either way, not just a German-support add-on.
        function escapeRegex(kw) {
            return kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }

        function wordBoundaryPattern(inner) {
            return `(?<![\\p{L}\\p{N}_])(?:${inner})(?![\\p{L}\\p{N}_])`;
        }

        function containsKeyword(text, kw) {
            return new RegExp(wordBoundaryPattern(escapeRegex(kw)), 'iu').test(text);
        }

        function countKeywordHits(text, keywords) {
            let hits = 0;
            for (const kw of keywords) if (containsKeyword(text, kw)) hits++;
            return hits;
        }

        // ── Character-card inference (MBTI + archetype bias) language ──────────
        // Runs once per chat directly against the character card's free text
        // (description/personality/scenario), not chat messages — independent
        // of api.getKeywordLanguage() (message-scoring). Read live (not cached
        // like KEYWORD_LANG) since these run at baseline-creation time, not
        // module load, so no reload is required to pick up a change.
        function getMbtiInferenceLanguage() {
            const lang = typeof api.getMbtiInferenceLanguage === 'function' ? api.getMbtiInferenceLanguage() : 'en';
            return (lang === 'de' || lang === 'both') ? lang : 'en';
        }

        function pickByInferenceLanguage(en, de) {
            const lang = getMbtiInferenceLanguage();
            if (lang === 'en') return en;
            if (lang === 'de') return de;
            return [...en, ...de];
        }

        const DIMENSION_KEYWORDS_EN = {
            E: ['outgoing', 'social', 'talkative', 'energetic', 'charismatic', 'party', 'extrovert'],
            I: ['quiet', 'reserved', 'introvert', 'shy', 'private', 'withdrawn', 'loner'],
            N: ['imaginative', 'creative', 'visionary', 'intuitive', 'dreamer', 'abstract', 'symbolic'],
            S: ['practical', 'grounded', 'realistic', 'observant', 'detail', 'literal', 'sensory'],
            T: ['logical', 'rational', 'analytical', 'objective', 'strategic', 'calculating'],
            F: ['empathetic', 'emotional', 'compassionate', 'kind', 'warm', 'sensitive'],
            J: ['organized', 'structured', 'disciplined', 'decisive', 'planner', 'orderly'],
            P: ['spontaneous', 'adaptable', 'flexible', 'improvised', 'chaotic', 'free-spirited'],
        };
        const DIMENSION_KEYWORDS_DE = {
            E: ['aufgeschlossen', 'gesellig', 'gesprächig', 'energisch', 'charismatisch', 'extrovertiert', 'kontaktfreudig'],
            I: ['still', 'zurückhaltend', 'introvertiert', 'schüchtern', 'zurückgezogen', 'einzelgänger', 'privat'],
            N: ['einfallsreich', 'kreativ', 'visionär', 'intuitiv', 'träumerisch', 'abstrakt', 'symbolisch'],
            S: ['praktisch', 'bodenständig', 'realistisch', 'aufmerksam', 'detailorientiert', 'wörtlich', 'sinnlich'],
            T: ['logisch', 'rational', 'analytisch', 'objektiv', 'strategisch', 'berechnend'],
            F: ['einfühlsam', 'emotional', 'mitfühlend', 'freundlich', 'warmherzig', 'sensibel'],
            J: ['organisiert', 'strukturiert', 'diszipliniert', 'entschlossen', 'planer', 'ordentlich'],
            P: ['spontan', 'anpassungsfähig', 'flexibel', 'improvisiert', 'chaotisch', 'freigeistig'],
        };

        function inferMBTIFromCharacter(char) {
            const corpus = `${char?.description || ''} ${char?.personality || ''} ${char?.scenario || ''}`.toLowerCase();
            if (!corpus.trim()) return 'ISFP';

            const dimensions = {
                E: countKeywordHits(corpus, pickByInferenceLanguage(DIMENSION_KEYWORDS_EN.E, DIMENSION_KEYWORDS_DE.E)),
                I: countKeywordHits(corpus, pickByInferenceLanguage(DIMENSION_KEYWORDS_EN.I, DIMENSION_KEYWORDS_DE.I)),
                N: countKeywordHits(corpus, pickByInferenceLanguage(DIMENSION_KEYWORDS_EN.N, DIMENSION_KEYWORDS_DE.N)),
                S: countKeywordHits(corpus, pickByInferenceLanguage(DIMENSION_KEYWORDS_EN.S, DIMENSION_KEYWORDS_DE.S)),
                T: countKeywordHits(corpus, pickByInferenceLanguage(DIMENSION_KEYWORDS_EN.T, DIMENSION_KEYWORDS_DE.T)),
                F: countKeywordHits(corpus, pickByInferenceLanguage(DIMENSION_KEYWORDS_EN.F, DIMENSION_KEYWORDS_DE.F)),
                J: countKeywordHits(corpus, pickByInferenceLanguage(DIMENSION_KEYWORDS_EN.J, DIMENSION_KEYWORDS_DE.J)),
                P: countKeywordHits(corpus, pickByInferenceLanguage(DIMENSION_KEYWORDS_EN.P, DIMENSION_KEYWORDS_DE.P)),
            };

            const pick = (a, b, fallback) => (dimensions[a] === dimensions[b] ? fallback : (dimensions[a] > dimensions[b] ? a : b));
            return `${pick('I', 'E', 'I')}${pick('N', 'S', 'S')}${pick('T', 'F', 'F')}${pick('J', 'P', 'P')}`;
        }

        function applyMBTIBaselineDeltas(base, mbtiType) {
            if (!mbtiType) return base;
            for (const letter of mbtiType.split('')) {
                const deltas = MBTI_TRAIT_BASELINE_DELTA[letter];
                if (!deltas) continue;
                for (const [emotionId, delta] of Object.entries(deltas)) {
                    base[emotionId] = clampBaseline((base[emotionId] ?? EMOTION_BASELINE[emotionId]) + delta);
                }
            }
            return base;
        }

        const ARCHETYPE_WORDS_EN = {
            grumpy: ['grumpy', 'cynical', 'irritable', 'tsundere', 'snarky', 'bitter', 'jaded', 'mean'],
            bubbly: ['bubbly', 'cheerful', 'optimistic', 'playful', 'sunny', 'sweet', 'upbeat', 'enthusiastic'],
            anxious: ['anxious', 'paranoid', 'timid', 'nervous', 'insecure', 'jittery'],
            melancholic: ['melancholic', 'tragic', 'depressed', 'sorrowful', 'gloomy', 'heartbroken'],
            stoic: ['stoic', 'cold', 'detached', 'emotionless', 'composed', 'austere'],
            romantic: ['romantic', 'loving', 'affectionate', 'devoted', 'passionate', 'tender', 'sentimental', 'lovestruck', 'lovesick'],
        };
        const ARCHETYPE_WORDS_DE = {
            grumpy: ['grantig', 'zynisch', 'reizbar', 'bissig', 'verbittert', 'abgestumpft', 'gemein'],
            bubbly: ['fröhlich', 'heiter', 'optimistisch', 'verspielt', 'sonnig', 'süß', 'gutgelaunt', 'begeistert'],
            anxious: ['ängstlich', 'paranoid', 'schüchtern', 'nervös', 'unsicher', 'zappelig'],
            melancholic: ['melancholisch', 'tragisch', 'depressiv', 'traurig', 'düster', 'gebrochen'],
            stoic: ['stoisch', 'kühl', 'distanziert', 'gefühllos', 'gefasst', 'streng'],
            romantic: ['romantisch', 'liebevoll', 'zärtlich', 'hingebungsvoll', 'leidenschaftlich', 'sentimental', 'verliebt'],
        };

        function archetypeMatches(text, key) {
            const words = pickByInferenceLanguage(ARCHETYPE_WORDS_EN[key], ARCHETYPE_WORDS_DE[key]);
            return new RegExp(wordBoundaryPattern(words.map(escapeRegex).join('|')), 'u').test(text);
        }

        function applyPersonaArchetypeBias(base, corpus) {
            const text = (corpus || '').toLowerCase();
            if (!text) return base;

            const hasGrumpy = archetypeMatches(text, 'grumpy');
            const hasBubbly = archetypeMatches(text, 'bubbly');
            const hasAnxious = archetypeMatches(text, 'anxious');
            const hasMelancholic = archetypeMatches(text, 'melancholic');
            const hasStoic = archetypeMatches(text, 'stoic');
            const hasRomantic = archetypeMatches(text, 'romantic');

            if (hasGrumpy) {
                base.anger = clampBaseline(base.anger + 16);
                base.joy = clampBaseline(base.joy - 12);
                base.trust = clampBaseline(base.trust - 8);
                base.disgust = clampBaseline(base.disgust + 6);
                base.love = clampBaseline(base.love - 10);
            }
            if (hasBubbly) {
                base.joy = clampBaseline(base.joy + 16);
                base.trust = clampBaseline(base.trust + 8);
                base.anticipation = clampBaseline(base.anticipation + 7);
                base.sadness = clampBaseline(base.sadness - 6);
                base.anger = clampBaseline(base.anger - 5);
                base.love = clampBaseline(base.love + 10);
            }
            if (hasAnxious) {
                base.fear = clampBaseline(base.fear + 14);
                base.trust = clampBaseline(base.trust - 7);
                base.surprise = clampBaseline(base.surprise + 5);
            }
            if (hasMelancholic) {
                base.sadness = clampBaseline(base.sadness + 16);
                base.joy = clampBaseline(base.joy - 10);
                base.anticipation = clampBaseline(base.anticipation - 6);
                base.love = clampBaseline(base.love + 6);
            }
            if (hasStoic) {
                base.surprise = clampBaseline(base.surprise - 6);
                base.joy = clampBaseline(base.joy - 5);
                base.disgust = clampBaseline(base.disgust + 4);
                base.love = clampBaseline(base.love - 6);
            }
            if (hasRomantic) {
                base.love = clampBaseline(base.love + 20);
                base.trust = clampBaseline(base.trust + 5);
                base.joy = clampBaseline(base.joy + 5);
                base.disgust = clampBaseline(base.disgust - 5);
            }

            return base;
        }

        function buildPersonalityAnchorsForCharacter(char) {
            const mbtiType = inferMBTIFromCharacter(char);
            const corpus = `${char?.description || ''} ${char?.personality || ''} ${char?.scenario || ''}`;
            let anchors = { ...EMOTION_BASELINE };
            anchors = applyMBTIBaselineDeltas(anchors, mbtiType);
            anchors = applyPersonaArchetypeBias(anchors, corpus);
            for (const emotionId of Object.keys(EMOTION_BASELINE)) anchors[emotionId] = clampBaseline(anchors[emotionId]);
            return { mbtiType, anchors };
        }

        function buildAnchoredEmotionState() {
            const char = api.getCurrentCharacter();
            const { mbtiType, anchors } = buildPersonalityAnchorsForCharacter(char);
            return {
                love: anchors.love,
                joy: anchors.joy,
                trust: anchors.trust,
                fear: anchors.fear,
                surprise: anchors.surprise,
                sadness: anchors.sadness,
                disgust: anchors.disgust,
                anger: anchors.anger,
                anticipation: anchors.anticipation,
                personalityAnchor: { ...anchors },
                baselineAnchors: { ...anchors },
                affinityShift: Object.fromEntries(Object.keys(EMOTION_BASELINE).map(id => [id, 0])),
                mbtiType,
                lastImpactSource: 'none',
                lastImpact: createZeroImpactMap()
            };
        }

        // ── State get/save — re-pointed at api.getState()/api.saveState() instead
        // of a character-keyed extensionSettings map. No lastUpdated/decay bookkeeping.
        function getEmotionState() {
            let state = api.getState();
            if (!state) {
                state = buildAnchoredEmotionState();
                api.saveState(state);
                return state;
            }

            if (!state.personalityAnchor || typeof state.personalityAnchor !== 'object' || Array.isArray(state.personalityAnchor)) {
                const seeded = buildAnchoredEmotionState();
                state.personalityAnchor = { ...seeded.personalityAnchor };
                state.baselineAnchors = { ...seeded.baselineAnchors };
                state.affinityShift = { ...seeded.affinityShift };
                state.mbtiType = seeded.mbtiType;
            }
            if (!state.baselineAnchors || typeof state.baselineAnchors !== 'object' || Array.isArray(state.baselineAnchors)) {
                state.baselineAnchors = { ...state.personalityAnchor };
            }
            if (!state.affinityShift || typeof state.affinityShift !== 'object' || Array.isArray(state.affinityShift)) {
                state.affinityShift = Object.fromEntries(Object.keys(EMOTION_BASELINE).map(id => [id, 0]));
            }
            if (typeof state.mbtiType !== 'string') state.mbtiType = inferMBTIFromCharacter(api.getCurrentCharacter());

            for (const emotion of PLUTCHIK_EMOTIONS) {
                if (typeof state[emotion.id] !== 'number' || Number.isNaN(state[emotion.id])) state[emotion.id] = state.baselineAnchors[emotion.id] ?? EMOTION_BASELINE[emotion.id];
                if (typeof state.personalityAnchor[emotion.id] !== 'number' || Number.isNaN(state.personalityAnchor[emotion.id])) state.personalityAnchor[emotion.id] = EMOTION_BASELINE[emotion.id];
                if (typeof state.baselineAnchors[emotion.id] !== 'number' || Number.isNaN(state.baselineAnchors[emotion.id])) state.baselineAnchors[emotion.id] = state.personalityAnchor[emotion.id];
                if (typeof state.affinityShift[emotion.id] !== 'number' || Number.isNaN(state.affinityShift[emotion.id])) state.affinityShift[emotion.id] = Number((state.baselineAnchors[emotion.id] - state.personalityAnchor[emotion.id]).toFixed(2));
            }
            if (!state.lastImpact || typeof state.lastImpact !== 'object' || Array.isArray(state.lastImpact)) state.lastImpact = createZeroImpactMap();
            for (const emotion of PLUTCHIK_EMOTIONS) {
                if (typeof state.lastImpact[emotion.id] !== 'number' || Number.isNaN(state.lastImpact[emotion.id])) state.lastImpact[emotion.id] = 0;
            }
            if (typeof state.lastImpactSource !== 'string') state.lastImpactSource = 'none';
            return state;
        }

        function saveEmotionState(state) {
            api.saveState(state);
        }

        function clearEmotionState() {
            api.saveState(buildAnchoredEmotionState());
        }

        // ── Long-term baseline drift — driven by repeated message patterns, not
        // wall-clock time, so this is kept (unlike applyEmotionDecay).
        function updateAffinityShift(state, source) {
            if (source !== 'user_message' && source !== 'char_message') return state;
            const learningRate = 0.018;

            for (const id of Object.keys(EMOTION_BASELINE)) {
                const anchor = state.personalityAnchor?.[id] ?? EMOTION_BASELINE[id];
                const baseline = state.baselineAnchors?.[id] ?? anchor;
                const drift = state[id] - baseline;
                const shiftDelta = Math.max(-0.85, Math.min(0.85, drift * learningRate));

                const minBaseline = clampBaseline(anchor - 25);
                const maxBaseline = clampBaseline(anchor + 35);
                const updatedBaseline = Math.max(minBaseline, Math.min(maxBaseline, baseline + shiftDelta));

                state.baselineAnchors[id] = updatedBaseline;
                state.affinityShift[id] = Number((updatedBaseline - anchor).toFixed(2));
            }

            return state;
        }

        function getEmotionSensitivityMultiplier(emotionId) {
            const char = api.getCurrentCharacter();
            const history = api.getChatHistory().slice(-10);
            const corpus = [char?.personality, char?.description, char?.scenario, ...history.map(m => m.mes)]
                .filter(Boolean)
                .join(' ')
                .toLowerCase();

            if (!corpus) return 1;
            const keywords = TEXT_EMOTION_KEYWORDS[emotionId] || [];
            let hits = 0;
            for (const kw of keywords) if (containsKeyword(corpus, kw.toLowerCase())) hits++;
            return 1 + Math.min(1.5, hits * 0.12);
        }

        const INTENSE_WORDS_PATTERN = new RegExp(wordBoundaryPattern(INTENSE_WORDS[KEYWORD_LANG].map(escapeRegex).join('|')), 'giu');

        function getTextImpactMultiplier(text) {
            if (!text) return 1;
            const allCapsWords = (text.match(/\b[A-Z]{4,}\b/g) || []).length;
            const strongPunctuation = (text.match(/(!{2,}|\?{2,}|\?!|!\?)/g) || []).length;
            const intenseWords = (text.toLowerCase().match(INTENSE_WORDS_PATTERN) || []).length;
            const score = Math.min(1.75, (allCapsWords * 0.2) + (strongPunctuation * 0.18) + (intenseWords * 0.3));
            return 1 + score;
        }

        function buildEmotionImpact(beforeState, afterState) {
            const impact = {};
            for (const emotion of PLUTCHIK_EMOTIONS) impact[emotion.id] = Number((afterState[emotion.id] - beforeState[emotion.id]).toFixed(2));
            return impact;
        }

        function setLastImpact(state, beforeState, source) {
            state.lastImpact = buildEmotionImpact(beforeState, state);
            state.lastImpactSource = source;
        }

        function enforceOpposites(state) {
            const pairs = [['love', 'disgust'], ['joy', 'sadness'], ['trust', 'disgust'], ['fear', 'anger'], ['surprise', 'anticipation']];
            for (const [a, b] of pairs) {
                const total = (state[a] ?? 0) + (state[b] ?? 0);
                if (total > 80) {
                    const excess = total - 80;
                    if ((state[a] ?? 0) >= (state[b] ?? 0)) state[b] = clampEmotion((state[b] ?? 0) - excess * 0.5);
                    else state[a] = clampEmotion((state[a] ?? 0) - excess * 0.5);
                }
            }
            return state;
        }

        function analyzeTextEmotion(state, text, isUser, weight) {
            if (!text) return state;
            const lower = text.toLowerCase();
            // The character's own reply is weighted higher by default: it's the
            // character's actual felt reaction (as the roleplay model wrote it),
            // while the user's message is only the stimulus that provoked it —
            // secondary context, not the thing whose mood we're tracking.
            // Configurable via the extension's settings panel (index.js).
            const WEIGHT = typeof weight === 'number' ? weight : (isUser ? 0.6 : 1.0);
            const impactMultiplier = getTextImpactMultiplier(text);

            for (const [emotionId, keywords] of Object.entries(TEXT_EMOTION_KEYWORDS)) {
                let hits = 0;
                let negHits = 0;
                for (const kw of keywords) {
                    if (!containsKeyword(lower, kw)) continue;
                    const escaped = escapeRegex(kw);
                    const negWordsPattern = wordBoundaryPattern(NEGATION_WORDS[KEYWORD_LANG].map(escapeRegex).join('|'));
                    const negPattern = new RegExp(`${negWordsPattern}.{0,15}${escaped}`, 'iu');
                    if (negPattern.test(lower)) negHits++;
                    else hits++;
                }
                const netHits = hits - negHits;
                if (netHits !== 0) {
                    const sensitivity = getEmotionSensitivityMultiplier(emotionId);
                    const baselineDelta = Math.min(6, Math.abs(netHits)) * EMOTION_BASE_STEP * 3.5;
                    const delta = baselineDelta * WEIGHT * sensitivity * impactMultiplier * Math.sign(netHits);
                    state[emotionId] = clampEmotion(state[emotionId] + delta);
                    const opp = PLUTCHIK_EMOTIONS.find(e => e.id === emotionId)?.opposite;
                    if (opp) state[opp] = clampEmotion(state[opp] - delta * 0.26);
                }
            }
            return state;
        }

        function getDominantEmotion(state) {
            let best = null;
            let bestVal = -1;
            for (const e of PLUTCHIK_EMOTIONS) if (state[e.id] > bestVal) { bestVal = state[e.id]; best = e; }
            return best;
        }

        function getIntensityLabel(emotionDef, value) {
            if (value < 33) return emotionDef.intensity[0];
            if (value < 66) return emotionDef.intensity[1];
            return emotionDef.intensity[2];
        }

        function buildMBTITemperamentNote(mbti) {
            if (!mbti || mbti.length < 4) return '';
            const [ei, ns, tf, jp] = mbti.toUpperCase().split('');

            const energy = ei === 'E'
                ? 'openly expressive and energised by engagement — tends toward visible, outward reactions'
                : 'more contained in expression — communicates through subtle cues and takes a beat before reacting';
            const perceive = ns === 'N'
                ? 'drawn to meaning and subtext rather than literal facts'
                : 'grounded and specific, prefers concrete sensory detail over abstraction';
            const decide = tf === 'F'
                ? 'warmth-forward and emotionally intuitive — responds to feeling first, reads undercurrents naturally'
                : 'measured and precise — shows care through logic and helpfulness rather than emotional display';
            const structure = jp === 'J'
                ? 'purposeful and consistent in expression'
                : 'spontaneous and adaptive, shifts easily with the mood of the conversation';

            return `${energy}; ${perceive}; ${decide}; ${structure}.`;
        }

        function buildBehavioralGuidance(state, activeEmotions) {
            if (!activeEmotions.length) return 'Replies should feel neutral and measured.';

            const dominant = activeEmotions[0];
            const domVal = state[dominant.id];

            const GUIDANCE = {
                love: [
                    'Softly caring — affectionate in small, understated ways rather than overt declarations.',
                    'Openly affectionate. Warmth bleeds into phrasing naturally; small gestures of care feel instinctive.',
                    'Deeply devoted. Every reply carries a current of adoration — tender, attentive, easily moved.'
                ],
                joy: [
                    'Calm, easy contentment. Tone is unhurried and pleasant without being effusive.',
                    'Bright and upbeat — more expressive and enthusiastic than usual; smiling comes through in the words.',
                    'Overflowing. Happiness is hard to contain — effusive, exclamatory, rides every positive thread fully.'
                ],
                trust: [
                    'Politely open and at ease. Measured warmth — genuine but not gushing; comfortable without being animated.',
                    'Warm and reliable. Genuine engagement, more willing to share than usual, no guardedness.',
                    'Deep openness. Puts this person first, leans in emotionally, speaks with real candour and affection.'
                ],
                fear: [
                    'A mild undercurrent of apprehension — replies are a little more careful, slightly less forthcoming.',
                    'Noticeably unsettled. Hedging language, shorter replies, quicker to flinch from difficult topics.',
                    'Deeply frightened. Hard to stay focused — replies feel fragmented, over-cautious, searching for safety.'
                ],
                surprise: [
                    'Mildly caught off guard — a little more reactive than usual, noticing the unexpected.',
                    'Genuinely surprised. Energy spikes briefly; responses have a disrupted, heightened quality.',
                    'Stunned. Hard to find words — replies come out choppy, exclamatory, or trail off mid-thought.'
                ],
                sadness: [
                    'Quietly pensive. Replies carry a slightly softer, more reflective quality — not heavy, just thoughtful.',
                    'Visibly subdued. Less energy, shorter phrasing, a gentle melancholy colours word choices.',
                    'Heavy and grieving. Replies slow down, become more raw and unguarded; the weight is hard to mask.'
                ],
                disgust: [
                    'Mild distaste — replies are a little more clipped, slightly less generous in tone.',
                    'Clearly put off. Less warmth, more dry or pointed phrasing, reluctance to engage deeply.',
                    'Strong aversion — replies become terse, blunt, or openly critical.'
                ],
                anger: [
                    'Mildly irritated — a slight edge to replies, still controlled but less patient than usual.',
                    'Noticeably frustrated. Shorter, sharper phrasing; pushback comes more readily.',
                    'Openly angry. Replies have real heat — blunt, forceful, quick to escalate if pushed.'
                ],
                anticipation: [
                    'Quietly curious — slightly more engaged than baseline, watching for what comes next.',
                    'Eager and forward-leaning. Enthusiastic about where the conversation is going.',
                    'Intensely focused on what is being anticipated — every reply leans hard toward it, energised and locked in.'
                ]
            };

            const tier = domVal < 33 ? 0 : domVal < 66 ? 1 : 2;
            const mainText = GUIDANCE[dominant.id]?.[tier] ?? 'Replies should feel measured and natural.';

            let modifier = '';
            if (activeEmotions.length > 1) {
                const secondary = activeEmotions[1];
                const secVal = state[secondary.id];
                if (domVal - secVal < 25) {
                    const secTier = secVal < 33 ? 0 : secVal < 66 ? 1 : 2;
                    const SEC_PHRASE = {
                        joy: ['with a hint of lightness underneath', 'with a warm thread of happiness running through', 'colored by real elation'],
                        trust: ['with some underlying comfort', 'with genuine openness and warmth', 'with deep affection'],
                        love: ['with quiet affection', 'with real tenderness', 'with adoration'],
                        sadness: ['but with a wistful undertone', 'but shadowed by a quiet melancholy', 'carrying real grief beneath the surface'],
                        fear: ['with a slight guardedness', 'with an anxious undercurrent', 'with real underlying fear'],
                        anticipation: ['with mild curiosity about what is next', 'and a forward-leaning eagerness', 'and intense focus on what is coming'],
                        anger: ['with a slight irritable edge', 'with some frustration showing through', 'with real anger underneath'],
                        surprise: ['with mild alertness', 'with genuine surprise', 'with shock'],
                        disgust: ['with mild distaste', 'with clear reluctance', 'with strong aversion'],
                    };
                    const phrase = SEC_PHRASE[secondary.id]?.[secTier];
                    if (phrase) modifier = ` — ${phrase}`;
                }
            }

            return `Tone: ${mainText}${modifier}`;
        }

        function buildEmotionContext() {
            const state = getEmotionState();
            const dominant = getDominantEmotion(state);
            if (!dominant) return '';

            const mbti = state.mbtiType || 'ISFP';

            const activeEmotions = PLUTCHIK_EMOTIONS
                .filter(e => state[e.id] >= 12)
                .sort((a, b) => state[b.id] - state[a.id])
                .slice(0, 4);

            if (!activeEmotions.find(e => e.id === dominant.id)) activeEmotions.unshift(dominant);

            const stateSummary = activeEmotions
                .map(e => `${e.label} (${getIntensityLabel(e, state[e.id])}, ${Math.round(state[e.id])}%)`)
                .join(' · ');

            const guidance = buildBehavioralGuidance(state, activeEmotions);
            // Token saver mode skips this — it's the single most expensive line
            // (~70-90 tokens) and also the one that changes least: the character's
            // MBTI-derived temperament is static for the whole chat, so the model
            // has already picked it up from how the character has behaved in the
            // visible transcript by the time it would matter.
            const tokenSaverMode = typeof api.getTokenSaverMode === 'function' && api.getTokenSaverMode();
            const temperamentNote = tokenSaverMode ? '' : buildMBTITemperamentNote(mbti);

            const trustDrift = (state.affinityShift && state.affinityShift.trust) || 0;
            const joyDrift = (state.affinityShift && state.affinityShift.joy) || 0;
            const affinityScore = trustDrift + joyDrift * 0.6;
            let bondNote = '';
            if (affinityScore >= 14) {
                bondNote = '\nBond: Deep trust has built up over time — forgiveness comes easily, warmth is natural, teasing and inside references feel safe.';
            } else if (affinityScore >= 7) {
                bondNote = '\nBond: A warm connection has formed — more open and relaxed with this person than with a stranger.';
            } else if (affinityScore <= -10) {
                bondNote = '\nBond: Repeated tension has worn down baseline trust — emotional spikes take longer to resolve; small frustrations carry extra weight.';
            } else if (affinityScore <= -5) {
                bondNote = '\nBond: Some underlying wariness — more guarded than usual.';
            }

            const emotionLines = [
                tokenSaverMode ? null : `Temperament (${mbti}): ${temperamentNote}`,
                `Feeling right now: ${stateSummary}.`,
                guidance,
                bondNote.trim() || null,
                'Express this through tone, phrasing, and energy — do not name or announce emotions directly unless asked.'
            ].filter(Boolean).join('\n');
            return `\n\n<emotional_state>\n${emotionLines}\n</emotional_state>`;
        }

        // No applyEmotionDecay call here by design — see file header.
        //
        // `opts.updateImpact` (default true) controls whether `lastImpact` gets
        // overwritten by this call. The caller passes `false` for the user's own
        // message so the visible "last change" badges keep showing the impact of
        // the character's *previous* reply until the character actually answers
        // again — index.js then re-applies the char message's impact against
        // `opts.impactBaseline` (a snapshot taken before the user's message was
        // processed), so the displayed delta covers the whole exchange at once
        // instead of flashing to ~0 the moment the user hits send.
        function processMessageEmotion(text, isUser, opts = {}) {
            let state = getEmotionState();
            const before = opts.impactBaseline || { ...state };
            state = analyzeTextEmotion(state, text, isUser, opts.weight);
            state = enforceOpposites(state);
            const source = isUser ? 'user_message' : 'char_message';
            state = updateAffinityShift(state, source);
            if (opts.updateImpact !== false) {
                setLastImpact(state, before, source);
            }
            saveEmotionState(state);
            return state;
        }

        // Directly sets one axis to an explicit value (manual edit mode in the
        // UI) instead of deriving a delta from text. Deliberately skips
        // enforceOpposites/updateAffinityShift — a manual override should
        // stick exactly as set, not get auto-rebalanced against its opposite
        // emotion or nudge the character's long-term baseline.
        function setEmotionValue(emotionId, value) {
            const state = getEmotionState();
            if (typeof state[emotionId] !== 'number') return state;
            const before = { ...state };
            state[emotionId] = clampEmotion(Number(value));
            setLastImpact(state, before, 'manual_edit');
            saveEmotionState(state);
            return state;
        }

        return {
            PLUTCHIK_EMOTIONS,
            getEmotionState,
            clearEmotionState,
            buildEmotionContext,
            processMessageEmotion,
            setEmotionValue,
            getDominantEmotion,
            getIntensityLabel,
        };
    }

    window.ChatMoodEmotionEngine = { createEmotionEngine };
})();
