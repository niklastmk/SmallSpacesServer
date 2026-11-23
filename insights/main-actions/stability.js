// Stability actions that need the network: the generated summary of a crash issue.
//
// Runs on the main thread. The issue's facts come from the worker
// (`stability.summary_facts`), the answer is stored through the worker
// (`stability.save_summary`); nothing here reads stored data.
//
// The call follows the crash analysis of the old dashboard (server.js,
// /api/crashes/reclassify): the Anthropic SDK, one short request, JSON back.
let Anthropic = null;
try {
    Anthropic = require('@anthropic-ai/sdk').default;
} catch (error) {
    Anthropic = null;
}

// INSIGHTS_SUMMARY_MODEL overrides the model.
const DEFAULT_MODEL = 'claude-haiku-5-5';
const REQUEST_MS = 60 * 1000;
// The model thinks before it answers and that counts against the limit, so
// the limit is well above the few sentences asked for.
const MAX_TOKENS = 4000;

function refuse(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}
// The Anthropic API did not give a usable answer: the route answers 502.
const upstream = (message) => refuse('upstream', message);

const percent = (value) => (typeof value === 'number' ? `${Math.round(value * 100)} %` : 'unknown');
const shares = (rows) => (Array.isArray(rows) && rows.length > 0
    ? rows.map((row) => `${row.name} ${percent(row.share)}`).join(', ') : 'unknown');

function launchLine(bins) {
    if (!Array.isArray(bins) || bins.every((bin) => typeof bin.share !== 'number')) return 'unknown';
    const minutes = (seconds) => Math.round(seconds / 60);
    return bins.filter((bin) => bin.share > 0).map((bin) => {
        const label = bin.to_s === null ? `over ${minutes(bin.from_s)} min` : bin.from_s === 0 ? `under ${minutes(bin.to_s)} min` : `${minutes(bin.from_s)} to ${minutes(bin.to_s)} min`;
        return `${label} ${percent(bin.share)}`;
    }).join(', ') || 'unknown';
}

function promptFor(facts) {
    const frames = Array.isArray(facts.frames) && facts.frames.length > 0
        ? facts.frames.map((frame, index) => `${index} ${frame.text}${frame.game ? '   <- game code' : ''}`).join('\n')
        : 'unavailable';
    return `You are analysing one crash issue of the Unreal Engine 5 game "Small Spaces" (an interior design game for Windows, Mac and Steam Deck). The numbers below are computed from the crash reports of this issue.

Issue: ${facts.title}
Category: ${facts.category}${facts.crash_type ? ` (${facts.crash_type})` : ''}
Error message:
${facts.error_message || 'unavailable'}

Reports: ${facts.reports_all_time} in builds ${Array.isArray(facts.builds) && facts.builds.length > 0 ? facts.builds.join(', ') : 'unknown'}
Platforms: ${shares(facts.platforms)}
Graphics cards: ${shares(facts.graphics_cards)}
System memory: ${shares(facts.memory)}
Operating systems: ${shares(facts.systems)}
What the player was doing: ${shares(facts.activity)}
Time since launch: ${launchLine(facts.time_since_launch)}
Most common call stack (${facts.same_trace ? `${facts.same_trace.same} of ${facts.same_trace.of} reports` : 'unknown share'}), top frame first:
${frames}

Write for the two developers of the game. Use only what is given above; where the data does not show a cause, say what is missing instead of guessing. Plain sentences, no lists, no markdown.

Return JSON only, with exactly these two fields:
{"likely_cause": "one to three sentences on what most likely causes this crash, naming the numbers that support it", "suggested_fix": "one to three sentences on what to change or check first"}`;
}

// The model's answer as an object. It is asked for JSON only, but may wrap it
// in a code fence or a sentence.
function readAnswer(text) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        const value = JSON.parse(text.slice(start, end + 1));
        return value && typeof value === 'object' ? value : null;
    } catch (error) {
        return null;
    }
}

// POST /api/admin/v2/do/stability.summarise  { id: 'SS-12' }
// Answers { summary: { likely_cause, suggested_fix, at, reports } }.
async function summarise(body, context) {
    if (typeof process.env.ANTHROPIC_API_KEY !== 'string' || process.env.ANTHROPIC_API_KEY === '') {
        throw refuse('invalid', 'A summary cannot be written: ANTHROPIC_API_KEY is not set on the server.');
    }
    if (!Anthropic) {
        throw refuse('invalid', 'A summary cannot be written: the Anthropic SDK is not installed on the server.');
    }
    // Refuses with not_found or invalid for an issue that does not exist.
    const facts = (await context.card('stability.summary_facts', { id: String(body.id === undefined ? '' : body.id) })).data;
    if (!facts.reports_read) throw refuse('conflict', `${facts.key} has no reports to write a summary from.`);

    const client = new Anthropic({ timeout: REQUEST_MS, maxRetries: 1 });
    let response;
    try {
        response = await client.messages.create({
            model: process.env.INSIGHTS_SUMMARY_MODEL || DEFAULT_MODEL,
            max_tokens: MAX_TOKENS,
            messages: [{ role: 'user', content: promptFor(facts) }]
        });
    } catch (error) {
        if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
            throw refuse('invalid', 'A summary cannot be written: the Anthropic API refused the key set on the server.');
        }
        if (error instanceof Anthropic.RateLimitError) {
            throw upstream('The Anthropic API is rate limited at the moment. Try again in a minute.');
        }
        if (error instanceof Anthropic.APIConnectionError) {
            throw upstream('The Anthropic API could not be reached. Try again.');
        }
        if (error instanceof Anthropic.APIError) {
            throw upstream(`The Anthropic API answered with an error (${error.status || 'no status'}).`);
        }
        throw upstream('The request to the Anthropic API failed. Try again.');
    }
    if (response.stop_reason === 'refusal') throw upstream('The model declined to write this summary.');

    const text = (response.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('\n');
    const answer = readAnswer(text);
    const likelyCause = answer && typeof answer.likely_cause === 'string' ? answer.likely_cause.trim() : '';
    const suggestedFix = answer && typeof answer.suggested_fix === 'string' ? answer.suggested_fix.trim() : '';
    if (likelyCause === '' && suggestedFix === '') {
        context.log.error(`Insights summary for ${facts.key}: the answer could not be read (stop reason ${response.stop_reason}).`);
        throw upstream('The summary could not be read from the answer. Try again.');
    }
    const stored = await context.action('stability.save_summary', {
        id: facts.id, likely_cause: likelyCause, suggested_fix: suggestedFix, reports: facts.reports_all_time
    });
    return { summary: stored.summary };
}

module.exports = { actions: { 'stability.summarise': summarise }, promptFor, readAnswer };
