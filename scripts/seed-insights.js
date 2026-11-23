// Fills a THROWAWAY storage folder with made-up players, sessions, events,
// crashes, designs and artist clicks, so the dashboard can be looked at
// locally. Never point it at real storage: it refuses a folder that already
// holds an insights database unless --force is given.
//
//   node scripts/seed-insights.js <storage folder> [--days 45] [--players 260] [--force]
//
// Run it with the server stopped, then start the server on that folder
// (RAILWAY_VOLUME_MOUNT_PATH=<storage folder>). The worker reads the spool
// files this writes, exactly as it reads what the game sends.
//
// The story it tells: an old build (1.3.2) that only starts sessions and
// reports crashes; build 1.4.0, ten days ago, the first that sends usage data;
// build 1.4.1, two days ago, which also sends the second wave of events.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const storageDir = args.find((arg) => !arg.startsWith('--'));
const option = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] ? Number(args[index + 1]) : fallback;
};
if (!storageDir) {
    console.error('usage: node scripts/seed-insights.js <storage folder> [--days 45] [--players 260] [--force]');
    process.exit(2);
}
const DAYS = option('days', 45);
const PLAYERS_PER_DAY = option('players', 260);
const dbFile = path.join(storageDir, 'insights', 'insights.db');
if (fs.existsSync(dbFile) && !args.includes('--force')) {
    console.error(`${dbFile} exists. This script is for a throwaway folder; pass --force to add to it anyway.`);
    process.exit(2);
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const TODAY = Math.floor(NOW / DAY) * DAY;
const RELEASE_140 = TODAY - 10 * DAY + 15 * 60 * 60 * 1000;
const RELEASE_141 = TODAY - 2 * DAY + 14 * 60 * 60 * 1000;
const RELEASE_132 = TODAY - 40 * DAY;

// A small deterministic generator, so two runs give the same data.
let seed = 20261123;
const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
};
const between = (low, high) => low + random() * (high - low);
const whole = (low, high) => Math.floor(between(low, high + 1));
const chance = (p) => random() < p;
const pick = (list) => list[Math.floor(random() * list.length)];
function weighted(table) { // [[value, weight], ...]
    const total = table.reduce((sum, entry) => sum + entry[1], 0);
    let roll = random() * total;
    for (const [value, weight] of table) {
        roll -= weight;
        if (roll <= 0) return value;
    }
    return table[table.length - 1][0];
}
const id = () => {
    const bytes = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(random() * 256);
    return bytes.toString('hex');
};
const uuid = () => {
    const hex = id();
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const round1 = (value) => Math.round(value * 10) / 10;

// ---------------------------------------------------------------------------
// Output: spool files per UTC day
// ---------------------------------------------------------------------------

const spoolDir = path.join(storageDir, 'insights', 'spool');
const crashDir = path.join(storageDir, 'insights', 'crashes');
fs.mkdirSync(spoolDir, { recursive: true });
fs.mkdirSync(crashDir, { recursive: true });
fs.mkdirSync(path.join(storageDir, 'thumbnails'), { recursive: true });
const lines = new Map(); // day -> [line]
function spool(record) {
    const day = new Date(record.received_at).toISOString().slice(0, 10);
    if (!lines.has(day)) lines.set(day, []);
    lines.get(day).push(JSON.stringify(record));
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

const COLLECTIONS = ['berlin', 'newyork', 'offgrid', 'sanfrancisco', 'tokyo'];
const LEVELS = COLLECTIONS.flatMap((name) => [1, 2, 3].map((n) => `${name}-0${n}`));
const ITEMS = ['BP_Sofa_Loop', 'BP_Chair_Bistro', 'BP_Table_Oak', 'BP_Lamp_Arc', 'BP_Plant_Monstera', 'BP_Rug_Wool', 'BP_Shelf_Wall',
    'BP_Bed_Low', 'BP_Desk_Studio', 'BP_Mirror_Round', 'BP_Books_Stack', 'BP_Vase_Clay', 'BP_Poster_Frame', 'BP_Curtain_Linen',
    'BP_Stool_Cork', 'BP_Cabinet_Kitchen', 'BP_Record_Player', 'BP_Candle_Set', 'BP_Basket_Woven', 'BP_Clock_Wall',
    'BP_Sideboard_Teak', 'BP_Armchair_Boucle', 'BP_Pendant_Glass', 'BP_Bench_Hall', 'BP_Planter_Tall', 'BP_Throw_Blanket'];
const WINDOWS_GPUS = [['NVIDIA GeForce RTX 3060', 16], ['NVIDIA GeForce RTX 4060', 14], ['NVIDIA GeForce GTX 1650', 9], ['NVIDIA GeForce RTX 3070', 8],
    ['NVIDIA GeForce RTX 4070', 8], ['AMD Radeon RX 6600', 6], ['AMD Radeon RX 7800 XT', 4], ['NVIDIA GeForce GTX 1060 6GB', 6],
    ['Intel(R) UHD Graphics 630', 5], ['Intel(R) Iris(R) Xe Graphics', 7], ['AMD Radeon(TM) Graphics', 6], ['NVIDIA GeForce RTX 2060', 6],
    ['Intel(R) Arc(TM) A750 Graphics', 2], ['NVIDIA GeForce RTX 4090', 2]];
const MAC_CHIPS = [['Apple M1', 30], ['Apple M2', 26], ['Apple M3', 16], ['Apple M1 Pro', 10], ['Apple M2 Pro', 7], ['Apple M3 Pro', 6], ['Apple M4', 5]];
const LANGUAGES = [['en', 38], ['de', 14], ['zh-Hans', 12], ['fr', 8], ['ja', 7], ['es', 7], ['ko', 5], ['pt-BR', 5], ['ru', 4]];
const SCREENS = [[1920, 1080, 50], [2560, 1440, 22], [3840, 2160, 6], [1366, 768, 5], [1280, 800, 6], [2560, 1600, 6], [3024, 1964, 5]];
const WEAK_GPU = /UHD|Iris|Radeon\(TM\)|GTX 1650|GTX 1060/;

function newInstall(firstSeen) {
    const platform = weighted([['Windows', 84], ['Mac', 11.5], ['Deck', 4.5]]);
    const install = { install_id: id(), first_seen: firstSeen, launches: 0, platform, existing: chance(0.7), stars: whole(0, 6) };
    if (platform === 'Mac') {
        const chip = weighted(MAC_CHIPS);
        Object.assign(install, {
            wire_platform: 'Mac', device: chance(0.96) ? 'apple_silicon' : 'intel_mac', cpu: chip, gpu: chip, cpu_cores: pick([8, 8, 10, 12]),
            ram_gb: pick([8, 8, 16, 16, 24, 32]), rhi: 'Metal', os_version: pick(['15.1', '15.2', '14.7.1', '26.0', '26.1']),
            upscaler: weighted([['tsr', 60], ['fsr', 25], ['none', 15]])
        });
    } else if (platform === 'Deck') {
        Object.assign(install, {
            wire_platform: 'Windows', device: 'steam_deck', ...(chance(0.4) ? { cpu: 'AMD Custom APU 0932', gpu: 'AMD Custom GPU 0932' }
                : { cpu: 'AMD Custom APU 0405', gpu: 'AMD Custom GPU 0405' }), cpu_cores: 8, ram_gb: 16,
            rhi: 'D3D12', os_version: 'Windows 10 (Proton)', upscaler: weighted([['fsr', 70], ['tsr', 20], ['none', 10]])
        });
    } else {
        const gpu = weighted(WINDOWS_GPUS);
        Object.assign(install, {
            wire_platform: 'Windows', device: chance(0.03) ? 'proton' : 'pc', gpu, cpu: pick(['AMD Ryzen 5 5600X 6-Core Processor', 'Intel(R) Core(TM) i5-12400F',
                'Intel(R) Core(TM) i7-10700K', 'AMD Ryzen 7 5800X3D 8-Core Processor', 'Intel(R) Core(TM) i5-8250U', 'AMD Ryzen 5 3600 6-Core Processor']),
            cpu_cores: pick([4, 6, 6, 8, 8, 12, 16]), ram_gb: pick([8, 16, 16, 16, 32, 32, 64]), rhi: chance(0.9) ? 'D3D12' : 'D3D11',
            os_version: pick(['Windows 11 (24H2)', 'Windows 11 (23H2)', 'Windows 10 (22H2)', 'Windows 11 (25H2)']),
            upscaler: /NVIDIA.*RTX/.test(gpu) ? weighted([['dlss', 70], ['tsr', 20], ['none', 10]])
                : /Arc/.test(gpu) ? weighted([['xess', 60], ['tsr', 40]]) : weighted([['fsr', 45], ['tsr', 35], ['none', 20]])
        });
    }
    const screen = install.device === 'steam_deck' ? [1280, 800] : weighted(SCREENS.map((entry) => [[entry[0], entry[1]], entry[2]]));
    Object.assign(install, {
        screen_w: screen[0], screen_h: screen[1], language: weighted(LANGUAGES),
        quality: WEAK_GPU.test(install.gpu) || install.device === 'steam_deck' ? weighted([['0', 20], ['1', 45], ['2', 30], ['3', 5]])
            : weighted([['1', 5], ['2', 20], ['3', 50], ['4', 25]]),
        window_mode: weighted([['borderless', 62], ['fullscreen', 24], ['windowed', 14]]),
        base_fps: WEAK_GPU.test(install.gpu) ? between(22, 48) : install.device === 'steam_deck' ? between(30, 45) : between(55, 140),
        retention: between(0.25, 0.75), mod: install.platform === 'Windows' && chance(0.02)
    });
    return install;
}

// ---------------------------------------------------------------------------
// Crashes
// ---------------------------------------------------------------------------

let AdmZip = null;
try { AdmZip = require('adm-zip'); } catch (error) { console.warn('adm-zip is not installed: crashes are written through the old route\'s record instead of archives'); }

const CRASH_KINDS = [
    { weight: 22, type: 'Crash', message: 'Fatal error: [File:D:\\build\\++UE5\\Sync\\Engine\\Source\\Runtime\\D3D12RHI\\Private\\D3D12Util.cpp] [Line: 948]\nOut of video memory trying to allocate a rendering resource. Make sure your video card has the minimum required memory.', weak: true, stack: ['UnrealEditor_D3D12RHI!TerminateOnOutOfMemory()', 'UnrealEditor_D3D12RHI!FD3D12DynamicRHI::CreateTexture()', 'SmallSpaces!USSRoomStreaming::LoadMaterialSet()'] },
    { weight: 16, type: 'Hang', message: 'GameThread timed out waiting for RenderThread after 120.00 seconds', weak: true, stack: ['UnrealEditor_RenderCore!FRenderCommandFence::Wait()', 'SmallSpaces!ASSPlayerController::FinishRoomLoad()'] },
    { weight: 14, type: 'Crash', message: 'Unhandled Exception: EXCEPTION_ACCESS_VIOLATION reading address 0x0000000000000038', stack: ['SmallSpaces!USSControllerPlacement::CommitPlacement()', 'SmallSpaces!USSControllerPlacement::Tick()', 'UnrealEditor_Engine!FActorTickFunction::ExecuteTick()'] },
    { weight: 9, type: 'Crash', message: 'Unhandled Exception: EXCEPTION_ACCESS_VIOLATION reading address 0x00000000000001a0', stack: ['SmallSpaces!UUndoRedoSubsystem::Undo()', 'SmallSpaces!USSControllerInput::HandleUndo()'] },
    { weight: 8, type: 'GPUCrash', message: 'GPU Crash dump Triggered\nDXGI_ERROR_DEVICE_REMOVED', weak: true, stack: ['UnrealEditor_D3D12RHI!FD3D12Adapter::HandleGpuCrash()', 'UnrealEditor_D3D12RHI!FD3D12Viewport::Present()'] },
    { weight: 7, type: 'Assert', message: 'Assertion failed: IsInGameThread() [File:D:\\build\\SmallSpaces\\Source\\SmallSpaces\\Media\\Private\\CustomImageManager.cpp] [Line: 212]', stack: ['SmallSpaces!UCustomImageManager::OnImageDecoded()', 'UnrealEditor_Core!FAsyncTask::DoWork()'] },
    { weight: 6, type: 'OutOfMemory', message: 'Ran out of memory allocating 67108864 bytes with alignment 16', stack: ['UnrealEditor_Core!FGenericPlatformMemory::OnOutOfMemory()', 'SmallSpaces!USSControllerSaveFlowBridge::WriteSave()'] },
    { weight: 5, type: 'Crash', message: 'Fatal error: [File:D:\\build\\++UE5\\Sync\\Engine\\Source\\Runtime\\RenderCore\\Private\\ShaderCodeArchive.cpp] [Line: 413]\nShader compilation failures are Fatal.', stack: ['UnrealEditor_RenderCore!FShaderCodeArchive::CreateShader()', 'UnrealEditor_Renderer!FMaterialShaderMap::Compile()'] },
    { weight: 4, type: 'Ensure', message: 'Ensure condition failed: Slot.IsValid() [File:D:\\build\\SmallSpaces\\Source\\SmallSpaces\\Controller\\Private\\SSControllerSharingHost.cpp] [Line: 301]', stack: ['SmallSpaces!USSControllerSharingHost::ApplyGalleryPage()'] },
    { weight: 3, type: 'Crash', message: 'Unhandled Exception: EXCEPTION_ACCESS_VIOLATION writing address 0x0000000000000000', only141: true, stack: ['SmallSpaces!USSTutorialOverlay::AdvanceStep()', 'SmallSpaces!USSControllerProgressionTutorial::HandleAddStar()'] },
    { weight: 3, type: 'Crash', message: 'Fatal error: [File:D:\\build\\SmallSpaces\\Source\\SmallSpaces\\Gameplay\\Private\\CreativeGrid.cpp] [Line: 88]\nArray index out of bounds: 512 into an array of size 512', stack: ['SmallSpaces!UCreativeGrid::CellAt()', 'SmallSpaces!ASSToolWall::Preview()'] }
];
const escapeXml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function crashXml(kind, install, secondsAlive) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<FGenericCrashContext><RuntimeProperties>
<CrashType>${kind.type}</CrashType><ErrorMessage>${escapeXml(kind.message)}</ErrorMessage>
<IsAssert>${kind.type === 'Assert'}</IsAssert><IsStall>false</IsStall><MemoryStats.bIsOOM>${kind.type === 'OutOfMemory' ? 1 : 0}</MemoryStats.bIsOOM>
<PCallStackHash>${crypto.createHash('sha1').update(kind.stack.join('|')).digest('hex').toUpperCase()}</PCallStackHash>
<PCallStack>${escapeXml(kind.stack.map((frame, index) => `${frame} [0x${(0x7ff600000000 + index * 4096).toString(16)}]`).join('\n'))}</PCallStack>
<Misc.CPUBrand>${escapeXml(install.cpu)}</Misc.CPUBrand><Misc.PrimaryGPUBrand>${escapeXml(install.gpu)}</Misc.PrimaryGPUBrand>
<Misc.OSVersionMajor>${escapeXml(install.os_version)}</Misc.OSVersionMajor><MemoryStats.TotalPhysicalGB>${install.ram_gb}</MemoryStats.TotalPhysicalGB>
<EngineVersion>5.8.4-0+UE5</EngineVersion><BuildConfiguration>Shipping</BuildConfiguration><SecondsSinceStart>${Math.round(secondsAlive)}</SecondsSinceStart>
<GameName>UE-SmallSpaces</GameName><AppDefaultLocale>${install.language}</AppDefaultLocale>
</RuntimeProperties></FGenericCrashContext>`;
}
let crashCount = 0;
function writeCrash(install, sessionId, build, at, secondsAlive, legacy) {
    const kinds = CRASH_KINDS.filter((kind) => (!kind.only141 || build === '1.4.1') && (!kind.weak || WEAK_GPU.test(install.gpu) || chance(0.25)));
    const kind = weighted(kinds.map((entry) => [entry, entry.weight]));
    const guid = `UECC-Windows-${id().toUpperCase()}_0000`;
    crashCount++;
    if (install.platform === 'Mac' || !AdmZip || legacy) {
        // The old route's record: it had already read the archive.
        spool({
            type: 'legacy_crash', legacy: true, received_at: at, crash_id: guid, file: null, platform: legacy ? null : install.wire_platform,
            metadata: {
                id: guid, version: build, session_id: legacy ? 'unknown' : sessionId, file_size: whole(40000, 900000),
                crash_context: {
                    error_message: kind.message, crash_type: kind.type, callstack: kind.stack.join('\n'), callstack_hash: 'seed', cpu: install.cpu, gpu: install.gpu,
                    os: install.os_version, ram_gb: install.ram_gb, engine_version: '5.8.4-0+UE5', seconds_since_start: Math.round(secondsAlive), crash_time: null
                }
            }
        });
        return;
    }
    const zip = new AdmZip();
    zip.addFile('CrashContext.runtime-xml', Buffer.from(crashXml(kind, install, secondsAlive)));
    zip.addFile('SmallSpaces.log', Buffer.from('LogInit: seeded crash report\n'));
    fs.writeFileSync(path.join(crashDir, `${guid}.zip`), zip.toBuffer());
    spool({
        type: 'crash', received_at: at, crash_guid: guid, install_id: install.install_id, session_id: sessionId, build, steam_build: build === '1.4.1' ? 20144210 : 20101987,
        platform: install.wire_platform, file: `insights/crashes/${guid}.zip`, size: 2048
    });
}

// ---------------------------------------------------------------------------
// One session of the new protocol
// ---------------------------------------------------------------------------

const featuredIds = [];
const designIds = [];
function playSession(install, start, build) {
    const sessionId = id();
    const wave2 = build === '1.4.1';
    install.launches++;
    let seq = 0;
    let clock = start;
    const events = [];
    const add = (name, props, advance = 0) => {
        clock += advance * 1000;
        events.push({ name, t: Math.round(clock), seq: seq++, props });
    };
    const settings = {
        quality_preset: install.quality, upscaler: install.upscaler, window_mode: install.window_mode, screen_w: install.screen_w,
        screen_h: install.screen_h, res_scale: install.upscaler === 'none' ? 100 : pick([67, 77, 100]), language: install.language
    };
    add('session_start', {
        build, steam_build: wave2 ? 20144210 : 20101987, steam_branch: chance(0.03) ? 'beta' : 'public', platform: install.wire_platform,
        os_version: install.os_version, device: install.device, mod_ue4ss: install.mod, cpu: install.cpu, cpu_cores: install.cpu_cores,
        ram_gb: install.ram_gb, gpu: install.gpu, rhi: install.rhi, ...settings, launch_count: install.launches, existing_player: install.existing
    });
    const previous = install.unclean;
    if (previous) {
        add('session_abnormal_end', {
            prev_session_id: previous.session_id, last_stage: previous.stage, seconds_alive: Math.round(previous.alive),
            prev_started_ms: previous.started, prev_last_ms: previous.started + previous.alive * 1000, had_crash_folder: previous.crashed
        });
        install.unclean = null;
    }

    // Some sessions die before the menu.
    const startupDeath = chance(WEAK_GPU.test(install.gpu) ? 0.035 : 0.008);
    let stage = 'startup';
    let died = startupDeath;
    let active = 0;
    if (!died) {
        add('menu_shown', { startup_s: round1(between(6, WEAK_GPU.test(install.gpu) ? 40 : 18)), ...settings }, between(6, 20));
        stage = 'menu';
        if (chance(0.06)) {
            const key = pick(['quality_preset', 'upscaler', 'window_mode']);
            const to = key === 'quality_preset' ? pick(['1', '2', '3', '4'].filter((value) => value !== settings.quality_preset))
                : key === 'upscaler' ? pick(['fsr', 'tsr', 'none'].filter((value) => value !== settings.upscaler))
                : pick(['borderless', 'fullscreen', 'windowed'].filter((value) => value !== settings.window_mode));
            add('setting_change', { key, to, by: 'player' }, between(5, 40));
            settings[key] = to;
        }
        if (wave2 && install.launches <= 2) {
            const steps = ['welcome', 'move_camera', 'place_item', 'rotate_item', 'open_catalogue', 'finish'];
            for (const step of steps) {
                const action = chance(0.88) ? 'done' : 'skipped';
                add('onboarding_step', { flow: 'first_room', step, action }, between(4, 25));
                if (action === 'skipped' && chance(0.5)) break;
            }
        }
        if (chance(0.35)) {
            add('gallery_open', { ok: chance(0.97), count: whole(12, 60) }, between(3, 30));
            add('featured_shown', { ok: true, count: featuredIds.length }, 1);
            const viewed = whole(0, 4);
            for (let i = 0; i < viewed; i++) {
                const featured = chance(0.4) && featuredIds.length > 0;
                const design = featured ? pick(featuredIds) : pick(designIds);
                if (wave2) add('design_view', { design_id: design, list: featured ? 'featured' : pick(['newest', 'top', 'search']) }, between(4, 30));
                if (chance(0.45)) add('design_download', { design_id: design, ok: chance(0.96) }, between(2, 10));
                if (chance(0.3)) add('design_like', { design_id: design, like: chance(0.92) }, between(1, 8));
            }
        }
        if (wave2 && chance(0.2)) {
            const placement = pick(['main_menu', 'catalogue_poster', 'credits']);
            add('artist_link_shown', { slug: 'leah', placement }, between(2, 20));
            if (chance(0.12)) add('artist_link_click', { slug: 'leah', placement }, between(2, 15));
        }

        const rooms = weighted([[1, 55], [2, 30], [3, 12], [0, 3]]);
        for (let room = 0; room < rooms && !died; room++) {
            const mode = weighted([['unpack', 34], ['design', 40], ['creative', 16], ['community', 10]]);
            const level = mode === 'unpack' ? LEVELS[Math.min(LEVELS.length - 1, Math.floor(Math.abs(between(0, 1) + between(0, 1) - 1) * LEVELS.length))] : pick(LEVELS);
            add('room_enter', { mode, level_id: level }, between(3, 20));
            stage = `loading:${mode}:${level}`;
            if (chance(0.012)) {
                add('room_load_failed', { mode, level_id: level, stage: pick(['StreamLevel', 'RestoreSave', 'SpawnItems']), canceled: chance(0.3) }, between(5, 60));
                stage = 'load_failed';
                continue;
            }
            const load = between(4, WEAK_GPU.test(install.gpu) ? 45 : 16);
            if (chance(WEAK_GPU.test(install.gpu) ? 0.02 : 0.004)) { clock += load * 500; died = true; break; }
            add('room_ready', { mode, level_id: level, load_s: round1(load) }, load);
            stage = `room:${mode}:${level}`;
            const duration = Math.max(40, between(2, 40) * 60 * (mode === 'community' ? 0.3 : 1));
            if (chance(0.012)) { clock += duration * 400; active += duration * 0.3; died = true; break; }
            const placed = mode === 'community' ? whole(0, 3) : whole(2, 90);
            if (chance(0.04)) add('save_failed', { outcome: pick(['WriteFailed', 'DiskFull', 'Timeout']), mode, level_id: level }, duration * 0.3);
            if (mode === 'unpack' && chance(0.5)) {
                install.stars++;
                add('star_earned', { level_id: level, stars_total: install.stars }, duration * 0.3);
                if (wave2 && chance(0.7)) add('level_complete', { level_id: level, stars: whole(1, 3), duration_s: Math.round(duration) }, 2);
            }
            if (wave2 && chance(0.18)) add('photo_taken', { mode }, duration * 0.1);
            if (wave2 && chance(0.01)) add('content_skipped', { kind: 'item', id: pick(ITEMS) }, 1);
            if (chance(0.03)) add('image_upload', { ok: chance(0.9) }, 5);
            if (mode !== 'community' && chance(0.05)) add('design_upload', { ok: chance(0.93) }, 10);
            const exitTo = room + 1 < rooms ? pick(['menu', 'room']) : 'quit';
            clock = Math.max(clock, events[events.length - 1].t) ;
            const roomActive = duration * between(0.7, 1);
            active += roomActive;
            add('room_exit', {
                mode, level_id: level, duration_s: Math.round(duration), active_s: Math.round(roomActive), items_placed: placed,
                items_removed: whole(0, Math.ceil(placed / 4)), items_moved: whole(0, placed * 2), materials_applied: whole(0, 12),
                build_steps: mode === 'creative' ? whole(5, 200) : 0, undo_count: whole(0, 20), redo_count: whole(0, 5), saves: whole(0, 4), ready: true, exit_to: exitTo
            }, duration * 0.4);
            if (duration > 30) {
                const fps = Math.max(8, install.base_fps * between(0.85, 1.1) * (settings.quality_preset === '4' ? 0.85 : 1));
                add('room_perf', {
                    mode, level_id: level, fps_avg: round1(fps), fps_p1: round1(fps * between(0.45, 0.8)), hitches: whole(0, fps < 30 ? 40 : 8),
                    mem_mb: whole(2800, 7200), quality_preset: settings.quality_preset, upscaler: settings.upscaler, res_scale: settings.res_scale
                });
            }
            if (placed > 0) {
                const used = new Map();
                for (let i = 0; i < placed; i++) {
                    const item = ITEMS[Math.min(ITEMS.length - 1, Math.floor(Math.pow(random(), 1.8) * ITEMS.length))];
                    used.set(item, (used.get(item) || 0) + 1);
                }
                add('catalog_usage', { mode, level_id: level, items: [...used.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([item, count]) => `${item}:${count}`).join(',') });
            }
            stage = exitTo === 'quit' ? stage : 'menu';
        }
    }
    const alive = (clock - start) / 1000 + (died ? between(2, 20) : 0);
    if (died) {
        const crashed = chance(install.platform === 'Mac' ? 0.5 : 0.8);
        install.unclean = { session_id: sessionId, stage, alive, started: start, crashed };
        if (crashed) writeCrash(install, sessionId, build, start + alive * 1000 + between(20, 4000) * 1000, alive, false);
    } else {
        add('session_end', { duration_s: Math.round(alive), active_s: Math.round(active), reason: 'quit' }, between(1, 20));
    }

    // Batches as the game sends them: the first at once, then every 30 seconds.
    const header = { type: 'collect', schema: 2, install_id: install.install_id, session_id: sessionId, build, steam_build: wave2 ? 20144210 : 20101987, platform: install.wire_platform };
    let batch = [];
    let batchEnd = events[0].t + 1000;
    const flush = () => {
        if (batch.length === 0) return;
        const sent = Math.max(batch[batch.length - 1].t, batchEnd);
        // The player's clock is off by up to five minutes; sent_at carries the same error.
        const skew = install.clock_skew || 0;
        spool({ ...header, received_at: sent + 400, sent_at: sent + skew, events: batch.map((event) => ({ ...event, t: event.t + skew })) });
        batch = [];
    };
    for (const event of events) {
        if (event.t > batchEnd) { flush(); batchEnd = event.t + 30000; }
        batch.push(event);
    }
    flush();
    return clock;
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

// Designs and artists first, so sessions can refer to them.
const designs = [];
const TITLES = ['Sunday light', 'Tiny reading nook', 'Plant shop loft', 'Two desks, one cat', 'Midnight studio', 'Grandma\'s kitchen', 'Record corner',
    'Balcony jungle', 'Attic for two', 'Blue hour', 'Tatami and tea', 'Brick and brass', 'Soft landing', 'The long table', 'Writer\'s room', 'Under the stairs'];
for (let i = 0; i < 180; i++) {
    const designId = uuid();
    designIds.push(designId);
    const uploaded = NOW - between(0, DAYS) * DAY;
    designs.push({
        id: designId, title: `${pick(TITLES)}${chance(0.4) ? ` ${whole(2, 9)}` : ''}`, description: '', author_name: pick(['mika', 'Juno', 'pixelfern', 'Okapi', 'lotte_b', 'Sam', 'nori', 'Wren', 'Ada', 'kestrel']),
        level: pick(LEVELS), download_count: whole(0, 400), upload_date: new Date(uploaded).toISOString(), thumbnail_url: `/api/thumbnails/${designId}.png`, christmas_event: false
    });
}
// A 4:3 PNG placeholder per design (one flat warm colour).
function png(width, height, rgb) {
    const zlib = require('zlib');
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
    const raw = Buffer.concat(Array.from({ length: height }, () => row));
    const chunk = (type, data) => {
        const body = Buffer.concat([Buffer.from(type), data]);
        const out = Buffer.alloc(body.length + 8);
        out.writeUInt32BE(data.length, 0);
        body.copy(out, 4);
        out.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) >>> 0 : 0, body.length + 4);
        return out;
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.set([8, 2, 0, 0, 0], 8);
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
for (const design of designs) {
    fs.writeFileSync(path.join(storageDir, 'thumbnails', `${design.id}.png`), png(64, 48, [whole(150, 230), whole(120, 190), whole(90, 160)]));
}
featuredIds.push(...designIds.slice(0, 6));
fs.writeFileSync(path.join(storageDir, 'metadata.json'), JSON.stringify(designs, null, 2));
fs.writeFileSync(path.join(storageDir, 'featured.json'), JSON.stringify([...featuredIds, uuid()], null, 2)); // the last one no longer exists
fs.writeFileSync(path.join(storageDir, 'artists.json'), JSON.stringify([
    { slug: 'leah', name: 'Leah Gardner', destination: 'https://example.com/', active: true, utm_campaign: 'artist-showcase' }
], null, 2));
const clicks = [];
for (let day = Math.min(DAYS, 30); day >= 0; day--) {
    const count = whole(2, 14);
    for (let i = 0; i < count; i++) {
        const bot = chance(0.12);
        clicks.push({
            id: id().slice(0, 12), slug: 'leah', placement: pick(['main_menu', 'main_menu', 'catalogue_poster', 'credits']),
            timestamp: new Date(TODAY - day * DAY + between(0, DAY - 1)).toISOString(), bot, unique: !bot && chance(0.8), visitor: id().slice(0, 16)
        });
    }
}
fs.writeFileSync(path.join(storageDir, 'artist_clicks.json'), JSON.stringify(clicks.filter((click) => Date.parse(click.timestamp) <= NOW), null, 2));

// Uploads the thumbnail image check refused, in the shape server.js writes
// (logModerationRejection): the Gallery page's rejections. It has its own
// generator, so the rest of the seeded data stays as it was.
{
    let state = 4711;
    const next = () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
    };
    const rejections = [];
    for (let i = 0; i < 34; i++) {
        const sexual = next() < 0.7 ? (next() < 0.5 ? 4 : 2) : 0;
        const violence = sexual === 0 || next() < 0.2 ? 2 : 0;
        rejections.push({
            date: new Date(NOW - next() * Math.min(DAYS, 24) * DAY).toISOString(),
            design_id: [8, 4, 4, 4, 12].map((length) => Array.from({ length }, () => Math.floor(next() * 16).toString(16)).join('')).join('-'),
            title: ['Untitled room', 'My flat', 'Test', 'Loft v2', 'Party room', 'Night shift'][Math.floor(next() * 6)] + (next() < 0.5 ? ` ${2 + Math.floor(next() * 30)}` : ''),
            author_name: ['kasia_w', 'dmn_44', 'buildmore', 'ines.r', 'p_olsen', 'marco_b', 'Anonymous'][Math.floor(next() * 7)],
            categories: [{ category: 'Hate', severity: 0 }, { category: 'SelfHarm', severity: 0 }, { category: 'Sexual', severity: sexual }, { category: 'Violence', severity: violence }]
        });
    }
    rejections.sort((a, b) => (a.date < b.date ? -1 : 1));
    fs.writeFileSync(path.join(storageDir, 'moderation_rejections.json'), JSON.stringify(rejections, null, 2));
}

const installs = [];
let sessions = 0;
let legacySessions = 0;
for (let back = DAYS; back >= 0; back--) {
    const dayStart = TODAY - back * DAY;
    const weekend = [0, 6].includes(new Date(dayStart).getUTCDay());
    const target = Math.round(PLAYERS_PER_DAY * (weekend ? 1.25 : 1) * between(0.9, 1.1) * (back === 0 ? (NOW - TODAY) / DAY : 1));

    // Who plays today: returning installs by their own habit, then new ones.
    const today = installs.filter((install) => chance(install.retention * Math.max(0.15, 1 - (dayStart - install.first_seen) / (60 * DAY))));
    while (today.length < target) {
        const install = newInstall(dayStart);
        install.clock_skew = chance(0.1) ? Math.round(between(-300, 300)) * 1000 : 0;
        installs.push(install);
        today.push(install);
    }
    for (const install of today.slice(0, Math.max(target, 1))) {
        const launches = weighted([[1, 62], [2, 28], [3, 10]]);
        let at = dayStart + between(7, 23) * 60 * 60 * 1000 * (back === 0 ? Math.min(1, (NOW - TODAY) / DAY / 0.96) : 1);
        for (let launch = 0; launch < launches; launch++) {
            if (at > NOW - 5 * 60 * 1000) break;
            // Which build this launch runs: players update over a few days.
            const since140 = (at - RELEASE_140) / DAY;
            const since141 = (at - RELEASE_141) / DAY;
            install.build = install.build === '1.4.1' || (since141 > 0 && chance(Math.min(0.9, 0.45 + since141 * 0.25))) ? '1.4.1'
                : install.build === '1.4.0' || (since140 > 0 && chance(Math.min(0.85, 0.4 + since140 * 0.12))) ? '1.4.0' : '1.3.2';
            if (install.build === '1.3.2') {
                // The old build: a session start, one game mode event per room, crashes through the old route.
                const sessionId = uuid();
                legacySessions++;
                spool({ type: 'legacy_session', legacy: true, received_at: at, session: { id: sessionId, start_time: new Date(at).toISOString(), client_version: '1.0.0', platform: install.wire_platform === 'Mac' ? 'Mac' : 'Windows', metadata: {} } });
                spool({ type: 'legacy_events', legacy: true, received_at: at + 60000, events: [{ id: uuid(), session_id: sessionId, event_name: 'TrackGameMode', properties: { GameMode: pick(['Unpack', 'Design', 'Design', 'Creative']) }, timestamp: new Date(at + 60000).toISOString(), client_version: '1.0.0', platform: 'Windows' }] });
                if (chance(WEAK_GPU.test(install.gpu) ? 0.06 : 0.02)) writeCrash(install, sessionId, '1.3.2', at + between(1, 40) * 60000, between(20, 2400), true);
                at += between(20, 90) * 60000;
            } else {
                sessions++;
                at = playSession(install, at, install.build) + between(10, 240) * 60000;
            }
        }
    }
}

for (const [day, list] of lines) {
    fs.appendFileSync(path.join(spoolDir, `collect-${day}.ndjson`), `${list.join('\n')}\n`);
}

// Build markers go straight into the database (the server must be stopped).
const database = require('../insights/db');
const db = database.open(dbFile);
for (const [name, released, note] of [['1.3.2', RELEASE_132, 'Autumn fixes'], ['1.4.0', RELEASE_140, 'Mac release, usage data'], ['1.4.1', RELEASE_141, 'Hotfix, second wave of events']]) {
    db.run('INSERT OR REPLACE INTO build_markers (name, released_at, note) VALUES (?, ?, ?)', name, released, note);
}
db.close();

console.log(`Seeded ${storageDir}: ${installs.length} installs, ${sessions} new sessions, ${legacySessions} old sessions, ${crashCount} crashes, ${designs.length} designs, ${lines.size} spool days.`);
