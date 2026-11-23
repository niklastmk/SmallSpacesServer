// The spool: what the game sent, appended as one JSON line per record to a
// file per UTC day, storage/insights/spool/collect-YYYY-MM-DD.ndjson.
//
// The main thread only appends here (createSpool). The worker thread reads the
// files from where it stopped last time (listSpoolFiles, readSpoolLines) and
// deletes a file once all of it is in the database and it is over a week old.
// A record is safe as soon as its line is written, whether or not the database
// can be opened.
const fs = require('fs');
const path = require('path');

const SPOOL_FILE = /^collect-(\d{4}-\d{2}-\d{2})\.ndjson$/;

function spoolDir(storageDir) {
    return path.join(storageDir, 'insights', 'spool');
}

function utcDay(ms) {
    return new Date(ms).toISOString().slice(0, 10);
}

function spoolFileName(ms) {
    return `collect-${utcDay(ms)}.ndjson`;
}

// The spool files in the order they were written: [{ name, day, file, size }].
function listSpoolFiles(dir) {
    let names;
    try {
        names = fs.readdirSync(dir);
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
    const files = [];
    for (const name of names.sort()) {
        const match = SPOOL_FILE.exec(name);
        if (!match) continue;
        const file = path.join(dir, name);
        try {
            files.push({ name, day: match[1], file, size: fs.statSync(file).size });
        } catch (error) {
            // deleted between the listing and the stat
        }
    }
    return files;
}

// A process stopped in the middle of an append can leave a last line without
// its line end. Close that line, so the next record starts on a line of its
// own; the reader skips the broken one.
function closeUnfinishedLine(file) {
    const size = fs.statSync(file).size;
    if (size === 0) return false;
    const fd = fs.openSync(file, 'r');
    const last = Buffer.alloc(1);
    try {
        fs.readSync(fd, last, 0, 1, size - 1);
    } finally {
        fs.closeSync(fd);
    }
    if (last[0] === 0x0A) return false;
    fs.appendFileSync(file, '\n');
    return true;
}

// Main thread. Creates the folder, closes unfinished lines left by an earlier
// process, and returns { append, dir }.
function createSpool(storageDir, log = console) {
    const dir = spoolDir(storageDir);
    fs.mkdirSync(dir, { recursive: true });
    for (const entry of listSpoolFiles(dir)) {
        try {
            if (closeUnfinishedLine(entry.file)) {
                log.warn(`Insights spool ${entry.name} ended in an unfinished line; closed it`);
            }
        } catch (error) {
            log.error(`Insights spool ${entry.name} could not be checked:`, error.message);
        }
    }

    // One append at a time, in the order asked for, so two records never mix
    // their lines. Records that arrive while an append is running are written
    // together by the next one.
    let waiting = []; // { file, text, resolve, reject }
    let writing = false;

    async function drain() {
        writing = true;
        while (waiting.length > 0) {
            const batch = waiting;
            waiting = [];
            const byFile = new Map();
            for (const item of batch) {
                byFile.set(item.file, (byFile.get(item.file) || '') + item.text);
            }
            let failure = null;
            for (const [file, text] of byFile) {
                try {
                    await fs.promises.appendFile(file, text);
                } catch (error) {
                    failure = failure || error;
                }
            }
            for (const item of batch) {
                if (failure) item.reject(failure); else item.resolve();
            }
        }
        writing = false;
    }

    // Appends one record as one line. `record.received_at` (epoch ms) decides
    // the day file. Resolves when the line is written.
    function append(record) {
        return new Promise((resolve, reject) => {
            let text;
            try {
                text = JSON.stringify(record) + '\n';
            } catch (error) {
                return reject(error);
            }
            const received = Number.isFinite(record.received_at) ? record.received_at : Date.now();
            waiting.push({ file: path.join(dir, spoolFileName(received)), text, resolve, reject });
            if (!writing) drain();
        });
    }

    return { append, dir };
}

// Worker thread. Reads whole lines of a spool file starting at `offset`.
// Returns { lines: [{ record | null, text }], nextOffset, more }. A line that
// is not a JSON object comes back with record null. The last line is only
// returned once its line end has been written.
function readSpoolLines(file, offset, size, maxBytes) {
    let length = Math.min(size - offset, maxBytes);
    const fd = fs.openSync(file, 'r');
    try {
        for (;;) {
            const buffer = Buffer.alloc(length);
            const read = fs.readSync(fd, buffer, 0, length, offset);
            const end = buffer.lastIndexOf(0x0A, read - 1);
            if (end === -1) {
                // No whole line in this piece: a line longer than the piece, or
                // the last line is still being written. Read more if there is more.
                if (offset + read < size && length < 256 * 1024 * 1024) {
                    length = Math.min(size - offset, length * 4);
                    continue;
                }
                return { lines: [], nextOffset: offset, more: false };
            }
            const lines = [];
            let start = 0;
            while (start <= end) {
                let lineEnd = buffer.indexOf(0x0A, start);
                if (lineEnd === -1 || lineEnd > end) lineEnd = end;
                if (lineEnd > start) {
                    const text = buffer.toString('utf8', start, lineEnd);
                    let record = null;
                    try {
                        const parsed = JSON.parse(text);
                        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) record = parsed;
                    } catch (error) {
                        record = null;
                    }
                    lines.push({ record, text });
                }
                start = lineEnd + 1;
            }
            const nextOffset = offset + end + 1;
            return { lines, nextOffset, more: nextOffset < size };
        }
    } finally {
        fs.closeSync(fd);
    }
}

module.exports = { createSpool, listSpoolFiles, readSpoolLines, spoolDir, spoolFileName, utcDay, SPOOL_FILE };
