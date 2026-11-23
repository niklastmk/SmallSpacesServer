// Reads a crash archive and derives its category and group key.
//
// extractCrashContext, deriveCategory and deriveGroupKey are copies of the
// functions of the same name in server.js (which the old crash routes keep
// using). The copy differs in three places:
// - it also reports what the archive holds when there is no
//   CrashContext.runtime-xml;
// - it reads the macOS crash report (.ips, or the older .crash text) that a
//   Mac archive holds instead of a CrashContext.runtime-xml;
// - a report without any context gets a group key of its own per platform.
let AdmZip;
try {
    AdmZip = require('adm-zip');
} catch (error) {
    AdmZip = null;
}

// ZIP bomb protection: limits individual entry sizes
const MAX_ZIP_ENTRY_SIZE = 10 * 1024 * 1024; // 10 MB max per extracted entry
const MAC_CALLSTACK_FRAMES = 12;
const MAC_GROUP_FRAMES = 3;

function contextFromXml(xml) {
    // Simple XML tag extractor (avoids needing an XML parser dependency)
    const get = (tag) => {
        const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
        return m ? m[1].trim() : '';
    };
    return {
        error_message: get('ErrorMessage'),
        crash_type: get('CrashType'),
        is_assert: get('IsAssert') === 'true',
        is_stall: get('IsStall') === 'true',
        is_oom: get('MemoryStats.bIsOOM') === '1',
        callstack_hash: get('PCallStackHash'),
        callstack: get('PCallStack'),
        cpu: get('Misc.CPUBrand'),
        gpu: get('Misc.PrimaryGPUBrand'),
        os: get('Misc.OSVersionMajor'),
        ram_gb: parseInt(get('MemoryStats.TotalPhysicalGB')) || 0,
        ram_available_bytes: parseInt(get('MemoryStats.AvailablePhysical')) || 0,
        vram_used_bytes: parseInt(get('MemoryStats.UsedVirtual')) || 0,
        engine_version: get('EngineVersion'),
        build_config: get('BuildConfiguration'),
        seconds_since_start: parseInt(get('SecondsSinceStart')) || 0,
        game_name: get('GameName'),
        locale: get('AppDefaultLocale'),
        crash_time: null
    };
}

// ---------------------------------------------------------------------------
// macOS crash reports
// ---------------------------------------------------------------------------

const text = (value, max = 300) => (typeof value === 'string' ? value.slice(0, max) : '');

// "2026-11-22 14:03:11.00 +0100" (the .ips and .crash form) -> ISO string, or null.
function macTimestamp(value) {
    if (typeof value !== 'string') return null;
    const m = value.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?\s*(Z|[+-]\d{2}):?(\d{2})?$/);
    const iso = m
        ? `${m[1]}T${m[2]}${m[3] || ''}${m[4] === 'Z' ? 'Z' : `${m[4]}:${m[5] || '00'}`}`
        : value;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const isHangName = (name) => /\.(hang|diag)$/i.test(name || '');

// EXC_BAD_ACCESS -> 'Access Violation', EXC_CRASH or SIGABRT -> 'Crash',
// hangs (bug_type 298 or a .hang / .diag file) -> 'Hang', anything else 'Crash'.
function macCategory(exceptionType, signal, bugType, reportName) {
    if (String(bugType) === '298' || isHangName(reportName)) return 'Hang';
    if (/EXC_BAD_ACCESS/.test(exceptionType || '')) return 'Access Violation';
    if (/EXC_CRASH/.test(exceptionType || '') || /SIGABRT/.test(signal || '')) return 'Crash';
    return 'Crash';
}

// Builds the context from what either Mac format gave us. `frames` are
// { image, offset, symbol, own } of the faulting thread, top first.
function macContext(source, fields, frames, reportName) {
    const line = (frame) => `${frame.image}+${frame.offset}`;
    const exceptionType = text(fields.exception_type, 80);
    const signal = text(fields.signal, 40);
    const indicator = text(fields.indicator, 160);
    const category = macCategory(exceptionType, signal, fields.bug_type, reportName);

    let message = exceptionType || (category === 'Hang' ? 'Hang' : '');
    if (signal) message += message ? ` (${signal})` : signal;
    if (indicator) message += message ? `: ${indicator}` : indicator;

    const own = frames.filter((frame) => frame.own);
    const keyFrames = (own.length > 0 ? own : frames).slice(0, MAC_GROUP_FRAMES).map(line);
    const groupKey = [exceptionType || (category === 'Hang' ? 'hang' : 'unknown'), ...keyFrames].join('|').slice(0, 300);

    return {
        source,
        error_message: message,
        crash_type: category === 'Hang' ? 'Hang' : 'Crash',
        is_assert: false,
        is_stall: category === 'Hang',
        is_oom: false,
        callstack_hash: '',
        callstack: frames.slice(0, MAC_CALLSTACK_FRAMES)
            .map((frame) => line(frame) + (frame.symbol ? ` (${frame.symbol})` : '')).join('\n'),
        cpu: text(fields.cpu, 120),
        gpu: '',
        os: text(fields.os, 120),
        ram_gb: 0,
        engine_version: '',
        build_config: '',
        seconds_since_start: Number.isFinite(fields.seconds_since_start) ? fields.seconds_since_start : 0,
        game_name: text(fields.app_name, 120),
        locale: '',
        crash_time: fields.crash_time || null,
        // Mac only
        app_version: text(fields.app_version, 80),
        bug_type: text(String(fields.bug_type || ''), 20),
        exception_type: exceptionType,
        exception_subtype: text(fields.exception_subtype, 200),
        signal,
        mac_category: category,
        mac_group_key: groupKey
    };
}

// An .ips file: one JSON object on the first line (the header), then a second
// JSON object (the body). Returns a context, or null when it is not that.
function contextFromIps(content, reportName) {
    const newline = content.indexOf('\n');
    let header = null;
    let body = null;
    try {
        header = JSON.parse(newline === -1 ? content : content.slice(0, newline));
    } catch (error) {
        return null;
    }
    if (!header || typeof header !== 'object' || Array.isArray(header)) return null;
    if (newline !== -1) {
        try {
            body = JSON.parse(content.slice(newline + 1));
        } catch (error) {
            body = null; // the header alone still gives time, system and version
        }
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
    // Not a crash report at all (some other JSON file with the same ending).
    if (!header.bug_type && !header.app_name && !body.exception && !Array.isArray(body.threads)) return null;

    const exception = body.exception && typeof body.exception === 'object' ? body.exception : {};
    const termination = body.termination && typeof body.termination === 'object' ? body.termination : {};
    const images = Array.isArray(body.usedImages) ? body.usedImages : [];
    const threads = Array.isArray(body.threads) ? body.threads : [];
    const appName = text(header.app_name, 120) || text(header.name, 120) || text(body.procName, 120);

    let thread = Number.isInteger(body.faultingThread) ? threads[body.faultingThread] : null;
    if (!thread) thread = threads.find((candidate) => candidate && candidate.triggered) || threads[0] || null;
    const rawFrames = thread && Array.isArray(thread.frames) ? thread.frames : [];
    const frames = [];
    for (const frame of rawFrames.slice(0, 64)) {
        if (!frame || typeof frame !== 'object') continue;
        const image = images[frame.imageIndex] && typeof images[frame.imageIndex] === 'object' ? images[frame.imageIndex] : {};
        const imageName = text(image.name, 120) || '?';
        const imagePath = text(image.path, 400);
        frames.push({
            image: imageName,
            offset: Number.isFinite(frame.imageOffset) ? frame.imageOffset : 0,
            symbol: text(frame.symbol, 160),
            own: Boolean(appName) && (imageName === appName || imagePath.includes(`/${appName}.app/`))
        });
    }

    const crashTime = macTimestamp(header.timestamp) || macTimestamp(body.captureTime);
    const launched = Date.parse(macTimestamp(body.procLaunch) || '');
    const captured = Date.parse(macTimestamp(body.captureTime) || crashTime || '');
    const cpu = [text(body.cpuType, 40), text(body.modelCode, 40)].filter(Boolean);

    return macContext('ips', {
        exception_type: exception.type,
        exception_subtype: exception.subtype,
        signal: exception.signal,
        indicator: termination.indicator,
        bug_type: header.bug_type || body.bug_type,
        cpu: cpu.length === 2 ? `${cpu[0]} (${cpu[1]})` : cpu[0] || '',
        os: text(header.os_version, 120) || text(body.osVersion && body.osVersion.train, 120),
        app_name: appName,
        app_version: header.app_version,
        crash_time: crashTime,
        seconds_since_start: Number.isFinite(launched) && Number.isFinite(captured) && captured >= launched
            ? Math.round((captured - launched) / 1000) : undefined
    }, frames, reportName);
}

// The older text report (.crash). Returns a context, or null when the text
// has none of the lines such a report starts with.
function contextFromCrashText(content, reportName) {
    const field = (label) => {
        const m = content.match(new RegExp(`^${label}:[ \\t]*(.+)$`, 'm'));
        return m ? m[1].trim() : '';
    };
    const exceptionLine = field('Exception Type');
    const processLine = field('Process');
    if (!exceptionLine && !processLine) return null;

    const exceptionMatch = exceptionLine.match(/^(\S+)(?:\s*\((\w+)\))?/);
    const appName = processLine.replace(/\s*\[\d+\]\s*$/, '');
    const crashedThread = field('Crashed Thread').match(/^(\d+)/);

    // "Thread 0 Crashed:" then lines such as
    // "0   SmallSpaces    0x0000000104f3c1a4 0x104000000 + 15974820"
    const frames = [];
    const start = crashedThread
        ? content.search(new RegExp(`^Thread ${crashedThread[1]}\\b.*$`, 'm'))
        : content.search(/^Thread \d+ Crashed.*$/m);
    if (start !== -1) {
        const lines = content.slice(start).split('\n').slice(1, 80);
        for (const raw of lines) {
            const m = raw.match(/^\d+\s+(.+?)\s+0x[0-9a-fA-F]+\s+(.*)$/);
            if (!m) {
                if (raw.trim() === '') break;
                continue;
            }
            const imageName = m[1].trim().slice(0, 120);
            const tail = m[2].trim();
            const load = tail.match(/^0x[0-9a-fA-F]+\s*\+\s*(\d+)$/);
            const symbol = load ? null : tail.match(/^(.*?)\s*\+\s*(\d+)$/);
            frames.push({
                image: imageName,
                offset: load ? Number(load[1]) : symbol ? Number(symbol[2]) : 0,
                symbol: symbol ? symbol[1].slice(0, 160) : '',
                own: Boolean(appName) && imageName === appName
            });
        }
    }

    return macContext('crash', {
        exception_type: exceptionMatch ? exceptionMatch[1] : '',
        signal: exceptionMatch ? exceptionMatch[2] : '',
        exception_subtype: field('Exception Codes'),
        indicator: field('Termination Reason'),
        cpu: [field('Code Type'), field('Hardware Model')].filter(Boolean).join(' / '),
        os: field('OS Version'),
        app_name: appName,
        app_version: field('Version'),
        crash_time: macTimestamp(field('Date/Time'))
    }, frames, reportName);
}

// Reads a macOS report in either format. Never throws; null when unreadable.
function parseMacReport(content, reportName) {
    try {
        const trimmed = String(content).replace(/^﻿/, '');
        if (trimmed.trimStart().startsWith('{')) {
            const fromIps = contextFromIps(trimmed.trimStart(), reportName);
            if (fromIps) return fromIps;
        }
        return contextFromCrashText(trimmed, reportName);
    } catch (error) {
        return null;
    }
}

// ---------------------------------------------------------------------------
// The archive
// ---------------------------------------------------------------------------

// Reads an archive (a Buffer or a file path). Never throws.
// Returns { ok, error, context, has_context, has_minidump, crash_time, entries,
// report_name, hang }. `context` is null when the archive holds neither a
// CrashContext.runtime-xml nor a readable macOS report.
function parseCrashArchive(source) {
    const result = {
        ok: false, error: null, context: null, has_context: false, has_minidump: false,
        crash_time: null, entries: [], report_name: null, hang: false
    };
    if (!AdmZip) {
        result.error = 'adm-zip is not installed';
        return result;
    }
    try {
        const zip = new AdmZip(source);
        const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
        result.entries = entries.slice(0, 50).map((entry) => String(entry.entryName).slice(0, 200));
        // The files may sit in a folder inside the archive; match on the file name.
        const baseName = (entry) => String(entry.entryName).split('/').pop();
        const find = (name) => zip.getEntry(name) || entries.find((entry) => baseName(entry) === name) || null;

        const contextEntry = find('CrashContext.runtime-xml');
        if (contextEntry) {
            if (contextEntry.header.size > MAX_ZIP_ENTRY_SIZE) {
                result.error = `CrashContext.runtime-xml too large (${contextEntry.header.size} bytes)`;
            } else {
                result.context = contextFromXml(contextEntry.getData().toString('utf-8'));
                result.has_context = true;
            }
        }

        // Extract actual crash timestamp from minidump header
        const dmpEntry = find('UEMinidump.dmp');
        if (dmpEntry) {
            result.has_minidump = true;
            if (dmpEntry.header.size <= MAX_ZIP_ENTRY_SIZE) {
                const dmpData = dmpEntry.getData();
                // MINIDUMP_HEADER: Signature(4) Version(4) NumberOfStreams(4) StreamDirectoryRva(4) CheckSum(4) TimeDateStamp(4)
                if (dmpData.length >= 24 && dmpData.toString('ascii', 0, 4) === 'MDMP') {
                    const unixTimestamp = dmpData.readUInt32LE(20);
                    if (unixTimestamp > 0) {
                        result.crash_time = new Date(unixTimestamp * 1000).toISOString();
                    }
                }
            }
        }
        if (result.context) result.context.crash_time = result.crash_time;

        // A Mac archive: one macOS report instead of the two files above.
        if (!result.context) {
            const report = ['.ips', '.crash', '.hang', '.diag']
                .map((ending) => entries.find((entry) => baseName(entry).toLowerCase().endsWith(ending)))
                .find(Boolean);
            if (report) {
                result.report_name = baseName(report).slice(0, 200);
                result.hang = isHangName(result.report_name);
                if (report.header.size > MAX_ZIP_ENTRY_SIZE) {
                    result.error = `${result.report_name} too large (${report.header.size} bytes)`;
                } else {
                    const context = parseMacReport(report.getData().toString('utf-8'), result.report_name);
                    if (context) {
                        result.context = context;
                        result.has_context = true;
                        result.crash_time = context.crash_time;
                        result.hang = context.mac_category === 'Hang';
                    } else {
                        result.error = `${result.report_name} could not be read as a macOS crash report`;
                    }
                }
            }
        }
        result.ok = true;
    } catch (error) {
        result.error = String((error && error.message) || error).slice(0, 300);
    }
    return result;
}

// Same answer as the function in server.js for a Windows archive: the context, or null.
function extractCrashContext(buffer) {
    return parseCrashArchive(buffer).context;
}

// Derive a meaningful category from the error message content, not just crash_type
function deriveCategory(ctx) {
    const err = (ctx.error_message || '').toLowerCase();
    const crashType = (ctx.crash_type || '').toLowerCase();

    // Specific error patterns (checked first — most informative)
    if (err.includes('shader compilation failures')) return 'Shader Compilation';
    if (err.includes('out of video memory')) return 'Out of VRAM';
    if (err.includes('ran out of memory') || err.includes('paging file')) return 'Out of RAM';
    if (err.includes('gpu crash dump')) return 'GPU Crash';
    if (err.includes('timed out waiting for renderthread')) return 'Render Hang';
    if (err.includes('hang detected')) return 'Thread Hang';
    if (err.includes('scalability.ini') || err.includes('ecvf_scalability')) return 'Config Error';
    if (err.includes('exception_access_violation')) return 'Access Violation';
    if (err.includes('uniformbuffer') || err.includes('shadertablehash')) return 'Shader Mismatch';
    if (err.includes('material') && (err.includes('deleted') || err.includes('render proxy'))) return 'Material Error';
    if (err.includes('isingamethread') || err.includes('isinrenderingthread')) return 'Threading Error';
    if (err.includes('crashing the gamethread at your request')) return 'Intentional Crash';

    // Fall back to crash_type for anything unmatched
    if (crashType === 'outofmemory') return 'Out of Memory';
    if (crashType === 'gpucrash') return 'GPU Crash';
    if (crashType === 'hang') return 'Hang';
    if (crashType === 'ensure') return 'Assertion';
    if (crashType === 'assert') return 'Fatal Error';
    if (crashType === 'crash') return 'Crash';
    return 'Unknown';
}

// Derive a group key from the error message — groups by error pattern, not exact callstack
function deriveGroupKey(ctx) {
    const err = ctx.error_message || '';

    // Extract [File:...\Filename.cpp] [Line: N] pattern
    const fileLineMatch = err.match(/\[File:.*?([^\\\/:]+)\]\s*\[Line:\s*(\d+)\]/);
    if (fileLineMatch) {
        return `${fileLineMatch[1]}:${fileLineMatch[2]}`;
    }

    // For messages without file/line, normalize the first line
    const firstLine = err.split('\n')[0].trim();
    const normalized = firstLine
        .replace(/0x[0-9a-fA-F]+/g, '0x_')           // hex addresses
        .replace(/after \d+\.\d+ seconds/g, 'after N seconds')  // timeout values
        .replace(/allocating \d+/g, 'allocating N')    // allocation sizes
        .slice(0, 120);

    return normalized || ctx.crash_type || 'unknown';
}

// Category, group key and group title for a crash. `context` may be null: such
// reports are grouped per platform (and hang or not) instead of all landing in
// one "unknown" group.
function classifyCrash(context, platform, hang = false) {
    if (context && context.mac_group_key) {
        return {
            category: context.mac_category || 'Crash',
            group_key: `mac:${context.mac_group_key}`,
            title: (context.error_message || 'macOS report without exception details').slice(0, 120)
        };
    }
    if (!context || (!context.error_message && !context.crash_type)) {
        const where = platform || 'unknown platform';
        return hang
            ? { category: 'Hang', group_key: `no-context-hang:${platform || 'unknown'}`, title: `Hang report without readable context (${where})` }
            : { category: 'Unknown', group_key: `no-context:${platform || 'unknown'}`, title: `Report without crash context (${where})` };
    }
    const groupKey = deriveGroupKey(context);
    const title = context.error_message
        ? context.error_message.split('\n')[0].slice(0, 120)
        : `Crash group ${groupKey.slice(0, 8)}`;
    return { category: deriveCategory(context), group_key: groupKey, title };
}

module.exports = {
    available: () => Boolean(AdmZip),
    parseCrashArchive,
    parseMacReport,
    extractCrashContext,
    deriveCategory,
    deriveGroupKey,
    classifyCrash,
    MAX_ZIP_ENTRY_SIZE
};
