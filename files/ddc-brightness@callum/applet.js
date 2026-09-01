/*
 * DDC Brightness — a Cinnamon applet giving each external monitor its own
 * brightness slider, driven over DDC/CI by ddcutil. An "Advanced" toggle adds
 * contrast and colour-temperature sliders for the monitors that support them.
 *
 * SPDX-License-Identifier: MIT
 */

const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const Util = imports.misc.util;
const Main = imports.ui.main;
const GLib = imports.gi.GLib;
const Clutter = imports.gi.Clutter;
const St = imports.gi.St;

const UUID = "ddc-brightness@callum";

/* An applet installed outside the Cinnamon tree needs its own text domain —
 * the global _() resolves against Cinnamon's. With no po/ shipped yet this is
 * an identity function, but it is the hook translations attach to. */
const Gettext = imports.gettext;
Gettext.bindtextdomain(UUID, GLib.get_home_dir() + "/.local/share/locale");
function _(str) {
    return Gettext.dgettext(UUID, str);
}

/* MCCS feature codes. */
const VCP_BRIGHTNESS = "10";
const VCP_CONTRAST = "12";
const VCP_COLOR_PRESET = "14";

/* A monitor accepts at most one write per this interval while a slider is
 * dragged. DDC/CI is slow (~100ms a write) and flooding the i2c bus makes
 * panels drop values or lag far behind the handle. */
const WRITE_INTERVAL_MS = 200;

/* Guards against a wedged i2c bus stalling a monitor's queue forever. */
const WRITE_TIMEOUT_MS = 10000;
const READ_TIMEOUT_MS = 10000;
const CAPS_TIMEOUT_MS = 30000;

function nowMs() {
    return GLib.get_monotonic_time() / 1000;
}

/* ddcutil's own defaults are very conservative. --noverify skips the read-back
 * after each write, roughly halving write latency. */
function ddcArgv(sleepMultiplier) {
    return ["ddcutil", "--noverify", "--sleep-multiplier", String(sleepMultiplier)];
}

/* Runs a command, handing (stdout, exitCode) to the callback. Returns the
 * Gio.Subprocess so it can be cancelled, or null if the spawn itself failed —
 * which is what happens when ddcutil is not installed. The callback always
 * fires asynchronously, so callers can assign the return value before it runs. */
function run(argv, callback) {
    try {
        return Util.spawnCommandLineAsyncIO(null, (stdout, stderr, exitCode) => {
            callback(stdout || "", exitCode);
        }, { argv: argv });
    } catch (e) {
        global.logError("[" + UUID + "] spawn failed: " + e);
        Util.setTimeout(() => callback("", -1), 0);
        return null;
    }
}

/* Parses one "VCP <code> ..." line from `getvcp --brief`.
 *   continuous:      VCP 10 C 80 100
 *   non-continuous:  VCP 14 CNC x00 x0b x00 x05   (current value is the last field)
 * Returns {continuous, value, max} or null. */
function parseVcpLine(stdout, code) {
    const lines = stdout.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const f = lines[i].trim().split(/\s+/);
        if (f[0] !== "VCP" || f[1] !== code || f.length < 4) continue;

        if (f[2] === "C") {
            const value = parseInt(f[3], 10);
            const max = parseInt(f[4], 10);
            if (isNaN(value) || isNaN(max) || max <= 0) return null;
            return { continuous: true, value: value, max: max };
        }
        const raw = parseInt(f[f.length - 1].replace(/^x/i, ""), 16);
        if (isNaN(raw)) return null;
        return { continuous: false, value: raw, max: 0 };
    }
    return null;
}

/* Pulls the colour-preset list out of `ddcutil capabilities`:
 *     Feature: 14 (Select color preset)
 *        Values:
 *           04: 5000 K
 *           05: 6500 K
 *           0b: User 1
 * Only the numeric Kelvin entries make a meaningful slider axis, so named
 * modes like "User 1" are dropped and the rest sorted cool-wards. */
function parseColorPresets(stdout) {
    const choices = [];
    let inTarget = false;

    stdout.split("\n").forEach((line) => {
        const feature = line.match(/^\s*Feature:\s*([0-9A-Fa-f]{2})\b/);
        if (feature) {
            inTarget = feature[1].toUpperCase() === VCP_COLOR_PRESET;
            return;
        }
        if (!inTarget) return;

        const value = line.match(/^\s+([0-9A-Fa-f]{2}):\s*(\S.*?)\s*$/);
        if (!value) return;

        const kelvin = value[2].match(/^(\d{3,5})\s*K$/);
        if (!kelvin) return;

        choices.push({
            raw: parseInt(value[1], 16),
            label: value[2],
            kelvin: parseInt(kelvin[1], 10),
        });
    });

    choices.sort((a, b) => a.kelvin - b.kelvin);
    return choices;
}

/* ddcutil --brief emits, per display:
 *     Display 1
 *        I2C bus:          /dev/i2c-7
 *        Monitor:          MSI:MSI MP275:SERIAL0001
 * On drivers that do not expose DRM connector mappings (the NVIDIA blob, for
 * one) it prefixes all this with connector-lookup warnings, so anchor on the
 * field labels rather than on line numbers. */
function parseDetect(stdout) {
    const found = [];
    let bus = null;
    let model = null;
    let valid = false;

    const flush = () => {
        if (valid && bus !== null) found.push({ bus: bus, model: model || "Display " + bus });
        bus = null;
        model = null;
    };

    stdout.split("\n").forEach((line) => {
        /* Fields are indented, so anything flush-left opens a new block. That
         * covers "Display 1" and equally "Invalid display", "Phantom display"
         * and ddcutil's connector warnings — none of which should contribute a
         * monitor, but all of which would otherwise bleed their I2C bus line
         * into the block before them. */
        if (/^\S/.test(line)) {
            flush();
            valid = /^Display\s+\d+/.test(line);
            return;
        }
        if (!valid) return;

        let m = line.match(/^\s*I2C bus:\s*\/dev\/i2c-(\d+)/);
        if (m) {
            bus = parseInt(m[1], 10);
            return;
        }
        m = line.match(/^\s*Monitor:\s*(.+?)\s*$/);
        if (m) {
            /* "mfg:model:serial" — the middle field is the human name. */
            const parts = m[1].split(":");
            model = (parts.length >= 2 && parts[1]) ? parts[1] : m[1];
        }
    });
    flush();
    return found;
}

/* One control on one row: name, slider, current value.
 *
 * PopupSliderMenuItem puts its slider straight into the menu item's column
 * layout, which leaves nowhere to right-align a trailing value. Lifting the
 * slider out into a BoxLayout gives all three parts a single row with real
 * alignment. The drag maths is unaffected: _moveHandle works from the
 * slider's transformed position on the stage, not from its parent. */
class FeatureRow extends PopupMenu.PopupSliderMenuItem {
    constructor(name) {
        super(0);

        this.nameLabel = new St.Label({ text: name, style_class: "ddc-name" });
        this.valueLabel = new St.Label({ text: "", style_class: "ddc-value" });

        this.removeActor(this._slider);
        const box = new St.BoxLayout({ style_class: "ddc-row" });
        box.add(this.nameLabel, { y_align: St.Align.MIDDLE, y_fill: false });
        box.add(this._slider, { expand: true, x_fill: true, y_fill: true });
        box.add(this.valueLabel, { y_align: St.Align.MIDDLE, y_fill: false });
        this.addActor(box, { span: -1, expand: true });
    }

    setValueText(text) {
        this.valueLabel.set_text(text);
    }
}

/* One slider bound to one VCP feature on one monitor.
 *
 * kind "continuous": the slider spans 0..max in the monitor's own units.
 * kind "enum":       the slider steps through `choices`, an ordered list of
 *                    {raw, label}. Writes send the raw MCCS value. */
class FeatureSlider {
    constructor(monitor, spec) {
        this.monitor = monitor;
        this.code = spec.code;
        this.name = spec.name;
        this.kind = spec.kind;
        this.choices = spec.choices || [];

        this.value = 0;
        this.max = spec.max || 100;
        this.known = false;

        /* Created per menu build — see addTo(). */
        this.row = null;
    }

    /* PopupMenuBase.removeAll() destroys every item it holds, so a widget kept
     * across a menu rebuild comes back destroyed and silently adds nothing.
     * The menu owns the row; this object owns only the state. */
    addTo(menu) {
        this.row = new FeatureRow(this.name);
        this.row.connect("value-changed", (row, fraction) => this._onSlider(fraction));
        this.row.connect("drag-begin", () => { this.monitor.dragging = true; });
        /* Committing on drag-end means letting go always lands the exact value
         * under the handle, even if the last motion event was rate-limited away. */
        this.row.connect("drag-end", () => {
            this.monitor.dragging = false;
            this.monitor.flush();
        });

        this.row.setValue(this.fraction());
        this.row.setValueText(this.display());
        menu.addMenuItem(this.row);
    }

    /* The menu has destroyed our row; drop the dangling reference. */
    forgetWidget() {
        this.row = null;
    }

    _choiceIndex() {
        for (let i = 0; i < this.choices.length; i++) {
            if (this.choices[i].raw === this.value) return i;
        }
        return -1;
    }

    display() {
        if (!this.known) return "…";
        if (this.kind === "enum") {
            const i = this._choiceIndex();
            return i >= 0 ? this.choices[i].label : "?";
        }
        return Math.round((this.value / this.max) * 100) + "%";
    }

    _updateLabel() {
        if (this.row) this.row.setValueText(this.display());
    }

    fraction() {
        if (this.kind === "enum") {
            if (this.choices.length < 2) return 0;
            const i = this._choiceIndex();
            return i < 0 ? 0 : i / (this.choices.length - 1);
        }
        return this.max > 0 ? this.value / this.max : 0;
    }

    read(done) {
        const argv = ddcArgv(this.monitor.applet.sleepMultiplier)
            .concat(["--bus", String(this.monitor.bus), "getvcp", this.code, "--brief"]);

        this.monitor.enqueueRead("get:" + this.code, argv, READ_TIMEOUT_MS, (stdout, exitCode) => {
            let ok = false;
            if (exitCode === 0) {
                const parsed = parseVcpLine(stdout, this.code);
                if (parsed) {
                    if (parsed.continuous) this.max = parsed.max;
                    /* Never clobber a value the user is in the middle of
                     * setting: a refresh landing between the drag and the
                     * write would snap the handle back to the old level. */
                    if (!this.known ||
                        (!this.monitor.dragging && !this.monitor.hasPendingWrite(this.code))) {
                        this.value = parsed.value;
                        this.known = true;
                        if (this.row) this.row.setValue(this.fraction());
                        this._updateLabel();
                    }
                    ok = true;
                }
            }
            if (done) done(ok);
        });
    }

    _onSlider(fraction) {
        if (!this.known) return;   /* no scale yet; don't write a guessed value */

        let value;
        if (this.kind === "enum") {
            if (this.choices.length < 2) return;
            const i = Math.round(fraction * (this.choices.length - 1));
            value = this.choices[Math.max(0, Math.min(this.choices.length - 1, i))].raw;
        } else {
            value = Math.round(fraction * this.max);
        }

        if (value === this.value) return;
        this.value = value;
        this._updateLabel();
        this.monitor.applet.updatePanel();
        this.monitor.requestWrite(this.code, this._wireValue(value));
    }

    /* Enumerated features take a hex MCCS value; continuous ones a decimal. */
    _wireValue(value) {
        return this.kind === "enum" ? "0x" + value.toString(16) : String(value);
    }

    /* Nudge by a percentage of full scale, for the scroll wheel. Enumerated
     * features are left alone — stepping colour presets on a stray scroll
     * would be a nasty surprise. */
    nudge(deltaPercent) {
        if (!this.known || this.kind !== "continuous") return;
        const step = Math.max(1, Math.round((Math.abs(deltaPercent) / 100) * this.max));
        const target = Math.max(0, Math.min(this.max, this.value + (deltaPercent > 0 ? step : -step)));
        if (target === this.value) return;

        this.value = target;
        if (this.row) this.row.setValue(this.fraction());
        this._updateLabel();
        this.monitor.applet.updatePanel();
        this.monitor.requestWrite(this.code, this._wireValue(target));
    }

    destroy() {
        this.forgetWidget();
    }
}

/* One monitor, and the gate in front of its i2c bus.
 *
 * EVERY ddcutil invocation for this display — read, write or capabilities —
 * goes through _pump/_exec, so exactly one process touches the bus at a time.
 * Two concurrent processes on one i2c bus is how values get dropped or
 * misapplied. Writes take priority over reads so dragging stays responsive. */
class MonitorControl {
    constructor(applet, bus, model) {
        this.applet = applet;
        this.bus = bus;
        this.model = model;
        this.destroyed = false;
        this.dragging = false;

        this.brightness = new FeatureSlider(this, {
            code: VCP_BRIGHTNESS, name: _("Brightness"), kind: "continuous",
        });
        this.advancedFeatures = [];   /* built lazily from a capabilities probe */
        this.probed = false;
        this.probing = false;

        this.header = null;   /* created per menu build, like the feature rows */

        this._writes = new Map();     /* code -> wire value; latest wins per code */
        this._writingCode = null;
        this._reads = [];             /* queued read jobs */
        this._busy = null;            /* the one running subprocess */
        this._guard = 0;              /* its timeout source */
        this._timer = 0;              /* write rate-limit source */
        this._lastWrite = 0;
    }

    features() {
        return [this.brightness].concat(this.applet.advanced ? this.advancedFeatures : []);
    }

    addTo(menu) {
        this.header = new PopupMenu.PopupBaseMenuItem({ reactive: false, style_class: "ddc-header-item" });
        this.header.addActor(new St.Label({ text: this.model, style_class: "ddc-header" }),
                             { span: -1, expand: true });
        menu.addMenuItem(this.header);
        this.features().forEach((f) => f.addTo(menu));
    }

    /* Called right after the menu is cleared: every widget below is already
     * destroyed, so only the references need dropping. */
    forgetWidgets() {
        this.header = null;
        this.brightness.forgetWidget();
        this.advancedFeatures.forEach((f) => f.forgetWidget());
    }

    readAll(done) {
        const list = this.features();
        let outstanding = list.length;
        if (outstanding === 0) {
            if (done) done();
            return;
        }
        list.forEach((f) => f.read(() => {
            if (--outstanding === 0 && done) done();
        }));
    }

    hasPendingWrite(code) {
        return this._writes.has(code) || this._writingCode === code;
    }

    requestWrite(code, wireValue) {
        this._writes.set(code, wireValue);
        this._pump();
    }

    /* Called on drag-end: skip the rate limit and commit immediately. */
    flush() {
        if (this._timer) {
            Util.clearTimeout(this._timer);
            this._timer = 0;
        }
        this._pump();
    }

    /* Queues a read. A read already queued under the same key absorbs the new
     * callback rather than queueing a duplicate round trip. */
    enqueueRead(key, argv, timeoutMs, callback) {
        for (let i = 0; i < this._reads.length; i++) {
            if (this._reads[i].key === key) {
                this._reads[i].callbacks.push(callback);
                return;
            }
        }
        this._reads.push({ key: key, argv: argv, timeoutMs: timeoutMs, callbacks: [callback] });
        this._pump();
    }

    _pump() {
        if (this.destroyed || this._busy || this._timer) return;

        if (this._writes.size > 0) {
            const wait = Math.max(0, WRITE_INTERVAL_MS - (nowMs() - this._lastWrite));
            if (wait > 0) {
                this._timer = Util.setTimeout(() => {
                    this._timer = 0;
                    this._pump();
                }, wait);
                return;
            }

            const entry = this._writes.entries().next().value;
            const code = entry[0];
            const wireValue = entry[1];
            this._writes.delete(code);
            this._writingCode = code;
            this._lastWrite = nowMs();

            const argv = ddcArgv(this.applet.sleepMultiplier)
                .concat(["--bus", String(this.bus), "setvcp", code, wireValue]);

            this._exec(argv, WRITE_TIMEOUT_MS, (stdout, exitCode) => {
                this._writingCode = null;
                if (exitCode !== 0) this.applet.reportError(this.model);
            });
            return;
        }

        if (this._reads.length > 0) {
            const job = this._reads.shift();
            this._exec(job.argv, job.timeoutMs, (stdout, exitCode) => {
                job.callbacks.forEach((cb) => cb(stdout, exitCode));
            });
        }
    }

    /* Runs one ddcutil, under a timeout, then pumps the queue again. */
    _exec(argv, timeoutMs, callback) {
        let settled = false;

        const settle = (stdout, exitCode) => {
            if (settled) return;
            settled = true;
            if (this._guard) {
                Util.clearTimeout(this._guard);
                this._guard = 0;
            }
            this._busy = null;
            if (!this.destroyed) callback(stdout, exitCode);
            this._pump();
        };

        this._guard = Util.setTimeout(() => {
            /* Zero it first: this source has already fired, and removing it
             * again would raise a GLib critical. */
            this._guard = 0;
            if (this._busy && this._busy.cancellable) this._busy.cancellable.cancel();
            settle("", -1);
        }, timeoutMs);

        this._busy = run(argv, settle);
    }

    /* Works out which advanced features this monitor actually has. Contrast is
     * probed directly rather than trusted to the capabilities string, which
     * vendors routinely under-report; the colour-preset list can only come
     * from capabilities, the sole source of the Kelvin values. */
    probeAdvanced(done) {
        if (this.probed || this.probing) {
            if (done) done();
            return;
        }
        this.probing = true;

        const finish = () => {
            this.probing = false;
            this.probed = true;
            if (done) done();
        };

        const contrastArgv = ddcArgv(this.applet.sleepMultiplier)
            .concat(["--bus", String(this.bus), "getvcp", VCP_CONTRAST, "--brief"]);

        this.enqueueRead("probe:contrast", contrastArgv, READ_TIMEOUT_MS, (stdout, exitCode) => {
            if (this.destroyed) return finish();

            const parsed = exitCode === 0 ? parseVcpLine(stdout, VCP_CONTRAST) : null;
            if (parsed && parsed.continuous) {
                this.advancedFeatures.push(new FeatureSlider(this, {
                    code: VCP_CONTRAST, name: _("Contrast"), kind: "continuous", max: parsed.max,
                }));
            }

            const capsArgv = ["ddcutil", "--bus", String(this.bus), "capabilities"];
            this.enqueueRead("probe:caps", capsArgv, CAPS_TIMEOUT_MS, (capsOut, capsCode) => {
                if (this.destroyed) return finish();
                if (capsCode === 0) {
                    const choices = parseColorPresets(capsOut);
                    if (choices.length >= 2) {
                        this.advancedFeatures.push(new FeatureSlider(this, {
                            code: VCP_COLOR_PRESET, name: _("Colour temperature"),
                            kind: "enum", choices: choices,
                        }));
                    }
                }
                finish();
            });
        });
    }

    destroy() {
        this.destroyed = true;
        if (this._timer) {
            Util.clearTimeout(this._timer);
            this._timer = 0;
        }
        if (this._guard) {
            Util.clearTimeout(this._guard);
            this._guard = 0;
        }
        if (this._busy && this._busy.cancellable) this._busy.cancellable.cancel();
        this._busy = null;
        this._writes.clear();
        this._reads = [];
        this.brightness.destroy();
        this.advancedFeatures.forEach((f) => f.destroy());
        this.advancedFeatures = [];
        this.header = null;
    }
}

class DDCBrightnessApplet extends Applet.TextIconApplet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        this.setAllowedLayout(Applet.AllowedLayout.BOTH);
        this.set_applet_icon_symbolic_name("display-brightness");
        this.set_applet_label("");
        this.set_applet_tooltip(_("Monitor brightness"));

        this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);
        this.settings.bind("scrollStep", "scrollStep");
        this.settings.bind("showPercent", "showPercent", () => this.updatePanel());
        this.settings.bind("refreshOnOpen", "refreshOnOpen");
        this.settings.bind("sleepMultiplier", "sleepMultiplier");
        this.settings.bind("advanced", "advanced", () => this._onAdvancedSetting());

        this.monitors = [];
        this._errorShown = false;
        this._detecting = false;
        this._detectProc = null;
        /* Bumped whenever the monitor set is torn down, so callbacks from a
         * previous generation can recognise themselves as stale. */
        this._generation = 0;

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);

        this.menu.connect("open-state-changed", (menu, open) => {
            if (open && this.refreshOnOpen && this.monitors.length > 0) {
                this.monitors.forEach((m) => m.readAll(() => this.updatePanel()));
            }
        });

        this.actor.connect("scroll-event", (actor, event) => this._onScroll(event));

        this.detect();
    }

    /* The only way the menu should ever be emptied: removeAll() destroys the
     * items, so the monitors must drop their references in the same breath. */
    _clearMenu() {
        this.menu.removeAll();
        this.monitors.forEach((m) => m.forgetWidgets());
    }

    on_applet_clicked() {
        this.menu.toggle();
    }

    _onScroll(event) {
        const direction = event.get_scroll_direction();
        let delta = 0;
        if (direction === Clutter.ScrollDirection.UP) delta = this.scrollStep;
        else if (direction === Clutter.ScrollDirection.DOWN) delta = -this.scrollStep;
        else return Clutter.EVENT_PROPAGATE;

        /* Brightness only — scrolling should never trip a colour preset. */
        this.monitors.forEach((m) => m.brightness.nudge(delta));
        return Clutter.EVENT_STOP;
    }

    detect() {
        if (this._detecting) return;
        this._detecting = true;
        this._generation++;
        const generation = this._generation;

        this._clearMenu();
        this._clearMonitors();
        this.menu.addMenuItem(new PopupMenu.PopupMenuItem(_("Detecting monitors…"), { reactive: false }));

        this._detectProc = run(["ddcutil", "detect", "--brief"], (stdout, exitCode) => {
            this._detectProc = null;
            if (generation !== this._generation) return;
            this._detecting = false;

            if (exitCode !== 0) {
                this._showMessage(_("ddcutil failed — is it installed?"));
                return;
            }
            const found = parseDetect(stdout);
            if (found.length === 0) {
                this._showMessage(_("No DDC/CI monitors found"));
                return;
            }

            this.monitors = found.map((d) => new MonitorControl(this, d.bus, d.model));

            const finish = () => {
                if (generation !== this._generation) return;
                this.rebuildMenu();
                this.monitors.forEach((m) => m.readAll(() => this.updatePanel()));
            };

            if (this.advanced) this._probeAll(generation, finish);
            else finish();
        });
    }

    _probeAll(generation, done) {
        let outstanding = this.monitors.length;
        if (outstanding === 0) {
            done();
            return;
        }
        this.monitors.forEach((m) => m.probeAdvanced(() => {
            if (generation !== this._generation) return;
            if (--outstanding === 0) done();
        }));
    }

    rebuildMenu() {
        this._clearMenu();

        this.monitors.forEach((m, i) => {
            if (i > 0) this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            m.addTo(this.menu);
        });

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._advancedSwitch = new PopupMenu.PopupSwitchMenuItem(_("Advanced"), this.advanced);
        this._advancedSwitch.connect("toggled", (item, state) => {
            if (state === this.advanced) return;
            this.advanced = state;
            this.settings.setValue("advanced", state);
            this._applyAdvanced();
        });
        this.menu.addMenuItem(this._advancedSwitch);

        const rescan = new PopupMenu.PopupMenuItem(_("Rescan monitors"));
        rescan.connect("activate", () => this.detect());
        this.menu.addMenuItem(rescan);
    }

    /* Fires when the setting is changed from the configuration window rather
     * than the menu switch. */
    _onAdvancedSetting() {
        if (this._advancedSwitch && this._advancedSwitch.state === this.advanced) return;
        this._applyAdvanced();
    }

    _applyAdvanced() {
        if (!this.advanced) {
            this.rebuildMenu();
            this.updatePanel();
            return;
        }

        /* The first enable has to ask each monitor what it supports, which is
         * several seconds of DDC round trips. Say so rather than look hung. */
        const needProbe = this.monitors.some((m) => !m.probed);
        if (!needProbe) {
            this.rebuildMenu();
            this.monitors.forEach((m) => m.readAll(() => this.updatePanel()));
            return;
        }

        const generation = this._generation;
        this._clearMenu();
        this.menu.addMenuItem(new PopupMenu.PopupMenuItem(_("Reading monitor capabilities…"), { reactive: false }));

        this._probeAll(generation, () => {
            if (generation !== this._generation) return;
            this.rebuildMenu();
            this.monitors.forEach((m) => m.readAll(() => this.updatePanel()));
        });
    }

    _showMessage(text) {
        this._clearMenu();
        this.menu.addMenuItem(new PopupMenu.PopupMenuItem(text, { reactive: false }));
        const retry = new PopupMenu.PopupMenuItem(_("Rescan monitors"));
        retry.connect("activate", () => this.detect());
        this.menu.addMenuItem(retry);
        /* monitors is already empty here, so this clears the label and resets
         * the tooltip together. */
        this.updatePanel();
    }

    updatePanel() {
        const levels = this.monitors
            .filter((m) => m.brightness.known)
            .map((m) => Math.round((m.brightness.value / m.brightness.max) * 100));

        this.set_applet_label(
            (this.showPercent && levels.length > 0) ? levels.join(" / ") + "%" : ""
        );

        this.set_applet_tooltip(
            this.monitors.length === 0
                ? _("Monitor brightness")
                : this.monitors
                    .map((m) => m.model + ": " + m.brightness.display())
                    .join("\n")
        );
    }

    /* One notification per session, not one per failed write — a monitor that
     * has gone to sleep would otherwise bury the user in them. */
    reportError(model) {
        if (this._errorShown) return;
        this._errorShown = true;
        Main.notify(_("DDC Brightness"), _("Could not set a value on ") + model);
    }

    _clearMonitors() {
        this.monitors.forEach((m) => m.destroy());
        this.monitors = [];
    }

    on_applet_removed_from_panel() {
        this._generation++;   /* strands any in-flight detect callback */
        if (this._detectProc && this._detectProc.cancellable) {
            this._detectProc.cancellable.cancel();
        }
        this._detectProc = null;
        this._clearMenu();
        this._clearMonitors();
        this.settings.finalize();
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new DDCBrightnessApplet(metadata, orientation, panelHeight, instanceId);
}
