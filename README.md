# DDC Brightness

A Cinnamon applet that puts a brightness slider for **each external monitor**
in your panel — plus one that sets them all at once — driven over DDC/CI by
[`ddcutil`](https://www.ddcutil.com/).
An **Advanced** toggle adds contrast and colour-temperature sliders for the
monitors that support them.

Desktop machines have no `/sys/class/backlight`, so Cinnamon's built-in
brightness control is laptop-only and simply isn't there. This talks to the
monitors over the i2c lines in the video cable and changes the actual backlight
— not gamma, so blacks stay black.

## Requirements

- Cinnamon 6.x
- `ddcutil` 2.x
- Monitors that support DDC/CI (most do; some ship with it **disabled in the
  monitor's own OSD menu** — check there first if a panel doesn't show up)

## Install

```bash
sudo apt install ddcutil          # Debian/Ubuntu
git clone https://github.com/callumedmonds/cinnamon-ddc-brightness.git
cd cinnamon-ddc-brightness
./install.sh
```

Then restart Cinnamon (`Alt+F2`, `r`, `Enter`) and add **DDC Brightness** from
*System Settings → Applets*.

`install.sh` copies the applet into `~/.local/share/cinnamon/applets/`. Use
`./install.sh --link` to symlink the repo instead if you're working on it —
but note that Cinnamon's *Uninstall* button only works on a real directory, and
that Cinnamon caches applet code, so **every** update needs a Cinnamon restart
to take effect. `./uninstall.sh` removes it.

### i2c permissions

`ddcutil`'s packaging ships a udev rule that grants your desktop session access
to the i2c buses. If it hasn't been applied yet:

```bash
sudo udevadm control --reload && sudo udevadm trigger --subsystem-match=i2c-dev
```

Confirm you can reach the monitors **as your normal user** — if this lists your
displays, the applet will work:

```bash
ddcutil detect
```

## Controls

Click the panel icon for a slider per monitor. With more than one monitor
attached, an **All monitors** slider sits above them:

- **Dragging All monitors** puts every monitor at the same level. Its value
  reads `60%` when the monitors agree and `40–60%` when they don't, with the
  handle at their average — so the first drag after setting them apart brings
  them back together.
- **Scrolling on the panel icon** moves every monitor by the scroll step while
  keeping any gap between them. Use this if you've matched two panels by eye
  at different settings and want to keep them matched.

Switch on **Advanced** in the menu and each monitor also gets:

- **Contrast** — VCP `0x12`, continuous.
- **Colour temperature** — VCP `0x14`, stepping through the Kelvin presets that
  monitor actually advertises. Monitors differ here: one panel may offer
  5000/6500/9300 K and another 6500/7500/9300 K, so the slider is built per
  monitor from its own capabilities. Named modes like "User 1" are left out,
  since they have no place on a temperature axis.

Moving the colour-temperature slider switches the monitor to that preset, which
takes it **out of any "User" mode** and discards a custom white balance you set
from its OSD. If a monitor is currently in User 1 and you want it back after
experimenting, `ddcutil --bus <N> setvcp 14 0x0b` restores it.

Both are discovered per monitor rather than assumed: contrast is probed
directly (capabilities strings are routinely under-reported by vendors) and the
preset list is read from `ddcutil capabilities`. A monitor that doesn't support
one simply doesn't get that slider. The first time you enable Advanced it takes
a few seconds per monitor to ask.

Scrolling deliberately only moves brightness — stepping a colour preset on a
stray wheel notch would be an unpleasant surprise.

The menu puts each control on one row — name, slider, current value — with the
columns aligned across every feature and every monitor, under a heading per
monitor, with the All monitors row above them all.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Scroll wheel step | 5% | How far one wheel notch moves brightness. |
| Show levels in the panel | off | Puts each monitor's level next to the icon, e.g. `60 / 45%`. |
| Re-read levels when the menu opens | on | Picks up changes made from the monitor's OSD buttons or another tool. Costs ~200ms per monitor. |
| Advanced controls | off | Same as the menu toggle. |
| DDC/CI timing multiplier | 0.3 | Scales the delays `ddcutil` leaves between i2c messages. Raise it if your monitor drops or misapplies values; lower it for snappier sliders. |

## How it behaves

DDC/CI is slow — roughly 100ms per write — and two processes talking to one
i2c bus at the same time is how values get dropped or misapplied. So every
`ddcutil` invocation for a given monitor, **read or write**, goes through a
single per-monitor gate: exactly one process on that bus at a time, writes
prioritised over reads so dragging stays responsive. Repeated slider motion is
folded into one pending value per feature (latest wins) and rate-limited to one
write per 200ms; releasing the slider always commits the exact value under the
handle. A refresh that lands while you're dragging is discarded rather than
snapping the handle backwards. Everything is asynchronous — nothing blocks
Cinnamon's UI thread.

## Tests

```bash
tests/run-tests.sh
```

The parsers are pure functions, so the suite lifts them straight out of
`applet.js` and runs them under `gjs` — the same engine Cinnamon uses — against
fixtures of real `ddcutil` output, including the connector-lookup warnings the
NVIDIA proprietary driver prints ahead of the actual data.

## Troubleshooting

**Nothing is detected.** Run `ddcutil detect` in a terminal as your normal
user. If it works there but not in the applet, check `~/.xsession-errors` and
`journalctl -b _COMM=cinnamon` — Looking Glass (`Alt+F2`, `lg`) shows applet
errors too.

**"Failed to find connector name" warnings from `ddcutil`.** Harmless. The
NVIDIA proprietary driver doesn't populate the `/sys` DRM connector → i2c
mapping `ddcutil` prefers, so it falls back to probing EDIDs. The applet parses
around this noise.

**A monitor is detected but writes fail.** Some panels need more relaxed
timing — raise the *DDC/CI timing multiplier*. DDC over HDMI is generally
flakier than over DisplayPort.

**Values snap back.** The monitor is rejecting the write. Check DDC/CI is
enabled in its OSD, and that nothing else (a vendor OSD tool, another DDC
utility) is competing for the bus.

## What else DDC/CI can control

Brightness is VCP feature `0x10`. Most monitors also expose speaker volume
(`0x62`), RGB gain (`0x16`/`0x18`/`0x1A`), input source (`0x60`) and power
(`0xD6`) — input switching in particular makes for a decent software KVM. See
what yours supports with:

```bash
ddcutil --bus <N> capabilities
```

Take care with `0x04` (restore factory defaults — it resets colour and geometry
too, not just brightness) and with `0xD6` on monitors that advertise only the
"off" value, since there's then no DDC command to turn them back on.

## Licence

MIT — see [LICENSE](LICENSE).
